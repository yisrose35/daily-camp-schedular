// node --test tests/billing_core.test.js
//
// The ledger engine. Every scenario in TEST_FINDINGS.md that used to lose money
// is replayed here against campistry_billing_core.js and must now come out
// right — so this file is both the unit suite and the proof that the redesign
// actually addresses what it was written for.
//
// The four rules it enforces, each with its own section:
//   1. entries are never mutated or removed
//   2. posting is idempotent where a real-world event happens once
//   3. amounts are positive; the sign lives in `kind`
//   4. the account outlives the enrollment, and joins on camperId not name

const test = require('node:test');
const assert = require('node:assert');
const B = require('../campistry_billing_core.js');

const acct = (o) => B.newAccount(Object.assign({ famKey: 'f1', name: 'Stein Family' }, o));

/** A fully enrolled family owing 3000. The starting point for most tests. */
function enrolled(tuition = 3000, over = {}) {
    const a = acct({ camperIds: [101] });
    B.postTuition(a, Object.assign({
        enrollmentId: 'e1', camperId: 101, camperName: 'Malky Stein',
        session: 'Full Summer', tuition, date: '2026-01-01',
    }, over));
    return a;
}

// ── 1. the balance is a sum, not a stored number ──────────────────────────

test('balance is charges + refunds − credits − payments', () => {
    const a = acct();
    B.post(a, { kind: 'charge', amount: 1000, reason: 'tuition' });
    B.post(a, { kind: 'charge', amount: 150, reason: 'fee' });
    B.post(a, { kind: 'credit', amount: 100, reason: 'discount' });
    B.post(a, { kind: 'payment', amount: 400, reason: 'card' });
    B.post(a, { kind: 'refund', amount: 50, reason: 'card' });
    assert.strictEqual(B.balance(a), 700);   // 1150 + 50 − 100 − 400
});

test('an empty account owes nothing', () => {
    assert.strictEqual(B.balance(acct()), 0);
});

test('overpaying goes negative — the camp owes it back', () => {
    // Never clamped. Clamping hides a refund the camp genuinely owes, which is
    // the same defect as a disappearing debt pointed the other way.
    const a = enrolled();
    B.post(a, { kind: 'payment', amount: 3500, reason: 'check' });
    assert.strictEqual(B.balance(a), -500);
});

test('rounding holds over many small entries', () => {
    const a = acct();
    for (let i = 0; i < 3; i++) B.post(a, { kind: 'charge', amount: 33.33, reason: 'canteen' });
    B.post(a, { kind: 'payment', amount: 99.99, reason: 'cash' });
    assert.strictEqual(B.balance(a), 0);
});

// ── 2. rule 3: amounts are positive, the sign lives in `kind` ─────────────

test('a negative or zero amount is refused, not reinterpreted', () => {
    const a = acct();
    for (const bad of [-100, 0, null, undefined, 'abc', NaN]) {
        const r = B.post(a, { kind: 'charge', amount: bad, reason: 'fee' });
        assert.strictEqual(r.ok, false, `amount ${bad} should be refused`);
        assert.strictEqual(r.error, 'bad_amount');
    }
    assert.strictEqual(B.entriesOf(a).length, 0, 'nothing was appended');
});

test('an unknown kind or reason is refused', () => {
    const a = acct();
    assert.strictEqual(B.post(a, { kind: 'invoice', amount: 10 }).error, 'bad_kind');
    assert.strictEqual(B.post(a, { kind: 'charge', amount: 10, reason: 'vibes' }).error, 'bad_reason');
});

// ── 3. rule 1: nothing is ever mutated or removed ─────────────────────────

test('a reversal appends the mirror and leaves the original untouched', () => {
    const a = enrolled();
    const orig = B.entriesOf(a)[0];
    const frozen = JSON.stringify(orig);

    const r = B.reverse(a, orig.id, { note: 'Billed in error', by: 'office' });
    assert.ok(r.ok);
    assert.strictEqual(JSON.stringify(B.find(a, orig.id)), frozen,
        'the original entry must be byte-identical after being reversed');
    assert.strictEqual(r.entry.kind, 'credit', 'a charge reverses to a credit');
    assert.strictEqual(r.entry.amount, 3000);
    assert.strictEqual(r.entry.reverses, orig.id);
    assert.strictEqual(B.balance(a), 0);
});

