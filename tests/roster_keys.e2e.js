// =============================================================================
// roster_keys.e2e.js — a roster key belongs to one child, and a rename keeps
// the camper's number: the Me page and the database together.   (259)
//
//   npm run test:keys
//
// Nothing is mocked but the network (tests/e2e: a throwaway Postgres with the
// real migrations, the repo's own pages, and a client shim that turns the
// pages' calls into SQL).
//
//   1. Avi Katz #10 is on the roster, then leaves — his records are kept.
//   2. The office adds a new "Avi Katz" through the real Add Camper form. He
//      gets his own number and his own key ("Avi Katz #<n>"), never #10's,
//      and the page shows him as plain "Avi Katz".
//   3. The Me page ends up holding him under that key (it adopts the key the
//      server filed him under, or chose it itself), so its next save does not
//      make a third camper.
//   4. Dov Stern is renamed through the real form. He keeps his number, and
//      nothing of his is left on a departed identity.
//
// It SKIPS with exit 0 when Playwright or Postgres is missing, like the other
// browser tests.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PORT = 8144;
const OWNER = '53000000-0000-0000-0000-000000000001';
const CAMP = '53000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@keys.test';

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
    const until = Date.now() + (ms || 20000);
    let last;
    while (Date.now() < until) {
        try { if (await fn()) return; } catch (e) { last = e.message; }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('timed out waiting for ' + what + (last ? ' (last error: ' + last + ')' : ''));
}

