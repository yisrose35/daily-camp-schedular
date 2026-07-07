// =============================================================================
// elective_prelock_unscoped_sim.js
// -----------------------------------------------------------------------------
// Locks down STEP 2.5 (scheduler_core_main.js): elective tiles must register their
// GlobalFieldLocks facility lock UNCONDITIONALLY — never filtered by
// allowedDivisionsSet — so an elective keeps its facility reserved in FULL *and*
// PARTIAL (scoped) regens. This mirrors the STEP 2.45 pinned pre-lock fix.
//
// Why: in a partial regen the elective's OWN division is usually out of scope (its
// schedule is preserved, not re-solved). The sport path is still safe
// (window.fieldReservations is built from the FULL skeleton), but SmartTile
// specials + free-fill gate on GlobalFieldLocks.isFieldLockedByTime — which would
// MISS an out-of-scope elective's facility if STEP 2.5 skipped it, letting an
// IN-SCOPE division's special land on the reserved facility.
//
// Two checks:
//   (A) SOURCE GUARD — the real STEP 2.5 elective loop must NOT contain an
//       `allowedDivisionsSet` skip (regression guard against re-introducing it).
//   (B) BEHAVIORAL — a faithful mirror of the loop, driven with a minimal
//       DIVISION-aware GlobalFieldLocks stub, proves an out-of-scope elective locks
//       the facility against a foreign in-scope division but EXEMPTS its own grade.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- (A) SOURCE GUARD --------------------------------------------------------
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_main.js'), 'utf8');
    const start = src.indexOf('[STEP 2.5] Processing elective tiles');
    assert.ok(start !== -1, 'located STEP 2.5 banner in source');
    const end = src.indexOf('[Elective] Processed', start);
    assert.ok(end !== -1 && end > start, 'located end of STEP 2.5 elective loop');
    const block = src.slice(start, end);
    assert.ok(/item\.type === 'elective'/.test(block), 'STEP 2.5 scopes to elective tiles');
    assert.ok(!/allowedDivisionsSet\s*&&\s*!allowedDivisionsSet\.has/.test(block),
        'STEP 2.5 elective lock must NOT filter by allowedDivisionsSet (locks unconditionally)');
    console.log('SOURCE GUARD PASS — STEP 2.5 elective lock is not scoped by allowedDivisionsSet');
}

// ---- (B) BEHAVIORAL MIRROR ---------------------------------------------------
// Minimal DIVISION-aware GlobalFieldLocks stub: a division lock on a field blocks
// every division EXCEPT its allowedDivision during any overlapping window (mirrors
// isFieldLockedByTime for a lockType:'division' lock).
function makeLocks() {
    const byField = {}; // field → [{startMin,endMin,allowedDivision}]
    return {
        byField,
        lockFieldForDivision(field, slots, allowedDivision, reason, timeRange) {
            if (!field || !slots || !slots.length || !allowedDivision) return false;
            (byField[field] = byField[field] || []).push({
                startMin: timeRange.startMin, endMin: timeRange.endMin, allowedDivision
            });
            return true;
        },
        isFieldLockedByTime(field, s, e, divisionContext) {
            const locks = byField[field] || [];
            return locks.some(l =>
                s < l.endMin && e > l.startMin &&
                !(divisionContext && divisionContext === l.allowedDivision)
            ) || false;
        }
    };
}

// Faithful mirror of STEP 2.5's elective loop — WITH the fix (no allowedDivisionsSet
// filter; only the bunk-less-division guard remains). Any drift in the real loop is
// caught by (A).
function step25ElectiveLock(manualSkeleton, divisions, allowedDivisionsSet, Locks, helpers) {
    const { parseTimeToMinutes, findSlotsForRange } = helpers;
    let count = 0;
    manualSkeleton
        .filter(item => item.type === 'elective' || item.type === 'swim_elective')
        .forEach(elective => {
            const electiveDivision = elective.division;
            // NO allowedDivisionsSet filter — electives lock unconditionally.
            if (!((divisions[electiveDivision] && divisions[electiveDivision].bunks) || []).length) return;
            const baseActivities = elective.electiveActivities || [];
            const hybridSwimLoc = (elective.type === 'swim_elective' && elective.swimLocation) ? [elective.swimLocation] : [];
            const activities = Array.from(new Set([...baseActivities, ...hybridSwimLoc]));
            const startMin = parseTimeToMinutes(elective.startTime);
            const endMin = parseTimeToMinutes(elective.endTime);
            const slots = findSlotsForRange(startMin, endMin, electiveDivision);
            if (activities.length === 0 || slots.length === 0) return;
            activities.forEach(activityName => {
                const ok = Locks.lockFieldForDivision(activityName, slots, electiveDivision,
                    `Elective (${electiveDivision})`, { startMin, endMin });
                if (ok) count++;
            });
        });
    return count;
}

