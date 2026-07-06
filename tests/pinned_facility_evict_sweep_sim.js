// =============================================================================
// pinned_facility_evict_sweep_sim.js
// -----------------------------------------------------------------------------
// Locks down STEP 7.9 (scheduler_core_main.js): the PINNED-FACILITY EXCLUSION
// SWEEP. After all placement/fill passes, any NON-pinned entry that physically
// sits on a facility a custom-pinned tile reserved (window.fieldReservations)
// during an overlapping time must be demoted to Free. This is the safety net
// for the real-world bug: "Masmidim pins Lake for 3:30–4:30, but a 5th-grade
// bunk (ג) also got Lake 3:30–4:50" — a cross-division double-book that a
// PARTIAL regen (ג preserved from an earlier gen) or a pin added after a prior
// gen can leave behind, which no in-gen gate re-examines.
//
// The sweep reads the SAME source the solver's canBlockFit uses
// (Utils.isFieldReserved over window.fieldReservations), so its verdict matches
// the generator's own gate. Per this repo's convention (see
// custom_pinned_facility_exclusion_sim.js, which tests a MIRROR of the free-fill
// guard), we load the REAL Utils.isFieldReserved from source and drive it
// through a faithful transcription of the STEP 7.9 predicate.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- Load the REAL Utils.isFieldReserved from scheduler_core_utils.js --------
// It's a tiny pure function; extract just its body so we don't drag in the whole
// module's load-time deps.
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8');
const m = utilsSrc.match(/Utils\.isFieldReserved\s*=\s*function[\s\S]*?\n    \};/);
assert.ok(m, 'located Utils.isFieldReserved in source');
const isFieldReserved = (0, eval)('(' + m[0].replace(/^\s*Utils\.isFieldReserved\s*=\s*/, '').replace(/;\s*$/, '') + ')');
assert.strictEqual(typeof isFieldReserved, 'function', 'isFieldReserved compiled');

// Sanity: the real function overlaps correctly.
const _r = { Lake: [{ startMin: 930, endMin: 990, division: 'מתמדים', event: 'Masmidim' }] };
assert.ok(isFieldReserved('Lake', 930, 1010, _r), 'real isFieldReserved: overlap detected');
assert.ok(!isFieldReserved('Lake', 990, 1050, _r), 'real isFieldReserved: disjoint → null');

// ---- Faithful MIRROR of the STEP 7.9 sweep predicate -------------------------
// Transcribes scheduler_core_main.js STEP 7.9 exactly. Mutates scheduleAssignments
// in place (arr[idx] → Free) and returns the eviction count.
function pinnedFacilityEvictSweep(scheduleAssignments, fieldReservations, specialActivities, getLocationForActivity) {
    const _resv = fieldReservations;
    if (!_resv || !Object.keys(_resv).length) return 0;
    const _resvKeyLc = {};
    Object.keys(_resv).forEach(k => { _resvKeyLc[String(k).toLowerCase().trim()] = k; });
    const _evSpecLoc = {};
    (specialActivities || []).forEach(s => {
        if (!s || !s.name || !s.location) return;
        const n = String(s.name).toLowerCase().trim();
        if (!_evSpecLoc[n]) _evSpecLoc[n] = s.location;
    });
    const _evSkip = { 'free': 1, 'free play': 1, 'free (timeout)': 1, 'no field': 1, 'lunch': 1,
        'snacks': 1, 'dismissal': 1, 'swim': 1, 'pool': 1, 'change': 1, 'cleanup': 1,
        'lineup': 1, 'transition': 1, 'buffer': 1, 'davening': 1, 'mincha': 1, 'main activity': 1 };
    let _evicted = 0;
    Object.keys(scheduleAssignments).forEach(bunk => {
        const arr = scheduleAssignments[bunk];
        if (!Array.isArray(arr)) return;
        arr.forEach((e, idx) => {
            if (!e || e._pinned || e.continuation || e._bunkOverride) return;
            if (e._isLeague || e._leagueMatchups || e.matchups || e._leagueName) return;
            const sM = e._startMin, eM = e._endMin;
            if (sM == null || eM == null) return;
            const act = e._activity || e.field;
            if (act && _evSkip[String(act).toLowerCase().trim()]) return;
            const cands = new Set();
            const _add = f => { if (f && typeof f === 'string' && f.trim() && f !== 'Free') cands.add(f.trim()); };
            _add(e.field);
            _add(e._location);
            if (Array.isArray(e._reservedFields)) e._reservedFields.forEach(_add);
            _add(_evSpecLoc[String(act || '').toLowerCase().trim()]);
            try { _add(getLocationForActivity && getLocationForActivity(act)); } catch (_ig) {}
            let hit = null;
            for (const cf of cands) {
                const key = _resvKeyLc[String(cf).toLowerCase().trim()];
                if (!key) continue;
                const r = isFieldReserved(key, sM, eM, _resv);
                if (r) { hit = { field: key, resv: r }; break; }
            }
            if (!hit) return;
            if (String(act || '').toLowerCase().trim() === String(hit.resv.event || '').toLowerCase().trim()) return;
            arr[idx] = { field: 'Free', _activity: 'Free', _startMin: sM, _endMin: eM, _pinnedFacilityEvicted: true };
            _evicted++;
        });
    });
    return _evicted;
}

