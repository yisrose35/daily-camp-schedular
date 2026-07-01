/**
 * Sim for: rotation_engine.js calculateLimitScore frequencyDays cooldown guard.
 *
 * Run with:  node tests/frequencydays_zero_count_sim.js
 *
 * Bug: the cloud-merge in getBunkHistory fabricated a daysSinceLast from a stray
 * rotation_counts lastDone date even when the count was ZERO. So
 * getDaysSinceActivity returned "1" (done yesterday) for a special the bunk had
 * never actually done (getActivityCount === 0). With frequencyDays=6 the cooldown
 * gate (1 < 6) returned Infinity and blocked it → the bunk fell to the Swim
 * fallback for a special it had never had.
 *
 * Guard: the frequencyDays cooldown must only fire when the bunk has an ACTUAL
 * prior occurrence (getActivityCount > 0).
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEngine() {
    const win = {};
    const sandbox = {
        window: win, self: win,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout,
        Date, Math, Object, Array, JSON, String, Number, Boolean,
        Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, RegExp
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    win.loadGlobalSettings = () => ({});
    const src = fs.readFileSync(path.join(__dirname, '..', 'rotation_engine.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'rotation_engine.js' });
    return win;
}

let pass = 0, fail = 0;
function check(desc, fn) {
    try { fn(); console.log(`  ✓ ${desc}`); pass++; }
    catch (e) { console.log(`  ✗ ${desc}\n      ${e.message}`); fail++; }
}

const win = loadEngine();
const RE = win.RotationEngine;
assert.ok(RE && typeof RE.calculateLimitScore === 'function', 'RotationEngine.calculateLimitScore missing');

// A special with a 6-day "min days between visits" cooldown.
const AP = { Lake: { available: true, frequencyDays: 6 } };

// Simulate the bug: history reports "done yesterday" (daysSince=1)…
RE.getDaysSinceActivity = () => 1;

console.log('[frequencydays_zero_count_sim]');

check('NOT blocked when the bunk has never actually done it (count 0)', () => {
    RE.getActivityCount = () => 0; // the schedule-derived truth: never done
    const score = RE.calculateLimitScore('לו', 'Lake', AP, '9');
    assert.notEqual(score, Infinity, `expected finite score, got Infinity (cooldown wrongly fired on a never-done special)`);
});

check('STILL blocked when the bunk genuinely did it within the cooldown', () => {
    RE.getActivityCount = () => 1; // really did it
    const score = RE.calculateLimitScore('לו', 'Lake', AP, '9');
    assert.equal(score, Infinity, `expected Infinity (real cooldown), got ${score}`);
});

check('not blocked once the gap clears the cooldown (daysSince >= frequencyDays)', () => {
    RE.getActivityCount = () => 1;
    RE.getDaysSinceActivity = () => 6; // 6 >= 6 → cooldown satisfied
    const score = RE.calculateLimitScore('לו', 'Lake', AP, '9');
    assert.notEqual(score, Infinity, `expected finite score once cooldown clears, got Infinity`);
});

console.log(`\n  ${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
