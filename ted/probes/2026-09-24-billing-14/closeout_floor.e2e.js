// Probe (14th pass, TED-142 re-check: Me's season close-out). The REAL Me page
// in a real browser against real SQL (the project's smoke harness), Billing →
// a family → "Close out…", for a child whose canteen wallet has $50 and whose
// parent set a $10 Balance Floor in Link. TED-142 made the close-out offer the
// WHOLE balance; its cash / cheque / donate choices take the money off through
// canteen_office_cash_out (migration 240) — which still keeps the floor.
//
//   K0 the camp's Snacks settings as they come (daily cash limit $20, the
//      default): NO floor, "Hand back in cash" / "Donate" / "Send a cheque"
//   then with the daily cash limit switched off (Snacks settings, 0 = none):
//   K1 "Hand back in cash" for the $50 offered, $10 floor → what happens?
//   K2 "Donate to the camp", $10 floor → what happens?
//   K3 control: NO floor → "Hand back in cash"
// Run: node ted/probes/2026-09-24-billing-14/closeout_floor.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));

const PORT = 8195;
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
  const db = boot({ port: 5659 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistryMe', { families: { katz: { name: 'Katz', camperIds: [CAMPER], entries: [] } } });

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
  const wallet = () => ({ bal: Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND deleted_at IS NULL LIMIT 1`)),
    outs: q1(`SELECT coalesce(string_agg((payload->>'kind') || ' $' || amount, ', '), 'none') FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind' NOT IN ('deposit')`) });
  const setWallet = (bal, floor, camperId) => db.sql(`SELECT public.canteen_account_save('${CAMP}', ${lit(CAMPER)}, ${lit(JSON.stringify({ balance: bal, balanceFloor: floor, camperId }))}::jsonb);`);
  const closeOut = async (disposition) => {
    await openMe();
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => window.CampistryMe.closeOutFamily('katz'));
    await page.waitForSelector('#coForm', { timeout: 15000 });
    const line = (await page.textContent('#coForm')).replace(/\s+/g, ' ').trim().slice(0, 200);
    await page.selectOption('.coDisp[data-kind="canteen"]', disposition);
    await page.evaluate(() => window.CampistryMe._closeoutPreview('katz'));
    await page.click('#dynModalSave');
    await new Promise(r => setTimeout(r, 4000));
    return { line, toast: (await toasts()).slice(-1) };
  };
  try {
    // a real camper with a number (the Me page's own form)
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
    db.sql(`SELECT public.canteen_post('${CAMP}', ${lit(CAMPER)}, ${lit(JSON.stringify({ type: 'credit', kind: 'deposit', method: 'cash', amount: 50, date: '2026-07-01', timestamp: 1, camperId }))}::jsonb);`);
    log(`SETUP: ${CAMPER} (#${camperId}), $50 on the canteen wallet (cash, at the office); the Katz family has no credit on its bill.`);

    for (const [disp, label] of [['cash', 'Hand back in cash'], ['donate', 'Donate to the camp'], ['check', 'Send a cheque']]) {
      setWallet(50, 0, camperId);
      db.sql(`DELETE FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind' NOT IN ('deposit');`);
      log(`\nK0. Default Snacks settings (daily cash limit $20), NO floor. Close out… → "${label}"`);
      const r = await closeOut(disp);
      const w = wallet();
      log(`    toast: ${JSON.stringify(r.toast)}\n    wallet now $${w.bal}; lines taken off: ${w.outs}`);
      check(`K0 "${label}": the $50 the close-out offered comes off the wallet`, w.bal === 0, `wallet still $${w.bal}`);
    }
    kv('campistrySnacks', { settings: { cashDailyMax: 0, cashReasonRequired: true, cashAllowNegative: false } });
    log('\n— Snacks settings: daily cash limit switched OFF (0) from here on —');
    for (const [k, disp, label] of [['K1', 'cash', 'Hand back in cash'], ['K2', 'donate', 'Donate to the camp']]) {
      setWallet(50, 10, camperId);
      db.sql(`DELETE FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind' NOT IN ('deposit');`);
      log(`\n${k}. The parent set a $10 Balance Floor. Billing → Katz → Close out… → "${label}"`);
      const r = await closeOut(disp);
      const w = wallet();
      log(`    the window: "${r.line}"\n    toast: ${JSON.stringify(r.toast)}\n    wallet now $${w.bal}; lines taken off: ${w.outs}`);
      check(`${k} the $50 the close-out offered comes off the wallet ("${label}")`, w.bal === 0, `wallet still $${w.bal}`);
    }
    setWallet(50, 0, camperId);
    db.sql(`DELETE FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind' NOT IN ('deposit');`);
    log(`\nK3. Control: no floor. Close out… → "Hand back in cash"`);
    const r3 = await closeOut('cash');
    const w3 = wallet();
    log(`    toast: ${JSON.stringify(r3.toast)}\n    wallet now $${w3.bal}; lines taken off: ${w3.outs}`);
    check('K3 (control) with no floor the $50 comes off', w3.bal === 0, `wallet $${w3.bal}`);
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
