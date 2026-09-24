// Probe (22nd pass): the edited 288 (4889ba7) against the owner's paste orders.
//  V0 today's chain → 286/288 rows ok
//  V1 last pass's 288 (dc83cf0) pasted over today's → "apply 288 again"?
//  V2 today's 288 again → ok; merge wrapped once; only the 3-argument Resume left
//  V3 today's 288 twice more → merge still wrapped once
//  V4 286 pasted again after 288 → no error, merge unchanged, rows ok
//  V5 266, 269, 272 pasted again after 288 → rows? merge still keeps the pause?
//  V6 after 272 re-pasted, follow the rows: 286 then 288 → both back, no error?
'use strict';
const fs = require('node:fs');
const R = '/home/user/daily-camp-schedular';
const P = R + '/ted/probes/2026-09-24-billing-22/';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5832 });
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const rows = () => db.json(fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').replace(/;\s*$/, ''))
  .filter(r => /^(286|288)/.test(r.item)).map(r => r.item.slice(0, 3) + ': ' + r.result);
const allOk = () => rows().every(x => /: ok$/.test(x));
const M = (f) => fs.readFileSync(R + '/migrations/' + fs.readdirSync(R + '/migrations').find(x => x.startsWith(f)), 'utf8');
const OLD = fs.readFileSync(P + 'old_288_from_dc83cf0.sql', 'utf8');
const merge = () => db.sql(`SELECT pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure)`);
const count = (s, w) => (s.match(new RegExp(w, 'g')) || []).length;
const resumes = () => db.sql(`SELECT string_agg(oid::regprocedure::text, ' | ') FROM pg_proc WHERE proname = 'resume_autopay_after_dispute'`).trim();
try {
  console.log('V0 ' + JSON.stringify(rows()));
  check(allOk(), 'V0 today\'s chain → ok', rows().join(' | '));
  db.sql(OLD);
  console.log('V1 ' + JSON.stringify(rows()) + '; resume functions: ' + resumes());
  check(rows().some(x => /^288: apply 288 again/.test(x)), 'V1 last pass\'s 288 pasted over today\'s → apply 288 again', rows().join(' | '));
  db.sql(M('288_'));
  let m = merge();
  console.log('V2 ' + JSON.stringify(rows()) + '; merge: _keep_dispute_hold ×' + count(m, '_keep_dispute_hold') + ', _keep_payer_ledger ×' + count(m, '_keep_payer_ledger') + '; resume functions: ' + resumes());
  check(allOk() && count(m, '_keep_dispute_hold') === 1 && !/\(uuid,text\)(?! *,)/.test(resumes().replace(/boolean/, '')) && /boolean/.test(resumes()) && !/\|/.test(resumes()), 'V2 today\'s 288 again → ok, wrapped once, one Resume (3 arguments)', resumes());
  db.sql(M('288_')); db.sql(M('288_'));
  m = merge();
  check(allOk() && count(m, '_keep_dispute_hold') === 1, 'V3 288 twice more → merge wrapped once', count(m, '_keep_dispute_hold'));
  db.sql(M('286_'));
  const m2 = merge();
  check(allOk() && m2 === m, 'V4 286 pasted again after 288 → no error, merge unchanged', rows().join(' | '));
  for (const f of ['266_', '269_', '272_']) {
    let err = '';
    try { db.sql(M(f)); } catch (e) { err = String(e.message).split('\n')[0]; }
    const mm = merge();
    console.log(`V5 ${f} pasted again: ${err || 'no error'}; rows ${JSON.stringify(rows())}; merge keeps pause: ${count(mm, '_keep_dispute_hold')}`);
    if (f === '272_') {
      // 272 replaces the merge: the check script must say so, and following it must work
      check(!err && rows().some(x => /^286: apply 286/.test(x)) && rows().some(x => /^288: apply 288/.test(x)), 'V5 272 re-pasted after 288 → the checking script names 286 and 288', rows().join(' | '));
      let e2 = '';
      try { db.sql(M('286_')); db.sql(M('288_')); } catch (e) { e2 = String(e.message).split('\n')[0]; }
      const m3 = merge();
      console.log(`V6 then 286 and 288 as the rows say: ${e2 || 'no error'}; rows ${JSON.stringify(rows())}; merge _keep_dispute_hold ×${count(m3, '_keep_dispute_hold')}, _keep_payer_ledger ×${count(m3, '_keep_payer_ledger')}`);
      check(!e2 && allOk() && count(m3, '_keep_dispute_hold') === 1 && count(m3, '_keep_payer_ledger') === 1, 'V6 following the rows (286, then 288) puts both back', e2 || rows().join(' | '));
    } else check(!err && allOk() && count(mm, '_keep_dispute_hold') === 1, `V5 ${f} re-pasted after 288 → still ok`, err || rows().join(' | '));
  }
} catch (e) { check(false, 'the run finished', String(e.message).split('\n').slice(0, 4).join(' ')); }
finally { db.stop(); console.log(`\n${bad} BAD`); }
