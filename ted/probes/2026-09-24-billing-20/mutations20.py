#!/usr/bin/env python3
# 20th pass: break each a941220 fix on purpose (one at a time) in a scratch
# worktree of HEAD (outside the project), run the builder's tests for it,
# restore. "CAUGHT" = the test run fails. Log → mutations.log
import subprocess, os
S='/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/mut20'
LOG='/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-20/mutations.log'
WH='supabase/functions/stripe-webhook/index.ts'
CW='supabase/functions/stripe-connect-webhook/index.ts'
RUN='supabase/functions/charge-due-installments/index.ts'
M287='migrations/287_a_canteen_top_up_refunded_outside_campistry.sql'
M284='migrations/284_a_register_sale_can_be_voided.sql'
M288='migrations/288_autopay_waits_while_a_payment_is_disputed.sql'
M289='migrations/289_a_register_sale_keeps_what_it_sold.sql'
M283='migrations/283_a_register_sale_is_charged_once.sql'
PG=lambda n: ['bash','scripts/run_pgtests.sh',n]
NT=lambda *f: ['node','--test',*f]
TD='tests/tuition_dispute_inquiry.test.js'
M=[
 ('M1 TED-186 tuition inquiry posted again (warning_ skip removed)',WH,
   [('  if (status.startsWith("warning_")) {\n    console.log(','  if (false) {\n    console.log(')], NT(TD,'tests/canteen_stripe_reversal.test.js','tests/chargeback_and_blocks.test.js')),
 ('M2 TED-186/188 updated / funds_withdrawn not routed',WH,
   [('} else if (event.type === "charge.dispute.updated" || event.type === "charge.dispute.funds_withdrawn") {','} else if (false) {')], NT(TD,'tests/canteen_stripe_reversal.test.js')),
 ('M3 TED-186 chargeback does not pause autopay',WH,
   [('    if (data.familyKey) {\n      const hold','    if (false) {\n      const hold')], NT(TD)),
 ('M4 TED-186 won does not resume autopay',WH,
   [('    if (won && data?.familyKey) {','    if (false) {')], NT(TD)),
 ('M5 TED-187 refund DB error answered 200 again',WH,
   [('      if (error) throw new Error(`refund ${refundId} not booked yet','      if (false) throw new Error(`refund ${refundId} not booked yet')], NT(TD,'tests/stripe_webhook_write_fails.test.js')),
 ('M6 TED-187 chargeback DB error answered 200 again',WH,
   [('    if (error) throw new Error(`chargeback ${disputeId} not posted yet','    if (false) throw new Error(`chargeback ${disputeId} not posted yet')], NT(TD,'tests/stripe_webhook_write_fails.test.js')),
 ('M7 TED-187 close DB error answered 200 again',WH,
   [('    if (error) throw new Error(`dispute ${disputeId} close not recorded yet','    if (false) throw new Error(`dispute ${disputeId} close not recorded yet')], NT(TD,'tests/stripe_webhook_write_fails.test.js')),
 ('M8 TED-187 autopay-pause DB error answered 200',WH,
   [('      if (hold.error) throw new Error(','      if (false) throw new Error(')], NT(TD)),
 ('M9 TED-186 runner charges a paused dueDates plan',RUN,
   [('        if (blocked && blocked.reason === "chargeback") {','        if (false) {')], NT(TD,'tests/autopay_runner.test.js')),
 ('M10 TED-186 runner charges a paused installments plan',RUN,
   [('        if (blockedL && blockedL.reason === "chargeback") {','        if (false) {')], NT(TD,'tests/autopay_runner.test.js')),
 ('M11 TED-186 288 a win releases any dispute\'s pause',M288,
   [("AND (p_dispute_id IS NULL OR b ->> 'disputeId' = p_dispute_id), false) THEN",", false) THEN")], PG('288')),
 ('M12 TED-186 288 resume needs no Billing edit (staff enough)',M288,
   [("       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') <> 'edit' THEN","       THEN")], PG('288')),
 ('M13 TED-186 288 pause marks plans without autopay too',M288,
   [("IF COALESCE((p ->> 'autopay')::boolean, false)\n                   AND NOT","IF NOT")], PG('288')),
 ('M14 TED-188 canteen: only charge.dispute.created takes the money',WH,
   [('    if (taking) {\n      await canteenReversal(','    if (event.type === "charge.dispute.created") {\n      await canteenReversal(')], NT('tests/canteen_stripe_reversal.test.js',TD)),
 ('M15 TED-188 tips: funds_withdrawn not routed',CW,
   [('|| event.type === "charge.dispute.funds_withdrawn"\n','\n')], NT('tests/tip_refund_dispute.test.js')),
 ('M16 TED-189 Cancel share bills the family anyway','campistry_me.js',
   [("if(e.kind==='charge'&&!cancel){","if(e.kind==='charge'){")], NT('tests/payer_split_billed.test.js')),
 ('M17 TED-190 old payer cheque placed again','campistry_me.js',
   [("pays.forEach(function(e){ if(placed[e.id])return;","pays.forEach(function(e){ ")], NT('tests/payer_split_billed.test.js')),
 ('M18 TED-191 287 no cap at what the top-up has left (19th M6)',M287,
   [("v_amt := round(LEAST(GREATEST(COALESCE(p_amount, 0), 0), GREATEST(COALESCE(v_left, dep.amount), 0)), 2);","v_amt := round(GREATEST(COALESCE(p_amount, 0), 0), 2);")], PG('287')),
 ('M19 TED-191 287 once-per-refund check removed (19th M9)',M287,
   [("    v_sig := 'xref:' || v_ref;\n    IF EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = v_sig) THEN","    v_sig := 'xref:' || v_ref;\n    IF false THEN")], PG('287')),
 ('M20 TED-191 no build check on the downloaded register (19th M21)','campistry_snacks.js',
   [("        if (html.indexOf(\"OFFLINE_POS_BUILD = '\" + OFFLINE_POS_BUILD + \"'\") < 0) {","        if (false) {")], NT('tests/offline_register_once.test.js')),
 ('M21 TED-192 289 does not keep soldItems',M289,
   [("               SET payload = payload || jsonb_build_object('soldItems', v_sold)","               SET payload = payload")], PG('289')),
 ('M22 TED-192 284 by-id restock not capped at the sale',M284,
   [("            SELECT a.id, LEAST(a.qty, COALESCE(","            SELECT a.id, GREATEST(a.qty, COALESCE(")], ['bash','-c','bash scripts/run_pgtests.sh 284 && bash scripts/run_pgtests.sh 289']),
 ('M23 TED-192 register sends no p_sold','campistry_snacks_pos.js',
   [("Object.assign({ p_sale_key: _saleKey, p_sold: _sold }, _args)","Object.assign({ p_sale_key: _saleKey }, _args)")], NT('tests/pos_charge_once.test.js')),
 ('M24 TED-192 Snacks void offer ignores soldItems','campistry_snacks.js',
   [("_saleItemsToRestock(t.items, t.soldItems)","_saleItemsToRestock(t.items)")], NT('tests/snacks_void_sale.test.js')),
 ('M25 TED-192 283 re-pasted after 289 leaves two versions',M283,
   [("        DROP FUNCTION IF EXISTS public.submit_canteen_purchase_once(uuid, text, text, numeric, text, date, bigint);\n        RAISE NOTICE","        RAISE NOTICE")], ['bash','-c','bash scripts/run_pgtests.sh 283 && bash scripts/run_pgtests.sh 289']),
]
env=dict(os.environ, TRY_MIGRATION_PORT='5449')
out=open(LOG,'w')
for name,f,pairs,cmd in M:
    p=S+'/'+f; s=open(p).read()
    ok=True
    for old,new in pairs:
        if s.count(old)!=1:
            out.write(f"SKIP  {name}: target found {s.count(old)} times: {old[:70]!r}\n"); ok=False; break
        s=s.replace(old,new)
    if not ok: out.flush(); continue
    open(p,'w').write(s)
    r=subprocess.run(cmd,cwd=S,capture_output=True,text=True,timeout=2400,env=env)
    txt=r.stdout+r.stderr
    fails=[l for l in txt.splitlines() if l.startswith('not ok') or ' FAIL' in l or l.strip().startswith('FAIL') or l.strip().startswith('BAD')]
    res='CAUGHT' if r.returncode!=0 else 'MISSED'
    out.write(f"{res}  {name}  (exit {r.returncode}; {' '.join(cmd)})\n")
    for l in fails[:5]: out.write('      '+l.strip()[:200]+'\n')
    out.flush()
    subprocess.run(['git','checkout','--',f],cwd=S)
out.close()
