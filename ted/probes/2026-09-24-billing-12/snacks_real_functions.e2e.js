// Probe (12th pass: TED-124 / TED-116 / TED-125 re-check, TED-126 on screen).
// The REAL Snacks page in a real browser (Playwright + Chromium) against a
// throwaway Postgres with every migration (the project's smoke harness), and —
// unlike the builder's test, which answers every edge call with a stand-in —
// the page's edge-function calls are run by the REAL edge functions
// (payments-canteen-refund(-all), stripe-canteen-refund(-all), stripe-webhook)
// in Node against the SAME database, with a pretend Sola and a pretend Stripe
// that follow their documented rules (Stripe: key replay marked
// Idempotent-Replayed, refunds listable/gettable, a refund can fail later).
//
//   S1  Sola camp: a $20 refund whose answer is lost → Refund All window lists
//       it → "It went through" with Sola's real reference. Another lost one →
//       "Nothing went through". What does the office see after each (toast,
//       balance, the Refund window's figure)?
//   S2  Take Out Cash $5: the message and the cleared amount box.
//   S3  Stripe camp: Refund All refunds a $20 Stripe top-up; three days later
//       Stripe fails it and sends refund.failed; the office reloads Snacks and
//       runs Refund All again. What does the window say, and what happens?
//   S4  Stripe camp: a single refund whose answer is lost, the wallet then at
//       $0 → the Refund All window's look-up button → the real look-up.
// Run: node ted/probes/2026-09-24-billing-12/snacks_real_functions.e2e.js
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

const PORT = 8171;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const CAMPER = 'Avi Katz';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const out = [];
const log = (s) => { console.log(s); out.push(s); };
let bad = 0;
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
async function waitFor(what, fn, ms) {
  const until = Date.now() + (ms || 15000); let last;
  while (Date.now() < until) { try { if (await fn()) return true; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 200)); }
  throw new Error('timed out waiting for ' + what + (last ? ' (' + last + ')' : ''));
}

(async () => {
  const db = boot({ port: 5631 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  log('postgres up with ' + db.applied.length + ' migrations applied');
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test');
          UPDATE camps SET payment_processor_key = 'cardknox' WHERE id = '${CAMP}';
          CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
          CREATE TABLE ted_charge (ref text PRIMARY KEY, camp text, amount int, refunded int NOT NULL DEFAULT 0);
          CREATE TABLE ted_refunds (id serial, camp text, pi text, cents int, hold text, status text NOT NULL DEFAULT 'succeeded', created bigint, meta jsonb);
          CREATE TABLE ted_money (id serial, camp text, ref text, cents int);
          CREATE TABLE ted_flags (k text PRIMARY KEY, n int);`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [], settings: { payMethods: ['cash', 'card'], defaultDailyLimit: 0 } });
  const flag = (k, n = 1) => db.sql(`INSERT INTO ted_flags VALUES ('${k}', ${n}) ON CONFLICT (k) DO UPDATE SET n = ${n}`);
  const clearFlags = () => db.sql(`DELETE FROM ted_flags`);
  const wallet = () => Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(CAMPER)}`));
  const holdsDb = () => q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', ' ORDER BY created_at), 'none') FROM canteen_refund_holds WHERE camp_id='${CAMP}'`);
  const ageAll = (i) => db.sql(`UPDATE canteen_refund_holds SET created_at = created_at - interval '${i}' WHERE camp_id='${CAMP}';
      UPDATE refund_intents SET created_at = created_at - interval '${i}', called_at = called_at - interval '${i}' WHERE camp_id='${CAMP}';
      UPDATE ted_refunds SET created = created - extract(epoch from interval '${i}')::bigint;
      UPDATE ted_keys SET resp = jsonb_set(resp, '{created}', to_jsonb((resp->>'created')::bigint - extract(epoch from interval '${i}')::bigint)) WHERE resp ? 'created';`);

  // ── the real edge functions, run in Node against this database ──────────
  const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
    'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent',
    'refund_canteen_deposit_from_stripe', 'record_processor_transaction', 'reverse_failed_stripe_refund'];
  const BR = bridge(db, RPCS, ['refund_intents']);
  const SOLA = `
