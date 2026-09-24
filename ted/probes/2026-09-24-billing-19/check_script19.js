// Probe (19th pass): the check script's rows for 284 (edited in place), 286, 287.
//  V0 today's full chain → all ok
//  V1 last pass's 284 (91e9ef9) pasted over it → "apply 284 again"? and does it over-restock?
//  V2 286 undone (the merge without _keep_payer_ledger) → "apply 286"?
//  V3 287's function granted to signed-in browsers → "apply 287 again"?
//  V4 today's 284/286/287 pasted again (twice) → ok, nothing breaks
// Run: node ted/probes/2026-09-24-billing-19/check_script19.js
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5793 });
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const verify = () => db.json(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').replace(/;\s*$/, ''))
  .filter(r => /^28[4-7]/.test(r.item)).map(r => r.item.slice(0, 4) + ': ' + r.result);
const row = (v, n) => v.find(x => x.startsWith(n)) || '(missing)';
const M = (f) => fs.readFileSync(R + '/migrations/' + fs.readdirSync(R + '/migrations').find(x => x.startsWith(f)), 'utf8');
try {
  let v = verify(); console.log('V0 ' + JSON.stringify(v));
  check(v.every(x => /: ok$/.test(x)) && v.length === 4, 'V0 all four rows ok on today\'s chain', v.join(' | '));
  db.sql(fs.readFileSync(R + '/ted/probes/2026-09-24-billing-19/old_284_from_91e9ef9.sql', 'utf8'));
  v = verify(); console.log('V1 ' + row(v, '284'));
  check(!/284 : ok$/.test(row(v, '284')) && /apply 284/.test(row(v, '284')), 'V1 old 284 → apply 284 again', row(v, '284'));
  db.sql(M('284_'));
  const d = db.sql(`SELECT pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure)`);
  const undone = d.replace('public._keep_payer_ledger(p_server, v_out)', 'v_out');
  fs.writeFileSync('/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/undo286.sql', undone + ';');
  db.sql(undone + ';');
  v = verify(); console.log('V2 ' + row(v, '286'));
  check(/apply 286/.test(row(v, '286')), 'V2 286 missing → apply 286', row(v, '286'));
  db.sql(M('286_'));
  db.sql(`GRANT EXECUTE ON FUNCTION public.record_canteen_stripe_reversal(uuid, text, text, numeric, text, text) TO authenticated;`);
  v = verify(); console.log('V3 ' + row(v, '287'));
  check(/apply 287/.test(row(v, '287')), 'V3 287 open to browsers → apply 287 again', row(v, '287'));
  db.sql(M('287_')); db.sql(M('287_')); db.sql(M('286_')); db.sql(M('286_')); db.sql(M('284_'));
  v = verify(); console.log('V4 ' + JSON.stringify(v));
  check(v.every(x => /: ok$/.test(x)), 'V4 re-pasting 284/286/287 leaves everything ok', v.join(' | '));
  const dd = db.sql(`SELECT pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure)`);
  check((dd.match(/_keep_payer_ledger/g) || []).length === 1, 'V4 286 pasted twice wraps the merge once', (dd.match(/_keep_payer_ledger/g) || []).length + ' mentions');
} catch (e) { check(false, 'the run finished', String(e.message).split('\n')[0]); }
finally { db.stop(); console.log(`\n${bad} BAD`); }
