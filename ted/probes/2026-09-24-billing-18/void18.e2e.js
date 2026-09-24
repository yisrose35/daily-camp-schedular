// Probe (18th pass, TED-175 re-check in a real browser). The REAL Snacks page
// (smoke harness: real migration chain incl. 284, vendored-style shim).
// Avi Katz: $20 cash deposit at the desk; then the register charges him $5
// for "Ices ×2" by mistake (the real submit_canteen_purchase_once, as the
// register sends it; the register's own stock count as it leaves it).
//   D1 Snacks → Avi's history: which lines offer "Void"?
//   D2 Void the sale (both Ices ticked back) → wallet, stock, lines
//   D3 the day's numbers: Sales today, Analytics revenue, cash drawer
//      ("Cash deposits in"), today's list labels
// Run: node ted/probes/2026-09-24-billing-18/void18.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8463;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const CAMPER = 'Avi Katz';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(what, fn, ms) {
  const until = Date.now() + (ms || 15000); let last;
  while (Date.now() < until) { try { if (await fn()) return true; } catch (e) { last = e.message; } await wait(200); }
  throw new Error('timed out waiting for ' + what + (last ? ' (' + last + ')' : ''));
}
(async () => {
  const db = boot({ port: 5763 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Void Camp', 'o@v.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                               ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [{ id: 1, name: 'Ices', price: 2.5, cat: 'snack', stock: 8, soldToday: 2, totalSold: 2 }], settings: { payMethods: ['cash', 'card'], defaultDailyLimit: 0 } });
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
  const open = async (file, ready) => {
    await page.goto('http://localhost:' + PORT + '/' + file, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId(), null, { timeout: 30000 });
    if (ready) await page.waitForFunction(ready, null, { timeout: 30000 });
  };
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));
  try {
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
    let camperId = null;
    await waitFor('the roster saved with a camper number', () => {
      const r = db.json(`SELECT value FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='app1'`);
      const rec = r.length && r[0].value.camperRoster && r[0].value.camperRoster[CAMPER];
      if (rec && Number(rec.camperId) > 0) { camperId = Number(rec.camperId); return true; }
      return false;
    }, 30000);
    const today = q1(`SELECT to_char(now(), 'YYYY-MM-DD')`);
    const claims = `SET "request.jwt.claims" = '{"sub":"${OWNER}"}';`;
    db.sql(`${claims} SELECT public.canteen_office_credit('${CAMP}', ${lit(CAMPER)}, 20, 'cash', NULL, NULL, ${camperId});`);
    db.sql(`${claims} SELECT public.submit_canteen_purchase_once('${CAMP}', 'sale_v18', ${lit(CAMPER)}, 5, 'Ices ×2', '${today}'::date, ${camperId});`);
    const wallet = () => q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND person_id=${camperId}`);
    const stock = () => q1(`SELECT (e->>'stock') || ' left, ' || (e->>'soldToday') || ' sold today, ' || (e->>'totalSold') || ' sold' FROM camp_state_kv, jsonb_array_elements(value->'inventory') e WHERE camp_id='${CAMP}' AND key='campistrySnacks'`);
    log(`SETUP: ${CAMPER} (#${camperId}) $20 cash in, then $5 "Ices ×2" at the register → wallet $${wallet()}; Ices ${stock()}`);

    const numbers = async () => {
      await open('campistry_snacks.html', () => !!window.CampistrySnacks);
      await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
      await wait(2500);
      return page.evaluate(() => {
        const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.replace(/\s+/g, ' ').trim() : '(none)'; };
        try { window.rAnalytics && window.rAnalytics(); } catch (_) {}
        try { window.rSettings && window.rSettings(); } catch (_) {}
        const rows = [...document.querySelectorAll('#txBody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim());
        return { salesToday: t('sS'), revenue: t('mRev'), txns: t('mTxn'), drawer: t('cashDrawerBox').slice(0, 120), rows };
      });
    };
    const n0 = await numbers();
    log(`    before: Sales today "${n0.salesToday}", Revenue "${n0.revenue}", ${n0.txns}; drawer "${n0.drawer}"`);

    log('\nD1. Avi\'s history: which lines offer "Void"?');
    await page.evaluate((n) => window.viewAccountHistory(n), CAMPER); await wait(1500);
    const hist = await page.evaluate(() => [...document.querySelectorAll('.hist-row')].map(r => ({ t: r.textContent.replace(/\s+/g, ' ').trim(), v: !!r.querySelector('button') })));
    log(`    ${JSON.stringify(hist)}`);
    check('D1 only the register sale offers Void', hist.filter(h => h.v).length === 1 && hist.find(h => h.v && /Ices/.test(h.t)), JSON.stringify(hist));

    log('\nD2. Void it (both Ices back)');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.hist-row button')].find(x => /Void/.test(x.textContent)); b && b.click(); }); await wait(800);
    const dlg = await page.evaluate(() => ((document.getElementById('voidSummary') || {}).textContent || '') + ' | ' + ((document.getElementById('voidItems') || {}).textContent || ''));
    log(`    window: "${dlg.replace(/\s+/g, ' ').slice(0, 300)}"`);
    const vis = await page.evaluate(() => { const b = document.getElementById('voidBtn'); const m = document.getElementById('m-void'); if (!b) return 'no #voidBtn'; const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return JSON.stringify({ modalClass: m && m.className, modalDisplay: m && getComputedStyle(m).display, z: m && getComputedStyle(m).zIndex, btnRect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], topmost: top ? (top.id || top.className || top.tagName) : null, openModals: [...document.querySelectorAll('.modal-overlay')].filter(o => getComputedStyle(o).display !== 'none').map(o => o.id + ' z' + getComputedStyle(o).zIndex) }); });
    log(`    the Void window on screen: ${vis}`);
    await page.screenshot({ path: path.join(__dirname, 'void18_window.png') });
    await page.click('#voidBtn', { timeout: 5000 }).catch(async (e) => { log('    a real click did not reach "Void sale" (' + String(e.message).split('\n')[0] + ') — pressing it from script to carry on'); await page.evaluate(() => document.getElementById('voidBtn').click()); });
    await wait(3000);
    log(`    toast ${JSON.stringify((await toasts()).slice(-1))}; wallet $${wallet()}; Ices ${stock()}; lines: ${q1(`SELECT string_agg(tx_type || ' ' || COALESCE(payload->>'kind','') || ' $' || amount || COALESCE(' method=' || (payload->>'method'), ''), ', ' ORDER BY first_seen) FROM canteen_transactions WHERE camp_id='${CAMP}'`)}`);
    check('D2 $5 back on the wallet, both Ices back in stock, a void line with no payment method', Number(wallet()) === 20 && /^10 left, 0 sold today, 0 sold/.test(stock()), `wallet $${wallet()}, Ices ${stock()}`);

    log('\nD3. the day\'s numbers after the void');
    const n1 = await numbers();
    log(`    after: Sales today "${n1.salesToday}", Revenue "${n1.revenue}", ${n1.txns}; drawer "${n1.drawer}"\n    today's list: ${JSON.stringify(n1.rows)}`);
    check('D3 the voided sale is not a sale any more (Sales today / Revenue $0)', /\$0(\.00)?\b/.test(n1.salesToday) && /\$0(\.00)?\b/.test(n1.revenue), `${n1.salesToday} / ${n1.revenue}`);
    check('D3 the cash drawer still says $20 came in (the void is not cash)', n1.drawer === n0.drawer, n1.drawer);
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
