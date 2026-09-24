// Probe (12th pass, TED-126 / TED-127). Stripe refunds that FAIL after Stripe
// accepted them — the REAL edge functions (stripe-canteen-refund,
// stripe-canteen-refund-all, stripe-webhook) against the REAL migration chain
// on a scratch Postgres (275 holds, 198 claims, 278 put-back), with a pretend
// Stripe that behaves the way Stripe documents:
//   * an Idempotency-Key replays its FIRST answer (status + body as it was
//     then), marked with the response header `Idempotent-Replayed: true`;
//     the same key with other details → 400 idempotency_error;
//   * keys are forgotten after 24 h (modelled by deleting them);
//   * GET /refunds/{id} gives the refund as it is NOW; GET /refunds?payment_intent=
//     lists them with their metadata;
//   * a refund can FAIL later (status → failed, the charge is refundable again);
//   * a request can be cut off before it reaches Stripe, or after Stripe made it;
//   * each canteen top-up carries metadata.campId (webhook camp look-up).
// Changes from the 11th-pass fake (whose F1/F3 could not show the fix):
// replays now carry the header, a replayed body's `created` ages with the
// clock, and GET /refunds/{id} exists. Mode `no_header` drops the header to
// test the `created` fallback alone.
//
// The webhook events are signed with the test secret and sent to the real
// stripe-webhook, whose reverse_failed_stripe_refund / record_external_refund
// run on the real database.
//
// "money back" = the sum of refunds Stripe made that did not fail.
// Run: node ted/probes/2026-09-24-billing-12/refund_failed_realdb.js
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5623 });

const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent',
  'refund_canteen_deposit_from_stripe', 'record_processor_transaction',
  'reverse_failed_stripe_refund', 'record_external_refund'];
const BR = bridge(db, RPCS, ['refund_intents']);
let campN = 0;
const q1 = (s) => db.sql(s).trim();
const OWNER = '0ed12000-0000-0000-0000-0000000000a1';

db.sql(`CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
  CREATE TABLE ted_charge (ref text PRIMARY KEY, camp text, amount int, refunded int NOT NULL DEFAULT 0);
  CREATE TABLE ted_refunds (id serial, camp text, pi text, cents int, hold text, status text NOT NULL DEFAULT 'succeeded', created bigint, meta jsonb);
  CREATE TABLE ted_flags (k text PRIMARY KEY, n int);
  INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@ted12') ON CONFLICT DO NOTHING;`);

// A fresh camp: Avi (#7) topped up once per entry of `tops` (dollars), spent `spent`.
function camp(tops, spent) {
  campN++;
  const C = `0ed12000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
  const refs = tops.map((_, i) => `pi_${campN}top${i + 1}`);
  let sql = `INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','P${campN}','stripe');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0}'::jsonb);`;
  tops.forEach((t, i) => { sql += `SELECT public.canteen_post('${C}', 'Avi', '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"${refs[i]}","amount":${t},"date":"2026-07-01","timestamp":${i + 1},"camperId":7}'::jsonb);
    INSERT INTO ted_charge (ref, camp, amount) VALUES ('${refs[i]}', '${C}', ${t * 100});`; });
  if (spent) sql += `SELECT public.canteen_post('${C}', 'Avi', '{"type":"debit","kind":"purchase","amount":${spent},"date":"2026-07-02","timestamp":9}'::jsonb);`;
  const total = tops.reduce((a, b) => a + b, 0);
  sql += `SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": ${total - spent}, "balanceFloor": 0}'::jsonb);`;
  db.sql(sql);
  return { C, refs };
}
function topUp(c, dollars) {     // a later top-up (a new PaymentIntent)
  const ref = `pi_${campN}late${c.refs.length + 1}`; c.refs.push(ref);
  db.sql(`SELECT public.canteen_post('${c.C}', 'Avi', '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"${ref}","amount":${dollars},"date":"2026-07-03","timestamp":20,"camperId":7}'::jsonb);
    DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${c.C}','Avi'); PERFORM public.canteen_account_save('${c.C}','Avi', a || jsonb_build_object('balance', (a->>'balance')::numeric + ${dollars})); END $x$;
    INSERT INTO ted_charge (ref, camp, amount) VALUES ('${ref}', '${c.C}', ${dollars * 100});`);
  return ref;
}
const flag = (k, n = 1) => db.sql(`INSERT INTO ted_flags VALUES ('${k}', ${n}) ON CONFLICT (k) DO UPDATE SET n = ${n}`);
const clearFlags = () => db.sql(`DELETE FROM ted_flags WHERE k <> 'no_header'`);
const setMode = (noHeader) => db.sql(noHeader ? `INSERT INTO ted_flags VALUES ('no_header', 1) ON CONFLICT (k) DO UPDATE SET n = 1` : `DELETE FROM ted_flags WHERE k = 'no_header'`);
// time passes: holds, claims, Stripe's refunds AND Stripe's saved answers all move back together
function later(c, interval, forgetKeys) {
  db.sql(`UPDATE canteen_refund_holds SET created_at = created_at - interval '${interval}' WHERE camp_id='${c.C}';
    UPDATE refund_intents SET created_at = created_at - interval '${interval}', called_at = called_at - interval '${interval}' WHERE camp_id='${c.C}';
    UPDATE ted_refunds SET created = created - extract(epoch from interval '${interval}')::bigint WHERE camp='${c.C}';
    UPDATE ted_keys SET resp = jsonb_set(resp, '{created}', to_jsonb((resp->>'created')::bigint - extract(epoch from interval '${interval}')::bigint)) WHERE resp ? 'created';`);
  if (forgetKeys) db.sql(`DELETE FROM ted_keys`);   // > 24 h: Stripe has forgotten every key
}
// Stripe fails a refund after it was made: the money goes back to the platform, the charge is refundable again
function failRefund(c, which) {
  const id = q1(`SELECT id FROM ted_refunds WHERE camp='${c.C}' AND status <> 'failed' ORDER BY id ${which === 'last' ? 'DESC' : 'ASC'} LIMIT 1`);
  db.sql(`UPDATE ted_charge t SET refunded = refunded - r.cents FROM ted_refunds r WHERE r.id = ${id} AND t.ref = r.pi;
    UPDATE ted_refunds SET status = 'failed' WHERE id = ${id};`);
  return 're_' + id;
}

