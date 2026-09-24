// =============================================================================
// snacks_refund_windows.e2e.js — the REAL Snacks refund windows, clicked in a
// real browser (Playwright + Chromium) over a throwaway Postgres with the real
// migrations (tests/e2e/db.js, bridge.js, shim.js — the money_path harness).
//
// WHY THIS EXISTS. Three Snacks windows crashed on the office and every test
// stayed green, because the tests pulled single functions out of the page and
// supplied their own copies of the helpers the page could not reach:
//
//   TED-124  Refund All called _stripeRefundCapacity, which never existed — the
//            window never opened.
//   TED-116  the "waiting for an answer" list called _lbl, declared INSIDE
//            getCamperList — it crashed as it drew, so the office had nowhere to
//            settle a stuck Sola/Banquest refund.
//   TED-125  Take Out Cash hit the same _lbl after the payout: no confirmation,
//            and the amount left in the box.
//   TED-130  "How much can go back to the card" was worked out from the week of
//            history the page loads, so a top-up older than 7 days read $0.00.
//            Step 3b answers the page's question with the REAL refund function's
//            code (run in Node by tests/edge_harness.js) over the REAL database's
//            full history — no stand-in numbers — with a top-up 30 days old.
//
// Here nothing is extracted: the page loads as the office loads it, and the
// test presses the buttons. Edge functions are not reachable in the harness, so
// `functions.invoke` is swapped for one that answers the `holds` question and
// records every call; everything else (deposits, cash-out) runs through the
// real RPCs into the database.
//
// It SKIPS with exit 0 when Playwright or Postgres is missing, the same bargain
// tests/money_path.e2e.js strikes.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PORT = 8147;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const CAMPER = 'Avi Katz';

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (e) {
    console.log('SKIP — playwright is not installed (npm i).');
    process.exit(0);
}
const { boot } = require('./e2e/db');
const { start } = require('./e2e/bridge');
const { runEdge } = require('./edge_harness');

