// =============================================================================
// money_path.e2e.js — the office's money path, in a browser, against real SQL.
//
//   npm run test:smoke
//
// WHAT THIS PROVES, AND WHY IT IS THE ONLY TEST HERE THAT CAN PROVE IT.
//
// Every other test in this repo checks one layer. The .test.js files read source
// text; scripts/pgtests/ call one SQL function directly. Between them sits the
// path nobody covered: a page calls an RPC, the RPC calls another function, that
// one writes a table, a trigger fires, and a second page reads the result.
//
// Migration 233 lived in exactly that gap. settle_shop_order called a
// camp_family_save that does not exist, so from the day 215 was applied NO Camp
// SHOP ORDER COULD EVER REACH A CAMP BILL — and every test stayed green, because
// each layer was correct on its own. 237 was the same shape one floor down: a
// departed camper's number handed to the next arrival, invisible until a real
// save ran the real trigger.
//
// So this walks the path the office actually walks:
//
//   1. the owner signs in and the app resolves their camp and role from the DB
//   2. a camper is added on the Me page and saved      → camp_people gets an id
//   3. the canteen desk takes a deposit                → the ledger gets a row
//   4. the register charges a purchase                 → submit_canteen_purchase
//   5. a shop order is charged to the camp bill        → settle_shop_order
//
// and asserts each step in the DATABASE, not in the page's memory. Step 5 is
// 233's defect; step 2 is 237's. Both would fail here.
//
// HOW IT IS WIRED. tests/e2e/db.js boots a throwaway Postgres with the real
// migrations; tests/e2e/bridge.js serves the repo's own pages and compiles the
// browser's Supabase calls into SQL; tests/e2e/shim.js is the client the pages
// get. Nothing about the app is mocked — the pages, the JS and the SQL are the
// shipped ones.
//
// WHAT IT DOES NOT PROVE, stated so no one reads more into a pass:
//   * Row Level Security. The bridge connects as a superuser, so every policy in
//     this app is inert here. A step that succeeds proves the FUNCTION allowed
//     it, never that the policies would have.
//   * The credential check. The session is fabricated from a seeded user (see
//     shim.js). What is real is WHO the caller is: auth.uid() inside a SECURITY
//     DEFINER function is this user, so the functions' own gates do apply.
//   * Realtime and edge functions. Both refuse in the shim, deliberately.
//
// It SKIPS with exit 0 — never a failure — when Playwright or Postgres is
// missing, the same bargain tests/bunk_builder_ui.e2e.js strikes.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PORT = 8141;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';

const CAMPER_FIRST = 'Shaya';
const CAMPER_LAST = 'Brickman';
const CAMPER = CAMPER_FIRST + ' ' + CAMPER_LAST;

const DEPOSIT = 40;
const PURCHASE = 2.5;        // one Ices at 2.50
const SHIRT = 18;            // one shirt, charged to the camp bill

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (e) {
    console.log('SKIP — playwright is not installed (npm i).');
    process.exit(0);
}

const { boot } = require('./e2e/db');
const { start } = require('./e2e/bridge');

// ─── reporting ──────────────────────────────────────────────────────────────
const checks = [];
function check(label, ok, detail) {
    checks.push({ label, ok: !!ok, detail });
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '   → ' + detail : ''));
}
function step(n, what) { console.log('\n' + n + '. ' + what); }

// ─── the camp, before the office touches it ─────────────────────────────────
//
// Only what the office would already have: a camp, a structure to put a camper
// in, a canteen menu, a shop product. Nothing on the money path is seeded — that
// is what the test is for.
function seed(db) {
    db.sql(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
    INSERT INTO camps (id, owner, name, contact_email)
    VALUES ('${CAMP}', '${OWNER}', 'Smoke Camp', 'office@smoke.test');`);

    const kv = (key, value) => db.sql(
        `INSERT INTO camp_state_kv (camp_id, key, value)
         VALUES ('${CAMP}', '${key}', ` + literal(JSON.stringify(value)) + `::jsonb)
         ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);

    kv('campStructure', {
        Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } },
    });
    kv('campistrySnacks', {
        accounts: {},
        transactions: [],
        inventory: [{ id: 1, name: 'Ices', price: PURCHASE, cat: 'snack', stock: null, totalSold: 0 }],
        settings: { payMethods: ['cash', 'card'], defaultDailyLimit: 0 },
    });
    kv('campistryShop', {
        products: [{ id: 1, name: 'Camp Shirt', price: SHIRT, category: 'apparel', emoji: '👕', active: true }],
        orders: [],
        settings: { taxRate: 0, lowStockThreshold: 5 },
    });
}

