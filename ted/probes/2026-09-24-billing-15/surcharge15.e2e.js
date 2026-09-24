// Probe (14th pass, TED-141 re-check + hunt). The REAL Me page (Billing) in a
// real browser (the project's smoke harness: real migrations on a throwaway
// Postgres), its refund calls answered by the REAL stripe-refund and its
// webhook by the REAL stripe-webhook in Node against the SAME database, with a
// pretend Stripe that follows Stripe's documented rules. The camp surcharges
// credit cards 3%.
//
//   S1 Silver paid $1,030 by card ($1,000 tuition + the $30 surcharge). The
//      office refunds $1,000 (Direct Refund). The preview before pressing, what
//      goes back to the card, the fee's share taken off the bill, the toast.
//   S2 Bronze: a $500 card deposit at registration (no surcharge), then the
//      $3,000 balance by credit card with a $90 surcharge ($3,090). Bronze
//      withdraws; the deposit is kept and the $3,090 payment is refunded in
//      full. The card brands' rule is per payment: a surcharged payment refunded
//      in full returns its whole surcharge ($90).
//   S3 Copper: the surcharged $1,030 card payment first, then $2,000 by bank
//      (no surcharge). The office refunds $500 — Billing draws it newest-first,
//      so from the bank payment. The surcharged payment is untouched.
//   S4 Silver again, fresh: refund $1,000 → then Stripe FAILS that refund and
//      278 puts the $1,000 back. What does Silver's account say now? Then the
//      office refunds again (TED-136's path).
//   15th pass (this copy): the real 281 functions are wired to the webhook
//   (undo_card_fee_return, release_refund_failure_alert), and new cases:
//   S5 Pewter: two card payments after one fee; a refund that spans both —
//      the window's preview against what is really credited
//   S6 Tin: three partial refunds of one surcharged $1,030 payment ($300, $300,
//      $430) — do the fee credits add up to exactly the $30 fee?
//   S7 the camp switches to a flat $5 "Online payment fee" (convenience fee,
//      which the rules allow on bank payments too): Zinc (bank default, a
//      credit card also saved) and Nickel (credit card default)
// Run: node ted/probes/2026-09-24-billing-15/surcharge15.e2e.js
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
const F = require(path.join(R, 'campistry_card_fees.js'));

