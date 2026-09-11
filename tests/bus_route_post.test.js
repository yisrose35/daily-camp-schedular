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

test('polishDistricts moves a segment to the bus whose route already passes it, under seats and containment', () => {
    // Bus A runs north 2..4mi; one of its atoms sits right on bus B's north-east road.
    const A = [at(2, 0, 3), at(3, 0.1, 3), at(4, 0, 3), at(3.6, 1.9, 3) /* misplaced */];
    const Bb = [at(2.5, 1.5, 3), at(3.2, 1.8, 3), at(4.0, 2.0, 3)];
    const S = [at(-2.5, 0.2, 3), at(-3.2, -0.1, 3)];
    const res = P.polishDistricts([A, Bb, S], [48, 48, 48], CAMP);
    assert.ok(res.moves >= 1, 'the misplaced atom should move');
    assert.ok(res.after < res.before - 1, 'fleet estimate must drop: ' + res.before.toFixed(1) + ' -> ' + res.after.toFixed(1));
    assert.strictEqual(res.buckets[1].some(a => a.address === '3.6N 1.9E'), true, 'it lands on the north-east bus');
    assert.strictEqual(res.buckets[2].length, 2, 'the south bus is untouched');
    const all = res.buckets.flat();
    assert.strictEqual(all.length, 9, 'every atom exactly once');
    for (const b of res.buckets) assert.ok(P.arcDeg(b, CAMP) <= 110, 'contained');
});

test('polishDistricts swaps when both buses are full and never breaks seats or containment', () => {
    // Two full buses (cap 6, 2 atoms of 3 each) with one atom each on the wrong side.
    const A = [at(3, 0, 3), at(3, 2.2, 3)];      // second atom belongs east
    const Bb = [at(3.2, 2.0, 3), at(2.8, 0.2, 3)]; // second atom belongs north
    const res = P.polishDistricts([A, Bb], [6, 6], CAMP);
    assert.ok(res.moves >= 1, 'a swap is the only legal move and it must happen');
    assert.ok(res.after < res.before - 1);
    for (const b of res.buckets) {
        assert.strictEqual(b.reduce((a, x) => a + x.campers.length, 0), 6, 'seats unchanged');
        assert.ok(P.spreadMi(b) < 1.0, 'each bus is now compact');
    }
});

test('polishDistricts never widens a bus across camp even when the tour would be shorter', () => {
    // A tiny north bus and a big south bus: moving the south singleton onto
    // the north bus would "save" a bus trip but straddle camp.
    const north = [at(2, 0, 3), at(2.4, 0.1, 3)];
    const south = [at(-2.0, 0.1, 3)];
    const res = P.polishDistricts([north, south], [48, 48], CAMP, { polishRideBudgetMin: 0 });
    assert.strictEqual(res.buckets[0].length + res.buckets[1].length, 3);
    for (const b of res.buckets) assert.ok(P.arcDeg(b, CAMP) <= 110, 'no straddle');
});

test('polishDistricts leaves a clean districting alone', () => {
    const A = [at(2, 0, 3), at(3, 0.1, 3), at(4, 0, 3)];
    const Bb = [at(2, 2, 3), at(3, 2.1, 3), at(4, 2, 3)];
    const res = P.polishDistricts([A, Bb], [48, 48], CAMP);
    assert.strictEqual(res.moves, 0);
    assert.strictEqual(res.after, res.before);
});

test('localTspOrder is idempotent: re-ordering an ordered route keeps it (or improves it)', () => {
    let seed = 21; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let trial = 0; trial < 5; trial++) {
        const stops = []; for (let i = 0; i < 25; i++) stops.push(at(1 + rnd() * 4, rnd() * 3 - 1.5, 1 + (i % 4)));
        const once = P.localTspOrder(stops, CAMP, false);
        const twice = P.localTspOrder(once, CAMP, false);
        const t1 = P.routeLastDropMin({ stops: once }, CAMP), t2 = P.routeLastDropMin({ stops: twice }, CAMP);
        // same order, or a strictly better objective — never a random different local optimum
        assert.ok(twice.every((s, i) => s === once[i]) || t2 <= t1 + 3, 'trial ' + trial + ': ' + Math.round(t1) + ' -> ' + Math.round(t2));
        // and the quality must not depend on how the stops were handed over
        const shuffled = stops.slice().sort(() => rnd() - 0.5);
        const fromShuffled = P.localTspOrder(shuffled, CAMP, false);
        // Local search has some inherent dependence on its starting point (measured: up
        // to ~2.5% even with full candidate lists); kicks keep it small. Guard the ceiling.
        const c1 = P.routeObjective(once, CAMP, false), c2 = P.routeObjective(fromShuffled, CAMP, false);
        assert.ok(Math.abs(c2 - c1) <= 0.03 * c1, 'trial ' + trial + ': quality depends on input order (' + Math.round(c1) + ' vs ' + Math.round(c2) + ')');
    }
});

