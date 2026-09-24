// Probe (20th pass, TED-192 re-check end to end). The REAL register
// (campistry_snacks_pos.html) then the REAL Snacks page, on the real chain incl.
// 283/284/289. Items named like the sale's text: "Trail Mix 2", "Chips, BBQ".
//   V1 register: Avi buys 2 × Trail Mix 2 + 1 × Chips, BBQ → what the page sends,
//      what the sale line keeps
//   V2 Snacks → Avi's history → Void: which items are offered back to stock
//   V3 Void → wallet back, stock back exactly (+2 / +1), nothing more
// Run: node ted/probes/2026-09-24-billing-20/void20.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8521;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const AVI = 'Avi Katz';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = boot({ port: 5826 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'POS Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('app1', { camperRoster: { [AVI]: { camperId: 1, division: 'Boys', grade: 'Junior', bunk: 'J1' } } });
  kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [{ id: 11, name: 'Trail Mix 2', price: 2, cat: 'snack', stock: 10, totalSold: 0 },
    { id: 12, name: 'Chips, BBQ', price: 1, cat: 'snack', stock: 10, totalSold: 0 }], settings: { payMethods: ['cash'], defaultDailyLimit: 0 } });
  db.sql(`INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', ${lit(AVI)}, ${lit(AVI)}) ON CONFLICT DO NOTHING;
    SELECT public.canteen_account_save('${CAMP}', ${lit(AVI)}, '{"balance": 20, "camperId": 1, "dailyLimit": 0}'::jsonb);
    SELECT public.canteen_post('${CAMP}', ${lit(AVI)}, '{"type":"credit","kind":"deposit","method":"cash","amount":20,"date":"2026-07-01","timestamp":1,"camperId":1}'::jsonb);`);
  const bal = () => q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(AVI)}`);
  const stock = () => q1(`SELECT string_agg((i->>'name') || ' ' || coalesce(i->>'stock','?') || ' left', '; ') FROM jsonb_array_elements((SELECT value->'inventory' FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistrySnacks')) i`);
  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  try {
    log('V1. the register: Avi buys 2 × Trail Mix 2 and 1 × Chips, BBQ');
    await page.goto(`http://localhost:${PORT}/campistry_snacks_pos.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistrySnacksPOS, null, { timeout: 30000 });
    await page.waitForFunction((n) => [...document.querySelectorAll('.camper-item .camper-name')].some(e => e.textContent.trim() === n), AVI, { timeout: 30000 });
    await page.evaluate(() => { const c = window.CampistryDB.getClient(); const o = c.rpc.bind(c); window.__sent = [];
      c.rpc = (fn, args) => { if (/^submit_canteen/.test(fn)) window.__sent.push({ fn, p_sold: args && args.p_sold, p_items: args && args.p_items }); return o(fn, args); }; });
    await page.click('.camper-item:has-text("' + AVI + '")'); await page.waitForSelector('.item-tile', { timeout: 10000 });
    await page.click('.item-tile:has-text("Trail Mix 2")'); await page.click('.item-tile:has-text("Trail Mix 2")'); await page.click('.item-tile:has-text("Chips, BBQ")');
    await page.waitForFunction(() => { const b = document.getElementById('chargeBtn'); return b && !b.disabled; }, null, { timeout: 10000 });
    await page.click('#chargeBtn'); await wait(3000);
    const sent = await page.evaluate(() => window.__sent);
    const line = q1(`SELECT items || ' | ' || amount || ' | ' || COALESCE((payload->'soldItems')::text,'(no soldItems)') FROM canteen_transactions WHERE camp_id='${CAMP}' AND tx_type='debit'`);
    log(`    sent ${JSON.stringify(sent)}\n    sale line: ${line}; Avi $${bal()}; stock ${stock()}`);
    check('V1 the sale keeps what it sold by id', /"id": 11, "qty": 2/.test(line) && /"id": 12, "qty": 1/.test(line), line);

    log('\nV2. Snacks → Avi\'s history → Void');
    await page.goto(`http://localhost:${PORT}/campistry_snacks.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistrySnacks, null, { timeout: 30000 });
    await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), AVI, { timeout: 30000 });
    await wait(2500);
    await page.evaluate((n) => window.viewAccountHistory(n), AVI); await wait(1500);
    await page.evaluate(() => { const b = [...document.querySelectorAll('.hist-row button')].find(x => /Void/.test(x.textContent)); b && b.click(); }); await wait(800);
    const offered = await page.evaluate(() => [...document.querySelectorAll('#voidItems label, #voidItems div')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    log(`    offered: ${JSON.stringify(offered)}`);
    check('V2 both items offered back with the sold quantities', offered.some(t => /Put 2 × Trail Mix 2 back/.test(t)) && offered.some(t => /Put 1 × Chips, BBQ back/.test(t)), JSON.stringify(offered));
    await page.screenshot({ path: path.join(__dirname, 'void20_window.png') });

    log('\nV3. Void it');
    await page.click('#voidBtn', { timeout: 5000 }).catch(async (e) => { log('    click: ' + String(e.message).split('\n')[0]); await page.evaluate(() => document.getElementById('voidBtn').click()); });
    await wait(3000);
    log(`    Avi $${bal()}; stock ${stock()}`);
    check('V3 $5 back; stock back to 10 / 10', Number(bal()) === 20 && /Trail Mix 2 10 left; Chips, BBQ 10 left/.test(stock()), `Avi $${bal()}, ${stock()}`);
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
