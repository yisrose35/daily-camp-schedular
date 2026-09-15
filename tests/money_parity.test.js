// node --test tests/money_parity.test.js
//
// THE ONE INVARIANT THAT MATTERS ABOUT MONEY IN THIS APP:
//
//     what the PARENT is told they owe  ===  what the CAMP is told they owe
//
// There are two independent implementations of that number, in two languages,
// and they cannot share code — the parent's runs as SQL inside the database
// (get_my_balance, SECURITY DEFINER, because it is the security boundary) and
// the camp's runs in the browser (buildFamilyLedgers in campistry_me.js). So
// the only way to keep them honest is to model both and compare them.
//
// That is what this file does. Both models below are transliterated from the
// real code — deliberately following each one's own structure, not a shared
// helper, so that they CAN disagree and the test can catch it. A single shared
// implementation here would prove nothing.
//
// ── the three defects this pins ────────────────────────────────────────────
//
//   1. ZELLE / ACH invisible to parents. Bank deposits live in `bank_deposits`
//      rather than the campistryMe blob (migration 145: the blob has one
//      writer and a webhook appending to it gets clobbered by a stale tab).
//      buildFamilyLedgers unions them at read time; get_my_balance did not —
//      so a family that paid by Zelle was settled on the camp's screen and
//      still owing on the parent's, permanently.
//
//   2. A PARENT WITH TWO FAMILY RECORDS saw only one. Migration 152 restricted
//      the balance to the first family to fix a worse bug (summing all of them
//      while reporting one key), which left a split household under-billed.
//
//   3. A DISCOUNT LARGER THAN TUITION went negative on the parent's side.
//      campistry_me.js caps it at the tuition; the SQL did not.
//
// ── the algebra, since the two sides express it differently ────────────────
//
//   camp:    (grossTuition + charges) − payments − (discount + credits)
//   parent:  (grossTuition − discount + charges) − payments − credits
//
// Both reduce to  T + C − P − D − Cr. They are the same formula arranged
// differently, which is exactly why a difference in any INPUT is invisible
// until something like this compares the outputs.

const test = require('node:test');
const assert = require('node:assert');

// ── shared helpers (inputs only — never the math) ──────────────────────────

const money = n => Math.round((Number(n) || 0) * 100) / 100;

/** Tuition for an enrollment: live session price wins when positive. */
function tuitionOf(e, sessions) {
    const s = sessions.find(x => x.name === e.session);
    const live = (s && s.tuition != null) ? Number(s.tuition) || 0 : 0;
    const snap = Number(e.sessionTuition) || 0;
    return live > 0 ? live : snap;
}

/**
 * Discount: flat PLUS percentage, capped at the tuition.
 *
 * Both sides must agree on all three parts. The 'plus' was once a 'replace'
 * (a discount carrying both silently lost the flat part), and the cap existed
 * only on the camp's side.
 */
function discountOf(e, tuition) {
    if (!e.discount) return 0;
    let d = Number(e.discount.amt) || 0;
    if (e.discount.pct > 0) d += Math.round(tuition * e.discount.pct / 100);
    if (d > tuition) d = tuition;
    return d;
}

const COLLECTED = p => p.status !== 'pending' && p.status !== 'failed';

/** A posted, attributed deposit's signed dollar amount. */
function depositAmount(d) {
    return (d.is_reversal ? -1 : 1) * money(d.amount_cents / 100);
}

// ── model A: the CAMP's side (buildFamilyLedgers) ──────────────────────────
//
// Per-family ledgers. Bills GROSS tuition and books the discount as a credit.

