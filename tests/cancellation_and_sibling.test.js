// node --test tests/cancellation_and_sibling.test.js
//
// Two money rules every camp has and Campistry did not, found by reading what
// the other platforms and their camps say goes wrong.
//
//   NO CANCELLATION POLICY. BillingCore.creditWithdrawal already understood
//     {percent}, {amount} and {keepDeposit}, but the only caller passed
//     `policy == null ? 'none' : policy` and nothing ever passed anything.
//     'none' credits zero, so every withdrawal silently kept 100% of the
//     tuition — not because a camp chose that, but because nobody had written
//     the rule down.
//
//   SIBLING DISCOUNT APPLIED ONCE, BY TYPING ORDER. It was granted at
//     enrollment if the family already had campers, so the first child entered
//     got nothing and the second got the discount; and it was never re-checked,
//     so a sibling withdrawing left either a discount nobody was entitled to or
//     one the camp owed and never gave. The public form multiplied it by zero.

const test = require('node:test');
const assert = require('node:assert');
const C = require('../campistry_cancellation_policy.js');
const S = require('../campistry_sibling_discount.js');
const B = require('../campistry_billing_core.js');

// ── 1. cancellation: the bands ──────────────────────────────────────────────

const POLICY = C.normalize({
    enabled: true, nonRefundableDeposit: 300,
    tiers: [{ minDaysBefore: 28, refundPct: 100 },
            { minDaysBefore: 15, refundPct: 50 },
            { minDaysBefore: 0,  refundPct: 0 }],
    afterStart: 'prorate', financialAidFullRefund: true
});

const withdraw = (onDate, extra) => C.resolve(POLICY, Object.assign({
    sessionStart: '2026-07-01', sessionEnd: '2026-07-29',
    onDate: onDate, tuitionNet: 3000
}, extra || {}));

test('the bands land where the camp published them', () => {
    // 60 days out: everything back except the deposit.
    assert.strictEqual(withdraw('2026-05-02').creditAmount, 2700);
    // Exactly 28 days: still the top band — "28 or more days before".
    assert.strictEqual(withdraw('2026-06-03').creditAmount, 2700);
    // 27 days: the half band. 1500 refundable, less the 300 deposit.
    assert.strictEqual(withdraw('2026-06-04').creditAmount, 1200);
    // 14 days: nothing, and the deposit cannot take it below zero.
    assert.strictEqual(withdraw('2026-06-17').creditAmount, 0);
    assert.strictEqual(withdraw('2026-06-17').keptAmount, 3000);
});

test('the deposit is kept in every band, which is what non-refundable means', () => {
    for (const d of ['2026-05-02', '2026-06-04']) {
        const r = withdraw(d);
        assert.ok(r.keptAmount >= 300,
            `on ${d} the camp kept ${r.keptAmount}, less than the deposit it said was non-refundable`);
    }
});

test('a part-attended session is credited pro rata', () => {
    // 28-day session, they leave after 7 days: 21 of 28 unattended.
    const r = withdraw('2026-07-08');
    assert.strictEqual(r.basis, 'prorated');
    // 3000 * 21/28 = 2250, less the 300 deposit.
    assert.strictEqual(r.creditAmount, 1950);
});

test('after the start with prorate off, nothing is credited — and it SAYS so', () => {
    const p = C.normalize({ enabled: true, nonRefundableDeposit: 0, afterStart: 'none' });
    const r = C.resolve(p, { sessionStart: '2026-07-01', sessionEnd: '2026-07-29',
                             onDate: '2026-07-08', tuitionNet: 3000 });
    assert.strictEqual(r.creditAmount, 0);
    assert.strictEqual(r.decided, true, 'a deliberate zero must be a DECISION');
    assert.match(r.label, /already started/);
});

test('financial aid is credited in full whatever the calendar says', () => {
    const r = withdraw('2026-06-17', { financialAid: true });   // the no-refund band
    assert.strictEqual(r.creditAmount, 3000);
    assert.strictEqual(r.basis, 'financial_aid');
});

// ── 2. cancellation: the distinction that matters most ──────────────────────

