// Probe (17th pass): migration 281 was edited in place (TED-160 adds the
// discount give-back). An owner who pasted LAST pass's 281 and now pastes only
// the new 283 — does scripts/verify_identity_chain.sql say "apply 281 again"?
// Scratch DB with today's full chain, then last pass's 281 (aa72c69) pasted
// over it the way the SQL Editor would, then the check script.
// Then: does the old copy give the discount back when a refund fails?
// Run: node ted/probes/2026-09-24-billing-17/check_script_281_17.js
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5734 });
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const verify = () => { const out = db.json(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').replace(/;\s*$/, '')); return out.filter(r => /^28[123]/.test(r.item)).map(r => r.item.slice(0, 4) + ': ' + r.result); };
const C = '0ed17500-0000-0000-0000-000000000001';
const scenario = () => {
  db.sql(`DELETE FROM camp_state_kv WHERE camp_id='${C}'; DELETE FROM camps WHERE id='${C}';
    INSERT INTO auth.users (id, email) VALUES ('0ed17500-0000-0000-0000-0000000000a1','o@t17c') ON CONFLICT DO NOTHING;
    INSERT INTO camps (id, owner, name) VALUES ('${C}', '0ed17500-0000-0000-0000-0000000000a1', 'C');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', jsonb_build_object('hawk', jsonb_build_object('name','Hawk',
      'credits', '[{"id":"cdisc_pi_pi_hawk","amount":30,"cashDiscount":true,"paymentId":"pi_pi_hawk"}]'::jsonb,
      'charges', '[{"id":"cdback_1","category":"Discount returned","amount":30,"cashDiscountBack":true,"paymentId":"pi_pi_hawk","refundId":"re_9"}]'::jsonb,
      'entries', '[{"id":"le_t","kind":"charge","amount":1000,"reason":"tuition"},{"id":"le_pay_pi_hawk","kind":"payment","amount":970,"reason":"ach"},{"id":"le_cdisc_pi_pi_hawk","kind":"credit","amount":30,"reason":"discount"},{"id":"le_pay_re_9","kind":"refund","amount":970,"reason":"refund"},{"id":"le_chg_cdback_1","kind":"charge","amount":30,"reason":"other"}]'::jsonb))));`);
  const r = db.sql(`SELECT public.undo_card_fee_return('${C}', 'hawk', 're_9')::text`).trim();
  const credits = db.sql(`SELECT coalesce(string_agg(c->>'id' || ' $' || (c->>'amount'), ', '), 'none') FROM jsonb_array_elements(public.camp_family('${C}','hawk')->'credits') c`).trim();
  return r + ' | credits now: ' + credits;
};
try {
  console.log('today\'s chain (new 281): ' + JSON.stringify(verify()));
  console.log('   failed refund re_9 → undo_card_fee_return: ' + scenario());
  db.sql(fs.readFileSync(R + '/ted/probes/2026-09-24-billing-17/old_281_from_aa72c69.sql', 'utf8'));
  const v = verify();
  console.log('\nlast pass\'s 281 pasted over it: ' + JSON.stringify(v));
  const s = scenario();
  console.log('   failed refund re_9 → undo_card_fee_return: ' + s);
  check(!/^281 : ok$/.test(v.find(x => x.startsWith('281')) || ''), 'the check script tells the owner to paste 281 again', v.find(x => x.startsWith('281')));
  check(/cdback_undo/.test(s), 'the discount comes back when the refund fails', s);
} catch (e) { check(false, 'the run finished', String(e.message).split('\n')[0]); }
finally { db.stop(); console.log(`\n${bad} BAD`); }
