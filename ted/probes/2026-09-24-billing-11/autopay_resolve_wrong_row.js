// Probe (11th pass, TED-120 re-check) on a scratch DB with the real chain
// (resolve_unconfirmed_autopay as edited in 276). One camp, two families on a
// $1,000 two-instalment autopay plan each. On the night, Silver's $500 went
// through and Stripe's webhook booked it (pi_SILVER). Gold's $500 answer was
// lost, so Gold's plan holds it `unconfirmed`. In Stripe's Payments list both
// rows read "$500.00 · Succeeded · Jun 1".
//   W1  Gold's charge DID go through (webhook booked pi_GOLD). The office opens
//       the wrong row and pastes Silver's id pi_SILVER for Gold.
//   W2  Gold's charge did NOT go through. The office pastes pi_SILVER for Gold.
//   W3  control: the office pastes pi_GOLD (the right one).
//   W4  a typo: pi_GOLDX (nowhere in Stripe); later the webhook books pi_GOLD.
// For each: both families' ledger payments and balances, and what autopay does next.
// Run: node ted/probes/2026-09-24-billing-11/autopay_resolve_wrong_row.js
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5611 });
const OWNER = '0ed11000-0000-0000-0000-0000000000a1';
let n = 0;
const q = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const fam = (name) => ({ name, camperIds: ['Avi ' + name], cardOnFile: true, stripeCustomerId: 'cus_' + name,
  entries: [{ id: 'c_tuition', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }],
  plans: [{ id: 'plan_' + name.toLowerCase(), dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0, history: [], autopay: true, total: 1000 }] });
function setup() {
  n++;
  const C = `0ed11000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const fams = { gold: fam('Gold'), silver: fam('Silver') };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t') ON CONFLICT DO NOTHING;
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'W${n}', 'stripe');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe', jsonb_build_object('families', ${lit(fams)}));
    SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
    SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  // Gold: exactly what the runner holds when the answer is lost
  q(`SELECT public.hold_autopay_charge('${C}','gold','plan_gold', ${lit({ unconfirmed: true, processor: 'stripe', amount: 500, dueDate: '2026-06-01', index: 0, planIndex: null, planId: 'plan_gold', since: '2026-06-01', why: 'connection reset' })})::text`);
  return C;
}
const webhookBooks = (C, famKey, famName, pi) => q(`SELECT public.append_camp_payment('${C}', ${lit({ id: 'pi_' + pi, family: 'Avi ' + famName, familyKey: famKey, enrollmentId: null, amount: 500, date: '2026-06-01', method: 'Credit Card (online)', reference: pi, notes: 'Online payment (Credit Card (online))', stripePaymentIntentId: pi, status: 'succeeded', timestamp: 1 })}, '${pi}', ${lit({ status: 'succeeded', amount: 500, method: 'Credit Card (online)' })})::text`);
const resolve = (C, ref) => q(`SELECT public.resolve_unconfirmed_autopay('${C}','gold','plan_gold',true,'${ref}')::text`);
function report(C, label) {
  for (const k of ['gold', 'silver']) {
    const f = JSON.parse(q(`SELECT (public.camp_families_object('${C}')->'${k}')::text`));
    const pays = (f.entries || []).filter(e => e.kind === 'payment');
    const bal = q(`SELECT public.family_ledger_balance((public.camp_families_object('${C}')->'${k}'))::text`);
    const due = q(`SELECT coalesce(public.plan_due_for('${C}','${k}','plan_${k}','2026-07-02')::text,'null')`);
    console.log(`  ${label} ${k.padEnd(6)}: ledger payments [${pays.map(e => e.id + ' $' + e.amount).join(', ')}] | balance owed ${bal} | hold ${(f.plans[0] || {}).pendingCharge ? 'STILL THERE' : 'none'} | next night due ${due}`);
  }
  console.log(`  ${label} payment rows: ${q(`SELECT string_agg(payment_id || '→' || coalesce(payload->>'familyKey','?') || ' $' || amount, ', ' ORDER BY payment_id) FROM camp_payments WHERE camp_id='${C}' AND deleted_at IS NULL`)}`);
}
try {
  console.log('W1 Gold went through (pi_GOLD booked); office pastes Silver\'s pi_SILVER for Gold');
  let C = setup(); webhookBooks(C, 'silver', 'Silver', 'pi_SILVER'); webhookBooks(C, 'gold', 'Gold', 'pi_GOLD');
  console.log('  office →', resolve(C, 'pi_SILVER')); report(C, 'after');
  console.log('W2 Gold did NOT go through; office pastes pi_SILVER for Gold');
  C = setup(); webhookBooks(C, 'silver', 'Silver', 'pi_SILVER');
  console.log('  office →', resolve(C, 'pi_SILVER')); report(C, 'after');
  console.log('W3 control: Gold went through, office pastes pi_GOLD');
  C = setup(); webhookBooks(C, 'silver', 'Silver', 'pi_SILVER'); webhookBooks(C, 'gold', 'Gold', 'pi_GOLD');
  console.log('  office →', resolve(C, 'pi_GOLD')); report(C, 'after');
  console.log('W4 a typo pi_GOLDX, Gold\'s webhook (pi_GOLD) arrives after');
  C = setup(); webhookBooks(C, 'silver', 'Silver', 'pi_SILVER');
  console.log('  office →', resolve(C, 'pi_GOLDX')); webhookBooks(C, 'gold', 'Gold', 'pi_GOLD'); report(C, 'after');
} catch (e) { console.log('ERROR', String(e.message).slice(0, 1200)); }
finally { db.stop && db.stop(); }
