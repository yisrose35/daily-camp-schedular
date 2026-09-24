// Probe (9th pass, new hunt). The REAL nightly autopay runner
// (charge-due-installments) at a Cardknox camp. Two families, Gold then
// Silver, each with a $500 instalment due tonight.
//   A. Cardknox takes Gold's $500, then the connection drops before the
//      answer is read (fetch throws). What happens to Gold's record, and does
//      Silver get charged tonight at all?
//   B. The next night, from the same records (the runner wrote nothing for
//      Gold, and cardknox-webhook does not book a sale with an unknown
//      CI- invoice — TED-071), is Gold charged again?
//   C. Banquest's gateway answers 504 with no body (the sale may have gone
//      through). What does the runner book?
// Run: node --test ted/probes/2026-09-24-billing-9/autopay_lost_answer.test.js
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');
const TODAY = new Date().toISOString().split('T')[0];

function night(proc, mode) {
  const plan = (id) => ({ id, dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false });
  return `
const TODAY = '${TODAY}';
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: '${proc}' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck', sourceKey: 's', pin: 'p' } });
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.retry_failed_tip_transfers = () => [];
T.rpc.record_processor_transaction = () => ({ success: true });
T.rpc.record_autopay_charge = (a: any) => ({ success: true, balance: 500 });
T.rpc.flag_plan_collection = () => ({ success: true });
T.rpc.camp_families_object = () => ({
  gold:   { name: 'Gold',   camperIds: ['Avi'],  cardOnFile: true, byopCustomerRef: '111', byopProcessor: '${proc}', charges: [{ amount: 1000 }], plans: [${JSON.stringify(plan('plan_g'))}] },
  silver: { name: 'Silver', camperIds: ['Dina'], cardOnFile: true, byopCustomerRef: '222', byopProcessor: '${proc}', charges: [{ amount: 1000 }], plans: [${JSON.stringify(plan('plan_s'))}] } });
T.rpc.plan_due_for = () => ({ index: 0, dueDate: TODAY, amount: 500 });
T.tables.__sales = [];
T.fetch = (url: string, init: any) => {
  const body = String(init.body || '');
  if (body.includes('cc%3Asale')) {
    const tok = new URLSearchParams(body).get('xToken');
    T.tables.__sales.push((tok === '111' ? 'Gold' : 'Silver') + ' $' + new URLSearchParams(body).get('xAmount'));
    if (${JSON.stringify(mode)} === 'drop' && tok === '111') throw new Error('connection reset by peer');   // money moved, answer lost
    return 'xResult=A&xRefNum=' + (tok === '111' ? '9001' : '9002') + '&xStatus=Approved';
  }
  if (url.endsWith('/transactions/charge')) {
    const src = JSON.parse(body).source;
    T.tables.__sales.push((src === 'tkn-111' ? 'Gold' : 'Silver') + ' $' + JSON.parse(body).amount + ' (Banquest)');
    if (${JSON.stringify(mode)} === '504' && src === 'tkn-111') return { __status: 504 };
    return { status_code: 'A', status: 'Approved', reference_number: src === 'tkn-111' ? 7001 : 7002 };
  }
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
}

// Deno's std serve answers 500 when the handler throws; the harness has no such
// wrapper, so add the same one after the function loads.
const DENO_ONERROR = { transform: (fn) => fn + "\n{ const T = (globalThis as any).__T; const h = T.handler; T.handler = async (r: any) => { try { return await h(r); } catch (e) { T.tables.__thrown = [String((e as Error).message)]; return new Response('Internal Server Error', { status: 500 }); } }; }\n" };
const recorded = (r) => r.rpcs.filter(c => c.name === 'record_autopay_charge').map(c => c.args.p_family_key + ':' + c.args.p_amount + (c.args.p_reason ? ' (' + c.args.p_reason + ')' : ''));

test('A+B: Cardknox answer lost for the first family', () => {
  const n1 = runEdge('charge-due-installments', night('cardknox', 'drop'), DENO_ONERROR);
  console.log(`# A night 1: runner answered HTTP ${n1.status} (threw: ${JSON.stringify(n1.tables.__thrown || [])}) | card sales made ${JSON.stringify(n1.tables.__sales)} | booked ${JSON.stringify(recorded(n1))}`);
  const n2 = runEdge('charge-due-installments', night('cardknox', 'ok'));
  console.log(`# B night 2 (Gold still unbooked): card sales made ${JSON.stringify(n2.tables.__sales)} | booked ${JSON.stringify(recorded(n2))}`);
  console.log('#   Gold paid twice for one $500 instalment if night 1\'s sale went through; Silver waited a night.');
});

test('C: Banquest 504 with no body', () => {
  const r = runEdge('charge-due-installments', night('banquest', '504'));
  console.log(`# C: runner answered HTTP ${r.status} | sales ${JSON.stringify(r.tables.__sales)} | booked ${JSON.stringify(recorded(r))} | flag ${JSON.stringify(r.rpcs.filter(c => c.name === 'flag_plan_collection').map(c => c.args.p_reason + ': ' + c.args.p_detail))}`);
});
