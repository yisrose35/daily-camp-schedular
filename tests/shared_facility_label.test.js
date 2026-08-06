/**
 * Shared-facility label on a schedule tile.
 *
 * When another bunk is on the same facility at the same time, the tile names it.
 * The wording depends on WHAT is shared, because the two cases mean different
 * things to a counselor reading the sheet:
 *
 *   • a shared SPORTS FIELD normally means the two bunks are playing each other
 *       → "Kickball – Baseball Field 1 – vs Bunk 2"
 *   • a shared SPECIAL ACTIVITY is a group attending together, not a contest
 *       → "Arts & Crafts – Room A – with Bunks 2, 3, & 4"
 *
 * Regression guard: a special is only recognised via the special-activity
 * registry, and that config is mirrored in several stores that can diverge
 * (getAllSpecialActivities vs the persisted app1 copy). A name missed by
 * `_specialNamesSet` makes a special fall through to the sports branch and
 * render as a "vs" matchup — the exact bug this file pins down.
 *
 * Drives the REAL functions out of unified_schedule_system.js (sliced by name
 * and evaluated against injected globals) so the wording can't drift from the
 * shipped code. The file is far too large to evaluate whole in a sandbox.
 *
 * Run with: node --test tests/shared_facility_label.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'unified_schedule_system.js'), 'utf8');

// Slice `    function NAME(...) { ... }` out of the source by matching braces.
// These helpers are module-local (inside the IIFE), hence the leading indent.
function sliceFunction(name) {
  const start = SRC.search(new RegExp('\\n\\s*function ' + name + '\\('));
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
  'fieldLabel',
  'resolveEntryLocation',
  '_specialNamesSet',
  '_noSharers',
  'findFieldSharers',
  '_formatSharerGroup'
].map(sliceFunction).join('\n');

// The one line of module state the slices close over.
const PRELUDE = 'const Utils = () => window.SchedulerCoreUtils || {};\n';

// The label the schedule grid appends, lifted verbatim from renderCell so the
// test asserts the shipped wording rather than a paraphrase of it.
const LABEL = `
function labelFor(bunk, slotIdx, divName) {
  const _sharers = findFieldSharers(bunk, slotIdx, divName);
  if (!_sharers.bunks.length) return '';
  if (_sharers.kind === 'special') return ' – with ' + _formatSharerGroup(_sharers.bunks);
  const _names = _sharers.bunks.map(b => /^\\d/.test(String(b)) ? 'Bunk ' + b : b);
  return ' – vs ' + _names.join(', ');
}
`;

/**
 * @param specialsIn  where the special registry is readable from:
 *                    'registry' (getAllSpecialActivities), 'app1', 'top', 'none'
 */
function makeLabeller({ assignments, specials = [], specialsIn = 'registry' }) {
  // One division, one slot, everyone in it — the sharer scan is time-based, and
  // a single overlapping slot is enough to exercise every branch.
  const bunks = Object.keys(assignments);
  const slots = [{ startMin: 600, endMin: 645 }];
  const specialDefs = specials.map(name => ({ name }));

  const win = {
    scheduleAssignments: assignments,
    divisionTimes: { Majors: slots },
    SchedulerCoreUtils: { getDivisionForBunk: () => 'Majors' },
    naturalSort: (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }),
    getAllSpecialActivities: specialsIn === 'registry' ? () => specialDefs : undefined,
    loadGlobalSettings: () => ({
      app1: { specialActivities: specialsIn === 'app1' ? specialDefs : [] },
      specialActivities: specialsIn === 'top' ? specialDefs : []
    })
  };
  if (specialsIn !== 'registry') delete win.getAllSpecialActivities;

  const ctx = { console, window: win };
  vm.createContext(ctx);
  vm.runInContext(PRELUDE + FNS + LABEL, ctx);
  return { label: (bunk) => ctx.labelFor(bunk, 0, 'Majors'), bunks };
}

const sport = (name, field) => ({ _activity: name, sport: name, field });
const special = (name, room) => ({ _activity: name, field: name, _specialLocation: room });

describe('shared sports field — reads as a matchup', () => {
  it('two bunks on one field → "vs Bunk 2"', () => {
    const { label } = makeLabeller({
      assignments: { '1': [sport('Kickball', 'Baseball Field 1')], '2': [sport('Kickball', 'Baseball Field 1')] }
    });
    assert.equal(label('1'), ' – vs Bunk 2');
    assert.equal(label('2'), ' – vs Bunk 1');
  });

  it('three bunks on one field keep the existing comma list', () => {
    const { label } = makeLabeller({
      assignments: {
        '1': [sport('Kickball', 'Baseball Field 1')],
        '2': [sport('Kickball', 'Baseball Field 1')],
        '3': [sport('Kickball', 'Baseball Field 1')]
      }
    });
    assert.equal(label('1'), ' – vs Bunk 2, Bunk 3');
  });

  it('different fields at the same time do not pair', () => {
    const { label } = makeLabeller({
      assignments: { '1': [sport('Kickball', 'Field A')], '2': [sport('Kickball', 'Field B')] }
    });
    assert.equal(label('1'), '');
  });
});

