// =============================================================================
// league_pool_numeric_timekey_sim.js
// -----------------------------------------------------------------------------
// Regression sim for the PHANTOM FIELD SHORTAGE bug:
//   "1 league game is not being generated" + "too many teams are getting byes"
//
// SYMPTOM (live log, 2026-07-25, camp with staggered league clocks):
//   - All Stars Game 10 @900: "Available Field/Sport Combinations: 1"
//     → 2 of 3 matchups got "Not enough fields" byes.
//   - Majors Game 12 @900:   "Available Field/Sport Combinations: 0"
//     → "PERIOD SKIPPED — No fields were open".
//   ...while ~13 fields physically existed and only 4 were genuinely locked.
//
// ROOT CAUSE (NOT over-wide locks — the lock windows were all correct):
//   `blocksByTime` keys come from Object.keys(), so `timeKey` is the STRING
//   "900". buildAvailableFieldSportPool converted it with parseTimeToMinutes,
//   which only accepts clock text ("3:00pm") and returns null for a bare
//   numeric string. That null triggered the fallback:
//         _poolStartMin = divisionTimes[thisLeagueDiv][slots[0]].startMin
//   where `slots` was taken from sampleBlock — ANOTHER division's block. With
//   staggered/coarser grade grids the same slot INDEX is a different wall-clock
//   time, so the pool queried a window starting HOURS early, swept in still-
//   valid locks from earlier periods, and reported a phantom field shortage.
//
//   Real data: 5th's grid is coarser than 7th+8th's. Slot #4 is 900-950 for
//   5th but 780-830 for 7th+8th. sampleBlock was 5th's (slots=[4]), so All
//   Stars (7th+8th) queried [780,950] instead of [900,950].
//
// THE FIX: coerce numeric strings FIRST in _toPoolMin (mirrors the lock-
// creation path, which already did Number(timeKey) and is why the LOCKS were
// correct while the QUERY was not).
//
// This sim drives the REAL parseTimeToMinutes and the REAL GlobalFieldLocks,
// using the grids + lock table dumped from the user's live session.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// --- Minimal browser shims so the IIFE modules can load ----------------------
let _now = 1;
global.window = {
    divisionTimes: {},
    addEventListener: () => {},
    DEBUG_GLOBAL_LOCKS: false,
};
global.document = { readyState: 'complete', addEventListener: () => {} };
global.Date = class extends Date { static now() { return _now++; } };

// Load the REAL lock module (attaches window.GlobalFieldLocks)
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'global_field_locks.js'), 'utf8'));
const GFL = global.window.GlobalFieldLocks;
assert.ok(GFL, 'GlobalFieldLocks loaded');

// Load the REAL SchedulerCoreUtils (for the genuine parseTimeToMinutes)
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8'));
const parseTimeToMinutes = global.window.SchedulerCoreUtils.parseTimeToMinutes;
assert.strictEqual(typeof parseTimeToMinutes, 'function', 'parseTimeToMinutes loaded');

// =============================================================================
// TEST 0 — pin the trap itself: parseTimeToMinutes("900") really is null
// =============================================================================
assert.strictEqual(parseTimeToMinutes('900'), null,
    'parseTimeToMinutes must return null for a bare numeric string (the trap)');
assert.strictEqual(parseTimeToMinutes(900), 900, 'numbers still pass through');
assert.strictEqual(parseTimeToMinutes('3:00pm'), 900, 'clock text still parses');
console.log('TEST 0 PASS — parseTimeToMinutes("900") === null (the numeric-string trap is real)');

// --- The user's REAL division grids (from the live console dump) -------------
global.window.divisionTimes = {
    // NOTE 5th is COARSER: its slot #0 spans 585-725, so every later index is
    // shifted relative to the other grades.
    '5th':     [{ startMin: 585, endMin: 725 }, { startMin: 730, endMin: 770 },
                { startMin: 780, endMin: 830 }, { startMin: 840, endMin: 890 },
                { startMin: 900, endMin: 950 }],
    '6th':     [{ startMin: 585, endMin: 630 }, { startMin: 640, endMin: 680 },
                { startMin: 685, endMin: 725 }, { startMin: 730, endMin: 770 },
                { startMin: 780, endMin: 830 }, { startMin: 840, endMin: 890 },
                { startMin: 900, endMin: 950 }],
    '7th+8th': [{ startMin: 585, endMin: 630 }, { startMin: 640, endMin: 680 },
                { startMin: 685, endMin: 725 }, { startMin: 730, endMin: 770 },
                { startMin: 780, endMin: 830 }, { startMin: 840, endMin: 890 },
                { startMin: 900, endMin: 950 }],
};

