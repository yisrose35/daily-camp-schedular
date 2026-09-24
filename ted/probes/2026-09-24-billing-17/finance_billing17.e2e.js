// Probe (17th pass): re-check TED-157, TED-158, TED-160 on the REAL Me page in
// a real browser (the smoke harness: the real migration chain on a throwaway
// Postgres). Card refunds are answered by the REAL stripe-refund, and a refund
// failure is delivered to the REAL stripe-webhook (278 + 281 on the same DB),
// with a pretend Stripe that keeps its own refund book. Card Fees: 3% discount
// for not paying by card. Every family owes $1,000 of tuition.
//
//   F1  Moss: Finance → Revenue → "+ Record Payment" — which form opens? Pick
//       Moss, $970 cheque. Ledger, Finance's list, autopay's plan_due_for.
//   F2  Wolf: $970 cheque recorded in Billing; then Finance ✕ → the words, then
//       "Remove payment". Owes? Discount? History kept?
//   F3  Fox: same, but Cancel on the confirmation → nothing changes.
//   F4  Owl: an OLD Finance-page row (typed name only, never on the ledger —
//       what the pre-fix button saved). ✕ — words, and what the ledger does.
//   F5  Hawk paid $970 online by bank (Stripe). Family page note; "Discount
//       for not paying by card…" → pick → Give; press again.
//   F6  Hawk: ✕ on the online payment itself → refused?
//   F7  Hawk: card/bank refund of the whole $970 (Issue Credit/Refund →
//       refund_gateway): preview, toast, ledger — owes $1,000 again?
//   F8  Hawk: ✕ on that REFUND row in Finance's Payment Log (real money went
//       back to the bank through Stripe) — refused?
//   F9  Lark: online bank $970 + discount; refunds $500 then $470 → exactly $30
//       of discount back?
//   F10 Slate: online bank $970 + discount; refund $970; Stripe FAILS it → the
//       real webhook (278 put-back + 281) → owes? Re-delivered → no change.
//   F11 Slate: ✕ on the "Refund failed" put-back row → refused?
//   F12 Robin: $970 cheque + discount; Issue Credit/Refund → refund_offline →
//       the note about the discount.
//   F13 Heron: a bank debit still on its way (pending) is not offered.
// Run: node ted/probes/2026-09-24-billing-17/finance_billing17.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');

const PORT = 8417;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const POLICY = { mode: 'cash_discount', cashDiscountPct: 3, cashDiscountFlat: 0, state: 'NY' };
const TODAY = new Date().toISOString().slice(0, 10);
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(what, fn, ms) {
  const until = Date.now() + (ms || 15000); let last;
  while (Date.now() < until) { try { if (await fn()) return true; } catch (e) { last = e.message; } await wait(200); }
  throw new Error('timed out waiting for ' + what + (last ? ' (' + last + ')' : ''));
}

