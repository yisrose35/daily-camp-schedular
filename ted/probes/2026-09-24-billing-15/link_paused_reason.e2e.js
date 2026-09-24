// Probe (15th pass, TED-143 re-check, the parent's side). The office's Refund
// All switched Avi's auto-reload off with a reason (the four refund functions'
// pauseAutoReload writes enabled:false + disabledReason through the real
// update_canteen_autoreload_state). Then, on the REAL set_canteen_auto_reload
// (231) as Avi's parent, on a scratch Postgres with the full chain:
//   P1 the parent switches it back on (Link's auto-save: enabled true)
//   P2 later the parent presses "Turn off" themselves (enabled false)
// After each, the Link page's OWN _renderAutoReload (lifted from
// campistry_link_parent.html with its Auto-Reload card markup) in Chromium:
// what does the parent read, and which buttons are there?
// Run: node ted/probes/2026-09-24-billing-15/link_paused_reason.e2e.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = '/home/user/daily-camp-schedular';
const { chromium } = require(path.join(R, 'node_modules/playwright'));
const db = require(R + '/tests/e2e/db.js').boot({ port: 5679 });
const q1 = (s) => db.sql(s).trim();
const CAMP = '0ed15000-0000-0000-0000-0000000000c9', OWNER = '0ed15000-0000-0000-0000-0000000000c8', PARENT = '0ed15000-0000-0000-0000-0000000000c7';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}${detail ? '   → ' + detail : ''}`); };

(async () => {
  let browser;
  try {
    db.sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'o@ted15c'), ('${PARENT}', 'p@ted15c');
      INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'Link Camp');
      INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 7, 'camper', 'Avi Katz', 'Avi Katz');
      INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
        VALUES ('${CAMP}', '${PARENT}', 'Katz parent', 'p@ted15c', jsonb_build_array('Avi Katz'), 'active');
      SELECT public.canteen_account_save('${CAMP}', 'Avi Katz', '{"balance": 0, "camperId": 7}'::jsonb);`);
    // What Refund All's pauseAutoReload leaves (its exact fields), written the way it writes it.
    const paused = { enabled: false, cardOnFile: true, stripeCustomerId: 'cus_avi', paymentMethodLabel: 'Visa ···· 4242', thresholdEnabled: true, thresholdAmount: 5,
      thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1, consecutiveFailures: 0,
      disabledAt: new Date().toISOString(), disabledReason: 'switched off when the camp refunded the canteen balance — switch it back on if you still want it' };
    const upd = q1(`SELECT public.update_canteen_autoreload_state(p_camp_id => '${CAMP}', p_camper_name => 'Avi Katz', p_camper_id => 7, p_autoreload => '${JSON.stringify(paused).replace(/'/g, "''")}'::jsonb)::text`);
    const arNow = () => JSON.parse(q1(`SELECT (payload->'autoReload')::text FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key='Avi Katz'`));
    console.log(`SETUP: Refund All paused Avi's auto-reload (update_canteen_autoreload_state → ${upd.slice(0, 40)}): enabled ${arNow().enabled}, reason "${arNow().disabledReason}"`);

    // The Link page's own renderer and its card, in a blank page.
    const L = fs.readFileSync(R + '/campistry_link_parent.html', 'utf8');
    const cut = (name) => { const at = L.indexOf('function ' + name + '('); let i = L.indexOf('{', at), d = 0;
      for (; i < L.length; i++) { if (L[i] === '{') d++; else if (L[i] === '}' && --d === 0) break; } return L.slice(at, i + 1); };
    const cardAt = L.indexOf('<div class="lk-card lk-collapsible collapsed" id="autoReloadCard">');
    let depth = 0, j = cardAt;
    for (; j < L.length; j++) { if (L.startsWith('<div', j)) depth++; else if (L.startsWith('</div>', j)) { depth--; if (depth === 0) { j += 6; break; } } }
    const card = L.slice(cardAt, j);
    const js = ['_escHtml', '_arToggleOption', '_arRenderDayOptions', '_arRenderSessionPicker', '_renderAutoReload'].map(cut).join('\n');
    const pinned = '/opt/pw-browsers/chromium';
    browser = await chromium.launch(fs.existsSync(pinned) ? { executablePath: pinned } : {});
    const page = await browser.newPage();
    await page.setContent(`<html><body>${card}<script>window._campSessionsByCamp = {};\n${js}\n</script></body></html>`);
    const show = async (ar) => page.evaluate((a) => {
      _renderAutoReload({ name: 'Avi Katz', campId: 'c', autoReload: a });
      const vis = (id) => { const e = document.getElementById(id); return e && e.style.display !== 'none' ? e.textContent.trim() : null; };
      return { status: document.getElementById('arStatusMsg').textContent.replace(/\s+/g, ' ').trim(), summary: (document.getElementById('arSummary') || {}).textContent,
        buttons: ['arCardBtn', 'arOffBtn'].map(vis).filter(Boolean), trigger: document.getElementById('arThEnabled').checked };
    }, ar);
    let v = await show(arNow());
    console.log(`\nP0. The parent opens Link after the refund:\n    status "${v.status}"; buttons ${JSON.stringify(v.buttons)}; "below $5" trigger box ticked: ${v.trigger}`);

    const asParent = (cfg) => q1(`SELECT set_config('test.uid', '${PARENT}', false); SELECT public.set_canteen_auto_reload('${CAMP}', 'Avi Katz', '${JSON.stringify(cfg)}'::jsonb)::text`).split('\n').pop();
    const base = { thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 };
    const r1 = JSON.parse(asParent(Object.assign({ enabled: true }, base)));
    console.log(`\nP1. The parent switches it back on (Link's auto-save sends enabled:true) → success ${r1.success}`);
    console.log(`    stored: enabled ${arNow().enabled}, disabledReason ${JSON.stringify(arNow().disabledReason || null)}`);
    v = await show(arNow());
    console.log(`    Link: "${v.status}"`);
    const r2 = JSON.parse(asParent(Object.assign({ enabled: false }, base)));
    console.log(`\nP2. Weeks later the parent presses "Turn off" themselves → success ${r2.success}`);
    console.log(`    stored: enabled ${arNow().enabled}, disabledReason ${JSON.stringify(arNow().disabledReason || null)}`);
    v = await show(arNow());
    console.log(`    Link: "${v.status}"; buttons ${JSON.stringify(v.buttons)}`);
    check(!/refunded the canteen balance/.test(v.status), 'P2 after the parent turned it off themselves, Link does not say the camp switched it off', `"${v.status}"`);
  } catch (e) { check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
  finally { if (browser) await browser.close().catch(() => {}); db.stop(); console.log(`\n${bad} BAD`); }
})();