test('the reversal back-pointer is derived, not stored on the original', () => {
    const a = enrolled();
    const orig = B.entriesOf(a)[0];
    assert.ok(!('reversedBy' in orig), 'the original must carry no mutable back-pointer');
    B.reverse(a, orig.id, {});
    assert.strictEqual(B.reversalOf(a, orig.id).reverses, orig.id);
    assert.strictEqual(B.isReversed(a, orig.id), true);
    assert.ok(!('reversedBy' in B.find(a, orig.id)), 'still no field written on the original');
});

test('reversing twice is refused — it would credit the family twice', () => {
    const a = enrolled();
    const id = B.entriesOf(a)[0].id;
    assert.ok(B.reverse(a, id, {}).ok);
    const second = B.reverse(a, id, {});
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.error, 'already_reversed');
    assert.strictEqual(B.balance(a), 0, 'balance moved once, not twice');
});

test('a reversal cannot itself be reversed', () => {
    const a = enrolled();
    const rev = B.reverse(a, B.entriesOf(a)[0].id, {});
    assert.strictEqual(B.reverse(a, rev.entry.id, {}).error, 'cannot_reverse_a_reversal');
});

test('payments and refunds mirror each other', () => {
    const a = enrolled();
    const p = B.post(a, { kind: 'payment', amount: 500, reason: 'card' });
    assert.strictEqual(B.balance(a), 2500);
    B.reverse(a, p.entry.id, { note: 'Chargeback' });
    assert.strictEqual(B.balance(a), 3000, 'a reversed payment is a refund');
    assert.strictEqual(B.reversalOf(a, p.entry.id).kind, 'refund');
});

// ── 4. rule 2: posting tuition is idempotent ──────────────────────────────

test('tuition posts once however many times it is called', () => {
    // The old code re-derived tuition on every render. If the new code posted on
    // every render the family would be billed repeatedly — the opposite failure,
    // and the one real risk of moving from derived to posted.
    const a = acct({ camperIds: [101] });
    const enr = { enrollmentId: 'e1', camperId: 101, camperName: 'Malky Stein', tuition: 3000 };
    for (let i = 0; i < 50; i++) B.postTuition(a, enr);
    assert.strictEqual(B.balance(a), 3000);
    assert.strictEqual(B.entriesOf(a).filter(e => e.reason === 'tuition').length, 1);
});

test('re-posting reports alreadyPosted rather than failing', () => {
    const a = enrolled();
    const again = B.postTuition(a, { enrollmentId: 'e1', tuition: 3000 });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.alreadyPosted, true);
});

test('a later price change does NOT re-bill — it is a correction to post', () => {
    const a = enrolled(3000);
    const r = B.postTuition(a, { enrollmentId: 'e1', tuition: 3500 });
    assert.strictEqual(r.alreadyPosted, true);
    assert.strictEqual(B.balance(a), 3000, 'the posted charge is a fact');
    // The honest way to raise it:
    B.post(a, { kind: 'charge', amount: 500, reason: 'adjustment',
                note: 'Session price corrected 3000 → 3500',
                source: { enrollmentId: 'e1' } });
    assert.strictEqual(B.balance(a), 3500);
});

test('tuition without an enrollment id is refused', () => {
    assert.strictEqual(B.postTuition(acct(), { tuition: 100 }).error, 'no_enrollment_id');
});

// ── 5. a discount is a credit, so gross and given-away stay separable ─────

test('a discount posts as its own credit against the gross charge', () => {
    const a = acct({ camperIds: [101] });
    B.postTuition(a, { enrollmentId: 'e1', tuition: 3000, discount: 500 });
    assert.strictEqual(B.balance(a), 2500);
    const s = B.summary(a);
    assert.strictEqual(s.assessed, 3000, 'the camp billed 3000');
    assert.strictEqual(s.discounts, 500, 'and gave 500 away — reportable separately');
    assert.strictEqual(s.netAssessed, 3000, 'a discount does not reduce the assessment');
});

