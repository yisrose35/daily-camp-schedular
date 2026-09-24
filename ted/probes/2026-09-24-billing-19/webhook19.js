// Probe (19th pass). The REAL stripe-webhook (e8f1d26) on real SQL (full
// migration chain incl. 286/287) through the 10th-pass realdb bridge.
// Re-checks TED-181 and TED-183 and hunts around them.
//   C1  dashboard refund of a $20 top-up → wallet $0, one notice; repeat → once
//   C2  dispute created → $0; closed won → $20; won again → once
//   C3  dispute lost → stays $0
//   C4  inquiry (warning_needs_response) → nothing; then the inquiry is
//       escalated (charge.dispute.updated needs_response + funds_withdrawn)
//   C5  $5 then $15 partial dashboard refunds → $0; a third "refund" capped
//   C6  child already spent $15, then dashboard refund of $20 → wallet −$15 and notice says so
//   C7  a Snacks refund (campistryHold-tagged) arriving as charge.refunded → not taken twice
//   C8  dashboard refund that later FAILS (refund.failed) → back on the wallet?
//   T1  tuition payment then a bank INQUIRY (warning_needs_response) then
//       warning_closed → does the family owe the money again?
//   P1  unknown_camper top-up → 200 + 1 email; again → 0 emails
//   P2  same but the email fails → 500, then the next delivery sends it → 200
//   P3  same but RESEND not configured → answer / anyone told?
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5791 });
const OWNER = '0ed19900-0000-0000-0000-0000000000a1';
const C = '0ed19900-0000-0000-0000-000000000001';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
try {
  const kids = [[1, 'Avi Gold'], [2, 'Bina Gold'], [3, 'Chaim Gold'], [4, 'Dov Gold'], [5, 'Eli Gold'], [6, 'Fay Gold'], [7, 'Gil Gold'], [8, 'Hadas Gold']];
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t19');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Canteen Camp', 'stripe');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ${kids.map(([i, n]) => `('${C}', ${i}, 'camper', '${n}', '${n}')`).join(',')};
     ${kids.map(([i, n]) => `SELECT public.canteen_account_save('${C}', '${n}', '{"balance": 0, "camperId": ${i}}'::jsonb);`).join('\n')}
     INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', ${lit({ gold: { name: 'Gold', camperIds: ['Avi Gold'], entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-06-01' }] }, teal: { name: 'Teal', camperIds: ['Bina Gold'], entries: [{ id: 'le_t2', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-06-01' }], plans: [{ id: 'plan_teal', dueDates: ['2026-09-24'], count: 1, nextIndex: 0, history: [], autopay: true, paused: false }] } })}));`);
  const wallet = (id) => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=${id}`);
  const notices = (like) => q(`SELECT count(*) FROM notifications WHERE camp_id='${C}' AND source='canteen_reversed'${like ? ` AND body ILIKE '${like}'` : ''}`);
  const owes = () => q(`SELECT public.family_ledger_balance(public.camp_family('${C}','gold'))`);
  const RPCS = ['credit_canteen_balance_from_stripe', 'record_external_refund', 'record_chargeback', 'resolve_chargeback', 'camp_families_object',
    'record_canteen_stripe_reversal', 'claim_refund_failure_alert', 'release_refund_failure_alert', 'append_camp_payment',
    'reverse_failed_stripe_refund', 'undo_card_fee_return', '_record_registration_deposit', '_record_registration_card', 'record_link_photo_purchase'];
  const META = (id, name) => ({ campId: C, source: 'campistry-canteen-deposit', camperId: String(id), camperName: name });
  function deliver(event, stripe, opts) {
    opts = opts || {};
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    const env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted' };
    if (!opts.noResend) env.RESEND_API_KEY = 're_test';
    const scen = `
T.env = ${JSON.stringify(env)};
${opts.emailFails ? 'T.emailFails = () => true;' : ''}
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
    return { status: r.responses[0].status, body: JSON.stringify(r.responses[0].body || '').slice(0, 200),
      emails: (r.emails || []).length, subjects: (r.emails || []).map(e => e.subject), log: (r.logs || []).join(' | ').slice(0, 600) };
  }
  let n = 0;
  const topup = (pi, id, name, cents) => ({ id: 'evt_' + pi + (n++), type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: pi, object: 'payment_intent', amount: cents || 2000, amount_received: cents || 2000, status: 'succeeded', payment_method_types: ['card'], metadata: META(id, name) } } });
  const chargeRefunded = (pi, id, name, refunds, amtRefunded) => ({ id: 'evt_r' + (n++), type: 'charge.refunded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'ch_' + pi, object: 'charge', amount: 2000, amount_refunded: amtRefunded, refunded: amtRefunded >= 2000, payment_intent: pi, metadata: META(id, name), refunds: { data: refunds } } } });
  const stripeFor = (pi, id, name, refunds) => {
    const m = { ['/payment_intents/' + pi]: { id: pi, metadata: META(id, name) }, ['/charges/ch_' + pi]: { id: 'ch_' + pi, payment_intent: pi, metadata: META(id, name) },
      ['/refunds?charge=ch_' + pi]: { data: refunds || [] } };
    for (const r of refunds || []) m['/refunds/' + r.id] = r;
    return m;
  };
  const dispute = (type, dp) => ({ id: 'evt_d' + (n++), type, created: Math.floor(Date.now() / 1000), data: { object: dp } });

  for (const [i, nm] of kids) deliver(topup('pi_k' + i, i, nm));
  console.log(`SETUP: $20 card top-ups → ${kids.map(([i, nm]) => nm.split(' ')[0] + ' $' + wallet(i)).join(', ')}`);

  // C1
  console.log('\nC1. Avi\'s $20 top-up refunded in the Stripe Dashboard (twice delivered)');
  let re = { id: 're_c1', object: 'refund', amount: 2000, status: 'succeeded', charge: 'ch_pi_k1', payment_intent: 'pi_k1', metadata: {} };
  let a = deliver(chargeRefunded('pi_k1', 1, 'Avi Gold', [re], 2000), stripeFor('pi_k1', 1, 'Avi Gold', [re]));
  let b = deliver(chargeRefunded('pi_k1', 1, 'Avi Gold', [re], 2000), stripeFor('pi_k1', 1, 'Avi Gold', [re]));
  console.log(`    HTTP ${a.status}/${b.status}; Avi $${wallet(1)}; notices ${notices()}`);
  check(Number(wallet(1)) === 0 && a.status === 200 && b.status === 200 && notices() === '1', 'C1 off the wallet once, one notice', `Avi $${wallet(1)}, notices ${notices()}`);

  // C2
  console.log('\nC2. Bina\'s top-up disputed, then won (won delivered twice)');
  const dp2 = { id: 'dp_2', object: 'dispute', amount: 2000, charge: 'ch_pi_k2', payment_intent: 'pi_k2', reason: 'fraudulent', status: 'needs_response', metadata: {} };
  a = deliver(dispute('charge.dispute.created', dp2), stripeFor('pi_k2', 2, 'Bina Gold'));
  const afterOpen = wallet(2);
  b = deliver(dispute('charge.dispute.closed', { ...dp2, status: 'won' }), stripeFor('pi_k2', 2, 'Bina Gold'));
  const c = deliver(dispute('charge.dispute.closed', { ...dp2, status: 'won' }), stripeFor('pi_k2', 2, 'Bina Gold'));
  console.log(`    log(created): ${a.log.slice(0, 500)}`);
  console.log(`    HTTP ${a.status}/${b.status}/${c.status}; Bina after open $${afterOpen}, after won $${wallet(2)}`);
  check(Number(afterOpen) === 0 && Number(wallet(2)) === 20, 'C2 off while open, back once when won', `open $${afterOpen}, won $${wallet(2)}`);

  // C3
  console.log('\nC3. Chaim\'s top-up disputed and lost');
  const dp3 = { id: 'dp_3', object: 'dispute', amount: 2000, charge: 'ch_pi_k3', payment_intent: 'pi_k3', reason: 'fraudulent', status: 'needs_response', metadata: {} };
  deliver(dispute('charge.dispute.created', dp3), stripeFor('pi_k3', 3, 'Chaim Gold'));
  a = deliver(dispute('charge.dispute.closed', { ...dp3, status: 'lost' }), stripeFor('pi_k3', 3, 'Chaim Gold'));
  check(Number(wallet(3)) === 0, 'C3 lost → stays off', `Chaim $${wallet(3)} (HTTP ${a.status})`);

  // C4
  console.log('\nC4. Dov\'s top-up: a bank inquiry, then the inquiry is escalated to a chargeback');
  const dp4 = { id: 'dp_4', object: 'dispute', amount: 2000, charge: 'ch_pi_k4', payment_intent: 'pi_k4', reason: 'general', status: 'warning_needs_response', metadata: {} };
  a = deliver(dispute('charge.dispute.created', dp4), stripeFor('pi_k4', 4, 'Dov Gold'));
  const inq = wallet(4);
  b = deliver(dispute('charge.dispute.updated', { ...dp4, status: 'needs_response' }), stripeFor('pi_k4', 4, 'Dov Gold'));
  const fw = deliver(dispute('charge.dispute.funds_withdrawn', { ...dp4, status: 'needs_response' }), stripeFor('pi_k4', 4, 'Dov Gold'));
  console.log(`    inquiry HTTP ${a.status} → Dov $${inq}; escalated (updated HTTP ${b.status}, funds_withdrawn HTTP ${fw.status}) → Dov $${wallet(4)}; notices for Dov ${notices('%Dov%')}`);
  check(Number(inq) === 20, 'C4a an inquiry takes nothing', `Dov $${inq}`);
  check(Number(wallet(4)) === 0 || Number(notices('%Dov%')) > 0, 'C4b an escalated inquiry (money withdrawn) comes off, or the camp is told', `Dov $${wallet(4)}, notices ${notices('%Dov%')}`);

  // C5
  console.log('\nC5. Eli: $5 then $15 refunded in the dashboard, then a bogus third $5');
  const r5a = { id: 're_5a', object: 'refund', amount: 500, status: 'succeeded', metadata: {} };
  const r5b = { id: 're_5b', object: 'refund', amount: 1500, status: 'succeeded', metadata: {} };
  const r5c = { id: 're_5c', object: 'refund', amount: 500, status: 'succeeded', metadata: {} };
  deliver(chargeRefunded('pi_k5', 5, 'Eli Gold', [r5a], 500), stripeFor('pi_k5', 5, 'Eli Gold', [r5a]));
  const e1 = wallet(5);
  deliver(chargeRefunded('pi_k5', 5, 'Eli Gold', [r5b, r5a], 2000), stripeFor('pi_k5', 5, 'Eli Gold', [r5b, r5a]));
  const e2 = wallet(5);
  deliver(chargeRefunded('pi_k5', 5, 'Eli Gold', [r5c, r5b, r5a], 2500), stripeFor('pi_k5', 5, 'Eli Gold', [r5c, r5b, r5a]));
  console.log(`    after $5: $${e1}; after $15: $${e2}; after bogus 3rd: $${wallet(5)}`);
  check(Number(e1) === 15 && Number(e2) === 0 && Number(wallet(5)) === 0, 'C5 partial refunds add up, never more than the top-up', `${e1} / ${e2} / ${wallet(5)}`);

  // C6
  console.log('\nC6. Fay spent $15 of her $20, then the $20 is refunded in the dashboard');
  q(`SELECT public.canteen_account_save('${C}', 'Fay Gold', '{"balance": 5, "camperId": 6}'::jsonb)`);
  const r6 = { id: 're_6', object: 'refund', amount: 2000, status: 'succeeded', metadata: {} };
  deliver(chargeRefunded('pi_k6', 6, 'Fay Gold', [r6], 2000), stripeFor('pi_k6', 6, 'Fay Gold', [r6]));
  const body6 = q(`SELECT body FROM notifications WHERE camp_id='${C}' AND source='canteen_reversed' AND source_id='xref:re_6'`);
  console.log(`    Fay $${wallet(6)}; notice: ${body6}`);
  check(Number(wallet(6)) === -15 && /owes the canteen/.test(body6), 'C6 wallet −$15 and the notice says the family owes it', `Fay $${wallet(6)}`);

  // C7
  console.log('\nC7. Gil: a refund made from Snacks (tagged campistryHold) arrives as charge.refunded');
  const r7 = { id: 're_7', object: 'refund', amount: 2000, status: 'succeeded', metadata: { campistryHold: 'scanteen:k:1' } };
  a = deliver(chargeRefunded('pi_k7', 7, 'Gil Gold', [r7], 2000), stripeFor('pi_k7', 7, 'Gil Gold', [r7]));
  check(Number(wallet(7)) === 20, 'C7 the webhook leaves a Snacks refund to Snacks (no second deduction)', `Gil $${wallet(7)} (HTTP ${a.status})`);

  // C8
  console.log('\nC8. Hadas: a dashboard refund that then FAILS at the bank (refund.failed)');
  const r8 = { id: 're_8', object: 'refund', amount: 2000, status: 'succeeded', charge: 'ch_pi_k8', payment_intent: 'pi_k8', metadata: {} };
  deliver(chargeRefunded('pi_k8', 8, 'Hadas Gold', [r8], 2000), stripeFor('pi_k8', 8, 'Hadas Gold', [r8]));
  const h1 = wallet(8);
  const r8f = { ...r8, status: 'failed', failure_reason: 'expired_or_canceled_card' };
  a = deliver({ id: 'evt_f8', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: r8f } },
    { ...stripeFor('pi_k8', 8, 'Hadas Gold', [r8f]), '/refunds/re_8': r8f });
  const b8 = deliver({ id: 'evt_f8b', type: 'refund.failed', created: Math.floor(Date.now() / 1000), data: { object: r8f } },
    { ...stripeFor('pi_k8', 8, 'Hadas Gold', [r8f]), '/refunds/re_8': r8f });
  console.log(`    after refund $${h1}; after refund.failed (HTTP ${a.status}, again ${b8.status}) $${wallet(8)}; emails ${a.emails}+${b8.emails}`);
  console.log(`    log: ${a.log.slice(0, 400)}`);
  check(Number(h1) === 0 && Number(wallet(8)) === 20, 'C8 failed dashboard refund goes back on the wallet once', `$${h1} → $${wallet(8)}`);

  // T1
  console.log('\nT1. Gold pays $500 tuition by card; the bank opens an INQUIRY; the inquiry closes (no money moved)');
  const tpi = { id: 'pi_t1', object: 'payment_intent', amount: 50000, amount_received: 50000, status: 'succeeded', payment_method_types: ['card'], metadata: { campId: C, familyKey: 'gold', familyName: 'Gold' } };
  deliver({ id: 'evt_t1', type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000), data: { object: tpi } });
  const o0 = owes();
  const tdp = { id: 'dp_t1', object: 'dispute', amount: 50000, charge: 'ch_t1', payment_intent: 'pi_t1', reason: 'general', status: 'warning_needs_response', metadata: {} };
  const TS = { '/payment_intents/pi_t1': { id: 'pi_t1', metadata: tpi.metadata }, '/charges/ch_t1': { id: 'ch_t1', payment_intent: 'pi_t1', metadata: tpi.metadata } };
  a = deliver(dispute('charge.dispute.created', tdp), TS);
  const o1 = owes();
  b = deliver(dispute('charge.dispute.closed', { ...tdp, status: 'warning_closed' }), TS);
  const o2 = owes();
  const cb = q(`SELECT coalesce(json_agg(e)::text,'[]') FROM jsonb_array_elements(public.camp_family('${C}','gold')->'entries') e WHERE e->>'id' LIKE 'le_cb%'`);
  console.log(`    owes after paying $${o0}; after inquiry opened (HTTP ${a.status}) $${o1}; after inquiry closed (HTTP ${b.status}) $${o2}`);
  console.log(`    log(inquiry closed): ${b.log.slice(0, 500)}`);
  console.log(`    log(inquiry created): ${a.log.slice(0, 500)}`);
  console.log(`    chargeback lines: ${cb.slice(0, 400)}`);
  check(Number(o1) === 500 && Number(o2) === 500, 'T1 a bank inquiry moves no money: the family still owes $500 (not $1,000)', `opened → $${o1}, closed → $${o2}`);

  // T2
  console.log('\nT2. Teal paid the whole $1,000 by card; autopay plan due today; then a bank INQUIRY');
  const t2 = { id: 'pi_t2', object: 'payment_intent', amount: 100000, amount_received: 100000, status: 'succeeded', payment_method_types: ['card'], metadata: { campId: C, familyKey: 'teal', familyName: 'Teal' } };
  deliver({ id: 'evt_t2', type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000), data: { object: t2 } });
  const due = () => q(`SELECT public.plan_due_for('${C}'::uuid, 'teal', 'plan_teal', '2026-09-24')::text`);
  const d0 = due();
  const dp2t = { id: 'dp_t2', object: 'dispute', amount: 100000, charge: 'ch_t2', payment_intent: 'pi_t2', reason: 'general', status: 'warning_needs_response', metadata: {} };
  deliver(dispute('charge.dispute.created', dp2t), { '/payment_intents/pi_t2': { id: 'pi_t2', metadata: t2.metadata }, '/charges/ch_t2': { id: 'ch_t2', payment_intent: 'pi_t2', metadata: t2.metadata } });
  const d1 = due();
  const tealNote = q(`SELECT body FROM notifications WHERE camp_id='${C}' AND source='chargeback' AND source_id='dp_t2'`);
  console.log(`    before the inquiry autopay asks plan_due_for → ${d0}`);
  console.log(`    after the inquiry  autopay asks plan_due_for → ${d1}`);
  console.log(`    camp notice: ${tealNote}`);
  check(!/"amount"\s*:\s*[1-9]/.test(d1), 'T2 an inquiry does not make tonight\'s autopay charge the parent again', d1);

  // P1-P3
  const unknown = (pi, cid) => ({ id: 'evt_' + pi + (n++), type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: pi, object: 'payment_intent', amount: 1500, amount_received: 1500, status: 'succeeded', payment_method_types: ['card'],
      metadata: { campId: C, source: 'campistry-canteen-deposit', camperId: String(cid), camperName: 'Nobody Here' } } } });
  console.log('\nP1. a top-up for child #99 (erased): delivered twice');
  a = deliver(unknown('pi_p1', 99)); b = deliver(unknown('pi_p1', 99));
  console.log(`    HTTP ${a.status}/${b.status}; emails ${a.emails}/${b.emails}; body ${a.body}`);
  check(a.status === 200 && b.status === 200 && a.emails === 1 && b.emails === 0, 'P1 200, told once', `${a.status}/${b.status}, ${a.emails}/${b.emails}`);
  console.log('\nP2. same, but the email service is down the first time');
  a = deliver(unknown('pi_p2', 98), null, { emailFails: true }); b = deliver(unknown('pi_p2', 98));
  console.log(`    HTTP ${a.status}/${b.status}; email attempts ${a.emails}/${b.emails}`);
  check(a.status === 500 && b.status === 200 && b.emails === 1, 'P2 500 until the alert goes, then 200', `${a.status}/${b.status}`);
  console.log('\nP3. same, but no email key is configured');
  a = deliver(unknown('pi_p3', 97), null, { noResend: true });
  const campNote = q(`SELECT count(*) FROM notifications WHERE camp_id='${C}' AND body ILIKE '%pi_p3%'`);
  console.log(`    HTTP ${a.status}; emails ${a.emails}; camp notices naming it ${campNote}`);
  check(!(a.status === 200 && a.emails === 0 && campNote === '0'), 'P3 without email someone is still told (camp notice) or Stripe keeps retrying', `HTTP ${a.status}, emails ${a.emails}, notices ${campNote}`);
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
