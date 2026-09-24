// Probe (17th pass, hunt — the offline register, never audited). The REAL
// campistry_snacks_pos_offline.html in Chromium (it needs no server: it keeps
// accounts, stock and sales in the tablet's own IndexedDB). Set up the way a
// camp does: camp name, PIN, then the office's export file (accounts + menu).
//   O0 control: one tap → one sale
//   O1 a double tap the touchscreen registers as two taps in the same instant
//   O2 two taps 40 ms apart (a bouncy screen / an impatient counselor)
//   O3 "Export sales" once → the file; the file is lost; "Export sales" again
//      → what does the second file hold? any way to get the sales back out?
// Run: node ted/probes/2026-09-24-billing-17/offline_register17.e2e.js
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
  }).listen(8431);
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).split('\n')[0]));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:8431') ? r.continue() : r.abort());
  try {
    await page.goto('http://localhost:8431/campistry_snacks_pos_offline.html', { waitUntil: 'load' });
    await wait(1500);
    const data = { accounts: { 'Shaya Brickman': { balance: 20, dailyLimit: 0, spentToday: 0, camperId: 1 } },
      inventory: [{ id: 1, name: 'Ices', price: 2.5, cat: 'snack', stock: 30 }], settings: { campName: 'Offline Camp' } };
    const tmp = path.join(__dirname, 'offline_register17.import.json'); fs.writeFileSync(tmp, JSON.stringify(data));
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
  } catch (e) {
    check('the run finished', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  } finally {
    log('page errors: ' + JSON.stringify(errs));
    await browser.close().catch(() => {});
    srv.close();
    log(`\n${bad} BAD`);
  }
})();
