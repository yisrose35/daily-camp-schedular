// Re-run safety of 265-270 (each claims "safe to run more than once") and whether
// the checking script notices when a re-run of an older file undoes a newer one.
const R = '/home/user/daily-camp-schedular', fs = require('fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5496 });
const file = f => fs.readFileSync(R + '/migrations/' + f, 'utf8');
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const rows = () => db.sql(`SELECT item || ' => ' || result FROM (${verify}) v WHERE item ~ '^2(6[2-9]|70)'`).trim();
const M = fs.readdirSync(R + '/migrations').filter(f => /^(26[5-9]|270)_/.test(f)).sort();
try {
  console.log('files:', M.join(', '));
  console.log('fresh chain:\n' + rows());
  for (let k = 0; k < 2; k++) M.forEach(m => db.sql(file(m)));
  console.log('\nafter re-running 265-270 twice each, in order:\n' + rows());
  db.sql(file(M.find(m => m.startsWith('266'))));
  console.log('\nafter re-running ONLY 266 once more:\n' + rows());
  const d = db.sql(`SELECT pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure) ~ '_merge_plan_state' AS has269, pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure) ~ '_keep_charge_links' AS has267;`).trim();
  console.log('  _merge_family_from_page still has 269 / 267 parts:', d.split('\n').pop());
  M.filter(m => m >= '267').forEach(m => db.sql(file(m)));
  console.log('\nafter re-applying 267-270:\n' + rows());
  // APPLY_BUNDLE.sql guard on a 262+ database
  let out;
  try { out = db.sql(file('APPLY_BUNDLE.sql').split('\n').slice(0, 400).join('\n')); } catch (e) { out = 'ERROR: ' + String(e.message || e).split('\n').filter(l => /ERROR|bundle|262/i.test(l)).slice(0, 3).join(' | '); }
  console.log('\nAPPLY_BUNDLE.sql (first 400 lines) on this database:', String(out).slice(0, 400));
} finally { db.stop && db.stop(); }
