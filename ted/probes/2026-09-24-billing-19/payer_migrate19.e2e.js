// Probe (19th pass): the one-time move of old payer ledgers onto families, then an old page writing the old layout back.
// Probe (19th pass, re-check TED-177/178/179). The REAL Me page (e8f1d26) in
// Chromium on the real migration chain incl. 286; office computers are browser
// contexts with their own local storage; realtime not delivered (asleep laptop).
//
//  S1  A: Add Charge $1,000 for Pine, Scholarship Fund $800 → where is the share?
//  S2  A: Manage payers → Record payment $300 (method preselected?), layout
//  S3  A: Finance → Revenue: Collected / Outstanding / Payment Log with the fund
//  S4  B (opened BEFORE S1, never refreshed) saves a $50 charge on OAK, then a
//      $50 charge on PINE itself (the family row that now holds the fund lines)
//  S5  fresh C: Manage payers
//  S6  C: Account → Remove the $300 payment → fund owes $800 again; Finance
//  S7  C: Account → Move the $800 share back → Pine owes it; plan_due_for
//  S8  B (still stale) saves Pine again → do the void lines and moved-back charge survive?
//  S9  D and E (both fresh) each record a $100 fund cheque without reloading
// Run: node ted/probes/2026-09-24-billing-19/payer_split19.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const O = path.join(R, 'ted/probes/2026-09-24-billing-19');
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8472;
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
  const db = boot({ port: 5772 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Split Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const started = (k) => [{ id: 'le_reg_' + k, kind: 'charge', amount: 100, reason: 'registration', date: '2026-05-01' }, { id: 'le_pay_reg_' + k, kind: 'payment', amount: 100, reason: 'check', date: '2026-05-01' }];
  const OLD = [
    { id: 'prc_a_org_scholarship_fund', kind: 'charge', amount: 800, familyKey: 'pine', family: 'Pine', chargeId: 'a', description: 'Tuition — share for Pine', date: '2026-06-01' },
    { id: 'prc_b_org_scholarship_fund', kind: 'charge', amount: 500, familyKey: 'oak', family: 'Oak', chargeId: 'b', description: 'Tuition — share for Oak', date: '2026-06-01' },
    { id: 'prp_old1', kind: 'payment', amount: 1000, method: 'check', reference: '1001', date: '2026-06-10' }];
  kv('campistryMe', { families: {
      pine: { name: 'Pine', camperIds: ['Pine Kid'], cardOnFile: true, entries: started('pine'),
        plans: [{ id: 'plan_pine', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }] },
      oak: { name: 'Oak', camperIds: ['Oak Kid'], entries: started('oak') } },
    payers: { org_scholarship_fund: { id: 'org_scholarship_fund', name: 'Scholarship Fund', kind: 'organization', ledger: OLD } } });
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
  // the fund's account the page's own way, computed from the cloud rows
  const fund = () => { const L = JSON.parse(pl('pine') === '(none)' ? '[]' : pl('pine')).concat(JSON.parse(pl('oak') === '(none)' ? '[]' : pl('oak')));
    const v = new Set(L.filter(e => e.kind === 'void').map(e => e.voidOf)); let ch = 0, pd = 0;
    L.forEach(e => { if (v.has(e.id)) return; if (e.kind === 'charge') ch += e.amount; if (e.kind === 'payment') pd += e.amount; });
    return { charged: ch, paid: pd, owes: ch - pd, lines: L.length }; };
  const toastLast = (P) => P.evaluate(() => Array.from(document.querySelectorAll('.me-toast,.toast,[class*=toast]')).map(t => t.textContent.trim()).filter(Boolean).slice(-1)[0] || '');
  const finance = async (P) => {
    await P.evaluate(() => window.CampistryMe.nav('finance')); await wait(800);
    await P.evaluate(() => window.CampistryMe.finSetTab && window.CampistryMe.finSetTab('revenue')); await wait(800);
    return P.evaluate(() => {
      const t = ((document.getElementById('page-finance') || {}).textContent || '').replace(/\s+/g, ' ');
      const g = (lab) => (t.match(new RegExp(lab + '\\s*(\\$[\\d,.]+)')) || [, '?'])[1];
      const rows = Array.from(document.querySelectorAll('#page-finance tr')).map(r => r.textContent.replace(/\s+/g, ' ').trim()).filter(x => /\(fund\)/.test(x));
      return { collected: g('Collected'), outstanding: g('Outstanding'), fundRows: rows };
    });
  };
  const addCharge = async (P, fk, amt, desc, fundAmt) => {
    await P.evaluate((k) => window.CampistryMe.addChargeForFamily(k), fk); await wait(600);
    await P.fill('#chgAmount', String(amt)); await P.fill('#chgDesc', desc);
    if (fundAmt) {
      await P.evaluate(() => { const d = document.querySelector('#dynModal details'); if (d) d.open = true; });
      await P.evaluate(() => window.CampistryMe._addPayerRow()); await wait(300);
      await P.selectOption('.me-payer-row .me-pay-who', 'org_scholarship_fund');
      await P.fill('.me-payer-row .me-pay-amt', String(fundAmt));
    }
    await P.click('#dynModalSave'); await wait(3000);
  };
  const recordFund = async (P, amt, ref) => {
    await P.evaluate(() => window.CampistryMe.recordPayerPayment('org_scholarship_fund')); await wait(500);
    const method = await P.evaluate(() => (document.getElementById('ppMethod') || {}).value);
    await P.fill('#ppAmt', String(amt)); await P.fill('#ppRef', ref);
    await P.click('#dynModalSave'); await wait(3000);
    return method;
  };
  const accountClick = async (P, re) => {
    await P.evaluate(() => window.CampistryMe.payerLines('org_scholarship_fund')); await wait(600);
    const rows = await P.evaluate(() => Array.from(document.querySelectorAll('#dynModal tr')).map(r => r.textContent.replace(/\s+/g, ' ').trim()));
    const btn = P.locator('#dynModal button', { hasText: re }).first();
    await btn.click(); await wait(500);
    const msg = await P.evaluate(() => ((document.getElementById('confirmDlgOverlay') || {}).textContent || '').replace(/\s+/g, ' ').trim());
    await P.click('#confirmDlgOk'); await wait(3000);
    return { rows, msg };
  };
  try {
    log('M1  an office computer on the new code opens a camp whose fund lines are in the old place, and saves something');
    const F = await computer('F');
    await addCharge(F, 'oak', 20, 'Trip');
    log(`  fund from the family rows ${JSON.stringify(fund())}; cloud payers.ledger: ${q1(`SELECT COALESCE((value->'payers'->'org_scholarship_fund'->'ledger')::text,'none') FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistryMe'`)}`);
    check('M1 moved once: shares $1,300, paid $1,000', fund().charged === 1300 && fund().paid === 1000, JSON.stringify(fund()));
    log('M2  a computer still on the OLD page (not reloaded after the update) saves the settings document with its old payers.ledger');
    db.sql(`UPDATE camp_state_kv SET value = jsonb_set(value, '{payers,org_scholarship_fund,ledger}', ${lit(JSON.stringify(OLD))}::jsonb) WHERE camp_id='${CAMP}' AND key='campistryMe'`);
    const H = await computer('H');
    await addCharge(H, 'oak', 5, 'Stamp');
    log(`  fund ${JSON.stringify(fund())}`);
    log(`  Pine payerLedger ${pl('pine')}`);
    log(`  Oak payerLedger ${pl('oak')}`);
    await H.evaluate(() => window.CampistryMe.managePayers()); await wait(600);
    const hOwes = await H.evaluate(() => (((document.getElementById('dynModal') || {}).textContent || '').match(/Owes -?\$[\d,.-]+ \(shares[^)]*\)/) || ['(no Owes line)'])[0]);
    log(`  Manage payers on H: "${hOwes}"`);
    check('M2 the $1,000 cheque still counted once', fund().paid === 1000, JSON.stringify(fund()));
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
