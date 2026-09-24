// Probe (13th pass): the owner pasted the EARLIER 278 (f3ee2ed) and now pastes
// today's 278 — twice. Real chain on a scratch Postgres; the check script's
// 278 row read after each step.
// Run: node ted/probes/2026-09-24-billing-13/repaste_278.js
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5655 });
const OLD = R + '/ted/probes/2026-09-24-billing-13/old278_f3ee2ed.sql';   // git show f3ee2ed:migrations/278_…sql
const NEW = R + '/migrations/278_a_refund_that_fails_later_puts_the_money_back.sql';
const row = () => db.sql(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8')).split('\n').filter(l => /^ *278/.test(l) || /278  a refund/.test(l)).map(l => l.replace(/\s+/g, ' ').trim()).join(' / ');
const over = () => db.sql(`SELECT string_agg(oid::regprocedure::text, ' ; ') FROM pg_proc WHERE proname = 'reverse_failed_stripe_refund'`).trim();
try {
  db.sql(`DROP FUNCTION public.reverse_failed_stripe_refund(uuid,text,text,numeric,text); DROP FUNCTION public._notice_unbooked_refund_failure(uuid,text,text,numeric,text);`);
  db.file ? db.file(OLD) : db.sql(fs.readFileSync(OLD, 'utf8'));
  console.log('only the EARLIER 278: ' + over() + '\n    check script: ' + row());
  for (const n of [1, 2]) {
    db.file ? db.file(NEW) : db.sql(fs.readFileSync(NEW, 'utf8'));
    console.log(`today's 278 pasted (${n}): ` + over() + '\n    check script: ' + row());
  }
} catch (e) { console.log('ERROR ' + String(e.message).slice(0, 400)); }
finally { db.stop(); }
