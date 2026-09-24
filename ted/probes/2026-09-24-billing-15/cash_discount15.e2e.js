// Probe (15th pass, hunt: the "cash discount" card-fee mode, never audited).
// Me → Settings → Card Fees → "Discount for not paying by card" (3%), which the
// settings call "Safest of the three". The REAL public registration form and the
// REAL Me page, in a real browser against the real migration chain.
//   C1 A parent opens the registration form: what does it promise?
//   C2 The Wolf family owes $1,000 and pays by cheque, taking the promised 3%
//      off ($970). The office records the cheque (Billing → Record Payment).
//      What does Wolf owe afterwards?
//   C3 What tool does the office have to give the discount? "Add card
//      surcharge…" in this mode.
// Where the discount is read at all: grep of every file (logged below).
// Run: node ted/probes/2026-09-24-billing-15/cash_discount15.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));

const PORT = 8209;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };

(async () => {
  const db = boot({ port: 5687 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  const POL = { mode: 'cash_discount', cashDiscountPct: 3, cashDiscountFlat: 0, state: 'NY' };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const d = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  kv('campistryMe', { families: { wolf: { name: 'Wolf', camperIds: ['Tal Wolf'], entries: [{ id: 'le_t_w', kind: 'charge', amount: 1000, reason: 'tuition', date: d }] } },
    enrollSettings: { cardFeePolicy: POL, formConfig: { paymentMethods: ['check', 'card', 'ach'] } },
    sessions: [{ id: 's1', name: 'Full Summer', startDate: '2027-06-28', endDate: '2027-08-20', price: 1000 }] });
  const owes = () => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','wolf'))`));

  const reads = execSync(`cd ${R} && grep -rln "CampistryCardFees\\|cardFeePolicy" --include=*.js --include=*.html --include=*.ts . | grep -v node_modules | grep -v '^./ted/' | grep -v '^./tests/' | sort`).toString().trim().split('\n');
  const discountReads = execSync(`cd ${R} && (grep -rn "\\.discount\\b" --include=*.js --include=*.html --include=*.ts . | grep -v node_modules | grep -v '^./ted/' | grep -v '^./tests/' | grep -i "quote\\|cardFee\\|q\\.discount" || true)`).toString().trim();
  log(`Files that read the card-fee policy at all: ${reads.join(', ')}`);
  log(`Places that read a quote's discount: ${discountReads || 'none'}`);

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  const newPage = async (signedIn) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
    page.on('dialog', dd => dd.dismiss().catch(() => {}));
    await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
    await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
        users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }]${signedIn ? `, signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' }` : ''} });`);
    return page;
  };
  try {
    log(`\nC1. A parent opens the registration form (${'campistry_register.html?camp=' + CAMP})`);
    const reg = await newPage(false);
    await reg.goto(`http://localhost:${PORT}/campistry_register.html?camp=${CAMP}`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 6000));
    await reg.evaluate(() => { try { _regRenderCardFee(); } catch (e) {} });
    const note = await reg.evaluate(() => { const b = document.getElementById('cardFeeNote'); return b ? b.textContent.replace(/\s+/g, ' ').trim() : '(no box)'; });
    log(`    the card-fee note on the form: "${note}"`);

    log(`\nC2. Wolf owes $${owes()} and pays by cheque, taking the promised 3% off: $970. Me → Billing → Wolf → Record Payment $970 (cheque)`);
    const me = await newPage(true);
    await me.goto(`http://localhost:${PORT}/campistry_me.html`, { waitUntil: 'domcontentloaded' });
    await me.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await me.evaluate(() => window.CampistryMe.nav('billing'));
    await new Promise(r => setTimeout(r, 3000));
    const rp = await me.evaluate(() => Object.keys(window.CampistryMe).filter(k => /openPaymentForFamily|recordPayment|finAddPayment/i.test(k)));
    log(`    Record Payment entry points on the page: ${JSON.stringify(rp)}`);
    await me.evaluate(() => { window.CampistryMe.openPaymentForFamily('wolf'); });
    await new Promise(r => setTimeout(r, 1200));
    const form = await me.evaluate(() => { const m = document.getElementById('dynModal'); return m ? m.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : '(no window)'; });
    log(`    the Record Payment window: "${form}"`);
    const ids = await me.evaluate(() => [...document.querySelectorAll('#dynModal input, #dynModal select')].map(e => e.id + ':' + e.tagName + (e.tagName === 'SELECT' ? '[' + [...e.options].map(o => o.value).join('|') + ']' : '')));
    log(`    its fields: ${JSON.stringify(ids)}`);
    const amtId = ids.map(s => s.split(':')[0]).find(i => /amt|amount/i.test(i));
    const methId = ids.map(s => s.split(':')[0]).find(i => /meth/i.test(i));
    if (amtId) await me.fill('#' + amtId, '970');
    if (methId) { const opts = ids.find(s => s.startsWith(methId + ':')) || ''; const chk = (opts.match(/\[(.*)\]/) || [, ''])[1].split('|').find(v => /check|cheque/i.test(v)); if (chk) await me.selectOption('#' + methId, chk); }
    const formAfter = await me.evaluate(() => { const m = document.getElementById('dynModal'); return m ? m.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : ''; });
    log(`    after typing $970 by cheque: "${formAfter}"`);
    await me.click('#dynModalSave');
    await new Promise(r => setTimeout(r, 3500));
    log(`    Wolf now owes $${owes()}`);
    check('C2 a family that pays by cheque with the promised 3% off owes nothing', owes() === 0, `Wolf still owes $${owes()} — the 3% the form promised was never taken off`);

    log(`\nC3. The office looks for a way to give the discount: Billing → Wolf → "Add card surcharge…" in this mode`);
    await me.evaluate(() => window.CampistryMe.addCardSurcharge('wolf'));
    await new Promise(r => setTimeout(r, 1200));
    const win = await me.evaluate(() => { const m = document.getElementById('dynModal'); return m ? m.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : '(no window)'; });
    log(`    window: "${win}"`);
    if (await me.$('#csBase')) { await me.fill('#csBase', '1000'); await me.evaluate(() => window.CampistryMe._surchargePreview()); await me.click('#dynModalSave'); await new Promise(r => setTimeout(r, 1500)); }
    const t = await me.evaluate(() => { const e = document.getElementById('tM'); return e ? e.textContent : ''; });
    log(`    toast: "${t}"; Wolf owes $${owes()}`);
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
