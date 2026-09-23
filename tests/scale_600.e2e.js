// =============================================================================
// scale_600.e2e.js — a 600-camper camp, in a browser, against real SQL.
//
//   npm run test:scale
//
// WHAT THIS PROVES. That the camp the product is sold to — 500+ campers, a
// season of canteen sales — is not slower to run than the camps it was built
// on. Two halves:
//
//   DATABASE  the hot reads and writes, timed inside Postgres on a seeded camp:
//             600 campers, 300 families, 600 canteen accounts and 36,000 ledger
//             rows, all written through the real triggers.
//   BROWSER   the Me roster, the Snacks manager and the register, each loaded
//             against that camp: how long until the roster is on screen, how
//             many calls it took, and that no call is made once PER CAMPER — the
//             shape (an RPC inside a roster loop) that is invisible at 20
//             campers and a minute-long page at 600.
//
// The budgets are deliberately loose — this is a sandbox, not production — and
// each one is there because something here once blew straight through it:
// get_canteen_accounts shipped 3.4 MB on every load before its window was cut.
//
// It SKIPS with exit 0 when Playwright or Postgres is missing.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PORT = 8161;
const OWNER = '60000000-0000-0000-0000-000000000001';
const CAMP = '60000000-0000-0000-0000-0000000000c1';
const N = 600;

// ── budgets ─────────────────────────────────────────────────────────────────
const MS = {
    purchase: 50,             // one register sale
    deposit: 50,              // one desk deposit
    canteenRead: 400,         // the Snacks page's whole-camp read
    rosterSave: 250,          // re-saving the 600-camper roster with one change
    billingSave: 400,         // re-saving the billing document with one change
    pageReady: 20000,         // any page, roster on screen
};
const CANTEEN_READ_BYTES = 2.5e6;
const PER_CAMPER_CALLS = 25;  // any one RPC called more than this in one page load is a loop

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('SKIP — playwright is not installed (npm i).'); process.exit(0); }

const { boot } = require('./e2e/db');
const { start } = require('./e2e/bridge');
const { seedCamp, lit } = require('./e2e/scale_seed');

const checks = [];
function check(label, ok, detail) {
    checks.push({ label, ok: !!ok, detail });
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '   → ' + detail : ''));
}

