// Probe (11th pass, TED-118 + TED-119). Me → Billing → Charge Card: the REAL
// page code (chargeStoredCard + its key store, cut from campistry_me.js) sending
// to the REAL stripe-charge / payments-charge functions (tests/edge_harness.js),
// with a pretend Stripe that answers a repeated Idempotency-Key with its first
// answer, and a pretend Sola. The office answers the new "same charge, or a new
// one?" question each way. Then (TED-119) the rows the real page produced are
// saved to a REAL scratch database (sync_camp_billing, what the page's save
// does) together with the webhook's own row (append_camp_payment), in both
// orders: how many payment rows, ledger payments, and what balance?
// 15th pass copy (helpers + Stripe list). Run: node --test ted/probes/2026-09-24-billing-15/charge_card_same_or_new15.test.js
'use strict';
const test = require('node:test');
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const { runEdge } = require(R + '/tests/edge_harness.js');
const ME = fs.readFileSync(R + '/campistry_me.js', 'utf8');
const cut = (re) => { const m = ME.match(re); if (!m) throw new Error('not found ' + re); return m[0]; };
const SRC = [
  cut(/async function chargeStoredCard\(famKey,amount,description,quiet\)\{[\s\S]*?\n\}\n/),
  cut(/function _pendingChargeStoreKey\(\)\{[^\n]*\n/), cut(/function _pendingChargeAll\(\)\{[^\n]*\n/),
  cut(/function _pendingChargeGet\(famKey,amount\)\{[\s\S]*?\n\}\n/), cut(/function _pendingChargeSet\(famKey,amount,v\)\{[\s\S]*?\n\}\n/),
  cut(/function _pendingChargeClear\(famKey,amount\)\{[\s\S]*?\n\}\n/),
  // 15th pass: the helpers chargeStoredCard now calls (TED-144)
  cut(/function _familyOnItsWay\(famKey\)\{[\s\S]*?\n\}\n/), cut(/function _familyDisputed\(famKey\)\{[\s\S]*?\n\}\n/), cut(/function _onItsWayWords\(w\)\{[\s\S]*?\n\}\n/),
  cut(/function _recordOnItsWay\(f,famKey,piId,amount\)\{[\s\S]*?\n\}\n/), cut(/function _methodTypeCharged\(f\)\{[\s\S]*?\n\}\n/)].join('\n');

function stripeWorld() { return { keys: {}, charges: [] }; }
function callStripeCharge(S, body, loseAnswer) {
  const r = runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_G' } });
const S = ${JSON.stringify(S)}; T.tables.__stripe = S;
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_G', customer: 'cus_G' };
  // 15th pass: Stripe's list of this customer's payments (TED-144's look-up) — every card charge here succeeded
  if (url.includes('/payment_intents?customer=')) return { object: 'list', data: Object.values(S.keys).map((x: any) => ({ id: x.id, status: x.status, amount: x.amount, customer: 'cus_G', metadata: { campId: 'camp1' } })), has_more: false };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const k = init.headers['Idempotency-Key'];
    if (!S.keys[k]) { const id = 'pi_' + (S.charges.length + 1); S.charges.push(id + ' $' + Number(new URLSearchParams(init.body).get('amount')) / 100); S.keys[k] = { id, status: 'succeeded', amount: Number(new URLSearchParams(init.body).get('amount')) }; }
    if (${loseAnswer ? 'true' : 'false'}) throw new Error('connection reset');
    return S.keys[k];
  }
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} };`);
  Object.assign(S, r.tables.__stripe);
  return r;
}
function ckWorld() { return { claims: {}, sales: [] }; }
function callPaymentsCharge(K0, body, loseAnswer) {
  const r = runEdge('payments-charge', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', byopCustomerRef: 'tok_G' } });
const K = ${JSON.stringify(K0)}; T.tables.__ck = K;
T.rpc.claim_refund_intent = (a: any) => { const c = K.claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} }; K.claims[a.p_key] = { result: null }; return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { K.claims[a.p_key].result = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { delete K.claims[a.p_key]; return true; };
T.rpc.release_stale_refund_intent = () => false;
T.rpc.record_processor_transaction = () => ({ success: true });
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Asale')) { const id = 'R' + (K.sales.length + 1); K.sales.push(id + ' $' + new URLSearchParams(init.body).get('xAmount'));
    if (${loseAnswer ? 'true' : 'false'}) throw new Error('connection reset');
    return 'xResult=A&xStatus=Approved&xRefNum=' + id; }
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} };`);
  Object.assign(K0, r.tables.__ck);
  return r;
}

