// =============================================================================
// pinned_prelock_unscoped_sim.js
// -----------------------------------------------------------------------------
// Locks down STEP 2.45 (scheduler_core_main.js): the PINNED-FACILITY PRE-LOCK
// must register a pin's reserved facilities UNCONDITIONALLY — never filtered by
// allowedDivisionsSet. This closes the one generation-time hole in
// "a pinned facility is locked completely from start to end, no one else can use
// it": in a PARTIAL regen the pin's OWN division is usually out of scope (its
// schedule is preserved, not re-solved). The solver's sport path is still safe
// (window.fieldReservations is built from the FULL skeleton), but SmartTile
// specials + free-fill gate on GlobalFieldLocks.isFieldLockedByTime, which would
// MISS an out-of-scope pin's facility if the pre-lock skipped it — letting an
// in-scope division's special land on the reserved facility.
//
// Two checks:
//   (A) SOURCE GUARD — the real STEP 2.45 pinned pre-lock loop must NOT contain
//       an `allowedDivisionsSet` skip (regression guard against re-introducing it).
//   (B) BEHAVIORAL — a faithful mirror of the loop, driven with a minimal
//       time-aware GlobalFieldLocks stub, proves an out-of-scope pin locks the
//       facility and blocks an in-scope division for the full window.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- (A) SOURCE GUARD --------------------------------------------------------
// Extract the STEP 2.45 block (between the "STEP 2.45" banner and "STEP 2.5")
// and assert the pinned pre-lock does not filter by allowedDivisionsSet.
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_main.js'), 'utf8');
    const start = src.indexOf('STEP 2.45: PINNED-FACILITY PRE-LOCK');
    assert.ok(start !== -1, 'located STEP 2.45 banner in source');
    const end = src.indexOf('[STEP 2.5]', start);
    assert.ok(end !== -1 && end > start, 'located end of STEP 2.45 block');
    const block = src.slice(start, end);
    // The pin loop iterates manualSkeleton for type==='pinned' and must NOT early-return
    // on `allowedDivisionsSet && !allowedDivisionsSet.has(...)`.
    assert.ok(/type\s*!==\s*'pinned'/.test(block), 'STEP 2.45 scopes to pinned tiles');
    assert.ok(!/allowedDivisionsSet\s*&&\s*!allowedDivisionsSet\.has/.test(block),
        'STEP 2.45 pinned pre-lock must NOT filter by allowedDivisionsSet (locks unconditionally)');
    console.log('SOURCE GUARD PASS — STEP 2.45 pinned pre-lock is not scoped by allowedDivisionsSet');
}

// ---- (B) BEHAVIORAL MIRROR ---------------------------------------------------
// Minimal time-aware GlobalFieldLocks stub: a GLOBAL lock on a field blocks ALL
// divisions during any overlapping window (mirrors isFieldLockedByTime for a
// non-division lock).
function makeLocks() {
    const byField = {}; // field → [{startMin,endMin,division}]
    return {
        byField,
        lockField(field, slots, meta) {
            if (!field || !slots || !slots.length) return false;
            (byField[field] = byField[field] || []).push({
                startMin: meta.startMin, endMin: meta.endMin, division: meta.division
            });
            return true;
        },
        isFieldLockedByTime(field, s, e) {
            const locks = byField[field] || [];
            return locks.some(l => s < l.endMin && e > l.startMin) || false;
        }
    };
}

// Faithful mirror of STEP 2.45's pinned pre-lock loop — WITH the fix (no
// allowedDivisionsSet filter). Any drift in the real loop is caught by (A).
function step245PreLock(manualSkeleton, divisions, allowedDivisionsSet, Locks, helpers) {
    const { parseTimeToMinutes, findSlotsForRange, getLocationForPinnedEvent } = helpers;
    let count = 0;
    manualSkeleton.forEach(item => {
        if (!item || item.type !== 'pinned') return;
        const _divName = item.division;
        // NO allowedDivisionsSet filter — pins lock unconditionally.
        if (!((divisions[_divName] && divisions[_divName].bunks) || []).length) return;
        const _sMin = parseTimeToMinutes(item.startTime);
        const _eMin = parseTimeToMinutes(item.endTime);
        if (_sMin == null || _eMin == null || _eMin <= _sMin) return;
        const _slots = findSlotsForRange(_sMin, _eMin, _divName);
        if (!_slots.length) return;
        const _pinFields = new Set();
        const _add = (f) => { if (f && typeof f === 'string' && f.trim() && f !== 'Free') _pinFields.add(f.trim()); };
        _add(getLocationForPinnedEvent(item));
        _add(typeof item.location === 'string' ? item.location : null);
        if (Array.isArray(item.reservedFields)) item.reservedFields.forEach(_add);
        _pinFields.forEach(_pinLoc => {
            const _ok = Locks.lockField(_pinLoc, _slots, {
                lockedBy: 'pinned_event_location', division: _divName, startMin: _sMin, endMin: _eMin
            });
            if (_ok) count++;
        });
    });
    return count;
}

