// Probe (18th pass, TED-175 re-check beyond pgtest 284). Migration 284's REAL
// canteen_void_sale on the real migration chain (scratch Postgres), as the
// camp owner.
//   V1 two office computers void the same $5 sale at the same moment (A holds
//      its transaction 2 s, B arrives 0.5 s later) → money and stock once?
//   V2 lines that are NOT register sales: a card refund (kind refund), a cash
//      out, a season close-out → refused, nothing moves
//   V3 the restock list is the page's: a $2.50 Ices sale voided with
//      "restock 100 Chips" (never sold) → what does the stock say?
// Run: node ted/probes/2026-09-24-billing-18/void_sale18.js
'use strict';
const { spawn } = require('node:child_process');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5762 });
const OWNER = '0ed18600-0000-0000-0000-0000000000a1';
const C = '0ed18600-0000-0000-0000-000000000001';
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
    q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}', 'o@t18v');
       INSERT INTO camps (id, owner, name) VALUES ('${C}', '${OWNER}', 'Void Camp');
       INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Avi', 'Avi');
       INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistrySnacks', '{"inventory":[{"id":1,"name":"Ices","price":2.5,"stock":8,"soldToday":2,"totalSold":2},{"id":2,"name":"Chips","price":1.5,"stock":10,"soldToday":0,"totalSold":0}]}'::jsonb);
       ${claims}
       SELECT public.canteen_office_credit('${C}', 'Avi', 40);`);
    const bal = () => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=1`);
    const stock = () => q(`SELECT string_agg((e->>'name') || ' ' || (e->>'stock') || ' left/' || (e->>'totalSold') || ' sold', ', ') FROM camp_state_kv, jsonb_array_elements(value->'inventory') e WHERE camp_id='${C}' AND key='campistrySnacks'`);
    const voids = () => Number(q(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${C}' AND payload->>'kind'='void'`));
    const sale = (items, amt, key) => { q(`${claims} SELECT public.submit_canteen_purchase_once('${C}', '${key}', 'Avi', ${amt}, '${items}', NULL, 1)`);
      return q(`SELECT sig FROM canteen_transactions WHERE camp_id='${C}' AND tx_type='debit' AND items='${items}' ORDER BY first_seen DESC LIMIT 1`); };
    const voidSql = (sig, restock) => `SELECT public.canteen_void_sale('${C}', '${sig}', '${JSON.stringify(restock)}'::jsonb, NULL)::text`;

    console.log('V1. Avi is charged $5 for "Ices ×2" by mistake; two office computers press Void at the same moment');
    const s1 = sale('Ices ×2', 5, 'k1');
    const b0 = bal(), st0 = stock();
    const A = psql(`${claims} BEGIN; ${voidSql(s1, [{ id: 1, qty: 2 }])}; SELECT pg_sleep(2); COMMIT;`);
    await sleep(500);
    const B = psql(`${claims} ${voidSql(s1, [{ id: 1, qty: 2 }])}`);
    const [a, b] = await Promise.all([A, B]);
    console.log(`    A: ${a.out.split('\n').pop().slice(0, 160)}\n    B (${b.ms} ms): ${b.out.slice(0, 160)}`);
    console.log(`    wallet $${b0} → $${bal()}; stock ${st0} → ${stock()}; void lines ${voids()}`);
    check(Number(bal()) - Number(b0) === 5 && voids() === 1 && /already_voided/.test(b.out) && /Ices 10 left\/0 sold/.test(stock()),
      'V1 voided once: $5 back once, 2 Ices back once, the second press told "already voided"', `wallet +${(Number(bal()) - Number(b0)).toFixed(2)}, ${voids()} void lines, ${stock()}`);

    console.log('\nV2. lines that are not register sales');
    const kinds = [
      ['a card refund of a top-up', { type: 'debit', kind: 'refund', method: 'stripe', amount: 10, items: 'Refund — deposit reversed', stripeRefundId: 're_v2' }],
      ['cash handed out at the desk', { type: 'debit', kind: 'cash_out', amount: 5, items: 'Cash out' }],
      ['the season close-out', { type: 'debit', kind: 'closeout', amount: 7, items: 'Season close-out' }],
    ];
    for (const [what, tx] of kinds) {
      const sig = 'v2_' + tx.kind;
      q(`SELECT public.canteen_post('${C}', 'Avi', '${JSON.stringify(Object.assign({ camper: 'Avi', camperId: 1, date: '2026-07-01' }, tx))}'::jsonb, '${sig}')`);
      const b1 = bal(), n1 = voids();
      const r = q(`${claims} ${voidSql(sig, [])}`).split('\n').pop();
      console.log(`    ${what}: ${r.slice(0, 160)}`);
      check(/not_a_sale/.test(r) && bal() === b1 && voids() === n1, `V2 ${what} is not voidable`, r.slice(0, 120));
    }

    console.log('\nV3. a $2.50 Ices sale, voided with the restock list "100 Chips" (Chips were never sold)');
    const s3 = sale('Ices', 2.5, 'k3');
    const st3 = stock();
    const r3 = q(`${claims} ${voidSql(s3, [{ id: 2, qty: 100 }, { id: 2, qty: 100 }])}`).split('\n').pop();
    console.log(`    ${r3.slice(0, 200)}\n    stock ${st3} → ${stock()}`);
    console.log(`    (observation only: the server restocks whatever the page lists — the page offers only the sale's own items)`);
  } catch (e) {
    check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  } finally {
    db.stop();
    console.log(`\n${bad} BAD`);
  }
})();
