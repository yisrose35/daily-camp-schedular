// bunk_gen_report.console.js — readable quality report for the Bunk Builder
// auto-generator. This is NOT pass/fail (bunk_generator.test.js is): it is what
// you run to see whether a change made the BUNKS better, not just legal.
//
//   node tests/bunk_gen_report.console.js
//
// To compare against another copy of campistry_me.js (e.g. before a change):
//   BUNK_GEN_SRC=/path/to/old/campistry_me.js node tests/bunk_gen_report.console.js

const { runGenerator } = require('./bunk_gen_harness.js');
const { makeCamp, standardCamp, randomCamp } = require('./bunk_gen_fixtures.js');
const { analyze, hardFailures } = require('./bunk_gen_check.js');

const pct = (x) => (x * 100).toFixed(1) + '%';
const pad = (s, n) => String(s).padEnd(n);

function line(char) { console.log(char.repeat(76)); }

function reportCamp(label, camp, opts) {
  const r = runGenerator(Object.assign({
    roster: camp.roster, structure: camp.structure, enrollments: camp.enrollments
  }, opts || {}));
  const a = analyze(camp, r.config, r.capacity);
  const fails = hardFailures(a);

  console.log('\n' + label);
  line('─');
  const sizeStr = a.nonEmpty.map((b) => b + ':' + a.sizes[b]).join('  ');
  console.log('  bunks in use      ' + a.nonEmpty.length + ' of ' + Object.keys(a.sizes).length
    + (a.emptyBunks.length ? '   (empty: ' + a.emptyBunks.join(', ') + ')' : ''));
  console.log('  sizes             ' + sizeStr);
  console.log('  largest/smallest  ' + a.largest + ' / ' + a.smallest + '   spread ' + a.spread
    + '   gini ' + a.gini.toFixed(3));
  console.log('  under minimum     ' + (a.underMin.length ? JSON.stringify(a.underMin) : 'none'));
  console.log('  unplaced          ' + (a.unplaced.length || 'none'));
  if (a.friendTotal) {
    console.log('  friend requests   ' + a.friendHonored + ' / ' + a.friendTotal + '  (' + pct(a.friendRate) + ')');
  }
  if (a.avoidTotal) {
    console.log('  do-not-bunk       ' + a.avoidViolations.length + ' violated of ' + a.avoidTotal);
  }
  console.log('  same-school pairs ' + pct(a.sameSchoolRate) + '   same-city pairs ' + pct(a.sameCityRate));
  if (r.report) {
    if (r.report.unresolved.length) console.log('  unresolved names  ' + r.report.unresolved.length);
    if (r.report.fallbackPlaced.length) console.log('  no grade match    ' + r.report.fallbackPlaced.length);
    if (r.report.leftEmpty.length) console.log('  left empty        ' + r.report.leftEmpty.join(', '));
  }
  console.log('  HARD FAILURES     ' + (fails.length ? '*** ' + fails.join(' | ') : 'none'));
  return { a, r };
}

line('═');
console.log('BUNK BUILDER — AUTO-GENERATE QUALITY REPORT');
line('═');

// ── 1. the headline camp ─────────────────────────────────────────────────
reportCamp('1. Standard camp — 108 campers, 2 divisions, 4 bunk groups, 14 bunks',
  standardCamp(7));

// ── 2. the same camp with the criteria switched off, for contrast ────────
reportCamp('2. Same camp, all grouping criteria DISABLED (the contrast case)',
  standardCamp(7), { config: { criteria: [] } });

// ── 3. per-bunk capacity ─────────────────────────────────────────────────
(function () {
  const camp = standardCamp(7);
  const bunks = camp.structure.Boys.grades['Junior A'].bunks;
  reportCamp('3. Standard camp with per-bunk capacity set (' + bunks[0] + '=5, ' + bunks[1] + '=7)',
    camp, { capacity: { [bunks[0]]: 5, [bunks[1]]: 7 } });
})();

// ── 4. a camp under real request pressure ────────────────────────────────
reportCamp('4. Heavy requests — 6 mutual + 6 one-way + 4 separations per group',
  makeCamp({
    seed: 21,
    cohorts: [
      { div: 'Boys', group: 'Junior A', bunks: 4, campers: 40 },
      { div: 'Boys', group: 'Senior A', bunks: 4, campers: 40 }
    ],
    mutualPerCohort: 6, onewayPerCohort: 6, avoidPerCohort: 4
  }));

