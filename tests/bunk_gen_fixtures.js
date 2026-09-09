// bunk_gen_fixtures.js — seeded, deterministic camps for the bunk-generator
// tests. Every camp is a plain {roster, structure, enrollments} plus a
// `requests` ground-truth block, so bunk_gen_check.js can score a run against
// what was actually asked for rather than re-deriving it through the same
// resolver the generator uses.
//
// A camp is described by its cohorts — one entry per (division, bunk group) —
// which is the unit the generator itself works in.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Avi', 'Moshe', 'Yaakov', 'Dovid', 'Shmuel', 'Eli', 'Yosef', 'Chaim', 'Binyomin', 'Zev',
  'Naftali', 'Shlomo', 'Meir', 'Aryeh', 'Yehuda', 'Tzvi', 'Menachem', 'Baruch', 'Simcha', 'Nosson',
  'Rivka', 'Sarah', 'Leah', 'Miriam', 'Chana', 'Devorah', 'Esther', 'Shaindy', 'Malka', 'Rochel'];
const LAST = ['Cohen', 'Levy', 'Friedman', 'Katz', 'Schwartz', 'Rosenberg', 'Goldstein', 'Weiss',
  'Kaplan', 'Berger', 'Adler', 'Feld', 'Mandel', 'Stern', 'Roth', 'Green', 'Blum', 'Sofer',
  'Klein', 'Hirsch', 'Zimmer', 'Perl', 'Braun', 'Salzman', 'Yaffe', 'Nadler', 'Oster', 'Uhr'];
const SCHOOLS = ['Darchei Torah', 'Torah Vodaas', 'Chaim Berlin', 'Mesivta of Long Beach', 'Bais Yaakov'];
const CITIES = ['Lakewood', 'Brooklyn', 'Monsey', 'Passaic', 'Baltimore'];

// Deterministic unique full names, drawn in a fixed order so the same seed
// always produces the same roster in the same order.
function nameFactory(rnd) {
  const used = new Set();
  return function next() {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const f = FIRST[Math.floor(rnd() * FIRST.length)];
      const l = LAST[Math.floor(rnd() * LAST.length)];
      const n = f + ' ' + l;
      if (!used.has(n)) { used.add(n); return n; }
    }
    let i = 1;
    while (used.has('Camper ' + i)) i++;
    used.add('Camper ' + i);
    return 'Camper ' + i;
  };
}

/**
 * @param {object}  opts
 * @param {number} [opts.seed=1]
 * @param {Array}   opts.cohorts   [{div, group, bunks, campers, schoolGrades?, bunkNames?, schools?}]
 * @param {number} [opts.mutualPerCohort=0]   mutual A↔B friend pairs
 * @param {number} [opts.onewayPerCohort=0]   one-way A→B friend requests
 * @param {number} [opts.avoidPerCohort=0]    do-not-bunk pairs
 * @param {string} [opts.requestSource='roster']  'roster' | 'enrollment' | 'postAccept'
 * @param {number} [opts.schoolCount=5]
 * @param {number} [opts.cityCount=5]
 */
