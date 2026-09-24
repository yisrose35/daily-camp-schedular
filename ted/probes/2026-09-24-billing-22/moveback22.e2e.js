// Probe (22nd pass, moveback22). The REAL Me page (4889ba7) in Chromium on the
// real migration chain incl. the edited 288. Re-checks the Billing side of
// TED-200/202 and TED-203, and hunts around them.
//  B1  Teal (one open dispute): the row says "Payment disputed — card not charged"
//  B2  clicking it: "A dispute is still open" / "Resume anyway" → pause gone
//  B3  a stale office computer saves Teal → the resume sticks
//  B4  Rose: two disputes, one lost: the window counts "1 … still open (the camp lost 1)"
//  B5  Vale: the page loaded when its only dispute was lost (nothing open); a NEW
//      dispute arrives on the server; the office presses Resume on the stale page
//      → the server refuses, the page asks again; Cancel → still paused
//  S1  Pine: Add Charge $1,000, Scholarship Fund $800; the fund pays $300
//  S3  Move back to family: words; fund keeps a $300 share (paid); Pine owes
//      $200 + $500 = $700; autopay asks $700
//  S5  Move back again on the kept "$300 — the part … paid" line
//  S6  the fund also shares Birch ($800, first) and Oak ($400); pays $500 (the
//      cheque is placed on Birch, "oldest share first"); Move back Birch's share
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const O = path.join(R, 'ted/probes/2026-09-24-billing-22/moveback22');
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
  const db = boot({ port: 5826 });
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
        plans: [{ id: 'plan_teal', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }] },
      rose: { name: 'Rose', camperIds: ['Rose Kid'], cardOnFile: true, stripeCustomerId: 'cus_r', entries: [{ id: 'le_r', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }] },
      vale: { name: 'Vale', camperIds: ['Vale Kid'], cardOnFile: true, stripeCustomerId: 'cus_v', entries: [{ id: 'le_v', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }] },
      birch: { name: 'Birch', camperIds: ['Birch Kid'], entries: started('birch') },
      oak: { name: 'Oak', camperIds: ['Oak Kid'], entries: started('oak') } },
    payers: { org_scholarship_fund: { id: 'org_scholarship_fund', name: 'Scholarship Fund', kind: 'organization' } } });
  // the webhook's pause, as 288 writes it (Teal: open; Rose: two, one lost; Vale: one, lost)
  db.sql(`SELECT public.hold_autopay_for_dispute('${CAMP}', 'teal', 'dp_t', true, 'fraudulent');
          SELECT public.hold_autopay_for_dispute('${CAMP}', 'rose', 'dp_rA', true, 'fraudulent');
          SELECT public.hold_autopay_for_dispute('${CAMP}', 'rose', 'dp_rB', true, 'fraudulent');
          SELECT public.note_dispute_lost('${CAMP}', 'rose', 'dp_rA');
          SELECT public.hold_autopay_for_dispute('${CAMP}', 'vale', 'dp_v1', true, 'fraudulent');
          SELECT public.note_dispute_lost('${CAMP}', 'vale', 'dp_v1');`);
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
  const hold = (fk) => q1(`SELECT COALESCE((public.camp_family('${CAMP}','${fk}')->'disputeHold')::text,'none')`);
  const dlg = (P) => P.evaluate(() => ((document.getElementById('confirmDlgOverlay') || {}).textContent || '').replace(/\s+/g, ' ').trim());
  const LABEL = 'Payment disputed — card not charged';
  try {
    const A = await computer('A');
    const Stale = await computer('Stale');
    const pageText = (P) => P.evaluate(() => ((document.getElementById('page-billing') || document.body).textContent || '').replace(/\s+/g, ' '));

    log('B1  Billing: Teal has one open dispute');
    const t1 = await pageText(A);
    const n1 = (t1.match(/Payment disputed — card not charged/g) || []).length;
    log(`  label shown ${n1} times on Billing (Teal, Rose, Vale expected → 3)`);
    check('B1 the label is on each paused family, once each', n1 === 3, String(n1));
    await A.screenshot({ path: path.join(O, 'b1_billing.png') });

    log('B2  click Teal\'s label');
    const rowLink = (P, name) => P.locator('tr', { hasText: name + ' Kid' }).locator('span', { hasText: LABEL }).first();
    await rowLink(A, 'Teal').click(); await wait(500);
    const m2 = await dlg(A);
    log(`  window: "${m2}"`);
    check('B2 window says a dispute is still open and offers "Resume anyway"', /still open/.test(m2) && /Resume anyway/.test(m2), m2.slice(0, 200));
    await A.click('#confirmDlgOk'); await wait(2500);
    log(`  toast "${await toastLast(A)}"; cloud pause ${hold('teal')}; plan mark ${mark('teal')}`);
    check('B2 Resume anyway lifts the family pause and the plan mark', hold('teal') === 'none' && mark('teal') === 'none', hold('teal'));

    log('B3  the stale computer adds a $10 charge to Teal');
    await Stale.evaluate(() => window.CampistryMe.addChargeForFamily('teal')); await wait(600);
    await Stale.fill('#chgAmount', '10'); await Stale.fill('#chgDesc', 'Snack');
    await Stale.click('#dynModalSave'); await wait(3000);
    log(`  Teal owes $${owes('teal')}; pause ${hold('teal')}; mark ${mark('teal')}`);
    check('B3 a stale computer does not bring the pause back', hold('teal') === 'none' && mark('teal') === 'none', hold('teal'));

    log('B4  Rose: two disputes, the camp lost one');
    await A.evaluate(() => window.CampistryMe.nav('billing')); await wait(800);
    await rowLink(A, 'Rose').click(); await wait(500);
    const m4 = await dlg(A);
    log(`  window: "${m4}"`);
    check('B4 the window counts 1 still open and 1 lost', /1 dispute is still open/.test(m4) && /lost 1/.test(m4), m4.slice(0, 200));
    await A.click('#confirmDlgCancel'); await wait(500);
    check('B4 Cancel changes nothing', /dp_rB/.test(hold('rose')), hold('rose'));

    log('B5  Vale: page loaded with the only dispute lost; a new dispute arrives on the server; Resume pressed on the stale page');
    db.sql(`SELECT public.hold_autopay_for_dispute('${CAMP}', 'vale', 'dp_v2', true, 'fraudulent')`);
    await Stale.evaluate(() => window.CampistryMe.nav('billing')); await wait(800);
    await rowLink(Stale, 'Vale').click(); await wait(500);
    const m5a = await dlg(Stale);
    log(`  first window: "${m5a}"`);
    await Stale.click('#confirmDlgOk'); await wait(2000);
    const m5b = await dlg(Stale);
    log(`  second window: "${m5b}"`);
    check('B5 the server\'s refusal is shown as a second question', /still open/.test(m5b), m5b.slice(0, 200));
    await Stale.click('#confirmDlgCancel').catch(() => {}); await wait(800);
    log(`  Vale pause now ${hold('vale')}`);
    check('B5 Cancel on the second question keeps the pause', /dp_v2/.test(hold('vale')), hold('vale'));

    log('S1  Pine: Add Charge $1,000, Scholarship Fund $800; the fund pays $300');
    const split = async (fk, amt, fundAmt, desc) => {
      await A.evaluate((k) => window.CampistryMe.addChargeForFamily(k), fk); await wait(600);
      await A.fill('#chgAmount', String(amt)); await A.fill('#chgDesc', desc);
      await A.evaluate(() => { const d = document.querySelector('#dynModal details'); if (d) d.open = true; });
      await A.evaluate(() => window.CampistryMe._addPayerRow()); await wait(300);
      await A.selectOption('.me-payer-row .me-pay-who', 'org_scholarship_fund');
      await A.fill('.me-payer-row .me-pay-amt', String(fundAmt));
      await A.click('#dynModalSave'); await wait(3000);
    };
    const fundPays = async (amt, ref) => {
      await A.evaluate(() => window.CampistryMe.recordPayerPayment('org_scholarship_fund')); await wait(500);
      await A.fill('#ppAmt', String(amt)); await A.fill('#ppRef', ref);
      await A.click('#dynModalSave'); await wait(3000);
    };
    await split('pine', 1000, 800, 'Tuition 2027');
    await fundPays(300, 'chk 1');
    log(`  Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}`);

    const moveBack = async (rowText) => {
      await A.evaluate(() => window.CampistryMe.payerLines('org_scholarship_fund')); await wait(600);
      const rows = await A.evaluate(() => Array.from(document.querySelectorAll('#dynModal tr')).map(r => r.textContent.replace(/\s+/g, ' ').trim()));
      log(`  account rows: ${JSON.stringify(rows)}`);
      await A.locator('#dynModal tr', { hasText: rowText }).locator('button', { hasText: 'Move back to family' }).first().click(); await wait(500);
      const c = await dlg(A);
      log(`  confirm said: "${c}"`);
      await A.click('#confirmDlgOk'); await wait(3000);
      const t = await toastLast(A);
      log(`  toast "${t}"`);
      return { c, t };
    };
    log('S3  the fund\'s account → Move back to family (after the fund paid $300)');
    const s3 = await moveBack('Tuition 2027 — share for Pine');
    const due = q1(`SELECT public.plan_due_for('${CAMP}'::uuid, 'pine', 'plan_pine', '${TODAY}')::text`);
    log(`  Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}; plan_due_for ${due}`);
    check('S3 the window names the $300 paid and the $500 that moves', /already paid \$300/.test(s3.c) && /unpaid \$500/.test(s3.c), s3.c.slice(0, 220));
    check('S3 Pine owes $700, the fund charged $300 / paid $300, autopay asks $700', owes('pine') === 700 && fund().charged === 300 && fund().paid === 300 && /"amount": 700/.test(due), `Pine $${owes('pine')}, fund ${JSON.stringify(fund())}`);

    log('S5  Move back again, on the kept "$300 — the part … paid" line');
    const s5 = await moveBack('the part Scholarship Fund paid');
    log(`  Pine owes $${owes('pine')}; fund ${JSON.stringify(fund())}`);
    check('S5 no money moves; Pine still $700; fund 300/300', owes('pine') === 700 && fund().charged === 300 && fund().paid === 300, `Pine $${owes('pine')}, fund ${JSON.stringify(fund())}`);

    log('S6  Birch $1,000 (fund $800) and Oak $500 (fund $400); the fund pays $500; Move back Birch\'s share');
    await split('birch', 1000, 800, 'Birch tuition');
    await split('oak', 500, 400, 'Oak tuition');
    const before = fund();
    await fundPays(500, 'chk 2');
    const L = (fk) => JSON.parse(pl(fk) === '(none)' ? '[]' : pl(fk));
    const onFam = (fk) => { const x = L(fk); const v = new Set(x.filter(e => e.kind === 'void').map(e => e.voidOf)); let ch = 0, pd = 0;
      x.forEach(e => { if (v.has(e.id) || e.payerId !== 'org_scholarship_fund') return; if (e.kind === 'charge') ch += e.amount; if (e.kind === 'payment') pd += e.amount; }); return { charged: ch, paid: pd }; };
    log(`  fund before cheque ${JSON.stringify(before)}; after ${JSON.stringify(fund())}; the $500 cheque placed: Birch ${JSON.stringify(onFam('birch'))}, Oak ${JSON.stringify(onFam('oak'))}, Pine ${JSON.stringify(onFam('pine'))}`);
    const bOwes0 = owes('birch');
    const s6 = await moveBack('Birch tuition — share for Birch');
    log(`  Birch owes $${bOwes0} → $${owes('birch')}; fund ${JSON.stringify(fund())}; on Birch ${JSON.stringify(onFam('birch'))}, on Oak ${JSON.stringify(onFam('oak'))}`);
    log(`  NOTE S6 the cheque sits on Birch's account, but Move back kept ${(s6.c.match(/already paid (\$[\d,.]+)/) || [, '?'])[1]} on Birch's share and moved ${(s6.c.match(/unpaid (\$[\d,.]+)/) || [, '?'])[1]} to the Birch family`);
    await A.screenshot({ path: path.join(O, 's6_after.png') });
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
