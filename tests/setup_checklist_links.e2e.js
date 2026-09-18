// setup_checklist_links.e2e.js — drives the REAL dashboard.html,
// campistry_me.html, team_access_setup.html and campistry_team_access.html
// in a browser to prove the Setup Checklist's "camp" phase items actually
// land where they claim to, not just that the target file exists:
//   camp.profile -> dashboard.html#setup-profile
//   camp.dates   -> dashboard.html#setup-dates
//   camp.sessions-> dashboard.html#setup-dates   (same tab, different card)
//   camp.team    -> team_access_setup.html       (own page, not a hash link)
//   camp.access  -> campistry_team_access.html   (own page, not a hash link)
// Also covers the same hash-routing mechanism for four more checklist items
// that reuse it (people.families/roster/staff/payroll, daily.reports all
// route through campistry_me.html's sidebar the same way camp.structure does).
//
// dashboard.html and campistry_team_access.html both require a real Supabase
// session before they render anything, and there is no real backend here —
// window.supabase (and, for campistry_team_access.html, CampistryDB.getClient/
// getCampId, which it prefers) is replaced with a minimal fake before the
// page's own scripts run. Any table/RPC not explicitly stubbed returns empty
// data rather than throwing, so this only needs to model the exact calls
// each page's own auth/role check actually makes.
//
//   node tests/setup_checklist_links.e2e.js
//
// Skips with exit 0 if playwright isn't installed, same convention as
// tests/bunk_builder_ui.e2e.js.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 8124;

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
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const clean = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, clean === '/' ? '/dashboard.html' : clean);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

const checks = [];
function check(label, cond, detail) {
  checks.push({ label, ok: !!cond, detail });
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (detail ? '   → ' + detail : ''));
}

const OWNER_USER = { id: 'test-owner-1', email: 'owner@test.camp' };
const SCHEDULER_USER = { id: 'test-sched-1', email: 'sched@test.camp' };

const OWNER_RESPONSES = {
  camp_users: { data: null, error: null }, // not a team member, no pending invite
  camps: { data: [{ id: 'test-camp-1', name: 'Test Camp', address: '', contact_email: '', owner: 'test-owner-1' }], error: null }
};

const SCHEDULER_RESPONSES = {
  camp_users: { data: { id: 'mem-1', role: 'scheduler', camp_id: 'test-camp-1', user_id: 'test-sched-1', accepted_at: '2026-01-01' }, error: null },
  camps: { data: [{ id: 'test-camp-1', name: 'Test Camp', address: '', contact_email: '', owner: 'someone-else' }], error: null }
};

