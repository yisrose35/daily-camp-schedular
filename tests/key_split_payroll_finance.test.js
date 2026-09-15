// node --test tests/key_split_payroll_finance.test.js
//
// Phase 2B: Payroll and Finance moved out of the campistryMe blob into their
// own camp_state_kv keys (migration 158), so an entitlement can be enforced on
// them by RLS instead of only by the browser.
//
// Three things can go wrong in a move like this, and all three lose data
// silently rather than throwing:
//
//   1. The migration bridge picks the wrong source. This code ships BEFORE the
//      SQL runs, so for a while the new key does not exist and the legacy
//      branch is the only copy. Prefer an empty new key over a populated legacy
//      branch and the first load shows an empty Payroll page — and the first
//      save writes that emptiness back over the real thing.
//
//   2. The scrub stops working. Restricted branches are deleted from the cached
//      blob at load and put back at save. The map now has to handle a WHOLE KEY
//      as well as a branch inside a blob; if the new one-segment shape is
//      silently ignored, a restricted user caches the payroll file on their
//      laptop and can overwrite it.
//
//   3. The ledger moves by accident. campistryMe.finance.payments must stay
//      where it is — seven payment edge functions and get_my_balance read it
//      there — while the rest of finance moves.
//
// See ENTITLEMENTS_DESIGN.md §6 and migrations/158_split_payroll_finance_keys.sql.

const test = require('node:test');
const assert = require('node:assert');

// ── minimal DOM shim, installed before the module is required ───────────────
// campistry_access_sections.js is browser code that boots on load. With no
// __CAMPISTRY_PRODUCT__ set it short-circuits through finish(), which touches
// documentElement and dispatches an event — that is all this needs to cover.
const noop = () => {};
const emptyList = [];
global.window = {
    addEventListener: noop,
    dispatchEvent: noop,
    CustomEvent: function CustomEvent() {},
};
global.document = {
    readyState: 'complete',
    addEventListener: noop,
    currentScript: null,
    documentElement: { setAttribute: noop },
    body: null,
    querySelectorAll: () => emptyList,
    querySelector: () => null,
};
global.CustomEvent = global.window.CustomEvent;

const S = require('../campistry_access_sections.js');
const B = require('../campistry_birthdays.js');

// ── 1. the migration bridge ────────────────────────────────────────────────
//
// This mirrors _preferKey in campistry_me.js. It is duplicated rather than
// imported because campistry_me.js is a 16k-line browser file that cannot be
// required; the point of the test is to pin the RULE, so that a future edit
// that "simplifies" it to `newKey || legacy` fails here instead of in
// production on the one load where it matters.
function preferKey(fresh, legacy) {
    if (fresh && typeof fresh === 'object' && Object.keys(fresh).length) return fresh;
    return (legacy && typeof legacy === 'object') ? legacy : {};
}

test('before the SQL runs, the legacy branch is still the only copy', () => {
    const legacy = { staff: [{ id: 1, name: 'Rivky' }], nextStaffId: 2 };
    assert.deepStrictEqual(preferKey(undefined, legacy), legacy);
});

test('an EMPTY new key must not win over a populated legacy branch', () => {
    // The failure this pins: integration_hooks hydrates every row the camp has,
    // and a restricted user's key is scrubbed to nothing. A plain `a || b` takes
    // {} here — truthy — and the Payroll page loads empty.
    const legacy = { staff: [{ id: 1, name: 'Rivky' }], nextStaffId: 2 };
    assert.deepStrictEqual(preferKey({}, legacy), legacy);
    assert.deepStrictEqual(preferKey(null, legacy), legacy);
});

test('once the new key holds data it wins, even against a stale legacy branch', () => {
    // 158 deliberately leaves the legacy branch in place as the rollback copy,
    // so after the move BOTH exist and the new key has to be authoritative.
    const fresh = { staff: [{ id: 1, name: 'Rivky', rate: 20 }], nextStaffId: 2 };
    const stale = { staff: [{ id: 1, name: 'Rivky', rate: 15 }], nextStaffId: 2 };
    assert.deepStrictEqual(preferKey(fresh, stale), fresh);
});

