// Re-run safety of 265-272 (5th pass): twice each in order; then 266 alone and
// 269 alone (TED-094 says they now leave 272's merge in place); then the
// check script. Also: an owner who pastes 271/272 BEFORE 266-270 (out of order).
const R = '/home/user/daily-camp-schedular', fs = require('fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5513 });
const file = f => fs.readFileSync(R + '/migrations/' + f, 'utf8');
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const rows = () => db.sql(`SELECT item || ' => ' || result FROM (${verify}) v WHERE item ~ '^2(6[5-9]|7[0-2])'`).trim();
const M = fs.readdirSync(R + '/migrations').filter(f => /^(26[5-9]|27[0-2])_/.test(f)).sort();
const merge = () => db.sql(`SELECT (d ~ 'LIKE ''shop') || '/' || (d ~ '_plan_fingerprint') || '/' || (d ~ '_keep_charge_links') FROM (SELECT pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure) d) x;`).trim().split('\n').pop();
try {
  console.log('files:', M.join(', '));
  for (let k = 0; k < 2; k++) M.forEach(m => db.sql(file(m)));
  console.log('after 265-272 twice each, in order:\n' + rows());
  console.log('merge has shop/fingerprint/links:', merge());
  db.sql(file(M.find(m => m.startsWith('266'))));
  console.log('after 266 alone: merge', merge());
  db.sql(file(M.find(m => m.startsWith('269'))));
  console.log('after 269 alone: merge', merge());
  console.log(rows().split('\n').filter(l => /266|269|272/.test(l)).join('\n'));
  // 271 twice more: the one-off catch-up pass must not double anything
  const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a513';
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b513','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b513', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', '{}'::jsonb);
    SELECT set_config('request.jwt.claims','{"sub":"b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b513"}',false);
    SELECT sync_camp_billing('${CAMP}', '{}'::jsonb, '[]'::jsonb, '[{"id":"pay_1","familyKey":"g","family":"G","amount":300,"method":"Check","status":"paid","date":"2026-05-20"}]'::jsonb, '[]'::jsonb);
    ALTER TABLE camp_families DISABLE TRIGGER trg_ledger_started_catch_up;
    SELECT sync_camp_billing('${CAMP}', '{"g":{"name":"G","entries":[{"id":"le_t","kind":"charge","amount":1000,"reason":"tuition","source":{"enrollmentId":"e1"}}]}}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    ALTER TABLE camp_families ENABLE TRIGGER trg_ledger_started_catch_up;`);
  const bal = () => db.sql(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'g');`).trim().split('\n').pop();
  console.log('\nrow:', db.sql(`SELECT payload::text FROM camp_families WHERE camp_id='${CAMP}';`).trim());
  console.log('family whose ledger started short (before 271): balance', bal());
  const f271 = M.find(m => m.startsWith('271'));
  db.sql(file(f271)); console.log('after pasting 271: balance', bal());
  db.sql(file(f271)); db.sql(file(f271)); console.log('after pasting 271 twice more: balance', bal(), '(should stay 700)');
} finally { db.stop && db.stop(); }
