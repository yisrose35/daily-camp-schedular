// node --test tests/gl_reorder_convert.test.js
'use strict';
const assert = require('assert');
const { test } = require('node:test');
const GLStagger = require('../gl_stagger.js');

const canon = v => { const s = String(v == null ? '' : v).toLowerCase().trim(); return (!s || s === 'regular' || s === 'uncategorized') ? 'uncategorized' : s; };

// camp spacing rule: "no Sport within 40 min of another Sport" (mirrors the real gate's shape:
// it reads block.type / startMin / endMin from _toBlk output).
function makeGate(radius = 40) {
    return function gate(block, template) {
        if (!block || block.type !== 'sport') return true;
        const s = block.startMin, e = block.endMin;
        for (const t of (template || [])) {
            if (!t || t.type !== 'sport') continue;
            const bs = t.startMin, be = t.endMin;
            let gap;
            if (be <= s) gap = s - be;
            else if (e <= bs) gap = bs - e;
            else gap = -1;               // overlap
            if (gap < radius) return false;
        }
        return true;
    };
}
function tile(k, sub, d, s, e, opts) {
    return Object.assign({ kind: k, subcat: sub || null, name: opts && opts.name || (k === 'special' ? ('Special: ' + (sub || '')) : 'Sport'), durationMin: d, startMin: s, endMin: e, generic: !(opts && opts.generic === false) }, opts && opts._concrete ? { _concrete: opts._concrete } : {});
}
function deadCount(tiles) { return tiles.filter(t => t.kind === 'special' && t.generic === true && !t._concrete).length; }
function noOverlap(tiles) {
    const occ = tiles.map(t => [t.startMin, t.endMin]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < occ.length; i++) if (occ[i][0] < occ[i - 1][1]) return false;
    return true;
}

test('relocates an UNEQUAL-dur blocker so a dead 10-min special becomes a Sport', () => {
    // B(sport 40)@[60,100] blocks a Sport at W(food 10)@[110,120] (gap 10 < 40).
    // P(uncategorized 40, dead)@[200,240] is a clean partner far from any sport.
    const B = tile('sport', null, 40, 60, 100);
    const W = tile('special', 'food', 10, 110, 120);
    const P = tile('special', 'uncategorized', 40, 200, 240);
    const tiles = [B, W, P];
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon, sportLabel: 'Sport' });
    assert.strictEqual(r.converted, 1, 'W rescued');
    assert.strictEqual(r.relocations, 1, 'one blocker relocated');
    assert.strictEqual(W.kind, 'sport', 'dead food → Sport');
    assert.strictEqual(W.generic, true, 'left generic for GENERIC-SPORT-FILL to concretize');
    assert.ok(!W._concrete);
    assert.strictEqual(B.startMin, 200, 'blocker moved to the partner slot');
    assert.strictEqual(P.startMin, 60, 'partner moved to the blocker slot');
    assert.strictEqual(P.kind, 'special', 'partner stays a special');
    assert.ok(noOverlap(tiles), 'no new overlap (equal-dur swap)');
    // final state has no spacing violation: both sports (W@110-120, B@200-240) are ≥40 apart
    const g = makeGate(40);
    assert.ok(g({ type: 'sport', startMin: 110, endMin: 120 }, [{ type: 'sport', startMin: 200, endMin: 240 }]));
});

test('DIRECT convert when a Sport already fits the dead window (no blocker)', () => {
    const W = tile('special', 'food', 10, 110, 120);
    const other = tile('special', 'uncategorized', 40, 200, 240, { _concrete: 'Baking', generic: false });
    const tiles = [W, other];
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon });
    assert.strictEqual(r.converted, 1);
    assert.strictEqual(r.relocations, 0, 'no relocation needed');
    assert.strictEqual(W.kind, 'sport');
});

test('canConvert PROTECTS a subcat (weekly-must shiur is left as a placeholder)', () => {
    const W = tile('special', 'shiur', 20, 110, 130);
    const tiles = [W];
    const r = GLStagger.reorderDeadToSport({
        bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon,
        canConvert: t => canon(t.subcat) !== 'shiur'
    });
    assert.strictEqual(r.converted, 0, 'protected subcat not converted');
    assert.strictEqual(W.kind, 'special', 'shiur placeholder preserved');
});

