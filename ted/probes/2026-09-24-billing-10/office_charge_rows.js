// Probe (10th pass): an ordinary office Stripe charge (Me → Charge Card) writes
// the payment twice — the page pushes {id:'pay_<ms>', reference/stripePaymentIntentId: pi}
// into its list and saves (sync_camp_billing), and stripe-webhook records
// {id:'pi_'+pi, ...} through append_camp_payment. Real chain, scratch DB.
// Both orders. How many payment rows, ledger payment entries, and what balance?
// Run: node ted/probes/2026-09-24-billing-10/office_charge_rows.js
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5567 });
const OWNER = '0ed20000-0000-0000-0000-0000000000a1';
let n = 0;
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const q = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
const fam = { name: 'Gold', camperIds: ['Avi Gold'], stripeCustomerId: 'cus_G', entries: [{ id: 'c1', kind: 'charge', amount: 1000, date: '2026-06-01' }] };
function setup() {
  n++; const C = `0ed20000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t') ON CONFLICT DO NOTHING;
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'T${n}', 'stripe');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(fam)})));`);
  q(`SELECT public.sync_camp_billing('${C}', jsonb_build_object('gold', ${lit(fam)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);
  return C;
}
const webhook = (C, pi) => q(`SELECT public.append_camp_payment('${C}', ${lit({ id: 'pi_' + pi, family: 'Avi Gold', familyKey: 'gold', amount: 500, date: '2026-06-02', method: 'Credit Card (online)', reference: pi, stripePaymentIntentId: pi, status: 'succeeded', timestamp: 1 })}, '${pi}', ${lit({ status: 'succeeded', amount: 500 })})::text`);
// what chargeStoredCard pushes (campistry_me.js _chgRow) + _postPaymentEntry's ledger entry, saved by the page
const pageRow = (pi) => ({ id: 'pay_1790000000000', family: 'Gold', familyKey: 'gold', amount: 500, date: '2026-06-02', method: 'Stripe (auto)', reference: pi, notes: 'Auto-charged via Stripe', stripePaymentIntentId: pi, byopTransactionId: null, byopProcessor: null, timestamp: 1790000000000 });
function pageSaves(C, pi) {
  const cur = JSON.parse(q(`SELECT (public.camp_families_object('${C}')->'gold')::text`));
  const f2 = Object.assign({}, cur, { entries: (cur.entries || []).concat((cur.entries || []).some(e => e.id === 'le_pay_' + pi || (e.source && e.source.paymentId === pi)) ? [] : [{ id: 'le_pay_' + pi, kind: 'payment', amount: 500, reason: 'card', date: '2026-06-02', by: 'system', source: { paymentId: pi } }]) });
  return q(`SELECT public.sync_camp_billing('${C}', jsonb_build_object('gold', ${lit(f2)}), '[]'::jsonb, ${lit([pageRow(pi)])}, '[]'::jsonb)::text`);
}
function report(C, label) {
  const rows = q(`SELECT string_agg(payment_id || ' $' || amount, ', ' ORDER BY payment_id) FROM camp_payments WHERE camp_id='${C}' AND deleted_at IS NULL`);
  const f = JSON.parse(q(`SELECT (public.camp_families_object('${C}')->'gold')::text`));
  const pays = (f.entries || []).filter(e => e.kind === 'payment').map(e => e.id + ' $' + e.amount);
  const sum = q(`SELECT coalesce(sum(amount),0) FROM camp_payments WHERE camp_id='${C}' AND deleted_at IS NULL AND status NOT IN ('pending','failed')`);
  console.log(`  ${label}: payment rows [${rows}] (total collected per the rows: $${sum}) | ledger payments [${pays.join(', ')}] | balance owed ${q(`SELECT public.family_ledger_balance((public.camp_families_object('${C}')->'gold'))::text`)}`);
}
try {
  let C = setup(); console.log('page saves first, webhook after:'); pageSaves(C, 'pi_A'); webhook(C, 'pi_A'); report(C, 'result');
  C = setup(); console.log('webhook first, page saves after:'); webhook(C, 'pi_B'); pageSaves(C, 'pi_B'); report(C, 'result');
  console.log('get_camp_payments as the owner (what Billing lists):', q(`SELECT (SELECT string_agg(p->>'id' || ' ' || (p->>'amount'), ', ') FROM jsonb_array_elements(public.get_camp_payments('${C}')->'payments') p)`));
} catch (e) { console.log('ERROR', String(e.message).slice(0, 1200)); }
finally { db.stop && db.stop(); }