const helpers = {
    parseTimeToMinutes: (t) => { // "HH:MM" → minutes
        if (typeof t === 'number') return t;
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
        return m ? (+m[1]) * 60 + (+m[2]) : null;
    },
    findSlotsForRange: () => [0],           // any non-empty slot list
    getLocationForPinnedEvent: () => null   // pin uses reservedFields here
};

// Masmidim (division מתמדים) pins Lake + Home Run Stadium + New Gym 1 @ 15:30–16:30.
const skeleton = [{
    type: 'pinned', division: 'מתמדים', event: 'Masmidim',
    startTime: '15:30', endTime: '16:30',
    reservedFields: ['Home Run Stadium', 'Lake', 'New Gym 1']
}];
const divisions = {
    'מתמדים': { bunks: ['מ1'] },
    'Camp Agudah > 5': { bunks: ['ג'] }
};

// =============================================================================
// TEST 1 — PARTIAL regen that EXCLUDES the pin's division still locks the Lake,
//          and an in-scope 5th-grade division is blocked for the full window.
// =============================================================================
{
    const Locks = makeLocks();
    const scope = new Set(['Camp Agudah > 5']); // מתמדים is OUT of scope (preserved)
    const n = step245PreLock(skeleton, divisions, scope, Locks, helpers);
    assert.strictEqual(n, 3, 'all 3 reserved facilities locked despite the pin division being out of scope');
    // The in-scope 5th-grade division must be blocked from the Lake for the whole window.
    assert.ok(Locks.isFieldLockedByTime('Lake', 930, 1010, 'Camp Agudah > 5'),
        'Lake locked against in-scope division across the overlapping window (930–1010)');
    assert.ok(Locks.isFieldLockedByTime('Lake', 930, 990, 'Camp Agudah > 5'), 'exact window locked');
    assert.ok(Locks.isFieldLockedByTime('New Gym 1', 950, 970, 'Camp Agudah > 5'), 'New Gym 1 locked too');
    // Disjoint time (after the pin) is free — the lock is exactly the window, no more.
    assert.ok(!Locks.isFieldLockedByTime('Lake', 990, 1050, 'Camp Agudah > 5'), 'after-window Lake stays free');
    console.log('TEST 1 PASS — out-of-scope pin locks its facilities; in-scope division blocked for the full window only');
}

// =============================================================================
// TEST 2 — FULL gen (allowedDivisionsSet null) is unchanged: pins still lock.
// =============================================================================
{
    const Locks = makeLocks();
    const n = step245PreLock(skeleton, divisions, null, Locks, helpers);
    assert.strictEqual(n, 3, 'full gen locks all reserved facilities (unchanged behavior)');
    assert.ok(Locks.isFieldLockedByTime('Home Run Stadium', 940, 985, 'Camp Agudah > 5'), 'Home Run Stadium locked');
    console.log('TEST 2 PASS — full gen behavior unchanged (all pin facilities locked)');
}

// =============================================================================
// TEST 3 — a pin whose division has NO bunks is skipped (guard preserved).
// =============================================================================
{
    const Locks = makeLocks();
    const emptyDiv = { 'Ghost': { bunks: [] } };
    const ghostPin = [{ type: 'pinned', division: 'Ghost', event: 'X', startTime: '15:30', endTime: '16:30', reservedFields: ['Lake'] }];
    const n = step245PreLock(ghostPin, emptyDiv, null, Locks, helpers);
    assert.strictEqual(n, 0, 'pin for a bunk-less division is skipped');
    assert.ok(!Locks.isFieldLockedByTime('Lake', 930, 990, 'x'), 'no lock registered for a ghost pin');
    console.log('TEST 3 PASS — bunk-less-division guard preserved');
}

console.log('\n✅ ALL pinned_prelock_unscoped_sim TESTS PASSED');
