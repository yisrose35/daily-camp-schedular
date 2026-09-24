// Probe (14th pass, hunt: canteen auto-reload after the season). Avi's parent
// turned on Link's canteen Auto-Reload ("when the balance drops below $5, add
// $20") with a saved card, and left the optional Active dates empty (the form's
// default). Camp ends; the office returns every child's canteen money with
// Snacks → Refund All. The auto-reload job runs every 30 minutes, every day
// (CANTEEN_AUTORELOAD_SETUP.md's cron line: '*/30 7-18 * * *').
//
// The REAL stripe-canteen-refund-all, the REAL canteen-auto-reload (as the
// cron calls it, with the x-cron-secret) and the REAL stripe-webhook, on the
// REAL migration chain, with a pretend Stripe that records every charge.
//   A1 Refund All at the end of the season → $30 back to the parent, wallet $0
//   A2 the next auto-reload run → is the parent's card charged again?
//   A3 the webhook credits it → the wallet after the season
//   A4 the office runs Refund All again → then the next day's run?
//   A5 Bea's parent chose the WEEKLY reload ("every <today's weekday>, add $25"),
//      no dates, $0 on the wallet after Refund All → the run on that weekday
// Run: node ted/probes/2026-09-24-billing-14/autoreload_after_season.js
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5661 });

const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent',
  'refund_canteen_deposit_from_stripe', 'record_processor_transaction',
  'reverse_failed_stripe_refund', 'record_external_refund', 'claim_refund_failure_alert',
  'canteen_autoreload_accounts', 'update_canteen_autoreload_state', 'credit_canteen_balance_from_stripe'];
const BR = bridge(db, RPCS, ['refund_intents']);
let campN = 0;
const q1 = (s) => db.sql(s).trim();
const OWNER = '0ed12000-0000-0000-0000-0000000000a1';

