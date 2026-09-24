#!/usr/bin/env python3
# 21st pass: break each dc83cf0 fix on purpose (one at a time) in a scratch
# worktree of HEAD (outside the project), run the builder's tests for it,
# restore. "CAUGHT" = the test run fails. Log → mutations.log
import subprocess, os
S='/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/mut21'
LOG='/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-21/mutations.log'
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
 # re-runs of last pass's missed ones
 ('M8 TED-187/199 autopay-pause DB error answered 200',WH,
   [('      if (hold.error) throw new Error(','      if (false) throw new Error(')], NT(TD)),
 ('M9+M10+F TED-199 runner: all three dispute skips removed',RUN,
   [('        if (blocked && blocked.reason === "chargeback") {','        if (false) {'),
    ('        if (blockedL && blockedL.reason === "chargeback") {','        if (false) {'),
    ('      if (plans.some((p: any) => p && p.collectionBlocked && p.collectionBlocked.reason === "chargeback")) {','      if (false) {')], NT(TD,'tests/autopay_runner.test.js')),
 ('M9 TED-199 runner: dueDates-plan skip removed (other two kept)',RUN,
   [('        if (blocked && blocked.reason === "chargeback") {','        if (false) {')], NT(TD,'tests/autopay_runner.test.js')),
 ('F1 TED-194 runner: family-level skip removed (per-plan kept)',RUN,
   [('      if (plans.some((p: any) => p && p.collectionBlocked && p.collectionBlocked.reason === "chargeback")) {','      if (false) {')], NT(TD,'tests/autopay_runner.test.js')),
 ('M12 TED-199 288 resume needs no Billing edit',M288,
   [("       OR COALESCE(public.user_section_level(p_camp_id, 'me.billing'), 'none') <> 'edit' THEN","       THEN")], PG('288')),
 ('M15 TED-199 tips funds_withdrawn not routed',CW,
   [(' || event.type === "charge.dispute.funds_withdrawn"\n','\n')], NT('tests/tip_refund_dispute.test.js')),
 ('M17 TED-199 old payer cheque placed again','campistry_me.js',
   [("pays.forEach(function(e){ if(placed[e.id])return;","pays.forEach(function(e){ ")], NT('tests/payer_split_billed.test.js')),
 ('M24 TED-199 Void window ignores soldItems','campistry_snacks.js',
   [("_saleItemsToRestock(t.items, t.soldItems)","_saleItemsToRestock(t.items)")], NT('tests/snacks_void_sale.test.js')),
 # this pass's fixes
 ('N1 TED-193 a win lifts the pause even with other disputes open',M288,
   [("v_ids := CASE WHEN p_dispute_id IS NULL THEN '[]'::jsonb ELSE v_ids - p_dispute_id END;","v_ids := '[]'::jsonb;")], PG('288')),
 ('N2 TED-193 a second dispute is not added to the list',M288,
   [("                    IF NOT v_ids ? p_dispute_id THEN","                    IF false THEN")], PG('288')),
 ('N3 TED-194 flag_plan_collection not patched (288 DO block returns at once)',M288,
   [("    IF position('v_cb' IN d) > 0 THEN\n        RAISE NOTICE","    IF true THEN\n        RAISE NOTICE")], PG('288')),
 ('N4 TED-194 patched flag drops the mark instead of keeping it under',M288,
   [("            || CASE WHEN v_plan ? ''collectionBlocked'' THEN jsonb_build_object(''under'', v_plan->''collectionBlocked'') ELSE ''{}''::jsonb END, true);","            , true);")], PG('288')),
 ('N5 TED-195 Batch Charge keeps disputed families','campistry_me.js',
   [("    eligible=eligible.filter(function([fk]){return !_familyDisputed(fk)});","")], NT('tests/ach_on_its_way.test.js','tests/batch_charge_counts_failures.test.js')),
 ('N6 TED-195 Charge Card guard removed','campistry_me.js',
   [("    if(_familyDisputed(famKey)){\n","    if(false){\n")], NT('tests/ach_on_its_way.test.js','tests/batch_charge_counts_failures.test.js','tests/office_charge_retry.test.js')),
 ('N7 TED-196 webhook: won/lost counted as taking again',WH,
   [(' && status !== "won" && status !== "lost";',';')], NT(TD,'tests/canteen_stripe_reversal.test.js','tests/chargeback_and_blocks.test.js')),
 ('N8 TED-196 hold: alreadyWon check removed',M288,
   [("    IF COALESCE(p_hold, false) AND EXISTS (","    IF false AND EXISTS (")], PG('288')),
 ('N9 TED-197 release forgets the mark kept under',M288,
   [("                    ELSIF jsonb_typeof(b -> 'under') = 'object' THEN","                    ELSIF false THEN")], PG('288')),
 ('N10 TED-197 first pause does not keep the earlier mark',M288,
   [("                     || CASE WHEN jsonb_typeof(b) = 'object' THEN jsonb_build_object('under', b) ELSE '{}'::jsonb END, true);","                     , true);")], PG('288')),
 ('N11 TED-198 Account button back to charged>0 only','campistry_me.js',
   [("              +(_payerAccount(id).lines.length?'<button","              +(_payerAccount(id).charged>0?'<button")], NT('tests/payer_split_billed.test.js')),
 ('N12 TED-198 standing says Owes for a credit','campistry_me.js',
   [("    return a.balance>0?'Owes '+fm(a.balance)","    return a.balance!==0?'Owes '+fm(a.balance)")], NT('tests/payer_split_billed.test.js')),
 ('N13 TED-198 Cancel share window no longer says what was paid','campistry_me.js',
   [("                    +(a.paid>0?' '+name+' has paid '+fm(a.paid)+' so far;","                    +(false?' '+name+' has paid '+fm(a.paid)+' so far;")], NT('tests/payer_split_billed.test.js')),
 ('N14 check script: earlier-288 row removed','scripts/verify_identity_chain.sql',
   [("          WHEN pg_get_functiondef(to_regprocedure('public.flag_plan_collection(uuid,text,text,text,text)')) !~ 'v_cb'","          WHEN false AND pg_get_functiondef(to_regprocedure('public.flag_plan_collection(uuid,text,text,text,text)')) !~ 'v_cb'")], PG('288')),
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
