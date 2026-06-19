// node --test tests/gl_stagger.test.js
'use strict';
const assert = require('assert');
const { test } = require('node:test');
const GLStagger = require('../gl_stagger.js');

// ── mock injection: a global cap-`cap` usage map keyed by (location||name) ──
function makeCtx(bunks, opts) {
    opts = opts || {};
    const caps = opts.caps || {};           // name(lower) -> cap (default 1)
    const durs = opts.durs || {};           // name -> number[]
    const usage = {};                       // key -> [{grade,s,e}]
    const keyOf = c => String(c.location || c.name).toLowerCase();
    function maxOverlap(list, s, e) {
        const pts = [];
        list.forEach(u => { if (u.s < e && u.e > s) { pts.push([Math.max(u.s, s), 1]); pts.push([Math.min(u.e, e), -1]); } });
        pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let cur = 0, mx = 0; pts.forEach(p => { cur += p[1]; if (cur > mx) mx = cur; });
        return mx;
    }
    return {
        bunks,
        canon: v => { const s = String(v == null ? '' : v).toLowerCase().trim(); return (!s || s === 'regular' || s === 'uncategorized') ? 'uncategorized' : s; },
        specialDurs: name => durs[name] || [],
        capFits: (cand, grade, s, e) => { const cap = caps[String(cand.name).toLowerCase()] || 1; return (1 + maxOverlap(usage[keyOf(cand)] || [], s, e)) <= cap; },
        recordUse: (cand, grade, s, e) => { const k = keyOf(cand); (usage[k] = usage[k] || []).push({ grade: grade, s: s, e: e }); },
        removeUse: (cand, grade, s, e) => { const l = usage[keyOf(cand)]; if (!l) return; for (let i = 0; i < l.length; i++) { if (l[i].s === s && l[i].e === e) { l.splice(i, 1); return; } } },
        _usage: usage, _keyOf: keyOf
    };
}
function seed(ctx, name, grade, s, e) { ctx.recordUse({ name: name }, grade, s, e); }
function intervals(tiles) { return tiles.map(t => t.startMin + '-' + t.endMin).sort(); }

test('sport partner: empty special moves to a free-capacity time, sport relocates', () => {
    const miss = { kind: 'special', generic: true, subcat: 'Regular', durationMin: 40, startMin: 0, endMin: 40, _ref: { window: [0, 200] } };
    const sport = { kind: 'sport', generic: true, durationMin: 40, startMin: 100, endMin: 140, _ref: { window: [0, 200] } };
    const bunks = [{ grade: 'G', tiles: [miss, sport], pool: [{ name: 'X', subcategory: 'Regular' }, { name: 'Y', subcategory: 'Regular' }] }];
    const ctx = makeCtx(bunks, { durs: { X: [40], Y: [40] } });
    seed(ctx, 'X', 'other', 0, 40); seed(ctx, 'Y', 'other', 0, 40);     // both uncat taken at [0,40]
    const before = intervals(bunks[0].tiles);
    const r = GLStagger.restructure(ctx);
    assert.strictEqual(r.recovered, 1);
    assert.ok(miss._concrete === 'X' || miss._concrete === 'Y');
    assert.strictEqual(miss.startMin, 100);                              // moved onto the free slot
    assert.strictEqual(sport.startMin, 0);                              // sport took the old slot
    assert.ok(!sport._concrete);                                        // sport stays a generic placeholder
    assert.deepStrictEqual(intervals(bunks[0].tiles), before);         // wall-to-wall: same interval set
});

test('special partner (cross-subcat): keeps partner activity, both fill', () => {
    const miss = { kind: 'special', generic: true, subcat: 'Food', durationMin: 40, startMin: 0, endMin: 40, _ref: { window: [0, 200] } };
    const part = { kind: 'special', generic: true, subcat: 'Regular', durationMin: 40, startMin: 100, endMin: 140, _concrete: 'U', _fillLoc: null, _ref: { window: [0, 200] } };
    const bunks = [{ grade: 'G', tiles: [miss, part], pool: [{ name: 'F', subcategory: 'Food' }, { name: 'U', subcategory: 'Regular' }] }];
    const ctx = makeCtx(bunks, { durs: { F: [40], U: [40] } });
    seed(ctx, 'F', 'other', 0, 40);     // food taken at [0,40] (miss stuck there)
    seed(ctx, 'U', 'G', 100, 140);      // partner's own U placement
    const before = intervals(bunks[0].tiles);
    const r = GLStagger.restructure(ctx);
    assert.strictEqual(r.recovered, 1);
    assert.strictEqual(miss._concrete, 'F');
    assert.strictEqual(miss.startMin, 100);
    assert.strictEqual(part._concrete, 'U');
    assert.strictEqual(part.startMin, 0);
    assert.deepStrictEqual(intervals(bunks[0].tiles), before);
});

