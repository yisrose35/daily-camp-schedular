/**
 * Regression test for the FIXED-TILE / GENERAL-ACTIVITY duplicate.
 *
 * BUG: Every general activity a camp configures (Facilities editor → General
 *      Activities) gets its own pinned tile in the Master Scheduler and Daily
 *      Adjustments palettes. But the hard-coded "Fixed" tiles (Swim, Lunch,
 *      Snacks, Dismissal) were rendered unconditionally, so a camp that created
 *      a Lunch general activity saw TWO Lunch tiles — the configured one (bound
 *      to its facility, carrying its sharing/capacity rules) and the built-in
 *      one (bound to nothing).
 *
 * RULE: a built-in Fixed tile shows only when NO general activity covers that
 *       kind. Configure one and the built-in steps aside; configure none and the
 *       built-in stays, so a camp that never set Lunch up can still pin one.
 *
 * This loads the REAL facilities.js in a vm sandbox and drives the two exported
 * helpers, then applies the same filter the palettes use.
 *
 * Run with: node --test tests/fixed_tile_ga_dedupe.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FACILITIES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'facilities.js'), 'utf8'
);

// Load facilities.js against a minimal window/document so the two palette
// helpers are callable. They read the persisted registry via loadGlobalSettings
// when the module-local `facilities` array is empty (fresh page load).
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

// The filter both manual palettes apply (master_schedule_builder.js /
// daily_adjustments.js renderPalette).
function fixedRow(win) {
  const covered = win.getGeneralActivityCoveredFixedTypes();
  return ['swim', 'lunch', 'snacks', 'dismissal', 'custom']
    .filter(t => t === 'custom' || !covered[t]);
}

// The filter both auto (DAW) palettes apply to their anchor tiles.
function dawAnchors(win) {
  const covered = win.getGeneralActivityCoveredFixedTypes();
  return ['dismissal', 'custom'].filter(t => !covered[t]);
}

const fac = (name, gas) => ({ name, generalActivities: gas });

// The covered map is built inside the vm realm, so its prototype is a foreign
// Object — compare its keys, not the object itself.
const coveredKeys = win => Object.keys(win.getGeneralActivityCoveredFixedTypes()).sort();

describe('fixed tile / general activity de-duplication', () => {

  it('no general activities → every built-in Fixed tile still shows', () => {
    const win = loadFacilities([fac('Auditorium', [])]);
    assert.deepEqual(fixedRow(win),
      ['swim', 'lunch', 'snacks', 'dismissal', 'custom']);
    assert.deepEqual(dawAnchors(win), ['dismissal', 'custom']);
  });

  it('an empty facilities registry leaves every built-in in place', () => {
    const win = loadFacilities([]);
    assert.deepEqual(coveredKeys(win), []);
    assert.deepEqual(fixedRow(win),
      ['swim', 'lunch', 'snacks', 'dismissal', 'custom']);
  });

  it('FIX: a Lunch general activity removes the built-in Lunch tile', () => {
    const win = loadFacilities([
      fac('Dining Room', [{ name: 'Lunch', quickType: 'lunch' }])
    ]);
    const row = fixedRow(win);
    assert.ok(!row.includes('lunch'), 'built-in Lunch should be gone');
    assert.ok(row.includes('swim') && row.includes('snacks'),
      'unrelated built-ins are untouched');
    // …and the configured one is the single Lunch left standing.
    const pal = win.getGeneralActivityPaletteItems();
    assert.equal(pal.filter(g => /^lunch$/i.test(g.name)).length, 1);
    assert.equal(pal.find(g => /^lunch$/i.test(g.name)).facility, 'Dining Room');
  });

  it('matches on quickType, so a differently-named swim GA still covers Swim', () => {
    const win = loadFacilities([
      fac('Pool', [{ name: 'Free Swim', quickType: 'swim' }])
    ]);
    assert.ok(!fixedRow(win).includes('swim'));
  });

  it('matches on NAME too — a GA renamed to Lunch keeps its stale quickType', () => {
    // Renaming a general activity does not recompute quickType, and a GA named
    // "Dismissal" never gets one (dismissal isn't in the add-time name map).
    const win = loadFacilities([
      fac('Auditorium', [{ name: '  LUNCH ', quickType: 'custom' }])
    ]);
    assert.ok(!fixedRow(win).includes('lunch'));
  });

  it('"Snack" (singular) covers the Snacks tile', () => {
    const win = loadFacilities([
      fac('Kitchen', [{ name: 'Snack', quickType: 'snacks' }])
    ]);
    assert.ok(!fixedRow(win).includes('snacks'));
  });

  it('a Dismissal GA replaces the built-in in BOTH the Fixed row and DAW anchors', () => {
    const win = loadFacilities([
      fac('Front Gate', [{ name: 'Dismissal', quickType: 'custom' }])
    ]);
    assert.ok(!fixedRow(win).includes('dismissal'));
    assert.deepEqual(dawAnchors(win), ['custom'],
      'the auto palette must not show a second Dismissal anchor');
    // Dismissal is no longer excluded from the palette items, so it is offered.
    assert.ok(win.getGeneralActivityPaletteItems()
      .some(g => /^dismissal$/i.test(g.name)));
  });

  it('an unrelated general activity covers nothing', () => {
    const win = loadFacilities([
      fac('Auditorium', [{ name: 'Main activity', quickType: 'custom' }])
    ]);
    assert.deepEqual(coveredKeys(win), []);
    assert.deepEqual(fixedRow(win),
      ['swim', 'lunch', 'snacks', 'dismissal', 'custom']);
  });

  it('Custom Pinned is never suppressed', () => {
    const win = loadFacilities([
      fac('X', [
        { name: 'Swim', quickType: 'swim' },
        { name: 'Lunch', quickType: 'lunch' },
        { name: 'Snacks', quickType: 'snacks' },
        { name: 'Dismissal', quickType: 'custom' }
      ])
    ]);
    assert.deepEqual(fixedRow(win), ['custom']);
    assert.deepEqual(dawAnchors(win), ['custom']);
  });

});