function campLedgers(db) {
    const ledgers = {};
    Object.keys(db.families).forEach(fk => {
        ledgers[fk] = { totalCharges: 0, totalPayments: 0, totalCredits: 0 };
    });

    // 1. tuition
    Object.entries(db.enrollments).forEach(([eid, e]) => {
        if (e.status !== 'enrolled' && e.status !== 'accepted') return;
        const fk = db.camperFamily[e.camperName];
        if (!fk || !ledgers[fk]) return;
        const t = tuitionOf(e, db.sessions);
        const d = discountOf(e, t);
        ledgers[fk].totalCharges += t;            // GROSS
        if (d > 0) ledgers[fk].totalCredits += d; // discount as a credit
    });

    // 2 + 2b. family charges and credits
    Object.entries(db.families).forEach(([fk, f]) => {
        (f.charges || []).forEach(c => { ledgers[fk].totalCharges += Number(c.amount) || 0; });
        (f.credits || []).forEach(c => { ledgers[fk].totalCredits += Number(c.amount) || 0; });
    });

    // 3. payments from the blob
    db.payments.forEach(p => {
        const fk = p.familyKey && ledgers[p.familyKey] ? p.familyKey : null;
        if (!fk) return;
        if (COLLECTED(p)) ledgers[fk].totalPayments += Number(p.amount) || 0;
    });

    // 3b. bank deposits, unioned at read time
    db.deposits.forEach(d => {
        if (d.status !== 'posted' || !d.family_key) return;
        if (!ledgers[d.family_key]) return;
        ledgers[d.family_key].totalPayments += depositAmount(d);
    });

    Object.values(ledgers).forEach(l => {
        l.balance = l.totalCharges - l.totalPayments - l.totalCredits;
    });
    return ledgers;
}

/** What the camp would say this parent's household owes, in total. */
function campBalanceForParent(db, camperNames) {
    const ledgers = campLedgers(db);
    const mine = new Set();
    Object.entries(db.families).forEach(([fk, f]) => {
        if ((f.camperIds || []).some(c => camperNames.includes(c))) mine.add(fk);
    });
    return money([...mine].reduce((s, fk) => s + ledgers[fk].balance, 0));
}

// ── model B: the PARENT's side (get_my_balance, after migration 166) ───────
//
// One number. Bills NET tuition and counts only real family credits.

function parentBalance(db, camperNames) {
    let billed = 0, paid = 0, credits = 0;
    const enrIds = [];

    // tuition
    Object.entries(db.enrollments).forEach(([eid, e]) => {
        if (!camperNames.includes(e.camperName)) return;
        if (e.status !== 'enrolled' && e.status !== 'accepted') return;
        const t = tuitionOf(e, db.sessions);
        const d = discountOf(e, t);
        billed += (t - d);                         // NET
        enrIds.push(eid);
    });

    // every family this parent belongs to
    const famKeys = [], famNames = [];
    Object.keys(db.families).sort().forEach(fk => {
        const f = db.families[fk];
        if (!(f.camperIds || []).some(c => camperNames.includes(c))) return;
        famKeys.push(fk);
        if (f.name) famNames.push(f.name);
        (f.charges || []).forEach(c => { billed += Number(c.amount) || 0; });
        (f.credits || []).forEach(c => { credits += Number(c.amount) || 0; });
    });

    // payments from the blob
    db.payments.forEach(p => {
        const matched =
            camperNames.includes(p.family || '') ||
            enrIds.includes(p.enrollmentId || '') ||
            (p.familyKey && famKeys.includes(p.familyKey)) ||
            (p.family && famNames.includes(p.family));
        if (!matched) return;
        if (COLLECTED(p)) paid += Number(p.amount) || 0;
    });

    // bank deposits — the union migration 166 adds
    db.deposits.forEach(d => {
        if (d.status !== 'posted' || !d.family_key) return;
        if (!famKeys.includes(d.family_key)) return;
        paid += depositAmount(d);
    });

    return money(billed - paid - credits);
}

// ── fixtures ───────────────────────────────────────────────────────────────

function db(over) {
    return Object.assign({
        sessions: [{ name: 'Full Summer', tuition: 3000 }],
        enrollments: {},
        families: {},
        camperFamily: {},     // camper -> famKey, as enrollCamper's camperIds would
        payments: [],
        deposits: [],
    }, over || {});
}

function oneCamper(over) {
    return db(Object.assign({
        enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer', status: 'enrolled' } },
        families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'] } },
        camperFamily: { 'Malky Stein': 'f1' },
    }, over || {}));
}

