// Probe (10th pass): with row security ON (SET ROLE authenticated, a real
// signed-in role, not the superuser the pgtests run as), what can a signed-in
// STRANGER, a PARENT of the camp, and a camp SCHEDULER (staff, no billing
// section) read or change of camp A's billing? Owner as control.
// Run: node ted/probes/2026-09-24-billing-10/stranger_reads.js
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5563 });
const CAMP = 'a2770000-0000-0000-0000-000000000001';
const U = { owner: 'a2770000-0000-0000-0000-0000000000a1', stranger: 'a2770000-0000-0000-0000-0000000000b1',
            parent: 'a2770000-0000-0000-0000-0000000000c1', scheduler: 'a2770000-0000-0000-0000-0000000000d1' };
const as = (who) => `SET ROLE authenticated; SELECT set_config('request.jwt.claims','{"sub":"${U[who]}","role":"authenticated"}',false);`;
const one = (who, q) => {
  try { return db.sql(as(who) + q + '; RESET ROLE;').trim().split('\n').pop(); }
  catch (e) { try { db.sql('RESET ROLE;'); } catch (_) {} return 'ERROR: ' + (String(e.message).match(/ERROR:\s*([^\n]*)/) || [, String(e.message).slice(0, 160)])[1]; }
};
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${U.owner}','o@t'),('${U.stranger}','s@t'),('${U.parent}','p@t'),('${U.scheduler}','sch@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${U.owner}', 'Camp A');
    INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES ('${CAMP}', '${U.scheduler}', 'scheduler', now());
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', 'campistryMe', jsonb_build_object(
      'families', jsonb_build_object('gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
          'entries', jsonb_build_array(jsonb_build_object('id','c1','kind','charge','amount',3000,'date','2026-06-01')),
          'plans', jsonb_build_array(jsonb_build_object('id','plan_a','dueDates',jsonb_build_array('2026-06-01'),'autopay',true,
              'pendingCharge', jsonb_build_object('unconfirmed',true,'processor','cardknox','amount',500,'dueDate','2026-06-01','index',0,'planId','plan_a','since','2026-06-01'))))),
      'finance', jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('id','pay_1','familyKey','gold','amount',500,'date','2026-06-01')))));
    INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status)
      VALUES ('${CAMP}', '${U.parent}', 'p@t', '["Avi Gold"]', 'active');
    SELECT set_config('request.jwt.claims','{"sub":"${U.owner}"}',false);
    SELECT public.sync_camp_billing('${CAMP}', (SELECT value->'families' FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistryMe'), '[]'::jsonb,
                                    (SELECT value->'finance'->'payments' FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistryMe'), '[]'::jsonb);
    INSERT INTO canteen_refund_holds (camp_id, hold_key, account_key, amount, method, payment_ref) VALUES ('${CAMP}','canteen:x:1','Avi Gold',20,'cardknox','X1');
    INSERT INTO refund_intents (camp_id, key, amount, payment_ref) VALUES ('${CAMP}','charge:chg_1',500,'tok');`);
  const checks = [
    ['camp_families rows', `SELECT count(*) FROM camp_families WHERE camp_id='${CAMP}'`],
    ['camp_payments rows', `SELECT count(*) FROM camp_payments WHERE camp_id='${CAMP}'`],
    ['canteen_refund_holds rows', `SELECT count(*) FROM canteen_refund_holds WHERE camp_id='${CAMP}'`],
    ['refund_intents rows', `SELECT count(*) FROM refund_intents WHERE camp_id='${CAMP}'`],
    ['projected_family_ledger', `SELECT public.projected_family_ledger('${CAMP}','gold')::text`],
    ['projected_family_payments', `SELECT public.projected_family_payments('${CAMP}','gold')::text`],
    ['get_camp_families', `SELECT left(public.get_camp_families('${CAMP}')::text, 90)`],
    ['get_camp_payments', `SELECT left(public.get_camp_payments('${CAMP}')::text, 90)`],
    ['resolve_unconfirmed_autopay (went through)', `SELECT public.resolve_unconfirmed_autopay('${CAMP}','gold','plan_a',true,'REF999')::text`],
    ['release_canteen_refund_hold', `SELECT public.release_canteen_refund_hold('${CAMP}','canteen:x:1',NULL)::text`],
    ['reserve_canteen_refund', `SELECT public.reserve_canteen_refund('${CAMP}','Avi Gold','k2',5,'cardknox','X1')::text`],
    ['release_stale_refund_intent', `SELECT public.release_stale_refund_intent('${CAMP}','charge:chg_1')::text`],
    ['append_camp_payment', `SELECT public.append_camp_payment('${CAMP}','{"id":"evil","familyKey":"gold","amount":9999}'::jsonb,NULL,NULL)::text`],
    ['canteen_refund_view', `SELECT left(public.canteen_refund_view('${CAMP}')::text, 80)`],
  ];
  for (const who of ['stranger', 'parent', 'scheduler', 'owner']) {
    console.log('=== as ' + who);
    for (const [label, q] of checks) console.log('  ' + label.padEnd(44) + ' → ' + one(who, q).slice(0, 150));
  }
  console.log('=== after all of that (superuser): hold state', db.sql(`SELECT state FROM canteen_refund_holds WHERE camp_id='${CAMP}' AND hold_key='canteen:x:1'`).trim(),
              '| plan pendingCharge', db.sql(`SELECT (payload->'plans'->0->'pendingCharge') IS NOT NULL FROM camp_families WHERE camp_id='${CAMP}' AND family_key='gold'`).trim(),
              '| payments', db.sql(`SELECT string_agg(payment_id, ',' ORDER BY payment_id) FROM camp_payments WHERE camp_id='${CAMP}' AND deleted_at IS NULL`).trim());
} catch (e) { console.log('ERROR', String(e.message).slice(0, 900)); }
finally { db.stop && db.stop(); }
