// Probe (11th pass, TED-117). Stripe canteen refunds — the REAL edge functions
// (stripe-canteen-refund, stripe-canteen-refund-all) against the REAL migration
// chain on a scratch Postgres (275 holds, 198 claims), with a pretend Stripe
// that behaves the way Stripe documents:
//   * an Idempotency-Key replays its FIRST answer for the same details; the
//     same key with different details → 400 idempotency_error;
//   * keys are forgotten after 24 h (modelled by deleting them);
//   * each refund keeps its metadata; GET /refunds?payment_intent= lists them;
//   * a refund can FAIL after it was created (status → failed, money back);
//   * a request can be cut off before it reaches Stripe, or after Stripe made it.
// Stripe's memory lives in the scratch DB so it survives between presses.
// "money back" = sum of refunds Stripe made that did not fail.
// Run: node ted/probes/2026-09-24-billing-11/canteen_stripe_faithful_realdb.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5613 });

const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent',
  'refund_canteen_deposit_from_stripe', 'record_processor_transaction'];
const BR = bridge(db, RPCS, ['refund_intents']);
let campN = 0;
const q1 = (s) => db.sql(s).trim();

db.sql(`CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
  CREATE TABLE ted_charge (ref text PRIMARY KEY, amount int, refunded int NOT NULL DEFAULT 0);
  CREATE TABLE ted_refunds (id serial, camp text, pi text, cents int, hold text, status text NOT NULL DEFAULT 'succeeded', created bigint);
  CREATE TABLE ted_flags (k text PRIMARY KEY, n int);
  INSERT INTO auth.users (id, email) VALUES ('0ed13000-0000-0000-0000-0000000000a1','o@ted') ON CONFLICT DO NOTHING;`);

// A fresh camp: Avi (#7) topped up once per entry of `tops` (dollars), spent `spent`.
function camp(tops, spent) {
  campN++;
  const C = `0ed13000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
  const refs = tops.map((_, i) => `pi_${campN}top${i + 1}`);
  let sql = `INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','0ed13000-0000-0000-0000-0000000000a1','P${campN}','stripe');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0}'::jsonb);`;
  tops.forEach((t, i) => { sql += `SELECT public.canteen_post('${C}', 'Avi', '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"${refs[i]}","amount":${t},"date":"2026-07-01","timestamp":${i + 1}}'::jsonb);
    INSERT INTO ted_charge (ref, amount) VALUES ('${refs[i]}', ${t * 100});`; });
  if (spent) sql += `SELECT public.canteen_post('${C}', 'Avi', '{"type":"debit","kind":"purchase","amount":${spent},"date":"2026-07-02","timestamp":9}'::jsonb);`;
  const total = tops.reduce((a, b) => a + b, 0);
  sql += `SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": ${total - spent}, "balanceFloor": 0}'::jsonb);`;
  db.sql(sql);
  return { C, refs };
}
function topUp(c, dollars) {     // a later top-up (a new PaymentIntent)
  const ref = `pi_${campN}late${c.refs.length + 1}`; c.refs.push(ref);
  db.sql(`SELECT public.canteen_post('${c.C}', 'Avi', '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"${ref}","amount":${dollars},"date":"2026-07-03","timestamp":20}'::jsonb);
    DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${c.C}','Avi'); PERFORM public.canteen_account_save('${c.C}','Avi', a || jsonb_build_object('balance', (a->>'balance')::numeric + ${dollars})); END $x$;
    INSERT INTO ted_charge (ref, amount) VALUES ('${ref}', ${dollars * 100});`);
  return ref;
}
const flag = (k, n = 1) => db.sql(`INSERT INTO ted_flags VALUES ('${k}', ${n}) ON CONFLICT (k) DO UPDATE SET n = ${n}`);
const clearFlags = () => db.sql(`DELETE FROM ted_flags`);
// time passes: holds, claims and Stripe's refunds all move back together
function later(c, interval, forgetKeys) {
  db.sql(`UPDATE canteen_refund_holds SET created_at = created_at - interval '${interval}' WHERE camp_id='${c.C}';
    UPDATE refund_intents SET created_at = created_at - interval '${interval}', called_at = called_at - interval '${interval}' WHERE camp_id='${c.C}';
    UPDATE ted_refunds SET created = created - extract(epoch from interval '${interval}')::bigint WHERE camp='${c.C}';`);
  if (forgetKeys) db.sql(`DELETE FROM ted_keys WHERE k LIKE 'canteen_refund_%'`);   // > 24 h: Stripe has forgotten every key
}
// Stripe fails a refund after it was made: the money goes back to the camp side
function failRefund(c, which) {
  db.sql(`UPDATE ted_charge t SET refunded = refunded - r.cents FROM ted_refunds r WHERE r.camp='${c.C}' AND r.id = (SELECT id FROM ted_refunds WHERE camp='${c.C}' ORDER BY id ${which === 'last' ? 'DESC' : 'ASC'} LIMIT 1) AND t.ref = r.pi;
    UPDATE ted_refunds SET status = 'failed' WHERE id = (SELECT id FROM ted_refunds WHERE camp='${c.C}' ORDER BY id ${which === 'last' ? 'DESC' : 'ASC'} LIMIT 1);`);
}

