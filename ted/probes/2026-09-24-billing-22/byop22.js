// Probe (22nd pass, byop22). The REAL byop-dispute-webhook (4889ba7) in the edge
// harness, with recorded database calls (no database needed for these answers).
//   Y1  set up the way BYOP_SETUP.md / PROCESSOR_ONBOARDING.md say (no
//       BYOP_DISPUTE_SECRET; the processor sends no x-webhook-secret header)
//       → is the dispute recorded? the family paused?
//   Y2  the database fails while POSTING the chargeback (record_chargeback
//       errors) → HTTP? paused? (a 200 means the processor never sends it again)
//   Y3  control: the pause write fails → 500 (the builder's claim)
//   Y4  control: all good → 200, posted + paused
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdge } = require(R + '/tests/edge_harness.js');
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const calls = (r, name) => r.rpcs.filter(c => c.name === name).length;
function byop(env, headers, extra) {
  const body = { xResponseRefnum: '9001', xStatus: 'Chargeback', xStatusReason: 'Fraud' };
  return runEdge('byop-dispute-webhook', `
T.env = ${JSON.stringify(Object.assign({ SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, env))};
T.rpc.record_chargeback = () => ({ success: true, familyKey: 'birch' });
T.rpc.hold_autopay_for_dispute = () => ({ success: true, changed: true });
${extra || ''}
T.request = { url: 'http://edge.test/byop-dispute-webhook?processor=cardknox&camp=camp1', headers: ${JSON.stringify(Object.assign({ 'content-type': 'application/json' }, headers))}, rawBody: ${JSON.stringify(JSON.stringify(body))} };`);
}
const y1 = byop({}, {});
console.log(`Y1 set up as the guides say (no secret, no header): HTTP ${y1.status} ${JSON.stringify(y1.body)}; posted ${calls(y1, 'record_chargeback')}, paused ${calls(y1, 'hold_autopay_for_dispute')}`);
console.log(`   log: ${(y1.logs || []).join(' | ').slice(0, 260)}`);
check(calls(y1, 'record_chargeback') === 1 && calls(y1, 'hold_autopay_for_dispute') === 1, 'Y1 a dispute on a camp set up by the guides is recorded and the card paused', `HTTP ${y1.status}`);

const y2 = byop({ BYOP_DISPUTE_SECRET: 'sek' }, { 'x-webhook-secret': 'sek' }, `T.rpc.record_chargeback = () => { throw new Error('canceling statement due to statement timeout'); };`);
console.log(`Y2 record_chargeback fails: HTTP ${y2.status} ${JSON.stringify(y2.body)}; paused ${calls(y2, 'hold_autopay_for_dispute')}`);
check(y2.status >= 500 || calls(y2, 'hold_autopay_for_dispute') === 1, 'Y2 a database failure while posting is sent again (5xx) or the card is still paused', `HTTP ${y2.status}, paused ${calls(y2, 'hold_autopay_for_dispute')}`);

const y3 = byop({ BYOP_DISPUTE_SECRET: 'sek' }, { 'x-webhook-secret': 'sek' }, `T.rpc.hold_autopay_for_dispute = () => { throw new Error('statement timeout'); };`);
console.log(`Y3 the pause write fails: HTTP ${y3.status}`);
check(y3.status === 500, 'Y3 a failed pause answers 500', String(y3.status));

const y4 = byop({ BYOP_DISPUTE_SECRET: 'sek' }, { 'x-webhook-secret': 'sek' });
console.log(`Y4 all good: HTTP ${y4.status}; posted ${calls(y4, 'record_chargeback')}, paused ${calls(y4, 'hold_autopay_for_dispute')}`);
check(y4.status === 200 && calls(y4, 'record_chargeback') === 1 && calls(y4, 'hold_autopay_for_dispute') === 1, 'Y4 control: posted and paused', String(y4.status));
console.log(`\n${bad} BAD`);
