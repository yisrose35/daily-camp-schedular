// What the parent sees after paying through Link's Stripe Pay Now: the webhook
// records the payment with the metadata it was given (familyKey '' -> null).
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5463 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a3', PARENT = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b3';
const AS = u => `SELECT set_config('request.jwt.claims','{"sub":"${u}"}',false);`;
const q = s => db.sql(s).trim().split('\n').pop();
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${PARENT}','p@t'),('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', 'Avi Gold', 'Avi Gold');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', '${JSON.stringify({
      sessions: [{ name: 'Full', tuition: 1000 }],
      enrollments: { e1: { camperName: 'Avi Gold', camperId: 1, session: 'Full', status: 'enrolled' } },
      families: { gold: { name: 'Gold', camperIds: ['Avi Gold'],
        entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', source: { enrollmentId: 'e1' } }] } } })}'::jsonb);
    INSERT INTO link_parent_invites (camp_id, user_id, parent_name, camper_names, status) VALUES ('${CAMP}','${PARENT}','Mrs Gold','["Avi Gold"]','active');`);
  console.log('parent balance before:', q(AS(PARENT) + `SELECT (get_my_balance('${CAMP}')->>'balance') || ' ledger=' || (get_my_balance('${CAMP}')->>'ledger');`));
  // exactly what stripe-webhook upsertPayment sends for this PaymentIntent (index.ts:190-212)
  console.log('webhook record:', q(`SELECT append_camp_payment('${CAMP}', '{"id":"pi_pi_1","family":"Gold","familyKey":null,"enrollmentId":null,"amount":500,"date":"2026-09-24","method":"Card","reference":"pi_1","stripePaymentIntentId":"pi_1","status":"succeeded"}'::jsonb, 'pi_1', '{"status":"succeeded","amount":500,"method":"Card"}'::jsonb)::text;`));
  console.log('parent balance after paying $500:', q(AS(PARENT) + `SELECT (get_my_balance('${CAMP}')->>'balance') || ' ledger=' || (get_my_balance('${CAMP}')->>'ledger');`));
  console.log('ledger balance:', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`));
} finally { db.stop && db.stop(); }