const MALKY = ['Malky Stein'];

/** The invariant. Every test ends here. */
function agree(t, d, names, expected, what) {
    const camp = campBalanceForParent(d, names);
    const parent = parentBalance(d, names);
    assert.strictEqual(parent, camp,
        `${what}: parent says ${parent}, camp says ${camp} — they must agree`);
    if (expected !== undefined) {
        assert.strictEqual(camp, expected, `${what}: expected ${expected}, got ${camp}`);
    }
}

// ── 1. the baseline ────────────────────────────────────────────────────────

test('tuition only', () => {
    agree(test, oneCamper(), MALKY, 3000, 'plain enrollment');
});

test('a live session price change re-bills both sides', () => {
    const d = oneCamper({ sessions: [{ name: 'Full Summer', tuition: 3500 }] });
    agree(test, d, MALKY, 3500, 'session reprice');
});

test('a frozen snapshot is used when the live price is gone or zero', () => {
    const d = oneCamper({
        sessions: [{ name: 'Full Summer', tuition: 0 }],
        enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer',
                             status: 'enrolled', sessionTuition: 2800 } },
    });
    agree(test, d, MALKY, 2800, 'zero live price falls back to the snapshot');
});

// ── 2. discounts ───────────────────────────────────────────────────────────

test('a flat discount is applied once, not twice', () => {
    // The camp bills gross and credits the discount; the parent bills net.
    // Subtracting it on both sides of the camp's formula understated the
    // balance by the discount — a real bug once.
    const d = oneCamper({
        enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer',
                             status: 'enrolled', discount: { amt: 500 } } },
    });
    agree(test, d, MALKY, 2500, 'flat discount');
});

test('a percentage discount is applied once', () => {
    const d = oneCamper({
        enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer',
                             status: 'enrolled', discount: { pct: 10 } } },
    });
    agree(test, d, MALKY, 2700, 'pct discount');
});

test('flat and percentage are ADDITIVE, not either/or', () => {
    // pct used to REPLACE amt, so a discount carrying both lost the flat part.
    const d = oneCamper({
        enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer',
                             status: 'enrolled', discount: { amt: 500, pct: 10 } } },
    });
    agree(test, d, MALKY, 2200, 'additive discount');   // 3000 - 500 - 300
});

test('a discount bigger than the tuition stops at free — it never goes negative', () => {
    // Defect 3: the camp capped this, the SQL did not, so the parent saw a
    // NEGATIVE charge and the camp saw zero.
    const d = oneCamper({
        enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer',
                             status: 'enrolled', discount: { amt: 5000 } } },
    });
    agree(test, d, MALKY, 0, 'over-cap discount');
});

// ── 3. payments ────────────────────────────────────────────────────────────

test('a card payment reduces the balance on both sides', () => {
    const d = oneCamper({
        payments: [{ id: 'p1', familyKey: 'f1', family: 'Stein Family',
                     amount: 1000, status: 'succeeded' }],
    });
    agree(test, d, MALKY, 2000, 'card payment');
});

test('pending and failed payments do not reduce anything', () => {
    const d = oneCamper({
        payments: [
            { id: 'p1', familyKey: 'f1', amount: 500, status: 'pending' },
            { id: 'p2', familyKey: 'f1', amount: 500, status: 'failed' },
        ],
    });
    agree(test, d, MALKY, 3000, 'uncollected payments');
});

test('a refund is a negative payment and raises the balance back', () => {
    const d = oneCamper({
        payments: [
            { id: 'p1', familyKey: 'f1', amount: 1000, status: 'succeeded' },
            { id: 'p2', familyKey: 'f1', amount: -400, status: 'succeeded', refundOf: 'p1' },
        ],
    });
    agree(test, d, MALKY, 2400, 'partial refund');
});

test('paying in full settles to exactly zero', () => {
    const d = oneCamper({
        payments: [{ id: 'p1', familyKey: 'f1', amount: 3000, status: 'succeeded' }],
    });
    agree(test, d, MALKY, 0, 'paid in full');
});

