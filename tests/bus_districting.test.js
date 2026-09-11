// node --test tests/bus_districting.test.js
//
// Districting must keep every bus on ONE side of camp. The camp's complaint:
// "a bus leaves camp, goes north, then completely turns around and goes
// south." With a tight fleet the greedy packer used to hand the last
// neighbourhood pieces to whichever buses still had seats, which put one bus
// 4mi north AND 4mi south of camp; the sweep alternative never built because
// filling neighbourhood-sized pieces in bearing order overflowed the last bus.
//
// These pin the capacity-aware sweep in packIntoBuses on a layout shaped like
// the real camp (dense core, four towns around it, one far township) with the
// fleet 94% full. packIntoBuses is pure — no road graph, no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.window = global.window || {};
eval(fs.readFileSync(path.join(__dirname, '..', 'campistry_go_route_post.js'), 'utf8'));   // sweepPartition
eval(fs.readFileSync(path.join(__dirname, '..', 'campistry_go_neighborhoods.js'), 'utf8'));
const NH = global.window.CampistryGoNeighborhoods;

const CAMP = { lat: 40.0933, lng: -74.2110 };
const MI_LAT = 1 / 69, MI_LNG = 1 / (69 * Math.cos(CAMP.lat * Math.PI / 180));
const R = 3958.8, tR = x => x * Math.PI / 180;
function hav(a, b, c, d) {
    const dLat = tR(c - a), dLng = tR(d - b);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(tR(a)) * Math.cos(tR(c)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}
const bearing = p => Math.atan2(p.lng - CAMP.lng, p.lat - CAMP.lat);
const angDiff = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
function arcDeg(points) {
    const bs = points.filter(p => hav(CAMP.lat, CAMP.lng, p.lat, p.lng) >= 1.5).map(bearing);
    if (bs.length < 2) return 0;
    bs.sort((a, b) => a - b);
    let gap = bs[0] + 2 * Math.PI - bs[bs.length - 1];
    for (let i = 1; i < bs.length; i++) gap = Math.max(gap, bs[i] - bs[i - 1]);
    return (2 * Math.PI - gap) * 180 / Math.PI;
}

// Deterministic layout — no Math.random, so the assertions are stable.
function buildCamp(spec, seed0) {
    let seed = seed0; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let segSeq = 0; const homes = [], segments = [], neighborhoods = [];
    for (const [id, offMiN, offMiE, radiusMi, campers] of spec) {
        const cLat = CAMP.lat + offMiN * MI_LAT, cLng = CAMP.lng + offMiE * MI_LNG;
        const segIds = []; let placed = 0;
        while (placed < campers) {
            const n = Math.min(3, campers - placed);
            const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radiusMi;
            const sLat = cLat + Math.cos(ang) * r * MI_LAT, sLng = cLng + Math.sin(ang) * r * MI_LNG;
            const sid = 'seg' + (segSeq++); const segHomes = [];
            for (let i = 0; i < n; i++) {
                const h = { neighborhoodId: id, segmentId: sid, lat: sLat + (rnd() - .5) * 0.0015, lng: sLng + (rnd() - .5) * 0.0015 };
                homes.push(h); segHomes.push(h);
            }
            segments.push({ id: sid, neighborhoodId: id, homes: segHomes });
            segIds.push(sid); placed += n;
        }
        neighborhoods.push({ id, segmentIds: segIds, camperCount: campers });
    }
    return { homes, segments, neighborhoods };
}
const TOWNS = [['CORE', 0.3, 0.2, 1.8, 300], ['NORTH', 4.6, 0.4, 1.2, 80], ['SOUTH', -4.0, -0.3, 1.2, 70],
               ['EAST', 0.5, 3.6, 1.0, 50], ['WEST', -0.4, -4.1, 1.0, 45], ['FARNW', 5.2, -5.8, 1.6, 40]];

function pack(spec, fleet, cap, seed, caps) {
    const result = buildCamp(spec, seed);
    const buses = []; for (let i = 0; i < fleet; i++) buses.push({ id: 'bus' + (i + 1), capacity: caps ? caps[i] : cap });
    const out = NH.packIntoBuses({ result, buses, depot: CAMP, rideSpeedMph: 25, rideStopMin: 2, maxChildRideMin: 60 });
    const segPt = {}; for (const s of result.segments) segPt[s.id] = s.homes[0];
    const rows = out.map(b => ({
        busId: b.busId, campers: b.camperCount, cap: buses.find(x => x.id === b.busId).capacity,
        arc: arcDeg(b.segmentIds.map(sid => segPt[sid])),
        segs: b.segmentIds,
    }));
    return { rows, total: result.homes.length, placed: out.reduce((a, b) => a + b.camperCount, 0), segCount: result.segments.length };
}

test('tight fleet (94% full): every bus stays on one side of camp, everyone is seated', () => {
    const r = pack(TOWNS, 13, 48, 20260911);
    assert.strictEqual(r.placed, r.total, 'every camper is on a bus');
    assert.strictEqual(r.rows.filter(x => x.campers > x.cap).length, 0, 'no bus over its seats');
    const straddlers = r.rows.filter(x => x.arc > 110);
    assert.deepStrictEqual(straddlers.map(x => x.busId + ':' + Math.round(x.arc)), [], 'no bus may serve both sides of camp');
    assert.ok(Math.max(...r.rows.map(x => x.arc)) < 90, 'widest bus arc should be well under a right angle');
});

test('no segment is on two buses and none is lost', () => {
    const r = pack(TOWNS, 13, 48, 20260911);
    const seen = new Set();
    for (const row of r.rows) for (const sid of row.segs) { assert.ok(!seen.has(sid), sid + ' on two buses'); seen.add(sid); }
    assert.strictEqual(seen.size, r.segCount);
});

test('different seeds and fleet sizes never straddle when the fleet can seat everyone', () => {
    for (const seed of [1, 2, 3]) for (const fleet of [13, 14, 16]) {
        const r = pack(TOWNS, fleet, 48, 20260900 + seed);
        assert.strictEqual(r.placed, r.total, `seed ${seed} fleet ${fleet}: all placed`);
        assert.strictEqual(r.rows.filter(x => x.campers > x.cap).length, 0, `seed ${seed} fleet ${fleet}: capacity`);
        assert.strictEqual(r.rows.filter(x => x.arc > 110).length, 0, `seed ${seed} fleet ${fleet}: straddle`);
    }
});

test('mixed bus sizes: the sweep respects each bus\'s own seat count', () => {
    const caps = [54, 54, 54, 48, 48, 48, 48, 44, 44, 44, 40, 40, 40];
    const r = pack(TOWNS, 13, 48, 6, caps);
    assert.strictEqual(r.placed, r.total);
    assert.strictEqual(r.rows.filter(x => x.campers > x.cap).length, 0);
    assert.strictEqual(r.rows.filter(x => x.arc > 110).length, 0);
});

test('a loose fleet keeps the greedy districting (prior-year stability) and still does not straddle', () => {
    const r = pack(TOWNS, 15, 48, 20260911);
    assert.strictEqual(r.placed, r.total);
    assert.strictEqual(r.rows.filter(x => x.arc > 110).length, 0);
});

test('two huge buses covering a ring of towns legitimately take half the compass each', () => {
    const RING = [['N', 3, 0, 1, 60], ['NE', 2.2, 2.2, 1, 60], ['E', 0, 3, 1, 60], ['SE', -2.2, 2.2, 1, 60],
                  ['S', -3, 0, 1, 60], ['SW', -2.2, -2.2, 1, 60], ['W', 0, -3, 1, 60], ['NW', 2.2, -2.2, 1, 60]];
    const r = pack(RING, 2, 300, 12);
    assert.strictEqual(r.placed, r.total);
    assert.strictEqual(r.rows.length, 2);
    // each bus is one contiguous half — never interleaved quarters (arc would be ~180 either way,
    // so check contiguity: the bearings of one bus's segments all fall in one half-plane)
    for (const row of r.rows) {
        const result = buildCamp(RING, 12); const segPt = {}; for (const s of result.segments) segPt[s.id] = s.homes[0];
        const bs = row.segs.map(sid => bearing(segPt[sid])).sort((a, b) => a - b);
        // A contiguous wedge leaves ONE large empty gap in its bearings (interleaved
        // quarters leave two ~90deg gaps). Allow an uneven 5/3 split of the towns.
        let gap = 0; for (let i = 1; i < bs.length; i++) gap = Math.max(gap, bs[i] - bs[i - 1]);
        gap = Math.max(gap, bs[0] + 2 * Math.PI - bs[bs.length - 1]);
        assert.ok(gap * 180 / Math.PI > 120, row.busId + ' is not one contiguous wedge of the ring (largest gap ' + Math.round(gap * 180 / Math.PI) + 'deg)');
    }
});
