// node --test tests/bus_stop_modes.test.js
//
// Go offers three drop-off modes. They must all be REAL and they must not
// change who rides which bus -- the mode decides only where the bus physically
// stops; districting happens earlier, in packIntoBuses.
//
// Regressions this pins:
//   * 'optimized-stops' used to fall through to the door-to-door branch, so
//     choosing it in the UI changed nothing whatsoever.
//   * 'corner-stops' emitted one stop per ROAD SEGMENT. The graph chops one
//     street into many short segments, so it produced MORE stops than
//     door-to-door (310 vs 199 on the camp's real data) and never used a real
//     intersection. The camp's own historical routes are 263 stops at 3.14
//     children each, every one named "Street@Street".

const test = require('node:test');
const assert = require('node:assert');
const fs2 = require('fs');
const path = require('path');

global.window = global.window || {};
eval(fs2.readFileSync(path.join(__dirname, '..', 'campistry_go_route_post.js'), 'utf8'));
eval(fs2.readFileSync(path.join(__dirname, '..', 'campistry_go_neighborhoods.js'), 'utf8'));
const NH = global.window.CampistryGoNeighborhoods;

// A small grid of streets so segments, intersections and homes are all real.
function buildFixture() {
    const nodes = {}, segments = [], homes = [];
    const streets = ['Oak St', 'Elm St', 'Pine St'];
    const cross = ['1st Ave', '2nd Ave', '3rd Ave'];
    let nodeId = 1, segId = 1, kid = 1;
    // intersection grid
    const grid = {};
    streets.forEach((st, si) => cross.forEach((cs, ci) => {
        const id = 'n' + (nodeId++);
        nodes[id] = { id, lat: 40.10 + si * 0.004, lng: -74.20 + ci * 0.004,
                      streets: [st, cs], degree: 4 };
        grid[si + '_' + ci] = id;
    }));
    // one segment between consecutive intersections along each street
    streets.forEach((st, si) => {
        for (let ci = 0; ci < cross.length - 1; ci++) {
            const from = grid[si + '_' + ci], to = grid[si + '_' + (ci + 1)];
            const segHomes = [];
            for (let k = 0; k < 3; k++) {
                const t = (k + 1) / 4;
                const h = {
                    camperName: 'Kid' + (kid++), division: 'D', bunk: 'B',
                    lat: nodes[from].lat + 0.0002,
                    lng: nodes[from].lng + (nodes[to].lng - nodes[from].lng) * t,
                    address: (100 + k) + ' ' + st, houseNum: String(100 + k), t,
                    neighborhoodId: 'nh1', segmentId: 's' + segId,
                };
                homes.push(h); segHomes.push(h);
            }
            segments.push({ id: 's' + (segId++), neighborhoodId: 'nh1',
                            fromNodeId: from, toNodeId: to, name: st, homes: segHomes });
        }
    });
    const neighborhoods = [{ id: 'nh1', segmentIds: segments.map(s => s.id),
                             camperCount: homes.length }];
    return { nodes, segments, homes, neighborhoods };
}

const result = buildFixture();
const assignment = [{ busId: 'bus1', name: 'Bus 1',
                      segmentIds: result.segments.map(s => s.id),
                      neighborhoodIds: ['nh1'],
                      camperCount: result.homes.length }];

function run(dropoffMode, maxWalkMi) {
    const out = NH.expandToPhysicalStops({ assignment, result, dropoffMode, maxWalkMi });
    const stops = out[0].stops;
    const riders = [];
    stops.forEach(s => (s.campers || []).forEach(c => riders.push(c.name)));
    return { stops, riders };
}

test('every mode carries exactly the same children', () => {
    const total = result.homes.length;
    const door = run('door-to-door', 0.25);
    const corner = run('corner-stops', 0.25);
    const opt = run('optimized-stops', 0.25);
    for (const [name, r] of [['door', door], ['corner', corner], ['optimized', opt]]) {
        assert.strictEqual(r.riders.length, total, name + ' must carry every child');
        assert.strictEqual(new Set(r.riders).size, total, name + ' must not duplicate a child');
    }
});

test('door-to-door is one stop per home', () => {
    const door = run('door-to-door', 0.25);
    assert.strictEqual(door.stops.length, result.homes.length);
});

test('corner-stops consolidates and names a real intersection', () => {
    const door = run('door-to-door', 0.25);
    const corner = run('corner-stops', 0.25);
    assert.ok(corner.stops.length < door.stops.length,
        'corner should have FEWER stops than door-to-door, got ' +
        corner.stops.length + ' vs ' + door.stops.length);
    const named = corner.stops.filter(s => / @ /.test(s.address || ''));
    assert.ok(named.length > 0, 'expected Street @ Cross names, got: ' +
        corner.stops.map(s => s.address).join(' | '));
    // every stop should sit on one of the graph's intersections
    const interKeys = new Set(Object.values(result.nodes)
        .map(n => n.lat.toFixed(5) + ',' + n.lng.toFixed(5)));
    const onCorner = corner.stops.filter(s =>
        interKeys.has(s.lat.toFixed(5) + ',' + s.lng.toFixed(5)));
    assert.ok(onCorner.length >= corner.stops.length - 1,
        'corner stops should sit on real intersections');
});

