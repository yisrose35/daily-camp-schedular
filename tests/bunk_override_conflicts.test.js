/**
 * Bunk-override SETUP-CONFLICT pre-flight.
 *
 * A bunk override is a manual instruction, so it bypasses the solver's own fit
 * checks. Before this pre-flight a user could hand a bunk a facility that was
 * switched off for the day, or hand one not-sharable room to three bunks at
 * once, and only find out by reading the generated schedule.
 *
 * `_boCheckOverrideConflicts(targets, items)` returns a list of human-readable
 * problems (empty = clean). The UI turns a non-empty list into an accept/deny
 * confirm — it WARNS, it never blocks, because the head counselor is allowed to
 * knowingly override their own configuration.
 *
 * This drives the REAL functions out of daily_adjustments.js (sliced by name and
 * evaluated against injected globals) so the decision table can't drift from the
 * shipped code. Note the file is far too large to evaluate whole in a sandbox —
 * hence the slice.
 *
 * Run with: node --test tests/bunk_override_conflicts.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'daily_adjustments.js'), 'utf8');

// Slice `function NAME(...) { ... }` out of the source by matching braces.
// Brace counting is safe for these helpers: none of them contain a string or
// comment holding an unbalanced brace (asserted by the successful parse below).
function sliceFunction(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(');
  assert.notEqual(start, -1, 'could not find function ' + name + ' — did it get renamed?');
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces slicing ' + name);
}

const FNS = [
  '_boItemFacility',
  '_boFieldByName',
  '_boFieldCapacity',
  '_boDivisionOfBunk',
  '_boFacilityClosedDuring',
  '_boCheckOverrideConflicts'
].map(sliceFunction).join('\n');

// Build a sandbox holding the real helpers plus the few globals they read.
function makeChecker({ fields = [], specials = [], divisions = {}, overrides = {} }) {
  const currentOverrides = Object.assign({
    disabledFields: [],
    disabledSpecials: [],
    dailyDisabledSportsByField: {},
    dailyFieldAvailability: {},
    bunkActivityOverrides: []
  }, overrides);

  const ctx = {
    console,
    currentOverrides,
    masterSettings: { app1: { fields, specialActivities: specials, divisions } },
    window: {
      divisions,
      SchedulerCoreUtils: {
        parseTimeToMinutes(t) {
          if (t == null) return null;
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
          return m ? Number(m[1]) * 60 + Number(m[2]) : null;
        }
      }
    },
    // Plain passthroughs — the real ones only affect presentation.
    _escHtml: (s) => String(s == null ? '' : s),
    minutesToTime: (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
  };
  vm.createContext(ctx);
  vm.runInContext(FNS, ctx);
  return {
    check: (targets, items) => vm.runInContext('_boCheckOverrideConflicts', ctx)(targets, items),
    capacity: (f) => vm.runInContext('_boFieldCapacity', ctx)(f),
    closed: (fac, s, e, d) => vm.runInContext('_boFacilityClosedDuring', ctx)(fac, s, e, d)
  };
}

const GYM = { name: 'Gym', activities: ['Basketball'], sharableWith: { type: 'not_sharable', capacity: 1, divisions: [] } };
const FIELD_SAME_DIV = { name: 'Big Field', activities: ['Kickball'], sharableWith: { type: 'same_division', capacity: 2, divisions: [] } };
const FIELD_ALL = { name: 'Open Lawn', activities: ['Tag'], sharableWith: { type: 'all', capacity: 4, divisions: [] } };
const DIVS = {
  'Grade 5': { bunks: ['5A', '5B', '5C'] },
  'Grade 6': { bunks: ['6A', '6B'] }
};
const W = { startMin: 600, endMin: 660 }; // 10:00–11:00

// The checker builds its result array INSIDE the vm realm, so assert.deepEqual
// against a plain [] fails on prototype identity alone. Assert on contents, and
// print what was actually reported when the expectation misses.
function assertClean(out) {
  assert.equal(out.length, 0, 'expected no warnings, got: ' + Array.from(out).join(' | '));
}

describe('bunk-override setup-conflict pre-flight', () => {

  it('a clean pick produces no warnings', () => {
    const c = makeChecker({ fields: [GYM], divisions: DIVS });
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]);
    assertClean(out);
  });

  // ── facility switched off for the date (Resources tab) ────────────────────
  it('flags a facility disabled for this date', () => {
    const c = makeChecker({ fields: [GYM], divisions: DIVS, overrides: { disabledFields: ['Gym'] } });
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]);
    assert.equal(out.length, 1);
    assert.match(out[0], /Gym.*turned OFF/i);
  });

  it('flags a special disabled for this date', () => {
    const c = makeChecker({
      fields: [], divisions: DIVS,
      specials: [{ name: 'Woodworking', location: 'Shop' }],
      overrides: { disabledSpecials: ['Woodworking'] }
    });
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Woodworking', location: null, type: 'special' }]);
    assert.equal(out.length, 1);
    assert.match(out[0], /Woodworking.*turned OFF/i);
  });

  it('flags a sport whose every host field is off today', () => {
    const c = makeChecker({ fields: [GYM], divisions: DIVS, overrides: { disabledFields: ['Gym'] } });
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Basketball', location: null, type: 'sport' }]);
    assert.equal(out.length, 1);
    assert.match(out[0], /Every field that hosts.*Basketball/i);
  });

  it('does NOT flag a sport that still has an open host field', () => {
    const alt = { name: 'Gym 2', activities: ['Basketball'], sharableWith: { type: 'all', capacity: 4 } };
    const c = makeChecker({ fields: [GYM, alt], divisions: DIVS, overrides: { disabledFields: ['Gym'] } });
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Basketball', location: null, type: 'sport' }]);
    assertClean(out);
  });

  it('flags a sport explicitly disabled at the picked field for the date', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: { dailyDisabledSportsByField: { Gym: ['Basketball'] } }
    });
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Basketball', location: 'Gym', type: 'pinned' }]);
    assert.equal(out.length, 1);
    assert.match(out[0], /Basketball.*disabled at.*Gym/i);
  });

  // ── time rules ────────────────────────────────────────────────────────────
  it('flags a per-date unavailable window that OVERLAPS the block', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: { dailyFieldAvailability: { Gym: [{ type: 'unavailable', startMin: 630, endMin: 700 }] } }
    });
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]);
    assert.equal(out.length, 1);
    assert.match(out[0], /closed at/i);
  });

  it('leaves a non-overlapping unavailable window alone', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: { dailyFieldAvailability: { Gym: [{ type: 'unavailable', startMin: 700, endMin: 800 }] } }
    });
    assertClean(c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]));
  });

  it('matches the iron gate: lowercase and capitalised rule types both close it', () => {
    for (const type of ['unavailable', 'Unavailable', 'UNAVAILABLE']) {
      const c = makeChecker({
        fields: [GYM], divisions: DIVS,
        overrides: { dailyFieldAvailability: { Gym: [{ type, startMin: 630, endMin: 700 }] } }
      });
      assert.equal(c.closed('Gym', 600, 660, 'Grade 5'), true, 'type=' + type);
    }
  });

  it('an available-only rule set closes anything outside it', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: { dailyFieldAvailability: { Gym: [{ type: 'available', startMin: 540, endMin: 620 }] } }
    });
    assert.equal(c.closed('Gym', 600, 660, 'Grade 5'), true,  'block runs past the available window');
    assert.equal(c.closed('Gym', 550, 610, 'Grade 5'), false, 'block sits inside the available window');
  });

  it('a rule scoped to other divisions does not apply', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: { dailyFieldAvailability: { Gym: [{ type: 'unavailable', startMin: 630, endMin: 700, divisions: ['Grade 6'] }] } }
    });
    assert.equal(c.closed('Gym', 600, 660, 'Grade 5'), false);
    assert.equal(c.closed('Gym', 600, 660, 'Grade 6'), true);
  });

  it('falls back to the facility setup time rules when the date has none', () => {
    const gymWithSetupRule = Object.assign({}, GYM, { timeRules: [{ type: 'unavailable', start: '10:30', end: '11:40' }] });
    const c = makeChecker({ fields: [gymWithSetupRule], divisions: DIVS });
    assert.equal(c.closed('Gym', 600, 660, 'Grade 5'), true);
  });

  // ── sharing ───────────────────────────────────────────────────────────────
  it('flags a not-sharable facility given to 3 bunks at once', () => {
    const c = makeChecker({ fields: [GYM], divisions: DIVS });
    const out = c.check(
      [{ bunk: '5A', ...W }, { bunk: '5B', ...W }, { bunk: '5C', ...W }],
      [{ name: 'Gym', location: 'Gym', type: 'field' }]
    );
    assert.equal(out.length, 1);
    assert.match(out[0], /not shareable.*>3<.*bunks/i);
  });

  it('one bunk on a not-sharable facility is fine', () => {
    const c = makeChecker({ fields: [GYM], divisions: DIVS });
    assertClean(c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]));
  });

  it('counts bunks ALREADY overridden onto the same facility and window', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: {
        bunkActivityOverrides: [
          { id: 'x', bunk: '5B', startMin: 600, endMin: 660, activity: 'Gym', location: 'Gym', type: 'field' }
        ]
      }
    });
    // Only ONE new target, but 5B is already there → 2 bunks on a cap-1 room.
    const out = c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]);
    assert.equal(out.length, 1);
    assert.match(out[0], /not shareable.*>2<.*bunks/i);
  });

  it('does not count an existing override the apply is REPLACING', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: {
        bunkActivityOverrides: [
          { id: 'x', bunk: '5A', startMin: 600, endMin: 660, activity: 'Gym', location: 'Gym', type: 'field' }
        ]
      }
    });
    assertClean(c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]));
  });

  it('ignores an existing override in a different time window', () => {
    const c = makeChecker({
      fields: [GYM], divisions: DIVS,
      overrides: {
        bunkActivityOverrides: [
          { id: 'x', bunk: '5B', startMin: 700, endMin: 760, activity: 'Gym', location: 'Gym', type: 'field' }
        ]
      }
    });
    assertClean(c.check([{ bunk: '5A', ...W }], [{ name: 'Gym', location: 'Gym', type: 'field' }]));
  });

  it('flags a same_division facility shared across two grades', () => {
    const c = makeChecker({ fields: [FIELD_SAME_DIV], divisions: DIVS });
    const out = c.check(
      [{ bunk: '5A', ...W }, { bunk: '6A', ...W }],
      [{ name: 'Big Field', location: 'Big Field', type: 'field' }]
    );
    assert.equal(out.length, 1);
    assert.match(out[0], /only be shared within one grade/i);
  });

  it('allows a same_division facility shared inside one grade, up to capacity', () => {
    const c = makeChecker({ fields: [FIELD_SAME_DIV], divisions: DIVS });
    assertClean(c.check([{ bunk: '5A', ...W }, { bunk: '5B', ...W }], [{ name: 'Big Field', location: 'Big Field', type: 'field' }]));
  });

  it('flags exceeding the configured capacity', () => {
    const c = makeChecker({ fields: [FIELD_SAME_DIV], divisions: DIVS });
    const out = c.check(
      [{ bunk: '5A', ...W }, { bunk: '5B', ...W }, { bunk: '5C', ...W }],
      [{ name: 'Big Field', location: 'Big Field', type: 'field' }]
    );
    assert.equal(out.length, 1);
    assert.match(out[0], /allows.*>2<.*bunk\(s\).*>3</i);
  });

  it('a per-grade sharing rule overrides the facility default', () => {
    const perGrade = Object.assign({}, FIELD_ALL, { gradeShareRules: { 'Grade 5': { type: 'not_sharable', capacity: 1 } } });
    const c = makeChecker({ fields: [perGrade], divisions: DIVS });
    // Default is all/cap 4, but Grade 5 is pinned to not_sharable.
    const out = c.check(
      [{ bunk: '5A', ...W }, { bunk: '5B', ...W }],
      [{ name: 'Open Lawn', location: 'Open Lawn', type: 'field' }]
    );
    assert.equal(out.length, 1);
    assert.match(out[0], /not shareable/i);
  });

  it('a plain sport has no facility yet, so sharing is not judged', () => {
    const c = makeChecker({ fields: [GYM], divisions: DIVS });
    // 3 bunks on Basketball — the solver picks the court at generation time.
    assertClean(c.check([{ bunk: '5A', ...W }, { bunk: '5B', ...W }, { bunk: '5C', ...W }],
                        [{ name: 'Basketball', location: null, type: 'sport' }]));
  });

  it('reports a disabled facility AND its sharing breach together', () => {
    const c = makeChecker({ fields: [GYM], divisions: DIVS, overrides: { disabledFields: ['Gym'] } });
    const out = c.check(
      [{ bunk: '5A', ...W }, { bunk: '5B', ...W }],
      [{ name: 'Gym', location: 'Gym', type: 'field' }]
    );
    assert.equal(out.length, 2);
  });

  it('an unknown facility (not a configured field) is not judged for sharing', () => {
    const c = makeChecker({ fields: [], divisions: DIVS });
    assertClean(c.check([{ bunk: '5A', ...W }, { bunk: '5B', ...W }], [{ name: 'Somewhere', location: 'Somewhere', type: 'pinned' }]));
  });

  // ── capacity resolution mirrors SchedulerCoreUtils.getFieldCapacity ────────
  it('resolves capacity the same way the solver does', () => {
    const c = makeChecker({ fields: [], divisions: {} });
    assert.equal(c.capacity({ sharableWith: { type: 'not_sharable', capacity: 9 } }), 1, 'not_sharable is always 1');
    assert.equal(c.capacity({ sharableWith: { type: 'all' } }), 999, 'all defaults to unlimited');
    assert.equal(c.capacity({ sharableWith: { type: 'all', capacity: 3 } }), 3);
    assert.equal(c.capacity({ sharableWith: { type: 'same_division' } }), 2);
    assert.equal(c.capacity({ sharableWith: { type: 'cross_division' } }), 2);
    assert.equal(c.capacity({}), 1, 'no sharing config → 1');
  });
});