test('overpaying goes negative on both sides, not clamped on one', () => {
    const d = oneCamper({
        payments: [{ id: 'p1', familyKey: 'f1', amount: 3500, status: 'succeeded' }],
    });
    agree(test, d, MALKY, -500, 'overpayment is a credit balance');
});

// ── 4. Zelle / ACH — defect 1 ──────────────────────────────────────────────

test('A ZELLE DEPOSIT REDUCES THE PARENT BALANCE, not just the camp one', () => {
    // The headline defect. Migration 145 put deposits in their own table and
    // left a note that get_my_balance still needed the union; it never got
    // wired, so this family was settled for the camp and still owing for the
    // parent — permanently, with no way for either to see why.
    const d = oneCamper({
        deposits: [{ id: 'd1', family_key: 'f1', amount_cents: 300000,
                     is_reversal: false, status: 'posted', kind: 'zelle' }],
    });
    agree(test, d, MALKY, 0, 'zelle paid in full');
});

test('a returned / NSF deposit DEBITS — a bounced ACH must not read as paid', () => {
    const d = oneCamper({
        deposits: [
            { id: 'd1', family_key: 'f1', amount_cents: 100000, is_reversal: false,
              status: 'posted', kind: 'ach' },
            { id: 'd2', family_key: 'f1', amount_cents: 100000, is_reversal: true,
              status: 'posted', kind: 'ach' },
        ],
    });
    agree(test, d, MALKY, 3000, 'deposit then reversal nets to nothing');
});

test('an UNMATCHED deposit counts for nobody', () => {
    // No family_key yet — the office has not attributed it. Crediting it to
    // someone would be inventing a payment.
    const d = oneCamper({
        deposits: [{ id: 'd1', family_key: null, amount_cents: 300000,
                     is_reversal: false, status: 'posted', kind: 'zelle' }],
    });
    agree(test, d, MALKY, 3000, 'unmatched deposit');
});

test('a deposit that is not posted counts for nobody', () => {
    for (const status of ['unmatched', 'suggested', 'ignored', 'pending']) {
        const d = oneCamper({
            deposits: [{ id: 'd1', family_key: 'f1', amount_cents: 300000,
                         is_reversal: false, status, kind: 'zelle' }],
        });
        agree(test, d, MALKY, 3000, 'deposit with status ' + status);
    }
});

test('a deposit posted to someone ELSE never touches this parent', () => {
    const d = oneCamper({
        families: {
            f1: { name: 'Stein Family', camperIds: ['Malky Stein'] },
            f2: { name: 'Other Family', camperIds: ['Someone Else'] },
        },
        deposits: [{ id: 'd1', family_key: 'f2', amount_cents: 300000,
                     is_reversal: false, status: 'posted', kind: 'zelle' }],
    });
    agree(test, d, MALKY, 3000, 'another family’s deposit');
});

test('cents survive the cents-to-dollars conversion', () => {
    // amount_cents is an integer; the blob's amounts are dollars. A rounding
    // difference between the two sides would show up as a few cents owed
    // forever, which is the kind of thing nobody can explain to a parent.
    const d = oneCamper({
        deposits: [{ id: 'd1', family_key: 'f1', amount_cents: 123456,
                     is_reversal: false, status: 'posted', kind: 'zelle' }],
    });
    agree(test, d, MALKY, money(3000 - 1234.56), 'odd cents');
});

// ── 5. camp-side charges — the "parent sees the charge" scenario ───────────

test('a charge the camp adds shows up in the parent balance', () => {
    const d = oneCamper({
        families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'],
                          charges: [{ id: 'c1', amount: 250, category: 'Trip', date: '2026-07-01' }] } },
    });
    agree(test, d, MALKY, 3250, 'camp-added charge');
});

test('a credit the camp issues reduces the parent balance', () => {
    const d = oneCamper({
        families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'],
                          credits: [{ id: 'cr1', amount: 150, reason: 'Financial aid' }] } },
    });
    agree(test, d, MALKY, 2850, 'camp-issued credit');
});

