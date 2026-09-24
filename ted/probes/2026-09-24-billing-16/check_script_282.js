// Probe (16th pass, TED-156 owner steps): migration 282 and the checking
// script's 282 row, in the orders an owner pasting by hand can produce.
//   A full chain (…281, 282) → "ok"
//   B 231 pasted AGAIN after 282 (it re-creates set_canteen_auto_reload
//     without the fix) → the check says "apply 282"? then 282 again → "ok"?
//   C 282 pasted twice → a NOTICE, no error, still "ok"
//   D 282 pasted on a DB that never had 231's function → the error it gives
// Run: node ted/probes/2026-09-24-billing-16/check_script_282.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const fs = require('node:fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5697 });
const q1 = (s) => db.sql(s).trim();
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const row = () => q1(`SELECT result FROM (${verify}) v WHERE item LIKE '282%'`);
const paste = (f) => { const r = require('node:child_process').spawnSync(db.psql, ['-h', db.socket, '-p', String(db.port), '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', R + '/migrations/' + f], { encoding: 'utf8' });
  return (r.status === 0 ? 'ran' : 'ERROR') + (r.stderr.trim() ? ' — ' + r.stderr.trim().split('\n').filter(l => /NOTICE|ERROR/.test(l)).map(l => l.replace(/^psql:[^:]*:\d+: /, '')).join(' | ').slice(0, 300) : ''); };
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
try {
  let r = row();
  console.log(`A. full chain: 282 row → "${r}"`); check(r === 'ok', 'A full chain is ok', r);
  console.log(`B. 231 pasted again after 282: ${paste('231_the_last_four_canteen_writers_on_the_shared_gate.sql')}`);
  r = row(); console.log(`   282 row → "${r}"`); check(/^apply 282/.test(r), 'B the check notices the fix is gone', r);
  console.log(`   282 pasted again: ${paste('282_a_parent_save_clears_the_camps_pause_note.sql')}`);
  r = row(); console.log(`   282 row → "${r}"`); check(r === 'ok', 'B after 282 again it is ok', r);
  console.log(`C. 282 pasted a second time: ${paste('282_a_parent_save_clears_the_camps_pause_note.sql')}`);
  r = row(); check(r === 'ok', 'C still ok after a repeat', r);
  const n = q1(`SELECT (length(pg_get_functiondef('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)'::regprocedure)) - length(replace(pg_get_functiondef('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)'::regprocedure), '(v_ar - ''disabledReason'')', ''))) / length('(v_ar - ''disabledReason'')')`);
  check(n === '1', 'C the note-clearing line is in the function once, not once per paste', n + ' copies');
  const grants = q1(`SELECT has_function_privilege('authenticated','public.set_canteen_auto_reload(uuid,text,jsonb,bigint)','EXECUTE')::text || ' / anon ' || has_function_privilege('anon','public.set_canteen_auto_reload(uuid,text,jsonb,bigint)','EXECUTE')::text`);
  check(grants === 'true / anon false', 'the patched function keeps its grants (parents yes, signed-out no)', grants);
  db.sql(`DROP FUNCTION public.set_canteen_auto_reload(uuid,text,jsonb,bigint)`);
  console.log(`D. 282 on a database without 231's function: ${paste('282_a_parent_save_clears_the_camps_pause_note.sql')}`);
} catch (e) { bad++; console.log('ERROR ' + String(e.stack || e).slice(0, 600)); }
finally { db.stop(); console.log(`\n${bad} BAD`); }
