// Proof (4th pass): 266 keeps ledger ENTRIES a stale Billing tab didn't know about,
// but not the charges[] list. The shop bills a $40 order to the family (charges[] +
// ledger), an office tab opened earlier adds a $10 charge and saves. What does the
// next Billing load's catch-up (_postExistingCharges, real code) then do?
const R = '/home/user/daily-camp-schedular', fs = require('fs'), vm = require('vm');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5491 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a4a1', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b4b1';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const src = fs.readFileSync(R + '/campistry_me.js', 'utf8');
const grab = n => { const at = src.indexOf('function ' + n + '('); let i = src.indexOf('{', at), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(at, i + 1); };
const ctx = { window: {}, console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(R + '/campistry_billing_core.js', 'utf8'), ctx);
vm.runInContext('function _billingCore(){return window.BillingCore}\n' + grab('_postLedgerCharge') + '\n' + grab('_postExistingCharges'), ctx);
const bal = () => q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`);
const row = () => JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold')::text;`));
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', 'Avi Gold', 'Avi Gold');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryShop','{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill"}]}'::jsonb);
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit({ name: 'Gold', camperIds: ['Avi Gold'], entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', source: { enrollmentId: 'e1' } }] })})));`);
  const tab = row();                                   // office tab loads the family
  console.log('tab loaded; balance', bal());
  console.log('shop bills $40:', q(`SELECT settle_shop_order('${CAMP}','o1','bill',40)::text;`));
  console.log('  row charges:', JSON.stringify((row().charges || []).map(c => c.id)), 'balance', bal());
  // stale tab adds a $10 charge the way Add Charge does (charges[] + ledger), then saves
  tab.charges = (tab.charges || []).concat([{ id: 'c10', amount: 10, category: 'Other', description: 'Photo', date: '2026-07-02' }]);
  ctx._postLedgerCharge(tab, tab.charges[tab.charges.length - 1]);
  console.log('stale tab save:', q(`SELECT sync_camp_billing('${CAMP}', jsonb_build_object('gold', ${lit(tab)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text;`));
  const r = row();
  console.log('  row charges:', JSON.stringify((r.charges || []).map(c => c.id)), '| entries:', r.entries.map(e => e.id).join(', '), '| balance', bal());
  // next Billing load anywhere runs the catch-up on the row and saves it
  const n = ctx._postExistingCharges(r);
  console.log('catch-up posted', n, ':', JSON.stringify(r.entries.slice(-n).map(e => [e.id, e.kind, e.amount, e.note])));
  q(`SELECT sync_camp_billing('${CAMP}', jsonb_build_object('gold', ${lit(r)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  console.log('balance now', bal(), '(should be 1050: tuition 1000 + shop 40 + photo 10)');
} finally { db.stop && db.stop(); }