// --- The user's REAL lock table at the moment the 900 period runs ------------
// (every window here is CORRECT and tight — the locks were never the bug)
const LIVE_LOCKS = [
    ['0',      'Football (field 1)',      585, 630, 'All Stars'],
    ['0',      'Small Turf',              585, 630, 'All Stars'],
    ['0',      'New Gym Bball(2)',        585, 630, 'Majors'],
    ['0',      'New Gym bball(1)',        585, 630, 'Majors'],
    ['0',      'Old Gym Hockey',          585, 630, 'Double A'],
    ['0',      'Lower bball (2)',         585, 630, 'Single A'],
    ['1',      'New Gym Bball(2)',        640, 680, 'All Stars'],
    ['1',      'New Gym bball(1)',        640, 680, 'All Stars'],
    ['1',      'Hockey(Rink)',            640, 680, 'Majors'],
    ['1',      'Small Turf',              640, 680, 'Majors'],
    ['1',      'Old Gym Hockey',          640, 680, 'Double A'],
    ['1',      'Red and Black bball (1)', 640, 680, 'Single A'],
    ['2',      'Old Gym Hockey',          685, 725, 'All Stars'],
    ['2',      'Football (field 2)',      685, 725, 'All Stars'],
    ['2',      'New Gym bball(1)',        685, 725, 'Majors'],
    ['2',      'New Gym Bball(2)',        685, 725, 'Majors'],
    ['3',      'New Gym bball(1)',        730, 770, 'All Stars'],
    ['3',      'New Gym Bball(2)',        730, 770, 'All Stars'],
    ['3',      'Football (field 2)',      730, 770, 'All Stars'],
    ['2',      'Small Turf',              780, 820, 'Majors'],
    ['2',      'Football (field 1)',      780, 820, 'Majors'],
    ['2#780',  'New Gym bball(1)',        780, 830, 'Triple A'],
    ['2#780',  'New Gym Bball(2)',        780, 830, 'Triple A'],
    ['3',      'Hockey(Rink)',            840, 880, 'All Stars'],
    ['3',      'Upper(bball)',            840, 880, 'All Stars'],
    ['3',      'Lower bball (1)',         840, 880, 'All Stars'],
    ['3',      'Old Gym Hockey',          840, 880, 'Majors'],
    ['3',      'Lower bball (2)',         840, 880, 'Majors'],
    ['3#840',  'New Gym bball(1)',        840, 890, 'Triple A'],
    ['3#840',  'New Gym Bball(2)',        840, 890, 'Triple A'],
];

// The courts available to the SENIOR leagues (All Stars / Majors). Taken from
// the live log: with nothing locked both reported exactly these 10 combos. The
// "Red and Black" courts are deliberately absent — the live log shows they only
// ever reach Double A / Single A, so including them would overstate the pool.
const ALL_FIELDS = [
    'Lower bball (2)', 'New Gym bball(1)', 'New Gym Bball(2)', 'Old Gym Hockey',
    'Hockey(Rink)', 'Upper(bball)', 'Lower bball (1)', 'Football (field 1)',
    'Football (field 2)', 'Small Turf',
];

function seedLiveLocks() {
    GFL.reset();
    // Write straight into the registry so the exact live slotKeys (incl. the
    // time-qualified '2#780' / '3#840' keys) are reproduced verbatim.
    for (const [slotKey, field, startMin, endMin, leagueName] of LIVE_LOCKS) {
        if (!GFL._locks[slotKey]) GFL._locks[slotKey] = {};
        GFL._locks[slotKey][field.toLowerCase().trim()] = {
            lockedBy: 'regular_league', lockType: 'global',
            fieldName: field, leagueName, startMin, endMin, timestamp: 1,
        };
    }
}

// --- The two _toPoolMin implementations (old = buggy, new = fixed) -----------
function toPoolMin_OLD(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    const n = parseTimeToMinutes(v);
    return (n == null || isNaN(Number(n))) ? null : Number(n);
}
function toPoolMin_NEW(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    const _s = String(v).trim();
    if (_s !== '' && !isNaN(Number(_s))) return Number(_s);   // ★ the fix
    const n = parseTimeToMinutes(v);
    return (n == null || isNaN(Number(n))) ? null : Number(n);
}

// Faithful replica of buildAvailableFieldSportPool's window derivation + the
// per-field lock scan (lines ~1007-1057 of scheduler_core_leagues.js).
function poolFor(toPoolMin, leagueDiv, timeKey, slots, blockEndMin) {
    const divSlots = global.window.divisionTimes[leagueDiv] || [];
    let s = toPoolMin(timeKey);
    let e = toPoolMin(blockEndMin);
    if (s == null && slots.length) s = divSlots[slots[0]] && divSlots[slots[0]].startMin;
    if (e == null && slots.length) {
        const last = divSlots[slots[slots.length - 1]];
        e = last && last.endMin;
    }
    if (s != null && (e == null || e <= s)) e = s + 40;
    const open = ALL_FIELDS.filter(f => GFL.isFieldLockedByTime(f, s, e, leagueDiv) === null);
    return { window: [s, e], open };
}

