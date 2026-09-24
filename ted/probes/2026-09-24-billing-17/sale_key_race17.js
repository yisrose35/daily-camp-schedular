// Probe (17th pass, TED-159): migration 283 with TWO real database connections
// at the same moment (the builder's pgtest 283 runs one statement after
// another). Real chain on a scratch Postgres; two psql processes started
// together, the first holding its transaction open for 2 s after the charge
// (a slow commit), the second arriving 0.5 s later with the SAME key.
//   R1 same key, first commits → second waits, gets the first answer (replayed), one debit
//   R2 same key, first ROLLS BACK after charging (a failure after the charge,
//      e.g. the connection dies) → second charges, one debit in all
//   R3 different keys at once (two registers, two sales) → both charged
//   R4 same key, first REFUSED (not enough money) → second is refused too, no debit, no key left
//   R5 the 3-day clean-up: a key older than 3 days is forgotten and a new sale
//      under that old key is charged (a register can't reuse keys: they carry the time)
// Run: node ted/probes/2026-09-24-billing-17/sale_key_race17.js
'use strict';
const { spawn } = require('node:child_process');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5719 });
const OWNER = '0ed17200-0000-0000-0000-0000000000a1';
const C = '0ed17200-0000-0000-0000-000000000001';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
const claims = `SET "request.jwt.claims" = '{"sub":"${OWNER}"}';`;
function psql(sql) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(db.psql, ['-h', db.socket, '-p', String(db.port), '-U', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 }));
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  try {
    q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'o@t17');
       INSERT INTO camps (id, owner, name) VALUES ('${C}', '${OWNER}', 'Race Camp');
       INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Avi', 'Avi'), ('${C}', 2, 'camper', 'Bina', 'Bina'), ('${C}', 3, 'camper', 'Dov', 'Dov');
       ${claims}
       SELECT public.canteen_office_credit('${C}', 'Avi', 20); SELECT public.canteen_office_credit('${C}', 'Bina', 20); SELECT public.canteen_office_credit('${C}', 'Dov', 1);`);
    const debits = (who) => Number(q(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${C}' AND camper='${who}' AND tx_type='debit'`));
    const bal = (who) => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=${{ Avi: 1, Bina: 2, Dov: 3 }[who]}`);
    const buy = (key, who, id, amt) => `SELECT public.submit_canteen_purchase_once('${C}', ${key === null ? 'NULL' : `'${key}'`}, '${who}', ${amt}, 'Ices', NULL, ${id})::text`;
    const slowTx = (inner, end) => `${claims} BEGIN; ${inner}; SELECT pg_sleep(2); ${end};`;

    console.log('R1. same key k1: A charges and holds its transaction 2 s; B arrives 0.5 s later');
    let d = debits('Avi');
    let A = psql(slowTx(buy('k1', 'Avi', 1, 2.5), 'COMMIT'));
    await sleep(500);
    let B = psql(`${claims} ${buy('k1', 'Avi', 1, 2.5)}`);
    let [a, b] = await Promise.all([A, B]);
    console.log(`    A (${a.ms} ms): ${a.out.split('\n')[0]}\n    B (${b.ms} ms): ${b.out || b.err}`);
    check(debits('Avi') - d === 1 && /"replayed": true/.test(b.out) && b.ms > 1200, 'R1 one debit; B waited for A and got its answer, marked replayed', `debits +${debits('Avi') - d}, B waited ${b.ms} ms, balance $${bal('Avi')}`);

    console.log('R2. same key k2: A charges, then its transaction is ROLLED BACK (it fails after charging); B 0.5 s later');
    d = debits('Avi');
    A = psql(slowTx(buy('k2', 'Avi', 1, 2.5), 'ROLLBACK'));
    await sleep(500);
    B = psql(`${claims} ${buy('k2', 'Avi', 1, 2.5)}`);
    [a, b] = await Promise.all([A, B]);
    console.log(`    A (${a.ms} ms, rolled back): ${a.out.split('\n')[0]}\n    B (${b.ms} ms): ${b.out || b.err}`);
    check(debits('Avi') - d === 1 && /"success": true/.test(b.out) && !/replayed/.test(b.out), 'R2 A left nothing; B charged, once', `debits +${debits('Avi') - d}`);

    console.log('R3. two registers, two sales (keys k3 and k4) at the same moment');
    d = debits('Avi'); const db2 = debits('Bina');
    A = psql(slowTx(buy('k3', 'Avi', 1, 2.5), 'COMMIT'));
    await sleep(300);
    B = psql(`${claims} ${buy('k4', 'Bina', 2, 2.5)}`);
    [a, b] = await Promise.all([A, B]);
    console.log(`    A (${a.ms} ms): ${a.out.split('\n')[0].slice(0, 120)}\n    B (${b.ms} ms): ${(b.out || b.err).slice(0, 120)}`);
    check(debits('Avi') - d === 1 && debits('Bina') - db2 === 1, 'R3 both sales charged', `Avi +${debits('Avi') - d}, Bina +${debits('Bina') - db2}; B waited ${b.ms} ms (the camp-wide lock of 247)`);

    console.log('R4. Dov has $1; same key k5 twice at once for $2.50');
    d = debits('Dov');
    A = psql(slowTx(buy('k5', 'Dov', 3, 2.5), 'COMMIT'));
    await sleep(500);
    B = psql(`${claims} ${buy('k5', 'Dov', 3, 2.5)}`);
    [a, b] = await Promise.all([A, B]);
    console.log(`    A: ${a.out.split('\n')[0]}\n    B (${b.ms} ms): ${b.out || b.err}`);
    const left = q(`SELECT count(*) FROM canteen_sale_keys WHERE camp_id='${C}' AND sale_key='k5'`);
    check(debits('Dov') === d && /insufficient|daily_limit/.test(a.out) && /insufficient|daily_limit/.test(b.out) && left === '0', 'R4 both refused, nothing charged, no key kept', `debits +${debits('Dov') - d}, key rows ${left}`);

    console.log('R5. a key older than 3 days');
    q(`UPDATE canteen_sale_keys SET created_at = now() - interval '4 days' WHERE camp_id='${C}' AND sale_key='k1'`);
    d = debits('Avi');
    const r5 = q(`${claims} ${buy('k1', 'Avi', 1, 2.5)}`);
    console.log(`    the same key again: ${r5}`);
    check(debits('Avi') - d === 1, 'R5 an expired key is forgotten (a new charge under it goes through)', `debits +${debits('Avi') - d}`);

    console.log('R6. who may call it: a parent account (not camp staff)');
    q(`INSERT INTO auth.users (id, email) VALUES ('0ed17200-0000-0000-0000-0000000000b2', 'parent@t17');`);
    const r6 = q(`SET "request.jwt.claims" = '{"sub":"0ed17200-0000-0000-0000-0000000000b2"}'; ${buy('k9', 'Avi', 1, 2.5)}`);
    console.log(`    ${r6}`);
    check(/not_authorized/.test(r6), 'R6 a non-staff account is refused', r6);
    console.log(`\nAvi's ledger: ${q(`SELECT string_agg(tx_type || ' ' || amount, '; ' ORDER BY first_seen) FROM canteen_transactions WHERE camp_id='${C}' AND camper='Avi'`)}`);
  } catch (e) {
    check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  } finally {
    db.stop();
    console.log(`\n${bad} BAD`);
  }
})();