test('special partner (same-subcat, old slot saturated): correctly REJECTED, state restored', () => {
    const miss = { kind: 'special', generic: true, subcat: 'Regular', durationMin: 40, startMin: 0, endMin: 40, _ref: { window: [0, 200] } };
    const part = { kind: 'special', generic: true, subcat: 'Regular', durationMin: 40, startMin: 100, endMin: 140, _concrete: 'X', _fillLoc: null, _ref: { window: [0, 200] } };
    const bunks = [{ grade: 'G', tiles: [miss, part], pool: [{ name: 'X', subcategory: 'Regular' }, { name: 'Y', subcategory: 'Regular' }] }];
    const ctx = makeCtx(bunks, { durs: { X: [40], Y: [40] } });
    seed(ctx, 'X', 'other', 0, 40); seed(ctx, 'Y', 'other', 0, 40);     // both uncat saturated at [0,40]
    seed(ctx, 'X', 'G', 100, 140);                                       // partner's own X
    const r = GLStagger.restructure(ctx);
    assert.strictEqual(r.recovered, 0);                                  // nothing to swap into a saturated slot
    assert.ok(!miss._concrete);
    assert.strictEqual(part._concrete, 'X');
    assert.strictEqual(part.startMin, 100);                              // untouched
    // usage restored: X still recorded once at [100,140]
    const xUse = ctx._usage['x'].filter(u => u.s === 100 && u.e === 140);
    assert.strictEqual(xUse.length, 1);
});

test('respects layer window: no swap if the move leaves a window', () => {
    const miss = { kind: 'special', generic: true, subcat: 'Regular', durationMin: 40, startMin: 0, endMin: 40, _ref: { window: [0, 40] } }; // pinned-ish window
    const sport = { kind: 'sport', generic: true, durationMin: 40, startMin: 100, endMin: 140, _ref: { window: [100, 140] } };
    const bunks = [{ grade: 'G', tiles: [miss, sport], pool: [{ name: 'X', subcategory: 'Regular' }] }];
    const ctx = makeCtx(bunks, { durs: { X: [40] } });
    seed(ctx, 'X', 'other', 0, 40);
    const r = GLStagger.restructure(ctx);
    assert.strictEqual(r.recovered, 0);   // miss can't enter sport's window and vice-versa
    assert.ok(!miss._concrete);
});

test('never introduces a same-day repeat on a bunk', () => {
    // miss(uncat) + sport; only activity X exists and X is already on another tile of the bunk
    const miss = { kind: 'special', generic: true, subcat: 'Regular', durationMin: 40, startMin: 0, endMin: 40, _ref: { window: [0, 300] } };
    const sport = { kind: 'sport', generic: true, durationMin: 40, startMin: 100, endMin: 140, _ref: { window: [0, 300] } };
    const have = { kind: 'special', generic: true, subcat: 'Regular', durationMin: 40, startMin: 200, endMin: 240, _concrete: 'X', _ref: { window: [0, 300] } };
    const bunks = [{ grade: 'G', tiles: [miss, sport, have], pool: [{ name: 'X', subcategory: 'Regular' }] }];
    const ctx = makeCtx(bunks, { durs: { X: [40] } });
    seed(ctx, 'X', 'G', 200, 240);          // the bunk's own X
    const r = GLStagger.restructure(ctx);
    assert.strictEqual(r.recovered, 0);      // X already used by the bunk → can't reuse, no other activity
    assert.ok(!miss._concrete);
});

function abTile(o) { return { kind: o.k, subcat: o.sub || null, name: o.n || null, durationMin: o.d, startMin: o.s, endMin: o.e, generic: o.g === false ? false : true, _concrete: o.c || undefined }; }

