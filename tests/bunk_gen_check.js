// bunk_gen_check.js — scores a generated camp.
//
// Everything here is measured against the FIXTURE's ground truth (exact camper
// names recorded when the requests were created), never by re-running the
// generator's own name resolver — otherwise a resolver bug would hide itself.

function bunkIndex(structure) {
  const idx = {};
  Object.keys(structure).forEach(function (div) {
    const grades = (structure[div] && structure[div].grades) || {};
    Object.keys(grades).forEach(function (gr) {
      (grades[gr].bunks || []).forEach(function (b) {
        idx[b] = { div: div, gr: gr, schoolGrades: grades[gr].schoolGrades || [] };
      });
    });
  });
  return idx;
}

function gini(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort(function (a, b) { return a - b; });
  const n = s.length;
  const sum = s.reduce(function (a, b) { return a + b; }, 0);
  if (!sum) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * s[i];
  return cum / (n * sum);
}

/**
 * @param {object} camp     the fixture ({roster, structure, requests}) AFTER a run
 * @param {object} cfg      the bunkGenConfig that was used
 * @param {object} capacity the bunkCapacity that was used
 */
function analyze(camp, cfg, capacity) {
  const roster = camp.roster;
  const structure = camp.structure;
  const caps = capacity || {};
  const idx = bunkIndex(structure);
  const allBunks = Object.keys(idx);
  const minSize = Math.max(0, parseInt(cfg.minBunkSize, 10) || 0);
  const globalMax = Math.max(1, parseInt(cfg.maxBunkSize, 10) || 1);
  const effMax = function (b) {
    const c = parseInt(caps[b], 10);
    return (!isNaN(c) && c > 0) ? c : globalMax;
  };

  const sizes = {};
  allBunks.forEach(function (b) { sizes[b] = 0; });
  const unplaced = [];
  const wrongGrade = [];
  const staleDivGrade = [];
  const ghostBunk = [];

  Object.keys(roster).forEach(function (n) {
    const c = roster[n];
    if (c.unenrolled) return;
    if (!c.bunk) { unplaced.push(n); return; }
    const loc = idx[c.bunk];
    if (!loc) { ghostBunk.push(n); return; }
    sizes[c.bunk]++;
    if (c.division !== loc.div || c.grade !== loc.gr) staleDivGrade.push(n);
    if (loc.schoolGrades.length) {
      const sg = String(c.schoolGrade || '').trim().toLowerCase();
      const ok = loc.schoolGrades.some(function (x) { return String(x).trim().toLowerCase() === sg; });
      if (!ok) wrongGrade.push(n);
    }
  });

  const overCapacity = allBunks.filter(function (b) { return sizes[b] > effMax(b); })
    .map(function (b) { return { bunk: b, size: sizes[b], cap: effMax(b) }; });
  const underMin = allBunks.filter(function (b) {
    return sizes[b] > 0 && sizes[b] < Math.min(minSize, effMax(b));
  }).map(function (b) { return { bunk: b, size: sizes[b], min: Math.min(minSize, effMax(b)) }; });
  const nonEmpty = allBunks.filter(function (b) { return sizes[b] > 0; });
  const emptyBunks = allBunks.filter(function (b) { return sizes[b] === 0; });

  // requests, against the fixture's ground truth
  const req = camp.requests || { friends: [], avoid: [] };
  let friendHonored = 0;
  const friendMissed = [];
  req.friends.forEach(function (p) {
    const a = roster[p[0]], b = roster[p[1]];
    if (a && b && a.bunk && a.bunk === b.bunk) friendHonored++;
    else friendMissed.push(p);
  });
  const avoidViolations = req.avoid.filter(function (p) {
    const a = roster[p[0]], b = roster[p[1]];
    return a && b && a.bunk && a.bunk === b.bunk;
  });

  // same-school pair rate over every same-bunk pair
  const members = {};
  allBunks.forEach(function (b) { members[b] = []; });
  Object.keys(roster).forEach(function (n) {
    if (roster[n].bunk && members[roster[n].bunk]) members[roster[n].bunk].push(n);
  });
  let pairs = 0, sameSchool = 0, sameCity = 0;
  allBunks.forEach(function (b) {
    const m = members[b];
    for (let i = 0; i < m.length; i++) {
      for (let j = i + 1; j < m.length; j++) {
        pairs++;
        const x = roster[m[i]], y = roster[m[j]];
        if (x.school && y.school && x.school === y.school) sameSchool++;
        if (x.city && y.city && x.city === y.city) sameCity++;
      }
    }
  });

  const sizeList = nonEmpty.map(function (b) { return sizes[b]; });
  return {
    sizes: sizes,
    nonEmpty: nonEmpty,
    emptyBunks: emptyBunks,
    largest: sizeList.length ? Math.max.apply(null, sizeList) : 0,
    smallest: sizeList.length ? Math.min.apply(null, sizeList) : 0,
    spread: sizeList.length ? Math.max.apply(null, sizeList) - Math.min.apply(null, sizeList) : 0,
    unplaced: unplaced,
    wrongGrade: wrongGrade,
    staleDivGrade: staleDivGrade,
    ghostBunk: ghostBunk,
    overCapacity: overCapacity,
    underMin: underMin,
    friendTotal: req.friends.length,
    friendHonored: friendHonored,
    friendMissed: friendMissed,
    friendRate: req.friends.length ? friendHonored / req.friends.length : 1,
    avoidTotal: req.avoid.length,
    avoidViolations: avoidViolations,
    pairs: pairs,
    sameSchoolPairs: sameSchool,
    sameSchoolRate: pairs ? sameSchool / pairs : 0,
    sameCityRate: pairs ? sameCity / pairs : 0,
    gini: gini(sizeList)
  };
}

/** True when nothing a camp can never accept has happened. */
function hardFailures(a) {
  const f = [];
  if (a.overCapacity.length) f.push('over capacity: ' + JSON.stringify(a.overCapacity));
  if (a.avoidViolations.length) f.push('do-not-bunk violated: ' + JSON.stringify(a.avoidViolations));
  if (a.wrongGrade.length) f.push('wrong school grade: ' + a.wrongGrade.join(', '));
  if (a.staleDivGrade.length) f.push('stale division/grade on: ' + a.staleDivGrade.join(', '));
  if (a.ghostBunk.length) f.push('placed in a non-existent bunk: ' + a.ghostBunk.join(', '));
  return f;
}

module.exports = { analyze, hardFailures, gini, bunkIndex };