test('a discount never exceeds the tuition', () => {
    const a = acct();
    B.postTuition(a, { enrollmentId: 'e1', tuition: 1000, discount: 5000 });
    assert.strictEqual(B.balance(a), 0, 'stops at free, never negative');
});

test('a correction reduces the ASSESSMENT; a discount does not', () => {
    // FACTS draws this same line, and a board report needs it: one shrinks
    // revenue, the other is money you chose to give away.
    const a = enrolled(3000);
    B.post(a, { kind: 'credit', amount: 300, reason: 'correction', note: 'Billed wrong session' });
    const s = B.summary(a);
    assert.strictEqual(s.assessed, 3000);
    assert.strictEqual(s.corrections, 300);
    assert.strictEqual(s.netAssessed, 2700);
    assert.strictEqual(s.discounts, 0);
    assert.strictEqual(s.balance, 2700);
});

test('summary.balance always agrees with balance()', () => {
    const a = enrolled(3000, { discount: 250 });
    B.post(a, { kind: 'payment', amount: 1000, reason: 'zelle' });
    B.post(a, { kind: 'charge', amount: 60, reason: 'canteen' });
    B.post(a, { kind: 'refund', amount: 25, reason: 'card' });
    B.post(a, { kind: 'credit', amount: 15, reason: 'goodwill' });
    assert.strictEqual(B.summary(a).balance, B.balance(a));
});

// ── 6. THE DEFECTS. Taking a camper out of camp ───────────────────────────

test('D0/delete: the debt SURVIVES the camper being removed', () => {
    // The whole reason this module exists. Under the old derived model, removing
    // the enrollment erased the charge and with it the debt. Here the charge is
    // a posted fact and the default withdrawal policy forgives nothing.
    const a = enrolled(3000);
    B.post(a, { kind: 'payment', amount: 1500, reason: 'card' });
    assert.strictEqual(B.balance(a), 1500);

    const r = B.creditWithdrawal(a, { enrollmentId: 'e1', camperName: 'Malky Stein' });
    assert.ok(r.ok);
    assert.strictEqual(B.balance(a), 1500,
        'they still owe 1500 after being removed — this is the bug that is fixed');
    // And the original charge is still on the record a year later.
    assert.strictEqual(B.tuitionEntryFor(a, 'e1').amount, 3000);
});

test('a withdrawal policy can forgive all, some, or nothing', () => {
    // Every case starts from tuition 3000 with 1500 already paid, so a policy
    // that forgives MORE than the 1500 still outstanding correctly leaves the
    // camp owing the difference back. That is the point of not clamping.
    const cases = [
        ['none', 1500],                // forgive nothing — they still owe 1500
        ['full', -1500],               // forgive all 3000 — the 1500 paid is now refundable
        [{ percent: 50 }, 0],          // forgive 1500 — exactly settles
        [{ amount: 500 }, 1000],
        [{ keepDeposit: 500 }, -1000], // forgive 2500, they had paid 1500
    ];
    for (const [policy, expected] of cases) {
        const a = enrolled(3000);
        B.post(a, { kind: 'payment', amount: 1500, reason: 'card' });
        B.creditWithdrawal(a, { enrollmentId: 'e1', policy });
        assert.strictEqual(B.balance(a), expected,
            `policy ${JSON.stringify(policy)} should leave ${expected}`);
    }
});

test('a withdrawal credit never exceeds what is still charged', () => {
    const a = enrolled(1000);
    B.creditWithdrawal(a, { enrollmentId: 'e1', policy: { amount: 99999 } });
    assert.strictEqual(B.balance(a), 0, 'cannot credit past the charge');
});

test('withdrawing twice credits once', () => {
    const a = enrolled(3000);
    B.creditWithdrawal(a, { enrollmentId: 'e1', policy: 'full' });
    const second = B.creditWithdrawal(a, { enrollmentId: 'e1', policy: 'full' });
    assert.strictEqual(second.alreadyCredited, true);
    assert.strictEqual(B.balance(a), 0, 'not −3000');
});

