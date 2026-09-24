#!/usr/bin/env python3
# 18th pass: break each 91e9ef9 fix on purpose (one at a time) in a scratch
# worktree of HEAD, run the builder's tests for it, restore. A mutation is
# "caught" when the test run fails. Log → mutations.log
import subprocess, sys
S='/tmp/claude-0/-home-user-daily-camp-schedular/39278441-0cf3-5f6a-bf8e-a51bef67e95d/scratchpad/mut18'
LOG='/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-18/mutations.log'
M=[
 ('M1 TED-163 ✕ refuses only payments again (refund / put-back rows removable)','campistry_me.js',"||p.stripeRefundId||p.byopRefundId||p.failedRefundId","||false",['node','--test','tests/finance_payments_reach_the_bill.test.js']),
 ('M2 TED-164 webhook answers 200 when the payment is not recorded','supabase/functions/stripe-webhook/index.ts',"throw new Error(`could not record ${pi.id}","return false; (`could not record ${pi.id}",['node','--test','tests/stripe_webhook_write_fails.test.js']),
 ('M3 TED-165 household billed the full split charge','campistry_me.js',"_chg.amount=Math.round((amt-_others.reduce(","_chg.amount=Math.round((amt-0*_others.reduce(",['node','--test','tests/payer_split_billed.test.js']),
 ('M4 TED-166 default pay run from the Sunday of last week','campistry_me.js',"var from=prevEnd?_prShiftWeek(_prWeekStart(prevEnd),1):_prShiftWeek(_prWeekStart(today),-1);","var from=_prShiftWeek(_prWeekStart(today),-1);",['node','--test','tests/payroll_run_dates.test.js']),
 ('M5 TED-174 same-name households auto-posted again','campistry_deposit_match.js',"if (runnerUp && top.identity < M.SCORE.PARENT_HANDLE","if (false && runnerUp && top.identity < M.SCORE.PARENT_HANDLE",['node','--test','tests/deposit_match.test.js']),
 ('M6 TED-170 offline register without its one-sale lock','campistry_snacks_pos_offline.html',"    if (_offlineCharging) return;","    ",['node','--test','tests/offline_register_once.test.js']),
 ('M7 TED-172 Link forgets a pending tick','campistry_link_parent.html',"enabled:_wasOn||!!_arPendingOn[_arKey(c)],","enabled:_wasOn||false,",['node','--test','tests/link_autoreload_paused.test.js']),
 ('M8 TED-168 Clear All keeps the pending sale key','campistry_snacks_pos.js',"window.clearCart = function() { cart = []; _pendingSale = null; renderCart(); };","window.clearCart = function() { cart = []; renderCart(); };",['node','--test','tests/pos_charge_once.test.js']),
 ('M9 TED-169 finish() counts the current cart','campistry_snacks_pos.js',"const itemDeltas = saleCart.map(","const itemDeltas = cart.map(",['node','--test','tests/pos_charge_once.test.js']),
 ('M10 TED-175 a sale can be voided twice','migrations/284_a_register_sale_can_be_voided.sql',"IF EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = p_camp_id AND sig = 'void:' || v_sig) THEN","IF false THEN",['scripts/run_pgtests.sh','284']),
 ('M11 TED-176 a late older refund event lowers the refund','migrations/285_a_refunded_or_disputed_tip.sql',"v_ref  := LEAST(t.amount, GREATEST(COALESCE(t.refunded_amount, 0), round(COALESCE(p_refunded, 0), 2)));","v_ref  := LEAST(t.amount, round(COALESCE(p_refunded, 0), 2));",['scripts/run_pgtests.sh','285']),
 ('M12 TED-176 transfer reversal without a stable key','supabase/functions/stripe-connect-webhook/index.ts',"}, `tiprev_${transferId}_${want}`);","}, `tiprev_${transferId}_${want}_${Math.random()}`);",['node','--test','tests/tip_refund_dispute.test.js']),
 ('M13 TED-167 preview from the old per-family balance','campistry_me.js',"var newBalance=Math.round((_now+amt-_fee+_dback)*100)/100;","var newBalance=Math.round(((f.balance||0)+amt-_fee+_dback)*100)/100;",['node','--test','tests/card_surcharge_billing.test.js']),
 ('M14 TED-175 a voided sale still counts as a sale','campistry_snacks.js',"&& !(t.sig && _voidedSigs()[t.sig]);",";",['node','--test','tests/snacks_void_sale.test.js','tests/closeout_not_a_sale.test.js']),
 ('M15 TED-173 check script without the 281 discount row','scripts/verify_identity_chain.sql',"!~ 'cashDiscountBack'","!~ ''",['scripts/run_pgtests.sh','281']),
]
out=open(LOG,'w')
for name,f,old,new,cmd in M:
    p=S+'/'+f; s=open(p).read()
    assert s.count(old)==1,(name,'target not unique')
    open(p,'w').write(s.replace(old,new))
    r=subprocess.run(cmd,cwd=S,capture_output=True,text=True,timeout=1800)
    txt=r.stdout+r.stderr
    fails=[l for l in txt.splitlines() if l.startswith('not ok') or ' FAIL' in l or l.strip().startswith('FAIL')]
    res='CAUGHT' if r.returncode!=0 else 'MISSED'
    out.write(f"{res}  {name}  (exit {r.returncode}; {' '.join(cmd)})\n")
    for l in fails[:6]: out.write('      '+l.strip()[:200]+'\n')
    out.flush()
    subprocess.run(['git','checkout','--',f],cwd=S)
out.close()
print(open(LOG).read())