test('charges and credits and payments all compose', () => {
    const d = oneCamper({
        families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'],
                          charges: [{ id: 'c1', amount: 250 }],
                          credits: [{ id: 'cr1', amount: 100 }] } },
        payments: [{ id: 'p1', familyKey: 'f1', amount: 1000, status: 'succeeded' }],
        deposits: [{ id: 'd1', family_key: 'f1', amount_cents: 50000,
                     is_reversal: false, status: 'posted', kind: 'zelle' }],
    });
    // 3000 + 250 - 100 - 1000 - 500
    agree(test, d, MALKY, 1650, 'everything at once');
});

// ── 6. multi-family households — defect 2 ──────────────────────────────────

test('A PARENT WITH TWO FAMILY RECORDS owes the sum of both', () => {
    // Defect 2: restricted to the first family, the parent saw half their
    // charges. Under-billing, but still the wrong number.
    const d = db({
        sessions: [{ name: 'Full Summer', tuition: 3000 }],
        enrollments: {
            e1: { camperName: 'Malky Stein', session: 'Full Summer', status: 'enrolled' },
            e2: { camperName: 'Yossi Stein', session: 'Full Summer', status: 'enrolled' },
        },
        families: {
            f1: { name: 'Stein Family', camperIds: ['Malky Stein'],
                  charges: [{ id: 'c1', amount: 100 }] },
            f2: { name: 'Stein Family (2)', camperIds: ['Yossi Stein'],
                  charges: [{ id: 'c2', amount: 200 }] },
        },
        camperFamily: { 'Malky Stein': 'f1', 'Yossi Stein': 'f2' },
    });
    agree(test, d, ['Malky Stein', 'Yossi Stein'], 6300, 'split household');
});

test('a payment on the second family record still counts', () => {
    const d = db({
        sessions: [{ name: 'Full Summer', tuition: 1000 }],
        enrollments: {
            e1: { camperName: 'Malky Stein', session: 'Full Summer', status: 'enrolled' },
            e2: { camperName: 'Yossi Stein', session: 'Full Summer', status: 'enrolled' },
        },
        families: {
            f1: { name: 'Stein A', camperIds: ['Malky Stein'] },
            f2: { name: 'Stein B', camperIds: ['Yossi Stein'] },
        },
        camperFamily: { 'Malky Stein': 'f1', 'Yossi Stein': 'f2' },
        payments: [{ id: 'p1', familyKey: 'f2', amount: 700, status: 'succeeded' }],
        deposits: [{ id: 'd1', family_key: 'f2', amount_cents: 30000,
                     is_reversal: false, status: 'posted', kind: 'zelle' }],
    });
    agree(test, d, ['Malky Stein', 'Yossi Stein'], 1000, 'payment on the 2nd record');
});

// ── 7. statuses and edges ──────────────────────────────────────────────────

test('only enrolled and accepted are billed', () => {
    for (const status of ['applied', 'declined', 'waitlist', 'withdrawn', 'cancelled']) {
        const d = oneCamper({
            enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer', status } },
        });
        agree(test, d, MALKY, 0, 'status ' + status + ' must not be billed');
    }
    for (const status of ['enrolled', 'accepted']) {
        const d = oneCamper({
            enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer', status } },
        });
        agree(test, d, MALKY, 3000, 'status ' + status + ' must be billed');
    }
});

test('a sibling not on this parent’s invite is not billed to them', () => {
    // camper_names on the invite is the boundary. A camper the parent has no
    // claim to must not appear on their balance.
    const d = db({
        sessions: [{ name: 'Full Summer', tuition: 1000 }],
        enrollments: {
            e1: { camperName: 'Malky Stein', session: 'Full Summer', status: 'enrolled' },
            e2: { camperName: 'Not Mine', session: 'Full Summer', status: 'enrolled' },
        },
        families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'] },
                    f2: { name: 'Other', camperIds: ['Not Mine'] } },
        camperFamily: { 'Malky Stein': 'f1', 'Not Mine': 'f2' },
    });
    assert.strictEqual(parentBalance(d, MALKY), 1000);
});