// The 900 period. sampleBlock is the 5th-grade block → slots = [4].
// (5th's #4 is 900-950; but 7th+8th's #4 is 780-830 — that mismatch is the bug.)
const TIME_KEY_900 = '900';       // STRING, exactly as Object.keys() yields it
const SLOTS_900 = [4];
const BLOCK_END_900 = 950;

// =============================================================================
// TEST 1 — OLD code reproduces BOTH live symptoms
// =============================================================================
seedLiveLocks();
{
    const allStars = poolFor(toPoolMin_OLD, '7th+8th', TIME_KEY_900, SLOTS_900, BLOCK_END_900);
    assert.deepStrictEqual(allStars.window, [780, 950],
        'OLD: All Stars mis-derives its window to [780,950] via the foreign slot index');
    assert.strictEqual(allStars.open.length, 1,
        'OLD: All Stars sees only 1 open field (live log said exactly 1) → field-shortage byes');
    assert.deepStrictEqual(allStars.open, ['Football (field 2)'],
        'OLD: and that single field is Football (field 2), matching the live log verbatim');

    // Majors runs next; All Stars has by then locked its one field too.
    GFL._locks['4'] = GFL._locks['4'] || {};
    GFL._locks['4']['football (field 2)'] = {
        lockedBy: 'regular_league', lockType: 'global', fieldName: 'Football (field 2)',
        leagueName: 'All Stars', startMin: 900, endMin: 940, timestamp: 1,
    };
    const majors = poolFor(toPoolMin_OLD, '6th', TIME_KEY_900, SLOTS_900, BLOCK_END_900);
    assert.strictEqual(majors.open.length, 0,
        'OLD: Majors sees 0 open fields → "PERIOD SKIPPED" (the missing game)');
}
console.log('TEST 1 PASS — OLD code reproduces BOTH symptoms: All Stars 1 field (byes), Majors 0 fields (skipped period)');

// =============================================================================
// TEST 2 — NEW code restores the real availability
// =============================================================================
seedLiveLocks();
{
    // At the moment All Stars builds its 900 pool, every seeded lock has already
    // ended (latest is 840-890). So ALL 10 courts are genuinely free.
    const allStars = poolFor(toPoolMin_NEW, '7th+8th', TIME_KEY_900, SLOTS_900, BLOCK_END_900);
    assert.deepStrictEqual(allStars.window, [900, 950],
        'NEW: window anchors on the numeric timeKey → [900,950]');
    assert.strictEqual(allStars.open.length, 10,
        `NEW: All Stars gets its full 10-court pool back, got ${allStars.open.length}`);
    // Specifically, fields locked only in EARLIER periods are free again.
    assert.ok(allStars.open.includes('Old Gym Hockey'),  'NEW: 840-880 lock no longer bleeds into 900');
    assert.ok(allStars.open.includes('Hockey(Rink)'),    'NEW: 840-880 lock no longer bleeds into 900');
    assert.ok(allStars.open.includes('Upper(bball)'),    'NEW: 840-880 lock no longer bleeds into 900');
    assert.ok(allStars.open.includes('New Gym bball(1)'),'NEW: 840-890 Triple A lock no longer bleeds into 900');

    // All Stars needed 3 fields for its 3 matchups — it now has far more than 3,
    // so NEITHER "Team 25 v 27" NOR "Team 26 v 30" gets a field-shortage bye.
    assert.ok(allStars.open.length >= 3,
        'NEW: enough courts for all 3 All Stars matchups → no field-shortage byes');

    // Majors runs next. Simulate All Stars claiming 3 courts, then check Majors.
    for (const f of allStars.open.slice(0, 3)) {
        GFL._locks['4'] = GFL._locks['4'] || {};
        GFL._locks['4'][f.toLowerCase().trim()] = {
            lockedBy: 'regular_league', lockType: 'global', fieldName: f,
            leagueName: 'All Stars', startMin: 900, endMin: 950, timestamp: 1,
        };
    }
    const majors = poolFor(toPoolMin_NEW, '6th', TIME_KEY_900, SLOTS_900, BLOCK_END_900);
    assert.deepStrictEqual(majors.window, [900, 950], 'NEW: Majors derives the same correct window');
    assert.strictEqual(majors.open.length, 7,
        `NEW: Majors sees the 7 courts All Stars did not take, got ${majors.open.length}`);
    assert.ok(majors.open.length >= 2,
        'NEW: Majors has courts for its 2 matchups → period is NOT skipped');
}
console.log('TEST 2 PASS — NEW code gives All Stars + Majors their real field pools back at 900');