test('"no policy set" is NOT the same as "credit nothing"', () => {
    // The whole defect in one assertion. Reading an undecided zero as a
    // decision is exactly how every withdrawal came to keep 100%.
    const off = C.resolve(C.normalize({}), {
        sessionStart: '2026-07-01', onDate: '2026-05-01', tuitionNet: 3000
    });
    assert.strictEqual(off.decided, false);
    assert.strictEqual(off.creditAmount, 0);
    assert.strictEqual(C.corePolicyFor(off), null,
        'an undecided result hands BillingCore a policy anyway, which would ' +
        'credit zero and call it settled');

    const decided = withdraw('2026-06-17');
    assert.strictEqual(decided.decided, true);
    assert.deepStrictEqual(C.corePolicyFor(decided), { amount: 0 },
        'a deliberate zero must still be handed over as a decision');
});

test('unusable dates are undecided, not zero', () => {
    const r = C.resolve(POLICY, { sessionStart: '', onDate: '', tuitionNet: 3000 });
    assert.strictEqual(r.decided, false);
});

test('the amount handed to BillingCore is the one the office was shown', () => {
    // Passing {percent} would make BillingCore recompute against its own net
    // and quietly disagree with the dialog, deposit and prorating included.
    const r = withdraw('2026-06-04');
    const core = C.corePolicyFor(r);
    assert.deepStrictEqual(core, { amount: 1200 });

    const a = B.newAccount({ famKey: 'f1' });
    B.postTuition(a, { enrollmentId: 'e1', camperId: 1, tuition: 3000 });
    B.creditWithdrawal(a, { enrollmentId: 'e1', camperName: 'Eli', policy: core });
    assert.strictEqual(B.balance(a), 1800, 'the ledger disagrees with the dialog');
});

// ── 3. siblings: order must not decide who is discounted ────────────────────

const SESSIONS = [
    { name: 'Full Summer', tuition: 4000, siblingDiscount: 10 },
    { name: 'Half Summer', tuition: 2000, siblingDiscount: 10 }
];
const famOf = enr => ({ enrollments: enr, sessions: SESSIONS,
                        camperNames: Object.values(enr).map(e => e.camperName) });

test('the most expensive camper pays full price, whatever the entry order', () => {
    const a = { e1: { camperName: 'Eli', session: 'Full Summer', status: 'enrolled' },
                e2: { camperName: 'Mia', session: 'Half Summer', status: 'enrolled' } };
    const b = { e2: { camperName: 'Mia', session: 'Half Summer', status: 'enrolled' },
                e1: { camperName: 'Eli', session: 'Full Summer', status: 'enrolled' } };
    const ra = S.compute(famOf(a)), rb = S.compute(famOf(b));
    assert.strictEqual(ra.byEnrollment.e1.amt, 0, 'the dearer session was discounted');
    assert.strictEqual(ra.byEnrollment.e2.amt, 200);
    assert.deepStrictEqual(ra.byEnrollment, rb.byEnrollment,
        'entering the same two children in the other order priced them differently');
});

test('a tie is broken stably, not arbitrarily', () => {
    // Two identically priced children must not swap the discount between them
    // every time anything is recalculated.
    const enr = { eB: { camperName: 'B', session: 'Half Summer', status: 'enrolled' },
                  eA: { camperName: 'A', session: 'Half Summer', status: 'enrolled' } };
    const first = S.compute(famOf(enr)).byEnrollment;
    const again = S.compute(famOf(enr)).byEnrollment;
    assert.deepStrictEqual(first, again);
    assert.strictEqual(Object.values(first).filter(x => x.amt > 0).length, 1);
});

test('one camper is not a sibling set', () => {
    const r = S.compute(famOf({ e1: { camperName: 'Eli', session: 'Full Summer', status: 'enrolled' } }));
    assert.strictEqual(r.byEnrollment.e1.amt, 0);
    assert.strictEqual(r.byEnrollment.e1.reason, 'only_camper');
});

test('a withdrawn camper stops counting as a sibling', () => {
    const enr = { e1: { camperName: 'Eli', session: 'Full Summer', status: 'enrolled' },
                  e2: { camperName: 'Mia', session: 'Half Summer', status: 'withdrawn' } };
    const r = S.compute(famOf(enr));
    assert.strictEqual(r.counted, 1);
    assert.strictEqual(r.byEnrollment.e1.amt, 0);
    assert.strictEqual(r.byEnrollment.e2, undefined, 'a withdrawn enrollment is still priced');
});