test('withdrawing one sibling leaves the other fully billed', () => {
    const a = acct({ camperIds: [101, 102] });
    B.postTuition(a, { enrollmentId: 'e1', camperId: 101, camperName: 'Malky', tuition: 3000 });
    B.postTuition(a, { enrollmentId: 'e2', camperId: 102, camperName: 'Shaya', tuition: 3000 });
    assert.strictEqual(B.balance(a), 6000);
    B.creditWithdrawal(a, { enrollmentId: 'e1', policy: 'full' });
    assert.strictEqual(B.balance(a), 3000, 'the sibling is untouched');
    assert.strictEqual(B.netTuitionFor(a, 'e2'), 3000);
});

test('a fee survives a withdrawal — it is not tuition', () => {
    const a = enrolled(3000);
    B.post(a, { kind: 'charge', amount: 150, reason: 'fee', note: 'Bus' });
    B.creditWithdrawal(a, { enrollmentId: 'e1', policy: 'full' });
    assert.strictEqual(B.balance(a), 150, 'the bus charge is not forgiven by a withdrawal');
});

test('re-enrolling does NOT double-bill — the trap in this design', () => {
    // The carried debt and a fresh enrollment must not both bill. They cannot,
    // because tuition is keyed per enrollment: a new season is a NEW
    // enrollmentId, and last season's charge is already posted and unchanged.
    const a = enrolled(3000);
    B.post(a, { kind: 'payment', amount: 1500, reason: 'card' });
    B.creditWithdrawal(a, { enrollmentId: 'e1' });          // owes 1500, removed
    assert.strictEqual(B.balance(a), 1500);

    B.postTuition(a, { enrollmentId: 'e2', camperId: 101, tuition: 3200,
                       season: 'Summer 2027' });
    assert.strictEqual(B.balance(a), 4700, '1500 carried + 3200 new — not 1500 + 3000 + 3200');
    assert.strictEqual(B.entriesOf(a).filter(e => e.reason === 'tuition').length, 2);
});

// ── 7. rule 4: the account outlives enrollment, and joins on ID ───────────

test('hasMoney keeps any account with a history, even one netting to zero', () => {
    const empty = acct();
    assert.strictEqual(B.hasMoney(empty), false, 'a genuinely untouched account may be deleted');

    const closed = enrolled(3000);
    B.post(closed, { kind: 'payment', amount: 3000, reason: 'card' });
    assert.strictEqual(B.balance(closed), 0);
    assert.strictEqual(B.hasMoney(closed), true,
        'a settled account is closed, not empty — its history is worth keeping');
});

test('hasMoney also keeps an account holding only a card or a plan', () => {
    const withCard = acct(); withCard.cardOnFile = true;
    assert.strictEqual(B.hasMoney(withCard), true);
    const withPlan = acct(); withPlan.plans = [B.newPlan({ dueDates: ['2026-01-01'] })];
    assert.strictEqual(B.hasMoney(withPlan), true);
    const withToken = acct(); withToken.savedPaymentMethods = [{ token: 'pm_1' }];
    assert.strictEqual(B.hasMoney(withToken), true);
});

test('entries carry camperId, so money never joins on a name', () => {
    // D4: two children with the same name across two summers must not share a
    // balance. Identity is the id; the name is a display label that rides along.
    const a = enrolled(3000);
    const e = B.tuitionEntryFor(a, 'e1');
    assert.strictEqual(e.source.camperId, 101);
    assert.strictEqual(e.source.camperName, 'Malky Stein');

    const other = acct({ camperIds: [205] });
    B.postTuition(other, { enrollmentId: 'e9', camperId: 205,
                           camperName: 'Malky Stein', tuition: 500 });
    assert.strictEqual(B.balance(a), 3000, 'same name, different id, separate money');
    assert.strictEqual(B.balance(other), 500);
});

// ── 8. payment plans: derived amounts, and D1 ─────────────────────────────

const SIX = () => B.newPlan({
    id: 'plan_1',
    dueDates: ['2026-01-01','2026-02-01','2026-03-01','2026-04-01','2026-05-01','2026-06-01'],
});