test('arrival ordering pays for the drive back to camp: the last pickup is near camp, not five miles out', () => {
    // Two branches north of camp: a big group 5mi out west, singles along the east branch.
    const stops = [at(1, 0.3, 2), at(2, 0.4, 2), at(3, 0.5, 2), at(4, 0.6, 2), at(5, -1.5, 9), at(4, -1.4, 1), at(3, -1.3, 1), at(2, -1.2, 1)];
    const ord = P.localTspOrder(stops, CAMP, true);
    const last = ord[ord.length - 1];
    assert.ok(P.haversineMi(CAMP.lat, CAMP.lng, last.lat, last.lng) < 2.5, 'last pickup should be close to camp, got ' + last.address);
    let t = 0, prev = CAMP; const arr = [];
    for (const s of ord) { t += P.driveMin(prev, s) + 2; arr.push(t); prev = s; }
    const back = P.driveMin(prev, CAMP);
    let kidMin = 0, kids = 0; ord.forEach((s, i) => { kids += s.campers.length; kidMin += s.campers.length * (t + back - arr[i]); });
    assert.ok(kidMin / kids < 26, 'average child ride should be under 26 min, got ' + (kidMin / kids).toFixed(1));
});

test('dwell model: seconds per child lengthen a busy stop but not a flat-configured camp', () => {
    const big = at(2, 0, 12), small = at(2, 0.1, 1);
    assert.strictEqual(P.stopDwellMin(big, { avgStopMin: 2, secPerRider: 0 }), 2, 'flat when secPerRider is 0');
    assert.ok(Math.abs(P.stopDwellMin(big, { avgStopMin: 0.5, secPerRider: 3 }) - (0.5 + 36 / 60)) < 1e-9);
    const flat = P.routeLastDropMin({ stops: [big, small] }, CAMP, { avgStopMin: 2, secPerRider: 0 });
    const perKid = P.routeLastDropMin({ stops: [big, small] }, CAMP, { avgStopMin: 2, secPerRider: 5 });
    assert.ok(Math.abs((perKid - flat) - (13 * 5) / 60) < 1e-6, 'per-child seconds add up across the route');
});

test('ride-ratio audit flags a child riding far longer than their direct trip', () => {
    // A 1mi-from-camp stop dropped LAST after a 6mi loop: rides ~30min for a ~3min trip.
    const r = route('r', [at(3, 0, 3), at(5, 0.5, 3), at(6, -0.5, 3), at(1, 0.2, 3)], 48);
    const v = P.rideRatioViolations(r, CAMP, false);
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].stop.address, '1N 0.2E');
    assert.ok(v[0].rideMin > v[0].limitMin);
    const good = route('g', [at(1, 0.2, 3), at(3, 0, 3), at(5, 0.5, 3), at(6, -0.5, 3)], 48);
    assert.strictEqual(P.rideRatioViolations(good, CAMP, false).length, 0);
});

test('pass-by audit catches a bus that drives past a stop and comes back for it later', () => {
    // North road: camp -> 1N -> 3N, then back to 2N (passed on the 1N->3N leg), then 4N.
    const r = route('r', [at(1, 0, 3), at(3, 0, 3), at(2, 0.01, 3), at(4, 0, 3)], 48);
    const p = P.passBys(r, CAMP, false);
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].stop.address, '2N 0.01E');
    const clean = route('c', [at(1, 0, 3), at(2, 0.01, 3), at(3, 0, 3), at(4, 0, 3)], 48);
    assert.strictEqual(P.passBys(clean, CAMP, false).length, 0);
    // arrival mirror: pickups 4N,2N,3N,1N -> riding direction 1N,3N,2N,4N: 2N is passed
    const arr = route('a', [at(4, 0, 3), at(2, 0.01, 3), at(3, 0, 3), at(1, 0, 3)], 48);
    assert.strictEqual(P.passBys(arr, CAMP, true).length, 1);
});

