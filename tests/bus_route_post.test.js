// node --test tests/bus_route_post.test.js
//
// Campistry Go post-routing passes (campistry_go_route_post.js). These pin
// the "containment" rule: no pass may hand a stop to a bus unless the stop
// sits on that bus's ground, and no pass may leave a bus serving both sides
// of camp — the source of the "drive north, turn around, drive back through
// camp and out south" routes. Every pass that moves a stop re-orders the
// routes it touched, and buses never leave with more children than seats.
//
// The module is pure — no DOM, no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.window = global.window || {};
eval(fs.readFileSync(path.join(__dirname, '..', 'campistry_go_route_post.js'), 'utf8'));
const P = global.window.CampistryGoRoutePost;

const CAMP = { lat: 40.0933, lng: -74.2110 };
const MI_LAT = 1 / 69, MI_LNG = 1 / (69 * Math.cos(CAMP.lat * Math.PI / 180));
const at = (miN, miE, kids, extra) => Object.assign({
    lat: CAMP.lat + miN * MI_LAT, lng: CAMP.lng + miE * MI_LNG,
    address: miN + 'N ' + miE + 'E', campers: Array.from({ length: kids || 1 }, (_, i) => ({ name: 'k' + miN + '_' + miE + '_' + i })),
}, extra || {});
const route = (busId, stops, cap) => ({ busId, busName: busId, stops: stops.map((s, i) => Object.assign(s, { stopNum: i + 1 })), _cap: cap, camperCount: stops.reduce((a, s) => a + s.campers.length, 0), totalDuration: 0 });
const kids = r => r.stops.reduce((a, s) => a + s.campers.length, 0);

test('arcDeg ignores stops inside the near-camp radius and measures the rest', () => {
    assert.strictEqual(P.arcDeg([at(0.3, 0), at(-0.3, 0)], CAMP), 0, 'homes either side of camp are compact, not a straddle');
    assert.ok(Math.abs(P.arcDeg([at(3, 0), at(-3, 0.1)], CAMP) - 178) < 3, 'north and south of camp is ~180 degrees');
    assert.ok(P.arcDeg([at(3, 0), at(3, 1)], CAMP) < 25, 'a tight wedge stays narrow');
});

test('stopFitsRoute rejects a stop that would make a bus straddle camp, even when it is near the centroid', () => {
    // Bus serves 0..2mi north; its centroid is ~1mi north of camp.
    const north = [at(0.5, 0), at(1.0, 0.2), at(1.5, -0.1), at(2.0, 0.1)];
    const south = at(-2.0, 0);      // 3mi from the centroid — the old centroid gate let this through
    const r = P.stopFitsRoute(south, north, CAMP, {}, 3.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'straddle', 'it is 2.5mi from the nearest north stop, so the ARC test must be what rejects it');
    const farSouth = at(-3.0, 0);
    const r2 = P.stopFitsRoute(farSouth, north, CAMP, {}, 3.0);
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, 'too-far');
    const north2 = at(2.4, 0.2);
    assert.strictEqual(P.stopFitsRoute(north2, north, CAMP, {}, 3.0).ok, true, 'a stop further out on the same side is fine');
    assert.strictEqual(P.stopFitsRoute(at(5, 5), [], CAMP).ok, true, 'an empty bus can take anything');
});

test('localTspOrder produces a coherent outward sweep and keeps staff pseudo-stops at the tail', () => {
    let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const stops = []; for (let i = 0; i < 40; i++) stops.push(at(1 + rnd() * 4, rnd() * 2 - 1, 1 + (i % 3)));
    const monitor = { isMonitor: true, campers: [], address: 'monitor' };
    const before = P.routeLastDropMin({ stops }, CAMP);
    const t0 = Date.now();
    const ord = P.localTspOrder(stops.concat([monitor]), CAMP, false);
    const ms = Date.now() - t0;
    const after = P.routeLastDropMin({ stops: ord }, CAMP);
    assert.strictEqual(ord.length, 41);
    assert.strictEqual(ord[ord.length - 1], monitor, 'monitor stays last');
    assert.ok(after < before * 0.6, 'ordering should cut the route substantially: ' + Math.round(before) + ' -> ' + Math.round(after));
    assert.ok(ms < 2000, 'a 40-stop bus must order in under 2s, took ' + ms + 'ms');
    // dismissal: no consecutive pair should jump across camp
    for (let i = 1; i < ord.length - 1; i++) {
        assert.ok(P.arcDeg([ord[i - 1], ord[i]], CAMP) < 120, 'no through-camp reversal between consecutive stops');
    }
});