// Reservation table mirroring what getFieldReservationsFromSkeleton produces for
// the Masmidim pin (reservedFields: Home Run Stadium, Lake, New Gym 1 @ 930–990).
const RESV = {
    'Home Run Stadium': [{ startMin: 930, endMin: 990, division: 'מתמדים', event: 'Masmidim' }],
    'Lake': [{ startMin: 930, endMin: 990, division: 'מתמדים', event: 'Masmidim' }],
    'New Gym 1': [{ startMin: 930, endMin: 990, division: 'מתמדים', event: 'Masmidim' }]
};
// Lake the SPECIAL is hosted at the facility literally named "Lake".
const SPECIALS = [{ name: 'Lake', location: 'Lake' }, { name: 'VR', location: 'VR Room' }];
const getLoc = (a) => (a === 'Lake' ? 'Lake' : (a === 'VR' ? 'VR Room' : null));

// =============================================================================
// TEST 1 — the reported bug: ג on Lake 930–1010 overlaps the pin → evicted
// =============================================================================
{
    const sa = {
        'ג':        [{ field: 'Lake', _activity: 'Lake', _startMin: 930, _endMin: 1010 }],
        'Masmidim': [{ field: 'Masmidim', _activity: 'Masmidim', _pinned: true, _startMin: 930, _endMin: 990,
                       _reservedFields: ['Home Run Stadium', 'Lake', 'New Gym 1'] }]
    };
    const n = pinnedFacilityEvictSweep(sa, RESV, SPECIALS, getLoc);
    assert.strictEqual(n, 1, 'exactly one eviction');
    assert.strictEqual(sa['ג'][0]._activity, 'Free', 'ג demoted to Free');
    assert.strictEqual(sa['ג'][0]._pinnedFacilityEvicted, true, 'eviction marker set');
    assert.strictEqual(sa['Masmidim'][0]._activity, 'Masmidim', 'the pin itself is untouched');
    console.log('TEST 1 PASS — ג\'s overlapping Lake demoted to Free; the pin stays');
}

