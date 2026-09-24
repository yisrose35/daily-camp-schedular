// Probe (10th pass): canteen refunds — the REAL edge functions against the REAL
// migration chain (275's reserve/settle/release, 198's claims, 273's stale
// release) on a scratch Postgres, with a pretend Stripe / Cardknox whose memory
// (idempotency keys, what was refunded) lives in the same database so it
// survives between separate presses.
//
//   A. TED-110 re-check: Refund All and a single refund of the same child at
//      once, the second landing at 3 moments (first one reading balances /
//      just reserved / at the card company), $20 and $10, both processors.
//   B. A canteen sale while Refund All is running.
//   C. Cardknox: Refund All's answer for Avi is lost. What can the office do
//      afterwards? (Refund All again; the single refund; the Snacks page.)
//   D. Cardknox: a single refund's answer is lost; the office reloads Snacks
//      (new key) and refunds the same child again.
//   E. Stripe: a refund whose answer was lost is re-asked MORE THAN 24 HOURS
//      later, after Stripe has dropped the idempotency key (Stripe documents
//      that keys are pruned after 24 h and a reused pruned key is a NEW
//      request). E1: a $100 top-up (room left on it). E2: a $20 top-up refunded
//      in full.
// Run: node ted/probes/2026-09-24-billing-10/canteen_holds_realdb.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require('./realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5565 });

const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent',
  'refund_canteen_deposit_from_stripe', 'record_processor_transaction'];
const BR = bridge(db, RPCS, ['refund_intents']);
let campN = 0;
const q1 = (s) => db.sql(s).trim();

db.sql(`CREATE TABLE ted_keys (k text PRIMARY KEY, resp jsonb, status int);
  CREATE TABLE ted_charge (ref text PRIMARY KEY, amount int, refunded int NOT NULL DEFAULT 0);
  CREATE TABLE ted_money (id serial, camp text, ref text, cents int, refund_id text);
  CREATE TABLE ted_flags (k text PRIMARY KEY, n int);
  INSERT INTO auth.users (id, email) VALUES ('0ed00000-0000-0000-0000-0000000000a1','o@ted') ON CONFLICT DO NOTHING;`);

// A fresh camp: Avi (#7) topped up `topup` once (Stripe pi / Cardknox X ref) and spent `spent`.
function camp(proc, topup, spent) {
  campN++;
  const C = `0ed00000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
  const ref = (proc === 'stripe' ? 'pi_' : 'X') + campN + 'top';
  const dep = proc === 'stripe' ? `"stripePaymentIntentId":"${ref}"` : `"byopTransactionId":"${ref}"`;
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','0ed00000-0000-0000-0000-0000000000a1','P${campN}','${proc}');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0}'::jsonb);
    SELECT public.canteen_post('${C}', 'Avi', '{"type":"credit","kind":"deposit","method":"${proc}",${dep},"amount":${topup},"date":"2026-07-01","timestamp":1}'::jsonb);
    ${spent ? `SELECT public.canteen_post('${C}', 'Avi', '{"type":"debit","kind":"purchase","amount":${spent},"date":"2026-07-02","timestamp":2}'::jsonb);` : ''}
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": ${topup - spent}, "balanceFloor": 0}'::jsonb);
    INSERT INTO ted_charge (ref, amount) VALUES ('${ref}', ${topup * 100});`);
  return { C, ref, proc };
}

