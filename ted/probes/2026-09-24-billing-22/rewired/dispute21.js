// Probe (21st pass, dispute21). The REAL stripe-webhook and the REAL nightly
// runner (charge-due-installments) at dc83cf0 on real SQL (full chain incl. the
// edited 288). Hunts for families whose disputed card can still be charged:
//   H1  Hazel pays by hand (plan autopay OFF), card on file; payment disputed →
//       paused? Then autopay is switched on (office or parent) → a night → charged?
//   H2  Fern has no plan at all; disputed; a new autopay plan is set up → night?
//   H3  Ash still has the older single `plan` (installments, autopay on) that the
//       server functions all support (215/233/269) → disputed → paused? night?
//   H4  Rose2: two disputes; A lost; the owner presses Resume while B is open
//   K1  control: Kiwi (plans[] autopay) disputed → held
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges, runEdge } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5821 });
const OWNER = '0ed21000-0000-0000-0000-0000000000a1';
const C = '0ed21000-0000-0000-0000-000000000001';
const TODAY = new Date().toISOString().split('T')[0];
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
const qo = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
try {
  const plan = (id, extra) => Object.assign({ id, dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false }, extra || {});
  const fam = (name, tok, extra) => Object.assign({ name, camperIds: [name + ' Kid'], cardOnFile: true, stripeCustomerId: 'cus_' + tok, stripePaymentMethodId: 'pm_' + tok,
    entries: [{ id: 'c_' + tok, kind: 'charge', amount: 2000, reason: 'tuition', date: '2026-05-01' }] }, extra || {});
  const fams = {
    hazel: fam('Hazel', 'hazel', { plans: [plan('plan_hazel', { autopay: false })] }),
    fern: fam('Fern', 'fern', {}),
    ash: fam('Ash', 'ash', { charges: [{ id: 'ch_ash', amount: 2000, description: 'Tuition' }], plan: { autopay: true, installments: [{ dueDate: '2020-01-01', amount: 500, status: 'pending' }, { dueDate: '2099-01-01', amount: 500, status: 'pending' }] } }),
    kiwi: fam('Kiwi', 'kiwi', { plans: [plan('plan_kiwi')] }),
    rose2: fam('Rose2', 'rose2', { plans: [plan('plan_rose2')] }),
  };
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t21');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Dispute Camp', 'stripe');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Dov Gold', 'Dov Gold');
     SELECT public.canteen_account_save('${C}', 'Dov Gold', '{"balance": 0, "camperId": 1}'::jsonb);
     INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', ${lit(fams)}));`);
  qo(`SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);

  const owes = (k) => q(`SELECT public.family_ledger_balance(public.camp_family('${C}','${k}'))`);
  const mark = (k) => { const f = JSON.parse(q(`SELECT public.camp_family('${C}','${k}')::text`)); const b = (f.plans || [])[0] && f.plans[0].collectionBlocked; return b ? JSON.stringify({ reason: b.reason, disputeId: b.disputeId, nextRetryAt: b.nextRetryAt, attempts: b.attempts }) : 'none'; };
  const due = (k) => q(`SELECT public.plan_due_for('${C}'::uuid, '${k}', 'plan_${k}', '${TODAY}')::text`);
  const pauseNotes = (k) => q(`SELECT count(*) FROM notifications WHERE camp_id='${C}' AND source='autopay_blocked' AND source_id LIKE '${k}:chargeback:%'`);
  const wallet = () => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=1`);

  const RPCS = ['credit_canteen_balance_from_stripe', 'record_external_refund', 'resolve_chargeback', 'camp_families_object', 'hold_autopay_for_dispute', 'note_dispute_lost',
    'record_canteen_stripe_reversal', 'claim_refund_failure_alert', 'release_refund_failure_alert', 'append_camp_payment',
    'reverse_failed_stripe_refund', 'undo_card_fee_return', '_record_registration_deposit', '_record_registration_card', 'record_link_photo_purchase'];
  function deliver(event, stripe) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    const env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
    const scen = `
T.env = ${JSON.stringify(env)};
T.tables.camps = [{ id: '${C}', owner: '${OWNER}', payment_processor_key: 'stripe' }];
${bridge(db, RPCS, [])}
T.rpc.record_chargeback = (a: any) => {
  const L = (v: any) => v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
  const out = (T as any).__q('SELECT public.record_chargeback(p_camp_id => ' + L(a.p_camp_id) + '::uuid, p_dispute_id => ' + L(a.p_dispute_id)
    + ', p_refs => ARRAY[' + (a.p_refs || []).map(L).join(',') + ']::text[], p_amount => ' + Number(a.p_amount) + ', p_reason => ' + L(a.p_reason) + ', p_status => ' + L(a.p_status) + ')::text');
  return JSON.parse(out);
};
const ST: any = ${JSON.stringify(stripe || {})};
T.fetch = async (url: string, init: any) => {
  for (const k of Object.keys(ST)) if (url.includes(k)) return ST[k];
  return { __status: 404, error: { message: 'No such object' } };
};
T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=' + ${JSON.stringify(sig)} }, rawBody: ${JSON.stringify(body)} }];`;
    const r = runEdges(['stripe-webhook'], scen);
    return { status: r.responses[0].status, emails: (r.emails || []).length, log: (r.logs || []).join(' | ').slice(0, 400) };
  }
  let n = 0;
  const pay = (k, pi, cents) => deliver({ id: 'evt_p' + (n++), type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: pi, object: 'payment_intent', amount: cents, amount_received: cents, status: 'succeeded', payment_method_types: ['card'], metadata: { campId: C, familyKey: k, familyName: k } } } });
  const ST = (k, pi) => ({ ['/payment_intents/' + pi]: { id: pi, metadata: { campId: C, familyKey: k } }, ['/charges/ch_' + pi]: { id: 'ch_' + pi, payment_intent: pi, metadata: { campId: C, familyKey: k } } });
  const dsp = (type, id, pi, cents, status) => ({ id: 'evt_d' + (n++), type, created: Math.floor(Date.now() / 1000),
    data: { object: { id, object: 'dispute', amount: cents, charge: 'ch_' + pi, payment_intent: pi, reason: 'fraudulent', status, metadata: {} } } });


  const anyMark = (k) => { const f = JSON.parse(q(`SELECT public.camp_family('${C}','${k}')::text`));
    const ps = Array.isArray(f.plans) ? f.plans : (f.plan ? [f.plan] : []);
    const b = ps.map(p => p && p.collectionBlocked).filter(Boolean)[0]; return b ? JSON.stringify({ reason: b.reason, disputeIds: b.disputeIds }) : 'none'; };
  // N1 / N2 — the real nightly runner on the same database
  const RUN_RPCS = ['camp_families_object', 'camp_payments_array', 'plan_due_for', 'record_autopay_charge', 'hold_autopay_charge', 'flag_plan_collection', 'flag_expiring_cards'];
  q(`CREATE TABLE ted_sales (id serial, who text, cents int)`);
  function night() {
    const scen = `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron', STRIPE_SECRET_KEY: 'sk_test' };
T.tables.camp_state_kv = [{ camp_id: '${C}', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: '${C}', name: 'Camp', payment_processor_key: null }];
${bridge(db, RUN_RPCS, [])}
T.rpc.retry_failed_tip_transfers = () => [];
const __qq = (T as any).__q;
T.fetch = (url: string, init: any) => {
  if (init && init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(String(init.body || '')); const who = String(p.get('customer') || '');
    __qq("INSERT INTO ted_sales (who, cents) VALUES ('" + who + "', " + Number(p.get('amount')) + ")");
    return { id: 'pi_n_' + who + '_' + __qq("SELECT count(*) FROM ted_sales"), status: 'succeeded', amount: Number(p.get('amount')) };
  }
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
    const r = runEdge('charge-due-installments', scen);
    return (r.body && r.body.details || []).filter(d => d.family).map(d => `${d.family}:${d.result}`);
  }
  const sales = () => q(`SELECT coalesce(string_agg(who || ' $' || (cents/100.0)::numeric(10,2), ', ' ORDER BY id), 'none') FROM ted_sales`);

  for (const k of ['hazel', 'fern', 'ash', 'kiwi', 'rose2']) pay(k, 'pi_' + k, 100000);
  console.log('H1/H2/H3/K1. each paid $1,000 by card; each payment disputed (needs_response)');
  for (const k of ['hazel', 'fern', 'ash', 'kiwi']) deliver(dsp('charge.dispute.created', 'dp_' + k, 'pi_' + k, 100000, 'needs_response'), ST(k, 'pi_' + k));
  for (const k of ['hazel', 'fern', 'ash', 'kiwi']) console.log(`    ${k}: owes $${owes(k)}, pause ${anyMark(k)}, chargeback notices ${pauseNotes(k)}`);
  check(/chargeback/.test(anyMark('kiwi')), 'K1 control: an autopay family is paused', anyMark('kiwi'));
  check(/chargeback/.test(anyMark('ash')), 'H3 the older single-plan family is paused too', anyMark('ash'));
  // H1: autopay switched on for Hazel during the dispute (the plan otherwise unchanged)
  let f = JSON.parse(q(`SELECT public.camp_family('${C}','hazel')::text`)); f.plans[0].autopay = true;
  q(`SELECT public.camp_family_save('${C}', 'hazel', ${lit(f)})`);
  // H2: a new autopay plan for Fern during the dispute
  f = JSON.parse(q(`SELECT public.camp_family('${C}','fern')::text`)); f.plans = [plan('plan_fern')];
  q(`SELECT public.camp_family_save('${C}', 'fern', ${lit(f)})`);
  const n1 = night();
  console.log(`    night: ${JSON.stringify(n1)}; charges: ${sales()}`);
  check(!/cus_hazel/.test(sales()), 'H1 autopay switched on mid-dispute does not charge the disputed card', sales());
  check(!/cus_fern/.test(sales()), 'H2 a new autopay plan mid-dispute does not charge the disputed card', sales());
  check(!/cus_ash/.test(sales()), 'H3 the older single-plan family is not charged mid-dispute', sales());
  check(!/cus_kiwi/.test(sales()), 'K1 control not charged', sales());

  console.log('\nH4. Rose2: two disputes (A on pi_rose2, B on a second $500); A lost; owner resumes');
  pay('rose2', 'pi_rose2b', 50000);
  deliver(dsp('charge.dispute.created', 'dp_r2A', 'pi_rose2', 100000, 'needs_response'), ST('rose2', 'pi_rose2'));
  deliver(dsp('charge.dispute.created', 'dp_r2B', 'pi_rose2b', 50000, 'needs_response'), ST('rose2', 'pi_rose2b'));
  deliver(dsp('charge.dispute.closed', 'dp_r2A', 'pi_rose2', 100000, 'lost'), ST('rose2', 'pi_rose2'));
  const before = anyMark('rose2');
  const res = qo(`SELECT public.resume_autopay_after_dispute('${C}', 'rose2')::text`);
  console.log(`    after A lost: ${before}; resume → ${res}; pause now ${anyMark('rose2')} (dispute B still open)`);
  check(true, 'H4 (recorded; the owner resumed by hand)', anyMark('rose2'));
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
