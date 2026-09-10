// =============================================================================
// campistry_deposits_ui.js — the office's side of automatic Zelle/ACH capture
//
// The server half (deposit-inbox + migration 145) already receives bank alerts,
// matches them to families and posts the confident ones. Without this file none
// of that is visible: the money sits in `bank_deposits` where only the database
// can see it.
//
// This module owns four surfaces:
//
//   • The reconcile INBOX  — deposits that need a human, each with ranked
//                            candidates and the reason behind the ranking.
//                            One click resolves it AND teaches an alias, which
//                            is what stops the same payer ever asking again.
//   • ALIASES              — the learned "this payer is that family" list.
//   • SETTINGS             — the camp's inbound address, dry-run, allowlist.
//   • MEMO CODES           — the per-family code that makes the payer's name
//                            irrelevant when a parent actually uses it.
//
// ─────────────────────────────────────────────────────────────────────────────
// It deliberately does NOT bring its own modal, toast, escaping or currency
// formatting. campistry_me.js already has all of those, and a second set would
// drift in styling and in escaping rules -- the second of which is a security
// bug, not a cosmetic one. The host injects them through init().
// ─────────────────────────────────────────────────────────────────────────────
//
// Exposed as window.CampistryDeposits.
// =============================================================================
(function () {
    'use strict';

    var D = {};

    // Resolved rather than referenced bare, so the module can be loaded and its
    // pure surface exercised outside a browser (tests/deposits_ui.test.js).
    // A bare `window` reference throws ReferenceError in Node, not undefined.
    var W = (typeof window !== 'undefined') ? window
          : (typeof globalThis !== 'undefined') ? globalThis : {};

    // Host-supplied UI kit + data accessors, wired in campistry_me.js.
    var host = {
        showModal: null, closeModal: null, toast: null,
        // esc  -> HTML text/attribute escaping.
        // jesc -> the same, PLUS escaping ' for use inside an onclick="...'X'..."
        //         JS string literal. They are separate because using jesc on
        //         visible text renders "Shimon\'s Hardware" -- and apostrophes
        //         are extremely common in exactly the payer names this feature
        //         exists to handle.
        esc: function (s) { return String(s == null ? '' : s); },
        jesc: function (s) { return String(s == null ? '' : s).replace(/'/g, "\\'"); },
        fm: function (n) { return '$' + (Number(n) || 0).toFixed(2); },
        client: null, campId: null,
        families: function () { return {}; },
        onChange: function () {}
    };

    var state = {
        loaded: false,
        loading: false,
        deposits: [],       // review + unmatched + recently posted
        aliases: [],
        credits: {},        // famKey -> [ledger entries]
        settings: null,
        error: ''
    };

    D.init = function (opts) {
        Object.keys(opts || {}).forEach(function (k) {
            if (opts[k] != null) host[k] = opts[k];
        });
        return D;
    };

    function db() {
        if (host.client) return typeof host.client === 'function' ? host.client() : host.client;
        return (W.CampistryDB && W.CampistryDB.getClient)
            ? W.CampistryDB.getClient() : W.supabase;
    }

    function campId() {
        return typeof host.campId === 'function' ? host.campId() : host.campId;
    }

    function Match() { return W.CampistryDepositMatch || null; }

    // ── loading ──────────────────────────────────────────────────────────────

    /**
     * Pull everything this module renders from.
     *
     * Failures are recorded, never thrown: Billing must still render its normal
     * ledger if the deposits feature is not deployed yet (the RPCs simply do
     * not exist), or if the user is a non-admin whose RPCs return not_authorized.
     */
    D.refresh = async function () {
        var client = db(), cid = campId();
        if (!client || !cid || state.loading) return state;
        state.loading = true;
        try {
            var res = await Promise.all([
                client.rpc('get_bank_deposits', { p_camp_id: cid, p_limit: 300 }),
                client.rpc('get_payer_aliases', { p_camp_id: cid }),
                client.rpc('get_camp_deposit_credits', { p_camp_id: cid })
            ]);
            var deps = res[0], als = res[1], crd = res[2];

            if (deps.error) throw deps.error;
            state.deposits = (deps.data && deps.data.deposits) || [];
            state.aliases = (als.data && als.data.aliases) || [];
            state.credits = (crd.data && crd.data.credits) || {};
            state.error = '';
            state.loaded = true;
        } catch (e) {
            // A missing function (migration not applied) is the common case and
            // is not worth alarming anyone about.
            state.error = (e && e.message) || String(e);
            state.loaded = true;
            if (!/does not exist|not_authorized|schema cache/i.test(state.error)) {
                console.warn('[Deposits] refresh failed:', state.error);
            }
        } finally {
            state.loading = false;
        }
        return state;
    };

    D.state = function () { return state; };

    // ── the ledger union ─────────────────────────────────────────────────────
    //
    // Posted deposits are ledger entries that live in Postgres instead of in
    // the camp_state_kv blob (migration 145 explains why). buildFamilyLedgers()
    // folds these in alongside finPayments.

    D.creditsFor = function (famKey) {
        return state.credits[famKey] || [];
    };

    D.totalPending = function () {
        return state.deposits.filter(function (d) {
            return d.status === 'review' || d.status === 'unmatched';
        }).length;
    };

    D.pendingAmount = function () {
        return state.deposits.reduce(function (sum, d) {
            return (d.status === 'review' || d.status === 'unmatched')
                ? sum + (d.amount_cents || 0) / 100 : sum;
        }, 0);
    };

    // ── balance snapshot ─────────────────────────────────────────────────────
    //
    // The server cannot run buildFamilyLedgers(), so the overpay guardrail has
    // no balance to check unless the browser publishes what it already
    // computed. Debounced because Billing re-renders on every keystroke in its
    // search box, and this is a network write.

    var _snapTimer = null, _snapLast = '';
    D.publishBalances = function (ledgers) {
        var client = db(), cid = campId();
        if (!client || !cid || !ledgers) return;

        var balances = {};
        Object.keys(ledgers).forEach(function (k) {
            // Pending/synthesized ledgers have no real family record for the
            // server to match a deposit against, so publishing them is noise.
            if (ledgers[k] && !ledgers[k].pendingEnrollment) {
                balances[k] = Math.round((Number(ledgers[k].balance) || 0) * 100) / 100;
            }
        });

        var sig = JSON.stringify(balances);
        if (sig === _snapLast) return;          // nothing moved since last publish

        clearTimeout(_snapTimer);
        _snapTimer = setTimeout(function () {
            _snapLast = sig;
            client.rpc('set_family_balance_snapshot', { p_camp_id: cid, p_balances: balances })
                .then(function () {}, function (err) {
                    console.warn('[Deposits] balance snapshot failed:', err && err.message);
                });
        }, 4000);
    };

    // ── memo codes ───────────────────────────────────────────────────────────

    D.memoCode = function (famKey, familyName) {
        var M = Match();
        return M ? M.memoCode(famKey, familyName) : '';
    };

    /** The line to show a parent, on a statement or the family detail page. */
    D.memoInstruction = function (famKey, familyName) {
        var code = D.memoCode(famKey, familyName);
        return code
            ? 'Put ' + code + ' in the Zelle/bank memo so the payment is credited automatically.'
            : '';
    };

    /**
     * Turn an RPC failure into something the person reading it can act on.
     *
     * This used to say "Deposit capture isn't set up for this camp yet" for
     * every possible cause -- migration missing, permissions, a stale API
     * schema cache -- which is the same silent-failure pattern this whole
     * feature exists to avoid. The three causes need three different fixes,
     * so name them.
     */
    D.explainError = function (err) {
        var e = String(err || '');
        if (/not_authorized/i.test(e)) {
            return 'You need owner or admin access on this camp to see bank deposits. ' +
                   'A scheduler or staff login cannot open them.';
        }
        if (/schema cache/i.test(e)) {
            return 'The database has the deposit functions but the API hasn\'t picked them up yet. ' +
                   'In Supabase go to Settings → API → Reload schema, then refresh this page.';
        }
        if (/does not exist|could not find the function|42883/i.test(e)) {
            return 'Migration 145 hasn\'t been applied to this Supabase project yet. ' +
                   'Paste migrations/145_bank_deposits.sql into the SQL Editor and run it.';
        }
        if (/JWT|not_authenticated|401/i.test(e)) {
            return 'Your session expired — sign out and back in, then try again.';
        }
        return e || 'Unknown error.';
    };

    // ── the reconcile inbox ──────────────────────────────────────────────────

    var BODY_ID = 'depInboxBody';

    D.openInbox = function () {
        if (!host.showModal) return;
        host.showModal('Bank Deposits', '<div id="' + BODY_ID + '">Loading…</div>', null, { maxWidth: 920 });
        D.refresh().then(renderInbox);
    };

    function statusPill(d) {
        var map = {
            posted:    ['#065F46', '#D1FAE5', 'Posted'],
            review:    ['#92400E', '#FEF3C7', 'Needs review'],
            unmatched: ['#991B1B', '#FEE2E2', 'Unmatched'],
            ignored:   ['#374151', '#F3F4F6', 'Not tuition']
        };
        var m = map[d.status] || map.unmatched;
        return '<span style="background:' + m[1] + ';color:' + m[0] +
               ';padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:600">' + m[2] + '</span>';
    }

    function famName(fk) {
        var f = (host.families() || {})[fk];
        return (f && f.name) || fk || '—';
    }

    function candidateButtons(d) {
        var cands = d.candidates || [];
        if (!cands.length) {
            return '<div style="font-size:.78rem;color:var(--s500)">No candidate families — pick one below.</div>';
        }
        return cands.map(function (c) {
            var reasons = (c.reasons || []).join(' · ');
            return '<button class="me-btn me-btn--sec me-btn--sm" style="margin:0 6px 6px 0;text-align:left"' +
                   ' onclick="CampistryDeposits.resolve(\'' + host.jesc(d.id) + '\',\'' + host.jesc(c.familyKey) + '\')">' +
                   '<strong>' + host.esc(c.familyName || famName(c.familyKey)) + '</strong>' +
                   ' <span style="opacity:.7">' + (c.score || 0) + '%</span>' +
                   (reasons ? '<div style="font-weight:400;font-size:.7rem;opacity:.75">' + host.esc(reasons) + '</div>' : '') +
                   '</button>';
        }).join('');
    }

    function familyPicker(d) {
        var fams = host.families() || {};
        var opts = ['<option value="">— pick a family —</option>'].concat(
            Object.keys(fams)
                .sort(function (a, b) { return (fams[a].name || '').localeCompare(fams[b].name || ''); })
                .map(function (k) {
                    return '<option value="' + host.esc(k) + '">' + host.esc(fams[k].name || k) + '</option>';
                })
        ).join('');
        return '<select class="me-input" style="max-width:260px;display:inline-block"' +
               ' onchange="if(this.value)CampistryDeposits.resolve(\'' + host.jesc(d.id) + '\',this.value)">' +
               opts + '</select>';
    }

    function depositRow(d) {
        var amt = (d.amount_cents || 0) / 100;
        var when = d.deposit_date || (d.created_at || '').slice(0, 10) || '—';
        var payer = d.payer_name || '(payer not readable)';

        var head = '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap">' +
            '<div><strong style="font-size:1.02rem">' + host.fm(amt) + '</strong>' +
            ' <span style="color:var(--s600)">from ' + host.esc(payer) + '</span>' +
            (d.memo_code ? ' <code style="background:var(--s50);padding:1px 5px;border-radius:4px;font-size:.72rem">' + host.esc(d.memo_code) + '</code>' : '') +
            '</div>' +
            '<div style="font-size:.75rem;color:var(--s500)">' + host.esc(when) + ' · ' +
            host.esc((d.kind || '').toUpperCase()) + (d.bank ? ' · ' + host.esc(d.bank) : '') + ' ' + statusPill(d) + '</div>' +
            '</div>';

        var why = d.guardrail
            ? '<div style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;padding:6px 10px;border-radius:var(--r);font-size:.76rem;margin:8px 0">' +
              host.esc(d.guardrail) + '</div>'
            : '';

        var memoLine = (d.memo && d.memo !== d.memo_code)
            ? '<div style="font-size:.75rem;color:var(--s500);margin-top:4px">Memo: ' + host.esc(d.memo) + '</div>' : '';

        var actions;
        if (d.status === 'posted') {
            actions = '<div style="margin-top:8px;font-size:.8rem">Posted to <strong>' + host.esc(famName(d.family_key)) + '</strong>' +
                ' <span style="color:var(--s500)">(' + host.esc(d.matched_by === 'auto' ? 'automatic, ' + (d.match_confidence || 0) + '%' : 'by staff') + ')</span>' +
                ' <button class="me-btn me-btn--ghost me-btn--sm" style="margin-left:8px"' +
                ' onclick="CampistryDeposits.unmatch(\'' + host.jesc(d.id) + '\')">Undo</button></div>';
        } else {
            actions = '<div style="margin-top:8px">' + candidateButtons(d) +
                '<div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
                familyPicker(d) +
                '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryDeposits.ignore(\'' + host.jesc(d.id) + '\')">Not tuition</button>' +
                '</div></div>';
        }

        return '<div style="border:1px solid var(--s100);border-radius:var(--r);padding:12px 14px;margin-bottom:10px">' +
               head + memoLine + why + actions + '</div>';
    }

    function renderInbox() {
        var el = document.getElementById(BODY_ID);
        if (!el) return;

        if (state.error && !state.deposits.length) {
            el.innerHTML = '<p style="color:var(--s600);font-size:.88rem;margin:0 0 10px"><strong>Bank deposits aren\'t available yet.</strong></p>' +
                '<p style="color:var(--s500);font-size:.85rem;margin:0 0 12px">' + host.esc(D.explainError(state.error)) + '</p>' +
                '<p style="color:var(--s400);font-size:.76rem;margin:0">Details: <code>' + host.esc(state.error) + '</code></p>';
            return;
        }

        var pending = state.deposits.filter(function (d) { return d.status === 'review' || d.status === 'unmatched'; });
        var posted = state.deposits.filter(function (d) { return d.status === 'posted'; }).slice(0, 25);

        var dry = state.settings && state.settings.dryRun;
        var h = '';

        if (dry) {
            h += '<div style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1E40AF;padding:9px 12px;border-radius:var(--r);font-size:.8rem;margin-bottom:12px">' +
                 '<strong>Dry run is on.</strong> Deposits are being matched and explained, but nothing posts to a ledger automatically. ' +
                 'Turn it off in Deposit Settings once the matches look right.</div>';
        }

        h += '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">' +
             '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryDeposits.openSettings()">Deposit Settings</button>' +
             '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryDeposits.openAliases()">Known Payers (' + state.aliases.length + ')</button>' +
             '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryDeposits.openAddAlias()">+ Add a payer</button>' +
             '</div>';

        h += '<h4 style="margin:0 0 8px;font-size:.9rem">Needs you (' + pending.length + ')</h4>';
        h += pending.length
            ? pending.map(depositRow).join('')
            : '<p style="color:var(--s500);font-size:.85rem;margin:0 0 18px">Nothing waiting — every deposit has been matched.</p>';

        if (posted.length) {
            h += '<h4 style="margin:18px 0 8px;font-size:.9rem">Recently posted</h4>' + posted.map(depositRow).join('');
        }

        el.innerHTML = h;
    }

    // ── actions ──────────────────────────────────────────────────────────────

    function busy(msg) { if (host.toast) host.toast(msg); }

    async function call(fn, args, okMsg) {
        var client = db(), cid = campId();
        if (!client || !cid) return false;
        try {
            var res = await client.rpc(fn, Object.assign({ p_camp_id: cid }, args));
            if (res.error) throw res.error;
            if (res.data && res.data.success === false) throw new Error(res.data.error || 'failed');
            if (okMsg && host.toast) host.toast(okMsg);
            await D.refresh();
            renderInbox();
            host.onChange();
            return true;
        } catch (e) {
            if (host.toast) host.toast('Failed: ' + ((e && e.message) || e), 'error');
            return false;
        }
    }

    /**
     * Assign a deposit to a family — and learn the payer, which is the whole
     * point. The alias is created by default rather than behind an opt-in
     * checkbox: the office is already telling us the answer, and an alias is
     * cheap to delete but expensive to keep re-deriving by hand.
     */
    D.resolve = function (depositId, familyKey) {
        var d = state.deposits.filter(function (x) { return String(x.id) === String(depositId); })[0];
        var M = Match();
        var normalized = (d && M) ? M.normalize(d.payer_name) : '';
        return call('resolve_bank_deposit', {
            p_deposit_id: depositId,
            p_family_key: familyKey,
            p_create_alias: true,
            p_alias_normalized: normalized
        }, 'Posted to ' + famName(familyKey) + (normalized ? ' — future payments from this payer will match automatically' : ''));
    };

    D.ignore = function (depositId) {
        return call('ignore_bank_deposit', { p_deposit_id: depositId, p_note: 'Marked not tuition' },
                    'Marked as not tuition');
    };

    D.unmatch = function (depositId) {
        return call('unmatch_bank_deposit', { p_deposit_id: depositId }, 'Moved back to review');
    };

    D.deleteAlias = function (aliasId) {
        return call('delete_payer_alias', { p_alias_id: aliasId }, 'Payer forgotten');
    };

    // ── aliases ──────────────────────────────────────────────────────────────

    /**
     * Teach a payer BEFORE any money arrives.
     *
     * The learned-alias loop only fires once a deposit has already landed and
     * been resolved, which means a camp's first week is spent resolving payers
     * they could have told us about on day one. Onboarding asks the camp
     * "which families pay from a business account, or under a different name?"
     * -- this is where those answers go, so those deposits match on arrival
     * instead of sitting in the inbox.
     */
    D.openAddAlias = function (prefillName) {
        if (!host.showModal) return;
        var fams = host.families() || {};
        var opts = ['<option value="">— pick a family —</option>'].concat(
            Object.keys(fams)
                .sort(function (a, b) { return (fams[a].name || '').localeCompare(fams[b].name || ''); })
                .map(function (k) {
                    return '<option value="' + host.esc(k) + '">' + host.esc(fams[k].name || k) + '</option>';
                })
        ).join('');

        var h = '<div class="me-modal-form">';
        h += '<p style="margin:0 0 16px;color:var(--s500);font-size:.85rem">' +
             'Tell Campistry that a payer belongs to a family before they ever pay. ' +
             'Payments from this name or handle are then credited to that family automatically.</p>';
        h += '<div class="me-field"><label>Family</label>' +
             '<select id="alFam" class="me-input">' + opts + '</select></div>';
        h += '<div class="me-field"><label>Name the money arrives under</label>' +
             '<input type="text" id="alName" class="me-input" placeholder="e.g. SHIMON\'S HARDWARE LLC" value="' +
             host.esc(prefillName || '') + '"></div>';
        h += '<div class="me-field"><label>Zelle email or phone (optional)</label>' +
             '<input type="text" id="alHandle" class="me-input" placeholder="office@example.com or 845-555-0142"></div>';
        h += '<div class="me-field"><label>Note (optional)</label>' +
             '<input type="text" id="alNote" class="me-input" placeholder="e.g. Father\'s business"></div>';
        h += '</div>';

        host.showModal('Add a Known Payer', h, function () {
            var client = db(), cid = campId();
            var fk = (document.getElementById('alFam') || {}).value;
            var name = ((document.getElementById('alName') || {}).value || '').trim();
            var handle = ((document.getElementById('alHandle') || {}).value || '').trim();
            if (!fk) { if (host.toast) host.toast('Pick a family', 'error'); return; }
            if (!name && !handle) { if (host.toast) host.toast('Enter a name or a handle', 'error'); return; }

            var M = Match();
            client.rpc('add_payer_alias', {
                p_camp_id: cid,
                p_family_key: fk,
                p_display_name: name,
                // Normalized here, by the same function the matcher uses, so a
                // hand-typed payer compares identically to a learned one.
                p_normalized: (name && M) ? M.normalize(name) : '',
                p_handle: (handle && M) ? M.normalizeHandle(handle) : handle,
                p_kind: 'zelle',
                p_source: 'confirmed',
                p_note: ((document.getElementById('alNote') || {}).value || '').trim()
            }).then(function (r) {
                if (r.error) { if (host.toast) host.toast('Failed: ' + r.error.message, 'error'); return; }
                if (r.data && r.data.duplicate) { if (host.toast) host.toast('Already known — nothing to add'); }
                else if (host.toast) host.toast('Payer added');
                if (host.closeModal) host.closeModal('dynModal');
                D.refresh().then(function () { host.onChange(); });
            });
        });
    };

    D.openAliases = function () {
        var rows = state.aliases.map(function (a) {
            return '<tr>' +
                '<td style="padding:6px 8px 6px 0">' + host.esc(a.displayName || a.handle || '—') + '</td>' +
                '<td style="padding:6px 8px">' + host.esc(famName(a.familyKey)) + '</td>' +
                '<td style="padding:6px 8px">' + host.esc(a.handle || '') + '</td>' +
                '<td style="padding:6px 8px;font-size:.75rem;color:var(--s500)">' + host.esc(a.source) + '</td>' +
                '<td style="padding:6px 0;text-align:right"><button class="me-btn me-btn--ghost me-btn--sm"' +
                ' onclick="CampistryDeposits.deleteAlias(\'' + host.jesc(a.id) + '\')">Forget</button></td>' +
                '</tr>';
        }).join('');

        var body = '<p style="margin:0 0 14px;color:var(--s500);font-size:.85rem">' +
            'Payers Campistry has learned. A Zelle payment from any of these names or handles is credited to the ' +
            'matching family automatically, however different the name looks from the household on file — a business, ' +
            'a maiden name, a grandparent. Each one was taught by somebody resolving a deposit once.</p>' +
            (state.aliases.length
                ? '<table style="width:100%;border-collapse:collapse;font-size:.85rem">' +
                  '<thead><tr style="text-align:left;border-bottom:1px solid var(--s100)">' +
                  '<th style="padding:6px 8px 6px 0">Pays as</th><th style="padding:6px 8px">Family</th>' +
                  '<th style="padding:6px 8px">Handle</th><th style="padding:6px 8px">Learned</th><th></th>' +
                  '</tr></thead><tbody>' + rows + '</tbody></table>'
                : '<p style="color:var(--s400)">Nothing known yet. Add the payers the camp already knows about, or resolve a deposit in the inbox and it is remembered from then on.</p>') +
            '<div style="margin-top:18px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryDeposits.openAddAlias()">+ Add a payer</button></div>';

        host.showModal('Known Payers', body, null, { maxWidth: 760 });
    };

    // ── settings ─────────────────────────────────────────────────────────────

    D.openSettings = async function () {
        var client = db(), cid = campId();
        if (!client || !cid) return;
        var res = await client.rpc('get_camp_deposit_settings', { p_camp_id: cid });
        if (res.error || !res.data || res.data.success === false) {
            var why = (res.error && res.error.message) || (res.data && res.data.error) || 'unknown';
            console.warn('[Deposits] get_camp_deposit_settings failed:', why);
            if (host.toast) host.toast(D.explainError(why), 'error');
            return;
        }
        state.settings = res.data;
        var s = res.data;
        var domain = (W.CAMPISTRY_INBOUND_DOMAIN || 'inbound.campistry.org');
        // On a Resend MANAGED address (<anything>@<id>.resend.app) the safe form
        // is the bare token as the local part: plus-addressing is accepted by
        // most providers but not guaranteed, and a silently-dropped '+' means a
        // camp's bank alerts vanish with no error anywhere. On a custom domain a
        // readable prefix is nicer (and leaves room to route other purposes on
        // the same domain later), so it's a constant rather than a hard choice.
        // The edge function accepts both shapes.
        var prefix = (typeof W.CAMPISTRY_INBOUND_PREFIX === 'string')
            ? W.CAMPISTRY_INBOUND_PREFIX : 'deposits+';
        var address = prefix + s.inboundToken + '@' + domain;

        var h = '<div class="me-modal-form">';
        h += '<div class="me-field"><label>Send the bank\'s deposit alerts here</label>' +
             '<input type="text" class="me-input" readonly value="' + host.esc(address) + '" onclick="this.select()">' +
             '<div style="font-size:.75rem;color:var(--s500);margin-top:4px">' +
             'In the camp\'s online banking, add this as an alert recipient for incoming deposits and Zelle payments — ' +
             'or set up a forwarding rule from whichever mailbox already gets them.</div></div>';

        h += '<div class="me-field"><label><input type="checkbox" id="depDryRun"' + (s.dryRun ? ' checked' : '') + '> ' +
             'Dry run — match and explain, but never post automatically</label>' +
             '<div style="font-size:.75rem;color:var(--s500);margin-top:4px">' +
             'Leave this on for the first week or two. Every deposit still appears in the inbox with its match and ' +
             'confidence, so the office can check the matches are right before trusting them.</div></div>';

        h += '<div class="me-field"><label>Only accept alerts from these sender domains</label>' +
             '<input type="text" id="depAllow" class="me-input" placeholder="chase.com, alerts.wellsfargo.com" value="' +
             host.esc((s.senderAllowlist || []).join(', ')) + '">' +
             '<div style="font-size:.75rem;color:var(--s500);margin-top:4px">' +
             'Strongly recommended. While this is empty, any email reaching the address above is trusted.</div></div>';

        h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
             '<div class="me-field"><label>Post automatically at or above</label>' +
             '<input type="number" id="depAuto" class="me-input" min="0" max="100" value="' + (s.autoPostAt || 90) + '"></div>' +
             '<div class="me-field"><label>Suggest at or above</label>' +
             '<input type="number" id="depSuggest" class="me-input" min="0" max="100" value="' + (s.suggestAt || 40) + '"></div>' +
             '</div>';
        h += '</div>';

        host.showModal('Deposit Settings', h, function () {
            var allow = (document.getElementById('depAllow').value || '')
                .split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
            client.rpc('set_camp_deposit_settings', {
                p_camp_id: cid,
                p_dry_run: document.getElementById('depDryRun').checked,
                p_sender_allowlist: allow,
                p_auto_post_at: parseInt(document.getElementById('depAuto').value, 10) || 90,
                p_suggest_at: parseInt(document.getElementById('depSuggest').value, 10) || 40
            }).then(function (r) {
                if (r.error) { if (host.toast) host.toast('Save failed: ' + r.error.message, 'error'); return; }
                state.settings = r.data;
                if (host.closeModal) host.closeModal('dynModal');
                if (host.toast) host.toast('Deposit settings saved');
                D.refresh().then(function () { renderInbox(); host.onChange(); });
            });
        });
    };

    if (typeof window !== 'undefined') window.CampistryDeposits = D;
    if (typeof module !== 'undefined' && module.exports) module.exports = D;
})();