(async () => {
  const db = boot({ port: 5717 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  log('postgres up with ' + db.applied.length + ' migrations applied');
  const q1 = (s) => db.sql(s).trim();
  const d5 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const d3at = Date.now() - 3 * 86400000, d3 = new Date(d3at).toISOString().slice(0, 10);
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');
          CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
          CREATE TABLE ted_charge (ref text PRIMARY KEY, customer text, amount int, refunded int NOT NULL DEFAULT 0);
          CREATE TABLE ted_refunds (id serial, pi text, cents int, status text NOT NULL DEFAULT 'succeeded', created bigint, meta jsonb);`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const NAMES = { moss: 'Moss', wolf: 'Wolf', fox: 'Fox', owl: 'Owl', hawk: 'Hawk', lark: 'Lark', slate: 'Slate', robin: 'Robin', heron: 'Heron' };
  const families = {};
  for (const [k, n] of Object.entries(NAMES)) families[k] = { name: n, camperIds: [n + ' Kid'], stripeCustomerId: 'cus_' + k,
    entries: [{ id: 'le_t_' + k, kind: 'charge', amount: 1000, reason: 'tuition', date: d5 }] };
  families.moss.plans = [{ id: 'plan_moss', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }];
  families.moss.cardOnFile = true;
  // Owl's row exactly as the pre-fix Finance button saved it (aa72c69 finAddPayment): typed name, no key, no ledger entry
  const owlRow = { id: Date.now() - 86400000, family: 'Owl', amount: 970, method: 'check', date: d5, status: 'paid' };
  kv('campistryMe', { families, enrollSettings: { cardFeePolicy: POLICY, formConfig: { paymentMethods: ['check', 'cash', 'card', 'ach', 'zelle'] } },
    finance: { payments: [owlRow] } });
  db.sql(`SELECT public.camp_payment_add('${CAMP}', ${lit(JSON.stringify(owlRow))}::jsonb);`);
  // online bank payments, recorded the way stripe-webhook records them (append_camp_payment)
  const bankPay = (k, pi, status) => {
    const row = { id: 'pi_' + pi, family: NAMES[k], familyKey: k, amount: 970, date: d3, method: 'ACH', reference: pi, notes: 'Online payment (ACH)',
      stripePaymentIntentId: pi, status: status || 'succeeded', timestamp: d3at };
    db.sql(`INSERT INTO ted_charge (ref, customer, amount) VALUES ('${pi}', 'cus_${k}', 97000);`);
    return q1(`SELECT public.append_camp_payment(p_camp_id => '${CAMP}', p_payment => ${lit(JSON.stringify(row))}::jsonb, p_dedupe_key => '${pi}', p_update_on_match => '{"status":"${status || 'succeeded'}"}'::jsonb)::text`);
  };
  for (const k of ['hawk', 'lark', 'slate']) bankPay(k, 'pi_' + k);
  { // Finch: enrolled on the Me page (enrollCamper adds the tuition to the family's balance field, campistry_me.js:15402), paid $1,000 by card online
    const me = JSON.parse(q1(`SELECT value::text FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistryMe'`));
    me.families.finch = { name: 'Finch', camperIds: ['Finch Kid'], stripeCustomerId: 'cus_finch', balance: 1000,
      entries: [{ id: 'le_t_finch', kind: 'charge', amount: 1000, reason: 'tuition', date: d5 }] };
    kv('campistryMe', me);
    NAMES.finch = 'Finch';
    const row = { id: 'pi_pi_finch', family: 'Finch', familyKey: 'finch', amount: 1000, date: d3, method: 'Card', reference: 'pi_finch', notes: 'Online payment (Card)',
      stripePaymentIntentId: 'pi_finch', status: 'succeeded', timestamp: d3at };
    db.sql(`INSERT INTO ted_charge (ref, customer, amount) VALUES ('pi_finch', 'cus_finch', 100000);`);
    q1(`SELECT public.append_camp_payment(p_camp_id => '${CAMP}', p_payment => ${lit(JSON.stringify(row))}::jsonb, p_dedupe_key => 'pi_finch', p_update_on_match => '{"status":"succeeded"}'::jsonb)::text`);
  }
  bankPay('heron', 'pi_heron', 'pending');

  const owes = (k) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${k}'))`));
  const ledger = (k) => q1(`SELECT coalesce(string_agg(e->>'kind' || ' ' || (e->>'amount') || ' ' || coalesce(e->>'reason','') || coalesce(' rev:' || (e->>'reverses'),'') || ' [' || coalesce(e->>'id','') || ']', '; ' ORDER BY ord), '')
                            FROM jsonb_array_elements(public.camp_family('${CAMP}','${k}')->'entries') WITH ORDINALITY x(e, ord)`);
  const nEntries = (k) => Number(q1(`SELECT jsonb_array_length(coalesce(public.camp_family('${CAMP}','${k}')->'entries','[]'::jsonb))`));
  const credits = (k) => q1(`SELECT coalesce(string_agg((c->>'id') || ' $' || (c->>'amount'), ', '), 'none') FROM jsonb_array_elements(coalesce(public.camp_family('${CAMP}','${k}')->'credits','[]'::jsonb)) c`);
  const payRows = (k) => q1(`SELECT coalesce(string_agg((p->>'id') || ' ' || (p->>'amount') || ' ' || coalesce(p->>'method',''), ' | '), 'none') FROM jsonb_array_elements(public.camp_payments_array('${CAMP}')) p WHERE p->>'familyKey' = '${k}' OR p->>'family' = '${NAMES[k]}'`);
  const sentTo = (pi) => q1(`SELECT coalesce(string_agg('re_' || id || ' $' || (cents/100.0) || ' ' || status, ', ' ORDER BY id), 'none') FROM ted_refunds WHERE pi='${pi}'`);
  log(`SETUP: 9 families owe $1,000 each (3% off for not paying by card). Hawk/Lark/Slate each paid $970 online by bank (owe $${owes('hawk')}); Heron's $970 bank debit is still on its way; Owl has an old Finance-page cheque row (owes $${owes('owl')})`);

  // ── the pretend Stripe (15th-pass model: idempotency keys, refund book) ──
  const STRIPE = `
const __qq = (T as any).__q;
const __esc = (s: string) => String(s).replace(/'/g, "''");
const __refObj = (r: any) => Object.assign({ id: 're_' + r.id, object: 'refund', amount: r.cents, payment_intent: r.pi, charge: 'ch_' + r.pi,
  status: r.status, created: Number(r.created), metadata: r.meta || {} }, r.status === 'failed' ? { failure_reason: 'expired_or_canceled_card' } : {});
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = String(init.headers['Idempotency-Key'] || '');
    const body = String(init.body || '');
    const seen = JSON.parse(__qq("SELECT json_build_object('body', body, 'resp', resp, 'status', status)::text FROM ted_keys WHERE k='" + __esc(k) + "'") || 'null');
    if (seen) {
      if (seen.body !== body) return { __status: 400, error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } };
      return Object.assign({ __status: seen.status }, seen.resp, { __headers: { 'Idempotent-Replayed': 'true' } });
    }
    const p = new URLSearchParams(body);
    const pi = String(p.get('payment_intent')); const cents = Number(p.get('amount'));
    const row = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + __esc(pi) + "'") || 'null');
    let resp: any, status = 200;
    if (!row) { resp = { error: { type: 'invalid_request_error', message: 'No such payment_intent' } }; status = 404; }
    else if (cents > row.amount - row.refunded) { resp = { error: { type: 'invalid_request_error', message: 'Refund amount is greater than unrefunded amount on charge' } }; status = 400; }
    else {
      const meta: any = {}; for (const [kk, vv] of p.entries()) { const m = kk.match(/^metadata\\[(.+)\\]$/); if (m) meta[m[1]] = vv; }
      const r = JSON.parse(__qq("INSERT INTO ted_refunds (pi, cents, created, meta) VALUES ('" + __esc(pi) + "'," + cents + ", extract(epoch from now())::bigint, '" + __esc(JSON.stringify(meta)) + "'::jsonb) RETURNING row_to_json(ted_refunds)::text"));
      __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + __esc(pi) + "'");
      resp = __refObj(r);
    }
    if (k) __qq("INSERT INTO ted_keys (k, body, resp, status) VALUES ('" + __esc(k) + "','" + __esc(body) + "','" + __esc(JSON.stringify(resp)) + "'::jsonb," + status + ")");
    return Object.assign({ __status: status }, resp);
  }
  const one = url.match(/\\/refunds\\/re_(\\d+)$/);
  if (one && init.method !== 'POST') { const r = JSON.parse(__qq("SELECT row_to_json(x)::text FROM ted_refunds x WHERE id=" + Number(one[1])) || 'null');
    return r ? __refObj(r) : { __status: 404, error: { type: 'invalid_request_error', message: 'No such refund' } }; }
  if (url.includes('/payment_intents/')) { const id = decodeURIComponent(url.split('/payment_intents/')[1].split('?')[0]);
    const c = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + __esc(id) + "'") || 'null');
    return { id, object: 'payment_intent', customer: c ? c.customer : null, transfer_data: null, metadata: {} }; }
  return {};
};`;
  const RPCS = ['claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'camp_families_object',
    'reverse_failed_stripe_refund', 'record_external_refund', 'claim_refund_failure_alert', 'undo_card_fee_return', 'release_refund_failure_alert'];
  const BR = bridge(db, RPCS, ['refund_intents']);
  function edge(fn, body, headers) {
    const env = `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', payment_processor_key: 'stripe' }];
${BR}
${STRIPE}`;
    const req = headers ? `T.requests = [{ headers: ${JSON.stringify(headers)}, rawBody: ${JSON.stringify(body)} }];`
                        : `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body || {})} }];`;
    const r = runEdges([fn], env + '\n' + req);
    const res = r.responses[0];
    return { status: res.status, body: res.body };
  }
  function webhook(event) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    return edge('stripe-webhook', body, { 'stripe-signature': `t=${t},v1=${sig}` });
  }

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  await page.exposeFunction('__tedEdge', (fn, body) => edge(fn, body));
  const wire = () => page.evaluate(() => {
    const inv = async (fn, o) => {
      const r = await window.__tedEdge(fn, o && o.body);
      if (r.status >= 400) return { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status: r.status, json: async () => r.body } } };
      return { data: r.body, error: null };
    };
    window.CampistryDB.client.functions.invoke = inv;
    const c2 = window.CampistryDB.getClient && window.CampistryDB.getClient();
    if (c2 && c2.functions) c2.functions.invoke = inv;
  });
  const toastNow = () => page.evaluate(() => { const e = document.getElementById('tM'); return e ? e.textContent : ''; });
  const modal = () => page.evaluate(() => { const m = document.getElementById('dynModal'); return m && m.offsetParent !== null ? m.textContent.replace(/\s+/g, ' ').trim() : '(closed)'; });
  const openMe = async () => {
    await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await wire();
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await waitFor('the families on the page', () => page.evaluate(() => /Moss/.test(document.body.textContent)), 30000);
    await wait(2500);
  };
  const famText = async (k) => { await page.evaluate((k) => window.CampistryMe.viewFamily(k), k); await wait(1000);
    return page.evaluate(() => { const c = document.getElementById('page-familydetail'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : ''; }); };
  const recordPayment = async (k, amount, method) => {
    await page.evaluate((k) => window.CampistryMe.openPaymentForFamily(k), k);
    await page.waitForSelector('#payAmount', { timeout: 10000 });
    await page.fill('#payAmount', String(amount));
    await page.selectOption('#payMethod', method);
    await wait(300);
    await page.click('#dynModalSave');
    await wait(2000);
  };
  const financeRevenue = async () => {
    await page.evaluate(() => window.CampistryMe.nav('finance')); await wait(800);
    await page.evaluate(() => window.CampistryMe.finSetTab('revenue')); await wait(800);
  };
  const logRows = () => page.evaluate(() => [...document.querySelectorAll('#page-finance tr')].filter(t => t.querySelector('button')).map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  // press ✕ on the Payment Log row that matches, then read the confirmation, then press OK or Cancel
  const pressX = async (re, answer) => {
    await financeRevenue();
    const row = await page.evaluate((src) => { const re = new RegExp(src); const r = [...document.querySelectorAll('#page-finance tr')].find(t => re.test(t.textContent) && t.querySelector('button'));
      if (!r) return null; const t = r.textContent.replace(/\s+/g, ' ').trim(); r.querySelector('button').click(); return t; }, re.source);
    await wait(600);
    const words = await page.evaluate(() => { const o = document.getElementById('confirmDlgOverlay'); return o ? o.textContent.replace(/\s+/g, ' ').trim() : '(no confirmation shown)'; });
    if (answer && words !== '(no confirmation shown)') { await page.click(answer === 'ok' ? '#confirmDlgOk' : '#confirmDlgCancel'); }
    await wait(2500);
    return { row, words, toast: await toastNow() };
  };
  const refundWindow = async (fk, type, amt) => {
    await page.evaluate((k) => window.CampistryMe.issueCreditForFamily(k), fk);
    await page.waitForSelector('#crType', { timeout: 10000 });
    await page.selectOption('#crType', type);
    await wait(500);
    const amtSel = type === 'credit' ? '#crAmount' : '#crRefundAmount';
    if (amt != null && await page.$(amtSel)) { await page.fill(amtSel, String(amt)); await page.evaluate(() => window.CampistryMe._crUpdateBalancePreview()); }
    const pv = await page.evaluate(() => { const e = document.getElementById('crBalancePreview'); return e ? e.textContent.replace(/\s+/g, ' ').trim() : '(no preview)'; });
    return pv;
  };
  const pressRefund = async () => {
    await page.click('#dynModalSave');
    await waitFor('the refund answer', async () => /Refunded|Refund failed|error/i.test(await toastNow()), 20000).catch(() => {});
    await wait(2500);
    return toastNow();
  };
  const giveDiscount = async (k, pickFirst) => {
    await page.evaluate((k) => window.CampistryMe.addCardSurcharge(k), k); await wait(700);
    const w = await modal();
    const opts = await page.evaluate(() => { const s = document.getElementById('cdPay'); return s ? [...s.options].map(o => o.textContent) : null; });
    if (opts && pickFirst) { await page.click('#dynModalSave'); await wait(2000); }
    else await page.evaluate(() => window.CampistryMe.closeModal('dynModal'));
    return { w, opts, toast: await toastNow() };
  };

  try {
    await openMe();

    // ── F1 ────────────────────────────────────────────────────────────────
    log(`\nF1. Moss pays $970 by cheque; the office uses Finance → Revenue → "+ Record Payment"`);
    await financeRevenue();
    await page.evaluate(() => [...document.querySelectorAll('#page-finance button')].find(b => /Record Payment/.test(b.textContent)).click());
    await wait(800);
    const form = await page.evaluate(() => ({ picker: !!document.getElementById('payFamKey'), oldTyped: !!document.getElementById('fapFamily'),
      options: (() => { const s = document.getElementById('payFamKey'); return s ? [...s.options].map(o => o.textContent.trim()) : []; })() }));
    log(`    the window: family picker ${form.picker}, typed-name box ${form.oldTyped}; families offered ${JSON.stringify(form.options)}`);
    await page.selectOption('#payFamKey', 'moss');
    await page.fill('#payAmount', '970');
    await page.selectOption('#payMethod', 'check');
    await wait(400);
    const f1pv = await page.evaluate(() => { const b = document.getElementById('payDiscount'); return b ? b.textContent.trim() : ''; });
    await page.click('#dynModalSave'); await wait(2500);
    const f1toast = await toastNow();
    const f1rows = await logRows();
    const onFinance = await page.evaluate(() => !!document.querySelector('#page-finance') && document.querySelector('#page-finance').offsetParent !== null);
    log(`    preview "${f1pv}"; toast "${f1toast}"`);
    log(`    still on Finance: ${onFinance}; its Payment Log now: ${JSON.stringify(f1rows)}`);
    log(`    Moss's ledger: ${ledger('moss')}; owes $${owes('moss')}`);
    const due = q1(`SELECT public.plan_due_for('${CAMP}'::uuid, 'moss', 'plan_moss', '${TODAY}')::text`);
    log(`    tonight's autopay asks plan_due_for → ${due}`);
    check('F1 Finance\'s button is Billing\'s form (family picker, no typed name)', form.picker && !form.oldTyped && form.options.some(o => /Moss/.test(o)), JSON.stringify(form));
    check('F1 the cheque is on Moss\'s bill with its $30 discount (owes $0)', owes('moss') === 0 && /\$30/.test(f1toast), `owes $${owes('moss')}`);
    check('F1 Finance re-rendered with the new row, without leaving the page', onFinance && f1rows.some(r => /Moss.*\$970/.test(r)), JSON.stringify(f1rows));
    const dueAmt = (() => { try { return Number(JSON.parse(due).amount); } catch (_) { return NaN; } })();
    check('F1 autopay finds nothing to charge Moss tonight', !(dueAmt > 0), due);

    // ── F2 / F3 ───────────────────────────────────────────────────────────
    log(`\nF2. Wolf: $970 cheque recorded in Billing (with its $30 discount), then removed on Finance → Payment Log → ✕`);
    await recordPayment('wolf', 970, 'check');
    const wolfN = nEntries('wolf');
    log(`    before: owes $${owes('wolf')}; ledger ${ledger('wolf')}; credits ${credits('wolf')}`);
    const x2 = await pressX(/Wolf/, 'ok');
    log(`    pressed ✕ on "${x2.row}"\n    the confirmation: "${x2.words}"\n    toast: "${x2.toast}"`);
    log(`    after: owes $${owes('wolf')}; ledger ${ledger('wolf')}; credits ${credits('wolf')}; payment rows: ${payRows('wolf')}`);
    check('F2 the words say what happens (Wolf owes it again, the $30 discount goes too)', /Wolf.{0,3}s account/.test(x2.words) && /owe it again/.test(x2.words) && /\$30(\.00)? discount/.test(x2.words), x2.words);
    check('F2 Wolf owes $1,000 again, the discount credit is gone, and the history keeps both entries (reversed, not deleted)',
      owes('wolf') === 1000 && credits('wolf') === 'none' && nEntries('wolf') === wolfN + 2 && payRows('wolf') === 'none', `owes $${owes('wolf')}, entries ${wolfN}→${nEntries('wolf')}, credits ${credits('wolf')}, rows ${payRows('wolf')}`);

    log(`\nF3. Fox: $970 cheque in Billing, ✕ in Finance, then Cancel`);
    await recordPayment('fox', 970, 'check');
    const foxBefore = [owes('fox'), ledger('fox'), payRows('fox')].join(' / ');
    const x3 = await pressX(/Fox/, 'cancel');
    const foxAfter = [owes('fox'), ledger('fox'), payRows('fox')].join(' / ');
    log(`    toast "${x3.toast}"; before ${foxBefore}\n    after  ${foxAfter}`);
    check('F3 Cancel changes nothing', foxBefore === foxAfter, foxAfter);

    // ── F4 ────────────────────────────────────────────────────────────────
    log(`\nF4. Owl: the OLD Finance-page cheque row (typed name, never on the bill). ✕`);
    const owlBefore = owes('owl');
    const x4 = await pressX(/Owl/, 'ok');
    log(`    pressed ✕ on "${x4.row}"\n    the confirmation: "${x4.words}"\n    toast: "${x4.toast}"`);
    log(`    Owl owes: before $${owlBefore}, after $${owes('owl')}; ledger ${ledger('owl')}; rows ${payRows('owl')}`);
    check('F4 removing a row that never reached the bill leaves the bill alone', owes('owl') === owlBefore, `owes ${owlBefore} → ${owes('owl')}`);
    check('F4b and the words do not claim the family will owe it again / the balance went up', !/owe it again/.test(x4.words) && !/back up by/.test(x4.toast),
      `confirmation "${x4.words}"; toast "${x4.toast}"`);

    // ── F5 / F6 ───────────────────────────────────────────────────────────
    log(`\nF5. Hawk paid $970 online by bank (owes $${owes('hawk')})`);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(800);
    const noteOf = async (k) => { await famText(k); return page.evaluate(() => { const d = [...document.querySelectorAll('#page-familydetail div')].filter(x => /made online without/.test(x.textContent) && !x.querySelector('div'));
      return d.length ? d[0].textContent.replace(/\s+/g, ' ').trim() : '(no note)'; }); };
    const note = await noteOf('hawk');
    log(`    family page: "${note}"`);
    let g = await giveDiscount('hawk', true);
    log(`    window: "${g.w.slice(0, 220)}"; payments offered ${JSON.stringify(g.opts)}\n    toast "${g.toast}"; Hawk owes $${owes('hawk')}; credits ${credits('hawk')}`);
    const g2 = await giveDiscount('hawk', true);
    log(`    pressed again: window "${g2.w.slice(0, 160)}"; offered ${JSON.stringify(g2.opts)}; Hawk owes $${owes('hawk')}`);
    const note2 = await noteOf('hawk');
    log(`    family page now: "${note2}"`);
    check('F5 the family page says one online bank payment lacks the discount', /^1 bank payment made online/.test(note), note);
    check('F5 the discount is given for the picked payment: Hawk owes $0, one credit cdisc_pi_pi_hawk', owes('hawk') === 0 && credits('hawk') === 'cdisc_pi_pi_hawk $30', `owes $${owes('hawk')}, credits ${credits('hawk')}`);
    check('F5b a second press gives nothing more and the note is gone', owes('hawk') === 0 && g2.opts === null && note2 === '(no note)', `owes $${owes('hawk')}; ${g2.w.slice(0, 80)}`);

    log(`\nF6. Hawk: ✕ on the online bank payment itself`);
    const x6 = await pressX(/Hawk.*\$970/, 'ok');
    log(`    confirmation "${x6.words}"; toast "${x6.toast}"; Hawk owes $${owes('hawk')}`);
    check('F6 a processor payment is refused (that is a refund)', /Issue Credit\/Refund/.test(x6.toast) && owes('hawk') === 0 && x6.words === '(no confirmation shown)', x6.toast);

    // ── F7 / F8 ───────────────────────────────────────────────────────────
    log(`\nF7. Hawk withdraws: Issue Credit/Refund → back to the bank, $970`);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(600);
    const pv7 = await refundWindow('hawk', 'refund_gateway', 970);
    log(`    preview: "${pv7}"`);
    const t7 = await pressRefund();
    log(`    toast "${t7}"\n    Stripe: ${sentTo('pi_hawk')}; ledger ${ledger('hawk')}; owes $${owes('hawk')}`);
    check('F7 the refund goes back once and the $30 discount comes back on the bill: Hawk owes $1,000 (tuition, nothing kept)',
      /^re_\d+ \$970(\.0+)? succeeded$/.test(sentTo('pi_hawk')), sentTo('pi_hawk'));
    check('F7b Hawk owes $1,000; the preview said so first', owes('hawk') === 1000 && /\$1,000/.test(pv7) && /\$30(\.00)? not-paying-by-card discount/.test(pv7), `owes $${owes('hawk')}; preview "${pv7}"`);

    log(`\nF8. Hawk: ✕ on that REFUND row in Finance's Payment Log (the $970 really went back to the bank through Stripe)`);
    const hawkBefore8 = owes('hawk');
    const x8 = await pressX(/Hawk.*−\$970/, 'ok');
    log(`    pressed ✕ on "${x8.row}"\n    confirmation "${x8.words}"\n    toast "${x8.toast}"`);
    log(`    Hawk owes: before $${hawkBefore8}, after $${owes('hawk')}; ledger ${ledger('hawk')}; rows ${payRows('hawk')}`);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(600);
    const pv8 = await refundWindow('hawk', 'refund_gateway', null);
    const sum8 = await page.evaluate(() => { const e = document.getElementById('crRefundSummary'); return e ? e.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : ''; });
    await page.evaluate(() => window.CampistryMe.closeModal('dynModal'));
    log(`    the refund window now says: "${sum8}"`);
    check('F8 a refund that went through Stripe is not "undone" by ✕ (refused, like the payment)', owes('hawk') === hawkBefore8,
      `Hawk now owes $${owes('hawk')} instead of $${hawkBefore8} — the bill says the camp still holds $970 that went back to the bank`);

    // ── F9 ────────────────────────────────────────────────────────────────
    log(`\nF9. Lark: online bank $970, discount, then two refunds: $500, then $470`);
    await giveDiscount('lark', true);
    log(`    after the discount: owes $${owes('lark')}; credits ${credits('lark')}`);
    for (const a of [500, 470]) {
      await openMe();
      const pv = await refundWindow('lark', 'refund_gateway', a);
      const t = await pressRefund();
      log(`    $${a}: preview "${pv}"\n         toast "${t}"; owes $${owes('lark')}`);
    }
    const back9 = q1(`SELECT coalesce(string_agg('$' || (e->>'amount'), ' + '), 'none') FROM jsonb_array_elements(public.camp_family('${CAMP}','lark')->'entries') e WHERE e->>'kind' = 'charge' AND e->>'reason' <> 'tuition'`);
    log(`    discount charged back: ${back9}; Stripe ${sentTo('pi_lark')}`);
    check('F9 two partial refunds take back exactly the $30 (Lark owes $1,000)', owes('lark') === 1000, `owes $${owes('lark')}; back ${back9}`);

    // ── F10 / F11 ─────────────────────────────────────────────────────────
    log(`\nF10. Slate: online bank $970, discount, refund $970 — then Stripe FAILS that refund`);
    await openMe();
    await giveDiscount('slate', true);
    await refundWindow('slate', 'refund_gateway', 970);
    const t10 = await pressRefund();
    log(`    toast "${t10}"; owes $${owes('slate')}`);
    const rid = Number(q1(`SELECT max(id) FROM ted_refunds WHERE pi='pi_slate'`));
    db.sql(`UPDATE ted_refunds SET status='failed' WHERE id=${rid}; UPDATE ted_charge SET refunded = refunded - 97000 WHERE ref='pi_slate'; DELETE FROM ted_keys;`);
    const obj = JSON.parse(q1(`SELECT json_build_object('id','re_'||id,'object','refund','amount',cents,'payment_intent',pi,'charge','ch_'||pi,'status',status,'failure_reason','expired_or_canceled_card','metadata',meta,'created',created)::text FROM ted_refunds WHERE id=${rid}`));
    const wh = webhook({ id: 'evt_f10', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: obj } });
    log(`    refund.failed → the real webhook → HTTP ${wh.status} ${JSON.stringify(wh.body).slice(0, 160)}`);
    log(`    Slate: owes $${owes('slate')}; ledger ${ledger('slate')}`);
    check('F10 after the failure Slate is back where it was before the refund (owes $0: payment and discount both stand)', owes('slate') === 0, `owes $${owes('slate')}`);
    const wh2 = webhook({ id: 'evt_f10r', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: obj } });
    log(`    re-delivered → HTTP ${wh2.status}; Slate owes $${owes('slate')}`);
    check('F10b a re-delivered failure changes nothing', owes('slate') === 0, `owes $${owes('slate')}`);

    log(`\nF11. Slate: ✕ on the "Refund failed" put-back row`);
    await openMe();
    const slateBefore = owes('slate');
    const x11 = await pressX(/Slate\$970(?!ACH)/, 'ok');
    log(`    pressed ✕ on "${x11.row}"\n    confirmation "${x11.words}"\n    toast "${x11.toast}"; Slate owes: before $${slateBefore}, after $${owes('slate')}`);
    check('F11 the put-back of a failed Stripe refund is not removable as if it were a cheque', owes('slate') === slateBefore,
      `Slate now owes $${owes('slate')} — as if the failed refund had reached the parent`);

    // ── F12 / F13 ─────────────────────────────────────────────────────────
    log(`\nF12. Robin: $970 cheque (with the discount); Issue Credit/Refund → a refund by cheque (offline) of $970`);
    await openMe();
    await recordPayment('robin', 970, 'check');
    const pv12 = await refundWindow('robin', 'refund_offline', 970);
    await page.evaluate(() => window.CampistryMe.closeModal('dynModal'));
    log(`    the window: "${pv12}"`);
    check('F12 the offline refund window tells the office about the $30 discount', /\$30(\.00)? off for not paying by card/.test(pv12) && /Add Charge/.test(pv12), pv12);

    log(`\nF13. Heron: a $970 bank debit still on its way (pending)`);
    const g13 = await giveDiscount('heron', false);
    log(`    window "${g13.w.slice(0, 200)}"; offered ${JSON.stringify(g13.opts)}; Heron owes $${owes('heron')}`);
    check('F13 a bank debit still on its way is not offered', g13.opts === null, JSON.stringify(g13.opts));
    log(`\nF14. Finch enrolled on the Me page ($1,000 tuition → the family's old "balance" field says 1000, as enrolCamper sets it) and paid $1,000 by CARD online (webhook). Office refunds $400 to the card`);
    await openMe();
    log(`    before: Finch owes $${owes('finch')} on the ledger (Billing's figure: ${JSON.stringify(((await famText('finch')).match(/Balance\s*(-?\$[\d,.]+|\$-?[\d,.]+)/) || [])[1])})`);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(600);
    const pv14 = await refundWindow('finch', 'refund_gateway', 400);
    const t14 = await pressRefund();
    log(`    preview "${pv14}"\n    toast "${t14}"; Finch now owes $${owes('finch')} (Stripe ${sentTo('pi_finch')})`);
    const pvNum = Number(((pv14.match(/refund: \$([\d,.-]+)/) || [])[1] || 'NaN').replace(/,/g, ''));
    check('F14 the refund window\'s "Balance owed after this refund" is what the family owes afterwards', Math.abs(pvNum - owes('finch')) < 0.005,
      `preview said $${pvNum}, the family owes $${owes('finch')}`);
  } catch (e) {
    check('the run finished', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  } finally {
    log('page errors: ' + JSON.stringify(pageErrors));
    await browser.close().catch(() => {});
    await bridgeSrv.close().catch(() => {});
    db.stop();
    log(`\n${bad} BAD`);
  }
})();
