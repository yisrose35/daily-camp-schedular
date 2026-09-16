// node --test tests/aid_and_credits_reach_the_ledger.test.js
//
// Two money-in-name-only bugs, and the statement that could not add up.
//
// Award Financial Aid and Issue Credit both wrote a row on families[fk].credits
// and decremented families[fk].balance. Both of those are the DERIVED balance,
// and buildFamilyLedgers stops using the derived balance the moment a family
// has a posted ledger — which is every enrolled family, because tuition posts
// on every render. So the number that a payment plan charges and a parent sees
// on their pay link never moved: a camp could award a $1,500 scholarship, watch
// Billing show it, and bill the family full tuition anyway.
//
// Separately, a posted entry with no live counterpart — the withdrawal credit —
// never reached the rendered entry list at all, so a withdrawn family's printed
// statement showed the tuition charge with nothing against it and then a
// Balance Due that did not follow from the rows above it.
//
// Source assertions, for the reason billing_wiring.test.js gives: campistry_me.js
// has no export surface, and the failure being guarded is silent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ME = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
const B = require(path.join(ROOT, 'campistry_billing_core.js'));

function fnBody(decl, endDecl) {
    const a = ME.indexOf(decl);
    assert.ok(a > 0, 'cannot find ' + decl + ' — this test needs re-anchoring');
    const b = endDecl ? ME.indexOf(endDecl, a) : ME.length;
    assert.ok(b > a, 'cannot find the end anchor after ' + decl);
    return ME.slice(a, b);
}

// ── the ledger really does ignore families[].credits ───────────────────────
// This is the fact the whole change rests on, so it is asserted rather than
// assumed: if BillingCore ever started reading that array, the dual write
// below would double-count and this test should be the one that says so.

test('BillingCore.balance does not look at families[].credits', () => {
    const f = { entries: [] };
    B.postTuition(f, { enrollmentId: 'e1', camperName: 'Eli', tuition: 2000 });
    f.credits = [{ id: 'sch_1', reason: 'Scholarship for Eli', amount: 1500, date: '2026-04-01' }];
    assert.strictEqual(B.balance(f), 2000, 'the legacy credits array moves nothing');
});

