/**
 * Sim for: smart_logic_adapter.js getAvailableSpecialsForTimeBlock
 *          case-duplicate special collapse.
 *
 * Run with:  node tests/smarttile_special_case_dedupe_sim.js
 *
 * Why this exists: a camp stores every special TWICE, cap + lowercase
 * ("Lake" + "lake", "VR" + "vr", ...). Both survived the SmartTile special
 * pool because getGlobalSpecialActivities + activityProperties merged
 * case-sensitively. The pre-allocator then budgeted DOUBLE the real room
 * count, and the two entries blocked each other on the shared facility claim
 * key — a room reserved under the lowercase twin read "full" to the proper-
 * case one, so the rotation's "Special" step found every candidate taken and
 * fell through to the Swim fallback while the room sat empty.
 *
 * The pool must collapse case-variants of the SAME special name to ONE
 * canonical (proper-case) entry, while keeping genuinely different specials
 * that merely SHARE a room ("Arts & Crafts" + "Leather" → one shack).
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAdapter(specials) {
    const win = {};
    const sandbox = {
        window: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, RegExp
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    win.isRainyDayModeActive = () => false;
    win.getGlobalSpecialActivities = () => specials;
    win.getAllSpecialActivities = () => specials;
    win.loadCurrentDailyData = () => ({});
    win.currentDisabledFields = [];
    // No shut-off fields; facilities present so the orphan-facility gate keeps all.
    win.loadGlobalSettings = () => ({ app1: { fields: [] } });
    win.getFacilities = () => [];          // empty registry → orphan gate fails open
    win.getLocationForActivity = (n) => n; // self-hosted
    win.SchedulerCoreUtils = { findSlotsForRange: () => [0] };

    const src = fs.readFileSync(path.join(__dirname, '..', 'smart_logic_adapter.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'smart_logic_adapter.js' });
    return win;
}

// Mirror the camp: every special duplicated cap + lowercase. The lowercase
// twin carries no sharableWith (blank config), exactly like production.
const specials = [
    { name: 'Lake', sharableWith: { type: 'same_division', capacity: 2 } },
    { name: 'lake' },
    { name: 'VR' },
    { name: 'vr' },
    { name: 'Gaming Center' },
    { name: 'gaming center' },
    { name: 'Pizza Making' },
    { name: 'pizza making' },
    // Two DIFFERENT specials sharing one room — must NOT be collapsed together.
    { name: 'Arts & Crafts', location: 'Arts & Crafts Shack' },
    { name: 'Leather', location: 'Arts & Crafts Shack' },
];

let pass = 0, fail = 0;
function check(desc, fn) {
    try { fn(); console.log(`  ✓ ${desc}`); pass++; }
    catch (e) { console.log(`  ✗ ${desc}\n      ${e.message}`); fail++; }
}

const win = loadAdapter(specials);
const pool = win.SmartLogicAdapter.getAvailableSpecialsForTimeBlock(
    970, 1020, '9', /* activityProps */ {}, /* dailyFieldAvailability */ {});
const names = pool.map(s => s.name);
const lcNames = names.map(n => n.toLowerCase());

console.log('[smarttile_special_case_dedupe_sim]');
console.log('  pool:', names.join(', '));

check('collapses to 6 distinct specials (4 case-dups → 1 each + 2 shared-room)', () => {
    assert.equal(pool.length, 6, `got ${pool.length}: ${names.join(', ')}`);
});

check('no lowercase TWIN survives (canonical proper-case kept)', () => {
    for (const n of ['lake', 'vr', 'gaming center', 'pizza making']) {
        const matches = names.filter(x => x.toLowerCase() === n);
        assert.equal(matches.length, 1, `"${n}" appears ${matches.length}× (expected 1)`);
        assert.notEqual(matches[0], n, `kept the lowercase twin "${n}" instead of canonical case`);
    }
});

check('canonical entry retains the real capacity (Lake = 2, not blank-dup 1)', () => {
    const lake = pool.find(s => s.name === 'Lake');
    assert.ok(lake, 'Lake missing');
    assert.equal(lake.capacity, 2, `Lake capacity ${lake.capacity} (expected 2 from sharableWith)`);
});

check('total budgeted capacity is 7, not the double-counted 12', () => {
    // 4 dup-rooms (Lake=2, VR=1, Gaming=1, Pizza=1) + Arts&Crafts=1 + Leather=1 = 7.
    // Before the fix the lowercase twins added +5 (lake/vr/gaming/pizza×1 each) → 12.
    const total = pool.reduce((s, a) => s + a.capacity, 0);
    assert.equal(total, 7, `total ${total}`);
});

check('genuinely-different specials sharing ONE room are both kept', () => {
    assert.ok(lcNames.includes('arts & crafts'), 'Arts & Crafts dropped');
    assert.ok(lcNames.includes('leather'), 'Leather dropped');
});

console.log(`\n  ${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
