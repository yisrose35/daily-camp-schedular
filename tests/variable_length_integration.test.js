/**
 * Integration: the division slot grid and the per-bunk carving must agree.
 *
 * DivisionTimesSystem cuts a splittable tile into sub-slots; ManualBlockSplit
 * then decides, per bunk, how many of those sub-slots each activity spans. If
 * the two ever disagree — a carving landing mid-sub-slot — the generator would
 * write an activity into a slot it doesn't line up with.
 *
 * Run with: node --test tests/variable_length_integration.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Split = require('../manual_block_split.js');
const PeriodPacker = require('../period_packer.js');

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
    s.CampUtils = {
        minutesToTimeLabel: (m) => String(m),
        minutesToTime: (m) => String(m),
    };
    for (const f of ['scheduler_core_utils.js', 'division_times_system.js']) {
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), s, { filename: f });
    }
    return s;
}

// Specials: two 20-min, one 40-min, one that runs either.
const SPECIALS = [
    { name: 'Slush', durations: [20] },
    { name: 'Popcorn', durations: [20] },
    { name: 'Ceramics', durations: [40] },
    { name: 'Woodshop', durations: [20, 40] },
];

function buildGrid(win, tileOverrides) {
    win.getAllSpecialActivities = () => SPECIALS;
    win.sportMetaData = {};
    const skeleton = [Object.assign({
        id: 'vl1', division: 'Junior', event: 'Special Activity', type: 'slot',
        startTime: '10:00am', endTime: '10:40am', allowSplit: true,
    }, tileOverrides)];
    const divisions = { Junior: { bunks: ['J1', 'J2'], startTime: '9:00am', endTime: '4:00pm' } };
    return win.DivisionTimesSystem.buildFromSkeleton(skeleton, divisions).Junior || [];
}

// Which grid slots does [s,e) overlap?
const coveredSlots = (grid, s, e) =>
    grid.map((slot, i) => ({ slot, i })).filter(x => x.slot.startMin < e && x.slot.endMin > s).map(x => x.i);

describe('grid cut + per-bunk carving', () => {
    let win;
    beforeEach(() => { win = boot(); });

    it('cuts the 40-min splittable tile into two 20-min grid slots', () => {
        const grid = buildGrid(win, {});
        const vl = grid.filter(s => s._vlParts);
        assert.strictEqual(vl.length, 2);
        assert.deepEqual(vl.map(s => [s.startMin, s.endMin]), [[600, 620], [620, 640]]);
    });

    it('leaves the grid uncut when the tile is not marked splittable', () => {
        const grid = buildGrid(win, { allowSplit: false });
        assert.strictEqual(grid.filter(s => s._vlParts).length, 0);
        const own = grid.filter(s => s.startMin === 600 && s.endMin === 640);
        assert.strictEqual(own.length, 1, 'stays a single 600-640 slot');
    });

    it('a splitting bunk gets one activity per sub-slot', () => {
        const grid = buildGrid(win, {});
        const demand = Split.buildDemand(SPECIALS, []);          // nothing used yet
        const plan = Split.splitBlock({
            startMin: 600, endMin: 640,
            durations: Split.collectDurations(SPECIALS), demand, packer: PeriodPacker,
        });
        assert.strictEqual(plan.split, true);
        assert.deepEqual(plan.segments.map(s => s.durationMin), [20, 20]);
        for (const seg of plan.segments) {
            const covers = coveredSlots(grid, seg.startMin, seg.endMin);
            assert.strictEqual(covers.length, 1, `${seg.startMin}-${seg.endMin} lands on exactly one sub-slot`);
        }
    });

    it('a non-splitting bunk spans both sub-slots with one activity', () => {
        const grid = buildGrid(win, {});
        // Only Woodshop left — one activity cannot fill two pieces.
        const demand = Split.buildDemand(SPECIALS, ['Slush', 'Popcorn', 'Ceramics']);
        const plan = Split.splitBlock({
            startMin: 600, endMin: 640,
            durations: Split.collectDurations(SPECIALS), demand, packer: PeriodPacker,
        });
        assert.strictEqual(plan.split, false);
        const covers = coveredSlots(grid, 600, 640);
        assert.strictEqual(covers.length, 2, 'the single activity spans both sub-slots (continuation)');
    });

    it('every carving lands exactly on sub-slot boundaries — never mid-slot', () => {
        const grid = buildGrid(win, {});
        const boundaries = new Set();
        grid.forEach(s => { boundaries.add(s.startMin); boundaries.add(s.endMin); });

        const scenarios = [[], ['Slush'], ['Slush', 'Popcorn'], ['Slush', 'Popcorn', 'Ceramics'], ['Ceramics']];
        for (const used of scenarios) {
            const plan = Split.splitBlock({
                startMin: 600, endMin: 640,
                durations: Split.collectDurations(SPECIALS),
                demand: Split.buildDemand(SPECIALS, used), packer: PeriodPacker,
            });
            for (const seg of plan.segments) {
                assert.ok(boundaries.has(seg.startMin), `start ${seg.startMin} is a grid boundary (used=${used})`);
                assert.ok(boundaries.has(seg.endMin), `end ${seg.endMin} is a grid boundary (used=${used})`);
            }
        }
    });

    it('two bunks can resolve the same tile differently against one shared grid', () => {
        const grid = buildGrid(win, {});
        const durations = Split.collectDurations(SPECIALS);

        const j1 = Split.splitBlock({ startMin: 600, endMin: 640, durations, demand: Split.buildDemand(SPECIALS, []), packer: PeriodPacker });
        const j2 = Split.splitBlock({ startMin: 600, endMin: 640, durations, demand: Split.buildDemand(SPECIALS, ['Slush', 'Popcorn', 'Ceramics']), packer: PeriodPacker });

        assert.strictEqual(j1.segments.length, 2, 'J1 takes 2x20');
        assert.strictEqual(j2.segments.length, 1, 'J2 takes one 40');
        // Both still cover the whole tile, so neither bunk ends up with a hole.
        for (const plan of [j1, j2]) {
            assert.strictEqual(plan.segments[0].startMin, 600);
            assert.strictEqual(plan.segments[plan.segments.length - 1].endMin, 640);
        }
        assert.strictEqual(grid.filter(s => s._vlParts).length, 2, 'one grid serves both');
    });

    it('sub-slots carry the original tile window so the source stays traceable', () => {
        const grid = buildGrid(win, {});
        const vl = grid.filter(s => s._vlParts);
        assert.ok(vl.every(s => s._originalStartMin === 600 && s._originalEndMin === 640));
    });
});
