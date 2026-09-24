// Probe (15th pass, TED-144 re-check + hunt). The REAL Me page (Billing) on
// several office computers (separate browser contexts) against the same real
// SQL; "Charge Card" answered by the REAL stripe-charge; Stripe's events by the
// REAL stripe-webhook. The pretend Stripe keeps every PaymentIntent it makes,
// with its status and metadata, and answers GET /payment_intents?customer=…
// and GET /payment_intents/{id} the way Stripe does (the 14th-pass probe's
// Stripe did not know the list request, which the fix now makes).
//
// Iron pays by BANK (default method). Gold pays by credit card.
//   A1 Computer A: Billing → Iron → Charge Card $1,000 → what does the office read?
//   A2 Stripe: payment_intent.processing → the real webhook
//   A3 Computer B: Iron's row + family page; Charge Card again → refused?
//   A3s the SERVER guard alone: computer C whose page has no row for the debit
//       (neither the page's row nor the webhook's arrived) → Charge Card
//   A4 Batch charge on computer B (Iron and Gold owe money)
//   A5 the bank settles Iron's debit: payment_intent.succeeded; then Stripe
//       re-delivers the old "processing" event late
//   A6 Steel (bank): a debit the bank RETURNS (payment_intent.payment_failed),
//       then the old "processing" event is re-delivered late → what does
//       Billing say, and can the office charge again?
// Run: node ted/probes/2026-09-24-billing-15/ach15.e2e.js
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