test('no movable SPECIAL partner → blocked window left as-is', () => {
    // B blocks W, but the only other movable tile is a SPORT (would re-block) → no conversion.
    const B = tile('sport', null, 40, 60, 100);
    const W = tile('special', 'food', 10, 110, 120);
    const otherSport = tile('sport', null, 40, 200, 240);
    const tiles = [B, W, otherSport];
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon });
    assert.strictEqual(r.converted, 0, 'no special partner → cannot relocate');
    assert.strictEqual(W.kind, 'special');
});

test('SAFETY: never introduces a sport-spacing violation, however many convert', () => {
    // a cramped layout where a naive relocation could put two sports within 40 of each other.
    const g = makeGate(40);
    function noViolation(tiles) {
        const sports = tiles.filter(t => t.kind === 'sport');
        return sports.every(S => g({ type: 'sport', startMin: S.startMin, endMin: S.endMin },
            tiles.filter(t => t !== S).map(t => ({ type: t.kind, startMin: t.startMin, endMin: t.endMin }))));
    }
    const tiles = [
        tile('sport', null, 40, 60, 100),
        tile('special', 'food', 40, 110, 150),       // blocked by the sport at [60,100]
        tile('special', 'uncategorized', 40, 160, 200),
        tile('sport', null, 40, 210, 250),
        tile('special', 'uncategorized', 40, 260, 300),
    ];
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: g, canon });
    assert.ok(noViolation(tiles), 'final layout has no two sports within 40 min');
    assert.ok(noOverlap(tiles), 'no overlap');
    // and any tile that flipped to sport really is spacing-legal where it sits
    assert.ok(r.converted >= 0);
});

test('sportless bunk is never given a Sport', () => {
    const W = tile('special', 'food', 10, 110, 120);
    const tiles = [W];
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Leebi', noSport: true }], gate: makeGate(40), canon });
    assert.strictEqual(r.converted, 0);
    assert.strictEqual(W.kind, 'special');
});

test('stress: many dead specials + blockers — terminates, dead count drops, no overlap', () => {
    const bunks = [];
    for (let b = 0; b < 12; b++) {
        // each bunk: a blocker sport, a dead food right after it, and two clean 40-min special partners
        const tiles = [
            tile('sport', null, 40, 60, 100),
            tile('special', 'food', 10, 110, 120),
            tile('special', 'uncategorized', 40, 300, 340),
            tile('special', 'uncategorized', 40, 400, 440),
        ];
        bunks.push({ tiles, grade: 'Majors' });
    }
    const before = bunks.reduce((n, bk) => n + deadCount(bk.tiles), 0);
    const r = GLStagger.reorderDeadToSport({ bunks, gate: makeGate(40), canon });
    const after = bunks.reduce((n, bk) => n + deadCount(bk.tiles), 0);
    assert.ok(r.converted > 0, 'rescued at least one per bunk');
    assert.ok(after < before, 'dead-special count dropped (' + before + '→' + after + ')');
    bunks.forEach(bk => assert.ok(noOverlap(bk.tiles), 'no overlap'));
});

// a seat ledger: capFits returns a fixed result; record/remove are tracked so we can assert balance
function makeLedger(capResult) {
    const removed = [], recorded = [];
    return {
        removed, recorded,
        capFits: () => capResult,
        recordUse: (cand, grade, s, e) => recorded.push([cand.name, s, e]),
        removeUse: (cand, grade, s, e) => removed.push([cand.name, s, e]),
    };
}

test('FILLED partner: relocate the blocker by swapping a filled special (seat re-validated + ledger moved)', () => {
    const B = tile('sport', null, 40, 60, 100);
    const W = tile('special', 'food', 10, 110, 120);
    const P = tile('special', 'uncategorized', 40, 200, 240, { _concrete: 'Baking', generic: false, name: 'Baking' });
    const tiles = [B, W, P];
    const L = makeLedger(true);
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon, capFits: L.capFits, recordUse: L.recordUse, removeUse: L.removeUse });
    assert.strictEqual(r.converted, 1);
    assert.strictEqual(r.filledMoves, 1, 'one filled special moved');
    assert.strictEqual(W.kind, 'sport');
    assert.strictEqual(B.startMin, 200, 'blocker took the partner slot');
    assert.strictEqual(P.startMin, 60, 'filled partner took the blocker slot');
    assert.strictEqual(P._concrete, 'Baking', 'partner keeps its activity');
    assert.strictEqual(P.kind, 'special');
    assert.deepStrictEqual(L.removed, [['Baking', 200, 240]], 'old seat removed once');
    assert.deepStrictEqual(L.recorded, [['Baking', 60, 100]], 'seat recorded at the new slot');
    assert.ok(noOverlap(tiles));
});

