// Probe (16th pass, TED-153 re-check + hunt). Card Fees → "Discount for not
// paying by card" (3%). The REAL Me page in a real browser on the real
// migration chain (the smoke harness: tests/e2e/db + bridge + shim).
// Each family owes $1,000 of tuition (a posted ledger charge).
//   D1 Wolf pays $970 by cheque → Billing → Record Payment. Preview before
//      saving? Owes after? What sits on the ledger?
//   D2 Fox pays the full $1,000 by cheque → $30 credit?
//   D3 Lynx pays $500 (ACH) then $470 (Zelle) → exactly $30 in all?
//   D4 Bear pays $970 by credit card → no discount (owes $30)
//   D5 Moss pays $970 by cheque, recorded on the OTHER "Record Payment" —
//      Finance → Revenue → "+ Record Payment". Discount? Does Billing's
//      balance (and the parent's, from the ledger) even go down?
//   D6 Wolf's cheque was entered by mistake: Finance → Payment Log → ✕.
//      What happens to what Wolf owes, and to the $30 discount?
//   D7 Hawk paid $970 online by bank (a Stripe bank debit recorded by the
//      webhook's own SQL). Family menu → "Discount for not paying by card…"
//      → 970 → Give discount. Then the office presses it again for the same
//      payment (two people, or a double click on a slow day).
//   D8 menu labels per mode (cash discount / convenience / surcharge)
// Run: node ted/probes/2026-09-24-billing-16/cash_discount16.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));

const PORT = 8316;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };

