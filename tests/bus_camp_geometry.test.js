// node --test tests/bus_camp_geometry.test.js
//
// Replays two real generated route sets (bare geometry: camp, per bus the
// stops as [lat, lng, children, minute]; no names, no addresses) through the
// pure post-routing passes. These pin what every change must keep: every
// child exactly once, seats, containment, the cap honoured by the passes
// that promise it, and the same input giving the same routes twice.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.window = global.window || {};
eval(fs.readFileSync(path.join(__dirname, '..', 'campistry_go_route_post.js'), 'utf8'));
const P = global.window.CampistryGoRoutePost;

function load(name) {
    const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
    const camp = { lat: G.camp[0], lng: G.camp[1] };
    const names = Object.keys(G.buses);
    const buckets = names.map(n => G.buses[n].stops.map((s, i) => ({
        lat: s[0], lng: s[1], count: s[2], address: n + '#' + (i + 1),
        campers: Array.from({ length: s[2] }, (_, j) => ({ name: n + '/' + i + '/' + j })),
    })));
    const caps = names.map(() => (G.cap || 48) - (G.reserve || 0));
    return { G, camp, names, buckets, caps };
}
const kids = b => b.reduce((a, x) => a + x.count, 0);
const opts = (G, extra) => Object.assign({
    avgSpeedMph: G.avgSpeed || 25, avgStopMin: G.stopMin || 1, roadFactor: 1.67, legFixedMin: 0.7, busOverheadMin: 0, returnToDepot: false,
    polishRideBudgetMin: G.maxRouteMin || 70, polishOverBudgetX: 4, polishOverBudgetQuad: 0.5, polishReachMi: 5,
    polishLnsIters: 40, polishMaxWork: 1e12, polishTimeBudgetMs: 120000, polishMergeAnyMi: 0.01,
}, extra || {});
const solo = (G, camp, b) => b.length ? P.polishDistricts([b, []], [46, 46], camp, opts(G, { polishMaxPasses: 0, polishRideBudgetMin: 0, polishLnsIters: 0 })).fleetBefore : 0;

for (const name of ['camp_geometry_a.json', 'camp_geometry_b.json']) {
    test('real map ' + name + ': the polish keeps every invariant and does not make the fleet worse', () => {
        const { G, camp, buckets, caps } = load(name);
        const total = buckets.reduce((a, b) => a + kids(b), 0);
        assert.strictEqual(total, 751);
        const before = buckets.map(b => solo(G, camp, b));
        const res = P.polishDistricts(buckets.map(b => b.slice()), caps, camp, opts(G));
        assert.strictEqual(res.buckets.reduce((a, b) => a + kids(b), 0), total, 'every child exactly once');
        const seen = new Set();
        for (const b of res.buckets) for (const a of b) for (const c of a.campers) { assert.ok(!seen.has(c.name), 'no child twice'); seen.add(c.name); }
        res.buckets.forEach((b, i) => assert.ok(kids(b) <= caps[i], 'seats on bus ' + i + ': ' + kids(b) + '/' + caps[i]));
        res.buckets.forEach((b, i) => {
            const arc = P.arcDeg(b, camp), was = P.arcDeg(buckets[i], camp);
            assert.ok(arc <= 110 + 1e-9 || arc <= was + 1e-9, 'contained (bus ' + i + ': ' + arc.toFixed(0) + '°, was ' + was.toFixed(0) + '°)');
        });
        const after = res.buckets.map(b => solo(G, camp, b));
        const sum = a => a.reduce((x, y) => x + y, 0);
        assert.ok(sum(after) <= sum(before) + 1e-6, 'fleet minutes did not rise: ' + sum(before).toFixed(0) + ' -> ' + sum(after).toFixed(0));
        assert.ok(res.after <= res.before + 1e-6, 'the objective did not rise');
        // no bus is pushed over the cap by a fleet-only hand-off
        const cap = G.maxRouteMin || 70;
        res.buckets.forEach((b, i) => { if (after[i] > cap + 1e-6) assert.ok(before[i] > cap - 1e-6 || after[i] <= Math.max(...before) + 1e-6, 'bus ' + i + ' pushed over the cap: ' + before[i].toFixed(0) + ' -> ' + after[i].toFixed(0)); });
        assert.notStrictEqual(res.stoppedBy, 'time', 'the polish did not need the wall clock');
    });

    test('real map ' + name + ': the same input gives the same routes twice', () => {
        const { G, camp, buckets, caps } = load(name);
        const sig = r => r.buckets.map(b => b.map(a => a.address).join('|')).join('||');
        const r1 = P.polishDistricts(buckets.map(b => b.slice()), caps, camp, opts(G));
        const r2 = P.polishDistricts(buckets.map(b => b.slice()), caps, camp, opts(G));
        assert.strictEqual(sig(r1), sig(r2));
        assert.strictEqual(r1.after, r2.after);
    });

    test('real map ' + name + ': every bus orders to a tour no longer than its input order', () => {
        const { G, camp, buckets } = load(name);
        const tourMin = ord => { let t = 0, prev = camp; for (const s of ord) { t += P.driveMin(prev, s, opts(G)) + P.stopDwellMin(s, opts(G)); prev = s; } return t; };
        for (const b of buckets) {
            const stops = b.map(a => Object.assign({}, a));
            const ord = P.localTspOrder(stops, camp, false, opts(G, { routeCapMin: G.maxRouteMin || 70 }));
            assert.strictEqual(ord.length, stops.length);
            assert.ok(tourMin(ord) <= tourMin(stops) + 2, 'no longer than the stamped order (+2 min slack): ' + tourMin(stops).toFixed(1) + ' -> ' + tourMin(ord).toFixed(1));
        }
    });
}
