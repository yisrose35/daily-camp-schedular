'use strict';
// Simulation test for PARTIAL (per-tile) REGENERATION (Manual builder).
//
// Models the data-flow that the real feature wires together:
//   daily_adjustments.js  _boRegenerateSelectedCells()  → builds window.__regenSlotScope
//   scheduler_core_main.js STEP 1   → rebuilds each in-scope bunk (keep pinned / regen null)
//   scheduler_core_main.js STEP 1.6 → registers field usage for the preserved tiles
//   scheduler_core_main.js STEP 6.5 → drops solver blocks whose slot is already occupied
//
// Invariants proven:
//   1. Only the SELECTED (bunk, slot) tiles are emptied for re-roll.
//   2. Every OTHER slot — including sibling bunks in the same division — is preserved
//      byte-for-byte and marked _pinned/_fixed.
//   3. Preserved tiles' fields are registered into fieldUsageBySlot (so the solver
//      cannot double-book them when filling the empty slots).
//   4. The solver only receives blocks for the empty (selected) slots.
//   5. A multi-period (continuation) selection expands to its whole block.

const test = require('node:test');
const assert = require('node:assert');

// ── Pure re-implementations of the production logic under test ──────────────

// scheduler_core_main.js STEP 1 (per-tile branch) + STEP 1.6 capacity registration.
function rebuildInScopeBunks(scheduleAssignments, regenSlotScope, slotCount) {
  const out = {};
  for (const bunk of Object.keys(regenSlotScope)) {
    const rs = regenSlotScope[bunk];
    const arr = new Array(slotCount).fill(null);
    for (const k in rs.keep) {
      const i = parseInt(k, 10);
      if (i >= 0 && i < slotCount && rs.keep[k]) {
        arr[i] = Object.assign({}, rs.keep[k], { _fixed: true, _pinned: true, _regenPreserved: true });
      }
    }
    out[bunk] = arr; // selected (regen) slots stay null
  }
  return out;
}

// scheduler_core_main.js STEP 6.5 — remove blocks whose target slot is already filled.
function filterOccupiedBlocks(blocks, scheduleAssignments) {
  return blocks.filter(b => {
    const ex = scheduleAssignments[b.bunk] && scheduleAssignments[b.bunk][b.slots[0]];
    if (ex && !ex.continuation && !ex._isTransition) {
      const act = (ex._activity || ex.field || '').toLowerCase().trim();
      if (act && act !== 'free' && act !== 'free play') return false; // occupied → drop
    }
    return true;
  });
}

