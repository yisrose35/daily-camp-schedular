// Probe (11th pass). The REAL Snacks page in a real browser (Playwright +
// Chromium), against a throwaway Postgres with every migration, using the
// project's own smoke harness (tests/e2e/db.js, bridge.js, shim.js).
//
//   1. the owner adds a camper on Me and takes a $40 desk deposit in Snacks
//      (the same clicks as tests/money_path.e2e.js steps 1-3);
//   2. clicks the real "Refund All" button on Snacks → Accounts;
//      does the Refund All window open? does the new "waiting for an answer"
//      list (TED-116) appear in it? any page error?
//   3. opens the real Refund window for that camper, with the edge function
//      answering `holds` with one unanswered Sola refund of $20 for him:
//      does the "waiting for an answer" list show, with both buttons?
//
// Edge functions are not reachable in the harness; step 2/3 swap in a fake
// `functions.invoke` that answers action:'holds' (only) and records calls.
//
// Run: node ted/probes/2026-09-24-billing-11/snacks_refund_windows.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));

const PORT = 8163;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const CAMPER = 'Avi Katz';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function waitFor(what, fn, ms) {
  const until = Date.now() + (ms || 15000); let last;
  while (Date.now() < until) { try { if (fn()) return; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 250)); }
  throw new Error('timed out waiting for ' + what + (last ? ' (' + last + ')' : ''));
}

