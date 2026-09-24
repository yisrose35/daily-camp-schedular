// Proof: what the parent's portal shows for a plan with office-set amounts,
// against what autopay (BillingCore.planDue, same rule as SQL plan_due 264) charges.
const R = '/home/user/daily-camp-schedular', fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(R + '/campistry_link_parent.html', 'utf8');
const at = html.indexOf('function _lkPlanSchedule('); let i = html.indexOf('{', at), d = 0;
for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}' && --d === 0) break; }
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(html.slice(at, i + 1), ctx);
vm.runInContext(fs.readFileSync(R + '/campistry_billing_core.js', 'utf8'), ctx);
const plan = { id: 'p', autopay: true, dueDates: ['2026-06-01', '2026-07-01', '2026-08-01'], amounts: [1000, 200, 200], nextIndex: 0 };
console.log('parent portal shows:', JSON.stringify(ctx._lkPlanSchedule(plan, 1400).map(x => x.amount)));
const fam = { entries: [{ id: 't', kind: 'charge', amount: 1400, reason: 'tuition' }], plans: [plan] };
console.log('autopay charges on 1 Jun:', JSON.stringify(ctx.window.BillingCore.planDue(fam, plan, '2026-06-02')));