const helpers = {
    parseTimeToMinutes: (t) => {
        if (typeof t === 'number') return t;
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
        return m ? (+m[1]) * 60 + (+m[2]) : null;
    },
    findSlotsForRange: () => [0]
};

// Division A holds an elective on Rock Climbing + Archery @ 14:00–14:45.
const skeleton = [{
    type: 'elective', division: 'A', event: 'Elective',
    startTime: '14:00', endTime: '14:45',
    electiveActivities: ['Rock Climbing', 'Archery']
}];
const divisions = { 'A': { bunks: ['A1'] }, 'B': { bunks: ['B1'] } };

// =============================================================================
// TEST 1 — PARTIAL regen that EXCLUDES the elective's division (A) still locks the
//          facility, and an in-scope foreign division B is blocked; A is exempt.
// =============================================================================
{
    const Locks = makeLocks();
    const scope = new Set(['B']); // A is OUT of scope (preserved)
    const n = step25ElectiveLock(skeleton, divisions, scope, Locks, helpers);
    assert.strictEqual(n, 2, 'both elective activities locked despite division A being out of scope');
    // Foreign in-scope division B → blocked for the full window (this was the leak).
    assert.ok(Locks.isFieldLockedByTime('Rock Climbing', 840, 885, 'B'), 'foreign division B blocked across the window');
    assert.ok(Locks.isFieldLockedByTime('Archery', 850, 870, 'B'), 'second activity blocked for B too');
    // The elective's OWN grade A is exempt (division lock).
    assert.ok(!Locks.isFieldLockedByTime('Rock Climbing', 840, 885, 'A'), "elective's own grade A is exempt");
    // Disjoint time (after the elective) is free — lock is exactly the window.
    assert.ok(!Locks.isFieldLockedByTime('Rock Climbing', 885, 930, 'B'), 'after-window stays free');
    console.log('TEST 1 PASS — out-of-scope elective locks its facilities; foreign in-scope division blocked, own grade exempt');
}

// =============================================================================
// TEST 2 — FULL gen (allowedDivisionsSet null) is unchanged: electives still lock.
// =============================================================================
{
    const Locks = makeLocks();
    const n = step25ElectiveLock(skeleton, divisions, null, Locks, helpers);
    assert.strictEqual(n, 2, 'full gen locks all elective facilities (unchanged behavior)');
    assert.ok(Locks.isFieldLockedByTime('Archery', 840, 885, 'B'), 'Archery locked for foreign division');
    console.log('TEST 2 PASS — full gen behavior unchanged');
}

// =============================================================================
// TEST 3 — a swim+elective hybrid for an out-of-scope division locks the pool too.
// =============================================================================
{
    const Locks = makeLocks();
    const hybrid = [{ type: 'swim_elective', division: 'A', event: 'Swim + Elective',
        startTime: '10:00', endTime: '11:00', swimLocation: 'Main Pool',
        electiveActivities: ['Ropes Course'] }];
    const n = step25ElectiveLock(hybrid, divisions, new Set(['B']), Locks, helpers);
    assert.strictEqual(n, 2, 'hybrid locks the pool + the elective activity');
    assert.ok(Locks.isFieldLockedByTime('Main Pool', 600, 660, 'B'), 'pool locked against foreign division');
    assert.ok(Locks.isFieldLockedByTime('Ropes Course', 600, 660, 'B'), 'hybrid activity locked');
    console.log('TEST 3 PASS — out-of-scope swim+elective hybrid holds pool + activity');
}

console.log('\n✅ ALL elective_prelock_unscoped_sim TESTS PASSED');
