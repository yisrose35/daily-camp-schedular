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

    // Same reasoning for `document`, and the same trap: a bare reference is a
    // ReferenceError in Node rather than undefined. The render functions are
    // the ones that reach for it, and they are exercised by the tests. Every
    // caller already handles a missing element, so a stub that finds nothing is
    // the correct behaviour outside a browser -- not an error.
    var DOC = (typeof document !== 'undefined') ? document : {
        getElementById: function () { return null; },
        querySelector: function () { return null; },
        createElement: function () { return null; }
    };

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
    D.BUILD = '20260914-02';

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

    // Which tab the console is showing. Kept on the module rather than in the
    // DOM so a refresh after an action lands the office back where they were
    // instead of bouncing them to the top.
    var tab = 'needs';

    D.openInbox = function (startTab) {
        if (!host.showModal) return;
        tab = startTab || 'needs';
        host.showModal('Bank Deposits', '<div id="' + BODY_ID + '">Loading…</div>', null,
                       { maxWidth: 1400, maxHeight: '94vh', minHeight: '86vh' });
        D.refresh().then(renderInbox);
    };

    D.tab = function (name) { tab = name; renderInbox(); };

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
        var cands = (d.candidates || []).slice(0, 4);
        if (!cands.length) {
            return '<div style="font-size:.85rem;color:var(--s500)">' +
                   'No family looks like a match — pick one below.</div>';
        }
        // Laid out as cards rather than a row of wrapping buttons: each one is
        // a decision about somebody's money, and the score and the reason for
        // it are what the office is actually weighing.
        return '<div style="display:flex;gap:8px;flex-wrap:wrap">' + cands.map(function (c, i) {
            var score = c.score || 0;
            var strong = score >= 90;
            var reasons = (c.reasons || []).join(' · ');
            return '<button onclick="CampistryDeposits.resolve(\'' + host.jesc(d.id) + '\',\'' +
                host.jesc(c.familyKey) + '\')" ' +
                'style="text-align:left;cursor:pointer;border-radius:var(--r);padding:10px 13px;min-width:200px;' +
                'flex:1 1 200px;background:' + (i === 0 ? '#F0FDF4' : '#fff') + ';border:1px solid ' +
                (i === 0 ? '#86EFAC' : 'var(--s100)') + '">' +
                '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
                '<strong style="font-size:.94rem">' + host.esc(c.familyName || famName(c.familyKey)) + '</strong>' +
                '<span style="font-size:.76rem;font-weight:700;color:' +
                (strong ? '#065F46' : 'var(--s500)') + '">' + score + '%</span></div>' +
                (reasons ? '<div style="font-size:.74rem;color:var(--s500);margin-top:4px;line-height:1.4">' +
                           host.esc(reasons) + '</div>' : '') +
                '</button>';
        }).join('') + '</div>';
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
        return '<select class="me-input" style="max-width:280px;display:inline-block"' +
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
            '<strong style="font-size:1.05rem">An email we could not read</strong>' +
            '<div style="font-size:.75rem;color:var(--s500)">' + host.esc(when) + ' ' + statusPill(d) + '</div></div>' +
            '<div style="font-size:.86rem;color:var(--s600);margin-top:8px;max-width:760px;line-height:1.6">' +
            'It mentions money, so it is kept here rather than discarded — but nothing about it has been counted anywhere. ' +
            'If it is a real payment, add it to the family by hand; if it is not, dismiss it.</div>' +
            (d.raw_subject ? '<div style="font-size:.78rem;color:var(--s500);margin-top:6px">Subject: ' + host.esc(d.raw_subject) + '</div>' : '') +
            (body ? '<pre style="white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid var(--s100);border-radius:var(--r);padding:12px 14px;margin:12px 0 0;font-size:.78rem;line-height:1.55;max-height:260px;overflow:auto">' + host.esc(body) + '</pre>' : '') +
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
        var payer = d.payer_name || '';

        // A return reads as a payment unless it is labelled loudly. The ledger
        // gets the sign right on its own (get_camp_deposit_credits applies it
        // from is_reversal), but the row is what a human acts on, and "$400
        // from DAVID KLEIN" invites someone to match it as income when it is
        // money the bank has already taken back.
        var rev = !!d.is_reversal;
        var done = d.status === 'posted';

        // Money first and large. Scanning a list of deposits is scanning
        // amounts; everything else is detail you read once you have stopped.
        var left = '<div style="min-width:190px">' +
            '<div style="font-size:1.45rem;font-weight:700;line-height:1.15;color:' +
            (rev ? '#991B1B' : 'inherit') + '">' + (rev ? '−' : '') + host.fm(amt) + '</div>' +
            '<div style="font-size:.95rem;color:var(--s600);margin-top:3px;word-break:break-word">' +
            (payer ? (rev ? 'returned by ' : 'from ') + host.esc(payer)
                   : '<em style="color:var(--s400)">payer not readable</em>') + '</div>' +
            '<div style="font-size:.75rem;color:var(--s500);margin-top:6px">' +
            host.esc(when) + ' · ' + host.esc((d.kind || '').toUpperCase()) +
            (d.bank ? ' · ' + host.esc(d.bank) : '') + '</div>' +
            (d.memo_code
                ? '<div style="margin-top:6px"><code style="background:#EEF2FF;color:#3730A3;padding:2px 7px;' +
                  'border-radius:4px;font-size:.76rem;font-weight:600">' + host.esc(d.memo_code) + '</code></div>'
                : '') +
            ((d.memo && d.memo !== d.memo_code)
                ? '<div style="font-size:.76rem;color:var(--s500);margin-top:5px;word-break:break-word">“' +
                  host.esc(d.memo) + '”</div>' : '') +
            '</div>';

        var notes = '';
        if (rev) {
            notes += '<div style="background:#FEF2F2;border:1px solid #FECACA;color:#991B1B;padding:9px 12px;' +
                'border-radius:var(--r);font-size:.82rem;margin-bottom:10px;line-height:1.5">' +
                '<strong>This payment was returned.</strong> The money is not in the account. Matching it to a ' +
                'family <strong>subtracts</strong> it from their balance — do that for the family whose original ' +
                'payment bounced, then chase them for it.</div>';
        }
        if (d.guardrail) {
            notes += '<div style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;padding:8px 12px;' +
                'border-radius:var(--r);font-size:.82rem;margin-bottom:10px">' + host.esc(d.guardrail) + '</div>';
        }

        var right;
        if (done) {
            right = '<div style="font-size:.9rem">Posted to <strong>' + host.esc(famName(d.family_key)) + '</strong>' +
                '<div style="font-size:.78rem;color:var(--s500);margin-top:3px">' +
                host.esc(d.matched_by === 'auto' ? 'matched automatically · ' + (d.match_confidence || 0) + '% confident'
                                                 : 'matched by staff') + '</div>' +
                '<button class="me-btn me-btn--ghost me-btn--sm" style="margin-top:8px" ' +
                'onclick="CampistryDeposits.unmatch(\'' + host.jesc(d.id) + '\')">Undo</button></div>';
        } else {
            right = notes +
                '<div style="font-size:.76rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;' +
                'color:var(--s500);margin-bottom:7px">Credit this to</div>' +
                candidateButtons(d) +
                '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
                familyPicker(d) +
                '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryDeposits.ignore(\'' +
                host.jesc(d.id) + '\')">Not tuition</button>' +
                '</div>';
        }

        return '<div style="border:1px solid ' + (rev ? '#FECACA' : 'var(--s100)') + ';border-radius:var(--r);' +
            'padding:16px 18px;margin-bottom:12px' + (rev ? ';background:#FFFBFB' : '') + '">' +
            '<div style="display:flex;justify-content:flex-end;margin-bottom:-6px">' + statusPill(d) + '</div>' +
            '<div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start">' +
            left + '<div style="flex:1;min-width:280px">' + right + '</div></div></div>';
    }

    // ── the console ──────────────────────────────────────────────────────────
    //
    // One surface, not six. The old layout put the inbox in a 920px modal with
    // a row of buttons that each opened ANOTHER modal on top of it -- payers,
    // layouts, settings, add-a-payer -- so doing two related things meant
    // closing and reopening your way back. Everything that is a list now lives
    // in a tab here; only genuine forms still open over it.

    function summaryStrip() {
        var pending = state.deposits.filter(D.isPending);
        var amount = D.pendingAmount();
        var unparsed = state.deposits.filter(function (d) { return d.status === 'unparsed'; }).length;
        var dry = state.settings && state.settings.dryRun;

        function stat(value, label, tone) {
            return '<div style="min-width:150px">' +
                '<div style="font-size:1.6rem;font-weight:700;line-height:1.1;color:' + (tone || 'var(--s900,#111)') + '">' +
                value + '</div>' +
                '<div style="font-size:.76rem;color:var(--s500);margin-top:2px">' + label + '</div></div>';
        }

        var h = '<div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start;' +
                'padding:4px 0 18px;border-bottom:1px solid var(--s100);margin-bottom:16px">';
        h += stat(host.fm(amount), 'waiting to be matched', pending.length ? '#92400E' : undefined);
        h += stat(String(pending.length), pending.length === 1 ? 'deposit needs you' : 'deposits need you');
        if (unparsed) h += stat(String(unparsed), unparsed === 1 ? 'email we could not read' : 'emails we could not read', '#5B21B6');
        h += stat(String(state.aliases.length), 'payers learned');

        h += '<div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
             (dry ? '<span style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1E40AF;padding:5px 11px;' +
                    'border-radius:999px;font-size:.76rem;font-weight:600">Dry run — nothing posts by itself</span>' : '') +
             '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryDeposits.openSettings()">Settings</button>' +
             '</div>';
        h += '</div>';
        return h;
    }

    function tabBar() {
        var pending = state.deposits.filter(D.isPending).length;
        var posted = state.deposits.filter(function (d) { return d.status === 'posted'; }).length;
        var mine = state.templates.filter(function (x) { return x.scope === 'camp'; }).length;

        var tabs = [
            ['needs',   'Needs you',    pending],
            ['posted',  'Posted',       posted],
            ['payers',  'Known payers', state.aliases.length],
            ['layouts', 'Bank layouts', mine]
        ];
        return '<div style="display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--s100);margin-bottom:18px">' +
            tabs.map(function (t) {
                var on = tab === t[0];
                return '<button onclick="CampistryDeposits.tab(\'' + t[0] + '\')" ' +
                    'style="background:none;border:none;border-bottom:2px solid ' +
                    (on ? 'var(--acc,#D97706)' : 'transparent') + ';padding:9px 14px;cursor:pointer;' +
                    'font-size:.9rem;font-weight:' + (on ? '700' : '500') + ';color:' +
                    (on ? 'var(--s900,#111)' : 'var(--s500)') + '">' +
                    t[1] + (t[2] ? ' <span style="opacity:.6;font-weight:500">' + t[2] + '</span>' : '') +
                    '</button>';
            }).join('') + '</div>';
    }

    function emptyState(title, body, action) {
        return '<div style="text-align:center;padding:48px 20px;color:var(--s500)">' +
            '<div style="font-size:1.05rem;font-weight:600;color:var(--s600);margin-bottom:6px">' + title + '</div>' +
            '<div style="font-size:.88rem;max-width:520px;margin:0 auto;line-height:1.6">' + body + '</div>' +
            (action ? '<div style="margin-top:18px">' + action + '</div>' : '') +
            '</div>';
    }

    function renderInbox() {
        var el = DOC.getElementById(BODY_ID);
        if (!el) return;

        if (state.error && !state.deposits.length) {
            el.innerHTML = emptyState(
                'Bank deposits aren\'t available yet',
                host.esc(D.explainError(state.error)) +
                '<div style="font-size:.76rem;color:var(--s400);margin-top:12px">Details: <code>' +
                host.esc(state.error) + '</code></div>');
            return;
        }

        var h = summaryStrip() + tabBar();

        if (tab === 'needs') {
            var pending = state.deposits.filter(D.isPending);
            h += pending.length
                ? pending.map(depositRow).join('')
                : emptyState('Nothing waiting',
                    'Every deposit that has arrived is matched to a family. New ones appear here the moment the bank emails about them.');
        } else if (tab === 'posted') {
            var posted = state.deposits.filter(function (d) { return d.status === 'posted'; }).slice(0, 60);
            h += posted.length
                ? posted.map(depositRow).join('')
                : emptyState('Nothing posted yet',
                    'Deposits credited to a family show up here, newest first.');
        } else if (tab === 'payers') {
            h += aliasesHtml();
        } else if (tab === 'layouts') {
            h += templatesHtml();
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
        }, 'Posted to ' + famName(familyKey) + (normalized ? ' — future payments from this payer will match automatically' : ''))
            .then(function (r) { learnFromCorrection(d); return r; });
    };

    /**
     * Learn WHERE the values live from a correction somebody just made.
     *
     * Resolving a deposit already teaches WHO the payer is (an alias). This
     * teaches where that payer's name sits in the message, which is the part
     * that helps the next deposit from a family nobody has seen before.
     *
     * It costs the office nothing: the message is on the row, the confirmed
     * values are on the row, and finding one inside the other gives exactly
     * what a highlight would have. A camp that never opens the teaching screen
     * still ends up with a template, built out of corrections it was making
     * anyway.
     *
     * Silent by design, including its failures. Most corrections teach nothing
     * about location -- the confirmed name often does not appear verbatim in
     * the message -- and that is ordinary, not something to report. The rules
     * are also not used until two independent deposits produce identical ones.
     */
    function learnFromCorrection(d) {
        var T = Tpl();
        if (!T || !d || !d.raw_excerpt || !d.from_address) return;
        var sig = T.signature(d.from_address);
        if (!sig) return;

        var res = T.deriveFromCorrection(d.raw_excerpt, {
            payerName: d.payer_name,
            amount: (d.amount_cents || 0) / 100,
            memo: d.memo
        }, { bank: d.bank || sig, source: 'correction' });
        if (!res.ok) return;

        var client = db(), cid = campId();
        if (!client || !cid) return;
        client.rpc('learn_template_from_correction', {
            p_camp_id: cid,
            p_bank_signature: sig,
            p_template: res.template,
            p_template_hash: T.hash(res.template),
            p_is_shareable: T.isShareable(res.template)
        }).then(function (r) {
            var out = r && r.data;
            // Worth one line only when it actually starts working, since that
            // is the moment the office's own corrections change what the inbox
            // does on its own.
            if (out && out.promoted && host.toast) {
                host.toast('Campistry has learned how ' + sig + ' writes its alerts — future deposits should read cleanly.');
            }
            if (out && out.learned) D.refresh().then(function () { renderInbox(); });
        }, function () { /* migration 148 not applied yet; nothing to do */ });
    }

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
            var fk = (DOC.getElementById('alFam') || {}).value;
            var name = ((DOC.getElementById('alName') || {}).value || '').trim();
            var handle = ((DOC.getElementById('alHandle') || {}).value || '').trim();
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
                p_note: ((DOC.getElementById('alNote') || {}).value || '').trim()
            }).then(function (r) {
                if (r.error) { if (host.toast) host.toast('Failed: ' + r.error.message, 'error'); return; }
                if (r.data && r.data.duplicate) { if (host.toast) host.toast('Already known — nothing to add'); }
                else if (host.toast) host.toast('Payer added');
                if (host.closeModal) host.closeModal('dynModal');
                D.refresh().then(function () { host.onChange(); });
            });
        });
    };

    function aliasesHtml() {
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
        return body;
    }

    // Still reachable on its own (Billing links straight to it), but inside the
    // console it is a tab -- six buttons each opening a modal over a modal was
    // the worst thing about the old layout.
    D.openAliases = function () {
        host.showModal('Known Payers', aliasesHtml(), null, { maxWidth: 860 });
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
            var allow = (DOC.getElementById('depAllow').value || '')
                .split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
            client.rpc('set_camp_deposit_settings', {
                p_camp_id: cid,
                p_dry_run: DOC.getElementById('depDryRun').checked,
                p_sender_allowlist: allow,
                p_auto_post_at: parseInt(DOC.getElementById('depAuto').value, 10) || 90,
                p_suggest_at: parseInt(DOC.getElementById('depSuggest').value, 10) || 40
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
            var ta = DOC.getElementById('tchText');
            if (ta && ta.value !== t.text) ta.value = t.text;
        }, 0);
    }

    /** Re-render only the preview, so typing in the textarea is never interrupted. */
    function refreshPreview() {
        var el = DOC.getElementById('tchPreview');
        if (el) el.innerHTML = teachPreview();
        // Keep the mark buttons' ticks honest without rebuilding the textarea.
        var t = state.teach;
        Object.keys(TEACH_LABELS).forEach(function (f) {
            var btn = DOC.querySelector('[onclick*="teachMark(\'' + f + '\')"]');
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
        var ta = DOC.getElementById('tchText');
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

    // Step numbers are explicit and the panel is always on screen, because the
    // camp doing this has never seen it before and will do it exactly once. At
    // every moment it should be obvious which question is being asked, what has
    // already been captured, and that the answers are being kept.
    var MARK_COLORS = {
        payerName: 'rgba(37,99,235,.28)',
        amount:    'rgba(16,185,129,.30)',
        memo:      'rgba(217,119,6,.28)'
    };

    var TEACH_STEP_NAMES = { payerName: 'Who sent it', amount: 'How much', memo: 'The memo' };

    function renderTeachPdf() {
        var t = state.teachPdf;
        var h = '<div class="me-modal-form">';

        if (!t.doc) {
            h += '<div style="max-width:560px">';
            h += '<p style="font-size:.92rem;color:var(--s600);margin:0 0 16px;line-height:1.55">' +
                 'Open one of your bank\'s deposit alert emails, print it, and choose ' +
                 '<strong>Save as PDF</strong>. Upload that file here and Campistry will ask you to point at ' +
                 'three things on it.</p>';
            h += '<div class="me-field"><label>The bank\'s email address</label>' +
                 '<input type="text" id="tpFrom" class="me-input" placeholder="alerts@capitalone.com" value="' +
                 host.esc(t.from) + '" oninput="CampistryDeposits.teachPdfSet(\'from\', this.value)">' +
                 '<div style="font-size:.76rem;color:var(--s500);margin-top:4px">Who the alert comes FROM. This is how the layout is recognised later.</div></div>';
            h += '<div class="me-field"><label>Bank name <span style="color:var(--s400);font-weight:400">(optional)</span></label>' +
                 '<input type="text" id="tpLabel" class="me-input" placeholder="Capital One" value="' +
                 host.esc(t.label) + '" oninput="CampistryDeposits.teachPdfSet(\'label\', this.value)"></div>';
            h += '<div class="me-field"><label>The printed email</label>' +
                 '<input type="file" id="tpFile" accept="application/pdf" class="me-input" ' +
                 'onchange="CampistryDeposits.teachPdfLoad(this.files && this.files[0])"></div>';
            h += '<div id="tpStatus" style="font-size:.85rem;color:var(--s500)"></div>';
            h += '</div></div>';
            host.showModal('Teach Campistry your bank\'s emails', h, null, { maxWidth: 700 });
            return;
        }

        h += '<div id="tpPrompt">' + teachPdfPrompt() + '</div>';
        // The page gets the room; the panel rides alongside it and collapses
        // underneath on a narrow screen.
        h += '<div style="display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start" id="tpGrid">' +
             '<div id="tpPage" style="border:1px solid var(--s100);border-radius:var(--r);overflow:auto;' +
             'height:62vh;background:#fff;position:relative"></div>' +
             '<div id="tpPanel">' + teachPdfPanel() + '</div>' +
             '</div>';
        h += '</div>';

        host.showModal('Teach Campistry your bank\'s emails', h, null,
                       { maxWidth: 1240, maxHeight: '94vh', minHeight: '90vh' });
        setTimeout(function () {
            var g = DOC.getElementById('tpGrid');
            if (g && g.clientWidth < 820) g.style.gridTemplateColumns = 'minmax(0,1fr)';
            paintPdfPage();
        }, 0);
    }

    function P_FIELD(step) {
        var P = Pdf();
        return (P && step >= 0 && step < P.FIELD_ORDER.length) ? P.FIELD_ORDER[step] : null;
    }

    /** The question being asked right now, across the top. */
    function teachPdfPrompt() {
        var t = state.teachPdf, P = Pdf();
        var field = P_FIELD(t.step);
        var total = P.FIELD_ORDER.length;

        if (!field) {
            return '<div style="background:#ECFDF5;border:1px solid #A7F3D0;color:#065F46;' +
                   'padding:14px 18px;border-radius:var(--r);margin-bottom:14px">' +
                   '<div style="font-size:1.05rem;font-weight:700">All three captured</div>' +
                   '<div style="font-size:.88rem;margin-top:4px">Check the panel on the right, then save.</div>' +
                   '</div>';
        }

        var got = t.marks[field];
        var prompt = P.PROMPTS[field];

        // A dot per step, so "how far through am I" needs no reading.
        var dots = '';
        for (var i = 0; i < total; i++) {
            var done = !!t.marks[P.FIELD_ORDER[i]];
            var here = i === t.step;
            dots += '<span style="display:inline-block;width:' + (here ? '26px' : '10px') + ';height:10px;' +
                    'border-radius:999px;margin-right:5px;background:' +
                    (here ? '#2563EB' : done ? '#10B981' : '#CBD5E1') + '"></span>';
        }

        return '<div style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1E3A8A;' +
            'padding:14px 18px;border-radius:var(--r);margin-bottom:14px">' +
            '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
            '<div>' + dots + '</div>' +
            '<div style="font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.75">' +
            'Step ' + (t.step + 1) + ' of ' + total + '</div></div>' +
            '<div style="font-size:1.15rem;font-weight:700;margin-top:8px">' + host.esc(prompt.title) + '</div>' +
            '<div style="font-size:.9rem;margin-top:4px;line-height:1.5">' + host.esc(prompt.help) + '</div>' +
            (got
                ? '<div style="background:#fff;border:1px solid #BFDBFE;border-radius:var(--r);padding:8px 12px;margin-top:10px">' +
                  '<span style="font-size:.76rem;color:var(--s500)">You highlighted</span><br>' +
                  '<strong style="font-size:1rem">' + host.esc(t.text.slice(got.start, got.end).trim()) + '</strong></div>'
                : '') +
            '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="me-btn ' + (got ? 'me-btn--sec' : 'me-btn--pri') + ' me-btn--sm" ' +
            'onclick="CampistryDeposits.teachPdfTake()">' +
            (got ? 'Highlight it again' : 'Use what I highlighted') + '</button>' +
            (got ? '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryDeposits.teachPdfStep(' +
                   (t.step + 1) + ')">' + (t.step + 1 < total ? 'Next step →' : 'Finish →') + '</button>' : '') +
            (field === 'memo' && !got ? '<button class="me-btn me-btn--ghost me-btn--sm" ' +
                   'onclick="CampistryDeposits.teachPdfStep(' + (t.step + 1) + ')">This bank has no memo</button>' : '') +
            (t.step > 0 ? '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryDeposits.teachPdfStep(' +
                   (t.step - 1) + ')">← Back</button>' : '') +
            '</div></div>';
    }

    /**
     * The panel: what has been captured, and what the rules read back.
     *
     * The read-back is the point. A camp has no reason to believe a highlight
     * was kept, still less that anything was learned from it -- so the rules
     * are built and re-run on the spot, and the panel shows the value they
     * return rather than the value that was highlighted. When those match, the
     * learning is visibly real.
     */
    function teachPdfPanel() {
        var t = state.teachPdf, P = Pdf(), T = Tpl();
        var marked = Object.keys(t.marks);

        var h = '<div style="border:1px solid var(--s100);border-radius:var(--r);padding:14px 16px;background:var(--s50)">';
        h += '<div style="font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;' +
             'color:var(--s500);margin-bottom:10px">What Campistry has learned</div>';

        var read = null, res = null;
        if (marked.length) {
            res = T.learn(t.text, t.marks, { bank: t.label, source: 'pdf' });
            if (res.template && Object.keys(res.template.fields).length) {
                read = T.read(res.template, t.text);
            }
        }

        P.FIELD_ORDER.forEach(function (f, i) {
            var got = t.marks[f];
            var here = P_FIELD(t.step) === f;
            var r = read && read[f];
            var highlighted = got ? t.text.slice(got.start, got.end).trim() : '';
            var matches = r && r.value === highlighted;

            h += '<div style="padding:9px 0;border-top:' + (i ? '1px solid var(--s100)' : 'none') + '">' +
                 '<div style="display:flex;align-items:center;gap:8px">' +
                 '<span style="width:20px;height:20px;border-radius:999px;flex-shrink:0;display:inline-flex;' +
                 'align-items:center;justify-content:center;font-size:.7rem;font-weight:700;color:#fff;background:' +
                 (got ? '#10B981' : here ? '#2563EB' : '#CBD5E1') + '">' + (got ? '✓' : (i + 1)) + '</span>' +
                 // The same colour this field is highlighted in on the page, so
                 // the panel and the document read as one thing.
                 '<span style="width:10px;height:10px;border-radius:2px;flex-shrink:0;background:' +
                 (MARK_COLORS[f] || '#CBD5E1').replace(/[\d.]+\)$/, '1)') + '"></span>' +
                 '<strong style="font-size:.86rem">' + host.esc(TEACH_STEP_NAMES[f]) + '</strong>' +
                 (here && !got ? '<span style="font-size:.72rem;color:#2563EB;font-weight:600">← now</span>' : '') +
                 '</div>';

            if (got) {
                h += '<div style="font-size:.9rem;margin:5px 0 0 28px;word-break:break-word">' +
                     host.esc(highlighted) + '</div>';
                h += '<div style="font-size:.74rem;margin:3px 0 0 28px;color:' +
                     (matches ? 'var(--s500)' : '#92400E') + '">' +
                     (matches
                        ? 'Rule reads this back correctly' + (r && r.agree ? ' · both rules agree' : '')
                        : 'Rule reads back: ' + host.esc((r && r.value) || 'nothing') + ' — try highlighting a bit differently') +
                     '</div>';
            } else {
                h += '<div style="font-size:.8rem;margin:5px 0 0 28px;color:var(--s400)">Not captured yet</div>';
            }
            h += '</div>';
        });

        h += '</div>';

        if (!P_FIELD(t.step)) {
            var ok = res && res.ok;
            h += '<div style="margin-top:14px">';
            if (ok) {
                h += '<button class="me-btn me-btn--pri" style="width:100%" ' +
                     'onclick="CampistryDeposits.teachPdfSave()">Save this layout</button>' +
                     '<div style="font-size:.74rem;color:var(--s500);margin-top:8px;line-height:1.5">' +
                     'Every future alert from this bank will be read this way. You can re-teach it any time.</div>';
            } else {
                h += '<div style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;padding:9px 12px;' +
                     'border-radius:var(--r);font-size:.8rem">' +
                     host.esc((res && res.errors && res.errors[0]) || 'Nothing has been highlighted yet.') + '</div>' +
                     '<button class="me-btn me-btn--sec me-btn--sm" style="width:100%;margin-top:8px" ' +
                     'onclick="CampistryDeposits.teachPdfStep(0)">Start over</button>';
            }
            h += '</div>';
        }
        return h;
    }

    /** Redraw the saved highlights over the rendered page. */
    function paintMarks() {
        var t = state.teachPdf;
        var layer = DOC.getElementById('tpMarks');
        if (!t || !layer || !t.viewport) return;
        layer.innerHTML = '';
        var pageNo = t.pageNo || 1;
        var vp = t.viewport;

        Object.keys(t.marks).forEach(function (f) {
            var m = t.marks[f];
            t.items.forEach(function (it) {
                if (it.page !== pageNo) return;
                if (it.end <= m.start || it.start >= m.end) return;
                var box = DOC.createElement('div');
                box.style.cssText = 'position:absolute;border-radius:3px;background:' +
                    (MARK_COLORS[f] || 'rgba(0,0,0,.2)') + ';' +
                    'left:' + (it.x * vp.scale) + 'px;' +
                    'top:' + (vp.height - (it.y * vp.scale) - (it.h * vp.scale * 1.05)) + 'px;' +
                    'width:' + (it.w * vp.scale) + 'px;' +
                    'height:' + (it.h * vp.scale * 1.25) + 'px;';
                layer.appendChild(box);
            });
        });
    }

    /** Repaint the question and the panel without touching the rendered page. */
    function refreshTeachPdf() {
        var a = DOC.getElementById('tpPrompt');
        var b = DOC.getElementById('tpPanel');
        if (a) a.innerHTML = teachPdfPrompt();
        if (b) b.innerHTML = teachPdfPanel();
        paintMarks();
    }


    async function paintPdfPage() {
        var t = state.teachPdf;
        var host_el = DOC.getElementById('tpPage');
        if (!host_el || !t.doc) return;

        var pageNo = t.pageNo || 1;
        var page = await t.doc.getPage(pageNo);
        var wrapW = Math.max(320, host_el.clientWidth - 4);
        var base = page.getViewport({ scale: 1 });
        var viewport = page.getViewport({ scale: wrapW / base.width });

        var canvas = DOC.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.style.display = 'block';
        var layer = DOC.createElement('div');
        layer.id = 'tpLayer';
        layer.style.cssText = 'position:absolute;inset:0;color:transparent;' +
            'line-height:1;transform-origin:0 0;user-select:text;-webkit-user-select:text';

        host_el.innerHTML = '';
        var frame = DOC.createElement('div');
        frame.style.cssText = 'position:relative;width:' + viewport.width + 'px';
        frame.appendChild(canvas);
        frame.appendChild(layer);
        host_el.appendChild(frame);

        await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        t.frame = frame;

        // Persisted highlights, drawn back onto the page. A camp has no reason
        // to trust that a selection was kept unless it can still see it -- and
        // seeing all three at once is what makes the last step obviously right.
        var marksLayer = DOC.createElement('div');
        marksLayer.id = 'tpMarks';
        marksLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
        frame.insertBefore(marksLayer, layer);
        t.viewport = viewport;
        paintMarks();

        t.items.filter(function (it) { return it.page === pageNo; }).forEach(function (it) {
            var sp = DOC.createElement('span');
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
            var nav = DOC.createElement('div');
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
        var el = DOC.getElementById('tpStatus');
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
        var layer = DOC.getElementById('tpLayer');
        var off = layer && P.offsetsFromSelection(layer);
        if (!off) {
            if (host.toast) host.toast('Drag across the words on the page first.', 'error');
            return;
        }
        t.marks[field] = { start: off.start, end: off.end };
        refreshTeachPdf();
    };

    D.teachPdfStep = function (n) {
        var t = state.teachPdf;
        if (!t) return;
        if (n === 0) t.marks = {};
        t.step = n;
        refreshTeachPdf();
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

    function templatesHtml() {
        var mine = state.templates.filter(function (x) { return x.scope === 'camp'; });
        var shared = state.templates.filter(function (x) { return x.scope === 'shared'; });

        var h = '<div>';
        h += '<p style="font-size:.88rem;color:var(--s600);margin:0 0 14px;max-width:720px;line-height:1.6">' +
             'Campistry reads every bank\'s alerts on its own. Teaching it yours makes that exact, ' +
             'and is worth doing if anything is coming through wrong. It also learns quietly from ' +
             'corrections you make in <strong>Needs you</strong>, so this is optional.</p>';
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
        return h;
    }

    D.openTemplates = function () {
        host.showModal('Bank layouts', templatesHtml(), null, { maxWidth: 900 });
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