const PORT = 8205;
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
  const db = boot({ port: 5675 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  log('postgres up with ' + db.applied.length + ' migrations applied');
  const q1 = (s) => db.sql(s).trim();
  const day = (n) => ({ at: Date.now() - n * 86400000, date: new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) });
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');
          CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
          CREATE TABLE ted_charge (ref text PRIMARY KEY, customer text, amount int, refunded int NOT NULL DEFAULT 0);
          CREATE TABLE ted_refunds (id serial, pi text, cents int, status text NOT NULL DEFAULT 'succeeded', created bigint, meta jsonb);`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const fee = (id, amt, base, d) => ({ id, category: 'Card Fee', description: F.disclosure(POLICY), amount: amt, date: d, cardFee: { mode: 'surcharge', base, reason: 'surcharge', funding: 'credit' } });
  const families = {}, pays = [];
  const addFam = (key, name, cus, charges, pieces) => {
    const entries = [];
    charges.forEach((c, i) => entries.push(c.cardFee ? { id: 'le_chg_' + c.id, kind: 'charge', amount: c.amount, reason: 'card_fee', date: c.date, source: { chargeId: c.id } }
                                                     : { id: 'le_t_' + key + i, kind: 'charge', amount: c.amount, reason: 'tuition', date: c.date }));
    pieces.forEach(p => { entries.push({ id: 'le_pay_pi_' + p.pi, kind: 'payment', amount: p.amount, reason: 'card', date: p.d.date, by: 'system', source: { paymentId: 'pi_' + p.pi } });
      pays.push({ id: 'pi_' + p.pi, family: name, familyKey: key, amount: p.amount, date: p.d.date, method: p.method, stripePaymentIntentId: p.pi, status: 'succeeded', timestamp: p.d.at });
      db.sql(`INSERT INTO ted_charge (ref, customer, amount) VALUES ('${p.pi}', '${cus}', ${Math.round(p.amount * 100)});`); });
    families[key] = { name, camperIds: [name + ' Kid'], stripeCustomerId: cus, cardOnFile: true, charges: charges.filter(c => c.cardFee), entries };
  };
  const d10 = day(10), d20 = day(20), d5 = day(5), d60 = day(60);
  addFam('silver', 'Silver', 'cus_silver', [{ amount: 1000, date: d10.date }, fee('sur_s', 30, 1000, d10.date)],
    [{ pi: 'pi_S', amount: 1030, d: d10, method: 'Card' }]);
  addFam('bronze', 'Bronze', 'cus_bronze', [{ amount: 3500, date: d60.date }, fee('sur_b', 90, 3000, d10.date)],
    [{ pi: 'pi_Bdep', amount: 500, d: d60, method: 'Card' }, { pi: 'pi_Bbal', amount: 3090, d: d10, method: 'Card' }]);
  addFam('copper', 'Copper', 'cus_copper', [{ amount: 3000, date: d20.date }, fee('sur_c', 30, 1000, d20.date)],
    [{ pi: 'pi_Ccard', amount: 1030, d: d20, method: 'Card' }, { pi: 'pi_Cbank', amount: 2000, d: d5, method: 'ACH' }]);
  addFam('slate', 'Slate', 'cus_slate', [{ amount: 1000, date: d10.date }, fee('sur_t', 30, 1000, d10.date)],
    [{ pi: 'pi_T', amount: 1030, d: d10, method: 'Card' }]);
  const d30 = day(30), d3 = day(3);
  addFam('pewter', 'Pewter', 'cus_pewter', [{ amount: 1500, date: d30.date }, fee('sur_p', 30, 1000, d30.date)],
    [{ pi: 'pi_P1', amount: 1030, d: d30, method: 'Card' }, { pi: 'pi_P2', amount: 500, d: d3, method: 'Card' }]);
  addFam('tin', 'Tin', 'cus_tin', [{ amount: 1000, date: d10.date }, fee('sur_n', 30, 1000, d10.date)],
    [{ pi: 'pi_N', amount: 1030, d: d10, method: 'Card' }]);
  addFam('zinc', 'Zinc', 'cus_zinc', [{ amount: 1000, date: d10.date }], []);
  addFam('nickel', 'Nickel', 'cus_nickel', [{ amount: 1000, date: d10.date }], []);
  Object.assign(families.zinc, { stripePaymentMethodId: 'pm_zbank', savedPaymentMethods: [
    { id: 'x1', type: 'us_bank_account', processor: 'stripe', token: 'pm_zbank', stripeCustomerId: 'cus_zinc', last4: '6789', label: 'Chase ···· 6789' },
    { id: 'x2', type: 'card', processor: 'stripe', token: 'pm_zvisa', stripeCustomerId: 'cus_zinc', last4: '1111', label: 'Visa ···· 1111', funding: 'credit' }] });
  Object.assign(families.nickel, { stripePaymentMethodId: 'pm_nvisa', savedPaymentMethods: [
    { id: 'x3', type: 'card', processor: 'stripe', token: 'pm_nvisa', stripeCustomerId: 'cus_nickel', last4: '4444', label: 'Visa ···· 4444', funding: 'credit' }] });
  kv('campistryMe', { families, enrollSettings: { cardFeePolicy: POLICY } });
  pays.forEach(p => db.sql(`SELECT public.camp_payment_add('${CAMP}', ${lit(JSON.stringify(p))}::jsonb);`));

  // ── the pretend Stripe ──────────────────────────────────────────────────
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
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));
  const openMe = async () => {
    await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await wire();
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await waitFor('the families on the page', () => page.evaluate(() => /Silver/.test(document.body.textContent)), 30000);
    await new Promise(r => setTimeout(r, 2500));
  };
  const refundWindow = async (fk, amt) => {
    await page.evaluate((k) => window.CampistryMe.issueCreditForFamily(k), fk);
    await page.waitForSelector('#crType', { timeout: 10000 });
    await page.selectOption('#crType', 'refund_gateway');
    await new Promise(r => setTimeout(r, 500));
    if (amt != null) { await page.fill('#crRefundAmount', String(amt)); await page.evaluate(() => window.CampistryMe._crUpdateBalancePreview()); }
    return { summary: (await page.textContent('#crRefundSummary')).replace(/\s+/g, ' ').trim(),
             preview: (await page.textContent('#crBalancePreview')).replace(/\s+/g, ' ').trim() };
  };
  const press = async () => {
    await page.click('#dynModalSave');
    await waitFor('the refund answer', async () => (await toasts()).some(t => /Refunded|Refund failed|error/i.test(t)), 20000).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    return (await toasts()).slice(-1);
  };
  const owes = (k) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${k}'))`));
  const feeCredits = (k) => q1(`SELECT coalesce(string_agg('$' || (e->>'amount'), ' + '), 'none') FROM jsonb_array_elements(public.camp_family('${CAMP}','${k}')->'entries') e WHERE e->>'kind' = 'credit'`);
  const sentTo = (pi) => q1(`SELECT coalesce(string_agg('re_' || id || ' $' || (cents/100.0) || ' ' || status, ', ' ORDER BY id), 'none') FROM ted_refunds WHERE pi='${pi}'`);
  const back = (pis) => Number(q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_refunds WHERE status <> 'failed' AND pi IN (${pis.map(p => `'${p}'`).join(',')})`));

  try {
    await openMe();
    log(`\nThe rule (campistry_card_fees.refundShare): a refund of $1,000 of a $1,030 payment returns $${F.refundShare(POLICY, { feeCharged: 30, paymentAmount: 1030, refundAmount: 1000 }).fee}; of all $3,090 of a $3,090 payment: $${F.refundShare(POLICY, { feeCharged: 90, paymentAmount: 3090, refundAmount: 3090 }).fee}`);

    log('\nS1. Silver paid $1,030 by card ($1,000 + $30 surcharge). Office: Direct Refund $1,000');
    log(`    before: Silver owes $${owes('silver')}`);
    let w = await refundWindow('silver', 1000);
    log(`    window: "…${w.summary.slice(w.summary.indexOf('This family'), w.summary.indexOf('This family') + 120)}…"\n    preview before pressing: "${w.preview}"`);
    let t = await press();
    log(`    toast: ${JSON.stringify(t)}\n    Stripe: ${sentTo('pi_S')}; credits on Silver's bill: ${feeCredits('silver')}; Silver now owes $${owes('silver')}`);
    check('S1 $1,000 goes back to the card once; $29.13 of the fee comes off the bill; Silver owes $970.87', back(['pi_S']) === 1000 && Math.abs(owes('silver') - 970.87) < 0.005,
      `owes ${owes('silver')}`);
    check('S1b the preview before pressing said what Silver would owe afterwards', /970\.87/.test(w.preview), `preview "${w.preview}", afterwards $${owes('silver')}`);

    log('\nS2. Bronze: $500 card deposit (no surcharge) 60 days ago; $3,090 by credit card 10 days ago ($3,000 + $90 surcharge). Withdraws; the deposit is kept; office refunds the whole $3,090 payment');
    log(`    before: Bronze owes $${owes('bronze')}`);
    w = await refundWindow('bronze', 3090);
    t = await press();
    log(`    toast: ${JSON.stringify(t)}\n    Stripe: deposit ${sentTo('pi_Bdep')}; balance payment ${sentTo('pi_Bbal')}; credits on Bronze's bill: ${feeCredits('bronze')}; Bronze now owes $${owes('bronze')}`);
    const bronzeFee = 90 - (Number((feeCredits('bronze').match(/\$([\d.]+)/) || [])[1]) || 0);
    check('S2 the surcharged $3,090 payment is refunded in full, so its whole $90 surcharge comes off the bill (Bronze keeps none of it)',
      back(['pi_Bbal']) === 3090 && Math.abs(bronzeFee) < 0.005, `the card got $${back(['pi_Bbal'])} back from the surcharged payment, but $${bronzeFee.toFixed(2)} of its surcharge is still on Bronze's bill`);

    log('\nS3. Copper: $1,030 by credit card 20 days ago ($1,000 + $30 surcharge), then $2,000 by bank 5 days ago. Office refunds $500');
    log(`    before: Copper owes $${owes('copper')}`);
    w = await refundWindow('copper', 500);
    t = await press();
    log(`    toast: ${JSON.stringify(t)}\n    Stripe: card payment ${sentTo('pi_Ccard')}; bank payment ${sentTo('pi_Cbank')}; credits on Copper's bill: ${feeCredits('copper')}; Copper now owes $${owes('copper')}`);
    check('S3 the $500 came from the bank payment (newest first), so none of the card surcharge is returned',
      sentTo('pi_Ccard') === 'none' && feeCredits('copper') === 'none', `card payment refunds: ${sentTo('pi_Ccard')}; fee credits: ${feeCredits('copper')}`);

    log('\nS4. Slate paid $1,030 by card ($1,000 + $30 surcharge). Office refunds $1,000; three days later Stripe FAILS that refund');
    await refundWindow('slate', 1000);
    t = await press();
    log(`    toast: ${JSON.stringify(t)}; Slate owes $${owes('slate')}; credits ${feeCredits('slate')}`);
    const rid = Number(q1(`SELECT max(id) FROM ted_refunds WHERE pi='pi_T'`));
    db.sql(`UPDATE ted_refunds SET status='failed', created = created - 3*86400 WHERE id=${rid}; UPDATE ted_charge SET refunded = refunded - 100000 WHERE ref='pi_T'; DELETE FROM ted_keys;`);
    const obj = JSON.parse(q1(`SELECT json_build_object('id','re_'||id,'object','refund','amount',cents,'payment_intent',pi,'charge','ch_'||pi,'status',status,'failure_reason','expired_or_canceled_card','metadata',meta,'created',created)::text FROM ted_refunds WHERE id=${rid}`));
    const wh = webhook({ id: 'evt_s4', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: obj } });
    log(`    refund.failed → the real webhook → HTTP ${wh.status}; Stripe: ${sentTo('pi_T')}`);
    log(`    Slate's account after the put-back: owes $${owes('slate')} (before the refund: $0 — nothing reached the card); credits ${feeCredits('slate')}`);
    check('S4 after the failed refund is put back, Slate is where it was before the refund (owes $0, the whole $30 surcharge still on the bill)',
      Math.abs(owes('slate')) < 0.005, `Slate shows a credit of $${(-owes('slate')).toFixed(2)} — the surcharge share of a refund that never happened`);
    await openMe();
    await refundWindow('slate', 1000);
    t = await press();
    log(`    the office refunds $1,000 again: ${JSON.stringify(t)}; Stripe: ${sentTo('pi_T')}; credits ${feeCredits('slate')}; Slate owes $${owes('slate')}`);
    check('S4b after the second (successful) $1,000 refund, Slate owes what one refund of $1,000 leaves ($970.87)', Math.abs(owes('slate') - 970.87) < 0.005,
      `fee credits ${feeCredits('slate')}; charges back on the bill: ${q1(`SELECT coalesce(string_agg((e->>'id') || ' $' || (e->>'amount'), ', '), 'none') FROM jsonb_array_elements(public.camp_family('${CAMP}','slate')->'entries') e WHERE e->>'id' LIKE 'le_chg_cfr_undo%'`)}; owes $${owes('slate')}`);
    const wh2 = webhook({ id: 'evt_s4r', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: obj } });
    log(`    Stripe re-delivers the first failure → HTTP ${wh2.status}; Slate owes $${owes('slate')}`);
    check('S4c a re-delivered failure changes nothing', Math.abs(owes('slate') - 970.87) < 0.005, `owes $${owes('slate')}`);

    log('\nS5. Pewter: $30 surcharge on $1,000 (30 days ago), paid $1,030 by card that day, then $500 more by card 3 days ago. Office refunds $800 (Billing takes it newest-first: $500 from the second payment, $300 from the first)');
    log(`    before: Pewter owes $${owes('pewter')}`);
    w = await refundWindow('pewter', 800);
    log(`    preview before pressing: "${w.preview}"`);
    t = await press();
    log(`    toast: ${JSON.stringify(t)}\n    Stripe: first ${sentTo('pi_P1')}; second ${sentTo('pi_P2')}; credits: ${feeCredits('pewter')}; Pewter owes $${owes('pewter')}`);
    const pvOwe = Number(((w.preview.match(/refund: \$([\d,.-]+)/) || [])[1] || 'NaN').replace(/,/g, ''));
    check('S5 the preview matches the result', Math.abs(pvOwe - owes('pewter')) < 0.005, `preview $${pvOwe}, result $${owes('pewter')}`);
    const rule = F.refundShare(POLICY, { feeCharged: 30, paymentAmount: 1030, refundAmount: 300 }).fee;
    check('S5b only the $300 from the surcharged payment returns fee ($' + rule + ' by the card-fee rule)', feeCredits('pewter') === '$' + rule, `credits ${feeCredits('pewter')}`);

    log('\nS6. Tin paid $1,030 by card ($1,000 + $30). Three partial refunds: $300, $300, then the last $430');
    for (const a of [300, 300, 430]) { await openMe(); await refundWindow('tin', a); t = await press(); log(`    $${a}: ${JSON.stringify(t)}; credits ${feeCredits('tin')}; owes $${owes('tin')}`); }
    const tinFee = q1(`SELECT coalesce(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(public.camp_family('${CAMP}','tin')->'entries') e WHERE e->>'kind' = 'credit'`);
    check('S6 the three refunds return exactly the $30 fee between them; Tin owes $1,000 (the tuition, nothing paid)', Number(tinFee) === 30 && Math.abs(owes('tin') - 1000) < 0.005,
      `fee credits total $${tinFee}; owes $${owes('tin')}; Stripe ${sentTo('pi_N')}`);

    log('\nS7. The camp switches Card Fees to a flat $5 "Online payment fee" (a convenience fee — the rules allow it on bank payments too)');
    const conv = { mode: 'convenience', convenienceFlat: 5, onlineOnly: true, state: 'NY' };
    const me = JSON.parse(q1(`SELECT value::text FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistryMe'`));
    me.enrollSettings = Object.assign({}, me.enrollSettings || {}, { cardFeePolicy: conv });
    kv('campistryMe', me);
    await openMe();
    const toastT = async () => (await toasts()).slice(-1);
    for (const fk of ['zinc', 'nickel']) {
      await page.evaluate((k) => window.CampistryMe.addCardSurcharge(k), fk);
      await page.waitForSelector('#csBase', { timeout: 10000 });
      await page.fill('#csBase', '1000'); await page.evaluate(() => window.CampistryMe._surchargePreview());
      const win = (await page.textContent('#dynModal')).replace(/\s+/g, ' ').trim().slice(0, 260);
      await page.click('#dynModalSave'); await new Promise(r => setTimeout(r, 2500));
      log(`    ${fk}: window "${win}"\n        toast ${JSON.stringify(await toastT())}; ${fk}'s fee charges: ${q1(`SELECT coalesce(string_agg((e->>'reason') || ' $' || (e->>'amount'), ', '), 'none') FROM jsonb_array_elements(public.camp_family('${CAMP}','${fk}')->'entries') e WHERE e->>'kind'='charge' AND e->>'reason' <> 'tuition'`)}`);
      await page.evaluate(() => { const m = document.getElementById('dynModal'); if (m) m.remove(); });
    }
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
