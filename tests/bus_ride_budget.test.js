// node --test tests/bus_ride_budget.test.js
//
// Districting is judged by the child who sits on the bus longest, not by miles.
// A district far from camp burns most of its riding-time budget just getting
// there, so filling it to the last seat leaves its final drops riding far longer
// than the rest of the camp. Capacity alone cannot see that.
//
// These tests pin the riding-time budget in packIntoBuses using a layout shaped
// like the real camp that motivated it (dense core, a mid ring, and one township
// ~7 miles out): with a spare bus available the far township is shared and the
// worst ride drops well under an hour; with the budget switched off it is served
// by a single bus and the worst ride is ~80 minutes.
//
// packIntoBuses is pure — it needs no road graph and no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The module publishes itself on `window`.
global.window = global.window || {};
eval(fs.readFileSync(path.join(__dirname, '..', 'campistry_go_neighborhoods.js'), 'utf8'));
const NH = global.window.CampistryGoNeighborhoods;

const CAMP = { lat: 40.0933, lng: -74.2110 };
const MI_LAT = 1 / 69, MI_LNG = 1 / 53; // approx at this latitude
const R = 3958.8, tR = (x) => x * Math.PI / 180;
function hav(a, b, c, d) {
    const dLat = tR(c - a), dLng = tR(d - b);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(tR(a)) * Math.cos(tR(c)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

// Deterministic layout — no Math.random, so the thresholds below are stable.
function buildCamp() {
    let seed = 20260903;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let segSeq = 0;
    const homes = [], segments = [], neighborhoods = [];

    function addCluster(id, offMiN, offMiE, radiusMi, campers) {
        const cLat = CAMP.lat + offMiN * MI_LAT, cLng = CAMP.lng + offMiE * MI_LNG;
        const segIds = [];
        let placed = 0;
        while (placed < campers) {
            const n = Math.min(3, campers - placed);
            const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radiusMi;
            const sLat = cLat + Math.cos(ang) * r * MI_LAT;
            const sLng = cLng + Math.sin(ang) * r * MI_LNG;
            const sid = 'seg' + (segSeq++);
            const segHomes = [];
            for (let i = 0; i < n; i++) {
                const h = { neighborhoodId: id, segmentId: sid,
                    lat: sLat + (rnd() - .5) * 0.0015, lng: sLng + (rnd() - .5) * 0.0015 };
                homes.push(h); segHomes.push(h);
            }
            segments.push({ id: sid, neighborhoodId: id, homes: segHomes });
            segIds.push(sid); placed += n;
        }
        neighborhoods.push({ id, segmentIds: segIds, camperCount: campers });
    }

    addCluster('CORE', 0.4, 0.3, 1.9, 500);
    addCluster('MIDW', 0.2, -3.2, 1.1, 60);
    addCluster('MIDS', -3.0, 0.4, 1.1, 60);
    addCluster('MIDE', 0.6, 3.1, 1.0, 50);
    addCluster('MIDN', 3.0, -0.3, 1.0, 39);
    addCluster('FARTOWN', 2.4, -6.6, 2.7, 42); // ~7mi out, ~5.5mi across
    return { homes, segments, neighborhoods };
}

const SPEED = 25, STOPMIN = 1, ROAD = 1.35, CAP = 48;

// Nearest-neighbour run over a bus's stops, starting at camp.
function busRideMin(segIds, segments) {
    const byId = Object.fromEntries(segments.map((s) => [s.id, s]));
    const pts = [];
    for (const sid of segIds) {
        const s = byId[sid];
        if (!s || !s.homes.length) continue;
        pts.push({
            lat: s.homes.reduce((a, h) => a + h.lat, 0) / s.homes.length,
            lng: s.homes.reduce((a, h) => a + h.lng, 0) / s.homes.length,
        });
    }
    if (!pts.length) return 0;
    let la = CAMP.lat, lo = CAMP.lng, mi = 0;
    const rem = pts.slice();
    while (rem.length) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < rem.length; i++) {
            const d = hav(la, lo, rem[i].lat, rem[i].lng);
            if (d < bd) { bd = d; bi = i; }
        }
        mi += bd; la = rem[bi].lat; lo = rem[bi].lng; rem.splice(bi, 1);
    }
    return (mi * ROAD / SPEED) * 60 + pts.length * STOPMIN;
}

function pack(fleet, maxChildRideMin) {
    const result = buildCamp();
    const buses = [];
    for (let i = 0; i < fleet; i++) buses.push({ id: 'bus' + (i + 1), capacity: CAP });
    const out = NH.packIntoBuses({
        result, buses, depot: CAMP,
        rideSpeedMph: SPEED, rideStopMin: STOPMIN, maxChildRideMin,
    });
    const rows = out.map((b) => ({
        campers: b.camperCount,
        ride: busRideMin(b.segmentIds, result.segments),
        far: b.neighborhoodIds.some((id) => String(id).startsWith('FARTOWN')),
    }));
    return {
        rows,
        worstRide: Math.max(...rows.map((r) => r.ride)),
        farBuses: rows.filter((r) => r.far).length,
        placed: out.reduce((a, b) => a + b.camperCount, 0),
        overCap: out.filter((b) => b.camperCount > CAP).length,
        total: result.neighborhoods.reduce((a, n) => a + n.camperCount, 0),
    };
}

test('riding budget splits a far district across buses when one is spare', () => {
    const r = pack(20, 60);
    assert.strictEqual(r.farBuses, 2, 'the far township should be shared by two buses');
    assert.ok(r.worstRide < 60,
        'worst ride should be under an hour, got ' + Math.round(r.worstRide));
});

test('without the budget the same fleet leaves one bus with the whole far district', () => {
    const withBudget = pack(20, 60);
    const without = pack(20, 0);
    assert.strictEqual(without.farBuses, 1, 'no budget means one bus takes the lot');
    assert.ok(without.worstRide > 75,
        'expected the long ~80min run, got ' + Math.round(without.worstRide));
    assert.ok(withBudget.worstRide < without.worstRide - 20,
        'the budget should cut the worst ride by more than 20 minutes');
});

test('every camper is placed and no bus is over capacity, budget on or off', () => {
    for (const budget of [60, 0]) {
        for (const fleet of [18, 20]) {
            const r = pack(fleet, budget);
            assert.strictEqual(r.placed, r.total,
                'fleet ' + fleet + ' budget ' + budget + ': all campers placed');
            assert.strictEqual(r.overCap, 0,
                'fleet ' + fleet + ' budget ' + budget + ': no bus over capacity');
        }
    }
});

test('a fleet with no spare bus cannot split the far district (documents the limit)', () => {
    // Not a defect: with 18 buses the core and mid ring consume every vehicle, so
    // the township has nowhere to split to. This is the measurement behind the
    // advice to add a bus rather than to keep tuning the packer.
    const r = pack(18, 60);
    assert.strictEqual(r.farBuses, 1);
    assert.ok(r.worstRide > 75, 'got ' + Math.round(r.worstRide));
});
