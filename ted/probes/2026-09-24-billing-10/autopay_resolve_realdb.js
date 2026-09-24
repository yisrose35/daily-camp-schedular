// Probe (10th pass, TED-113 / migration 276) on a scratch DB with the real chain.
// A family owes $1,000 on a two-instalment ledger plan. The nightly run's $500
// charge got no answer, so the plan holds it `unconfirmed` (hold_autopay_charge,
// exactly what the runner sends). Then:
//   S1  Stripe: the webhook books the PaymentIntent (append_camp_payment, the
//       webhook's own payload) and the office answers "went through" with the pi_ id.
//   S2  the same, but the office pastes the Stripe CHARGE id (ch_…), which the
//       Stripe dashboard shows on the same payment page.
//   S3  the office answers first, the webhook arrives after.
//   S4  Cardknox: no webhook booking (TED-071); the office answers with the ref.
//   S5  "did not go through": the hold goes, and what plan_due_for says next.
// For each: ledger payment entries, payment rows, balance.
// Run: node ted/probes/2026-09-24-billing-10/autopay_resolve_realdb.js
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5566 });
const OWNER = '0ed10000-0000-0000-0000-0000000000a1';
let n = 0;
const q = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
function setup(proc) {
  n++;
  const C = `0ed10000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const fam = { name: 'Gold', camperIds: ['Avi Gold'], cardOnFile: true, stripeCustomerId: 'cus_G',
    entries: [{ id: 'c_tuition', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }],
    plans: [{ id: 'plan_a', dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0, history: [], autopay: true, total: 1000 }] };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t') ON CONFLICT DO NOTHING;
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'T${n}', '${proc}');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(fam)})));
    SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
    SELECT public.sync_camp_billing('${C}', jsonb_build_object('gold', ${lit(fam)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  // exactly what the runner holds (charge-due-installments holdUnconfirmed)
  q(`SELECT public.hold_autopay_charge('${C}','gold','plan_a', ${lit({ unconfirmed: true, processor: proc, amount: 500, dueDate: '2026-06-01', index: 0, planIndex: null, planId: 'plan_a', since: '2026-06-01', why: 'connection reset' })})::text`);
  return C;
}
function webhookBooks(C, pi) {       // stripe-webhook upsertPayment, succeeded
  return q(`SELECT public.append_camp_payment('${C}', ${lit({ id: 'pi_' + pi, family: 'Avi Gold', familyKey: 'gold', enrollmentId: null, amount: 500, date: '2026-06-01', method: 'Credit Card (online)', reference: pi, notes: 'Online payment (Credit Card (online))', stripePaymentIntentId: pi, status: 'succeeded', timestamp: 1 })}, '${pi}', ${lit({ status: 'succeeded', amount: 500, method: 'Credit Card (online)' })})::text`);
}
const resolve = (C, went, ref) => q(`SELECT public.resolve_unconfirmed_autopay('${C}','gold','plan_a',${went},${ref ? `'${ref}'` : 'NULL'})::text`);
function report(C, label) {
  const fam = JSON.parse(q(`SELECT (public.camp_families_object('${C}')->'gold')::text`));
  const pays = (fam.entries || []).filter(e => e.kind === 'payment');
  const rows = q(`SELECT count(*) FROM camp_payments WHERE camp_id='${C}' AND deleted_at IS NULL`);
  const bal = q(`SELECT public.family_ledger_balance((public.camp_families_object('${C}')->'gold'))::text`);
  const due = q(`SELECT coalesce(public.plan_due_for('${C}','gold','plan_a','2026-07-02')::text,'null')`);
  console.log(`  ${label}: ledger payments ${pays.length} [${pays.map(e => e.id + ' $' + e.amount).join(', ')}] | payment rows ${rows} | balance owed ${bal} | hold ${fam.plans[0].pendingCharge ? 'STILL THERE' : 'cleared'} | history ${JSON.stringify((fam.plans[0].history || []).map(h => h.index + ':' + h.charged))} | next night due ${due}`);
}
try {
  console.log('S1 Stripe: webhook books pi_S1, office answers "went through" with pi_S1');
  let C = setup('stripe'); console.log('  webhook →', webhookBooks(C, 'pi_S1').slice(0, 120)); console.log('  office →', resolve(C, true, 'pi_S1')); report(C, 'after');
  console.log('S2 Stripe: webhook books pi_S2, office pastes the charge id ch_S2 from the same Stripe page');
  C = setup('stripe'); webhookBooks(C, 'pi_S2'); console.log('  office →', resolve(C, true, 'ch_S2')); report(C, 'after');
  console.log('S3 Stripe: office answers with pi_S3 first, the webhook arrives after');
  C = setup('stripe'); console.log('  office →', resolve(C, true, 'pi_S3')); console.log('  webhook →', webhookBooks(C, 'pi_S3').slice(0, 120)); report(C, 'after');
  console.log('S4 Cardknox: no webhook booking; office answers with the Sola ref 12345');
  C = setup('cardknox'); console.log('  office →', resolve(C, true, '12345')); report(C, 'after');
  console.log('  and answers again (a second tab / double click) →', resolve(C, true, '12345'));
  console.log('S5 Cardknox: office answers "did not go through"');
  C = setup('cardknox'); console.log('  office →', resolve(C, false, null)); report(C, 'after');
  console.log('S6 went through without a reference →', resolve(setup('cardknox'), true, null));
} catch (e) { console.log('ERROR', String(e.message).slice(0, 1200)); }
finally { db.stop && db.stop(); }