// Pretend processors, remembered in the scratch DB.
const PROCESSORS = `
const __qq = (T as any).__q;
const __flag = (k: string) => { const n = Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='" + k + "'),0)")); if (n > 0) { __qq("UPDATE ted_flags SET n = n - 1 WHERE k='" + k + "'"); return true; } return false; };
const __refund = (ref: string, cents: number): any => {
  const row = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + ref + "'") || 'null');
  if (!row) return { err: 'No such charge' };
  const room = row.amount - row.refunded;
  if (room <= 0) return { err: 'Charge ' + ref + ' has already been refunded.' };
  if (cents > room) return { err: 'Refund amount ($' + (cents/100).toFixed(2) + ') is greater than unrefunded amount on charge ($' + (room/100).toFixed(2) + ')' };
  const id = __qq("INSERT INTO ted_money (camp, ref, cents) VALUES ('" + T.__camp + "','" + ref + "'," + cents + ") RETURNING 're_' || id");
  __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + ref + "'");
  __qq("UPDATE ted_money SET refund_id='" + id + "' WHERE 're_' || id = '" + id + "'");
  return { id };
};
T.fetch = async (url: string, init: any) => {
  if (T.hookAt === 'processor' && !T.nested && !T.fired && (url.endsWith('/refunds') || String(init.body || '').includes('cc%3Arefund'))) { T.fired = true; await T.runOther(0, T.otherBody); }
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key'];
    const seen = JSON.parse(__qq("SELECT json_build_object('resp', resp, 'status', status)::text FROM ted_keys WHERE k='" + String(k).replace(/'/g, "''") + "'") || 'null');
    if (seen) { if (__flag('lose')) throw new Error('connection reset'); return Object.assign({ __status: seen.status }, seen.resp); }
    const p = new URLSearchParams(init.body);
    const r = __refund(String(p.get('payment_intent')), Number(p.get('amount')));
    const resp = r.err ? { error: { type: 'invalid_request_error', message: r.err } } : { id: r.id, status: 'succeeded', amount: Number(p.get('amount')) };
    const status = r.err ? 400 : 200;
    if (k) __qq("INSERT INTO ted_keys (k, resp, status) VALUES ('" + String(k).replace(/'/g, "''") + "','" + JSON.stringify(resp).replace(/'/g, "''") + "'::jsonb," + status + ")");
    if (__flag('lose')) throw new Error('connection reset');
    return Object.assign({ __status: status }, resp);
  }
  if (url.includes('/payment_intents/')) return { id: url.split('/').pop(), transfer_data: null };
  if (String(init.body || '').includes('cc%3Arefund')) {
    const p = new URLSearchParams(init.body);
    const r = __refund(String(p.get('xRefNum')), Math.round(Number(p.get('xAmount')) * 100));
    if (__flag('lose')) throw new Error('connection reset');
    return r.err ? 'xResult=E&xStatus=Error&xError=' + encodeURIComponent(r.err) : 'xResult=A&xStatus=Approved&xRefNum=' + r.id;
  }
  return {};
};`;

function scenario(c, extra) {
  return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${c.C}', owner: 'u-owner', payment_processor_key: '${c.proc}' }];
T.__camp = '${c.C}';
${BR}
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
T.nested = false; T.fired = false; T.tables.__answers = [];
T.runOther = async (idx: number, body: any) => {
  T.nested = true;
  const r = await T.handlers[idx](new Request('http://edge.test/fn', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify(body) }));
  T.tables.__answers.push({ fn: idx, body: await r.json() });
  T.nested = false;
};
// the second office lands while the first is reading balances, or just after it reserved
const __view = T.rpc.canteen_refund_view, __res = T.rpc.reserve_canteen_refund;
T.rpc.canteen_refund_view = async (a: any) => { const v = __view(a); if (T.hookAt === 'view' && !T.nested && !T.fired) { T.fired = true; await T.runOther(0, T.otherBody); } return v; };
T.rpc.reserve_canteen_refund = async (a: any) => { const v = __res(a); if (T.hookAt === 'reserve' && !T.nested && !T.fired) { T.fired = true; await T.runOther(0, T.otherBody); } return v; };
${PROCESSORS}
${extra || ''}`;
}

const fns = (proc) => proc === 'stripe'
  ? { one: 'stripe-canteen-refund', all: 'stripe-canteen-refund-all' }
  : { one: 'payments-canteen-refund', all: 'payments-canteen-refund-all' };
const state = (c) => ({
  money: q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_money WHERE camp='${c.C}'`),
  wallet: q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${c.C}' AND account_key='Avi'`),
  holds: q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', ' ORDER BY created_at), 'none') FROM canteen_refund_holds WHERE camp_id='${c.C}'`),
  lines: q1(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${c.C}' AND payload->>'kind'='refund'`),
});
const say = (b) => !b ? '—' : b.uncertain ? 'UNCERTAIN: ' + String(b.error || '').slice(0, 110)
  : b.error ? 'ERROR: ' + String(b.error).slice(0, 110)
  : ('refundedCount' in b) ? `Refund All: $${b.totalRefunded}, refunded ${b.refundedCount}, failed ${b.failedCount}, skipped ${b.skippedCount}` + (b.details && b.details[0] && (b.details[0].error || b.details[0].skipped) ? ' [' + String(b.details[0].error || b.details[0].skipped).slice(0, 120) + ']' : '')
  : `$${b.totalRefunded}` + (b.replayed ? ' (replayed)' : '') + (b.cappedReason ? ' — ' + String(b.cappedReason).slice(0, 120) : '');