describe('shared special activity — reads as a group, never "vs"', () => {
  it('two bunks → "with Bunks 1 & 2", not "vs"', () => {
    const { label } = makeLabeller({
      assignments: { '1': [special('Arts & Crafts', 'Room A')], '2': [special('Arts & Crafts', 'Room A')] },
      specials: ['Arts & Crafts']
    });
    assert.equal(label('1'), ' – with Bunk 2');
    assert.equal(label('2'), ' – with Bunk 1');
    assert.ok(!label('1').includes('vs'));
  });

  it('four bunks → Oxford-comma ampersand list', () => {
    const { label } = makeLabeller({
      assignments: {
        '1': [special('Gameroom', 'Gameroom')],
        '2': [special('Gameroom', 'Gameroom')],
        '3': [special('Gameroom', 'Gameroom')],
        '4': [special('Gameroom', 'Gameroom')]
      },
      specials: ['Gameroom']
    });
    assert.equal(label('1'), ' – with Bunks 2, 3, & 4');
    assert.equal(label('3'), ' – with Bunks 1, 2, & 4');
  });

  it('three bunks → "Bunks 2 & 3" (no comma before the ampersand)', () => {
    const { label } = makeLabeller({
      assignments: {
        '1': [special('Gameroom', 'Gameroom')],
        '2': [special('Gameroom', 'Gameroom')],
        '3': [special('Gameroom', 'Gameroom')]
      },
      specials: ['Gameroom']
    });
    assert.equal(label('1'), ' – with Bunks 2 & 3');
  });

  it('named (non-numeric) bunks are listed verbatim', () => {
    const { label } = makeLabeller({
      assignments: {
        'Majors 1': [special('Canteen', 'Canteen')],
        'Majors 2': [special('Canteen', 'Canteen')],
        'Majors 3': [special('Canteen', 'Canteen')]
      },
      specials: ['Canteen']
    });
    assert.equal(label('Majors 1'), ' – with Majors 2 & Majors 3');
  });

  it('the same special in two rooms stays two separate groups', () => {
    const { label } = makeLabeller({
      assignments: {
        '1': [special('Arts & Crafts', 'Room A')],
        '2': [special('Arts & Crafts', 'Room A')],
        '3': [special('Arts & Crafts', 'Room B')]
      },
      specials: ['Arts & Crafts']
    });
    assert.equal(label('1'), ' – with Bunk 2');
    assert.equal(label('3'), '');
  });

  it('a bunk alone at a special gets no annotation', () => {
    const { label } = makeLabeller({
      assignments: { '1': [special('Gameroom', 'Gameroom')], '2': [sport('Kickball', 'Field A')] },
      specials: ['Gameroom']
    });
    assert.equal(label('1'), '');
  });
});

describe('special detection survives a divergent config store', () => {
  // The registry and the persisted app1 copy can hold different lists; whichever
  // one carries the name, the tile must still read "with", never "vs".
  for (const store of ['registry', 'app1', 'top']) {
    it('special named only in the ' + store + ' store still reads "with"', () => {
      const { label } = makeLabeller({
        assignments: { '1': [special('Gameroom', 'Gameroom')], '2': [special('Gameroom', 'Gameroom')] },
        specials: ['Gameroom'],
        specialsIn: store
      });
      assert.equal(label('1'), ' – with Bunk 2');
    });
  }

  it('an unregistered activity falls back to the sports wording', () => {
    const { label } = makeLabeller({
      assignments: { '1': [special('Gameroom', 'Gameroom')], '2': [special('Gameroom', 'Gameroom')] },
      specials: [],
      specialsIn: 'none'
    });
    assert.equal(label('1'), ' – vs Bunk 2');
  });
});

describe('entries that must never be annotated', () => {
  const exempt = {
    'league matchup': { _activity: 'League Game', field: 'Field A', _allMatchups: ['1 vs 2 @ Field A'] },
    'head-to-head': { _activity: 'Kickball', field: 'Field A', _h2h: true },
    'pinned tile': { _activity: 'Kickball', field: 'Field A', _pinned: true },
    'trip': { _activity: 'Zoo', field: 'Zoo', _isTrip: true },
    'transition': { _activity: 'Travel', field: 'Field A', _isTransition: true },
    'lunch': { _activity: 'Lunch', field: 'Dining Room' }
  };
  for (const [what, entry] of Object.entries(exempt)) {
    it(what + ' gets no sharer text', () => {
      const { label } = makeLabeller({
        assignments: { '1': [entry], '2': [{ ...entry }] },
        specials: ['Zoo']
      });
      assert.equal(label('1'), '');
    });
  }
});
