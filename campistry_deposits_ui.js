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

    // Bumped with campistry_me.html's ?v= on every deposits change, and shown
    // in the Bank layouts footer. Twice now a fix has been live on the server
    // while the browser ran an older copy, and there was no way to tell from
    // the screen which one was which -- so the screen says.
    D.BUILD = '20260911-03';

    var state = {
        loaded: false,
        loading: false,
        deposits: [],       // review + unmatched + recently posted
        aliases: [],
        credits: {},        // famKey -> [ledger entries]
        settings: null,
        templates: [],      // learned bank layouts: this camp's + shared
        teach: null,        // in-progress teaching session (pasted text)
        teachPdf: null,     // in-progress teaching session (printed PDF)
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
                client.rpc('get_camp_deposit_credits', { p_camp_id: cid }),
                // Tolerated separately: migration 147 may not be applied yet,
                // and a missing template table must not blank the inbox.
                client.rpc('get_bank_templates', { p_camp_id: cid })
                      .then(function (r) { return r; }, function () { return { data: null }; })
            ]);
            var deps = res[0], als = res[1], crd = res[2], tpl = res[3];

            if (deps.error) throw deps.error;
            state.deposits = (deps.data && deps.data.deposits) || [];
            state.aliases = (als.data && als.data.aliases) || [];
            state.credits = (crd.data && crd.data.credits) || {};
            state.templates = (tpl && tpl.data && tpl.data.templates) || [];
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

    // 'unparsed' counts as pending: it is a message that mentioned money and
    // that nothing in the parser understood. It is the item most likely to be
    // a real deposit nobody knows about, so it must never sit below the fold.
    D.isPending = function (d) {
        return d.status === 'review' || d.status === 'unmatched' || d.status === 'unparsed';
    };

    D.totalPending = function () {
        return state.deposits.filter(D.isPending).length;
    };

    D.pendingAmount = function () {
        return state.deposits.reduce(function (sum, d) {
            // Deliberately excludes 'unparsed': its amount is unknown and
            // stored as 0, so adding it would understate nothing but imply we
            // know a total we do not.
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
            ignored:   ['#374151', '#F3F4F6', 'Not tuition'],
            unparsed:  ['#5B21B6', '#EDE9FE', 'Couldn\'t read']
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

    // A message that mentioned money and that the parser could not read at all.
    // It is shown with the text that actually arrived, because that text is the
    // only way anyone can tell whether it was a real deposit -- and the only
    // way a bank we have never seen becomes visible rather than invisible.
    function unparsedRow(d) {
        var when = (d.created_at || '').slice(0, 10) || '—';
        var body = (d.raw_excerpt || '').slice(0, 1200);
        return '<div style="border:1px solid #DDD6FE;background:#FAF5FF;border-radius:var(--r);padding:12px 14px;margin-bottom:10px">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap">' +
            '<strong style="font-size:.95rem">An email we could not read</strong>' +
            '<div style="font-size:.75rem;color:var(--s500)">' + host.esc(when) + ' ' + statusPill(d) + '</div></div>' +
            '<div style="font-size:.8rem;color:var(--s600);margin-top:6px">' +
            'It mentions money, so it is kept here rather than discarded — but nothing about it has been counted anywhere. ' +
            'If it is a real payment, add it to the family by hand; if it is not, dismiss it.</div>' +
            (d.raw_subject ? '<div style="font-size:.78rem;color:var(--s500);margin-top:6px">Subject: ' + host.esc(d.raw_subject) + '</div>' : '') +
            (body ? '<pre style="white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid var(--s100);border-radius:var(--r);padding:8px 10px;margin:8px 0 0;font-size:.74rem;max-height:190px;overflow:auto">' + host.esc(body) + '</pre>' : '') +
            '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
            // Teaching from the email that just failed is the shortest path
            // there is: it is already on screen and it is the exact layout that
            // needs handling.
            '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryDeposits.teachFromDeposit(\'' + host.jesc(d.id) + '\')">Show Campistry how to read this</button>' +
            '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryDeposits.ignore(\'' + host.jesc(d.id) + '\')">Dismiss</button>' +
            '</div>' +
            '</div>';
    }

    function depositRow(d) {
        if (d.status === 'unparsed') return unparsedRow(d);
        var amt = (d.amount_cents || 0) / 100;
        var when = d.deposit_date || (d.created_at || '').slice(0, 10) || '—';
        var payer = d.payer_name || '(payer not readable)';

        // A return reads as a payment unless it is labelled loudly. The ledger
        // gets the sign right on its own (get_camp_deposit_credits applies it
        // from is_reversal), but the row is what a human acts on, and "$400
        // from DAVID KLEIN" invites someone to match it as income when it is
        // money the bank has already taken back.
        var rev = !!d.is_reversal;
        var head = '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap">' +
            '<div><strong style="font-size:1.02rem' + (rev ? ';color:#991B1B' : '') + '">' +
            (rev ? '\u2212' : '') + host.fm(amt) + '</strong>' +
            ' <span style="color:var(--s600)">' + (rev ? 'returned by ' : 'from ') + host.esc(payer) + '</span>' +
            (d.memo_code ? ' <code style="background:var(--s50);padding:1px 5px;border-radius:4px;font-size:.72rem">' + host.esc(d.memo_code) + '</code>' : '') +
            '</div>' +
            '<div style="font-size:.75rem;color:var(--s500)">' + host.esc(when) + ' · ' +
            host.esc((d.kind || '').toUpperCase()) + (d.bank ? ' · ' + host.esc(d.bank) : '') + ' ' + statusPill(d) + '</div>' +
            '</div>';

        var revBanner = rev
            ? '<div style="background:#FEF2F2;border:1px solid #FECACA;color:#991B1B;padding:7px 11px;border-radius:var(--r);font-size:.78rem;margin:8px 0">' +
              '<strong>This payment was returned.</strong> The money is not in the account. ' +
              'Matching it to a family <strong>subtracts</strong> it from their balance — do that for the family whose ' +
              'original payment bounced, then chase them for it.</div>'
            : '';

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

        return '<div style="border:1px solid ' + (rev ? '#FECACA' : 'var(--s100)') +
               ';border-radius:var(--r);padding:12px 14px;margin-bottom:10px' +
               (rev ? ';background:#FFFBFB' : '') + '">' +
               head + memoLine + revBanner + why + actions + '</div>';
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

        var pending = state.deposits.filter(D.isPending);
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
             '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryDeposits.openTemplates()">Bank layouts (' +
             state.templates.filter(function (x) { return x.scope === 'camp'; }).length + ')</button>' +
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


    // ── teaching Campistry a bank's layout ───────────────────────────────────
    //
    // A camp pastes one of its own alert emails, selects the sender's name, the
    // amount and the memo, and campistry_deposit_template.js turns each
    // selection into two rules. Every payment that bank sends afterwards is
    // read by those rules instead of by guessing at prose.
    //
    // A <textarea> is used deliberately. selectionStart/selectionEnd give exact
    // character offsets with no DOM walking, no contenteditable quirks, and it
    // works on a phone -- which is where a head counselor actually is.
    //
    // Nothing is saved until the rules have been replayed against the pasted
    // email and shown to reproduce what was highlighted. A template that cannot
    // do that will not do better on mail nobody has checked.

    function Tpl() { return W.CampistryDepositTemplate || null; }

    var TEACH_LABELS = {
        payerName: ['Who sent it', 'the person or business name'],
        amount:    ['How much', 'the dollar amount'],
        memo:      ['The memo', 'the note the sender typed, if there is one']
    };

    D.openTeach = function (prefillText, prefillFrom) {
        var T = Tpl();
        if (!T) { if (host.toast) host.toast('The template engine did not load.', 'error'); return; }

        state.teach = {
            text: prefillText || '',
            from: prefillFrom || '',
            label: '',
            marks: {},
            result: null
        };
        renderTeach();
    };

    /** Rebuild the modal in place; the textarea's value and caret are preserved. */
    function renderTeach() {
        var t = state.teach;
        var h = '<div class="me-modal-form">';

        h += '<p style="font-size:.84rem;color:var(--s600);margin:0 0 12px">' +
             'Paste one of your bank\'s deposit alerts below, then highlight each piece and press its button. ' +
             'Campistry learns where those pieces live and reads every future alert from this bank the same way.</p>';

        h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
             '<div class="me-field"><label>The bank\'s email address</label>' +
             '<input type="text" id="tchFrom" class="me-input" placeholder="alerts@capitalone.com" value="' +
             host.esc(t.from) + '" oninput="CampistryDeposits.teachSet(\'from\', this.value)">' +
             '<div style="font-size:.72rem;color:var(--s500);margin-top:4px">Who the alert comes FROM. This is how the layout is recognised later.</div></div>' +
             '<div class="me-field"><label>Bank name <span style="color:var(--s400);font-weight:400">(optional)</span></label>' +
             '<input type="text" id="tchLabel" class="me-input" placeholder="Capital One" value="' +
             host.esc(t.label) + '" oninput="CampistryDeposits.teachSet(\'label\', this.value)"></div>' +
             '</div>';

        h += '<div class="me-field"><label>The email</label>' +
             '<textarea id="tchText" class="me-input" rows="9" spellcheck="false" ' +
             'style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78rem;line-height:1.5" ' +
             'placeholder="Paste the whole email here…" ' +
             'oninput="CampistryDeposits.teachText(this.value)">' + host.esc(t.text) + '</textarea></div>';

        h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">';
        Object.keys(TEACH_LABELS).forEach(function (f) {
            var got = t.marks[f];
            h += '<button class="me-btn ' + (got ? 'me-btn--pri' : 'me-btn--sec') + ' me-btn--sm" ' +
                 'onclick="CampistryDeposits.teachMark(\'' + f + '\')">' +
                 (got ? '✓ ' : '') + host.esc(TEACH_LABELS[f][0]) + '</button>';
        });
        h += '</div>';
        h += '<div style="font-size:.74rem;color:var(--s500);margin-bottom:12px">' +
             'Select the text in the box above, then press the matching button.</div>';

        h += '<div id="tchPreview">' + teachPreview() + '</div>';
        h += '</div>';

        host.showModal('Teach Campistry your bank\'s emails', h, function () { D.teachSave(); }, 'Test and save');

        // Restore the textarea contents after the modal re-renders.
        setTimeout(function () {
            var ta = document.getElementById('tchText');
            if (ta && ta.value !== t.text) ta.value = t.text;
        }, 0);
    }

    /** Re-render only the preview, so typing in the textarea is never interrupted. */
    function refreshPreview() {
        var el = document.getElementById('tchPreview');
        if (el) el.innerHTML = teachPreview();
        // Keep the mark buttons' ticks honest without rebuilding the textarea.
        var t = state.teach;
        Object.keys(TEACH_LABELS).forEach(function (f) {
            var btn = document.querySelector('[onclick*="teachMark(\'' + f + '\')"]');
            if (!btn) return;
            var got = !!t.marks[f];
            btn.className = 'me-btn ' + (got ? 'me-btn--pri' : 'me-btn--sec') + ' me-btn--sm';
            btn.textContent = (got ? '✓ ' : '') + TEACH_LABELS[f][0];
        });
    }

    function teachPreview() {
        var t = state.teach, T = Tpl();
        var marked = Object.keys(t.marks);
        if (!t.text.trim()) {
            return '<div style="font-size:.8rem;color:var(--s500)">Paste an email to begin.</div>';
        }
        if (!marked.length) {
            return '<div style="font-size:.8rem;color:var(--s500)">Now highlight the sender\'s name and press <strong>Who sent it</strong>.</div>';
        }

        var h = '<div style="background:var(--s50);border-radius:var(--r);padding:10px 12px">';
        h += '<div style="font-size:.74rem;color:var(--s500);margin-bottom:6px">You highlighted</div>';
        marked.forEach(function (f) {
            h += '<div style="font-size:.82rem;margin-bottom:3px"><strong>' + host.esc(TEACH_LABELS[f][0]) +
                 ':</strong> ' + host.esc(t.text.slice(t.marks[f].start, t.marks[f].end)) + '</div>';
        });

        // Learn as they go, so a rule that cannot be built is reported at the
        // moment it fails rather than after they press save.
        var res = T.learn(t.text, t.marks, {});
        var tpl = res.template;
        if (tpl && Object.keys(tpl.fields).length) {
            var back = T.read(tpl, t.text);
            h += '<div style="font-size:.74rem;color:var(--s500);margin:10px 0 6px">Reading it back</div>';
            Object.keys(tpl.fields).forEach(function (f) {
                var r = back[f];
                var okMark = r && r.value === t.text.slice(t.marks[f].start, t.marks[f].end).trim();
                h += '<div style="font-size:.82rem;margin-bottom:3px">' +
                     (okMark ? '<span style="color:#065F46">✓</span> ' : '<span style="color:#991B1B">✗</span> ') +
                     host.esc(TEACH_LABELS[f][0]) + ': ' + host.esc((r && r.value) || '(nothing)') +
                     (r && r.agree ? ' <span style="color:var(--s400);font-size:.72rem">· both rules agree</span>' : '') +
                     '</div>';
            });
        }
        if (res.errors && res.errors.length) {
            h += '<div style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;padding:6px 9px;' +
                 'border-radius:var(--r);font-size:.76rem;margin-top:8px">' +
                 res.errors.map(function (e) { return host.esc(e); }).join('<br>') + '</div>';
        }
        h += '</div>';
        return h;
    }

    D.teachText = function (v) {
        var t = state.teach; if (!t) return;
        // Any highlight describes offsets into the OLD text, so editing the
        // email invalidates them. Silently keeping them would learn rules from
        // positions that no longer point at anything.
        if (v !== t.text) t.marks = {};
        t.text = v;
        refreshPreview();
    };

    D.teachSet = function (k, v) { if (state.teach) state.teach[k] = v; };

    D.teachMark = function (field) {
        var t = state.teach; if (!t) return;
        var ta = document.getElementById('tchText');
        if (!ta) return;
        var start = ta.selectionStart, end = ta.selectionEnd;
        if (start == null || end == null || end <= start) {
            if (host.toast) host.toast('Select the ' + TEACH_LABELS[field][1] + ' in the email first.', 'error');
            return;
        }
        t.text = ta.value;
        t.marks[field] = { start: start, end: end };
        refreshPreview();
    };

    D.teachSave = async function () {
        var t = state.teach, T = Tpl();
        if (!t || !T) return;
        var client = db(), cid = campId();

        var sig = T.signature(t.from);
        if (!sig) { if (host.toast) host.toast('Enter the address the bank sends from.', 'error'); return; }
        if (!Object.keys(t.marks).length) { if (host.toast) host.toast('Highlight at least the sender\'s name.', 'error'); return; }

        var res = T.learn(t.text, t.marks, { bank: t.label });
        if (!res.ok) {
            if (host.toast) host.toast(res.errors[0], 'error');
            refreshPreview();
            return;
        }

        var r = await client.rpc('save_bank_template', {
            p_camp_id: cid,
            p_bank_signature: sig,
            p_bank_label: t.label || sig,
            p_template: res.template,
            p_template_hash: T.hash(res.template),
            p_is_shareable: T.isShareable(res.template)
        });
        if (r.error) { if (host.toast) host.toast(D.explainError(r.error.message), 'error'); return; }
        if (r.data && r.data.success === false) { if (host.toast) host.toast(D.explainError(r.data.error), 'error'); return; }

        state.teach = null;
        if (host.closeModal) host.closeModal('dynModal');
        if (host.toast) host.toast('Saved. Future alerts from ' + sig + ' will be read this way.');
        await D.refresh();
        renderInbox();
        host.onChange();
    };

    /** Teach from the email that failed — it is already on screen. */

    // ── teaching from a printed PDF ──────────────────────────────────────────
    //
    // The paste-an-email path above works, but it asks an office to find raw
    // email text, which is not a thing most people know how to produce. Every
    // mail client can print to PDF, and everybody already knows how.
    //
    // One question at a time, in order, with the page on screen: highlight the
    // sender, Done; highlight the amount, Done; highlight the memo, Done.

    function Pdf() { return W.CampistryDepositTeachPdf || null; }

    D.openTeachPdf = function () {
        if (!Pdf() || !W.pdfjsLib) {
            if (host.toast) host.toast('PDF support did not load. Use "Paste the email" instead.', 'error');
            return;
        }
        state.teachPdf = { step: -1, from: '', label: '', marks: {}, doc: null, text: '' };
        renderTeachPdf();
    };

    function renderTeachPdf() {
        var t = state.teachPdf;
        var h = '<div class="me-modal-form">';

        if (!t.doc) {
            h += '<p style="font-size:.85rem;color:var(--s600);margin:0 0 14px">' +
                 'Open one of your bank\'s deposit alert emails, print it, and choose ' +
                 '<strong>Save as PDF</strong>. Upload that file here and Campistry will ask you to point at ' +
                 'three things on it.</p>';
            h += '<div class="me-field"><label>The bank\'s email address</label>' +
                 '<input type="text" id="tpFrom" class="me-input" placeholder="alerts@capitalone.com" value="' +
                 host.esc(t.from) + '" oninput="CampistryDeposits.teachPdfSet(\'from\', this.value)">' +
                 '<div style="font-size:.72rem;color:var(--s500);margin-top:4px">Who the alert comes FROM. This is how the layout is recognised later.</div></div>';
            h += '<div class="me-field"><label>Bank name <span style="color:var(--s400);font-weight:400">(optional)</span></label>' +
                 '<input type="text" id="tpLabel" class="me-input" placeholder="Capital One" value="' +
                 host.esc(t.label) + '" oninput="CampistryDeposits.teachPdfSet(\'label\', this.value)"></div>';
            h += '<div class="me-field"><label>The printed email</label>' +
                 '<input type="file" id="tpFile" accept="application/pdf" class="me-input" ' +
                 'onchange="CampistryDeposits.teachPdfLoad(this.files && this.files[0])"></div>';
            h += '<div id="tpStatus" style="font-size:.8rem;color:var(--s500)"></div>';
            h += '</div>';
            host.showModal('Teach Campistry your bank\'s emails', h, null);
            return;
        }

        // ── the walkthrough ──
        var field = P_FIELD(t.step);
        var pdfP = Pdf();
        h += '<div id="tpPrompt" style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1E40AF;' +
             'padding:10px 13px;border-radius:var(--r);margin-bottom:10px">' + teachPdfPrompt() + '</div>';
        h += '<div id="tpPage" style="border:1px solid var(--s100);border-radius:var(--r);overflow:auto;' +
             'max-height:52vh;background:#fff;position:relative"></div>';
        h += '<div style="font-size:.74rem;color:var(--s500);margin-top:8px">' +
             'Drag across the words on the page above, then press the button.</div>';
        h += '</div>';

        host.showModal('Teach Campistry your bank\'s emails', h, null);
        setTimeout(function () { paintPdfPage(); }, 0);
    }

    function P_FIELD(step) {
        var P = Pdf();
        return (P && step >= 0 && step < P.FIELD_ORDER.length) ? P.FIELD_ORDER[step] : null;
    }

    function teachPdfPrompt() {
        var t = state.teachPdf, P = Pdf();
        var field = P_FIELD(t.step);

        if (!field) {
            // All three asked. Show what was learned before anything is saved.
            var T = Tpl();
            var res = T.learn(t.text, t.marks, { bank: t.label, source: 'pdf' });
            var h = '<strong>That is everything.</strong><div style="font-size:.82rem;margin-top:6px">';
            if (res.ok) {
                var back = T.read(res.template, t.text);
                Object.keys(res.template.fields).forEach(function (f) {
                    h += '<div>' + host.esc(P.PROMPTS[f].title.replace('Highlight ', '')) + ': <strong>' +
                         host.esc((back[f] && back[f].value) || '—') + '</strong></div>';
                });
                h += '</div><button class="me-btn me-btn--pri me-btn--sm" style="margin-top:10px" ' +
                     'onclick="CampistryDeposits.teachPdfSave()">Save this layout</button>';
            } else {
                h += host.esc(res.errors[0]) + '</div>' +
                     '<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:10px" ' +
                     'onclick="CampistryDeposits.teachPdfStep(0)">Start over</button>';
            }
            return h;
        }

        var got = t.marks[field];
        var prompt = P.PROMPTS[field];
        return '<strong>' + host.esc(prompt.title) + '</strong>' +
            '<div style="font-size:.8rem;margin-top:4px">' + host.esc(prompt.help) + '</div>' +
            (got ? '<div style="font-size:.82rem;margin-top:6px">You highlighted: <strong>' +
                   host.esc(t.text.slice(got.start, got.end).trim()) + '</strong></div>' : '') +
            '<div style="margin-top:9px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryDeposits.teachPdfTake()">' +
            (got ? 'Re-highlight' : 'Use what I highlighted') + '</button>' +
            (got ? '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryDeposits.teachPdfStep(' +
                   (t.step + 1) + ')">Done</button>' : '') +
            (field === 'memo' ? '<button class="me-btn me-btn--ghost me-btn--sm" ' +
                   'onclick="CampistryDeposits.teachPdfStep(' + (t.step + 1) + ')">This bank has no memo</button>' : '') +
            '</div>';
    }

    /**
     * Render the page image with an invisible, selectable text layer on top.
     *
     * The canvas is what the camp reads; the spans are what a drag actually
     * selects. They are positioned from the same viewport transform, so the
     * words a camp drags across are the words whose offsets get recorded.
     */
    async function paintPdfPage() {
        var t = state.teachPdf;
        var host_el = document.getElementById('tpPage');
        if (!host_el || !t.doc) return;

        var pageNo = t.pageNo || 1;
        var page = await t.doc.getPage(pageNo);
        var wrapW = Math.max(320, host_el.clientWidth - 4);
        var base = page.getViewport({ scale: 1 });
        var viewport = page.getViewport({ scale: wrapW / base.width });

        var canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.style.display = 'block';
        var layer = document.createElement('div');
        layer.id = 'tpLayer';
        layer.style.cssText = 'position:absolute;inset:0;color:transparent;' +
            'line-height:1;transform-origin:0 0;user-select:text;-webkit-user-select:text';

        host_el.innerHTML = '';
        var frame = document.createElement('div');
        frame.style.cssText = 'position:relative;width:' + viewport.width + 'px';
        frame.appendChild(canvas);
        frame.appendChild(layer);
        host_el.appendChild(frame);

        await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;

        t.items.filter(function (it) { return it.page === pageNo; }).forEach(function (it) {
            var sp = document.createElement('span');
            sp.textContent = it.str;
            sp.setAttribute('data-start', String(it.start));
            var left = it.x * viewport.scale;
            var top = viewport.height - (it.y * viewport.scale) - (it.h * viewport.scale);
            sp.style.cssText = 'position:absolute;white-space:pre;transform-origin:0 0;' +
                'left:' + left + 'px;top:' + top + 'px;' +
                'font-size:' + (it.h * viewport.scale) + 'px;';
            layer.appendChild(sp);
        });

        if (t.doc.numPages > 1) {
            var nav = document.createElement('div');
            nav.style.cssText = 'position:sticky;bottom:0;background:var(--s50);padding:6px;text-align:center;font-size:.76rem';
            nav.innerHTML = 'Page ' + pageNo + ' of ' + t.doc.numPages + ' ' +
                '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryDeposits.teachPdfPage(' + (pageNo - 1) + ')">Prev</button> ' +
                '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryDeposits.teachPdfPage(' + (pageNo + 1) + ')">Next</button>';
            host_el.appendChild(nav);
        }
    }

    D.teachPdfSet = function (k, v) { if (state.teachPdf) state.teachPdf[k] = v; };

    D.teachPdfPage = function (n) {
        var t = state.teachPdf;
        if (!t || !t.doc || n < 1 || n > t.doc.numPages) return;
        t.pageNo = n;
        paintPdfPage();
    };

    D.teachPdfLoad = async function (file) {
        var t = state.teachPdf, P = Pdf();
        if (!file || !t || !P) return;
        var el = document.getElementById('tpStatus');
        if (el) el.textContent = 'Reading the PDF…';
        try {
            var buf = await file.arrayBuffer();
            var read = await P.readPdf(buf, W.pdfjsLib);

            // Strip print chrome BEFORE the offsets are used, so what the camp
            // highlights and what the rules are learned from are the same text.
            var own = [];
            try {
                var u = W.CampistryAuth && W.CampistryAuth.user && W.CampistryAuth.user();
                if (u && u.email) own.push(u.email);
            } catch (e) { /* best effort */ }

            t.doc = read.doc;
            t.items = read.items;
            t.text = read.text;
            t.ownAddresses = own;
            t.pageNo = 1;
            t.step = 0;
            renderTeachPdf();
        } catch (e) {
            if (el) el.textContent = '';
            if (host.toast) host.toast('That PDF could not be read: ' + ((e && e.message) || e), 'error');
        }
    };

    D.teachPdfTake = function () {
        var t = state.teachPdf, P = Pdf();
        var field = P_FIELD(t.step);
        if (!field) return;
        var layer = document.getElementById('tpLayer');
        var off = layer && P.offsetsFromSelection(layer);
        if (!off) {
            if (host.toast) host.toast('Drag across the words on the page first.', 'error');
            return;
        }
        t.marks[field] = { start: off.start, end: off.end };
        var el = document.getElementById('tpPrompt');
        if (el) el.innerHTML = teachPdfPrompt();
    };

    D.teachPdfStep = function (n) {
        var t = state.teachPdf;
        if (!t) return;
        if (n === 0) t.marks = {};
        t.step = n;
        var el = document.getElementById('tpPrompt');
        if (el) el.innerHTML = teachPdfPrompt();
    };

    D.teachPdfSave = async function () {
        var t = state.teachPdf, T = Tpl(), P = Pdf();
        if (!t || !T || !P) return;
        var client = db(), cid = campId();

        var sig = T.signature(t.from);
        if (!sig) { if (host.toast) host.toast('Enter the address the bank sends from.', 'error'); return; }

        var res = T.learn(t.text, t.marks, { bank: t.label, source: 'pdf' });
        if (!res.ok) { if (host.toast) host.toast(res.errors[0], 'error'); return; }

        var r = await client.rpc('save_bank_template', {
            p_camp_id: cid,
            p_bank_signature: sig,
            p_bank_label: t.label || sig,
            p_template: res.template,
            p_template_hash: T.hash(res.template),
            p_is_shareable: T.isShareable(res.template)
        });
        if (r.error) { if (host.toast) host.toast(D.explainError(r.error.message), 'error'); return; }
        if (r.data && r.data.success === false) { if (host.toast) host.toast(D.explainError(r.data.error), 'error'); return; }

        state.teachPdf = null;
        if (host.closeModal) host.closeModal('dynModal');
        if (host.toast) host.toast('Saved. Future alerts from ' + sig + ' will be read this way.');
        await D.refresh();
        renderInbox();
        host.onChange();
    };

    D.teachFromDeposit = function (id) {
        var d = null;
        for (var i = 0; i < state.deposits.length; i++) {
            if (state.deposits[i].id === id) { d = state.deposits[i]; break; }
        }
        if (!d) return;
        // raw_subject often carries the sender; the office can correct it.
        D.openTeach(d.raw_excerpt || '', '');
    };

    D.openTemplates = function () {
        var mine = state.templates.filter(function (x) { return x.scope === 'camp'; });
        var shared = state.templates.filter(function (x) { return x.scope === 'shared'; });

        var h = '<div class="me-modal-form">';
        h += '<p style="font-size:.84rem;color:var(--s600);margin:0 0 12px">' +
             'Campistry reads every bank\'s alerts on its own. Teaching it yours makes that exact, ' +
             'and is worth doing if anything is coming through wrong.</p>';
        h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
             '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryDeposits.openTeachPdf()">' +
             'Upload a printed email</button>' +
             '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryDeposits.openTeach()">' +
             'Paste the email text</button></div>';

        h += '<h4 style="margin:0 0 6px;font-size:.86rem">Yours (' + mine.length + ')</h4>';
        h += mine.length ? mine.map(templateRow).join('')
            : '<p style="color:var(--s500);font-size:.82rem;margin:0 0 14px">None yet.</p>';

        if (shared.length) {
            h += '<h4 style="margin:14px 0 6px;font-size:.86rem">From other camps (' + shared.length + ')</h4>';
            h += '<p style="font-size:.74rem;color:var(--s500);margin:0 0 8px">' +
                 'Layouts several camps taught independently and that all agreed on. Used only where you have not taught your own.</p>';
            h += shared.map(templateRow).join('');
        }
        h += '<div style="margin-top:16px;padding-top:10px;border-top:1px solid var(--s100);' +
             'font-size:.7rem;color:var(--s400)">Campistry deposits build ' + host.esc(D.BUILD) +
             (Pdf() ? '' : ' · PDF upload unavailable — this page is running an older copy, reload it') +
             '</div>';
        h += '</div>';
        host.showModal('Bank layouts', h, null);
    };

    function templateRow(t) {
        var total = (t.hits || 0) + (t.misses || 0);
        var rate = total ? Math.round((t.hits || 0) * 100 / total) : null;
        // A template that has stopped fitting must show as a number, not as a
        // quietly wrong answer. Conflicts -- the two rules disagreeing -- are
        // the earliest signal that the bank changed its layout.
        var warn = (t.conflicts || 0) > 0 || (rate !== null && rate < 80);
        return '<div style="border:1px solid ' + (warn ? '#FDE68A' : 'var(--s100)') +
            ';border-radius:var(--r);padding:9px 12px;margin-bottom:8px">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">' +
            '<strong style="font-size:.88rem">' + host.esc(t.bank_label || t.bank_signature) + '</strong>' +
            '<span style="font-size:.72rem;color:var(--s500)">' + host.esc(t.bank_signature) + '</span></div>' +
            '<div style="font-size:.74rem;color:var(--s500);margin-top:4px">' +
            (total ? (rate + '% read cleanly over ' + total + ' email' + (total === 1 ? '' : 's')) : 'Not used yet') +
            ((t.conflicts || 0) ? ' · <span style="color:#92400E">' + t.conflicts + ' disagreed — this bank may have changed its layout</span>' : '') +
            '</div>' +
            (t.scope === 'camp'
                ? '<div style="margin-top:6px;display:flex;gap:8px">' +
                  '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryDeposits.openTeach(\'\', \'' + host.jesc(t.bank_signature) + '\')">Re-teach</button>' +
                  '<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryDeposits.forgetTemplate(\'' + host.jesc(t.bank_signature) + '\')">Forget</button></div>'
                : '') +
            '</div>';
    }

    D.forgetTemplate = async function (sig) {
        var client = db(), cid = campId();
        var r = await client.rpc('delete_bank_template', { p_camp_id: cid, p_bank_signature: sig });
        if (r.error) { if (host.toast) host.toast(r.error.message, 'error'); return; }
        await D.refresh();
        D.openTemplates();
    };

    if (typeof window !== 'undefined') window.CampistryDeposits = D;
    if (typeof module !== 'undefined' && module.exports) module.exports = D;
})();