test('a credit posted as an entry does move the balance', () => {
    const f = { entries: [] };
    B.postTuition(f, { enrollmentId: 'e1', camperName: 'Eli', tuition: 2000 });
    const r = B.post(f, { id: 'le_sch_1', kind: 'credit', amount: 1500, reason: 'scholarship' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(B.balance(f), 500);
});

test('BillingCore.post does NOT dedupe on id, so the caller must', () => {
    // The reason _postLedgerCredit carries its own B.find guard. If this ever
    // starts failing, BillingCore grew dedupe and the guard is belt-and-braces.
    const f = { entries: [] };
    B.post(f, { id: 'le_sch_1', kind: 'credit', amount: 1500, reason: 'scholarship' });
    B.post(f, { id: 'le_sch_1', kind: 'credit', amount: 1500, reason: 'scholarship' });
    assert.strictEqual(B.entriesOf(f).length, 2);
});

test('"scholarship" was always a valid ledger reason — nothing ever used it', () => {
    assert.ok(B.REASONS.indexOf('scholarship') >= 0);
});

// ── the poster ─────────────────────────────────────────────────────────────

test('_postLedgerCredit exists, posts a credit, and refuses to post it twice', () => {
    const fn = fnBody('function _postLedgerCredit(', '\n/** Money helpers');
    assert.match(fn, /kind:'credit'/, 'must post a credit');
    assert.match(fn, /if\(B\.find\(f,id\)\)return false/, 'must be idempotent on the credit id');
    assert.match(fn, /if\(!\(amt>0\)\)return false/, 'must refuse a zero or negative award');
    assert.match(fn, /B\.REASONS\.indexOf\(o\.reason\)>=0\?o\.reason:'goodwill'/,
        'an unknown reason must fall back, not be rejected by B.post');
});

// ── awarding aid ───────────────────────────────────────────────────────────

test('awarding aid posts it to the ledger, as a scholarship', () => {
    const fn = fnBody('function addScholarship(', '\n// ══');
    assert.match(fn, /_postLedgerCredit\(_f,\{id:_schId,amount:amt,reason:'scholarship'/,
        'the award never reaches the balance that is actually charged');
});

test('awarding aid is what marks a camper as on financial aid', () => {
    const fn = fnBody('function addScholarship(', '\n// ══');
    assert.match(fn, /roster\[camperName\]\.financialAid=true/);
    assert.match(fn, /_f\.financialAid=true/);
});

test('the cancellation policy reads exactly the flag the award now sets', () => {
    // The "financial aid is credited in full whatever the calendar says" rule
    // has always read e.financialAid || f.financialAid. Nothing set either.
    assert.match(ME, /financialAid:!!\(e\.financialAid\|\|\(f&&f\.financialAid\)\)/);
});

test('aid awarded to a camper in no household says so instead of claiming success', () => {
    const fn = fnBody('function addScholarship(', '\n// ══');
    assert.match(fn, /not in a household yet[^']*','error'\)/,
        'a silent no-op here is how a camp finds out in August');
});

// ── issuing a credit ───────────────────────────────────────────────────────

test('Issue Credit posts to the ledger too', () => {
    const fn = fnBody('function issueCreditForFamily(', '\nasync function printStatement');
    assert.match(fn, /_postLedgerCredit\(f,\{id:_crId,amount:amt/,
        'a manual credit that never reaches the ledger reduces nothing');
});

test('both credit paths still write the legacy row the statement renders from', () => {
    // Dual write is deliberate: the derived list is what Account Activity
    // prints, and the posted ledger is what is charged. Dropping either one
    // takes the credit off the page or off the bill.
    const aid = fnBody('function addScholarship(', '\n// ══');
    const cr = fnBody('function issueCreditForFamily(', '\nasync function printStatement');
    assert.match(aid, /_f\.credits\.push\(\{id:_schId/);
    assert.match(cr, /f\.credits\.push\(\{id:_crId/);
});

test('the two writes share one id, so the ledger merge cannot double-count them', () => {
    const aid = fnBody('function addScholarship(', '\n// ══');
    assert.match(aid, /var _schId='sch_'\+Date\.now\(\)/);
    assert.ok(!/credits\.push\(\{id:'sch_'\+Date\.now\(\)/.test(aid),
        'a second Date.now() would give the two writes different ids');
});

// ── the statement that did not add up ──────────────────────────────────────

test('buildFamilyLedgers merges posted entries that have no derived counterpart', () => {
    const fn = fnBody('function buildFamilyLedgers(', '\n    // 4. Compute balances');
    assert.match(fn, /3c\. Entries that exist ONLY on the posted ledger/);
    assert.match(fn, /_BM\.entriesOf\(l\.family\)\.forEach/);
});

test('every derived row registers what it stands for, or the merge duplicates it', () => {
    const fn = fnBody('function buildFamilyLedgers(', '\n    // 4. Compute balances');
    ["_seen['t:'+eid]=1", "_seen['d:'+eid]=1", "_seen['c:'+ch.id]=1", "_seen['x:'+cr.id]=1",
     "_seen['p:'+dep.id]=1"].forEach(k => {
        assert.ok(fn.indexOf(k) >= 0, 'missing registration: ' + k);
    });
    assert.match(fn, /_paymentRefsOf\(p\)\.forEach\(function\(r\)\{ledgers\[fk\]\._seen\['p:'\+r\]=1\}\)/,
        'a payment must register EVERY id it may have been posted under — matching only p.id ' +
        'lets a Stripe-keyed entry through and prints the payment twice');
});

test('the merge keys on kind as well as id — one enrollment carries two entries', () => {
    const fn = fnBody('function buildFamilyLedgers(', '\n    // 4. Compute balances');
    assert.match(fn, /e\.kind==='charge'&&e\.reason==='tuition'&&src\.enrollmentId\)key='t:'/);
    assert.match(fn, /e\.reason==='discount'\|\|e\.reason==='sibling'\).*key='d:'/);
});

test('a merged entry moves the matching total, not just the visible list', () => {
    const fn = fnBody('function buildFamilyLedgers(', '\n    // 4. Compute balances');
    assert.match(fn, /l\.totalCredits\+=amt/);
    assert.match(fn, /l\.totalCharges\+=amt/);
    assert.match(fn, /l\.totalPayments-=amt;l\.totalRefunds\+=amt/);
});

test('a withdrawal credit is the entry this was built for, and has no derived key', () => {
    // Nothing in steps 1-3b produces a row for it: it is posted straight to
    // f.entries by creditWithdrawal and rebuilt from nothing.
    const f = { entries: [] };
    B.postTuition(f, { enrollmentId: 'e1', camperName: 'Eli', tuition: 2000 });
    const r = B.creditWithdrawal(f, { enrollmentId: 'e1', camperName: 'Eli', policy: { amount: 1200 } });
    assert.ok(r.ok, r.error);
    const credit = B.entriesOf(f).find(e => e.reason === 'withdrawal');
    assert.ok(credit, 'no withdrawal credit posted');
    assert.strictEqual(credit.source.creditId, undefined, 'it carries no creditId to match on');
    assert.strictEqual(credit.kind, 'credit');
    // It keys on 'd:'? No — reason is 'withdrawal', not 'discount'/'sibling',
    // so it falls through every branch and is always merged.
    assert.ok(credit.reason !== 'discount' && credit.reason !== 'sibling');
});
