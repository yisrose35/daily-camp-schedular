// Probe (16th pass, TED-143 re-check). The REAL canteen-auto-reload (called the
// way the cron calls it, with the x-cron-secret) on the REAL migration chain,
// with a pretend Stripe that records every charge it is asked for. The camp's
// sessions are stored the way Dashboard → Dates & Pricing stores them
// (camp_state_kv 'campistryMe' → sessions[] with id/name/startDate/endDate/
// dates/tuition), and campDates the way the dashboard derives it.
//
// Two children whose wallets are $0 (they spent it all):
//   Bea (#8): WEEKLY reload, "every <today's weekday>, add $25", no Active dates
//   Avi (#7): "below $5, add $20", no Active dates
//
//   S1 spring: last summer's sessions + NEXT summer's sessions entered (camp
//      starts in 90 days) → 4 weekly runs: nobody charged?
//   S2 between two sessions of the same summer (1st half ended 2 days ago,
//      2nd half starts in 3 days) → nobody?
//   S3 first day of a session / last day of a session → charged (both)?
//   S4 the day after the last session → nobody (season over)?
//   S5 a camp with no session dates and no campDates → nobody (no_session_dates)?
//   S6 sessions exist but none has both dates; campDates in range → charged
//      (fallback); campDates in the future → nobody
//   S7 in session, but the office's switch is Off → nobody
//   S8 ONE cron run over TWO camps, one in session and one not → only the
//      in-session camp's children are charged
//   S9 sessions say "not in session" while the old campDates row says "in
//      range" (a stale campDates) → sessions win, nobody charged
//   S10 the evening of the last session day in New York (21:00 EDT = 01:00 UTC
//      next day) and the evening before the first day → which side of the line?
// Run: node ted/probes/2026-09-24-billing-16/autoreload_sessions16.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5691 });