const run = (names, c, body, extra) => {
  const r = runEdges(names, scenario(c, `T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} }];\n` + (extra || '')));
  return { first: r.responses[0], others: (r.tables.__answers || []).map(a => a.body), logs: r.logs };
};
const single = (amt, key) => ({ camperId: 7, camperName: 'Avi', amount: amt, idempotencyKey: key });

try {
  // ── A. the race, real SQL ─────────────────────────────────────────────────
  console.log('A. Refund All + a single refund of Avi at once ($20 left of a $50 top-up)');
  for (const proc of ['stripe', 'cardknox']) {
    const F = fns(proc);
    for (const amt of [20, 10]) for (const first of ['single', 'all']) for (const hookAt of ['view', 'reserve', 'processor']) {
      const c = camp(proc, 50, 30);
      const names = first === 'single' ? [F.all, F.one] : [F.one, F.all];
      const firstBody = first === 'single' ? single(amt, 'cref_A' + campN) : {};
      const otherBody = first === 'single' ? {} : single(amt, 'cref_A' + campN);
      const r = run(names, c, firstBody, `T.hookAt = '${hookAt}'; T.otherBody = ${JSON.stringify(otherBody)};`);
      const s = state(c);
      const ok = Number(s.money) === 20 && Number(s.wallet) === 0 && Number(s.money) + Number(s.wallet) === 20;
      console.log(`  ${ok ? 'ok  ' : 'BAD '}${proc.padEnd(8)} $${amt} ${first}-first, 2nd lands at ${hookAt.padEnd(9)} → money back $${s.money}, wallet $${s.wallet}, holds [${s.holds}], ledger lines ${s.lines} | 1st: ${say(r.first.body)} | 2nd: ${say(r.others[0])}`);
    }
  }

  // ── B. a sale during Refund All ──────────────────────────────────────────
  console.log('B. A $15 canteen sale lands after Refund All read the balances ($20 left)');
  for (const proc of ['stripe', 'cardknox']) {
    const c = camp(proc, 50, 30);
    const saleSql = `DO $s$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${c.C}','Avi'); PERFORM public.canteen_account_save('${c.C}','Avi', a || jsonb_build_object('balance', (a->>'balance')::numeric - 15)); PERFORM public.canteen_post('${c.C}','Avi','{"type":"debit","kind":"purchase","amount":15}'::jsonb); END $s$`;
    const r = run([fns(proc).all], c, {}, `const __v2 = T.rpc.canteen_refund_view; let __n = 0; T.rpc.canteen_refund_view = async (a: any) => { const v = await __v2(a); if (++__n === 1) (T as any).__q(${JSON.stringify(saleSql)}); return v; };`);
    const s = state(c);
    console.log(`  ${Number(s.money) === 5 && Number(s.wallet) === 0 ? 'ok  ' : 'BAD '}${proc.padEnd(8)} → money back $${s.money}, wallet $${s.wallet} | ${say(r.first.body)}`);
  }

  // ── C. Cardknox Refund All, answer lost for Avi ───────────────────────────
  console.log('C. Cardknox: Refund All, the card company refunds Avi $20 but the answer is lost');
  {
    const c = camp('cardknox', 50, 30);
    db.sql(`INSERT INTO ted_flags VALUES ('lose', 1) ON CONFLICT (k) DO UPDATE SET n = 1`);
    let r = run([fns('cardknox').all], c, {});
    let s = state(c);
    console.log(`  run 1 → ${say(r.first.body)} | money back $${s.money}, wallet $${s.wallet}, holds [${s.holds}], ledger refund lines ${s.lines}`);
    db.sql(`UPDATE canteen_refund_holds SET created_at = now() - interval '1 day' WHERE camp_id='${c.C}'; UPDATE refund_intents SET created_at = now() - interval '1 day', called_at = now() - interval '1 day' WHERE camp_id='${c.C}'`);
    r = run([fns('cardknox').all], c, {});
    s = state(c);
    console.log(`  a day later, Refund All again → ${say(r.first.body)} | wallet $${s.wallet}, holds [${s.holds}]`);
    const acct = JSON.parse(q1(`SELECT (public.canteen_refund_view('${c.C}')->'accounts'->'Avi')::text`));
    console.log(`  what Snacks shows for Avi: balance $${acct.balance} → the Refund box's maximum is min(balance − floor, capacity) = $${Math.max(0, acct.balance - (acct.balanceFloor || 0))} → Refund button disabled`);
    r = run([fns('cardknox').one], c, single(20, 'cref_C_new'));
    s = state(c);
    console.log(`  single refund $20 sent anyway (a page can't: max is $0) → ${say(r.first.body)} ${r.first.body.confirmHolds ? '(server offers confirmHolds ' + JSON.stringify(r.first.body.confirmHolds) + ')' : ''} | wallet $${s.wallet}, holds [${s.holds}]`);
  }

  // ── D. Cardknox single refund lost, page reloaded, refunded again ─────────
  console.log('D. Cardknox: $20 of Avi\'s $50 refunded, answer lost (it did NOT go through*), office reloads Snacks and refunds $20 again');
  {
    const c = camp('cardknox', 50, 0);
    // * the refund fails at the card company AND the answer is lost: model it as a connection reset before anything happened
    const r1 = run([fns('cardknox').one], c, single(20, 'cref_D1'), `const __f0 = T.fetch; T.fetch = async (u: string, i: any) => { if (String(i.body||'').includes('cc%3Arefund') && !T.__cut) { T.__cut = true; throw new Error('connection reset'); } return __f0(u, i); };`);
    let s = state(c);
    console.log(`  press 1 → ${say(r1.first.body)} | money back $${s.money}, wallet $${s.wallet}, holds [${s.holds}]`);
    db.sql(`UPDATE canteen_refund_holds SET created_at = now() - interval '10 minutes' WHERE camp_id='${c.C}'`);
    const r2 = run([fns('cardknox').one], c, single(20, 'cref_D2_after_reload'));
    s = state(c);
    console.log(`  after a reload (new key), $20 again → ${say(r2.first.body)} | money back $${s.money}, wallet $${s.wallet} (should be $30), holds [${s.holds}]`);
    const r3 = run([fns('cardknox').one], c, single(30, 'cref_D3'));
    s = state(c);
    console.log(`  later: refund the rest the page shows ($${Number(s.wallet).toFixed(2)} + nothing held shown) → ${say(r3.first.body)} | money back $${s.money} of the $50 topped up, wallet $${s.wallet}, holds [${s.holds}]`);
  }

  // ── E. Stripe re-ask after the key was pruned (> 24 h) ────────────────────
  for (const [label, topup, spent] of [['E1 $100 top-up, $50 left', 100, 50], ['E2 $20 top-up, $20 left', 20, 0]]) {
    console.log(`${label}: Refund All refunds Avi, answer lost; Stripe made it. The next Refund All is 25 hours later.`);
    const c = camp('stripe', topup, spent);
    db.sql(`INSERT INTO ted_flags VALUES ('lose', 1) ON CONFLICT (k) DO UPDATE SET n = 1`);
    let r = run([fns('stripe').all], c, {});
    let s = state(c);
    console.log(`  run 1 → ${say(r.first.body)} | money back $${s.money}, wallet $${s.wallet}, holds [${s.holds}]`);
    db.sql(`UPDATE canteen_refund_holds SET created_at = now() - interval '25 hours' WHERE camp_id='${c.C}'; DELETE FROM ted_keys WHERE k LIKE 'canteen_refund_${c.ref}%'`);
    r = run([fns('stripe').all], c, {});
    s = state(c);
    console.log(`  run 2 (key pruned) → ${say(r.first.body)} | money back to the parent $${s.money} (their child had $${topup - spent}), wallet now $${s.wallet}, holds [${s.holds}], ledger refund lines ${s.lines}`);
    console.log(`  Stripe refunds made: ${q1(`SELECT string_agg(refund_id || ' $' || (cents/100.0), ', ' ORDER BY id) FROM ted_money WHERE camp='${c.C}'`)}`);
  }
  // ── F. TED-097 on real SQL: two deliberate $20 refunds, one after the other ──
  for (const proc of ['stripe', 'cardknox']) {
    for (const keys of [['cref_F1', 'cref_F2'], [null, null]]) {
      const c = camp(proc, 50, 0);
      const b = (k) => k ? single(20, k + campN) : { camperId: 7, camperName: 'Avi', amount: 20 };
      const r1 = run([fns(proc).one], c, b(keys[0]));
      const r2 = run([fns(proc).one], c, b(keys[1]));
      const s = state(c);
      console.log(`F. ${proc.padEnd(8)} two deliberate $20 refunds (${keys[0] ? 'page keys' : 'no page key'}) → 1st ${say(r1.first.body)} | 2nd ${say(r2.first.body)} | money back $${s.money}, wallet $${s.wallet} (want $40 / $10), ledger refund lines ${s.lines}`);
    }
  }
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); }
finally { db.stop && db.stop(); }
