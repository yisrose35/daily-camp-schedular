// Probe (13th pass, TED-132 re-check). The REAL Me page (Billing) in a real
// browser (Playwright + Chromium, the project's smoke harness: real migrations
// on a throwaway Postgres), its edge-function calls run by the REAL edge
// functions (stripe-refund, stripe-webhook) in Node against the SAME database,
// with a pretend Stripe that follows Stripe's documented rules (an
// Idempotency-Key replays its first answer, marked Idempotent-Replayed; keys
// forgotten after 24 h; GET /refunds/{id} shows the refund as it is NOW; a
// refund can fail days later and the charge becomes refundable again).
//
//   B1  Gold paid $500 by card. The office refunds $500: Billing → Issue
//       Credit/Refund → Direct Refund → $500 → Save.
//   B2  Three days later Stripe fails that refund (card closed) and sends
//       refund.failed → the real webhook → the real 278 puts it back and tells
//       the office "refund it again from Billing".
//   B3  The office does exactly that: reloads Me, Billing → Issue Credit/Refund
//       → Direct Refund. What does the window offer? They press Save for the
//       amount it offers. Does the parent get $500? What do the books say?
//   B4  They press it again (the window still offers it).
//   B5  Control: the same, but for $300 instead of $500.
// Run: node ted/probes/2026-09-24-billing-13/billing_refund_again.e2e.js
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