function kvWrite(db, key, value) {
    db.sql(`INSERT INTO camp_state_kv (camp_id, key, value)
            VALUES ('${CAMP}', '${key}', ` + literal(JSON.stringify(value)) + `::jsonb)
            ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
}
function kvRead(db, key) {
    const rows = db.json(`SELECT value FROM camp_state_kv WHERE camp_id = '${CAMP}' AND key = ` + literal(key));
    return rows.length ? rows[0].value : null;
}
function people(db) {
    return db.json(`SELECT person_id, source_key, deleted_at IS NOT NULL AS gone FROM camp_people
                     WHERE camp_id = '${CAMP}' AND kind = 'camper' ORDER BY person_id`);
}

function seed(db) {
    db.sql(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
    INSERT INTO camps (id, owner, name, contact_email)
    VALUES ('${CAMP}', '${OWNER}', 'Keys Camp', 'office@keys.test');`);
    kvWrite(db, 'campStructure', {
        Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } },
    });
    // 1. Avi Katz #10 and Dov Stern #3 are campers; then Avi leaves.
    kvWrite(db, 'app1', { camperRoster: {
        'Avi Katz': { name: 'Avi Katz', camperId: 10, division: 'Boys', grade: 'Junior', bunk: 'J1' },
        'Dov Stern': { name: 'Dov Stern', camperId: 3, division: 'Boys', grade: 'Junior', bunk: 'J1' },
    } });
    kvWrite(db, 'app1', { camperRoster: {
        'Dov Stern': { name: 'Dov Stern', camperId: 3, division: 'Boys', grade: 'Junior', bunk: 'J1' },
    } });
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
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
    await page.route('**/*', r =>
        r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
    await page.addInitScript(shim + `
        installCampistrySmokeShim({
            endpoint: 'http://localhost:${PORT}/__pg',
            users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'keys' }],
            signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' }
        });`);

    async function openCamperForm(key) {
        await page.evaluate(() => window.CampistryMe.nav('campers'));
        await page.evaluate((k) => window.CampistryMe.editCamper(k), key);
        await page.waitForSelector('#ceFirst', { timeout: 10000 });
        await page.waitForFunction(() => {
            const s = document.getElementById('ceDiv');
            return s && [...s.options].some(o => o.value === 'Boys');
        }, null, { timeout: 10000 });
    }
    async function saveCamperForm() {
        await page.click('#ceSave');
        await page.waitForSelector('#camperEditModal', { state: 'hidden', timeout: 10000 });
    }

    try {
        step(1, 'Avi Katz #10 has left; his key is still his');
        const before = people(db);
        check('#10 is departed and still holds "Avi Katz"',
            before.some(p => p.person_id === 10 && p.gone && p.source_key === 'Avi Katz'), JSON.stringify(before));

        await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId()
            && window.CampistryMe, null, { timeout: 30000 });
        await page.waitForFunction(() => {
            const g = window.loadGlobalSettings && window.loadGlobalSettings();
            return !!(g && g.campStructure && g.campStructure.Boys && g.app1 && g.app1.camperRoster && g.app1.camperRoster['Dov Stern']);
        }, null, { timeout: 30000 });

        step(2, 'the office adds a new "Avi Katz" through the Add Camper form');
        await openCamperForm(null);
        await page.fill('#ceFirst', 'Avi');
        await page.fill('#ceLast', 'Katz');
        await page.selectOption('#ceDiv', 'Boys');
        await page.selectOption('#ceCGrade', 'Junior');
        await page.selectOption('#ceBunk', 'J1');
        await saveCamperForm();

        let newAvi = null;
        await waitFor('the new Avi to reach the database under his own key', () => {
            const r = (kvRead(db, 'app1') || {}).camperRoster || {};
            const k = Object.keys(r).find(x => /^Avi Katz #\d+$/.test(x));
            if (!k) return false;
            newAvi = { key: k, rec: r[k] };
            return true;
        }, 30000);
        const roster = kvRead(db, 'app1').camperRoster;
        check('the new Avi is not filed under the departed Avi\'s key', !('Avi Katz' in roster), Object.keys(roster).join(', '));
        check('he has his own number, not #10', newAvi && Number(newAvi.rec.camperId) > 0 && Number(newAvi.rec.camperId) !== 10,
            newAvi && JSON.stringify(newAvi.rec.camperId));
        check('his key is made from his own number', newAvi && newAvi.key === 'Avi Katz #' + newAvi.rec.camperId, newAvi && newAvi.key);
        check('he is shown as "Avi Katz"', newAvi && newAvi.rec.displayName === 'Avi Katz', newAvi && newAvi.rec.displayName);

        step(3, 'the Me page holds him under that key, and saving again makes no third camper');
        await waitFor('the page to hold the new Avi under his own key', () => page.evaluate((k) => {
            const g = window.loadGlobalSettings && window.loadGlobalSettings();
            const r = (g && g.app1 && g.app1.camperRoster) || {};
            return !!r[k] && !r['Avi Katz'];
        }, newAvi.key), 40000);
        check('the page holds "' + newAvi.key + '"', true);
        const listText = await page.evaluate(() => { window.CampistryMe.nav('campers'); return document.body.innerText; });
        check('the roster screen shows "Avi Katz" and not the internal number',
            /Avi Katz/.test(listText) && !/Avi Katz #\d/.test(listText),
            /Avi Katz #\d/.test(listText) ? 'the screen shows "' + (listText.match(/Avi Katz #\d+/) || [''])[0] + '"' : '');

        await openCamperForm(newAvi.key);
        await page.fill('#ceSchool', 'Yeshiva Test');
        await saveCamperForm();
        await waitFor('the edit to reach the database', () => {
            const r = (kvRead(db, 'app1') || {}).camperRoster || {};
            return r[newAvi.key] && r[newAvi.key].school === 'Yeshiva Test';
        }, 30000);
        const avis = people(db).filter(p => /^Avi Katz/.test(p.source_key));
        check('saving him again did not make another camper', avis.length === 2 && avis.filter(p => !p.gone).length === 1,
            JSON.stringify(avis));

        step(4, 'Dov Stern is renamed through the form and keeps his number');
        await openCamperForm('Dov Stern');
        await page.fill('#ceLast', 'Sterne');
        await saveCamperForm();
        await waitFor('the rename to reach the database', () => {
            const r = (kvRead(db, 'app1') || {}).camperRoster || {};
            return !!r['Dov Sterne'];
        }, 30000);
        const dov = kvRead(db, 'app1').camperRoster['Dov Sterne'];
        check('the renamed camper still has number 3', Number(dov.camperId) === 3, JSON.stringify(dov.camperId));
        const p3 = people(db).filter(p => p.person_id === 3);
        check('his identity moved with him and is not departed',
            p3.length === 1 && p3[0].source_key === 'Dov Sterne' && !p3[0].gone, JSON.stringify(p3));
        check('no new number was issued for him', !people(db).some(p => p.source_key === 'Dov Sterne' && p.person_id !== 3),
            JSON.stringify(people(db)));

        const v = db.json(`SELECT public.verify_roster_keys() AS v`)[0].v;
        check('no key is shown by the wrong child', JSON.stringify(v.keys_shown_by_the_wrong_child) === '[]', JSON.stringify(v));
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