function makeCamp(opts) {
  const o = Object.assign({
    seed: 1, mutualPerCohort: 0, onewayPerCohort: 0, avoidPerCohort: 0,
    requestSource: 'roster', schoolCount: 5, cityCount: 5
  }, opts);
  const rnd = mulberry32(o.seed);
  const nextName = nameFactory(rnd);

  const roster = {};
  const structure = {};
  const enrollments = {};
  const requests = { friends: [], avoid: [] };
  const byCohort = [];
  let enrId = 1;

  o.cohorts.forEach(function (c, ci) {
    if (!structure[c.div]) structure[c.div] = { color: '#94A3B8', grades: {} };
    const bunkNames = c.bunkNames || [];
    if (!bunkNames.length) {
      for (let b = 1; b <= c.bunks; b++) bunkNames.push(c.div.slice(0, 1) + (ci + 1) + '-' + b);
    }
    structure[c.div].grades[c.group] = {
      bunks: bunkNames.slice(),
      schoolGrades: (c.schoolGrades || []).slice()
    };
    const schools = c.schools || SCHOOLS.slice(0, Math.max(1, o.schoolCount));
    const cities = CITIES.slice(0, Math.max(1, o.cityCount));
    const members = [];
    for (let i = 0; i < c.campers; i++) {
      const n = nextName();
      const sgList = c.schoolGrades || [];
      roster[n] = {
        bunk: '',
        division: c.div,
        grade: c.group,
        schoolGrade: sgList.length ? sgList[i % sgList.length] : '',
        school: schools[Math.floor(rnd() * schools.length)],
        city: cities[Math.floor(rnd() * cities.length)],
        zip: '',
        dob: '201' + (3 + Math.floor(rnd() * 3)) + '-0' + (1 + Math.floor(rnd() * 9)) + '-1' + Math.floor(rnd() * 9),
        bunkmateRequest: '', separateFrom: '', unenrolled: false
      };
      members.push(n);
    }
    byCohort.push({ div: c.div, group: c.group, bunks: bunkNames.slice(), members: members });
  });

  // Requests are drawn WITHIN a cohort — a parent asking for a kid in another
  // grade is a real thing, but it is unresolvable by construction, so the
  // tests that care about it build it explicitly instead of by the yard.
  function addFriend(a, b) {
    if (o.requestSource === 'roster') {
      roster[a].bunkmateRequest = roster[a].bunkmateRequest ? roster[a].bunkmateRequest + ', ' + b : b;
    } else if (o.requestSource === 'enrollment') {
      enrollments['e' + (enrId++)] = { camperName: a, bunkmate: b, appliedDate: '2026-01-01' };
    } else {
      enrollments['e' + (enrId++)] = { camperName: a, appliedDate: '2026-01-01', postAccept: { bunkmate: [b], separate: [] } };
    }
    requests.friends.push([a, b]);
  }
  function addAvoid(a, b) {
    roster[a].separateFrom = roster[a].separateFrom ? roster[a].separateFrom + ', ' + b : b;
    requests.avoid.push([a, b]);
  }

  byCohort.forEach(function (co) {
    const pool = co.members.slice();
    // shuffle deterministically so pairs aren't always neighbours in the roster
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    let k = 0;
    for (let m = 0; m < o.mutualPerCohort && k + 1 < pool.length; m++, k += 2) {
      addFriend(pool[k], pool[k + 1]);
      addFriend(pool[k + 1], pool[k]);
    }
    for (let w = 0; w < o.onewayPerCohort && k + 1 < pool.length; w++, k += 2) {
      addFriend(pool[k], pool[k + 1]);
    }
    for (let v = 0; v < o.avoidPerCohort && k + 1 < pool.length; v++, k += 2) {
      addAvoid(pool[k], pool[k + 1]);
    }
  });

  return { roster, structure, enrollments, requests, cohorts: byCohort };
}

// The camp the headline numbers are measured on: 108 campers, 2 divisions,
// 4 bunk groups (one group name deliberately reused across both divisions),
// 14 bunks, school-grade mapping on every group.
function standardCamp(seed) {
  return makeCamp({
    seed: seed == null ? 7 : seed,
    cohorts: [
      { div: 'Boys', group: 'Junior A', bunks: 4, campers: 36, schoolGrades: ['3rd Grade', '4th Grade'] },
      { div: 'Boys', group: 'Senior A', bunks: 4, campers: 24, schoolGrades: ['7th Grade', '8th Grade'] },
      { div: 'Girls', group: 'Junior A', bunks: 3, campers: 27, schoolGrades: ['3rd Grade Girls', '4th Grade Girls'] },
      { div: 'Girls', group: 'Senior A', bunks: 3, campers: 21, schoolGrades: ['7th Grade Girls', '8th Grade Girls'] }
    ],
    mutualPerCohort: 4,
    onewayPerCohort: 3,
    avoidPerCohort: 2
  });
}

// One camp of the randomised sweep: shape and request load both vary.
function randomCamp(seed) {
  const rnd = mulberry32(seed * 2654435761);
  const divs = ['Boys', 'Girls'];
  const groups = ['Junior A', 'Junior B', 'Senior A'];
  const cohorts = [];
  const nDiv = 1 + Math.floor(rnd() * 2);
  const nGroup = 1 + Math.floor(rnd() * 3);
  for (let d = 0; d < nDiv; d++) {
    for (let g = 0; g < nGroup; g++) {
      const campers = 8 + Math.floor(rnd() * 40);
      // Beds are sized to the roster, plus 0-1 spare bunks. A real camp does
      // not enroll more kids than it has beds, and a sweep over impossible
      // camps measures the over-subscription path (which test 34 already
      // covers) rather than the QUALITY of the bunks, which is the point here.
      const bunks = Math.ceil(campers / 10) + Math.floor(rnd() * 2);
      cohorts.push({
        div: divs[d], group: groups[g], bunks: Math.max(2, bunks), campers: campers,
        schoolGrades: rnd() < 0.6 ? [divs[d] + ' ' + groups[g] + ' SG'] : []
      });
    }
  }
  return makeCamp({
    seed: seed,
    cohorts: cohorts,
    mutualPerCohort: Math.floor(rnd() * 5),
    onewayPerCohort: Math.floor(rnd() * 4),
    avoidPerCohort: Math.floor(rnd() * 3)
  });
}

module.exports = { makeCamp, standardCamp, randomCamp, mulberry32, SCHOOLS, CITIES };
