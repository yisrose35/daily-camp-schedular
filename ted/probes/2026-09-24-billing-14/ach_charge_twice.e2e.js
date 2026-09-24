// Probe (14th pass, hunt: a bank debit started from Billing's "Charge Card").
// The REAL Me page (Billing) on TWO office computers (two browser contexts,
// each with its own local memory) against the same real SQL; "Charge Card"
// answered by the REAL stripe-charge, Stripe's payment_intent.processing by the
// REAL stripe-webhook; a pretend Stripe records every debit it is asked for.
//
// Iron pays by BANK (the bank account is Iron's default method). A bank debit
// stays "processing" for several business days before it settles.
//   A1 Office computer A: Billing → Iron → Charge Card for the $1,000 owed.
//      What does the office read?
//   A2 Stripe sends payment_intent.processing → the real webhook records it.
//   A3 Office computer B (another staff member, or A tomorrow): Billing →
//      what does Iron's row say? Charge Card for the balance shown → is a
//      SECOND $1,000 debit started while the first is still on its way?
// Run: node ted/probes/2026-09-24-billing-14/ach_charge_twice.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');

const PORT = 8193;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const POLICY = { mode: 'surcharge', surchargePct: 3, costOfAcceptancePct: 3, state: 'NY', processorNotifiedOn: '2026-05-01' };
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
async function waitFor(what, fn, ms) {
  const until = Date.now() + (ms || 15000); let last;
  while (Date.now() < until) { try { if (await fn()) return true; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 200)); }
  throw new Error('timed out waiting for ' + what + (last ? ' (' + last + ')' : ''));
}