// ── 4. siblings: the change has to be noticed and be postable ───────────────

test('a sibling leaving revokes the discount, and the diff says who owes more', () => {
    // The case the industry names: the second child drops mid-season.
    const before = { e1: { camperName: 'Eli', session: 'Full Summer', status: 'enrolled' },
                     e2: { camperName: 'Mia', session: 'Half Summer', status: 'enrolled',
                           discount: { pct: 10, amt: 200 } } };
    const after = { e1: before.e1,
                    e2: Object.assign({}, before.e2, { status: 'withdrawn' }) };
    // Eli alone now. Mia's 200 discount is gone with her, and Eli never had one.
    const changes = S.diff(S.compute(famOf(after)), after);
    assert.deepStrictEqual(changes, [], 'nothing should change for the camper who had no discount');

    // Now the other way round: the DEARER child leaves, so the one left becomes
    // the most expensive and loses the discount they had.
    const after2 = { e1: Object.assign({}, before.e1, { status: 'withdrawn' }), e2: before.e2 };
    const ch2 = S.diff(S.compute(famOf(after2)), after2);
    assert.strictEqual(ch2.length, 1);
    assert.strictEqual(ch2[0].enrollmentId, 'e2');
    assert.strictEqual(ch2[0].was, 200);
    assert.strictEqual(ch2[0].now, 0);
    assert.strictEqual(ch2[0].delta, 200, 'they owe 200 MORE and the sign must say so');
    assert.strictEqual(ch2[0].direction, 'less_discount');
});

test('a second child arriving grants the discount retroactively', () => {
    // "Parents register multiple children at full price, realize the discount
    // should have applied, and email asking for a refund."
    const now = { e1: { camperName: 'Eli', session: 'Full Summer', status: 'enrolled' },
                  e2: { camperName: 'Mia', session: 'Half Summer', status: 'enrolled' } };
    const changes = S.diff(S.compute(famOf(now)), now);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].enrollmentId, 'e2');
    assert.strictEqual(changes[0].now, 200);
    assert.strictEqual(changes[0].delta, -200, 'a new discount must lower what is owed');
    assert.strictEqual(changes[0].direction, 'more_discount');
});

test('the delta posts to the ledger instead of editing the tuition charge', () => {
    // Tuition is a posted charge and posted charges are facts. A revoked
    // discount is a new entry, not a rewrite.
    const a = B.newAccount({ famKey: 'f1' });
    B.postTuition(a, { enrollmentId: 'e2', camperId: 2, tuition: 2000 });
    B.post(a, { kind: 'credit', amount: 200, reason: 'sibling', source: { enrollmentId: 'e2' } });
    assert.strictEqual(B.balance(a), 1800);

    // Sibling leaves: the discount is taken back as a CHARGE, not by deleting.
    B.post(a, { kind: 'charge', amount: 200, reason: 'sibling', source: { enrollmentId: 'e2' } });
    assert.strictEqual(B.balance(a), 2000);
    assert.strictEqual(B.entriesOf(a).length, 3, 'an entry was removed rather than reversed');
});

test('a session with no sibling rate discounts nobody, and says why', () => {
    const sessions = [{ name: 'Day Camp', tuition: 500 }];
    const enr = { e1: { camperName: 'A', session: 'Day Camp', status: 'enrolled' },
                  e2: { camperName: 'B', session: 'Day Camp', status: 'enrolled' } };
    const r = S.compute({ enrollments: enr, sessions: sessions, camperNames: ['A', 'B'] });
    assert.strictEqual(r.discounted, 0);
    const cheaper = Object.values(r.byEnrollment).find(x => x.reason !== 'highest_tuition');
    assert.strictEqual(cheaper.reason, 'no_rate_on_session');
});

// ── 5. the app actually uses both, which is where the last one failed ───────
//
// The engine existing was never the problem: creditWithdrawal already took a
// policy and nobody passed one. So these check the wiring, not the maths.

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ME = read('campistry_me.js');

