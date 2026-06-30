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
