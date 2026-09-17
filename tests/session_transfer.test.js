// node --test tests/session_transfer.test.js
//
// A camper is on 1st Half and the family asks to switch to 2nd Half. Today there is
// no operation for that: an office credits one charge, adds another by hand, and the
// ledger holds two unrelated-looking entries that happen to cancel. Nobody reading
// it in February can tell it was a transfer, and if the halves are priced
// differently the difference is somebody's arithmetic.
//
// The shape is forced by two things this codebase will not bend on: the posted
// ledger is IMMUTABLE, and postTuition is keyed on the enrollment id and refuses a
// second post. So a transfer credits what stands, retires the enrollment, and makes
// a new one — never an edit.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const T = require(path.join(__dirname, '..', 'campistry_session_transfer.js'));

const SESSIONS = [
    { name: '1st Half', tuition: 2000, startDate: '2026-06-28', endDate: '2026-07-24' },
    { name: '2nd Half', tuition: 2400, startDate: '2026-07-26', endDate: '2026-08-21' },
    { name: 'Unpriced', tuition: 0 }
];
const ENR = { id: 'e1', camperName: 'Eli Stein', session: '1st Half', status: 'enrolled' };
/** A posted tuition charge, the way BillingCore writes one. */
const posted = (eid, amount, kind) =>
    ({ kind: kind || 'charge', reason: 'tuition', amount: amount, source: { enrollmentId: eid } });

// ── what is actually standing ──────────────────────────────────────────────

test('standing is charges less credits, for that enrollment only', () => {
    const entries = [
        posted('e1', 2000), posted('e1', 500, 'credit'),
        posted('e2', 9999)                                  // another camper entirely
    ];
    assert.strictEqual(T.standingFor(entries, 'e1'), 1500);
    assert.strictEqual(T.standingFor(entries, 'e2'), 9999);
    assert.strictEqual(T.standingFor(entries, 'nope'), 0);
});

test('standing reads the LEDGER, not the session price', () => {
    // A scholarship already covered half. Crediting the list price on transfer would
    // hand the family the difference as a windfall.
    const entries = [posted('e1', 2000), posted('e1', 1000, 'credit')];
    const p = T.plan({ enrollment: ENR, toSession: '2nd Half', sessions: SESSIONS, entries });
    const credit = p.steps.filter(s => s.do === 'credit')[0];
    assert.strictEqual(credit.amount, 1000, 'only what is still owed comes back');
});

test('entries with no source are ignored, not counted', () => {
    assert.strictEqual(T.standingFor([{ kind: 'charge', amount: 500 }, null, 'x'], 'e1'), 0);
});

// ── the shape of a transfer ────────────────────────────────────────────────

test('a transfer credits, retires and re-enrolls — in that order', () => {
    const p = T.plan({ enrollment: ENR, toSession: '2nd Half', sessions: SESSIONS,
                       entries: [posted('e1', 2000)] });
    assert.strictEqual(p.ok, true);
    assert.deepStrictEqual(p.steps.map(s => s.do), ['credit', 'retire', 'enroll']);
    assert.strictEqual(p.steps[0].amount, 2000);
    assert.strictEqual(p.steps[1].status, 'transferred');
    assert.strictEqual(p.steps[2].session, '2nd Half');
    assert.strictEqual(p.steps[2].tuition, 2400);
});

test('both ends are linked, so the pair reads as one event', () => {
    const p = T.plan({ enrollment: ENR, toSession: '2nd Half', sessions: SESSIONS,
                       entries: [posted('e1', 2000)] });
    assert.strictEqual(p.steps[1].to, '2nd Half', 'the old one says where they went');
    assert.strictEqual(p.steps[2].from, '1st Half', 'the new one says where they came from');
    assert.strictEqual(p.steps[2].fromEnrollmentId, 'e1');
});

test('the price difference needs no special handling', () => {
    // Up: 2000 credited, 2400 charged, 400 more owing.
    const up = T.plan({ enrollment: ENR, toSession: '2nd Half', sessions: SESSIONS,
                        entries: [posted('e1', 2000)] });
    assert.strictEqual(up.net, 400);

    // Down: the same arithmetic in reverse, and it must WARN, because a credit
    // balance is not refunded by itself.
    const down = T.plan({
        enrollment: { id: 'e9', camperName: 'Mia', session: '2nd Half', status: 'enrolled' },
        toSession: '1st Half', sessions: SESSIONS, entries: [posted('e9', 2400)]
    });
    assert.strictEqual(down.net, -400);
    assert.match(down.warnings.join(' '), /left with a credit/);
    assert.match(down.warnings.join(' '), /not refunded automatically/);
});

test('nothing posted yet means nothing to credit', () => {
    // Crediting anyway would invent money the family never owed.
    const p = T.plan({ enrollment: ENR, toSession: '2nd Half', sessions: SESSIONS, entries: [] });
    assert.deepStrictEqual(p.steps.map(s => s.do), ['retire', 'enroll']);
    assert.strictEqual(p.net, 2400, 'they simply owe the new session');
});

