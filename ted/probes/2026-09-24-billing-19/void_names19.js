// Probe (19th pass, hunt on TED-184's cap). The real 284 on today's chain.
// The cap reads what was sold back out of the sale's text ("Ices ×2, Chips").
// Items whose NAMES look like that text:
//   N1 "Trail Mix 2" sold once          → text "Trail Mix 2"
//   N2 "Chips, BBQ" sold once           → text "Chips, BBQ"
//   N3 "Ices" sold twice (control)      → text "Ices ×2"
// Voiding each with its own item ticked: does it go back in stock?
'use strict';
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5794 });
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const C = 'f2849900-0000-0000-0000-000000000001', O = 'f2849900-0000-0000-0000-0000000000aa';
const q = (s) => db.sql(s).trim();
try {
  q(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid $fn$;
     INSERT INTO auth.users (id, email) VALUES ('${O}', 'o@n19');
     INSERT INTO camps (id, name, owner) VALUES ('${C}', 'n19', '${O}');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Avi', 'Avi');
     INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistrySnacks',
       '{"inventory":[{"id":1,"name":"Trail Mix 2","price":2,"stock":10,"soldToday":0,"totalSold":0},{"id":2,"name":"Chips, BBQ","price":1,"stock":10,"soldToday":0,"totalSold":0},{"id":3,"name":"Ices","price":2.5,"stock":10,"soldToday":0,"totalSold":0}]}'::jsonb);`);
  const as = `SET "request.jwt.claims" = '{"sub":"${O}"}';`;
  q(`${as} SELECT public.canteen_office_credit('${C}', 'Avi', 20);`);
  const sale = (key, amt, items) => q(`${as} SELECT public.submit_canteen_purchase_once('${C}', '${key}', 'Avi', ${amt}, '${items.replace(/'/g, "''")}', NULL, 1)::text`);
  const stock = (id) => q(`SELECT e->>'stock' FROM camp_state_kv, jsonb_array_elements(value->'inventory') e WHERE camp_id='${C}' AND key='campistrySnacks' AND (e->>'id')::int=${id}`);
  const setStock = () => q(`UPDATE camp_state_kv SET value = jsonb_set(value, '{inventory}', (SELECT jsonb_agg(e || '{"stock":9}'::jsonb) FROM jsonb_array_elements(value->'inventory') e)) WHERE camp_id='${C}' AND key='campistrySnacks'`);
  sale('k1', 2, 'Trail Mix 2'); sale('k2', 1, 'Chips, BBQ'); sale('k3', 5, 'Ices ×2');
  setStock(); // the register took one of each (two ices) — model it simply: all at 9
  const sig = (items) => q(`SELECT sig FROM canteen_transactions WHERE camp_id='${C}' AND tx_type='debit' AND items='${items.replace(/'/g, "''")}'`);
  for (const [lab, items, id, qty] of [['N1', 'Trail Mix 2', 1, 1], ['N2', 'Chips, BBQ', 2, 1], ['N3', 'Ices ×2', 3, 2]]) {
    const r = q(`${as} SELECT public.canteen_void_sale('${C}', '${sig(items)}', '[{"id":${id},"qty":${qty}}]'::jsonb, 'probe')::text`);
    console.log(`${lab} void "${items}" (tick ${qty}): ${r}`);
    const s = Number(stock(id));
    check(s === 9 + qty, `${lab} "${items}" back in stock`, `stock ${s} (was 9); money back: ${JSON.parse(r).amount}`);
  }
} catch (e) { check(false, 'the run finished', String(e.message).split('\n')[0]); }
finally { db.stop(); console.log(`\n${bad} BAD`); }
