'use strict';
// Verifies the UI-only grade-column display order is DECOUPLED from the Me
// priority order:
//   • getUserDivisionOrder (display) follows app1.viewColumnOrder
//   • getDivisionAgeOrder (solver/field-quality priority) IGNORES it (stays Me order)
//   • with no viewColumnOrder, display === Me order (no regression)
// It sources the real functions from app1.js so the test tracks the shipped code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// --- Extract a `window.<name> = function (...) { ... };` block by brace matching ---
function extractFn(src, name) {
  const decl = `window.${name} = function`;
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `could not find ${decl} in app1.js`);
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  // include trailing semicolon if present
  while (i < src.length && src[i] !== ';') i++;
  return src.slice(start, i + 1);
}

function makeWindow(settings, divisions) {
  const win = {
    divisions: divisions || {},
    loadGlobalSettings: () => settings,
  };
  win.window = win;
  return win;
}

function loadOrderFns(settings, divisions) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app1.js'), 'utf8');
  const blocks = [
    extractFn(src, '_getMeDivisionOrder'),
    extractFn(src, '_applyViewColumnOrder'),
    extractFn(src, 'getUserDivisionOrder'),
    extractFn(src, 'getDivisionAgeOrder'),
  ].join('\n\n');
  const ctx = { window: makeWindow(settings, divisions) };
  ctx.window.window = ctx.window;
  // The blocks reference bare `window`; run them with window in scope.
  vm.runInNewContext('(function(window){' + blocks + '})(window)', ctx);
  return ctx.window;
}