test('absorb: empty special → Sport; filled special + walls untouched', () => {
    var tiles = [
        abTile({ k: 'special', sub: 'Regular', d: 40, s: 0, e: 40 }),                 // empty → sport
        abTile({ k: 'special', sub: 'Food', d: 20, s: 40, e: 60, c: 'Ice cream' }),   // filled → keep
        abTile({ k: 'swim', d: 30, s: 60, e: 90, g: false }),                          // wall → keep
    ];
    var bunks = [{ tiles: tiles }];
    var r = GLStagger.absorbUnfilledToSport({ bunks: bunks });
    assert.strictEqual(r.toSport, 1);
    var t0 = tiles.find(t => t.startMin === 0);
    assert.strictEqual(t0.kind, 'sport'); assert.strictEqual(t0.name, 'Sport'); assert.ok(!t0.subcat);
    assert.ok(tiles.some(t => t._concrete === 'Ice cream' && t.kind === 'special')); // filled special intact
    assert.ok(tiles.some(t => t.kind === 'swim'));                                    // wall intact
});

test('absorb+merge: two contiguous 20-min empty specials → one 40-min Sport', () => {
    var tiles = [
        abTile({ k: 'special', sub: 'Regular', d: 20, s: 0, e: 20 }),
        abTile({ k: 'special', sub: 'Regular', d: 20, s: 20, e: 40 }),
    ];
    var bunks = [{ tiles: tiles }];
    GLStagger.absorbUnfilledToSport({ bunks: bunks, maxMergeMin: 40 });
    assert.strictEqual(tiles.length, 1);
    assert.strictEqual(tiles[0].kind, 'sport'); assert.strictEqual(tiles[0].startMin, 0); assert.strictEqual(tiles[0].endMin, 40);
});

test('absorb+merge: caps at maxMergeMin (80-min run → 40+40)', () => {
    var tiles = [
        abTile({ k: 'special', sub: 'Regular', d: 40, s: 0, e: 40 }),
        abTile({ k: 'special', sub: 'Regular', d: 40, s: 40, e: 80 }),
    ];
    var bunks = [{ tiles: tiles }];
    GLStagger.absorbUnfilledToSport({ bunks: bunks, maxMergeMin: 40 });
    assert.strictEqual(tiles.length, 2);
    assert.deepStrictEqual(tiles.map(t => [t.startMin, t.endMin]), [[0, 40], [40, 80]]);
    assert.ok(tiles.every(t => t.kind === 'sport'));
});

test('absorb+merge: a filled special between two empties breaks the run (no cross-merge)', () => {
    var tiles = [
        abTile({ k: 'special', sub: 'Regular', d: 20, s: 0, e: 20 }),                   // → sport 20
        abTile({ k: 'special', sub: 'Food', d: 20, s: 20, e: 40, c: 'Ice cream' }),     // filled, keep
        abTile({ k: 'special', sub: 'Regular', d: 20, s: 40, e: 60 }),                   // → sport 20
    ];
    var bunks = [{ tiles: tiles }];
    GLStagger.absorbUnfilledToSport({ bunks: bunks, maxMergeMin: 40 });
    var occ = tiles.slice().sort((a, b) => a.startMin - b.startMin).map(t => t.kind + ':' + t.startMin + '-' + t.endMin);
    assert.deepStrictEqual(occ, ['sport:0-20', 'special:20-40', 'sport:40-60']);       // no merge across the filled special
});

test('absorb+merge: a break (non-contiguous gap) is not merged across', () => {
    var tiles = [
        abTile({ k: 'special', sub: 'Regular', d: 20, s: 0, e: 20 }),
        abTile({ k: 'special', sub: 'Regular', d: 20, s: 25, e: 45 }),   // 5-min break at 20-25
    ];
    var bunks = [{ tiles: tiles }];
    GLStagger.absorbUnfilledToSport({ bunks: bunks, maxMergeMin: 40 });
    assert.strictEqual(tiles.length, 2);                                  // not contiguous → stays two Sports
    assert.ok(tiles.every(t => t.kind === 'sport'));
});

