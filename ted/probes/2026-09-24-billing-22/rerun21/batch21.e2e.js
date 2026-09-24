// Probe (21st pass, batch21). The REAL Me page (dc83cf0) in Chromium on the real
// migration chain incl. the edited 288. Chargebacks posted by the real
// record_chargeback + hold_autopay_for_dispute (what stripe-webhook calls).
//   Teal  — autopay plan, payment disputed (paused)          → must not be charged
//   Hazel — plan with autopay OFF (pays by hand), card on file, payment disputed
//   Fern  — no plan at all, card on file, payment disputed
//   Olive — control: owes $500, card on file, nothing disputed
// D1 Batch Charge window: who is listed, who is named "disputed"
// D2 Charge Card (the family's own button path, amount given) for Teal, Hazel,
//    Fern, Olive: which ones reach stripe-charge? (functions.invoke is replaced
//    by a recorder — nothing is sent anywhere)
// D3 what Billing's row says for Hazel / Fern (any sign of the dispute?)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const O = path.join(R, 'ted/probes/2026-09-24-billing-22/rerun21');
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8531;
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
  const db = boot({ port: 5832 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Dispute Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const ents = (k, paid) => [{ id: 'le_c_' + k, kind: 'charge', amount: 2000, reason: 'tuition', date: '2026-05-01' }]
    .concat(paid ? [{ id: 'le_p_' + k, kind: 'payment', amount: 1000, reason: 'card', date: '2026-06-01', source: { paymentId: 'pi_' + k } }] : []);
  const card = (k) => ({ cardOnFile: true, stripeCustomerId: 'cus_' + k, stripePaymentMethodId: 'pm_' + k, cardBrand: 'visa', cardLast4: '4242', cardFunding: 'credit' });
  kv('campistryMe', { families: {
      teal: Object.assign({ name: 'Teal', camperIds: ['Teal Kid'], entries: ents('teal', true),
        plans: [{ id: 'plan_teal', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }] }, card('teal')),
      hazel: Object.assign({ name: 'Hazel', camperIds: ['Hazel Kid'], entries: ents('hazel', true),
        plans: [{ id: 'plan_hazel', dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: false, paused: false }] }, card('hazel')),
      fern: Object.assign({ name: 'Fern', camperIds: ['Fern Kid'], entries: ents('fern', true) }, card('fern')),
      olive: Object.assign({ name: 'Olive', camperIds: ['Olive Kid'], entries: [{ id: 'le_c_olive', kind: 'charge', amount: 500, reason: 'tuition', date: '2026-05-01' }] }, card('olive')) } });
  // what stripe-webhook does on charge.dispute.created (needs_response)
  for (const k of ['teal', 'hazel', 'fern']) {
    const r = q1(`SELECT public.record_chargeback('${CAMP}', 'dp_${k}', ARRAY['pi_${k}'], 1000, 'fraudulent', 'needs_response')::text`);
    const h = q1(`SELECT public.hold_autopay_for_dispute('${CAMP}', '${k}', 'dp_${k}', true, 'fraudulent')::text`);
    log(`  ${k}: record_chargeback ${r.slice(0, 80)} · hold ${h}`);
  }
  const owes = (fk) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${fk}'))`));
  log(`  owes: Teal $${owes('teal')}, Hazel $${owes('hazel')}, Fern $${owes('fern')}, Olive $${owes('olive')}`);
  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const A = await ctx.newPage();
    A.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
    await A.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
    await A.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
        users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
    await A.goto(`http://localhost:${PORT}/campistry_me.html`, { waitUntil: 'domcontentloaded' });
    await A.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await wait(2500);
    await A.evaluate(() => { window.__inv = []; const c = window.CampistryDB.getClient();
      c.functions.invoke = (n, o) => { window.__inv.push(n + ' ' + JSON.stringify((o || {}).body || {})); return Promise.resolve({ data: { success: false, error: 'ted probe: not sent' }, error: null }); }; });
    await A.evaluate(() => window.CampistryMe.nav('billing')); await wait(1200);

    log('D1  Batch Charge');
    await A.evaluate(() => window.CampistryMe.batchCharge()); await wait(800);
    const txt = await A.evaluate(() => ((document.getElementById('dynModal') || {}).textContent || '').replace(/\s+/g, ' ').trim());
    log(`  window: "${txt.slice(0, 600)}"`);
    await A.screenshot({ path: path.join(O, 'batch21_window.png') });
    const listed = (txt.split('Not charged')[0] || '');
    check('D1a Teal (autopay paused) is not in the charge list and is named as disputed', !/Teal/.test(listed) && /disputed: .*Teal/.test(txt), listed.slice(0, 200));
    check('D1b Olive (control) is in the charge list', /Olive/.test(listed), listed.slice(0, 200));
    check('D1c Hazel (pays by hand; payment disputed) is not in the charge list', !/Hazel/.test(listed), listed.slice(0, 200));
    check('D1d Fern (no plan; payment disputed) is not in the charge list', !/Fern/.test(listed), listed.slice(0, 200));
    await A.evaluate(() => window.CampistryMe.closeModal && window.CampistryMe.closeModal('dynModal')); await wait(300);

    log('D2  Charge Card with an amount, per family (recorder in place of stripe-charge)');
    for (const k of ['teal', 'hazel', 'fern', 'olive']) {
      const before = await A.evaluate(() => window.__inv.length);
      const r = await A.evaluate((fk) => window.CampistryMe.chargeStoredCard(fk, 500, 'probe', true), k);
      const sent = await A.evaluate((n) => window.__inv.slice(n), before);
      log(`  ${k}: result ${JSON.stringify(r).slice(0, 160)}; reached stripe-charge: ${sent.length}`);
      if (k === 'olive') check('D2 control Olive reaches stripe-charge', sent.length === 1, String(sent.length));
      else check(`D2 ${k} (payment disputed) never reaches stripe-charge`, sent.length === 0, sent.join(' | ').slice(0, 160));
    }

    log('D3  what Billing shows on Hazel / Fern');
    await A.evaluate(() => window.CampistryMe.nav('billing')); await wait(1000);
    const rowOf = (name) => A.evaluate((nm) => { const t = ((document.getElementById('page-billing') || document.body).textContent || '').replace(/\s+/g, ' ');
      const i = t.indexOf(nm); return i < 0 ? '(not listed)' : t.slice(i, i + 220); }, name);
    for (const nm of ['Teal', 'Hazel', 'Fern']) log(`  ${nm}: "${await rowOf(nm)}"`);
    await A.screenshot({ path: path.join(O, 'batch21_billing.png'), fullPage: false });
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
