// Probe (20th pass): the check script's rows 283, 284, 288, 289.
//  V0 today's chain → 283..289 all ok
//  V1 last pass's 284 (e8f1d26, no soldItems) pasted over it → "apply 284 again"?
//  V2 288 missing (functions dropped) → "apply 288"?
//  V3 288's pause function granted to browsers → "apply 288 again"?
//  V4 last pass's 283 (e8f1d26, no clean-up block) pasted after 289 → 289 row says two versions? and can a register sale still be made (named args, as PostgREST sends)?
//  V5 today's 283, 284, 288, 289 pasted again (twice) → ok
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const P = R + '/ted/probes/2026-09-24-billing-20/';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5827 });
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const verify = () => db.json(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').replace(/;\s*$/, ''))
  .filter(r => /^28[3-9]/.test(r.item)).map(r => r.item.slice(0, 4) + ': ' + r.result);
const row = (v, n) => v.find(x => x.startsWith(n)) || '(missing)';
const M = (f) => fs.readFileSync(R + '/migrations/' + fs.readdirSync(R + '/migrations').find(x => x.startsWith(f)), 'utf8');
const C = 'f2830000-0000-0000-0000-00000000c020', O = 'f2830000-0000-0000-0000-0000000000a0';
try {
  let v = verify(); console.log('V0 ' + JSON.stringify(v));
  check(v.length === 7 && v.every(x => /: ok$/.test(x)), 'V0 rows 283-289 ok on today\'s chain', v.join(' | '));
  db.sql(fs.readFileSync(P + 'old_284_from_e8f1d26.sql', 'utf8'));
  v = verify(); console.log('V1 ' + row(v, '284'));
  check(/apply 284/.test(row(v, '284')), 'V1 last pass\'s 284 → apply 284 again', row(v, '284'));
  db.sql(M('284_'));
  db.sql(`DROP FUNCTION public.hold_autopay_for_dispute(uuid,text,text,boolean,text);`);
  v = verify(); console.log('V2 ' + row(v, '288'));
  check(/apply 288/.test(row(v, '288')), 'V2 288 missing → apply 288', row(v, '288'));
  db.sql(M('288_'));
  db.sql(`GRANT EXECUTE ON FUNCTION public.hold_autopay_for_dispute(uuid,text,text,boolean,text) TO authenticated;`);
  v = verify(); console.log('V3 ' + row(v, '288'));
  check(/apply 288 again/.test(row(v, '288')), 'V3 288 open to browsers → apply 288 again', row(v, '288'));
  db.sql(M('288_'));
  v = verify(); check(/288 : ok$|288: ok$/.test(row(v, '288')) || /: ok$/.test(row(v, '288')), 'V3b 288 pasted again → ok (grant taken back)', row(v, '288'));
  db.sql(fs.readFileSync(P + 'old_283_from_e8f1d26.sql', 'utf8'));
  v = verify(); console.log('V4 ' + row(v, '283') + ' | ' + row(v, '289'));
  db.sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid $fn$;
    INSERT INTO auth.users (id, email) VALUES ('${O}', 'o@c20'); INSERT INTO camps (id, name, owner) VALUES ('${C}', 'c20', '${O}');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Avi', 'Avi');`);
  const as = `SET "request.jwt.claims" = '{"sub":"${O}"}';`;
  db.sql(`${as} SELECT public.canteen_office_credit('${C}', 'Avi', 20);`);
  let sale;
  try { sale = db.sql(`${as} SELECT public.submit_canteen_purchase_once(p_camp_id => '${C}', p_sale_key => 'k1', p_camper_name => 'Avi', p_amount => 1, p_items => 'Ices', p_camper_id => 1)::text`).trim(); }
  catch (e) { sale = 'ERROR ' + String(e.message).split('\n').find(l => /ERROR/.test(l)); }
  console.log('    a register that has not reloaded (no p_sold): ' + sale);
  check(/apply 289 again/.test(row(v, '289')), 'V4 an old 283 pasted after 289 → the 289 row says so', row(v, '289'));
  db.sql(M('283_')); db.sql(M('283_')); db.sql(M('284_')); db.sql(M('284_')); db.sql(M('288_')); db.sql(M('288_')); db.sql(M('289_')); db.sql(M('289_'));
  v = verify(); console.log('V5 ' + JSON.stringify(v));
  check(v.every(x => /: ok$/.test(x)), 'V5 re-pasting 283/284/288/289 twice leaves everything ok', v.join(' | '));
} catch (e) { check(false, 'the run finished', String(e.message).split('\n').slice(0, 3).join(' ')); }
finally { db.stop(); console.log(`\n${bad} BAD`); }