/** Charge whatever is due on `date`, the way the runner will. */
function runNight(a, plan, date) {
    const due = B.planDue(a, plan, date);
    if (!due) return null;
    if (due.amount <= 0) {
        B.recordInstalment(plan, { index: due.index, dueDate: due.dueDate,
                                   charged: 0, reason: due.reason || 'nothing_owed' });
        return due;
    }
    const p = B.post(a, { kind: 'payment', amount: due.amount, reason: 'autopay',
                          date: date, source: { planId: plan.id } });
    B.recordInstalment(plan, { index: due.index, dueDate: due.dueDate,
                               charged: due.amount, entryId: p.entry.id });
    return due;
}

test('a plan divides the balance evenly and collects all of it', () => {
    const a = enrolled(3000);
    const plan = SIX();
    for (const d of plan.dueDates) runNight(a, plan, d);
    assert.strictEqual(B.balance(a), 0, 'every dollar collected');
    assert.deepStrictEqual(plan.history.map(h => h.charged), [500,500,500,500,500,500]);
});

test('an amount that does not divide evenly is swept by the last instalment', () => {
    const a = enrolled(1000);
    const plan = B.newPlan({ dueDates: ['2026-01-01','2026-02-01','2026-03-01'] });
    for (const d of plan.dueDates) runNight(a, plan, d);
    assert.strictEqual(B.balance(a), 0, 'no cents left uncollectable');
    const total = plan.history.reduce((s, h) => s + h.charged, 0);
    assert.strictEqual(B.money(total), 1000);
});

test('an early overpayment just makes later instalments smaller', () => {
    // No capping, no scheduledAmount, no explanatory note needed — the amount
    // is derived, so it is simply right.
    const a = enrolled(3000);
    const plan = SIX();
    runNight(a, plan, '2026-01-01');                                  // 500
    B.post(a, { kind: 'payment', amount: 1000, reason: 'check' });     // parent pays extra
    const due = B.planDue(a, plan, '2026-02-01');
    assert.strictEqual(due.amount, 300, '1500 owed over 5 remaining');
    for (const d of plan.dueDates.slice(1)) runNight(a, plan, d);
    assert.strictEqual(B.balance(a), 0);
});

test('a late discount self-corrects on the next instalment', () => {
    const a = enrolled(3000);
    const plan = SIX();
    runNight(a, plan, '2026-01-01');
    B.post(a, { kind: 'credit', amount: 500, reason: 'scholarship' });
    assert.strictEqual(B.planDue(a, plan, '2026-02-01').amount, 400, '2000 over 5');
});

test('D1 FIXED: a parked-then-re-enrolled family pays in full', () => {
    // The worked example from TEST_FINDINGS.md, which used to end $1,500 short
    // with a plan reading "fully paid". Nothing is marked paid here, so nothing
    // is destroyed while the balance is zero.
    const a = enrolled(3000);
    const plan = SIX();
    runNight(a, plan, '2026-01-01');                 // 500
    runNight(a, plan, '2026-02-01');                 // 500

    B.creditWithdrawal(a, { enrollmentId: 'e1', policy: 'full' });   // parked, nothing owed
    assert.strictEqual(B.balance(a), -1000, 'they are owed their 1000 back while away');
    runNight(a, plan, '2026-03-01');
    runNight(a, plan, '2026-04-01');
    runNight(a, plan, '2026-05-01');
    assert.deepStrictEqual(plan.history.slice(2).map(h => h.charged), [0, 0, 0],
        'nothing charged while away — and nothing destroyed');

    // Re-enrolled: the withdrawal credit is reversed and the tuition stands again.
    B.reverse(a, B.withdrawalCreditFor(a, 'e1').id, { note: 'Re-enrolled' });
    assert.strictEqual(B.balance(a), 2000, 'the full remaining balance is back');

    runNight(a, plan, '2026-06-01');                 // last date sweeps it
    const st = B.planStatus(a, plan);
    assert.strictEqual(B.balance(a), 0, 'collected in full — no 1500 hole');
    assert.strictEqual(st.outstanding, 0);
    assert.strictEqual(st.settled, true);
});