// A simple camp: one parent "Camp" with grades 1,2,3 in that gradeOrder.
const SETTINGS_BASE = {
  campStructure: { Camp: { grades: { '1': {}, '2': {}, '3': {} }, gradeOrder: ['1', '2', '3'] } },
  app1: {},
};
const DIVS = {
  '1': { parentDivision: 'Camp' },
  '2': { parentDivision: 'Camp' },
  '3': { parentDivision: 'Camp' },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test('no viewColumnOrder → display order equals Me order (no regression)', () => {
  const w = loadOrderFns(clone(SETTINGS_BASE), DIVS);
  assert.deepStrictEqual(w.getUserDivisionOrder(['3', '1', '2']), ['1', '2', '3']);
  assert.deepStrictEqual(w._getMeDivisionOrder(['3', '1', '2']), ['1', '2', '3']);
});

test('viewColumnOrder reverses the DISPLAY order only', () => {
  const s = clone(SETTINGS_BASE);
  s.app1.viewColumnOrder = ['3', '2', '1'];
  const w = loadOrderFns(s, DIVS);
  // display follows the view order
  assert.deepStrictEqual(w.getUserDivisionOrder(['1', '2', '3']), ['3', '2', '1']);
  // Me/priority order is untouched
  assert.deepStrictEqual(w._getMeDivisionOrder(['1', '2', '3']), ['1', '2', '3']);
});

test('field-quality seniority (getDivisionAgeOrder) ignores viewColumnOrder', () => {
  // youngToOld default → oldest-first = reversed Me order = ['3','2','1'] regardless of view order
  const sBase = clone(SETTINGS_BASE);
  const wBase = loadOrderFns(sBase, DIVS);
  const priorityNoView = wBase.getDivisionAgeOrder(['1', '2', '3']);

  const sView = clone(SETTINGS_BASE);
  sView.app1.viewColumnOrder = ['1', '2', '3']; // a DIFFERENT look than the reversed priority
  const wView = loadOrderFns(sView, DIVS);
  const priorityWithView = wView.getDivisionAgeOrder(['1', '2', '3']);

  assert.deepStrictEqual(priorityNoView, ['3', '2', '1']); // oldest-first
  assert.deepStrictEqual(priorityWithView, priorityNoView, 'view order must NOT shift seniority');
});

test('a grade missing from viewColumnOrder still appears (appended in Me order)', () => {
  const s = clone(SETTINGS_BASE);
  s.app1.viewColumnOrder = ['3', '1']; // 2 not listed (e.g. newly added)
  const w = loadOrderFns(s, DIVS);
  const out = w.getUserDivisionOrder(['1', '2', '3']);
  assert.deepStrictEqual(out.slice(0, 2), ['3', '1']); // listed cols lead, in view order
  assert.ok(out.includes('2'), '2 must still appear');
  assert.strictEqual(out.length, 3);
});

// --- Multi-division camp: a STALE view order must NOT scatter grades across
//     division boundaries. Regression for the "DC 4 between 8 and 9" bug.
//   Day Camp 1-6, Camp Agudah 5-7, Agudah Max 8-10. Grades 5 & 6 collide across
//   Day Camp / Camp Agudah, so they become qualified keys ("Day Camp > 5", …).
//   A view order saved BEFORE the collision still holds bare "5"/"6" (now orphan)
//   and misplaces "4"; the display must keep every grade inside its own division.
const MULTI_SETTINGS = {
  campStructure: {
    'Day Camp':    { grades: { '1': {}, '2': {}, '3': {}, '4': {}, '5': {}, '6': {} }, gradeOrder: ['1', '2', '3', '4', '5', '6'] },
    'Camp Agudah': { grades: { '5': {}, '6': {}, '7': {} }, gradeOrder: ['5', '6', '7'] },
    'Agudah Max':  { grades: { '8': {}, '9': {}, '10': {} }, gradeOrder: ['8', '9', '10'] },
  },
  app1: { divisionOrder: ['Day Camp', 'Camp Agudah', 'Agudah Max'] },
};
// window.divisions keys, qualifying the collided grade names exactly like app1 does.
const MULTI_DIVS = {
  '1': { parentDivision: 'Day Camp' }, '2': { parentDivision: 'Day Camp' },
  '3': { parentDivision: 'Day Camp' }, '4': { parentDivision: 'Day Camp' },
  'Day Camp > 5': { parentDivision: 'Day Camp' }, 'Day Camp > 6': { parentDivision: 'Day Camp' },
  'Camp Agudah > 5': { parentDivision: 'Camp Agudah' }, 'Camp Agudah > 6': { parentDivision: 'Camp Agudah' },
  '7': { parentDivision: 'Camp Agudah' },
  '8': { parentDivision: 'Agudah Max' }, '9': { parentDivision: 'Agudah Max' }, '10': { parentDivision: 'Agudah Max' },
};
const MULTI_KEYS = Object.keys(MULTI_DIVS);

test('stale view order does not scatter a grade into another division (DC 4 stays in Day Camp)', () => {
  const s = clone(MULTI_SETTINGS);
  // Stale drag order from before the 5/6 collision — bare "5"/"6" are now orphans,
  // and "4" sits late (would land between "8" and "9" under the old flat sort).
  s.app1.viewColumnOrder = ['1', '2', '3', '5', '6', '7', '8', '4', '9', '10'];
  const w = loadOrderFns(s, MULTI_DIVS);
  const out = w.getUserDivisionOrder(MULTI_KEYS.slice());

  const i = (k) => out.indexOf(k);
  // Every Day Camp grade precedes every Agudah Max grade — no cross-division scatter.
  ['1', '2', '3', '4', 'Day Camp > 5', 'Day Camp > 6'].forEach((dc) => {
    ['8', '9', '10'].forEach((am) => {
      assert.ok(i(dc) < i(am), `${dc} (Day Camp) must come before ${am} (Agudah Max)`);
    });
  });
  // The reported symptom specifically: DC 4 is NOT between 8 and 9.
  assert.ok(i('4') < i('8'), 'DC 4 must not land after Agudah Max 8');
  // Division blocks stay contiguous and in Me order.
  assert.deepStrictEqual(out.slice(0, 6), ['1', '2', '3', '4', 'Day Camp > 5', 'Day Camp > 6']);
  assert.deepStrictEqual(out.slice(-3), ['8', '9', '10']);
});

test('with no view order, a multi-division camp shows the Me order exactly', () => {
  const s = clone(MULTI_SETTINGS);
  const w = loadOrderFns(s, MULTI_DIVS);
  assert.deepStrictEqual(
    w.getUserDivisionOrder(MULTI_KEYS.slice()),
    ['1', '2', '3', '4', 'Day Camp > 5', 'Day Camp > 6', 'Camp Agudah > 5', 'Camp Agudah > 6', '7', '8', '9', '10']
  );
});
