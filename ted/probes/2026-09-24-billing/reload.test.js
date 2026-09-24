const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
test('two instant triggers at once (two quick POS sales)', () => {
  const r = runEdge('canteen-auto-reload', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.users = { pos: 'u-counselor' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
T.tables.camp_users = [{ camp_id: 'camp1', user_id: 'u-counselor' }];
// the stored account state: $3 left, threshold $5, reload $50 once a day
let state: any = { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_P', thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 50 };
T.rpc.canteen_autoreload_accounts = () => [{ camp_id: 'camp1', resolvable: true, person_id: 7, camper_name: 'Avi', account: { balance: 3, autoReload: JSON.parse(JSON.stringify(state)) } }];
T.rpc.update_canteen_autoreload_state = (a: any) => { state = a.p_autoreload; return { success: true }; };
T.fetch = async (url: string) => { if (url.endsWith('/payment_intents')) { await new Promise(r => setTimeout(r, 300)); return { id: 'pi_' + T.fetches.length, status: 'succeeded' }; } return {}; };
// fire the same POS-sale call twice at once
let real: any;
Object.defineProperty(T, 'handler', { get() { return async (req: Request) => {
  const mk = () => new Request('http://edge.test/fn', { method: 'POST', headers: { Authorization: 'Bearer pos', 'content-type': 'application/json' }, body: JSON.stringify({ campId: 'camp1', camperId: 7 }) });
  const [a] = await Promise.all([real(mk()), real(mk())]); return a; }; }, set(h) { real = h; } });
T.request = { body: {} };
`);
  const pis = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));
  console.log('card charges made:', pis.length, pis.map(p => new URLSearchParams(p.body).get('amount')));
});
