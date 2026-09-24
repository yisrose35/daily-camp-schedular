// Probe (12th pass, TED-120 re-check). The REAL stripe-charge edge function's
// new action "confirmAutopay" against the REAL migration chain (276 hold, 279
// checked door, record_autopay_charge, the ledger) on a scratch Postgres, with
// a pretend Stripe that answers GET /payment_intents/{id} for several
// look-alike $500 payments. One camp, Gold and Silver each on a $1,000
// two-instalment autopay plan; Gold's June charge was never answered (held,
// since 2026-06-01).
// Each case: what the office is told, Gold's ledger payments and balance,
// whether the hold is cleared, and what autopay charges next.
// Run: node ted/probes/2026-09-24-billing-12/autopay_confirm_realdb.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5641 });
const OWNER = '0ed12a00-0000-0000-0000-0000000000a1';
let n = 0;
const q = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const BR = bridge(db, ['camp_families_object', 'resolve_unconfirmed_autopay_checked'], []);
const fam = (name) => ({ name, camperIds: ['Avi ' + name], cardOnFile: true, stripeCustomerId: 'cus_' + name,
  entries: [{ id: 'c_tuition', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }],
  plans: [{ id: 'plan_' + name.toLowerCase(), dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0, history: [], autopay: true, total: 1000 }] });