test('FILLED partner: seat re-validation fails → no move, ledger restored exactly', () => {
    const B = tile('sport', null, 40, 60, 100);
    const W = tile('special', 'food', 10, 110, 120);
    const P = tile('special', 'uncategorized', 40, 200, 240, { _concrete: 'Baking', generic: false, name: 'Baking' });
    const tiles = [B, W, P];
    const L = makeLedger(false);                 // no seat for Baking at the slot it would move into
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon, capFits: L.capFits, recordUse: L.recordUse, removeUse: L.removeUse });
    assert.strictEqual(r.converted, 0, 'no seat → no rescue');
    assert.strictEqual(W.kind, 'special');
    assert.strictEqual(B.startMin, 60, 'blocker unmoved');
    assert.strictEqual(P.startMin, 200, 'partner unmoved');
    assert.strictEqual(P._concrete, 'Baking');
    assert.deepStrictEqual(L.removed, [['Baking', 200, 240]], 'removed once during the trial');
    assert.deepStrictEqual(L.recorded, [['Baking', 200, 240]], 'restored to the SAME slot (balanced)');
});

test('FILLED partner is ignored when no capacity ledger is supplied (back-compat)', () => {
    const B = tile('sport', null, 40, 60, 100);
    const W = tile('special', 'food', 10, 110, 120);
    const P = tile('special', 'uncategorized', 40, 200, 240, { _concrete: 'Baking', generic: false, name: 'Baking' });
    const tiles = [B, W, P];
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon }); // no capFits/recordUse/removeUse
    assert.strictEqual(r.converted, 0, 'a filled partner needs a ledger; none here');
    assert.strictEqual(W.kind, 'special');
    assert.strictEqual(P.startMin, 200);
});

// ── MULTI-BLOCKER (maxBlockers > 1) ───────────────────────────────────────────
// W is boxed by TWO sports both inside its 40-min radius; single-hop can't free it.
// Partners are FILLED specials (realistic: at the crush every special is filled — and a
// FILLED partner isn't itself an independently-convertible dead window, so the test isolates
// exactly the multi-blocker behavior).

test('MULTI-BLOCKER: two sports box a dead window → relocate BOTH (filled partners), window becomes a Sport', () => {
    const W = tile('special', 'food', 10, 110, 120);
    const B1 = tile('sport', null, 40, 60, 100);     // gap to W = 10 < 40
    const B2 = tile('sport', null, 40, 130, 170);    // gap to W = 10 < 40
    const P1 = tile('special', 'uncategorized', 40, 300, 340, { _concrete: 'Baking', generic: false, name: 'Baking' });
    const P2 = tile('special', 'uncategorized', 40, 400, 440, { _concrete: 'Gymnastics', generic: false, name: 'Gymnastics' });
    const tiles = [W, B1, B2, P1, P2];
    const L = makeLedger(true);
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon, maxBlockers: 3, capFits: L.capFits, recordUse: L.recordUse, removeUse: L.removeUse });
    assert.strictEqual(r.converted, 1, 'W freed');
    assert.strictEqual(r.multiHops, 1, 'one multi-blocker rescue');
    assert.strictEqual(r.relocations, 2, 'both blockers relocated');
    assert.strictEqual(r.filledMoves, 2, 'both filled partners re-seated');
    assert.strictEqual(W.kind, 'sport');
    assert.strictEqual(B1.startMin, 300); assert.strictEqual(B2.startMin, 400);
    assert.strictEqual(P1.startMin, 60); assert.strictEqual(P2.startMin, 130);
    assert.strictEqual(P1._concrete, 'Baking'); assert.strictEqual(P2._concrete, 'Gymnastics');
    // ledger net-balanced: each removed slot has a matching recorded slot
    assert.deepStrictEqual(L.removed.slice().sort(), [['Baking', 300, 340], ['Gymnastics', 400, 440]].sort());
    assert.deepStrictEqual(L.recorded.slice().sort(), [['Baking', 60, 100], ['Gymnastics', 130, 170]].sort());
    assert.ok(noOverlap(tiles));
    const g = makeGate(40);
    [W, B1, B2].forEach(S => assert.ok(g({ type: 'sport', startMin: S.startMin, endMin: S.endMin },
        tiles.filter(t => t !== S && t.kind === 'sport').map(t => ({ type: 'sport', startMin: t.startMin, endMin: t.endMin }))),
        'every sport stays ≥40 apart'));
});

