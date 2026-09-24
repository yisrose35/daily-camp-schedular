// Probe (12th pass, 278 hunt). Two children share a name: Avi Katz #7 (wallet
// key "Avi Katz") and Avi Katz #102 (wallet key "Avi Katz #102"). Each gets a
// $20 Stripe canteen refund made the way the refund functions make it
// (reserve_canteen_refund with the child's NUMBER, then settle). Stripe then
// fails ONE of them, and migration 278's reverse_failed_stripe_refund runs.
// Whose wallet gets the $20 back? Real migration chain, scratch Postgres.
// Run: node ted/probes/2026-09-24-billing-12/refail_same_name.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5651 });
const q1 = (s) => db.sql(s).trim().split('\n').pop();
let n = 0;
function setup() {
  n++;
  const C = `0ed12b00-0000-0000-0000-${String(n).padStart(12, '0')}`;
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('0ed12b00-0000-0000-0000-0000000000a1','o@t') ON CONFLICT DO NOTHING;
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','0ed12b00-0000-0000-0000-0000000000a1','S${n}','stripe');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi Katz', 'Avi Katz');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 102, 'camper', 'Avi Katz #102', 'Avi Katz');
    SELECT public.canteen_account_save('${C}', 'Avi Katz', '{"balance": 50, "balanceFloor": 0}'::jsonb);
    SELECT public.canteen_account_save('${C}', 'Avi Katz #102', '{"balance": 50, "balanceFloor": 0}'::jsonb);`);
  return C;
}
const wallets = (C) => q1(`SELECT string_agg(account_key || ' (#' || coalesce(person_id::text,'?') || ') $' || balance, ' | ' ORDER BY account_key) FROM camp_canteen_accounts WHERE camp_id='${C}'`);
try {
  for (const who of [7, 102]) {
    const C = setup();
    console.log(`Case: the refund of #${who} fails`);
    console.log('  wallets at the start:', wallets(C));
    for (const id of [7, 102]) {
      const r1 = q1(`SELECT public.reserve_canteen_refund(p_camp_id => '${C}', p_camper_name => 'Avi Katz', p_hold_key => 'scanteen:pi_${id}:5000:2000', p_amount => 20, p_method => 'stripe', p_payment_ref => 'pi_${id}', p_stripe_key => 'k${id}', p_camper_id => ${id})::text`);
      const r2 = q1(`SELECT public.settle_canteen_refund_hold('${C}', 'scanteen:pi_${id}:5000:2000', 're_${id}')::text`);
      if (!/"success": true/.test(r1) || !/"success": true/.test(r2)) console.log('  setup answer for #' + id + ':', r1, r2);
    }
    console.log('  after both $20 refunds:', wallets(C));
    console.log('  refund rows:', q1(`SELECT string_agg(payload->>'stripeRefundId' || ' camper="' || camper || '" camper_id=' || coalesce(camper_id::text,'?'), ' | ' ORDER BY payload->>'stripeRefundId') FROM canteen_transactions WHERE camp_id='${C}' AND payload->>'kind'='refund'`));
    const r = q1(`SELECT public.reverse_failed_stripe_refund('${C}', 're_${who}', 'expired_or_canceled_card')::text`);
    console.log(`  Stripe fails re_${who} → 278 answers ${r}`);
    const after = wallets(C);
    console.log('  wallets after:', after);
    const want = who === 7 ? /Avi Katz \(#7\) \$50\.00 \| Avi Katz #102 \(#102\) \$30\.00/ : /Avi Katz \(#7\) \$30\.00 \| Avi Katz #102 \(#102\) \$50\.00/;
    console.log(`  ${want.test(after) ? 'ok  ' : 'BAD '}the $20 goes back to #${who}'s own wallet`);
  }
} catch (e) { console.log('ERROR', String(e.message).slice(0, 1500)); }
finally { db.stop && db.stop(); }
