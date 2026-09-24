const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('/home/user/daily-camp-schedular/campistry_me.js', 'utf8');
function cut(n) { const at = src.indexOf('function ' + n + '('); let i = src.indexOf('{', at), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(at, i + 1); }
const ctx = {}; vm.createContext(ctx); vm.runInContext(cut('_mpBuildLedgerPlan') + cut('_planSchedule'), ctx);
// The office types: $1,000 on 1 June, then $200 on 1 July and 1 August. Family owes $1,400.
const typed = [{ n: 1, amount: 1000, dueDate: '2026-06-01' }, { n: 2, amount: 200, dueDate: '2026-07-01' }, { n: 3, amount: 200, dueDate: '2026-08-01' }];
const p = ctx._mpBuildLedgerPlan(null, typed, true, 1400);
console.log('saved plan:', JSON.stringify(p, ['dueDates', 'nextIndex', 'total', 'installments']));
console.log('what autopay will take:', ctx._planSchedule(p, 1400).map(i => i.dueDate + ' $' + i.amount).join(', '));
// The office schedules only $600 of a $1,400 balance (the rest is due from a grant)
const part = ctx._mpBuildLedgerPlan(null, [{ amount: 300, dueDate: '2026-06-01' }, { amount: 300, dueDate: '2026-07-01' }], true, 600);
console.log('office scheduled $600 of $1,400 -> autopay takes:', ctx._planSchedule(part, 1400).map(i => '$' + i.amount).join(' + '));
