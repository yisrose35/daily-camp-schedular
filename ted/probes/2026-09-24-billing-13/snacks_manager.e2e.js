// Probe (13th pass: TED-130 / TED-135 / TED-134 re-check in a real browser).
// The REAL Snacks page (Playwright + Chromium, the project's smoke harness,
// every migration on a throwaway Postgres); its refund calls are run by the
// REAL edge functions (stripe-canteen-refund, stripe-canteen-refund-all) in
// Node against the SAME database, with a pretend Stripe that follows Stripe's
// documented rules (key replay marked Idempotent-Replayed; GET /refunds/{id};
// a list of a payment's refunds with their metadata).
//
//   R1  TED-130: Avi's $30 Stripe top-up is 40 days old. The Refund window, and
//       pressing Refund: does the parent get $30?
//   R2  TED-130: two children, each with an old top-up, one sharing a first
//       name — Refund All's preview and result.
//   R3  TED-135: a $20 refund's answer is lost (Stripe MADE it); Refund All:
//       what does its result say?
//   R4  TED-135: a $20 refund that never reached Stripe; Refund All: result,
//       and is the $20 really refunded again as it says?
//   R5  TED-134: a camp MANAGER (not owner/admin) opens the Refund window and
//       Refund All.
// R5 only, with what the manager's screen shows (13th pass).
// Run: node ted/probes/2026-09-24-billing-13/snacks_manager.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');

