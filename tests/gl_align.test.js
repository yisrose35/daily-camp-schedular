// node --test tests/gl_align.test.js
'use strict';
const assert = require('assert');
const { test } = require('node:test');
const GLAlign = require('../gl_align.js');

const canon = v => { const s = String(v == null ? '' : v).toLowerCase().trim(); return (!s || s === 'regular' || s === 'uncategorized') ? 'uncategorized' : s; };

// helper: build a bunk with tiles [{k,sub,d,s,e}]
function bunk(tiles) {
    return {
        tiles: tiles.map(t => ({
            kind: t.k, subcat: t.sub || null, name: t.name || (t.k === 'special' ? ('Special: ' + (t.sub || '')) : 'Sport'),
            durationMin: t.d, startMin: t.s, endMin: t.e, generic: t.generic !== false
        }))
    };
}
function distinctStarts(bunks, S) {
    const set = {};
    bunks.forEach(b => b.tiles.forEach(t => { if (t.kind === 'special' && canon(t.subcat) === S) set[t.startMin + '@' + t.endMin] = 1; }));
    return Object.keys(set).length;
}
function countSub(b, S) { return b.tiles.filter(t => t.kind === 'special' && canon(t.subcat) === S).length; }
function countSport(b) { return b.tiles.filter(t => t.kind === 'sport').length; }
function concurrentAt(bunks, S, s, e) { let c = 0; bunks.forEach(b => b.tiles.forEach(t => { if (t.kind === 'special' && canon(t.subcat) === S && t.startMin === s && t.endMin === e) c++; })); return c; }

test('clusters 3 scattered theme tiles onto one common band → sessions 3→1, 2 swaps', () => {
    // each bunk has 1 theme (at a different band) + 2 sports at the OTHER two bands
    const bunks = [
        bunk([{ k: 'special', sub: 'theme activity', d: 10, s: 0, e: 10 }, { k: 'sport', d: 10, s: 20, e: 30 }, { k: 'sport', d: 10, s: 40, e: 50 }]),
        bunk([{ k: 'sport', d: 10, s: 0, e: 10 }, { k: 'special', sub: 'theme activity', d: 10, s: 20, e: 30 }, { k: 'sport', d: 10, s: 40, e: 50 }]),
        bunk([{ k: 'sport', d: 10, s: 0, e: 10 }, { k: 'sport', d: 10, s: 20, e: 30 }, { k: 'special', sub: 'theme activity', d: 10, s: 40, e: 50 }]),
    ];
    assert.strictEqual(distinctStarts(bunks, 'theme activity'), 3);
    const r = GLAlign.align({ bunks, sharableSubcats: { 'theme activity': 15 }, canon, apply: true });
    assert.strictEqual(r.plan.totalSwaps, 2, 'two off-band tiles moved onto the anchor band');
    assert.strictEqual(distinctStarts(bunks, 'theme activity'), 1, 'all theme now on one band');
    // per-bunk counts preserved: still 1 theme + 2 sports each
    bunks.forEach(b => { assert.strictEqual(countSub(b, 'theme activity'), 1); assert.strictEqual(countSport(b), 2); });
    // the single surviving band holds all 3 concurrently (which band is algorithm-chosen)
    const themeTiles = bunks.flatMap(b => b.tiles.filter(t => t.kind === 'special' && canon(t.subcat) === 'theme activity'));
    assert.strictEqual(themeTiles.length, 3);
    assert.strictEqual(concurrentAt(bunks, 'theme activity', themeTiles[0].startMin, themeTiles[0].endMin), 3);
});

test('respects cap: cap 2, 3 scattered tiles → at most 2 on a band → sessions 3→2', () => {
    const bunks = [
        bunk([{ k: 'special', sub: 'theme activity', d: 10, s: 0, e: 10 }, { k: 'sport', d: 10, s: 20, e: 30 }, { k: 'sport', d: 10, s: 40, e: 50 }]),
        bunk([{ k: 'sport', d: 10, s: 0, e: 10 }, { k: 'special', sub: 'theme activity', d: 10, s: 20, e: 30 }, { k: 'sport', d: 10, s: 40, e: 50 }]),
        bunk([{ k: 'sport', d: 10, s: 0, e: 10 }, { k: 'sport', d: 10, s: 20, e: 30 }, { k: 'special', sub: 'theme activity', d: 10, s: 40, e: 50 }]),
    ];
    const r = GLAlign.align({ bunks, sharableSubcats: { 'theme activity': 2 }, canon, apply: true });
    // anchor band can hold 2 (1 already + 1 moved); the 3rd cannot join → 1 swap
    assert.ok(concurrentAt(bunks, 'theme activity', 0, 10) <= 2, 'never exceeds cap 2');
    assert.ok(distinctStarts(bunks, 'theme activity') < 3, 'reduced below 3');
    assert.ok(distinctStarts(bunks, 'theme activity') >= 2, 'cannot collapse fully under cap 2');
    bunks.forEach(b => { assert.strictEqual(countSub(b, 'theme activity'), 1); assert.strictEqual(countSport(b), 2); });
});

