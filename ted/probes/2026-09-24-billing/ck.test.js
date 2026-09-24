const test = require('node:test');
const crypto = require('crypto');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
function signed(fields) {
  const body = new URLSearchParams(fields).toString();
  const pairs = [...new URLSearchParams(body).entries()].map(([k, v]) => [k.toLowerCase(), v]).sort((a, b) => a[0] < b[0] ? -1 : 1);
  return { body, sig: md5(pairs.map(p => p[1]).join('') + 'PIN') };
}
const transform = s => s.replace(/import md5 from "https:\/\/esm\.sh\/js-md5@[^"]+";/, 'import { createHash } from "node:crypto"; const md5 = (x: string) => createHash("md5").update(x).digest("hex");');
const recent = new Date().toISOString();
const W = (intents) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.rpc._admin_get_processor_credential = () => ({ success: true, processorKey: 'cardknox', credentials: { apiKey: 'k', webhookPin: 'PIN' } });
T.rpc.get_cardknox_checkout_intent = () => ({ success: false });
T.tables.cardknox_checkout_intents = ${JSON.stringify(intents)};
T.rpc._record_registration_deposit = (a: any) => { (T as any).credited = a; return { success: true }; };
`;
const dep = (ref, enr, fam) => ({ reference: ref, camp_id: 'camp1', kind: 'registration_deposit', status: 'pending', amount_cents: 25000, enrollment_id: enr, created_at: recent, family_key: fam || null });
test('two families with a $250 deposit pending; one pays', () => {
  const { body, sig } = signed({ xAmount: '250.00', xRefNum: '9001', xResponseResult: 'Approved' });
  const r = runEdge('cardknox-webhook', W([dep('ckrd_A', 'enr_A'), dep('ckrd_B', 'enr_B')]) +
    `T.request = { url: 'http://edge.test/fn?campId=camp1', headers: { 'ck-signature': '${sig}', 'content-type': 'application/x-www-form-urlencoded' }, rawBody: '${body}' };`, { transform });
  console.log('A: status', r.status, JSON.stringify(r.body), '| deposit recorded:', r.rpcs.some(x => x.name === '_record_registration_deposit'));
});
test('an office/autopay cc:sale (xInvoice CI-...) posts back while one $250 deposit is pending', () => {
  const { body, sig } = signed({ xAmount: '250.00', xRefNum: '9002', xResponseResult: 'Approved', xInvoice: 'CI-lz9abc' });
  const r = runEdge('cardknox-webhook', W([dep('ckrd_A', 'enr_A')]) +
    `T.request = { url: 'http://edge.test/fn?campId=camp1', headers: { 'ck-signature': '${sig}', 'content-type': 'application/x-www-form-urlencoded' }, rawBody: '${body}' };`, { transform });
  const c = r.rpcs.find(x => x.name === '_record_registration_deposit');
  console.log('B: status', r.status, '| deposit recorded for', c && c.args.p_enroll_id, 'ref', c && c.args.p_reference);
});
