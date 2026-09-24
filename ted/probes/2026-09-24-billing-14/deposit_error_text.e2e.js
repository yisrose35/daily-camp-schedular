// Probe (14th pass, hunt: TED-134's twin in Registration). What the office
// READS when Registration → "Charge $250 now" (a deposit the form could not
// take) is refused by the server.
//
// In Chromium: the project's own vendored supabase-js (supabase-js@2.js, the
// file campistry_me.html loads) makes the functions.invoke call; the request is
// answered by the REAL registration-deposit-checkout (run in Node by
// tests/edge_harness.js) with its real status and body; the page's REAL
// chargeDepositNow (cut from campistry_me.js) decides what to toast.
//
//   D1 a camp MANAGER (the button is on the Registration page, no role gate)
//      presses "Charge $250 now"  → the server refuses with 403
//   D2 the owner presses it for an application the server cannot find → 404
//   D3 control: the owner presses it and the server refuses WITH STATUS 200
//      (here: "already in progress") — those words do reach the office
// Run: node ted/probes/2026-09-24-billing-14/deposit_error_text.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { runEdges } = require(R + '/tests/edge_harness.js');

const ME = fs.readFileSync(path.join(R, 'campistry_me.js'), 'utf8');
const cut = (name) => { const at = ME.indexOf('async function ' + name + '('); let i = ME.indexOf('{', at), d = 0;
  for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; } return ME.slice(at, i + 1); };
const CHARGE = cut('chargeDepositNow');

const CAMP = 'camp-1';
const BASE = (found) => `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', mgr: 'u-mgr' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', name: 'Probe Camp', payment_processor_key: 'stripe', stripe_account_id: null, stripe_charges_enabled: false }];
T.tables.camp_users = [{ camp_id: '${CAMP}', user_id: 'u-mgr', role: 'manager', accepted_at: '2026-06-01' }];
T.tables.camp_state_kv = [{ camp_id: '${CAMP}', key: 'campistryMe', value: { enrollments: { e1: { camperName: 'Dov Gold', savedCardCustomer: 'cus_dov', savedCardMethod: 'pm_dov', savedCardProcessor: 'stripe', savedCardLast4: '4242' } } } }];
T.rpc._registration_deposit_owed = () => (${found} ? { success: true, owed: 250, label: 'Registration deposit', camperName: 'Dov Gold' } : { success: false, error: 'not_found' });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.release_refund_intent = () => true;
T.rpc.claim_registration_deposit = () => ({ claimed: true, state: 'claimed' });
T.fetch = async (url: string, init: any) => {
  if (init && init.method === 'POST' && url.endsWith('/payment_intents'))
    return { __status: 402, error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } };
  return {};
};`;
const CASES = {
  D1: { who: 'mgr', found: true },
  D2: { who: 'owner', found: false },
  D3: { who: 'owner', found: true },
};
let current = null;
const serverSaid = {};

(async () => {
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const page = await browser.newPage();
  await page.route('https://sb.test/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/index.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script src="/supabase-js@2.js"></script>' });
    if (url.endsWith('/supabase-js@2.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(R, 'supabase-js@2.js'), 'utf8') });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: 'ok' });
    const m = url.match(/\/functions\/v1\/([a-z-]+)/);
    if (m) {
      const c = CASES[current];
      const r = runEdges([m[1]], BASE(c.found) + `\nT.requests = [{ headers: { Authorization: 'Bearer ${c.who}' }, body: ${route.request().postData() || '{}'} }];`);
      const res = r.responses[0];
      serverSaid[current] = res.status + ' ' + JSON.stringify(res.body);
      return route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(res.body) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://sb.test/index.html');
  await page.waitForFunction(() => window.supabase && window.supabase.createClient);
  await page.evaluate((src) => {
    const client = window.supabase.createClient('https://sb.test', 'anon-key', { auth: { persistSession: false } });
    window.CampistryDB = { getClient: () => client, getCampId: () => 'camp-1' };
    try { localStorage.setItem('campistry_camp_id', 'camp-1'); } catch (_) {}
    // the page's own helpers this function uses, as plain as possible
    window.enrollments = { e1: { camperName: 'Dov Gold', savedCardCustomer: 'cus_dov', savedCardLast4: '4242', depositRequired: 250, depositPaid: 0 } };
    window._depPolicyAPI = () => ({ outstanding: (e) => (Number(e.depositRequired) || 0) - (Number(e.depositPaid) || 0) });
    window.confirmDialog = async () => true;
    window.esc = (s) => String(s);
    window.fm = (n) => '$' + Number(n).toFixed(2);
    window.save = () => {}; window.renderRegistrationPage = () => {};
    window.__toasts = []; window.toast = (t) => { window.__toasts.push(t); };
    (0, eval)(src);
  }, CHARGE);
  let bad = 0;
  for (const [k, c] of Object.entries(CASES)) {
    current = k;
    const shown = await page.evaluate(async () => { window.__toasts = []; await chargeDepositNow('e1'); return window.__toasts.slice(); });
    const serverMsg = (() => { try { return JSON.parse(serverSaid[k].replace(/^\d+ /, '')).error; } catch (_) { return null; } })();
    const last = shown[shown.length - 1] || '';
    const good = !!serverMsg && last.includes(serverMsg);
    if (!good) bad++;
    console.log(`${k} ${c.who} presses "Charge $250.00 now"\n    the server answered: ${serverSaid[k]}\n    the office reads:    ${JSON.stringify(shown)}\n  ${good ? 'ok  ' : 'BAD '}the office is told the server's reason`);
  }
  await browser.close();
  console.log(`\n${bad} BAD`);
})();