test('absorb respects sport spacing: gate blocks Sport within 40min of a Sport → leftover stays Special', () => {
    // a 120-min open run; rule = no Sport within 40 min of another Sport.
    var tiles = [
        abTile({ k: 'special', sub: 'Regular', d: 40, s: 0, e: 40 }),
        abTile({ k: 'special', sub: 'Regular', d: 40, s: 40, e: 80 }),
        abTile({ k: 'special', sub: 'Regular', d: 40, s: 80, e: 120 }),
    ];
    var bunks = [{ tiles: tiles }];
    // gate: reject a candidate sport if any template sport falls within 40 min of it
    var gate = function (block, template) {
        if (block.type !== 'sport') return true;
        return !template.some(function (t) {
            return t.type === 'sport' && t.startMin < block.endMin + 40 && t.endMin > block.startMin - 40;
        });
    };
    var r = GLStagger.absorbUnfilledToSport({ bunks: bunks, gate: gate, maxMergeMin: 40 });
    var occ = tiles.slice().sort((a, b) => a.startMin - b.startMin).map(t => t.kind + ':' + t.startMin + '-' + t.endMin);
    // [0,40] sport ok; [40,80] sport would sit 0 min from the first → blocked → special; [80,120] is 40 min clear → sport
    assert.deepStrictEqual(occ, ['sport:0-40', 'special:40-80', 'sport:80-120']);
    assert.strictEqual(r.toSport, 2);
    assert.strictEqual(r.blockedBySpacing, 1);
    // every pair of placed Sports is ≥40 min apart (start-to-start ≥80 here) — the rule held
    var sports = tiles.filter(t => t.kind === 'sport').sort((a, b) => a.startMin - b.startMin);
    for (var i = 1; i < sports.length; i++) assert.ok(sports[i].startMin - sports[i - 1].endMin >= 0);
});

test('absorb is layer-safe: a FILLED special floor is never converted to Sport', () => {
    // even when sport spacing would happily allow a sport here, a filled special stays put
    var tiles = [
        abTile({ k: 'special', sub: 'Food', d: 20, s: 0, e: 20, c: 'Pizza' }),   // filled floor → must survive
        abTile({ k: 'special', sub: 'Regular', d: 40, s: 20, e: 60 }),            // empty → may become sport
    ];
    var bunks = [{ tiles: tiles }];
    var r = GLStagger.absorbUnfilledToSport({ bunks: bunks, gate: function () { return true; }, maxMergeMin: 40 });
    assert.ok(tiles.some(t => t._concrete === 'Pizza' && t.kind === 'special'), 'filled floor preserved');
    assert.strictEqual(r.toSport, 1);   // only the empty special converted
});

test('stress: 40 bunks × 8 tiles — terminates, invariants hold (no stack/cap/overlap/repeat issues)', () => {
    const bunks = [];
    const durs = {};
    const pool = [];
    for (let a = 0; a < 6; a++) { const n = 'A' + a; pool.push({ name: n, subcategory: 'Regular' }); durs[n] = [40]; }
    for (let b = 0; b < 40; b++) {
        const tiles = [];
        // 4 special tiles + 4 sport tiles, all 40min, clustered at the same 8 slots across bunks
        for (let s = 0; s < 8; s++) {
            const st = s * 40, en = st + 40;
            const kind = (s % 2 === 0) ? 'special' : 'sport';
            const t = { kind: kind, generic: true, durationMin: 40, startMin: st, endMin: en, _ref: { window: [0, 320] } };
            if (kind === 'special') t.subcat = 'Regular';
            tiles.push(t);
        }
        bunks.push({ grade: 'G' + (b % 5), tiles: tiles, pool: pool.slice() });
    }
    const ctx = makeCtx(bunks, { durs: durs });
    const before = bunks.map(b => intervals(b.tiles));
    const r = GLStagger.restructure(ctx);
    assert.ok(r.attempts >= 0);
    // invariants
    bunks.forEach((b, bi) => {
        assert.deepStrictEqual(intervals(b.tiles), before[bi]);          // wall-to-wall preserved
        const seen = {};
        const occ = [];
        b.tiles.forEach(t => {
            if (t._concrete) { assert.ok(!seen[t._concrete], 'no same-day repeat'); seen[t._concrete] = 1; }
            occ.push([t.startMin, t.endMin]);
        });
        occ.sort((x, y) => x[0] - y[0]);
        for (let i = 1; i < occ.length; i++) assert.ok(occ[i][0] >= occ[i - 1][1], 'no overlap');
    });
    // global cap-1 never exceeded
    Object.keys(ctx._usage).forEach(k => {
        const l = ctx._usage[k];
        for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
            assert.ok(!(l[i].s < l[j].e && l[j].s < l[i].e), 'cap-1 resource ' + k + ' double-booked');
        }
    });
});