(async function main() {
    let db;
    try { db = boot({ port: 5461 }); }
    catch (e) { console.log('SKIP — could not boot Postgres: ' + e.message.split('\n')[0]); process.exit(0); }
    if (!db) { console.log('SKIP — no Postgres server binaries.'); process.exit(0); }

    let browser, bridge;
    try {
        // ── DATABASE ─────────────────────────────────────────────────────────
        console.log('\nseeding a ' + N + '-camper camp through the real triggers…');
        const seed = seedCamp(db, { camp: CAMP, owner: OWNER, n: N, txDays: 30, salesPerDay: 2 });
        Object.entries(seed.timings).forEach(([k, v]) => console.log('       ' + String(v).padStart(6) + ' ms  ' + k));

        db.sql(`CREATE OR REPLACE FUNCTION public._scale_time(q text, n int, who uuid) RETURNS numeric
                LANGUAGE plpgsql AS $f$
                DECLARE t0 timestamptz; i int; BEGIN
                  PERFORM set_config('request.jwt.claims', json_build_object('sub', who)::text, false);
                  t0 := clock_timestamp();
                  FOR i IN 1..n LOOP EXECUTE q; END LOOP;
                  RETURN round(extract(epoch FROM clock_timestamp() - t0) * 1000 / n, 2);
                END $f$;`);
        const timeIt = (q, n) => Number(db.sql(`SELECT public._scale_time(${lit(q)}, ${n || 5}, ${lit(OWNER)})`).trim());
        const C = lit(CAMP);

        console.log('\n1. the hot paths, on ' + N + ' campers');
        const tSale = timeIt(`SELECT public.submit_canteen_purchase(${C}, 'Avi Adler', 1, 'x', NULL, 1)`, 50);
        check('a register sale', tSale < MS.purchase, tSale + ' ms (budget ' + MS.purchase + ')');
        const tDep = timeIt(`SELECT public.canteen_office_credit(${C}, 'Avi Adler', 1)`, 50);
        check('a desk deposit', tDep < MS.deposit, tDep + ' ms (budget ' + MS.deposit + ')');
        const tRead = timeIt(`SELECT public.get_canteen_accounts(${C})`, 3);
        const bytes = Number(db.sql(`SET "request.jwt.claims" = '{"sub":"${OWNER}"}';
                                     SELECT length(public.get_canteen_accounts(${C})::text);`).trim().split('\n').pop());
        check('the Snacks page\'s whole-camp read', tRead < MS.canteenRead,
            tRead + ' ms (budget ' + MS.canteenRead + ')');
        check('…and its size', bytes < CANTEEN_READ_BYTES,
            (bytes / 1e6).toFixed(2) + ' MB (budget ' + (CANTEEN_READ_BYTES / 1e6) + ' MB)');

        const wall = (q) => { const s = Date.now(); db.sql(q); return Date.now() - s; };
        const base = wall('SELECT 1');
        const tRoster = wall(`UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Avi Adler,bunk}', '"D0G0B1"'),
                              updated_at = now() WHERE camp_id = ${C} AND key = 'app1'`) - base;
        check('re-saving the roster with one camper changed', tRoster < MS.rosterSave,
            tRoster + ' ms (budget ' + MS.rosterSave + ')');
        const tBill = wall(`UPDATE camp_state_kv SET value = jsonb_set(value, '{families,fam3,notes}', '"x"'),
                            updated_at = now() WHERE camp_id = ${C} AND key = 'campistryMe'`) - base;
        check('re-saving billing with one family changed', tBill < MS.billingSave,
            tBill + ' ms (budget ' + MS.billingSave + ')');

        const counts = db.json(`SELECT (SELECT count(*) FROM camp_people WHERE camp_id = ${C} AND deleted_at IS NULL) AS people,
                                       (SELECT count(*) FROM camp_canteen_accounts WHERE camp_id = ${C}) AS accounts,
                                       (SELECT count(*) FROM camp_canteen_accounts WHERE camp_id = ${C} AND person_id IS NULL) AS unattributed`)[0];
        check('every camper became a person', Number(counts.people) === N, JSON.stringify(counts));
        check('every canteen account belongs to a person', Number(counts.unattributed) === 0,
            counts.unattributed + ' unattributed (same-named campers are keyed "<name> #<id>")');

        // ── BROWSER ──────────────────────────────────────────────────────────
        bridge = await start(db, { port: PORT });
        const shim = fs.readFileSync(path.join(__dirname, 'e2e', 'shim.js'), 'utf8');
        const pinned = '/opt/pw-browsers/chromium';
        browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
        await page.route('**/*', r =>
            r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
        await page.addInitScript(shim + `
            installCampistrySmokeShim({
                endpoint: 'http://localhost:${PORT}/__pg',
                users: [{ id: '${OWNER}', email: 'owner@scale.test', password: 'scale' }],
                signedInAs: { id: '${OWNER}', email: 'owner@scale.test' }
            });`);

        async function load(label, file, ready) {
            const before = bridge.calls.length;
            const s = Date.now();
            await page.goto('http://localhost:' + PORT + '/' + file, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(ready, N, { timeout: MS.pageReady + 10000 });
            const ms = Date.now() - s;
            // Let the page settle, so a loop that keeps firing after first paint is counted too.
            await page.waitForTimeout(3000);
            const calls = bridge.calls.slice(before);
            const byFn = {};
            calls.forEach(c => { const k = c.fn || (c.op + ' ' + c.table); byFn[k] = (byFn[k] || 0) + 1; });
            const loops = Object.entries(byFn).filter(([, n]) => n > PER_CAMPER_CALLS);
            check(label + ' — roster on screen', ms < MS.pageReady, ms + ' ms (budget ' + MS.pageReady + ')');
            check(label + ' — no call made once per camper', loops.length === 0,
                calls.length + ' calls' + (loops.length ? '; ' + loops.map(([k, n]) => k + '×' + n).join(', ') : ''));
        }

        console.log('\n2. the pages, on ' + N + ' campers');
        await load('Me', 'campistry_me.html', (n) => {
            const el = document.getElementById('page-campers');
            if (window.CampistryMe && el && !el.innerText.trim()) { try { window.CampistryMe.nav('campers'); } catch (_) {} }
            const m = el && /(\d+)\s+campers?/.exec(el.innerText);
            return !!m && Number(m[1]) >= n;
        });
        // Billing: 300 families. Rendering is synchronous, so time the call itself.
        const billMs = await page.evaluate(() => {
            const s = performance.now();
            window.CampistryMe.nav('billing');
            return Math.round(performance.now() - s);
        });
        const billText = await page.evaluate(() => (document.getElementById('page-billing') || {}).innerText || '');
        check('Me billing — 300 families rendered', billMs < 3000 && billText.length > 200,
            billMs + ' ms to render (budget 3000)');

        await load('Snacks', 'campistry_snacks.html',
            (n) => !!window.CampistrySnacks && (window.CampistrySnacks.getCamperList() || []).length >= n);

        // A desk deposit at scale: the refresh after it must be ONE camper's
        // rows, not the camp's — 1.7 MB a click before it was narrowed.
        {
            const before = bridge.calls.length;
            await page.click('#hamburgerBtn');
            await page.click('.sidebar-item[data-page="accounts"]');
            await page.waitForSelector('#page-accounts.active', { timeout: 10000 });
            await page.click('button[onclick="openM(\'dep\')"]');
            await page.waitForSelector('#m-dep', { state: 'visible', timeout: 10000 });
            await page.selectOption('#depCamper', 'Avi Adler');
            await page.fill('#depAmt', '5');
            const s = Date.now();
            await page.click('button[onclick="addDep()"]');
            await page.waitForSelector('#m-dep', { state: 'hidden', timeout: 15000 });
            await page.waitForFunction(() => true);
            await page.waitForTimeout(1500);
            const ms = Date.now() - s;
            const calls = bridge.calls.slice(before).map(c => c.fn).filter(Boolean);
            check('a desk deposit at 600 campers', calls.includes('canteen_office_credit') && ms < 5000,
                ms + ' ms, calls: ' + calls.join(', '));
            check('…refreshes one camper, not the whole camp', !calls.includes('get_canteen_accounts')
                && calls.includes('get_canteen_history'), calls.join(', '));
        }
        await load('Register', 'campistry_snacks_pos.html',
            (n) => document.querySelectorAll('.camper-item').length >= Math.min(n, 50));
        await load('Health', 'campistry_health.html',
            (n) => !!window.CampistryHealth && Object.keys(window.CampistryHealth.getRoster() || {}).length >= n);
        await load('Go', 'campistry_go.html',
            () => !!window.CampistryGo && document.readyState === 'complete');

        console.log('\n3. nothing broke on the way');
        check('no call fell through unimplemented', bridge.unsupported().length === 0,
            bridge.unsupported().map(c => c.op + ' ' + (c.table || c.fn)).slice(0, 5).join(' | '));
        check('no call came back with a database error', bridge.failed().length === 0,
            [...new Set(bridge.failed().map(c => (c.fn || c.table) + ': ' + c.error))].slice(0, 5).join(' | '));
        check('no uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].slice(0, 5).join(' | '));
    } catch (e) {
        check('the run completed', false, String(e.message).split('\n').slice(0, 6).join(' / '));
    } finally {
        if (browser) await browser.close();
        if (bridge) await bridge.close();
        db.stop();
    }
    const failed = checks.filter(c => !c.ok);
    console.log('\n' + (failed.length ? failed.length + ' of ' + checks.length + ' checks FAILED' : 'All ' + checks.length + ' checks passed.'));
    process.exit(failed.length ? 1 : 0);
})();