(async () => {
  const db = boot({ port: 5655 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  const d = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');
          CREATE TABLE ted_pis (id serial, customer text, pm text, cents int, descr text);`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const bank = { id: 'pm_x1', type: 'us_bank_account', processor: 'stripe', token: 'pm_bank', stripeCustomerId: 'cus_iron', last4: '6789', label: 'Chase ···· 6789' };
  const visa = { id: 'pm_x2', type: 'card', processor: 'stripe', token: 'pm_visa', stripeCustomerId: 'cus_iron', last4: '1111', label: 'Visa ···· 1111', funding: 'credit' };
  const iron = { name: 'Iron', camperIds: ['Ari Iron'], stripeCustomerId: 'cus_iron', stripePaymentMethodId: 'pm_bank', cardOnFile: true,
    paymentMethodType: 'us_bank_account', paymentMethodLabel: 'Chase ···· 6789', savedPaymentMethods: [bank],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', date: d }] };
  kv('campistryMe', { families: { iron }, enrollSettings: {} });
  const ledger = () => q1(`SELECT string_agg((e->>'kind') || ' ' || coalesce(e->>'reason','') || ' $' || (e->>'amount'), ', ') FROM jsonb_array_elements(public.camp_family('${CAMP}','iron')->'entries') e`);
  const owes = () => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','iron'))`));

  const STRIPE = `
const __qq = (T as any).__q;
const __esc = (s: string) => String(s).replace(/'/g, "''");
T.fetch = async (url: string, init: any) => {
  if (url.includes('/payment_methods/pm_bank')) return { id: 'pm_bank', object: 'payment_method', type: 'us_bank_account', customer: 'cus_iron', us_bank_account: { bank_name: 'Chase', last4: '6789' } };
  if (url.includes('/payment_methods/pm_visa')) return { id: 'pm_visa', object: 'payment_method', type: 'card', customer: 'cus_iron', card: { brand: 'visa', last4: '1111', funding: 'credit' } };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(String(init.body || ''));
    const r = JSON.parse(__qq("INSERT INTO ted_pis (customer, pm, cents, descr) VALUES ('" + __esc(String(p.get('customer'))) + "','" + __esc(String(p.get('payment_method'))) + "'," + Number(p.get('amount')) + ",'" + __esc(String(p.get('description'))) + "') RETURNING row_to_json(ted_pis)::text"));
    const isBank = r.pm === 'pm_bank';
    return { id: 'pi_' + r.id, object: 'payment_intent', amount: r.cents, amount_received: isBank ? 0 : r.cents, status: isBank ? 'processing' : 'succeeded',
             payment_method: r.pm, payment_method_types: [isBank ? 'us_bank_account' : 'card'], customer: r.customer, metadata: {} };
  }
  return {};
};`;
  const BR = bridge(db, ['camp_families_object', 'append_camp_payment'], []);
  function edge(fn, body, headers) {
    const env = `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', name: 'Probe Camp', payment_processor_key: 'stripe' }];
${BR}
${STRIPE}
${headers ? `T.requests = [{ headers: ${JSON.stringify(headers)}, rawBody: ${JSON.stringify(body)} }];` : `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body || {})} }];`}`;
    const r = runEdges([fn], env);
    return { status: r.responses[0].status, body: r.responses[0].body };
  }

  const crypto = require('node:crypto');
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
  const pageErrors = [];
  async function office() {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
    page.on('dialog', dd => dd.dismiss().catch(() => {}));
    await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
    await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
        users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
    await page.exposeFunction('__tedEdge', (fn, body) => edge(fn, body));
    await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await page.evaluate(() => {
      const inv = async (fn, o) => { const r = await window.__tedEdge(fn, o && o.body);
        if (r.status >= 400) return { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status: r.status, json: async () => r.body } } };
        return { data: r.body, error: null }; };
      window.CampistryDB.client.functions.invoke = inv;
      const c2 = window.CampistryDB.getClient && window.CampistryDB.getClient(); if (c2 && c2.functions) c2.functions.invoke = inv;
    });
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await waitFor('Iron on the page', () => page.evaluate(() => /Iron/.test(document.body.textContent)), 30000);
    await new Promise(r => setTimeout(r, 2500));
    return page;
  }
  const toastsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));
  const ironRow = (page) => page.evaluate(() => { const tr = [...document.querySelectorAll('#page-billing tr')].find(x => /Iron/.test(x.textContent)); return tr ? tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : '(no row)'; });
  const chargeCard = async (page) => {
    await page.evaluate(() => window.CampistryMe.chargeStoredCard('iron'));
    await page.waitForSelector('#chargeAmt', { timeout: 10000 });
    const win = (await page.textContent('#dynModal')).replace(/\s+/g, ' ').trim().slice(0, 160);
    await page.click('#dynModalSave');
    await new Promise(r => setTimeout(r, 5000));
    return { win, toast: (await toastsOf(page)).slice(-1) };
  };
  const debits = () => q1(`SELECT coalesce(string_agg('pi_' || id || ' ' || pm || ' $' || (cents/100.0)::numeric(10,2), ', ' ORDER BY id), 'none') FROM ted_pis`);
  try {
    const A = await office();
    log(`A1. Computer A: Iron owes $${owes()} and pays by bank (default method). Billing → Iron → Charge Card`);
    let r = await chargeCard(A);
    log(`    the window: "${r.win}"\n    toast: ${JSON.stringify(r.toast)}; debits started: ${debits()}`);

    log(`\nA2. Stripe: payment_intent.processing for pi_1 → the real webhook`);
    const pi1 = { id: 'pi_1', object: 'payment_intent', amount: 100000, status: 'processing', payment_method_types: ['us_bank_account'], customer: 'cus_iron',
      metadata: { campId: CAMP, familyKey: 'iron', familyName: 'Iron' } };
    const wh = webhook({ id: 'evt_p1', type: 'payment_intent.processing', created: Math.floor(Date.now() / 1000), data: { object: pi1 } });
    log(`    webhook HTTP ${wh.status}; payment rows: ${q1(`SELECT string_agg(payment_id || ' $' || amount || ' ' || coalesce(payload->>'status',''), ', ') FROM camp_payments WHERE camp_id='${CAMP}' AND deleted_at IS NULL`)}; Iron owes $${owes()}`);

    log(`\nA3. Computer B (another staff member — or A after a day): Billing`);
    const B = await office();
    log(`    Iron's row: "${await ironRow(B)}"`);
    r = await chargeCard(B);
    log(`    the window: "${r.win}"\n    toast: ${JSON.stringify(r.toast)}; debits started: ${debits()}`);
    const n = Number(q1(`SELECT count(*) FROM ted_pis`));
    check('A3 a second $1,000 bank debit is not started while the first is still processing', n === 1,
      `${n} debits of $1,000 from Iron's bank account for one $1,000 bill: ${debits()}`);
  } catch (e) {
    check('the run finished', false, String(e.message).split('\n')[0]);
  } finally {
    log('page errors: ' + JSON.stringify(pageErrors));
    await browser.close().catch(() => {});
    await bridgeSrv.close().catch(() => {});
    db.stop();
    log(`\n${bad} BAD`);
  }
})();
