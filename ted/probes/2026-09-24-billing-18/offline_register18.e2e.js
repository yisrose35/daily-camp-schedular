// Probe (18th pass: TED-170/171 re-check; built from offline_register17). The REAL
// campistry_snacks_pos_offline.html in Chromium (it needs no server: it keeps
// accounts, stock and sales in the tablet's own IndexedDB). Set up the way a
// camp does: camp name, PIN, then the office's export file (accounts + menu).
//   O0 control: one tap → one sale
//   O1 a double tap the touchscreen registers as two taps in the same instant
//   O2 two taps 40 ms apart (a bouncy screen / an impatient counselor)
//   O3 "Export sales" once → the file; the file is lost; "Export sales" again
//      → what does the second file hold? any way to get the sales back out?
//   O4 "Export all sales again" → every sale, same ids; both files imported
//      by the office's REAL canteen_office_import_offline (real chain, as the
//      owner) → each sale charged once, stock/balance right
//   O5 Clear All Data warns about sales never exported / exported files
// Run: node ted/probes/2026-09-24-billing-18/offline_register18.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = http.createServer((req, res) => {
    const p = path.join(R, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(R) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(p);
    res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  }).listen(8461);
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:8461') ? r.continue() : r.abort());
  try {
    await page.goto('http://localhost:8461/campistry_snacks_pos_offline.html', { waitUntil: 'load' });
    await wait(1500);
    const data = { accounts: { 'Shaya Brickman': { balance: 20, dailyLimit: 0, spentToday: 0, camperId: 1 } },
      inventory: [{ id: 1, name: 'Ices', price: 2.5, cat: 'snack', stock: 30 }], settings: { campName: 'Offline Camp' } };
    const tmp = path.join(__dirname, 'offline_register18.import.json'); fs.writeFileSync(tmp, JSON.stringify(data));
    await page.evaluate(async () => {
      document.getElementById('setupCampName').value = 'Offline Camp'; await POS.setupNext(1);
      document.getElementById('setupPin').value = '1234'; document.getElementById('setupPinConfirm').value = '1234'; await POS.setupNext(2);
    });
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => POS.triggerImport('setup'))]);
    await fc.setFiles(tmp); await wait(1200);
    await page.evaluate(() => POS.setupFinish()); await wait(1000);
    const state = () => page.evaluate(() => new Promise((res) => {
      const rq = indexedDB.open('CampistryOfflinePOS'); rq.onsuccess = () => { const d = rq.result; const out = {};
        const tx = d.transaction(['accounts', 'transactions', 'inventory'], 'readonly');
        tx.objectStore('accounts').getAll().onsuccess = (e) => { const a = e.target.result.find(x => x.name === 'Shaya Brickman'); out.bal = a && a.balance; };
        tx.objectStore('transactions').getAll().onsuccess = (e) => { out.sales = e.target.result.length; out.unexported = e.target.result.filter(t => !t.exported).length; };
        tx.objectStore('inventory').getAll().onsuccess = (e) => { out.stock = e.target.result[0] && e.target.result[0].stock; };
        tx.oncomplete = () => { d.close(); res(out); }; }; }));
    const ring = async () => {
      await page.evaluate(() => { POS.pickCamper('Shaya Brickman'); POS.addItem(1); });
      await wait(200);
    };
    log(`set up: ${JSON.stringify(await state())}; charge button "${await page.textContent('#chargeBtn')}"`);

    log('\nO0. one tap');
    await ring(); await page.click('#chargeBtn'); await wait(600);
    let s = await state();
    log(`    ${JSON.stringify(s)}`);
    check('O0 one tap → one $2.50 sale', s.sales === 1 && s.bal === 17.5, JSON.stringify(s));

    log('\nO1. a double tap registered in the same instant');
    let before = await state();
    await ring();
    await page.evaluate(() => { const b = document.getElementById('chargeBtn'); b.click(); b.click(); });
    await wait(800);
    s = await state();
    log(`    before ${JSON.stringify(before)} → after ${JSON.stringify(s)}`);
    check('O1 one Ices, one sale', s.sales - before.sales === 1 && Math.abs(before.bal - s.bal - 2.5) < 0.001,
      `${s.sales - before.sales} sales, balance ${before.bal} → ${s.bal}, stock ${before.stock} → ${s.stock}`);

    log('\nO2. two taps 40 ms apart');
    before = await state();
    await ring();
    await page.evaluate(async () => { const b = document.getElementById('chargeBtn'); b.click(); await new Promise(r => setTimeout(r, 40)); b.click(); });
    await wait(800);
    s = await state();
    log(`    before ${JSON.stringify(before)} → after ${JSON.stringify(s)}`);
    check('O2 one Ices, one sale', s.sales - before.sales === 1, `${s.sales - before.sales} sales, balance ${before.bal} → ${s.bal}`);

    log('\nO3. "Export sales" → the file; then the file is lost, export again');
    const exp = async () => {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.evaluate(() => POS.exportTransactions())]);
      const p = await dl.path(); return JSON.parse(fs.readFileSync(p, 'utf8'));
    };
    const f1 = await exp(); await wait(500);
    log(`    first file: ${f1.transactionCount} sales; register now ${JSON.stringify(await state())}`);
    const f2 = await exp(); await wait(500);
    log(`    second file: ${f2.transactionCount} sales`);
    const settingsText = await page.evaluate(() => { POS.openSettings(); const t = document.getElementById('settingsOverlay').textContent.replace(/\s+/g, ' ').trim(); POS.closeSettings(); return t; });
    const reExport = /export (all|again)|re-?export/i.test(settingsText);
    log(`    settings screen: "${settingsText.slice(0, 400)}"`);
    check('O3 sales from a lost export file can be exported again', f2.transactionCount > 0 || reExport, `second export holds ${f2.transactionCount} sales; no "export again" in settings`);

    log('\nO4. the file is lost: Settings → "Export all sales again"');
    const settingsHtml = await page.evaluate(() => { POS.openSettings(); const h = document.getElementById('settingsOverlay').innerHTML; return h; });
    const hasBtn = /Export all sales again/.test(settingsHtml);
    const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.evaluate(() => POS.exportAllTransactions())]);
    const f3 = JSON.parse(fs.readFileSync(await dl3.path(), 'utf8'));
    await page.evaluate(() => POS.closeSettings());
    const ids1 = f1.transactions.map(t => t.id).sort(), ids3 = f3.transactions.map(t => t.id).sort();
    log(`    button shown: ${hasBtn}; third file: ${f3.transactionCount} sales; same ids as the first file: ${JSON.stringify(ids1) === JSON.stringify(ids3)}`);
    check('O4 "Export all sales again" is offered and holds every sale', hasBtn && f3.transactionCount === f1.transactionCount && JSON.stringify(ids1) === JSON.stringify(ids3), `${f3.transactionCount} vs ${f1.transactionCount}`);
    // The office imports BOTH files (the "lost" one turned up after all).
    const { boot } = require(path.join(R, 'tests/e2e/db'));
    const db = boot({ port: 5761 });
    const OWN = '0ed18500-0000-0000-0000-0000000000a1', CAMP = '0ed18500-0000-0000-0000-000000000001';
    const q = (s) => db.sql(s).trim();
    q(`INSERT INTO auth.users (id, email) VALUES ('${OWN}','o@t18o');
       INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWN}', 'Offline Camp');
       INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', 'Shaya Brickman', 'Shaya Brickman');
       SELECT public.canteen_account_save('${CAMP}', 'Shaya Brickman', '{"balance": 20, "camperId": 1}'::jsonb);`);
    const imp = (rows) => q(`SET "request.jwt.claims" = '{"sub":"${OWN}"}'; SELECT public.canteen_office_import_offline('${CAMP}', '${JSON.stringify(rows).replace(/'/g, "''")}'::jsonb)::text`).split('\n').pop();
    const r1 = imp(f1.transactions), r3 = imp(f3.transactions);
    const bal = q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND person_id=1`);
    const n = q(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind'='offline_sale'`);
    log(`    import file 1 → ${r1}\n    import file 3 → ${r3}\n    Shaya's wallet $20 → $${bal}; offline sales on the ledger ${n}`);
    const exp$ = 20 - 2.5 * f1.transactionCount;
    check('O4b importing the first file and the re-export charges each sale once', Number(n) === f1.transactionCount && Math.abs(Number(bal) - exp$) < 0.001, `wallet $${bal} (expected $${exp$}), ${n} sales`);
    db.stop();

    log('\nO5. one more sale (never exported), then Clear All Data');
    await ring(); await page.click('#chargeBtn'); await wait(600);
    const warn = await page.evaluate(() => { POS.openSettings(); POS.clearAllDataPrompt(); const t = (document.getElementById('settingsBody').textContent || '').replace(/\s+/g, ' '); return (t.match(/\d+ sales? (has|have) never been exported[^.]*\./) || [''])[0] + ' | ' + (t.match(/Check the office imported[^.]*\./) || [''])[0]; });
    log(`    Clear All Data says: "${warn}"`);
    check('O5 Clear All Data names the unexported sale and the exported ones', /1 sale has never been exported/.test(warn) && /Check the office imported/.test(warn), warn);
  } catch (e) {
    check('the run finished', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  } finally {
    log('page errors: ' + JSON.stringify(errs));
    await browser.close().catch(() => {});
    srv.close();
    log(`\n${bad} BAD`);
  }
})();
