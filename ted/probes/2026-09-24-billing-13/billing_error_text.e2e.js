// Probe (13th pass, TED-134 Billing half). What the office actually READS when
// a Billing card action is refused by the server.
//
// In Chromium: the project's own vendored supabase-js (supabase-js@2.js, the
// file campistry_me.html loads) makes the functions.invoke call; the request is
// answered by the REAL edge function (stripe-charge / stripe-refund, run in Node
// by tests/edge_harness.js) with its real status and body; the page's REAL
// callEdgeFunctionAuthed (cut from campistry_me.js) turns that into the error
// its caller toasts. The toast wording is the caller's own, quoted from
// campistry_me.js (:6495 "Not recorded: ", :18738 "Refund failed: ",
// :19347-19349 "Charge failed: ").
//
//   E1 a camp MANAGER presses "It went through" on a Stripe autopay (TED-134)
//   E2 the owner refunds more than Stripe will take back (Stripe refuses)
//   E3 the owner presses Charge Card for a family with no card on file
// Run: node ted/probes/2026-09-24-billing-13/billing_error_text.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { runEdges } = require(R + '/tests/edge_harness.js');

const ME = fs.readFileSync(path.join(R, 'campistry_me.js'), 'utf8');
const cut = (name) => { const at = ME.indexOf('async function ' + name + '('); let i = ME.indexOf('{', at), d = 0;
  for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; } return ME.slice(at, i + 1); };
const CALL = cut('callEdgeFunctionAuthed');

const CAMP = 'camp-1';
const BASE = `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', mgr: 'u-mgr' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', name: 'Probe Camp', payment_processor_key: 'stripe' }];
T.tables.camp_users = [{ camp_id: '${CAMP}', user_id: 'u-mgr', role: 'manager', accepted_at: '2026-06-01' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_gold' } });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.release_refund_intent = () => true;
T.fetch = async (url: string, init: any) => {
  if (url.includes('/payment_intents/')) return { id: 'pi_G', object: 'payment_intent', customer: 'cus_gold', amount: 50000, status: 'succeeded', metadata: {} };
  if (init.method === 'POST' && url.endsWith('/refunds')) return { __status: 400, error: { type: 'invalid_request_error', message: 'Refund amount ($600.00) is greater than unrefunded amount on charge ($500.00)' } };
  if (url.includes('/payment_methods')) return { object: 'list', data: [] };
  if (url.includes('/customers/')) return { id: 'cus_gold', metadata: { campId: '${CAMP}' } };
  return {};
};`;
const CASES = {
  E1: { who: 'mgr', fn: 'stripe-charge', body: { action: 'confirmAutopay', familyKey: 'gold', planRef: 'plan_1:0', paymentIntentId: 'pi_G' }, toast: (m) => 'Not recorded: ' + m },
  E2: { who: 'owner', fn: 'stripe-refund', body: { paymentIntentId: 'pi_G', amount: 600, reason: 'requested_by_customer', idempotencyKey: 'rfnd_gold:x' }, toast: (m) => 'Refund failed: ' + m },
  E3: { who: 'owner', fn: 'stripe-charge', body: { customerId: 'cus_gold', amount: 100, currency: 'usd', description: 'x', metadata: { familyKey: 'gold' }, idempotencyKey: 'chg_1' }, toast: (m) => 'Charge failed: ' + m },
};
let current = null;
const serverSaid = {};

(async () => {
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const page = await browser.newPage();
  await page.route('http://sb.test/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/index.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script src="/supabase-js@2.js"></script>' });
    if (url.endsWith('/supabase-js@2.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(R, 'supabase-js@2.js'), 'utf8') });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: 'ok' });
    const m = url.match(/\/functions\/v1\/([a-z-]+)/);
    if (m) {
      const c = CASES[current];
      const r = runEdges([m[1]], BASE + `\nT.requests = [{ headers: { Authorization: 'Bearer ${c.who}' }, body: ${route.request().postData() || '{}'} }];`);
      const res = r.responses[0];
      serverSaid[current] = res.status + ' ' + JSON.stringify(res.body);
      return route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(res.body) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://sb.test/index.html');
  await page.waitForFunction(() => window.supabase && window.supabase.createClient);
  await page.evaluate((src) => {
    const client = window.supabase.createClient('http://sb.test', 'anon-key', { auth: { persistSession: false } });
    window.CampistryDB = { getClient: () => client };
    (0, eval)(src);
    window.__call = async (fn, body) => { try { const d = await callEdgeFunctionAuthed(fn, body); return { ok: true, data: d }; }
      catch (e) { return { ok: false, message: e.message, status: e.status == null ? null : e.status, hasData: !!e.data }; } };
  }, CALL);
  let bad = 0;
  for (const [k, c] of Object.entries(CASES)) {
    current = k;
    const out = await page.evaluate(([fn, body]) => window.__call(fn, body), [c.fn, c.body]);
    const shown = out.ok ? '(no error)' : c.toast(out.message);
    const serverMsg = (() => { try { return JSON.parse(serverSaid[k].replace(/^\d+ /, '')).error; } catch (_) { return null; } })();
    const good = !out.ok && serverMsg && shown.includes(serverMsg);
    if (!good) bad++;
    console.log(`${k} ${c.who} → ${c.fn}${c.body.action ? '(' + c.body.action + ')' : ''}\n    the server answered: ${serverSaid[k]}\n    the office reads:    "${shown}"\n  ${good ? 'ok  ' : 'BAD '}the office is told the server's reason`);
  }
  await browser.close();
  console.log(`\n${bad} BAD`);
})();
