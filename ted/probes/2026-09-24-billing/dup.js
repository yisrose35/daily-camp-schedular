// Proof: a family converted by convert_family_ledgers (171/215) already has its
// f.charges on the ledger as le_conv_*; the Me page's new backfill posts them again.
const R = '/home/user/daily-camp-schedular';
const fs = require('fs'), vm = require('vm');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5461 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1';
try {
  db.sql(`INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', '${JSON.stringify({
      sessions: [{ name: 'Full', tuition: 1000 }],
      enrollments: { e1: { camperName: 'Avi Gold', session: 'Full', status: 'enrolled' } },
      families: { gold: { name: 'Gold', camperIds: ['Avi Gold'],
        charges: [{ id: 'lf_1', category: 'Late Fee', description: 'Late fee', amount: 25, date: '2026-07-01' }] } },
      finance: { payments: [{ id: 'p1', familyKey: 'gold', amount: 400, status: 'succeeded', stripePaymentIntentId: 'pi_1' }] } })}'::jsonb);`);
  const conv = db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false); SELECT convert_family_ledgers('${CAMP}', false)::text;`);
  console.log('convert:', conv.trim().split('\n').pop());
  let fam = JSON.parse(db.sql(`SELECT (camp_families_object('${CAMP}')->'gold')::text`).trim());
  console.log('after convert: entries', fam.entries.map(e => e.id + ':' + e.kind + ':' + e.amount).join(', '));
  console.log('ledger balance after convert:', db.sql(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold')`).trim());
  // The Me page on its next load: buildFamilyLedgers -> _postLedgerCharge(f,c) for every f.charges
  const src = fs.readFileSync(R + '/campistry_me.js', 'utf8');
  const at = src.indexOf('function _postLedgerCharge('); let i = src.indexOf('{', at), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  const ctx = { window: {} }; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(R + '/campistry_billing_core.js', 'utf8'), ctx);
  ctx.window.BillingCore = ctx.window.BillingCore || ctx.BillingCore;
  vm.runInContext('function _billingCore(){return window.BillingCore}\n' + src.slice(at, i + 1), ctx);
  const posted = fam.charges.map(c => ctx._postLedgerCharge(fam, c));
  console.log('Me page backfill posted:', posted, '->', fam.entries.filter(e => e.kind === 'charge').map(e => e.id + ' $' + e.amount).join(', '));
  console.log('BillingCore balance now:', ctx.window.BillingCore.balance(fam));
  db.sql(`SELECT 1`);
  console.log('SQL family_ledger_balance of the backfilled family:', db.sql(`SELECT family_ledger_balance('${JSON.stringify(fam).replace(/'/g, "''")}'::jsonb)`).trim());
} finally { db.stop && db.stop(); }