async function loadDashboard(page, responses, user, rpcResponses, localStorageKeys) {
  await page.addInitScript(({ responses, user, rpcResponses, localStorageKeys }) => {
    window.__FAKE_SUPABASE__ = { responses, user, rpcResponses: rpcResponses || {}, localStorageKeys: localStorageKeys || {} };
    try { Object.keys(localStorageKeys || {}).forEach((k) => localStorage.setItem(k, localStorageKeys[k])); } catch (e) {}
  }, { responses, user, rpcResponses, localStorageKeys });
  await page.addInitScript(() => {
    // Installed before any of the page's own scripts run. supabase-js's own
    // createClient() call still happens (it's a real script tag) but nothing
    // in dashboard.js touches it until checkAuth() runs on DOMContentLoaded,
    // by which point this has already overwritten window.supabase.
    document.addEventListener('DOMContentLoaded', () => {
      const cfg = window.__FAKE_SUPABASE__;
      const fake = (function () {
        const respMap = cfg.responses, sessionUser = cfg.user, rpcMap = cfg.rpcResponses;
        function builder(table) {
          const raw = respMap[table];
          const b = {};
          ['select', 'eq', 'not', 'is', 'order', 'limit', 'in', 'gte', 'lte', 'neq', 'update', 'insert', 'upsert']
            .forEach((m) => { b[m] = () => b; });
          b.maybeSingle = async () => {
            const d = raw && raw.data;
            return { data: Array.isArray(d) ? (d[0] || null) : (d || null), error: (raw && raw.error) || null };
          };
          b.single = b.maybeSingle;
          b.then = (resolve) => {
            const d = raw ? raw.data : [];
            resolve({ data: Array.isArray(d) ? d : (d ? [d] : []), error: (raw && raw.error) || null });
          };
          return b;
        }
        return {
          auth: {
            getSession: async () => ({ data: { session: sessionUser ? { user: sessionUser } : null } }),
            refreshSession: async () => ({ data: null, error: { message: 'no session in test' } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({ error: null })
          },
          from: builder,
          rpc: async (fn) => rpcMap[fn] || { data: null, error: null },
          channel: () => ({ on() { return this; }, subscribe() { return this; } }),
          removeChannel: () => {}
        };
      })();
      window.supabase = fake;
      // campistry_team_access.html's client() prefers CampistryDB.getClient()
      // over window.supabase directly — patch both so neither path reaches
      // the real (network-blocked) Supabase project.
      if (window.CampistryDB) {
        window.CampistryDB.getClient = () => fake;
        if (cfg.localStorageKeys && cfg.localStorageKeys.campistry_camp_id) {
          window.CampistryDB.getCampId = () => cfg.localStorageKeys.campistry_camp_id;
        }
      }
    }, { once: true });
  });
}

(async function main() {
  const server = await serve();
  // Some sandboxes pin a Playwright version newer than the browser build
  // that's pre-fetched at this fixed path, so the default launch() (which
  // wants chromium_headless_shell) can't find a binary there. Prefer the
  // known-good one when present; a normal dev machine with its own
  // `npx playwright install chromium` has no such directory and just uses
  // the default resolution.
  const pinned = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});

  try {
    // ── PART 1: campistry_me.js — hash routing into the sidebar ──────────
    {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.addInitScript((s) => {
        // Also fires on the intervening about:blank navigations used below to
        // force a real reload — those have no storage-capable origin at all.
        try { localStorage.setItem('campGlobalSettings_v1', JSON.stringify(s)); } catch (e) {}
      }, { campStructure: {} });

      for (const [hash, expectPage] of [['billing', 'billing'], ['hiring', 'hiring'], ['payroll', 'payroll'], ['structure', 'structure'], ['reports', 'reports']]) {
        // Same-document navigations (URL differs only by fragment) do not
        // reload or re-run scripts, so init()'s one-time hash read would
        // never fire again for the 2nd+ hash in this loop without forcing a
        // real cross-document navigation first.
        await page.goto('about:blank');
        await page.goto(`http://localhost:${PORT}/campistry_me.html#${hash}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.CampistryMe && typeof window.CampistryMe.nav === 'function', null, { timeout: 20000 });
        const active = await page.evaluate(() => { const el = document.querySelector('.me-page.active'); return el ? el.id : null; });
        check(`campistry_me.html#${hash} lands on page-${expectPage}`, active === 'page-' + expectPage, 'active=' + active);
        const sidebarActive = await page.evaluate((p) => {
          const el = document.querySelector('.sidebar-item.active');
          return el ? el.dataset.page : null;
        }, expectPage);
        check(`  sidebar highlights "${expectPage}"`, sidebarActive === expectPage, 'sidebar active=' + sidebarActive);
      }

      // A garbage/attacker-controlled hash must not throw and must fall back
      // to the normal default (campers), not silently do nothing odd.
      await page.goto('about:blank');
      await page.goto(`http://localhost:${PORT}/campistry_me.html#'; alert(1); //`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.CampistryMe && typeof window.CampistryMe.nav === 'function', null, { timeout: 20000 });
      const activeAfterGarbage = await page.evaluate(() => { const el = document.querySelector('.me-page.active'); return el ? el.id : null; });
      check('a garbage hash falls back to page-campers, no crash', activeAfterGarbage === 'page-campers', 'active=' + activeAfterGarbage);
      check('no uncaught page errors (Me)', errors.length === 0, errors.join(' | '));
      await page.close();
    }

    // ── PART 2: dashboard.html — hash routing into a Camp Setup tab ──────
    {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await loadDashboard(page, OWNER_RESPONSES, OWNER_USER);

      for (const [hash, tab] of [['setup-profile', 'profile'], ['setup-dates', 'dates'], ['setup-payment', 'payment'], ['setup-settings', 'settings']]) {
        await page.goto('about:blank');
        await page.goto(`http://localhost:${PORT}/dashboard.html#${hash}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.switchSetupTab === 'function', null, { timeout: 20000 });
        await page.waitForFunction(
          (t) => { const b = document.querySelector('.dash-setup-tab.active'); return b && b.dataset.tab === t; },
          tab, { timeout: 20000 }
        ).catch(() => {});
        const activeTab = await page.evaluate(() => { const b = document.querySelector('.dash-setup-tab.active'); return b ? b.dataset.tab : null; });
        check(`dashboard.html#${hash} (owner) activates the "${tab}" tab`, activeTab === tab, 'active tab=' + activeTab);
      }

      await page.goto('about:blank');
      await page.goto(`http://localhost:${PORT}/dashboard.html#setup-nonsense`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.switchSetupTab === 'function', null, { timeout: 20000 });
      const fallbackTab = await page.evaluate(() => { const b = document.querySelector('.dash-setup-tab.active'); return b ? b.dataset.tab : null; });
      check('an unknown hash falls back to "profile", no crash', fallbackTab === 'profile', 'active tab=' + fallbackTab);
      check('no uncaught page errors (Dashboard, owner)', errors.length === 0, errors.join(' | '));
      await page.close();
    }

    // ── PART 3: a team member's hash must NOT bypass their own role gate ──
    {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await loadDashboard(page, SCHEDULER_RESPONSES, SCHEDULER_USER);

      await page.goto(`http://localhost:${PORT}/dashboard.html#setup-payment`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.switchSetupTab === 'function', null, { timeout: 20000 });
      await page.waitForTimeout(300); // let role gating + the hash check both settle
      const paymentBtnHidden = await page.evaluate(() => {
        const b = document.querySelector('.dash-setup-tab[data-tab="payment"]');
        return b ? getComputedStyle(b).display === 'none' : null;
      });
      const activeTab = await page.evaluate(() => { const b = document.querySelector('.dash-setup-tab.active'); return b ? b.dataset.tab : null; });
      check('scheduler’s Payment tab button is hidden', paymentBtnHidden === true, 'hidden=' + paymentBtnHidden);
      check('scheduler following #setup-payment still lands on Profile, not Payment',
        activeTab === 'profile', 'active tab=' + activeTab);
      check('no uncaught page errors (Dashboard, scheduler)', errors.length === 0, errors.join(' | '));
      await page.close();
    }

    // ── PART 4: the two non-hash "camp" items — own pages, not tabs ──────
    {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await loadDashboard(page, OWNER_RESPONSES, OWNER_USER, {}, {});
      await page.goto(`http://localhost:${PORT}/team_access_setup.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const el = document.getElementById('main-app-container');
        return el && getComputedStyle(el).display !== 'none';
      }, null, { timeout: 20000 }).catch(() => {});
      const teamBooted = await page.evaluate(() => {
        const main = document.getElementById('main-app-container');
        const loading = document.getElementById('auth-loading-screen');
        return { mainVisible: !!main && getComputedStyle(main).display !== 'none', loadingVisible: !!loading && getComputedStyle(loading).display !== 'none' };
      });
      check('team_access_setup.html boots past the auth gate', teamBooted.mainVisible && !teamBooted.loadingVisible, JSON.stringify(teamBooted));
      check('no uncaught page errors (team_access_setup.html)', errors.length === 0, errors.join(' | '));
      await page.close();
    }
    {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await loadDashboard(page, {}, OWNER_USER,
        {
          get_my_access: { data: { success: true, role: 'owner', entitlements: {} }, error: null },
          get_camp_role_access: { data: { success: true, roles: {} }, error: null }
        },
        { campistry_camp_id: 'test-camp-1' });
      await page.goto(`http://localhost:${PORT}/campistry_team_access.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.gate') || document.querySelectorAll('table, .role-row, [data-role]').length > 0,
        null, { timeout: 20000 }).catch(() => {});
      const gated = await page.evaluate(() => {
        const g = document.querySelector('.gate');
        return g ? g.textContent.trim() : null;
      });
      check('campistry_team_access.html reaches the real matrix, not a gate screen', gated === null, 'gate text=' + gated);
      check('no uncaught page errors (campistry_team_access.html)', errors.length === 0, errors.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})();