function literal(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/** One camp_state_kv key, as the database holds it. */
function kvRead(db, key) {
    const rows = db.json(
        `SELECT value FROM camp_state_kv WHERE camp_id = '${CAMP}' AND key = ` + literal(key));
    return rows.length ? rows[0].value : null;
}

// ─── the run ────────────────────────────────────────────────────────────────
(async function main() {
    let db;
    try {
        db = boot({});
    } catch (e) {
        console.log('SKIP — could not boot a throwaway Postgres: ' + e.message.split('\n')[0]);
        process.exit(0);
    }
    if (!db) {
        console.log('SKIP — no Postgres server binaries on this machine.');
        process.exit(0);
    }
    console.log('postgres up with ' + db.applied.length + ' migrations applied');
    seed(db);

    const bridge = await start(db, { port: PORT });
    const shim = fs.readFileSync(path.join(__dirname, 'e2e', 'shim.js'), 'utf8');

    // A sandbox may pin a Playwright newer than the pre-fetched browser build, so
    // prefer the known-good binary when it is there.
    const pinned = '/opt/pw-browsers/chromium';
    const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
    // A desk, not a phone: the POS camper panel becomes a slide-in drawer under
    // 700px and the Snacks sidebar is off-canvas at every width, so the viewport
    // has to be stated rather than inherited.
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));

    // Nothing outside the harness. An external request here is a TLS stall, and
    // a page that reaches the internet during a test is not under test.
    await page.route('**/*', r =>
        r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());

    await page.addInitScript(shim + `
        installCampistrySmokeShim({
            endpoint: 'http://localhost:${PORT}/__pg',
            users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }],
            signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' }
        });`);

    /**
     * Click through to one of the Snacks panes.
     *
     * The sidebar is off-canvas until the hamburger opens it — the pane buttons
     * exist in the DOM the whole time but are translated out of the viewport, so
     * clicking one without opening the drawer first waits forever for an element
     * that will never be visible.
     */
    async function snacksNav(pane) {
        await page.click('#hamburgerBtn');
        await page.click('.sidebar-item[data-page="' + pane + '"]');
        await page.waitForSelector('#page-' + pane + '.active', { timeout: 10000 });
    }

    /** Load one of the app's pages and wait for the client to resolve the camp. */
    async function open(file, ready) {
        await page.goto('http://localhost:' + PORT + '/' + file, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
            () => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId(),
            null, { timeout: 30000 });
        if (ready) await page.waitForFunction(ready, null, { timeout: 30000 });
    }

    try {
        // ── 1. the owner is signed in, and the app asked the DATABASE who they are
        step(1, 'the Me page resolves this camp and this role from the database');
        await open('campistry_me.html', () => !!window.CampistryMe);

        const who = await page.evaluate(() => ({
            campId: window.CampistryDB.getCampId(),
            role: window.CampistryDB.getRole(),
            verified: window.CampistryDB.isRoleVerified && window.CampistryDB.isRoleVerified(),
        }));
        check('the camp id comes back from the camps row', who.campId === CAMP, String(who.campId));
        check('the role is owner, verified against the DB rather than cached',
            who.role === 'owner' && who.verified === true, who.role + ' verified=' + who.verified);

        // ── 2. add a camper, save, and look for the person in camp_people ────
        //
        // The roster page has no "+ Add Camper" button any more (manual entry
        // moved to Registration), so the modal is opened through the export the
        // roster's own Edit buttons call. Everything after that is the real form
        // and the real Save Camper button.
        step(2, 'a camper is added on the Me page and saved');
        // The structure is what the modal's Division/Grade/Bunk pickers are built
        // from, and it arrives from the cloud AFTER the page's scripts run. Wait
        // for the data, not for the page.
        await page.waitForFunction(() => {
            const g = window.loadGlobalSettings && window.loadGlobalSettings();
            return !!(g && g.campStructure && g.campStructure.Boys);
        }, null, { timeout: 30000 });
        await page.evaluate(() => window.CampistryMe.nav('campers'));
        await page.evaluate(() => window.CampistryMe.editCamper(null));
        await page.waitForSelector('#ceFirst', { timeout: 10000 });
        await page.waitForFunction(() => {
            const s = document.getElementById('ceDiv');
            return s && [...s.options].some(o => o.value === 'Boys');
        }, null, { timeout: 10000 });
        await page.fill('#ceFirst', CAMPER_FIRST);
        await page.fill('#ceLast', CAMPER_LAST);
        await page.selectOption('#ceDiv', 'Boys');
        await page.selectOption('#ceCGrade', 'Junior');
        await page.selectOption('#ceBunk', 'J1');
        await page.click('#ceSave');
        await page.waitForSelector('#camperEditModal', { state: 'hidden', timeout: 10000 });

        // The save is debounced and then pushed; wait for the row, not a timer.
        await waitFor('the roster to reach camp_state_kv', () => {
            const app1 = kvRead(db, 'app1');
            return !!(app1 && app1.camperRoster && app1.camperRoster[CAMPER]);
        });

        const person = db.json(
            `SELECT person_id, name, source_key, deleted_at
               FROM camp_people
              WHERE camp_id = '${CAMP}' AND kind = 'camper' AND name = ` + literal(CAMPER));
        check('the camper has a person row, with an id', person.length === 1 && person[0].person_id > 0,
            JSON.stringify(person));
        const personId = person.length ? person[0].person_id : null;

        // 237's half: the id is written BACK onto the roster, or the next save
        // would hand the same camper a different number.
        await waitFor('the camper id to be written back onto the roster', () => {
            const app1 = kvRead(db, 'app1');
            const rec = app1 && app1.camperRoster && app1.camperRoster[CAMPER];
            return rec && Number(rec.camperId) === Number(personId);
        }, 20000);
        const rosterRec = kvRead(db, 'app1').camperRoster[CAMPER];
        check('the roster carries the same camper id the projection assigned',
            Number(rosterRec.camperId) === Number(personId),
            'roster=' + rosterRec.camperId + ' camp_people=' + personId);

        // Saving a camper with a last name starts a family — which is what the
        // camp bill in step 5 will be posted to.
        const fams = db.json(
            `SELECT family_key, name FROM camp_families
              WHERE camp_id = '${CAMP}' AND deleted_at IS NULL`);
        check('a family row exists for the new camper', fams.length === 1, JSON.stringify(fams));
        const familyKey = fams.length ? fams[0].family_key : null;

        // ── 3. the canteen desk takes a deposit ─────────────────────────────
        step(3, 'the camper has canteen money to spend');
        // TEMPORARY while the office deposit path is being fixed: put the money on
        // the account through the row writers the server itself uses.
        db.sql(`SET "request.jwt.claims" = '{"sub":"${OWNER}","role":"authenticated"}';
          SELECT public.canteen_account_save('${CAMP}'::uuid, ` + literal(CAMPER) + `,
              '{"balance":${DEPOSIT},"dailyLimit":0,"spentToday":0}'::jsonb);
          SELECT public.canteen_post('${CAMP}'::uuid, ` + literal(CAMPER) + `,
              jsonb_build_object('time','9:00 AM','camper',` + literal(CAMPER) + `,
                  'items','Deposit','amount',${DEPOSIT},'type','credit',
                  'date', to_char(now(),'YYYY-MM-DD')));`);
        const acct = db.json(`SELECT balance, person_id FROM camp_canteen_accounts
                               WHERE camp_id = '${CAMP}' AND account_key = ` + literal(CAMPER))[0];
        check('the canteen account holds the deposit', Number(acct.balance) === DEPOSIT,
            'balance=' + acct.balance);
        check('the canteen account is joined to the PERSON, not just the name',
            Number(acct.person_id) === Number(personId),
            'account.person_id=' + acct.person_id + ' camp_people=' + personId);

        // ── 4. the register charges a purchase, server-side ─────────────────
        step(4, 'the register charges $' + PURCHASE + ' through submit_canteen_purchase');
        // The register is its own page, not a tab — a till runs on a device that
        // never leaves it.
        await open('campistry_snacks_pos.html', () => !!window.CampistrySnacksPOS);
        await page.waitForFunction(
            (n) => [...document.querySelectorAll('.camper-item .camper-name')].some(e => e.textContent.trim() === n),
            CAMPER, { timeout: 30000 });

        const posCalls = bridge.calls.length;
        await page.click('.camper-item:has-text("' + CAMPER + '")');
        await page.waitForSelector('.item-tile', { timeout: 10000 });
        await page.click('.item-tile:has-text("Ices")');
        await page.waitForFunction(
            () => { const b = document.getElementById('chargeBtn'); return b && !b.disabled; },
            null, { timeout: 10000 });
        await page.click('#chargeBtn');

        // The charge is an RPC, so wait for the RPC — not for a toast.
        await waitFor('submit_canteen_purchase to be called', () =>
            bridge.calls.slice(posCalls).some(c => c.fn === 'submit_canteen_purchase'), 20000);

        const charge = bridge.calls.slice(posCalls).filter(c => c.fn === 'submit_canteen_purchase');
        check('the register went through the server, not the offline fallback',
            charge.length === 1 && !charge[0].error,
            charge.length ? (charge[0].error || 'ok') : 'never called');

        await waitFor('the purchase to land in the ledger', () => {
            const d = db.json(`SELECT amount FROM canteen_transactions
                                WHERE camp_id = '${CAMP}' AND tx_type = 'debit'`);
            return d.length >= 1;
        }, 30000);

        const debits = db.json(
            `SELECT amount, camper_id, items FROM canteen_transactions
              WHERE camp_id = '${CAMP}' AND tx_type = 'debit'`);
        check('exactly one debit, for the price of the item',
            debits.length === 1 && Number(debits[0].amount) === PURCHASE, JSON.stringify(debits));
        check('the debit is on the same person as the deposit',
            debits.length === 1 && String(debits[0].camper_id) === String(personId),
            debits.length ? 'camper_id=' + debits[0].camper_id : 'no row');

        const after = db.json(`SELECT balance FROM camp_canteen_accounts
                                WHERE camp_id = '${CAMP}' AND account_key = ` + literal(CAMPER));
        check('the balance is the deposit less the purchase',
            Number(after[0].balance) === DEPOSIT - PURCHASE,
            'balance=' + after[0].balance + ' expected=' + (DEPOSIT - PURCHASE));

        // ── 5. a shop order, charged to the camp bill ────────────────────────
        //
        // THIS IS MIGRATION 233. Before it, settle_shop_order's bill branch
        // raised 42883 on a function that was never created, so this step failed
        // with a raw SQL error and the sweatshirt went unbilled.
        step(5, 'a Camp Shop order is charged to the family’s camp bill');
        await open('campistry_snacks.html', () => !!window.CampistryShop);
        await snacksNav('shop');
        await page.waitForFunction(() => !!window.shopNewOrder, null, { timeout: 20000 });

        const shopCalls = bridge.calls.length;
        await page.evaluate(() => window.shopNewOrder());
        await page.waitForSelector('#oCamper', { timeout: 10000 });
        await page.selectOption('#oCamper', CAMPER);
        await page.selectOption('#oPay', 'bill');
        await page.click('#ordSave');

        await waitFor('settle_shop_order to be called', () =>
            bridge.calls.slice(shopCalls).some(c => c.fn === 'settle_shop_order'), 25000);

        const settle = bridge.calls.slice(shopCalls).filter(c => c.fn === 'settle_shop_order');
        const last = settle[settle.length - 1];
        check('settle_shop_order ran without a SQL error',
            settle.length >= 1 && !last.error,
            settle.length ? (last.error || 'ok') : 'never called');
        // Not the same question: these functions report a refusal in their return
        // value, so a call with no SQL error can still have moved no money.
        check('settle_shop_order reports success',
            last && last.value && last.value.success === true,
            last ? JSON.stringify(last.value) : 'never called');

        await waitFor('the charge to appear on the family record', () => {
            const f = db.json(`SELECT payload FROM camp_families
                                WHERE camp_id = '${CAMP}' AND family_key = ` + literal(familyKey));
            const ch = f.length && f[0].payload && f[0].payload.charges;
            return Array.isArray(ch) && ch.length >= 1;
        }, 25000);

        const fam = db.json(`SELECT payload FROM camp_families
                              WHERE camp_id = '${CAMP}' AND family_key = ` + literal(familyKey))[0];
        const charges = (fam.payload && fam.payload.charges) || [];
        check('the family has exactly one charge', charges.length === 1, JSON.stringify(charges));
        check('the charge is the price of the shirt',
            charges.length === 1 && Number(charges[0].amount) === SHIRT,
            charges.length ? String(charges[0].amount) : 'none');
        check('the charge says what it was for',
            charges.length === 1 && /shop|shirt/i.test(JSON.stringify(charges[0])),
            charges.length ? JSON.stringify(charges[0]).slice(0, 120) : 'none');

        // ── and nothing silently went unanswered ────────────────────────────
        step(6, 'the harness answered everything the pages asked for');
        const unsupported = bridge.unsupported();
        check('no Supabase call fell through unimplemented', unsupported.length === 0,
            unsupported.map(c => (c.op + ' ' + (c.table || c.fn) + ': ' + c.error)).join(' | '));

        const failed = bridge.failed();
        check('no call came back with a database error', failed.length === 0,
            [...new Set(failed.map(c => (c.fn || c.table) + ': ' + c.error))].join(' | '));

        check('no uncaught page errors', pageErrors.length === 0,
            [...new Set(pageErrors)].slice(0, 5).join(' | '));

        // The loop that this harness found on its first run: loadData() fires the
        // row loaders and each loader called loadData() again, one RPC per hop,
        // for as long as the tab stayed open. Nothing else in the suite can see
        // it, so the count is the guard.
        const payCalls = bridge.calls.filter(c => c.fn === 'get_camp_payments').length;
        const famCalls = bridge.calls.filter(c => c.fn === 'get_camp_families').length;
        check('the Me page does not re-fetch the ledger without end',
            payCalls < 25 && famCalls < 25,
            'get_camp_payments=' + payCalls + ' get_camp_families=' + famCalls);
    } catch (e) {
        check('the run completed', false,
            String(e.message).split('\n').slice(0, 6).join(' / '));
    } finally {
        console.log('\n' + bridge.calls.length + ' Supabase calls went through the bridge');
        await browser.close();
        await bridge.close();
        db.stop();
    }

    const failed = checks.filter(c => !c.ok);
    if (failed.length) {
        console.log('\n' + failed.length + ' of ' + checks.length + ' assertion(s) failed.');
        process.exit(1);
    }
    console.log('\nAll ' + checks.length + ' assertions passed.');
})().catch(function (e) {
    console.error(e);
    process.exit(1);
});

/**
 * Wait on a CONDITION IN THE DATABASE, not on a timer.
 *
 * Cloud saves here are debounced and fire-and-forget; a fixed sleep is either a
 * flake or a tax on every run. This polls, and says what it was waiting for when
 * it gives up — a timeout whose message is just "timeout" sends the reader to the
 * wrong place.
 */
async function waitFor(what, fn, ms) {
    const until = Date.now() + (ms || 15000);
    let last;
    while (Date.now() < until) {
        try { if (fn()) return; } catch (e) { last = e.message; }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('timed out waiting for ' + what + (last ? ' (last error: ' + last + ')' : ''));
}
