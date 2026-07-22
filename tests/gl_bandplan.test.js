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

// helper: bunk with grade for enforce tests
function gbunk(grade, tiles) { return { grade, tiles: tiles.map(tile) }; }

test('enforce: over-cap unfilled uncat is pulled down to its seats (excess → sport)', () => {
    // 3 bunks, all uncategorized at the same band; uncat seats=2, sport plenty → 1 → sport
    const bunks = [0, 1, 2].map(i => gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 40 }]));
    const r = GLBandPlan.enforce({ bunks, seats: { 'special:uncategorized': 2, sport: 10 }, seatsByGrade: { G: { 'special:uncategorized': 2 } }, canon });
    assert.strictEqual(r.toSport, 1, 'one excess uncat relabeled to sport');
    const after = GLBandPlan.measure({ bunks, supply: { 'special:uncategorized': 2 }, canon });
    assert.ok(after.cats['special:uncategorized'].peak <= 2, 'uncat now within its 2 seats');
    assert.strictEqual(r.violations.length, 0, 'no residual violation');
});

test('enforce SPORTLESS: an over-cap special in a sportless grade is never pulled down to Sport', () => {
    // same as the "excess → sport" case, but grade G has NO sport layer (sportlessGrades) → the
    // excess uncat must NOT become a Sport. With no other special subcat to take it, it stays.
    const bunks = [0, 1, 2].map(() => gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 40 }]));
    const r = GLBandPlan.enforce({ bunks, seats: { 'special:uncategorized': 2, sport: 10 }, seatsByGrade: { G: { 'special:uncategorized': 2 } }, canon, sportlessGrades: { G: 1 } });
    assert.strictEqual(r.toSport, 0, 'sportless grade: nothing pulled to Sport');
    assert.ok(bunks.every(b => b.tiles.every(t => t.kind !== 'sport')), 'no sport tiles at all');
    // none can move (no sport allowed + no other subcat) → genuine over-capacity reported, not hidden as Sport
    assert.strictEqual(r.left, 3, 'all over-cap tiles left in place (honest residual) rather than relabeled to Sport');
});

test('enforce: per-grade cap is honored even when camp-wide has room', () => {
    // grade G can only access 1 uncat activity (Shiur-style restriction) though camp-wide is 5.
    // 3 G-bunks on uncat at once → 2 must move (per-grade cap 1).
    const bunks = [0, 1, 2].map(() => gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 40 }]));
    const r = GLBandPlan.enforce({ bunks, seats: { 'special:uncategorized': 5, sport: 10 }, seatsByGrade: { G: { 'special:uncategorized': 1 } }, canon });
    assert.strictEqual(r.toSport, 2, 'two relabeled to respect the per-grade cap of 1');
    const gUncat = bunks.filter(b => b.tiles.some(t => t.kind === 'special')).length;
    assert.strictEqual(gUncat, 1, 'exactly one G-bunk keeps uncat');
});

test('byDuration: categoryOf and measure key specials by LENGTH', () => {
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'special', subcat: 'Regular', startMin: 0, endMin: 30 }, canon, true), 'special:uncategorized@30');
    assert.strictEqual(GLBandPlan.categoryOf({ kind: 'special', subcat: 'Regular', startMin: 0, endMin: 40 }, canon, true), 'special:uncategorized@40');
    // 3 bunks: two 30-min uncat + one 40-min uncat at the same band. Per-length seats: @30=1, @40=13.
    const bunks = [
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 30 }]),
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 30 }]),
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 40 }]),
    ];
    const r = GLBandPlan.measure({ bunks, supply: { 'special:uncategorized@30': 1, 'special:uncategorized@40': 13 }, canon, byDuration: true });
    assert.strictEqual(r.cats['special:uncategorized@30'].peak, 2);   // two 30-min tiles
    assert.strictEqual(r.cats['special:uncategorized@30'].over, 1);   // only 1 seat at 30min (Baking)
    assert.strictEqual(r.cats['special:uncategorized@40'].over, 0);   // 1 ≤ 13 at 40min
    assert.ok(r.overCats.includes('special:uncategorized@30'));
    assert.ok(!r.overCats.includes('special:uncategorized@40'));
});

test('enforce byDuration: a 30-min slot over its @30 seat is pulled to sport; the 40-min slot is fine', () => {
    const bunks = [
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 30 }]),
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 30 }]),  // 2nd 30-min — over the @30 seat (1)
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 40 }]),  // 40-min — within @40 seats
    ];
    const seats = { 'special:uncategorized@30': 1, 'special:uncategorized@40': 13, sport: 10 };
    const byGrade = { G: { 'special:uncategorized@30': 1, 'special:uncategorized@40': 13 } };
    const r = GLBandPlan.enforce({ bunks, seats, seatsByGrade: byGrade, canon, byDuration: true });
    assert.strictEqual(r.toSport, 1, 'the excess 30-min uncat went to sport (only 1 activity does 30min)');
    const min30 = bunks.filter(b => b.tiles.some(t => t.kind === 'special' && (t.endMin - t.startMin) === 30)).length;
    assert.strictEqual(min30, 1, 'only one 30-min uncat remains (its single seat)');
    assert.ok(bunks[2].tiles[0].kind === 'special', 'the 40-min uncat is untouched (within its seats)');
});

