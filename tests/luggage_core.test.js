// node --test tests/luggage_core.test.js
// Validates camp luggage logistics:
//   • tag codes are DERIVED, so a reprint reproduces the same code
//   • the status machine only steps one at a time (a skipped scan must show)
//   • pricing: included bags, extras, private pick-up replacing the base,
//     round trip charging both legs
//   • manifests and the by-bunk delivery sheet, including unassigned bags
const test = require('node:test');
const assert = require('node:assert');
const L = require('../campistry_luggage_core.js');

// ── tags ────────────────────────────────────────────────────────────────────

test('tagCode is derived, so reprinting a tag gives the same code', () => {
    const args = { campName: 'Camp Ruach', bookingRef: 'EK0007', bagIndex: 2 };
    assert.strictEqual(L.tagCode(args), 'CR-EK0007-02');
    assert.strictEqual(L.tagCode(args), L.tagCode(args));
});

test('tagCode strips punctuation and pads the bag number', () => {
    assert.strictEqual(L.tagCode({ campPrefix: 'c-r!', bookingRef: 'ab#12', bagIndex: 1 }), 'CR-AB12-01');
    assert.strictEqual(L.tagCode({ campPrefix: 'CR', bookingRef: 'X1', bagIndex: 11 }), 'CR-X1-11');
});

test('tagCode falls back rather than producing a blank tag', () => {
    const t = L.tagCode({});
    assert.match(t, /^CMP-0-01$/);
});

test('bookingRef uses camper initials plus a sequence', () => {
    assert.strictEqual(L.bookingRef('Eli Katz', 7), 'EK0007');
    assert.strictEqual(L.bookingRef('Moshe Chaim Blum', 12), 'MCB0012');
});

// ── bags ────────────────────────────────────────────────────────────────────

test('buildBags expands the per-type counts into individual bags', () => {
    const bags = L.buildBags({ ref: 'EK0007', counts: { duffel: 2, trunk: 1 } }, { campPrefix: 'CR' });
    assert.strictEqual(bags.length, 3);
    assert.deepStrictEqual(bags.map(b => b.type), ['duffel', 'duffel', 'trunk']);
    assert.deepStrictEqual(bags.map(b => b.tag), ['CR-EK0007-01', 'CR-EK0007-02', 'CR-EK0007-03']);
    assert.ok(bags.every(b => b.status === 'registered'));
});

test('buildBags preserves the state of bags already in transit', () => {
    // The family adds a bag mid-season; the two already loaded must not reset.
    const booking = {
        ref: 'EK0007', counts: { duffel: 2 },
        bags: [
            { tag: 'CR-EK0007-01', type: 'duffel', index: 1, status: 'loaded', history: [{ status: 'loaded' }] },
            { tag: 'CR-EK0007-02', type: 'duffel', index: 2, status: 'loaded', history: [] }
        ]
    };
    booking.counts.trunk = 1;
    const bags = L.buildBags(booking, { campPrefix: 'CR' });
    assert.strictEqual(bags.length, 3);
    assert.strictEqual(bags[0].status, 'loaded');
    assert.strictEqual(bags[1].status, 'loaded');
    assert.strictEqual(bags[2].status, 'registered');   // only the new one
});

test('bagCount sums every type', () => {
    assert.strictEqual(L.bagCount({ counts: { duffel: 2, trunk: 1, bedding: 1 } }), 4);
    assert.strictEqual(L.bagCount({}), 0);
});

// ── status machine ──────────────────────────────────────────────────────────

test('nextStatuses offers one step forward, one back, and exception', () => {
    assert.deepStrictEqual(L.nextStatuses('received'), ['loaded', 'tagged', 'exception']);
    assert.deepStrictEqual(L.nextStatuses('registered'), ['tagged', 'exception']);
});

test('an exception can be resolved back to any normal state', () => {
    assert.deepStrictEqual(L.nextStatuses('exception'),
        ['registered', 'tagged', 'received', 'loaded', 'in_transit', 'at_camp', 'delivered', 'returned']);
});

test('a bag cannot skip ahead — a missed scan has to surface', () => {
    // "Delivered" without ever being "received" means a scan was missed, and
    // hiding that defeats the point of tracking.
    assert.strictEqual(L.canTransition('registered', 'delivered'), false);
    assert.strictEqual(L.canTransition('tagged', 'received'), true);
    assert.strictEqual(L.canTransition('received', 'received'), false);
});