test('a higher bus overhead makes polish consolidate a tiny bus into its neighbour', () => {
    const A = [at(2, 0, 3), at(3, 0.1, 3), at(4, 0, 3), at(5, 0.1, 3)];
    const tiny = [at(2.6, 0.4, 2)];
    const cheap = P.polishDistricts([A, tiny], [48, 48], CAMP, { busOverheadMin: 0, polishRideBudgetMin: 0 });
    const dear = P.polishDistricts([A, tiny], [48, 48], CAMP, { busOverheadMin: 40, polishRideBudgetMin: 0 });
    assert.strictEqual(dear.buckets.filter(b => b.length).length, 1, 'with a dear bus the singleton merges');
    assert.ok(cheap.buckets.filter(b => b.length).length >= 1);
});

// A 7x7 street grid (0.5mi spacing) north of camp with a river between columns 3 and 4
// that only one bridge (row 3) crosses; the road along row 0 is one-way eastbound.
function riverGrid() {
    const nodes = {}, edges = [];
    const id = (r, c) => 'n' + r + '_' + c;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) nodes[id(r, c)] = { lat: CAMP.lat + (0.5 + r * 0.5) * MI_LAT, lng: CAMP.lng + (c - 3) * 0.5 * MI_LNG };
    let k = 0;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        if (r < 6) edges.push({ id: 'e' + (k++), fromNodeId: id(r, c), toNodeId: id(r + 1, c), lenMi: 0.5, hwClass: 'residential', oneway: false });
        if (c < 6) {
            const crossesRiver = c === 3;              // between column 3 and 4
            if (crossesRiver && r !== 3) continue;     // only the row-3 bridge crosses
            edges.push({ id: 'e' + (k++), fromNodeId: id(r, c), toNodeId: id(r, c + 1), lenMi: 0.5, hwClass: r === 3 ? 'secondary' : 'residential', oneway: r === 0 });
        }
    }
    // camp connects to the grid at (0,3)
    nodes.camp = { lat: CAMP.lat, lng: CAMP.lng };
    edges.push({ id: 'e' + (k++), fromNodeId: 'camp', toNodeId: id(0, 3), lenMi: 0.5, hwClass: 'residential', oneway: false });
    return { nodes, edges };
}

test('road network: a river with one bridge makes near-by points far apart by road', () => {
    const net = P.buildRoadNet(riverGrid(), { avgSpeedMph: 25 });
    assert.ok(net && net.nodeCount === 50);
    const west = { lat: CAMP.lat + 1.0 * MI_LAT, lng: CAMP.lng + 0 * MI_LNG };            // (row1, col3), west bank
    const east = { lat: CAMP.lat + 1.0 * MI_LAT, lng: CAMP.lng + 0.5 * MI_LNG };          // (row1, col4), east bank
    const L = net.legMinutesFor([west, east, CAMP]);
    const straight = P.driveMin(west, east, { avgSpeedMph: 25, roadFactor: 1.35 });
    const byRoad = L(west, east);
    // straight line ~0.5mi (~1.6min); road: up two rows (1mi), across the bridge (0.5mi secondary), down two rows (1mi)
    assert.ok(byRoad > straight * 3, 'road time ' + byRoad.toFixed(1) + ' should dwarf straight-line ' + straight.toFixed(1));
    const expected = 2.0 / 20 * 60 + 0.5 / 30 * 60 + 5 * 0.05;
    assert.ok(Math.abs(byRoad - expected) < 0.2, 'road time should be ' + expected.toFixed(2) + ' min, got ' + byRoad.toFixed(2));
    // unknown point falls back to straight-line x road factor
    assert.ok(Math.abs(L(west, { lat: CAMP.lat + 3 * MI_LAT, lng: CAMP.lng }) - P.driveMin(west, { lat: CAMP.lat + 3 * MI_LAT, lng: CAMP.lng }, { avgSpeedMph: 25, roadFactor: 1.35 })) < 1e-9);
});

