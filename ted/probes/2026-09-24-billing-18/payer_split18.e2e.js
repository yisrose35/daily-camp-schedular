// Probe (18th pass, re-check TED-165 + hunt). The REAL Me page in Chromium on
// the real migration chain, two office computers (two browser contexts, each
// its own local storage), realtime not delivered (a laptop asleep / wifi drop).
//
//  S1  Computer A: Add Charge $1,000 for Pine, split Scholarship Fund $800.
//      → Pine's ledger / plan_due_for / Billing page; the fund's account.
//  S2  Computer A: Manage payers → Record payment $300 from the fund.
//  S3  Finance → Revenue on computer A: is the fund's share / cheque counted?
//  S4  Computer B (opened BEFORE S1, never refreshed) adds an unrelated $50
//      charge to Oak. What is left of the fund's account in the cloud?
//  S5  Full split: fund pays 100% of a $400 charge → Pine's bill.
//  S6  Manage payers markup: are the buttons inside each payer's row?
// Run: node ted/probes/2026-09-24-billing-18/payer_split18.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const O = path.join(R, 'ted/probes/2026-09-24-billing-18');
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8453;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const TODAY = new Date().toISOString().slice(0, 10);
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = boot({ port: 5753 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Split Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const started = (k) => [{ id: 'le_reg_' + k, kind: 'charge', amount: 100, reason: 'registration', date: '2026-05-01' }, { id: 'le_pay_reg_' + k, kind: 'payment', amount: 100, reason: 'check', date: '2026-05-01' }];
  kv('campistryMe', { families: {
      pine: { name: 'Pine', camperIds: ['Pine Kid'], cardOnFile: true, entries: started('pine'),
        plans: [{ id: 'plan_pine', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }] },
      oak: { name: 'Oak', camperIds: ['Oak Kid'], entries: started('oak') } },
    payers: { org_scholarship_fund: { id: 'org_scholarship_fund', name: 'Scholarship Fund', kind: 'organization' } } });
  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  async function computer(tag) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(tag + ': ' + String(e).split('\n')[0]));
    await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
    await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
        users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
    await page.goto(`http://localhost:${PORT}/campistry_me.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await wait(2500);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(1200);
    return page;
  }
  const fundInCloud = () => q1(`SELECT COALESCE((value->'payers'->'org_scholarship_fund'->'ledger')::text,'(no ledger)') FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistryMe'`);
  const owes = (fk) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${fk}'))`));
  try {
    const A = await computer('A');
    const B = await computer('B');   // opened now, never refreshed again

    log('S1  computer A: Add Charge $1,000 for Pine, Scholarship Fund $800');
    await A.evaluate(() => window.CampistryMe.addChargeForFamily('pine')); await wait(600);
    await A.fill('#chgAmount', '1000'); await A.fill('#chgDesc', 'Tuition 2027');
    await A.evaluate(() => { const d = document.querySelector('#dynModal details'); if (d) d.open = true; });
    await A.evaluate(() => window.CampistryMe._addPayerRow()); await wait(300);
    await A.selectOption('.me-payer-row .me-pay-who', 'org_scholarship_fund');
    await A.fill('.me-payer-row .me-pay-amt', '800');
    await A.click('#dynModalSave'); await wait(3000);
    const toast1 = await A.evaluate(() => Array.from(document.querySelectorAll('.me-toast,.toast,[class*=toast]')).map(t => t.textContent.trim()).filter(Boolean).slice(-1)[0] || '');
    const due = q1(`SELECT public.plan_due_for('${CAMP}'::uuid, 'pine', 'plan_pine', '${TODAY}')::text`);
    log(`  toast "${toast1}"; Pine owes $${owes('pine')}; plan_due_for → ${due}`);
    log(`  fund's ledger in the cloud: ${fundInCloud()}`);
    check('Pine owes only its $200 share', owes('pine') === 200, `$${owes('pine')}`);
    check('autopay would charge Pine $200', /"amount": 200/.test(due), due);
    check('the fund\'s $800 share is on its account in the cloud', /"amount": 800/.test(fundInCloud()), fundInCloud());
    await A.evaluate(() => window.CampistryMe.viewFamily('pine')); await wait(1000);
    const famTxt = await A.evaluate(() => ((document.getElementById('page-familydetail') || {}).textContent || '').replace(/\s+/g, ' '));
    const also = (famTxt.match(/Also paying part of this bill:[^—]*/) || [''])[0];
    log(`  Pine's page: "${also.trim()}"`);
    check('Pine\'s page names the fund\'s share', /Scholarship Fund \$800/.test(also), also);

    log('S2  computer A: Manage payers → Record payment $300 from the fund');
    await A.evaluate(() => window.CampistryMe.managePayers()); await wait(600);
    const rowHtml = await A.evaluate(() => {
      const m = document.getElementById('dynModal'); const t = (m || {}).textContent || '';
      const btn = Array.from((m || document).querySelectorAll('button')).find(b => /Record payment/.test(b.textContent));
      // is the button inside the same bordered row as the payer's name?
      let row = btn; while (row && !(row.style && /border-radius: 8px/.test(row.getAttribute('style') || ''))) row = row.parentElement;
      return { owesLine: (t.match(/Owes \$[\d,.]+ \(shares[^)]*\)/) || [''])[0], btnInRow: !!(row && /Scholarship Fund/.test(row.textContent)) };
    });
    await A.screenshot({ path: path.join(O, 'payer_split18_manage_payers.png') });
    log(`  Manage payers says "${rowHtml.owesLine}"; Record payment button inside the fund's row: ${rowHtml.btnInRow}`);
    check('Manage payers shows the fund owes $800', /Owes \$800/.test(rowHtml.owesLine), rowHtml.owesLine);
    check('S6 the Record payment / Archive buttons sit in the fund\'s row', rowHtml.btnInRow, 'buttons outside the row box (extra </div>, campistry_me.js:1868)');
    await A.evaluate(() => window.CampistryMe.recordPayerPayment('org_scholarship_fund')); await wait(500);
    await A.fill('#ppAmt', '300'); await A.fill('#ppRef', 'chk 551');
    await A.click('#dynModalSave'); await wait(3000);
    log(`  fund's ledger in the cloud: ${fundInCloud()}`);
    check('the fund\'s $300 cheque is in the cloud', /"kind": "payment"/.test(fundInCloud()));

    log('S3  Finance → Revenue on computer A');
    await A.evaluate(() => window.CampistryMe.nav('finance')); await wait(800);
    await A.evaluate(() => window.CampistryMe.finSetTab && window.CampistryMe.finSetTab('revenue')); await wait(800);
    const fin = await A.evaluate(() => {
      const t = ((document.getElementById('page-finance') || {}).textContent || '').replace(/\s+/g, ' ');
      const g = (lab) => (t.match(new RegExp(lab + '\\s*(\\$[\\d,.]+)')) || [, '?'])[1];
      return { invoiced: g('Total Invoiced'), collected: g('Collected'), outstanding: g('Outstanding'), fund: /Scholarship Fund/.test(t), chk: /chk 551|\$300\.00/.test(t) };
    });
    log(`  Finance: Total Invoiced ${fin.invoiced}, Collected ${fin.collected}, Outstanding ${fin.outstanding}; fund named anywhere: ${fin.fund}; the $300 cheque listed: ${fin.chk}`);
    check('Finance counts the fund\'s $300 cheque as collected', fin.chk, 'not in the Payment Log / Collected');

    log('S4  computer B (opened before S1, never refreshed): Add Charge $50 to Oak');
    const bSees = await B.evaluate(() => JSON.stringify(((window.loadGlobalSettings && window.loadGlobalSettings().campistryMe) || {}).payers || null));
    log(`  computer B's copy of the fund: ${bSees}`);
    await B.evaluate(() => window.CampistryMe.addChargeForFamily('oak')); await wait(600);
    await B.fill('#chgAmount', '50'); await B.fill('#chgDesc', 'Canoe trip');
    await B.click('#dynModalSave'); await wait(3500);
    log(`  Oak owes $${owes('oak')}; Pine owes $${owes('pine')}`);
    log(`  fund's ledger in the cloud now: ${fundInCloud()}`);
    check('the fund still owes its $800 share after computer B saved', /"amount": 800/.test(fundInCloud()), fundInCloud());
    check('the fund\'s $300 cheque survives computer B\'s save', /"kind": "payment"/.test(fundInCloud()), fundInCloud());
    const C = await computer('C');
    await C.evaluate(() => window.CampistryMe.managePayers()); await wait(600);
    const cOwes = await C.evaluate(() => (((document.getElementById('dynModal') || {}).textContent || '').match(/Owes \$[\d,.]+ \(shares[^)]*\)/) || ['(no Owes line)'])[0]);
    log(`  a freshly opened computer C: Manage payers says "${cOwes}"`);

    log('S5  computer C: Add Charge $400 for Pine, fund $400 (100%)');
    const before5 = owes('pine');
    await C.evaluate(() => window.CampistryMe.closeModal ? window.CampistryMe.closeModal('dynModal') : 0);
    await C.evaluate(() => window.CampistryMe.addChargeForFamily('pine')); await wait(600);
    await C.fill('#chgAmount', '400'); await C.fill('#chgDesc', 'Bus');
    await C.evaluate(() => { const d = document.querySelector('#dynModal details'); if (d) d.open = true; });
    await C.evaluate(() => window.CampistryMe._addPayerRow()); await wait(300);
    await C.selectOption('.me-payer-row .me-pay-who', 'org_scholarship_fund');
    await C.fill('.me-payer-row .me-pay-amt', '400');
    await C.click('#dynModalSave'); await wait(3000);
    const toast5 = await C.evaluate(() => Array.from(document.querySelectorAll('.me-toast,.toast,[class*=toast]')).map(t => t.textContent.trim()).filter(Boolean).slice(-1)[0] || '');
    log(`  toast "${toast5}"; Pine owes $${before5} → $${owes('pine')}; fund ledger ${fundInCloud()}`);
    check('Pine\'s bill unchanged by a charge the fund pays in full', owes('pine') === before5, `$${owes('pine')}`);
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