test('setStatus records history and never mutates the input', () => {
    const bag = { tag: 'CR-EK0007-01', status: 'tagged', history: [] };
    const res = L.setStatus(bag, 'received', { at: '2026-06-28', by: 'Rivky' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.bag.status, 'received');
    assert.strictEqual(res.bag.history.length, 1);
    assert.strictEqual(res.bag.history[0].by, 'Rivky');
    assert.strictEqual(bag.status, 'tagged');        // original untouched
    assert.strictEqual(bag.history.length, 0);
});

test('setStatus refuses an illegal jump but allows it under force', () => {
    const bag = { tag: 'T', status: 'registered', history: [] };
    const bad = L.setStatus(bag, 'delivered');
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /can't go from Registered straight to Delivered/);

    const forced = L.setStatus(bag, 'delivered', { force: true });
    assert.strictEqual(forced.ok, true);
});

test('setStatus rejects a status that does not exist', () => {
    assert.strictEqual(L.setStatus({ status: 'tagged' }, 'teleported').ok, false);
});

test('scanBatch moves matching tags and reports unknown ones', () => {
    const bookings = [{
        id: 1, camperName: 'Eli Katz', status: 'active',
        bags: [
            { tag: 'CR-EK0007-01', status: 'received', history: [] },
            { tag: 'CR-EK0007-02', status: 'registered', history: [] }
        ]
    }];
    const res = L.scanBatch(bookings, ['cr-ek0007-01', 'CR-EK0007-02', 'CR-ZZ9999-01'], 'loaded');
    assert.strictEqual(res.moved.length, 1);           // only the received one can go to loaded
    assert.strictEqual(res.moved[0].tag, 'CR-EK0007-01');
    assert.strictEqual(res.failed.length, 1);          // registered -> loaded is a skip
    assert.deepStrictEqual(res.unknown, ['CR-ZZ9999-01']);
});

// ── pricing ─────────────────────────────────────────────────────────────────

const PRICING = { communalBase: 105, includedBags: 2, extraBagFee: 35, privatePickupFee: 250 };

test('quote: the base covers the included bags', () => {
    const q = L.quote({ serviceType: 'to_camp', pickupMode: 'communal', counts: { duffel: 2 } }, PRICING);
    assert.strictEqual(q.bags, 2);
    assert.strictEqual(q.extraBags, 0);
    assert.strictEqual(q.total, 105);
});

test('quote: bags beyond the allowance are charged per bag', () => {
    const q = L.quote({ serviceType: 'to_camp', pickupMode: 'communal', counts: { duffel: 2, trunk: 2 } }, PRICING);
    assert.strictEqual(q.extraBags, 2);
    assert.strictEqual(q.extraBagsFee, 70);
    assert.strictEqual(q.total, 175);
});

test('quote: private pick-up REPLACES the communal base, it does not stack', () => {
    const q = L.quote({ serviceType: 'to_camp', pickupMode: 'private', counts: { duffel: 2 } }, PRICING);
    assert.strictEqual(q.base, 250);
    assert.strictEqual(q.total, 250);          // not 355
});

test('quote: a round trip charges both legs', () => {
    const one = L.quote({ serviceType: 'to_camp', pickupMode: 'communal', counts: { duffel: 2 } }, PRICING);
    const both = L.quote({ serviceType: 'round', pickupMode: 'communal', counts: { duffel: 2 } }, PRICING);
    assert.strictEqual(both.legs, 2);
    assert.strictEqual(both.total, one.total * 2);
});

test('quote: the return leg can be discounted', () => {
    const q = L.quote({ serviceType: 'round', pickupMode: 'communal', counts: { duffel: 2 } },
                      Object.assign({}, PRICING, { returnLegMultiplier: 0.5 }));
    assert.strictEqual(q.total, 157.5);
});

test('quote: an unknown service type falls back to round trip rather than free', () => {
    const q = L.quote({ serviceType: 'nonsense', counts: { duffel: 2 } }, PRICING);
    assert.strictEqual(q.legs, 2);
    assert.ok(q.total > 0);
});

test('pricing clamps negatives away', () => {
    const p = L.pricing({ communalBase: -50, includedBags: -3, extraBagFee: 'abc' });
    assert.strictEqual(p.communalBase, 0);
    assert.strictEqual(p.includedBags, 0);
    assert.strictEqual(p.extraBagFee, 0);
});

// ── locations ───────────────────────────────────────────────────────────────

test('locationLoad counts BAGS against capacity, not bookings', () => {
    // A family with four trunks is not one unit — capacity is what fills a truck.
    const loc = { id: 'bklyn', name: 'Brooklyn', capacityBags: 5 };
    const bookings = [
        { id: 1, locationId: 'bklyn', counts: { duffel: 4 } },
        { id: 2, locationId: 'bklyn', counts: { duffel: 2 } },
        { id: 3, locationId: 'monsey', counts: { duffel: 9 } },
        { id: 4, locationId: 'bklyn', status: 'cancelled', counts: { duffel: 9 } }
    ];
    const load = L.locationLoad(loc, bookings);
    assert.strictEqual(load.bookings, 2);
    assert.strictEqual(load.bags, 6);
    assert.strictEqual(load.over, true);
    assert.strictEqual(load.remaining, 0);
});

test('locationLoad with no capacity set never reports over', () => {
    const load = L.locationLoad({ id: 'x' }, [{ id: 1, locationId: 'x', counts: { duffel: 99 } }]);
    assert.strictEqual(load.over, false);
    assert.strictEqual(load.remaining, null);
});

// ── manifests ───────────────────────────────────────────────────────────────

const BOOKINGS = [
    { id: 1, camperName: 'Eli Katz', bunk: 'A2', locationId: 'bklyn', bags: [
        { tag: 'T1', index: 1, status: 'loaded' }, { tag: 'T2', index: 2, status: 'delivered' } ] },
    { id: 2, camperName: 'Avi Stern', bunk: 'A10', locationId: 'bklyn', bags: [
        { tag: 'T3', index: 1, status: 'exception' } ] },
    { id: 3, camperName: 'Moshe Blum', bunk: '', locationId: 'monsey', bags: [
        { tag: 'T4', index: 1, status: 'registered' } ] },
    { id: 4, camperName: 'Gone', status: 'cancelled', bunk: 'A2', bags: [
        { tag: 'T9', index: 1, status: 'loaded' } ] }
];

test('allBags flattens across bookings and skips cancellations', () => {
    const bags = L.allBags(BOOKINGS);
    assert.strictEqual(bags.length, 4);
    assert.ok(!bags.some(b => b.tag === 'T9'));
    assert.strictEqual(bags.find(b => b.tag === 'T1').camperName, 'Eli Katz');
});

test('manifest filters by location and counts what is on board', () => {
    const m = L.manifest(BOOKINGS, { locationId: 'bklyn' });
    assert.strictEqual(m.total, 3);
    assert.strictEqual(m.onBoard, 2);            // loaded + delivered
    assert.strictEqual(m.exceptions.length, 1);
    assert.strictEqual(m.byStatus.loaded, 1);
});

test('manifest sorts by camper then bag number', () => {
    const m = L.manifest(BOOKINGS, {});
    assert.deepStrictEqual(m.bags.map(b => b.tag), ['T3', 'T1', 'T2', 'T4']);
});

test('deliveryByBunk groups for the crew, keeping unassigned bags visible last', () => {
    // An unassigned bag is precisely the one that goes missing — it must not
    // be filtered out of the sheet.
    const rows = L.deliveryByBunk(BOOKINGS);
    assert.deepStrictEqual(rows.map(r => r.bunk), ['A2', 'A10', 'Unassigned']);
    assert.strictEqual(rows[0].bagCount, 2);
    assert.strictEqual(rows[0].camperCount, 1);
    assert.deepStrictEqual(rows[0].campers, [{ name: 'Eli Katz', bags: 2 }]);
});

test('deliveryByBunk can filter to a single status', () => {
    const rows = L.deliveryByBunk(BOOKINGS, { status: 'delivered' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].bunk, 'A2');
    assert.strictEqual(rows[0].bagCount, 1);
});

test('summary reports progress and exceptions', () => {
    const s = L.summary(BOOKINGS);
    assert.strictEqual(s.bookings, 3);
    assert.strictEqual(s.bags, 4);
    assert.strictEqual(s.delivered, 1);
    assert.strictEqual(s.exceptions, 1);
    assert.strictEqual(s.percentComplete, 25);
});

test('summary of nothing is zeroes, not a divide by zero', () => {
    const s = L.summary([]);
    assert.strictEqual(s.bags, 0);
    assert.strictEqual(s.percentComplete, 0);
});
