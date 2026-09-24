// Probe (17th pass, TED-161 re-check + edges). Link's Auto-Reload card — its
// markup and its own functions lifted from campistry_link_parent.html — in
// Chromium, the RPC wired to the REAL set_canteen_auto_reload (231 + 282) on a
// scratch Postgres, called AS the parent. Events are real clicks/typing, so
// the card's own 'change' listener (_arAutoSave, 500 ms debounce) runs.
//   L1 Avi (set up, card on file, on) → parent Turns off → "Switch it back on"
//      shown? press it → on?
//   L2 Avi off again; the parent types a new amount (Tab away) → stays off,
//      amount kept?
//   L3 Bina, never set up: the parent ticks "Reload when balance drops
//      below" → switched on (Almost there — add a card)?
//   L4 Avi on: change the amount → stays on
//   L5 Chaim, never set up: ticks the trigger, then 0.2 s later clicks the
//      amount's up-arrow (the debounce keeps only the last change)
//   L6 Dov, never set up, slow phone network (each save answer takes 1.5 s):
//      ticks the trigger, then 0.8 s later changes the amount (the first save
//      is on its way, not yet answered)
// Run: node ted/probes/2026-09-24-billing-17/link17.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const db = require(R + '/tests/e2e/db.js').boot({ port: 5720 });
const q1 = (s) => db.sql(s).trim();
const CAMP = '0ed17300-0000-0000-0000-0000000000c9', OWNER = '0ed17300-0000-0000-0000-0000000000c8', PARENT = '0ed17300-0000-0000-0000-0000000000c7';
const KIDS = { 'Avi Katz': 7, 'Bina Katz': 8, 'Chaim Katz': 9, 'Dov Katz': 10 };
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s).replace(/'/g, "''");

(async () => {
  let browser;
  try {
    db.sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'o@ted17c'), ('${PARENT}', 'p@ted17c');
      INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'Link Camp');
      `);
    for (const [n, id] of Object.entries(KIDS)) db.sql(`INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', ${id}, 'camper', '${n}', '${n}');
      SELECT public.canteen_account_save('${CAMP}', '${n}', '{"balance": 0, "camperId": ${id}}'::jsonb);`);
    db.sql(`INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
        VALUES ('${CAMP}', '${PARENT}', 'Katz parent', 'p@ted17c', '${JSON.stringify(Object.keys(KIDS))}'::jsonb, 'active');`);
    // Avi: set up with a card, on
    db.sql(`SELECT public.update_canteen_autoreload_state(p_camp_id => '${CAMP}', p_camper_name => 'Avi Katz', p_camper_id => 7, p_autoreload => '${esc(JSON.stringify({
      enabled: true, cardOnFile: true, stripeCustomerId: 'cus_avi', paymentMethodLabel: 'Visa ···· 4242', thresholdEnabled: true, thresholdAmount: 5,
      thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1, consecutiveFailures: 0 }))}'::jsonb)`);
    const arNow = (n) => JSON.parse(q1(`SELECT coalesce(payload->'autoReload','{}'::jsonb)::text FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key='${n}'`));

    const L = fs.readFileSync(R + '/campistry_link_parent.html', 'utf8');
    const cut = (name) => { const at = L.indexOf('function ' + name + '('); if (at < 0) throw new Error(name + ' missing'); let i = L.indexOf('{', at), d = 0;
      for (; i < L.length; i++) { if (L[i] === '{') d++; else if (L[i] === '}' && --d === 0) break; } return L.slice(at, i + 1); };
    const cardAt = L.indexOf('<div class="lk-card lk-collapsible collapsed" id="autoReloadCard">');
    let depth = 0, j = cardAt;
    for (; j < L.length; j++) { if (L.startsWith('<div', j)) depth++; else if (L.startsWith('</div>', j)) { depth--; if (depth === 0) { j += 6; break; } } }
    const card = L.slice(cardAt, j).replace('lk-collapsible collapsed', 'lk-collapsible');
    const js = ['_escHtml', '_arToggleOption', '_arRenderDayOptions', '_arRenderSessionPicker', '_renderAutoReload', 'saveAutoReload', 'turnOffAutoReload', '_saveAutoReloadConfig', '_arAutoSave'].map(cut).join('\n');
    const pinned = '/opt/pw-browsers/chromium';
    browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
    const page = await browser.newPage();
    const calls = [];
    await page.exposeFunction('__setAR', (argsJson) => {
      const a = JSON.parse(argsJson); calls.push({ child: a.p_camper_name, enabled: a.p_config.enabled, thresholdEnabled: a.p_config.thresholdEnabled, thresholdReloadAmount: a.p_config.thresholdReloadAmount });
      return q1(`SELECT set_config('test.uid', '${PARENT}', false); SELECT public.set_canteen_auto_reload('${CAMP}', '${esc(a.p_camper_name)}', '${esc(JSON.stringify(a.p_config))}'::jsonb)::text`).split('\n').pop();
    });
    await page.setContent(`<html><head><style>.ar-option-body{display:block}</style></head><body>${card}<script>
      window._campSessionsByCamp = {}; window.__slow = 0;
      var TOASTS = []; function toast(m){ TOASTS.push(String(m)); }
      function _flashSavedHint(){ TOASTS.push('(saved hint)'); }
      function startCanteenAutoReloadSetup(){ TOASTS.push('(card page opened)'); }
      var CHILD = null;
      function _activeCanteenChild(){ return CHILD; }
      window._parentDB = { rpc: function(){ return Promise.reject(new Error('should use _pRpc')); } };
      window._pRpc = function(name, args){ var ms = window.__slow; return window.__setAR(JSON.stringify(args)).then(function(t){ return new Promise(function(res){ setTimeout(function(){ res({ data: JSON.parse(t), error: null }); }, ms); }); }); };
      var _arSaveTimer = null;
      ${js}
      document.getElementById('autoReloadCard').addEventListener('change', _arAutoSave);
    </script></body></html>`);
    const open = async (n) => page.evaluate(({ n, ar }) => { CHILD = { name: n, campId: '${CAMP}', autoReload: ar }; _renderAutoReload(CHILD); }, { n, ar: arNow(n) });
    const view = () => page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return e && e.style.display !== 'none' ? e.textContent.trim() : null; };
      return { status: document.getElementById('arStatusMsg').textContent.replace(/\s+/g, ' ').trim(),
        buttons: ['arCardBtn', 'arOffBtn', 'arOnBtn'].map(vis).filter(Boolean), ticked: document.getElementById('arThEnabled').checked, toasts: TOASTS.splice(0) };
    });

    console.log('L1. Avi is on (card on file). The parent presses "Turn off"');
    await open('Avi Katz');
    await page.click('#arOffBtn'); await wait(800);
    let v = await view();
    console.log(`    stored enabled ${arNow('Avi Katz').enabled}; Link "${v.status}"; buttons ${JSON.stringify(v.buttons)}; box ticked ${v.ticked}; toasts ${JSON.stringify(v.toasts)}; calls ${JSON.stringify(calls)}`);
    check(v.buttons.includes('Switch it back on'), 'L1 in the plain Off state there is a way back on', JSON.stringify(v.buttons));
    await page.click('#arOnBtn'); await wait(800);
    v = await view();
    console.log(`    pressed "Switch it back on" → stored enabled ${arNow('Avi Katz').enabled}; Link "${v.status}"`);
    check(arNow('Avi Katz').enabled === true && /Auto-reload is on/.test(v.status), 'L1b it is on again', v.status);

    console.log('\nL2. Off again; the parent types $35 in "Reload amount" and tabs away');
    await page.click('#arOffBtn'); await wait(800);
    let n0 = calls.length;
    await page.fill('#arThReload', '35'); await page.press('#arThReload', 'Tab'); await wait(1200);
    v = await view();
    console.log(`    sent ${JSON.stringify(calls.slice(n0))}; stored enabled ${arNow('Avi Katz').enabled}, amount ${arNow('Avi Katz').thresholdReloadAmount}; Link "${v.status}"; ${JSON.stringify(v.toasts)}`);
    check(arNow('Avi Katz').enabled === false && Number(arNow('Avi Katz').thresholdReloadAmount) === 35, 'L2 the amount is saved and auto-reload stays off', `enabled ${arNow('Avi Katz').enabled}`);

    console.log('\nL3. Bina, never set up: the parent ticks "Reload when balance drops below a threshold"');
    await open('Bina Katz');
    n0 = calls.length;
    await page.check('#arThEnabled'); await wait(1200);
    v = await view();
    console.log(`    sent ${JSON.stringify(calls.slice(n0))}; stored enabled ${arNow('Bina Katz').enabled}; Link "${v.status}"; buttons ${JSON.stringify(v.buttons)}`);
    check(arNow('Bina Katz').enabled === true && /Almost there/.test(v.status), 'L3 ticking a trigger switches it on (Almost there — add a card)', v.status);

    console.log('\nL4. Avi switched back on; the parent changes the amount to $40');
    await open('Avi Katz'); await page.click('#arOnBtn'); await wait(800);
    await page.fill('#arThReload', '40'); await page.press('#arThReload', 'Tab'); await wait(1200);
    v = await view();
    console.log(`    stored enabled ${arNow('Avi Katz').enabled}, amount ${arNow('Avi Katz').thresholdReloadAmount}; Link "${v.status}"`);
    check(arNow('Avi Katz').enabled === true && Number(arNow('Avi Katz').thresholdReloadAmount) === 40, 'L4 an edit while on keeps it on', v.status);

    console.log('\nL5. Chaim, never set up: ticks the trigger, then 0.2 s later presses the up-arrow on "Reload amount" ($20 → $21)');
    await open('Chaim Katz');
    n0 = calls.length;
    await page.check('#arThEnabled'); await wait(200);
    await page.focus('#arThReload'); await page.keyboard.press('ArrowUp');
    await page.evaluate(() => document.getElementById('arThReload').dispatchEvent(new Event('change', { bubbles: true })));   // a spinner click fires 'change' at once
    await wait(1500);
    v = await view();
    console.log(`    sent ${JSON.stringify(calls.slice(n0))}; stored enabled ${JSON.stringify(arNow('Chaim Katz').enabled)}; Link "${v.status}"; box ticked ${v.ticked}; buttons ${JSON.stringify(v.buttons)}`);
    check(arNow('Chaim Katz').enabled === true, 'L5 a parent who ticked the trigger and then nudged the amount has auto-reload on', `stored enabled ${JSON.stringify(arNow('Chaim Katz').enabled)}; the box is ticked (${v.ticked}) but Link says "${v.status}"`);

    console.log('\nL6. Dov, never set up; each save takes 1.5 s to answer (slow phone). Ticks the trigger, then 0.8 s later changes the amount to $30 and tabs away');
    await open('Dov Katz');
    await page.evaluate(() => { window.__slow = 1500; });
    n0 = calls.length;
    await page.check('#arThEnabled'); await wait(800);
    await page.fill('#arThReload', '30'); await page.press('#arThReload', 'Tab');
    await wait(4000);
    await page.evaluate(() => { window.__slow = 0; });
    v = await view();
    console.log(`    sent ${JSON.stringify(calls.slice(n0))}; stored enabled ${JSON.stringify(arNow('Dov Katz').enabled)}, amount ${arNow('Dov Katz').thresholdReloadAmount}; Link "${v.status}"; box ticked ${v.ticked}; toasts ${JSON.stringify(v.toasts)}`);
    check(arNow('Dov Katz').enabled === true, 'L6 ticking the trigger then setting the amount leaves auto-reload on', `stored enabled ${JSON.stringify(arNow('Dov Katz').enabled)} — Link "${v.status}", box ticked ${v.ticked}`);
  } catch (e) { check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
  finally { if (browser) await browser.close().catch(() => {}); db.stop(); console.log(`\n${bad} BAD`); }
})();
