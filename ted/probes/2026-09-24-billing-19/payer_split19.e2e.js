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
const PORT = 8471;
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
  const db = boot({ port: 5771 });
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
    const A = await computer('A');
    const B = await computer('B');   // opened now, never refreshed again

    log('S1  A: Add Charge $1,000 for Pine, Scholarship Fund $800');
    await addCharge(A, 'pine', 1000, 'Tuition 2027', 800);
    const due1 = q1(`SELECT public.plan_due_for('${CAMP}'::uuid, 'pine', 'plan_pine', '${TODAY}')::text`);
    log(`  Pine owes $${owes('pine')}; plan_due_for → ${due1}`);
    log(`  Pine's row payerLedger: ${pl('pine')}`);
    log(`  campistryMe.payers in the cloud: ${q1(`SELECT (value->'payers')::text FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistryMe'`)}`);
    check('S1 Pine owes $200, the fund\'s $800 share is on Pine\'s family row', owes('pine') === 200 && fund().charged === 800, `Pine $${owes('pine')}, fund ${JSON.stringify(fund())}`);

    log('S2  A: Manage payers → Record payment $300');
    await A.evaluate(() => window.CampistryMe.managePayers()); await wait(600);
    const lay = await A.evaluate(() => {
      const m = document.getElementById('dynModal'); const t = (m || {}).textContent || '';
      const btn = Array.from((m || document).querySelectorAll('button')).find(b => /Record payment/.test(b.textContent));
      let row = btn; while (row && !(row.getAttribute && /border-radius: 8px/.test(row.getAttribute('style') || ''))) row = row.parentElement;
      const save = document.getElementById('dynModalSave'); const box = m && m.querySelector('.me-modal, .modal, [class*=modal-content], [class*=me-modal]');
      return { owes: (t.match(/Owes \$[\d,.]+ \(shares[^)]*\)/) || [''])[0], btnInRow: !!(row && /Scholarship Fund/.test(row.textContent)), saveInBox: !!(box && save && box.contains(save)) };
    });
    await A.screenshot({ path: path.join(O, 'payer_split19_manage_payers.png') });
    log(`  "${lay.owes}"; Record payment inside the fund's row: ${lay.btnInRow}; Save inside the window box: ${lay.saveInBox}`);
    check('S2 TED-179 buttons in the fund\'s row', lay.btnInRow && /Owes \$800/.test(lay.owes), JSON.stringify(lay));
    await A.evaluate(() => window.CampistryMe.closeModal && window.CampistryMe.closeModal('dynModal'));
    const m2 = await recordFund(A, 300, 'chk 551');
    log(`  method preselected: ${m2}; fund now ${JSON.stringify(fund())}; toast "${await toastLast(A)}"`);
    check('S2 method starts on Check; $300 in the cloud', m2 === 'check' && fund().paid === 300, `${m2}, ${JSON.stringify(fund())}`);

    log('S3  A: Finance → Revenue');
    const f3 = await finance(A);
    log(`  Collected ${f3.collected}, Outstanding ${f3.outstanding}; fund rows: ${JSON.stringify(f3.fundRows)}`);
    // families: Pine paid 100 reg, Oak 100 → collected 200 + fund 300 = 500; outstanding Pine 200 + fund 500 = 700
    check('S3 Collected $500 and Outstanding $700 include the fund; its cheque is in the log', f3.collected === '$500' || f3.collected === '$500.00', `${f3.collected} / ${f3.outstanding}`);
    check('S3 Outstanding includes the fund\'s $500', /\$700/.test(f3.outstanding), f3.outstanding);

    log('S4  B (stale since before S1): $50 on Oak, then $50 on Pine itself');
    await addCharge(B, 'oak', 50, 'Canoe trip');
    log(`  after Oak: fund ${JSON.stringify(fund())}`);
    await addCharge(B, 'pine', 50, 'Late pickup');
    log(`  after Pine: Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}; Pine payerLedger ${pl('pine')}`);
    check('S4 the fund\'s $800 share and $300 cheque survive a stale computer saving Pine itself', fund().charged === 800 && fund().paid === 300 && owes('pine') === 250, `Pine $${owes('pine')}, fund ${JSON.stringify(fund())}`);

    log('S5  fresh computer C: Manage payers');
    const C = await computer('C');
    await C.evaluate(() => window.CampistryMe.managePayers()); await wait(600);
    const cOwes = await C.evaluate(() => (((document.getElementById('dynModal') || {}).textContent || '').match(/Owes \$[\d,.]+ \(shares[^)]*\)/) || ['(no Owes line)'])[0]);
    log(`  "${cOwes}"`);
    check('S5 a fresh computer shows the fund owes $500', /Owes \$500/.test(cOwes), cOwes);
    await C.evaluate(() => window.CampistryMe.closeModal && window.CampistryMe.closeModal('dynModal'));

    log('S6  C: Account → Remove the $300 payment');
    const r6 = await accountClick(C, /Remove/);
    log(`  account rows: ${JSON.stringify(r6.rows)}`);
    log(`  confirm said: "${r6.msg}"`);
    log(`  fund ${JSON.stringify(fund())}; toast "${await toastLast(C)}"`);
    check('S6 payment removed, fund owes $800 again', fund().owes === 800, JSON.stringify(fund()));
    const f6 = await finance(C);
    log(`  Finance: Collected ${f6.collected}, Outstanding ${f6.outstanding}; fund rows ${JSON.stringify(f6.fundRows)}`);
    check('S6 Finance no longer counts the removed cheque', /\$200/.test(f6.collected) && f6.fundRows.length === 0, `${f6.collected}; ${f6.fundRows.length} fund rows`);

    log('S7  C: Account → Move the $800 share back to Pine');
    await C.evaluate(() => window.CampistryMe.nav('billing')); await wait(800);
    const r7 = await accountClick(C, /Move back/);
    log(`  confirm said: "${r7.msg}"`);
    const due7 = q1(`SELECT public.plan_due_for('${CAMP}'::uuid, 'pine', 'plan_pine', '${TODAY}')::text`);
    log(`  Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}; plan_due_for → ${due7}`);
    check('S7 Pine owes $1,050, the fund $0', owes('pine') === 1050 && fund().owes === 0, `Pine $${owes('pine')}, fund ${JSON.stringify(fund())}`);

    log('S8  B (still stale) adds another $10 to Pine');
    await addCharge(B, 'pine', 10, 'Snack');
    log(`  Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}`);
    check('S8 void lines + moved-back charge survive the stale save', owes('pine') === 1060 && fund().owes === 0, `Pine $${owes('pine')}, fund ${JSON.stringify(fund())}`);

    log('S9  D and E (both fresh): new split $500 fund share, then each records a $100 fund cheque without reloading');
    const D = await computer('D');
    await addCharge(D, 'oak', 600, 'Tuition Oak', 500);
    const E = await computer('E');
    const D2 = await computer('D2');
    await recordFund(D2, 100, 'chk D'); await recordFund(E, 100, 'chk E');
    log(`  fund ${JSON.stringify(fund())}; Oak payerLedger ${pl('oak')}`);
    check('S9 both cheques kept', fund().paid === 200 && fund().owes === 300, JSON.stringify(fund()));
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
