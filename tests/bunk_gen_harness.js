// bunk_gen_harness.js — runs the REAL Bunk Builder auto-generator in Node.
//
// campistry_me.js is a ~1MB browser file with no module boundary, so it can't
// be required. Instead this slices out the generator block (everything from
// _splitNames through autoGenerateBunks) and evaluates it against injected
// globals. That means the tests drive the shipping algorithm — if someone
// changes the placement rules, these tests move with them rather than
// silently testing a stale copy.
//
// The slice deliberately stops before the report RENDERER (_bgNote /
// _showBunkGenReport), which is the only DOM-touching part; the harness
// supplies its own _showBunkGenReport that just captures the report object.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// BUNK_GEN_SRC lets a vacuity check point the same suite at an older copy of
// campistry_me.js and prove these tests actually fail without the fixes.
const SRC_PATH = process.env.BUNK_GEN_SRC || path.join(__dirname, '..', 'campistry_me.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8').split('\r\n').join('\n');

const START = 'function _splitNames(s){';
const END_MARKERS = ['function _bgNote(', 'function _showBunkGenReport('];

function extractBlock() {
  const s = SRC.indexOf(START);
  if (s === -1) throw new Error('generator block start not found (marker: ' + START + ')');
  let e = -1;
  for (const m of END_MARKERS) { e = SRC.indexOf(m, s); if (e !== -1) break; }
  if (e === -1) throw new Error('generator block end not found (markers: ' + END_MARKERS.join(', ') + ')');
  return SRC.slice(s, e);
}

const BLOCK = extractBlock();

// The camp-wide defaults the Bunk Settings modal ships with.
const DEFAULT_CONFIG = {
  minBunkSize: 6,
  maxBunkSize: 12,
  requestsEnabled: true,
  maxRequests: 3,
  honoredRequests: 2,
  doNotBunkEnabled: true,
  maxDoNotBunk: 3,
  criteria: [
    { key: 'school', label: 'School', enabled: true },
    { key: 'area', label: 'Area / City', enabled: true },
    { key: 'age', label: 'Age', enabled: true }
  ],
  schoolGrades: []
};

// campistry_me.js's own age() — copied rather than sliced because it lives far
// outside the generator block. Asserted identical by bunk_generator.test.js.
function age(dob) {
  if (!dob) return '';
  const a = Math.floor((Date.now() - new Date(dob).getTime()) / 31557600000);
  return a >= 0 && a < 25 ? a : '';
}

/**
 * Run ⚡ Auto-Generate over an in-memory camp.
 *
 * @param {object}  camp
 * @param {object}  camp.roster       {camperName: {...}} — MUTATED in place, same as the app
 * @param {object}  camp.structure    {div: {color, grades: {group: {bunks:[], schoolGrades:[]}}}}
 * @param {object} [camp.enrollments] {id: {camperName, bunkmate, separateFrom, postAccept}}
 * @param {object} [camp.config]      bunkGenConfig overrides (merged onto DEFAULT_CONFIG)
 * @param {object} [camp.capacity]    bunkCapacity — {bunkName: number}
 * @returns {{roster, report, toasts, saves, structure, capacity, config, api}}
 */
function runGenerator(camp) {
  const roster = camp.roster;
  const structure = camp.structure;
  const enrollments = camp.enrollments || {};
  const bunkGenConfig = Object.assign({}, DEFAULT_CONFIG, camp.config || {});
  if (camp.config && camp.config.criteria) bunkGenConfig.criteria = camp.config.criteria;
  const bunkCapacity = Object.assign({}, camp.capacity || {});

  const captured = { report: null, toasts: [], saves: 0, renders: 0 };

  const sandbox = {
    roster, structure, enrollments, bunkGenConfig, bunkCapacity, age,
    save() { captured.saves++; },
    renderBB() { captured.renders++; },
    toast(msg, kind) { captured.toasts.push({ msg, kind: kind || 'info' }); },
    esc(s) { return String(s == null ? '' : s); },
    // The report is built inside the VM realm, so its arrays fail
    // deepStrictEqual against host-realm ones. It is pure data — round-trip it.
    _showBunkGenReport(report) { captured.report = JSON.parse(JSON.stringify(report)); },
    console, Object, Array, String, Number, Math, JSON, Boolean, isNaN, parseInt, parseFloat, Date
  };
  sandbox.globalThis = sandbox;

  // Everything the block defines has to come back out so tests can poke at
  // individual helpers (_bunkTargets, _splitOversizeCluster, …) as well as
  // the whole run.
  const EXPORTS = [
    '_splitNames', '_enrollmentForCamper', '_camperBunkRequests', '_syncPostAcceptBunkRequests',
    '_resolveCamperName', '_criterionMatch', '_splitAvoidConflicts', '_splitOversizeCluster',
    '_effBunkMax', '_bunkTargets', '_critValue', '_critSignature', '_avoidBetween',
    '_mergeByCriteria', '_rebalanceCohort', '_placeGroupInBunk', '_cohortSchoolGrades',
    '_resolveCohortBySchoolGrade', '_bunkGenForGrade', '_bunkGenFallback', 'autoGenerateBunks'
  ];
  // try/catch per name so the same harness can also load an OLDER copy of
  // campistry_me.js (the vacuity check) that lacks some of these helpers.
  const code = BLOCK + '\n;__api__ = {};\n'
    + EXPORTS.map((n) => 'try{__api__.' + n + '=' + n + '}catch(e){}').join('\n') + '\n';

  vm.createContext(sandbox);
  vm.runInContext('var __api__;\n' + code, sandbox, { filename: 'campistry_me.js:generator-block' });
  sandbox.__api__.autoGenerateBunks();

  return {
    roster, structure, config: bunkGenConfig, capacity: bunkCapacity,
    report: captured.report, toasts: captured.toasts,
    saves: captured.saves, renders: captured.renders,
    api: sandbox.__api__
  };
}

module.exports = { runGenerator, DEFAULT_CONFIG, BLOCK, SRC, age };