const __qq = (T as any).__q;
const __flag = (k: string) => { const n = Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='" + k + "'),0)")); if (n > 0) { __qq("UPDATE ted_flags SET n = n - 1 WHERE k='" + k + "'"); return true; } return false; };
T.fetch = async (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    if (__flag('lose_before')) throw new Error('connection reset (never reached)');
    const p = new URLSearchParams(init.body);
    const ref = String(p.get('xRefNum')); const cents = Math.round(Number(p.get('xAmount')) * 100);
    const row = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + ref + "'") || 'null');
    if (!row || row.amount - row.refunded < cents) return 'xResult=E&xStatus=Error&xError=Amount%20exceeds';
    const id = __qq("INSERT INTO ted_money (camp, ref, cents) VALUES ('${CAMP}','" + ref + "'," + cents + ") RETURNING 'RN' || id");
    __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + ref + "'");
    if (__flag('lose')) throw new Error('connection reset');
    return 'xResult=A&xStatus=Approved&xRefNum=' + id;
  }
  return {};
};`;
  const STRIPE = `
const __qq = (T as any).__q;
const __esc = (s: string) => String(s).replace(/'/g, "''");
const __flag = (k: string) => { const n = Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='" + k + "'),0)")); if (n > 0) { __qq("UPDATE ted_flags SET n = n - 1 WHERE k='" + k + "'"); return true; } return false; };
const __refObj = (r: any) => Object.assign({ id: 're_' + r.id, object: 'refund', amount: r.cents, payment_intent: r.pi, charge: 'ch_' + r.pi,
  status: r.status, created: Number(r.created), metadata: Object.assign(r.hold ? { campistryHold: r.hold } : {}, r.meta || {}) },
  r.status === 'failed' ? { failure_reason: 'expired_or_canceled_card' } : {});
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = String(init.headers['Idempotency-Key'] || '');
    const body = String(init.body || '');
    if (__flag('lose_before')) throw new Error('connection reset (never reached Stripe)');
    const seen = JSON.parse(__qq("SELECT json_build_object('body', body, 'resp', resp, 'status', status)::text FROM ted_keys WHERE k='" + __esc(k) + "'") || 'null');
    if (seen) {
      if (seen.body !== body) return { __status: 400, error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } };
      if (__flag('lose')) throw new Error('connection reset');
      return Object.assign({ __status: seen.status }, seen.resp, { __headers: { 'Idempotent-Replayed': 'true' } });
    }
    const p = new URLSearchParams(body);
    const pi = String(p.get('payment_intent')); const cents = Number(p.get('amount'));
    const row = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + __esc(pi) + "'") || 'null');
    let resp: any, status = 200;
    if (!row) { resp = { error: { type: 'invalid_request_error', message: 'No such payment_intent' } }; status = 404; }
    else if (row.amount - row.refunded <= 0) { resp = { error: { type: 'invalid_request_error', message: 'Charge ' + pi + ' has already been refunded.' } }; status = 400; }
    else if (cents > row.amount - row.refunded) { resp = { error: { type: 'invalid_request_error', message: 'Refund amount is greater than unrefunded amount on charge' } }; status = 400; }
    else {
      const r = JSON.parse(__qq("INSERT INTO ted_refunds (camp, pi, cents, hold, created, meta) VALUES ('${CAMP}','" + __esc(pi) + "'," + cents + "," + (p.get('metadata[campistryHold]') ? "'" + __esc(String(p.get('metadata[campistryHold]'))) + "'" : 'NULL') + ", extract(epoch from now())::bigint, '{}'::jsonb) RETURNING row_to_json(ted_refunds)::text"));
      __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + __esc(pi) + "'");
      resp = __refObj(r);
    }
    if (k) __qq("INSERT INTO ted_keys (k, body, resp, status) VALUES ('" + __esc(k) + "','" + __esc(body) + "','" + __esc(JSON.stringify(resp)) + "'::jsonb," + status + ")");
    if (__flag('lose')) throw new Error('connection reset');
    return Object.assign({ __status: status }, resp);
  }
  const one = url.match(/\\/refunds\\/re_(\\d+)$/);
  if (one && init.method !== 'POST') { const r = JSON.parse(__qq("SELECT row_to_json(x)::text FROM ted_refunds x WHERE id=" + Number(one[1])) || 'null');
    return r ? __refObj(r) : { __status: 404, error: { type: 'invalid_request_error', message: 'No such refund' } }; }
  if (url.includes('/refunds?payment_intent=')) {
    const pi = decodeURIComponent(url.split('payment_intent=')[1].split('&')[0]);
    const rows = JSON.parse(__qq("SELECT coalesce(json_agg(r ORDER BY id DESC), '[]'::json)::text FROM ted_refunds r WHERE pi='" + __esc(pi) + "'"));
    return { object: 'list', data: rows.map(__refObj), has_more: false };
  }
  if (url.includes('/payment_intents/')) { const id = decodeURIComponent(url.split('/payment_intents/')[1].split('?')[0]); return { id, transfer_data: null, metadata: { campId: '${CAMP}' } }; }
  return {};
};`;
  let processor = 'cardknox';
  const edgeCalls = [];
  function edge(fn, body, headers) {
    const env = `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', payment_processor_key: '${processor}' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${BR}