(async () => {
  const db = boot({ port: 5696 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  const POL = { mode: 'cash_discount', cashDiscountPct: 3, cashDiscountFlat: 0, state: 'NY' };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const d = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const fam = (key, name) => ({ name, camperIds: [name[0] + '. ' + name], entries: [{ id: 'le_t_' + key, kind: 'charge', amount: 1000, reason: 'tuition', date: d }] });
  const FAMS = { wolf: 'Wolf', fox: 'Fox', lynx: 'Lynx', bear: 'Bear', moss: 'Moss', hawk: 'Hawk' };
  const families = {}; for (const [k, n] of Object.entries(FAMS)) families[k] = fam(k, n);
  kv('campistryMe', { families, enrollSettings: { cardFeePolicy: POL, formConfig: { paymentMethods: ['check', 'cash', 'card', 'ach', 'zelle'] } },
    sessions: [{ id: 's1', name: 'Full Summer', startDate: '2027-06-28', endDate: '2027-08-20', price: 1000 }] });
  const owes = (k) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${k}'))`));
  const ledger = (k) => q1(`SELECT coalesce(string_agg(e->>'kind' || ' ' || (e->>'amount') || ' ' || coalesce(e->>'reason','') || ' [' || coalesce(e->>'id','') || ']', '; ' ORDER BY ord), '')
                            FROM jsonb_array_elements(public.camp_family('${CAMP}','${k}')->'entries') WITH ORDINALITY x(e, ord)`);

  // D7 setup: Hawk's $970 online bank debit, recorded the way stripe-webhook records it (append_camp_payment)
  const hawkPay = q1(`SELECT public.append_camp_payment(p_camp_id => '${CAMP}', p_payment => ${lit(JSON.stringify({ id: 'pi_pi_hawk', family: 'Hawk', familyKey: 'hawk', amount: 970, date: d, method: 'ACH', reference: 'pi_hawk', notes: 'Online payment (ACH)', stripePaymentIntentId: 'pi_hawk', status: 'succeeded', timestamp: Date.now() }))}::jsonb, p_dedupe_key => 'pi_hawk', p_update_on_match => '{"status":"succeeded"}'::jsonb)::text`);
  log(`SETUP: 6 families owe $1,000 each (Card Fees: discount for not paying by card, 3%). Hawk's online bank payment: ${hawkPay}; Hawk owes $${owes('hawk')}`);

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  page.on('dialog', dd => dd.accept().catch(() => {}));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const modal = () => page.evaluate(() => { const m = document.getElementById('dynModal'); return m && m.offsetParent !== null ? m.textContent.replace(/\s+/g, ' ').trim() : '(closed)'; });
  const toast = () => page.evaluate(() => { const e = document.getElementById('tM'); return e ? e.textContent : ''; });
  const confirmOk = async () => { // Me's confirmDialog — press its confirm button if one is showing
    await wait(400);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && /^(Remove|Confirm|OK|Yes)$/i.test(b.textContent.trim())); if (b.length) b[b.length - 1].click(); });
  };
  const famPage = async (k) => { await page.evaluate((k) => window.CampistryMe.viewFamily(k), k); await wait(1000);
    return page.evaluate(() => { const c = document.getElementById('page-familydetail'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : ''; }); };
  // What Billing shows on the family's own page: the "Balance" figure
  const billingBalance = async (k) => { const t = await famPage(k); const m = t.match(/Balance\s*(-?\$[\d,.]+|\$-?[\d,.]+|−\$[\d,.]+)/); return m ? m[1] : t.slice(0, 160); };
  const recordPayment = async (k, amount, method) => {
    await page.evaluate((k) => window.CampistryMe.openPaymentForFamily(k), k);
    await wait(700);
    await page.fill('#payAmount', String(amount));
    await page.selectOption('#payMethod', method);
    await wait(300);
    const preview = await page.evaluate(() => { const b = document.getElementById('payDiscount'); return b ? b.textContent.trim() : '(no preview box)'; });
    await page.click('#dynModalSave');
    await wait(2500);
    return preview;
  };
  try {
    await page.goto(`http://localhost:${PORT}/campistry_me.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await wait(3000);
    const methods = await page.evaluate(() => { window.CampistryMe.openPaymentForFamily('wolf'); const s = document.getElementById('payMethod'); const v = s ? [...s.options].map(o => o.value) : []; window.CampistryMe.closeModal('dynModal'); return v; });
    log(`Record Payment methods offered: ${JSON.stringify(methods)}`);
    const pick = (re) => methods.find(v => re.test(v));

    log(`\nD1. Wolf pays $970 by cheque → Billing → Record Payment`);
    const p1 = await recordPayment('wolf', 970, pick(/^check|cheque/i));
    log(`    preview in the window before saving: "${p1}"`);
    log(`    toast: "${await toast()}"`);
    log(`    ledger: ${ledger('wolf')}`);
    check('D1 $970 by cheque settles $1,000 (owes $0) and the preview showed $30', owes('wolf') === 0 && /\$30(\.00)?\b/.test(p1), `owes $${owes('wolf')}`);

    log(`\nD2. Fox pays the full $1,000 by cheque`);
    const p2 = await recordPayment('fox', 1000, pick(/^check|cheque/i));
    log(`    preview: "${p2}"; toast: "${await toast()}"`);
    check('D2 the posted price by cheque leaves $30 of credit', owes('fox') === -30, `owes $${owes('fox')}`);

    log(`\nD3. Lynx pays $500 by bank transfer (ACH), then $470 by Zelle`);
    const p3a = await recordPayment('lynx', 500, pick(/^ach$/i));
    const p3b = await recordPayment('lynx', 470, pick(/zelle/i));
    log(`    previews: "${p3a}" / "${p3b}"`);
    log(`    ledger: ${ledger('lynx')}`);
    check('D3 two part payments earn exactly $30 in all', owes('lynx') === 0, `owes $${owes('lynx')}`);

    log(`\nD4. Bear pays $970 by credit card (recorded by hand)`);
    const p4 = await recordPayment('bear', 970, pick(/credit|card/i));
    log(`    preview: "${p4}"`);
    check('D4 a card payment gets no discount', owes('bear') === 30, `owes $${owes('bear')}`);

    log(`\nD5. Moss pays $970 by cheque; the office records it on Finance → Revenue → "+ Record Payment"`);
    await page.evaluate(() => { window.CampistryMe.nav('finance'); });
    await wait(1200);
    await page.evaluate(() => { if (window.CampistryMe.finSetTab) window.CampistryMe.finSetTab('revenue'); });
    await wait(800);
    const hasBtn = await page.evaluate(() => [...document.querySelectorAll('#page-finance button')].some(b => /Record Payment/.test(b.textContent)));
    log(`    Finance → Revenue shows a "+ Record Payment" button: ${hasBtn}`);
    await page.evaluate(() => [...document.querySelectorAll('#page-finance button')].find(b => /Record Payment/.test(b.textContent)).click());
    await wait(700);
    log(`    its window: "${(await modal()).slice(0, 200)}"`);
    const fapMethods = await page.evaluate(() => { const s = document.getElementById('fapMethod'); return s ? [...s.options].map(o => o.value) : []; });
    await page.fill('#fapFamily', 'Moss');
    await page.fill('#fapAmount', '970');
    await page.selectOption('#fapMethod', fapMethods.find(v => /^check|cheque/i.test(v)));
    await page.click('#dynModalSave');
    await wait(2500);
    log(`    toast: "${await toast()}"`);
    const mossRow = await page.evaluate(() => { const r = [...document.querySelectorAll('#page-finance tr')].find(t => /Moss/.test(t.textContent)); return r ? r.textContent.replace(/\s+/g, ' ').trim() : '(none)'; });
    log(`    Finance's own lists now show Moss as: "${mossRow.slice(0, 160)}"`);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(1500);
    const mossBill = await billingBalance('moss');
    log(`    Billing's figure for Moss: ${JSON.stringify(mossBill)}; the ledger (what the parent's Link balance and autopay read): owes $${owes('moss')}`);
    log(`    Moss's ledger: ${ledger('moss')}`);
    check('D5 a cheque recorded on the Finance page reduces what Moss owes', owes('moss') < 1000, `Moss still owes $${owes('moss')} on the ledger (Billing: ${JSON.stringify(mossBill)})`);

    log(`\nD6. Wolf's cheque was entered by mistake → Finance → Revenue → Payment Log → ✕ on it`);
    await page.evaluate(() => { window.CampistryMe.nav('finance'); }); await wait(800);
    await page.evaluate(() => { if (window.CampistryMe.finSetTab) window.CampistryMe.finSetTab('revenue'); }); await wait(800);
    const wolfBefore = owes('wolf');
    const removed = await page.evaluate(() => { const r = [...document.querySelectorAll('#page-finance tr')].find(t => /Wolf/.test(t.textContent) && t.querySelector('button')); if (!r) return '(no Wolf row with ✕)'; const t = r.textContent.replace(/\s+/g, ' ').trim(); r.querySelector('button').click(); return t; });
    log(`    pressed ✕ on: "${removed}"`);
    await confirmOk(); await wait(2500);
    log(`    toast: "${await toast()}"`);
    await page.evaluate(() => window.CampistryMe.nav('billing')); await wait(1500);
    log(`    Wolf owes on the ledger: before $${wolfBefore}, after $${owes('wolf')}; Billing: ${JSON.stringify(await billingBalance('wolf'))}`);
    log(`    Wolf's ledger: ${ledger('wolf')}`);
    check('D6 removing the mistaken $970 cheque puts Wolf back to owing $1,000', owes('wolf') === 1000, `Wolf owes $${owes('wolf')} — the payment and its $30 discount are still on the ledger`);

    log(`\nD7. Hawk paid $970 online by bank (owes $${owes('hawk')}). Family menu → "Discount for not paying by card…" → 970`);
    const give = async () => {
      await page.evaluate(() => window.CampistryMe.addCardSurcharge('hawk')); await wait(700);
      const w = await modal();
      await page.fill('#cdAmt', '970'); await page.click('#dynModalSave'); await wait(2000);
      return w;
    };
    const w1 = await give();
    log(`    window: "${w1.slice(0, 260)}"`);
    log(`    toast: "${await toast()}"; Hawk owes $${owes('hawk')}`);
    const after1 = owes('hawk');
    await give();
    log(`    pressed again for the same payment → toast: "${await toast()}"; Hawk owes $${owes('hawk')}`);
    check('D7 the online-bank discount settles Hawk (owes $0)', after1 === 0, `owes $${after1}`);
    check('D7b giving it a second time for the same payment is refused', owes('hawk') === after1, `second press took another $${Math.round((after1 - owes('hawk')) * 100) / 100} off — Hawk now owes $${owes('hawk')}`);

    log(`\nD8. The family page's More menu in this mode (cash discount)`);
    await page.evaluate(() => window.CampistryMe.viewFamily('bear')); await wait(1000);
    const items = await page.evaluate(() => [...document.querySelectorAll('#page-familydetail button')].map(b => b.textContent.trim()).filter(t => /surcharge|discount|online payment fee/i.test(t)));
    log(`    menu items: ${JSON.stringify(items)}`);
    check('D8 the menu says "Discount for not paying by card…" in this mode', items.some(t => /^Discount for not paying by card/.test(t)), JSON.stringify(items));
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
