// Probe (13th pass): can a browser (anon / authenticated) call the functions
// 278 added or changed? Real migration chain on a scratch Postgres.
// Run: node ted/probes/2026-09-24-billing-13/access_new_fn.js
'use strict';
const db = require('/home/user/daily-camp-schedular/tests/e2e/db.js').boot({ port: 5653 });
try {
  for (const fn of ['public._notice_unbooked_refund_failure(uuid,text,text,numeric,text)', 'public.reverse_failed_stripe_refund(uuid,text,text,numeric,text)']) {
    const r = db.sql(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AS anon, has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS authed, has_function_privilege('service_role', '${fn}', 'EXECUTE') AS service`).trim();
    console.log(fn + ' → anon|authenticated|service_role: ' + r);
  }
  console.log('old 3-argument reverse_failed_stripe_refund still there: ' + db.sql(`SELECT to_regprocedure('public.reverse_failed_stripe_refund(uuid,text,text)') IS NOT NULL`).trim());
  console.log('overloads of reverse_failed_stripe_refund: ' + db.sql(`SELECT string_agg(oid::regprocedure::text, ' ; ') FROM pg_proc WHERE proname = 'reverse_failed_stripe_refund'`).trim());
} finally { db.stop(); }
