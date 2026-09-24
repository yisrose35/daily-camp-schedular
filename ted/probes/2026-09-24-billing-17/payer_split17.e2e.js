// Probe (17th pass, hunt — "split between payers", never audited). The REAL Me
// page (Billing → Add Charge → "Split between payers") in Chromium on the real
// chain. The Pine family's tuition is $1,000; the camp's Scholarship Fund
// (an organization payer) has approved $800 of it, so the household owes $200.
// Pine is on a one-instalment autopay plan due today, and has a started ledger
// (a $100 registration fee, paid).
//   What does the family's bill (the ledger: Billing, Link, autopay) say Pine
//   owes, and what would tonight's autopay charge Pine's card?
// Run: node ted/probes/2026-09-24-billing-17/payer_split17.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8433;
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
  const db = boot({ port: 5733 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Split Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistryMe', { families: { pine: { name: 'Pine', camperIds: ['Pine Kid'], cardOnFile: true, entries: [{ id: 'le_reg', kind: 'charge', amount: 100, reason: 'registration', date: '2026-05-01' }, { id: 'le_pay_reg', kind: 'payment', amount: 100, reason: 'check', date: '2026-05-01' }],
      plans: [{ id: 'plan_pine', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }] } },
    payers: { org_scholarship_fund: { id: 'org_scholarship_fund', name: 'Scholarship Fund', kind: 'organization' } } });
  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  try {
    await page.goto(`http://localhost:${PORT}/campistry_me.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await wait(2500);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(1500);
    await page.evaluate(() => window.CampistryMe.addChargeForFamily('pine')); await wait(700);
    await page.fill('#chgAmount', '1000');
    await page.fill('#chgDesc', 'Tuition 2027');
    await page.evaluate(() => { const d = document.querySelector('#dynModal details'); if (d) d.open = true; });
    await page.evaluate(() => window.CampistryMe._addPayerRow()); await wait(300);
    await page.selectOption('.me-payer-row .me-pay-who', 'org_scholarship_fund');
    await page.fill('.me-payer-row .me-pay-amt', '800');
    await page.evaluate(() => window.CampistryMe._payerSplitPreview()); await wait(300);
    const pv = await page.evaluate(() => (document.getElementById('chgSplitPreview') || {}).textContent || '');
    log(`Add Charge $1,000 for Pine, split: Scholarship Fund $800. The window says: "${pv.trim()}"`);
    await page.click('#dynModalSave'); await wait(2500);
    const owes = Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','pine'))`));
    const ledger = q1(`SELECT string_agg(e->>'kind' || ' ' || (e->>'amount'), '; ') FROM jsonb_array_elements(public.camp_family('${CAMP}','pine')->'entries') e`);
    const due = q1(`SELECT public.plan_due_for('${CAMP}'::uuid, 'pine', 'plan_pine', '${TODAY}')::text`);
    await page.evaluate(() => window.CampistryMe.viewFamily('pine')); await wait(1200);
    const bill = await page.evaluate(() => { const t = (document.getElementById('page-familydetail') || {}).textContent || ''; const m = t.replace(/\s+/g, ' ').match(/Balance\s*(\$[\d,.]+)/); return m ? m[1] : t.slice(0, 120); });
    const fundShown = await page.evaluate(() => /Scholarship Fund/.test((document.getElementById('page-familydetail') || {}).textContent || ''));
    log(`Pine's ledger: ${ledger}; owes $${owes}; Billing's family page Balance ${bill}; the fund's share shown on that page: ${fundShown}`);
    log(`tonight's autopay asks plan_due_for → ${due}`);
    const dueAmt = (() => { try { return Number(JSON.parse(due).amount); } catch (_) { return NaN; } })();
    check('the household owes its $200 share, not the fund\'s $800', owes === 200, `Pine's bill says $${owes}`);
    check('autopay charges Pine\'s card only the household share', dueAmt === 200, `plan_due_for would charge $${dueAmt}`);
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
