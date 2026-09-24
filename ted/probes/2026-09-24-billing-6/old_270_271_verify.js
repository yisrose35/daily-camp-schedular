// NOTE: OLD points at a scratch git worktree of 25378b1 (removed after the run). To re-run: git worktree add <that path> 25378b1
// 6th pass: an owner who already pasted the 5th-pass copies of 270 and 271
// (from 25378b1) and now pastes only 273. Does the check script notice that
// 270 and 271 must be pasted again?
const R = '/home/user/daily-camp-schedular', fs = require('fs');
const OLD = '/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/old/migrations/';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5522 });
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const rows = () => db.sql(`SELECT item || ' => ' || result FROM (${verify}) v WHERE item ~ '^27[0-3]'`).trim();
try {
  // the test DB already has today's chain; put the old copies back on top, as that owner's DB would be
  ['270_money_notices_for_billing_only.sql', '271_parents_see_what_the_server_records.sql'].forEach(f => db.sql(fs.readFileSync(OLD + f, 'utf8')));
  console.log('old 270 + old 271 in place, new 273 applied:\n' + rows());
  console.log('is autopay_setup Billing-only?', db.sql("SELECT public.is_money_notice('autopay_setup')::text;").trim().split('\n').pop());
} finally { db.stop && db.stop(); }
