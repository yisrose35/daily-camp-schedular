// Probe (14th pass): (1) who can call what 278 now adds or changes, and read the
// new table; (2) the owner pastes today's 278 over the EARLIER ones
// (f3ee2ed's 3-argument version, and fef6edb's 5-argument version, which the
// builder says today's 278 drops) — twice. Real chain on a scratch Postgres;
// the check script's 278 row read after each step.
// Run: node ted/probes/2026-09-24-billing-14/access_repaste_278.js
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5663 });
const NEW = R + '/migrations/278_a_refund_that_fails_later_puts_the_money_back.sql';
const OLDS = { 'f3ee2ed (3-argument)': R + '/ted/probes/2026-09-24-billing-13/old278_f3ee2ed.sql',
               'fef6edb (5-argument)': R + '/ted/probes/2026-09-24-billing-14/old278_fef6edb.sql' };
const row = () => db.sql(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8')).split('\n').filter(l => /278  a refund/.test(l)).map(l => l.replace(/\s+/g, ' ').trim().split('|').slice(-1)[0]).join(' / ');
const over = (name) => db.sql(`SELECT coalesce(string_agg(oid::regprocedure::text, ' ; '), '(none)') FROM pg_proc WHERE proname = '${name}'`).trim();
const apply = (f) => (db.file ? db.file(f) : db.sql(fs.readFileSync(f, 'utf8')));
try {
  console.log('1. WHO CAN CALL / READ (anon | authenticated | service_role)');
  for (const fn of ['public._notice_unbooked_refund_failure(uuid,text,text,numeric,text,text)',
                    'public.reverse_failed_stripe_refund(uuid,text,text,numeric,text,text)',
                    'public.claim_refund_failure_alert(text)']) {
    const r = db.sql(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') || '|' || has_function_privilege('authenticated', '${fn}', 'EXECUTE') || '|' || has_function_privilege('service_role', '${fn}', 'EXECUTE')`).trim();
    console.log(`   ${fn}: ${r}`);
  }
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    console.log(`   table refund_failure_alerts ${p}: ` + db.sql(`SELECT has_table_privilege('anon', 'public.refund_failure_alerts', '${p}') || '|' || has_table_privilege('authenticated', 'public.refund_failure_alerts', '${p}')`).trim() + ' (anon|authenticated)');
  }
  console.log('   row level security on refund_failure_alerts: ' + db.sql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.refund_failure_alerts'::regclass`).trim());
  console.log(`   overloads now: ${over('reverse_failed_stripe_refund')} || ${over('_notice_unbooked_refund_failure')}`);
  console.log('   check script: ' + row());

  console.log('\n2. RE-PASTING');
  for (const [label, file] of Object.entries(OLDS)) {
    db.sql(`DROP FUNCTION IF EXISTS public.reverse_failed_stripe_refund(uuid,text,text,numeric,text,text);
            DROP FUNCTION IF EXISTS public._notice_unbooked_refund_failure(uuid,text,text,numeric,text,text);
            DROP FUNCTION IF EXISTS public.claim_refund_failure_alert(text); DROP TABLE IF EXISTS public.refund_failure_alerts;`);
    apply(file);
    console.log(`   only the EARLIER 278 from ${label}: ${over('reverse_failed_stripe_refund')} || ${over('_notice_unbooked_refund_failure')}\n       check script: ${row()}`);
    for (const n of [1, 2]) {
      apply(NEW);
      console.log(`   today's 278 pasted (${n}): ${over('reverse_failed_stripe_refund')} || ${over('_notice_unbooked_refund_failure')} || claim: ${over('claim_refund_failure_alert')}\n       check script: ${row()}`);
    }
  }
} catch (e) { console.log('ERROR ' + String(e.message).slice(0, 600)); }
finally { db.stop(); }