test('a plan that ends with money owed says so, loudly', () => {
    // The old model swallowed this by writing status:'paid'. This is the case
    // that must never be silent again.
    const a = enrolled(3000);
    const plan = B.newPlan({ dueDates: ['2026-01-01'] });
    plan.paused = true;                       // nothing ever charged
    plan.nextIndex = 1;                       // dates exhausted
    const st = B.planStatus(a, plan);
    assert.strictEqual(st.complete, true);
    assert.strictEqual(st.settled, false);
    assert.strictEqual(st.outstanding, 3000, 'reported, not hidden');
});

test('nothing can be recorded as paid that was not charged', () => {
    const a = enrolled(3000);
    const plan = SIX();
    runNight(a, plan, '2026-01-01');
    B.creditWithdrawal(a, { enrollmentId: 'e1', policy: 'full' });
    runNight(a, plan, '2026-02-01');           // charged 0

    const row = plan.history.find(h => h.index === 1);
    assert.strictEqual(row.charged, 0);
    assert.strictEqual(row.reason, 'nothing_owed');
    assert.ok(!('status' in row), 'there is no status field to corrupt');
    // And the invariant that replaces trusting a status:
    assert.strictEqual(B.planReconciles(a, plan).ok, true);
});

test('plan history reconciles against real payment entries', () => {
    const a = enrolled(3000);
    const plan = SIX();
    for (const d of plan.dueDates) runNight(a, plan, d);
    const rec = B.planReconciles(a, plan);
    assert.strictEqual(rec.claimed, 3000);
    assert.strictEqual(rec.posted, 3000);
    assert.strictEqual(rec.ok, true);
});

test('an instalment is recorded once even if the runner retries', () => {
    const plan = SIX();
    B.recordInstalment(plan, { index: 0, charged: 500 });
    const again = B.recordInstalment(plan, { index: 0, charged: 500 });
    assert.strictEqual(again.alreadyRecorded, true);
    assert.strictEqual(plan.history.length, 1);
    assert.strictEqual(plan.nextIndex, 1, 'the counter advanced once');
});

test('a paused plan is due nothing', () => {
    const a = enrolled(3000);
    const plan = SIX();
    plan.paused = true;
    assert.strictEqual(B.planDue(a, plan, '2026-01-01'), null);
});

test('a plan is due nothing before its date', () => {
    const a = enrolled(3000);
    assert.strictEqual(B.planDue(a, SIX(), '2025-12-31'), null);
});

test('a settled family is charged nothing but keeps its schedule intact', () => {
    const a = enrolled(3000);
    B.post(a, { kind: 'payment', amount: 3000, reason: 'check' });
    const plan = SIX();
    const due = B.planDue(a, plan, '2026-01-01');
    assert.strictEqual(due.amount, 0);
    assert.strictEqual(due.reason, 'nothing_owed');
    assert.strictEqual(plan.dueDates.length, 6, 'the schedule is not consumed or rewritten');
});

// ── 9. the SQL and the JS must compute the same balance ───────────────────
//
// There are two implementations of this number again — BillingCore.balance() in
// the browser and family_ledger_balance() in the database — and that is
// unavoidable, because the parent's balance is a security boundary and has to be
// computed server-side. The original defect this whole redesign addresses began
// as exactly this kind of drift, so pin it: the SQL's signs are transliterated
// here from the migration text and must match the JS on the same ledger.

const fs = require('node:fs');
const path = require('node:path');

/** The signs, read out of migration 171 rather than assumed. */
function sqlSigns() {
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '171_posted_ledger.sql'), 'utf8');
    const fn = sql.slice(sql.indexOf('FUNCTION public.family_ledger_balance'),
                         sql.indexOf('REVOKE ALL ON FUNCTION public.family_ledger_balance'));
    const signs = {};
    for (const m of fn.matchAll(/WHEN '(\w+)'\s+THEN\s+(-?)COALESCE/g)) {
        signs[m[1]] = m[2] === '-' ? -1 : 1;
    }
    return signs;
}