db.sql(`CREATE TABLE ted_keys (k text PRIMARY KEY, body text, resp jsonb, status int);
  CREATE TABLE ted_charge (ref text PRIMARY KEY, camp text, amount int, refunded int NOT NULL DEFAULT 0);
  CREATE TABLE ted_refunds (id serial, camp text, pi text, cents int, hold text, status text NOT NULL DEFAULT 'succeeded', created bigint, meta jsonb);
  CREATE TABLE ted_flags (k text PRIMARY KEY, n int);
  CREATE TABLE ted_pis (id serial, camp text, customer text, cents int, meta jsonb, at timestamptz DEFAULT now());
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
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(String(init.body || ''));
    const r = JSON.parse(__qq("INSERT INTO ted_pis (camp, customer, cents, meta) VALUES ('" + __esc(String(p.get('metadata[campId]'))) + "','" + __esc(String(p.get('customer'))) + "'," + Number(p.get('amount')) + ",'" + __esc(JSON.stringify(Object.fromEntries([...p.entries()].filter(([k]) => k.startsWith('metadata['))))) + "'::jsonb) RETURNING row_to_json(ted_pis)::text"));
    __qq("INSERT INTO ted_charge (ref, camp, amount) VALUES ('pi_reload" + r.id + "','" + __esc(String(r.camp)) + "'," + r.cents + ")");
    return { id: 'pi_reload' + r.id, object: 'payment_intent', amount: r.cents, amount_received: r.cents, status: 'succeeded', customer: r.customer,
             metadata: { campId: r.camp, camperName: 'Avi', camperId: '7', source: 'campistry-canteen-deposit', auto: 'true' } };
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

function autoReload(c, cfg, name, id) {
  db.sql(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${c.C}','${name}'); PERFORM public.canteen_account_save('${c.C}','${name}', a || jsonb_build_object('camperId', ${id}, 'autoReload', ${"'"}${JSON.stringify(cfg)}${"'"}::jsonb)); END $x$;`);
}
const CRON = (c, ts) => `T.env.CANTEEN_AUTORELOAD_CRON_SECRET = 'cron_s';
// canteen_autoreload_accounts RETURNS TABLE: read it as rows (PostgREST hands back a JSON array)
T.rpc.canteen_autoreload_accounts = (a: any) => JSON.parse((T as any).__q("SELECT coalesce(json_agg(x), '[]'::json)::text FROM public.canteen_autoreload_accounts("
  + (a && a.p_camp_id ? "p_camp_id => '" + String(a.p_camp_id).replace(/'/g, "''") + "'::uuid" : '') + ") x") || '[]'); T.tables.camps = [{ id: '${c.C}', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: null, stripe_charges_enabled: false, name: 'P' }];
${ts ? `const __RealDate = Date; (globalThis as any).Date = class extends __RealDate { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(${ts}); } static now() { return ${ts}; } };` : ''}
T.requests = [{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }];`;
function cron(c, ts) {
  const r = runEdges(['canteen-auto-reload'], scenario(c, CRON(c, ts)));
  const b = r.responses[0].body;
  return (b.details || []).map((d) => `${d.camper} ${d.kind || ''} $${d.amount} → ${d.result}`).join('; ') || JSON.stringify(b).slice(0, 120);
}
const charges = (c) => q1(`SELECT coalesce(string_agg('$' || (cents/100) || ' from ' || customer, ', ' ORDER BY id), 'none') FROM ted_pis WHERE camp='${c.C}'`);
const walletOf = (c, n) => Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${c.C}' AND account_key='${n}'`));
function creditByWebhook(c) {
  const rows = JSON.parse(q1(`SELECT coalesce(json_agg(p), '[]'::json)::text FROM ted_pis p WHERE camp='${c.C}' AND NOT coalesce((meta->>'credited')::boolean, false)`));
  for (const p of rows) {
    const meta = {}; Object.entries(p.meta || {}).forEach(([k, v]) => { const m = k.match(/^metadata\[(.+)\]$/); if (m) meta[m[1]] = v; });
    const h = hook(c, ev('payment_intent.succeeded', { id: 'pi_reload' + p.id, object: 'payment_intent', amount: p.cents, amount_received: p.cents, status: 'succeeded',
      customer: p.customer, payment_method_types: ['card'], metadata: meta }));
    db.sql(`UPDATE ted_pis SET meta = meta || '{"credited": true}'::jsonb WHERE id = ${p.id}`);
    if (h.status !== 200) console.log('    webhook HTTP ' + h.status);
  }
}
try {
  const c = camp([30], 0);
  const reload = { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_avi', stripePaymentMethodId: 'pm_avi',
    thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 };
  autoReload(c, reload, 'Avi', 7);
  console.log(`SETUP: Avi (#7): $30 topped up by card; Auto-Reload on (below $5 → add $20), saved card cus_avi, no Active dates. Camp is over.`);

  console.log('\nA1. The office runs Refund All (Snacks) to return every child\'s money');
  const a1 = run(ALL, c, {});
  console.log(`    ${say(a1)}; money back $${state(c).money}; Avi's wallet $${walletOf(c, 'Avi')}`);

  console.log('\nA2. The auto-reload job\'s next run (the cron, every 30 minutes)');
  console.log(`    runner: ${cron(c)}`);
  console.log(`    charges to parents' cards so far: ${charges(c)}`);
  creditByWebhook(c);
  console.log(`A3. Stripe confirms it → the real webhook: Avi's wallet $${walletOf(c, 'Avi')}`);
  const n1 = Number(q1(`SELECT count(*) FROM ted_pis WHERE camp='${c.C}'`));
  if (n1 > 0) bad++;
  console.log(`  ${n1 === 0 ? 'ok  ' : 'BAD '}A2 after the season's Refund All, the parent's card is not charged again   → ${n1} charge(s): ${charges(c)}`);

  console.log('\nA4. The office notices $20 on Avi\'s wallet and runs Refund All again; the job runs the next day');
  const a4 = run(ALL, c, {});
  console.log(`    ${say(a4)}; money back $${state(c).money}; Avi's wallet $${walletOf(c, 'Avi')}`);
  const tomorrow = Date.now() + 86400000;
  console.log(`    runner (next day): ${cron(c, tomorrow)}`);
  creditByWebhook(c);
  console.log(`    charges to the parent's card: ${charges(c)}; Avi's wallet $${walletOf(c, 'Avi')}`);

  console.log('\nA5. Bea (#8): WEEKLY reload on today\'s weekday, $25, no dates; wallet $0 after Refund All');
  db.sql(`INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${c.C}', 8, 'camper', 'Bea', 'Bea');
    SELECT public.canteen_account_save('${c.C}', 'Bea', '{"balance": 0, "camperId": 8}'::jsonb);`);
  const dow = new Date().getUTCDay();
  autoReload(c, { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_bea', stripePaymentMethodId: 'pm_bea', thresholdEnabled: false,
    scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDay: dow, scheduleReloadAmount: 25, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 }, 'Bea', 8);
  const wk = [0, 7, 14].map((d) => Date.now() + (d + 1) * 0 + d * 86400000);
  wk.forEach((ts, i) => { console.log(`    week ${i + 1} (${new Date(ts).toISOString().slice(0, 10)}): ${cron(c, ts).split('; ').filter((x) => /Bea/.test(x)).join('; ') || 'nothing for Bea'}`); });
  const nb = Number(q1(`SELECT count(*) FROM ted_pis WHERE camp='${c.C}' AND customer='cus_bea'`));
  if (nb > 0) bad++;
  console.log(`  ${nb === 0 ? 'ok  ' : 'BAD '}A5 after camp, a weekly reload does not keep charging   → Bea's parent charged ${nb} time(s): ${q1(`SELECT coalesce(string_agg('$' || (cents/100), ', '), 'none') FROM ted_pis WHERE camp='${c.C}' AND customer='cus_bea'`)}`);
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); bad++; }
finally { db.stop && db.stop(); }
console.log(`\n${bad} BAD`);
