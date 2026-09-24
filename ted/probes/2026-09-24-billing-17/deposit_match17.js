// Probe (17th pass, hunt — the bank-email matcher's decision, never audited).
// The REAL campistry_deposit_match.js (the same file the deposit-inbox
// function is built from), camp settings "Automatic".
//   M1 two households, each with a parent called David Cohen; Cohen A owes
//      $1,000, Cohen B owes $500. A Zelle arrives "from DAVID COHEN", $1,000.
//      (Which David Cohen sent it the bank email cannot say.)
//   M2 the same, but the payer's name is only in the bank's display name and
//      the household name is typed "Cohen" for one family
//   M3 control: a Zelle with the family's own payment reference → auto
//   M4 two families with the same household name "Katz" owing the same $750
// Run: node ted/probes/2026-09-24-billing-17/deposit_match17.js
'use strict';
const M = require('/home/user/daily-camp-schedular/campistry_deposit_match.js');
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const show = (r) => `${r.decision}${r.familyKey ? ' → ' + r.familyKey : ''} (conf ${r.confidence}${r.guardrail ? '; ' + r.guardrail : ''}) candidates ${JSON.stringify(r.candidates.map(c => [c.familyKey, c.score, c.reasons.join(' + ')]))}`;
const auto = { autoPostAt: 90, suggestAt: 40, ambiguousGap: 5, overpayGrace: 0.02, dryRun: false };

const fam = (name, parent) => ({ name, parents: [{ name: parent, email: parent.toLowerCase().replace(/\s/g, '.') + '@mail.test' }], parent1Name: parent });
const ctxA = { families: { cohenA: fam('Cohen Family (Flatbush)', 'David Cohen'), cohenB: fam('Cohen Family (Monsey)', 'David Cohen') },
  ledgers: { cohenA: { balance: 1000 }, cohenB: { balance: 500 } }, aliases: [] };
console.log('M1. Two households with a parent named David Cohen; A owes $1,000, B owes $500. Zelle "from DAVID COHEN" $1,000');
let r = M.decide({ kind: 'zelle', payerName: 'DAVID COHEN', amount: 1000 }, ctxA, auto);
console.log('    ' + show(r));
check(r.decision !== 'auto', 'M1 a payer name shared by two households is not posted without a person', show(r));

console.log('\nM1b. Same, but the money is $500 (B\'s balance)');
r = M.decide({ kind: 'zelle', payerName: 'DAVID COHEN', amount: 500 }, ctxA, auto);
console.log('    ' + show(r));
check(r.decision !== 'auto', 'M1b not posted to whichever Cohen owes that amount', show(r));

console.log('\nM3. Control: the Zelle carries Cohen A\'s payment reference');
const ref = M.referenceFor ? M.referenceFor('cohenA', ctxA) : null;
console.log(`    reference for cohenA: ${ref}`);
if (ref) { r = M.decide({ kind: 'zelle', payerName: 'DAVID COHEN', amount: 1000, memo: ref }, ctxA, auto); console.log('    ' + show(r)); }

const ctxK = { families: { katz1: fam('Katz', 'Moshe Katz'), katz2: fam('Katz', 'Yosef Katz') }, ledgers: { katz1: { balance: 750 }, katz2: { balance: 750 } }, aliases: [] };
console.log('\nM4. Two households named "Katz" each owing $750; Zelle "from KATZ" $750');
r = M.decide({ kind: 'zelle', payerName: 'KATZ', amount: 750 }, ctxK, auto);
console.log('    ' + show(r));
check(r.decision !== 'auto', 'M4 not auto-posted', show(r));
console.log(`\n${bad} BAD`);