(async () => {
  const db = boot({});
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  console.log('postgres up with ' + db.applied.length + ' migrations applied');
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test');`);
  try { db.sql(`UPDATE camps SET payment_processor_key = 'cardknox' WHERE id = '${CAMP}';`); console.log('camp processor set to cardknox'); }
  catch (e) { console.log('could not set processor: ' + e.message.split('\n')[0]); }
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [], settings: { payMethods: ['cash', 'card'], defaultDailyLimit: 0 } });

  const bridge = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  const open = async (file, ready) => {
    await page.goto('http://localhost:' + PORT + '/' + file, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId(), null, { timeout: 30000 });
    if (ready) await page.waitForFunction(ready, null, { timeout: 30000 });
  };
  const snacksNav = async (pane) => { await page.click('#hamburgerBtn'); await page.click('.sidebar-item[data-page="' + pane + '"]');
    await page.waitForSelector('#page-' + pane + '.active', { timeout: 10000 }); };

  try {
    // ── 1. a camper and a $40 desk deposit, through the real pages ──────────
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
    await waitFor('roster saved with a camper id', () => {
      const r = db.json(`SELECT value FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='app1'`);
      const rec = r.length && r[0].value.camperRoster && r[0].value.camperRoster[CAMPER];
      return rec && Number(rec.camperId) > 0;
    }, 30000);

    await open('campistry_snacks.html', () => !!window.CampistrySnacks);
    await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
    await snacksNav('accounts');
    await page.click('button[onclick="openM(\'dep\')"]');
    await page.waitForSelector('#m-dep', { state: 'visible', timeout: 10000 });
    await page.selectOption('#depCamper', CAMPER); await page.fill('#depAmt', '40'); await page.selectOption('#depMethod', 'cash');
    await page.click('button[onclick="addDep()"]');
    await waitFor('deposit on the account row', () => {
      const a = db.json(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(CAMPER)}`);
      return a.length === 1 && Number(a[0].balance) === 40;
    }, 30000);
    await page.waitForSelector('#m-dep', { state: 'hidden', timeout: 15000 });
    console.log('setup: camper "' + CAMPER + '" has a $40 wallet; campers in Snacks =', await page.evaluate(() => window.CampistrySnacks.getCamperList().length));

    // A fake edge-function answer for `holds` only: one Sola refund of $20
    // for this child, sent 10 minutes ago and never answered.
    const camperId = await page.evaluate((n) => { const r = window.CampistrySnacks.getCamperList().find(c => c.name === n); return r && r.camperId; }, CAMPER);
    await page.evaluate(({ n, id }) => {
      window.__fnCalls = [];
      const c = window.CampistryDB.client;
      c.functions.invoke = async (fn, o) => {
        window.__fnCalls.push([fn, JSON.stringify(o && o.body)]);
        if (o && o.body && o.body.action === 'holds') return { data: { holds: [{ key: 'canteen:cref_x:RN1', camperId: id, account: n, amount: 20, method: 'cardknox', ageSeconds: 600 }] }, error: null };
        return { data: null, error: { message: 'not in this probe' } };
      };
    }, { n: CAMPER, id: camperId });

    // ── 2. the real Refund All button ───────────────────────────────────────
    const errsBefore = pageErrors.length;
    await page.click('button[onclick="openRefundAllModal()"]');
    await page.waitForTimeout(1500);
    const ra = await page.evaluate(() => {
      const m = document.getElementById('m-refundall');
      const shown = m && (m.classList.contains('open') || m.classList.contains('active') || getComputedStyle(m).display !== 'none');
      const holds = document.getElementById('refundAllHolds');
      return { windowOpen: !!shown, cls: m && m.className, body: (document.getElementById('refundAllBody') || {}).textContent || '',
               holdsShown: !!(holds && holds.style.display !== 'none' && holds.innerHTML), holdsText: holds ? holds.textContent : null,
               calls: window.__fnCalls.slice(), typeofHelper: typeof window._stripeRefundCapacity };
    });
    console.log('\nREFUND ALL button pressed:');
    console.log('  page errors from the click:', JSON.stringify(pageErrors.slice(errsBefore)));
    console.log('  Refund All window open:', ra.windowOpen, '| class =', JSON.stringify(ra.cls));
    console.log('  window text:', JSON.stringify(ra.body.slice(0, 160)));
    console.log('  "waiting for an answer" list shown:', ra.holdsShown, '| edge calls made:', JSON.stringify(ra.calls));
    console.log('  typeof _stripeRefundCapacity in the page:', ra.typeofHelper);

    // ── 3. the real Refund window for this child ───────────────────────────
    const errs2 = pageErrors.length;
    await page.evaluate(() => { window.__fnCalls = []; });
    // the Refund button on the child's row in Snacks → Accounts
    const opened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^openMFor\('refund'/.test(x.getAttribute('onclick') || ''));
      if (b) b.click();
      return b ? b.getAttribute('onclick') : null;
    });
    console.log('\nREFUND (one child) row button onclick:', JSON.stringify(opened));
    await page.waitForTimeout(2000);
    const opts = await page.evaluate(() => ({ value: (document.getElementById('refundCamper') || {}).value,
      open: getComputedStyle(document.getElementById('m-refund')).display !== 'none' }));
    console.log('  Refund window open:', opts.open, '| camper picked:', JSON.stringify(opts.value));
    const one = await page.evaluate(() => {
      const h = document.getElementById('refundHolds');
      return { shown: !!(h && h.style.display !== 'none' && h.innerHTML), text: h ? h.textContent : null,
               buttons: h ? [...h.querySelectorAll('button')].map(b => b.textContent) : [],
               box: (document.getElementById('refundBox') || {}).textContent, calls: window.__fnCalls.slice() };
    });
    console.log('  page errors:', JSON.stringify(pageErrors.slice(errs2)));
    console.log('  refund box:', JSON.stringify(one.box));
    console.log('  "waiting for an answer" list shown:', one.shown, '| buttons:', JSON.stringify(one.buttons));
    console.log('  list text:', JSON.stringify(one.text));
    console.log('  edge calls:', JSON.stringify(one.calls));

    // ── 4. the real Take Out Cash: $5 to Avi ───────────────────────────────
    await page.evaluate(() => closeM('refund'));
    const errs3 = pageErrors.length;
    await page.click('button[onclick="openM(\'cash\')"]');
    await page.waitForSelector('#m-cash', { state: 'visible', timeout: 10000 });
    await page.selectOption('#cashCamper', CAMPER);
    await page.fill('#cashAmt', '5');
    if (await page.$('#cashNote')) await page.fill('#cashNote', 'bus money');
    await page.evaluate(() => window.cashPickCamper && window.cashPickCamper());
    await page.waitForTimeout(300);
    const pre = await page.evaluate(() => ({ disabled: document.getElementById('cashBtn').disabled,
      warn: (document.getElementById('cashWarn') || {}).textContent, info: (document.getElementById('cashInfo') || {}).textContent }));
    console.log('\n  before Pay Out: ' + JSON.stringify(pre));
    const callsBefore = bridge.calls.length;
    await page.click('#cashBtn');
    await page.waitForTimeout(2500);
    console.log('  calls after Pay Out: ' + JSON.stringify(bridge.calls.slice(callsBefore).map(c => [c.fn, c.error || (c.value && JSON.stringify(c.value).slice(0, 160))])));
    await waitFor('the cash-out on the account row', () => {
      const a = db.json(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(CAMPER)}`);
      return a.length === 1 && Number(a[0].balance) === 35;
    }, 20000);
    await page.waitForTimeout(1500);
    const co = await page.evaluate(() => ({
      toasts: [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean),
      amtField: (document.getElementById('cashAmt') || {}).value,
      modalOpen: getComputedStyle(document.getElementById('m-cash')).display !== 'none',
    }));
    const rows = db.json(`SELECT amount, payload->>'kind' AS kind FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind'='cash_out'`);
    console.log('\nTAKE OUT CASH $5:');
    console.log('  database: balance now $35, cash-out rows =', JSON.stringify(rows));
    console.log('  page errors from the payout:', JSON.stringify(pageErrors.slice(errs3)));
    console.log('  toasts on screen:', JSON.stringify(co.toasts), '| amount field still holds:', JSON.stringify(co.amtField), '| cash window open:', co.modalOpen);
  } catch (e) {
    console.log('PROBE ERROR:', e.message);
  } finally {
    console.log('\nall page errors:', JSON.stringify(pageErrors));
    await browser.close(); await bridge.close(); db.stop();
  }
})();
