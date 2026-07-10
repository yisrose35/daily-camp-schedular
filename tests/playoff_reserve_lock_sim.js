// =============================================================================
// playoff_reserve_lock_sim.js
// -----------------------------------------------------------------------------
// Proves playoff reserved-field locks are airtight in the lock layer:
//
//   TEST 1 — a multi-division reserve (comma list) admits EVERY league division
//            and blocks all others. (Per-division lock calls used to overwrite
//            each other, leaving only the LAST division allowed.)
//   TEST 2 — time-based checks (what leagues + the solver hot loop use) block
//            other divisions via the lock's EXPLICIT time window — no slot-grid
//            guessing — and admit the league's own divisions.
//   TEST 3 — a plain single-division elective lock behaves exactly as before.
//   TEST 4 — getLockedFieldsAtSlot hides the field from members, shows it to others.
//
// Loads the REAL global_field_locks.js in a sandbox.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8');
const sandbox = {
    window: { divisionTimes: {} },
    document: { readyState: 'complete', addEventListener: function () {}, getElementById: function () { return null; } },
    console,
    Date,
    setTimeout: function () {}, clearTimeout: function () {},
    Object, Array, JSON, Math, String, Number,
};
sandbox.window.window = sandbox.window;
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const GFL = sandbox.window.GlobalFieldLocks;
assert(GFL, 'GlobalFieldLocks failed to load');

GFL.reset();

// A playoff league spanning two divisions reserves Canteen for its non-playing
// kids during 600–660, on slot 2.
const ok = GFL.lockFieldForDivision('Canteen', [2], 'Camp A > 4, Camp A > 5',
    'Playoff reserve (4th/5th League R2)', { startMin: 600, endMin: 660 });
assert(ok === true, 'reserve lock failed to apply');

// TEST 1 — slot-based check (isFieldLocked)
{
    assert.strictEqual(GFL.isFieldLocked('Canteen', [2], 'Camp A > 4'), null, 'T1: div 4 should be allowed');
    assert.strictEqual(GFL.isFieldLocked('Canteen', [2], 'Camp A > 5'), null, 'T1: div 5 should be allowed');
    const other = GFL.isFieldLocked('Canteen', [2], 'Day Camp > 6');
    assert(other && other.lockType === 'division', 'T1: foreign division must be locked out');
    const noCtx = GFL.isFieldLocked('Canteen', [2]);
    assert(noCtx, 'T1: no division context must be locked (safe default)');
    console.log('TEST 1 PASS — multi-division reserve admits both divisions, blocks others');
}

// TEST 2 — time-based check (isFieldLockedByTime), explicit window, no slot grid
{
    const hit = GFL.isFieldLockedByTime('Canteen', 610, 650, 'Day Camp > 6');
    assert(hit && hit.lockType === 'division', 'T2: overlapping foreign query must hit the lock');
    assert.strictEqual(GFL.isFieldLockedByTime('Canteen', 610, 650, 'Camp A > 5'), null, 'T2: member division must pass');
    assert.strictEqual(GFL.isFieldLockedByTime('Canteen', 700, 740, 'Day Camp > 6'), null, 'T2: non-overlapping window must pass');
    console.log('TEST 2 PASS — time checks enforce the explicit reserve window');
}

// TEST 3 — legacy single-division elective lock unchanged
{
    GFL.lockFieldForDivision('Art Room', [3], 'Juniors', 'Elective for Juniors', { startMin: 500, endMin: 540 });
    assert.strictEqual(GFL.isFieldLocked('Art Room', [3], 'Juniors'), null, 'T3: own division allowed');
    assert(GFL.isFieldLocked('Art Room', [3], 'Seniors'), 'T3: other division blocked');
    assert(GFL.isFieldLockedByTime('Art Room', 510, 530, 'Seniors'), 'T3: time check blocks others');
    assert.strictEqual(GFL.isFieldLockedByTime('Art Room', 510, 530, 'Juniors'), null, 'T3: time check admits owner');
    console.log('TEST 3 PASS — single-division elective locks behave as before');
}

// TEST 4 — getLockedFieldsAtSlot respects multi-division membership
{
    const forMember = GFL.getLockedFieldsAtSlot(2, 'Camp A > 4');
    assert(!forMember.includes('Canteen'), 'T4: member should not see Canteen as locked');
    const forOther = GFL.getLockedFieldsAtSlot(2, 'Day Camp > 6');
    assert(forOther.includes('Canteen'), 'T4: foreign division should see Canteen locked');
    console.log('TEST 4 PASS — getLockedFieldsAtSlot honors multi-division membership');
}

// TEST 5 — TWO leagues reserve the SAME field in the SAME period: division
// lists MERGE (the second lock used to overwrite the first, silently locking
// the first league's non-playing kids out of their own reserved field).
{
    GFL.lockFieldForDivision('Pool', [4], 'Camp A > 4, Camp A > 5',
        'Playoff reserve (4th/5th League R1)', { startMin: 800, endMin: 860 });
    GFL.lockFieldForDivision('Pool', [4], 'Day Camp > 6, Day Camp > 7',
        'Playoff reserve (6th/7th League R2)', { startMin: 800, endMin: 860 });
    ['Camp A > 4', 'Camp A > 5', 'Day Camp > 6', 'Day Camp > 7'].forEach(d => {
        assert.strictEqual(GFL.isFieldLocked('Pool', [4], d), null, 'T5: ' + d + ' should be allowed');
        assert.strictEqual(GFL.isFieldLockedByTime('Pool', 810, 850, d), null, 'T5: ' + d + ' should pass time check');
    });
    assert(GFL.isFieldLocked('Pool', [4], 'Grade 9'), 'T5: uninvolved division must stay blocked');
    assert(GFL.isFieldLockedByTime('Pool', 810, 850, 'Grade 9'), 'T5: uninvolved division must fail time check');
    console.log('TEST 5 PASS — overlapping reserves from two leagues merge division lists');
}

// TEST 6 — a GLOBAL lock still refuses a division lock on top of it.
{
    GFL.lockField('Main Field', [5], { lockedBy: 'regular_league', leagueName: 'X League', activity: 'X League Game' });
    const applied = GFL.lockFieldForDivision('Main Field', [5], 'Camp A > 4', 'Playoff reserve');
    assert.strictEqual(applied, false, 'T6: division lock must not override a global lock');
    console.log('TEST 6 PASS — global locks still take precedence over reserves');
}

console.log('\nALL TESTS PASSED — playoff reserve locks are division-tight');
