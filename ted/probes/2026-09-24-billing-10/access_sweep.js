// Probe (10th pass): who can call the billing functions?
// Boots a scratch DB with the real chain (tests/e2e/db.js), lists every
// SECURITY DEFINER function in public that the `authenticated` role (any
// signed-in browser: a parent, a stranger) may EXECUTE, keeps the ones whose
// name or body touches billing/canteen/refund money, and prints how each one
// decides who the caller is. Output: access_sweep.out.json (+ a summary line
// per function on stdout).
// Run: node ted/probes/2026-09-24-billing-10/access_sweep.js
const R = '/home/user/daily-camp-schedular';
const fs = require('fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5561 });
try {
  const rows = db.json(`
    SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer,
           pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
  const money = /camp_families|camp_payments|camp_family_save|family_for_update|payment_ledger|refund_intent|canteen_account|canteen_post|canteen_transactions|finance|stripe|byop|autopay|installment|instalment|plan_due|record_chargeback|external_refund|settle_shop|shop_order|deposit|payroll|tax|tip|charge/i;
  const gates = {
    staff: /camp_staff_member\s*\(/,
    ownCamp: /get_user_camp_id\s*\(\)/,
    isAdmin: /_is_camp_admin\s*\(/,
    owner: /owner\s*=\s*auth\.uid\(\)|owner\s*=\s*v_caller|owner\s*=\s*v_uid/,
    role: /get_user_role\s*\(\)/,
    parent: /_parent_owns|camp_parent_camper_ids|parent_invite|my_campers|_caller_parent/i,
    section: /user_section_level\s*\(/,
    uid: /auth\.uid\(\)/,
  };
  const out = [];
  for (const r of rows) {
    const body = r.def.replace(/--[^\n]*/g, '');
    if (!money.test(r.sig) && !money.test(body)) continue;
    const g = Object.keys(gates).filter(k => gates[k].test(body));
    out.push({ sig: r.sig, definer: r.definer, gates: g, def: r.def });
  }
  out.sort((a, b) => a.sig.localeCompare(b.sig));
  fs.writeFileSync(__dirname + '/access_sweep.out.json', JSON.stringify(out, null, 1));
  console.log('functions a signed-in browser may call that touch money:', out.length);
  for (const o of out) console.log((o.definer ? 'DEFINER ' : 'invoker ') + o.sig.padEnd(95) + ' gates: ' + (o.gates.join(',') || 'NONE'));
} catch (e) { console.log('ERROR', String(e.message).slice(0, 800)); }
finally { db.stop && db.stop(); }
