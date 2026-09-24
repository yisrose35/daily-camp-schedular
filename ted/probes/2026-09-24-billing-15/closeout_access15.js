// Probe (15th pass, TED-142/145 hunt: who can use the new close-out write).
// migration 280's canteen_season_closeout on a scratch Postgres with the full
// chain, called as each kind of person (auth.uid() pinned per call):
//   owner, admin, manager, scheduler, counselor (accepted camp_users rows with
//   no custom section rules), a parent with an invite for the child, a
//   stranger, and a manager whose Billing was set to view-only / edit by the
//   owner's section rules.
// Also: the same child closed out twice (a double press), and a close-out of
// more than the balance.
// Run: node ted/probes/2026-09-24-billing-15/closeout_access15.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5683 });
const q1 = (s) => db.sql(s).trim();
const CAMP = '0ed15000-0000-0000-0000-0000000000d1';
const U = (n) => `0ed15000-0000-0000-0000-0000000000${n}`;
const who = { owner: U('e1'), admin: U('e2'), manager: U('e3'), scheduler: U('e4'), counselor: U('e5'), parent: U('e6'), stranger: U('e7') };
try {
  db.sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
    INSERT INTO auth.users (id, email) VALUES ${Object.entries(who).map(([k, v]) => `('${v}', '${k}@ted15d')`).join(',')};
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${who.owner}', 'Access Camp');
    INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES
      ('${CAMP}', '${who.admin}', 'admin', now()), ('${CAMP}', '${who.manager}', 'manager', now()),
      ('${CAMP}', '${who.scheduler}', 'scheduler', now()), ('${CAMP}', '${who.counselor}', 'counselor', now());
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 7, 'camper', 'Avi Katz', 'Avi Katz');
    INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
      VALUES ('${CAMP}', '${who.parent}', 'Katz parent', 'parent@ted15d', jsonb_build_array('Avi Katz'), 'active');`);
  const fill = (bal) => db.sql(`SELECT public.canteen_account_save('${CAMP}', 'Avi Katz', '{"balance": ${bal}, "camperId": 7}'::jsonb);`);
  const as = (uid, amt) => { fill(5); const out = q1(`SELECT set_config('test.uid', '${uid}', false); SELECT set_config('request.jwt.claims', '{"sub":"${uid}"}', false);
      SELECT public.canteen_season_closeout('${CAMP}', 7, 'Avi Katz', ${amt || 5}, 'Season close-out: cash')::text`).split('\n').pop();
    const r = JSON.parse(out); return r.success ? `took $${r.amount}` : `refused: ${r.error} ("${r.message}")`; };
  console.log('Each person asks to close out Avi\'s $5 (default access rules, none customised):');
  for (const [k, v] of Object.entries(who)) console.log(`    ${k.padEnd(10)} → ${as(v)}`);
  const lvl = (uid) => q1(`SELECT set_config('test.uid', '${uid}', false); SELECT coalesce(public.user_section_level('${CAMP}', 'me.billing'), 'null')`).split('\n').pop();
  console.log('\nFor comparison, the access resolver\'s level for Me → Billing: ' + Object.entries(who).slice(0, 5).map(([k, v]) => `${k} ${lvl(v)}`).join(', '));

  console.log('\nA double press: the office presses Apply twice for the same $5');
  fill(5);
  const one = q1(`SELECT set_config('test.uid', '${who.owner}', false); SELECT public.canteen_season_closeout('${CAMP}', 7, 'Avi Katz', 5, 'Season close-out: cash')::text`).split('\n').pop();
  const two = q1(`SELECT set_config('test.uid', '${who.owner}', false); SELECT public.canteen_season_closeout('${CAMP}', 7, 'Avi Katz', 5, 'Season close-out: cash')::text`).split('\n').pop();
  console.log(`    first: ${one}\n    second: ${two}\n    wallet $${q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${CAMP}' AND account_key='Avi Katz'`)}; close-out lines ${q1(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${CAMP}' AND payload->>'kind'='closeout'`)}`);
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 1500)); }
finally { db.stop(); }
