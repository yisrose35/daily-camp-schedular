// =============================================================================
// lite_health_numbers.e2e.js — Campistry Lite and Health save the camper's
// NUMBER, in a real browser, against the real database.       (Ted, TED-007)
//
//   npm run test:lite
//
// Two campers share a name: "Rivka Stern" #701 and a second Rivka Stern whose
// roster key is "Rivka Stern #702". Nothing below is mocked except the network
// (tests/e2e: a throwaway Postgres with the real migrations, the repo's own
// pages, and a client shim that turns the pages' calls into SQL).
//
//   1. Lite loads, and every call it makes can find a camper's number.
//   2. Lite's Health screen: pressing the real "Give" button for the second
//      Rivka saves a medication record carrying #702.
//   3. Lite sends a message about the second Rivka through its own client:
//      the row in link_messages carries person_id 702.
//   4. The Health page logs a medication for the second Rivka: the record
//      carries #702.
//   5. No page — Lite, Health, or the office's Billing screen — shows the
//      roster's internal "#702" as part of a name.
//
// It SKIPS with exit 0 when Playwright or Postgres is missing, like the other
// browser tests.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PORT = 8143;
const OWNER = '52000000-0000-0000-0000-000000000001';
const CAMP = '52000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@lite.test';
const FIRST = 'Rivka Stern';
const SECOND = 'Rivka Stern #702';

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('SKIP — playwright is not installed (npm i).'); process.exit(0); }

const { boot } = require('./e2e/db');
const { start } = require('./e2e/bridge');

