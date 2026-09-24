// Probe (14th pass): 275 was edited in place (TED-142: a refund may now take the
// whole balance, floor and all). If the owner had pasted the EARLIER 275 (fef6edb),
// does the check script notice? Real chain on a scratch Postgres.
// Run: node ted/probes/2026-09-24-billing-14/check_script_275.js
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5665 });
const row = () => db.sql(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8')).split('\n').filter(l => /275  a canteen/.test(l)).map(l => l.replace(/\s+/g, ' ').trim().split('|').slice(-1)[0]).join(' / ');
const C = '51000000-0000-0000-0000-0000000000c5';
const refund50 = (k) => db.sql(`SELECT public.reserve_canteen_refund('${C}', 'Avi', '${k}', 50, 'stripe', 'pi_A')::text`).trim();
const apply = (f) => (db.file ? db.file(f) : db.sql(fs.readFileSync(f, 'utf8')));
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('51000000-0000-0000-0000-000000000005', 'o5@p.test');
          INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '51000000-0000-0000-0000-000000000005', 'P', 'stripe');
          SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 50, "balanceFloor": 10}'::jsonb);`);
  console.log(`today's 275: reserve $50 of a $50 wallet with a $10 floor → ${refund50('k1')}\n    check script: ${row()}`);
  db.sql(`SELECT public.release_canteen_refund_hold('${C}', 'k1');`);
  apply(R + '/ted/probes/2026-09-24-billing-14/old275_fef6edb.sql');
  console.log(`the EARLIER 275 (fef6edb) pasted: reserve $50 → ${refund50('k2')}\n    check script: ${row()}`);
} catch (e) { console.log('ERROR ' + String(e.message).slice(0, 600)); }
finally { db.stop(); }
