// Probe (20th pass, batch20): Teal's $1,000 payment is charged back (288 pauses autopay; Teal owes $1,000 again, card on file).
// Billing → Batch Charge: is Teal in the list to be charged? (Nothing is actually charged: the window is read, then cancelled.)
// Original header of billing20 follows. The REAL Me page (a941220) in Chromium on the real
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
const O = path.join(R, 'ted/probes/2026-09-24-billing-21/rerun20');
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8522;
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
  const db = boot({ port: 5828 });
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
    db.sql(`SELECT 1`);
    const cards = await A.evaluate(() => /Batch Charge/.test(document.body.textContent));
    await A.evaluate(() => window.CampistryMe.batchCharge()); await wait(800);
    const txt = await A.evaluate(() => ((document.getElementById('dynModal') || {}).textContent || '').replace(/\s+/g, ' ').trim());
    log(`  Batch Charge button: ${cards}; window: "${txt.slice(0, 400)}"`);
    log(`  Teal plan mark in the cloud: ${mark('teal')}`);
    check('Teal (payment disputed, autopay paused) is left out of Batch Charge or named as disputed', !/Teal/.test(txt) || /disput/i.test(txt), txt.slice(0, 200));
    await A.screenshot({ path: path.join(O, 'batch20_window.png') });
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
