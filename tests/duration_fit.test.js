/**
 * Tests for the duration-fit gate in Utils.canBlockFit.
 *
 * An activity configured to run at set lengths cannot be squeezed into a block
 * shorter than its shortest one. The manual path never checked this — it only
 * shrank the WRITTEN end time afterwards, so a 40-minute special could sit in a
 * 30-minute tile mislabelled as 30. It matters most once a block is carved up:
 * a 20-minute piece must not be filled by something that needs 40.
 *
 * Run with: node --test tests/duration_fit.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function bootUtils() {
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
    s.loadCurrentDailyData = () => ({});

    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8'), s,
        { filename: 'scheduler_core_utils.js' });

    s.divisions = { Junior: { bunks: ['J1'] } };
    s.divisionTimes = { Junior: [{ slotIndex: 0, startMin: 600, endMin: 640, event: 'Special Activity', type: 'slot' }] };
    s.scheduleAssignments = { J1: [null] };
    s.specials = {};
    s.getSpecialActivityByName = (n) => s.specials[n] || null;
    s.sportMetaData = {};
    return s;
}

// A block of [startMin, endMin) for J1 on Field A.
const block = (startMin, endMin) => ({
    bunk: 'J1', divName: 'Junior', event: 'Special Activity', type: 'slot',
    startTime: startMin, endTime: endMin, slots: [0]
});

describe('canBlockFit — duration fit', () => {
    let win, U;
    beforeEach(() => { win = bootUtils(); U = win.SchedulerCoreUtils; });

    const fits = (b, actName) => U.canBlockFit(b, 'Field A', {}, {}, actName);

    it('rejects a special that needs longer than the block', () => {
        win.specials = { Ceramics: { name: 'Ceramics', durations: [40] } };
        assert.strictEqual(fits(block(600, 620), 'Ceramics'), false, '40-min special cannot fill a 20-min piece');
    });

    it('accepts the same special in a block long enough for it', () => {
        win.specials = { Ceramics: { name: 'Ceramics', durations: [40] } };
        assert.strictEqual(fits(block(600, 640), 'Ceramics'), true);
        assert.strictEqual(fits(block(600, 660), 'Ceramics'), true, 'a longer block is fine too');
    });

    it('uses the SHORTEST configured length, so a multi-length activity still fits', () => {
        win.specials = { Woodshop: { name: 'Woodshop', durations: [20, 40] } };
        assert.strictEqual(fits(block(600, 620), 'Woodshop'), true, 'can run at 20');
        assert.strictEqual(fits(block(600, 610), 'Woodshop'), false, 'but not at 10');
    });

    it('leaves an activity with no configured duration flexible', () => {
        win.specials = { Freeplay: { name: 'Freeplay' } };
        assert.strictEqual(fits(block(600, 605), 'Freeplay'), true);
    });

    it('applies to sports too', () => {
        win.sportMetaData = { Soccer: { durations: [40] } };
        assert.strictEqual(fits(block(600, 620), 'Soccer'), false);
        assert.strictEqual(fits(block(600, 640), 'Soccer'), true);
    });

    it('ignores junk duration values instead of rejecting everything', () => {
        win.specials = { Odd: { name: 'Odd', durations: [0, -5, 'x'] } };
        assert.strictEqual(fits(block(600, 605), 'Odd'), true);
    });

    it('does nothing when no activity name is supplied', () => {
        win.specials = { Ceramics: { name: 'Ceramics', durations: [40] } };
        assert.strictEqual(fits(block(600, 620), null), true);
    });

    it('honours the kill switch', () => {
        win.specials = { Ceramics: { name: 'Ceramics', durations: [40] } };
        win.__durationFitCheck = false;
        assert.strictEqual(fits(block(600, 620), 'Ceramics'), true);
    });

    it('survives a special lookup that throws', () => {
        win.getSpecialActivityByName = () => { throw new Error('boom'); };
        assert.strictEqual(fits(block(600, 620), 'Ceramics'), true, 'fails open rather than blocking everything');
    });
});
