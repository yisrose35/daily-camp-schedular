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
