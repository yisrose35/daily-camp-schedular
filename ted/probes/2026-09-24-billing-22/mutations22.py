#!/usr/bin/env python3
# 22nd pass: break each 4889ba7 fix on purpose (one at a time) in a scratch
# worktree of HEAD (outside the project), run the builder's tests for it,
# restore. "CAUGHT" = the test run fails. Log -> mutations.log
import subprocess, os
S='/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/mut22'
LOG='/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-22/mutations.log'
WH='supabase/functions/stripe-webhook/index.ts'
RUN='supabase/functions/charge-due-installments/index.ts'
SC='supabase/functions/stripe-charge/index.ts'
PC='supabase/functions/payments-charge/index.ts'
BY='supabase/functions/byop-dispute-webhook/index.ts'
M288='migrations/288_autopay_waits_while_a_payment_is_disputed.sql'
ME='campistry_me.js'
PG=lambda n: ['bash','scripts/run_pgtests.sh',n]
NT=lambda *f: ['node','--test',*f]
DP='tests/dispute_pause_everywhere.test.js'
PAGE=('tests/ach_on_its_way.test.js','tests/autopay_lost_answer.test.js','tests/batch_charge_counts_failures.test.js','tests/office_charge_retry.test.js','tests/payer_split_billed.test.js')
M=[
 ('P1 TED-200 new pause only on autopay plans again',M288,
   [("    ELSIF p_hold THEN\n","    ELSIF p_hold AND COALESCE((p ->> 'autopay')::boolean, false) THEN\n")], PG('288')),
 ('P2 TED-200 family disputeHold never written',M288,
   [("        v_out := jsonb_set(v_out, '{disputeHold}',\n","        v_out := jsonb_set(v_out, '{ignoredHold}',\n")], PG('288')),
 ('P3 TED-201 legacy single plan skipped',M288,
   [("    IF jsonb_typeof(p_fam -> 'plan') = 'object' THEN","    IF false THEN")], PG('288')),
 ('P4 TED-200 merge not patched (_keep_dispute_hold never applied)',M288,
   [("    IF position('_keep_dispute_hold' IN d) > 0 THEN","    IF true THEN")], PG('288')),
 ('P5 TED-200 _keep_dispute_hold lets a page write its own pause',M288,
   [("    RETURN p_merged - 'disputeHold';","    RETURN p_merged;")], PG('288')),
 ('P6 TED-202 Resume ignores open disputes',M288,
   [("    IF v_open > 0 AND NOT COALESCE(p_even_open, false) THEN","    IF false THEN")], PG('288')),
 ('P7 TED-202 note_dispute_lost a no-op',M288,
   [("v_lost || to_jsonb(p_dispute_id), true));","v_lost, true));")], PG('288')),
 ('P8 TED-200 runner: family-level disputeHold check removed',RUN,
   [("      if ((f.disputeHold && Array.isArray(f.disputeHold.disputeIds) && f.disputeHold.disputeIds.length > 0)\n          || plans.some(","      if (false\n          || plans.some(")], NT(DP,'tests/autopay_runner.test.js','tests/tuition_dispute_inquiry.test.js')),
 ('P9 TED-200 stripe-charge: dispute check removed',SC,
   [("      const disputed = disputedFamily(fams, (f: any) => f.stripeCustomerId === customerId);","      const disputed = null as any;")], NT(DP,'tests/stripe_refund_and_charge.test.js')),
 ('P10 TED-200 stripe-charge: family read error charges anyway',SC,
   [("      if (famErr) {\n        return new Response(JSON.stringify({ error: \"Could not read the family's record","      if (false) {\n        return new Response(JSON.stringify({ error: \"Could not read the family's record")], NT(DP,'tests/stripe_refund_and_charge.test.js')),
 ('P11 TED-200 payments-charge: dispute check removed',PC,
   [("    if (disputed) return json({ error: DISPUTED_MSG(disputed.name), disputed: true }, 409);","")], NT(DP,'tests/byop_charge.test.js')),
 ('P12 TED-200 byop: no pause on a new dispute',BY,
   [("      if (!error && data?.success && data.familyKey) {","      if (false) {")], NT(DP)),
 ('P13 TED-202 byop: a lost dispute lifts the pause',BY,
   [("        const r = d.won\n","        const r = true\n")], NT(DP)),
 ('P14 TED-202 stripe-webhook: lost not marked',WH,
   [("    } else if (!won && data?.familyKey) {","    } else if (false) {")], NT(DP,'tests/tuition_dispute_inquiry.test.js')),
 ('P15 TED-200 page: _famDisputeHeld ignores disputeHold',ME,
   [("    if(f.disputeHold&&Array.isArray(f.disputeHold.disputeIds)&&f.disputeHold.disputeIds.length)return true;\n","")], NT(*PAGE)),
 ('P16 TED-200 page: Billing label removed',ME,
   [("    if(_famDisputeHeld(l.family)){\n","    if(false){\n")], NT(*PAGE)),
 ('P17 TED-202 page: Resume always sends p_even_open true',ME,
   [("p_even_open:c.open>0});","p_even_open:true});")], NT(*PAGE)),
 ('P18 TED-202 page: server refusal not re-asked',ME,
   [("    if(d&&d.error==='dispute_open'){","    if(false){")], NT(*PAGE)),
 ('P19 TED-203 Move back keeps nothing',ME,
   [("        kept=Math.max(0,Math.min(tot,left));","        kept=0;")], NT(*PAGE)),
 ('P20 TED-203 Move back window no longer names the paid part',ME,
   [("                 :kept>0?'Move this '","                 :false?'Move this '")], NT(*PAGE)),
 ('P21 check script: the new 288 row removed','scripts/verify_identity_chain.sql',
   [("          WHEN to_regprocedure('public.note_dispute_lost(uuid,text,text)') IS NULL","          WHEN false AND to_regprocedure('public.note_dispute_lost(uuid,text,text)') IS NULL")], PG('288')),
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
