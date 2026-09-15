// =============================================================================
// campistry_setup_checklist.js — "what still has to be set up", in order
//
// A camp arriving at Campistry for the first time is looking at Me, Flow, Go,
// Lite, Link, a Dashboard with six setup tabs, and no idea which of them has to
// happen before which. The knowledge existed only in whichever order support
// happened to explain it in, so camps set up billing before they had a roster,
// turned on automatic deposits before the bank was sending alerts anywhere, and
// built a schedule before there were bunks to schedule.
//
// This is that order, written down once. Five phases, each item naming exactly
// where it is done and why it comes where it does. Checking a box is a note to
// the camp's own team -- several people share one camp, and "did anyone do the
// forwarding rule?" is a real question -- so the state is camp-wide and carries
// who ticked it.
//
// DELIBERATELY MANUAL
//
// Nothing here auto-ticks. The app can see that a roster exists; it cannot see
// that the roster is RIGHT, that the bank was actually told to send alerts, or
// that a forwarding rule survived the office's IT. A checklist that ticks
// itself on a half-done step is worse than one that waits to be told, because
// the camp stops reading it. Items that Campistry genuinely can verify already
// show their own live state where they live (Bank Deposits' Setup tab knows
// whether mail is arriving); this says what to do and in what order.
// =============================================================================
(function () {
    'use strict';

    var C = {};

    // ── the list ─────────────────────────────────────────────────────────────
    //
    // Order is the whole point, so it is expressed as order: phases run first
    // to last, items within a phase likewise. Each item says WHY it sits here
    // when that is not obvious -- a step whose reason is invisible is the one
    // people skip and then have to redo.
    C.PHASES = [
        {
            id: 'camp',
            title: 'Your camp',
            blurb: 'Everything else refers back to these. Do them first or you will be re-entering them later.',
            items: [
                {
                    id: 'profile',
                    title: 'Camp profile',
                    detail: 'Name, logo and contact details. These appear on every invoice, parent message and printed sheet, so a placeholder here shows up in a dozen places.',
                    where: 'Dashboard → Camp Setup → Profile & Account',
                    href: 'dashboard.html#setup-profile'
                },
                {
                    id: 'dates',
                    title: 'Camp dates',
                    detail: 'Start and end, plus halves and any transition weeks. Rotation fairness, period counting and the calendar all read these; setting them later reshuffles schedules you have already built.',
                    where: 'Dashboard → Camp Setup → Dates & Pricing',
                    href: 'dashboard.html#setup-dates'
                },
                {
                    id: 'sessions',
                    title: 'Sessions and pricing',
                    detail: 'What a family can enrol in and what it costs. Registration cannot quote a price without this, and every balance in Billing is derived from it.',
                    where: 'Dashboard → Camp Setup → Dates & Pricing',
                    href: 'dashboard.html#setup-dates'
                },
                {
                    id: 'team',
                    title: 'Invite your team and set access',
                    detail: 'Owners, admins, schedulers. Do this early: a scheduler only sees their own divisions, so inviting them after the structure exists saves explaining why half the camp is missing.',
                    where: 'Dashboard → Camp Setup → Team & Access',
                    href: 'team_access_setup.html'
                }
            ]
        },
        {
            id: 'people',
            title: 'Your people',
            blurb: 'Structure before campers, campers before households. Each one is what the next hangs off.',
            items: [
                {
                    id: 'structure',
                    title: 'Divisions, grades and bunks',
                    detail: 'The shape of the camp. A camper cannot be placed and a schedule cannot be built until this exists — a CSV import will create it for you if you would rather start from the roster.',
                    where: 'Me → Camp Structure',
                    href: 'campistry_me.html#structure'
                },
                {
                    id: 'roster',
                    title: 'Add your campers',
                    detail: 'Import a CSV or open registration and let families enrol. If you already give out camper ID numbers, put them in the Camper ID column — parents write those in bank memos, and Campistry will use yours rather than assigning its own.',
                    where: 'Me → Roster → Import, or Me → Registration',
                    href: 'campistry_me.html#campers'
                },
                {
                    id: 'families',
                    title: 'Check households',
                    detail: 'Siblings under one household, one billing contact each. Money is credited to a HOUSEHOLD, not a camper, so a camper sitting outside one has nowhere for a payment to land.',
                    where: 'Me → Billing',
                    href: 'campistry_me.html#billing'
                },
                {
                    id: 'staff',
                    title: 'Staff and hiring',
                    detail: 'Applications, hires and staff IDs. Staff draw from the same ID sequence as campers, so hiring before you hand out camper numbers keeps both tidy.',
                    where: 'Me → Hiring',
                    href: 'campistry_me.html#hiring'
                }
            ]
        },
        {
            id: 'money',
            title: 'Money in',
            blurb: 'In this order. Every step here depends on the one above actually working first.',
            items: [
                {
                    id: 'processor',
                    title: 'Card payments',
                    detail: 'Connect Stripe, or your own processor, and choose where tuition lands.',
                    where: 'Dashboard → Camp Setup → Payment',
                    href: 'dashboard.html#setup-payment'
                },
                {
                    id: 'plans',
                    title: 'Payment policy and plans',
                    detail: 'Deposits, instalments, late fees, sibling discounts. One camp-wide catalogue, used by registration, Billing, Snacks and Shop alike.',
                    where: 'Me → Billing → Payment policy',
                    href: 'campistry_me.html#billing'
                },
                {
                    id: 'dep_address',
                    title: 'Bank deposits: your camp’s address and number',
                    detail: 'A deposit address unique to your camp, and a camp number parents put in the memo as <camp>-<camper>. Tell parents the format now — it is the only thing that identifies a payer nobody has seen before.',
                    where: 'Me → Billing → Bank Deposits → Setup',
                    href: 'campistry_me.html#billing'
                },
                {
                    id: 'dep_alerts',
                    title: 'Point your bank’s alerts at it',
                    detail: 'In online banking, add that address as a recipient for incoming deposits and Zelle payments received. Nothing arrives until something is sending.',
                    where: 'Your bank’s alert settings',
                    href: 'campistry_me.html#billing'
                },
                {
                    id: 'dep_forward',
                    title: 'Or forward automatically from the mailbox you already use',
                    detail: 'If the bank already emails an existing mailbox, set a FILTER on the bank’s address that forwards to your deposit address — not "forward a copy of incoming mail", which sends your whole inbox. Your provider will email a confirmation code to the deposit address; it appears at the top of Needs you.',
                    where: 'Gmail → Filters, or Outlook → Rules',
                    href: 'campistry_me.html#billing'
                },
                {
                    id: 'dep_test',
                    title: 'Send yourself a test payment',
                    detail: 'A dollar, with a real memo reference, from a real account. It should appear matched within a minute. This is the step that proves the four above actually work.',
                    where: 'Me → Billing → Bank Deposits → Needs you',
                    href: 'campistry_me.html#billing'
                },
                {
                    id: 'dep_lock',
                    title: 'Lock the address to your bank',
                    detail: 'Once a real alert has arrived, restrict the address to that bank’s sending domain. Until you do, anything reaching it is trusted — fine while testing, not once the summer starts.',
                    where: 'Me → Billing → Bank Deposits → Settings',
                    href: 'campistry_me.html#billing'
                },
                {
                    id: 'dep_auto',
                    title: 'Switch deposits to Automatic',
                    detail: 'Last, not first. Run Manual for the first week of real payments so you can see what it would have done; switch once the matches look right. Automatic applies on arrival — turning it on does not reach back over deposits already waiting.',
                    where: 'Me → Billing → Bank Deposits → Settings',
                    href: 'campistry_me.html#billing'
                }
            ]
        },
        {
            id: 'schedule',
            title: 'The schedule',
            blurb: 'Needs divisions, bunks and activities to already exist. Coming here first is the most common way to waste an afternoon.',
            items: [
                {
                    id: 'facilities',
                    title: 'Activities, fields and specials',
                    detail: 'What happens at camp and where. Set access restrictions and field sharing here — the solver enforces them, it cannot guess them.',
                    where: 'Flow → Facilities & Activities',
                    href: 'flow.html'
                },
                {
                    id: 'leagues',
                    title: 'Leagues and teams',
                    detail: 'Only if you run them. League fixtures occupy slots the solver has to plan around, so define them before generating rather than after.',
                    where: 'Flow → Leagues',
                    href: 'flow.html'
                },
                {
                    id: 'builder',
                    title: 'Choose Auto or Manual builder',
                    detail: 'Auto solves the day from layers you define; Manual fills a skeleton you drag out yourself. Pick one before building — they keep separate work.',
                    where: 'Flow → Builder mode',
                    href: 'flow.html'
                },
                {
                    id: 'generate',
                    title: 'Generate a day and read it properly',
                    detail: 'Not "did it run" — check a bunk you know: right fields, nothing they cannot access, no double bookings. Fix the rules, not the output.',
                    where: 'Flow → Generate',
                    href: 'flow.html'
                },
                {
                    id: 'print',
                    title: 'Print one day',
                    detail: 'The printed sheet is what the camp actually runs on. Print it once now, while there is time to fix a layout, rather than at 7am on day one.',
                    where: 'Flow → Print Center',
                    href: 'flow.html'
                }
            ]
        },
        {
            id: 'daily',
            title: 'Day to day',
            blurb: 'None of this blocks opening day. Do it once the above is solid.',
            items: [
                {
                    id: 'lite',
                    title: 'Campistry Lite for staff phones',
                    detail: 'Head counsellors see the day and mark attendance from a phone. Add a texting number if you want to reach staff by SMS.',
                    where: 'Dashboard → Texting Number, and Lite',
                    href: 'campistry_lite.html'
                },
                {
                    id: 'link',
                    title: 'Campistry Link for parents',
                    detail: 'Balances, photos, messages and forms. Turn on only the programs you actually want parents to see.',
                    where: 'Dashboard → Camp Setup → Link Programs',
                    href: 'dashboard.html#setup-settings'
                },
                {
                    id: 'go',
                    title: 'Buses and luggage',
                    detail: 'Routes, stops and luggage tracking, if you run either.',
                    where: 'Go \u2192 Bus Routes and Luggage',
                    href: 'campistry_go.html'
                },
                {
                    id: 'reports',
                    title: 'Build the sheets you will need',
                    detail: 'Rosters, allergy lists, bus manifests. Build them before you need them at short notice.',
                    where: 'Me → Reports and Print Sheets',
                    href: 'campistry_me.html#reports'
                }
            ]
        }
    ];

    /** Every item, flattened, in the order they are meant to happen. */
    C.items = function () {
        var out = [];
        C.PHASES.forEach(function (p) {
            p.items.forEach(function (it) {
                out.push({ key: p.id + '.' + it.id, phase: p.id, item: it });
            });
        });
        return out;
    };

    C.count = function () { return C.items().length; };

    /** How far along, given the saved state. */
    C.progress = function (state) {
        var done = 0, all = C.items();
        all.forEach(function (r) { if (state && state[r.key] && state[r.key].done) done++; });
        return { done: done, total: all.length, pct: all.length ? Math.round(done * 100 / all.length) : 0 };
    };

    /**
     * The first thing still outstanding, which is what a camp opening this
     * actually wants to know. Returns null once everything is ticked.
     */
    C.nextUp = function (state) {
        var all = C.items();
        for (var i = 0; i < all.length; i++) {
            if (!(state && state[all[i].key] && state[all[i].key].done)) return all[i];
        }
        return null;
    };


    // ── rendering and storage (browser only) ─────────────────────────────────
    //
    // State is camp-wide, not per-user: several people share one camp and
    // "has anyone done the forwarding rule yet?" is exactly the question this
    // is here to answer. Each tick carries who and when for the same reason.

    var W = typeof window !== 'undefined' ? window : null;
    var KV_KEY = 'setupChecklist';
    var state = {};
    var loaded = false;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function campId() {
        try {
            return W.localStorage.getItem('campistry_camp_id') ||
                   W.localStorage.getItem('campistry_user_id') || '';
        } catch (e) { return ''; }
    }

    function whoami() {
        try { return W.localStorage.getItem('campistry_user_email') || ''; } catch (e) { return ''; }
    }

    C.load = async function () {
        if (loaded) return state;
        var cid = campId();
        if (!W || !W.supabase || !cid) { loaded = true; return state; }
        try {
            var r = await W.supabase.from('camp_state_kv')
                .select('value').eq('camp_id', cid).eq('key', KV_KEY).maybeSingle();
            if (r && r.data && r.data.value && typeof r.data.value === 'object') state = r.data.value;
        } catch (e) {
            // A checklist that cannot reach the cloud still renders; it just
            // will not remember. Better than an empty tab.
            console.warn('[SetupChecklist] load failed:', e && e.message);
        }
        loaded = true;
        return state;
    };

    C.save = async function () {
        var cid = campId();
        if (!W || !W.supabase || !cid) return false;
        try {
            var r = await W.supabase.from('camp_state_kv').upsert({
                camp_id: cid, key: KV_KEY, value: state, updated_at: new Date().toISOString()
            }, { onConflict: 'camp_id,key' });
            return !(r && r.error);
        } catch (e) {
            console.warn('[SetupChecklist] save failed:', e && e.message);
            return false;
        }
    };

    C.toggle = async function (key) {
        var was = !!(state[key] && state[key].done);
        state[key] = was ? { done: false } : { done: true, at: new Date().toISOString(), by: whoami() };
        C.render();
        var ok = await C.save();
        if (!ok) {
            var note = document.getElementById('setupChecklistSaveNote');
            if (note) {
                note.textContent = 'Could not save that tick — check your connection.';
                note.style.display = '';
            }
        }
        return ok;
    };

    function itemHtml(phaseId, it) {
        var key = phaseId + '.' + it.id;
        var on = !!(state[key] && state[key].done);
        var by = on && state[key].by ? state[key].by : '';
        var at = on && state[key].at ? String(state[key].at).slice(0, 10) : '';
        return '<li style="display:flex;gap:13px;padding:14px 0;border-top:1px solid var(--slate-100,#f1f5f9);' +
            'align-items:flex-start">' +
            '<button type="button" role="checkbox" aria-checked="' + (on ? 'true' : 'false') + '" ' +
            'onclick="CampistrySetupChecklist.toggle(\'' + esc(key) + '\')" ' +
            'style="flex-shrink:0;margin-top:1px;width:22px;height:22px;border-radius:6px;cursor:pointer;' +
            'display:inline-flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;' +
            (on ? 'background:#10B981;border:1px solid #10B981;color:#fff' :
                  'background:#fff;border:1.5px solid var(--slate-300,#cbd5e1);color:transparent') + '">' +
            (on ? '✓' : '') + '</button>' +
            '<div style="flex:1;min-width:0">' +
            '<div style="font-size:.95rem;font-weight:600;line-height:1.4;' +
            (on ? 'color:var(--slate-400,#94a3b8);text-decoration:line-through' : 'color:var(--slate-800,#1e293b)') +
            '">' + esc(it.title) + '</div>' +
            '<div style="font-size:.84rem;color:var(--slate-500,#64748b);line-height:1.6;margin-top:3px;max-width:680px">' +
            esc(it.detail) + '</div>' +
            '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:6px">' +
            '<a href="' + esc(it.href) + '" style="font-size:.79rem;font-weight:600;color:var(--purple-600,#7c3aed);' +
            'text-decoration:none">' + esc(it.where) + ' →</a>' +
            (by || at
                ? '<span style="font-size:.73rem;color:var(--slate-400,#94a3b8)">ticked' +
                  (by ? ' by ' + esc(by) : '') + (at ? ' on ' + esc(at) : '') + '</span>'
                : '') +
            '</div></div></li>';
    }

    C.html = function () {
        var p = C.progress(state);
        var next = C.nextUp(state);
        var h = '';

        h += '<div class="dashboard-card" style="margin-bottom:16px">' +
             '<div style="padding:20px 22px">' +
             '<div style="display:flex;justify-content:space-between;gap:14px;align-items:baseline;flex-wrap:wrap">' +
             '<h2 style="margin:0;font-size:1.12rem;font-weight:700">Setting up your camp</h2>' +
             '<span style="font-size:.85rem;font-weight:600;color:var(--slate-500,#64748b)">' +
             p.done + ' of ' + p.total + ' done</span></div>' +
             '<div style="height:8px;border-radius:999px;background:var(--slate-100,#f1f5f9);margin:12px 0 0;overflow:hidden">' +
             '<div style="height:100%;width:' + p.pct + '%;background:#10B981;border-radius:999px;transition:width .25s"></div>' +
             '</div>' +
             (next
                 ? '<div style="font-size:.88rem;color:var(--slate-600,#475569);margin-top:13px;line-height:1.6">' +
                   '<strong>Next:</strong> ' + esc(next.item.title) +
                   ' <span style="color:var(--slate-400,#94a3b8)">· ' + esc(next.item.where) + '</span></div>'
                 : '<div style="font-size:.88rem;color:#065F46;margin-top:13px;font-weight:600">' +
                   'Everything on the list is done. Have a good summer.</div>') +
             '<div style="font-size:.78rem;color:var(--slate-400,#94a3b8);margin-top:10px;line-height:1.6">' +
             'The order matters — each phase needs the one above it to exist first. Ticks are shared with ' +
             'everyone on your camp, so nobody redoes a step someone else finished.</div>' +
             '<div id="setupChecklistSaveNote" style="display:none;font-size:.79rem;color:#B91C1C;margin-top:8px"></div>' +
             '</div></div>';

        C.PHASES.forEach(function (ph, i) {
            var items = ph.items.map(function (it) { return ph.id + '.' + it.id; });
            var doneHere = items.filter(function (k) { return state[k] && state[k].done; }).length;
            var allDone = doneHere === items.length;
            h += '<div class="dashboard-card" style="margin-bottom:14px">' +
                 '<div style="padding:18px 22px 6px">' +
                 '<div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap">' +
                 '<span style="width:24px;height:24px;border-radius:999px;flex-shrink:0;display:inline-flex;' +
                 'align-items:center;justify-content:center;font-size:.76rem;font-weight:700;' +
                 (allDone ? 'background:#10B981;color:#fff' : 'background:var(--slate-100,#f1f5f9);color:var(--slate-500,#64748b)') +
                 '">' + (allDone ? '✓' : (i + 1)) + '</span>' +
                 '<h3 style="margin:0;font-size:1rem;font-weight:700">' + esc(ph.title) + '</h3>' +
                 '<span style="margin-left:auto;font-size:.78rem;color:var(--slate-400,#94a3b8)">' +
                 doneHere + '/' + items.length + '</span></div>' +
                 '<p style="font-size:.84rem;color:var(--slate-500,#64748b);line-height:1.6;margin:8px 0 0;max-width:700px">' +
                 esc(ph.blurb) + '</p>' +
                 '<ul style="list-style:none;padding:0;margin:10px 0 0">' +
                 ph.items.map(function (it) { return itemHtml(ph.id, it); }).join('') +
                 '</ul></div></div>';
        });
        return h;
    };

    C.render = function () {
        if (!W) return;
        var el = document.getElementById('dash-setup-checklist');
        if (el) el.innerHTML = C.html();
    };

    /** Called by the Dashboard when the tab is first shown. */
    C.mount = async function () {
        var el = W && document.getElementById('dash-setup-checklist');
        if (el && !loaded) el.innerHTML = '<div style="padding:24px;color:var(--slate-400,#94a3b8)">Loading…</div>';
        await C.load();
        C.render();
    };

    if (typeof globalThis !== 'undefined') globalThis.CampistrySetupChecklist = C;
    if (typeof window !== 'undefined') window.CampistrySetupChecklist = C;
    if (typeof module !== 'undefined' && module.exports) module.exports = C;
})();