/** family_ledger_balance(), evaluated in JS from those signs. */
function sqlBalance(account, signs) {
    let t = 0;
    for (const e of B.entriesOf(account)) {
        const s = signs[e.kind];
        if (s) t += s * Number(e.amount);
    }
    return Math.round(t * 100) / 100;
}

test('migration 171 gets every sign right, and misses none', () => {
    const signs = sqlSigns();
    assert.deepStrictEqual(signs,
        { charge: 1, refund: 1, credit: -1, payment: -1 },
        'the SQL signs disagree with the ledger model');
    // A kind the SQL does not know would silently contribute nothing.
    assert.deepStrictEqual(Object.keys(signs).sort(), B.KINDS.slice().sort(),
        'the SQL does not handle every entry kind');
});

test('SQL and JS agree across a messy real-world ledger', () => {
    const signs = sqlSigns();
    const a = enrolled(3000, { discount: 250 });
    B.postTuition(a, { enrollmentId: 'e2', camperId: 102, tuition: 3000 });
    B.post(a, { kind: 'charge', amount: 150, reason: 'fee' });
    B.post(a, { kind: 'charge', amount: 42.5, reason: 'canteen' });
    B.post(a, { kind: 'payment', amount: 1000, reason: 'zelle' });
    B.post(a, { kind: 'payment', amount: 33.33, reason: 'cash' });
    B.post(a, { kind: 'refund', amount: 20, reason: 'card' });
    B.post(a, { kind: 'credit', amount: 75, reason: 'goodwill' });
    B.creditWithdrawal(a, { enrollmentId: 'e1', policy: { percent: 50 } });
    B.reverse(a, B.entriesOf(a).find(e => e.reason === 'canteen').id, {});

    assert.strictEqual(sqlBalance(a, signs), B.balance(a),
        'the parent and the camp would be shown different numbers');
});

test('SQL and JS agree on an empty and a fully-settled ledger', () => {
    const signs = sqlSigns();
    const empty = acct();
    assert.strictEqual(sqlBalance(empty, signs), B.balance(empty));

    const settled = enrolled(3000);
    B.post(settled, { kind: 'payment', amount: 3000, reason: 'card' });
    assert.strictEqual(sqlBalance(settled, signs), B.balance(settled));
    assert.strictEqual(B.balance(settled), 0);
});

test('the conversion never touches a family that already has a ledger', () => {
    // Running it twice must not double every charge, and it is the kind of thing
    // an office WILL run twice.
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '171_posted_ledger.sql'), 'utf8');
    assert.match(sql, /IF public\.family_has_ledger\(v_fam\) THEN CONTINUE; END IF;/,
        'the conversion is no longer idempotent — it would double-bill every family');
    // And the dry run must not write.
    assert.match(sql, /IF NOT p_dry_run AND v_n_fams > 0 THEN/,
        'the dry run no longer guards the write');
    assert.match(sql, /p_dry_run boolean DEFAULT true/,
        'the conversion must default to a dry run');
});

test('the conversion rebuilds money from payments, never from plan statuses', () => {
    // The plan statuses are known-corrupted by D1; the payment ledger is not.
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '171_posted_ledger.sql'), 'utf8');
    const conv = sql.slice(sql.indexOf('FUNCTION public.convert_family_ledgers'),
                           sql.indexOf('FUNCTION public.report_plan_undercollection'));
    assert.ok(!/installments/.test(conv),
        'the conversion reads instalment data — it must rebuild from payments only');
    assert.ok(/finance.*payments|v_pays/.test(conv), 'it no longer reads payments');
    assert.ok(/bank_deposits/.test(conv),
        'Zelle/ACH deposits live outside the blob and would be lost');
});

test('a negative stored payment converts to a refund, not a negative payment', () => {
    // Refunds are stored today as negative payments. Rule 3 says the sign lives
    // in the kind, so the conversion has to flip them rather than carry a
    // negative amount into the new ledger.
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '171_posted_ledger.sql'), 'utf8');
    assert.match(sql, /WHEN \(e->>'amount'\)::numeric < 0 THEN 'refund'/,
        'a stored negative payment would become a negative-amount payment entry');
    assert.match(sql, /ABS\(\(e->>'amount'\)::numeric\)/,
        'the amount is not made positive');
});

