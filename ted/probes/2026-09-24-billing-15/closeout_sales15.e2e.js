// Probe (15th pass, hunt: what the season close-out does to the canteen's
// numbers). The REAL Me page (Billing → Close out…) and then the REAL Snacks
// page, in a real browser against the real migration chain (the smoke harness).
//
// Avi has $50 on the canteen wallet (cash). Today he buys a $3 snack, and the
// office hands him $10 cash from the till (a 'cash_out' line, the shape
// migration 240 writes). At the end of the season the office closes the family
// out: the remaining $37 → "Hand back in cash" (migration 280's
// canteen_season_closeout, kind 'closeout').
//   Z1 Snacks → Dashboard "Sales today" and "Cash out" tiles, before and after
//   Z2 Snacks → Analytics "Revenue", "txns", average, the weekly chart, and how
//      the close-out line is labelled in today's list
// Migration 240's own comment: "kind:'cash_out' is what lets revenue reporting
// and the drawer tell this from a sale".
// Run: node ted/probes/2026-09-24-billing-15/closeout_sales15.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));

const PORT = 8207;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const CAMPER = 'Avi Katz';
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
  const db = boot({ port: 5681 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistryMe', { families: { katz: { name: 'Katz', camperIds: [CAMPER], entries: [] } } });
  kv('campistrySnacks', { inventory: [], settings: { payMethods: ['cash', 'card'], defaultDailyLimit: 0, cashDailyMax: 20 } });

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
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));
  const openMe = async () => {
    await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await page.waitForFunction(() => { const g = window.loadGlobalSettings && window.loadGlobalSettings(); return !!(g && g.campStructure && g.campStructure.Boys); }, null, { timeout: 30000 });
  };
  const snacksNumbers = async () => {
    await page.goto('http://localhost:' + PORT + '/campistry_snacks.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistrySnacks, null, { timeout: 30000 });
    await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    return page.evaluate(() => {
      const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.replace(/\s+/g, ' ').trim() : '(none)'; };
      const rows = [...document.querySelectorAll('#txBody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim());
      const bars = [...document.querySelectorAll('#wChart .bar-value')].map(b => b.textContent).join(' ');
      return { salesToday: t('sS'), cashOut: t('sC'), revenue: t('mRev'), txns: t('mTxn'), avg: t('mAvg'), bars, rows };
    });
  };
  try {
    await openMe();
    await page.evaluate(() => window.CampistryMe.nav('campers'));
    await page.evaluate(() => window.CampistryMe.editCamper(null));
    await page.waitForSelector('#ceFirst', { timeout: 10000 });
    await page.waitForFunction(() => { const s = document.getElementById('ceDiv'); return s && [...s.options].some(o => o.value === 'Boys'); }, null, { timeout: 10000 });
    await page.fill('#ceFirst', 'Avi'); await page.fill('#ceLast', 'Katz');
    await page.selectOption('#ceDiv', 'Boys'); await page.selectOption('#ceCGrade', 'Junior'); await page.selectOption('#ceBunk', 'J1');
    await page.click('#ceSave');
    await page.waitForSelector('#camperEditModal', { state: 'hidden', timeout: 10000 });
    let camperId = null;
    await waitFor('the roster saved with a camper number', () => {
      const r = db.json(`SELECT value FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='app1'`);
      const rec = r.length && r[0].value.camperRoster && r[0].value.camperRoster[CAMPER];
      if (rec && Number(rec.camperId) > 0) { camperId = Number(rec.camperId); return true; }
      return false;
    }, 30000);
    const today = q1(`SELECT to_char(now(), 'YYYY-MM-DD')`);
    const post = (o) => db.sql(`SELECT public.canteen_post('${CAMP}', ${lit(CAMPER)}, ${lit(JSON.stringify(Object.assign({ camperId, camper: CAMPER, time: '10:00 AM' }, o)))}::jsonb);`);
    post({ type: 'credit', kind: 'deposit', method: 'cash', amount: 50, date: '2026-07-01', timestamp: 1 });
    post({ type: 'debit', kind: 'purchase', items: 'Chips', amount: 3, date: today, timestamp: Date.now() - 60000 });
    post({ type: 'debit', kind: 'cash_out', items: 'Cash out — trip money', amount: 10, date: today, timestamp: Date.now() - 30000 });
    db.sql(`SELECT public.canteen_account_save('${CAMP}', ${lit(CAMPER)}, ${lit(JSON.stringify({ balance: 37, camperId }))}::jsonb);`);
    log(`SETUP: ${CAMPER} (#${camperId}): $50 deposited in cash; today a $3 snack and $10 cash out from the till; wallet $37`);

    log(`\nZ1a. Snacks before the close-out`);
    const before = await snacksNumbers();
    log(`    Dashboard: Sales today "${before.salesToday}", Cash out "${before.cashOut}"; Analytics: Revenue "${before.revenue}", ${before.txns}, avg ${before.avg}; weekly bars [${before.bars}]`);

    log(`\nZ1b. Me → Billing → Katz → Close out… → canteen $37 "Hand back in cash" → Apply`);
    await openMe();
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => window.CampistryMe.closeOutFamily('katz'));
    await page.waitForSelector('#coForm', { timeout: 15000 });
    await page.selectOption('.coDisp[data-kind="canteen"]', 'cash');
    await page.evaluate(() => window.CampistryMe._closeoutPreview('katz'));
    await page.click('#dynModalSave');
    await new Promise(r => setTimeout(r, 4000));
    log(`    toast: ${JSON.stringify((await toasts()).slice(-1))}; wallet $${q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND deleted_at IS NULL LIMIT 1`)}; lines today: ${q1(`SELECT string_agg((payload->>'kind') || ' $' || amount, ', ' ORDER BY first_seen) FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'date' = '${today}'`)}`);

    log(`\nZ2. Snacks after the close-out`);
    const after = await snacksNumbers();
    log(`    Dashboard: Sales today "${after.salesToday}", Cash out "${after.cashOut}"; Analytics: Revenue "${after.revenue}", ${after.txns}, avg ${after.avg}; weekly bars [${after.bars}]`);
    log(`    today's list: ${JSON.stringify(after.rows)}`);
    check('Z2 the $37 handed back at close-out is not counted as a canteen sale (Sales today and Revenue stay at the $3 snack)',
      after.salesToday === before.salesToday && after.revenue === before.revenue,
      `Sales today ${before.salesToday} → ${after.salesToday}; Revenue ${before.revenue} → ${after.revenue}; the close-out row is labelled "${(after.rows.find(r => /close-out/i.test(r)) || '').replace(/.*(Purchase|Cash out|Refund|Deposit).*/, '$1')}"`);
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
