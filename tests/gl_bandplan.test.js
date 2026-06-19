// node --test tests/gl_bandplan.test.js
'use strict';
const assert = require('assert');
const { test } = require('node:test');
const GLBandPlan = require('../gl_bandplan.js');

const canon = GLBandPlan.canonDefault;
function tile(o) { return { kind: o.k, subcat: o.sub || null, startMin: o.s, endMin: o.e }; }
function bunk(tiles) { return { tiles: tiles.map(tile) }; }

test('categoryOf: specials key by canon subcat; sport/swim/activity by kind; walls null', () => {
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'special', subcat: 'Food' }, canon), 'special:food');
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'special', subcat: 'Regular' }, canon), 'special:uncategorized');
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'special', subcat: null }, canon), 'special:uncategorized');
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'sport' }, canon), 'sport');
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'swim' }, canon), 'swim');
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'lunch' }, canon), null);
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'change' }, canon), null);
});

test('peakOverlap: touching intervals do not overlap; nested do', () => {
    assert.strictEqual(GLBandPlan.peakOverlap([[0, 40], [40, 80]]).peak, 1);   // touching
    assert.strictEqual(GLBandPlan.peakOverlap([[0, 40], [20, 60]]).peak, 2);   // overlap
    assert.strictEqual(GLBandPlan.peakOverlap([[0, 40], [0, 40], [0, 40]]).peak, 3); // stacked
    assert.deepStrictEqual(GLBandPlan.peakOverlap([[0, 40], [0, 40]]).at, [0, 40]);
});

test('measure: 3 grades all on special:uncategorized at same band, supply 1 → peak 3, over 2', () => {
    const bunks = [0, 1, 2].map(() => bunk([{ k: 'special', sub: 'Regular', s: 0, e: 40 }]));
    const r = GLBandPlan.measure({ bunks, supply: { 'special:uncategorized': 1 }, canon });
    const c = r.cats['special:uncategorized'];
    assert.strictEqual(c.peak, 3);
    assert.strictEqual(c.supply, 1);
    assert.strictEqual(c.over, 2);
    assert.deepStrictEqual(c.overWindows, [{ s: 0, e: 40, demand: 3 }]);
    assert.ok(r.overCats.includes('special:uncategorized'));
});

test('measure: theme supply 1 with 7 grades concurrent → peak 7 over 6 (the hard bottleneck)', () => {
    const bunks = [0, 1, 2, 3, 4, 5, 6].map(() => bunk([{ k: 'special', sub: 'Theme', s: 100, e: 140 }]));
    const r = GLBandPlan.measure({ bunks, supply: { 'special:theme': 1 }, canon });
    assert.strictEqual(r.cats['special:theme'].peak, 7);
    assert.strictEqual(r.cats['special:theme'].over, 6);
});

test('measure: a category with no supply entry (sport) is treated as ∞ — never over', () => {
    const bunks = [0, 1, 2, 3, 4].map(() => bunk([{ k: 'sport', s: 0, e: 40 }]));
    const r = GLBandPlan.measure({ bunks, supply: { 'special:theme': 1 }, canon });
    assert.strictEqual(r.cats['sport'].peak, 5);
    assert.strictEqual(r.cats['sport'].supply, null);
    assert.strictEqual(r.cats['sport'].over, 0);
    assert.strictEqual(r.overCats.length, 0);
});

test('measure: SPREAD across bands eliminates the collision (peak ≤ supply → no overflow)', () => {
    // 3 grades on theme but each in a DIFFERENT band → peak 1, supply 1, 0 over
    const bunks = [
        bunk([{ k: 'special', sub: 'Theme', s: 0, e: 40 }]),
        bunk([{ k: 'special', sub: 'Theme', s: 40, e: 80 }]),
        bunk([{ k: 'special', sub: 'Theme', s: 80, e: 120 }]),
    ];
    const r = GLBandPlan.measure({ bunks, supply: { 'special:theme': 1 }, canon });
    assert.strictEqual(r.cats['special:theme'].peak, 1);
    assert.strictEqual(r.cats['special:theme'].over, 0);
    assert.strictEqual(r.totalOverMin, 0);
    assert.strictEqual(r.overCats.length, 0);
});

test('measure: partial overlap reports only the over-supply window + tile-min overflow', () => {
    // food supply 2; three bunks overlap [20,40] (peak 3) but only one at the edges
    const bunks = [
        bunk([{ k: 'special', sub: 'Food', s: 0, e: 40 }]),
        bunk([{ k: 'special', sub: 'Food', s: 20, e: 60 }]),
        bunk([{ k: 'special', sub: 'Food', s: 20, e: 40 }]),
    ];
    const r = GLBandPlan.measure({ bunks, supply: { 'special:food': 2 }, canon });
    const c = r.cats['special:food'];
    assert.strictEqual(c.peak, 3);
    assert.strictEqual(c.over, 1);
    assert.deepStrictEqual(c.overWindows, [{ s: 20, e: 40, demand: 3 }]); // only where 3>2
    assert.strictEqual(c.overMin, 20 * 1); // 20 min × (3-2)
});

test('measure: mixed categories ranked by overflow; non-hardcoded category set', () => {
    const bunks = [
        bunk([{ k: 'special', sub: 'Theme', s: 0, e: 40 }, { k: 'special', sub: 'Food', s: 40, e: 80 }]),
        bunk([{ k: 'special', sub: 'Theme', s: 0, e: 40 }, { k: 'special', sub: 'Food', s: 40, e: 80 }]),
        bunk([{ k: 'special', sub: 'Shiur', s: 0, e: 40 }]),  // a 3rd subcat — discovered dynamically
    ];
    const r = GLBandPlan.measure({ bunks, supply: { 'special:theme': 1, 'special:food': 1, 'special:shiur': 5 }, canon });
    assert.ok(r.cats['special:shiur']);                 // dynamic category key, no hardcoding
    assert.strictEqual(r.cats['special:shiur'].over, 0); // 1 ≤ 5
    assert.ok(r.overCats.includes('special:theme'));
    assert.ok(r.overCats.includes('special:food'));
});