test('optimized-stops is its own mode, not a copy of door-to-door', () => {
    const door = run('door-to-door', 0.25);
    const opt = run('optimized-stops', 0.25);
    assert.ok(opt.stops.length < door.stops.length,
        'optimized should consolidate; got ' + opt.stops.length + ' vs ' + door.stops.length);
});

test('a wider walk allowance yields fewer, fuller stops', () => {
    const tight = run('corner-stops', 0.05);
    const wide = run('corner-stops', 0.40);
    assert.ok(wide.stops.length <= tight.stops.length,
        'wider walk should not increase stop count: ' +
        wide.stops.length + ' vs ' + tight.stops.length);
});

test('no stop exceeds the 15-child cap', () => {
    for (const m of ['corner-stops', 'optimized-stops']) {
        run(m, 0.5).stops.forEach(s =>
            assert.ok((s.campers || []).length <= 15, m + ' stop over cap'));
    }
});

test('a corner gathers children from different streets when they are within the walk allowance', () => {
    // Oak St and Elm St are 0.004° (~0.28mi) apart in the fixture; with a
    // 0.30mi walk the two streets' homes near the same cross avenue share a
    // corner. Grouping by street first could never do this.
    const corner = run('corner-stops', 0.30);
    const mixed = corner.stops.filter(s => {
        const streets = new Set((s.campers || []).map(c => String(c.name)).map(n => {
            const h = result.homes.find(x => x.camperName === n); return h && h.address.replace(/^\d+\s+/, '');
        }));
        return streets.size > 1;
    });
    assert.ok(mixed.length > 0, 'expected at least one corner shared by two streets, got: ' +
        corner.stops.map(s => s.address + ' x' + (s.campers || []).length).join(' | '));
    const opt = run('optimized-stops', 0.30);
    assert.ok(corner.stops.length <= opt.stops.length + 1,
        'corner mode should not need more stops than walk groups: ' + corner.stops.length + ' vs ' + opt.stops.length);
});

test('walk groups are compact: every child within the allowance of the stop centre', () => {
    for (const m of ['corner-stops', 'optimized-stops']) for (const walk of [0.05, 0.15, 0.30]) {
        run(m, walk).stops.forEach(s => {
            const hs = (s.campers || []).map(c => result.homes.find(x => x.camperName === c.name));
            const cLat = hs.reduce((a, h) => a + h.lat, 0) / hs.length, cLng = hs.reduce((a, h) => a + h.lng, 0) / hs.length;
            for (const h of hs) assert.ok(window.CampistryGoRoutePost.haversineMi(cLat, cLng, h.lat, h.lng) <= walk + 1e-9,
                m + ' walk ' + walk + ': a child is further than the allowance from the group centre');
        });
    }
});

test('corner stops carry their homes, and a merged stop re-snaps to the corner nearest all of them', () => {
    const corner = run('corner-stops', 0.05);
    for (const st of corner.stops) {
        assert.ok(Array.isArray(st._homes) && st._homes.length === (st.campers || []).length, 'every corner stop carries one home per child');
        assert.ok(Number.isFinite(st._cLat) && Number.isFinite(st._cLng), 'and the centre of those homes');
    }
    // merge two stops the way the pipeline's consolidation does, then re-snap
    const a = corner.stops[0], b = corner.stops.find(s => s !== a && s.address !== a.address) || corner.stops[1];
    const merged = { campers: a.campers.concat(b.campers), _homes: a._homes.concat(b._homes) };
    const snapper = NH.cornerSnapper(result, 0.30);
    snapper.snap(merged);
    const interKeys = new Set(Object.values(result.nodes).map(n => n.lat.toFixed(5) + ',' + n.lng.toFixed(5)));
    assert.ok(interKeys.has(merged.lat.toFixed(5) + ',' + merged.lng.toFixed(5)), 'the merged stop sits on a real intersection');
    assert.ok(/ @ | corner$/.test(merged.address), 'and is named as a corner: ' + merged.address);
    // the corner chosen minimises the children's total walk among corners within reach
    const tot = n => merged._homes.reduce((s, h) => s + window.CampistryGoRoutePost.haversineMi(h.lat, h.lng, n.lat, n.lng), 0);
    const chosen = Object.values(result.nodes).find(n => n.lat.toFixed(5) === merged.lat.toFixed(5) && n.lng.toFixed(5) === merged.lng.toFixed(5));
    const reachable = Object.values(result.nodes).filter(n => window.CampistryGoRoutePost.haversineMi(merged._cLat, merged._cLng, n.lat, n.lng) <= 0.30);
    const best = Math.min(...reachable.map(tot));
    assert.ok(tot(chosen) <= best + 0.05, 'chosen corner walk ' + tot(chosen).toFixed(3) + ' vs best ' + best.toFixed(3));
});
