// Proof: the office merges two family records (Billing's Merge Families). B has a
// $25 late fee that is already on B's ledger. The merge moves B's ledger entries
// and plans to A, but not B's charges[]. What does Billing's catch-up then do?
const R = '/home/user/daily-camp-schedular', fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(R + '/campistry_me.js', 'utf8');
const grab = n => { const at = src.indexOf('function ' + n + '('); let i = src.indexOf('{', at), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(at, i + 1); };
const ctx = { window: {}, console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(R + '/campistry_billing_core.js', 'utf8'), ctx);
vm.runInContext(`function _billingCore(){return window.BillingCore}
function save(){} function render(){} function toast(){} function _meAudit(){} var curPage='billing';
var families={
  a:{name:'Gold (mom)',camperIds:['Avi Gold'],entries:[{id:'le_ta',kind:'charge',amount:500,reason:'tuition',source:{enrollmentId:'e1'}}]},
  b:{name:'Gold (dad)',camperIds:['Avi Gold'],charges:[{id:'lf_b',category:'Late Fee',description:'Late fee',amount:25,date:'2026-07-01'}],
     entries:[{id:'le_tb',kind:'charge',amount:500,reason:'tuition',source:{enrollmentId:'e2'}},
              {id:'le_chg_lf_b',kind:'charge',amount:25,reason:'fee',source:{chargeId:'lf_b',category:'Late Fee'}}]}};
` + grab('_postLedgerCharge') + '\n' + grab('_postExistingCharges') + '\n' + grab('mergeFamiliesReconciled'), ctx);
vm.runInContext(`
var B=window.BillingCore;
console.log('before merge: A owes', B.balance(families.a), '+ B owes', B.balance(families.b), '=', B.balance(families.a)+B.balance(families.b));
mergeFamiliesReconciled('a','b',null);
console.log('after merge: A owes', B.balance(families.a), '| A.charges:', JSON.stringify(families.a.charges||[]));
var n=_postExistingCharges(families.a);
console.log('Billing catch-up on next load posted', n, 'entr(y/ies):', JSON.stringify(families.a.entries.slice(-1)));
console.log('A now owes', B.balance(families.a));
`, ctx);
