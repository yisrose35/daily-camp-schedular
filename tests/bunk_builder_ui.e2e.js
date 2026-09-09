// bunk_builder_ui.e2e.js — drives the REAL Bunk Builder page in a browser.
//
// bunk_generator.test.js proves the ALGORITHM. This proves the WIRING: that the
// ⚡ Auto-Generate button reaches it, that bunkCapacity set in Camp Structure is
// actually read, that the result is SAVED (asserted through the app's own
// loadGlobalSettings(), not through in-memory state), and that the completion
// report renders what the office needs to see.
//
//   npm run test:e2e                           # exits 0 on pass
//
// Playwright is a devDependency (test tooling only — the app itself still has no
// build step and no runtime deps). A fresh clone needs the browser binary too:
//   npm i && npx playwright install chromium
// Without it this file SKIPS with exit 0 rather than failing the suite.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('SKIP — playwright is not installed.');
  console.log('      npm i && npx playwright install chromium');
  process.exit(0);
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

function serve() {
  return new Promise(function (resolve) {
    const server = http.createServer(function (req, res) {
      const clean = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, clean === '/' ? '/campistry_me.html' : clean);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, function () { resolve(server); });
  });
}

// 42 campers: J1/J2/J3 take 3rd+4th grade, K1/K2 take 7th+8th. J3 is capped at 6.
function seedCamp() {
  const roster = {};
  const schools = ['Darchei Torah', 'Torah Vodaas', 'Chaim Berlin'];
  const cities = ['Lakewood', 'Brooklyn'];
  for (let i = 1; i <= 28; i++) {
    roster['Junior ' + i] = {
      bunk: '', division: 'Boys', grade: 'Junior', schoolGrade: i % 2 ? '3rd Grade' : '4th Grade',
      school: schools[i % 3], city: cities[i % 2], dob: '2015-06-01', unenrolled: false
    };
  }
  for (let i = 1; i <= 14; i++) {
    roster['Senior ' + i] = {
      bunk: '', division: 'Boys', grade: 'Senior', schoolGrade: i % 2 ? '7th Grade' : '8th Grade',
      school: schools[i % 3], city: cities[i % 2], dob: '2011-06-01', unenrolled: false
    };
  }
  // one mutual friend request and one separation, so the report has content
  roster['Junior 1'].bunkmateRequest = 'Junior 2';
  roster['Junior 2'].bunkmateRequest = 'Junior 1';
  roster['Junior 3'].separateFrom = 'Junior 4';
  roster['Junior 5'].bunkmateRequest = 'Yankel Nobody';

  return {
    campStructure: {
      Boys: {
        color: '#3B82F6',
        grades: {
          Junior: { bunks: ['J1', 'J2', 'J3'], schoolGrades: ['3rd Grade', '4th Grade'] },
          Senior: { bunks: ['K1', 'K2'], schoolGrades: ['7th Grade', '8th Grade'] }
        }
      }
    },
    app1: { camperRoster: roster },
    campistryMe: {
      bunkCapacity: { J3: 6 },
      bunkGenConfig: {
        minBunkSize: 6, maxBunkSize: 12,
        requestsEnabled: true, maxRequests: 3, honoredRequests: 2,
        doNotBunkEnabled: true, maxDoNotBunk: 3,
        criteria: [
          { key: 'school', label: 'School', enabled: true },
          { key: 'area', label: 'Area / City', enabled: true },
          { key: 'age', label: 'Age', enabled: true }
        ],
        schoolGrades: ['3rd Grade', '4th Grade', '7th Grade', '8th Grade']
      }
    }
  };
}

const checks = [];
function check(label, cond, detail) {
  checks.push({ label, ok: !!cond, detail });
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (detail ? '   → ' + detail : ''));
}

