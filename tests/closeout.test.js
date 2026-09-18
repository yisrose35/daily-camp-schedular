// node --test tests/closeout.test.js
//
// A season ends and two different pots still hold money: a FAMILY credit balance,
// and a CAMPER's unspent canteen money. Neither had an ending — the balance sat on
// the books into next summer where it blocked re-enrolment, and the canteen money
// stayed put until a parent noticed and asked.
//
// The two pots are separate on purpose (tuition is the family's, spending money is
// the child's), so a camp may answer them differently and this must let it.
//
// The one disposition with a ceiling that is not the amount itself is refund_card:
// you cannot send back more than a card paid, or refund after the window closed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'campistry_closeout.js'));

// ── the policy ─────────────────────────────────────────────────────────────

test('the defaults cost nobody anything', () => {
    const p = C.normalize({});
    assert.strictEqual(p.family, 'bill', 'credit stays as credit unless told otherwise');
    assert.strictEqual(p.canteen, 'roll_forward');
    assert.strictEqual(p.notify, true, 'the family is told by default');
});

test('below the minimum, money does NOT default to the camp keeping it', () => {
    // A camp keeping small change by default reads badly however it was meant.
    assert.strictEqual(C.normalize({}).belowMinimum, 'bill');
    assert.notStrictEqual(C.normalize({}).belowMinimum, 'donate');
});

test('a nonsense disposition falls back rather than being stored', () => {
    const p = C.normalize({ family: 'steal_it', canteen: null, minToReturn: -5 });
    assert.strictEqual(p.family, 'bill');
    assert.strictEqual(p.canteen, 'roll_forward');
    assert.strictEqual(p.minToReturn, 0, 'a negative minimum is no minimum');
});

test('every option a camp is offered is a real one', () => {
    const ids = C.OPTIONS.map(o => o.id);
    ['bill', 'refund_card', 'cash', 'check', 'roll_forward', 'donate', 'hold']
        .forEach(id => assert.ok(ids.includes(id), id + ' must be offered'));
    C.OPTIONS.forEach(o => {
        assert.ok(o.label && o.blurb, o.id + ' needs a label and an explanation');
        assert.strictEqual(C.isOption(o.id), true);
    });
    assert.strictEqual(C.isOption('nope'), false);
});

test('only the three that move money out are marked as paying out', () => {
    ['refund_card', 'cash', 'check'].forEach(id =>
        assert.ok(C.PAYS_OUT[id], id + ' pays out'));
    ['bill', 'roll_forward', 'donate', 'hold'].forEach(id =>
        assert.ok(!C.PAYS_OUT[id], id + ' must NOT count as paying out'));
});

// ── one pot at a time ──────────────────────────────────────────────────────

test('nothing to close out produces no steps', () => {
    [0, -5, null, undefined, 'x'].forEach(amt => {
        const p = C.planPot({ amount: amt, disposition: 'cash' });
        assert.deepStrictEqual(p.steps, [], String(amt));
    });
});

test('a straightforward disposition is applied as asked', () => {
    ['bill', 'cash', 'check', 'roll_forward', 'donate', 'hold'].forEach(id => {
        const p = C.planPot({ amount: 40, disposition: id, policy: { minToReturn: 0 } });
        assert.strictEqual(p.steps.length, 1, id);
        assert.strictEqual(p.steps[0].do, id);
        assert.strictEqual(p.steps[0].amount, 40);
    });
});

test('a card refund is capped by what the card can take back', () => {
    const p = C.planPot({ amount: 40, disposition: 'refund_card', refundableToCard: 12,
                          policy: { minToReturn: 0, family: 'bill' } });
    const card = p.steps.filter(s => s.do === 'refund_card')[0];
    assert.strictEqual(card.amount, 12);
    // And the rest is NAMED, not silently dropped or silently refunded anyway.
    const rest = p.steps.filter(s => s.via === 'card_limit')[0];
    assert.strictEqual(rest.amount, 28);
    assert.strictEqual(rest.do, 'bill');
    assert.match(p.warnings.join(' '), /Only 12\.00 of 40\.00 can go back to a card/);
    assert.match(p.warnings.join(' '), /remaining 28\.00 is set to/);
});

test('the pot always adds up, whatever the card can take', () => {
    [0, 1, 12, 39.99, 40, 100].forEach(canCard => {
        const p = C.planPot({ amount: 40, disposition: 'refund_card',
                              refundableToCard: canCard, policy: { minToReturn: 0 } });
        const sum = p.steps.reduce((n, s) => n + s.amount, 0);
        assert.strictEqual(Math.round(sum * 100) / 100, 40,
            'canCard=' + canCard + ' summed to ' + sum);
    });
});

test('nothing refundable to a card means no card step at all', () => {
    const p = C.planPot({ amount: 40, disposition: 'refund_card', refundableToCard: 0,
                          policy: { minToReturn: 0 } });
    assert.ok(!p.steps.some(s => s.do === 'refund_card'),
        'a zero refund must not be issued as a step');
    assert.strictEqual(p.steps[0].amount, 40);
});

test('a card refund can never regress into itself', () => {
    // The fallback for the unrefundable part must not be refund_card again.
    const p = C.planPot({ amount: 40, disposition: 'refund_card', refundableToCard: 5,
                          policy: { minToReturn: 0, family: 'refund_card' } });
    const rest = p.steps.filter(s => s.via === 'card_limit')[0];
    assert.notStrictEqual(rest.do, 'refund_card');
    assert.strictEqual(rest.do, 'bill');
});

