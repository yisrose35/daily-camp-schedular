// =============================================================================
// rotation_active_date_authoritative_sim.js
// -----------------------------------------------------------------------------
// Locks down the hardened rebuildHistoricalCounts merge (scheduler_core_utils.js):
// on a PARTIAL local scan (near-quota browser keeps most dates in the cloud) the
// old code merged RAISE-ONLY, which froze a count high when the active date was
// edited DOWN — e.g. a mid-day rain erase that replaced an afternoon sport with
// Swim. The fix keeps raise-only protection for genuinely-absent dates but makes
// the active (re)generated date AUTHORITATIVE via its stored per-date breakdown.
//
// Mirrors the merge (keep in sync). Scenario: bunk X, activity Soccer.
//   D1  = past, LOCAL          → Soccer, Pizza
//   D2  = past, CLOUD-ONLY      → Soccer            (absent from the local scan)
//   07-05 sunny = active, LOCAL → Soccer(pm), Pizza(am)
//   07-05 rain  = active, LOCAL → Pizza only        (Soccer rained out)
// True Soccer after rain = D1 + D2 = 2 (07-05 Soccer gone). Old raise-only froze
// it at 3; the fix yields 2.
// =============================================================================

'use strict';
const assert = require('assert');

// Faithful mirror of the partial-scan merge (active date authoritative).
function mergePartial(prevCounts, prevByDate, counts, countsByDate, activeDate) {
  const oldActive = (activeDate && prevByDate[activeDate]) || null;
  if (!oldActive) {
    // transition: raise-only (no per-date baseline yet)
    const m = JSON.parse(JSON.stringify(prevCounts));
    Object.keys(counts).forEach(b => { m[b] = m[b] || {}; Object.keys(counts[b]).forEach(a => { m[b][a] = Math.max(m[b][a] || 0, counts[b][a]); }); });
    return m;
  }
  const newActive = (activeDate && countsByDate[activeDate]) || {};
  const floor = JSON.parse(JSON.stringify(prevCounts));
  Object.keys(oldActive).forEach(b => Object.keys(oldActive[b]).forEach(a => {
    if (floor[b] && floor[b][a] != null) floor[b][a] = Math.max(0, floor[b][a] - oldActive[b][a]);
  }));
  const freshRest = JSON.parse(JSON.stringify(counts));
  Object.keys(newActive).forEach(b => Object.keys(newActive[b]).forEach(a => {
    if (freshRest[b] && freshRest[b][a] != null) freshRest[b][a] = Math.max(0, freshRest[b][a] - newActive[b][a]);
  }));
  const merged = JSON.parse(JSON.stringify(floor));
  Object.keys(freshRest).forEach(b => { merged[b] = merged[b] || {}; Object.keys(freshRest[b]).forEach(a => { merged[b][a] = Math.max(merged[b][a] || 0, freshRest[b][a]); }); });
  Object.keys(newActive).forEach(b => { merged[b] = merged[b] || {}; Object.keys(newActive[b]).forEach(a => { merged[b][a] = (merged[b][a] || 0) + newActive[b][a]; }); });
  return merged;
}

// ---- Scenario state --------------------------------------------------------
// Cumulative after the sunny gen (all dates counted): Soccer 3 (D1+D2+0705), Pizza 2 (D1+0705)
const prevCounts = { X: { Soccer: 3, Pizza: 2 } };
// Per-date baseline stored during the sunny rebuild (active date = 07-05 sunny)
const prevByDate = { '2026-07-05': { X: { Soccer: 1, Pizza: 1 } } };
// Rain regen: local scan is D1 + 07-05 (D2 absent → PARTIAL). Cumulative over local:
//   Soccer = D1(1) + 0705rain(0) = 1 ; Pizza = D1(1) + 0705rain(1) = 2
const counts = { X: { Soccer: 1, Pizza: 2 } };
// Per-date for the active date after rain: Pizza only (Soccer rained out)
const countsByDate = { '2026-07-05': { X: { Pizza: 1 } } };

// TEST 1 — the fix: active date decrement is reflected; absent date protected.
{
  const m = mergePartial(prevCounts, prevByDate, counts, countsByDate, '2026-07-05');
  assert.strictEqual(m.X.Soccer, 2, 'Soccer drops to 2 (07-05 rained out) — D1+D2 still protected, NOT frozen at 3');
  assert.strictEqual(m.X.Pizza, 2, 'Pizza stays 2 (preserved morning special)');
  console.log('TEST 1 PASS — active date authoritative: Soccer 3→2 after rain, absent-date credit kept');
}

// TEST 2 — the OLD raise-only would have frozen Soccer at 3 (the bug we fixed).
{
  const oldMerged = JSON.parse(JSON.stringify(prevCounts));
  Object.keys(counts).forEach(b => Object.keys(counts[b]).forEach(a => { oldMerged[b][a] = Math.max(oldMerged[b][a] || 0, counts[b][a]); }));
  assert.strictEqual(oldMerged.X.Soccer, 3, 'old raise-only froze Soccer at 3 (stale-high) — this is what we fixed');
  console.log('TEST 2 PASS — confirms the old raise-only bug (Soccer frozen at 3) is what the fix removes');
}

// TEST 3 — an ADD on the active date is reflected (not just decrements).
{
  // 07-05 rain also gives X a NEW "Baking" it didn't have before.
  const counts3 = { X: { Soccer: 1, Pizza: 2, Baking: 1 } };
  const cbd3 = { '2026-07-05': { X: { Pizza: 1, Baking: 1 } } };
  const m = mergePartial(prevCounts, prevByDate, counts3, cbd3, '2026-07-05');
  assert.strictEqual(m.X.Baking, 1, 'new activity on the active date is added');
  assert.strictEqual(m.X.Soccer, 2, 'unrelated decrement still correct');
  console.log('TEST 3 PASS — adds on the active date are reflected too');
}

// TEST 4 — transition (no per-date baseline yet) falls back to safe raise-only.
{
  const m = mergePartial(prevCounts, {}, counts, countsByDate, '2026-07-05');
  assert.strictEqual(m.X.Soccer, 3, 'first run (no baseline) preserves via raise-only — never drops history');
  console.log('TEST 4 PASS — transition run is safe raise-only (self-heals on the next regen)');
}

console.log('\n✅ ALL rotation_active_date_authoritative_sim TESTS PASSED');