const checks = [];
function check(label, ok, detail) {
    checks.push({ label, ok: !!ok, detail });
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '   → ' + detail : ''));
}
function step(n, what) { console.log('\n' + n + '. ' + what); }
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function waitFor(what, fn, ms) {
    const until = Date.now() + (ms || 15000); let last;
    while (Date.now() < until) {
        try { if (await fn()) return true; } catch (e) { last = e.message; }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('timed out waiting for ' + what + (last ? ' (' + last + ')' : ''));
}

(async () => {
    const db = boot({});
    if (!db) { console.log('SKIP — no Postgres on this machine.'); process.exit(0); }
    console.log('postgres up with ' + db.applied.length + ' migrations applied');

    db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
            INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Refund Camp', 'o@r.test');
            UPDATE camps SET payment_processor_key = 'cardknox' WHERE id = '${CAMP}';`);
    const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                 ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
    kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
    kv('campistrySnacks', { accounts: {}, transactions: [], inventory: [], settings: { payMethods: ['cash', 'card'], defaultDailyLimit: 0 } });

    const bridge = await start(db, { port: PORT });
    const shim = fs.readFileSync(path.join(__dirname, 'e2e', 'shim.js'), 'utf8');
    const pinned = '/opt/pw-browsers/chromium';
    const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', e => { pageErrors.push(String(e).split('\n')[0]); if (process.env.STACKS) console.log('STACK', e.stack); });
    await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
    await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
        users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);

    const open = async (file, ready) => {
        await page.goto('http://localhost:' + PORT + '/' + file, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId(), null, { timeout: 30000 });
        if (ready) await page.waitForFunction(ready, null, { timeout: 30000 });
    };
    const snacksNav = async (pane) => {
        await page.click('#hamburgerBtn');
        await page.click('.sidebar-item[data-page="' + pane + '"]');
        await page.waitForSelector('#page-' + pane + '.active', { timeout: 10000 });
    };
    const visible = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display !== 'none'; }, id);
    // The edge functions: `holds` answers with the given list; every call is kept.
    const fakeEdge = (holds) => page.evaluate((hs) => {
        window.__fnCalls = [];
        window.CampistryDB.client.functions.invoke = async (fn, o) => {
            window.__fnCalls.push({ fn, body: o && o.body });
            if (o && o.body && o.body.action === 'holds') return { data: { success: true, holds: hs }, error: null };
            return { data: { totalRefunded: 0, refundedCount: 0, skippedCount: 0, failedCount: 0, details: [] }, error: null };
        };
    }, holds);
    const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map(t => t.textContent.trim()).filter(Boolean));

    let camperId = null;
    try {
        // ── 0. a camper, a $40 cash deposit and a $25 Sola deposit ──────────
        step(0, 'A camper with $40 in cash and $25 paid through Sola');
        await open('campistry_me.html', () => !!window.CampistryMe);
        await page.waitForFunction(() => { const g = window.loadGlobalSettings && window.loadGlobalSettings(); return !!(g && g.campStructure && g.campStructure.Boys); }, null, { timeout: 30000 });
        await page.evaluate(() => window.CampistryMe.nav('campers'));
        await page.evaluate(() => window.CampistryMe.editCamper(null));
        await page.waitForSelector('#ceFirst', { timeout: 10000 });
        await page.waitForFunction(() => { const s = document.getElementById('ceDiv'); return s && [...s.options].some(o => o.value === 'Boys'); }, null, { timeout: 10000 });
        await page.fill('#ceFirst', 'Avi'); await page.fill('#ceLast', 'Katz');
        await page.selectOption('#ceDiv', 'Boys'); await page.selectOption('#ceCGrade', 'Junior'); await page.selectOption('#ceBunk', 'J1');
        await page.click('#ceSave');
        await page.waitForSelector('#camperEditModal', { state: 'hidden', timeout: 10000 });
        await waitFor('the roster saved with a camper number', () => {
            const r = db.json(`SELECT value FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='app1'`);
            const rec = r.length && r[0].value.camperRoster && r[0].value.camperRoster[CAMPER];
            if (rec && Number(rec.camperId) > 0) { camperId = Number(rec.camperId); return true; }
            return false;
        }, 30000);

        await open('campistry_snacks.html', () => !!window.CampistrySnacks);
        await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
        await snacksNav('accounts');
        await page.click('button[onclick="openM(\'dep\')"]');
        await page.waitForSelector('#m-dep', { state: 'visible', timeout: 10000 });
        await page.selectOption('#depCamper', CAMPER); await page.fill('#depAmt', '40'); await page.selectOption('#depMethod', 'cash');
        await page.click('button[onclick="addDep()"]');
        await waitFor('the cash deposit on the account row', () => {
            const a = db.json(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(CAMPER)}`);
            return a.length === 1 && Number(a[0].balance) === 40;
        }, 30000);
        await page.waitForSelector('#m-dep', { state: 'hidden', timeout: 15000 });
        // the Sola deposit, the way cardknox-webhook credits one
        const credit = db.json(`SELECT public.credit_canteen_balance_from_processor(
                p_camp_id => '${CAMP}', p_camper_name => ${lit(CAMPER)}, p_amount => 25,
                p_processor_key => 'cardknox', p_external_transaction_id => 'XREF-25') AS r`);
        check('the Sola deposit was credited', credit[0] && credit[0].r && credit[0].r.success, JSON.stringify(credit[0] && credit[0].r));
        // the page picks it up the way it does after a refund
        await page.evaluate(() => window.CampistrySnacks && window.CampistrySnacks.refreshFromCloud ? window.CampistrySnacks.refreshFromCloud() : null);
        await open('campistry_snacks.html', () => !!window.CampistrySnacks);
        await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
        await snacksNav('accounts');
        await waitFor('the $65 wallet in the page', () => page.evaluate((n) => {
            const a = window.CampistrySnacks.getAccount ? window.CampistrySnacks.getAccount(n) : null;
            return a && Math.abs(Number(a.balance) - 65) < 0.001;
        }, CAMPER), 20000);

        const soloHold = { key: 'canteen:cref_x:RN1', camperId, account: CAMPER, amount: 20, method: 'cardknox', paymentRef: 'RN1', ageSeconds: 600 };

        // ── 1. Refund All (TED-124) ─────────────────────────────────────────
        step(1, 'Snacks → Accounts → Refund All, on a Sola camp with one unanswered refund');
        await fakeEdge([soloHold]);
        let errs = pageErrors.length;
        await page.click('button[onclick="openRefundAllModal()"]');
        await waitFor('the Refund All window', () => visible('m-refundall'), 10000).catch(() => {});
        await waitFor('the preview', () => page.evaluate(() => /through|No campers|no card processor/.test((document.getElementById('refundAllBody') || {}).textContent || '')), 10000).catch(() => {});
        await waitFor('the waiting list', () => page.evaluate(() => { const h = document.getElementById('refundAllHolds'); return h && h.style.display !== 'none' && h.innerHTML; }), 10000).catch(() => {});
        const ra = await page.evaluate(() => {
            const h = document.getElementById('refundAllHolds'), b = document.getElementById('refundAllBtn');
            return { body: (document.getElementById('refundAllBody') || {}).textContent || '',
                     holds: h && h.style.display !== 'none' ? h.textContent : '',
                     holdButtons: h ? [...h.querySelectorAll('button')].map(x => x.textContent) : [],
                     btn: b && getComputedStyle(b).display !== 'none' ? b.textContent : null };
        });
        check('no page error from the click', pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));
        check('the Refund All window opens', await visible('m-refundall'));
        check('it counts the Sola-paid money only: 1 camper, $25.00, through Sola',
              /1 camper\b/.test(ra.body) && /\$25\.00/.test(ra.body) && /through Sola/.test(ra.body), JSON.stringify(ra.body.slice(0, 200)));
        check('the button offers exactly that', ra.btn === 'Refund All ($25.00)', JSON.stringify(ra.btn));
        check('the unanswered refund is listed, by name without the number', /Avi Katz/.test(ra.holds) && /\$20\.00/.test(ra.holds), JSON.stringify(ra.holds.slice(0, 200)));
        check('with both answers', ra.holdButtons.join('|') === 'It went through|Nothing went through', JSON.stringify(ra.holdButtons));
        await page.evaluate(() => closeM('refundall'));

        // ── 2. the child's own Refund window (TED-116) ──────────────────────
        step(2, 'The Refund button on the child\'s row, with the same unanswered refund');
        await fakeEdge([soloHold]);
        errs = pageErrors.length;
        const onclick = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => /^openMFor\('refund'/.test(x.getAttribute('onclick') || ''));
            if (b) b.click();
            return b ? b.getAttribute('onclick') : null;
        });
        check('the row has a Refund button', !!onclick, JSON.stringify(onclick));
        await waitFor('the waiting list in the Refund window', () => page.evaluate(() => { const h = document.getElementById('refundHolds'); return h && h.style.display !== 'none' && h.innerHTML; }), 10000).catch(() => {});
        const one = await page.evaluate(() => {
            const h = document.getElementById('refundHolds');
            return { shown: !!(h && h.style.display !== 'none' && h.innerHTML), text: h ? h.textContent : '',
                     buttons: h ? [...h.querySelectorAll('button')].map(b => b.textContent) : [],
                     box: (document.getElementById('refundBox') || {}).textContent || '' };
        });
        check('no page error drawing the window', pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));
        check('the Refund window is open', await visible('m-refund'));
        check('"waiting for an answer" is shown for this child', one.shown && /waiting for an answer/.test(one.text) && /Avi Katz/.test(one.text), JSON.stringify(one.text.slice(0, 200)));
        check('with "It went through" and "Nothing went through"', one.buttons.join('|') === 'It went through|Nothing went through', JSON.stringify(one.buttons));
        check('the box offers the Sola-paid $25.00', /via Sola: \$25\.00/.test(one.box), JSON.stringify(one.box));

        // "Nothing went through" sends the office's answer for exactly that refund
        await page.evaluate(() => { window.confirm = () => true; });
        await page.evaluate(() => { window.__fnCalls = []; });
        await page.click('#refundHolds button:has-text("Nothing went through")');
        await waitFor('the answer sent', () => page.evaluate(() => window.__fnCalls.some(c => c.body && c.body.action === 'resolveHold')), 10000).catch(() => {});
        const sent = await page.evaluate(() => window.__fnCalls.filter(c => c.body && c.body.action === 'resolveHold'));
        check('the answer goes to payments-canteen-refund for that hold',
              sent.length === 1 && sent[0].fn === 'payments-canteen-refund' && sent[0].body.holdKey === soloHold.key && sent[0].body.wentThrough === false,
              JSON.stringify(sent));
        // "It went through" asks for the reference first, and sends it
        await page.evaluate(() => { window.prompt = () => 'SOLA-REF-9'; window.__fnCalls = []; });
        await page.click('#refundHolds button:has-text("It went through")');
        await waitFor('the answer sent', () => page.evaluate(() => window.__fnCalls.some(c => c.body && c.body.action === 'resolveHold')), 10000).catch(() => {});
        const sent2 = await page.evaluate(() => window.__fnCalls.filter(c => c.body && c.body.action === 'resolveHold'));
        check('"It went through" sends the reference the office typed',
              sent2.length === 1 && sent2[0].body.wentThrough === true && sent2[0].body.reference === 'SOLA-REF-9', JSON.stringify(sent2));
        check('no page error from either answer', pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));
        await page.evaluate(() => closeM('refund'));

        // ── 3. Take Out Cash (TED-125) ──────────────────────────────────────
        step(3, 'Take Out Cash: $5 to the child');
        errs = pageErrors.length;
        await page.click('button[onclick="openM(\'cash\')"]');
        await page.waitForSelector('#m-cash', { state: 'visible', timeout: 10000 });
        await page.selectOption('#cashCamper', CAMPER);
        await page.fill('#cashAmt', '5');
        if (await page.$('#cashNote')) await page.fill('#cashNote', 'bus money');
        await page.evaluate(() => window.cashPickCamper && window.cashPickCamper());
        await page.click('#cashBtn');
        await waitFor('the cash-out on the account row', () => {
            const a = db.json(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key=${lit(CAMPER)}`);
            return a.length === 1 && Number(a[0].balance) === 60;
        }, 20000);
        await waitFor('the confirmation', async () => (await toasts()).some(t => /Paid out \$5\.00 cash to Avi Katz/.test(t)), 10000).catch(() => {});
        const rows = db.json(`SELECT amount FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind'='cash_out'`);
        const t = await toasts();
        check('one $5 cash-out row in the database', rows.length === 1 && Number(rows[0].amount) === 5, JSON.stringify(rows));
        check('no page error from the payout', pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));
        check('the office is told "Paid out $5.00 cash to Avi Katz"', t.some(x => /Paid out \$5\.00 cash to Avi Katz/.test(x)), JSON.stringify(t));
        check('the amount box is cleared', (await page.evaluate(() => document.getElementById('cashAmt').value)) === '');

        // ── 4. a Stripe camp: a waiting refund for a child with $0 to refund ─
        // ── 3b. a top-up 30 days old, and a refund still waiting (TED-130/135)
        step('3b', 'A Sola top-up 30 days old, and a $20 refund of the new one still waiting');
        const credit2 = db.json(`SELECT public.credit_canteen_balance_from_processor(
                p_camp_id => '${CAMP}', p_camper_name => ${lit(CAMPER)}, p_amount => 30,
                p_processor_key => 'cardknox', p_external_transaction_id => 'XREF-OLD') AS r`);
        check('the old Sola top-up was credited', credit2[0] && credit2[0].r && credit2[0].r.success, JSON.stringify(credit2[0] && credit2[0].r));
        const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        db.sql(`UPDATE canteen_transactions SET tx_date = '${old}', payload = payload || jsonb_build_object('date', '${old}')
                 WHERE camp_id = '${CAMP}' AND payload->>'byopTransactionId' = 'XREF-OLD';`);
        // a refund of $20 from the $25 top-up, sent and never answered
        const held = db.json(`SELECT public.reserve_canteen_refund('${CAMP}', ${lit(CAMPER)}, 'canteen:cref_w:XREF-25', 20, 'cardknox', 'XREF-25') AS r`);
        check('the waiting refund took its $20 off the wallet', held[0] && held[0].r && held[0].r.success, JSON.stringify(held[0] && held[0].r));
        // wallet: $60 after the cash-out, + $30 old top-up, − $20 waiting = $70.
        // To a card: $25 − $20 waiting = $5, + the old $30 = $35. (The page alone
        // would say $25: the new top-up, blind to both the old one and the wait.)
        // The edge function's `holds` answer, from the real code over the real rows.
        await page.exposeFunction('__realHolds', (fn) => {
            const view = db.json(`SELECT public.canteen_refund_view('${CAMP}') AS v`)[0].v;
            const r = runEdge(fn, `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${CAMP}', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc.canteen_refund_view = () => (${JSON.stringify(view)});
T.request = { headers: { Authorization: 'Bearer owner' }, body: { action: 'holds' } };`);
            return r.body;
        });
        await open('campistry_snacks.html', () => !!window.CampistrySnacks);
        await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
        await snacksNav('accounts');
        const pageSees = await page.evaluate(() => (window.CampistrySnacks.getSnacksData().transactions || []).some(t => t && t.byopTransactionId === 'XREF-OLD'));
        check('the page itself does not hold the 30-day-old top-up (the week it loads)', !pageSees);
        await page.evaluate(() => {
            window.__fnCalls = [];
            window.CampistryDB.client.functions.invoke = async (fn, o) => {
                window.__fnCalls.push({ fn, body: o && o.body });
                if (o && o.body && o.body.action === 'holds') return { data: await window.__realHolds(fn), error: null };
                return { data: null, error: { message: 'not in this step' } };
            };
        });
        errs = pageErrors.length;
        await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => /^openMFor\('refund'/.test(x.getAttribute('onclick') || ''));
            if (b) b.click();
        });
        await waitFor('the refund box', () => page.evaluate(() => /Available to refund/.test((document.getElementById('refundBox') || {}).textContent || '')), 20000).catch(() => {});
        const box3 = await page.evaluate(() => ({ box: (document.getElementById('refundBox') || {}).textContent || '',
            disabled: document.getElementById('refundBtn').disabled, amt: document.getElementById('refundAmt').value,
            holds: (document.getElementById('refundHolds') || {}).textContent || '' }));
        check('no page error', pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));
        check('TED-130: the Refund window counts the 30-day-old top-up and the wait — $35.00 to the card',
              /via Sola: \$35\.00/.test(box3.box), JSON.stringify(box3.box));
        check('and the Refund button is on, for $35.00', !box3.disabled && box3.amt === '35.00', JSON.stringify(box3));
        check('the waiting $20 refund is listed', /\$20\.00/.test(box3.holds), JSON.stringify(box3.holds.slice(0, 160)));
        await page.evaluate(() => closeM('refund'));
        await page.click('button[onclick="openRefundAllModal()"]');
        await waitFor('the Refund All preview', () => page.evaluate(() => /through Sola|No campers/.test((document.getElementById('refundAllBody') || {}).textContent || '')), 20000).catch(() => {});
        const ra3 = await page.evaluate(() => { const b = document.getElementById('refundAllBtn');
            return { body: (document.getElementById('refundAllBody') || {}).textContent || '', btn: b && getComputedStyle(b).display !== 'none' ? b.textContent : null }; });
        check('TED-130/135: Refund All offers $35.00 — the old top-up counted, the waiting refund taken off',
              ra3.btn === 'Refund All ($35.00)' && /\$35\.00/.test(ra3.body), JSON.stringify(ra3));
        await page.evaluate(() => closeM('refundall'));

        step(4, 'Stripe camp, nobody with Stripe money left, one Stripe refund waiting');
        db.sql(`UPDATE camps SET payment_processor_key = 'stripe' WHERE id = '${CAMP}';`);
        await open('campistry_snacks.html', () => !!window.CampistrySnacks);
        await page.waitForFunction((n) => (window.CampistrySnacks.getCamperList() || []).some(c => c.name === n), CAMPER, { timeout: 30000 });
        await snacksNav('accounts');
        const stripeHold = { key: 'scanteen:pi_1:2000:2000', camperId, account: CAMPER, amount: 20, method: 'stripe', paymentRef: 'pi_1', ageSeconds: 900 };
        await fakeEdge([stripeHold]);
        errs = pageErrors.length;
        await page.click('button[onclick="openRefundAllModal()"]');
        await waitFor('the look-up button', () => page.evaluate(() => { const b = document.getElementById('refundAllBtn'); return b && getComputedStyle(b).display !== 'none'; }), 10000).catch(() => {});
        const st = await page.evaluate(() => {
            const b = document.getElementById('refundAllBtn'), h = document.getElementById('refundAllHolds');
            return { body: (document.getElementById('refundAllBody') || {}).textContent || '',
                     btn: b && getComputedStyle(b).display !== 'none' ? b.textContent : null,
                     holds: h && h.style.display !== 'none' ? h.textContent : '' };
        });
        const proc = await page.evaluate(() => window.__fnCalls.map(c => c.fn));
        check('no page error', pageErrors.length === errs, JSON.stringify(pageErrors.slice(errs)));
        check('it asks the Stripe function for the waiting refunds', proc.includes('stripe-canteen-refund'), JSON.stringify(proc));
        check('it says nobody has Stripe money to refund', /No campers currently have a Stripe-paid balance/.test(st.body), JSON.stringify(st.body));
        check('the waiting Stripe refund is listed', /Avi Katz/.test(st.holds) && /looked up in Stripe/.test(st.holds), JSON.stringify(st.holds.slice(0, 200)));
        check('and there is still a button to look it up', st.btn === 'Look up the waiting refunds in Stripe', JSON.stringify(st.btn));
        await page.evaluate(() => { window.__fnCalls = []; });
        await page.click('#refundAllBtn');
        await waitFor('Refund All sent', () => page.evaluate(() => window.__fnCalls.some(c => c.fn === 'stripe-canteen-refund-all')), 10000).catch(() => {});
        check('pressing it runs Refund All, which looks the refund up in Stripe',
              await page.evaluate(() => window.__fnCalls.some(c => c.fn === 'stripe-canteen-refund-all')));
    } catch (e) {
        check('the run finished', false, e.message);
    } finally {
        await browser.close().catch(() => {});
        await bridge.close().catch(() => {});
        db.stop();
    }

    const failed = checks.filter(c => !c.ok);
    console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed');
    if (pageErrors.length) console.log('page errors seen: ' + JSON.stringify(pageErrors));
    process.exit(failed.length ? 1 : 0);
})();
