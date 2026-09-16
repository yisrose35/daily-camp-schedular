/**
 * Tests for expandVariableLengthTiles in division_times_system.js.
 *
 * Every bunk in a division shares one slot grid, so a tile that may resolve
 * differently per bunk is cut to the FINEST carving any bunk might use. A bunk
 * taking the longer activity spans the sub-slots; a bunk taking two shorter ones
 * fills them separately. Either way there is still exactly one entry per
 * (bunk, slot), which the rest of the pipeline depends on.
 *
 * Run with: node --test tests/variable_length_grid.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function boot() {
    const s = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        Date, Math, Object, Array, JSON, String, Number, Boolean, RegExp, Error,
        Map, Set, WeakMap, WeakSet, Promise, parseInt, parseFloat, isNaN, isFinite,
        Infinity, NaN, Symbol, encodeURIComponent, decodeURIComponent,
    };
    s.window = s; s.self = s; s.globalThis = s; s.global = s;
    const el = () => ({ appendChild() {}, addEventListener() {}, setAttribute() {}, style: {}, children: [], dataset: {} });
    s.document = {
        readyState: 'complete', createElement: el, createDocumentFragment: el,
        getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}, body: el(), head: el(),
    };
    s.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} };
    s.CustomEvent = class {}; s.dispatchEvent = () => true;
    s.addEventListener = () => {}; s.removeEventListener = () => {};
    s.requestAnimationFrame = () => 0; s.cancelAnimationFrame = () => {};
    s.location = { href: '', reload() {}, search: '' };
    s.navigator = { onLine: true, userAgent: 'node' };
    s.CampUtils = { minutesToTimeLabel: (m) => String(m), minutesToTime: (m) => String(m) };

    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'division_times_system.js'), 'utf8'), s,
        { filename: 'division_times_system.js' });
    return s;
}

const tile = (o) => Object.assign({
    id: 't1', event: 'Special Activity', type: 'slot', division: 'Junior',
    startMin: 600, endMin: 640,
}, o);

// Specials configured at 20 or 40 minutes.
function setSpecials(win, durationsList) {
    win.getAllSpecialActivities = () => durationsList.map((d, i) => ({ name: 'S' + i, durations: d }));
}
function setSports(win, durationsList) {
    win.sportMetaData = {};
    durationsList.forEach((d, i) => { win.sportMetaData['Sport' + i] = { durations: d }; });
}

describe('expandVariableLengthTiles', () => {
    let win, E;
    beforeEach(() => {
        win = boot();
        E = win.DivisionTimesSystem.expandVariableLengthTiles;
        setSpecials(win, [[20], [40]]);
        setSports(win, []);
    });

    it('is exposed on DivisionTimesSystem', () => {
        assert.strictEqual(typeof E, 'function');
    });

    it('leaves an unmarked tile completely alone', () => {
        const out = E([tile({})]);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].startMin, 600);
        assert.strictEqual(out[0].endMin, 640);
        assert.strictEqual(out[0]._vlParts, undefined);
    });

    it('cuts a 40-min splittable tile into 2x20 when activities run 20 or 40', () => {
        const out = E([tile({ allowSplit: true })]);
        assert.strictEqual(out.length, 2);
        assert.deepEqual(out.map(b => [b.startMin, b.endMin]), [[600, 620], [620, 640]]);
        assert.deepEqual(out.map(b => b._vlPart), [0, 1]);
        assert.ok(out.every(b => b._vlParts === 2 && b._vlUnit === 20));
    });

    it('the cut pieces exactly cover the original tile', () => {
        const out = E([tile({ allowSplit: true, startMin: 600, endMin: 660 })]);
        assert.strictEqual(out[0].startMin, 600);
        assert.strictEqual(out[out.length - 1].endMin, 660);
        for (let i = 1; i < out.length; i++) {
            assert.strictEqual(out[i].startMin, out[i - 1].endMin, 'no gap or overlap between pieces');
        }
    });

    it('remembers the original window on every piece', () => {
        const out = E([tile({ allowSplit: true })]);
        assert.ok(out.every(b => b._originalStartMin === 600 && b._originalEndMin === 640));
        assert.ok(out.every(b => b._vlParentEvent === 'Special Activity'));
    });

    it('does not cut when no configured duration is shorter than the tile', () => {
        setSpecials(win, [[40], [60]]);
        const out = E([tile({ allowSplit: true, startMin: 600, endMin: 640 })]);
        assert.strictEqual(out.length, 1, '40-min tile, nothing shorter than 40 → nothing to split into');
    });

    it('does not cut when the unit would not divide the tile evenly', () => {
        // 50-min tile, activities run 20 → GCD(50,20) = 10, 5 parts > maxGridParts 4.
        setSpecials(win, [[20]]);
        const out = E([tile({ allowSplit: true, startMin: 600, endMin: 650 })]);
        assert.strictEqual(out.length, 1);
    });

    it('refuses to shatter a tile past maxGridParts', () => {
        setSpecials(win, [[5], [10]]);
        const out = E([tile({ allowSplit: true, startMin: 600, endMin: 640 })]);
        assert.strictEqual(out.length, 1, '8 x 5min is not a useful grid');
    });

    it('honours an explicit maxGridParts', () => {
        setSpecials(win, [[20]]);
        const three = E([tile({ allowSplit: true, startMin: 600, endMin: 660 })], { maxGridParts: 3 });
        assert.strictEqual(three.length, 3);
        const capped = E([tile({ allowSplit: true, startMin: 600, endMin: 660 })], { maxGridParts: 2 });
        assert.strictEqual(capped.length, 1, '3 parts exceeds the cap → leave whole');
    });

    it('respects minPartMin', () => {
        setSpecials(win, [[10], [20]]);
        const out = E([tile({ allowSplit: true, startMin: 600, endMin: 640 })], { minPartMin: 20 });
        assert.strictEqual(out.length, 1, '10-min pieces are below the floor');
    });

    it('reads sport durations for a Sports Slot, not special durations', () => {
        setSpecials(win, [[5]]);           // would shatter the grid
        setSports(win, [[15], [30]]);      // GCD 15 → 2 parts of 15 in a 30-min tile
        const out = E([tile({ allowSplit: true, event: 'Sports Slot', startMin: 600, endMin: 630 })]);
        assert.strictEqual(out.length, 2);
        assert.ok(out.every(b => b._vlUnit === 15));
    });

    it('never touches split tiles', () => {
        const out = E([tile({ allowSplit: true, type: 'split' }), tile({ allowSplit: true, type: 'split_half' })]);
        assert.strictEqual(out.length, 2);
        assert.ok(out.every(b => b._vlParts === undefined));
    });

    it('passes through cleanly when activity config is unreadable', () => {
        win.getAllSpecialActivities = () => { throw new Error('boom'); };
        win.sportMetaData = null;
        const out = E([tile({ allowSplit: true })]);
        assert.strictEqual(out.length, 1);
    });

    it('handles a mixed batch without disturbing neighbours', () => {
        const out = E([
            tile({ id: 'a', startMin: 540, endMin: 600 }),
            tile({ id: 'b', allowSplit: true, startMin: 600, endMin: 640 }),
            tile({ id: 'c', startMin: 640, endMin: 700 }),
        ]);
        assert.strictEqual(out.length, 4);
        assert.deepEqual(out.map(b => [b.startMin, b.endMin]),
            [[540, 600], [600, 620], [620, 640], [640, 700]]);
    });

    it('is deterministic', () => {
        const args = [tile({ allowSplit: true, startMin: 600, endMin: 660 })];
        setSpecials(win, [[20], [30], [60]]);
        const first = JSON.stringify(E(args));
        for (let i = 0; i < 10; i++) assert.strictEqual(JSON.stringify(E(args)), first);
    });
});
