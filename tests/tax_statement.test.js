/* Year-end tax statement — what a family PAID in a calendar year, per child.
 *
 * The cases that matter are the ones a spreadsheet gets wrong: a December
 * deposit for next summer, arrears paid the following March, a refund that
 * lands in a different year from the payment it reverses, and overnight camp.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const T = require(path.join(__dirname, '..', 'campistry_tax_statement.js'));

// Two children, two sessions, one of them overnight.
const SESSIONS = {
    'Day Camp': { overnight: false },
    'Sleepaway': { overnight: true }
};
const ENROLL = {
    e1: { camperName: 'Eli Klein', session: 'Day Camp' },
    e2: { camperName: 'Mia Klein', session: 'Day Camp' },
    e3: { camperName: 'Eli Klein', session: 'Sleepaway' }
};
function resolveCharge(entry) {
    const e = ENROLL[String(entry.ref || '').replace(/_disc$/, '')];
    if (!e) return {};
    return { camperName: e.camperName, session: e.session, overnight: !!(SESSIONS[e.session] || {}).overnight };
}
const build = (year, entries, extra) => T.build(Object.assign({ year, entries, resolveCharge }, extra || {}));

const charge = (date, amount, ref, desc) => ({ type: 'charge', category: 'Tuition', desc: desc || 'Tuition', amount, date, ref });
const pay = (date, amount, status) => ({ type: 'payment', category: 'Payment', desc: 'Payment', amount, date, status: status || '' });

// ── the ordinary case ──────────────────────────────────────────────────────

test('paid, not billed: an unpaid charge is not an expense', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), pay('2025-05-01', 800)]);
    assert.strictEqual(r.paid.net, 800);
    assert.strictEqual(r.qualifying, 800, 'the $1,200 still owed is not claimable');
});

test('a discount is not money the family spent', () => {
    const r = build(2025, [
        charge('2025-04-01', 2000, 'e1'),
        { type: 'credit', category: 'Discount', desc: '10% discount', amount: 200, date: '2025-04-01', ref: 'e1_disc' },
        pay('2025-05-01', 1800)
    ]);
    assert.strictEqual(r.qualifying, 1800);
    assert.strictEqual(r.prepaid, 0, 'the credit consumed $200 of the charge, so nothing is left over');
});

test('a credit settles the charge it was given against, so the next payment moves on', () => {
    // Eli's tuition is written off entirely (financial aid). The family's one
    // payment is therefore Mia's, not Eli's — if credits did not consume the
    // charge they were given against, the payment would land on Eli and the
    // statement would name the wrong child.
    const r = build(2025, [
        charge('2025-04-01', 2000, 'e1'),
        charge('2025-04-02', 1500, 'e2'),
        { type: 'credit', category: 'Credit', desc: 'Financial aid', amount: 2000, date: '2025-04-01', ref: 'e1_disc' },
        pay('2025-05-01', 1500)
    ]);
    const by = Object.fromEntries(r.byCamper.map(b => [b.camperName, b.qualifying]));
    assert.deepStrictEqual(by, { 'Mia Klein': 1500 });
});

test('two children get their own totals, split by which charge the money landed on', () => {
    const r = build(2025, [
        charge('2025-04-01', 2000, 'e1'),
        charge('2025-04-02', 1500, 'e2'),
        pay('2025-05-01', 3500)
    ]);
    const by = Object.fromEntries(r.byCamper.map(b => [b.camperName, b.qualifying]));
    assert.deepStrictEqual(by, { 'Eli Klein': 2000, 'Mia Klein': 1500 });
});

test('a partial payment lands on the oldest charge first, not split pro rata', () => {
    const r = build(2025, [
        charge('2025-04-01', 2000, 'e1'),
        charge('2025-04-02', 1500, 'e2'),
        pay('2025-05-01', 2000)
    ]);
    const by = Object.fromEntries(r.byCamper.map(b => [b.camperName, b.qualifying]));
    assert.deepStrictEqual(by, { 'Eli Klein': 2000 }, 'pro rata would have given Mia $857');
});

// ── the cases a spreadsheet gets wrong ─────────────────────────────────────

test('a December deposit for next summer is not deductible this year', () => {
    const r = build(2025, [pay('2025-12-15', 500)]);
    assert.strictEqual(r.paid.net, 500);
    assert.strictEqual(r.qualifying, 0);
    assert.strictEqual(r.prepaid, 500);
    assert.match(r.warnings.join(' '), /Publication 503/);
});

test('the prepaid part is only what no charge could absorb', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), pay('2025-12-15', 2500)]);
    assert.strictEqual(r.qualifying, 2000);
    assert.strictEqual(r.prepaid, 500);
});

test('arrears paid the following March count in the year they were paid', () => {
    const entries = [charge('2025-06-01', 2000, 'e1'), pay('2026-03-01', 2000)];
    assert.strictEqual(build(2025, entries).qualifying, 0, 'nothing was paid in 2025');
    const r26 = build(2026, entries);
    assert.strictEqual(r26.qualifying, 2000, 'paid in 2026, so claimable on the 2026 return');
    assert.strictEqual(r26.prepaid, 0, 'a prior-year charge absorbed it — this is not prepayment');
});

test('last year’s payments do not reappear in this year’s total', () => {
    const entries = [charge('2025-04-01', 3000, 'e1'), pay('2025-05-01', 1000), pay('2026-02-01', 2000)];
    assert.strictEqual(build(2025, entries).qualifying, 1000);
    assert.strictEqual(build(2026, entries).qualifying, 2000);
});

test('overnight camp is reported but never claimable', () => {
    const r = build(2025, [charge('2025-06-01', 3000, 'e3'), pay('2025-06-02', 3000)]);
    assert.strictEqual(r.qualifying, 0);
    assert.strictEqual(r.notQualifying, 3000);
    assert.strictEqual(r.paid.net, 3000, 'the family did pay it — it just cannot be claimed');
    assert.match(r.excluded.map(e => e.label).join(' '), /Overnight/);
});

test('a mixed family claims the day camp and not the sleepaway', () => {
    const r = build(2025, [
        charge('2025-06-01', 2000, 'e1'),   // Eli, day camp
        charge('2025-06-02', 3000, 'e3'),   // Eli, sleepaway
        pay('2025-06-03', 5000)
    ]);
    assert.strictEqual(r.qualifying, 2000);
    assert.strictEqual(r.notQualifying, 3000);
    const eli = r.byCamper.find(b => b.camperName === 'Eli Klein');
    assert.strictEqual(eli.qualifying, 2000);
    assert.strictEqual(eli.notQualifying, 3000);
});

// ── refunds ────────────────────────────────────────────────────────────────

test('a refund comes off the year’s total', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), pay('2025-05-01', 2000), pay('2025-07-01', -500)]);
    assert.strictEqual(r.paid.gross, 2000);
    assert.strictEqual(r.paid.refunds, 500);
    assert.strictEqual(r.paid.net, 1500);
    assert.strictEqual(r.qualifying, 1500);
});

test('a refund bigger than the year’s payments is reported, not clamped to zero', () => {
    const r = build(2026, [charge('2025-04-01', 2000, 'e1'), pay('2025-05-01', 2000), pay('2026-01-05', -2000)]);
    assert.strictEqual(r.paid.net, -2000);
    assert.strictEqual(r.qualifying, 0);
    assert.match(r.warnings.join(' '), /exceed payments/i);
});

// ── money that cannot be counted, and is never silently dropped ────────────

test('a pending or failed payment is not an expense, and says so', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), pay('2025-05-01', 2000, 'failed')]);
    assert.strictEqual(r.qualifying, 0);
    assert.strictEqual(r.uncollected.count, 1);
    assert.match(r.warnings.join(' '), /never cleared/);
});

test('an undated payment is counted as a problem, not as zero', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), { type: 'payment', amount: 900, date: '' }]);
    assert.strictEqual(r.undated.count, 1);
    assert.strictEqual(r.undated.amount, 900);
    assert.match(r.warnings.join(' '), /carry no date/);
});

test('an unrecognised add-on is counted in neither total and listed for the office', () => {
    const r = build(2025, [
        { type: 'charge', category: 'Add-On', desc: 'Gala ticket', amount: 180, date: '2025-04-01', ref: 'x' },
        pay('2025-05-01', 180)
    ]);
    assert.strictEqual(r.qualifying, 0);
    assert.strictEqual(r.notQualifying, 0);
    assert.strictEqual(r.needsReview, 180);
    assert.strictEqual(r.review.length, 1);
    assert.match(r.warnings.join(' '), /could not classify/);
});

test('canteen and swag are not care; extended day and the camp bus are', () => {
    const cases = [
        ['Canteen top-up', 'no'], ['Camp Shop — sweatshirt', 'no'], ['Photo package', 'no'],
        ['Extended Day', 'yes'], ['Bus — round trip', 'yes'], ['Tuition', 'yes'],
        ['Gala ticket', 'review']
    ];
    cases.forEach(([desc, want]) => {
        assert.strictEqual(T.classifyCharge({ category: 'Add-On', desc }).verdict, want, desc);
    });
});

test('overnight beats every category rule', () => {
    assert.strictEqual(T.classifyCharge({ category: 'Tuition', desc: 'Tuition' }, { overnight: true }).verdict, 'no');
});

// ── the parts a parent needs that are not money ────────────────────────────

test('a statement without an EIN is not ready to send', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), pay('2025-05-01', 2000)]);
    const bad = T.readiness(r, { name: 'Camp X', address: '1 Rd' });
    assert.strictEqual(bad.ready, false);
    assert.match(bad.missing.join(' '), /Tax ID/);
    assert.strictEqual(T.readiness(r, { name: 'Camp X', address: '1 Rd', taxId: '12-3456789' }).ready, true);
});

test('a child who turns 13 during the year is flagged, not excluded', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), pay('2025-05-01', 2000)],
        { campers: { 'Eli Klein': { dob: '2012-07-04' } } });
    const eli = r.byCamper[0];
    assert.strictEqual(eli.qualifying, 2000, 'the camp reports what was paid; the parent decides eligibility');
    assert.match(eli.notes.join(' '), /Turns 13 on 2025-07-04/);
});

test('a child already over 13 is flagged differently', () => {
    const r = build(2025, [charge('2025-04-01', 2000, 'e1'), pay('2025-05-01', 2000)],
        { campers: { 'Eli Klein': { dob: '2008-07-04' } } });
    assert.match(r.byCamper[0].notes.join(' '), /Turned 13 before 2025/);
});

test('payments that match no charge at all cannot be split per child', () => {
    const r = build(2025, [pay('2025-05-01', 900)]);
    assert.strictEqual(r.allocated, false);
    assert.match(r.warnings.join(' '), /one child at a time/);
});

test('yearsPresent lists only years with payments, newest first', () => {
    const years = T.yearsPresent([charge('2023-01-01', 10, 'e1'), pay('2024-05-01', 10), pay('2026-05-01', 10)]);
    assert.deepStrictEqual(years, [2026, 2024]);
});

test('an installment row is a schedule, not money, and never counts', () => {
    const r = build(2025, [
        charge('2025-04-01', 2000, 'e1'),
        { type: 'installment', category: 'Payment 1', amount: 1000, date: '2025-05-01', status: 'pending' },
        pay('2025-05-01', 1000)
    ]);
    assert.strictEqual(r.paid.net, 1000);
});

// ── the totals hold together ───────────────────────────────────────────────

test('qualifying + not qualifying + review + prepaid equals what was paid', () => {
    const r = build(2025, [
        charge('2025-04-01', 2000, 'e1'),
        charge('2025-04-02', 3000, 'e3'),
        { type: 'charge', category: 'Add-On', desc: 'Gala ticket', amount: 180, date: '2025-04-03', ref: 'x' },
        pay('2025-05-01', 6000)
    ]);
    const sum = r.qualifying + r.notQualifying + r.needsReview + r.prepaid;
    assert.strictEqual(Math.round(sum * 100) / 100, r.paid.net);
    assert.strictEqual(r.prepaid, 820);
});

test('the per-child totals add up to the whole', () => {
    const r = build(2025, [
        charge('2025-04-01', 2000, 'e1'), charge('2025-04-02', 1500, 'e2'),
        charge('2025-04-03', 3000, 'e3'), pay('2025-05-01', 5000), pay('2025-08-01', -500)
    ]);
    const sum = r.byCamper.reduce((a, b) => a + b.total, 0);
    assert.strictEqual(Math.round(sum * 100) / 100, r.paid.net);
});

// ── it is actually wired in ────────────────────────────────────────────────

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.html'), 'utf8');

test('the module is loaded by the page that uses it', () => {
    assert.match(HTML, /campistry_tax_statement\.js/);
});

test('Billing offers a year-end statement', () => {
    assert.match(ME, /printTaxStatement/, 'no entry point');
    assert.match(ME, /CampistryTaxStatement/, 'me.js never calls the module');
});

test('the tax statement prints the EIN whatever the on-statements toggle says', () => {
    // The toggle governs the ordinary account statement. A tax statement
    // without an EIN is useless, so it must not be silently suppressed.
    const fn = ME.slice(ME.indexOf('async function printTaxStatement'));
    const body = fn.slice(0, fn.indexOf('\nasync function ', 10));
    assert.ok(body.length > 200, 'printTaxStatement not found');
    assert.ok(!/showCampTaxId\s*&&\s*campTaxId/.test(body),
        'the tax statement must not hide the EIN behind show_tax_id_on_statements');
});

// ── TED-101: the year the care is given, not the year the charge was dated ──
const withCareYear = (e) => { const w = resolveCharge(e); return Object.assign({}, w, { careYear: '2026' }); };
const entries101 = () => [
    charge('2025-10-01', 3000, 'e1'),     // enrolled in October for summer 2026 — dated at enrolment
    pay('2025-12-15', 500),               // the December deposit
    pay('2026-04-01', 2500)
];

test('TED-101: a December deposit for next summer is prepaid in its own year, not claimable', () => {
    const r = T.build({ year: 2025, entries: entries101(), resolveCharge: withCareYear });
    assert.strictEqual(r.qualifying, 0, 'next summer\'s deposit was put on this year\'s return');
    assert.strictEqual(r.prepaid, 500);
});

test('TED-101: ...and all of it is claimable in the year the care is given', () => {
    const r = T.build({ year: 2026, entries: entries101(), resolveCharge: withCareYear });
    assert.strictEqual(r.qualifying, 3000, 'the December deposit never reached a statement');
    assert.strictEqual(r.paidEarlier, 500);
    assert.match(r.warnings.join(' '), /paid before 2026 for care given in 2026/);
});

test('TED-101: arrears still count in the year they are paid', () => {
    const late = (e) => Object.assign({}, resolveCharge(e), { careYear: '2025' });
    const r = T.build({ year: 2026, entries: [charge('2025-04-01', 2000, 'e1'), pay('2026-03-01', 2000)], resolveCharge: late });
    assert.strictEqual(r.qualifying, 2000);
    assert.strictEqual(T.build({ year: 2025, entries: [charge('2025-04-01', 2000, 'e1'), pay('2026-03-01', 2000)], resolveCharge: late }).qualifying, 0);
});

test('TED-101: Me tells the statement each charge\'s care year from the session start', () => {
    const ME = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'campistry_me.js'), 'utf8');
    assert.match(ME, /var careYear=String\(\(ses&&\(ses\.startDate\|\|ses\.start\)\)\|\|e\.sessionStart\|\|''\)\.slice\(0,4\);/);
});
