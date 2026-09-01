/**
 * Regression test for GENERAL ACTIVITY TILE COLORS.
 *
 * Every general activity used to render in the same amber, so a palette with a
 * dozen of them was a wall of identical dots. window.getGeneralActivityColor
 * (facilities.js) is the single resolver every surface now reads — the Master
 * Scheduler and Daily Adjustments palettes, the manual grid tiles, and the
 * auto-mode layer bands — so one activity is one colour everywhere.
 *
 * Locks the contract those callers depend on:
 *   - no two activities share a colour, at any list length
 *   - the four kinds with a built-in tile keep that tile's familiar colour and
 *     do not consume a palette slot
 *   - a name that isn't a configured general activity returns null, so callers
 *     fall back to what they rendered before
 *
 * Run with: node --test tests/general_activity_colors.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FACILITIES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'facilities.js'), 'utf8'
);

function loadFacilities(facilitiesRegistry) {
  const win = {
    loadGlobalSettings: () => ({ facilities: facilitiesRegistry }),
    saveGlobalSettings: () => {},
    addEventListener: () => {}
  };
  const noopEl = { style: {}, classList: { add() {}, remove() {} }, appendChild() {} };
  const ctx = {
    window: win,
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => noopEl
    },
    console: { log() {}, warn() {}, error() {} },
    alert: () => {},
    setTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(FACILITIES_SRC, ctx, { filename: 'facilities.js' });
  return win;
}

const gaFac = (name, gas) => ({ name, generalActivities: gas });
const ga = (name, quickType) => ({ name, quickType: quickType || 'custom' });
const swatch = c => [c.bg, c.bg2, c.text, c.dot].join('|');

describe('general activity tile colors', () => {

  it('a name that is not a configured general activity returns null', () => {
    const win = loadFacilities([gaFac('Auditorium', [ga('Main activity')])]);
    assert.equal(win.getGeneralActivityColor('Basketball'), null);
    assert.equal(win.getGeneralActivityColor(''), null);
    assert.equal(win.getGeneralActivityColor(null), null);
    assert.equal(win.getGeneralActivityColor(undefined), null);
  });

  it('a configured activity resolves to a full colour set', () => {
    const win = loadFacilities([gaFac('Auditorium', [ga('Main activity')])]);
    const c = win.getGeneralActivityColor('Main activity');
    assert.ok(c, 'expected a colour');
    ['bg', 'bg2', 'text', 'dot'].forEach(k =>
      assert.equal(typeof c[k], 'string', `missing ${k}`));
  });

  it('the lookup is case- and whitespace-insensitive', () => {
    const win = loadFacilities([gaFac('Auditorium', [ga('Main Activity')])]);
    const a = win.getGeneralActivityColor('Main Activity');
    assert.deepEqual(win.getGeneralActivityColor('  main activity '), a);
  });

  it('FIX: every activity gets a DIFFERENT colour', () => {
    const names = ['Cocoa Club', 'Main activity', 'Learning', 'Shiur', 'Canteen',
                   'Night Activity', 'Trip', 'Bunk Time', 'Davening', 'Rest Hour'];
    const win = loadFacilities([gaFac('Campus', names.map(n => ga(n)))]);
    const seen = new Set(names.map(n => swatch(win.getGeneralActivityColor(n))));
    assert.equal(seen.size, names.length, 'two activities share a colour');
  });

  it('stays all-different well past the curated palette (golden-angle tail)', () => {
    // 40 activities > the 14 curated slots, so the hue-stepping tail is exercised.
    const names = Array.from({ length: 40 }, (_, i) => 'Activity ' + String(i).padStart(2, '0'));
    const win = loadFacilities([gaFac('Campus', names.map(n => ga(n)))]);
    const seen = new Set(names.map(n => swatch(win.getGeneralActivityColor(n))));
    assert.equal(seen.size, names.length, 'colours repeat past the palette');
  });

  it('the four built-in kinds keep their familiar tile colour', () => {
    const win = loadFacilities([gaFac('Campus', [
      ga('Swim', 'swim'), ga('Lunch', 'lunch'),
      ga('Snacks', 'snacks'), ga('Dismissal')
    ])]);
    assert.equal(win.getGeneralActivityColor('Swim').dot, '#06b6d4');      // cyan
    assert.equal(win.getGeneralActivityColor('Lunch').dot, '#ef4444');     // red
    assert.equal(win.getGeneralActivityColor('Snacks').dot, '#eab308');    // yellow
    assert.equal(win.getGeneralActivityColor('Dismissal').dot, '#ec4899'); // pink
  });

  it('a built-in kind does not consume a palette slot', () => {
    // "Cocoa Club" must get the same colour whether or not Lunch/Swim exist —
    // otherwise adding a Lunch general activity would recolour everything.
    const alone = loadFacilities([gaFac('Campus', [ga('Cocoa Club')])]);
    const withFixed = loadFacilities([gaFac('Campus', [
      ga('Cocoa Club'), ga('Lunch', 'lunch'), ga('Swim', 'swim')
    ])]);
    assert.deepEqual(
      win2plain(withFixed.getGeneralActivityColor('Cocoa Club')),
      win2plain(alone.getGeneralActivityColor('Cocoa Club'))
    );
  });

  it('the same activity at two facilities is one colour', () => {
    const win = loadFacilities([
      gaFac('Auditorium', [ga('Learning')]),
      gaFac('Beis Medrash', [ga('Learning')]),
      gaFac('Campus', [ga('Canteen')])
    ]);
    // One name, one colour — and still distinct from the other activity.
    assert.notEqual(
      swatch(win.getGeneralActivityColor('Learning')),
      swatch(win.getGeneralActivityColor('Canteen'))
    );
  });

  it('repeated calls are stable (the cache does not drift)', () => {
    const win = loadFacilities([gaFac('Campus', [ga('Canteen'), ga('Learning')])]);
    const first = swatch(win.getGeneralActivityColor('Canteen'));
    for (let i = 0; i < 5; i++) win.getGeneralActivityColor('Learning');
    assert.equal(swatch(win.getGeneralActivityColor('Canteen')), first);
  });

  it('no facilities at all — resolver is a safe no-op', () => {
    const win = loadFacilities([]);
    assert.equal(win.getGeneralActivityColor('Anything'), null);
  });

});

// Colours come back from the vm realm, so compare plain field-by-field.
function win2plain(c) {
  return c ? { bg: c.bg, bg2: c.bg2, text: c.text, dot: c.dot } : null;
}