const PORT = 8203;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
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
  const db = boot({ port: 5673 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  const d = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');
          CREATE TABLE ted_pis (id serial, customer text, pm text, cents int, status text, meta jsonb, created bigint);`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const bankOf = (cus, tok) => ({ id: 'pm_' + tok, type: 'us_bank_account', processor: 'stripe', token: tok, stripeCustomerId: cus, last4: '6789', label: 'Chase ···· 6789' });
  const fam = (name, kid, cus, tok, type, owe) => ({ name, camperIds: [kid], stripeCustomerId: cus, stripePaymentMethodId: tok, cardOnFile: true,
    paymentMethodType: type, paymentMethodLabel: type === 'card' ? 'Visa ···· 1111' : 'Chase ···· 6789',
    savedPaymentMethods: [type === 'card' ? { id: 'pm_' + tok, type: 'card', processor: 'stripe', token: tok, stripeCustomerId: cus, last4: '1111', label: 'Visa ···· 1111', funding: 'credit' } : bankOf(cus, tok)],
    entries: [{ id: 'le_t_' + name, kind: 'charge', amount: owe, reason: 'tuition', date: d }] });
  kv('campistryMe', { families: {
    iron: fam('Iron', 'Ari Iron', 'cus_iron', 'pm_bank_iron', 'us_bank_account', 1000),
    gold: fam('Gold', 'Dov Gold', 'cus_gold', 'pm_visa_gold', 'card', 200),
    steel: fam('Steel', 'Eli Steel', 'cus_steel', 'pm_bank_steel', 'us_bank_account', 700) }, enrollSettings: {} });
  const owes = (k) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${k}'))`));
  const rows = () => q1(`SELECT coalesce(string_agg(payment_id || ' $' || amount || ' ' || coalesce(payload->>'status',''), ', ' ORDER BY payment_id), 'none') FROM camp_payments WHERE camp_id='${CAMP}' AND deleted_at IS NULL`);

  const STRIPE = `
const __qq = (T as any).__q;
const __esc = (s: string) => String(s).replace(/'/g, "''");
const __pi = (r: any) => ({ id: 'pi_' + r.id, object: 'payment_intent', amount: r.cents, amount_received: r.status === 'succeeded' ? r.cents : 0, status: r.status,
  payment_method: r.pm, payment_method_types: [String(r.pm).includes('bank') ? 'us_bank_account' : 'card'], customer: r.customer, created: Number(r.created), metadata: r.meta || {} });
T.fetch = async (url: string, init: any) => {
  const pm = url.match(/\\/payment_methods\\/(pm_[a-z_]+)$/);
  if (pm) { const t = pm[1]; const cus = t.includes('iron') ? 'cus_iron' : t.includes('gold') ? 'cus_gold' : 'cus_steel';
    return t.includes('bank') ? { id: t, object: 'payment_method', type: 'us_bank_account', customer: cus, us_bank_account: { bank_name: 'Chase', last4: '6789' } }
                              : { id: t, object: 'payment_method', type: 'card', customer: cus, card: { brand: 'visa', last4: '1111', funding: 'credit' } }; }
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(String(init.body || ''));
    const meta: any = {}; for (const [k, v] of p.entries()) { const m = k.match(/^metadata\\[(.+)\\]$/); if (m) meta[m[1]] = v; }
    const pmId = String(p.get('payment_method'));
    const r = JSON.parse(__qq("INSERT INTO ted_pis (customer, pm, cents, status, meta, created) VALUES ('" + __esc(String(p.get('customer'))) + "','" + __esc(pmId) + "'," + Number(p.get('amount')) + ",'" + (pmId.includes('bank') ? 'processing' : 'succeeded') + "','" + __esc(JSON.stringify(meta)) + "'::jsonb, extract(epoch from now())::bigint) RETURNING row_to_json(ted_pis)::text"));
    return __pi(r);
  }
  if (url.includes('/payment_intents?')) {
    const u = new URL(url);
    const cus = String(u.searchParams.get('customer') || ''); const since = Number(u.searchParams.get('created[gte]') || 0);
    const list = JSON.parse(__qq("SELECT coalesce(json_agg(x ORDER BY id DESC), '[]'::json)::text FROM ted_pis x WHERE customer='" + __esc(cus) + "' AND created >= " + since));
    return { object: 'list', data: list.map(__pi), has_more: false };
  }
  const one = url.match(/\\/payment_intents\\/pi_(\\d+)$/);
  if (one) { const r = JSON.parse(__qq("SELECT row_to_json(x)::text FROM ted_pis x WHERE id=" + Number(one[1])) || 'null');
    return r ? __pi(r) : { __status: 404, error: { message: 'No such payment_intent' } }; }
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
  let evN = 0;
  function webhook(type, piId) {
    const r = JSON.parse(q1(`SELECT row_to_json(x)::text FROM ted_pis x WHERE id=${Number(String(piId).replace('pi_', ''))}`));
    // the event carries the PaymentIntent as it was when Stripe made the event
    const status = type === 'payment_intent.processing' ? 'processing' : type === 'payment_intent.succeeded' ? 'succeeded' : 'requires_payment_method';
    const obj = { id: 'pi_' + r.id, object: 'payment_intent', amount: r.cents, amount_received: status === 'succeeded' ? r.cents : 0, status,
      payment_method_types: [String(r.pm).includes('bank') ? 'us_bank_account' : 'card'], customer: r.customer, metadata: r.meta || {},
      last_payment_error: status === 'requires_payment_method' ? { message: 'The customer\'s bank account could not be debited (R01 insufficient funds).' } : null };
    const body = JSON.stringify({ id: 'evt_' + (++evN), type, created: Math.floor(Date.now() / 1000), data: { object: obj } });
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
    await page.evaluate(() => { window.__toasts = []; const tM = document.getElementById('tM'), tI = document.getElementById('tI');
      if (tM) new MutationObserver(() => { if (tM.textContent) window.__toasts.push(((tI && tI.textContent) || '') + ' ' + tM.textContent); }).observe(tM, { childList: true, characterData: true, subtree: true }); });
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await waitFor('Iron on the page', () => page.evaluate(() => /Iron/.test(document.body.textContent)), 30000);
    await new Promise(r => setTimeout(r, 2500));
    return page;
  }
  const toastsOf = (page) => page.evaluate(() => (window.__toasts || []).slice());
  const rowOf = (page, name) => page.evaluate((n) => { const tr = [...document.querySelectorAll('#page-billing tr')].find(x => new RegExp(n).test(x.textContent)); return tr ? tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : '(no row)'; }, name);
  const modalText = (page) => page.evaluate(() => { const m = document.getElementById('dynModal'); return m ? m.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : ''; });
  const chargeCard = async (page, key) => {
    await page.evaluate(() => { const m = document.getElementById('dynModal'); if (m) m.remove(); });
    const before = (await toastsOf(page)).length;
    await page.evaluate((k) => { window.__tedRes = null; window.CampistryMe.chargeStoredCard(k).then(r => { window.__tedRes = r || null; }); }, key);
    await new Promise(r => setTimeout(r, 1500));
    let win = await modalText(page);
    if (await page.$('#chargeAmt')) {
      await page.click('#dynModalSave');
      await new Promise(r => setTimeout(r, 5000));
    }
    const t = await toastsOf(page);
    return { win, toast: t.slice(before).slice(-1) };
  };
  const familyPage = async (page, key) => {
    await page.evaluate((k) => { window.CampistryMe.viewFamily(k); }, key);
    await new Promise(r => setTimeout(r, 1500));
    return page.evaluate(() => { const el = document.querySelector('#page-familydetail') || document.body; const m = el.textContent.replace(/\s+/g, ' ').match(/Balance.{0,120}/); const r = m ? m[0] : null; window.CampistryMe.nav('billing'); return r; });
  };
  const debits = () => q1(`SELECT coalesce(string_agg('pi_' || id || ' ' || customer || ' $' || (cents/100.0)::numeric(10,2) || ' ' || status, ', ' ORDER BY id), 'none') FROM ted_pis`);
  const nFrom = (cus) => Number(q1(`SELECT count(*) FROM ted_pis WHERE customer='${cus}'`));
  try {
    const A = await office();
    log(`A1. Computer A: Iron owes $${owes('iron')} and pays by bank (default method). Billing → Iron → Charge Card $1,000`);
    let r = await chargeCard(A, 'iron');
    log(`    the window: "${r.win}"\n    toast: ${JSON.stringify(r.toast)}\n    debits started: ${debits()}; payment rows: ${rows()}; Iron owes $${owes('iron')}`);
    log(`    Iron's row on A: "${await rowOf(A, 'Iron')}"`);
    check('A1 the office is told the bank debit is on its way (not a red failure)', /on its way/.test(JSON.stringify(r.toast)) && !/✕/.test(JSON.stringify(r.toast)), JSON.stringify(r.toast));

    log(`\nA2. Stripe: payment_intent.processing for pi_1 → the real webhook`);
    const w2 = webhook('payment_intent.processing', 'pi_1');
    log(`    webhook HTTP ${w2.status}; payment rows: ${rows()}; Iron owes $${owes('iron')}`);

    log(`\nA3. Computer B (another staff member, or A tomorrow): Billing`);
    const B = await office();
    log(`    Iron's row: "${await rowOf(B, 'Iron')}"`);
    log(`    Iron's family page: ${JSON.stringify(await familyPage(B, 'iron'))}`);
    r = await chargeCard(B, 'iron');
    log(`    Charge Card → the window: "${r.win}"\n    toast: ${JSON.stringify(r.toast)}; debits: ${debits()}`);
    check('A3 a second debit is not started from computer B', nFrom('cus_iron') === 1, debits());

    log(`\nA3s. The server's own guard: computer C, whose page has NO row for the debit (as if neither A's save nor the webhook had arrived)`);
    db.sql(`UPDATE camp_payments SET deleted_at = now() WHERE camp_id='${CAMP}' AND payment_id LIKE 'pi_pi_1%'`);
    const C = await office();
    log(`    Iron's row on C: "${await rowOf(C, 'Iron')}"`);
    r = await chargeCard(C, 'iron');
    log(`    Charge Card → the window: "${r.win}"\n    toast: ${JSON.stringify(r.toast)}; debits: ${debits()}; payment rows now: ${rows()}`);
    check('A3s stripe-charge asks Stripe and refuses a second debit', nFrom('cus_iron') === 1, debits());
    db.sql(`UPDATE camp_payments SET deleted_at = NULL WHERE camp_id='${CAMP}' AND payment_id LIKE 'pi_pi_1%' AND NOT EXISTS (SELECT 1 FROM camp_payments x WHERE x.camp_id='${CAMP}' AND x.payment_id LIKE 'pi_pi_1%' AND x.deleted_at IS NULL)`);

    log(`\nA4. Computer B: Batch charge (Iron owes $1,000 with a debit on its way; Gold owes $200 by card; Steel owes $700 by bank)`);
    await B.reload({ waitUntil: 'domcontentloaded' });
    await B.waitForFunction(() => window.CampistryMe && window.CampistryDB && window.CampistryDB.getCampId(), null, { timeout: 30000 });
    await B.evaluate(() => {
      const inv = async (fn, o) => { const r = await window.__tedEdge(fn, o && o.body);
        if (r.status >= 400) return { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status: r.status, json: async () => r.body } } };
        return { data: r.body, error: null }; };
      window.CampistryDB.client.functions.invoke = inv;
      const c2 = window.CampistryDB.getClient && window.CampistryDB.getClient(); if (c2 && c2.functions) c2.functions.invoke = inv;
      window.CampistryMe.nav('billing');
    });
    await new Promise(r => setTimeout(r, 3000));
    await B.evaluate(() => { window.__toasts = window.__toasts || []; const tM = document.getElementById('tM'), tI = document.getElementById('tI');
      if (tM && !window.__tobs) { window.__tobs = new MutationObserver(() => { if (tM.textContent) window.__toasts.push(((tI && tI.textContent) || '') + ' ' + tM.textContent); }); window.__tobs.observe(tM, { childList: true, characterData: true, subtree: true }); }
      const m = document.getElementById('dynModal'); if (m) m.remove(); });
    await B.evaluate(() => window.CampistryMe.batchCharge());
    await new Promise(r => setTimeout(r, 1200));
    const bw = await modalText(B);
    log(`    the batch window: "${bw}"`);
    const tb = (await toastsOf(B)).length;
    if (await B.$('#dynModalSave')) { await B.click('#dynModalSave'); await new Promise(r => setTimeout(r, 9000)); }
    log(`    toast: ${JSON.stringify((await toastsOf(B)).slice(tb).slice(-1))}; debits: ${debits()}`);
    check('A4 Batch charge leaves Iron out and names it', nFrom('cus_iron') === 1 && /Iron/.test(bw) && /on its way/.test(bw), debits());

    log(`\nA5. The bank settles Iron's debit (payment_intent.succeeded), then Stripe re-delivers the old "processing" event late`);
    db.sql(`UPDATE ted_pis SET status='succeeded' WHERE id=1`);
    const w5 = webhook('payment_intent.succeeded', 'pi_1');
    log(`    succeeded → HTTP ${w5.status}; rows: ${rows()}; Iron owes $${owes('iron')}`);
    const w5b = webhook('payment_intent.processing', 'pi_1');
    log(`    late processing → HTTP ${w5b.status}; rows: ${rows()}; Iron owes $${owes('iron')}`);
    check('A5 a late "processing" does not turn the paid row back to pending', /pi_pi_1 \$1000(\.00)? succeeded/.test(rows()) && owes('iron') === 0, rows());

    const steelId = Number(q1(`SELECT coalesce(max(id),0) FROM ted_pis`)) + 1;
    log(`\nA6. Steel (bank default) owes $${owes('steel')}. ${nFrom('cus_steel') ? 'Steel\'s debit was started by the batch: ' + q1(`SELECT string_agg('pi_' || id, ',') FROM ted_pis WHERE customer='cus_steel'`) : 'Computer B → Charge Card $700'}`);
    if (!nFrom('cus_steel')) { r = await chargeCard(B, 'steel'); log(`    toast: ${JSON.stringify(r.toast)}`); }
    const sPi = 'pi_' + q1(`SELECT min(id) FROM ted_pis WHERE customer='cus_steel'`);
    log(`    webhook processing → HTTP ${webhook('payment_intent.processing', sPi).status}; rows: ${rows()}`);
    db.sql(`UPDATE ted_pis SET status='requires_payment_method' WHERE id=${Number(sPi.replace('pi_', ''))}`);
    log(`    the bank returns it (R01): payment_intent.payment_failed → HTTP ${webhook('payment_intent.payment_failed', sPi).status}; rows: ${rows()}; Steel owes $${owes('steel')}`);
    const w6 = webhook('payment_intent.processing', sPi);
    log(`    Stripe re-delivers the old "processing" event late → HTTP ${w6.status}; rows: ${rows()}; Steel owes $${owes('steel')}`);
    const D = await office();
    log(`    Computer D → Steel's row: "${await rowOf(D, 'Steel')}"`);
    log(`    Steel's family page: ${JSON.stringify(await familyPage(D, 'steel'))}`);
    r = await chargeCard(D, 'steel');
    log(`    Charge Card → the window: "${r.win}"\n    toast: ${JSON.stringify(r.toast)}; Steel's debits: ${q1(`SELECT string_agg('pi_' || id || ' ' || status, ', ' ORDER BY id) FROM ted_pis WHERE customer='cus_steel'`)}`);
    const steelRow = q1(`SELECT coalesce(payload->>'status','') FROM camp_payments WHERE camp_id='${CAMP}' AND payment_id = 'pi_${sPi}' AND deleted_at IS NULL`);
    check('A6 a returned debit stays "failed" after a late "processing", so the office can charge Steel again', steelRow === 'failed' && nFrom('cus_steel') === 2,
      `row status "${steelRow}", Steel's debits ${nFrom('cus_steel')}`);
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
