// Proof: a shop order billed to the family, then cancelled. The Me page's backfill
// posted the charge to the ledger in between; cancelling removes it from charges[]
// only, so the ledger keeps billing it.
const R = '/home/user/daily-camp-schedular';
const fs = require('fs'), vm = require('vm');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5462 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a2', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b2';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', 'Avi Gold', 'Avi Gold');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryShop','{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill"}]}'::jsonb);
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', '${JSON.stringify({
      families: { gold: { name: 'Gold', camperIds: ['Avi Gold'],
        entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition' }, { id: 'le_p', kind: 'payment', amount: 1000, reason: 'card' }] } } })}'::jsonb);`);
  console.log('settle bill $40:', q(`SELECT settle_shop_order('${CAMP}','o1','bill',40)::text;`));
  let fam = JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold')::text;`));
  console.log('charges[]:', JSON.stringify(fam.charges.map(c => c.id + ' $' + c.amount)), ' ledger balance:', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`));
  // Me page load: buildFamilyLedgers backfill
  const src = fs.readFileSync(R + '/campistry_me.js', 'utf8');
  const at = src.indexOf('function _postLedgerCharge('); let i = src.indexOf('{', at), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  const ctx = { window: {} }; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(R + '/campistry_billing_core.js', 'utf8'), ctx);
  vm.runInContext('function _billingCore(){return window.BillingCore}\n' + src.slice(at, i + 1), ctx);
  fam.charges.forEach(c => ctx._postLedgerCharge(fam, c));
  const lit = JSON.stringify(fam).replace(/'/g, "''");
  q(`SELECT camp_family_save('${CAMP}','gold','${lit}'::jsonb);`);
  console.log('after Me page backfill + save, ledger balance:', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`));
  console.log('cancel order:', q(`SELECT settle_shop_order('${CAMP}','o1','bill',40,true)::text;`));
  fam = JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold')::text;`));
  console.log('charges[] now:', JSON.stringify((fam.charges || []).map(c => c.id)), ' ledger entries:', fam.entries.map(e => e.id + ' $' + e.amount).join(', '));
  console.log('ledger balance after cancel:', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`));
} finally { db.stop && db.stop(); }