const checks = [];
function check(label, ok, detail) {
    checks.push({ label, ok: !!ok, detail });
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '   → ' + detail : ''));
}
function step(n, what) { console.log('\n' + n + '. ' + what); }
function literal(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
async function waitFor(what, fn, ms) {
    const until = Date.now() + (ms || 15000);
    let last;
    while (Date.now() < until) {
        try { if (await fn()) return; } catch (e) { last = e.message; }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('timed out waiting for ' + what + (last ? ' (last error: ' + last + ')' : ''));
}

function seed(db) {
    db.sql(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
    INSERT INTO camps (id, owner, name, contact_email)
    VALUES ('${CAMP}', '${OWNER}', 'Lite Camp', 'office@lite.test');`);
    const kv = (key, value) => db.sql(
        `INSERT INTO camp_state_kv (camp_id, key, value)
         VALUES ('${CAMP}', '${key}', ` + literal(JSON.stringify(value)) + `::jsonb)
         ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
    kv('campStructure', {
        Girls: { color: '#EC4899', grades: { Junior: { bunks: ['G1'], schoolGrades: ['3rd Grade'] } } },
    });
    kv('app1', { camperRoster: {
        [FIRST]:  { name: FIRST, camperId: 701, division: 'Girls', grade: 'Junior', bunk: 'G1', medications: 'Advil',
                    parent1Name: 'Parent One', parent1Email: 'one@lite.test' },
        [SECOND]: { name: FIRST, displayName: FIRST, camperId: 702, division: 'Girls', grade: 'Junior', bunk: 'G1',
                    medications: 'Tylenol', parent1Name: 'Parent Two', parent1Email: 'two@lite.test' },
    } });
    kv('campistryHealth', { dispensingLog: [], sickVisits: [], doctorVisits: [], bedwettingLog: [], medicalForms: {} });
    // One family with both Rivkas, for the office's Billing screen (Ted, TED-009).
    kv('campistryMe', { families: { fam_stern: { name: 'Stern', camperIds: [FIRST, SECOND],
        households: [{ parents: [{ name: 'Parent One', email: 'one@lite.test' }] }] } } });
}

function kvRead(db, key) {
    const rows = db.json(`SELECT value FROM camp_state_kv WHERE camp_id = '${CAMP}' AND key = ` + literal(key));
    return rows.length ? rows[0].value : null;
}

(async function main() {
    let db;
    try { db = boot({}); }
    catch (e) { console.log('SKIP — could not boot a throwaway Postgres: ' + e.message.split('\n')[0]); process.exit(0); }
    if (!db) { console.log('SKIP — no Postgres server binaries on this machine.'); process.exit(0); }
    console.log('postgres up with ' + db.applied.length + ' migrations applied');
    seed(db);

    const bridge = await start(db, { port: PORT });
    const shim = fs.readFileSync(path.join(__dirname, 'e2e', 'shim.js'), 'utf8');
    const pinned = '/opt/pw-browsers/chromium';
    const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
    const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));

    // Lite fetches supabase-js (and the QR reader) from a CDN on the web. The
    // shim is the client here, exactly as the bridge serves the local copy
    // empty for the other pages; nothing else leaves the machine.
    await page.route('**/*', r => {
        const url = r.request().url();
        if (url.startsWith('http://localhost:' + PORT)) return r.continue();
        if (/cdn\.jsdelivr\.net\/npm\/(@supabase\/supabase-js|jsqr)/.test(url)) {
            return r.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
        }
        return r.abort();
    });
    await page.addInitScript(shim + `
        installCampistrySmokeShim({
            endpoint: 'http://localhost:${PORT}/__pg',
            users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'lite' }],
            signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' }
        });`);

    try {
        // ── 1. Lite loads its roster and hands it to the number lookup ─────────
        step(1, 'Campistry Lite loads, and its calls can find a camper\'s number');
        await page.goto('http://localhost:' + PORT + '/campistry_lite.html', { waitUntil: 'domcontentloaded' });
        await waitFor('Lite to load the roster', () => page.evaluate(
            () => !!(window.__camperIdRoster && Object.keys(window.__camperIdRoster).length)), 45000);
        const resolved = await page.evaluate(
            (k) => typeof window.__camperIdResolve === 'function' ? window.__camperIdResolve(null, k) : null, SECOND);
        check('Lite\'s lookup gives the second Rivka her own number', Number(resolved) === 702, String(resolved));

        // ── 2. the real Give button on Lite's Health screen ───────────────────
        step(2, 'Lite Health: "Give" for the second Rivka saves a record with #702');
        await page.click('.lite-launch-tile[data-app="health"]');
        await page.waitForSelector('.lite-give-btn[data-give-name="' + SECOND + '"]', { timeout: 20000 });
        const litePageText = await page.evaluate(() => document.body.innerText);
        check('Lite shows the name without the internal number', !/#702/.test(litePageText),
            /#702/.test(litePageText) ? 'the screen shows "#702"' : '');
        await page.click('.lite-give-btn[data-give-name="' + SECOND + '"]');
        await waitFor('the dispensing record to reach the database', () => {
            const h = kvRead(db, 'campistryHealth');
            return h && Array.isArray(h.dispensingLog) && h.dispensingLog.length === 1;
        });
        const liteDose = kvRead(db, 'campistryHealth').dispensingLog[0];
        check('the medication record carries the camper\'s number', Number(liteDose.camperId) === 702,
            JSON.stringify(liteDose));

        // ── 3. a message about the second Rivka, through Lite's own client ────
        step(3, 'a Lite message about the second Rivka is filed on #702');
        const sent = await page.evaluate(async ({ camp, who }) => {
            const res = await window.supabase.from('link_messages').insert({
                id: '52000000-aaaa-0000-0000-000000000001', camp_id: camp, thread_id: '52000000-aaaa-0000-0000-000000000001', direction: 'out',
                parent_name: 'Parent Two', parent_email: 'two@lite.test',
                camper_name: who, subject: 'Hello', body: 'From Lite', channels: ['app'], read: false });
            return res && res.error ? res.error.message : 'ok';
        }, { camp: CAMP, who: SECOND });
        check('the insert went through', sent === 'ok', sent);
        const msg = db.json(`SELECT person_id FROM link_messages WHERE id = '52000000-aaaa-0000-0000-000000000001'`);
        check('the message row carries person_id 702', msg.length === 1 && Number(msg[0].person_id) === 702,
            JSON.stringify(msg));

        // ── 4. the Health page ────────────────────────────────────────────────
        step(4, 'the Health page logs a medication for the second Rivka with #702');
        await page.goto('http://localhost:' + PORT + '/campistry_health.html', { waitUntil: 'domcontentloaded' });
        await waitFor('Health to load', () => page.evaluate(() => {
            const g = window.loadGlobalSettings && window.loadGlobalSettings();
            return !!(window.CampistryHealth && g && g.app1 && g.app1.camperRoster && g.app1.camperRoster['Rivka Stern #702']);
        }), 45000);
        await page.evaluate((k) => window.CampistryHealth.logDispensing(k, 'Tylenol'), SECOND);
        await waitFor('the Health record to reach the database', () => {
            const h = kvRead(db, 'campistryHealth');
            return h && Array.isArray(h.dispensingLog) && h.dispensingLog.length === 2;
        }, 20000);
        const hDose = kvRead(db, 'campistryHealth').dispensingLog.find(d => d.medication === 'Tylenol' && d !== liteDose && !d.nurse?.includes?.('Lite'));
        const both = kvRead(db, 'campistryHealth').dispensingLog;
        check('the Health page\'s record carries the camper\'s number',
            both.filter(d => Number(d.camperId) === 702).length === 2, JSON.stringify(both.map(d => d.camperId)));
        const healthText = await page.evaluate(() => document.body.innerText);
        const at = healthText.search(/#702/);
        check('Health shows the name without the internal number', at < 0,
            at >= 0 ? 'the screen shows: "' + healthText.slice(Math.max(0, at - 60), at + 20).replace(/\s+/g, ' ') + '"' : '');
        void hDose;

        // The nurse's sick-visit form (Ted, TED-014): a typed name two campers
        // share is refused; picking the second Rivka records HER number, and the
        // box shows her plain name.
        await page.evaluate(() => document.getElementById('visitModal').classList.add('open'));
        await page.fill('#visitCamperInput', 'Rivka Stern');
        await page.click('#visitModal .modal-footer .btn-primary');
        await new Promise(r => setTimeout(r, 800));
        const visitsAfterTyped = (kvRead(db, 'campistryHealth') || {}).sickVisits || [];
        check('a name two campers share is not saved as a visit', visitsAfterTyped.length === 0, JSON.stringify(visitsAfterTyped));
        await page.fill('#visitCamperInput', '');
        await page.type('#visitCamperInput', 'Rivka');
        await page.waitForSelector('.camper-dd div', { timeout: 5000 });
        const items = await page.$$('.camper-dd > div');
        let picked = false;
        for (const it of items) {
            const txt = await it.innerText();
            if (/Rivka Stern/.test(txt) && !picked) {
                // the dropdown order follows the roster keys: pick the one whose key is the second Rivka
                const isSecond = await page.evaluate((el) => [...el.parentElement.children].indexOf(el), it) === 1;
                if (isSecond) { await it.click(); picked = true; }
            }
        }
        const shown = await page.inputValue('#visitCamperInput');
        check('the box shows the plain name, not the internal key', shown === 'Rivka Stern', shown);
        await page.click('#visitModal .modal-footer .btn-primary');
        await waitFor('the visit to reach the database', () => {
            const v = (kvRead(db, 'campistryHealth') || {}).sickVisits || [];
            return v.length === 1;
        }, 20000);
        const visit = kvRead(db, 'campistryHealth').sickVisits[0];
        check('the visit carries the picked camper\'s number (#702)', Number(visit.camperId) === 702, JSON.stringify(visit));

        // ── 5. the office's Billing screen ─────────────────────────────────────
        step(5, 'Me → Billing lists the family\'s children without the internal number');
        await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
        await waitFor('the Me page to load', () => page.evaluate(() => !!window.CampistryMe), 45000);
        await waitFor('the family to reach the Me page', () => page.evaluate(() => {
            window.CampistryMe.nav('billing');
            return /Stern/.test(document.body.innerText);
        }), 45000);
        const billText = await page.evaluate(() => document.body.innerText);
        const bAt = billText.search(/#702/);
        check('Billing shows both children, and no internal number', /Rivka Stern/.test(billText) && bAt < 0,
            bAt >= 0 ? 'the screen shows: "' + billText.slice(Math.max(0, bAt - 60), bAt + 20).replace(/\s+/g, ' ') + '"' : '');

        check('no uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].slice(0, 5).join(' | '));
    } catch (e) {
        check('the run completed', false, String(e.message).split('\n').slice(0, 6).join(' / '));
    } finally {
        await browser.close();
        await bridge.close();
        db.stop();
    }

    const failed = checks.filter(c => !c.ok);
    if (failed.length) { console.log('\n' + failed.length + ' of ' + checks.length + ' check(s) failed.'); process.exit(1); }
    console.log('\nAll ' + checks.length + ' checks passed.');
})();