const STRIPE = `
const __qq = (T as any).__q;
const __esc = (s: string) => String(s).replace(/'/g, "''");
const __flag = (k: string) => { const n = Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='" + k + "'),0)")); if (n > 0) { __qq("UPDATE ted_flags SET n = n - 1 WHERE k='" + k + "'"); return true; } return false; };
const __noHeader = () => Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='no_header'),0)")) > 0;
const __refObj = (r: any) => Object.assign({ id: 're_' + r.id, object: 'refund', amount: r.cents, payment_intent: r.pi, charge: 'ch_' + r.pi,
  status: r.status, created: Number(r.created), metadata: Object.assign(r.hold ? { campistryHold: r.hold } : {}, r.meta || {}) },
  r.status === 'failed' ? { failure_reason: 'expired_or_canceled_card' } : {});
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
      return Object.assign({ __status: seen.status }, seen.resp, __noHeader() ? {} : { __headers: { 'Idempotent-Replayed': 'true' } });
    }
    const p = new URLSearchParams(body);
    const pi = String(p.get('payment_intent')); const cents = Number(p.get('amount'));
    const row = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + __esc(pi) + "'") || 'null');
    let resp: any, status = 200;
    if (!row) { resp = { error: { type: 'invalid_request_error', message: 'No such payment_intent' } }; status = 404; }
    else if (row.amount - row.refunded <= 0) { resp = { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge ' + pi + ' has already been refunded.' } }; status = 400; }
    else if (cents > row.amount - row.refunded) { resp = { error: { type: 'invalid_request_error', message: 'Refund amount is greater than unrefunded amount on charge' } }; status = 400; }
    else {
      const meta: any = {}; for (const [kk, vv] of p.entries()) { const m = kk.match(/^metadata\\[(.+)\\]$/); if (m && m[1] !== 'campistryHold') meta[m[1]] = vv; }
      const r = JSON.parse(__qq("INSERT INTO ted_refunds (camp, pi, cents, hold, created, meta) VALUES ('" + __esc(String(row.camp)) + "','" + __esc(pi) + "'," + cents + "," + (p.get('metadata[campistryHold]') ? "'" + __esc(String(p.get('metadata[campistryHold]'))) + "'" : 'NULL') + ", extract(epoch from now())::bigint, '" + __esc(JSON.stringify(meta)) + "'::jsonb) RETURNING row_to_json(ted_refunds)::text"));
      __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + __esc(pi) + "'");
      resp = __refObj(r);
    }
    if (k) __qq("INSERT INTO ted_keys (k, body, resp, status) VALUES ('" + __esc(k) + "','" + __esc(body) + "','" + __esc(JSON.stringify(resp)) + "'::jsonb," + status + ")");
    if (__flag('lose')) throw new Error('connection reset');
    return Object.assign({ __status: status }, resp);
  }
  const one = url.match(/\\/refunds\\/re_(\\d+)$/);
  if (one && init.method !== 'POST') {
    if (__flag('get_fail')) return { __status: 500, error: { type: 'api_error', message: 'boom' } };
    const r = JSON.parse(__qq("SELECT row_to_json(x)::text FROM ted_refunds x WHERE id=" + Number(one[1])) || 'null');
    return r ? __refObj(r) : { __status: 404, error: { type: 'invalid_request_error', message: 'No such refund' } };
  }
  if (url.includes('/refunds?payment_intent=') || url.includes('/refunds?charge=')) {
    if (__flag('list_fail')) return { __status: 429, error: { type: 'rate_limit_error', message: 'Too many requests' } };
    const pi = url.includes('payment_intent=') ? decodeURIComponent(url.split('payment_intent=')[1].split('&')[0])
                                                 : decodeURIComponent(url.split('charge=')[1].split('&')[0]).replace(/^ch_/, '');
    const rows = JSON.parse(__qq("SELECT coalesce(json_agg(r ORDER BY id DESC), '[]'::json)::text FROM ted_refunds r WHERE pi='" + __esc(pi) + "'"));
    return { object: 'list', data: rows.map(__refObj), has_more: false };
  }
  if (url.includes('/payment_intents/')) {
    if (__flag('pi_fail')) return { __status: 429, error: { type: 'rate_limit_error', message: 'Too many requests' } };
    const id = decodeURIComponent(url.split('/payment_intents/')[1].split('?')[0]);
    const camp = __qq("SELECT camp FROM ted_charge WHERE ref='" + __esc(id) + "'");
    return { id, transfer_data: null, metadata: camp ? { campId: camp } : {} };
  }
  return {};
};`;

