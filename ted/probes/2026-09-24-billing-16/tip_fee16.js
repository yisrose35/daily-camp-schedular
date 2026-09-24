// Probe (16th pass, hunt — staff tips, never audited). The tip checkout's own
// fee maths (computeFees + its constants, lifted from
// supabase/functions/stripe-connect-tip/index.ts and run as-is) for typical
// tips: what the parent pays on top, as a share of the tip; and whether
// Stripe's real cut (2.9% + 30c of the TOTAL, rounded) leaves Campistry its 2%.
// Compared with the product's own card-fee rules (campistry_card_fees.js),
// which cap a surcharge at 3% and never put one on a debit card.
// Run: node ted/probes/2026-09-24-billing-16/tip_fee16.js
'use strict';
const fs = require('node:fs');
const src = fs.readFileSync('/home/user/daily-camp-schedular/supabase/functions/stripe-connect-tip/index.ts', 'utf8');
const pick = (re) => { const m = src.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
const consts = ['PLATFORM_FEE_RATE', 'STRIPE_PCT', 'STRIPE_FIXED_CENTS'].map(n => pick(new RegExp('const ' + n + ' = [^;]+;'))).join('\n');
const fnSrc = pick(/function computeFees\(tipCents: number\) \{[\s\S]*?\n\}/).replace('tipCents: number', 'tipCents');
const computeFees = new Function(consts + '\n' + fnSrc + '\nreturn computeFees;')();
console.log('lifted: ' + consts.replace(/\n/g, ' '));
for (const tip of [1, 2, 5, 10, 20, 50, 100, 500]) {
  const c = computeFees(tip * 100);
  const stripeReal = Math.round(c.totalCents * 0.029 + 30);
  const campistryKeeps = c.feeCents - stripeReal;
  console.log(`tip $${tip.toFixed(2)} → parent pays $${(c.totalCents / 100).toFixed(2)} (fee $${(c.feeCents / 100).toFixed(2)} = ${(100 * c.feeCents / (tip * 100)).toFixed(1)}% of the tip); staff gets $${((c.totalCents - c.feeCents) / 100).toFixed(2)}; Stripe takes ~$${(stripeReal / 100).toFixed(2)}, Campistry keeps ~$${(campistryKeeps / 100).toFixed(2)} (2% = $${(c.campistryFeeCents / 100).toFixed(2)})`);
}
const CF = require('/home/user/daily-camp-schedular/campistry_card_fees.js');
const pol = CF.normalize({ mode: 'surcharge', surchargePct: 10 });
console.log(`\nthe product's own card-fee rules: a 10% surcharge setting is stored as ${pol.surchargePct}%; on a debit card: ${JSON.stringify(CF.quote(CF.normalize({ mode: 'surcharge', surchargePct: 3 }), { amount: 20, method: 'card', funding: 'debit', channel: 'online' }).label || CF.quote(CF.normalize({ mode: 'surcharge', surchargePct: 3 }), { amount: 20, method: 'card', funding: 'debit', channel: 'online' }))}`);
