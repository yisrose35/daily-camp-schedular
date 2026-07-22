/**
 * Tests for CampUtils.sanitizeSkeletonTiles — the shared skeleton tile sanitizer.
 *
 * REGRESSION GUARD: the duplicate key used to be division|event|start, ignoring
 * _bunk. An AUTO-mode skeleton carries one entry PER BUNK, so a grade's shared
 * walls (Davening/Swim/Lunch/Main…) legitimately repeat once per bunk at the
 * same division+time — the old key dropped every bunk's wall but one at save
 * time (64 tiles/run live). The bunk is now part of the tile's identity.
 *
 * Run with: node --test tests/skeleton_sanitize.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function bootUtils() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout: () => 0, clearTimeout() {},
        Date, Math, Object, Array, JSON, String, Number, Boolean, RegExp, Error,
        parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const src = fs.readFileSync(path.join(__dirname, '..', 'campistry_utils.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'campistry_utils.js' });
    return sandbox.CampUtils;
}

const U = bootUtils();

test('per-bunk wall copies are NOT duplicates (auto-mode skeleton keeps every bunk)', () => {
    // three bunks of one grade, each carrying the same division-wide walls —
    // exactly what the auto generator emits (one skeleton entry per bunk).
    const skeleton = [];
    ['Leebi 2', 'Leebi 3', 'Leebi 4'].forEach(b => {
        skeleton.push({ division: 'Primary', _bunk: b, event: 'Davening', startTime: '9:20am', endTime: '9:40am' });
        skeleton.push({ division: 'Primary', _bunk: b, event: 'Swim', startTime: '9:40am', endTime: '11:00am' });
        skeleton.push({ division: 'Primary', _bunk: b, event: 'Lunch', startTime: '1:30pm', endTime: '1:50pm' });
        skeleton.push({ division: 'Primary', _bunk: b, event: 'Main Activity', startTime: '2:20pm', endTime: '3:00pm' });
    });
    const r = U.sanitizeSkeletonTiles(skeleton);
    assert.strictEqual(r.dropped.length, 0, 'no per-bunk wall may be dropped: ' + JSON.stringify(r.dropped));
    assert.strictEqual(r.tiles.length, 12, 'all 12 per-bunk wall entries survive');
    // every bunk still has all four walls
    ['Leebi 2', 'Leebi 3', 'Leebi 4'].forEach(b => {
        const mine = r.tiles.filter(t => t._bunk === b);
        assert.strictEqual(mine.length, 4, b + ' keeps its 4 walls');
    });
});

test('a TRUE duplicate (same bunk, same event, same start) still drops', () => {
    const skeleton = [
        { division: 'Primary', _bunk: 'Leebi 2', event: 'Swim', startTime: '9:40am', endTime: '11:00am' },
        { division: 'Primary', _bunk: 'Leebi 2', event: 'Swim', startTime: '9:40am', endTime: '11:00am' },
    ];
    const r = U.sanitizeSkeletonTiles(skeleton);
    assert.strictEqual(r.tiles.length, 1);
    assert.strictEqual(r.dropped.length, 1);
    assert.strictEqual(r.dropped[0].reason, 'duplicate');
});

test('manual-mode tiles (no _bunk) keep the division-level dedup unchanged', () => {
    const skeleton = [
        { division: 'Primary', event: 'Lunch', startTime: '1:30pm', endTime: '1:50pm' },
        { division: 'Primary', event: 'Lunch', startTime: '1:30pm', endTime: '1:50pm' },   // true division-level dup
        { division: '1st Grade', event: 'Lunch', startTime: '1:30pm', endTime: '1:50pm' }, // other division — kept
    ];
    const r = U.sanitizeSkeletonTiles(skeleton);
    assert.strictEqual(r.tiles.length, 2);
    assert.strictEqual(r.dropped.length, 1);
});

test('better-formed copy still wins within the same bunk', () => {
    const skeleton = [
        { division: 'Primary', _bunk: 'Leebi 2', event: 'Swim', startTime: '9:40', endTime: '11:00am' },   // bare time
        { division: 'Primary', _bunk: 'Leebi 2', event: 'Swim', startTime: '9:40am', endTime: '11:00am' }, // well-formed
    ];
    const r = U.sanitizeSkeletonTiles(skeleton);
    assert.strictEqual(r.tiles.length, 1);
    assert.strictEqual(r.tiles[0].startTime, '9:40am', 'the well-formed copy is kept');
});

test('unparseable and inverted times still drop (core guard intact)', () => {
    const skeleton = [
        { division: 'Primary', _bunk: 'Leebi 2', event: 'Oops', startTime: 'noonish', endTime: '1:00pm' },
        { division: 'Primary', _bunk: 'Leebi 2', event: 'Backwards', startTime: '5:10pm', endTime: '4:50pm' },
        { division: 'Primary', _bunk: 'Leebi 2', event: 'Fine', startTime: '4:00pm', endTime: '4:40pm' },
    ];
    const r = U.sanitizeSkeletonTiles(skeleton);
    assert.strictEqual(r.tiles.length, 1);
    assert.strictEqual(r.tiles[0].event, 'Fine');
    assert.strictEqual(r.dropped.length, 2);
});