test('rebalanceBusLoads is OFF by default — efficient routes, not equal ones', () => {
    const heavy = route('heavy', [at(2, 0, 10), at(2.5, 0.2, 10), at(3, 0, 10), at(3.5, 0.1, 10), at(1.7, 0.1, 6)], 48);
    const light = route('light', [at(1.6, 0.05, 4), at(2.2, -0.1, 4)], 48);
    const routes = [heavy, light];
    const moved = P.rebalanceBusLoads(routes, { heavy: 48, light: 48 }, CAMP, false);
    assert.strictEqual(moved, 0);
    assert.strictEqual(kids(heavy), 46);
    assert.strictEqual(kids(light), 8);
});

test('rebalanceBusLoads (opt-in) never hands a bus a stop on the other side of camp', () => {
    // heavy bus is compact in the NORTH; light bus is compact in the SOUTH.
    const heavy = route('heavy', [at(2, 0, 10), at(2.5, 0.2, 10), at(3, 0, 10), at(3.5, 0.1, 10), at(1.7, 0.1, 6)], 48);
    const light = route('light', [at(-1.6, 0.05, 4), at(-2.2, -0.1, 4)], 48);
    const moved = P.rebalanceBusLoads([heavy, light], { heavy: 48, light: 48 }, CAMP, false, { equalizeLoads: true });
    assert.strictEqual(moved, 0, 'nothing on the north bus belongs on the south bus');
    assert.ok(P.arcDeg(light.stops, CAMP) < 110);
    // ...but a north stop right next to a north light bus does move, and the receiver is re-ordered.
    const light2 = route('light2', [at(1.6, 0.05, 4), at(2.2, -0.1, 4)], 48);
    const moved2 = P.rebalanceBusLoads([heavy, light2], { heavy: 48, light2: 48 }, CAMP, false, { equalizeLoads: true });
    assert.ok(moved2 > 0);
    assert.ok(P.arcDeg(light2.stops, CAMP) < 110);
    assert.deepStrictEqual(light2.stops.map(s => s.stopNum), light2.stops.map((_, i) => i + 1), 'receiver renumbered');
});

test('splitOverlongRoutes only hands the far stop to a bus that is already nearby, and re-orders both', () => {
    // over-cap bus running north; a south bus with room; a north bus with room.
    const over = route('over', [at(2, 0, 3), at(3, 0.1, 3), at(4, 0, 3), at(5, 0.2, 3), at(6, 0, 3)], 48);
    over.totalDuration = 120;
    const south = route('south', [at(-2, 0, 3), at(-3, 0.1, 3)], 48); south.totalDuration = 30;
    const north = route('north', [at(5.5, 0.8, 3), at(4.8, 0.9, 3)], 48); north.totalDuration = 30;
    const moves = P.splitOverlongRoutes([over, south, north], { over: 48, south: 48, north: 48 }, CAMP, 90, false);
    assert.ok(moves > 0);
    assert.strictEqual(kids(south), 6, 'the south bus must not receive any north stop');
    assert.ok(kids(north) > 6, 'the north bus takes the far north stop');
    for (const r of [over, south, north]) {
        assert.ok(P.arcDeg(r.stops, CAMP) < 110, r.busId + ' must not straddle');
        assert.deepStrictEqual(r.stops.map(s => s.stopNum), r.stops.map((_, i) => i + 1), r.busId + ' renumbered');
    }
    // the moved stop was not just appended: the receiver's last stop is its farthest from camp (outward sweep)
    const far = north.stops.map(s => P.haversineMi(CAMP.lat, CAMP.lng, s.lat, s.lng));
    assert.strictEqual(far.indexOf(Math.max(...far)), far.length - 1);
});

