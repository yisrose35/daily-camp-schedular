// Probe (13th pass, hunt): card surcharges — never deep-audited before.
// The REAL Me page (Billing) in a real browser against real SQL (the project's
// smoke harness), plus the real campistry_card_fees.js rules.
//
//   C1  The camp surcharges credit cards 3% (state NY, processor notified — every
//       blocker cleared). Gold's only card on file is a DEBIT card (Stripe told
//       Campistry so when it was saved: funding "debit"). The office opens
//       Billing → Gold → "Add card surcharge…" for the $1,000 Gold owes.
//       What does the module say about a debit card, and what does the page do?
//   C2  Gold paid $1,030 by card (tuition + the $30 fee). Gold withdraws; the
//       office opens Billing → Issue Credit/Refund → Direct Refund. What does
//       the window say about the fee, and does anything work out the share of
//       the surcharge that must go back (the card brands require it)?
// Run: node ted/probes/2026-09-24-billing-13/surcharge.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const F = require(path.join(R, 'campistry_card_fees.js'));

const PORT = 8187;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
async function waitFor(what, fn, ms) {
  const until = Date.now() + (ms || 15000); let last;
  while (Date.now() < until) { try { if (await fn()) return true; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 200)); }
  throw new Error('timed out waiting for ' + what + (last ? ' (' + last + ')' : ''));
}
const POLICY = { mode: 'surcharge', surchargePct: 3, costOfAcceptancePct: 3, state: 'NY', processorNotifiedOn: '2026-05-01' };

