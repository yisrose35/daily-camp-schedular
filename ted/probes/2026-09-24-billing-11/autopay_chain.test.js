// Probe (11th pass, TED-123). The REAL charge-due-installments runner
// (tests/edge_harness.js), several camps listed out of order, families with
// awkward keys (capitals, digits, accents), every family with $500 due tonight
// on Cardknox. The run is made to run out of time and hand on; each
// continuation is fed exactly the body the run POSTed to itself. Across the
// whole chain: is every family charged exactly once? any skipped, any twice?
// does the chain end? does the 30-run cap hold, and what happens to the rest?
// Run: node --test ted/probes/2026-09-24-billing-11/autopay_chain.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const TODAY = new Date().toISOString().split('T')[0];

// camp id -> family keys (listed out of order on purpose)
function world(nPerCamp) {
  const camps = ['c9-camp', '0a-camp', 'b5-camp', 'B5-camp'];
  const keysBase = ['zed', 'Alpha', 'mike', '10', '9', 'émile', 'alpha', 'Zed_2'];
  const w = {};
  for (const c of camps) {
    w[c] = [];
    for (let i = 0; i < nPerCamp; i++) w[c].push(keysBase[i % keysBase.length] + (i >= keysBase.length ? '_' + i : ''));
  }
  return w;
}

function scenario(w, body, budget, delayMs) {
  const plan = (id) => ({ id, dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false });
  const fams = {};
  let tok = 0;
  for (const [c, keys] of Object.entries(w)) {
    fams[c] = {};
    for (const k of keys) { tok++; fams[c][k] = { name: c + '/' + k, camperIds: [k], cardOnFile: true, byopCustomerRef: c + '|' + k,
      byopProcessor: 'cardknox', charges: [{ amount: 1000 }], plans: [plan('p_' + tok)] }; }
  }
  return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron', STRIPE_SECRET_KEY: 'sk_test', AUTOPAY_TIME_BUDGET_MS: '${budget}' };
const FAMS: Record<string, any> = ${JSON.stringify(fams)};
T.tables.camp_state_kv = Object.keys(FAMS).map((c) => ({ camp_id: c, key: 'campistryMe', value: { enrollments: {}, sessions: [] } }));
T.tables.camps = Object.keys(FAMS).map((c) => ({ id: c, name: c, payment_processor_key: 'cardknox' }));
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck', sourceKey: 's', pin: 'p' } });
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = (a: any) => { (T.tables.__expiry = T.tables.__expiry || []).push(a.p_camp_id); return { expired: 0, expiringSoon: 0 }; };
T.rpc.retry_failed_tip_transfers = () => { T.tables.__tips = (T.tables.__tips || 0) + 1; return []; };
T.rpc.record_processor_transaction = () => ({ success: true });
T.rpc.record_autopay_charge = () => ({ success: true, balance: 500 });
T.rpc.flag_plan_collection = () => ({ success: true });
T.rpc.hold_autopay_charge = () => ({ success: true });
T.rpc.camp_families_object = (a: any) => FAMS[a.p_camp_id];
T.rpc.plan_due_for = () => ({ index: 0, dueDate: '${TODAY}', amount: 500 });
T.tables.__sales = [];
let n = 0;
T.fetch = async (url: string, init: any) => {
  const b = String(init.body || '');
  if (b.includes('cc%3Asale')) {
    ${delayMs ? `await new Promise((r) => setTimeout(r, ${delayMs}));` : ''}
    T.tables.__sales.push(new URLSearchParams(b).get('xToken'));
    n++; return 'xResult=A&xRefNum=' + (9000 + n) + '&xStatus=Approved';
  }
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: ${JSON.stringify(body)} };`;
}

function chain(w, budget, delayMs) {
  let body = {}, runs = 0;
  const sales = [], expiry = [], parts = [];
  let tips = 0, last;
  for (;;) {
    runs++;
    const r = runEdge('charge-due-installments', scenario(w, body, budget, delayMs));
    sales.push(...(r.tables.__sales || []));
    expiry.push(...(r.tables.__expiry || []));
    tips += r.tables.__tips || 0;
    parts.push((r.tables.__sales || []).length);
    last = r;
    const self = r.fetches.filter((f) => /\/functions\/v1\/charge-due-installments$/.test(f.url));
    if (r.body.done !== false || !self.length) break;
    body = JSON.parse(self[0].body);
    if (runs > 60) break;   // guard for the probe itself
  }
  return { runs, sales, expiry, tips, parts, last };
}

test('every family charged exactly once across the chain (1 family per run)', () => {
  const w = world(6);   // 4 camps × 6 = 24 families, under the 30-run cap
  const c = chain(w, -1, 0);
  const expected = Object.entries(w).flatMap(([cp, ks]) => ks.map((k) => cp + '|' + k)).sort();
  const got = c.sales.slice().sort();
  const twice = got.filter((x, i) => got.indexOf(x) !== i);
  const missing = expected.filter((x) => !got.includes(x));
  console.log(`  runs ${c.runs}, charged ${c.sales.length} of ${expected.length}, twice ${JSON.stringify(twice)}, missing ${JSON.stringify(missing)}, per run ${JSON.stringify(c.parts)}`);
  console.log(`  card-expiry check per camp: ${JSON.stringify(c.expiry)} | tip retry ran ${c.tips}× | last answer done=${c.last.body.done}`);
  assert.deepStrictEqual(twice, []);
  assert.deepStrictEqual(missing, []);
});

test('several families per run (a real clock: each sale takes 25 ms, budget 60 ms)', () => {
  const w = world(5);
  const c = chain(w, 60, 25);
  const expected = Object.entries(w).flatMap(([cp, ks]) => ks.map((k) => cp + '|' + k)).sort();
  const got = c.sales.slice().sort();
  const twice = got.filter((x, i) => got.indexOf(x) !== i);
  const missing = expected.filter((x) => !got.includes(x));
  console.log(`  runs ${c.runs}, charged ${c.sales.length} of ${expected.length}, twice ${JSON.stringify(twice)}, missing ${JSON.stringify(missing)}, per run ${JSON.stringify(c.parts)}`);
  assert.deepStrictEqual(twice, []);
  assert.deepStrictEqual(missing, []);
});

test('more families than 30 runs can reach: what happens to the rest?', () => {
  const w = world(9);   // 36 families, 1 per run
  const c = chain(w, -1, 0);
  const expected = Object.entries(w).flatMap(([cp, ks]) => ks.map((k) => cp + '|' + k));
  console.log(`  runs ${c.runs}, charged ${c.sales.length} of ${expected.length}; last run answered done=${c.last.body.done}, resumeAfter=${JSON.stringify(c.last.body.resumeAfter)}`);
  console.log('  last run logs: ' + JSON.stringify((c.last.logs || []).filter((l) => /stopped for time|NOT continuing/.test(String(l)))).slice(0, 300));
  // the next night starts from the beginning again: are those already charged tonight skipped?
});
