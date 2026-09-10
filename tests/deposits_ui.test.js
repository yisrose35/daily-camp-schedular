// node --test tests/deposits_ui.test.js
//
// The deposits UI is mostly DOM, but three things in it are pure and worth
// pinning down, because each one has a failure mode that is invisible in
// review: the ledger union (money silently not counted), the escaping split
// (mangled payer names, or worse), and the balance-snapshot payload (a wrong
// number feeding a server-side guardrail).
const test = require('node:test');
const assert = require('node:assert');

globalThis.CampistryDepositMatch = require('../campistry_deposit_match.js');
const D = require('../campistry_deposits_ui.js');

test('loads outside a browser without touching a bare window', () => {
    // A bare `window` reference throws ReferenceError in Node rather than
    // yielding undefined, which would take the whole Billing page down if this
    // module were ever evaluated in a non-browser context.
    assert.strictEqual(typeof D.refresh, 'function');
    assert.strictEqual(typeof D.memoCode, 'function');
});

test('memo codes delegate to the matcher, so there is one implementation', () => {
    const M = require('../campistry_deposit_match.js');
    assert.strictEqual(D.memoCode('fam_klein', 'Klein Family'), M.memoCode('fam_klein', 'Klein Family'));
    assert.match(D.memoInstruction('fam_klein', 'Klein Family'), /KLE-\d{4}/);
});

test('the escaping split keeps apostrophes readable in text', () => {
    // je()-style escaping on visible text renders "SHIMON\\'S HARDWARE LLC".
    // Apostrophes are extremely common in exactly the business payer names this
    // feature exists to handle, so the HTML escaper and the JS-string escaper
    // must stay separate. Rendering the Known Payers list is the cheapest way
    // to prove they are.
    let body = '';
    D.init({
        showModal: (_title, html) => { body = html; },
        esc: (s) => String(s == null ? '' : s),
        jesc: (s) => String(s == null ? '' : s).replace(/'/g, "\\'"),
        families: () => ({ fam_klein: { name: 'Klein Family' } })
    });
    D.state().aliases = [{
        id: 'alias-1', familyKey: 'fam_klein',
        displayName: "SHIMON'S HARDWARE LLC", handle: '', source: 'learned'
    }];

    D.openAliases();

    assert.ok(body.indexOf("SHIMON'S HARDWARE LLC") >= 0,
        'payer name should render with a plain apostrophe');
    assert.strictEqual(body.indexOf("SHIMON\\'S"), -1,
        'payer name must not be JS-escaped into visible text');
    assert.ok(body.indexOf('Klein Family') >= 0);
});

test('creditsFor returns the posted deposits a family ledger must count', () => {
    const state = D.state();
    state.credits = {
        fam_klein: [
            { id: 'dep_1', amount: 850, date: '2026-07-08', method: 'zelle', notes: 'Received from SHIMON\'S HARDWARE LLC' },
            { id: 'dep_2', amount: 425, date: '2026-07-22', method: 'ach', notes: 'Received from GOLDSTEIN DENTAL PC' }
        ]
    };
    assert.strictEqual(D.creditsFor('fam_klein').length, 2);
    assert.strictEqual(D.creditsFor('fam_klein').reduce((s, d) => s + d.amount, 0), 1275);
    // A family with no deposits must yield an array, not undefined — the ledger
    // builder iterates this directly.
    assert.deepStrictEqual(D.creditsFor('fam_nobody'), []);
});

test('pending counts drive the Billing banner and exclude posted deposits', () => {
    const state = D.state();
    state.deposits = [
        { id: '1', status: 'review',    amount_cents: 50000 },
        { id: '2', status: 'unmatched', amount_cents: 25000 },
        { id: '3', status: 'posted',    amount_cents: 90000 },
        { id: '4', status: 'ignored',   amount_cents: 10000 }
    ];
    assert.strictEqual(D.totalPending(), 2);
    assert.strictEqual(D.pendingAmount(), 750);
});

test('a return/NSF stays negative so the ledger can debit it', () => {
    // bank_deposits stores amount_cents positive and flags is_reversal; the
    // sign is applied by get_camp_deposit_credits. If a reversal ever arrives
    // here positive, a family whose ACH bounced reads as paid.
    D.state().credits = {
        fam_klein: [
            { id: 'dep_1', amount: 850, date: '2026-07-08', method: 'ach' },
            { id: 'dep_2', amount: -850, date: '2026-07-11', method: 'ach', isReversal: true }
        ]
    };
    const rows = D.creditsFor('fam_klein');
    assert.strictEqual(rows.reduce((s, d) => s + d.amount, 0), 0);
    assert.ok(rows.some(d => d.amount < 0), 'the reversal must carry a negative amount');
});

test('deposit kinds all resolve to a real payment label', () => {
    // The family ledger labels a deposit with the shared payment catalogue.
    // A kind missing from it renders the raw id ("wire") as the category.
    const P = require('../campistry_payments.js');
    ['zelle', 'ach', 'wire', 'other'].forEach(k => {
        assert.notStrictEqual(P.label(k), k, k + ' has no catalogue label');
    });
});
