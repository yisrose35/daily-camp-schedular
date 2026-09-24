#!/usr/bin/env python3
# 19th pass: break each e8f1d26 fix on purpose (one at a time) in a scratch
# worktree of HEAD (outside the project), run the builder's tests for it,
# restore. "CAUGHT" = the test run fails. Log → mutations.log
# Usage: mutations19.py [browser]   (the browser one runs alone, later)
import subprocess, sys
S='/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/mut19'
BROWSER = len(sys.argv) > 1 and sys.argv[1] == 'browser'
LOG='/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-19/mutations' + ('_browser' if BROWSER else '') + '.log'
WH='supabase/functions/stripe-webhook/index.ts'
CW='supabase/functions/stripe-connect-webhook/index.ts'
M287='migrations/287_a_canteen_top_up_refunded_outside_campistry.sql'
M284='migrations/284_a_register_sale_can_be_voided.sql'
PG=lambda n: ['bash','scripts/run_pgtests.sh',n]
NT=lambda *f: ['node','--test',*f]
M=[
 ('M1 TED-177 286 server merge drops payer lines the page never saw','migrations/286_an_old_tab_keeps_the_payers_share.sql',
   [("            v_pe := v_pe || jsonb_build_array(e);","            NULL;")], PG('286')),
 ('M2 TED-177 split share written to the payer again, not the family','campistry_me.js',
   [("        L.push({id:id,payerId:a.payerId,kind:'charge',","        (py.ledger=py.ledger||[]).push({id:id,payerId:a.payerId,kind:'charge',")], NT('tests/payer_split_billed.test.js')),
 ('M3 TED-178 Finance leaves the funds out again','campistry_me.js',
   [("    totalCollected+=_finPayers.paid; totalOutstanding+=_finPayers.outstanding;","    ")], NT('tests/payer_split_billed.test.js')),
 ('M4 TED-178 Move back to family does not bill the family','campistry_me.js',
   [("f.charges.push(chg); _postLedgerCharge(f,chg); f.balance=(f.balance||0)+chg.amount;","")], NT('tests/payer_split_billed.test.js')),
 ('M5 TED-178 fund payment method back to the first option','campistry_me.js',
   [("_payOptions('tuition','check')","_payOptions('tuition')")], NT('tests/payer_split_billed.test.js')),
 ('M6 TED-181 287 no cap at what the top-up has left',M287,
   [("v_amt := round(LEAST(GREATEST(COALESCE(p_amount, 0), 0), GREATEST(COALESCE(v_left, dep.amount), 0)), 2);","v_amt := round(GREATEST(COALESCE(p_amount, 0), 0), 2);")], PG('287')),
 ('M7 TED-181 287 takes money while a Snacks refund is waiting',M287,
   [("IF p_kind = 'refund' AND EXISTS (SELECT 1 FROM canteen_refund_holds","IF false AND EXISTS (SELECT 1 FROM canteen_refund_holds")], PG('287')),
 ('M8 TED-181 287 takes a Campistry refund again',M287,
   [("WHERE camp_id = p_camp_id AND payload ->> 'stripeRefundId' = v_ref) THEN","WHERE false) THEN")], PG('287')),
 ('M9 TED-181 287 once-per-refund check removed',M287,
   [("    v_sig := 'xref:' || v_ref;\n    IF EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = v_sig) THEN","    v_sig := 'xref:' || v_ref;\n    IF false THEN")], PG('287')),
 ('M10 TED-181 webhook takes a Snacks (campistryHold) refund',WH,
   [("      if (r.metadata && r.metadata.campistryHold) continue;","")], NT('tests/canteen_stripe_reversal.test.js','tests/stripe_webhook_write_fails.test.js')),
 ('M11 TED-181 webhook takes money on a canteen inquiry',WH,
   [("  if (!String(obj.status || \"\").startsWith(\"warning_\")) {\n    const canteen","  if (true) {\n    const canteen")], NT('tests/canteen_stripe_reversal.test.js')),
 ('M12 TED-181 webhook never gives a won dispute back',WH,
   [("} else if (event.type === \"charge.dispute.closed\" && String(obj.status || \"\") === \"won\") {","} else if (false) {")], NT('tests/canteen_stripe_reversal.test.js')),
 ('M13 TED-182 tip inquiry claws back again',CW,
   [("if (isDispute && String(obj.status || \"\").startsWith(\"warning_\")) {","if (false) {")], NT('tests/tip_refund_dispute.test.js')),
 ('M14 TED-182 late opened after a decided dispute claws back',CW,
   [("const dispNow = (decided && disputeStatus === \"open\") ?","const dispNow = (false) ?")], NT('tests/tip_refund_dispute.test.js')),
 ('M15 TED-183 every refusal retried again (no never-recorded list)',WH,
   [("return NEVER_RECORDED.has(c) ? new NeverRecorded(message, c) : new Error(message);","return new Error(message);")], NT('tests/stripe_webhook_write_fails.test.js')),
 ('M16 TED-183 failed alert email not released (never sent)',WH,
   [("          if (sent === \"failed\") {\n            await supabase.rpc(\"release_refund_failure_alert\", { p_refund_id: key });","          if (sent === \"failed\") {\n")], NT('tests/stripe_webhook_write_fails.test.js')),
 ('M17 TED-183 transient refusal treated as permanent',WH,
   [("\"unknown_camper\", \"missing_camper\",","\"unknown_camper\", \"missing_camper\", \"unknown\", \"\", \"db_busy\", \"canceling statement due to statement timeout\",")], NT('tests/stripe_webhook_write_fails.test.js')),
 ('M18 TED-184 void restocks whatever it is asked',M284,
   [("            SELECT a.id, LEAST(a.qty, si.qty) AS qty","            SELECT a.id, a.qty AS qty"),
    ("              JOIN sale_items si ON si.name = lower(btrim(COALESCE(inv.e ->> 'name', ''))))","              LEFT JOIN sale_items si ON false)")], PG('284')),
 ('M19 TED-184 register finish() counts the next cart (18th-pass M9 again)','campistry_snacks_pos.js',
   [("const itemDeltas = saleCart.map(","const itemDeltas = cart.map(")], NT('tests/pos_charge_once.test.js')),
 ('M20 TED-185 download without no-store','campistry_snacks.js',
   [("{ cache: 'no-store' }","{}")], NT('tests/offline_register_once.test.js')),
 ('M21 TED-185 no build check on the downloaded register','campistry_snacks.js',
   [("        if (html.indexOf(\"OFFLINE_POS_BUILD = '\" + OFFLINE_POS_BUILD + \"'\") < 0) {","        if (false) {")], NT('tests/offline_register_once.test.js')),
]
MB=[
 ('MB1 TED-180 void window opens behind history again','campistry_snacks.js',
   [("    closeM('history');\n    openM('void');","    openM('void');")], ['node','tests/snacks_refund_windows.e2e.js']),
]
out=open(LOG,'w')
for name,f,pairs,cmd in (MB if BROWSER else M):
    p=S+'/'+f; s=open(p).read()
    for old,new in pairs:
        assert s.count(old)==1,(name,'target not unique',s.count(old),old[:60])
        s=s.replace(old,new)
    open(p,'w').write(s)
    r=subprocess.run(cmd,cwd=S,capture_output=True,text=True,timeout=2400)
    txt=r.stdout+r.stderr
    fails=[l for l in txt.splitlines() if l.startswith('not ok') or ' FAIL' in l or l.strip().startswith('FAIL') or l.strip().startswith('BAD') or 'fail ' in l[:8]]
    res='CAUGHT' if r.returncode!=0 else 'MISSED'
    out.write(f"{res}  {name}  (exit {r.returncode}; {' '.join(cmd)})\n")
    for l in fails[:6]: out.write('      '+l.strip()[:200]+'\n')
    out.flush()
    subprocess.run(['git','checkout','--',f],cwd=S)
out.close()
print(open(LOG).read())