(async function main() {
  const server = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    const seed = seedCamp();
    await page.addInitScript(function (s) {
      localStorage.setItem('campGlobalSettings_v1', JSON.stringify(s));
    }, seed);

    await page.goto('http://localhost:' + PORT + '/campistry_me.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.CampistryMe && typeof window.CampistryMe.autoGenerateBunks === 'function',
      null, { timeout: 20000 });

    // Land on the Bunk Builder and confirm the pool starts full.
    await page.evaluate(() => window.CampistryMe.nav('bunkbuilder'));
    await page.waitForSelector('.bb-pool-hd h3', { timeout: 10000 });
    const poolBefore = await page.textContent('.bb-pool-hd h3');
    check('pool starts with everyone unassigned', /\(42\)/.test(poolBefore), poolBefore.trim());

    // Capacity set in Camp Structure must show on the board tile.
    const capBefore = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.bb-bunk')];
      const j3 = tiles.find((t) => t.querySelector('.bb-bunk-nm').textContent === 'J3');
      return j3 ? j3.querySelector('.bb-bunk-ct').textContent.trim() : null;
    });
    check('J3 tile shows its capacity before the run', capBefore === '0 / 6', String(capBefore));

    // ⚡ Auto-Generate — the real button, not the function.
    await page.click('button:has-text("Auto-Generate")');
    await page.waitForSelector('#dynModal', { state: 'visible', timeout: 20000 });
    const reportText = (await page.textContent('#dynModal')).replace(/\s+/g, ' ');

    check('report says 42 placed', /Campers placed\s*42/.test(reportText), reportText.slice(0, 200));
    check('report shows the friend-request tally', /Friend requests honored/.test(reportText));
    check('report names the request it could not match',
      /Yankel Nobody/.test(reportText), 'unmatched-request section');

    await page.evaluate(() => window.CampistryMe.closeModal('dynModal'));

    // Assert against what was SAVED, through the app's own loader — NOT by
    // reading campGlobalSettings_v1 directly. save() runs the state through
    // CampistrySections.preserveOnSave(), which for a session with no signed-in
    // user scrubs app1.camperRoster out of the raw localStorage copy entirely.
    // loadGlobalSettings() is the IDB-backed cache the app itself reads back.
    const saved = await page.evaluate(() => {
      const g = window.loadGlobalSettings();
      const r = (g.app1 && g.app1.camperRoster) || {};
      const sizes = {};
      Object.keys(r).forEach((n) => { if (r[n].bunk) sizes[r[n].bunk] = (sizes[r[n].bunk] || 0) + 1; });
      return {
        sizes,
        unplaced: Object.keys(r).filter((n) => !r[n].bunk),
        j3cap: (g.campistryMe && g.campistryMe.bunkCapacity && g.campistryMe.bunkCapacity.J3) || null,
        pair: r['Junior 1'].bunk === r['Junior 2'].bunk,
        split: r['Junior 3'].bunk !== r['Junior 4'].bunk,
        wrongGrade: Object.keys(r).filter((n) => {
          if (!r[n].bunk) return false;
          const junior = ['J1', 'J2', 'J3'].indexOf(r[n].bunk) >= 0;
          return junior !== (n.indexOf('Junior') === 0);
        }),
        staleGrade: Object.keys(r).filter((n) => r[n].bunk && !r[n].grade)
      };
    });

    console.log('  bunk sizes          : ' + JSON.stringify(saved.sizes));
    check('every camper is saved into a bunk', saved.unplaced.length === 0, saved.unplaced.join(', '));
    check('J3 never exceeds its capacity of 6', (saved.sizes.J3 || 0) <= 6, 'J3=' + saved.sizes.J3);
    check('bunkCapacity survived the save', saved.j3cap === 6, String(saved.j3cap));
    check('the mutual friend request was honored', saved.pair);
    check('the separation was respected', saved.split);
    check('nobody crossed into the other grade group', saved.wrongGrade.length === 0, saved.wrongGrade.join(', '));
    check('grade was written back on every placed camper', saved.staleGrade.length === 0, saved.staleGrade.join(', '));

    const sizes = Object.values(saved.sizes);
    check('no bunk is under the minimum of 6', sizes.every((v) => v >= 6), JSON.stringify(saved.sizes));

    // The board reflects the saved state, and J3 reads as full.
    await page.evaluate(() => window.CampistryMe.nav('bunkbuilder'));
    const poolAfter = await page.textContent('.bb-pool-hd h3');
    check('pool is empty afterwards', /\(0\)/.test(poolAfter), poolAfter.trim());
    const capAfter = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.bb-bunk')];
      const j3 = tiles.find((t) => t.querySelector('.bb-bunk-nm').textContent === 'J3');
      const ct = j3.querySelector('.bb-bunk-ct');
      return { text: ct.textContent.trim(), color: ct.getAttribute('style') || '' };
    });
    console.log('  capacity shown on J3: ' + capAfter.text);
    check('J3 tile reads N / 6', /^\d+ \/ 6$/.test(capAfter.text), capAfter.text);
    check('J3 is flagged as full', /--err/.test(capAfter.color), capAfter.color);

    check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log('\n' + failed.length + ' UI assertion(s) failed.');
    process.exit(1);
  }
  console.log('\nAll UI assertions passed.');
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
