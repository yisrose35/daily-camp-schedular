// Probe (16th pass, hunt — POS register maths, never deep-audited). The REAL
// register page (campistry_snacks_pos.html) in Chromium on the real migration
// chain (smoke harness). The harness's shim sends every database call as a
// SYNCHRONOUS request, which the real supabase-js never does (it uses fetch),
// and which would hide any double-tap race. So, after the page loads, this
// probe sends the register's submit_canteen_purchase through fetch — async,
// like the real library — to the same bridge, optionally slower (camp wifi)
// or with the answer lost after the server did the work.
//   P0 control: one tap on "Charge $2.50 → Shaya" → one debit
//   P1 the answer takes 1.2 s; the counselor taps Charge again after 0.3 s
//   P2 the server charged but the answer is lost (wifi drops) → what does the
//      register say? The counselor taps Charge again (answer arrives this time)
// Each case: the debits on the child's canteen account, and the balance.
// Run: node ted/probes/2026-09-24-billing-16/pos_double16.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));

const PORT = 8317;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const CAMPER = 'Shaya Brickman';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = boot({ port: 5700 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'POS Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('app1', { camperRoster: { [CAMPER]: { camperId: 1, division: 'Boys', grade: 'Junior', bunk: 'J1' } } });
  kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [{ id: 1, name: 'Ices', price: 2.5, cat: 'snack', stock: null, totalSold: 0 }],
    settings: { payMethods: ['cash'], defaultDailyLimit: 0 } });
  db.sql(`INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', ${lit(CAMPER)}, ${lit(CAMPER)}) ON CONFLICT DO NOTHING;
    SELECT public.canteen_account_save('${CAMP}', ${lit(CAMPER)}, '{"balance": 40, "camperId": 1, "dailyLimit": 0}'::jsonb);
    SELECT public.canteen_post('${CAMP}', ${lit(CAMPER)}, '{"type":"credit","kind":"deposit","method":"cash","amount":40,"date":"2026-07-01","timestamp":1,"camperId":1}'::jsonb);`);
  const debits = () => Number(q1(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${CAMP}' AND tx_type='debit'`));
  const bal = () => q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(CAMPER)}`);

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, .pos-toast')].map(t => t.textContent.trim()).filter(Boolean));
  try {
    await page.goto(`http://localhost:${PORT}/campistry_snacks_pos.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistrySnacksPOS, null, { timeout: 30000 });
    await page.waitForFunction((n) => [...document.querySelectorAll('.camper-item .camper-name')].some(e => e.textContent.trim() === n), CAMPER, { timeout: 30000 });
    // The register's charge goes out async (like supabase-js), through the same bridge.
    const wrapped = await page.evaluate(({ ep, uid }) => {
      const c = window.CampistryDB.getClient(); const orig = c.rpc.bind(c);
      window.__delay = 0; window.__drop = false; window.__sent = 0;
      c.rpc = function (fn, args) {
        if (fn !== 'submit_canteen_purchase') return orig(fn, args);
        window.__sent++;
        const delay = window.__delay, drop = window.__drop;
        return new Promise((resolve) => setTimeout(async () => {
          const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'rpc', fn, args, userId: uid }) });
          const j = await r.json();
          if (drop) resolve({ data: null, error: { message: 'TypeError: Failed to fetch' } });   // the server did it; the answer never came
          else resolve(j.error ? { data: null, error: j.error } : { data: j.data, error: null });
        }, delay));
      };
      return c.rpc !== orig && window.CampistryDB.getClient() === c;
    }, { ep: `http://localhost:${PORT}/__pg`, uid: OWNER });
    log(`the register's client is the one wrapped: ${wrapped}; start: debits ${debits()}, balance $${bal()}`);
    const ring = async () => {
      await page.click('.camper-item:has-text("' + CAMPER + '")');
      await page.waitForSelector('.item-tile', { timeout: 10000 });
      await page.click('.item-tile:has-text("Ices")');
      await page.waitForFunction(() => { const b = document.getElementById('chargeBtn'); return b && !b.disabled; }, null, { timeout: 10000 });
    };
    const btn = () => page.evaluate(() => { const b = document.getElementById('chargeBtn'); return b ? (b.disabled ? '[disabled] ' : '') + b.textContent.trim() : '(none)'; });

    log(`\nP0. Control: one tap`);
    await ring(); await page.click('#chargeBtn'); await wait(1500);
    log(`    debits ${debits()}, balance $${bal()}; register says ${JSON.stringify(await toasts())}`);
    check('P0 one tap → one $2.50 debit', debits() === 1 && Number(bal()) === 37.5, `debits ${debits()}, balance $${bal()}`);

    log(`\nP1. The answer takes 1.2 s (camp wifi); the counselor taps Charge again after 0.3 s`);
    const d1 = debits();
    await ring();
    await page.evaluate(() => { window.__delay = 1200; });
    await page.click('#chargeBtn');
    await wait(300);
    log(`    0.3 s after the first tap the button reads: "${await btn()}"`);
    await page.click('#chargeBtn', { force: true }).catch(e => log('    second tap: ' + String(e.message).split('\n')[0]));
    await wait(2500);
    await page.evaluate(() => { window.__delay = 0; });
    log(`    requests sent ${await page.evaluate(() => window.__sent)}; new debits ${debits() - d1}; balance $${bal()}; register says ${JSON.stringify(await toasts())}`);
    check('P1 a second tap while the first is on its way does not charge the child again', debits() - d1 === 1, `${debits() - d1} debits of $2.50 for one Ices — balance $${bal()}`);

    log(`\nP2. The server charged, but the answer is lost (wifi drops)`);
    const d2 = debits();
    await ring();
    await page.evaluate(() => { window.__drop = true; });
    await page.click('#chargeBtn'); await wait(1500);
    const said = await toasts();
    log(`    register says ${JSON.stringify(said)}; button "${await btn()}"; debits so far +${debits() - d2}`);
    await page.evaluate(() => { window.__drop = false; });
    await page.click('#chargeBtn').catch(e => log('    second tap: ' + String(e.message).split('\n')[0]));
    await wait(1500);
    log(`    counselor taps Charge again → register says ${JSON.stringify(await toasts())}; new debits ${debits() - d2}; balance $${bal()}`);
    check('P2 after a lost answer the child is charged once for one Ices', debits() - d2 === 1, `${debits() - d2} debits — the register said "${said.join(' / ')}" although the server had charged`);
    log(`    ledger: ${q1(`SELECT string_agg(tx_type || ' ' || amount || ' ' || coalesce(items,''), '; ' ORDER BY first_seen) FROM canteen_transactions WHERE camp_id='${CAMP}'`)}`);
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
