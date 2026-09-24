// Probe (14th pass, TED-140 re-check, the harder case). The REAL Me page
// (Billing) in a real browser against real SQL; its Charge Card call answered
// by the REAL stripe-charge (tests/edge_harness.js) with a pretend Stripe that
// records which saved method each charge was taken from.
//
// Iron pays by BANK on autopay: the bank account is Iron's default method
// (stripePaymentMethodId). Iron also saved one credit card later (Stripe:
// funding "credit"), which stripe-webhook appended as NOT the default.
//   I1 Office: Billing → Iron → "Add card surcharge…" for the $1,000 Iron owes.
//      What does the window say, and is the 3% fee added?
//   I2 Office: Billing → Iron → "Charge Card" for the balance. Which of Iron's
//      methods does the money — surcharge included — come from?
// Run: node ted/probes/2026-09-24-billing-14/surcharge_default_bank.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');

const PORT = 8191;
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
  const db = boot({ port: 5653 });
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
    paymentMethodType: 'us_bank_account', paymentMethodLabel: 'Chase ···· 6789', savedPaymentMethods: [bank, visa],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', date: d }] };
  kv('campistryMe', { families: { iron }, enrollSettings: { cardFeePolicy: POLICY } });
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
  const BR = bridge(db, ['camp_families_object'], []);
  function edge(fn, body) {
    const env = `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', name: 'Probe Camp', payment_processor_key: 'stripe' }];
${BR}
${STRIPE}
T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body || {})} }];`;
    const r = runEdges([fn], env);
    return { status: r.responses[0].status, body: r.responses[0].body };
  }

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  page.on('dialog', dd => dd.dismiss().catch(() => {}));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  await page.exposeFunction('__tedEdge', (fn, body) => edge(fn, body));
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));
  try {
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

    log(`I1. Iron owes $${owes()}. Default method: the BANK account (Chase ···· 6789); also saved: one credit card (Visa ···· 1111). Office: Add card surcharge… $1,000`);
    await page.evaluate(() => window.CampistryMe.addCardSurcharge('iron'));
    await page.waitForSelector('#csBase', { timeout: 10000 });
    await page.fill('#csBase', '1000');
    await page.evaluate(() => window.CampistryMe._surchargePreview());
    log(`    the window: "${(await page.textContent('#dynModal')).replace(/\s+/g, ' ').trim().slice(0, 300)}"`);
    await page.click('#dynModalSave');
    await new Promise(r => setTimeout(r, 3000));
    log(`    toast ${JSON.stringify((await toasts()).slice(-1))}; Iron's ledger [${ledger()}], owes $${owes()}`);
    const feeAdded = /card_fee \$30/.test(ledger()) || owes() === 1030;

    log(`\nI2. Office: Billing → Iron → Charge Card for the balance`);
    await page.evaluate(() => window.CampistryMe.chargeStoredCard('iron'));
    await page.waitForSelector('#chargeAmt', { timeout: 10000 });
    log(`    the window: "${(await page.textContent('#dynModal')).replace(/\s+/g, ' ').trim().slice(0, 200)}"`);
    await page.click('#dynModalSave');
    await new Promise(r => setTimeout(r, 5000));
    const pis = q1(`SELECT coalesce(string_agg(pm || ' $' || (cents/100.0)::numeric(10,2), ', '), 'none') FROM ted_pis`);
    log(`    toast ${JSON.stringify((await toasts()).slice(-1))}; what Stripe was asked to take, and from which method: ${pis}`);
    check('I1/I2 no card surcharge ends up collected from a bank account',
      !(feeAdded && /pm_bank \$1030/.test(pis)), `the 3% card surcharge ($30) was added on the strength of the credit card, and Charge Card took $1,030 from the BANK account (pm_bank)`);
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
