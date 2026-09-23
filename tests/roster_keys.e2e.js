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
//   5. The roster is re-imported with the spreadsheet's Replace option and no
//      Camper ID column (Ted, TED-013): a returning child keeps her number,
//      her key and her money; a new child gets a new number.
//   4b. (TED-016/017) Dov gets a new Camper ID through the form. The Me page
//      saves the roster and its own document in one statement; both reach
//      the database, another page's record and the family invitation follow
//      him, and a later edit still saves.
//   4c. (TED-020) Renamed and renumbered in one edit: still one child.
//   4e. (TED-025) …and put back on the number he was moved off.
//   4d. (TED-022) A spreadsheet Update with no Camper ID column updates the
//      child filed as "Avi Katz #<n>", rather than adding a third Avi.
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
        'Leah Fox': { name: 'Leah Fox', camperId: 20, division: 'Boys', grade: 'Junior', bunk: 'J1',
                      dob: '2015-05-05', parent1Email: 'fox@keys.test' },
    } });
    // Dov is enrolled (the Me page's own document), has a health record (another
    // page's document), and a family invitation — all on his number.
    kvWrite(db, 'campistryMe', { enrollments: {
        enr_dov: { id: 'enr_dov', camperName: 'Dov Stern', camperId: 3, status: 'enrolled' },
    } });
    kvWrite(db, 'campistryHealth', { sickVisits: [{ camperName: 'Dov Stern', camperId: 3, complaint: 'cough' }] });
    db.sql(`INSERT INTO link_parent_invites (id, camp_id, parent_email, camper_names, person_ids, status)
            VALUES ('53000000-aaaa-0000-0000-000000000001', '${CAMP}', 'stern@keys.test',
                    '["Dov Stern"]', '[3]', 'active');`);
    // Leah has money on her canteen account — it is on her number.
    db.sql(`INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
            VALUES ('${CAMP}', 'Leah Fox', 20, 'Leah Fox', 30.00);`);
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
    const syncErrors = [];
    page.on('console', m => { if (/Failed to sync|cannot affect row a second time/i.test(m.text())) syncErrors.push(m.text()); });
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
        await page.fill('#ceP1Em', 'katz@keys.test');
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

        step('4b', 'Dov is given a new Camper ID through the form (3 → 40) — the Me page saves several documents in one go (TED-016)');
        await openCamperForm('Dov Sterne');
        await page.fill('#ceCamperId', '40');
        await saveCamperForm();
        await waitFor('the renumber to reach the database', () =>
            people(db).some(p => p.person_id === 40 && p.source_key === 'Dov Sterne'), 30000);
        await waitFor('the enrollment to follow', () => {
            const m = kvRead(db, 'campistryMe') || {};
            return m.enrollments && m.enrollments.enr_dov && Number(m.enrollments.enr_dov.camperId) === 40;
        }, 30000);
        check('the roster in the database says #40', Number(kvRead(db, 'app1').camperRoster['Dov Sterne'].camperId) === 40);
        check('his enrollment in the database says #40', true);
        check('another page\'s record (Health) follows him to #40',
            Number(kvRead(db, 'campistryHealth').sickVisits[0].camperId) === 40, JSON.stringify(kvRead(db, 'campistryHealth')));
        const inv = db.json(`SELECT person_ids FROM link_parent_invites WHERE id = '53000000-aaaa-0000-0000-000000000001'`);
        check('his family\'s invitation follows him to #40', JSON.stringify(inv[0].person_ids) === '[40]', JSON.stringify(inv));
        check('number 3 is nobody\'s now', !people(db).some(p => p.person_id === 3), JSON.stringify(people(db)));
        // A later, unrelated edit still reaches the database.
        await openCamperForm('Leah Fox');
        await page.fill('#ceSchool', 'After The Renumber');
        await saveCamperForm();
        await waitFor('a later edit to reach the database', () => {
            const r = (kvRead(db, 'app1') || {}).camperRoster || {};
            return r['Leah Fox'] && r['Leah Fox'].school === 'After The Renumber';
        }, 30000);
        check('a later edit reaches the database', true);
        check('the page reports no failed cloud save', !syncErrors.length, syncErrors.slice(0, 3).join(' | '));

        step('4c', 'Dov is renamed AND renumbered in one edit (Sterne #40 → Stone #41): one child (TED-020)');
        await openCamperForm('Dov Sterne');
        await page.fill('#ceLast', 'Stone');
        await page.fill('#ceCamperId', '41');
        await saveCamperForm();
        await waitFor('the edit to reach the database', () =>
            people(db).some(p => p.person_id === 41 && p.source_key === 'Dov Stone'), 30000);
        const dovs = people(db).filter(p => /^Dov/.test(p.source_key));
        check('still one Dov, live, on #41', dovs.length === 1 && dovs[0].person_id === 41 && !dovs[0].gone, JSON.stringify(dovs));
        await waitFor('his records to follow', () =>
            Number(kvRead(db, 'campistryHealth').sickVisits[0].camperId) === 41, 30000);
        check('his records followed him to #41', true);
        check('the renumber hint is not stored', !('renumberedFrom' in kvRead(db, 'app1').camperRoster['Dov Stone']));

        step('4e', 'the office puts Dov back on the number he was moved off (#41 → #40) (TED-025)');
        await openCamperForm('Dov Stone');
        await page.fill('#ceCamperId', '40');
        await saveCamperForm();
        await waitFor('the change back to reach the database', () =>
            people(db).some(p => p.person_id === 40 && p.source_key === 'Dov Stone'), 30000);
        const dovBack = people(db).filter(p => /^Dov/.test(p.source_key));
        check('Dov is back on #40, one child', dovBack.length === 1 && dovBack[0].person_id === 40 && !dovBack[0].gone,
            JSON.stringify(dovBack));
        await waitFor('his records to come back', () =>
            Number(kvRead(db, 'campistryHealth').sickVisits[0].camperId) === 40, 30000);
        check('his records came back to #40', true);

        step('4d', 'a spreadsheet Update (no Camper ID column) has a row for the new Avi Katz, filed as "' + newAvi.key + '" (TED-022)');
        const csvU = '"First Name","Last Name","Date of Birth","Division","Grade","Bunk","Parent 1 Email"\n'
                   + '"Avi","Katz","2016-02-02","Boys","Junior","J1","katz@keys.test"\n';
        await page.evaluate(() => { window.CampistryMe.nav('campers'); window.CampistryMe.openCsv(); });
        await page.setInputFiles('#csvFI', { name: 'update.csv', mimeType: 'text/csv', buffer: Buffer.from(csvU) });
        await page.waitForSelector('#csvBtn:not([disabled])', { timeout: 10000 });
        await page.click('#csvBtn');
        await page.waitForSelector('#confirmDlgOk', { timeout: 10000 });
        await page.check('input[name="csvImportMode"][value="update"]');
        await page.fill('#csvArchiveLabel', '');
        await page.click('#confirmDlgOk');
        await waitFor('the update to reach the database', () => {
            const r = (kvRead(db, 'app1') || {}).camperRoster || {};
            return Object.keys(r).some(k => /^Avi Katz/.test(k) && r[k].dob === '2016-02-02');
        }, 40000);
        await new Promise(r => setTimeout(r, 1500));
        const r4d = kvRead(db, 'app1').camperRoster;
        const aviKeys = Object.keys(r4d).filter(k => /^Avi Katz/.test(k));
        check('the row updated that Avi, under his own key and number',
            aviKeys.length === 1 && aviKeys[0] === newAvi.key && r4d[newAvi.key].dob === '2016-02-02'
            && Number(r4d[newAvi.key].camperId) === Number(newAvi.rec.camperId), JSON.stringify(aviKeys));
        check('no third Avi Katz was made', people(db).filter(p => /^Avi Katz/.test(p.source_key)).length === 2,
            JSON.stringify(people(db)));

        step(5, 'the office re-imports the roster with the spreadsheet\'s Replace option, with no Camper ID column');
        const csv = '"First Name","Last Name","Date of Birth","Division","Grade","Bunk","Parent 1 Email"\n'
                  + '"Leah","Fox","2015-05-05","Boys","Junior","J1","fox@keys.test"\n'
                  + '"Newt","Ray","2016-01-01","Boys","Junior","J1","ray@keys.test"\n';
        await page.evaluate(() => { window.CampistryMe.nav('campers'); window.CampistryMe.openCsv(); });
        await page.setInputFiles('#csvFI', { name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await page.waitForSelector('#csvBtn:not([disabled])', { timeout: 10000 });
        await page.click('#csvBtn');
        await page.waitForSelector('#confirmDlgOk', { timeout: 10000 });
        await page.fill('#csvArchiveLabel', '');        // no season archive for this test
        await page.click('#confirmDlgOk');
        await waitFor('the re-imported roster to reach the database', () => {
            const r = (kvRead(db, 'app1') || {}).camperRoster || {};
            return !!r['Newt Ray'] && Object.keys(r).some(k => /^Leah Fox/.test(k));
        }, 40000);
        await new Promise(r => setTimeout(r, 1500));
        const r5 = kvRead(db, 'app1').camperRoster;
        const leahKey = Object.keys(r5).find(k => /^Leah Fox/.test(k));
        check('Leah kept her Camper ID and her key', leahKey === 'Leah Fox' && Number(r5[leahKey].camperId) === 20,
            leahKey + ' #' + (r5[leahKey] && r5[leahKey].camperId));
        const p20 = people(db).filter(p => p.person_id === 20);
        check('her identity is live, not departed', p20.length === 1 && !p20[0].gone, JSON.stringify(p20));
        const bal = db.json(`SELECT balance FROM camp_canteen_accounts WHERE camp_id = '${CAMP}' AND person_id = 20`);
        check('her $30 is still on her number', bal.length === 1 && Number(bal[0].balance) === 30, JSON.stringify(bal));
        check('a new child in the file got a new number', Number(r5['Newt Ray'].camperId) > 0
            && ![3, 4, 10, 20, 40, 41].includes(Number(r5['Newt Ray'].camperId)), JSON.stringify(r5['Newt Ray'].camperId));

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