const PORT = 8185;
const OWNER = '51000000-0000-0000-0000-000000000001';
const MGR = '51000000-0000-0000-0000-000000000002';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test', MGR_EMAIL = 'manager@smoke.test';
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
  const db = boot({ port: 5647 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  log('postgres up with ' + db.applied.length + ' migrations applied');
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}'), ('${MGR}', '${MGR_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');
          INSERT INTO camp_users (camp_id, user_id, role, accepted_at, product_access) VALUES ('${CAMP}', '${MGR}', 'manager', now(), '["snacks","me"]'::jsonb);
          CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
          CREATE TABLE ted_charge (ref text PRIMARY KEY, camp text, amount int, refunded int NOT NULL DEFAULT 0);
          CREATE TABLE ted_refunds (id serial, camp text, pi text, cents int, hold text, status text NOT NULL DEFAULT 'succeeded', created bigint, meta jsonb);
          CREATE TABLE ted_flags (k text PRIMARY KEY, n int);`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [], settings: { payMethods: ['cash', 'card'], defaultDailyLimit: 0 } });
  const flag = (k, n = 1) => db.sql(`INSERT INTO ted_flags VALUES ('${k}', ${n}) ON CONFLICT (k) DO UPDATE SET n = ${n}`);
  const clearFlags = () => db.sql(`DELETE FROM ted_flags`);
  const wallet = (n) => Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(n)}`));
  const holdsDb = () => q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', ' ORDER BY created_at), 'none') FROM canteen_refund_holds WHERE camp_id='${CAMP}'`);
  const stripeMade = () => q1(`SELECT coalesce(string_agg('re_' || id || ' $' || (cents/100) || ' ' || pi || ' ' || status, ', ' ORDER BY id), 'none') FROM ted_refunds`);
  const stripeBack = (pi) => Number(q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_refunds WHERE status <> 'failed'` + (pi ? ` AND pi='${pi}'` : '')));
  const ageAll = (i) => db.sql(`UPDATE canteen_refund_holds SET created_at = created_at - interval '${i}' WHERE camp_id='${CAMP}';
      UPDATE refund_intents SET created_at = created_at - interval '${i}', called_at = called_at - interval '${i}' WHERE camp_id='${CAMP}';
      UPDATE ted_refunds SET created = created - extract(epoch from interval '${i}')::bigint;
      UPDATE ted_keys SET resp = jsonb_set(resp, '{created}', to_jsonb((resp->>'created')::bigint - extract(epoch from interval '${i}')::bigint)) WHERE resp ? 'created';`);
  const cidOf = (n) => Number(q1(`SELECT (value->'camperRoster'->${lit(n)}->>'camperId') FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='app1'`));
  // a Stripe top-up posted the way the checkout webhook posts one, dated `daysAgo`
  const topUp = (name, pi, dollars, daysAgo) => {
    const d = q1(`SELECT ((now() AT TIME ZONE 'utc')::date - ${daysAgo})::text`);
    db.sql(`SELECT public.canteen_post('${CAMP}', ${lit(name)}, '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"${pi}","amount":${dollars},"date":"${d}","timestamp":${Date.now() - daysAgo * 86400000},"camperId":${cidOf(name)},"camper":${JSON.stringify(name)}}'::jsonb);
      DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${CAMP}',${lit(name)}); PERFORM public.canteen_account_save('${CAMP}',${lit(name)}, a || jsonb_build_object('balance', coalesce((a->>'balance')::numeric,0) + ${dollars})); END $x$;
      INSERT INTO ted_charge (ref, camp, amount) VALUES ('${pi}', '${CAMP}', ${dollars * 100});`);
    return d;
  };

  const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
    'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent',
    'refund_canteen_deposit_from_stripe', 'record_processor_transaction'];
  const BR = bridge(db, RPCS, ['refund_intents']);
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
  const edgeCalls = [];
  let signedIn = 'owner';
  function edge(fn, body) {
    const env = `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', mgr: 'u-mgr' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', payment_processor_key: 'stripe' }];
T.tables.camp_users = [{ camp_id: '${CAMP}', user_id: 'u-mgr', role: 'manager', accepted_at: '2026-06-01' }];
${BR}
${STRIPE}`;
    const r = runEdges([fn], env + `\nT.requests = [{ headers: { Authorization: 'Bearer ${signedIn}' }, body: ${JSON.stringify(body || {})} }];`);
    const res = r.responses[0];
    edgeCalls.push(`${signedIn}:${fn}${body && body.action ? '(' + body.action + ')' : ''}→${res.status}`);
    return { status: res.status, body: res.body };
  }

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  async function newPage(asId, asEmail) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
    page.on('dialog', d => d.dismiss().catch(() => {}));
    await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
    await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
        users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }, { id: '${MGR}', email: '${MGR_EMAIL}', password: 'smoke' }], signedInAs: { id: '${asId}', email: '${asEmail}' } });`);
    await page.exposeFunction('__tedEdge', (fn, body) => edge(fn, body));
    return page;
  }
  let page = await newPage(OWNER, OWNER_EMAIL);
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
  const openSnacks = async (who) => {
    await open('campistry_snacks.html', () => !!window.CampistrySnacks);
    await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), who || 'Avi Katz', { timeout: 30000 });
    await wire();
    await page.click('#hamburgerBtn'); await page.click('.sidebar-item[data-page="accounts"]');
    await page.waitForSelector('#page-accounts.active', { timeout: 10000 });
  };
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast')].map(t => t.textContent.trim()).filter(Boolean));
  const shown = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display !== 'none' ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }, id);
  const closeAll = () => page.evaluate(() => { ['refundall', 'refund', 'cash'].forEach(m => { try { closeM(m); } catch (_) {} }); });
  const openRefundAll = async () => {
    await closeAll();
    await page.click('button[onclick="openRefundAllModal()"]');
    await waitFor('the Refund All window', () => page.evaluate(() => { const e = document.getElementById('m-refundall'); return e && /open/.test(e.className); }), 10000);
    await waitFor('the preview', async () => !/Working out/.test(await shown('refundAllBody')), 15000);
    await new Promise(r => setTimeout(r, 1500));
    return { body: await shown('refundAllBody'), holds: await shown('refundAllHolds'),
             btn: await page.evaluate(() => { const b = document.getElementById('refundAllBtn'); return b && getComputedStyle(b).display !== 'none' ? b.textContent : null; }) };
  };
  const runRefundAll = async () => {
    await page.click('#refundAllBtn');
    await waitFor('the result', async () => !!(await shown('refundAllResult')), 20000).catch(() => {});
    return shown('refundAllResult');
  };
  const openRefundFor = async (name) => {
    await closeAll();
    await page.evaluate((n) => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('onclick') || '').startsWith("openMFor('refund'") && (x.getAttribute('onclick') || '').includes(n)); if (b) b.click(); else { openM('refund'); const s = document.getElementById('refundCamper'); s.value = n; refundPickCamper(); } }, name);
    await waitFor('the Refund window', () => page.evaluate(() => { const e = document.getElementById('m-refund'); return e && /open/.test(e.className); }), 10000);
    await waitFor('the refundable figure', async () => !/Working out/.test(await shown('refundBox')), 15000).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    return { box: await shown('refundBox'), amt: await page.evaluate(() => document.getElementById('refundAmt').value),
             off: await page.evaluate(() => document.getElementById('refundBtn').disabled) };
  };
  const addCamper = async (first, last) => {
    await open('campistry_me.html', () => !!window.CampistryMe);
    await page.waitForFunction(() => { const g = window.loadGlobalSettings && window.loadGlobalSettings(); return !!(g && g.campStructure && g.campStructure.Boys); }, null, { timeout: 30000 });
    await page.evaluate(() => window.CampistryMe.nav('campers'));
    await page.evaluate(() => window.CampistryMe.editCamper(null));
    await page.waitForSelector('#ceFirst', { timeout: 10000 });
    await page.waitForFunction(() => { const s = document.getElementById('ceDiv'); return s && [...s.options].some(o => o.value === 'Boys'); }, null, { timeout: 10000 });
    await page.fill('#ceFirst', first); await page.fill('#ceLast', last);
    await page.selectOption('#ceDiv', 'Boys'); await page.selectOption('#ceCGrade', 'Junior'); await page.selectOption('#ceBunk', 'J1');
    await page.click('#ceSave');
    await page.waitForSelector('#camperEditModal', { state: 'hidden', timeout: 10000 });
    const n = first + ' ' + last;
    await waitFor('the roster saved with a camper number', () => cidOf(n) > 0, 30000);
  };

  try {
    log('SETUP: Avi Katz and Avi Stern added on Me; $40 cash for Avi Katz at the Snacks desk');
    await addCamper('Avi', 'Katz');
    await addCamper('Avi', 'Stern');
    await openSnacks();
    await page.click('button[onclick="openM(\'dep\')"]');
    await page.waitForSelector('#m-dep', { state: 'visible', timeout: 10000 });
    await page.selectOption('#depCamper', 'Avi Katz'); await page.fill('#depAmt', '40'); await page.selectOption('#depMethod', 'cash');
    await page.click('button[onclick="addDep()"]');
    await waitFor('the cash deposit', () => wallet('Avi Katz') === 40, 30000);
    log(`  camper numbers: Avi Katz #${cidOf('Avi Katz')}, Avi Stern #${cidOf('Avi Stern')}`);

    // ── R5 ──
    log(`\nR5. A camp MANAGER (${MGR_EMAIL}, role manager) signs in to Snacks`);
    topUp('Avi Stern', 'pi_NEW6', 10, 0);
    signedIn = 'mgr';
    page = await newPage(MGR, MGR_EMAIL);
    await open('campistry_snacks.html', () => !!window.CampistrySnacks);
    await new Promise(r => setTimeout(r, 4000));
    await wire();
    const seen = await page.evaluate(() => ({
      role: (window.CampistryDB && window.CampistryDB.getRole) ? window.CampistryDB.getRole() : null,
      campers: (window.CampistrySnacks.getCamperList() || []).map(c => c.name),
      hamburger: (() => { const b = document.getElementById('hamburgerBtn'); return b ? getComputedStyle(b).display + '/' + b.offsetParent : 'none'; })(),
      accountsItem: (() => { const b = document.querySelector('.sidebar-item[data-page="accounts"]'); return b ? getComputedStyle(b).display : 'missing'; })(),
      banner: [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /access|permission|not allowed|sign in|owner/i.test(e.textContent) && e.offsetParent).map(e => e.textContent.trim()).slice(0, 5),
    }));
    log('    what the manager sees: ' + JSON.stringify(seen));
    await page.screenshot({ path: '/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-13/snacks_manager.png' });
    await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), 'Avi Stern', { timeout: 30000 });
    await page.click('#hamburgerBtn'); await page.click('.sidebar-item[data-page="accounts"]');
    await page.waitForSelector('#page-accounts.active', { timeout: 10000 });
    let w, ra;
    const role = await page.evaluate(() => { try { return window.CampistryDB.getRole ? window.CampistryDB.getRole() : null; } catch (_) { return null; } });
    w = await openRefundFor('Avi Stern');
    log(`    role on the page: ${JSON.stringify(role)} | Refund window: "${w.box.slice(0, 150)}" | button off: ${w.off}`);
    check('R5a the Refund window says only the owner or an admin can refund to a card', /Only the camp owner or an admin can refund canteen money to a card/.test(w.box) && w.off, '');
    ra = await openRefundAll();
    log(`    Refund All window: "${ra.body.slice(0, 150)}" | button ${JSON.stringify(ra.btn)}`);
    check('R5b Refund All says the same, with no "no card processor connected… Take Out Cash"',
      /Only the camp owner or an admin/.test(ra.body) && !/no card processor/.test(ra.body) && !ra.btn, '');
  } catch (e) {
    check('the run finished', false, String(e.message).split('\n')[0]);
  } finally {
    log('\nedge calls: ' + edgeCalls.join(', '));
    log('page errors: ' + JSON.stringify(pageErrors));
    await browser.close().catch(() => {});
    await bridgeSrv.close().catch(() => {});
    db.stop();
    log(`\n${bad} BAD`);
  }
})();
