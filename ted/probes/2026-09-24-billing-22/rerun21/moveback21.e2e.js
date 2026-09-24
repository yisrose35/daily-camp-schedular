// Probe (21st pass, moveback21): billing20 with S3 = "Move back to family" instead of Cancel share.
// TED-198 asked for both; what do the confirm, toast and Manage payers say after a fund paid $300?
// Probe (20th pass). The REAL Me page (a941220) in Chromium on the real
// migration chain incl. 286/288. Re-checks TED-189 and the Billing side of
// TED-186.
//  B1  Billing list: a family whose autopay plan is paused for a chargeback
//      shows "Autopay paused — a payment is disputed with the bank"; the family
//      page too
//  B2  clicking it: the confirm words; Resume → the pause is gone in the cloud
//  B3  a stale office computer (opened before B2) saves the family → the resume sticks?
//  S1  Add Charge $1,000 for Pine, Scholarship Fund $800; fund pays $300
//  S2  Issue Credit window for Pine names the fund's share and links to it
//  S3  the fund's account → Cancel share: words; fund charged 0 / paid 300;
//      Pine still owes $200; plan_due_for 200; Finance Outstanding
//  S4  what the office is shown for the fund's $300 cheque after the cancel
// Run: node ted/probes/2026-09-24-billing-20/billing20.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const O = path.join(R, 'ted/probes/2026-09-24-billing-22/rerun21/moveback21');
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8520;
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
  const db = boot({ port: 5825 });
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
      teal: { name: 'Teal', camperIds: ['Teal Kid'], cardOnFile: true, stripeCustomerId: 'cus_t', entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }],
        plans: [{ id: 'plan_teal', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }] } },
    payers: { org_scholarship_fund: { id: 'org_scholarship_fund', name: 'Scholarship Fund', kind: 'organization' } } });
  // the webhook's pause, as 288 writes it
  db.sql(`SELECT public.hold_autopay_for_dispute('${CAMP}', 'teal', 'dp_t', true, 'fraudulent')`);
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
  const pl = (fk) => q1(`SELECT COALESCE((public.camp_family('${CAMP}','${fk}')->'payerLedger')::text,'(none)')`);
  const owes = (fk) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${fk}'))`));
  const mark = (fk) => q1(`SELECT COALESCE((public.camp_family('${CAMP}','${fk}')->'plans'->0->'collectionBlocked')::text,'none')`);
  const fund = () => { const L = JSON.parse(pl('pine') === '(none)' ? '[]' : pl('pine'));
    const v = new Set(L.filter(e => e.kind === 'void').map(e => e.voidOf)); let ch = 0, pd = 0;
    L.forEach(e => { if (v.has(e.id)) return; if (e.kind === 'charge') ch += e.amount; if (e.kind === 'payment') pd += e.amount; });
    return { charged: ch, paid: pd, owes: ch - pd, lines: L.length }; };
  const toastLast = (P) => P.evaluate(() => Array.from(document.querySelectorAll('.me-toast,.toast,[class*=toast]')).map(t => t.textContent.trim()).filter(Boolean).slice(-1)[0] || '');
  try {
    const A = await computer('A');
    const Stale = await computer('Stale');

    log('B1  Billing: Teal\'s autopay is paused for a dispute');
    const pageText = (P) => P.evaluate(() => ((document.getElementById('page-billing') || document.body).textContent || '').replace(/\s+/g, ' '));
    const t1 = await pageText(A);
    const has = /Autopay paused — a payment is disputed with the bank/.test(t1);
    await A.evaluate(() => window.CampistryMe.openFamily ? window.CampistryMe.openFamily('teal') : null).catch(() => {});
    await wait(800);
    const onFam = await A.evaluate(() => /Autopay paused — a payment is disputed/.test(document.body.textContent || ''));
    log(`  Billing list shows the pause: ${has}; after opening Teal: ${onFam}`);
    await A.screenshot({ path: path.join(O, 'billing20_paused.png') });
    check('B1 Billing names the dispute pause', has, has ? 'shown' : t1.slice(0, 300));

    log('B2  click it → confirm → Resume');
    await A.evaluate(() => window.CampistryMe.nav('billing')); await wait(800);
    const link = A.locator('span', { hasText: 'Autopay paused — a payment is disputed with the bank' }).first();
    await link.click(); await wait(500);
    const msg = await A.evaluate(() => ((document.getElementById('confirmDlgOverlay') || {}).textContent || '').replace(/\s+/g, ' ').trim());
    log(`  confirm said: "${msg}"`);
    await A.click('#confirmDlgOk'); await wait(2500);
    log(`  toast "${await toastLast(A)}"; cloud mark now ${mark('teal')}; list still shows it: ${/Autopay paused — a payment/.test(await pageText(A))}`);
    check('B2 resumed: the pause is gone in the cloud and on the page', mark('teal') === 'none' && !/Autopay paused — a payment/.test(await pageText(A)), mark('teal'));

    log('B3  the stale computer (opened before the resume) adds a $10 charge to Teal');
    await Stale.evaluate(() => window.CampistryMe.addChargeForFamily('teal')); await wait(600);
    await Stale.fill('#chgAmount', '10'); await Stale.fill('#chgDesc', 'Snack');
    await Stale.click('#dynModalSave'); await wait(3000);
    log(`  Teal owes $${owes('teal')}; mark ${mark('teal')}`);
    check('B3 a stale computer does not bring the pause back', mark('teal') === 'none', mark('teal'));

    log('S1  Pine: Add Charge $1,000, Scholarship Fund $800; the fund pays $300');
    await A.evaluate(() => window.CampistryMe.addChargeForFamily('pine')); await wait(600);
    await A.fill('#chgAmount', '1000'); await A.fill('#chgDesc', 'Tuition 2027');
    await A.evaluate(() => { const d = document.querySelector('#dynModal details'); if (d) d.open = true; });
    await A.evaluate(() => window.CampistryMe._addPayerRow()); await wait(300);
    await A.selectOption('.me-payer-row .me-pay-who', 'org_scholarship_fund');
    await A.fill('.me-payer-row .me-pay-amt', '800');
    await A.click('#dynModalSave'); await wait(3000);
    await A.evaluate(() => window.CampistryMe.recordPayerPayment('org_scholarship_fund')); await wait(500);
    await A.fill('#ppAmt', '300'); await A.fill('#ppRef', 'chk 1');
    await A.click('#dynModalSave'); await wait(3000);
    log(`  Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}`);

    log('S2  Issue Credit for Pine');
    await A.evaluate(() => window.CampistryMe.issueCreditForFamily('pine')); await wait(700);
    const cr = await A.evaluate(() => ((document.getElementById('dynModal') || {}).textContent || '').replace(/\s+/g, ' '));
    const note = (cr.match(/Part of this bill is paid by[^.]*\.[^.]*\.[^→]*→ Cancel share/) || [''])[0];
    log(`  note: "${note}"`);
    check('S2 the credit window names the fund\'s share and points to Cancel share', /Scholarship Fund \(\$800/.test(note), note || cr.slice(0, 200));
    await A.evaluate(() => window.CampistryMe.closeModal && window.CampistryMe.closeModal('dynModal')); await wait(300);

    log('S3  the fund\'s account → Move back to family (after the fund paid $300)');
    await A.evaluate(() => window.CampistryMe.payerLines('org_scholarship_fund')); await wait(600);
    const rows = await A.evaluate(() => Array.from(document.querySelectorAll('#dynModal tr')).map(r => r.textContent.replace(/\s+/g, ' ').trim()));
    log(`  account rows: ${JSON.stringify(rows)}`);
    await A.locator('#dynModal button', { hasText: 'Move back to family' }).first().click(); await wait(500);
    const cmsg = await A.evaluate(() => ((document.getElementById('confirmDlgOverlay') || {}).textContent || '').replace(/\s+/g, ' ').trim());
    log(`  confirm said: "${cmsg}"`);
    await A.click('#confirmDlgOk'); await wait(3000);
    const toast3 = await toastLast(A);
    const due = q1(`SELECT public.plan_due_for('${CAMP}'::uuid, 'pine', 'plan_pine', '${TODAY}')::text`);
    log(`  toast "${toast3}"; Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}; plan_due_for ${due}`);
    check('S3 share cancelled: fund charged $0, Pine still $200, autopay asks $200', fund().charged === 0 && owes('pine') === 200 && /"amount": 200/.test(due), `fund ${JSON.stringify(fund())}, Pine $${owes('pine')}`);

    log('S4  what the office sees for the fund\'s $300 cheque now');
    await A.evaluate(() => window.CampistryMe.managePayers()); await wait(600);
    const mp = await A.evaluate(() => (((document.getElementById('dynModal') || {}).textContent || '').replace(/\s+/g, ' ').match(/Scholarship Fund.{0,160}/) || [''])[0]);
    log(`  Manage payers: "${mp}"`);
    await A.evaluate(() => window.CampistryMe.closeModal && window.CampistryMe.closeModal('dynModal'));
    await A.evaluate(() => window.CampistryMe.nav('finance')); await wait(800);
    await A.evaluate(() => window.CampistryMe.finSetTab && window.CampistryMe.finSetTab('revenue')); await wait(800);
    const fin = await A.evaluate(() => { const t = ((document.getElementById('page-finance') || {}).textContent || '').replace(/\s+/g, ' ');
      const g = (lab) => (t.match(new RegExp(lab + '\\s*(\\$[\\d,.-]+)')) || [, '?'])[1]; return { collected: g('Collected'), outstanding: g('Outstanding') }; });
    log(`  Finance: ${JSON.stringify(fin)}`);
    check('S4 the office is told the fund has $300 of cheque with no share to pay (a credit / money to return)', /credit|overpaid|refund|return|-\$300|\$-300|−\$300/i.test(mp), mp);
    await A.screenshot({ path: path.join(O, 'billing20_after_cancel.png') });
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
