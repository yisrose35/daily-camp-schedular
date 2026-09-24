// Probe (17th pass, hunt — payroll, never audited). The REAL Me page →
// Payroll → Pay Runs → "New Pay Run" in Chromium (smoke harness, real chain),
// with the browser's clock set to two Tuesdays a week apart. The office
// accepts the window's own default dates both times.
//   Ana: hourly $15.   Ben: weekly $300.   Cara: season salary $2,100 over
//   the window's default 7 runs.
//   Tue Jul 7:  week of Jun 28 is complete (40 h each); week of Jul 5 so far
//               Sun–Tue (16 h each).
//   Tue Jul 14: week of Jul 5 complete (40 h); week of Jul 12 so far 16 h.
// What do the two runs pay, against what was worked?
// B: the same with runs two weeks apart (Jul 7, Jul 21).
// Run: node ted/probes/2026-09-24-billing-17/payroll_runs17.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const { boot } = require(path.join(R, 'tests/e2e/db'));
const { start } = require(path.join(R, 'tests/e2e/bridge'));
const PORT = 8432;
const OWNER = '51000000-0000-0000-0000-000000000001';
const CAMP = '51000000-0000-0000-0000-0000000000c1';
const OWNER_EMAIL = 'owner@smoke.test';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let bad = 0;
const log = (s) => console.log(s);
const check = (label, ok, detail) => { if (!ok) bad++; log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = boot({ port: 5732 });
  if (!db) { console.log('NO POSTGRES'); process.exit(2); }
  const q1 = (s) => db.sql(s).trim();
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', '${OWNER_EMAIL}');
          INSERT INTO camps (id, owner, name, contact_email) VALUES ('${CAMP}', '${OWNER}', 'Payroll Camp', 'o@p.test');`);
  const kv = (k, v) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}', '${k}', ${lit(JSON.stringify(v))}::jsonb)
                                ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;`);
  const kvGet = (k) => JSON.parse(q1(`SELECT coalesce(value::text,'null') FROM camp_state_kv WHERE camp_id='${CAMP}' AND key='${k}'`) || 'null');
  kv('campStructure', { Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1'], schoolGrades: ['3rd Grade'] } } } });
  kv('campistryMe', { families: {} });
  const staff = [{ id: 1, name: 'Ana', role: 'Kitchen', payType: 'hourly', payRate: 15 },
                 { id: 2, name: 'Ben', role: 'Maintenance', payType: 'weekly', payRate: 300 },
                 { id: 3, name: 'Cara', role: 'Head counselor', payType: 'salary', payRate: 2100 }];
  const sheet = (id, weekOf, hours) => { const d = { sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 }; let left = hours;
    for (const k of ['mon', 'tue', 'wed', 'thu', 'fri']) { const h = Math.min(8, left); d[k] = h; left -= h; } return { staffId: id, weekOf, days: d, status: 'submitted', supervisorSigned: true }; };
  const sheets = (spec) => { const out = []; for (const [w, h] of spec) for (const s of staff) out.push(sheet(s.id, w, h)); return out; };
  kv('campistryMePayroll', { staff, timesheets: sheets([['2026-06-28', 40], ['2026-07-05', 16]]), youthCorps: {}, payRuns: [], nextStaffId: 4 });

  const bridgeSrv = await start(db, { port: PORT });
  const shim = fs.readFileSync(path.join(R, 'tests/e2e/shim.js'), 'utf8');
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.route('**/*', r => r.request().url().startsWith('http://localhost:' + PORT) ? r.continue() : r.abort());
  await page.addInitScript(shim + `installCampistrySmokeShim({ endpoint: 'http://localhost:${PORT}/__pg',
      users: [{ id: '${OWNER}', email: '${OWNER_EMAIL}', password: 'smoke' }], signedInAs: { id: '${OWNER}', email: '${OWNER_EMAIL}' } });`);
  const run = async (when) => {
    await page.clock.setFixedTime(new Date(when));
    await page.goto(`http://localhost:${PORT}/campistry_me.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryDB && window.CampistryDB.getCampId && window.CampistryDB.getCampId() && window.CampistryMe, null, { timeout: 30000 });
    await wait(2500);
    await page.evaluate(() => window.CampistryMe.nav('payroll')); await wait(1200);
    await page.evaluate(() => window.CampistryMe.prNewRun()); await wait(700);
    const dflt = await page.evaluate(() => ({ from: document.getElementById('runFrom').value, to: document.getElementById('runTo').value, runs: document.getElementById('runPeriods').value }));
    await page.click('#dynModalSave'); await wait(3000);
    return dflt;
  };
  try {
    const d1 = await run('2026-07-07T10:00:00');
    log(`Run 1, Tue Jul 7: the window's defaults From ${d1.from} To ${d1.to}, runs in season ${d1.runs} → pressed Save`);
    const pr1 = kvGet('campistryMePayroll');
    log(`   stored runs: ${(pr1.payRuns || []).length}`);
    // a week later: week of Jul 5 finished (40 h), week of Jul 12 so far 16 h
    pr1.timesheets = sheets([['2026-06-28', 40], ['2026-07-05', 40], ['2026-07-12', 16]]);
    kv('campistryMePayroll', pr1);
    const d2 = await run('2026-07-14T10:00:00');
    log(`Run 2, Tue Jul 14: defaults From ${d2.from} To ${d2.to} → pressed Save`);
    const runs = (kvGet('campistryMePayroll').payRuns || []);
    log(`   stored runs: ${runs.length}`);
    const tot = {};
    runs.forEach((r, i) => { log(`   run ${i + 1} (${r.from} → ${r.to}): camp total $${r.campTotal}; ` + r.lines.map(l => `${l.name} ${l.hours} h / ${l.weeks} wk → $${l.gross}`).join('; '));
      r.lines.forEach(l => { tot[l.name] = tot[l.name] || { hours: 0, gross: 0, weeks: 0 }; tot[l.name].hours += l.hours; tot[l.name].gross += l.gross; tot[l.name].weeks += l.weeks; }); });
    log(`   paid over the two runs: ${Object.entries(tot).map(([n, t]) => `${n} ${t.hours} h, ${t.weeks} weeks, $${t.gross}`).join('; ')}`);
    log(`   worked by Tue Jul 14: Ana 40 + 40 + 16 = 96 h ($1,440); Ben 2 full weeks + 2 days`);
    check('the two default runs pay Ana for the hours she worked (96 h), each hour once', tot.Ana && tot.Ana.hours === 96, `Ana paid for ${tot.Ana && tot.Ana.hours} h ($${tot.Ana && tot.Ana.gross}) — the week of Jul 5 is in both runs`);
    check('the two default runs pay Ben for each week once', tot.Ben && tot.Ben.weeks <= 3, `Ben paid ${tot.Ben && tot.Ben.weeks} weeks ($${tot.Ben && tot.Ben.gross}) over 2 runs a week apart`);
    const overlap = runs.length === 2 && runs[1].from <= runs[0].to;
    check('a run that overlaps an earlier one is flagged (or its dates start after the last run)', !overlap, `run 2 starts ${runs[1] && runs[1].from}, run 1 ended ${runs[0] && runs[0].to}; no warning`);

    log(`\nB. The same camp paying every TWO weeks with the defaults: runs on Tue Jul 7 and Tue Jul 21`);
    kv('campistryMePayroll', { staff, timesheets: sheets([['2026-06-28', 40], ['2026-07-05', 16]]), youthCorps: {}, payRuns: [], nextStaffId: 4 });
    const b1 = await run('2026-07-07T10:00:00');
    const prB = kvGet('campistryMePayroll');
    prB.timesheets = sheets([['2026-06-28', 40], ['2026-07-05', 40], ['2026-07-12', 40], ['2026-07-19', 16]]);
    kv('campistryMePayroll', prB);
    const b2 = await run('2026-07-21T10:00:00');
    const runsB = (kvGet('campistryMePayroll').payRuns || []);
    let anaB = 0;
    runsB.forEach((r, i) => { const a = r.lines.find(l => l.name === 'Ana'); anaB += a.hours; log(`   run ${i + 1} (${r.from} → ${r.to}): Ana ${a.hours} h → $${a.gross}`); });
    log(`   Ana paid for ${anaB} h over the two runs; worked by Tue Jul 21: 40 + 40 + 40 + 16 = 136 h — the Wed–Sat of the week of Jul 5 (24 h) is in neither run's count, and Jul 19's rest will be missed the same way`);
    check('two-weekly runs with the defaults pay every hour worked', anaB === 136, `Ana paid for ${anaB} h of 136 h ($${anaB * 15} of $${136 * 15})`);
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
