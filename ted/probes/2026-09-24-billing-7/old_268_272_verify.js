// Probe (7th pass, TED-104 re-check): the builder added "this round's copy"
// checks to rows 268 and 272 as well. An owner who pasted an EARLIER copy of
// 268 (4a59637) or 272 (4a08579) — does the check script now say to paste it
// again? And after re-pasting today's copies, does every 255-273 row say ok?
// Old copies come straight from git (git show <commit>:<file>), nothing checked out.
// Run: node ted/probes/2026-09-24-billing-7/old_268_272_verify.js
const R = '/home/user/daily-camp-schedular', fs = require('fs'), cp = require('child_process');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5532 });
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const rows = (re) => db.sql(`SELECT item || ' => ' || result FROM (${verify}) v WHERE item ~ '${re}'`).trim();
const old = (c, f) => cp.execSync(`git -C ${R} show ${c}:migrations/${f}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
const tryApply = (label, sql) => { try { db.sql(sql); console.log(label + ': applied'); } catch (e) { console.log(label + ': FAILED — ' + String(e.message || e).split('\n').slice(0, 3).join(' ')); } };
try {
  console.log('fresh chain (today\'s copies):\n' + rows('^2(5[5-9]|6[0-9]|7[0-3])'));
  tryApply('\nold 268 (4a59637) pasted over it', old('4a59637', '268_a_cut_off_charge_can_be_tried_again.sql'));
  tryApply('old 272 (4a08579) pasted over it', old('4a08579', '272_an_old_tab_keeps_the_shops_charges.sql'));
  console.log(rows('^26[89]|^27[0-3]'));
  tryApply('\ntoday\'s 268 re-pasted', fs.readFileSync(R + '/migrations/268_a_cut_off_charge_can_be_tried_again.sql', 'utf8'));
  tryApply('today\'s 272 re-pasted', fs.readFileSync(R + '/migrations/272_an_old_tab_keeps_the_shops_charges.sql', 'utf8'));
  console.log(rows('^26[89]|^27[0-3]'));
} finally { db.stop && db.stop(); }
