// combo_sibling_lock_sim.js
// COMBO-MARKER SIBLING OVER-BLOCK (live: New Gym 2 idle all day).
// lockField(sub) propagates a 'combined_field' marker onto the combined field
// (correct — Full is unusable while a half is busy), but the combo lock-table
// scans in isFieldLocked / isFieldLockedByTime treated that MARKER as a real
// lock on the counterpart when checking the SIBLING sub → using New Gym 1
// froze New Gym 2 for the whole camp. Subs must never block each other.
// Drives the REAL global_field_locks.js with a stubbed window.
//
// Run: node tests/combo_sibling_lock_sim.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8');

function makeLocks(over = {}) {
    // Combo model: "Full Gym" = Gym 1 + Gym 2 (subs exclusive with Full only)
    const combos = {
        'full gym': ['Gym 1', 'Gym 2'],
        'gym 1': ['Full Gym'],
        'gym 2': ['Full Gym'],
    };
    const w = {
        __comboSiblingUnblock: over.killSwitch === false ? false : undefined,
        divisionTimes: over.divisionTimes || {},
        scheduleAssignments: over.scheduleAssignments || {},
        divisions: over.divisions || {},
        FieldCombos: {
            isInCombo: (f) => String(f || '').toLowerCase().trim() in combos,
            getExclusiveFields: (f) => (combos[String(f || '').toLowerCase().trim()] || []).slice(),
            isBlockedByCombo: (fieldName, s, e) => {
                // mirror of the real per-bunk scan over scheduleAssignments
                const conflicts = (combos[String(fieldName || '').toLowerCase().trim()] || [])
                    .map(x => x.toLowerCase().trim());
                for (const bunk in (w.scheduleAssignments || {})) {
                    for (const entry of (w.scheduleAssignments[bunk] || [])) {
                        if (!entry || !entry.field) continue;
                        if (!conflicts.includes(String(entry.field).toLowerCase().trim())) continue;
                        if (entry._startMin < e && entry._endMin > s) {
                            return { blocked: true, blocker: entry.field };
                        }
                    }
                }
                return { blocked: false };
            },
        },
    };
    new Function('window', 'document', src)(w, {
        getElementById: () => ({}), createElement: () => ({ style: {} }),
        head: { appendChild() {} }, body: { appendChild() {} },
        addEventListener() {}, removeEventListener() {},
    });
    if (!w.GlobalFieldLocks) throw new Error('GlobalFieldLocks missing');
    w.GlobalFieldLocks.reset();
    return w;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// T1 — THE BUG: locking Gym 1 must NOT block Gym 2 (sibling), must block Full
{
    const w = makeLocks();
    const ok = w.GlobalFieldLocks.lockField('Gym 1', [0], {
        lockedBy: 'regular_league', leagueName: 'Test League', division: 'A',
        startMin: 800, endMin: 860,
    });
    check('T1  lockField(Gym 1) succeeds + propagates marker to Full Gym',
        ok === true && !!Object.values(w.GlobalFieldLocks._locks).some(sl => sl['full gym']));
    const g2 = w.GlobalFieldLocks.isFieldLockedByTime('Gym 2', 800, 860, 'B');
    check('T2  SIBLING FREE: Gym 2 not blocked while only Gym 1 is in use',
        g2 === null, JSON.stringify(g2));
    const full = w.GlobalFieldLocks.isFieldLockedByTime('Full Gym', 800, 860, 'B');
    check('T3  Full Gym still blocked while Gym 1 is in use (marker direct hit)',
        full !== null, JSON.stringify(full));
    const g1 = w.GlobalFieldLocks.isFieldLockedByTime('Gym 1', 800, 860, 'B');
    check('T4  Gym 1 itself still blocked (real lock)', g1 !== null);
    // slot-based check too (isFieldLocked path)
    w.divisionTimes.B = [{ startMin: 800, endMin: 860 }];
    const g2Slot = w.GlobalFieldLocks.isFieldLocked('Gym 2', [0], 'B');
    check('T5  slot-based isFieldLocked also leaves Gym 2 free',
        g2Slot === null || g2Slot === undefined, JSON.stringify(g2Slot));
}

// T6 — REAL Full lock still blocks BOTH subs (propagated direct markers)
{
    const w = makeLocks();
    w.GlobalFieldLocks.lockField('Full Gym', [0], {
        lockedBy: 'regular_league', leagueName: 'Big Game', division: 'A',
        startMin: 800, endMin: 860,
    });
    const g1 = w.GlobalFieldLocks.isFieldLockedByTime('Gym 1', 800, 860, 'B');
    const g2 = w.GlobalFieldLocks.isFieldLockedByTime('Gym 2', 800, 860, 'B');
    check('T6  REAL Full Gym lock still blocks Gym 1 AND Gym 2',
        g1 !== null && g2 !== null, JSON.stringify({ g1, g2 }));
}

// T7 — disjoint times: Gym 1 locked 800-860 must not block Gym 2 at 900-960 either
{
    const w = makeLocks();
    w.GlobalFieldLocks.lockField('Gym 1', [0], {
        lockedBy: 'pinned', activity: 'Event', division: 'A', startMin: 800, endMin: 860,
    });
    const g2Later = w.GlobalFieldLocks.isFieldLockedByTime('Gym 2', 900, 960, 'B');
    const fullLater = w.GlobalFieldLocks.isFieldLockedByTime('Full Gym', 900, 960, 'B');
    check('T7  disjoint window: Gym 2 and Full Gym both free after Gym 1 lock ends',
        g2Later === null && fullLater === null, JSON.stringify({ g2Later, fullLater }));
}

// T8 — per-bunk usage of Full (scheduleAssignments) still blocks subs
{
    const w = makeLocks({
        scheduleAssignments: { b1: [{ field: 'Full Gym', _startMin: 800, _endMin: 860 }] },
    });
    const g2 = w.GlobalFieldLocks.isFieldLockedByTime('Gym 2', 800, 860, 'B');
    check('T8  Full Gym in per-bunk use still blocks Gym 2 (isBlockedByCombo path)',
        g2 !== null && g2.lockedBy === 'combined_field', JSON.stringify(g2));
}

// T9 — kill switch restores legacy (sibling blocked again)
{
    const w = makeLocks({ killSwitch: false });
    w.GlobalFieldLocks.lockField('Gym 1', [0], {
        lockedBy: 'regular_league', leagueName: 'L', division: 'A', startMin: 800, endMin: 860,
    });
    const g2 = w.GlobalFieldLocks.isFieldLockedByTime('Gym 2', 800, 860, 'B');
    check('T9  kill switch (__comboSiblingUnblock=false) restores legacy sibling block',
        g2 !== null, JSON.stringify(g2));
}

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