test('MULTI-BLOCKER is OFF by default (maxBlockers=1) — a two-sport box is left alone', () => {
    const W = tile('special', 'food', 10, 110, 120);
    const B1 = tile('sport', null, 40, 60, 100);
    const B2 = tile('sport', null, 40, 130, 170);
    const P1 = tile('special', 'uncategorized', 40, 300, 340, { _concrete: 'Baking', generic: false, name: 'Baking' });
    const P2 = tile('special', 'uncategorized', 40, 400, 440, { _concrete: 'Gymnastics', generic: false, name: 'Gymnastics' });
    const tiles = [W, B1, B2, P1, P2];
    const L = makeLedger(true);
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon, capFits: L.capFits, recordUse: L.recordUse, removeUse: L.removeUse }); // no maxBlockers
    assert.strictEqual(r.converted, 0, 'single-hop cannot free a two-sport box');
    assert.strictEqual(W.kind, 'special');
    assert.strictEqual(B1.startMin, 60); assert.strictEqual(B2.startMin, 130);
    assert.strictEqual(L.removed.length, 0, 'multi-blocker never ran → no ledger churn');
});

test('MULTI-BLOCKER: a NON-movable sport in the radius blocks the whole thing', () => {
    const W = tile('special', 'food', 10, 110, 120);
    const B1 = tile('sport', null, 40, 60, 100);
    const B2 = tile('sport', null, 40, 130, 170, { generic: false, name: 'Soccer Game' }); // concrete/pinned → unmovable
    const P1 = tile('special', 'uncategorized', 40, 300, 340, { _concrete: 'Baking', generic: false, name: 'Baking' });
    const P2 = tile('special', 'uncategorized', 40, 400, 440, { _concrete: 'Gymnastics', generic: false, name: 'Gymnastics' });
    const tiles = [W, B1, B2, P1, P2];
    const L = makeLedger(true);
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon, maxBlockers: 3, capFits: L.capFits, recordUse: L.recordUse, removeUse: L.removeUse });
    assert.strictEqual(r.converted, 0, 'cannot move a concrete sport out of the radius');
    assert.strictEqual(W.kind, 'special');
    assert.strictEqual(B1.startMin, 60, 'movable blocker not left displaced');
    assert.strictEqual(L.removed.length, 0, 'aborted at the scan → no ledger churn');
});

test('MULTI-BLOCKER: not enough partners → ATOMIC rollback (tiles restored, ledger net-balanced)', () => {
    const W = tile('special', 'food', 10, 110, 120);
    const B1 = tile('sport', null, 40, 60, 100);
    const B2 = tile('sport', null, 40, 130, 170);
    const P1 = tile('special', 'uncategorized', 40, 300, 340, { _concrete: 'Baking', generic: false, name: 'Baking' }); // only ONE partner for TWO blockers
    const tiles = [W, B1, B2, P1];
    const L = makeLedger(true);
    const r = GLStagger.reorderDeadToSport({ bunks: [{ tiles, grade: 'Majors' }], gate: makeGate(40), canon, maxBlockers: 3, capFits: L.capFits, recordUse: L.recordUse, removeUse: L.removeUse });
    assert.strictEqual(r.converted, 0, 'cannot relocate both → abort');
    assert.strictEqual(W.kind, 'special');
    assert.strictEqual(B1.startMin, 60, 'blocker restored');
    assert.strictEqual(P1.startMin, 300, 'partner restored to its slot');
    assert.strictEqual(P1._concrete, 'Baking');
    // every removeUse during the trial was matched by a restoring recordUse → ledger net-unchanged
    assert.deepStrictEqual(L.removed.slice().sort(), L.recorded.slice().sort(), 'ledger net-balanced after rollback');
    assert.ok(noOverlap(tiles));
});
