/**
 * Tests for the schedule-template importer (schedule_layout_import.js).
 *
 * A camp uploads the spreadsheet they already print and tape to the wall, and
 * the importer works out the shape of it. Inference is a starting point — the
 * result lands in the designer's preview for confirmation — but it has to be
 * right on the shapes camps actually use, and it must never claim a confident
 * reading of a sheet it didn't understand.
 *
 * The browser-only path (file picking and .xlsx unzipping via
 * DecompressionStream) is exercised separately against a real .xlsx fixture in
 * a headless browser; this covers the parsing and inference that runs on the
 * grid once it's been read.
 *
 * Run with: node --test tests/schedule_layout_import.test.js
 */

const { describe, it, before } = require('node:test');
// non-strict: the importer runs inside a vm context, so the arrays and objects
// it returns carry that context's prototypes and deepStrictEqual would reject
// structurally identical values. Same reason as tests/travel_time.test.js.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// The importer is a browser IIFE that hangs itself off window, so give it just
// enough of a window to load. It reaches for DOM APIs only inside the file
// picker, which these tests never call.
function loadImporter(divisions) {
  const sandbox = {
    console,
    Promise, TextDecoder, Blob: class {}, Response: class {},
    DOMParser: undefined,
    window: { divisions: divisions || {} },
    module: undefined
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // The model first — the importer reads times and builds layouts through it.
  const model = fs.readFileSync(path.join(ROOT, 'schedule_layout_model.js'), 'utf8');
  vm.runInContext(model, ctx);
  const imp = fs.readFileSync(path.join(ROOT, 'schedule_layout_import.js'), 'utf8');
  vm.runInContext(imp, ctx);
  return sandbox.window;
}

const CAMP = {
  Aleph: { bunks: ['A1', 'A2', 'A3'] },
  Bais: { bunks: ['B1', 'B2'] }
};

let W, IMP, SL;
before(() => { W = loadImporter(CAMP); IMP = W.ScheduleLayoutImport; SL = W.ScheduleLayout; });

const build = (rows, name) => IMP._buildFromGrid(rows, name || 'template.csv');

describe('delimited parsing', () => {
  it('reads quoted fields, embedded commas and doubled quotes', () => {
    const grid = IMP._readDelimited('a,"b,c","say ""hi"""\n1,2,3');
    assert.deepEqual(grid, [['a', 'b,c', 'say "hi"'], ['1', '2', '3']]);
  });

  it('picks tabs over commas when the file is tab-separated', () => {
    const grid = IMP._readDelimited('Time\tAleph\tBais\n9:00am\tSwim\tSports');
    assert.deepEqual(grid[0], ['Time', 'Aleph', 'Bais']);
  });

  it('survives CRLF line endings and a BOM', () => {
    const grid = IMP._readDelimited('﻿a,b\r\nc,d\r\n');
    assert.deepEqual(grid[0], ['a', 'b']);
    assert.deepEqual(grid[1], ['c', 'd']);
  });
});

describe('reading a time cell', () => {
  it('reads an explicit range', () => {
    assert.deepEqual(IMP._readTimeCell('9:00am-10:00am'), { start: 540, end: 600 });
    assert.deepEqual(IMP._readTimeCell('11:00 – 12:00'), { start: 660, end: 720 });
    assert.deepEqual(IMP._readTimeCell('1:00 to 2:00'), { start: 780, end: 840 });
  });

  it('reads a bare clock time', () => {
    assert.deepEqual(IMP._readTimeCell('9:15'), { start: 555 });
    assert.deepEqual(IMP._readTimeCell('2:30pm'), { start: 870 });
  });

  it('reads a bare afternoon time as the afternoon', () => {
    // A camp writing "1:00" on a schedule means 1pm. Reading it as 1am would
    // put half the day before breakfast.
    assert.deepEqual(IMP._readTimeCell('1:00'), { start: 780 });
    assert.deepEqual(IMP._readTimeCell('3:30'), { start: 930 });
    assert.deepEqual(IMP._readTimeCell('9:00'), { start: 540 }, '9:00 is still the morning');
  });

  it('is not fooled by text that merely contains digits', () => {
    ['Swim', 'Bunk 3', 'Field 2', '', 'Period 1'].forEach(v => {
      assert.equal(IMP._readTimeCell(v), null, JSON.stringify(v));
    });
  });
});

describe('inferring the layout', () => {
  it('reads time running across the top as a time-across layout', () => {
    const layout = build([
      ['', '9:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-1:00'],
      ['Aleph', 'Davening', 'Sports', 'Swim', 'Lunch'],
      ['Bais', 'Learning', 'Swim', 'Sports', 'Lunch']
    ]).layout;
    assert.equal(layout.orientation, 'horizontal');
  });

  it('reads time running down the side as the classic layout', () => {
    const layout = build([
      ['Time', 'Aleph', 'Bais'],
      ['9:00am', 'Davening', 'Learning'],
      ['10:00am', 'Sports', 'Swim'],
      ['11:00am', 'Swim', 'Sports'],
      ['12:00pm', 'Lunch', 'Lunch']
    ]).layout;
    assert.equal(layout.orientation, 'vertical');
  });

  it('keeps BOTH time rows when a camp writes hours over quarter-hours', () => {
    // This is the shape that motivated the feature: a coarse period row with a
    // finer row beneath it. Losing either one loses how the camp reads its day.
    const res = build([
      ['', 'Period 1', 'Period 2', 'Period 3'],
      ['', '9:00-10:00', '10:00-11:00', '11:00-12:00'],
      ['Bunk', '9:00', '9:15', '9:30', '9:45', '10:00', '10:15', '10:30', '10:45'],
      ['A1', 'Davening', '', '', '', 'Sports', '', '', '']
    ]);
    const kinds = res.layout.rulers.map(r => r.kind);
    assert.equal(res.layout.rulers.length, 2, 'both time rows survive');
    assert.deepEqual(kinds, ['periods', 'uniform'], 'coarsest tier first');
    assert.equal(res.layout.rulers[1].increment, 15);
  });

  it('names the periods from the row beside the times', () => {
    const layout = build([
      ['', 'Learning', 'Breakfast', 'Activity 1'],
      ['', '8:00-9:30', '9:30-10:00', '10:00-11:15'],
      ['Aleph', '', '', '']
    ]).layout;
    const periods = layout.rulers.find(r => r.kind === 'periods');
    assert.deepEqual(periods.slots.map(s => s.label), ['Learning', 'Breakfast', 'Activity 1']);
    assert.deepEqual(periods.slots.map(s => s.end - s.start), [90, 30, 75]);
  });

  it('calls an evenly-spaced unnamed row an increment, not a bell schedule', () => {
    const layout = build([
      ['Time', 'Aleph', 'Bais'],
      ['9:00am', '', ''], ['9:30am', '', ''], ['10:00am', '', ''], ['10:30am', '', ''], ['11:00am', '', '']
    ]).layout;
    assert.equal(layout.rulers.length, 1);
    assert.equal(layout.rulers[0].kind, 'uniform');
    assert.equal(layout.rulers[0].increment, 30);
  });

  it('switches to bunk lanes when the labels are the camp\'s bunks', () => {
    const res = build([
      ['', '9:00-10:00', '10:00-11:00', '11:00-12:00'],
      ['A1', 'Davening', 'Sports', 'Swim'],
      ['A2', 'Davening', 'Art', 'Swim'],
      ['B1', 'Learning', 'Swim', 'Sports']
    ]);
    assert.equal(res.layout.entityAxis, 'bunk');
    assert.ok(res.notes.some(n => /bunks/.test(n)), res.notes.join(' | '));
  });

  it('uses grade lanes when the labels are the camp\'s grades', () => {
    const res = build([
      ['', '9:00-10:00', '10:00-11:00', '11:00-12:00'],
      ['Aleph', 'Davening', 'Sports', 'Swim'],
      ['Bais', 'Learning', 'Swim', 'Sports']
    ]);
    assert.equal(res.layout.entityAxis, 'division');
  });

  it('says so plainly when the labels match nothing in the camp', () => {
    const res = build([
      ['', '9:00-10:00', '10:00-11:00', '11:00-12:00'],
      ['Group Alpha', '', '', ''],
      ['Group Beta', '', '', '']
    ]);
    assert.equal(res.layout.entityAxis, 'division', 'falls back rather than guessing');
    assert.ok(res.notes.some(n => /switch it above/i.test(n)), res.notes.join(' | '));
  });

  it('names the layout after the file', () => {
    assert.equal(build([
      ['', '9:00-10:00', '10:00-11:00', '11:00-12:00'],
      ['Aleph', '', '', '']
    ], 'Summer Template.xlsx').layout.name, 'Summer Template');
  });

  it('reports what it decided so the camp can check it', () => {
    const res = build([
      ['', '9:00-10:00', '10:00-11:00', '11:00-12:00'],
      ['Aleph', '', '', '']
    ]);
    assert.ok(Array.isArray(res.notes) && res.notes.length > 0);
    assert.ok(res.notes.some(n => /across/i.test(n)));
  });
});

describe('refuses to invent a layout', () => {
  it('errors on a file with no times rather than guessing one', () => {
    const res = build([['Name', 'Activity'], ['A1', 'Swim'], ['A2', 'Sports']]);
    assert.ok(res.error, 'expected an error');
    assert.match(res.error, /no times/i);
    assert.equal(res.layout, undefined);
  });

  it('errors on an empty file', () => {
    assert.match(build([]).error, /empty/i);
    assert.match(build([['', ''], ['', '']]).error, /empty/i);
  });

  it('needs more than a couple of stray times to call a line a time axis', () => {
    // Two times in a sheet of prose is a coincidence, not a schedule.
    const res = build([
      ['Notes', 'Reminder'],
      ['Buses leave 9:00am', 'x'],
      ['Pickup 4:00pm', 'y']
    ]);
    assert.ok(res.error, 'expected an error, got ' + JSON.stringify(res.layout && res.layout.rulers));
  });
});

describe('the imported layout is usable immediately', () => {
  it('normalizes into a layout the grids can draw', () => {
    const layout = build([
      ['', 'Period 1', 'Period 2', 'Lunch'],
      ['', '9:00-10:00', '10:00-11:00', '12:00-1:00'],
      ['A1', 'Davening', 'Sports', 'Lunch']
    ]).layout;

    const lanes = SL.lanesFor(layout, CAMP, ['Aleph', 'Bais']);
    const geo = SL.geometry(layout, { startMin: 540, endMin: 960 }, { laneCount: lanes.length });
    assert.ok(geo.timeSpanPx > 0);
    assert.ok(geo.rulerTiers()[0].ticks.length > 0);
    // A tile dropped into "Period 2" should fill it exactly.
    assert.equal(geo.defaultDurationAt(630), 60);
    assert.equal(geo.snap(607), 600, 'snaps onto the imported bells');
  });
});