${fn.startsWith('stripe') ? STRIPE : SOLA}`;
    const req = headers ? `T.requests = [{ headers: ${JSON.stringify(headers)}, rawBody: ${JSON.stringify(body)} }];`
                        : `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body || {})} }];`;
    const r = runEdges([fn], env + '\n' + req);
    const res = r.responses[0];
    edgeCalls.push({ fn, body, status: res.status, answer: JSON.stringify(res.body).slice(0, 160) });
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
    window.CampistryDB.client.functions.invoke = async (fn, o) => {
      const r = await window.__tedEdge(fn, o && o.body);
      if (r.status >= 400) return { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status: r.status, json: async () => r.body } } };
      return { data: r.body, error: null };
    };
  });
  const open = async (file, ready) => {
    await page.goto('http://localhost:' + PORT + '/' + file, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId(), null, { timeout: 30000 });
    if (ready) await page.waitForFunction(ready, null, { timeout: 30000 });
  };
  const openSnacks = async () => {
    await open('campistry_snacks.html', () => !!window.CampistrySnacks);
    await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
    await wire();
    await page.click('#hamburgerBtn'); await page.click('.sidebar-item[data-page="accounts"]');
    await page.waitForSelector('#page-accounts.active', { timeout: 10000 });
  };
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));
  const shown = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display !== 'none' ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }, id);
  const pageBal = () => page.evaluate((n) => { const a = window.CampistrySnacks.getAccount(n); return a ? Number(a.balance) : null; }, CAMPER);
  const closeAll = () => page.evaluate(() => { ['refundall', 'refund', 'cash'].forEach(m => { try { closeM(m); } catch (_) {} }); });
  const openRefundAll = async () => {
    await closeAll();
    await page.click('button[onclick="openRefundAllModal()"]');
    await waitFor('the Refund All window', () => page.evaluate(() => { const e = document.getElementById('m-refundall'); return e && /open/.test(e.className); }), 10000);
    await waitFor('the preview', async () => !/Working out/.test(await shown('refundAllBody')), 15000);
    await new Promise(r => setTimeout(r, 1500));   // the waiting list comes from its own call
    return { body: await shown('refundAllBody'), holds: await shown('refundAllHolds'),
             btn: await page.evaluate(() => { const b = document.getElementById('refundAllBtn'); return b && getComputedStyle(b).display !== 'none' ? b.textContent : null; }) };
  };
  const openRefundFor = async () => {
    await closeAll();
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^openMFor\('refund'/.test(x.getAttribute('onclick') || '')); if (b) b.click(); });
    await waitFor('the Refund window', () => page.evaluate(() => { const e = document.getElementById('m-refund'); return e && /open/.test(e.className); }), 10000);
    await new Promise(r => setTimeout(r, 1500));
    return { box: await shown('refundBox'), holds: await shown('refundHolds'), amt: await page.evaluate(() => document.getElementById('refundAmt').value) };
  };

  try {
    // ── setup: the camper (Me page), $40 cash (Snacks), $25 paid through Sola ──
    log('SETUP: Avi Katz added on Me; $40 cash deposit in Snacks; $25 paid through Sola (XREF-25)');
    await open('campistry_me.html', () => !!window.CampistryMe);
    await page.waitForFunction(() => { const g = window.loadGlobalSettings && window.loadGlobalSettings(); return !!(g && g.campStructure && g.campStructure.Boys); }, null, { timeout: 30000 });
    await page.evaluate(() => window.CampistryMe.nav('campers'));
    await page.evaluate(() => window.CampistryMe.editCamper(null));
    await page.waitForSelector('#ceFirst', { timeout: 10000 });
    await page.waitForFunction(() => { const s = document.getElementById('ceDiv'); return s && [...s.options].some(o => o.value === 'Boys'); }, null, { timeout: 10000 });
    await page.fill('#ceFirst', 'Avi'); await page.fill('#ceLast', 'Katz');
    await page.selectOption('#ceDiv', 'Boys'); await page.selectOption('#ceCGrade', 'Junior'); await page.selectOption('#ceBunk', 'J1');
    await page.click('#ceSave');
    await page.waitForSelector('#camperEditModal', { state: 'hidden', timeout: 10000 });
    await waitFor('the roster saved with a camper number', () => { const r = db.json(`SELECT value FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='app1'`);
      const rec = r.length && r[0].value.camperRoster && r[0].value.camperRoster[CAMPER]; return rec && Number(rec.camperId) > 0; }, 30000);
    await openSnacks();
    await page.click('button[onclick="openM(\'dep\')"]');
    await page.waitForSelector('#m-dep', { state: 'visible', timeout: 10000 });
    await page.selectOption('#depCamper', CAMPER); await page.fill('#depAmt', '40'); await page.selectOption('#depMethod', 'cash');
    await page.click('button[onclick="addDep()"]');
    await waitFor('the cash deposit', () => wallet() === 40, 30000);
    db.json(`SELECT public.credit_canteen_balance_from_processor(p_camp_id => '${CAMP}', p_camper_name => ${lit(CAMPER)}, p_amount => 25, p_processor_key => 'cardknox', p_external_transaction_id => 'XREF-25') AS r`);
    db.sql(`INSERT INTO ted_charge (ref, camp, amount) VALUES ('XREF-25', '${CAMP}', 2500)`);
    await openSnacks();
    log(`  wallet in the database $${wallet()}, on the page $${await pageBal()}`);

    // ── S1: Sola, a lost refund → "It went through"; another → "Nothing went through" ──
    log('\nS1. Sola camp: the office refunds Avi $20; Sola makes it but the answer is lost; the office cancels the "never confirmed" question');
    let win = await openRefundFor();
    await page.fill('#refundAmt', '20'); await page.evaluate(() => refundAmtChanged());
    flag('lose');
    await page.evaluate(() => { window.confirm = () => false; });
    await page.click('#refundBtn');
    await waitFor('the answer', () => page.evaluate(() => !window._canteenRefundBusy), 20000);
    clearFlags(); ageAll('10 minutes');
    log(`  after the press: wallet $${wallet()}, holds [${holdsDb()}], Sola made ${q1(`SELECT string_agg('RN' || id || ' $' || cents/100.0, ', ') FROM ted_money`)}; the window says: "${(await shown('refundWarn')).slice(0, 150)}"`);
    let errs = pageErrors.length;
    const ra = await openRefundAll();
    log(`  REFUND ALL window: "${ra.body.slice(0, 220)}"\n     waiting list: "${ra.holds.slice(0, 220)}"\n     button: ${JSON.stringify(ra.btn)}`);
    check('Refund All opens with no page error, and lists the waiting $20 with both answers', pageErrors.length === errs && /Avi Katz: \$20\.00/.test(ra.holds) && /It went through/.test(ra.holds), JSON.stringify(pageErrors.slice(errs)));
    const serverWouldRefund = q1(`SELECT 25 - 20`);
    log(`  (the window's preview vs the server: the $25 Sola top-up has $20 held on its way, so the server can refund at most $${serverWouldRefund} of it)`);
    const rn1 = q1(`SELECT 'RN' || max(id) FROM ted_money`);
    await page.evaluate((ref) => { window.prompt = () => ref; }, rn1);
    await page.click('#refundAllHolds button:has-text("It went through")');
    await waitFor('the answer recorded', () => /posted/.test(holdsDb()), 20000).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));
    let t = await toasts();
    log(`  "It went through" (${rn1}) → holds [${holdsDb()}], wallet $${wallet()}, page balance $${await pageBal()}, toasts ${JSON.stringify(t.slice(-2))}, waiting list now: "${(await shown('refundAllHolds')).slice(0, 80)}"`);
    check('"It went through" records it once: hold posted, wallet unchanged at $45, told so, list cleared', /^posted \$20\.00$/.test(holdsDb()) && wallet() === 45 && t.some(x => /Recorded/.test(x)) && !(await shown('refundAllHolds')), '');

    log('\nS1b. Another $20 Sola refund, answer lost; the office answers "Nothing went through" from the child\'s Refund window');
    // Sola has $5 left on XREF-25 — top it up so a second $20 fits
    db.json(`SELECT public.credit_canteen_balance_from_processor(p_camp_id => '${CAMP}', p_camper_name => ${lit(CAMPER)}, p_amount => 30, p_processor_key => 'cardknox', p_external_transaction_id => 'XREF-30') AS r`);
    db.sql(`INSERT INTO ted_charge (ref, camp, amount) VALUES ('XREF-30', '${CAMP}', 3000)`);
    await openSnacks();
    win = await openRefundFor();
    await page.fill('#refundAmt', '20'); await page.evaluate(() => refundAmtChanged());
    flag('lose_before');
    await page.evaluate(() => { window.confirm = () => false; });
    await page.click('#refundBtn');
    await waitFor('the answer', () => page.evaluate(() => !window._canteenRefundBusy), 20000);
    clearFlags(); ageAll('10 minutes');
    await openSnacks();
    win = await openRefundFor();
    log(`  Refund window before the answer: box "${win.box.slice(0, 120)}", waiting "${win.holds.slice(0, 120)}", wallet $${wallet()}`);
    errs = pageErrors.length;
    const before1b = wallet(), held1b = Number(q1(`SELECT coalesce(sum(amount),0) FROM canteen_refund_holds WHERE camp_id='${CAMP}' AND state='open'`));
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('#refundHolds button:has-text("Nothing went through")');
    await waitFor('the money back', () => wallet() === before1b + held1b, 20000).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    const after = { box: await shown('refundBox'), amt: await page.evaluate(() => document.getElementById('refundAmt').value), holds: await shown('refundHolds') };
    t = await toasts();
    log(`  "Nothing went through" → wallet $${wallet()} (page $${await pageBal()}), holds [${holdsDb()}], toasts ${JSON.stringify(t.slice(-2))}\n     the Refund window 3 s later: box "${after.box.slice(0, 120)}", amount field "${after.amt}", waiting "${after.holds.slice(0, 60)}"`);
    check(`"Nothing went through" puts the held $${held1b} back once (wallet $${before1b} → $${before1b + held1b}) with no page error`, wallet() === before1b + held1b && /released/.test(holdsDb()) && pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));
    const pageNow = await page.evaluate((n) => { const a = window.CampistrySnacks.getAccount(n); return a && a.balance; }, CAMPER);
    check('the Refund window\'s figure follows the new wallet (Sola-refundable now $35 = $5 + $30)', /\$35\.00/.test(after.box), `box says "${after.box.slice(0, 80)}"; page wallet ${pageNow}`);

    // ── S2: Take Out Cash ─────────────────────────────────────────────────
    log('\nS2. Take Out Cash: $5 to Avi');
    await closeAll();
    errs = pageErrors.length;
    await page.click('button[onclick="openM(\'cash\')"]');
    await page.waitForSelector('#m-cash', { state: 'visible', timeout: 10000 });
    await page.selectOption('#cashCamper', CAMPER); await page.fill('#cashAmt', '5');
    if (await page.$('#cashNote')) await page.fill('#cashNote', 'bus money');
    const w2 = wallet();
    await page.evaluate(() => window.cashPickCamper && window.cashPickCamper());
    await page.click('#cashBtn');
    await waitFor('the payout', () => wallet() === w2 - 5, 20000).catch(() => {});
    await waitFor('the message', async () => (await toasts()).some(x => /Paid out \$5\.00 cash to Avi Katz/.test(x)), 8000).catch(() => {});
    t = await toasts();
    const cashRows = q1(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind'='cash_out'`);
    log(`  wallet $${wallet()}, cash-out rows ${cashRows}, toasts ${JSON.stringify(t.slice(-1))}, amount box "${await page.evaluate(() => document.getElementById('cashAmt').value)}"`);
    check('one $5 payout, "Paid out $5.00 cash to Avi Katz", the box cleared, no page error',
      wallet() === w2 - 5 && cashRows === '1' && t.some(x => /Paid out \$5\.00 cash to Avi Katz/.test(x)) && (await page.evaluate(() => document.getElementById('cashAmt').value)) === '' && pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));

    // ── S3: Stripe camp, Refund All, the refund fails later, Refund All again ──
    log('\nS3. The camp moves to Stripe. Avi tops up $20 by card (pi_A). The office runs Refund All');
    processor = 'stripe';
    db.sql(`UPDATE camps SET payment_processor_key = 'stripe' WHERE id = '${CAMP}';
            INSERT INTO ted_charge (ref, camp, amount) VALUES ('pi_A', '${CAMP}', 2000);`);
    const cid = Number(q1(`SELECT (value->'camperRoster'->${lit(CAMPER)}->>'camperId') FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='app1'`));
    const tenDaysAgo = q1(`SELECT ((now() AT TIME ZONE 'utc')::date - 10)::text`), today = q1(`SELECT ((now() AT TIME ZONE 'utc')::date)::text`);
    db.sql(`SELECT public.canteen_post('${CAMP}', ${lit(CAMPER)}, '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"pi_A","amount":20,"date":"${tenDaysAgo}","timestamp":${Date.now() - 10 * 86400000},"camperId":${cid},"camper":${JSON.stringify(CAMPER)}}'::jsonb);
      DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${CAMP}',${lit(CAMPER)}); PERFORM public.canteen_account_save('${CAMP}',${lit(CAMPER)}, a || jsonb_build_object('balance', (a->>'balance')::numeric + 20)); END $x$;`);
    log(`  S3a. The $20 Stripe top-up is dated ${tenDaysAgo} (10 days ago). Wallet $${wallet()}.`);
    await openSnacks();
    let w3 = await openRefundFor();
    const btnOff = await page.evaluate(() => document.getElementById('refundBtn').disabled);
    log(`     Avi's Refund window: "${w3.box.slice(0, 200)}" | amount "${w3.amt}" | Refund button disabled: ${btnOff}`);
    let r3 = await openRefundAll();
    log(`     REFUND ALL window: "${r3.body.slice(0, 160)}" | button ${JSON.stringify(r3.btn)}`);
    const srv = edge('stripe-canteen-refund', { action: 'holds' });
    const view = JSON.parse(q1(`SELECT public.canteen_refund_view('${CAMP}')::text`));
    const viewHas = (view.transactions || []).some(x => x.stripePaymentIntentId === 'pi_A');
    const pageHas = await page.evaluate(async () => { const r = await window.CampistryDB.client.rpc('get_canteen_accounts', { p_camp_id: window.CampistryDB.getCampId() });
      const d = r && r.data; return { has: (d && d.transactions || []).some(x => x.stripePaymentIntentId === 'pi_A'), window: d && d.ledgerWindow }; });
    log(`     what the page loads (get_canteen_accounts, window ${JSON.stringify(pageHas.window)}) holds the pi_A top-up: ${pageHas.has}; the server's refund view (what the refund functions read) holds it: ${viewHas}`);
    check('a 10-day-old Stripe top-up can be refunded from Snacks (Refund window or Refund All)', !btnOff || !!r3.btn, `Refund window "${w3.box.slice(0, 60)}", Refund All "${r3.body.slice(0, 60)}"`);
    log(`  S3b. The same top-up dated today (${today}) instead:`);
    db.sql(`UPDATE canteen_transactions SET tx_date = '${today}', payload = jsonb_set(payload, '{date}', to_jsonb('${today}'::text)) WHERE camp_id='${CAMP}' AND payload->>'stripePaymentIntentId'='pi_A'`);
    await openSnacks();
    w3 = await openRefundFor();
    log(`     Avi's Refund window: "${w3.box.slice(0, 120)}" | amount "${w3.amt}"`);
    r3 = await openRefundAll();
    log(`  window: "${r3.body.slice(0, 200)}" | button ${JSON.stringify(r3.btn)}`);
    await page.click('#refundAllBtn');
    await waitFor('the result', async () => !!(await shown('refundAllResult')), 20000).catch(() => {});
    log(`  result: "${await shown('refundAllResult')}" → wallet $${wallet()}, Stripe refunds [${q1(`SELECT string_agg('re_' || id || ' $' || cents/100.0 || ' ' || status, ', ') FROM ted_refunds`)}]`);
    log('  …three days later Stripe fails the refund (the card was closed) and sends refund.failed');
    ageAll('3 days'); db.sql(`DELETE FROM ted_keys`);
    const reId = q1(`SELECT max(id) FROM ted_refunds`);
    db.sql(`UPDATE ted_refunds SET status='failed' WHERE id=${reId}; UPDATE ted_charge SET refunded = refunded - 2000 WHERE ref='pi_A';`);
    const refObj = JSON.parse(q1(`SELECT json_build_object('id','re_'||id,'object','refund','amount',cents,'payment_intent',pi,'charge','ch_'||pi,'status',status,'failure_reason','expired_or_canceled_card','metadata',json_build_object('campistryHold',hold),'created',created)::text FROM ted_refunds WHERE id=${reId}`));
    const wh = webhook({ id: 'evt_s3', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: refObj } });
    log(`  webhook → HTTP ${wh.status}; wallet $${wallet()}; notice: ${q1(`SELECT count(*) FROM notifications WHERE camp_id='${CAMP}' AND source='refund_failed'`)}`);
    await openSnacks();
    const hist = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /Refund failed/.test(e.textContent)).map(e => e.textContent.trim()).slice(0, 3));
    log(`  the page after a reload: balance $${await pageBal()}; "Refund failed" text anywhere on the Accounts page: ${JSON.stringify(hist)}`);
    r3 = await openRefundAll();
    log(`  REFUND ALL window again: "${r3.body.slice(0, 200)}" | button ${JSON.stringify(r3.btn)}`);
    await page.click('#refundAllBtn');
    await waitFor('the result', async () => !!(await shown('refundAllResult')), 20000).catch(() => {});
    const res3 = await shown('refundAllResult');
    log(`  result: "${res3}" → wallet $${wallet()}, Stripe refunds [${q1(`SELECT string_agg('re_' || id || ' $' || cents/100.0 || ' ' || status, ', ') FROM ted_refunds`)}]`);
    check('after the failed $20 is put back, Refund All sends it again (or says why not)',
      Number(q1(`SELECT count(*) FROM ted_refunds WHERE status <> 'failed' AND pi='pi_A'`)) === 1 || /Avi/.test(res3), `the office sees "${res3}", wallet still $${wallet()}`);

    // ── S4: a Stripe refund waiting, wallet at $0 → the look-up button ─────────
    log('\nS4. Avi\'s own Refund: $20 by Stripe, answer lost (office cancels the question). Everything else paid out in cash → wallet $0');
    win = await openRefundFor();
    log(`  Refund window: "${win.box.slice(0, 120)}"`);
    await page.fill('#refundAmt', '20'); await page.evaluate(() => refundAmtChanged());
    flag('lose'); await page.evaluate(() => { window.confirm = () => false; });
    await page.click('#refundBtn');
    await waitFor('the answer', () => page.evaluate(() => !window._canteenRefundBusy), 20000);
    clearFlags();
    const left = wallet();
    // the rest paid out in cash at the desk (set directly: the office RPC needs a signed-in user)
    db.sql(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${CAMP}',${lit(CAMPER)}); PERFORM public.canteen_account_save('${CAMP}',${lit(CAMPER)}, a || jsonb_build_object('balance', 0)); END $x$;`);
    log(`  (the other $${left} paid out in cash, set directly on the account)`);
    ageAll('10 minutes');
    log(`  wallet $${wallet()}, holds [${holdsDb()}]`);
    await openSnacks();
    const r4 = await openRefundAll();
    log(`  REFUND ALL window: "${r4.body.slice(0, 160)}" | waiting "${r4.holds.slice(0, 160)}" | button ${JSON.stringify(r4.btn)}`);
    if (r4.btn) {
      await page.click('#refundAllBtn');
      await waitFor('the result', async () => !!(await shown('refundAllResult')), 20000).catch(() => {});
    }
    const res4 = await shown('refundAllResult');
    log(`  result: "${res4}" → holds [${holdsDb()}], wallet $${wallet()}, history ${q1(`SELECT coalesce(string_agg(payload->>'stripeRefundId' || ' $' || amount, ', '), 'none') FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind'='refund' AND payload->>'method'='stripe'`)}`);
    check('the look-up button is offered and settles the waiting refund as made', r4.btn === 'Look up the waiting refunds in Stripe' && /posted/.test(holdsDb()) && !/open/.test(holdsDb()), `button ${JSON.stringify(r4.btn)}`);
  } catch (e) {
    check('the run finished', false, String(e.message).split('\n')[0]);
  } finally {
    log('\nedge calls: ' + edgeCalls.map(c => `${c.fn}${c.body && c.body.action ? '(' + c.body.action + ')' : ''}→${c.status}`).join(', '));
    log('page errors: ' + JSON.stringify(pageErrors));
    await browser.close().catch(() => {});
    await bridgeSrv.close().catch(() => {});
    db.stop();
    log(`\n${bad} BAD`);
  }
})();
