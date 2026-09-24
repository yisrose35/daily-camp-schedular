// Probe (18th pass, hunt — never checked: two office computers at once). The
// REAL Me page in Chromium on the real chain, two office computers (two
// browser contexts, own local storage; realtime not delivered).
// Pine owes $1,000 tuition.
//   K1 computer A records a $300 cheque; computer B (opened before, never
//      refreshed) records a $200 cheque → both on the bill? Pine owes $500?
//   K2 at the same instant: A adds a $50 trip charge, B records a $100 cash
//      payment → both on the bill? Pine owes $450?
// Run: node ted/probes/2026-09-24-billing-18/two_computers18.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const O = path.join(R, 'ted/probes/2026-09-24-billing-18');
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8455;
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
  const db = boot({ port: 5755 });
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
  const ledger = (fk) => q1(`SELECT string_agg(e->>'kind' || ' ' || (e->>'amount'), '; ') FROM jsonb_array_elements(public.camp_family('${CAMP}','${fk}')->'entries') e`);
  const payRows = () => q1(`SELECT count(*) || ' rows, $' || COALESCE(sum(amount),0) FROM camp_payments WHERE camp_id='${CAMP}' AND deleted_at IS NULL AND family_key='pine'`);
  async function pay(P, amt, method) {
    await P.evaluate(() => window.CampistryMe.openPaymentForFamily('pine')); await wait(700);
    await P.fill('#payAmount', String(amt)); await P.selectOption('#payMethod', method); await wait(200);
  }
  try {
    db.sql(`UPDATE camp_state_kv SET value = jsonb_set(value, '{families,pine,entries}', value->'families'->'pine'->'entries' || '[{"id":"le_t","kind":"charge","amount":1000,"reason":"tuition","date":"2026-06-01"}]'::jsonb) WHERE camp_id='${CAMP}' AND key='campistryMe'`);
    const A = await computer('A');
    const B = await computer('B');
    log(`start: Pine owes $${owes('pine')}; ledger ${ledger('pine')}`);
    log('\nK1. A records a $300 cheque; then B (stale) records a $200 cheque');
    await pay(A, 300, 'check'); await A.click('#dynModalSave'); await wait(3000);
    log(`    after A: owes $${owes('pine')}; payments ${payRows()}`);
    await pay(B, 200, 'check'); await B.click('#dynModalSave'); await wait(3500);
    log(`    after B: owes $${owes('pine')}; ledger ${ledger('pine')}; payments ${payRows()}`);
    check('K1 both cheques on Pine\'s bill (owes $500)', owes('pine') === 500, `$${owes('pine')}`);
    log('\nK2. at the same instant: A adds a $50 trip charge, B records a $100 cash payment');
    await A.evaluate(() => window.CampistryMe.addChargeForFamily('pine')); await wait(600);
    await A.fill('#chgAmount', '50'); await A.fill('#chgDesc', 'Trip');
    await pay(B, 100, 'cash');
    await Promise.all([A.click('#dynModalSave'), B.click('#dynModalSave')]); await wait(4000);
    log(`    owes $${owes('pine')}; ledger ${ledger('pine')}; payments ${payRows()}`);
    check('K2 the charge and the payment both on the bill (owes $450)', owes('pine') === 450, `$${owes('pine')}`);
    const C = await computer('C');
    await C.evaluate(() => window.CampistryMe.viewFamily('pine')); await wait(1200);
    const bill = await C.evaluate(() => { const t = ((document.getElementById('page-familydetail') || {}).textContent || '').replace(/\s+/g, ' '); const m = t.match(/Balance\s*(\$[\d,.]+)/); return m ? m[1] : '?'; });
    log(`    a fresh computer C shows Pine's Balance ${bill}`);
    check('K2 a fresh computer shows $450', bill === '$450', bill);
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
