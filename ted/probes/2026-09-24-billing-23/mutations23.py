#!/usr/bin/env python3
# 23rd pass: break each 1b0067b fix on purpose (one at a time) in a scratch
# worktree of HEAD (outside the project), run the builder's tests for it,
# restore. "CAUGHT" = the test run fails. Also re-runs last pass's MISSED
# P5/P10/P17/P18/P21 and N14. Log -> mutations.log
import subprocess, os
S='/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/mut23'
LOG='/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-23/mutations.log'
WH='supabase/functions/stripe-webhook/index.ts'
SC='supabase/functions/stripe-charge/index.ts'
BY='supabase/functions/byop-dispute-webhook/index.ts'
AR='supabase/functions/canteen-auto-reload/index.ts'
M288='migrations/288_autopay_waits_while_a_payment_is_disputed.sql'
M290='migrations/290_a_disputed_top_up_pauses_auto_reload.sql'
VS='scripts/verify_identity_chain.sql'
ME='campistry_me.js'
PG=lambda n: ['bash','scripts/run_pgtests.sh',n]
NT=lambda *f: ['node','--test',*f]
DP='tests/dispute_pause_everywhere.test.js'
ARL=(DP,'tests/canteen_autoreload_once.test.js','tests/canteen_autoreload_season.test.js','tests/canteen_and_payout_alerts.test.js','tests/canteen_rows_everywhere.test.js')
PAGE=('tests/ach_on_its_way.test.js','tests/autopay_lost_answer.test.js','tests/batch_charge_counts_failures.test.js','tests/office_charge_retry.test.js','tests/payer_split_billed.test.js',DP)
M=[
 # --- last pass's misses, re-run
 ('P5 (re) _keep_dispute_hold lets a page write its own pause',M288,
   [("    RETURN p_merged - 'disputeHold';","    RETURN p_merged;")], PG('288')),
 ('P10 (re) stripe-charge: family read error charges anyway',SC,
   [("      if (famErr) {\n        return new Response(JSON.stringify({ error: \"Could not read the family's record","      if (false) {\n        return new Response(JSON.stringify({ error: \"Could not read the family's record")], NT(DP,'tests/stripe_refund_and_charge.test.js')),
 ('P17 (re) page: Resume always sends p_even_open true',ME,
   [("p_even_open:c.open>0});","p_even_open:true});")], NT(*PAGE)),
 ('P18 (re) page: server refusal not re-asked',ME,
   [("    if(d&&d.error==='dispute_open'){","    if(false){")], NT(*PAGE)),
 ('P21 (re) check script: 288 note_dispute_lost check off',VS,
   [("          WHEN to_regprocedure('public.note_dispute_lost(uuid,text,text)') IS NULL","          WHEN false AND to_regprocedure('public.note_dispute_lost(uuid,text,text)') IS NULL")], PG('288')),
 ('N14 (re) check script: earlier-288 v_cb check off',VS,
   [("          WHEN pg_get_functiondef(to_regprocedure('public.flag_plan_collection(uuid,text,text,text,text)')) !~ 'v_cb'","          WHEN false AND pg_get_functiondef(to_regprocedure('public.flag_plan_collection(uuid,text,text,text,text)')) !~ 'v_cb'")], PG('288')),
 # --- TED-205
 ('Q1 TED-205 runner: dispute check removed',AR,
   [("      if ((ar.stripeCustomerId && disputed.cards.has(String(ar.stripeCustomerId)))","      if (false && (ar.stripeCustomerId && disputed.cards.has(String(ar.stripeCustomerId)))")], NT(*ARL)),
 ('Q2 TED-205 runner: families unreadable -> reload anyway',AR,
   [("      if (!disputed) {\n","      if (false) {\n"),("      if ((ar.stripeCustomerId && disputed.cards","      if (disputed && (ar.stripeCustomerId && disputed.cards")], NT(*ARL)),
 ('Q3 TED-205 runner: card match removed (children only)',AR,
   [("        for (const c of [f.stripeCustomerId, f.byopCustomerRef]) if (c) out.cards.add(String(c));\n","")], NT(*ARL)),
 ('Q4 TED-205 runner: plan chargeback marks ignored',AR,
   [("          || [...(Array.isArray(f.plans) ? f.plans : []), f.plan].some(","          || false && [...(Array.isArray(f.plans) ? f.plans : []), f.plan].some(")], NT(*ARL)),
 ('Q5 TED-205 webhook: pause call removed',WH,
   [("      const pause = await supabase.rpc(\"pause_canteen_autoreload_for_dispute\", {\n        p_camp_id: canteen.campId, p_payment_intent_id: canteen.pi, p_dispute_id: disputeId });","      const pause = { error: null } as any;")], NT(DP,'tests/canteen_and_payout_alerts.test.js','tests/tuition_dispute_inquiry.test.js')),
 ('Q6 TED-205 webhook: pause error ignored (200)',WH,
   [("      if (pause.error) throw new Error(`canteen dispute","      if (false) throw new Error(`canteen dispute")], NT(DP,'tests/canteen_and_payout_alerts.test.js','tests/tuition_dispute_inquiry.test.js')),
 ('Q7 TED-205 290: pause function leaves auto-reload on',M290,
   [("        'enabled', false,\n        'disputePausedAt'","        'enabled', true,\n        'disputePausedAt'")], PG('290')),
 ('Q8 TED-205 290: nightly-run patch keeps nothing',M290,
   [("    IF jsonb_typeof(v_prev) = 'object' AND v_prev ? 'disputePausedAt' AND NOT p_autoreload ? 'disputePausedAt' THEN","    IF false THEN")], PG('290')),
 ('Q9 TED-205 290: parent save does not clear the pause',M290,
   [("    new text := $n$    v_ar := (((v_ar - 'disabledReason') - 'disabledAt') - 'disputePausedAt') - 'disputeId';$n$;","    new text := $n$    v_ar := (v_ar - 'disabledReason') - 'disabledAt'; -- disputePausedAt$n$;")], PG('290')),
 ('Q10 TED-205 290 check-script row off',VS,
   [("               OR pg_get_functiondef(to_regprocedure('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)')) !~ 'disputePausedAt'","               OR false")], PG('290')),
 # --- TED-206
 ('Q11 TED-206 byop: record_chargeback DB error -> 200 again',BY,
   [("      if (error) writeFailed = `chargeback ${d.disputeId} not posted yet: ${error.message}`;\n      else if (!data?.success) {","      if (!data?.success) {")], NT(DP,'tests/chargeback_and_blocks.test.js')),
 ('Q12 TED-206 byop: close DB error -> 200',BY,
   [("      if (error) writeFailed = `dispute ${d.disputeId} close not recorded yet: ${error.message}`;","")], NT(DP,'tests/chargeback_and_blocks.test.js')),
 ('Q13 TED-206 byop: &key= not accepted',BY,
   [("  const sent = req.headers.get(\"x-webhook-secret\") || url.searchParams.get(\"key\") || \"\";","  const sent = req.headers.get(\"x-webhook-secret\") || \"\";")], NT(DP,'tests/chargeback_and_blocks.test.js')),
 ('Q14 TED-206 byop: a thrown call answers 200',BY,
   [("    writeFailed = `threw: ${(e as Error).message}`;","    console.error(String(e));")], NT(DP,'tests/chargeback_and_blocks.test.js')),
 # --- TED-207
 ('Q15 TED-207 hold ignores resumed log',M288,
   [("    IF COALESCE(p_hold, false) AND COALESCE((v_fam -> 'disputeLog' -> 'resumed') ? p_dispute_id, false) THEN","    IF false THEN")], PG('288')),
 ('Q16 TED-207 loss-first not applied to a later hold',M288,
   [("    IF COALESCE(p_hold, false) AND COALESCE((v_fam -> 'disputeLog' -> 'lost') ? p_dispute_id, false)\n","    IF false AND COALESCE((v_fam -> 'disputeLog' -> 'lost') ? p_dispute_id, false)\n")], PG('288')),
 ('Q17 TED-207 note_dispute_lost does not log the loss',M288,
   [("    IF NOT COALESCE((v_fam -> 'disputeLog' -> 'lost') ? p_dispute_id, false) THEN\n        v_new := jsonb_set(v_new, '{disputeLog}'","    IF false THEN\n        v_new := jsonb_set(v_new, '{disputeLog}'")], PG('288')),
 ('Q18 TED-207 Resume does not log resumed',M288,
   [("    IF jsonb_typeof(h -> 'disputeIds') = 'array' AND jsonb_array_length(h -> 'disputeIds') > 0 THEN\n        v_new := jsonb_set(v_new, '{disputeLog}'","    IF false THEN\n        v_new := jsonb_set(v_new, '{disputeLog}'")], PG('288')),
 ('Q19 TED-207 merge drops the server log (page wins)',M288,
   [("                     ELSE p_merged - 'disputeLog' END;","                     ELSE p_merged END;"),("                     THEN jsonb_set(p_merged, '{disputeLog}', p_server -> 'disputeLog', true)","                     THEN p_merged")], PG('288')),
 ('Q20 TED-207 check-script disputeLog row off',VS,
   [("          WHEN pg_get_functiondef(to_regprocedure('public.hold_autopay_for_dispute(uuid,text,text,boolean,text)')) !~ 'disputeLog'","          WHEN false AND pg_get_functiondef(to_regprocedure('public.hold_autopay_for_dispute(uuid,text,text,boolean,text)')) !~ 'disputeLog'")], PG('288')),
 # --- TED-209
 ('Q21 TED-209 "paid" never shown (Move back always offered)',ME,
   [("        var paidUp=!off&&","        var paidUp=false&&!off&&")], NT(*PAGE)),
 ('Q22 TED-209 no early stop: pressing it writes lines again',ME,
   [("    if(!isPay&&!cancel&&!(back>0)){toast(","    if(false){toast(")], NT(*PAGE)),
 ('Q23 TED-209 doubled title back',ME,
   [("description:String(e.description||'Share').replace(/ \\u2014 the part .* paid$/,'')+' \\u2014 the part '+name+' paid'","description:(e.description||'Share')+' \\u2014 the part '+name+' paid'")], NT(*PAGE)),
]
env=dict(os.environ, TRY_MIGRATION_PORT='5449')
out=open(LOG,'w')
for name,f,pairs,cmd in M:
    p=S+'/'+f; orig=open(p).read(); s=orig
    ok=True
    for old,new in pairs:
        if s.count(old)!=1:
            out.write(f"SKIP  {name}: target found {s.count(old)} times: {old[:70]!r}\n"); ok=False; break
        s=s.replace(old,new)
    if not ok: out.flush(); continue
    open(p,'w').write(s)
    try:
        r=subprocess.run(cmd,cwd=S,capture_output=True,text=True,timeout=2400,env=env)
        txt=r.stdout+r.stderr
        fails=[l for l in txt.splitlines() if l.startswith('not ok') or ' FAIL' in l or l.strip().startswith('FAIL') or l.strip().startswith('BAD')]
        res='CAUGHT' if r.returncode!=0 else 'MISSED'
        out.write(f"{res}  {name}  (exit {r.returncode}; {' '.join(cmd)})\n")
        for l in fails[:5]: out.write('      '+l.strip()[:200]+'\n')
    finally:
        open(p,'w').write(orig)
    out.flush()
