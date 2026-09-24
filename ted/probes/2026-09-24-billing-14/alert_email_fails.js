// Probe (14th pass, TED-137 follow-up). The platform alert for a failed refund
// is now claimed ONCE per refund. What if the alert email itself fails to send
// on the first delivery (Resend down for a minute)? Stripe re-sends the failure
// — does the email go then?
//
// The REAL stripe-webhook (tests/edge_harness.js), with the email sender made to
// fail on its first call only (Resend answering an error), and the once-only
// claims kept the way 278's claim_refund_failure_alert / the notice insert keep
// them (first → true, then false). Two cases:
//   A  a failed refund of a payment NO camp can be found for (TED-137's path)
//   B  a failed refund of a KNOWN camp's booked refund (the notice is the claim)
// Four deliveries each: refund.failed, a re-send, refund.updated, charge.refund.updated.
// Run: node ted/probes/2026-09-24-billing-14/alert_email_fails.js
'use strict';
const crypto = require('node:crypto');
const { runEdges } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');

function events(meta) {
  const obj = { id: 're_77', object: 'refund', amount: 2000, status: 'failed', failure_reason: 'expired_or_canceled_card',
                payment_intent: 'pi_77', charge: 'ch_77', metadata: meta, created: 1790000000 };
  return ['refund.failed', 'refund.failed', 'refund.updated', 'charge.refund.updated'].map((type, i) => {
    const body = JSON.stringify({ id: 'evt_' + i, type, created: Math.floor(Date.now() / 1000), data: { object: obj } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    return { headers: { 'stripe-signature': `t=${t},v1=${sig}` }, rawBody: body };
  });
}
function run(label, meta, extra) {
  const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
let sends = 0; (globalThis as any).__sent = [];
(globalThis as any).__send = async (m: any) => { sends++; if (sends === 1) return { data: null, error: { statusCode: 503, message: 'Resend is unavailable' } };
  (globalThis as any).__sent.push(m.subject); return { data: { id: 'em_' + sends }, error: null }; };
const claimed = new Set<string>();
T.rpc.claim_refund_failure_alert = (a: any) => { const f = !claimed.has(a.p_refund_id); claimed.add(a.p_refund_id); return f; };
T.rpc.reverse_failed_stripe_refund = (a: any) => { const f = !claimed.has('n:' + a.p_refund_id); claimed.add('n:' + a.p_refund_id);
  return { success: true, family: true, familyKey: 'gold', amount: 20, firstNotice: f }; };
T.fetch = async (url: string) => {
  if (url.includes('/payment_intents/')) return { id: 'pi_77', object: 'payment_intent', metadata: ${JSON.stringify(meta)} };
  if (url.includes('/charges/')) return { id: 'ch_77', object: 'charge', metadata: ${JSON.stringify(meta)} };
  if (url.includes('/refunds/re_77')) return { id: 're_77', object: 'refund', status: 'failed', amount: 2000, metadata: ${JSON.stringify(meta)} };
  return {};
};
${extra || ''}
T.requests = ${JSON.stringify(events(meta))};`;
  const r = runEdges(['stripe-webhook'], scen, { transform: (src) => src.replace('await resend.emails.send({', 'await (globalThis as any).__send({') });
  const sent = r.logs.filter(l => /risk alert email sent/.test(l)).length;
  const failedLog = r.logs.filter(l => /risk alert email failed/.test(l)).length;
  console.log(`${label}\n    HTTP ${r.responses.map(x => x.status).join('/')}; send attempts that failed: ${failedLog}; alert emails that went out: ${sent}`);
  return sent;
}
const a = run('A  no camp found (TED-137 path): the first alert email fails (Resend 503), then 3 more deliveries', {});
const b = run('B  known camp, booked refund (TED-131 path): the first alert email fails, then 3 more deliveries', { campId: 'camp-1', familyKey: 'gold' });
console.log(`\nresult: ${a === 0 && b === 0 ? 'NEITHER alert is ever sent once the first email fails (the claim is taken before the email)' : 'an alert went out on a later delivery'}`);