test('a family with nothing at all is zero, not NaN', () => {
    const d = db({ families: { f1: { name: 'Empty', camperIds: ['Malky Stein'] } },
                   camperFamily: { 'Malky Stein': 'f1' } });
    agree(test, d, MALKY, 0, 'empty family');
    assert.ok(!Number.isNaN(parentBalance(d, MALKY)));
});

test('missing and malformed amounts read as zero, never NaN', () => {
    const d = oneCamper({
        families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'],
                          charges: [{ id: 'c1' }, { id: 'c2', amount: null },
                                    { id: 'c3', amount: 'junk' }] } },
        payments: [{ id: 'p1', familyKey: 'f1', status: 'succeeded' }],
    });
    agree(test, d, MALKY, 3000, 'malformed amounts');
    assert.ok(!Number.isNaN(parentBalance(d, MALKY)));
});

// ── 8. the algebra itself ──────────────────────────────────────────────────

test('the two formulas are algebraically the same, on random cases', () => {
    // The two sides arrange the same terms differently — the camp bills gross
    // and credits the discount, the parent bills net. This is the property that
    // makes that safe, checked over a spread of inputs rather than one case.
    let seed = 12345;
    const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 300; i++) {
        const tuition = rnd(6000);
        const d = oneCamper({
            sessions: [{ name: 'Full Summer', tuition }],
            enrollments: { e1: { camperName: 'Malky Stein', session: 'Full Summer',
                                 status: 'enrolled',
                                 discount: { amt: rnd(2000), pct: rnd(120) } } },
            families: { f1: { name: 'Stein Family', camperIds: ['Malky Stein'],
                              charges: [{ id: 'c1', amount: rnd(900) }],
                              credits: [{ id: 'cr1', amount: rnd(400) }] } },
            payments: [{ id: 'p1', familyKey: 'f1', amount: rnd(3000), status: 'succeeded' },
                       { id: 'p2', familyKey: 'f1', amount: -rnd(500), status: 'succeeded' },
                       { id: 'p3', familyKey: 'f1', amount: rnd(900), status: 'pending' }],
            deposits: [{ id: 'd1', family_key: 'f1', amount_cents: rnd(400000),
                         is_reversal: rnd(4) === 0, status: 'posted', kind: 'zelle' }],
        });
        const camp = campBalanceForParent(d, MALKY);
        const parent = parentBalance(d, MALKY);
        assert.strictEqual(parent, camp,
            `case ${i} (tuition ${tuition}): parent ${parent} vs camp ${camp}`);
    }
});

// ── 9. the migration really contains the fixes ─────────────────────────────

test('migration 166 unions bank_deposits into the parent balance', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '166_balance_parity.sql'), 'utf8');
    const fn = sql.slice(sql.indexOf('FUNCTION public.get_my_balance'));
    assert.ok(fn.includes('FROM bank_deposits'), 'the deposit union is missing');
    assert.ok(fn.includes("status = 'posted'"), 'unposted deposits would be counted');
    assert.ok(fn.includes('family_key IS NOT NULL'), 'unmatched deposits would be counted');
    assert.ok(fn.includes('is_reversal'), 'a returned deposit would credit instead of debit');
    assert.ok(/amount_cents::numeric \/ 100/.test(fn), 'cents are not converted to dollars');
    assert.ok(fn.includes('v_famKeys'), 'deposits are not scoped to the caller’s families');
});

test('migration 166 sums every family and caps the discount', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'migrations', '166_balance_parity.sql'), 'utf8');
    assert.ok(/IF v_disc > v_tuition THEN v_disc := v_tuition/.test(sql),
        'the discount cap is missing — a big discount goes negative for parents');
    // The 152 behaviour was a bare CONTINUE that skipped every family after the
    // first. If that comes back, a split household is under-billed again.
    assert.ok(sql.includes('v_famKeys := v_famKeys || famRec.key'),
        'families are not accumulated');
    assert.ok(!/ELSE\s+CONTINUE;\s+END IF;/.test(sql),
        'the single-family restriction is back — split households lose charges');
});
