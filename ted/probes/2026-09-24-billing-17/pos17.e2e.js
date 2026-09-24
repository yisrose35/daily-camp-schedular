// Probe (17th pass, TED-159 re-check). The REAL register page
// (campistry_snacks_pos.html) in Chromium on the real migration chain incl.
// 283. The harness shim sends database calls synchronously; real supabase-js
// sends them with fetch. So after load this probe sends BOTH purchase
// functions (submit_canteen_purchase_once and the old submit_canteen_purchase)
// asynchronously, through the same bridge to the same database, optionally
// slower, or with the answer lost after the server did the work, or lost
// before it reached the server. The lost answer is shaped as supabase-js
// shapes a failed fetch: { message: 'TypeError: Failed to fetch', code: '' }.
//   P0 control: one tap → one debit
//   P1 answer takes 1.2 s, second tap after 0.3 s → one request, one debit
//   P2 server charged, answer lost → the register's words; tap again → ?
//   P3 the request never reached the server → tap again → charged once
//   P4 the SAME child buys the SAME item again later, as the very next sale
//      after a lost answer that the counselor did not re-press (they checked
//      and saw it went through) → is the second Ices charged?
//   P5 slow charge; while it is on its way the counselor starts the next
//      child's sale (select Avi, add Chips) → what happens to Avi's cart and
//      to the stock counts when Shaya's answer lands?
//   P6 not enough money → "Blocked", nothing charged; after a top-up the same
//      items go through
//   P7 migration 283 not applied (function dropped) → falls back, one charge
// Run: node ted/probes/2026-09-24-billing-17/pos17.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));