const STRIPE = `
const __qq = (T as any).__q;
const __esc = (s: string) => String(s).replace(/'/g, "''");
const __flag = (k: string) => { const n = Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='" + k + "'),0)")); if (n > 0) { __qq("UPDATE ted_flags SET n = n - 1 WHERE k='" + k + "'"); return true; } return false; };
const __refObj = (r: any) => ({ id: 're_' + r.id, object: 'refund', amount: r.cents, payment_intent: r.pi, status: r.status, created: Number(r.created), metadata: r.hold ? { campistryHold: r.hold } : {} });
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = String(init.headers['Idempotency-Key'] || '');
    const body = String(init.body || '');
    if (__flag('lose_before')) throw new Error('connection reset (never reached Stripe)');
    const seen = JSON.parse(__qq("SELECT json_build_object('body', body, 'resp', resp, 'status', status)::text FROM ted_keys WHERE k='" + __esc(k) + "'") || 'null');
    if (seen) {
      if (seen.body !== body) return { __status: 400, error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } };
      T.__replays = (T.__replays || 0) + 1;
      if (__flag('lose')) throw new Error('connection reset');
      return Object.assign({ __status: seen.status }, seen.resp);
    }
    const p = new URLSearchParams(body);
    const pi = String(p.get('payment_intent')); const cents = Number(p.get('amount'));
    const row = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + __esc(pi) + "'") || 'null');
    let resp: any, status = 200;
    if (!row) { resp = { error: { type: 'invalid_request_error', message: 'No such payment_intent' } }; status = 404; }
    else if (row.amount - row.refunded <= 0) { resp = { error: { type: 'invalid_request_error', message: 'Charge ' + pi + ' has already been refunded.' } }; status = 400; }
    else if (cents > row.amount - row.refunded) { resp = { error: { type: 'invalid_request_error', message: 'Refund amount is greater than unrefunded amount on charge' } }; status = 400; }
    else {
      const r = JSON.parse(__qq("INSERT INTO ted_refunds (camp, pi, cents, hold, created) VALUES ('" + T.__camp + "','" + __esc(pi) + "'," + cents + "," + (p.get('metadata[campistryHold]') ? "'" + __esc(String(p.get('metadata[campistryHold]'))) + "'" : 'NULL') + ", extract(epoch from now())::bigint) RETURNING row_to_json(ted_refunds)::text"));
      __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + __esc(pi) + "'");
      resp = __refObj(r);
    }
    if (k) __qq("INSERT INTO ted_keys (k, body, resp, status) VALUES ('" + __esc(k) + "','" + __esc(body) + "','" + __esc(JSON.stringify(resp)) + "'::jsonb," + status + ")");
    if (__flag('lose')) throw new Error('connection reset');
    return Object.assign({ __status: status }, resp);
  }
  if (url.includes('/refunds?payment_intent=')) {
    if (__flag('list_fail')) return { __status: 429, error: { type: 'rate_limit_error', message: 'Too many requests' } };
    const pi = decodeURIComponent(url.split('payment_intent=')[1].split('&')[0]);
    const rows = JSON.parse(__qq("SELECT coalesce(json_agg(r ORDER BY id DESC), '[]'::json)::text FROM ted_refunds r WHERE pi='" + __esc(pi) + "'"));
    return { object: 'list', data: rows.map(__refObj), has_more: false };
  }
  if (url.includes('/payment_intents/')) {
    if (__flag('pi_fail')) return { __status: 429, error: { type: 'rate_limit_error', message: 'Too many requests' } };
    return { id: url.split('/').pop(), transfer_data: null };
  }
  return {};
};`;

