// Probe (18th pass, TED-176 re-check). The REAL stripe-connect-webhook with
// migration 285's REAL record_tip_reversal / mark_tip_reversal_alerted and the
// real link_tips / link_staff_accounts rows (scratch Postgres, realdb bridge).
// Stripe is a model that keeps each transfer's amount_reversed and honours
// idempotency keys. Moshe's tip: $20, the parent paid $21.00 (tip + fees), a
// destination charge whose transfer tr_1 sent Moshe $20.
//   T1 refunded in full in the Stripe Dashboard; the event delivered twice
//   T2 a new tip: dispute opened → dispute WON → the closed event re-sent
//   T3 events out of order: the dispute is WON and its "closed" event arrives
//      first; the late "created" event arrives after
//   T4 a partial refund ($10.50 of $21), then the rest
//   T5 an INQUIRY (Stripe's warning_needs_response: the bank asks, no money
//      is taken from the platform) that closes without a chargeback
// For each: what was taken back from Moshe's Stripe account, his total in
// Link Admin (total_earned), the tip's record, and the platform emails.
// Run: node ted/probes/2026-09-24-billing-18/tip18.js
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5766 });
const OWNER = '0ed18700-0000-0000-0000-0000000000a1';
const C = '0ed18700-0000-0000-0000-000000000001';
const STAFF = '0ed18700-0000-0000-0000-0000000000f1';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
// Stripe's state, kept across deliveries (a file the scenario reads and writes).
const fs = require('node:fs');
const STATE = __dirname + '/tip18.stripe.json';
try {
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t18t');
     INSERT INTO camps (id, owner, name) VALUES ('${C}', '${OWNER}', 'Tip Camp');
     INSERT INTO link_staff_accounts (id, camp_id, staff_name, total_earned) VALUES ('${STAFF}', '${C}', 'Moshe', 0);`);
  const tip = (n, pi) => { const id = `0ed18700-0000-0000-0000-00000000010${n}`;
    q(`INSERT INTO link_tips (id, camp_id, recipient_name, amount, status, stripe_payment_intent_id, staff_account_id) VALUES ('${id}', '${C}', 'Moshe', 20, 'succeeded', '${pi}', '${STAFF}');
       UPDATE link_staff_accounts SET total_earned = total_earned + 20 WHERE id = '${STAFF}';`); return id; };
  const earned = () => q(`SELECT total_earned FROM link_staff_accounts WHERE id='${STAFF}'`);
  const rec = (id) => q(`SELECT 'refunded ' || refunded_amount || ', dispute ' || COALESCE(dispute_status,'-') || ', taken back ' || clawed_back_amount || COALESCE(', note: ' || reversal_note, '') FROM link_tips WHERE id='${id}'`);
  function deliver(event) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_c').update(`${t}.${body}`).digest('hex');
    const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_c', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're_x' };
${bridge(db, ['record_tip_reversal', 'mark_tip_reversal_alerted'], ['link_tips'])}
const __fs: any = await import('node:fs');
const S: any = JSON.parse(__fs.readFileSync(${JSON.stringify(STATE)}, 'utf8'));
const save = () => __fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(S));
T.fetch = (url: string, init: any) => {
  if (url.includes('api.resend.com')) { S.emails.push(JSON.parse(init.body).subject); save(); return { id: 'em' }; }
  let m = url.match(/\\/charges\\/([^/?]+)$/); if (m) return S.charges[m[1]] || { error: { message: 'No such charge' } };
  m = url.match(/\\/transfers\\/([^/?]+)\\/reversals$/);
  if (m) { const k = init.headers['Idempotency-Key']; if (!S.keys[k]) { S.keys[k] = 1; S.transfers[m[1]].amount_reversed += Number(new URLSearchParams(init.body).get('amount')); S.reversals.push(m[1] + ' ' + new URLSearchParams(init.body).get('amount')); save(); } return { id: 'trr_' + k }; }
  m = url.match(/\\/transfers\\/([^/?]+)$/); if (m) return S.transfers[m[1]] || { error: { message: 'No such transfer' } };
  return {};
};
T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=' + ${JSON.stringify(sig)} }, rawBody: ${JSON.stringify(body)} }];`;
    const r = runEdges(['stripe-connect-webhook'], scen);
    return r.responses[0].status;
  }
  const S = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const setStripe = (charges, transfers) => fs.writeFileSync(STATE, JSON.stringify({ charges, transfers, keys: {}, reversals: [], emails: [] }));
  const status = (label, id) => { const s = S(); console.log(`    ${label}: taken back ${JSON.stringify(s.reversals)}; Moshe's total $${earned()}; tip: ${rec(id)}; emails ${JSON.stringify(s.emails)}`); return s; };

  console.log('T1. Moshe\'s $20 tip refunded in full in the Stripe Dashboard; the event arrives twice');
  const t1 = tip(1, 'pi_t1');
  setStripe({ ch_1: { id: 'ch_1', amount: 2100, amount_refunded: 2100, transfer: 'tr_1', payment_intent: 'pi_t1' } }, { tr_1: { id: 'tr_1', amount: 2000, amount_reversed: 0 } });
  const ev1 = { id: 'evt_1', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', amount: 2100, amount_refunded: 2100, transfer: 'tr_1', payment_intent: 'pi_t1' } } };
  const a1 = [deliver(ev1), deliver(ev1)];
  let s = status(`answers ${a1}`, t1);
  check(s.reversals.join() === 'tr_1 2000' && Number(earned()) === 0 && s.emails.length === 1, 'T1 $20 taken back once, Moshe\'s total down by $20 once, one email', `${s.reversals}, total $${earned()}, ${s.emails.length} emails`);

  console.log('\nT2. a new $20 tip: dispute opened → dispute WON → the closed event re-sent');
  const t2 = tip(2, 'pi_t2');
  setStripe({ ch_2: { id: 'ch_2', amount: 2100, amount_refunded: 0, transfer: 'tr_2', payment_intent: 'pi_t2' } }, { tr_2: { id: 'tr_2', amount: 2000, amount_reversed: 0 } });
  const e0 = earned();
  const dis = (type, st) => ({ id: 'evt_' + type, type, data: { object: { id: 'dp_2', object: 'dispute', charge: 'ch_2', payment_intent: 'pi_t2', amount: 2100, status: st } } });
  deliver(dis('charge.dispute.created', 'needs_response')); s = status('after opened', t2);
  const midEarned = earned();
  deliver(dis('charge.dispute.closed', 'won')); deliver(dis('charge.dispute.closed', 'won')); s = status('after won (x2)', t2);
  check(Number(midEarned) === Number(e0) - 20 && Number(earned()) === Number(e0) && s.reversals.join() === 'tr_2 2000' && s.emails.length === 2 && /disputed/.test(s.emails[0]),
    'T2 open: $20 taken back, total −$20; won: total back, no second reversal, one email per state', `total ${e0} → ${midEarned} → ${earned()}; ${s.reversals}; ${s.emails.length} emails`);

  console.log('\nT3. out of order: a third $20 tip\'s dispute is WON; "closed" arrives first, the late "created" after');
  const t3 = tip(3, 'pi_t3');
  setStripe({ ch_3: { id: 'ch_3', amount: 2100, amount_refunded: 0, transfer: 'tr_3', payment_intent: 'pi_t3' } }, { tr_3: { id: 'tr_3', amount: 2000, amount_reversed: 0 } });
  const e3 = earned();
  const dis3 = (type, st) => ({ id: 'evt3_' + type, type, data: { object: { id: 'dp_3', object: 'dispute', charge: 'ch_3', payment_intent: 'pi_t3', amount: 2100, status: st } } });
  deliver(dis3('charge.dispute.closed', 'won')); status('after closed(won)', t3);
  deliver(dis3('charge.dispute.created', 'needs_response')); s = status('after the late created', t3);
  check(s.reversals.length === 0 && Number(earned()) === Number(e3),
    'T3 a dispute already WON takes nothing from Moshe when its late "created" event arrives', `taken back ${JSON.stringify(s.reversals)}; total ${e3} → ${earned()}; tip ${rec(t3)}`);

  console.log('\nT4. a fourth $20 tip: $10.50 of the $21 refunded, then the rest');
  const t4 = tip(4, 'pi_t4');
  setStripe({ ch_4: { id: 'ch_4', amount: 2100, amount_refunded: 1050, transfer: 'tr_4', payment_intent: 'pi_t4' } }, { tr_4: { id: 'tr_4', amount: 2000, amount_reversed: 0 } });
  const e4 = earned();
  deliver({ id: 'evt4a', type: 'charge.refunded', data: { object: { id: 'ch_4', object: 'charge', amount: 2100, amount_refunded: 1050, transfer: 'tr_4', payment_intent: 'pi_t4' } } });
  status('after $10.50', t4); const mid4 = earned();
  const st4 = S(); st4.charges.ch_4.amount_refunded = 2100; fs.writeFileSync(STATE, JSON.stringify(st4));
  deliver({ id: 'evt4b', type: 'charge.refunded', data: { object: { id: 'ch_4', object: 'charge', amount: 2100, amount_refunded: 2100, transfer: 'tr_4', payment_intent: 'pi_t4' } } });
  s = status('after the rest', t4);
  check(Number(mid4) === Number(e4) - 10 && Number(earned()) === Number(e4) - 20 && s.transfers.tr_4.amount_reversed === 2000,
    'T4 half refunded → $10 back from Moshe; the rest → $20 in all', `total ${e4} → ${mid4} → ${earned()}; reversed ${s.transfers.tr_4.amount_reversed}c`);

  console.log('\nT5. a fifth $20 tip: the card issuer opens an INQUIRY (no money moves), later closed');
  const t5 = tip(5, 'pi_t5');
  setStripe({ ch_5: { id: 'ch_5', amount: 2100, amount_refunded: 0, transfer: 'tr_5', payment_intent: 'pi_t5' } }, { tr_5: { id: 'tr_5', amount: 2000, amount_reversed: 0 } });
  const e5 = earned();
  const dis5 = (type, st) => ({ id: 'evt5_' + type, type, data: { object: { id: 'dp_5', object: 'dispute', charge: 'ch_5', payment_intent: 'pi_t5', amount: 2100, status: st, is_charge_refundable: true } } });
  deliver(dis5('charge.dispute.created', 'warning_needs_response')); s = status('after the inquiry opened', t5); const mid5 = earned();
  deliver(dis5('charge.dispute.closed', 'warning_closed')); s = status('after it closed', t5);
  check(s.reversals.length === 0, 'T5 an inquiry (no money taken from Campistry) takes nothing from Moshe', `taken back ${JSON.stringify(s.reversals)}; total ${e5} → ${mid5} → ${earned()}; emails ${s.emails.length}`);
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
} finally {
  db.stop();
  try { fs.unlinkSync(STATE); } catch (_) {}
  console.log(`\n${bad} BAD`);
}
