// Probe (15th pass, claim 10): scripts/verify_identity_chain.sql's new 280 and
// 281 rows, on a scratch Postgres with the full chain, in the states an owner
// could really be in: all pasted; 280 not pasted; 281 not pasted; 281 pasted but
// a browser can call the webhook's functions; and 275's earlier copy (TED-151).
// Run: node ted/probes/2026-09-24-billing-15/check_script_280_281.js
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5689 });
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const rows = (change) => {
  // one session: the change, the check, then ROLLBACK (a separate psql call would lose the change)
  const out = db.sql(`BEGIN; ${change || ''} SELECT item || ' → ' || result FROM (${verify}) v WHERE item ~ '^(275|280|281)'; ROLLBACK;`).trim();
  return out.split('\n').filter(l => /→/.test(l)).map(s => '      ' + s).join('\n');
};
try {
  console.log('A. everything pasted:\n' + rows(''));
  console.log('B. 280 not pasted:\n' + rows('DROP FUNCTION public.canteen_season_closeout(uuid,bigint,text,numeric,text);'));
  console.log('C. 281 not pasted:\n' + rows('DROP FUNCTION public.undo_card_fee_return(uuid,text,text); DROP FUNCTION public.release_refund_failure_alert(text);'));
  console.log('D. 281 pasted, but a signed-in browser can call undo_card_fee_return:\n' + rows('GRANT EXECUTE ON FUNCTION public.undo_card_fee_return(uuid,text,text) TO authenticated;'));
  console.log('E. 280 pasted, but anyone (not signed in) can call the close-out:\n' + rows('GRANT EXECUTE ON FUNCTION public.canteen_season_closeout(uuid,bigint,text,numeric,text) TO anon;'));
} catch (e) { console.log('ERROR', String(e.message).slice(0, 800)); }
finally { db.stop(); }
