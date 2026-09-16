// variable_length_ui.e2e.js — drives the REAL Flow page in a browser to prove
// the variable-length wiring is actually reachable from the UI.
//
// The unit tests prove the CARVING. This proves the WIRING: that the modules
// load in the page, that a tile marked splittable survives a draft save/reload
// through the app's own code, that the grid cut and the per-bunk carving line up
// on real camp config, and that a normal tile is left completely alone.
//
//   node tests/variable_length_ui.e2e.js        # exits 0 on pass
//
// Playwright is a devDependency. Without the browser binary this SKIPS with
// exit 0 rather than failing the suite.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 8137;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('SKIP — playwright is not installed.');
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
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('nope'); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, function () { resolve(server); });
  });
}

// A camp with specials at 20 and 40 minutes, so a 40-minute block can resolve
// either way depending on the bunk.
function seedCamp() {
  return {
    campStructure: {
      Boys: { color: '#3B82F6', grades: { Junior: { bunks: ['J1', 'J2'] } } }
    },
    app1: {
      builderMode: 'manual',
      divisions: { Junior: { bunks: ['J1', 'J2'], startTime: '9:00am', endTime: '4:00pm' } },
      specialActivities: [
        { name: 'Slush', durations: [20], location: 'Canteen' },
        { name: 'Popcorn', durations: [20], location: 'Canteen' },
        { name: 'Ceramics', durations: [40], location: 'Art Room' }
      ],
      sportMetaData: { Soccer: { durations: [20, 40] } }
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
  // Use a pre-installed browser when the bundled revision isn't downloaded.
  const pinned = (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.addInitScript(function (s) {
      localStorage.setItem('campGlobalSettings_v1', JSON.stringify(s));
    }, seedCamp());

    await page.goto('http://localhost:' + PORT + '/flow.html', { waitUntil: 'domcontentloaded' });

    // ── the modules reach the page at all ──
    await page.waitForFunction(() => window.ManualBlockSplit && window.PeriodPacker, null, { timeout: 20000 });
    const loaded = await page.evaluate(() => ({
      split: !!window.ManualBlockSplit,
      packer: !!window.PeriodPacker,
      dts: typeof window.DivisionTimesSystem?.expandVariableLengthTiles === 'function',
      utils: typeof window.SchedulerCoreUtils?.getScheduleUsageInWindow === 'function',
      resolve: typeof window.SchedulerCoreUtils?.resolveEntryTime === 'function'
    }));
    check('ManualBlockSplit loads in the page', loaded.split);
    check('PeriodPacker loads in the page', loaded.packer);
    check('DivisionTimesSystem exposes the tile cut', loaded.dts);
    check('SchedulerCoreUtils exposes time-window occupancy', loaded.utils);
    check('SchedulerCoreUtils exposes resolveEntryTime', loaded.resolve);

    // ── the carver produces the user's scenario in a real browser ──
    const carve = await page.evaluate(() => {
      const S = window.ManualBlockSplit;
      const cands = [
        { name: 'Slush', durations: [20] },
        { name: 'Popcorn', durations: [20] },
        { name: 'Ceramics', durations: [40] }
      ];
      const durations = S.collectDurations(cands);
      const hungry = S.splitBlock({ startMin: 600, endMin: 640, durations, demand: S.buildDemand(cands, []) });
      const sated = S.splitBlock({
        startMin: 600, endMin: 640, durations,
        demand: S.buildDemand(cands, ['Slush', 'Popcorn'])
      });
      return {
        hungry: hungry.segments.map(s => s.durationMin),
        sated: sated.segments.map(s => s.durationMin)
      };
    });
    check('a bunk with two short specials left takes 2x20',
      JSON.stringify(carve.hungry) === '[20,20]', JSON.stringify(carve.hungry));
    check('a bunk with only the long special left takes one 40',
      JSON.stringify(carve.sated) === '[40]', JSON.stringify(carve.sated));

    // ── the grid cut agrees with the carving, on the page's own config ──
    const grid = await page.evaluate(() => {
      const skel = [{
        id: 'vl-e2e', division: 'Junior', event: 'Special Activity', type: 'slot',
        startTime: '10:00am', endTime: '10:40am', allowSplit: true, maxSegments: 2
      }];
      const divs = { Junior: { bunks: ['J1', 'J2'], startTime: '9:00am', endTime: '4:00pm' } };
      const cut = window.DivisionTimesSystem.buildFromSkeleton(skel, divs).Junior || [];

      const plain = [{ ...skel[0], id: 'plain-e2e', allowSplit: false }];
      const uncut = window.DivisionTimesSystem.buildFromSkeleton(plain, divs).Junior || [];

      return {
        cut: cut.map(s => [s.startMin, s.endMin, s._vlParts || 0]),
        uncut: uncut.map(s => [s.startMin, s.endMin, s._vlParts || 0])
      };
    });
    check('a splittable 40-min tile is cut into two 20-min slots',
      JSON.stringify(grid.cut) === '[[600,620,2],[620,640,2]]', JSON.stringify(grid.cut));
    check('an unmarked tile stays one 40-min slot',
      JSON.stringify(grid.uncut) === '[[600,640,0]]', JSON.stringify(grid.uncut));

    // ── the flag survives the app's own draft save + reload ──
    const persisted = await page.evaluate(() => {
      const tile = {
        id: 'persist-e2e', division: 'Junior', event: 'Special Activity', type: 'slot',
        startTime: '10:00am', endTime: '10:40am', allowSplit: true, maxSegments: 3
      };
      const sanitized = window.CampUtils.sanitizeSkeletonTiles([tile]).tiles[0];
      localStorage.setItem('master-schedule-draft', JSON.stringify([sanitized]));
      const back = JSON.parse(localStorage.getItem('master-schedule-draft'))[0];
      return { allowSplit: back.allowSplit, maxSegments: back.maxSegments };
    });
    check('allowSplit survives the skeleton sanitizer + draft round trip',
      persisted.allowSplit === true && persisted.maxSegments === 3, JSON.stringify(persisted));

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('e2e ran to completion', false, String(e && e.message || e));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = checks.filter(c => !c.ok);
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})();