(async () => {
  log('The card-fee rules themselves (campistry_card_fees.js), $1,000 by card, this policy:');
  for (const funding of ['credit', 'debit', 'prepaid', '']) {
    const q = F.quote(POLICY, { amount: 1000, method: 'card', funding, channel: 'online' });
    log(`    funding ${JSON.stringify(funding || '(unknown)').padEnd(11)} → fee $${q.fee}, ${q.reason}${q.label ? ' — "' + q.label + '"' : ''}`);
  }
  log(`    blockers for this policy: ${JSON.stringify(F.explain(POLICY).blockers || [])}`);
  log(`    what must go back when $1,000 of a $1,030 payment is refunded: $${F.refundShare(POLICY, { feeCharged: 30, paymentAmount: 1030, refundAmount: 1000 }).fee}; all of it: $${F.refundShare(POLICY, { feeCharged: 30, paymentAmount: 1030, refundAmount: 1030 }).fee}`);

  const db = boot({ port: 5649 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  const paidAt = Date.now() - 10 * 86400000, paidDate = new Date(paidAt).toISOString().slice(0, 10);
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email, payment_processor_key) VALUES ('${CAMP}', '${OWNER}', 'Probe Camp', 'o@p.test', 'stripe');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  const debitCard = { id: 'pm_x1', type: 'card', processor: 'stripe', token: 'pm_debit', stripeCustomerId: 'cus_gold', last4: '4242', label: 'Visa ···· 4242', funding: 'debit', isDefault: true };
  const gold = { name: 'Gold', camperIds: ['Dov Gold'], stripeCustomerId: 'cus_gold', stripePaymentMethodId: 'pm_debit', cardOnFile: true,
    paymentMethodType: 'card', paymentMethodLabel: 'Visa ···· 4242', savedPaymentMethods: [debitCard],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', date: paidDate }] };
  // Silver: the same fee already added and PAID by card with the tuition ($1,030)
  const silver = { name: 'Silver', camperIds: ['Eli Silver'], stripeCustomerId: 'cus_silver', cardOnFile: true,
    charges: [{ id: 'sur_1', category: 'Card Fee', description: F.disclosure(POLICY), amount: 30, date: paidDate, cardFee: { mode: 'surcharge', base: 1000, reason: 'surcharge' } }],
    entries: [{ id: 'le_t2', kind: 'charge', amount: 1000, reason: 'tuition', date: paidDate },
              { id: 'le_chg_sur_1', kind: 'charge', amount: 30, reason: 'card_fee', date: paidDate, source: { chargeId: 'sur_1' } },
              { id: 'le_pay_pi_pi_S', kind: 'payment', amount: 1030, reason: 'card', date: paidDate, by: 'system', source: { paymentId: 'pi_pi_S' } }] };
  kv('campistryMe', { families: { gold, silver }, enrollSettings: { cardFeePolicy: POLICY } });
  db.sql(`SELECT public.camp_payment_add('${CAMP}', ${lit(JSON.stringify({ id: 'pi_pi_S', family: 'Silver', familyKey: 'silver', amount: 1030, date: paidDate,
    method: 'Card', stripePaymentIntentId: 'pi_S', status: 'succeeded', timestamp: paidAt }))}::jsonb);`);
  const ledger = (k) => q1(`SELECT string_agg((e->>'kind') || ' ' || coalesce(e->>'reason','') || ' $' || (e->>'amount'), ', ') FROM jsonb_array_elements(public.camp_family('${CAMP}','${k}')->'entries') e`);
  const owes = (k) => Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${CAMP}','${k}'))`));

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));
  try {
    await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await page.evaluate(() => window.CampistryMe.nav('billing'));
    await waitFor('Gold on the page', () => page.evaluate(() => /Gold/.test(document.body.textContent)), 30000);
    await new Promise(r => setTimeout(r, 2500));

    log(`\nC1. Gold owes $${owes('gold')}; the only card on file is a DEBIT card (funding "debit"). Office: Billing → Gold → Add card surcharge…`);
    await page.evaluate(() => window.CampistryMe.addCardSurcharge('gold'));
    await page.waitForSelector('#csBase', { timeout: 10000 });
    await page.fill('#csBase', '1000');
    await page.evaluate(() => window.CampistryMe._surchargePreview());
    const preview = (await page.textContent('#csPreview')).replace(/\s+/g, ' ').trim();
    const modalText = (await page.textContent('#dynModal')).replace(/\s+/g, ' ').trim();
    log(`    the window: "${modalText.slice(0, 260)}"`);
    log(`    preview: "${preview}"`);
    await page.click('#dynModalSave');
    await new Promise(r => setTimeout(r, 3000));
    log(`    toast ${JSON.stringify((await toasts()).slice(-1))}; Gold's ledger now [${ledger('gold')}], owes $${owes('gold')}`);
    check('C1 no surcharge is put on a family whose card is a debit card (the module refuses: "Debit and prepaid cards are never surcharged")',
      !/card_fee|30/.test(ledger('gold').replace('tuition $1000', '')), `a $30 fee was added: [${ledger('gold')}]`);

    log(`\nC2. Silver paid $1,030 by card (tuition $1,000 + the 3% fee $30). Silver withdraws. Office: Issue Credit/Refund → Direct Refund`);
    log(`    Silver's ledger [${ledger('silver')}], owes $${owes('silver')}`);
    await page.evaluate(() => window.CampistryMe.issueCreditForFamily('silver'));
    await page.waitForSelector('#crType', { timeout: 10000 });
    await page.selectOption('#crType', 'refund_gateway');
    await new Promise(r => setTimeout(r, 500));
    const summary = (await page.textContent('#crRefundSummary')).replace(/\s+/g, ' ').trim();
    const note = (await page.textContent('#crStripeOptWrap')).replace(/\s+/g, ' ').trim();
    await page.fill('#crRefundAmount', '1000'); await page.evaluate(() => window.CampistryMe._crUpdateBalancePreview());
    const prev = (await page.textContent('#crBalancePreview')).replace(/\s+/g, ' ').trim();
    log(`    window: "${summary}" | "${note.slice(0, 160)}"\n    refunding $1,000 (the tuition): "${prev}"`);
    check('C2 the refund window says a share of the $30 surcharge must go back with the refund (the brands require it; campistry_card_fees.refundShare works it out: $29.13 for $1,000, $30 for all)',
      /surcharge|card fee|fee/i.test(summary + ' ' + note + ' ' + prev), 'no mention of the fee anywhere in the refund window');
  } catch (e) {
    check('the run finished', false, String(e.message).split('\n')[0]);
  } finally {
    log('page errors: ' + JSON.stringify(pageErrors));
    await browser.close().catch(() => {});
    await bridgeSrv.close().catch(() => {});
    db.stop();
    log(`\n${bad} BAD`);
  }
})();