test('neither source present yields an empty object, never undefined', () => {
    // The loader immediately reads .staff/.timesheets off this.
    assert.deepStrictEqual(preferKey(undefined, undefined), {});
    assert.deepStrictEqual(preferKey(null, 'not an object'), {});
});

// ── 1b. the stripped-snapshot guard ────────────────────────────────────────
//
// Mirrors _hasContent/_writable in campistry_me.js. Both new keys are stripped
// from the lite localStorage snapshot (they grow with headcount), and on a fresh
// load — before the IndexedDB read lands — loadGlobalSettings falls back to that
// snapshot. The key is then ABSENT, not empty, and writing back the module
// defaults would erase the camp's payroll file.
//
// This is the same bug class that integration_hooks fetch-merges app1 and
// campistryMe to avoid, and that the sessions/enrollments guards exist for.

function hasContent(v) {
    if (!v || typeof v !== 'object') return false;
    return Object.keys(v).some(k => {
        const x = v[k];
        if (Array.isArray(x)) return x.length > 0;
        if (x && typeof x === 'object') return Object.keys(x).length > 0;
        return !(x === undefined || x === null || x === '' || x === 0 || x === 1 || x === false);
    });
}
const writable = (built, wasLoaded) => hasContent(built) || !!wasLoaded;

const PAYROLL_DEFAULT = { staff: [], timesheets: [], youthCorps: {}, payRuns: [], nextStaffId: 1 };
const FINANCE_DEFAULT = { staff: [], expenses: [], budget: {}, integrations: {} };

test('an untouched default is NOT mistaken for content', () => {
    // The built object always has its shape, so Object.keys is never 0 — a
    // naive emptiness check would call these non-empty and write them.
    assert.strictEqual(hasContent(PAYROLL_DEFAULT), false);
    assert.strictEqual(hasContent(FINANCE_DEFAULT), false);
    assert.strictEqual(hasContent({ ...PAYROLL_DEFAULT, nextStaffId: 1 }), false,
        'nextStaffId defaults to 1, so 1 must not read as content');
});

test('a key we never loaded is NOT written when empty', () => {
    // The actual data-loss path: stripped snapshot -> defaults -> save.
    assert.strictEqual(writable(PAYROLL_DEFAULT, false), false,
        'an unloaded empty payroll would be written over the real cloud copy');
    assert.strictEqual(writable(FINANCE_DEFAULT, false), false);
});

test('a real deletion IS written', () => {
    // Loaded, then emptied by the user. Must persist, or "remove the last staff
    // member" silently reverts on reload.
    assert.strictEqual(writable(PAYROLL_DEFAULT, true), true);
    assert.strictEqual(writable(FINANCE_DEFAULT, true), true);
});

test('content always writes, loaded or not — a first-ever save must land', () => {
    // A brand-new camp has no key anywhere, so wasLoaded is false. Requiring
    // wasLoaded would make payroll unsaveable forever on such a camp.
    assert.strictEqual(writable({ ...PAYROLL_DEFAULT, staff: [{ id: 1, name: 'Rivky' }] }, false), true);
    assert.strictEqual(writable({ ...FINANCE_DEFAULT, budget: { revenue: 100 } }, false), true);
    assert.strictEqual(writable({ ...PAYROLL_DEFAULT, nextStaffId: 7 }, false), true);
});

// ── 2. whole-key scrub and preserve ────────────────────────────────────────

// Put the module in the state a real restricted load leaves it in. Only the
// levels map is supplied; scrubSettings/preserveOnSave and S.level below are
// the actual production code.
const GATED = ['me.payroll', 'me.finance', 'me.billing', 'snacks.accounts', 'link.tips'];
function restrictTo(noneSections) {
    const levels = {};
    GATED.forEach(cap => { levels[cap] = noneSections.indexOf(cap) >= 0 ? 'none' : 'edit'; });
    S.__applyLevelsForTest(levels);
}