test('an enrollment already in credit is flagged, not silently topped up', () => {
    const p = T.plan({ enrollment: ENR, toSession: '2nd Half', sessions: SESSIONS,
                       entries: [posted('e1', 2000), posted('e1', 2500, 'credit')] });
    assert.ok(!p.steps.some(s => s.do === 'credit'), 'nothing to reverse');
    assert.match(p.warnings.join(' '), /already carrying a 500\.00 credit/);
});

// ── the discount travels ───────────────────────────────────────────────────

test('a percentage discount re-applies against the NEW price', () => {
    // 10% of 2400, not 10% of 2000. The discount is a fact about the family.
    const p = T.plan({
        enrollment: Object.assign({}, ENR, { discount: { pct: 10 } }),
        toSession: '2nd Half', sessions: SESSIONS, entries: [posted('e1', 1800)]
    });
    assert.strictEqual(p.discount, 240);
    assert.strictEqual(p.net, (2400 - 240) - 1800);
});

test('a fixed discount carries as agreed', () => {
    const p = T.plan({
        enrollment: Object.assign({}, ENR, { discount: { amt: 300 } }),
        toSession: '2nd Half', sessions: SESSIONS, entries: [posted('e1', 1700)]
    });
    assert.strictEqual(p.discount, 300);
});

test('a discount can never exceed the new tuition', () => {
    const p = T.plan({
        enrollment: Object.assign({}, ENR, { discount: { amt: 99999 } }),
        toSession: '2nd Half', sessions: SESSIONS, entries: []
    });
    assert.strictEqual(p.discount, 2400, 'discounted to free, never past it');
    assert.strictEqual(p.net, 0);
});

// ── the refusals ───────────────────────────────────────────────────────────

test('every refusal returns NO steps', () => {
    // A caller that ignores `ok` must not be able to half-transfer somebody.
    const bad = [
        [{ toSession: '2nd Half', sessions: SESSIONS }, 'no_enrollment'],
        [{ enrollment: ENR, sessions: SESSIONS }, 'no_target'],
        [{ enrollment: ENR, toSession: '1st Half', sessions: SESSIONS }, 'same_session'],
        [{ enrollment: Object.assign({}, ENR, { status: 'withdrawn' }),
           toSession: '2nd Half', sessions: SESSIONS }, 'not_transferable'],
        [{ enrollment: ENR, toSession: 'Ghost', sessions: SESSIONS }, 'no_such_session'],
        [{ enrollment: ENR, toSession: 'Unpriced', sessions: SESSIONS }, 'target_unpriced']
    ];
    bad.forEach(([arg, reason]) => {
        const p = T.plan(arg);
        assert.strictEqual(p.ok, false, reason);
        assert.strictEqual(p.reason, reason);
        assert.deepStrictEqual(p.steps, [], reason + ' must produce no steps');
        assert.ok(p.message.length > 0, reason + ' must say why');
    });
});

test('an unpriced target is refused rather than billing nothing', () => {
    const p = T.plan({ enrollment: ENR, toSession: 'Unpriced', sessions: SESSIONS, entries: [] });
    assert.match(p.message, /no tuition set/);
    assert.match(p.message, /Set its price first/);
});

test('the same-session refusal names the camper when it can', () => {
    assert.match(T.plan({ enrollment: ENR, toSession: '1st Half', sessions: SESSIONS }).message,
        /Eli Stein is already on 1st Half/);
    assert.match(T.plan({ enrollment: { id: 'x', session: 'A', status: 'enrolled' },
                          toSession: 'A', sessions: SESSIONS }).message,
        /already on that session/);
});

test('plan() never throws, whatever it is handed', () => {
    [undefined, null, {}, { enrollment: 'x' }, { enrollment: {}, toSession: 5 },
     { enrollment: ENR, toSession: '2nd Half', sessions: 'nope', entries: 'nope' }
    ].forEach(arg => {
        const p = T.plan(arg);
        assert.strictEqual(typeof p.ok, 'boolean');
        assert.ok(Array.isArray(p.steps));
    });
});

// ── the sentence the office reads ──────────────────────────────────────────

test('describe states both sides and the resulting balance', () => {
    const p = T.plan({ enrollment: ENR, toSession: '2nd Half', sessions: SESSIONS,
                       entries: [posted('e1', 2000)] });
    const s = T.describe(p);
    assert.match(s, /credits 2000\.00 back against 1st Half/);
    assert.match(s, /charges 2400\.00 for 2nd Half/);
    assert.match(s, /owe 400\.00 more/);
});

test('describe says when the balance does not move, and nothing on a refusal', () => {
    const same = T.plan({
        enrollment: { id: 'e5', session: 'A', status: 'enrolled' },
        toSession: '1st Half',
        sessions: [{ name: 'A', tuition: 2000 }, { name: '1st Half', tuition: 2000 }],
        entries: [posted('e5', 2000)]
    });
    assert.match(T.describe(same), /balance does not change/);
    assert.strictEqual(T.describe(T.plan({})), '');
    assert.strictEqual(T.describe(null), '');
});