test('relieveLongRoutes measures the hand-off gate in miles and respects containment', () => {
    // Long north route with a far tail; a north bus with seats nearby; a south bus with seats.
    const long = route('long', [at(1.5, 0, 3), at(2.5, 0.1, 3), at(3.5, 0, 3), at(4.5, 0.2, 3), at(5.5, 0, 3), at(6.5, 0.1, 3), at(7.5, 0, 3), at(8.5, 0.1, 3)], 48);
    const nearN = route('nearN', [at(6.8, 0.6, 3), at(7.8, 0.7, 3), at(8.3, 0.5, 3)], 48);
    const south = route('south', [at(-2, 0, 3), at(-2.5, 0.1, 3), at(-3, 0, 3)], 48);
    const short1 = route('s1', [at(1, 0.5, 3), at(1.2, 0.6, 3), at(1.4, 0.4, 3)], 48);
    const short2 = route('s2', [at(1, -0.5, 3), at(1.2, -0.6, 3), at(1.4, -0.4, 3)], 48);
    const before = P.routeLastDropMin(long, CAMP);
    const moves = P.relieveLongRoutes([long, nearN, south, short1, short2], CAMP, false);
    assert.ok(moves > 0, 'the far tail should be handed to the nearby north bus');
    assert.strictEqual(kids(south), 9, 'the south bus is not touched');
    assert.ok(P.routeLastDropMin(long, CAMP) < before - 2);
    assert.ok(P.arcDeg(nearN.stops, CAMP) < 110);
});

test('enforceCapacity moves riders off an over-capacity bus onto a contained receiver', () => {
    const over = route('over', [at(2, 0, 20), at(2.5, 0.2, 20), at(3, 0, 16)], 48); // 56 on 48 seats
    const north = route('north', [at(3.4, 0.3, 10)], 48);
    const south = route('south', [at(-2, 0, 10)], 48);
    const res = P.enforceCapacity([over, north, south], { over: 48, north: 48, south: 48 }, CAMP, false);
    assert.ok(res.moved > 0);
    assert.strictEqual(res.stranded, 0);
    assert.ok(kids(over) <= 48, 'over-capacity bus is brought within its seats');
    assert.strictEqual(kids(south), 10, 'the south bus receives nothing from a north bus');
    assert.ok(kids(north) > 10);
    assert.strictEqual(res.uncontained, 0);
});

test('enforceCapacity uses a one-step chain before handing a stop to a bus outside its area', () => {
    // over-full A (north). B is next to A but full. C is next to B with room.
    // D (south) has plenty of room but is on the wrong side of camp.
    const a = route('a', [at(2.0, 0, 20), at(2.4, 0.1, 20), at(2.8, 0, 12)], 48);   // 52
    const b = route('b', [at(3.2, 0.3, 24), at(3.6, 0.5, 24)], 48);               // 48, full
    const c = route('c', [at(4.0, 0.9, 10)], 48);                                  // room
    const d = route('d', [at(-2.5, 0, 5)], 48);                                    // south
    const res = P.enforceCapacity([a, b, c, d], { a: 48, b: 48, c: 48, d: 48 }, CAMP, false);
    assert.ok(kids(a) <= 48);
    assert.strictEqual(kids(d), 5, 'the south bus must not be used');
    assert.strictEqual(res.uncontained, 0, 'the chain keeps every move contained');
    assert.ok(kids(c) > 10, 'C took B\'s stop so B could take A\'s');
    assert.strictEqual(kids(a) + kids(b) + kids(c) + kids(d), 52 + 48 + 10 + 5);
    for (const r of [a, b, c, d]) assert.ok(P.arcDeg(r.stops, CAMP) < 110, r.busId + ' contained');
});

test('enforceCapacity reports stranded riders when the fleet is genuinely full', () => {
    const a = route('a', [at(2, 0, 30), at(2.5, 0.2, 20)], 48);
    const b = route('b', [at(2.2, 0.4, 48)], 48);
    const res = P.enforceCapacity([a, b], { a: 48, b: 48 }, CAMP, false);
    assert.strictEqual(res.stranded, 2);
    assert.strictEqual(kids(a) + kids(b), 98, 'no child is dropped');
});

test('containmentReport flags a bus that serves both sides of camp', () => {
    const rep = P.containmentReport([
        route('ok', [at(2, 0, 3), at(3, 0.5, 3)]),
        route('bad', [at(3, 0, 3), at(-3, 0.2, 3)]),
    ], CAMP);
    assert.strictEqual(rep.find(r => r.busId === 'ok').straddle, false);
    assert.strictEqual(rep.find(r => r.busId === 'bad').straddle, true);
    assert.ok(rep.find(r => r.busId === 'bad').arcDeg > 170);
});