const RPCS = ['canteen_autoreload_accounts', 'update_canteen_autoreload_state', 'claim_refund_intent', 'release_refund_intent'];
const BR = bridge(db, RPCS, ['camp_state_kv']);
const q1 = (s) => db.sql(s).trim();
const OWNER = '0ed16000-0000-0000-0000-0000000000a1';
db.sql(`CREATE TABLE ted_pis (id serial, camp text, customer text, cents int, credited boolean NOT NULL DEFAULT false, at timestamptz DEFAULT now());
  INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@ted16') ON CONFLICT DO NOTHING;`);

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;
let campN = 0;
const campIds = [];
function camp() {
  campN++;
  const C = `0ed16000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
  campIds.push(C);
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','S${campN}','stripe');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi'), ('${C}', 8, 'camper', 'Bea', 'Bea');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0, "camperId": 7}'::jsonb);
    SELECT public.canteen_account_save('${C}', 'Bea', '{"balance": 0, "camperId": 8}'::jsonb);`);
  const ar = (name, id, cfg) => db.sql(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','${name}');
    PERFORM public.canteen_account_save('${C}','${name}', a || jsonb_build_object('camperId', ${id}, 'autoReload', '${JSON.stringify(cfg)}'::jsonb)); END $x$;`);
  ar('Avi', 7, { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_avi', stripePaymentMethodId: 'pm_avi',
    thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 });
  return C;
}
function bea(C, dow) {
  db.sql(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Bea');
    PERFORM public.canteen_account_save('${C}','Bea', a || jsonb_build_object('autoReload', '${JSON.stringify({ enabled: true, cardOnFile: true,
      stripeCustomerId: 'cus_bea', stripePaymentMethodId: 'pm_bea', thresholdEnabled: false, scheduleEnabled: true, scheduleFrequency: 'weekly',
      scheduleDay: dow, scheduleReloadAmount: 25, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 })}'::jsonb)); END $x$;`);
}
const kv = (C, key, val) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', '${key}', '${JSON.stringify(val).replace(/'/g, "''")}'::jsonb)
  ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value`);
// The Me document the way the dashboard writes it: sessions beside everything else.
let sN = 0;
const sess = (a, b, name) => ({ id: 's_' + (++sN).toString(36), name: name || ('Session ' + sN), startDate: a, endDate: b,
  dates: a && b ? a + ' – ' + b : '', tuition: 1000, capacity: 100 });
const meDoc = (C, sessions) => kv(C, 'campistryMe', { families: { gold: { name: 'Gold', camperIds: ['Avi', 'Bea'] } },
  enrollments: {}, sessions, sessionBundles: [], enrollSettings: {} });
// campDates the way _dashDeriveCampDatesFromSessions derives it
const derived = (C, sessions) => {
  const st = sessions.map(s => s.startDate).filter(Boolean), en = sessions.map(s => s.endDate).filter(Boolean);
  if (st.length && en.length) kv(C, 'campDates', { startDate: st.sort()[0], half1End: null, half2Start: null, endDate: en.sort().slice(-1)[0] });
};

const STRIPE = `
const __qq = (T as any).__q;
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(String(init.body || ''));
    const r = JSON.parse(__qq("INSERT INTO ted_pis (camp, customer, cents) VALUES ('" + String(p.get('metadata[campId]')) + "','" + String(p.get('customer')) + "'," + Number(p.get('amount')) + ") RETURNING row_to_json(ted_pis)::text"));
    return { id: 'pi_reload' + r.id, object: 'payment_intent', amount: r.cents, amount_received: r.cents, status: 'succeeded', customer: r.customer };
  }
  return {};
};`;
function cron(Cs, ts) {
  Cs = [].concat(Cs);
  const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'cron_s' };
${BR}
T.rpc.canteen_autoreload_accounts = (a: any) => JSON.parse((T as any).__q("SELECT coalesce(json_agg(x), '[]'::json)::text FROM public.canteen_autoreload_accounts("
  + (a && a.p_camp_id ? "p_camp_id => '" + String(a.p_camp_id) + "'::uuid" : '') + ") x WHERE x.camp_id IN (${Cs.map(c => "'" + c + "'").join(',')})") || '[]');
T.tables.camps = ${JSON.stringify(Cs.map((c, i) => ({ id: c, owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: null, stripe_charges_enabled: false, name: 'S' + i })))};
${STRIPE}
${ts ? `const __RealDate = Date; (globalThis as any).Date = class extends __RealDate { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(${ts}); } static now() { return ${ts}; } };` : ''}
T.requests = [{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }];`;
  const r = runEdges(['canteen-auto-reload'], scen);
  const b = r.responses[0].body || {};
  for (const C of Cs) for (const row of JSON.parse(q1(`SELECT coalesce(json_agg(p), '[]'::json)::text FROM ted_pis p WHERE camp='${C}' AND NOT credited`))) {
    const who = row.customer === 'cus_bea' ? [8, 'Bea'] : [7, 'Avi'];
    db.sql(`SELECT public.credit_canteen_balance_from_stripe(p_camp_id => '${C}', p_camper_id => ${who[0]}, p_camper_name => '${who[1]}', p_amount => ${row.cents / 100}, p_payment_intent_id => 'pi_reload${row.id}'); UPDATE ted_pis SET credited = true WHERE id = ${row.id};`);
  }
  return (b.details || []).map((d) => d.camper ? `${d.camper} ${d.kind || ''} $${d.amount} → ${d.result}` : `camp ${String(d.camp).slice(-2)} → ${d.result}`).join('; ') || JSON.stringify(b).slice(0, 200);
}
const charged = (C) => q1(`SELECT coalesce(string_agg('$' || (cents/100) || ' from ' || customer, ', ' ORDER BY id), 'none') FROM ted_pis WHERE camp='${C}'`);
const nCharged = (C) => Number(q1(`SELECT count(*) FROM ted_pis WHERE camp='${C}'`));
let bad = 0;
const verdict = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const now = Date.now();
const dow = new Date(now).getUTCDay();