// ── 5. a small, awkward camp — more bunks than the minimum can fill ──────
reportCamp('5. Small camp — 20 campers, 5 bunks, minimum 8 (bunks must be left empty)',
  makeCamp({ seed: 33, cohorts: [{ div: 'Boys', group: 'Junior A', bunks: 5, campers: 20 }] }),
  { config: { minBunkSize: 8, maxBunkSize: 12 } });

// ── 6. more campers than beds — the one case that CAN'T come out clean ───
reportCamp('6. Over-subscribed — 30 campers, 2 bunks (24 beds), separations on file',
  makeCamp({
    seed: 44,
    cohorts: [{ div: 'Boys', group: 'Junior A', bunks: 2, campers: 30 }],
    avoidPerCohort: 4
  }));
console.log('  ^ expected: campers left in the Unassigned pool, and a forced');
console.log('    do-not-bunk conflict is possible once every bed is taken —');
console.log('    both are reported, neither is silent.');

// ── the sweep ────────────────────────────────────────────────────────────
console.log('\n');
line('═');
console.log('RANDOMISED SWEEP — 120 seeded camps');
line('═');

const SEEDS = 120;
let campers = 0, friendTot = 0, friendHon = 0, avoidTot = 0, avoidBad = 0;
let unplaced = 0, overCap = 0, wrongGrade = 0, stale = 0, ghost = 0;
let schoolRateSum = 0, giniSum = 0, spreadSum = 0, underMin = 0, rated = 0;
const worst = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const camp = randomCamp(seed);
  const r = runGenerator(camp);
  const a = analyze(camp, r.config, r.capacity);
  campers += Object.keys(camp.roster).length;
  friendTot += a.friendTotal; friendHon += a.friendHonored;
  avoidTot += a.avoidTotal; avoidBad += a.avoidViolations.length;
  unplaced += a.unplaced.length;
  overCap += a.overCapacity.length;
  wrongGrade += a.wrongGrade.length;
  stale += a.staleDivGrade.length;
  ghost += a.ghostBunk.length;
  underMin += a.underMin.length;
  if (a.pairs) { schoolRateSum += a.sameSchoolRate; rated++; }
  giniSum += a.gini; spreadSum += a.spread;
  const f = hardFailures(a);
  if (f.length) worst.push('seed ' + seed + ': ' + f.join(' | '));
}

console.log('  camps                     ' + SEEDS);
console.log('  campers placed across all ' + campers);
console.log('');
console.log('  ' + pad('hard-constraint failures:', 28) + (overCap + avoidBad + wrongGrade + stale + ghost));
console.log('    ' + pad('over per-bunk capacity', 26) + overCap);
console.log('    ' + pad('do-not-bunk violated', 26) + avoidBad + ' of ' + avoidTot);
console.log('    ' + pad('wrong school grade', 26) + wrongGrade);
console.log('    ' + pad('stale division/grade', 26) + stale);
console.log('    ' + pad('placed in a ghost bunk', 26) + ghost);
console.log('    ' + pad('campers left unplaced', 26) + unplaced);
console.log('');
console.log('  ' + pad('friend requests honored:', 28) + friendHon + '/' + friendTot
  + '  (' + pct(friendTot ? friendHon / friendTot : 1) + ')');
console.log('  ' + pad('mean same-school pair rate:', 28) + pct(rated ? schoolRateSum / rated : 0)
  + '   (chance is ~20% with 5 schools)');
console.log('  ' + pad('mean size gini:', 28) + (giniSum / SEEDS).toFixed(3));
console.log('  ' + pad('mean size spread:', 28) + (spreadSum / SEEDS).toFixed(2));
console.log('  ' + pad('bunks under minimum:', 28) + underMin
  + '   (each one is explained in the report modal)');

if (worst.length) {
  console.log('\n  *** HARD FAILURES ***');
  worst.slice(0, 20).forEach((w) => console.log('    ' + w));
  if (worst.length > 20) console.log('    + ' + (worst.length - 20) + ' more');
  process.exitCode = 1;
} else {
  console.log('\n  no hard-constraint failure in any of the ' + SEEDS + ' camps.');
}
line('═');
