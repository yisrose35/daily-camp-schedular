/**
 * Bunk Builder ⚡ Auto-Generate — behaviour suite.
 *
 * Drives the REAL generator block out of campistry_me.js (see
 * bunk_gen_harness.js) so these can't drift from the shipping code. One case
 * per behaviour the camp is entitled to rely on:
 *
 *   bunk size (1-5) · friend requests (6-12) · do-not-bunk (13-16) ·
 *   school grade (17-22) · criteria (23-24) · existing state (25-28) ·
 *   scale and degenerate input (29-34)
 *
 * Run with: node --test tests/bunk_generator.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runGenerator, DEFAULT_CONFIG } = require('./bunk_gen_harness.js');
const { makeCamp, standardCamp } = require('./bunk_gen_fixtures.js');
const { analyze, hardFailures } = require('./bunk_gen_check.js');

// ── helpers ──────────────────────────────────────────────────────────────
function sizesOf(camp) {
  const out = {};
  Object.keys(camp.roster).forEach(function (n) {
    const b = camp.roster[n].bunk;
    if (b) out[b] = (out[b] || 0) + 1;
  });
  return out;
}
function bunkOf(camp, n) { return camp.roster[n].bunk; }
function placedIn(camp, bunk) {
  return Object.keys(camp.roster).filter(function (n) { return camp.roster[n].bunk === bunk; });
}
// A hand-built camp: one cohort, named campers, explicit bunks.
function tinyCamp(bunks, campers, opts) {
  const o = opts || {};
  const roster = {};
  campers.forEach(function (c) {
    roster[c.name] = Object.assign({
      bunk: '', division: o.div || 'Boys', grade: o.group || 'Junior A',
      schoolGrade: '', school: '', city: '', zip: '', dob: '',
      bunkmateRequest: '', separateFrom: '', unenrolled: false
    }, c.data || {});
  });
  const structure = {};
  structure[o.div || 'Boys'] = {
    color: '#94A3B8',
    grades: {}
  };
  structure[o.div || 'Boys'].grades[o.group || 'Junior A'] = {
    bunks: bunks.slice(), schoolGrades: o.schoolGrades || []
  };
  return { roster: roster, structure: structure, enrollments: o.enrollments || {}, requests: { friends: [], avoid: [] } };
}
const NO_CRIT = [];

// ═══ BUNK SIZE ═══════════════════════════════════════════════════════════
describe('bunk size', function () {
  it('1. largest and smallest non-empty bunk differ by at most 3 on a 108-camper camp', function () {
    const camp = standardCamp(7);
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.equal(Object.keys(camp.roster).length, 108, 'fixture should be 108 campers');
    assert.deepEqual(hardFailures(a), []);
    assert.ok(a.spread <= 3, 'spread was ' + a.spread + ' (' + JSON.stringify(a.sizes) + ')');
  });

  it('2. no bunk under the camp minimum and none over the maximum on that camp', function () {
    const camp = standardCamp(7);
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.deepEqual(a.underMin, [], JSON.stringify(a.sizes));
    assert.deepEqual(a.overCapacity, []);
  });

  it('3. a bunk with bunkCapacity set is never exceeded', function () {
    const camp = standardCamp(7);
    const firstBunk = camp.structure.Boys.grades['Junior A'].bunks[0];
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, enrollments: camp.enrollments, capacity: { [firstBunk]: 5 } });
    const a = analyze(camp, r.config, r.capacity);
    assert.deepEqual(a.overCapacity, []);
    assert.ok(a.sizes[firstBunk] <= 5, firstBunk + ' held ' + a.sizes[firstBunk]);
    assert.equal(a.unplaced.length, 0);
  });

  it('4. a bunk capped below the camp minimum is filled to its capacity, not emptied', function () {
    const campers = [];
    for (let i = 1; i <= 26; i++) campers.push({ name: 'Kid ' + i });
    const camp = tinyCamp(['B1', 'B2', 'B3'], campers);
    const r = runGenerator({
      roster: camp.roster, structure: camp.structure,
      config: { minBunkSize: 8, maxBunkSize: 12, criteria: NO_CRIT },
      capacity: { B3: 4 }
    });
    const s = sizesOf(camp);
    assert.equal(s.B3, 4, 'B3 should be filled to its capacity of 4, got ' + s.B3 + ' — ' + JSON.stringify(s));
    assert.equal(r.report.underMin.length, 0, 'a bunk at its own capacity is not "under minimum"');
    assert.equal(r.report.unplaced.length, 0);
  });

  it('5. nine campers across three bunks with a minimum of 8 makes ONE bunk of 9', function () {
    const campers = [];
    for (let i = 1; i <= 9; i++) campers.push({ name: 'Kid ' + i });
    const camp = tinyCamp(['B1', 'B2', 'B3'], campers);
    runGenerator({
      roster: camp.roster, structure: camp.structure,
      config: { minBunkSize: 8, maxBunkSize: 12, criteria: NO_CRIT }
    });
    const s = sizesOf(camp);
    assert.deepEqual(Object.values(s).sort(), [9], 'expected a single bunk of 9, got ' + JSON.stringify(s));
  });
});

// ═══ FRIEND REQUESTS ═════════════════════════════════════════════════════
describe('friend requests', function () {
  it('6. a mutual request puts both campers in the same bunk', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen', data: { bunkmateRequest: 'Moshe Levy' } },
      { name: 'Moshe Levy', data: { bunkmateRequest: 'Avi Cohen' } },
      { name: 'Dovid Katz' }, { name: 'Eli Stern' },
      { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ]);
    runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.equal(bunkOf(camp, 'Avi Cohen'), bunkOf(camp, 'Moshe Levy'));
  });

  it('7. at least 90% of requests are honored on a full camp', function () {
    const camp = standardCamp(7);
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.ok(a.friendTotal >= 20, 'fixture should carry a real request load, had ' + a.friendTotal);
    assert.ok(a.friendRate >= 0.9,
      'honored ' + a.friendHonored + '/' + a.friendTotal + ' = ' + (a.friendRate * 100).toFixed(1) + '%'
      + ' — missed ' + JSON.stringify(a.friendMissed));
  });

  it('8. a partial name ("Moshe L") resolves to the right camper', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen', data: { bunkmateRequest: 'Moshe L' } },
      { name: 'Moshe Levy' }, { name: 'Dovid Katz' }, { name: 'Eli Stern' },
      { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ]);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.equal(bunkOf(camp, 'Avi Cohen'), bunkOf(camp, 'Moshe Levy'));
    assert.deepEqual(r.report.unresolved, []);
    assert.equal(r.report.requestsHonored, 1);
  });

  it('9. a request that only exists on the post-acceptance form is honored', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen' }, { name: 'Moshe Levy' }, { name: 'Dovid Katz' },
      { name: 'Eli Stern' }, { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ], {
      enrollments: {
        e1: { camperName: 'Avi Cohen', appliedDate: '2026-01-01', postAccept: { bunkmate: ['Moshe Levy'], separate: [] } }
      }
    });
    const r = runGenerator({
      roster: camp.roster, structure: camp.structure, enrollments: camp.enrollments,
      config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT }
    });
    assert.equal(bunkOf(camp, 'Avi Cohen'), bunkOf(camp, 'Moshe Levy'));
    assert.equal(r.report.requestsHonored, 1);
  });

  it('10. honoredRequests:1 with three requests on file counts exactly one', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen', data: { bunkRequests: ['Moshe Levy', 'Dovid Katz', 'Eli Stern'] } },
      { name: 'Moshe Levy' }, { name: 'Dovid Katz' }, { name: 'Eli Stern' },
      { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ]);
    const r = runGenerator({
      roster: camp.roster, structure: camp.structure,
      config: { minBunkSize: 1, maxBunkSize: 6, maxRequests: 3, honoredRequests: 1, criteria: NO_CRIT }
    });
    assert.equal(r.report.requestsTotal, 1);
  });

  it('11. an unmatchable request is reported with camper, text and kind', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen', data: { bunkmateRequest: 'Yankel Nobody', separateFrom: 'Ghost McGhost' } },
      { name: 'Moshe Levy' }, { name: 'Dovid Katz' }, { name: 'Eli Stern' },
      { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ]);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.deepEqual(
      r.report.unresolved.slice().sort(function (a, b) { return a.kind < b.kind ? -1 : 1; }),
      [{ camper: 'Avi Cohen', requested: 'Ghost McGhost', kind: 'avoid' },
       { camper: 'Avi Cohen', requested: 'Yankel Nobody', kind: 'friend' }]);
    assert.equal(r.report.requestsTotal, 1, 'an unresolvable friend request still counts in the denominator');
    assert.equal(r.report.requestsHonored, 0);
  });

  it('12. a 16-camper request chain neither overflows a bunk nor monopolises one', function () {
    const campers = [];
    for (let i = 1; i <= 16; i++) {
      campers.push({ name: 'Kid ' + i, data: i < 16 ? { bunkmateRequest: 'Kid ' + (i + 1) } : {} });
    }
    const camp = tinyCamp(['B1', 'B2', 'B3'], campers);
    const r = runGenerator({
      roster: camp.roster, structure: camp.structure,
      config: { minBunkSize: 6, maxBunkSize: 12, honoredRequests: 2, criteria: NO_CRIT }
    });
    const s = sizesOf(camp);
    const vals = Object.values(s);
    assert.equal(vals.reduce(function (a, b) { return a + b; }, 0), 16);
    assert.ok(Math.max.apply(null, vals) <= 12, 'overflowed: ' + JSON.stringify(s));
    assert.ok(Object.keys(s).length >= 2, 'one chain monopolised a single bunk: ' + JSON.stringify(s));
    assert.equal(r.report.unplaced.length, 0);
  });
});

// ═══ DO-NOT-BUNK ═════════════════════════════════════════════════════════
describe('do-not-bunk', function () {
  it('13. a separation pair never share a bunk', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen', data: { separateFrom: 'Moshe Levy' } },
      { name: 'Moshe Levy' }, { name: 'Dovid Katz' }, { name: 'Eli Stern' },
      { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ]);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.notEqual(bunkOf(camp, 'Avi Cohen'), bunkOf(camp, 'Moshe Levy'));
    assert.equal(r.report.avoidViolations, 0);
  });

  it('14. a separation beats a friend request naming the same camper', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen', data: { bunkmateRequest: 'Moshe Levy', separateFrom: 'Moshe Levy' } },
      { name: 'Moshe Levy', data: { bunkmateRequest: 'Avi Cohen' } },
      { name: 'Dovid Katz' }, { name: 'Eli Stern' },
      { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ]);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.notEqual(bunkOf(camp, 'Avi Cohen'), bunkOf(camp, 'Moshe Levy'));
    assert.equal(r.report.avoidViolations, 0);
  });

  it('15. a separation from an ALREADY-PLACED camper, written as a partial name, is enforced', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Yaakov Cohen', data: { bunk: 'B1' } },
      { name: 'Avi Levy', data: { separateFrom: 'Yaakov C' } },
      { name: 'Dovid Katz' }, { name: 'Eli Stern' },
      { name: 'Zev Blum' }, { name: 'Meir Roth' }
    ]);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.equal(bunkOf(camp, 'Yaakov Cohen'), 'B1', 'the already-placed camper must not be moved');
    assert.notEqual(bunkOf(camp, 'Avi Levy'), 'B1');
    assert.equal(r.report.avoidViolations, 0);
    assert.deepEqual(r.report.unresolved, [], '"Yaakov C" resolves to a real camper, so it is not unmatched');
  });

  it('16. zero violations on a heavy-request camp', function () {
    const camp = makeCamp({
      seed: 21,
      cohorts: [
        { div: 'Boys', group: 'Junior A', bunks: 4, campers: 40 },
        { div: 'Boys', group: 'Senior A', bunks: 4, campers: 40 }
      ],
      mutualPerCohort: 6, onewayPerCohort: 6, avoidPerCohort: 4
    });
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.deepEqual(a.avoidViolations, []);
    assert.equal(r.report.avoidViolations, 0);
    assert.equal(a.unplaced.length, 0);
  });
});

// ═══ SCHOOL GRADE ════════════════════════════════════════════════════════
describe('school grade', function () {
  it('17. every camper lands in a bunk group that takes their school grade', function () {
    const camp = standardCamp(7);
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.deepEqual(a.wrongGrade, []);
    assert.deepEqual(a.ghostBunk, []);
  });

  it('18. division and grade are written back onto every placed camper', function () {
    const camp = standardCamp(7);
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.deepEqual(a.staleDivGrade, []);
  });

  it('19. two divisions using the same bunk-group name stay separate', function () {
    const camp = makeCamp({
      seed: 3,
      cohorts: [
        { div: 'Boys', group: 'Junior A', bunks: 3, campers: 21 },
        { div: 'Girls', group: 'Junior A', bunks: 3, campers: 21 }
      ]
    });
    // Checked against the FIXTURE's cohort membership, not against
    // roster[n].division after the run: placing a camper in the wrong bunk
    // also rewrites their division to match that bunk, so a post-run field
    // comparison can never see this bug.
    const belongsTo = {};
    camp.cohorts.forEach(function (co) {
      co.members.forEach(function (n) { belongsTo[n] = co.div; });
    });
    const bunkDiv = {};
    ['Boys', 'Girls'].forEach(function (d) {
      camp.structure[d].grades['Junior A'].bunks.forEach(function (b) { bunkDiv[b] = d; });
    });
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    Object.keys(belongsTo).forEach(function (n) {
      const b = camp.roster[n].bunk;
      assert.ok(b, n + ' was not placed at all');
      assert.equal(bunkDiv[b], belongsTo[n],
        n + ' belongs to ' + belongsTo[n] + ' but landed in ' + b + ' (' + bunkDiv[b] + ')');
    });
    assert.deepEqual(a.staleDivGrade, []);
    assert.equal(a.unplaced.length, 0);
  });

  it('20. a school grade claimed by two bunk groups skips those campers, with a warning', function () {
    const camp = makeCamp({
      seed: 4,
      cohorts: [
        { div: 'Boys', group: 'Junior A', bunks: 2, campers: 12, schoolGrades: ['5th Grade'] },
        { div: 'Boys', group: 'Junior B', bunks: 2, campers: 12, schoolGrades: ['5th Grade'] }
      ]
    });
    const r = runGenerator(camp);
    assert.equal(r.report.placed, 0, 'nobody may be guessed into a group when the mapping is ambiguous');
    assert.equal(r.report.unplaced.length, 24);
    assert.ok(r.report.warnings.some(function (w) { return /more than one bunk group/.test(w); }),
      'expected an ambiguity warning, got: ' + JSON.stringify(r.report.warnings));
  });

  it('21. a camper with no grade match never lands in a MAPPED group, and is reported', function () {
    const camp = tinyCamp(['M1', 'M2'], [
      { name: 'Avi Cohen', data: { schoolGrade: '3rd Grade' } },
      { name: 'Moshe Levy', data: { schoolGrade: '3rd Grade' } },
      { name: 'Dovid Katz', data: { schoolGrade: '3rd Grade' } }
    ], { schoolGrades: ['3rd Grade'] });
    // a second, UNMAPPED bunk group, and a camper whose grade matches nothing
    camp.structure.Boys.grades['Flex'] = { bunks: ['F1'], schoolGrades: [] };
    camp.roster['Lost Kid'] = {
      bunk: '', division: 'Boys', grade: 'No Such Group', schoolGrade: '11th Grade',
      school: '', city: '', zip: '', dob: '', bunkmateRequest: '', separateFrom: '', unenrolled: false
    };
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.equal(bunkOf(camp, 'Lost Kid'), 'F1', 'must land in the UNMAPPED group, not the 3rd-Grade one');
    assert.deepEqual(r.report.fallbackPlaced, ['Lost Kid']);
    assert.equal(camp.roster['Lost Kid'].grade, 'Flex', 'the fallback must write the grade back too');
    assert.equal(camp.roster['Lost Kid'].division, 'Boys');
  });

  it('22. a camp with no school-grade mapping still pools by bunk-group name', function () {
    const camp = makeCamp({
      seed: 5,
      cohorts: [
        { div: 'Boys', group: 'Junior A', bunks: 2, campers: 14 },
        { div: 'Boys', group: 'Senior A', bunks: 2, campers: 14 }
      ]
    });
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.equal(a.unplaced.length, 0);
    assert.deepEqual(a.staleDivGrade, []);
    assert.deepEqual(r.report.fallbackPlaced, [], 'the cohort path should have handled everyone');
  });
});

// ═══ CRITERIA ════════════════════════════════════════════════════════════
describe('grouping criteria', function () {
  it('23. school grouping beats chance, and beats the same camp with criteria off', function () {
    const withCrit = standardCamp(7);
    const rc = runGenerator(withCrit);
    const ac = analyze(withCrit, rc.config, rc.capacity);

    const without = standardCamp(7);
    const rn = runGenerator({
      roster: without.roster, structure: without.structure, enrollments: without.enrollments,
      config: { criteria: [] }
    });
    const an = analyze(without, rn.config, rn.capacity);

    assert.ok(ac.sameSchoolRate >= 0.30,
      'same-school pair rate was ' + (ac.sameSchoolRate * 100).toFixed(1) + '%');
    assert.ok((ac.sameSchoolRate - an.sameSchoolRate) >= 0.08,
      'criteria added only ' + ((ac.sameSchoolRate - an.sameSchoolRate) * 100).toFixed(1)
      + ' points (' + (ac.sameSchoolRate * 100).toFixed(1) + '% vs ' + (an.sameSchoolRate * 100).toFixed(1) + '%)');
  });

  it('24. a grade where everyone shares one school still places everyone', function () {
    const camp = makeCamp({
      seed: 9,
      cohorts: [{ div: 'Boys', group: 'Junior A', bunks: 4, campers: 32, schools: ['Darchei Torah'] }]
    });
    const r = runGenerator(camp);
    const a = analyze(camp, r.config, r.capacity);
    assert.equal(a.unplaced.length, 0);
    assert.deepEqual(a.overCapacity, []);
    assert.equal(a.sameSchoolRate, 1);
  });
});

// ═══ EXISTING STATE ══════════════════════════════════════════════════════
describe('existing state', function () {
  it('25. campers already placed are left exactly where they are', function () {
    const camp = standardCamp(7);
    const pre = Object.keys(camp.roster).slice(0, 5);
    const bunks = camp.structure.Boys.grades['Junior A'].bunks;
    const pinned = {};
    pre.forEach(function (n, i) {
      camp.roster[n].bunk = bunks[i % bunks.length];
      camp.roster[n].schoolGrade = '3rd Grade';
      camp.roster[n].division = 'Boys';
      camp.roster[n].grade = 'Junior A';
      pinned[n] = camp.roster[n].bunk;
    });
    runGenerator(camp);
    Object.keys(pinned).forEach(function (n) {
      assert.equal(camp.roster[n].bunk, pinned[n], n + ' was moved out of ' + pinned[n]);
    });
  });

  it('26. unenrolled campers are skipped and are not counted as unplaced', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen' }, { name: 'Moshe Levy' }, { name: 'Dovid Katz' },
      { name: 'Gone Kid', data: { unenrolled: true } },
      { name: 'Also Gone', data: { unenrolled: true } }
    ]);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.equal(bunkOf(camp, 'Gone Kid'), '');
    assert.equal(bunkOf(camp, 'Also Gone'), '');
    assert.deepEqual(r.report.unplaced, []);
    assert.equal(r.report.placed, 3);
  });

  it('27. running twice in a row changes nothing', function () {
    const camp = standardCamp(7);
    runGenerator(camp);
    const first = JSON.stringify(sizesOf(camp));
    const firstPlacement = {};
    Object.keys(camp.roster).forEach(function (n) { firstPlacement[n] = camp.roster[n].bunk; });
    const r2 = runGenerator(camp);
    assert.equal(JSON.stringify(sizesOf(camp)), first);
    Object.keys(firstPlacement).forEach(function (n) {
      assert.equal(camp.roster[n].bunk, firstPlacement[n], n + ' moved on the second run');
    });
    assert.equal(r2.report.unplaced.length, 0);
  });

  it('28. the same camp in gives the same bunks out', function () {
    const a = standardCamp(7); runGenerator(a);
    const b = standardCamp(7); runGenerator(b);
    const pa = {}, pb = {};
    Object.keys(a.roster).forEach(function (n) { pa[n] = a.roster[n].bunk; });
    Object.keys(b.roster).forEach(function (n) { pb[n] = b.roster[n].bunk; });
    assert.deepEqual(pa, pb);
  });
});

// ═══ SCALE AND DEGENERATE INPUT ══════════════════════════════════════════
describe('scale and degenerate input', function () {
  it('29. 600 campers finish quickly with no overflow and no violations', function () {
    const cohorts = [];
    for (let g = 1; g <= 6; g++) {
      cohorts.push({ div: g <= 3 ? 'Boys' : 'Girls', group: 'Group ' + g, bunks: 10, campers: 100 });
    }
    const camp = makeCamp({ seed: 11, cohorts: cohorts, mutualPerCohort: 8, onewayPerCohort: 6, avoidPerCohort: 4 });
    const t0 = Date.now();
    const r = runGenerator(camp);
    const ms = Date.now() - t0;
    const a = analyze(camp, r.config, r.capacity);
    assert.equal(Object.keys(camp.roster).length, 600);
    assert.deepEqual(hardFailures(a), []);
    assert.equal(a.unplaced.length, 0);
    assert.ok(ms < 15000, 'took ' + ms + 'ms');
  });

  it('30. a camp with no bunks toasts instead of crashing', function () {
    const camp = { roster: { 'Avi Cohen': { bunk: '', division: 'Boys', grade: 'Junior A' } }, structure: {} };
    const r = runGenerator(camp);
    assert.equal(r.report, null, 'no report modal when there is nothing to generate into');
    assert.equal(r.toasts.length, 1);
    assert.match(r.toasts[0].msg, /divisions and bunks/i);
    assert.equal(camp.roster['Avi Cohen'].bunk, '');
  });

  it('31. an empty roster is a no-op', function () {
    const camp = tinyCamp(['B1', 'B2'], []);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure });
    assert.equal(r.report.placed, 0);
    assert.deepEqual(r.report.unplaced, []);
    assert.deepEqual(r.report.warnings, []);
    assert.deepEqual(r.report.underMin, []);
  });

  it('32. a camper requesting themselves is ignored, not counted and not "unresolved"', function () {
    const camp = tinyCamp(['B1', 'B2'], [
      { name: 'Avi Cohen', data: { bunkRequests: ['Avi Cohen', 'Avi C'] } },
      { name: 'Moshe Levy' }, { name: 'Dovid Katz' }, { name: 'Eli Stern' }
    ]);
    const r = runGenerator({ roster: camp.roster, structure: camp.structure, config: { minBunkSize: 1, maxBunkSize: 6, criteria: NO_CRIT } });
    assert.equal(r.report.requestsTotal, 0);
    assert.deepEqual(r.report.unresolved, []);
    assert.equal(r.report.unplaced.length, 0);
  });

  it('33. requests and do-not-bunk switched off are ignored entirely', function () {
    const camp = tinyCamp(['B1'], [
      { name: 'Avi Cohen', data: { bunkmateRequest: 'Moshe Levy', separateFrom: 'Moshe Levy' } },
      { name: 'Moshe Levy' }
    ]);
    const r = runGenerator({
      roster: camp.roster, structure: camp.structure,
      config: { minBunkSize: 1, maxBunkSize: 6, requestsEnabled: false, doNotBunkEnabled: false, criteria: NO_CRIT }
    });
    assert.equal(bunkOf(camp, 'Avi Cohen'), 'B1');
    assert.equal(bunkOf(camp, 'Moshe Levy'), 'B1', 'the separation must be ignored when the feature is off');
    assert.equal(r.report.requestsTotal, 0);
    assert.equal(r.report.avoidViolations, 0);
    assert.deepEqual(r.report.unresolved, []);
  });

  it('34. more campers than beds is reported as unplaced, never overfilled', function () {
    const campers = [];
    for (let i = 1; i <= 12; i++) campers.push({ name: 'Kid ' + i });
    const camp = tinyCamp(['B1'], campers);
    const r = runGenerator({
      roster: camp.roster, structure: camp.structure,
      config: { minBunkSize: 2, maxBunkSize: 5, criteria: NO_CRIT }
    });
    const s = sizesOf(camp);
    assert.equal(s.B1, 5, 'B1 must stop at the maximum, got ' + s.B1);
    assert.equal(r.report.unplaced.length, 7);
    assert.equal(r.report.placed, 5);
    assert.ok(r.report.warnings.length > 0, 'the office has to be told');
  });
});