// ── 10. the parent's side, and the recursion guard ────────────────────────

test('173 wraps get_my_balance instead of duplicating it', () => {
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '173_parent_balance_from_ledger.sql'), 'utf8');
    assert.match(sql, /ALTER FUNCTION public\.get_my_balance\(uuid\) RENAME TO get_my_balance_derived;/,
        '166’s function is no longer moved aside — 173 must not duplicate its 250 lines');
    assert.match(sql, /v_base := public\.get_my_balance_derived\(p_camp_id\);/,
        'the wrapper no longer calls the derived function');
});

test('the rename is guarded against making the wrapper call itself', () => {
    // Re-running 173 must not rename the WRAPPER to get_my_balance_derived and
    // then create a wrapper that calls itself — that is infinite recursion in
    // the RPC the parent portal depends on.
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '173_parent_balance_from_ledger.sql'), 'utf8');
    const guard = sql.slice(sql.indexOf('DO $rename$'), sql.indexOf('$rename$;'));
    assert.match(guard, /LEDGER_WRAPPER_V173/, 'the guard no longer checks for the marker');
    assert.ok(guard.indexOf('LEDGER_WRAPPER_V173') < guard.indexOf('ALTER FUNCTION'),
        'the marker check must come BEFORE the rename');
    assert.match(guard, /RETURN;/, 'the guard does not bail out when already wrapped');
    // And the marker must actually be present in the wrapper body, or the guard
    // can never fire.
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.get_my_balance('));
    assert.match(body, /LEDGER_WRAPPER_V173/,
        'the wrapper carries no marker — the guard would never match and a ' +
        're-run would build a self-calling function');
    // The bundle's verification row counts pg_proc rows whose prosrc carries the
    // marker and expects exactly ONE. Only the wrapper is a pg_proc row — a DO
    // block is not — so the invariant that matters is that the marker lives in
    // the guard and in the wrapper, and in no OTHER function body.
    // Each body is bounded at its OWN `$$;` terminator, not at the next CREATE —
    // the guarded DO block sits between two functions, and slicing to the next
    // CREATE swept its marker into the preceding function.
    const fnStarts = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)];
    const carriers = fnStarts.filter((m) => {
        const end = sql.indexOf('\n$$;', m.index);
        return sql.slice(m.index, end < 0 ? sql.length : end)
                  .includes('LEDGER_WRAPPER_V173');
    }).map(m => m[1]);
    assert.deepStrictEqual(carriers, ['get_my_balance'],
        'exactly one function body may carry the marker, or the bundle check breaks');
});

test('a partly-converted household falls back rather than mixing the two', () => {
    // Some families posted and some derived would total to neither number.
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '173_parent_balance_from_ledger.sql'), 'utf8');
    assert.match(sql, /IF NOT v_allHave THEN[\s\S]{0,200}RETURN v_base/,
        'the wrapper no longer bails out when a family is unconverted');
    assert.match(sql, /v_allHave := false;\s*EXIT;/,
        'it no longer stops at the first unconverted family');
});

test('the parent summary keeps the shape the portal already renders', () => {
    // billed − paid − credits is what get_my_balance has always returned and
    // what the portal renders; changing the shape here would need a client change.
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '173_parent_balance_from_ledger.sql'), 'utf8');
    const fn = sql.slice(sql.indexOf('FUNCTION public.family_ledger_summary'),
                         sql.indexOf('REVOKE ALL ON FUNCTION public.family_ledger_summary'));
    for (const k of ['billed', 'paid', 'credits']) {
        assert.ok(fn.includes("'" + k + "',"), 'the summary no longer returns ' + k);
    }
    // A refund must REDUCE what counts as paid, or a refunded family reads as
    // having paid money the camp gave back.
    assert.match(fn, /WHEN kind = 'refund'\s+THEN -amount/,
        'a refund no longer reduces `paid`');
    // And deposits must not be re-added: the conversion already posts them.
    assert.match(sql, /does NOT\s*--? ?re-add bank deposits|NOT re-add bank deposits/,
        'the double-counting note is gone — check deposits are not added twice');
});
