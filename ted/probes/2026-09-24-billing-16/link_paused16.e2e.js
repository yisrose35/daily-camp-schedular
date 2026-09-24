// Probe (16th pass, TED-156 re-check). Link's Auto-Reload card — its markup and
// its own functions lifted from campistry_link_parent.html (_renderAutoReload,
// saveAutoReload, turnOffAutoReload, _saveAutoReloadConfig, _arAutoSave …) —
// in Chromium, with its RPC wired to the REAL set_canteen_auto_reload (231 +
// 282) on a scratch Postgres, called AS the parent.
//   P0 the camp's Refund All paused Avi's auto-reload (its exact fields):
//      what does the parent read, which buttons are there?
//   P1 the parent presses "Switch it back on"
//   P2 later the parent presses "Turn off" themselves: what now, and is there
//      a button to switch it back on?
//   P3 in that Off state, the parent only changes the reload amount ($20→$30)
//      — what gets saved?
//   P4 paused by the camp again; the parent only changes the amount — saved?
// Run: node ted/probes/2026-09-24-billing-16/link_paused16.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const db = require(R + '/tests/e2e/db.js').boot({ port: 5699 });
const q1 = (s) => db.sql(s).trim();
const CAMP = '0ed16300-0000-0000-0000-0000000000c9', OWNER = '0ed16300-0000-0000-0000-0000000000c8', PARENT = '0ed16300-0000-0000-0000-0000000000c7';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let browser;
  try {
    db.sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'o@ted16c'), ('${PARENT}', 'p@ted16c');
      INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'Link Camp');
      INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 7, 'camper', 'Avi Katz', 'Avi Katz');
      INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
        VALUES ('${CAMP}', '${PARENT}', 'Katz parent', 'p@ted16c', jsonb_build_array('Avi Katz'), 'active');
      SELECT public.canteen_account_save('${CAMP}', 'Avi Katz', '{"balance": 0, "camperId": 7}'::jsonb);`);
    const pause = () => {
      const cur = JSON.parse(q1(`SELECT coalesce(payload->'autoReload','{}'::jsonb)::text FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key='Avi Katz'`));
      const paused = Object.assign({ cardOnFile: true, stripeCustomerId: 'cus_avi', paymentMethodLabel: 'Visa ···· 4242', thresholdEnabled: true, thresholdAmount: 5,
        thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1, consecutiveFailures: 0 }, cur,
        { enabled: false, disabledAt: new Date().toISOString(), disabledReason: 'switched off when the camp refunded the canteen balance — switch it back on if you still want it' });
      return q1(`SELECT public.update_canteen_autoreload_state(p_camp_id => '${CAMP}', p_camper_name => 'Avi Katz', p_camper_id => 7, p_autoreload => '${JSON.stringify(paused).replace(/'/g, "''")}'::jsonb)::text`);
    };
    const arNow = () => JSON.parse(q1(`SELECT (payload->'autoReload')::text FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key='Avi Katz'`));
    console.log(`SETUP: Refund All paused Avi's auto-reload → ${pause().slice(0, 30)}; stored enabled ${arNow().enabled}, reason "${arNow().disabledReason}"`);

    const L = fs.readFileSync(R + '/campistry_link_parent.html', 'utf8');
    const cut = (name) => { const at = L.indexOf('function ' + name + '('); if (at < 0) throw new Error(name + ' missing'); let i = L.indexOf('{', at), d = 0;
      for (; i < L.length; i++) { if (L[i] === '{') d++; else if (L[i] === '}' && --d === 0) break; } return L.slice(at, i + 1); };
    const cardAt = L.indexOf('<div class="lk-card lk-collapsible collapsed" id="autoReloadCard">');
    let depth = 0, j = cardAt;
    for (; j < L.length; j++) { if (L.startsWith('<div', j)) depth++; else if (L.startsWith('</div>', j)) { depth--; if (depth === 0) { j += 6; break; } } }
    const card = L.slice(cardAt, j);
    const js = ['_escHtml', '_arToggleOption', '_arRenderDayOptions', '_arRenderSessionPicker', '_renderAutoReload', 'saveAutoReload', 'turnOffAutoReload', '_saveAutoReloadConfig'].map(cut).join('\n');
    // _arAutoSave is a function too; its body is lifted the same way
    const autoSave = cut('_arAutoSave');
    const pinned = '/opt/pw-browsers/chromium';
    browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
    const page = await browser.newPage();
    const calls = [];
    await page.exposeFunction('__setAR', (argsJson) => {
      const a = JSON.parse(argsJson); calls.push(a.p_config);
      const out = q1(`SELECT set_config('test.uid', '${PARENT}', false); SELECT public.set_canteen_auto_reload('${CAMP}', ${"'" + String(a.p_camper_name).replace(/'/g, "''") + "'"}, '${JSON.stringify(a.p_config).replace(/'/g, "''")}'::jsonb)::text`).split('\n').pop();
      return out;
    });
    await page.setContent(`<html><body>${card}<div id="toastBox"></div><script>
      window._campSessionsByCamp = {};
      var TOASTS = []; function toast(m){ TOASTS.push(String(m)); }
      function _flashSavedHint(){ TOASTS.push('(saved hint)'); }
      function startCanteenAutoReloadSetup(){ TOASTS.push('(card page opened)'); }
      var CHILD = { name: 'Avi Katz', campId: '${CAMP}', autoReload: {} };
      function _activeCanteenChild(){ return CHILD; }
      window._parentDB = { rpc: function(){ return Promise.reject(new Error('should use _pRpc')); } };
      window._pRpc = function(name, args){ return window.__setAR(JSON.stringify(args)).then(function(t){ return { data: JSON.parse(t), error: null }; }); };
      ${js}
      var _arSaveTimer = null;   // declared beside _arAutoSave in Link
      ${autoSave}
      document.getElementById('autoReloadCard').addEventListener('change', _arAutoSave);
    </script></body></html>`);
    const show = async (ar) => page.evaluate((a) => {
      if (a) { CHILD.autoReload = a; _renderAutoReload(CHILD); }
      const vis = (id) => { const e = document.getElementById(id); return e && e.style.display !== 'none' ? e.textContent.trim() : null; };
      return { status: document.getElementById('arStatusMsg').textContent.replace(/\s+/g, ' ').trim(),
        buttons: ['arCardBtn', 'arOffBtn', 'arOnBtn'].map(vis).filter(Boolean), trigger: document.getElementById('arThEnabled').checked,
        toasts: TOASTS.splice(0) };
    }, ar);

    let v = await show(arNow());
    console.log(`\nP0. The parent opens Link after the refund:\n    status "${v.status}"; buttons ${JSON.stringify(v.buttons)}; "below $5" box ticked: ${v.trigger}`);
    check(v.buttons.includes('Switch it back on'), 'P0 a "Switch it back on" button is shown while the camp has it paused', JSON.stringify(v.buttons));

    await page.click('#arOnBtn'); await wait(1500);
    v = await show(null);
    console.log(`\nP1. The parent presses "Switch it back on" → sent ${JSON.stringify(calls[calls.length - 1])}`);
    console.log(`    stored: enabled ${arNow().enabled}, disabledReason ${JSON.stringify(arNow().disabledReason || null)}, card kept ${arNow().stripeCustomerId}`);
    console.log(`    Link: "${v.status}"; buttons ${JSON.stringify(v.buttons)}; toasts ${JSON.stringify(v.toasts)}`);
    check(arNow().enabled === true && !arNow().disabledReason && /Auto-reload is on/.test(v.status), 'P1 it is back on, the camp\'s note is gone, Link says on', v.status);

    await page.click('#arOffBtn'); await wait(1500);
    v = await show(null);
    console.log(`\nP2. Later the parent presses "Turn off" → stored enabled ${arNow().enabled}, reason ${JSON.stringify(arNow().disabledReason || null)}`);
    console.log(`    Link: "${v.status}"; buttons ${JSON.stringify(v.buttons)}; "below $5" box ticked: ${v.trigger}; toasts ${JSON.stringify(v.toasts)}`);
    check(!/refunded/.test(v.status), 'P2 Link does not say the camp switched it off', v.status);
    console.log(`  NOTE P2 in the parent's own Off state the buttons shown are ${JSON.stringify(v.buttons)}; the trigger box is still ticked`);

    const before = calls.length;
    await page.fill('#arThReload', '30');
    await page.dispatchEvent('#arThReload', 'change');
    await wait(1500);
    v = await show(null);
    const sent = calls.slice(before);
    console.log(`\nP3. In that Off state the parent changes only the reload amount ($20 → $30):`);
    console.log(`    sent ${JSON.stringify(sent)}`);
    console.log(`    stored: enabled ${arNow().enabled}, thresholdReloadAmount ${arNow().thresholdReloadAmount}; Link "${v.status}"; toasts ${JSON.stringify(v.toasts)}`);
    console.log(`  NOTE P3 editing an amount while Off ${arNow().enabled ? 'SWITCHES IT BACK ON (enabled true), with only a "saved" hint' : 'keeps it off'}`);

    pause();
    v = await show(arNow());
    const before4 = calls.length;
    await page.fill('#arThReload', '25');
    await page.dispatchEvent('#arThReload', 'change');
    await wait(1500);
    v = await show(null);
    console.log(`\nP4. Paused by the camp again; the parent changes only the amount ($30 → $25): sent ${JSON.stringify(calls.slice(before4).map(c => ({ enabled: c.enabled, thresholdReloadAmount: c.thresholdReloadAmount })))}`);
    console.log(`    stored: enabled ${arNow().enabled}, reason ${JSON.stringify(arNow().disabledReason || null)}; Link "${v.status}"`);
  } catch (e) { check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
  finally { if (browser) await browser.close().catch(() => {}); db.stop(); console.log(`\n${bad} BAD`); }
})();