function scenario(c, extra) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
          STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${c.C}', owner: 'u-owner', payment_processor_key: 'stripe' }];
T.__camp = '${c.C}';
${BR}
// record_external_refund takes p_refs as text[] (215); the generic bridge sends
// arrays as jsonb, so this one is called with a real text[] (PostgREST does that).
T.rpc.record_external_refund = (a: any) => {
  const L = (v: any) => v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
  const refs = 'ARRAY[' + ((a.p_refs || []) as any[]).map(L).join(',') + ']::text[]';
  const out = (T as any).__q('SELECT public.record_external_refund(p_camp_id => ' + L(a.p_camp_id) + '::uuid, p_refund_id => ' + L(a.p_refund_id)
    + ', p_refs => ' + refs + ', p_amount => ' + Number(a.p_amount) + ', p_note => ' + L(a.p_note) + ')::text');
  return out === '' ? null : JSON.parse(out);
};
${STRIPE}
${extra || ''}`;
}
const ONE = 'stripe-canteen-refund', ALL = 'stripe-canteen-refund-all', HOOK = 'stripe-webhook';
const state = (c) => ({
  money: Number(q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_refunds WHERE camp='${c.C}' AND status <> 'failed'`)),
  made: q1(`SELECT coalesce(string_agg('re_' || id || ' $' || (cents/100) || CASE WHEN status='failed' THEN ' (FAILED)' ELSE '' END, ', ' ORDER BY id), 'none') FROM ted_refunds WHERE camp='${c.C}'`),
  wallet: Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${c.C}' AND account_key='Avi'`) || 'NaN'),
  holds: q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', ' ORDER BY created_at), 'none') FROM canteen_refund_holds WHERE camp_id='${c.C}'`),
  lines: q1(`SELECT coalesce(string_agg((payload->>'kind') || ' ' || coalesce(payload->>'stripeRefundId', payload->>'failedRefundId') || ' $' || amount, ', ' ORDER BY first_seen), 'none') FROM canteen_transactions WHERE camp_id='${c.C}' AND payload->>'kind' IN ('refund','refund_failed')`),
  notices: Number(q1(`SELECT count(*) FROM notifications WHERE camp_id='${c.C}' AND source='refund_failed'`)),
});
const say = (b) => !b ? '—' : typeof b === 'string' ? b.slice(0, 100) : b.uncertain && !b.totalRefunded ? 'UNCERTAIN: ' + String(b.error || '').slice(0, 90)
  : b.error ? 'ERROR: ' + String(b.error).slice(0, 100)
  : ('refundedCount' in b) ? `Refund All: $${b.totalRefunded}, refunded ${b.refundedCount}, failed ${b.failedCount}, skipped ${b.skippedCount}` + (b.details && b.details[0] && (b.details[0].error || b.details[0].skipped || b.details[0].refunded != null) ? ' [' + JSON.stringify(b.details[0]).slice(0, 140) + ']' : '')
  : ('received' in b) ? 'webhook ' + JSON.stringify(b).slice(0, 60)
  : `$${b.totalRefunded}` + (b.replayed ? ' (replayed)' : '') + (b.cappedReason ? ' — ' + String(b.cappedReason).slice(0, 90) : '');
const run = (fn, c, body) => {
  const r = runEdges([fn], scenario(c, `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} }];`));
  return r.responses[0].body;
};
// Stripe sends an event to the real webhook, signed with the test secret.
function hook(c, event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
  const r = runEdges([HOOK], scenario(c, `T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} }];`));
  const logs = (r.logs || []).filter((l) => /refund|put back|not on/i.test(l)).map((l) => l.slice(0, 160));
  return { status: r.responses[0].status, body: r.responses[0].body, emails: (r.emails || []).map((e) => e.subject), logs };
}
const refundNow = (id) => { const r = JSON.parse(q1(`SELECT row_to_json(x)::text FROM ted_refunds x WHERE id=${Number(String(id).replace('re_', ''))}`));
  return { id: 're_' + r.id, object: 'refund', amount: r.cents, payment_intent: r.pi, charge: 'ch_' + r.pi, status: r.status,
           failure_reason: r.status === 'failed' ? 'expired_or_canceled_card' : null, metadata: Object.assign(r.hold ? { campistryHold: r.hold } : {}, r.meta || {}), created: Number(r.created) }; };
let evtN = 0;
const ev = (type, obj) => ({ id: 'evt_ted12_' + (++evtN), type, created: Math.floor(Date.now() / 1000), data: { object: obj } });
const hookSay = (h) => `webhook HTTP ${h.status}` + (h.emails.length ? ` email "${h.emails[0].slice(0, 70)}"` : '') + (h.logs.length ? ` log "${h.logs[h.logs.length - 1].slice(0, 110)}"` : '');
const single = (amt, key, extra) => Object.assign({ camperId: 7, camperName: 'Avi', amount: amt, idempotencyKey: key }, extra || {});
let bad = 0;
function line(ok, label, c, answers, want) {
  const s = state(c);
  const good = ok(s); if (!good) bad++;
  console.log(`  ${good ? 'ok  ' : 'BAD '}${label}\n        answers: ${answers.map((a) => a && a.status != null && a.emails ? hookSay(a) : say(a)).join(' | ')}\n        → money back $${s.money} [${s.made}], wallet $${s.wallet}, holds [${s.holds}], history [${s.lines}], notices ${s.notices}${want ? '\n        (want ' + want + ')' : ''}`);
}

try {
  for (const noHeader of [false, true]) {
    setMode(noHeader);
    const tag = noHeader ? ' [NO replay header: the `created` fallback alone]' : ' [Stripe marks the replay]';
    // ── F. (11th pass F1-F3) answer lost, Stripe made it, then FAILED it; asked again ──
    console.log('F. Refund made, answer lost; then Stripe FAILS it (card closed); asked again' + tag);
    for (const [lbl, gap, forget, who] of [['F1 Refund All again 1 hour later', '1 hour', false, 'all'], ['F2 Refund All again 25 h later', '25 hours', true, 'all'],
                                            ['F3 single refund, same page key, 1 hour later', '1 hour', false, 'one']]) {
      const c = camp([50], 30); clearFlags(); flag('lose');
      const key = 'cref_F' + campN;
      const a1 = who === 'all' ? run(ALL, c, {}) : run(ONE, c, single(20, key));
      clearFlags(); failRefund(c, 'last'); later(c, gap, forget);
      const a2 = who === 'all' ? run(ALL, c, {}) : run(ONE, c, single(20, key));
      line((s) => s.money === 20 && s.wallet === 0 && !/FAILED[^,]*$/.test(s.lines), lbl, c, [a1, a2], 'the parent really gets $20 (money $20 from a new refund, wallet $0), the failed refund not on the history');
    }
  }
  setMode(false);

  // ── F4: the re-send is itself cut off, then pressed again (the _after_ key must be stable) ──
  console.log('F4. As F3, but the re-send under the new key is cut off after Stripe made it; the office presses Refund a 3rd time');
  {
    const c = camp([50], 30); clearFlags(); flag('lose');
    const key = 'cref_F4' + campN;
    const a1 = run(ONE, c, single(20, key));
    clearFlags(); failRefund(c, 'last'); later(c, '1 hour', false);
    // the 2nd press: the replay is detected, the new-key send is made and its answer lost
    db.sql(`INSERT INTO ted_flags VALUES ('lose', 0) ON CONFLICT (k) DO UPDATE SET n = 0`);
    const a2 = runEdges([ONE], scenario(c, `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(single(20, key))} }];
      const __f1 = T.fetch; T.fetch = async (u: string, i: any) => { if (i.method === 'POST' && u.endsWith('/refunds') && String(i.headers['Idempotency-Key'] || '').includes('_after_')) (T as any).__q("UPDATE ted_flags SET n = 1 WHERE k='lose'"); return __f1(u, i); };`)).responses[0].body;
    clearFlags(); later(c, '10 minutes', false);
    const a3 = run(ONE, c, single(20, key));
    line((s) => s.money === 20 && s.wallet === 0, 'F4', c, [a1, a2, a3], 'money $20 once (never $40), wallet $0');
  }

  // ── C. TED-127: after the look-up settles a stuck refund, refund a new top-up ──
  console.log('C. Refund All refunds Avi\'s $50 (answer lost, made). An hour later the parent tops up $30 and the office refunds $30');
  {
    const c = camp([50], 0); clearFlags(); flag('lose');
    const a1 = run(ALL, c, {}); later(c, '1 hour', false);
    topUp(c, 30); clearFlags();
    const a2 = run(ONE, c, single(30, 'cref_C' + campN));
    line((s) => s.money === 80 && s.wallet === 0 && !/ERROR/.test(say(a2)), 'C1 (TED-127) first press', c, [a1, a2], '$30 refunded on the FIRST press: money $80, wallet $0');
  }

  // ── W. the webhook hears a canteen refund fail ────────────────────────────
  console.log('W. Refund All refunds Avi\'s $20 (answer received). Later Stripe FAILS it and sends refund.failed');
  for (const [lbl, gap, forget] of [['W1 failed 3 days later; the office runs Refund All again', '3 days', true],
                                    ['W1b failed 2 hours later; the office runs Refund All again', '2 hours', false]]) {
    const c = camp([20], 0); clearFlags();
    const a1 = run(ALL, c, {});
    later(c, gap, forget);
    const re = failRefund(c, 'last');
    const h1 = hook(c, ev('refund.failed', refundNow(re)));
    const s1 = state(c);
    const h2 = hook(c, ev('refund.failed', refundNow(re)));            // Stripe re-sends the event
    const h3 = hook(c, ev('charge.refund.updated', refundNow(re)));    // and the older-style event too
    const s2 = state(c);
    console.log(`    after the webhook: wallet $${s1.wallet} [${s1.lines}], notices ${s1.notices}; after 2 more deliveries: wallet $${s2.wallet}, notices ${s2.notices}  (${hookSay(h1)} | ${hookSay(h2)} | ${hookSay(h3)})`);
    const ok1 = s1.wallet === 20 && s2.wallet === 20 && s2.notices === 1 && /refund_failed/.test(s1.lines);
    if (!ok1) bad++;
    console.log(`  ${ok1 ? 'ok  ' : 'BAD '}${lbl.split(';')[0]}: the $20 back on the wallet once, a "refund failed" line, one notice`);
    const a2 = run(ALL, c, {});
    line((s) => s.money === 20 && s.wallet === 0, lbl, c, [a1, h1, a2], 'the $20 refunded again for real: money $20 (a NEW refund), wallet $0 — or, if not, an answer that says why');
  }
  {
    console.log('W2. As W1, but the office uses the child\'s own Refund button (a new page key) after the put-back');
    const c = camp([20], 0); clearFlags();
    const a1 = run(ALL, c, {}); later(c, '3 days', true);
    const re = failRefund(c, 'last');
    const h1 = hook(c, ev('refund.failed', refundNow(re)));
    const a2 = run(ONE, c, single(20, 'cref_W2' + campN));
    line((s) => s.money === 20 && s.wallet === 0, 'W2', c, [a1, h1, a2], 'money $20 (a new refund), wallet $0');
  }
  {
    console.log('W3. Refund All\'s answer LOST (money held); Stripe fails the refund and its refund.failed arrives BEFORE any look-up; Refund All 1 hour later');
    const c = camp([20], 0); clearFlags(); flag('lose');
    const a1 = run(ALL, c, {}); clearFlags();
    const re = failRefund(c, 'last'); later(c, '1 hour', false);
    const h1 = hook(c, ev('refund.failed', refundNow(re)));
    const sMid = state(c);
    console.log(`    after the webhook: wallet $${sMid.wallet}, holds [${sMid.holds}], history [${sMid.lines}]`);
    const a2 = run(ALL, c, {});
    line((s) => s.money === 20 && s.wallet === 0 && (s.lines.match(/refund_failed/g) || []).length === 0, 'W3', c, [a1, h1, a2], 'the parent gets $20 once (a new refund), wallet $0, the money never put back twice');
  }
  {
    console.log('W4. A normal refund.updated (still succeeded) and a charge.refunded carrying the refund AFTER it failed');
    const c = camp([20], 0); clearFlags();
    run(ALL, c, {});
    const re = q1(`SELECT 're_' || max(id) FROM ted_refunds WHERE camp='${c.C}'`);
    const h0 = hook(c, ev('refund.updated', refundNow(re)));
    const s0 = state(c);
    failRefund(c, 'last');
    const h1 = hook(c, ev('refund.failed', refundNow(re)));
    const ch = { id: 'ch_' + c.refs[0], object: 'charge', payment_intent: c.refs[0], metadata: { campId: c.C }, refunds: { data: [refundNow(re)] } };
    const h2 = hook(c, ev('charge.refunded', ch));
    const chNoList = { id: 'ch_' + c.refs[0], object: 'charge', payment_intent: c.refs[0], metadata: { campId: c.C } };
    const h3 = hook(c, ev('charge.refunded', chNoList));
    console.log(`    refund.updated(succeeded) → wallet $${s0.wallet} (unchanged 0)`);
    line((s) => s0.wallet === 0 && s.wallet === 20 && (s.lines.match(/refund_failed/g) || []).length === 1 && (s.lines.match(/refund re_/g) || []).length === 1,
      'W4', c, [h0, h1, h2, h3], 'wallet $20 once; the failed refund not booked a second time by charge.refunded');
  }

  // ── T. the webhook hears a TUITION refund fail ───────────────────────────
  console.log('T. Gold paid $500 tuition by card (pi_T); the office refunded $500 through Billing (re_T). Stripe fails it and sends refund.failed');
  const famCamp = (label) => {
    campN++;
    const C = `0ed12000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
    const pi = `pi_${campN}T`;
    db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','T${campN}','stripe');
      INSERT INTO ted_charge (ref, camp, amount, refunded) VALUES ('${pi}', '${C}', 50000, 50000);`);
    // the refund Stripe made for Billing's click (stripe-refund stamps metadata campId)
    const reId = 're_' + q1(`INSERT INTO ted_refunds (camp, pi, cents, created, meta) VALUES ('${C}', '${pi}', 50000, extract(epoch from now())::bigint - 86400*3, '{"campId":"${C}","family":"Gold"}'::jsonb) RETURNING id`);
    const fam = { name: 'Gold', camperIds: ['Dov Gold'], stripeCustomerId: 'cus_gold',
      entries: [
        { id: 'le_t', kind: 'charge', amount: 500, reason: 'tuition', date: '2026-06-01' },
        { id: 'le_pay_' + pi, kind: 'payment', amount: 500, reason: 'card', date: '2026-06-02', by: 'system', source: { paymentId: pi } },
        // what Billing's _postPaymentEntry posts for the refund row (campistry_me.js:6290-6299)
        { id: 'le_pay_' + reId, kind: 'refund', amount: 500, reason: 'refund', date: '2026-09-20', note: 'Refund — Requested by customer (Stripe)', by: 'system', source: { paymentId: reId } }] };
    db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', jsonb_build_object('gold', '${JSON.stringify(fam).replace(/'/g, "''")}'::jsonb)));`);
    // the payments list, as Billing writes it (campistry_me.js:18715-18727)
    const payRow = { id: 'pi_' + pi, family: 'Gold', familyKey: 'gold', amount: 500, date: '2026-06-02', method: 'Card', stripePaymentIntentId: pi, status: 'succeeded', timestamp: Date.now() - 20 * 86400000 };
    const refRow = { id: 'ref_1_0', family: 'Gold', familyKey: 'gold', amount: -500, date: '2026-09-20', method: 'Refund', reference: reId, notes: 'Refund — Requested by customer (Stripe)',
      reason: 'requested_by_customer', refundOf: 'pi_' + pi, stripeRefundId: reId, byopRefundId: null, byopProcessor: null, offline: false, timestamp: Date.now() - 3 * 86400000 };
    db.sql(`SELECT public.camp_payment_add('${C}', '${JSON.stringify(payRow)}'::jsonb); SELECT public.camp_payment_add('${C}', '${JSON.stringify(refRow)}'::jsonb);`);
    return { C, refs: [pi], reId, label };
  };
  const famState = (c) => ({
    owes: Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${c.C}','gold'))`)),
    entries: q1(`SELECT string_agg((e->>'kind') || ':' || (e->>'amount') || coalesce('/' || (e->>'reason'), ''), ', ') FROM jsonb_array_elements(public.camp_family('${c.C}','gold')->'entries') e`),
    rows: q1(`SELECT string_agg(payment_id || ' $' || amount, ', ' ORDER BY payment_id) FROM camp_payments WHERE camp_id='${c.C}' AND deleted_at IS NULL`),
    notices: Number(q1(`SELECT count(*) FROM notifications WHERE camp_id='${c.C}' AND source='refund_failed'`)),
    notice: q1(`SELECT coalesce(max(body), '') FROM notifications WHERE camp_id='${c.C}' AND source='refund_failed'`),
  });
  {
    const c = famCamp('T1');
    const s0 = famState(c);
    failRefund(c, 'last');
    const h1 = hook(c, ev('refund.failed', refundNow(c.reId)));
    const s1 = famState(c);
    const h2 = hook(c, ev('refund.failed', refundNow(c.reId)));
    const h3 = hook(c, ev('refund.updated', refundNow(c.reId)));
    db.sql(`SELECT public.sync_family_ledger_payments('${c.C}', 'gold')`);
    const s2 = famState(c);
    console.log(`    before: owes $${s0.owes} [${s0.entries}]`);
    console.log(`    after refund.failed: owes $${s1.owes} [${s1.entries}] rows [${s1.rows}] notices ${s1.notices}  (${hookSay(h1)})`);
    console.log(`    after 2 more deliveries + the ledger sync: owes $${s2.owes}, rows [${s2.rows}], notices ${s2.notices}  (${hookSay(h2)} | ${hookSay(h3)})`);
    console.log(`    the notice says: "${s1.notice}"`);
    const ok = s0.owes === 500 && s1.owes === 0 && s2.owes === 0 && s2.notices === 1 && (s2.rows.match(/refail_/g) || []).length === 1;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'BAD '}T1 the $500 goes back on Gold's account once (owes 500 → 0), one payments row, one notice`);

    // What Billing then offers: the REAL page functions, over the rows as the page loads them.
    const ME = fs.readFileSync(R + '/campistry_me.js', 'utf8');
    const cut = (name) => { const at = ME.indexOf('function ' + name + '('); let i = ME.indexOf('{', at), d = 0;
      for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; } return ME.slice(at, i + 1); };
    const finPayments = JSON.parse(q1(`SELECT json_agg(payload ORDER BY payment_id)::text FROM camp_payments WHERE camp_id='${c.C}' AND deleted_at IS NULL`));
    const fam = JSON.parse(q1(`SELECT public.camp_family('${c.C}','gold')::text`));
    const ctx = { finPayments, normalizePersonId: () => null, camperNameById: () => null, Date, Math, String, Number };
    vm.createContext(ctx);
    vm.runInContext(['_famRefundablePayments', '_paymentAgeDays', '_famRefundableOnlineAll', '_famRefundableOnline'].map(cut).join('\n') +
      '\nvar REFUND_WINDOW_DAYS=120;\nthis.onl = _famRefundableOnline; this.any = _famRefundablePayments;', ctx);
    const onl = ctx.onl(fam).map((d) => `${d.p.id} $${d.remaining}`);
    const any = ctx.any(fam).map((p) => `${p.id} $${p.amount}`);
    console.log(`    Billing → Refund to card/bank can draw on: [${onl.join(', ') || 'nothing'}]   (payments the page counts as refundable at all: [${any.join(', ')}])`);
    const okCard = onl.length > 0;
    console.log(`  ${okCard ? 'ok  ' : 'NOTE'}T1b after the put-back, Billing's card refund ${okCard ? 'offers the money again' : 'offers NOTHING — "No online charges on record for this family — use Offline Refund instead"'} (the notice says "refund it again from Billing")`);
  }
  {
    console.log('T2. A refund made in the Stripe DASHBOARD (booked by charge.refunded), which then fails');
    campN++;
    const C = `0ed12000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
    const pi = `pi_${campN}D`;
    const c = { C, refs: [pi] };
    db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','D${campN}','stripe');
      INSERT INTO ted_charge (ref, camp, amount, refunded) VALUES ('${pi}', '${C}', 50000, 20000);
      INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', jsonb_build_object('gold',
        '{"name":"Gold","camperIds":["Dov Gold"],"entries":[{"id":"le_t","kind":"charge","amount":500,"reason":"tuition"},{"id":"le_pay_${pi}","kind":"payment","amount":500,"reason":"card","source":{"paymentId":"${pi}"}}]}'::jsonb)));
      SELECT public.camp_payment_add('${C}', '{"id":"pi_${pi}","family":"Gold","familyKey":"gold","amount":500,"method":"Card","stripePaymentIntentId":"${pi}","status":"succeeded","date":"2026-06-02"}'::jsonb);`);
    const reId = 're_' + q1(`INSERT INTO ted_refunds (camp, pi, cents, created, meta) VALUES ('${C}', '${pi}', 20000, extract(epoch from now())::bigint, '{}'::jsonb) RETURNING id`);
    const ch = { id: 'ch_' + pi, object: 'charge', payment_intent: pi, metadata: { campId: C } };        // newer API: no refunds list on the charge
    const h1 = hook(c, ev('charge.refunded', ch));
    const s1 = famState(c);
    failRefund(c, 'last');
    const h2 = hook(c, ev('refund.failed', refundNow(reId)));
    const s2 = famState(c);
    console.log(`    charge.refunded → owes $${s1.owes} [${s1.entries}]  (${hookSay(h1)})`);
    console.log(`    refund.failed   → owes $${s2.owes} [${s2.entries}] notices ${s2.notices}  (${hookSay(h2)})`);
    const ok = s1.owes === 200 && s2.owes === 0 && s2.notices === 1;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'BAD '}T2 dashboard refund booked (owes 200), then put back when it fails (owes 0), one notice`);
  }
  {
    console.log('T3. A dashboard refund that failed BEFORE its charge.refunded was delivered (refund.failed first, then charge.refunded)');
    campN++;
    const C = `0ed12000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
    const pi = `pi_${campN}E`;
    const c = { C, refs: [pi] };
    db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','E${campN}','stripe');
      INSERT INTO ted_charge (ref, camp, amount, refunded) VALUES ('${pi}', '${C}', 50000, 20000);
      INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', jsonb_build_object('gold',
        '{"name":"Gold","camperIds":["Dov Gold"],"entries":[{"id":"le_t","kind":"charge","amount":500,"reason":"tuition"},{"id":"le_pay_${pi}","kind":"payment","amount":500,"reason":"card","source":{"paymentId":"${pi}"}}]}'::jsonb)));
      SELECT public.camp_payment_add('${C}', '{"id":"pi_${pi}","family":"Gold","familyKey":"gold","amount":500,"method":"Card","stripePaymentIntentId":"${pi}","status":"succeeded","date":"2026-06-02"}'::jsonb);`);
    const reId = 're_' + q1(`INSERT INTO ted_refunds (camp, pi, cents, created, meta) VALUES ('${C}', '${pi}', 20000, extract(epoch from now())::bigint, '{}'::jsonb) RETURNING id`);
    const snapshotAtRefund = refundNow(reId);            // the charge.refunded event was created while the refund stood
    failRefund(c, 'last');
    const h1 = hook(c, ev('refund.failed', refundNow(reId)));
    for (const [lbl2, chg] of [['newer API (no list on the charge: asked for)', { id: 'ch_' + pi, object: 'charge', payment_intent: pi, metadata: { campId: C } }],
                               ['older API (the list as it was when the event was made)', { id: 'ch_' + pi, object: 'charge', payment_intent: pi, metadata: { campId: C }, refunds: { data: [snapshotAtRefund] } }]]) {
      const h2 = hook(c, ev('charge.refunded', chg));
      const s = famState(c);
      console.log(`    ${lbl2}: owes $${s.owes} [${s.entries}]  (${hookSay(h1)} | ${hookSay(h2)})`);
    }
  }
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); bad++; }
finally { db.stop && db.stop(); }
console.log(`\n${bad} BAD`);