// =============================================================================
// TEST 2 — no false positives: disjoint time, different facility, own pin fill
// =============================================================================
{
    const sa = {
        // Lake AFTER the pin window (990–1050) → legal, keep.
        'A': [{ field: 'Lake', _activity: 'Lake', _startMin: 990, _endMin: 1050 }],
        // A sport on a NON-reserved field during the window → keep.
        'B': [{ field: 'Powerplay', _activity: 'Hockey', _startMin: 930, _endMin: 990 }],
        // The pin's own filled bunk (flagged _pinned) → keep.
        'C': [{ field: 'Masmidim', _activity: 'Masmidim', _pinned: true, _startMin: 930, _endMin: 990,
                _reservedFields: ['Lake'] }]
    };
    const n = pinnedFacilityEvictSweep(sa, RESV, SPECIALS, getLoc);
    assert.strictEqual(n, 0, 'no evictions for legal placements');
    assert.strictEqual(sa['A'][0]._activity, 'Lake', 'disjoint-time Lake kept');
    assert.strictEqual(sa['B'][0]._activity, 'Hockey', 'unrelated field kept');
    assert.strictEqual(sa['C'][0]._activity, 'Masmidim', 'pin fill kept');
    console.log('TEST 2 PASS — disjoint time, unrelated field, and the pin fill are all left alone');
}

// =============================================================================
// TEST 3 — reserved SPORT field + special resolved via host room; skips leagues,
//          overrides, continuations, and pseudo-activities.
// =============================================================================
{
    const sa = {
        // Sport directly on a reserved sport field (Home Run Stadium) → evict.
        'D': [{ field: 'Home Run Stadium', _activity: 'Baseball', _startMin: 940, _endMin: 985 }],
        // Special filed by NAME whose host room is a reserved field → evict.
        //   special "VR" hosted at "VR Room" (not reserved) → keep;
        //   here use a special whose host IS reserved: fake "PoolParty"@New Gym 1.
        'E': [{ field: 'PoolParty', _activity: 'PoolParty', _startMin: 930, _endMin: 990, _location: 'New Gym 1' }],
        // League block (teams≠bunks) on a reserved field → NEVER touched.
        'F': [{ field: 'Home Run Stadium', _activity: 'Baseball', _isLeague: true, _startMin: 940, _endMin: 985 }],
        // Explicit user override on the reserved facility → respected, keep.
        'G': [{ field: 'Lake', _activity: 'Lake', _bunkOverride: true, _startMin: 930, _endMin: 990 }],
        // Continuation slot → skip (its lead handles it).
        'H': [{ field: 'Lake', _activity: 'Lake', continuation: true, _startMin: 930, _endMin: 990 }],
        // Pseudo-activity (Swim) that doesn't occupy a bookable facility → skip.
        'I': [{ field: 'Swim', _activity: 'Swim', _startMin: 930, _endMin: 990 }]
    };
    const n = pinnedFacilityEvictSweep(sa, RESV, SPECIALS, getLoc);
    assert.strictEqual(n, 2, 'sport-on-reserved-field and special-via-host-room evicted (2)');
    assert.strictEqual(sa['D'][0]._activity, 'Free', 'sport on reserved field evicted');
    assert.strictEqual(sa['E'][0]._activity, 'Free', 'special resolved via _location host room evicted');
    assert.strictEqual(sa['F'][0]._activity, 'Baseball', 'league block untouched');
    assert.strictEqual(sa['G'][0]._activity, 'Lake', 'bunk override respected');
    assert.strictEqual(sa['H'][0]._activity, 'Lake', 'continuation skipped');
    assert.strictEqual(sa['I'][0]._activity, 'Swim', 'pseudo-activity Swim skipped');
    console.log('TEST 3 PASS — reserved sport field + host-room special evicted; leagues/overrides/continuations/pseudo skipped');
}

// =============================================================================
// TEST 4 — killswitch parity: an empty reservation table is a clean no-op
// =============================================================================
{
    const sa = { 'ג': [{ field: 'Lake', _activity: 'Lake', _startMin: 930, _endMin: 1010 }] };
    const n = pinnedFacilityEvictSweep(sa, {}, SPECIALS, getLoc);
    assert.strictEqual(n, 0, 'no reservations → nothing evicted');
    assert.strictEqual(sa['ג'][0]._activity, 'Lake', 'entry untouched when no pins exist');
    console.log('TEST 4 PASS — empty reservation table is a no-op (matches clean-full-gen behavior)');
}

console.log('\n✅ ALL pinned_facility_evict_sweep_sim TESTS PASSED');