// ── the minimum ────────────────────────────────────────────────────────────

test('too small to post a cheque for goes to the fallback instead', () => {
    const p = C.planPot({ amount: 0.4, disposition: 'check',
                          policy: { minToReturn: 1, belowMinimum: 'donate' } });
    assert.strictEqual(p.steps[0].do, 'donate');
    assert.strictEqual(p.steps[0].via, 'below_minimum');
    assert.match(p.steps[0].note, /under the 1\.00 minimum/);
});

test('the minimum applies ONLY to money leaving the camp', () => {
    // Leaving 40 cents as credit costs nothing, so there is no reason to divert it.
    ['bill', 'roll_forward', 'hold', 'donate'].forEach(id => {
        const p = C.planPot({ amount: 0.4, disposition: id, policy: { minToReturn: 5 } });
        assert.strictEqual(p.steps[0].do, id, id + ' must not be diverted by the minimum');
        assert.strictEqual(p.steps[0].via, 'chosen');
    });
});

// ── a whole family ─────────────────────────────────────────────────────────

const FAMILY = {
    familyCredit: 40, refundableToCard: 40,
    campers: [{ name: 'Eli', canteen: 18 }, { name: 'Mia', canteen: 6 }],
    policy: { family: 'refund_card', canteen: 'roll_forward', minToReturn: 0 }
};

test('the two pots are answered separately, which is the whole point', () => {
    const p = C.plan(FAMILY);
    assert.strictEqual(p.total, 64, '40 + 18 + 6');
    const fam = p.steps.filter(s => s.kind === 'family');
    const can = p.steps.filter(s => s.kind === 'canteen');
    assert.strictEqual(fam[0].do, 'refund_card', "the family's overpayment goes back");
    assert.ok(can.every(s => s.do === 'roll_forward'), "the children's money carries over");
    assert.strictEqual(can.length, 2);
    assert.strictEqual(can[0].camper, 'Eli');
});

test('the camp is told what it is paying out and what it is keeping', () => {
    const p = C.plan(FAMILY);
    assert.strictEqual(p.paidOut, 40, 'only the card refund leaves the camp');
    assert.strictEqual(p.kept, 0);

    const donating = C.plan(Object.assign({}, FAMILY, {
        policy: { family: 'donate', canteen: 'donate', minToReturn: 0 } }));
    assert.strictEqual(donating.paidOut, 0);
    assert.strictEqual(donating.kept, 64);
});

test('a single camper can be handled differently from the policy', () => {
    // A camp sets a policy and then a family asks for something else, which is the
    // normal way this goes.
    const p = C.plan(Object.assign({}, FAMILY, {
        campers: [{ name: 'Eli', canteen: 18, disposition: 'cash' },
                  { name: 'Mia', canteen: 6 }]
    }));
    const eli = p.steps.filter(s => s.camper === 'Eli')[0];
    const mia = p.steps.filter(s => s.camper === 'Mia')[0];
    assert.strictEqual(eli.do, 'cash');
    assert.strictEqual(mia.do, 'roll_forward');
});

test('campers with nothing left are left out entirely', () => {
    const p = C.plan({ familyCredit: 0, campers: [{ name: 'Eli', canteen: 0 },
                                                  { name: 'Mia', canteen: 5 }],
                       policy: { minToReturn: 0 } });
    assert.strictEqual(p.steps.length, 1);
    assert.strictEqual(p.steps[0].camper, 'Mia');
    assert.strictEqual(p.total, 5);
    // And left out of `pots` too, not merely out of `steps`. A camper with nothing
    // left produces no steps either way, so asserting on steps alone stayed green
    // with the guard removed — and an empty row on a close-out sheet is somebody
    // asking why it is there.
    assert.strictEqual(p.pots.length, 1, 'no empty pot for a camper with nothing left');
    assert.strictEqual(p.pots[0].name, 'Mia');
});

test('the total always equals the sum of its steps', () => {
    [FAMILY,
     { familyCredit: 100, refundableToCard: 30, campers: [{ name: 'A', canteen: 7.77 }],
       policy: { family: 'refund_card', canteen: 'cash', minToReturn: 0 } },
     { familyCredit: 0.33, campers: [], policy: { family: 'check', minToReturn: 1 } }
    ].forEach((arg, i) => {
        const p = C.plan(arg);
        const sum = p.steps.reduce((n, s) => n + s.amount, 0);
        assert.strictEqual(Math.round(sum * 100) / 100, p.total, 'case ' + i);
    });
});

test('plan() never throws, whatever it is handed', () => {
    [undefined, null, {}, { campers: 'x' }, { campers: [null, 5, {}] },
     { familyCredit: 'abc', policy: 'nope' }].forEach(arg => {
        const p = C.plan(arg);
        assert.strictEqual(typeof p.total, 'number');
        assert.ok(Array.isArray(p.steps));
    });
});

test('describe says the total, what goes back, and what stays', () => {
    const s = C.describe(C.plan(FAMILY));
    assert.match(s, /64\.00 in all/);
    assert.match(s, /40\.00 paid back/);
    assert.match(s, /24\.00 left on account or carried over/);
    assert.strictEqual(C.describe(C.plan({})), '', 'nothing to say when there is nothing to do');
});