test('road network: one-way streets are asymmetric', () => {
    const net = P.buildRoadNet(riverGrid(), { avgSpeedMph: 25 });
    const a = { lat: CAMP.lat + 0.5 * MI_LAT, lng: CAMP.lng - 1.5 * MI_LNG };  // (row0, col0)
    const b = { lat: CAMP.lat + 0.5 * MI_LAT, lng: CAMP.lng - 0.5 * MI_LNG };  // (row0, col2)
    const L = net.legMinutesFor([a, b]);
    assert.ok(L(a, b) < L(b, a) - 1, 'eastbound is direct (1mi); westbound must detour: ' + L(a, b).toFixed(2) + ' vs ' + L(b, a).toFixed(2));
});

test('ordering on road legs serves one river bank fully before crossing, and stamps leg seconds for ETAs', () => {
    const net = P.buildRoadNet(riverGrid(), { avgSpeedMph: 25 });
    const west = [1, 2, 4, 5].map(r => at(0.5 + r * 0.5, 0, 3));
    const east = [1, 2, 4, 5].map(r => at(0.5 + r * 0.5, 0.5, 3));
    const stops = [west[0], east[0], west[1], east[1], west[2], east[2], west[3], east[3]]; // interleaved
    const L = net.legMinutesFor([CAMP].concat(stops));
    const ord = P.localTspOrder(stops, CAMP, false, { avgSpeedMph: 25, legMinutes: L });
    // count bank changes along the sequence: a good road-aware order crosses the river once
    let crossings = 0; for (let i = 1; i < ord.length; i++) if ((ord[i].address.endsWith('0.5E')) !== (ord[i - 1].address.endsWith('0.5E'))) crossings++;
    assert.ok(crossings <= 1, 'expected at most one river crossing, got ' + crossings + ': ' + ord.map(s => s.address).join(' > '));
    const route = { stops: ord };
    const legs = P.stampLegTimes(route, CAMP, L);
    assert.strictEqual(legs.length, ord.length + 1, 'one leg per stop plus the return');
    assert.ok(legs.every(x => x > 0));
});

test('polish keeps every invariant on a scattered instance and never worsens the objective', () => {
    let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // four wedges of atoms with a few atoms scattered into the wrong wedge
    const buckets = [[], [], [], []];
    for (let i = 0; i < 80; i++) {
        const wedge = i % 4, ang = (wedge * 90 + 10 + rnd() * 70) * Math.PI / 180, r = 1.6 + rnd() * 3;
        const atom = at(r * Math.cos(ang), r * Math.sin(ang), 1 + (i % 3));
        atom.count = atom.campers.length;
        buckets[(i % 9 === 0) ? (wedge + 1) % 4 : wedge].push(atom);
    }
    const inWedge = buckets.map(b => P.arcDeg(b, CAMP));
    const res = P.polishDistricts(buckets, [48, 48, 48, 48], CAMP, { polishTimeBudgetMs: 3000 });
    assert.ok(res.after <= res.before + 1e-9);
    assert.strictEqual(res.buckets.flat().length, 80, 'every atom exactly once');
    res.buckets.forEach((b, i) => {
        assert.ok(b.reduce((a, x) => a + x.count, 0) <= 48);
        // a bus that came in straddling may stay so; polish must never make a wedge wider than the limit
        assert.ok(P.arcDeg(b, CAMP) <= Math.max(110, inWedge[i]) + 1e-9, 'never widened past the limit');
    });
    // deterministic
    const again = P.polishDistricts(buckets, [48, 48, 48, 48], CAMP, { polishTimeBudgetMs: 3000 });
    assert.strictEqual(Math.round(again.after), Math.round(res.after));
});

test('road network paths follow the streets and cross the river only at the bridge', () => {
    const g = riverGrid();
    // give the bridge edge a curve so we can see interior shape points come through
    const bridge = g.edges.find(e => e.fromNodeId === 'n3_3' && e.toNodeId === 'n3_4');
    bridge.pts = [[CAMP.lat + (0.5 + 3 * 0.5 + 0.05) * MI_LAT, CAMP.lng + 0.25 * MI_LNG]];
    const net = P.buildRoadNet(g, { avgSpeedMph: 25 });
    const west = { lat: CAMP.lat + 1.0 * MI_LAT, lng: CAMP.lng }, east = { lat: CAMP.lat + 1.0 * MI_LAT, lng: CAMP.lng + 0.5 * MI_LNG };
    const L = net.legMinutesFor([west, east]);
    const path = L.pathFor(west, east);
    assert.ok(path && path.length >= 6, 'path should run up to the bridge and back down');
    assert.deepStrictEqual(path[0], [west.lat, west.lng]);
    assert.deepStrictEqual(path[path.length - 1], [east.lat, east.lng]);
    const bridgeRowLat = CAMP.lat + (0.5 + 3 * 0.5) * MI_LAT;
    assert.ok(path.some(q => Math.abs(q[0] - bridgeRowLat) < 1e-9), 'must pass through the bridge row');
    assert.ok(path.some(q => Math.abs(q[1] - (CAMP.lng + 0.25 * MI_LNG)) < 1e-9), 'bridge shape point kept');
    const route = { stops: [west, east].map((p, i) => Object.assign({ campers: [{ name: 'k' + i }], address: 'x' + i }, p)) };
    const pts = P.stampRoadPath(route, CAMP, L, false, false);
    assert.ok(pts.length > path.length, 'whole run: camp -> west -> east');
    assert.deepStrictEqual(route._roadPts[0], [CAMP.lat, CAMP.lng]);
});