test('a restricted section is scrubbed as a WHOLE KEY and put back on save', () => {
    restrictTo(['me.payroll']);
    const gs = {
        campistryMe: { families: { a: 1 }, finance: { payments: [{ id: 'p1' }] } },
        campistryMePayroll: { staff: [{ id: 1, name: 'Rivky', rate: 20 }] },
        campistryMeFinance: { budget: { revenue: 100 } },
    };

    S.scrubSettings(gs);
    // Gone from the copy that gets cached to localStorage/IDB on their laptop.
    assert.strictEqual('campistryMePayroll' in gs, false,
        'payroll key survived the scrub — it would be cached on a restricted laptop');
    // Untouched: not restricted.
    assert.deepStrictEqual(gs.campistryMeFinance, { budget: { revenue: 100 } });

    // On save the real value comes back, so the write cannot blank it.
    S.preserveOnSave(gs);
    assert.deepStrictEqual(gs.campistryMePayroll, { staff: [{ id: 1, name: 'Rivky', rate: 20 }] });
});

test('scrubbing finance does NOT take the payment ledger with it', () => {
    // The bug this pins was live: 'me.finance' used to scrub campistryMe.finance
    // wholesale, which included payments. A user with finance:none and
    // billing:edit therefore loaded an EMPTY ledger, and recording a single
    // payment wrote it back over every payment the camp had ever taken.
    restrictTo(['me.finance']);
    const gs = {
        campistryMe: { finance: { payments: [{ id: 'p1', amount: 500 }] } },
        campistryMeFinance: { budget: { revenue: 100 }, expenses: [{ id: 'e1' }] },
    };

    S.scrubSettings(gs);
    assert.strictEqual('campistryMeFinance' in gs, false, 'finance key was not scrubbed');
    assert.deepStrictEqual(gs.campistryMe.finance.payments, [{ id: 'p1', amount: 500 }],
        'the payment ledger was scrubbed — Billing would write an empty ledger back');
});

test('a two-segment branch path still scrubs, unchanged', () => {
    // The one-segment form is additive; the existing shape must keep working.
    restrictTo(['me.billing']);
    const gs = { campistryMe: { families: { a: 1 }, leads: { b: 2 } } };
    S.scrubSettings(gs);
    assert.strictEqual('families' in gs.campistryMe, false);
    assert.deepStrictEqual(gs.campistryMe.leads, { b: 2 }, 'scrub reached past its own branch');
    S.preserveOnSave(gs);
    assert.deepStrictEqual(gs.campistryMe.families, { a: 1 });
});

test('an unrestricted section is left completely alone', () => {
    restrictTo([]);
    const gs = {
        campistryMePayroll: { staff: [{ id: 1 }] },
        campistryMeFinance: { budget: { revenue: 100 } },
    };
    const before = JSON.parse(JSON.stringify(gs));
    S.scrubSettings(gs);
    assert.deepStrictEqual(gs, before);
});

// ── 3. downstream readers follow the move ──────────────────────────────────

test('birthdays reads staff from the new keys', () => {
    const people = B.collectFromSettings({
        campistryMePayroll: { staff: [{ name: 'Rivky Gold', dob: '2000-08-14', role: 'Counselor' }] },
        campistryMeFinance: { staff: [{ name: 'Shaya Weiss', dob: '1998-03-02', role: 'Head Staff' }] },
    });
    const names = people.map(p => p.name).sort();
    assert.deepStrictEqual(names, ['Rivky Gold', 'Shaya Weiss']);
});

test('birthdays still reads a pre-migration blob', () => {
    // A camp that has not saved since the move, or a page loaded before the SQL
    // was run, still has everything in campistryMe.
    const people = B.collectFromSettings({
        campistryMe: {
            payroll: { staff: [{ name: 'Rivky Gold', dob: '2000-08-14', role: 'Counselor' }] },
            finance: { staff: [{ name: 'Shaya Weiss', dob: '1998-03-02', role: 'Head Staff' }] },
        },
    });
    const names = people.map(p => p.name).sort();
    assert.deepStrictEqual(names, ['Rivky Gold', 'Shaya Weiss']);
});

test('birthdays survives a user who is denied both keys', () => {
    // Restricted or unentitled: the keys simply are not there. The card should
    // show no staff birthdays, not throw and take the dashboard down with it.
    const people = B.collectFromSettings({
        app1: { camperRoster: { 'Malky Stein': { dob: '2014-07-04', division: 'A' } } },
    });
    assert.deepStrictEqual(people.map(p => p.name), ['Malky Stein']);
});