function page(fam, send, dialogs) {
  const store = {}; const toasts = []; const rows = []; const asked = [];
  let lose = false;
  const ctx = {
    families: { gold: fam }, finPayments: rows, curPage: 'billing',
    toast: (t) => toasts.push(t), save: () => {}, renderBilling: () => {}, renderFamilyDetailPage: () => {},
    _postPaymentEntry: () => true, fm: (n) => '$' + n, esc: (s) => s, getCampId: () => 'camp1',
    confirmDialog: async (o) => { const a = dialogs.length ? dialogs.shift() : false; asked.push(o.title + ' → ' + (a ? 'OK' : 'Cancel')); return a; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { confirm: (m) => { asked.push('window.confirm: ' + m.split('\n')[0].slice(0, 70) + ' → Cancel'); return false; } },
    callEdgeFunctionAuthed: async (fn, body) => {
      const r = send(fn, body, lose);
      if (r.status >= 500 || (r.body && r.body.error && !r.body.uncertain && !r.body.declined && r.status !== 200)) { const e = new Error(r.body.error || 'x'); e.status = r.status; e.noAnswer = r.status >= 500; throw e; }
      if (r.body && r.body.error) { const e = new Error(r.body.error); e.data = r.body; throw e; }
      return r.body;
    },
  };
  const charge = new Function(...Object.keys(ctx), SRC + '; return chargeStoredCard;')(...Object.values(ctx));
  return { charge, toasts, rows, asked, setLose: (v) => { lose = v; } };
}

async function day(proc, dialogs, quietSecond) {
  const S = stripeWorld(), K = ckWorld();
  const fam = proc === 'stripe' ? { name: 'Gold', stripeCustomerId: 'cus_G', stripePaymentMethodId: 'pm_G' } : { name: 'Gold', byopCustomerRef: 'tok_G', byopProcessor: 'cardknox' };
  const p = page(fam, (fn, body, lose) => proc === 'stripe' ? callStripeCharge(S, body, lose) : callPaymentsCharge(K, body, lose), dialogs);
  p.setLose(true);
  const r1 = await p.charge('gold', 500, 'Camp payment — Gold');
  p.setLose(false);
  const r2 = await p.charge('gold', 500, 'Late pickup fee — Gold', quietSecond);
  return { r1, r2, p, made: proc === 'stripe' ? S.charges : K.sales };
}

const cases = [
  ['Stripe  ', 'stripe', [false, true], false, 'office: "a new charge" → "yes"'],
  ['Stripe  ', 'stripe', [true], false, 'office: "the same charge"'],
  ['Stripe  ', 'stripe', [false, false], false, 'office: cancels both'],
  ['Stripe  ', 'stripe', [], true, 'Batch charge (quiet)'],
  ['Cardknox', 'cardknox', [false, true], false, 'office: "a new charge" → "yes"'],
  ['Cardknox', 'cardknox', [true], false, 'office: "the same charge"'],
  ['Cardknox', 'cardknox', [], true, 'Batch charge (quiet)'],
];
test('10:00 a $500 charge whose answer is lost (it went through); 15:00 another $500 press', async () => {
  for (const [label, proc, dialogs, quiet, what] of cases) {
    const d = await day(proc, dialogs.slice(), quiet);
    console.log(`  ${label} ${what.padEnd(34)} | asked ${JSON.stringify(d.p.asked)} | 15:00 → ok=${d.r2.ok}${d.r2.error ? ' "' + String(d.r2.error).slice(0, 70) + '"' : ''} | charges actually made ${JSON.stringify(d.made)} | rows the page added ${JSON.stringify(d.p.rows.map((x) => x.id + ' $' + x.amount))}`);
  }
});

// ── TED-119 on the real database ─────────────────────────────────────────────
test('TED-119: the real page row + the webhook row on a real database, both orders', async () => {
  const db = require(R + '/tests/e2e/db.js').boot({ port: 5612 });
  const OWNER = '0ed12000-0000-0000-0000-0000000000a1';
  const q = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
  const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
  const famDoc = { name: 'Gold', camperIds: ['Avi Gold'], stripeCustomerId: 'cus_G', entries: [{ id: 'c1', kind: 'charge', amount: 1000, date: '2026-06-01' }] };
  let n = 0;
  const setup = () => { n++; const C = `0ed12000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t') ON CONFLICT DO NOTHING;
      INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'T${n}', 'stripe');
      INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(famDoc)})));`);
    q(`SELECT public.sync_camp_billing('${C}', jsonb_build_object('gold', ${lit(famDoc)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);
    return C; };
  const webhook = (C, pi) => q(`SELECT public.append_camp_payment('${C}', ${lit({ id: 'pi_' + pi, family: 'Avi Gold', familyKey: 'gold', amount: 500, date: '2026-06-02', method: 'Credit Card (online)', reference: pi, stripePaymentIntentId: pi, status: 'succeeded', timestamp: 1 })}, '${pi}', ${lit({ status: 'succeeded', amount: 500 })})::text`);
  const pageSaves = (C, row, pi) => {
    const cur = JSON.parse(q(`SELECT (public.camp_families_object('${C}')->'gold')::text`));
    const f2 = Object.assign({}, cur, { entries: (cur.entries || []).concat((cur.entries || []).some(e => e.id === 'le_pay_' + pi || (e.source && e.source.paymentId === pi)) ? [] : [{ id: 'le_pay_' + pi, kind: 'payment', amount: 500, reason: 'card', date: '2026-06-02', by: 'system', source: { paymentId: pi } }]) });
    return q(`SELECT public.sync_camp_billing('${C}', jsonb_build_object('gold', ${lit(f2)}), '[]'::jsonb, ${lit([row])}, '[]'::jsonb)::text`);
  };
  const report = (C, label) => {
    const rows = q(`SELECT string_agg(payment_id || ' $' || amount, ', ' ORDER BY payment_id) FROM camp_payments WHERE camp_id='${C}' AND deleted_at IS NULL`);
    const f = JSON.parse(q(`SELECT (public.camp_families_object('${C}')->'gold')::text`));
    const pays = (f.entries || []).filter(e => e.kind === 'payment').map(e => e.id + ' $' + e.amount);
    const sum = q(`SELECT coalesce(sum(amount),0) FROM camp_payments WHERE camp_id='${C}' AND deleted_at IS NULL AND status NOT IN ('pending','failed')`);
    console.log(`  ${label}: payment rows [${rows}] (collected per the rows $${sum}) | ledger payments [${pays.join(', ')}] | owed ${q(`SELECT public.family_ledger_balance((public.camp_families_object('${C}')->'gold'))::text`)}`);
  };
  try {
    // the row the REAL page makes for a charge Stripe answered pi_7
    const S = stripeWorld();
    const p = page({ name: 'Gold', stripeCustomerId: 'cus_G', stripePaymentMethodId: 'pm_G' }, (fn, body, lose) => callStripeCharge(S, body, lose), []);
    await p.charge('gold', 500, 'Camp payment — Gold');
    const row = p.rows[0]; const pi = row.stripePaymentIntentId;
    console.log('  the page\'s own row: id=' + row.id + ' pi=' + pi);
    let C = setup(); pageSaves(C, row, pi); webhook(C, pi); report(C, 'page saves first, webhook after');
    C = setup(); webhook(C, pi); pageSaves(C, row, pi); report(C, 'webhook first, page saves after');
    console.log('  Billing list (get_camp_payments):', q(`SELECT (SELECT string_agg(p->>'id' || ' ' || (p->>'amount'), ', ') FROM jsonb_array_elements(public.get_camp_payments('${C}')->'payments') p)`));
  } finally { db.stop(); }
});