const t = (d) => Math.floor(Date.parse(d + 'T03:00:00Z') / 1000);
function setup() {
  n++;
  const C = `0ed12a00-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const fams = { gold: fam('Gold'), silver: fam('Silver') };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t') ON CONFLICT DO NOTHING;
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'A${n}', 'stripe');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe', jsonb_build_object('families', ${lit(fams)}));
    SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
    SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  q(`SELECT public.hold_autopay_charge('${C}','gold','plan_gold', ${lit({ unconfirmed: true, processor: 'stripe', amount: 500, dueDate: '2026-06-01', index: 0, planIndex: null, planId: 'plan_gold', since: '2026-06-01', why: 'connection reset' })})::text`);
  // Stripe's payments, all "$500.00 · Succeeded" on the list unless noted
  const PIS = {
    pi_SILVER: { customer: 'cus_Silver', amount: 50000, status: 'succeeded', created: t('2026-06-01'), metadata: { campId: C, familyKey: 'silver', planId: 'plan_silver', source: 'autopay' } },
    pi_GOLD: { customer: 'cus_Gold', amount: 50000, status: 'succeeded', created: t('2026-06-01'), metadata: { campId: C, familyKey: 'gold', planId: 'plan_gold', source: 'autopay' } },
    pi_GOLDFAIL: { customer: 'cus_Gold', amount: 50000, status: 'requires_payment_method', created: t('2026-06-01'), metadata: { campId: C, familyKey: 'gold', planId: 'plan_gold' } },
    pi_GOLDMAY: { customer: 'cus_Gold', amount: 50000, status: 'succeeded', created: t('2026-05-01'), metadata: { campId: C, familyKey: 'gold' } },
    pi_GOLDPLAN2: { customer: 'cus_Gold', amount: 50000, status: 'succeeded', created: t('2026-06-01'), metadata: { campId: C, familyKey: 'gold', planId: 'plan_other' } },
    pi_GOLD300: { customer: 'cus_Gold', amount: 30000, status: 'succeeded', created: t('2026-06-01'), metadata: { campId: C, familyKey: 'gold', planId: 'plan_gold' } },
    pi_OTHERCAMP: { customer: 'cus_Gold', amount: 50000, status: 'succeeded', created: t('2026-06-01'), metadata: { campId: 'another-camp', familyKey: 'gold' } },
    pi_GOLDLINK: { customer: 'cus_Gold', amount: 50000, status: 'succeeded', created: t('2026-06-02'), metadata: { campId: C, familyKey: 'gold', source: 'link_pay_now' } },
  };
  return { C, PIS };
}
const webhookBooks = (C, famKey, famName, pi) => q(`SELECT public.append_camp_payment('${C}', ${lit({ id: 'pi_' + pi, family: 'Avi ' + famName, familyKey: famKey, enrollmentId: null, amount: 500, date: '2026-06-01', method: 'Credit Card (online)', reference: pi, notes: 'Online payment (Credit Card (online))', stripePaymentIntentId: pi, status: 'succeeded', timestamp: 1 })}, '${pi}', ${lit({ status: 'succeeded', amount: 500, method: 'Credit Card (online)' })})::text`);
function confirm(k, piId, who, stripeDown) {
  const r = runEdges(['stripe-charge'], `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', mgr: 'u-mgr' };
T.tables.camps = [{ id: '${k.C}', owner: 'u-owner' }];
T.tables.camp_users = [{ camp_id: '${k.C}', user_id: 'u-mgr', role: 'manager', accepted_at: '2026-01-01' }];
${BR}
const PIS: any = ${JSON.stringify(k.PIS)};
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST') return { __status: 400, error: { message: 'no charges in this probe' } };
  ${stripeDown ? "return { __status: 500, error: { type: 'api_error', message: 'boom' } };" : ''}
  const id = decodeURIComponent(url.split('/payment_intents/')[1] || '');
  const p = PIS[id];
  return p ? Object.assign({ id, object: 'payment_intent', amount_received: p.amount }, p) : { __status: 404, error: { type: 'invalid_request_error', message: 'No such payment_intent: ' + id } };
};
T.requests = [{ headers: { Authorization: 'Bearer ${who || 'owner'}' }, body: { action: 'confirmAutopay', familyKey: 'gold', planRef: 'plan_gold', paymentIntentId: '${piId}' } }];`);
  const res = r.responses[0];
  return res.status + ' ' + JSON.stringify(res.body).slice(0, 170);
}
let bad = 0;
function report(k, label, want) {
  const f = JSON.parse(q(`SELECT (public.camp_families_object('${k.C}')->'gold')::text`));
  const pays = (f.entries || []).filter(e => e.kind === 'payment').map(e => e.id + ' $' + e.amount);
  const bal = Number(q(`SELECT public.family_ledger_balance((public.camp_families_object('${k.C}')->'gold'))::text`));
  const held = !!(f.plans[0] || {}).pendingCharge;
  const due = q(`SELECT coalesce(public.plan_due_for('${k.C}','gold','plan_gold','2026-07-02')::text,'null')`);
  const rows = q(`SELECT coalesce(string_agg(payment_id || '→' || coalesce(payload->>'familyKey','?') || ' $' || amount, ', ' ORDER BY payment_id), '') FROM camp_payments WHERE camp_id='${k.C}' AND deleted_at IS NULL`);
  const ok = want(bal, held, pays);
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}\n        gold: ledger payments [${pays.join(', ')}] | owes ${bal} | hold ${held ? 'KEPT' : 'cleared'} | next due ${due}\n        payment rows: ${rows}`);
}
const refused = (bal, held) => bal === 1000 && held;
try {
  let k;
  console.log('A1 Silver\'s pi_SILVER (booked for Silver) pasted for Gold'); k = setup(); webhookBooks(k.C, 'silver', 'Silver', 'pi_SILVER');
  console.log('   office →', confirm(k, 'pi_SILVER')); report(k, 'A1 refused', refused);
  console.log('A2 Silver\'s pi_SILVER, Silver\'s webhook not in yet'); k = setup();
  console.log('   office →', confirm(k, 'pi_SILVER')); report(k, 'A2 refused', refused);
  console.log('A3 a typo pi_GOLDX (Stripe has no such payment)'); k = setup();
  console.log('   office →', confirm(k, 'pi_GOLDX')); report(k, 'A3 refused', refused);
  console.log('A4 the right one pi_GOLD, its webhook already booked it'); k = setup(); webhookBooks(k.C, 'gold', 'Gold', 'pi_GOLD');
  console.log('   office →', confirm(k, 'pi_GOLD')); report(k, 'A4 recorded once (owes 500, hold cleared)', (b, h) => b === 500 && !h);
  console.log('A5 the right one pi_GOLD before its webhook; then the webhook books it'); k = setup();
  console.log('   office →', confirm(k, 'pi_GOLD')); webhookBooks(k.C, 'gold', 'Gold', 'pi_GOLD'); report(k, 'A5 recorded once (owes 500, hold cleared)', (b, h) => b === 500 && !h);
  console.log('A5b the office presses "it went through" again with pi_GOLD'); console.log('   office →', confirm(k, 'pi_GOLD')); report(k, 'A5b still once', (b, h) => b === 500 && !h);
  console.log('A6 Gold\'s charge that did NOT go through (requires_payment_method)'); k = setup();
  console.log('   office →', confirm(k, 'pi_GOLDFAIL')); report(k, 'A6 refused', refused);
  console.log('A7 Gold\'s May payment (same card, same $500, a month earlier)'); k = setup(); webhookBooks(k.C, 'gold', 'Gold', 'pi_GOLDMAY');
  console.log('   office →', confirm(k, 'pi_GOLDMAY')); report(k, 'A7 refused', (b, h) => b === 500 && h);
  console.log('A8 Gold\'s payment for ANOTHER plan'); k = setup();
  console.log('   office →', confirm(k, 'pi_GOLDPLAN2')); report(k, 'A8 refused', refused);
  console.log('A9 Gold\'s $300 payment'); k = setup();
  console.log('   office →', confirm(k, 'pi_GOLD300')); report(k, 'A9 refused', refused);
  console.log('A10 a payment stamped for another camp'); k = setup();
  console.log('   office →', confirm(k, 'pi_OTHERCAMP')); report(k, 'A10 refused', refused);
  console.log('A11 Stripe answers 500'); k = setup();
  console.log('   office →', confirm(k, 'pi_GOLD', 'owner', true)); report(k, 'A11 nothing recorded, hold kept', refused);
  console.log('A12 a camp manager (Billing edit) presses it'); k = setup();
  console.log('   office →', confirm(k, 'pi_GOLD', 'mgr')); report(k, 'A12 (manager) — not recorded', refused);
  console.log('A13 the parent paid $500 by Link Pay Now the next day (booked by webhook); the office records THAT as the autopay charge'); k = setup(); webhookBooks(k.C, 'gold', 'Gold', 'pi_GOLDLINK');
  console.log('   office →', confirm(k, 'pi_GOLDLINK')); report(k, 'A13 no money counted twice (owes 500)', (b) => b === 500);
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 1500)); bad++; }
finally { db.stop && db.stop(); }
console.log(`\n${bad} BAD`);
