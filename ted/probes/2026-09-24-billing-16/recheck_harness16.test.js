// 16th-pass corrected copy: the pretend camp is in session today (TED-143: auto-reload charges only then). No other change.
// Re-checks of TED-063, 064, 075 with state carried between runs / a claim that
// behaves like the real claim_refund_intent (insert-if-absent).
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const TODAY = new Date().toISOString().split('T')[0];

test('TED-063 parent Pay Now (signed in) and the office pay link', () => {
  const W = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { parentTok: 'u-parent' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', stripe_account_id: 'acct_CAMP', stripe_charges_enabled: true }];
T.rpc.camp_family = (a: any) => ({ gold: { name: 'Gold' }, silver: { name: 'Silver' } } as any)[a.p_family_key] || null;
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold' }, silver: { name: 'Silver' } });
T.rpc.get_my_balance = () => ({ success: true, familyKey: 'gold', balance: 1000 });
T.fetch = (url: string) => url.endsWith('/checkout/sessions') ? { id: 'cs_1', url: 'https://checkout.stripe.com/x' } : {};`;
  const cases = [
    ['parent signed in, body names ANOTHER family (silver)', `{ headers: { Authorization: 'Bearer parentTok' }, body: {campId:'camp1',familyKey:'silver',familyName:'Gold',email:'p@x',amount:500} }`],
    ['office pay link (anon key), family gold', `{ headers: { Authorization: 'Bearer anon' }, body: {campId:'camp1',familyKey:'gold',familyName:'Gold',email:'p@x',amount:500} }`],
    ['no login, family not of this camp', `{ headers: { Authorization: 'Bearer anon' }, body: {campId:'camp1',familyKey:'zzz',email:'p@x',amount:500} }`],
  ];
  for (const [who, req] of cases) {
    const r = runEdge('stripe-checkout', W + `T.request = ${req};`);
    const s = r.fetches.find(f => f.url.endsWith('/checkout/sessions'));
    const p = s ? new URLSearchParams(s.body) : null;
    console.log(who, '=>', r.status, p ? ('destination ' + p.get('payment_intent_data[transfer_data][destination]') + ' | familyKey ' + p.get('payment_intent_data[metadata][familyKey]')) : JSON.stringify(r.body));
  }
});

test('TED-064 three nights, the hold carried from night to night', () => {
  let plan = { id: 'plan_b', dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false };
  let total = 0;
  for (const [n, heldStatus] of [[1, 'processing'], [2, 'processing'], [3, 'succeeded']]) {
    const r = runEdge('charge-due-installments', `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: {} }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.flag_plan_collection = () => ({ success: true });
T.rpc.record_autopay_charge = () => ({ success: true, balance: 500 });
T.rpc.hold_autopay_charge = () => ({ success: true });
T.rpc.camp_families_object = () => ({ famB: { name: 'Bank family', camperIds: ['A'], cardOnFile: true, stripeCustomerId: 'cus_B', plans: [${JSON.stringify(plan)}] } });
T.rpc.plan_due_for = () => ({ index: 0, dueDate: '${TODAY}', amount: 500 });
T.fetch = (url: string, init: any) => (init.method === 'POST' && url.endsWith('/payment_intents')) ? { id: 'pi_ach1', status: 'processing' }
   : url.includes('/payment_intents/pi_ach1') ? { id: 'pi_ach1', status: '${heldStatus}' } : {};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`);
    const debits = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents')).length;
    total += debits;
    const hold = r.rpcs.filter(x => x.name === 'hold_autopay_charge').map(x => x.args.p_hold);
    const rec = r.rpcs.filter(x => x.name === 'record_autopay_charge').map(x => x.args.p_amount);
    for (const h of hold) { if (h) plan = { ...plan, pendingCharge: h }; else { const { pendingCharge, ...rest } = plan; plan = rest; } }
    console.log(`night ${n} (Stripe says ${heldStatus} for the held debit): new debits ${debits} | recorded ${JSON.stringify(rec)} | hold now ${JSON.stringify(plan.pendingCharge || null)}`);
  }
  console.log('debits for one instalment over 3 nights:', total);
});

test('TED-075 two POS triggers at once, with an insert-if-absent claim', () => {
  const r = runEdge('canteen-auto-reload', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.users = { pos: 'u-counselor' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
T.tables.camp_users = [{ camp_id: 'camp1', user_id: 'u-counselor' }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { sessions: [{ name: 'Summer', startDate: '2000-01-01', endDate: '2999-12-31' }] } }]; // 16th pass: camp in session (TED-143)
let state: any = { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_P', thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 50 };
T.rpc.canteen_autoreload_accounts = () => [{ camp_id: 'camp1', resolvable: true, person_id: 7, camper_name: 'Avi', account: { balance: 3, autoReload: JSON.parse(JSON.stringify(state)) } }];
T.rpc.update_canteen_autoreload_state = (a: any) => { state = a.p_autoreload; return { success: true }; };
const claims: Record<string, boolean> = {};
T.rpc.claim_refund_intent = (a: any) => { const k = a.p_camp_id + '|' + a.p_key; if (claims[k]) return { claimed: false }; claims[k] = true; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_camp_id + '|' + a.p_key]; return true; };
T.fetch = async (url: string) => { if (url.endsWith('/payment_intents')) { await new Promise(r => setTimeout(r, 300)); return { id: 'pi_' + T.fetches.length, status: 'succeeded' }; } return {}; };
let real: any;
Object.defineProperty(T, 'handler', { get() { return async (req: Request) => {
  const mk = () => new Request('http://edge.test/fn', { method: 'POST', headers: { Authorization: 'Bearer pos', 'content-type': 'application/json' }, body: JSON.stringify({ campId: 'camp1', camperId: 7 }) });
  const [a] = await Promise.all([real(mk()), real(mk())]); return a; }; }, set(h) { real = h; } });
T.request = { body: {} };`);
  const pis = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));
  console.log('card charges made:', pis.length, '| Idempotency-Key:', pis[0] && pis[0].headers['Idempotency-Key']);
});