try {
  console.log(`SETUP (each case its own camp): Avi (#7) "below $5 → add $20", Bea (#8) weekly on today's weekday → add $25; both wallets $0, no Active dates; today ${iso(now)} (UTC)\n`);

  { const C = camp(); bea(C, dow);
    const S = [sess(iso(now - 110 * DAY), iso(now - 80 * DAY), 'Last summer 1st half'), sess(iso(now - 79 * DAY), iso(now - 50 * DAY), 'Last summer 2nd half'),
               sess(iso(now + 90 * DAY), iso(now + 120 * DAY), 'Next summer 1st half'), sess(iso(now + 121 * DAY), iso(now + 150 * DAY), 'Next summer 2nd half')];
    meDoc(C, S); derived(C, S);
    console.log(`S1. Spring: last summer's AND next summer's sessions are listed (next starts ${iso(now + 90 * DAY)}); campDates derived ${S[0].startDate} → ${S[3].endDate}`);
    console.log(`    run today (${iso(now)}): ${cron(C)}`);
    for (const w of [1, 2, 3]) console.log(`    run week ${w + 1} (${iso(now + 7 * w * DAY)}): ${cron(C, now + 7 * w * DAY)}`);
    verdict(nCharged(C) === 0, 'S1 months before camp starts, nobody is charged (4 weekly runs)', `${nCharged(C)} charge(s): ${charged(C)}`); }

  { const C = camp(); bea(C, dow);
    const S = [sess(iso(now - 20 * DAY), iso(now - 2 * DAY), '1st half'), sess(iso(now + 3 * DAY), iso(now + 20 * DAY), '2nd half')];
    meDoc(C, S); derived(C, S);
    console.log(`\nS2. Between two sessions: 1st half ended ${S[0].endDate}, 2nd half starts ${S[1].startDate}`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 0, 'S2 between sessions, nobody is charged', charged(C)); }

  { const C1 = camp(); bea(C1, dow);
    const S1 = [sess(iso(now), iso(now + 10 * DAY), 'starts today')]; meDoc(C1, S1); derived(C1, S1);
    const C2 = camp(); bea(C2, dow);
    const S2 = [sess(iso(now - 10 * DAY), iso(now), 'ends today')]; meDoc(C2, S2); derived(C2, S2);
    console.log(`\nS3. First day of a session (camp ${C1.slice(-2)}: ${S1[0].startDate} → ${S1[0].endDate}) / last day (camp ${C2.slice(-2)}: ${S2[0].startDate} → ${S2[0].endDate})`);
    console.log(`    run first-day camp: ${cron(C1)}`);
    console.log(`    run last-day camp: ${cron(C2)}`);
    verdict(nCharged(C1) === 2 && nCharged(C2) === 2, 'S3 first and last day are camp days (Avi $20 + Bea $25 each)', `first: ${charged(C1)}; last: ${charged(C2)}`); }

  { const C = camp(); bea(C, dow);
    const S = [sess(iso(now - 40 * DAY), iso(now - DAY), 'Summer')]; meDoc(C, S); derived(C, S);
    console.log(`\nS4. The day after the last session (ended ${S[0].endDate})`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 0, 'S4 after the season, nobody is charged', charged(C)); }

  { const C = camp(); bea(C, dow);
    console.log(`\nS5. No sessions and no campDates at all`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 0, 'S5 a camp with no dates charges nobody', charged(C)); }

  { const C1 = camp(); bea(C1, dow);
    meDoc(C1, [sess('', '', 'Summer (no dates yet)'), sess(iso(now - 5 * DAY), '', 'start only')]);
    kv(C1, 'campDates', { startDate: iso(now - 5 * DAY), endDate: iso(now + 5 * DAY) });
    const C2 = camp(); bea(C2, dow);
    meDoc(C2, [sess('', '', 'Summer (no dates yet)')]);
    kv(C2, 'campDates', { startDate: iso(now + 5 * DAY), endDate: iso(now + 40 * DAY) });
    console.log(`\nS6. Sessions without both dates; fallback to campDates (camp ${C1.slice(-2)} in range, camp ${C2.slice(-2)} in the future)`);
    console.log(`    run in-range camp: ${cron(C1)}`);
    console.log(`    run future camp: ${cron(C2)}`);
    verdict(nCharged(C1) === 2 && nCharged(C2) === 0, 'S6 campDates fallback: in range charged, future not', `in range: ${charged(C1)}; future: ${charged(C2)}`); }

  { const C = camp(); bea(C, dow);
    const S = [sess(iso(now - 5 * DAY), iso(now + 5 * DAY))]; meDoc(C, S); derived(C, S);
    kv(C, 'campistrySnacks', { settings: { cashDailyMax: 20, autoReloadOff: true } });
    console.log(`\nS7. In session, but the office switched Parents' auto-reload Off`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 0, 'S7 the office\'s switch stops every charge', charged(C)); }

  { const Cin = camp(); bea(Cin, dow); const Sin = [sess(iso(now - 5 * DAY), iso(now + 5 * DAY))]; meDoc(Cin, Sin); derived(Cin, Sin);
    const Cout = camp(); bea(Cout, dow); const Sout = [sess(iso(now + 60 * DAY), iso(now + 90 * DAY))]; meDoc(Cout, Sout); derived(Cout, Sout);
    console.log(`\nS8. ONE cron run over two camps: ${Cin.slice(-2)} in session, ${Cout.slice(-2)} starts in 60 days`);
    console.log(`    run: ${cron([Cin, Cout])}`);
    verdict(nCharged(Cin) === 2 && nCharged(Cout) === 0, 'S8 only the in-session camp is charged', `in session: ${charged(Cin)}; not yet: ${charged(Cout)}`); }

  { const C = camp(); bea(C, dow);
    meDoc(C, [sess(iso(now + 60 * DAY), iso(now + 90 * DAY))]);
    kv(C, 'campDates', { startDate: iso(now - 30 * DAY), endDate: iso(now + 30 * DAY) });
    console.log(`\nS9. Sessions say next summer; an old campDates row still says ${iso(now - 30 * DAY)} → ${iso(now + 30 * DAY)}`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 0, 'S9 the sessions decide, not a stale campDates', charged(C)); }

  { // New York, EDT (UTC-4). Session 2027-07-01 → 2027-08-20.
    const C = camp();
    const S = [sess('2027-07-01', '2027-08-20', 'Summer 2027')]; meDoc(C, S); derived(C, S);
    const eveBefore = Date.parse('2027-07-01T01:00:00Z');   // 2027-06-30 21:00 in New York
    const lastEve = Date.parse('2027-08-21T01:00:00Z');     // 2027-08-20 21:00 in New York (last day of camp)
    console.log(`\nS10. Time of day (UTC "today"): session 2027-07-01 → 2027-08-20, camp in New York`);
    console.log(`    run at 21:00 New York the evening BEFORE camp (UTC ${new Date(eveBefore).toISOString()}): ${cron(C, eveBefore)}`);
    const n1 = nCharged(C);
    db.sql(`UPDATE camp_canteen_accounts SET balance = 0, payload = jsonb_set(payload, '{balance}', '0') WHERE camp_id = '${C}'`);
    console.log(`    run at 21:00 New York on the LAST day of camp (UTC ${new Date(lastEve).toISOString()}): ${cron(C, lastEve)}`);
    console.log(`  NOTE S10 evening before camp: ${n1} charge(s); last-day evening: ${nCharged(C) - n1} charge(s) — the job's "today" is the UTC date`); }
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); bad++; }
finally { db.stop && db.stop(); }
console.log(`\n${bad} BAD`);