test('no swap target (no equal-dur sport at the band) → no change', () => {
    // bunk2's theme is at [20,30] but it has NO sport at [0,10] (the anchor) → cannot move
    const bunks = [
        bunk([{ k: 'special', sub: 'theme activity', d: 10, s: 0, e: 10 }, { k: 'special', sub: 'food', d: 10, s: 20, e: 30 }]),
        bunk([{ k: 'special', sub: 'food', d: 10, s: 0, e: 10 }, { k: 'special', sub: 'theme activity', d: 10, s: 20, e: 30 }]),
    ];
    const snap = JSON.stringify(bunks);
    const r = GLAlign.align({ bunks, sharableSubcats: { 'theme activity': 15 }, canon, apply: true });
    assert.strictEqual(r.plan.totalSwaps, 0);
    assert.strictEqual(JSON.stringify(bunks), snap, 'unchanged — no sport tile to swap onto');
});

test('shadow mode (apply:false) does NOT mutate tiles but projects the reduction', () => {
    const bunks = [
        bunk([{ k: 'special', sub: 'theme activity', d: 10, s: 0, e: 10 }, { k: 'sport', d: 10, s: 20, e: 30 }]),
        bunk([{ k: 'sport', d: 10, s: 0, e: 10 }, { k: 'special', sub: 'theme activity', d: 10, s: 20, e: 30 }]),
    ];
    const snap = JSON.stringify(bunks);
    const r = GLAlign.align({ bunks, sharableSubcats: { 'theme activity': 15 }, canon, apply: false });
    assert.strictEqual(JSON.stringify(bunks), snap, 'tiles unchanged in shadow mode');
    assert.strictEqual(r.applied, 0);
    assert.ok(r.plan.subcats[0].sessionsAfter < r.plan.subcats[0].sessionsBefore, 'plan projects a reduction (2→1)');
});

test('equal-duration only: a 20-min theme is NOT moved onto a 10-min sport', () => {
    const bunks = [
        bunk([{ k: 'special', sub: 'theme activity', d: 20, s: 0, e: 20 }, { k: 'sport', d: 10, s: 30, e: 40 }]),
        bunk([{ k: 'sport', d: 10, s: 0, e: 10 }, { k: 'special', sub: 'theme activity', d: 20, s: 30, e: 50 }]),
    ];
    const r = GLAlign.align({ bunks, sharableSubcats: { 'theme activity': 15 }, canon, apply: true });
    assert.strictEqual(r.plan.totalSwaps, 0, 'durations/bands do not line up → no legal swap');
});

test('never swaps onto a CONCRETE (already-filled) sport', () => {
    // both candidate swap targets are already filled → consolidation is fully blocked
    const bunks = [
        bunk([{ k: 'special', sub: 'theme activity', d: 10, s: 0, e: 10 }, { k: 'sport', d: 10, s: 20, e: 30, generic: false }]),
        bunk([{ k: 'sport', d: 10, s: 0, e: 10, generic: false }, { k: 'special', sub: 'theme activity', d: 10, s: 20, e: 30 }]),
    ];
    bunks[0].tiles[1]._concrete = 'Soccer';        // bunk0's only target ([20,30]) is filled
    bunks[1].tiles[0]._concrete = 'Basketball';    // bunk1's only target ([0,10]) is filled
    const r = GLAlign.align({ bunks, sharableSubcats: { 'theme activity': 15 }, canon, apply: true });
    assert.strictEqual(r.plan.totalSwaps, 0, 'both swap targets are concrete → no legal move');
    assert.strictEqual(bunks[0].tiles[1]._concrete, 'Soccer', 'concrete tile untouched');
    assert.strictEqual(bunks[1].tiles[0]._concrete, 'Basketball', 'concrete tile untouched');
});

test('stress: 20 bunks × scattered theme + sports — terminates, sessions drop, invariants hold', () => {
    const bunks = [];
    const bands = [[0, 10], [20, 30], [40, 50], [60, 70], [80, 90]];
    for (let b = 0; b < 20; b++) {
        const themeBand = bands[b % bands.length];
        const tiles = bands.map(([s, e]) =>
            (s === themeBand[0])
                ? { k: 'special', sub: 'theme activity', d: 10, s, e }
                : { k: 'sport', d: 10, s, e });
        bunks.push(bunk(tiles));
    }
    const before = distinctStarts(bunks, 'theme activity');
    const snapCounts = bunks.map(b => [countSub(b, 'theme activity'), countSport(b)]);
    const r = GLAlign.align({ bunks, sharableSubcats: { 'theme activity': 15 }, canon, apply: true });
    const after = distinctStarts(bunks, 'theme activity');
    assert.ok(before > 1, 'precondition: scattered (' + before + ' sessions)');
    assert.ok(after < before, 'sessions reduced (' + before + '→' + after + ')');
    assert.ok(after <= Math.ceil(20 / 15), 'collapses toward ceil(20/cap) = 2');
    bunks.forEach((b, i) => {
        assert.strictEqual(countSub(b, 'theme activity'), snapCounts[i][0], 'theme count preserved');
        assert.strictEqual(countSport(b), snapCounts[i][1], 'sport count preserved');
        const occ = b.tiles.map(t => [t.startMin, t.endMin]).sort((x, y) => x[0] - y[0]);
        for (let k = 1; k < occ.length; k++) assert.ok(occ[k][0] >= occ[k - 1][1], 'no overlap within a bunk');
    });
    // every shared band stays within cap
    [...new Set(bunks.flatMap(b => b.tiles.filter(t => t.kind === 'special' && canon(t.subcat) === 'theme activity').map(t => t.startMin + '@' + t.endMin)))]
        .forEach(key => { const [s, e] = key.split('@').map(Number); assert.ok(concurrentAt(bunks, 'theme activity', s, e) <= 15, 'band within cap'); });
});
