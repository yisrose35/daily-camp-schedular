// Probe (21st pass): the edited 288 against the owner's real paste orders.
//  V0 today's chain → 288 ok
//  V1 last pass's 288 (a941220) pasted over today's → "apply 288 again"?
//  V2 a DB that has only the a941220 288 (flag_plan_collection unpatched), with a
//     pause already stored the old way ({disputeId} only) → paste today's 288 →
//     row ok; flag_plan_collection patched once; the old-style pause: a second
//     dispute joins it, winning the first keeps it, winning the second lifts it
//  V3 today's 288 pasted twice more → ok, flag_plan_collection unchanged
//  V4 214 pasted again after 288 (owner re-runs an old file) → the row catches it?
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const P = R + '/ted/probes/2026-09-24-billing-21/';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5831 });
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const verify = () => db.json(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').replace(/;\s*$/, ''))
  .filter(r => /^288/.test(r.item)).map(r => r.result)[0];
const M = (f) => fs.readFileSync(R + '/migrations/' + fs.readdirSync(R + '/migrations').find(x => x.startsWith(f)), 'utf8');
const OLD = fs.readFileSync(P + 'old_288_from_a941220.sql', 'utf8');
const fdef = () => db.sql(`SELECT md5(pg_get_functiondef('public.flag_plan_collection(uuid,text,text,text,text)'::regprocedure))`).trim();
const vcb = () => db.sql(`SELECT (length(pg_get_functiondef('public.flag_plan_collection(uuid,text,text,text,text)'::regprocedure)) - length(replace(pg_get_functiondef('public.flag_plan_collection(uuid,text,text,text,text)'::regprocedure), 'v_cb', ''))) / 4`).trim();
const C = 'f2880000-0000-0000-0000-00000000c021', O = 'f2880000-0000-0000-0000-0000000000a1';
try {
  let v = verify(); console.log('V0 ' + v);
  check(v === 'ok', 'V0 today\'s chain → 288 ok', v);
  db.sql(OLD);
  v = verify(); console.log('V1 ' + v);
  check(/apply 288 again/.test(v), 'V1 last pass\'s 288 pasted over today\'s → apply 288 again', v);
  db.sql(M('288_'));
  check(verify() === 'ok', 'V1b today\'s 288 again → ok', verify());

  // V2: roll flag_plan_collection back to its pre-288 body (re-run 214 + 269), put the old 288 in
  db.sql(M('214_')); db.sql(M('269_')); db.sql(OLD);
  console.log('V2 before: v_cb count ' + vcb() + '; row: ' + verify());
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${O}', 'o@c21'); INSERT INTO camps (id, name, owner) VALUES ('${C}', 'c21', '${O}');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', '{"families":{}}'::jsonb);
    SELECT public.camp_family_save('${C}', 'oak', '{"name":"Oak","entries":[],"plans":[{"id":"p1","autopay":true,"dueDates":["2026-10-01"],"count":1,"nextIndex":0}]}'::jsonb);
    SELECT public.hold_autopay_for_dispute('${C}', 'oak', 'dp_old', true, 'fraudulent');`);
  const mk = () => db.sql(`SELECT COALESCE((public.camp_family('${C}','oak')->'plans'->0->'collectionBlocked')::text, 'none')`).trim();
  console.log('    pause stored by the old 288: ' + mk());
  db.sql(M('288_'));
  v = verify(); console.log('V2 after today\'s 288: row ' + v + '; v_cb count ' + vcb());
  check(v === 'ok' && Number(vcb()) > 0, 'V2 today\'s 288 over the old one → ok, flag_plan_collection patched', v);
  db.sql(`SELECT public.hold_autopay_for_dispute('${C}', 'oak', 'dp_new', true, NULL)`);
  const a = mk();
  db.sql(`SELECT public.hold_autopay_for_dispute('${C}', 'oak', 'dp_old', false)`);
  const b = mk();
  db.sql(`SELECT public.hold_autopay_for_dispute('${C}', 'oak', 'dp_new', false)`);
  const c = mk();
  console.log(`    second dispute joins: ${a}\n    old one won: ${b}\n    new one won: ${c}`);
  check(/dp_old/.test(a) && /dp_new/.test(a), 'V2a an old-style pause takes a second dispute into its list', a);
  check(/chargeback/.test(b) && /dp_new/.test(b), 'V2b winning the old one keeps the pause for the new one', b);
  check(c === 'none', 'V2c winning both lifts it', c);

  const h1 = fdef();
  db.sql(M('288_')); db.sql(M('288_'));
  check(verify() === 'ok' && fdef() === h1, 'V3 today\'s 288 twice more → ok, flag_plan_collection unchanged', verify() + ' ' + (fdef() === h1));

  db.sql(M('214_'));
  v = verify(); console.log('V4 214 re-pasted after 288: ' + v);
  check(v !== 'ok', 'V4 214 re-pasted after 288 → the 288 row is not ok', v);
  db.sql(M('269_')); db.sql(M('288_'));
  check(verify() === 'ok', 'V4b 269 + 288 again → ok', verify());
} catch (e) { check(false, 'the run finished', String(e.message).split('\n').slice(0, 4).join(' ')); }
finally { db.stop(); console.log(`\n${bad} BAD`); }