test('enforce: never moves a FILLED special, and leaves an honest residual when nothing has room', () => {
    // 2 bunks: one FILLED uncat (Baking) + one unfilled uncat; uncat seats=1, sport seats=0 (full) →
    // the filled one stays, the unfilled one can't go to sport (0 seats) → left as residual violation.
    const bunks = [
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 40 }]),
        gbunk('G', [{ k: 'special', sub: 'Regular', s: 0, e: 40 }]),
    ];
    bunks[0].tiles[0]._concrete = 'Baking';   // filled — must never move
    const r = GLBandPlan.enforce({ bunks, seats: { 'special:uncategorized': 1, sport: 0 }, seatsByGrade: { G: { 'special:uncategorized': 1 } }, canon });
    assert.ok(bunks[0].tiles[0]._concrete === 'Baking' && bunks[0].tiles[0].kind === 'special', 'filled special untouched');
    assert.strictEqual(r.toSport, 0);
    assert.ok(r.left >= 1, 'the unfilled excess could not be placed (sport full) → reported, not silently dropped');
    assert.ok(r.violations.length >= 1, 'residual over-cap surfaced for the audit');
});

test('enforce + canRelabel: a rejected over-cap tile is left in place (genuine over-capacity), never relabeled', () => {
    // Same shape as the "excess → sport" case, but the caller (subcat-strict)
    // rejects repurposing 'food'-tagged tiles: the excess stays a food special
    // and is counted `left` — the caller's honest-open endgame turns it into
    // genuine free time instead of a Sport or another subcat's label.
    const bunks = [0, 1, 2].map(() => gbunk('G', [{ k: 'special', sub: 'Food', s: 0, e: 40 }]));
    const r = GLBandPlan.enforce({
        bunks, seats: { 'special:food': 2, sport: 10 },
        seatsByGrade: { G: { 'special:food': 2 } }, canon,
        canRelabel: (t) => canon(t.subcat) !== 'food',
    });
    assert.strictEqual(r.toSport, 0, 'nothing pulled down to Sport');
    assert.strictEqual(r.toOtherSpecial, 0, 'nothing relabeled to another subcat');
    // with no relabel allowed, every tile of the over-cap band stays over-cap →
    // all 3 count as left (same accounting as the sportless no-move case above)
    assert.strictEqual(r.left, 3, 'all over-cap food tiles left in place (honest residual)');
    assert.ok(bunks.every(b => b.tiles.every(t => t.kind === 'special' && canon(t.subcat) === 'food')),
        'no tile changed identity');
});

test('enforce: PHANTOM over-cap — tiles touching at a boundary are NOT concurrent (live shiur 4>3 / sport 29>28)', () => {
    // The live Neranina shape: 4 shiur@20 tiles across 4 grades — 10:50-11:10,
    // 11:00-11:20, 11:10-11:30, 11:10-11:30. TRUE peak is 3 (the 10:50 tile ENDS
    // exactly when two others START), and the validator found zero conflicts. The
    // old touch-count conc() reported 4>3 against the 11:00-11:20 reference and
    // relabeled a healthy tile into an unfillable placeholder. Peak-based conc
    // must find NO violation and touch NOTHING.
    const mk = (g, s, e) => ({ grade: g, tiles: [{ kind: 'special', subcat: 'Shiur', generic: true, startMin: s, endMin: e, durationMin: e - s }] });
    const bunks = [mk('A', 650, 670), mk('B', 660, 680), mk('C', 670, 690), mk('D', 670, 690)];
    const r = GLBandPlan.enforce({
        bunks,
        seats: { 'special:shiur@20': 3 },
        seatsByGrade: { A: { 'special:shiur@20': 1 }, B: { 'special:shiur@20': 1 }, C: { 'special:shiur@20': 1 }, D: { 'special:shiur@20': 1 } },
        canon, byDuration: true
    });
    assert.strictEqual(r.toSport, 0, 'no tile pulled to sport');
    assert.strictEqual(r.toOtherSpecial, 0, 'no tile relabeled');
    assert.strictEqual(r.left, 0, 'nothing counted as stuck');
    assert.deepStrictEqual(r.violations, [], 'no phantom violation reported');
    assert.ok(bunks.every(b => b.tiles.every(t => canon(t.subcat) === 'shiur')), 'all tiles keep their identity');
});

test('enforce: a REAL 4-at-once over-cap is still caught and relabeled/reported', () => {
    // Same 4 tiles but genuinely simultaneous — peak 4 > 3 seats. The cap must
    // still bite (relabel one away or report it), proving the fix loosened only
    // the phantom case, not the real one.
    const mk = (g) => ({ grade: g, tiles: [{ kind: 'special', subcat: 'Shiur', generic: true, startMin: 660, endMin: 680, durationMin: 20 }] });
    const bunks = [mk('A'), mk('B'), mk('C'), mk('D')];
    const r = GLBandPlan.enforce({
        bunks,
        seats: { 'special:shiur@20': 3, sport: 28 },
        seatsByGrade: { A: { 'special:shiur@20': 1 }, B: { 'special:shiur@20': 1 }, C: { 'special:shiur@20': 1 }, D: { 'special:shiur@20': 1 } },
        canon, byDuration: true
    });
    assert.ok(r.toSport + r.toOtherSpecial + r.left >= 1, 'a real over-cap is acted on: ' + JSON.stringify(r));
});