// =============================================================================
// TEST 3 — cross-league exclusion still works (no over-permissiveness)
// =============================================================================
seedLiveLocks();
{
    // All Stars takes Upper(bball) at 900 and locks it.
    GFL._locks['4'] = GFL._locks['4'] || {};
    GFL._locks['4']['upper(bball)'] = {
        lockedBy: 'regular_league', lockType: 'global', fieldName: 'Upper(bball)',
        leagueName: 'All Stars', startMin: 900, endMin: 950, timestamp: 1,
    };
    const majors = poolFor(toPoolMin_NEW, '6th', TIME_KEY_900, SLOTS_900, BLOCK_END_900);
    assert.ok(!majors.open.includes('Upper(bball)'),
        'NEW: a same-period lock from another league MUST still exclude the field (no double-book)');
}
console.log('TEST 3 PASS — same-period cross-league locks still exclude (fix is not over-permissive)');

// =============================================================================
// TEST 4 — earlier periods are unaffected (no regression at 640/780/840)
// =============================================================================
seedLiveLocks();
{
    // At 640, Majors must still be excluded from All Stars' New Gym locks.
    const majors640 = poolFor(toPoolMin_NEW, '6th', '640', [1], 680);
    assert.deepStrictEqual(majors640.window, [640, 680], 'NEW: 640 window correct');
    assert.ok(!majors640.open.includes('New Gym bball(1)'),
        'NEW: All Stars 640-680 lock still excludes Majors');
    assert.ok(!majors640.open.includes('New Gym Bball(2)'),
        'NEW: All Stars 640-680 lock still excludes Majors');
    // ...but a field only locked at 585-630 is free again at 640.
    assert.ok(majors640.open.includes('Lower bball (2)'),
        'NEW: the 585-630 lock does not bleed into the 640 period');

    // Triple A at 780 (its own grid slot #2 == 780-830) stays correct.
    const tripleA780 = poolFor(toPoolMin_NEW, '5th', '780', [2], 830);
    assert.deepStrictEqual(tripleA780.window, [780, 830], 'NEW: Triple A 780 window correct');
    assert.ok(!tripleA780.open.includes('Small Turf'),
        'NEW: Majors 780-820 lock still excludes Triple A');
}
console.log('TEST 4 PASS — earlier periods unchanged; genuine same-period exclusions all hold');

// =============================================================================
// TEST 5 — clock-text timeKeys still work (auto mode / legacy shape)
// =============================================================================
seedLiveLocks();
{
    const viaText = poolFor(toPoolMin_NEW, '7th+8th', '3:00pm', SLOTS_900, BLOCK_END_900);
    assert.deepStrictEqual(viaText.window, [900, 950],
        'NEW: a clock-text timeKey ("3:00pm") still resolves to the same window');
}
console.log('TEST 5 PASS — clock-text timeKeys still parse (no regression for non-numeric keys)');

// =============================================================================
// TEST 6 — SOURCE GUARD: bind this sim to the real code.
// buildAvailableFieldSportPool is an inner function and cannot be imported, so
// the tests above exercise a faithful REPLICA of _toPoolMin. That would still
// pass if someone reverted the real fix — so assert the real source actually
// coerces numerics BEFORE falling back to parseTimeToMinutes.
// =============================================================================
{
    const leaguesSrc = fs.readFileSync(
        path.join(__dirname, '..', 'scheduler_core_leagues.js'), 'utf8');
    const m = leaguesSrc.match(/const _toPoolMin\s*=\s*\(v\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
    assert.ok(m, 'found _toPoolMin in scheduler_core_leagues.js');
    const body = m[1];
    const numericIdx = body.search(/isNaN\(Number\(_s\)\)|Number\(String\(v\)/);
    const parseIdx = body.indexOf('_parsePoolMin');
    assert.ok(numericIdx !== -1,
        'REGRESSION: _toPoolMin no longer coerces numeric strings — the "900" timeKey ' +
        'trap is back, leagues will see phantom field shortages on staggered clocks');
    assert.ok(numericIdx < parseIdx,
        'REGRESSION: numeric coercion must come BEFORE the parseTimeToMinutes fallback');
}
console.log('TEST 6 PASS — real scheduler_core_leagues.js source still coerces numerics first');

console.log('\nALL 7 POOL NUMERIC-TIMEKEY TESTS PASS');