const PORT = 8418;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const SHAYA = 'Shaya Brickman', AVI = 'Avi Katz', LEAH = 'Leah Gold';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = boot({ port: 5718 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'POS Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('app1', { camperRoster: { [SHAYA]: { camperId: 1, division: 'Boys', grade: 'Junior', bunk: 'J1' }, [AVI]: { camperId: 2, division: 'Boys', grade: 'Junior', bunk: 'J1' },
    [LEAH]: { camperId: 3, division: 'Boys', grade: 'Junior', bunk: 'J1' } } });
  kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [{ id: 1, name: 'Ices', price: 2.5, cat: 'snack', stock: 50, totalSold: 0 },
    { id: 2, name: 'Chips', price: 1.5, cat: 'snack', stock: 50, totalSold: 0 }], settings: { payMethods: ['cash'], defaultDailyLimit: 0 } });
  const acct = (name, id, bal) => db.sql(`INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', ${id}, 'camper', ${lit(name)}, ${lit(name)}) ON CONFLICT DO NOTHING;
    SELECT public.canteen_account_save('${CAMP}', ${lit(name)}, '{"balance": ${bal}, "camperId": ${id}, "dailyLimit": 0}'::jsonb);
    SELECT public.canteen_post('${CAMP}', ${lit(name)}, '{"type":"credit","kind":"deposit","method":"cash","amount":${bal},"date":"2026-07-01","timestamp":${id},"camperId":${id}}'::jsonb);`);
  acct(SHAYA, 1, 40); acct(AVI, 2, 40); acct(LEAH, 3, 1);
  const debits = (who) => Number(q1(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${CAMP}' AND tx_type='debit'` + (who ? ` AND camper=${lit(who)}` : '')));
  const bal = (who) => q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(who)}`);
  const stock = () => q1(`SELECT string_agg((i->>'name') || ' ' || coalesce(i->>'stock','?') || ' left/' || coalesce(i->>'totalSold','0') || ' sold', ', ') FROM jsonb_array_elements((SELECT value->'inventory' FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='campistrySnacks')) i`);

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, .pos-toast')].map(t => t.textContent.trim()).filter(Boolean));
  const btn = () => page.evaluate(() => { const b = document.getElementById('chargeBtn'); return b ? (b.disabled ? '[disabled] ' : '') + b.textContent.trim() : '(none)'; });
  const cartNow = () => page.evaluate(() => (document.getElementById('cartBody') || {}).textContent.replace(/\s+/g, ' ').trim());
  try {
    await page.goto(`http://localhost:${PORT}/campistry_snacks_pos.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistrySnacksPOS, null, { timeout: 30000 });
    await page.waitForFunction((n) => [...document.querySelectorAll('.camper-item .camper-name')].some(e => e.textContent.trim() === n), SHAYA, { timeout: 30000 });
    const wrapped = await page.evaluate(({ ep, uid }) => {
      const c = window.CampistryDB.getClient(); const orig = c.rpc.bind(c);
      window.__delay = 0; window.__drop = false; window.__lostBefore = false; window.__sent = []; window.__arrived = 0;
      c.rpc = function (fn, args) {
        if (!/^submit_canteen_purchase/.test(fn)) return orig(fn, args);
        window.__sent.push(fn + (args && args.p_sale_key ? ' key=' + args.p_sale_key : ''));
        const delay = window.__delay, drop = window.__drop, lostBefore = window.__lostBefore;
        return new Promise((resolve) => setTimeout(async () => {
          if (lostBefore) { resolve({ data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 }); return; }
          const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'rpc', fn, args, userId: uid }) });
          const j = await r.json();
          window.__arrived++;
          if (drop) resolve({ data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 });
          else resolve(j.error ? { data: null, error: j.error } : { data: j.data, error: null });
        }, delay));
      };
      return c.rpc !== orig && window.CampistryDB.getClient() === c;
    }, { ep: `http://localhost:${PORT}/__pg`, uid: OWNER });
    log(`the register's client is the one wrapped: ${wrapped}; start: Shaya $${bal(SHAYA)}, Avi $${bal(AVI)}, Leah $${bal(LEAH)}; stock ${stock()}`);
    const pick = async (who) => { await page.click('.camper-item:has-text("' + who + '")'); await page.waitForSelector('.item-tile', { timeout: 10000 }); };
    const add = async (item) => { await page.click('.item-tile:has-text("' + item + '")'); };
    const ring = async (who, item) => { await pick(who); await add(item || 'Ices');
      await page.waitForFunction(() => { const b = document.getElementById('chargeBtn'); return b && !b.disabled; }, null, { timeout: 10000 }); };
    const sent = () => page.evaluate(() => window.__sent.slice());
    const set = (o) => page.evaluate((o) => Object.assign(window, o), o);

    log(`\nP0. Control: one tap`);
    await ring(SHAYA); await page.click('#chargeBtn'); await wait(1500);
    log(`    sent ${JSON.stringify(await sent())}; Shaya debits ${debits(SHAYA)}, $${bal(SHAYA)}; register says ${JSON.stringify(await toasts())}`);
    check('P0 one tap → one $2.50 debit, through submit_canteen_purchase_once with a key', debits(SHAYA) === 1 && Number(bal(SHAYA)) === 37.5 && /once key=sale_/.test((await sent())[0] || ''), `debits ${debits(SHAYA)}`);

    log(`\nP1. The answer takes 1.2 s; the counselor taps Charge again after 0.3 s`);
    let d = debits(SHAYA); let s0 = (await sent()).length;
    await ring(SHAYA); await set({ __delay: 1200 });
    await page.click('#chargeBtn'); await wait(300);
    const b1 = await btn();
    await page.click('#chargeBtn', { force: true }).catch(e => log('    second tap: ' + String(e.message).split('\n')[0]));
    await page.evaluate(() => window.charge && window.charge());   // and a third, straight into the handler
    await wait(2500); await set({ __delay: 0 });
    const t1 = await toasts();
    log(`    0.3 s after the first tap the button reads "${b1}"; requests ${JSON.stringify((await sent()).slice(s0))}; new debits ${debits(SHAYA) - d}; register says ${JSON.stringify(t1)}`);
    check('P1 one request, one debit, the button locked while charging, and the toast names the child', debits(SHAYA) - d === 1 && (await sent()).length - s0 === 1 && /Charging/.test(b1) && t1.some(t => /charged to Shaya Brickman/.test(t)) && !t1.some(t => /null/.test(t)),
      `${debits(SHAYA) - d} debits, ${(await sent()).length - s0} requests`);

    log(`\nP2. The server charged; the answer is lost`);
    d = debits(SHAYA); s0 = (await sent()).length;
    await ring(SHAYA); await set({ __drop: true });
    await page.click('#chargeBtn'); await wait(1500);
    const t2 = await toasts(); const b2 = await btn(); const c2 = await cartNow();
    log(`    register says ${JSON.stringify(t2)}; button "${b2}"; cart "${c2}"; debits so far +${debits(SHAYA) - d}`);
    await set({ __drop: false });
    await page.click('#chargeBtn').catch(e => log('    second tap: ' + String(e.message).split('\n')[0]));
    await wait(1500);
    const s2 = (await sent()).slice(s0);
    log(`    tap again → requests ${JSON.stringify(s2)}; register says ${JSON.stringify(await toasts())}; new debits ${debits(SHAYA) - d}; Shaya $${bal(SHAYA)}`);
    check('P2 the register says it could not confirm (never "Charge failed") and keeps the sale', t2.some(t => /Could not confirm the charge to Shaya Brickman/.test(t)) && !t2.some(t => /Charge failed/.test(t)) && /Ices/.test(c2), JSON.stringify(t2));
    check('P2b the retry sends the same key and the child is charged once', debits(SHAYA) - d === 1 && s2.length === 2 && s2[0] === s2[1], JSON.stringify(s2));

    log(`\nP3. The request never reached the server (wifi down before it went)`);
    d = debits(SHAYA); s0 = (await sent()).length;
    await ring(SHAYA); await set({ __lostBefore: true });
    await page.click('#chargeBtn'); await wait(1200);
    const t3 = await toasts();
    await set({ __lostBefore: false });
    await page.click('#chargeBtn').catch(() => {}); await wait(1500);
    log(`    first: ${JSON.stringify(t3)}; retry → ${JSON.stringify(await toasts())}; requests ${JSON.stringify((await sent()).slice(s0))}; new debits ${debits(SHAYA) - d}`);
    check('P3 charged exactly once after the retry', debits(SHAYA) - d === 1, `${debits(SHAYA) - d} debits`);

    log(`\nP4. Answer lost again; the counselor checks, sees it went through, clears the cart (no re-press). Ten minutes later Shaya buys another Ices — the very next sale on this register`);
    d = debits(SHAYA); s0 = (await sent()).length;
    await ring(SHAYA); await set({ __drop: true });
    await page.click('#chargeBtn'); await wait(1500);
    await set({ __drop: false });
    await page.evaluate(() => { if (window.clearCart) window.clearCart(); });
    const cartAfterClear = await cartNow();
    log(`    after the lost answer: +${debits(SHAYA) - d} debit on the server; cart after "clear": "${cartAfterClear}"`);
    if (/Ices/.test(cartAfterClear)) { await page.click('.cart-line button:has-text("−")').catch(() => {}); }
    const bal4 = Number(bal(SHAYA)); const d4 = debits(SHAYA);
    await ring(SHAYA); await page.click('#chargeBtn'); await wait(1500);
    const s4 = (await sent()).slice(s0);
    log(`    the second Ices: requests ${JSON.stringify(s4)}; register says ${JSON.stringify(await toasts())}; new debits ${debits(SHAYA) - d4}; Shaya $${bal4} → $${bal(SHAYA)}`);
    check('P4 a genuinely new sale of the same item is charged', debits(SHAYA) - d4 === 1, `the register said "charged" but the server replayed the first sale: ${debits(SHAYA) - d4} new debit(s), requests ${JSON.stringify(s4)}`);

    log(`\nP5. A slow charge for Shaya (2 s); while it is on its way the counselor starts Avi's sale (select Avi, add Chips)`);
    const st0 = stock(); d = debits(SHAYA); const da = debits(AVI);
    await ring(SHAYA); await set({ __delay: 2000 });
    await page.click('#chargeBtn'); await wait(300);
    let p5sel = 'ok';
    await pick(AVI).catch(e => { p5sel = 'could not select Avi: ' + String(e.message).split('\n')[0]; });
    await add('Chips').catch(e => { p5sel += ' / could not add Chips: ' + String(e.message).split('\n')[0]; });
    const cartMid = await cartNow(); const btnMid = await btn();
    await wait(2600); await set({ __delay: 0 });
    await wait(1500);
    const cartAfter = await cartNow(); const btnAfter = await btn();
    log(`    during: ${p5sel}; cart "${cartMid}"; button "${btnMid}"\n    after Shaya's answer: register says ${JSON.stringify(await toasts())}; cart "${cartAfter}"; button "${btnAfter}"`);
    log(`    Shaya +${debits(SHAYA) - d} debit, Avi +${debits(AVI) - da}; stock before ${st0}; after ${stock()}`);
    const ices = (s) => Number((s.match(/Ices (\d+) left/) || [])[1]); const chips = (s) => Number((s.match(/Chips (\d+) left/) || [])[1]);
    check('P5 the stock counts follow what was sold (Ices −1, Chips unchanged)', ices(stock()) === ices(st0) - 1 && chips(stock()) === chips(st0), `before ${st0}; after ${stock()}`);
    check('P5b Avi\'s half-rung sale is still on the screen', /Chips/.test(cartAfter), `cart "${cartAfter}"`);

    log(`\nP6. Leah has $1: Ices $2.50 → blocked`);
    await page.evaluate(() => { if (window.clearCart) window.clearCart(); });
    d = debits(LEAH);
    await ring(LEAH); await page.click('#chargeBtn'); await wait(1200);
    const t6 = await toasts();
    log(`    register says ${JSON.stringify(t6)}; Leah +${debits(LEAH) - d} debits, $${bal(LEAH)}`);
    check('P6 refused before sending (the page\'s own pre-check) or by the server; nothing charged', debits(LEAH) === d, JSON.stringify(t6));

    log(`\nP7. Migration 283 not applied yet (submit_canteen_purchase_once dropped)`);
    db.sql(`DROP FUNCTION public.submit_canteen_purchase_once(uuid, text, text, numeric, text, date, bigint); NOTIFY pgrst, 'reload schema';`);
    await page.evaluate(() => { if (window.clearCart) window.clearCart(); });
    d = debits(AVI); s0 = (await sent()).length;
    await ring(AVI); await page.click('#chargeBtn'); await wait(1500);
    const s7 = (await sent()).slice(s0);
    log(`    requests ${JSON.stringify(s7)}; register says ${JSON.stringify(await toasts())}; Avi +${debits(AVI) - d}`);
    check('P7 without 283 the register still charges once (old function)', debits(AVI) - d === 1 && s7.some(x => /^submit_canteen_purchase$/.test(x)), JSON.stringify(s7));
    log(`\n    Shaya's ledger: ${q1(`SELECT string_agg(tx_type || ' ' || amount || ' ' || coalesce(items,''), '; ' ORDER BY first_seen) FROM canteen_transactions WHERE camp_id='${CAMP}' AND camper=${lit(SHAYA)}`)}`);
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
