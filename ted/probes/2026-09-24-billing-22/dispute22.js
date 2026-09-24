// Probe (22nd pass, dispute22). The REAL stripe-webhook, the REAL nightly runner
// (charge-due-installments) and the REAL stripe-charge at 4889ba7 on real SQL
// (full migration chain incl. the edited 288). Re-checks TED-200/201/202 and
// hunts around them.
//   D1  Hazel (hand-paying, plan autopay off), Fern (no plan), Ash (older single
//       plan), Kiwi (autopay) — each disputed: the FAMILY is paused? one notice?
//   D2  the night: all four held_for_dispute; control Olive (no dispute) charged
//   D3  Charge Card on the server (real stripe-charge): Hazel / Fern / Ash → 409,
//       nothing sent to Stripe; Olive → charged
//   D4  an office computer that loaded before the dispute saves Hazel (no pause
//       in its copy) → still paused; a page that sends a pause for Olive → not kept
//   D5  Rose: disputes A and B; A lost → Resume refused (1 open); B won → pause
//       stays (A lost) → Resume (no "anyway") allowed
//   D6  Wren: disputed, lost, the office resumes; then a LATE delivery of the same
//       dispute's funds_withdrawn (status needs_response — e.g. Stripe re-trying
//       an earlier failed delivery) → paused again? told? Resume says "open"?
//   D8  Moss: disputed; the office presses "Resume anyway"; the camp submits evidence (updated, under_review)
//   D7  Lark: the "closed: lost" message arrives before "created" (created's first
//       delivery failed and Stripe re-sent it later) → Resume says "still open"?
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges, runEdge } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5822 });
const OWNER = '0ed22000-0000-0000-0000-0000000000a1';
const C = '0ed22000-0000-0000-0000-000000000001';
const TODAY = new Date().toISOString().split('T')[0];
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const note = (label, detail) => console.log(`  NOTE ${label}   → ${detail}`);
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
    olive: fam('Olive', 'olive', { plans: [plan('plan_olive')] }),
    rose: fam('Rose', 'rose', { plans: [plan('plan_rose', { dueDates: ['2099-01-01'], count: 1 })] }),
    wren: fam('Wren', 'wren', { plans: [plan('plan_wren', { dueDates: ['2099-01-01'], count: 1 })] }),
    lark: fam('Lark', 'lark', { plans: [plan('plan_lark', { dueDates: ['2099-01-01'], count: 1 })] }),
    moss: fam('Moss', 'moss', { plans: [plan('plan_moss', { dueDates: ['2099-01-01'], count: 1 })] }),
  };
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t22');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Dispute Camp', 'stripe');
     INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', ${lit(fams)}));`);
  qo(`SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);

  const famOf = (k) => JSON.parse(q(`SELECT public.camp_family('${C}','${k}')::text`));
  const hold = (k) => { const h = famOf(k).disputeHold; return h ? JSON.stringify({ disputeIds: h.disputeIds, lostIds: h.lostIds }) : 'none'; };
  const pauseNotes = (k) => q(`SELECT count(*) FROM notifications WHERE camp_id='${C}' AND source='autopay_blocked' AND source_id LIKE '${k}:chargeback:%'`);
  const resume = (k, anyway) => qo(`SELECT public.resume_autopay_after_dispute('${C}', '${k}'${anyway ? ', true' : ''})::text`);

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
    return { status: r.responses[0].status, log: (r.logs || []).join(' | ').slice(0, 400) };
  }
  let n = 0;
  const pay = (k, pi, cents) => deliver({ id: 'evt_p' + (n++), type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: pi, object: 'payment_intent', amount: cents, amount_received: cents, status: 'succeeded', payment_method_types: ['card'], metadata: { campId: C, familyKey: k, familyName: k } } } });
  const ST = (k, pi) => ({ ['/payment_intents/' + pi]: { id: pi, metadata: { campId: C, familyKey: k } }, ['/charges/ch_' + pi]: { id: 'ch_' + pi, payment_intent: pi, metadata: { campId: C, familyKey: k } } });
  const dsp = (type, id, pi, cents, status) => ({ id: 'evt_d' + (n++), type, created: Math.floor(Date.now() / 1000),
    data: { object: { id, object: 'dispute', amount: cents, charge: 'ch_' + pi, payment_intent: pi, reason: 'fraudulent', status, metadata: {} } } });

  // ── the real runner ──
  const RUN_RPCS = ['camp_families_object', 'camp_payments_array', 'plan_due_for', 'record_autopay_charge', 'hold_autopay_charge', 'flag_plan_collection', 'flag_expiring_cards'];
  q(`CREATE TABLE ted_sales (id serial, via text, who text, cents int)`);
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
    __qq("INSERT INTO ted_sales (via, who, cents) VALUES ('night', '" + who + "', " + Number(p.get('amount')) + ")");
    return { id: 'pi_n_' + who + '_' + __qq("SELECT count(*) FROM ted_sales"), status: 'succeeded', amount: Number(p.get('amount')) };
  }
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
    const r = runEdge('charge-due-installments', scen);
    return (r.body && r.body.details || []).filter(d => d.family).map(d => `${d.family}:${d.result}`);
  }
  // ── the real stripe-charge (office Charge Card / Batch Charge) ──
  function chargeCard(k) {
    const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: '${OWNER}' };
T.tables.camps = [{ id: '${C}', owner: '${OWNER}', name: 'Dispute Camp', stripe_account_id: null, stripe_charges_enabled: false }];
${bridge(db, ['camp_families_object'], [])}
const __qq = (T as any).__q;
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_${k}', customer: 'cus_${k}' };
  if (url.includes('/payment_intents?customer=')) return { object: 'list', data: [], has_more: false };
  if (init && init.method === 'POST' && url.endsWith('/payment_intents')) {
    __qq("INSERT INTO ted_sales (via, who, cents) VALUES ('office', 'cus_${k}', 100000)");
    return { id: 'pi_office_${k}', status: 'succeeded', amount: 100000 };
  }
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_${k}', paymentMethodId: 'pm_${k}', amount: 1000, idempotencyKey: 'k_${k}_' + Date.now() } };`;
    const r = runEdge('stripe-charge', scen);
    return { status: r.status, error: r.body && r.body.error, disputed: r.body && r.body.disputed };
  }
  const sales = (via) => q(`SELECT coalesce(string_agg(who || ' $' || (cents/100.0)::numeric(10,2), ', ' ORDER BY id), 'none') FROM ted_sales WHERE via='${via}'`);

  // D1
  for (const k of Object.keys(fams)) pay(k, 'pi_' + k, 100000);
  console.log('D1. Hazel (hand-paying), Fern (no plan), Ash (older single plan), Kiwi (autopay) each paid $1,000 by card; each disputed');
  for (const k of ['hazel', 'fern', 'ash', 'kiwi']) {
    const r = deliver(dsp('charge.dispute.created', 'dp_' + k, 'pi_' + k, 100000, 'needs_response'), ST(k, 'pi_' + k));
    console.log(`    ${k}: HTTP ${r.status}; family pause ${hold(k)}; notices ${pauseNotes(k)}`);
  }
  for (const k of ['hazel', 'fern', 'ash', 'kiwi'])
    check(/dp_/.test(hold(k)) && pauseNotes(k) === '1', `D1 ${k}: the family is paused, one notice`, `${hold(k)}, ${pauseNotes(k)}`);
  const ashPlan = famOf('ash').plan.collectionBlocked;
  check(ashPlan && ashPlan.reason === 'chargeback', 'D1 Ash\'s older single plan carries the pause too', JSON.stringify(ashPlan));
  const hazelPlan = famOf('hazel').plans[0].collectionBlocked;
  check(hazelPlan && hazelPlan.reason === 'chargeback', 'D1 Hazel\'s autopay-off plan carries the pause too', JSON.stringify(hazelPlan));

  // D2 — autopay switched on for Hazel, a new autopay plan for Fern, during the dispute
  let f = famOf('hazel'); f.plans[0].autopay = true; delete f.plans[0].collectionBlocked;
  qo(`SELECT public.sync_camp_billing('${C}', ${lit({ hazel: f })}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);
  f = famOf('fern'); f.plans = [plan('plan_fern')];
  qo(`SELECT public.sync_camp_billing('${C}', ${lit({ fern: f })}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);
  const n1 = night();
  console.log(`\nD2. the office switches Hazel to autopay and gives Fern an autopay plan (page saves); the night: ${JSON.stringify(n1)}; charged: ${sales('night')}`);
  check(!/cus_(hazel|fern|ash|kiwi)/.test(sales('night')), 'D2 no disputed family charged by the night', sales('night'));
  check(/cus_olive \$500/.test(sales('night')), 'D2 control Olive charged by the night (her $500 instalment)', sales('night'));

  // D3
  console.log('\nD3. Charge Card on the server (real stripe-charge), each family');
  for (const k of ['hazel', 'fern', 'ash', 'kiwi', 'olive']) {
    const r = chargeCard(k);
    console.log(`    ${k}: HTTP ${r.status} ${r.disputed ? '(disputed) ' : ''}${String(r.error || '').slice(0, 120)}`);
  }
  check(!/cus_(hazel|fern|ash|kiwi)/.test(sales('office')), 'D3 no disputed family\'s card sent to Stripe', sales('office'));
  check(/cus_olive/.test(sales('office')), 'D3 control Olive charged', sales('office'));

  // D4
  const stale = JSON.parse(JSON.stringify(fams.hazel)); stale.notes = 'edited on an old computer';
  const oliveFake = famOf('olive'); oliveFake.disputeHold = { disputeIds: ['dp_fake'], lostIds: [] };
  qo(`SELECT public.sync_camp_billing('${C}', ${lit({ hazel: stale, olive: oliveFake })}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);
  console.log(`\nD4. an old computer saves Hazel (copy from before the dispute) and sends a made-up pause for Olive → Hazel ${hold('hazel')} (notes: ${famOf('hazel').notes}); Olive ${hold('olive')}`);
  check(/dp_hazel/.test(hold('hazel')) && famOf('hazel').notes === 'edited on an old computer', 'D4 the old computer\'s edit is kept, the pause is kept', hold('hazel'));
  check(hold('olive') === 'none', 'D4 a page cannot invent a pause', hold('olive'));

  // D5
  console.log('\nD5. Rose: two disputes (A $1,000, B $500); A lost; then B won');
  pay('rose', 'pi_roseb', 50000);
  deliver(dsp('charge.dispute.created', 'dp_rA', 'pi_rose', 100000, 'needs_response'), ST('rose', 'pi_rose'));
  deliver(dsp('charge.dispute.created', 'dp_rB', 'pi_roseb', 50000, 'needs_response'), ST('rose', 'pi_roseb'));
  let lostA = deliver(dsp('charge.dispute.closed', 'dp_rA', 'pi_rose', 100000, 'lost'), ST('rose', 'pi_rose'));
  const r1 = resume('rose');
  console.log(`    A lost (HTTP ${lostA.status}): pause ${hold('rose')}; Resume → ${r1}`);
  check(/"open": 1/.test(r1) && /dispute_open/.test(r1), 'D5 Resume refused while B is open, says 1 open', r1);
  const wonB = deliver(dsp('charge.dispute.closed', 'dp_rB', 'pi_roseb', 50000, 'won'), ST('rose', 'pi_roseb'));
  console.log(`    B won (HTTP ${wonB.status}): pause ${hold('rose')}`);
  check(/dp_rA/.test(hold('rose')) && !/dp_rB/.test(hold('rose')), 'D5 after B won, only lost A keeps the pause (the office decides)', hold('rose'));
  const r2 = resume('rose');
  console.log(`    Resume → ${r2}; pause ${hold('rose')}`);
  check(/"success": true/.test(r2) && hold('rose') === 'none', 'D5 Resume (no "anyway") allowed once nothing is open', `${r2} / ${hold('rose')}`);

  // D6
  console.log('\nD6. Wren: disputed → lost → the office resumes → a late funds_withdrawn for the same dispute arrives');
  deliver(dsp('charge.dispute.created', 'dp_w', 'pi_wren', 100000, 'needs_response'), ST('wren', 'pi_wren'));
  deliver(dsp('charge.dispute.closed', 'dp_w', 'pi_wren', 100000, 'lost'), ST('wren', 'pi_wren'));
  const r3 = resume('wren');
  const afterResume = hold('wren');
  const late = deliver(dsp('charge.dispute.funds_withdrawn', 'dp_w', 'pi_wren', 100000, 'needs_response'), ST('wren', 'pi_wren'));
  const afterLate = hold('wren');
  const r4 = resume('wren');
  console.log(`    resume → ${r3}; pause after resume: ${afterResume}`);
  console.log(`    late funds_withdrawn HTTP ${late.status}; pause now ${afterLate}; notices ${pauseNotes('wren')}; Resume again → ${r4}`);
  console.log(`    owes $${q(`SELECT public.family_ledger_balance(public.camp_family('${C}','wren'))`)} (paid 1,000 of 2,000; chargeback 1,000 → 2,000)`);
  check(afterLate === 'none', 'D6 a late message for a dispute already lost and resumed does not pause the family again', afterLate);
  check(!/dispute_open/.test(r4), 'D6 Resume does not call a lost dispute "still open"', r4);
  resume('wren', true);

  // D7
  console.log('\nD7. Lark: "closed: lost" is delivered before "created" (created re-sent later by Stripe)');
  const earlyLost = deliver(dsp('charge.dispute.closed', 'dp_l', 'pi_lark', 100000, 'lost'), ST('lark', 'pi_lark'));
  const lateCreated = deliver(dsp('charge.dispute.created', 'dp_l', 'pi_lark', 100000, 'needs_response'), ST('lark', 'pi_lark'));
  const r5 = resume('lark');
  console.log(`    closed(lost) first: HTTP ${earlyLost.status} ${earlyLost.log.slice(0, 160)}`);
  console.log(`    created later: HTTP ${lateCreated.status}; pause ${hold('lark')}; Resume → ${r5}`);
  note('D7 order-dependent: Resume after a lost dispute whose "lost" came first', r5);

  // D8
  console.log('\nD8. Moss: disputed; the office agrees with the family and presses "Resume anyway"; the camp then submits evidence (Stripe: charge.dispute.updated, under_review)');
  deliver(dsp('charge.dispute.created', 'dp_m', 'pi_moss', 100000, 'needs_response'), ST('moss', 'pi_moss'));
  const r6 = resume('moss', true);
  const afterAnyway = hold('moss');
  const upd = deliver(dsp('charge.dispute.updated', 'dp_m', 'pi_moss', 100000, 'under_review'), ST('moss', 'pi_moss'));
  console.log(`    resume anyway → ${r6}; pause ${afterAnyway}; evidence submitted → HTTP ${upd.status}; pause now ${hold('moss')}; notices ${pauseNotes('moss')}`);
  check(hold('moss') === 'none', 'D8 the office\'s "Resume anyway" is not undone by the next routine Stripe update', hold('moss'));
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