test('withdrawals stop defaulting to keeping everything', () => {
    assert.match(ME, /function _withdrawalQuotes\(f,name,onDate\)/,
        'nothing works out what the policy says a withdrawal is worth');
    assert.match(ME, /if\(pol==null&&CP&&q\.quote&&q\.quote\.decided\)pol=CP\.corePolicyFor\(q\.quote\);/,
        'the policy result is never handed to creditWithdrawal');
    // An explicit override from the caller must still win.
    const fn = ME.slice(ME.indexOf('function _creditWithdrawalsFor'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /var pol=policy;/,
        'an office override is ignored in favour of the published policy');
});

test('an undecided policy still credits nothing, and only then', () => {
    // The narrow remaining case: no policy configured AND no override. It has
    // to stay 'none' — but it is now that case alone, not every withdrawal.
    const fn = ME.slice(ME.indexOf('function _creditWithdrawalsFor'));
    assert.match(fn, /if\(pol==null\)pol='none';/);
});

test('the office is shown the number before it happens', () => {
    assert.match(ME, /function _withdrawalQuoteText\(quotes\)/,
        'there is no way to put the credit in front of the office first');
    assert.match(ME, /CP\.explain\(q\.quote,fm\)/);
});

test('sibling pricing is recomputed where the family changes', () => {
    assert.match(ME, /function _resyncSiblingDiscounts\(fk\)/);
    const calls = (ME.match(/_resyncSiblingDiscounts\(/g) || []).length;
    assert.ok(calls >= 3,
        `the resync is defined but called from ${calls - 1} place(s); it has to run ` +
        `wherever a family's enrolled set changes`);
    // After the statuses flip, not before — it prices from who is still enrolled.
    const at = ME.indexOf("_sibChanges=_resyncSiblingDiscounts(_fkOf)");
    const flip = ME.indexOf("e.status='unenrolled'");
    assert.ok(at > 0 && flip > 0 && at > flip,
        'the sibling re-price runs before the withdrawal is applied, so it prices ' +
        'the family as it was rather than as it now is');
});

test('the old order-dependent rule is gone', () => {
    assert.ok(!/sesObj&&sesObj\.siblingDiscount>0&&famKey&&families\[famKey\]&&families\[famKey\]\.camperIds\.length>0/.test(ME),
        'the "family already has campers" rule is still there, so who gets the ' +
        'discount still depends on data-entry order');
    assert.match(ME, /var _c=_SD\.compute\(\{enrollments:enrollments,sessions:sessions,/,
        'a new enrollment is no longer priced from the shared rule');
});

test('a revoked discount is posted, not edited into the tuition charge', () => {
    const fn = ME.slice(ME.indexOf('function _resyncSiblingDiscounts'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /kind:c\.delta>0\?'charge':'credit'/,
        'the delta is not posted as a ledger entry');
    assert.match(body, /var id='le_sib_'/, 'the entry has no stable id, so re-running stacks');
    assert.match(body, /if\(entries\[i\]&&entries\[i\]\.id===id\)return/,
        're-running posts the same adjustment twice');
});

test('both cores are actually loaded by the pages that need them', () => {
    const meHtml = read('campistry_me.html');
    assert.match(meHtml, /campistry_cancellation_policy\.js/);
    assert.match(meHtml, /campistry_sibling_discount\.js/);
    // The public form has to apply the discount too — it used to multiply it
    // by zero and leave the family to notice.
    const reg = read('campistry_register.html');
    assert.match(reg, /campistry_sibling_discount\.js/);
});

test('the camp can actually set the policy', () => {
    // A policy with no way to configure it changes nothing in practice.
    assert.match(ME, /function _cpCardHtml\(pol\)/, 'there is no settings form');
    assert.match(ME, /function _cpRead\(\)/, 'the form is never read back');
    assert.match(ME, /enrollSettings\.cancellationPolicy=_cpAPI\(\)\.normalize\(_cpRead\(\)\)/,
        'the form is never saved');
    assert.match(ME, /_cpToggle:_cpToggle/, 'the toggle is not exported, so the panel cannot open');
    assert.match(ME, /_cpCardSafe\(\)/, 'the card is never rendered');
});