const PORT = 8181;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const PI = 'pi_GOLD1';
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
  const db = boot({ port: 5641 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  log('postgres up with ' + db.applied.length + ' migrations applied');
  const q1 = (s) => db.sql(s).trim();
  const paidAt = Date.now() - 30 * 86400000;
  const paidDate = new Date(paidAt).toISOString().slice(0, 10);
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');
          CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
          CREATE TABLE ted_charge (ref text PRIMARY KEY, camp text, amount int, refunded int NOT NULL DEFAULT 0);
          CREATE TABLE ted_refunds (id serial, camp text, pi text, cents int, status text NOT NULL DEFAULT 'succeeded', created bigint, meta jsonb);
          INSERT INTO ted_charge (ref, camp, amount) VALUES ('${PI}', '${CAMP}', 50000);`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  // Gold: $500 tuition, paid $500 by card a month ago (the way Stripe checkout books it)
  const fam = { name: 'Gold', camperIds: ['Dov Gold'], stripeCustomerId: 'cus_gold',
    entries: [{ id: 'le_t', kind: 'charge', amount: 500, reason: 'tuition', date: paidDate },
              { id: 'le_pay_pi_' + PI, kind: 'payment', amount: 500, reason: 'card', date: paidDate, by: 'system', source: { paymentId: 'pi_' + PI } }] };
  kv('campistryMe', { families: { gold: fam } });
  db.sql(`SELECT public.camp_payment_add('${CAMP}', ${lit(JSON.stringify({ id: 'pi_' + PI, family: 'Gold', familyKey: 'gold', amount: 500, date: paidDate,
    method: 'Card', stripePaymentIntentId: PI, status: 'succeeded', timestamp: paidAt }))}::jsonb);`);

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
      const r = JSON.parse(__qq("INSERT INTO ted_refunds (camp, pi, cents, created, meta) VALUES ('${CAMP}','" + __esc(pi) + "'," + cents + ", extract(epoch from now())::bigint, '" + __esc(JSON.stringify(meta)) + "'::jsonb) RETURNING row_to_json(ted_refunds)::text"));
      __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + __esc(pi) + "'");
      resp = __refObj(r);
    }
    if (k) __qq("INSERT INTO ted_keys (k, body, resp, status) VALUES ('" + __esc(k) + "','" + __esc(body) + "','" + __esc(JSON.stringify(resp)) + "'::jsonb," + status + ")");
    return Object.assign({ __status: status }, resp);
  }
  const one = url.match(/\\/refunds\\/re_(\\d+)$/);
  if (one && init.method !== 'POST') { const r = JSON.parse(__qq("SELECT row_to_json(x)::text FROM ted_refunds x WHERE id=" + Number(one[1])) || 'null');
    return r ? __refObj(r) : { __status: 404, error: { type: 'invalid_request_error', message: 'No such refund' } }; }
  if (url.includes('/refunds?')) {
    const pi = decodeURIComponent((url.split('payment_intent=')[1] || '').split('&')[0]);
    const rows = JSON.parse(__qq("SELECT coalesce(json_agg(r ORDER BY id DESC), '[]'::json)::text FROM ted_refunds r WHERE pi='" + __esc(pi) + "'"));
    return { object: 'list', data: rows.map(__refObj), has_more: false };
  }
  if (url.includes('/payment_intents/')) { const id = decodeURIComponent(url.split('/payment_intents/')[1].split('?')[0]);
    return { id, object: 'payment_intent', customer: 'cus_gold', transfer_data: null, metadata: {} }; }
  return {};
};`;
  const RPCS = ['claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'camp_families_object',
    'reverse_failed_stripe_refund', 'record_external_refund'];
  const BR = bridge(db, RPCS, ['refund_intents']);
  const edgeCalls = [];
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
    edgeCalls.push({ fn, status: res.status, answer: JSON.stringify(res.body).slice(0, 200), emails: (r.emails || []).map(e => e.subject) });
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
    // the family and its payments, from their rows
    await waitFor('Gold and the payment rows on the page', () => page.evaluate(() => {
      try { return !!document.querySelector('#page-billing') && /Gold/.test(document.body.textContent); } catch (_) { return false; } }), 30000);
    await new Promise(r => setTimeout(r, 2500));
  };
  const refundWindow = async () => {
    await page.evaluate(() => window.CampistryMe.issueCreditForFamily('gold'));
    await page.waitForSelector('#crType', { timeout: 10000 });
    await page.selectOption('#crType', 'refund_gateway');
    await new Promise(r => setTimeout(r, 500));
    return { summary: (await page.textContent('#crRefundSummary')).replace(/\s+/g, ' ').trim(),
             amount: await page.inputValue('#crRefundAmount') };
  };
  const pressRefund = async (amt) => {
    if (amt != null) { await page.fill('#crRefundAmount', String(amt)); }
    const before = (await toasts()).length;
    await page.click('#dynModalSave');
    await waitFor('the refund answer', async () => (await toasts()).some(t => /Refunded|Refund failed|refundable|error/i.test(t)), 20000).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));      // the save to the cloud
    const t = await toasts();
    return t.slice(-2);
  };
  const stripeMoney = () => ({
    back: Number(q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_refunds WHERE status <> 'failed'`)),
    made: q1(`SELECT coalesce(string_agg('re_' || id || ' $' || (cents/100) || ' ' || status, ', ' ORDER BY id), 'none') FROM ted_refunds`),
  });
  const books = () => ({
    owes: Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','gold'))`)),
    rows: q1(`SELECT string_agg(payment_id || ' $' || amount || coalesce(' [' || (payload->>'stripeRefundId') || ']', ''), ', ' ORDER BY ordinal) FROM camp_payments WHERE camp_id='${CAMP}' AND deleted_at IS NULL`),
    refundRows: Number(q1(`SELECT count(*) FROM camp_payments WHERE camp_id='${CAMP}' AND deleted_at IS NULL AND amount < 0`)),
    ledgerRefunds: q1(`SELECT coalesce(string_agg((e->>'kind') || ':' || (e->>'amount'), ', '), '') FROM jsonb_array_elements(public.camp_family('${CAMP}','gold')->'entries') e WHERE e->>'kind' IN ('refund') OR e->>'reason' = 'refund_failed'`),
  });
  const say = (label) => { const s = stripeMoney(), b = books();
    log(`    ${label}: Stripe sent back $${s.back} [${s.made}] | books: Gold owes $${b.owes}; payment rows [${b.rows}]`); return { s, b }; };
  const billingRow = async () => page.evaluate(() => { try { window.CampistryMe.nav('billing'); } catch (_) {}
    const tr = [...document.querySelectorAll('#page-billing tr')].find(x => /Gold/.test(x.textContent));
    return tr ? tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : '(no Gold row)'; });

  try {
    log(`SETUP: Gold paid $500 tuition by card (${PI}) on ${paidDate}.`);
    await openMe();
    say('start');

    log('\nB1. The office refunds $500: Billing → Issue Credit/Refund → Direct Refund — back to card/bank');
    let w = await refundWindow();
    log(`    window: "${w.summary.slice(0, 120)}" | amount "${w.amount}"`);
    let t = await pressRefund();
    log(`    toast: ${JSON.stringify(t)}`);
    const s1 = say('after B1');
    check('B1 the first refund goes to Stripe once ($500 back)', s1.s.back === 500, '');

    log('\nB2. Three days later Stripe FAILS that refund (the card account was closed) and sends refund.failed');
    db.sql(`UPDATE ted_refunds SET created = created - 3*86400; UPDATE ted_keys SET resp = jsonb_set(resp, '{created}', to_jsonb((resp->>'created')::bigint - 3*86400)) WHERE resp ? 'created';
            DELETE FROM ted_keys;   -- older than 24 h: Stripe has forgotten the key
            UPDATE ted_refunds SET status = 'failed' WHERE id = 1; UPDATE ted_charge SET refunded = refunded - 50000 WHERE ref = '${PI}';`);
    const refObj = JSON.parse(q1(`SELECT json_build_object('id','re_'||id,'object','refund','amount',cents,'payment_intent',pi,'charge','ch_'||pi,'status',status,'failure_reason','expired_or_canceled_card','metadata',meta,'created',created)::text FROM ted_refunds WHERE id=1`));
    const wh = webhook({ id: 'evt_b2', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: refObj } });
    const notice = q1(`SELECT coalesce(max(body), '') FROM notifications WHERE camp_id='${CAMP}' AND source='refund_failed'`);
    log(`    webhook → HTTP ${wh.status}; the office's notice: "${notice.slice(0, 260)}"`);
    const s2 = say('after the put-back');
    check('B2 the failed $500 is put back once', wh.status === 200 && /refail_/.test(s2.b.rows), '');

    log('\nB3. The office does what the notice says: reload Me → Billing → Issue Credit/Refund → Direct Refund → Save');
    await openMe();
    log(`    Billing's row for Gold before pressing: "${await billingRow()}"`);
    w = await refundWindow();
    log(`    window: "${w.summary.slice(0, 140)}" | amount "${w.amount}"`);
    check('B3a the window offers the put-back $500 again (TED-132)', /\$500 refundable/.test(w.summary) && Number(w.amount) === 500, '');
    t = await pressRefund();
    log(`    toast: ${JSON.stringify(t)}`);
    const s3 = say('after B3');
    log(`    Billing's row for Gold now: "${await billingRow()}"`);
    const intents = q1(`SELECT string_agg(key || ' → ' || coalesce(result::text,'(open)'), ' ; ') FROM refund_intents WHERE camp_id='${CAMP}'`);
    log(`    refund claims: ${intents}`);
    check('B3b pressing Refund for the offered $500 really refunds the parent $500 (Stripe sends $500 back), or says it did not',
      s3.s.back === 500 || !t.some(x => /Refunded \$500 /.test(x)),
      `Stripe sent back $${s3.s.back} in total; the office was told ${JSON.stringify(t)}; payment rows [${s3.b.rows}]`);

    log('\nB4. The window still offers it; the office presses again');
    await openMe();
    w = await refundWindow();
    log(`    window: "${w.summary.slice(0, 140)}" | amount "${w.amount}"`);
    t = await pressRefund();
    log(`    toast: ${JSON.stringify(t)}`);
    const s4 = say('after B4');
    check('B4 a second press does not add another refund that sent nothing', s4.b.refundRows <= 2 || s4.s.back > s3.s.back,
      `refund rows in the books ${s4.b.refundRows}, Stripe sent back $${s4.s.back}`);

    log('\nB5. Control: the office refunds $300 instead of $500');
    await openMe();
    w = await refundWindow();
    t = await pressRefund(300);
    log(`    toast: ${JSON.stringify(t)}`);
    const s5 = say('after B5');
    check('B5 (control) a different amount reaches Stripe: $300 back', s5.s.back === 300, '');
  } catch (e) {
    check('the run finished', false, String(e.message).split('\n')[0]);
  } finally {
    log('\nedge calls: ' + edgeCalls.map(c => `${c.fn}→${c.status} ${c.answer.slice(0, 110)}${c.emails.length ? ' email:' + c.emails[0].slice(0, 60) : ''}`).join('\n   '));
    log('page errors: ' + JSON.stringify(pageErrors));
    await browser.close().catch(() => {});
    await bridgeSrv.close().catch(() => {});
    db.stop();
    log(`\n${bad} BAD`);
  }
})();