function scenario(c, extra) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${c.C}', owner: 'u-owner', payment_processor_key: 'stripe' }];
T.__camp = '${c.C}';
${BR}
${STRIPE}
${extra || ''}`;
}
const ONE = 'stripe-canteen-refund', ALL = 'stripe-canteen-refund-all';
const state = (c) => ({
  money: Number(q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_refunds WHERE camp='${c.C}' AND status <> 'failed'`)),
  made: q1(`SELECT coalesce(string_agg('re_' || id || ' $' || (cents/100) || CASE WHEN status='failed' THEN ' (FAILED)' ELSE '' END, ', ' ORDER BY id), 'none') FROM ted_refunds WHERE camp='${c.C}'`),
  wallet: Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${c.C}' AND account_key='Avi'`)),
  holds: q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', ' ORDER BY created_at), 'none') FROM canteen_refund_holds WHERE camp_id='${c.C}'`),
  lines: q1(`SELECT coalesce(string_agg(payload->>'stripeRefundId' || ' $' || amount, ', '), 'none') FROM canteen_transactions WHERE camp_id='${c.C}' AND payload->>'kind'='refund'`),
});
const say = (b) => !b ? '—' : b.uncertain && !b.totalRefunded ? 'UNCERTAIN: ' + String(b.error || '').slice(0, 90)
  : b.error ? 'ERROR: ' + String(b.error).slice(0, 100)
  : ('refundedCount' in b) ? `Refund All: $${b.totalRefunded}, refunded ${b.refundedCount}, failed ${b.failedCount}, skipped ${b.skippedCount}` + (b.details && b.details[0] && (b.details[0].error || b.details[0].skipped) ? ' [' + String(b.details[0].error || b.details[0].skipped).slice(0, 90) + ']' : '')
  : `$${b.totalRefunded}` + (b.replayed ? ' (replayed)' : '') + (b.cappedReason ? ' — ' + String(b.cappedReason).slice(0, 90) : '');
const run = (fn, c, body) => {
  const r = runEdges([fn], scenario(c, `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} }];`));
  return r.responses[0].body;
};
const single = (amt, key, extra) => Object.assign({ camperId: 7, camperName: 'Avi', amount: amt, idempotencyKey: key }, extra || {});
function line(ok, label, c, answers, want) {
  const s = state(c);
  console.log(`  ${ok(s) ? 'ok  ' : 'BAD '}${label}\n        answers: ${answers.map(say).join(' | ')}\n        → money back $${s.money} [${s.made}], wallet $${s.wallet}, holds [${s.holds}], history [${s.lines}]${want ? '   (want ' + want + ')' : ''}`);
}

try {
  // ── A. Refund All's answer lost, Stripe made it; next Refund All 25 h later ──
  console.log('A. Refund All refunds Avi, answer lost (Stripe made it); Refund All again 25 hours later (Stripe forgot the key)');
  for (const [lbl, tops, spent] of [['A1 $100 top-up, $50 left', [100], 50], ['A2 $20 top-up, all left', [20], 0]]) {
    const c = camp(tops, spent); clearFlags(); flag('lose');
    const a1 = run(ALL, c, {}); later(c, '25 hours', true);
    const a2 = run(ALL, c, {});
    const left = tops[0] - spent;
    line((s) => s.money === left && s.wallet === 0 && /^posted/.test(s.holds), lbl, c, [a1, a2], `money $${left} once, wallet $0, on the history`);
  }

  // ── B. the request never reached Stripe ─────────────────────────────────
  console.log('B. Refund All\'s request never reached Stripe (cut off on the way)');
  for (const [lbl, gap, forget] of [['B1 next Refund All 25 h later', '25 hours', true], ['B2 next Refund All 5 min later', '5 minutes', false]]) {
    const c = camp([50], 30); clearFlags(); flag('lose_before');
    const a1 = run(ALL, c, {}); later(c, gap, forget);
    const a2 = run(ALL, c, {});
    line((s) => s.money === 20 && s.wallet === 0, lbl, c, [a1, a2], 'money $20 once, wallet $0');
  }

  // ── C. TED-117 V3: Refund All lost, a new top-up, the office refunds it ────
  console.log('C. Refund All refunds Avi\'s $50 (answer lost, made). An hour later the parent tops up $30 and the office refunds $30');
  for (const [lbl, listFail] of [['C1 Stripe answers the lookup', false], ['C2 the lookup is rate-limited (429)', true]]) {
    const c = camp([50], 0); clearFlags(); flag('lose');
    const a1 = run(ALL, c, {}); later(c, '1 hour', false);
    topUp(c, 30); clearFlags(); if (listFail) flag('list_fail', 5);
    const a2 = run(ONE, c, single(30, 'cref_C' + campN));
    line((s) => s.money === 80 && s.wallet === 0, lbl, c, [a1, a2], 'money $80 once each, wallet $0');
    if (!listFail) {   // the office presses Refund again (the page keeps its key after an error)
      clearFlags(); const a3 = run(ONE, c, single(30, 'cref_C' + campN));
      line((s) => s.money === 80 && s.wallet === 0, lbl + ' → the office presses Refund again', c, [a3], 'money $80, wallet $0');
    }
  }

  // ── D. a single refund, same page key again ─────────────────────────────
  console.log('D. A single refund of $20 (of $50), the office presses Refund again with the page\'s same key');
  const D = [
    ['D1 answer lost (made); again 10 s later', ['lose'], null, false, 20, 30],
    ['D2 never reached Stripe; again 10 s later', ['lose_before'], null, false, 20, 30],
    ['D3 never reached; again 10 s later, payment lookup 429', ['lose_before'], 'pi_fail', false, 0, 50],
    ['D4 answer lost (made); again 25 h later (key forgotten)', ['lose'], null, '25 hours', 20, 30],
    ['D5 never reached; again 25 h later', ['lose_before'], null, '25 hours', 20, 30],
    ['D6 answer lost (made); again 10 s later with another reason', ['lose'], null, false, 20, 30, { reason: 'duplicate' }],
  ];
  for (const [lbl, f1, f2, gap, wantMoney, wantWallet, extra2] of D) {
    const c = camp([50], 0); clearFlags(); f1.forEach((f) => flag(f));
    const key = 'cref_D' + campN;
    const a1 = run(ONE, c, single(20, key)); clearFlags();
    if (gap) later(c, gap, true); else later(c, '10 seconds', false);
    if (f2) flag(f2, 5);
    const a2 = run(ONE, c, single(20, key, extra2));
    const answers = [a1, a2];
    if (f2) { clearFlags(); later(c, '3 minutes', false); answers.push(run(ONE, c, single(20, key))); }
    line((s) => s.money === (f2 ? 20 : wantMoney) && s.wallet === (f2 ? 30 : wantWallet), lbl + (f2 ? ' → pressed a 3rd time 3 min later' : ''), c, answers, f2 ? 'first answers uncertain, then $20 once, wallet $30' : `money $${wantMoney} once, wallet $${wantWallet}`);
  }

  // ── E. two top-ups, the second part's answer lost ───────────────────────
  console.log('E. Avi has $10 + $50 top-ups; a $20 refund draws $10 + $10, the second part\'s answer lost; pressed again 10 s later');
  {
    const c = camp([10, 50], 0); clearFlags();
    // lose only the 2nd refund's answer
    db.sql(`INSERT INTO ted_flags VALUES ('lose', 0) ON CONFLICT (k) DO UPDATE SET n = 0`);
    const key = 'cref_E' + campN;
    const a1 = runEdges([ONE], scenario(c, `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(single(20, key))} }];
      const __f1 = T.fetch; let __n = 0; T.fetch = async (u: string, i: any) => { if (i.method === 'POST' && u.endsWith('/refunds') && ++__n === 2) (T as any).__q("UPDATE ted_flags SET n = 1 WHERE k='lose'"); return __f1(u, i); };`)).responses[0].body;
    clearFlags(); later(c, '10 seconds', false);
    const a2 = run(ONE, c, single(20, key));
    line((s) => s.money === 20 && s.wallet === 40, 'E1', c, [a1, a2], 'money $20 once, wallet $40');
  }

  // ── F. a refund Stripe made, whose answer was lost, and which then FAILED ──
  console.log('F. Refund made, answer lost; then Stripe FAILS it (card closed) and the money comes back; asked again');
  for (const [lbl, gap, forget, who] of [['F1 Refund All again 1 hour later', '1 hour', false, 'all'], ['F2 Refund All again 25 h later', '25 hours', true, 'all'],
                                          ['F3 single refund, same page key, 1 hour later', '1 hour', false, 'one']]) {
    const c = camp([50], 30); clearFlags(); flag('lose');
    const key = 'cref_F' + campN;
    const a1 = who === 'all' ? run(ALL, c, {}) : run(ONE, c, single(20, key));
    clearFlags(); failRefund(c, 'last'); later(c, gap, forget);
    const a2 = who === 'all' ? run(ALL, c, {}) : run(ONE, c, single(20, key));
    line((s) => s.money === 20 && s.wallet === 0 || s.money === 0 && s.wallet === 20, lbl, c, [a1, a2], 'either the parent really gets $20 (money $20, wallet $0) or the $20 is back on the wallet (money $0, wallet $20)');
  }

  // ── G. regression: two deliberate $20 refunds (TED-097) ─────────────────
  {
    const c = camp([50], 0); clearFlags();
    const a1 = run(ONE, c, single(20, 'cref_G1')); const a2 = run(ONE, c, single(20, 'cref_G2'));
    console.log('G. two deliberate $20 refunds, one after the other');
    line((s) => s.money === 40 && s.wallet === 10, 'G1', c, [a1, a2], 'money $40, wallet $10');
  }
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); }
finally { db.stop && db.stop(); }
