// Probe (20th pass). The REAL stripe-webhook and the REAL nightly runner
// (charge-due-installments) at a941220, on real SQL (full migration chain incl.
// 288/289) through the 10th-pass realdb bridge. Re-checks TED-186/187/188 and
// hunts around migration 288's autopay pause.
//   T1  tuition inquiry opened then warning_closed → owes stays $500
//   T2  Teal (paid in full, autopay due today) inquiry → plan_due_for nothing
//   T3  inquiry escalates (updated needs_response, funds_withdrawn) → owes back
//       once, the autopay plan paused, one pause notice
//   T4  that dispute won → owes $0 again, pause off
//   T5  two disputes on one family (two instalments disputed), A won while B
//       still open → is autopay still paused?
//   T6  dispute won, then a late charge.dispute.updated (status won) /
//       a re-sent funds_withdrawn (needs_response) → paused again after the win?
//   T7  plan already waiting on a declined card (retry next week) → dispute →
//       won → does the decline wait survive?
//   T8  lost → pause stays; the owner resumes it (resume_autopay_after_dispute)
//   C9  canteen top-up disputed, won, then a late updated(won) → wallet stays $20
//   N1  runner: paused family → held_for_dispute, no charge; a control family charged
//   N2  runner: paused family whose card is gone → the no-card mark replaces the
//       dispute pause; the parent adds a new card; a later night → charged while
//       the dispute is still open?
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges, runEdge } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5820 });
const OWNER = '0ed20000-0000-0000-0000-0000000000a1';
const C = '0ed20000-0000-0000-0000-000000000001';
const TODAY = new Date().toISOString().split('T')[0];
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
const qo = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
try {
  const plan = (id, extra) => Object.assign({ id, dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false }, extra || {});
  const fam = (name, tok, extra) => Object.assign({ name, camperIds: [name + ' Kid'], cardOnFile: true, stripeCustomerId: 'cus_' + tok, stripePaymentMethodId: 'pm_' + tok,
    entries: [{ id: 'c_' + tok, kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }] }, extra || {});
  const fams = {
    gold: fam('Gold', 'gold', { plans: [plan('plan_gold')] }),
    teal: fam('Teal', 'teal', { plans: [plan('plan_teal')] }),
    rose: fam('Rose', 'rose', { plans: [plan('plan_rose')] }),
    lime: fam('Lime', 'lime', { plans: [plan('plan_lime')] }),
    plum: fam('Plum', 'plum', { plans: [plan('plan_plum', { collectionBlocked: { reason: 'declined', attempts: 1, since: '2026-09-20T00:00:00Z', nextRetryAt: '2099-01-01', detail: 'insufficient funds' } })] }),
    sage: fam('Sage', 'sage', { plans: [plan('plan_sage')] }),
    mint: fam('Mint', 'mint', { plans: [plan('plan_mint')] }),
    iris: fam('Iris', 'iris', { plans: [plan('plan_iris')] }),
  };
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t20');
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

  const RPCS = ['credit_canteen_balance_from_stripe', 'record_external_refund', 'resolve_chargeback', 'camp_families_object', 'hold_autopay_for_dispute',
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

  // T1
  console.log('T1. Gold pays $500; bank inquiry; inquiry closes');
  pay('gold', 'pi_g1', 50000);
  const g0 = owes('gold');
  let a = deliver(dsp('charge.dispute.created', 'dp_g1', 'pi_g1', 50000, 'warning_needs_response'), ST('gold', 'pi_g1'));
  const g1 = owes('gold');
  let b = deliver(dsp('charge.dispute.closed', 'dp_g1', 'pi_g1', 50000, 'warning_closed'), ST('gold', 'pi_g1'));
  console.log(`    owes $${g0} → inquiry (HTTP ${a.status}) $${g1} → closed (HTTP ${b.status}) $${owes('gold')}; pause ${mark('gold')}`);
  check(g0 === '500.00' && g1 === '500.00' && owes('gold') === '500.00' && mark('gold') === 'none', 'T1 an inquiry posts nothing and pauses nothing', `$${g1}/$${owes('gold')}`);

  // T2
  console.log('\nT2. Teal paid $1,000; inquiry');
  pay('teal', 'pi_t2', 100000);
  const d0 = due('teal');
  deliver(dsp('charge.dispute.created', 'dp_t2', 'pi_t2', 100000, 'warning_needs_response'), ST('teal', 'pi_t2'));
  console.log(`    plan_due_for before ${d0}; after ${due('teal')}`);
  check(/nothing_owed/.test(due('teal')), 'T2 an inquiry does not make autopay charge again', due('teal'));

  // T3
  console.log('\nT3. Teal\'s inquiry escalates');
  a = deliver(dsp('charge.dispute.updated', 'dp_t2', 'pi_t2', 100000, 'needs_response'), ST('teal', 'pi_t2'));
  b = deliver(dsp('charge.dispute.funds_withdrawn', 'dp_t2', 'pi_t2', 100000, 'needs_response'), ST('teal', 'pi_t2'));
  const cb = q(`SELECT count(*) FROM jsonb_array_elements(public.camp_family('${C}','teal')->'entries') e WHERE e->>'id' LIKE 'le_cb_%'`);
  console.log(`    HTTP ${a.status}/${b.status} emails ${a.emails}/${b.emails}; owes $${owes('teal')}; chargeback lines ${cb}; pause ${mark('teal')}; pause notices ${pauseNotes('teal')}; plan_due_for ${due('teal')}`);
  check(owes('teal') === '1000.00' && cb === '1' && /chargeback/.test(mark('teal')) && pauseNotes('teal') === '1' && a.emails + b.emails === 0,
    'T3 escalated: back on the bill once, autopay paused, one notice, no extra email', `owes $${owes('teal')}, lines ${cb}`);

  // T4
  console.log('\nT4. Teal\'s dispute won');
  a = deliver(dsp('charge.dispute.closed', 'dp_t2', 'pi_t2', 100000, 'won'), ST('teal', 'pi_t2'));
  console.log(`    HTTP ${a.status}; owes $${owes('teal')}; pause ${mark('teal')}`);
  check(owes('teal') === '0.00' && mark('teal') === 'none', 'T4 won: paid again, pause off', `owes $${owes('teal')}, ${mark('teal')}`);

  // T5
  console.log('\nT5. Rose paid two $500 instalments; the parent disputes both; the camp wins the first while the second is still open');
  pay('rose', 'pi_r1', 50000); pay('rose', 'pi_r2', 50000);
  deliver(dsp('charge.dispute.created', 'dp_rA', 'pi_r1', 50000, 'needs_response'), ST('rose', 'pi_r1'));
  deliver(dsp('charge.dispute.created', 'dp_rB', 'pi_r2', 50000, 'needs_response'), ST('rose', 'pi_r2'));
  const r1 = mark('rose'), ro1 = owes('rose');
  deliver(dsp('charge.dispute.closed', 'dp_rA', 'pi_r1', 50000, 'won'), ST('rose', 'pi_r1'));
  console.log(`    both open: owes $${ro1}, pause ${r1}; after A won: owes $${owes('rose')}, pause ${mark('rose')}; plan_due_for ${due('rose')}`);
  check(mark('rose') !== 'none', 'T5 dispute B still open → autopay still paused', `pause ${mark('rose')}, plan_due_for ${due('rose')}`);

  // T6
  console.log('\nT6. Lime paid $1,000; dispute; won; then a late charge.dispute.updated (won) and a re-sent funds_withdrawn');
  pay('lime', 'pi_l1', 100000);
  deliver(dsp('charge.dispute.created', 'dp_l1', 'pi_l1', 100000, 'needs_response'), ST('lime', 'pi_l1'));
  deliver(dsp('charge.dispute.closed', 'dp_l1', 'pi_l1', 100000, 'won'), ST('lime', 'pi_l1'));
  const l1 = mark('lime');
  a = deliver(dsp('charge.dispute.updated', 'dp_l1', 'pi_l1', 100000, 'won'), ST('lime', 'pi_l1'));
  const l2 = mark('lime');
  deliver(dsp('charge.dispute.closed', 'dp_l1', 'pi_l1', 100000, 'won'), ST('lime', 'pi_l1'));
  b = deliver(dsp('charge.dispute.funds_withdrawn', 'dp_l1', 'pi_l1', 100000, 'needs_response'), ST('lime', 'pi_l1'));
  console.log(`    after win pause ${l1}; late updated(won) HTTP ${a.status} → pause ${l2}; re-sent funds_withdrawn HTTP ${b.status} → pause ${mark('lime')}; owes $${owes('lime')}; pause notices ${pauseNotes('lime')}`);
  check(l2 === 'none', 'T6a a late "updated" (status won) does not pause autopay after the win', `pause ${l2}`);
  check(mark('lime') === 'none', 'T6b a re-sent funds_withdrawn after the win does not pause autopay again', `pause ${mark('lime')}`);

  // T7
  console.log('\nT7. Plum\'s plan waits on a declined card (retry 2099); Plum paid $500 earlier by another card; that payment disputed, then won');
  pay('plum', 'pi_p1', 50000);
  const p0 = mark('plum');
  deliver(dsp('charge.dispute.created', 'dp_p1', 'pi_p1', 50000, 'needs_response'), ST('plum', 'pi_p1'));
  const p1 = mark('plum');
  deliver(dsp('charge.dispute.closed', 'dp_p1', 'pi_p1', 50000, 'won'), ST('plum', 'pi_p1'));
  console.log(`    before ${p0}; disputed ${p1}; won ${mark('plum')}`);
  check(/declined/.test(mark('plum')), 'T7 the decline wait survives a dispute that was won', `after win ${mark('plum')}`);

  // T8
  console.log('\nT8. Sage paid $1,000; dispute lost; the owner resumes autopay');
  pay('sage', 'pi_s1', 100000);
  deliver(dsp('charge.dispute.created', 'dp_s1', 'pi_s1', 100000, 'needs_response'), ST('sage', 'pi_s1'));
  deliver(dsp('charge.dispute.closed', 'dp_s1', 'pi_s1', 100000, 'lost'), ST('sage', 'pi_s1'));
  const s1 = mark('sage');
  const res = qo(`SELECT public.resume_autopay_after_dispute('${C}', 'sage')::text`);
  console.log(`    lost → owes $${owes('sage')}, pause ${s1}; resume → ${res}; pause ${mark('sage')}`);
  check(/chargeback/.test(s1) && mark('sage') === 'none' && owes('sage') === '1000.00', 'T8 lost keeps the pause; the owner resumes it', `${s1} → ${mark('sage')}`);

  // C9
  console.log('\nC9. Dov\'s $20 canteen top-up disputed, won, then a late updated(won)');
  const META = { campId: C, source: 'campistry-canteen-deposit', camperId: '1', camperName: 'Dov Gold' };
  deliver({ id: 'evt_c9', type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000), data: { object: { id: 'pi_c9', object: 'payment_intent', amount: 2000, amount_received: 2000, status: 'succeeded', payment_method_types: ['card'], metadata: META } } });
  const CS = { '/payment_intents/pi_c9': { id: 'pi_c9', metadata: META }, '/charges/ch_pi_c9': { id: 'ch_pi_c9', payment_intent: 'pi_c9', metadata: META } };
  const w0 = wallet();
  deliver(dsp('charge.dispute.created', 'dp_c9', 'pi_c9', 2000, 'needs_response'), CS);
  const w1 = wallet();
  deliver(dsp('charge.dispute.closed', 'dp_c9', 'pi_c9', 2000, 'won'), CS);
  const w2 = wallet();
  deliver(dsp('charge.dispute.updated', 'dp_c9', 'pi_c9', 2000, 'won'), CS);
  deliver(dsp('charge.dispute.funds_withdrawn', 'dp_c9', 'pi_c9', 2000, 'needs_response'), CS);
  console.log(`    $${w0} → disputed $${w1} → won $${w2} → late updated/funds_withdrawn $${wallet()}`);
  check(w0 === '20.00' && w1 === '0.00' && w2 === '20.00' && wallet() === '20.00', 'C9 canteen late events after a win take nothing', `$${wallet()}`);

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
  console.log('\nN1. Nightly run: Mint disputed (paused) and Iris (control) both owe tonight');
  pay('mint', 'pi_m1', 100000);
  deliver(dsp('charge.dispute.created', 'dp_m1', 'pi_m1', 100000, 'needs_response'), ST('mint', 'pi_m1'));
  console.log(`    Mint owes $${owes('mint')}, pause ${mark('mint')}`);
  const n1 = night();
  console.log(`    results ${JSON.stringify(n1.filter(x => /Mint|Iris/.test(x)))}; charges: ${sales()}`);
  check(n1.includes('Mint:held_for_dispute') && !/cus_mint/.test(sales()) && /cus_iris/.test(sales()), 'N1 paused family not charged; control charged', sales());

  console.log('\nN2. Mint\'s card is removed (bank closed it after the fraud claim); a night; then the parent saves a new card; later nights');
  let f = JSON.parse(q(`SELECT public.camp_family('${C}','mint')::text`));
  f.cardOnFile = false; delete f.stripePaymentMethodId;
  q(`SELECT public.camp_family_save('${C}', 'mint', ${lit(f)})`);
  const n2a = night();
  const m1 = mark('mint');
  f = JSON.parse(q(`SELECT public.camp_family('${C}','mint')::text`));
  f.cardOnFile = true; f.stripePaymentMethodId = 'pm_mint_new';
  if (f.plans[0].collectionBlocked && f.plans[0].collectionBlocked.nextRetryAt) f.plans[0].collectionBlocked.nextRetryAt = '2000-01-01';   // a few nights later
  q(`SELECT public.camp_family_save('${C}', 'mint', ${lit(f)})`);
  const n2b = night();
  console.log(`    night with no card: ${JSON.stringify(n2a.filter(x => /Mint/.test(x)))} → pause ${m1}`);
  console.log(`    later night with the new card: ${JSON.stringify(n2b.filter(x => /Mint/.test(x)))}; charges: ${sales()}; dispute dp_m1 still open`);
  check(/chargeback/.test(m1), 'N2a the dispute pause survives a night with no card', `pause ${m1}`);
  check(!/cus_mint/.test(sales()), 'N2b a new card does not get charged while the dispute is open', sales());
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