// daily_adjustments.js _boRegenerateSelectedCells() — build the per-slot snapshot
// covering every bunk of the affected divisions (with multi-period expansion).
function buildRegenScope(divisions, scheduleAssignments, selections) {
  const bunkToDiv = {};
  Object.entries(divisions).forEach(([dn, di]) =>
    (di.bunks || []).forEach(b => { bunkToDiv[String(b)] = dn; }));

  const regenByBunk = {};
  const affectedDivs = new Set();
  selections.forEach(sel => {
    const bunk = String(sel.bunk);
    const dn = bunkToDiv[bunk];
    if (!dn) return;
    if (!regenByBunk[bunk]) regenByBunk[bunk] = new Set();
    regenByBunk[bunk].add(sel.slot);
    affectedDivs.add(dn);
    // multi-period guard
    const arr = scheduleAssignments[bunk] || [];
    const entry = arr[sel.slot];
    const bs = entry && (entry._blockStart != null ? entry._blockStart
                         : (entry._startMin != null ? entry._startMin : null));
    if (entry && bs != null) {
      for (let j = 0; j < arr.length; j++) {
        const e = arr[j];
        if (e && (e._blockStart != null ? e._blockStart : e._startMin) === bs) regenByBunk[bunk].add(j);
      }
    }
  });

  const regenScope = {};
  affectedDivs.forEach(dn => {
    (divisions[dn].bunks || []).forEach(b => {
      const bunk = String(b);
      const regen = regenByBunk[bunk] || new Set();
      const arr = scheduleAssignments[bunk] || [];
      const keep = {};
      for (let i = 0; i < arr.length; i++) {
        if (regen.has(i)) continue;
        if (arr[i]) keep[i] = JSON.parse(JSON.stringify(arr[i]));
      }
      regenScope[bunk] = { regen, keep };
    });
  });
  return regenScope;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
function fixture() {
  const divisions = { Div1: { bunks: ['A', 'B'] }, Div2: { bunks: ['C'] } };
  const SLOT = 4;
  const mk = (act, field, start) => ({ _activity: act, field, _startMin: start, _blockStart: start });
  const scheduleAssignments = {
    A: [mk('Swim', 'Pool', 600), mk('Basketball', 'Court 1', 660), mk('Art', 'Art Room', 720), mk('Soccer', 'Field 1', 780)],
    B: [mk('Soccer', 'Field 1', 600), mk('Swim', 'Pool', 660), mk('Hockey', 'Rink', 720), mk('Art', 'Art Room', 780)],
    C: [mk('Tennis', 'Court 2', 600), mk('Lunch', 'Hall', 660), mk('Swim', 'Pool', 720), mk('Chess', 'Club', 780)],
  };
  return { divisions, scheduleAssignments, SLOT };
}

// ── Tests ────────────────────────────────────────────────────────────────

test('only selected tiles are emptied; everything else preserved + pinned', () => {
  const { divisions, scheduleAssignments, SLOT } = fixture();
  // Select bunk A slot 1 (Basketball) only.
  const scope = buildRegenScope(divisions, scheduleAssignments, [{ bunk: 'A', slot: 1 }]);

  // Scope must cover EVERY bunk of the affected division (Div1: A and sibling B), not Div2.
  assert.deepStrictEqual(Object.keys(scope).sort(), ['A', 'B']);

  const rebuilt = rebuildInScopeBunks(scheduleAssignments, scope, SLOT);

  // A: slot 1 emptied for re-roll; slots 0/2/3 preserved & pinned.
  assert.strictEqual(rebuilt.A[1], null, 'selected slot must be empty');
  [0, 2, 3].forEach(i => {
    assert.ok(rebuilt.A[i] && rebuilt.A[i]._pinned && rebuilt.A[i]._fixed, 'kept slot pinned');
    assert.strictEqual(rebuilt.A[i]._activity, scheduleAssignments.A[i]._activity, 'kept activity unchanged');
  });
  // Sibling B: fully preserved & pinned (no empty slots).
  rebuilt.B.forEach((e, i) => {
    assert.ok(e && e._pinned, 'sibling bunk slot preserved+pinned at ' + i);
    assert.strictEqual(e._activity, scheduleAssignments.B[i]._activity);
  });
});

test('solver receives blocks ONLY for the empty selected slots', () => {
  const { divisions, scheduleAssignments, SLOT } = fixture();
  const scope = buildRegenScope(divisions, scheduleAssignments, [{ bunk: 'A', slot: 1 }, { bunk: 'B', slot: 3 }]);
  const rebuilt = rebuildInScopeBunks(scheduleAssignments, scope, SLOT);

  // One skeleton block per (bunk, slot) for the in-scope division.
  const allBlocks = [];
  ['A', 'B'].forEach(bunk => { for (let s = 0; s < SLOT; s++) allBlocks.push({ bunk, slots: [s] }); });

  const remaining = filterOccupiedBlocks(allBlocks, rebuilt);
  const remKeys = remaining.map(b => b.bunk + ':' + b.slots[0]).sort();
  assert.deepStrictEqual(remKeys, ['A:1', 'B:3'], 'only the two selected slots remain fillable');
});

test('preserved fields are registered so the empty slot cannot double-book them', () => {
  const { divisions, scheduleAssignments, SLOT } = fixture();
  // Select A slot 0 (Swim/Pool). B slot 1 also holds Swim/Pool at a DIFFERENT slot — fine.
  const scope = buildRegenScope(divisions, scheduleAssignments, [{ bunk: 'A', slot: 0 }]);
  const rebuilt = rebuildInScopeBunks(scheduleAssignments, scope, SLOT);

  // Model STEP 1.6: register field usage per (slotIndex, field) from preserved tiles.
  const fieldUsageBySlot = {};
  Object.keys(scope).forEach(bunk => {
    rebuilt[bunk].forEach((e, i) => {
      if (!e || !e.field) return;
      fieldUsageBySlot[i] = fieldUsageBySlot[i] || {};
      fieldUsageBySlot[i][e.field] = (fieldUsageBySlot[i][e.field] || 0) + 1;
    });
  });

  // Slot 0: A's Pool is now empty (selected), B's Field 1 preserved → Pool NOT locked at slot 0.
  assert.ok(!fieldUsageBySlot[0] || !fieldUsageBySlot[0]['Pool'], 'freed Pool@slot0 available for re-roll');
  // Slot 1: B's Pool preserved → registered, so a re-roll of another bunk into slot1 sees it.
  assert.strictEqual(fieldUsageBySlot[1]['Pool'], 1, 'preserved Pool@slot1 registered');
  // Art Room used by A@2 and B@3 — preserved at their own slots.
  assert.strictEqual(fieldUsageBySlot[2]['Art Room'], 1);
  assert.strictEqual(fieldUsageBySlot[3]['Art Room'], 1);
});

// scheduler_core_main.js STEP 3 — a league block is preserved (skipped, not re-rolled)
// unless the user selected that league period's slot. Mirrors the production predicate.
function leagueBlockTargeted(regenScope, divBunks, leagueSlot) {
  return leagueSlot != null && divBunks.some(b =>
    regenScope[b] && regenScope[b].regen && regenScope[b].regen.has(leagueSlot));
}

test('league is preserved when its period is NOT selected, re-rolled when it IS', () => {
  const divisions = { Div1: { bunks: ['A', 'B'] } };
  // Div1: slot0=Swim, slot1=League, slot2=Special/Sports.
  const scheduleAssignments = {
    A: [{ _activity: 'Swim', field: 'Pool', _startMin: 600, _blockStart: 600 }, null,
        { _activity: 'Art', field: 'Art Room', _startMin: 720, _blockStart: 720 }],
    B: [{ _activity: 'Swim', field: 'Pool', _startMin: 600, _blockStart: 600 }, null,
        { _activity: 'Soccer', field: 'Field 1', _startMin: 720, _blockStart: 720 }],
  };
  // Case 1: user selects the Special/Sports tile (slot 2) — league (slot 1) untouched.
  const scope1 = buildRegenScope(divisions, scheduleAssignments, [{ bunk: 'A', slot: 2 }, { bunk: 'B', slot: 2 }]);
  assert.strictEqual(leagueBlockTargeted(scope1, ['A', 'B'], 1), false, 'league preserved');

  // Case 2: user selects the League tile (slot 1) — should re-roll.
  const scope2 = buildRegenScope(divisions, scheduleAssignments, [{ bunk: 'A', slot: 1 }, { bunk: 'B', slot: 1 }]);
  assert.strictEqual(leagueBlockTargeted(scope2, ['A', 'B'], 1), true, 'league re-rolled');
});

// Capacity-repair-gate NO-BLANK net: a demoted regen slot is restored to its ORIGINAL
// activity iff that field is free; otherwise it stays Free. Mirrors the production guard.
function restoreDemotedRegenSlots(sa, regenScope, occByField) {
  const fieldFree = (fl, s, en) => !(occByField[fl] || []).some(iv => iv.s < en && iv.e > s);
  let filled = 0;
  Object.keys(sa).forEach(b => {
    const o = regenScope[b] && regenScope[b].orig;
    if (!o) return;
    (sa[b] || []).forEach((e, i) => {
      if (!e || !e._constraintDemoted) return;
      const orig = o[i];
      if (!orig || !orig.field) return;
      const fl = orig.field.toLowerCase();
      if (!fieldFree(fl, orig._startMin, orig._endMin)) return;
      sa[b][i] = Object.assign({}, orig, { _regenOriginalRestored: true });
      (occByField[fl] = occByField[fl] || []).push({ s: orig._startMin, e: orig._endMin });
      filled++;
    });
  });
  return filled;
}

test('no-blank net: demoted regen slot restores its original when the field is free', () => {
  // Bunk A slot 1 was regenerated, conflicted, and got demoted to Free by the gate.
  const sa = {
    A: [{ _activity: 'Swim', field: 'Pool', _startMin: 600, _endMin: 660 },
        { _activity: 'Free', field: 'Free', _startMin: 660, _endMin: 720, _constraintDemoted: true }],
  };
  const regenScope = { A: { orig: { 1: { _activity: 'Art', field: 'Art Room', _startMin: 660, _endMin: 720 } } } };
  const filled = restoreDemotedRegenSlots(sa, regenScope, {});
  assert.strictEqual(filled, 1);
  assert.strictEqual(sa.A[1]._activity, 'Art', 'original restored — no blank');
  assert.ok(sa.A[1]._regenOriginalRestored);
});

test('no-blank net: leaves Free when the original field is now occupied (no new conflict)', () => {
  const sa = {
    A: [{ _activity: 'Free', field: 'Free', _startMin: 660, _endMin: 720, _constraintDemoted: true }],
  };
  const regenScope = { A: { orig: { 0: { _activity: 'Art', field: 'Art Room', _startMin: 660, _endMin: 720 } } } };
  // Art Room already taken 660-720 by someone else.
  const occ = { 'art room': [{ s: 660, e: 720 }] };
  const filled = restoreDemotedRegenSlots(sa, regenScope, occ);
  assert.strictEqual(filled, 0);
  assert.strictEqual(sa.A[0]._activity, 'Free', 'stays Free rather than double-book');
});

// STEP 7.9 pinned-facility evict sweep, per-tile-regen scoping: during a per-tile regen
// it must only consider REGEN slots of IN-SCOPE bunks — never background bunks or kept
// slots. Mirrors the production skip predicate.
function step79ShouldSweep(regenScope, bunk, idx) {
  if (!regenScope) return true;                       // full gen — sweep everything
  const sc = regenScope[bunk];
  if (!sc) return false;                              // background bunk — preserve
  return !!(sc.regen && sc.regen.has(idx));           // only user-selected slots
}

test('STEP 7.9 evict sweep only touches regenerated slots during a per-tile regen', () => {
  const regenScope = {
    A: { regen: new Set([2]), keep: {}, orig: {} },   // in-scope, slot 2 selected
  };
  // Background bunk B (not in scope) — never swept, even on a "conflict".
  assert.strictEqual(step79ShouldSweep(regenScope, 'B', 0), false);
  assert.strictEqual(step79ShouldSweep(regenScope, 'B', 2), false);
  // In-scope bunk A: only the selected slot 2 is swept; kept slots preserved.
  assert.strictEqual(step79ShouldSweep(regenScope, 'A', 0), false);
  assert.strictEqual(step79ShouldSweep(regenScope, 'A', 2), true);
  // Full gen (no scope): sweep everything.
  assert.strictEqual(step79ShouldSweep(null, 'B', 0), true);
});

// STEP 5.6 field extraction — regular-league matchups are DISPLAY STRINGS
// "T1 vs T2 @ Field (Sport)"; specialty matchups are objects with .field.
function extractLeagueFields(matchups) {
  const s = new Set();
  matchups.forEach(m => {
    if (!m) return;
    if (typeof m === 'object' && m.field) { s.add(String(m.field).trim()); return; }
    if (typeof m === 'string') {
      const mm = m.match(/@\s*([^(@]+?)\s*(?:\(|$)/);
      if (mm && mm[1]) s.add(mm[1].trim());
    }
  });
  return [...s].filter(Boolean);
}

test('STEP 5.6 extracts fields from string AND object matchups; skips chinuch/bye lines', () => {
  const fields = extractLeagueFields([
    '1 vs 2 @ The Hatrick (Hockey)',
    '3 vs 4 @ Powerplay (Hockey)',
    'Armadila vs Squirel @ The Hatrick (Hockey)',   // dup field → deduped
    'Team 5 — Chinuch (Beis Medrash)',              // no "@" → skipped
    'Team 6 — BYE',                                 // no "@" → skipped
    { field: 'Grand Slam Park', sport: 'Baseball' } // specialty object form
  ]);
  assert.deepStrictEqual(fields.sort(), ['Grand Slam Park', 'Powerplay', 'The Hatrick']);
});

test('multi-period selection expands to the whole block', () => {
  const divisions = { Div1: { bunks: ['A'] } };
  // A 60-min Cooking spanning slots 1 & 2 (continuation), same _blockStart.
  const scheduleAssignments = {
    A: [
      { _activity: 'Swim', field: 'Pool', _startMin: 600, _blockStart: 600 },
      { _activity: 'Cooking', field: 'Kitchen', _startMin: 660, _blockStart: 660 },
      { _activity: 'Cooking', field: 'Kitchen', _startMin: 660, _blockStart: 660, continuation: true },
      { _activity: 'Art', field: 'Art Room', _startMin: 780, _blockStart: 780 },
    ],
  };
  // Select only slot 1 (the start of the spanned block).
  const scope = buildRegenScope(divisions, scheduleAssignments, [{ bunk: 'A', slot: 1 }]);
  assert.ok(scope.A.regen.has(1) && scope.A.regen.has(2), 'both halves of the block selected');
  const rebuilt = rebuildInScopeBunks(scheduleAssignments, scope, 4);
  assert.strictEqual(rebuilt.A[1], null);
  assert.strictEqual(rebuilt.A[2], null);
  assert.ok(rebuilt.A[0]._pinned && rebuilt.A[3]._pinned, 'unrelated slots preserved');
});