test('every bus gets its own colour when the fleet outgrows the palette, neighbours far apart', () => {
    const routes = [];
    for (let i = 0; i < 20; i++) {
        const ang = i * 18 * Math.PI / 180;
        routes.push({ busId: 'b' + i, busColor: ['#3b82f6', '#ef4444', '#22c55e'][i % 3], stops: [at(3 * Math.cos(ang), 3 * Math.sin(ang), 3)] });
    }
    const map = P.assignRouteColors(routes, CAMP);
    const cols = Array.from(map.values());
    assert.strictEqual(new Set(cols).size, 20, 'all distinct');
    assert.ok(cols.every(c => /^#[0-9a-f]{6}$/.test(c)));
    // neighbouring wedges (b0,b1) should not share a hue family: measure hue distance
    const hue = hex => { const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return 0; let h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn); return ((h * 60) + 360) % 360; };
    for (let i = 0; i < 20; i++) {
        const d = Math.abs(hue(map.get('b' + i)) - hue(map.get('b' + ((i + 1) % 20)))); const dd = Math.min(d, 360 - d);
        assert.ok(dd > 60, 'neighbours b' + i + ' and next differ by ' + dd.toFixed(0) + ' degrees of hue');
    }
    // unique colours are left alone
    const ok = [{ busId: 'x', busColor: '#111111', stops: [] }, { busId: 'y', busColor: '#222222', stops: [] }];
    assert.deepStrictEqual(Array.from(P.assignRouteColors(ok, CAMP).values()), ['#111111', '#222222']);
});

// ── polish objective: child-minutes and street coherence ────────────────────

test('polish prices child-minutes: a stop the fleet is indifferent about goes to the bus that reaches it sooner', () => {
    // Bus A is a long run north (1..6mi); bus B a short one to the east.
    // The stop X sits exactly between the two columns: the detour to serve
    // it is the same 0.62mi on either bus, so bus minutes alone leave it
    // where it is. On A it is dropped mid-run (~21 min) and delays six later
    // stops; on B it is dropped at ~16 min and delays one.
    const A = []; for (let n = 1; n <= 6; n += 0.5) A.push(at(n, 0, 4));
    const X = at(3.0, 0.45, 4); A.push(X);
    const Bb = [at(2.5, 0.9, 4), at(3.0, 0.9, 4), at(3.5, 0.9, 4)];
    const flat = P.polishDistricts([A, Bb], [48, 48], CAMP, { polishChildMinuteWeight: 0, polishStreetSplitMin: 0 });
    assert.strictEqual(flat.buckets[1].includes(X), false, 'bus minutes alone: X stays on the long bus');
    const res = P.polishDistricts([A, Bb], [48, 48], CAMP, { polishStreetSplitMin: 0, polishChildMinuteWeight: 0.03 });
    assert.strictEqual(res.buckets[1].includes(X), true, 'with child-minutes priced, X rides the short bus');
    assert.ok(res.childMinAfter < res.childMinBefore - 100, 'children ride less: ' + res.childMinBefore.toFixed(0) + ' -> ' + res.childMinAfter.toFixed(0));
    assert.ok(res.fleetAfter < res.fleetBefore + 2, 'for at most a couple of fleet minutes');
    assert.strictEqual(res.buckets.flat().length, A.length + Bb.length, 'every atom exactly once');
    for (const b of res.buckets) assert.ok(P.arcDeg(b, CAMP) <= 110, 'contained');
});

test('polish keeps one street on one bus: a split street is consolidated even at a small cost in minutes', () => {
    // "Forest Cir" runs east from 0.4E to 0.7E at 2N. One of its stops is on
    // bus A (column at 0.3E, so it is cheap there); the other two are on bus
    // B (column at 0.9E). Fleet minutes prefer the split; the street penalty
    // puts the whole street on one bus.
    const A = []; for (let n = 1; n <= 3; n += 0.5) A.push(at(n, 0.3, 3));
    A.push(at(2, 0.4, 3, { streetKey: 'Forest Cir' }));
    const Bb = []; for (let n = 1; n <= 3; n += 0.5) Bb.push(at(n, 0.9, 3));
    Bb.push(at(2, 0.6, 3, { streetKey: 'forest cir' }), at(2, 0.7, 3, { streetKey: 'FOREST CIR ' }));
    const onStreet = b => b.filter(x => x.streetKey).length;
    const flat = P.polishDistricts([A, Bb], [48, 48], CAMP, { polishStreetSplitMin: 0, polishChildMinuteWeight: 0 });
    assert.ok(flat.buckets.every(b => onStreet(b) > 0), 'without the penalty the street stays split');
    // (a) the explicit street-split penalty
    const res = P.polishDistricts([A, Bb], [48, 48], CAMP, { polishStreetSplitMin: 4 });
    assert.strictEqual(res.buckets.filter(b => onStreet(b) > 0).length, 1, 'the street is served by one bus');
    assert.strictEqual(res.buckets.filter(b => onStreet(b) === 3).length, 1, 'all three of its stops together');
    assert.ok(res.after < res.before, 'objective fell');
    assert.strictEqual(res.buckets.flat().length, A.length + Bb.length, 'every atom exactly once');
    // (b) the default: merge-aware dwell. Stops on one street within a quarter
    // mile of a same-bus stop share it, so the bus that already stops on
    // Forest Cir serves the third home for no extra stop time.
    const merged = P.polishDistricts([A, Bb], [48, 48], CAMP, { polishMergeSameStreetMi: 0.25, polishMergeAnyMi: 0.095 });
    assert.strictEqual(merged.buckets.filter(b => onStreet(b) > 0).length, 1, 'shared stop: the street is served by one bus');
    assert.ok(merged.fleetAfter < merged.fleetBefore, 'and the fleet gets shorter: ' + merged.fleetBefore.toFixed(1) + ' -> ' + merged.fleetAfter.toFixed(1));
    assert.strictEqual(merged.buckets.flat().length, A.length + Bb.length, 'every atom exactly once');
});

test('merge-aware dwell: homes that will share a stop are not each charged a stop', () => {
    const A = [at(2, 0, 3, { streetKey: 'Elm St' }), at(2.05, 0.02, 3, { streetKey: 'Elm St' }), at(3, 0, 3)];
    const plain = P.polishDistricts([A, []], [48, 48], CAMP, { polishMaxPasses: 0 });
    const shared = P.polishDistricts([A, []], [48, 48], CAMP, { polishMaxPasses: 0, polishMergeSameStreetMi: 0.25 });
    assert.ok(Math.abs((plain.fleetBefore - shared.fleetBefore) - 2) < 1e-6, 'one 2-minute stop saved: ' + plain.fleetBefore.toFixed(2) + ' vs ' + shared.fleetBefore.toFixed(2));
    // per-child seconds are still paid at a shared stop
    const sec = P.polishDistricts([A, []], [48, 48], CAMP, { polishMaxPasses: 0, polishMergeSameStreetMi: 0.25, secPerRider: 20 });
    assert.ok(Math.abs((sec.fleetBefore - shared.fleetBefore) - 9 * 20 / 60) < 1e-6, 'nine children x 20s');
});

test('polish in arrival mode prices the ride to camp and the return leg, and keeps every invariant', () => {
    const A = [at(2, 0, 3), at(3, 0.1, 3), at(4, 0, 3), at(3.6, 1.9, 3) /* misplaced */];
    const Bb = [at(2.5, 1.5, 3), at(3.2, 1.8, 3), at(4.0, 2.0, 3)];
    const S = [at(-2.5, 0.2, 3), at(-3.2, -0.1, 3)];
    const res = P.polishDistricts([A, Bb, S], [48, 48, 48], CAMP, { isArrival: true, polishChildMinuteWeight: 0.03 });
    assert.ok(res.moves >= 1);
    assert.strictEqual(res.buckets[1].some(a => a.address === '3.6N 1.9E'), true, 'the misplaced pickup joins the north-east bus');
    assert.ok(res.fleetAfter < res.fleetBefore, 'fleet minutes (to camp) fell');
    assert.ok(res.childMinAfter < res.childMinBefore, 'child-minutes (from pickup to camp) fell');
    assert.strictEqual(res.buckets.flat().length, 9, 'every atom exactly once');
    for (const b of res.buckets) assert.ok(P.arcDeg(b, CAMP) <= 110, 'contained');
    // arrival minutes include the return leg, so they exceed the dismissal figure for the same buckets
    const dis = P.polishDistricts([A, Bb, S], [48, 48, 48], CAMP, { polishMaxPasses: 0 });
    assert.ok(res.fleetBefore > dis.fleetBefore, 'arrival counts the drive back to camp');
});

test('a fractional Time Per Stop is honoured by the dwell model and the polish', () => {
    assert.strictEqual(P.stopDwellMin(at(1, 0, 4), { avgStopMin: 0.5, secPerRider: 0 }), 0.5);
    assert.ok(Math.abs(P.stopDwellMin(at(1, 0, 4), { avgStopMin: 0.5, secPerRider: 15 }) - 1.5) < 1e-9, '0.5 + 4 x 15s');
    const A = [at(2, 0, 3), at(3, 0.1, 3), at(4, 0, 3)];
    const Bb = [at(2, 2, 3), at(3, 2.1, 3), at(4, 2, 3)];
    const slow = P.polishDistricts([A, Bb], [48, 48], CAMP, { avgStopMin: 2, polishMaxPasses: 0 });
    const quick = P.polishDistricts([A, Bb], [48, 48], CAMP, { avgStopMin: 0.5, polishMaxPasses: 0 });
    assert.ok(Math.abs((slow.fleetBefore - quick.fleetBefore) - 6 * 1.5) < 1e-6, 'six stops x 1.5 min less dwell');
});

test('road legs answer by coordinates too: a fresh depot object equal by position gets the street time', () => {
    const net = P.buildRoadNet(riverGrid(), { avgSpeedMph: 25 });
    const west = { lat: CAMP.lat + 1.0 * MI_LAT, lng: CAMP.lng + 0 * MI_LNG };
    const east = { lat: CAMP.lat + 1.0 * MI_LAT, lng: CAMP.lng + 0.5 * MI_LNG };
    const L = net.legMinutesFor([west, east, CAMP]);
    const sameSpot = { lat: west.lat, lng: west.lng };
    assert.ok(Math.abs(L(sameSpot, east) - L(west, east)) < 1e-9, 'a copy of a known point resolves to its row');
    const campCopy = { lat: CAMP.lat, lng: CAMP.lng };
    assert.ok(Math.abs(L(campCopy, east) - L(CAMP, east)) < 1e-9, 'the depot is usually a fresh object');
});

test('polish on road legs: a stop across the river moves to the bus on its own bank even though it is nearer as the crow flies', () => {
    const net = P.buildRoadNet(riverGrid(), { avgSpeedMph: 25 });
    // West-bank bus A, east-bank bus B. X sits on the EAST bank, 0.5mi straight
    // across the river from A's stops — but by road it is a long way from A.
    const A = [1, 2, 4].map(r => at(0.5 + r * 0.5, 0, 3));
    const Bb = [1, 2, 4].map(r => at(0.5 + r * 0.5, 0.5, 3));
    const X = at(0.5 + 3 * 0.5, 0.5, 3); A.push(X);
    const legs = net.legMinutesFor([CAMP].concat(A, Bb));
    const straight = P.polishDistricts([A, Bb], [48, 48], CAMP, { polishRideBudgetMin: 0 });
    const road = P.polishDistricts([A, Bb], [48, 48], CAMP, { polishRideBudgetMin: 0, legMinutes: legs });
    assert.strictEqual(road.buckets[1].includes(X), true, 'on street times X rides the east-bank bus');
    assert.ok(road.fleetAfter < road.fleetBefore - 1, 'fleet minutes on the road fell: ' + road.fleetBefore.toFixed(1) + ' -> ' + road.fleetAfter.toFixed(1));
    assert.strictEqual(road.buckets.flat().length, 7, 'every atom once');
    assert.ok(straight.buckets.flat().length === 7, 'straight-line run is still valid');
});
