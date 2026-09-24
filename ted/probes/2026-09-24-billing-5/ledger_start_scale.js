// Probe (5th pass): 271's trigger runs sync_family_ledger_payments(camp, family)
// for EACH family whose ledger starts. That function builds the whole camp's
// families object and payments array every call. A camp's first Billing load
// after 271 (or the first load of the season) starts every family's ledger in
// one save. How long does that save take at 600 families, and is every
// earlier payment posted exactly once?
const R = '/home/user/daily-camp-schedular';
const N = Number(process.argv[2] || 600);
const db = require(R + '/tests/e2e/db.js').boot({ port: 5511 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a511', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b511';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const big = s => { const fn = require('os').tmpdir() + '/ted5_big.sql'; require('fs').writeFileSync(fn, AS + s); db.file(fn, { singleTransaction: false }); return 'done'; };
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
try {
  const fams = {}, pays = [];
  for (let i = 0; i < N; i++) {
    fams['f' + i] = { name: 'Fam ' + i, camperIds: ['Kid ' + i] };
    pays.push({ id: 'pay_' + i, familyKey: 'f' + i, family: 'Fam ' + i, amount: 100, method: 'Check', status: 'paid', date: '2026-05-20' });
  }
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', '{}'::jsonb);`);
  big(`SELECT sync_camp_billing('${CAMP}', ${lit(fams)}, '[]'::jsonb, ${lit(pays)}, '[]'::jsonb)::text;`);
  // Billing's first load: tuition posted on every family, one save.
  const started = {};
  for (let i = 0; i < N; i++) started['f' + i] = Object.assign({}, fams['f' + i], {
    entries: [{ id: 'le_t' + i, kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-21', source: { enrollmentId: 'e' + i } }] });
  const t0 = Date.now();
  const res = big(`SELECT sync_camp_billing('${CAMP}', ${lit(started)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text;`);
  const ms = Date.now() - t0;
  console.log(`${N} families' ledgers started in one save: ${ms} ms  -> ${res.slice(0, 120)}`);
  console.log('families with the $100 posted exactly once:',
    q(`SELECT count(*) FROM camp_families f WHERE f.camp_id='${CAMP}' AND (SELECT count(*) FROM jsonb_array_elements(f.payload->'entries') e WHERE e->>'id' LIKE 'le_pay_%') = 1;`),
    'of', N, '| sum of balances:', q(`SELECT sum(family_ledger_balance(f.payload)) FROM camp_families f WHERE f.camp_id='${CAMP}';`), '(should be', N * 900, ')');
  // Same save with the trigger switched off, for comparison.
  q(`ALTER TABLE camp_families DISABLE TRIGGER trg_ledger_started_catch_up; UPDATE camp_families SET payload = payload - 'entries' WHERE camp_id='${CAMP}'; SELECT 1;`);
  const t1 = Date.now();
  big(`SELECT sync_camp_billing('${CAMP}', ${lit(started)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text;`);
  console.log(`same save without the 271 trigger: ${Date.now() - t1} ms`);
} finally { db.stop && db.stop(); }
