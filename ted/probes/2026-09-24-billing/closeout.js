// Proof: closing out a camper's canteen money (default "roll forward", or cash/check/
// donate) now posts a charge to the FAMILY's tuition ledger; the canteen account is
// never debited by this path.
const R = '/home/user/daily-camp-schedular';
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(R + '/campistry_me.js', 'utf8');
function cut(name) { const at = src.indexOf('function ' + name + '('); let i = src.indexOf('{', at), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(at, i + 1); }
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(R + '/campistry_billing_core.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(R + '/campistry_closeout.js', 'utf8'), ctx);
vm.runInContext(`
var families={gold:{name:'Gold',camperIds:['Avi Gold'],balance:0,
  entries:[{id:'le_t',kind:'charge',amount:1000,reason:'tuition'},{id:'le_p',kind:'payment',amount:1000,reason:'card'}]}};
var curPage='billing',saves=0;
function save(){saves++} function closeModal(){} function renderBilling(){} function toast(m){console.log('toast:',m)}
function today(){return '2026-08-20'} function _camperLabel(k){return k}
function _billingCore(){return window.BillingCore}
function _closeoutAPI(){return window.CampistryCloseout}
` + cut('_postLedgerCharge') + '\n' + cut('_applyCloseout'), ctx);
vm.runInContext(`
var C=window.CampistryCloseout;
console.log('default canteen disposition:', C.normalize({}).canteen);
var plan=C.plan({familyCredit:0,refundableToCard:0,campers:[{name:'Avi Gold',canteen:6,disposition:C.normalize({}).canteen}],familyDisposition:null,policy:{}});
console.log('steps:', JSON.stringify(plan.steps.map(function(s){return {kind:s.kind,do:s.do,amount:s.amount}})));
console.log('family ledger balance before:', window.BillingCore.balance(families.gold));
_applyCloseout('gold',plan);
console.log('family charges[]:', JSON.stringify(families.gold.charges.map(function(c){return c.category+' $'+c.amount+' '+c.description})));
console.log('family ledger balance after:', window.BillingCore.balance(families.gold));
`, ctx);
