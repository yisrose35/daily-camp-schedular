// ============================================================================
// campistry_billing.js — Campistry Billing engine (window.CampistryBilling)
//
// A family financial ledger layered on top of registration. Every enrolled
// camper (campistryMe.enrollments) becomes a TUITION charge on a family
// ACCOUNT; discounts become CREDITs; the office records PAYMENTs (cash, check,
// Zelle, card, ACH) and optional installment PLANS against the account. Balance
// is always derived from the ledger (never stored authoritatively), and the
// real paid/partial/pending status is written back onto the enrollment so the
// registration status page reflects reality.
//
// State lives in camp_state_kv key `campistryBilling` — its own top-level key,
// hydrated by campistry_cloud_bootstrap.js (FETCH_KEYS) and persisted through
// the authoritative saveGlobalSettings handler, with a Snacks-style
// fetch-merge-by-id bridge so two devices converge without clobbering.
//
// Online card/ACH (Stripe) is intentionally a seam, not landed here — see
// settings.stripeEnabled and the note in openPayment().
// ============================================================================
(function () {
    'use strict';

    var STORAGE_KEY = 'campGlobalSettings_v1';
    var BILLING_KEY = 'campistryBilling';

    var METHOD_LABELS = { cash:'Cash', check:'Check', zelle:'Zelle', card:'Card (manual)', ach:'ACH / bank', 'card-online':'Card (online)' };
    var DEFAULT_METHODS = ['cash','check','zelle','card','ach'];

    // ── tiny utils ──────────────────────────────────────────────────────────
    function esc(s){ if(s==null)return''; var m={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}; return String(s).replace(/[&<>"']/g,function(c){return m[c];}); }
    function uid(p){ return (p||'b')+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7); }
    function n2(x){ return Math.round((Number(x)||0)*100)/100; }
    function fm(x){ var v=n2(x); var neg=v<0; v=Math.abs(v); return (neg?'-$':'$')+v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
    function todayISO(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
    function fmtDate(iso){ if(!iso)return''; try{ var d=new Date(iso.length<=10?iso+'T12:00:00':iso); return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }catch(e){ return iso; } }
    function norm(s){ return String(s||'').trim().toLowerCase(); }

    // ── global-settings blob access ─────────────────────────────────────────
    // The localStorage snapshot deliberately STRIPS heavy sub-keys (enrollments,
    // camperRoster, families, payments) to stay under the 5MB quota — the full
    // state lives in integration_hooks' in-memory cache, reachable via
    // window.loadGlobalSettings(). So always prefer that; fall back to raw
    // localStorage (which still holds everything on a fresh cloud-hydrated page,
    // before the first strip). When both exist, prefer whichever actually has
    // enrollments so we never operate on a stripped copy.
    function readGlobal(){ try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'); }catch(e){ return {}; } }
    function memState(){ try{ if(typeof window.loadGlobalSettings==='function'){ var s=window.loadGlobalSettings(); if(s&&typeof s==='object') return s; } }catch(e){} return null; }
    function hasEnr(me){ return !!(me&&me.enrollments&&Object.keys(me.enrollments).length); }
    function getMe(){
        var mem=memState(); var a=(mem&&mem.campistryMe)||null; var b=readGlobal().campistryMe||null;
        if(hasEnr(a)) return a;
        if(hasEnr(b)) return b;
        return a||b||{};
    }
    function getEnrollments(){ var me=getMe(); return (me&&me.enrollments)||{}; }
    function getSessions(){ var me=getMe(); return (me&&me.sessions)||[]; }
    function sessionByName(nm){ return getSessions().find(function(s){ return s.name===nm; })||null; }

    function campName(){ var g=readGlobal(); return (g.campistryMe&&g.campistryMe.campName)||g.camp_name||g.campName||localStorage.getItem('campistry_camp_name')||'Camp'; }

    // ── billing blob ────────────────────────────────────────────────────────
    function defaults(){
        return { accounts:{}, charges:{}, payments:{}, plans:{}, bootstrapped:{},
                 settings:{ currency:'USD', methods:DEFAULT_METHODS.slice(), stripeEnabled:false, invoicePrefix:'INV-', statementFooter:'' },
                 updatedAt:new Date().toISOString() };
    }
    function getBilling(){
        var mem=memState(); var mb=(mem&&mem[BILLING_KEY])||null; var lb=readGlobal()[BILLING_KEY]||null;
        function ct(x){ return x&&x.charges?Object.keys(x.charges).length:0; }
        var b = ct(mb)>=ct(lb) ? (mb||lb||{}) : (lb||{});
        var d=defaults();
        b.accounts=b.accounts||d.accounts; b.charges=b.charges||d.charges; b.payments=b.payments||d.payments;
        b.plans=b.plans||d.plans; b.bootstrapped=b.bootstrapped||d.bootstrapped;
        b.settings=Object.assign({}, d.settings, b.settings||{});
        if(!b.settings.methods||!b.settings.methods.length) b.settings.methods=DEFAULT_METHODS.slice();
        return b;
    }
    function saveBilling(b){
        b.updatedAt=new Date().toISOString();
        var g=readGlobal(); g[BILLING_KEY]=b; g.updated_at=new Date().toISOString();
        try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(g)); }catch(e){}
        if(window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler){
            try{ window.saveGlobalSettings(BILLING_KEY, b); }catch(e){}
        }
        return b;
    }

    // ── accounts: derive a stable family key from an enrollment ─────────────
    function acctKeyFor(enr){
        var email=norm(enr.parentEmail);
        if(email) return 'e:'+email;
        var nm=norm(enr.parentName);
        if(nm) return 'n:'+nm;
        return 'c:'+norm(enr.camperName||enr.camperFirst);
    }
    function ensureAccount(b, key, enr){
        if(!b.accounts[key]){
            b.accounts[key]={ key:key, familyName:(enr.parentName||enr.camperName||'Family'),
                parentName:enr.parentName||'', parentEmail:enr.parentEmail||'', parentPhone:enr.parentPhone||'',
                camperNames:[], createdAt:new Date().toISOString() };
        }
        var a=b.accounts[key];
        if(!a.parentEmail && enr.parentEmail) a.parentEmail=enr.parentEmail;
        if(!a.parentPhone && enr.parentPhone) a.parentPhone=enr.parentPhone;
        if(enr.camperName && a.camperNames.indexOf(enr.camperName)<0) a.camperNames.push(enr.camperName);
        return a;
    }

    // ── bootstrap: turn enrollments into tuition charges (idempotent) ───────
    function syncEnrollments(){
        var b=getBilling(); var enrolls=getEnrollments(); var changed=false;
        Object.keys(enrolls).forEach(function(eid){
            if(b.bootstrapped[eid]) return;               // already imported
            var enr=enrolls[eid]; if(!enr) return;
            // Skip declined applications — no charge owed.
            if(enr.status==='declined') { b.bootstrapped[eid]='skipped:declined'; changed=true; return; }
            var key=acctKeyFor(enr); ensureAccount(b,key,enr);
            var sess=sessionByName(enr.session)||{};
            var tuition=n2(enr.sessionTuition!=null?enr.sessionTuition:(sess.tuition||0));
            var cid=uid('chg');
            b.charges[cid]={ id:cid, acct:key, camper:enr.camperName||'', type:'tuition',
                label:'Tuition'+(enr.session?' — '+enr.session:''), amount:tuition,
                enrollmentId:eid, date:enr.appliedDate||todayISO(), void:false, ts:Date.now() };
            b.bootstrapped[eid]=cid;
            // Discount → credit line
            var disc=enr.discount;
            if(disc){
                var damt=n2((disc.amt||0)+tuition*(Number(disc.pct||0)/100));
                if(damt>0){
                    var did=uid('crd');
                    b.charges[did]={ id:did, acct:key, camper:enr.camperName||'', type:'credit',
                        label:'Discount'+(disc.code?' ('+disc.code+')':disc.label?' ('+disc.label+')':''),
                        amount:-damt, enrollmentId:eid, date:enr.appliedDate||todayISO(), void:false, ts:Date.now()+1 };
                }
            }
            changed=true;
        });
        if(changed) saveBilling(b);
        return b;
    }

    // ── ledger math ─────────────────────────────────────────────────────────
    // Returns totals + a waterfall allocation of payments across owed charges
    // (oldest first), so each tuition charge knows how much of it is paid.
    function computeAccount(b, key){
        var charges=Object.keys(b.charges).map(function(id){return b.charges[id];})
            .filter(function(c){ return c.acct===key && !c.void; })
            .sort(function(a,c){ return (a.ts||0)-(c.ts||0); });
        var payments=Object.keys(b.payments).map(function(id){return b.payments[id];})
            .filter(function(p){ return p.acct===key; })
            .sort(function(a,c){ return (a.ts||0)-(c.ts||0); });
        var billed=0, credits=0;
        charges.forEach(function(c){ if(c.amount>=0) billed+=c.amount; else credits+=(-c.amount); });
        var paid=payments.reduce(function(s,p){ return s+n2(p.amount); },0);
        // Waterfall: net owed pool = positive charges reduced by credits, then payments.
        var pool=paid+credits;
        var chargePaid={};
        charges.filter(function(c){return c.amount>0;}).forEach(function(c){
            var take=Math.min(c.amount, Math.max(0,pool)); chargePaid[c.id]=n2(take); pool=n2(pool-take);
        });
        var balance=n2(billed-credits-paid);
        return { charges:charges, payments:payments, billed:n2(billed), credits:n2(credits),
                 paid:n2(paid), balance:balance, chargePaid:chargePaid };
    }

    function accountList(b){
        b=b||getBilling();
        return Object.keys(b.accounts).map(function(key){
            var a=b.accounts[key]; var t=computeAccount(b,key);
            return { key:key, acct:a, billed:t.billed, credits:t.credits, paid:t.paid, balance:t.balance, campers:a.camperNames||[] };
        }).sort(function(x,y){ return y.balance-x.balance; });
    }

    function overdueInstallments(b){
        b=b||getBilling(); var today=todayISO(); var out=[];
        Object.keys(b.plans).forEach(function(pid){
            var pl=b.plans[pid]; var a=b.accounts[pl.acct]; if(!a) return;
            (pl.installments||[]).forEach(function(ins){
                if(!ins.paidId && ins.due && ins.due<today) out.push({ plan:pl, acct:a, ins:ins });
            });
        });
        return out.sort(function(x,y){ return (x.ins.due||'').localeCompare(y.ins.due||''); });
    }

    // ── write real paid/partial/pending back onto the enrollments ───────────
    var _writebackTimer=null;
    function scheduleWriteback(){ clearTimeout(_writebackTimer); _writebackTimer=setTimeout(writebackStatuses, 800); }
    function writebackStatuses(){
        var me=getMe(); if(!me||!me.enrollments||!Object.keys(me.enrollments).length) return;
        var b=getBilling(); var changed=false;
        // Precompute allocation per account once.
        var byAcct={};
        Object.keys(me.enrollments).forEach(function(eid){
            var enr=me.enrollments[eid]; if(!enr) return;
            var chgId=b.bootstrapped[eid]; if(!chgId||chgId.indexOf('skipped')===0) return;
            var chg=b.charges[chgId]; if(!chg) return;
            var key=chg.acct; if(!byAcct[key]) byAcct[key]=computeAccount(b,key);
            var paidPortion=n2(byAcct[key].chargePaid[chgId]||0);
            var owed=n2(chg.amount);
            var status = owed<=0 ? 'paid' : paidPortion>=owed ? 'paid' : paidPortion>0 ? 'partial' : 'pending';
            if(enr.paymentStatus!==status || n2(enr.paymentAmount)!==paidPortion){
                enr.paymentStatus=status; enr.paymentAmount=paidPortion; changed=true;
            }
        });
        if(changed){
            if(window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler){
                // Authoritative path updates the in-memory cache + IDB + the
                // (stripped) localStorage snapshot correctly.
                try{ window.saveGlobalSettings('campistryMe', me); }catch(e){}
            } else {
                // Fallback for a page without the authoritative handler: persist
                // the full campistryMe straight to localStorage.
                var g=readGlobal(); g.campistryMe=me; g.updated_at=new Date().toISOString();
                try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(g)); }catch(e){}
            }
        }
    }

    // ── ledger mutations ────────────────────────────────────────────────────
    function addCharge(acctKey, type, label, amount, camper, date){
        var b=getBilling(); var id=uid(type==='credit'?'crd':'chg');
        var amt=type==='credit'? -Math.abs(n2(amount)) : n2(amount);
        b.charges[id]={ id:id, acct:acctKey, camper:camper||'', type:type||'fee', label:label||'Charge',
            amount:amt, enrollmentId:null, date:date||todayISO(), void:false, ts:Date.now() };
        saveBilling(b); scheduleWriteback(); return id;
    }
    function voidCharge(id){ var b=getBilling(); if(b.charges[id]){ b.charges[id].void=true; saveBilling(b); scheduleWriteback(); } }
    function recordPayment(acctKey, method, amount, ref, note, date, planId, inst){
        var b=getBilling(); var id=uid('pay');
        b.payments[id]={ id:id, acct:acctKey, method:method||'cash', amount:n2(amount), ref:ref||'',
            note:note||'', date:date||todayISO(), planId:planId||null, inst:(inst==null?null:inst), ts:Date.now() };
        if(planId!=null && inst!=null && b.plans[planId] && b.plans[planId].installments[inst]){
            b.plans[planId].installments[inst].paidId=id;
        }
        saveBilling(b); scheduleWriteback(); return id;
    }
    function deletePayment(id){ var b=getBilling(); if(b.payments[id]){
        var p=b.payments[id]; if(p.planId!=null&&p.inst!=null&&b.plans[p.planId]&&b.plans[p.planId].installments[p.inst]) b.plans[p.planId].installments[p.inst].paidId=null;
        delete b.payments[id]; saveBilling(b); scheduleWriteback(); } }

    function createPlan(acctKey, total, deposit, count, cadence, firstDue){
        var b=getBilling(); var id=uid('pln');
        total=n2(total); deposit=n2(deposit); count=Math.max(1,parseInt(count,10)||1);
        var rem=n2(total-deposit); var each=n2(rem/count); var installments=[];
        var start=firstDue?new Date(firstDue+'T12:00:00'):new Date();
        for(var i=0;i<count;i++){
            var d=new Date(start.getTime());
            if(cadence==='monthly') d.setMonth(d.getMonth()+i);
            else if(cadence==='quarterly') d.setMonth(d.getMonth()+i*3);
            else if(cadence==='weekly') d.setDate(d.getDate()+i*7);
            var amt = i===count-1 ? n2(rem-each*(count-1)) : each;   // last absorbs rounding
            installments.push({ idx:i, amount:amt, due:d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'), paidId:null });
        }
        b.plans[id]={ id:id, acct:acctKey, total:total, deposit:deposit, cadence:cadence||'monthly', installments:installments, ts:Date.now() };
        saveBilling(b); return id;
    }
    function deletePlan(id){ var b=getBilling(); if(b.plans[id]){ delete b.plans[id]; saveBilling(b); } }

    // ══ RENDER ═══════════════════════════════════════════════════════════════
    var _search='';

    function balPill(bal){
        if(bal>0.001) return '<span class="bal-pill owed">'+fm(bal)+' due</span>';
        if(bal<-0.001) return '<span class="bal-pill credit">'+fm(-bal)+' credit</span>';
        return '<span class="bal-pill paid">Paid</span>';
    }

    function renderDashboard(){
        var b=syncEnrollments(); var list=accountList(b);
        var billed=0,collected=0,outstanding=0;
        list.forEach(function(r){ billed+=r.billed-r.credits; collected+=r.paid; if(r.balance>0) outstanding+=r.balance; });
        var od=overdueInstallments(b); var odAmt=od.reduce(function(s,x){return s+n2(x.ins.amount);},0);
        document.getElementById('statBilled').textContent=fm(billed);
        document.getElementById('statCollected').textContent=fm(collected);
        document.getElementById('statOutstanding').textContent=fm(outstanding);
        document.getElementById('statOverdue').textContent=fm(odAmt);
        // Revenue by session
        var bySess={};
        Object.keys(b.charges).forEach(function(id){ var c=b.charges[id]; if(c.void||c.type!=='tuition')return; var k=c.label.replace(/^Tuition — ?/,'')||'—'; bySess[k]=(bySess[k]||0)+c.amount; });
        var sessRows=Object.keys(bySess).sort(function(a,c){return bySess[c]-bySess[a];}).map(function(k){
            return '<tr><td>'+esc(k)+'</td><td class="num money">'+fm(bySess[k])+'</td></tr>';
        }).join('') || '<tr><td colspan="2" class="muted">No tuition charges yet — set session tuition in Campistry Me.</td></tr>';
        document.getElementById('revBySession').innerHTML='<table class="bill-table"><thead><tr><th>Session</th><th class="num">Billed</th></tr></thead><tbody>'+sessRows+'</tbody></table>';
        // Recent payments
        var recent=Object.keys(b.payments).map(function(id){return b.payments[id];}).sort(function(a,c){return (c.ts||0)-(a.ts||0);}).slice(0,8);
        var payRows=recent.map(function(p){ var a=b.accounts[p.acct]||{}; return '<tr><td>'+esc(a.familyName||p.acct)+'</td><td>'+esc(METHOD_LABELS[p.method]||p.method)+'</td><td class="muted">'+esc(fmtDate(p.date))+'</td><td class="num money pos">'+fm(p.amount)+'</td></tr>'; }).join('') || '<tr><td colspan="4" class="muted">No payments recorded yet.</td></tr>';
        document.getElementById('recentPayments').innerHTML='<table class="bill-table"><thead><tr><th>Family</th><th>Method</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>'+payRows+'</tbody></table>';
        // Overdue board
        var odRows=od.slice(0,10).map(function(x){ return '<tr class="clickable" onclick="CampistryBilling.openAccount(\''+esc(x.acct.key)+'\')"><td>'+esc(x.acct.familyName)+'</td><td class="muted">'+esc(fmtDate(x.ins.due))+'</td><td class="num money neg">'+fm(x.ins.amount)+'</td></tr>'; }).join('') || '<tr><td colspan="3" class="muted">Nothing overdue. 🎉</td></tr>';
        document.getElementById('overdueBoard').innerHTML='<table class="bill-table"><thead><tr><th>Family</th><th>Was due</th><th class="num">Amount</th></tr></thead><tbody>'+odRows+'</tbody></table>';
    }

    function renderFamilies(){
        var b=syncEnrollments(); var list=accountList(b);
        if(_search){ var q=norm(_search); list=list.filter(function(r){ return norm(r.acct.familyName).indexOf(q)>=0 || (r.campers||[]).some(function(c){return norm(c).indexOf(q)>=0;}) || norm(r.acct.parentEmail).indexOf(q)>=0; }); }
        var rows=list.map(function(r){
            var balCls=r.balance>0.001?'neg':r.balance<-0.001?'pos':'zero';
            return '<tr class="clickable" onclick="CampistryBilling.openAccount(\''+esc(r.key)+'\')">'+
                '<td><div style="font-weight:600">'+esc(r.acct.familyName)+'</div><div class="lr-sub">'+esc((r.campers||[]).join(', ')||'—')+'</div></td>'+
                '<td class="num money">'+fm(r.billed-r.credits)+'</td>'+
                '<td class="num money pos">'+fm(r.paid)+'</td>'+
                '<td class="num money '+balCls+'">'+fm(r.balance)+'</td>'+
                '<td class="right">'+balPill(r.balance)+'</td></tr>';
        }).join('') || '<tr><td colspan="5" class="muted">No families yet. Applications from the registration page appear here automatically.</td></tr>';
        document.getElementById('familiesBody').innerHTML=
            '<div class="card"><div class="card-body" style="overflow-x:auto"><table class="bill-table"><thead><tr><th>Family</th><th class="num">Net billed</th><th class="num">Paid</th><th class="num">Balance</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
    }

    function renderPayments(){
        var b=getBilling();
        var pays=Object.keys(b.payments).map(function(id){return b.payments[id];}).sort(function(a,c){return (c.ts||0)-(a.ts||0);});
        var rows=pays.map(function(p){ var a=b.accounts[p.acct]||{}; return '<tr>'+
            '<td class="muted">'+esc(fmtDate(p.date))+'</td>'+
            '<td class="clickable" onclick="CampistryBilling.openAccount(\''+esc(p.acct)+'\')">'+esc(a.familyName||p.acct)+'</td>'+
            '<td>'+esc(METHOD_LABELS[p.method]||p.method)+'</td>'+
            '<td class="muted">'+esc(p.ref||'')+'</td>'+
            '<td class="num money pos">'+fm(p.amount)+'</td>'+
            '<td class="right"><button class="btn btn-secondary btn-sm" onclick="CampistryBilling.deletePayment(\''+esc(p.id)+'\')">Delete</button></td>'+
            '</tr>'; }).join('') || '<tr><td colspan="6" class="muted">No payments recorded yet.</td></tr>';
        document.getElementById('paymentsBody').innerHTML=
            '<div class="card"><div class="card-body" style="overflow-x:auto"><table class="bill-table"><thead><tr><th>Date</th><th>Family</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
    }

    function renderPlans(){
        var b=getBilling(); var today=todayISO();
        var plans=Object.keys(b.plans).map(function(id){return b.plans[id];});
        if(!plans.length){ document.getElementById('plansBody').innerHTML='<div class="empty-state">No payment plans yet. Open a family and choose “Set up plan”.</div>'; return; }
        var html=plans.map(function(pl){
            var a=b.accounts[pl.acct]||{};
            var chips=(pl.installments||[]).map(function(ins){
                var cls=ins.paidId?'paid':(ins.due<today?'overdue':'due');
                var lbl=ins.paidId?'✓ ':(ins.due<today?'⚠ ':'');
                return '<span class="inst-chip '+cls+'">'+lbl+fm(ins.amount)+' · '+esc(fmtDate(ins.due))+'</span>';
            }).join(' ');
            return '<div class="card"><div class="card-body">'+
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'+
                '<div><span style="font-weight:700">'+esc(a.familyName||pl.acct)+'</span> <span class="muted">· '+esc(pl.cadence)+' · total '+fm(pl.total)+(pl.deposit?' · deposit '+fm(pl.deposit):'')+'</span></div>'+
                '<button class="btn btn-secondary btn-sm" onclick="CampistryBilling.deletePlan(\''+esc(pl.id)+'\')">Remove</button></div>'+
                '<div class="seg-row" style="margin:0">'+chips+'</div></div></div>';
        }).join('');
        document.getElementById('plansBody').innerHTML=html;
    }

    function renderSettings(){
        var b=getBilling(); var s=b.settings;
        var methodBoxes=Object.keys(METHOD_LABELS).filter(function(m){return m!=='card-online';}).map(function(m){
            var on=(s.methods||[]).indexOf(m)>=0;
            return '<label style="display:inline-flex;align-items:center;gap:6px;margin:0 14px 8px 0;font-size:.85rem"><input type="checkbox" '+(on?'checked':'')+' onchange="CampistryBilling.toggleMethod(\''+m+'\',this.checked)"> '+esc(METHOD_LABELS[m])+'</label>';
        }).join('');
        document.getElementById('settingsBody').innerHTML=
            '<div class="card"><div class="card-header"><h2>Payment methods offered</h2></div><div class="card-body">'+methodBoxes+'</div></div>'+
            '<div class="card"><div class="card-header"><h2>Documents</h2></div><div class="card-body">'+
              '<div class="form-group"><label class="form-label">Invoice number prefix</label><input class="form-input" id="setPrefix" value="'+esc(s.invoicePrefix||'INV-')+'" style="max-width:200px"></div>'+
              '<div class="form-group"><label class="form-label">Statement footer note</label><input class="form-input" id="setFooter" value="'+esc(s.statementFooter||'')+'" placeholder="e.g. Thank you! Questions? office@camp.org"></div>'+
              '<button class="btn btn-primary" onclick="CampistryBilling.saveSettings()">Save</button>'+
            '</div></div>'+
            '<div class="card"><div class="card-header"><h2>Online card / ACH payments</h2></div><div class="card-body">'+
              '<p class="muted" style="font-size:.85rem;line-height:1.6;margin-bottom:10px">Let families pay their balance online by card or bank. This needs a Stripe account and a one-time server setup (a Supabase edge function + your API keys). Turning it on here surfaces a “Pay online” button on invoices and in the parent portal once the server piece is deployed.</p>'+
              '<label style="display:inline-flex;align-items:center;gap:8px;font-size:.9rem"><input type="checkbox" id="setStripe" '+(s.stripeEnabled?'checked':'')+' onchange="CampistryBilling.toggleStripe(this.checked)"> Enable online payments (Stripe)</label>'+
              (s.stripeEnabled?'<div style="margin-top:10px;padding:10px 12px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;font-size:.8rem;color:#92400E">Server not deployed yet — the Pay-online button stays disabled until <code>create-payment-intent</code> is live. See the header comment in <code>campistry_billing.js</code>.</div>':'')+
            '</div></div>';
    }

    // ── account drawer ──────────────────────────────────────────────────────
    function openAccount(key){
        var b=getBilling(); var a=b.accounts[key]; if(!a) return; var t=computeAccount(b,key);
        var balCls=t.balance>0.001?'neg':t.balance<-0.001?'pos':'zero';
        var rows=[];
        t.charges.forEach(function(c){ rows.push({ ts:c.ts, kind:c.amount<0?'credit':'charge', title:c.label, sub:(c.camper?c.camper+' · ':'')+fmtDate(c.date), amt:c.amount, id:c.id, isPay:false }); });
        t.payments.forEach(function(p){ rows.push({ ts:p.ts, kind:'payment', title:'Payment · '+(METHOD_LABELS[p.method]||p.method), sub:(p.ref?p.ref+' · ':'')+fmtDate(p.date), amt:p.amount, id:p.id, isPay:true }); });
        rows.sort(function(x,y){ return (x.ts||0)-(y.ts||0); });
        var ledger=rows.map(function(r){
            var icon = r.kind==='payment'?'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
                : r.kind==='credit'?'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>'
                : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
            var amtCls = r.kind==='payment'?'money pos':r.kind==='credit'?'money pos':'money neg';
            var amtTxt = r.kind==='payment'? '+'+fm(r.amt) : fm(r.amt);
            var del = r.isPay ? '<button class="btn btn-secondary btn-sm" onclick="CampistryBilling.deletePayment(\''+esc(r.id)+'\',true)">✕</button>'
                              : (r.kind!=='payment' ? '<button class="btn btn-secondary btn-sm" onclick="CampistryBilling.voidCharge(\''+esc(r.id)+'\')">✕</button>' : '');
            return '<div class="ledger-row"><div class="lr-icon '+r.kind+'">'+icon+'</div>'+
                '<div class="lr-main"><div class="lr-title">'+esc(r.title)+'</div><div class="lr-sub">'+esc(r.sub)+'</div></div>'+
                '<div class="lr-amt '+amtCls+'">'+amtTxt+'</div>'+del+'</div>';
        }).join('') || '<div class="empty-state">No ledger activity yet.</div>';

        var body=
            '<div class="acct-balance" style="margin-bottom:4px"><div class="ab-num '+balCls+'">'+fm(t.balance)+'</div><div class="ab-lbl">'+(t.balance>0.001?'balance due':t.balance<-0.001?'credit balance':'paid in full')+'</div></div>'+
            '<div class="muted" style="font-size:.8rem;margin-bottom:14px">Billed '+fm(t.billed)+' · Credits '+fm(t.credits)+' · Paid '+fm(t.paid)+(a.parentEmail?' · '+esc(a.parentEmail):'')+'</div>'+
            '<div class="seg-row">'+
              '<button class="btn btn-primary btn-sm" onclick="CampistryBilling.openPayment(\''+esc(key)+'\')">Record payment</button>'+
              '<button class="btn btn-secondary btn-sm" onclick="CampistryBilling.openCharge(\''+esc(key)+'\')">Add charge / credit</button>'+
              '<button class="btn btn-secondary btn-sm" onclick="CampistryBilling.openPlan(\''+esc(key)+'\')">Set up plan</button>'+
              '<button class="btn btn-secondary btn-sm" onclick="CampistryBilling.printDoc(\''+esc(key)+'\',\'invoice\')">Invoice</button>'+
              '<button class="btn btn-secondary btn-sm" onclick="CampistryBilling.printDoc(\''+esc(key)+'\',\'statement\')">Statement</button>'+
            '</div>'+
            '<div>'+ledger+'</div>';
        showModal(esc(a.familyName), body, '', true);
    }

    // ── modals (dynamic) ─────────────────────────────────────────────────────
    function showModal(title, bodyHTML, footerHTML, wide){
        closeModal();
        var o=document.createElement('div'); o.className='modal-overlay open'; o.id='__billModal';
        o.innerHTML='<div class="modal'+(wide?' modal-wide':'')+'"><div class="modal-header"><h3>'+title+'</h3><button class="modal-close" onclick="CampistryBilling.closeModal()">&times;</button></div>'+
            '<div class="modal-body">'+bodyHTML+'</div>'+(footerHTML?'<div class="modal-footer">'+footerHTML+'</div>':'')+'</div>';
        o.addEventListener('click',function(e){ if(e.target===o) closeModal(); });
        document.body.appendChild(o);
    }
    function closeModal(){ var m=document.getElementById('__billModal'); if(m) m.remove(); }

    function acctOptions(sel){ var b=getBilling(); return accountList(b).map(function(r){ return '<option value="'+esc(r.key)+'"'+(r.key===sel?' selected':'')+'>'+esc(r.acct.familyName)+' ('+fm(r.balance)+' due)</option>'; }).join(''); }

    function openPayment(key){
        var b=getBilling();
        var methods=(b.settings.methods||DEFAULT_METHODS).map(function(m){ return '<option value="'+m+'">'+esc(METHOD_LABELS[m]||m)+'</option>'; }).join('');
        var t=key?computeAccount(b,key):null;
        var body=
            '<div class="form-group"><label class="form-label">Family</label><select class="form-input" id="payAcct"'+(key?' disabled':'')+'>'+(key?'':'<option value="">— Select —</option>')+acctOptions(key)+'</select></div>'+
            '<div class="form-group"><label class="form-label">Amount</label><input type="number" step="0.01" min="0" class="form-input" id="payAmt" value="'+(t&&t.balance>0?n2(t.balance):'')+'" placeholder="0.00"></div>'+
            '<div class="form-group"><label class="form-label">Method</label><select class="form-input" id="payMethod">'+methods+'</select></div>'+
            '<div class="form-group"><label class="form-label">Reference (check #, txn id)</label><input class="form-input" id="payRef" placeholder="optional"></div>'+
            '<div class="form-group"><label class="form-label">Date</label><input type="date" class="form-input" id="payDate" value="'+todayISO()+'"></div>'+
            '<div class="form-group"><label class="form-label">Note</label><input class="form-input" id="payNote" placeholder="optional"></div>';
        var footer='<button class="btn btn-secondary" onclick="CampistryBilling.closeModal()">Cancel</button><button class="btn btn-primary" onclick="CampistryBilling.savePayment(\''+esc(key||'')+'\')">Save payment</button>';
        showModal('Record payment', body, footer, false);
    }
    function savePayment(key){
        var acct=key||document.getElementById('payAcct').value;
        var amt=n2(document.getElementById('payAmt').value);
        if(!acct) return toast('Pick a family');
        if(!(amt>0)) return toast('Enter an amount');
        recordPayment(acct, document.getElementById('payMethod').value, amt, document.getElementById('payRef').value.trim(), document.getElementById('payNote').value.trim(), document.getElementById('payDate').value);
        closeModal(); toast('Payment recorded'); refresh(); openAccount(acct);
    }

    function openCharge(key){
        var body=
            '<div class="form-group"><label class="form-label">Type</label><select class="form-input" id="chgType"><option value="fee">Charge (fee / add-on)</option><option value="credit">Credit / discount / scholarship</option></select></div>'+
            '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="chgLabel" placeholder="e.g. Bus fee, Canteen top-up, Sibling scholarship"></div>'+
            '<div class="form-group"><label class="form-label">Amount</label><input type="number" step="0.01" min="0" class="form-input" id="chgAmt" placeholder="0.00"></div>'+
            '<div class="form-group"><label class="form-label">Date</label><input type="date" class="form-input" id="chgDate" value="'+todayISO()+'"></div>';
        var footer='<button class="btn btn-secondary" onclick="CampistryBilling.closeModal()">Cancel</button><button class="btn btn-primary" onclick="CampistryBilling.saveCharge(\''+esc(key)+'\')">Add</button>';
        showModal('Add charge / credit', body, footer, false);
    }
    function saveCharge(key){
        var type=document.getElementById('chgType').value;
        var label=document.getElementById('chgLabel').value.trim();
        var amt=n2(document.getElementById('chgAmt').value);
        if(!label) return toast('Enter a description');
        if(!(amt>0)) return toast('Enter an amount');
        addCharge(key, type, label, amt, '', document.getElementById('chgDate').value);
        closeModal(); toast(type==='credit'?'Credit added':'Charge added'); refresh(); openAccount(key);
    }

    function openPlan(key){
        var b=getBilling(); var t=computeAccount(b,key);
        var body=
            '<p class="muted" style="font-size:.82rem;margin-bottom:12px">Split the balance into scheduled installments. Recording a payment against an installment marks it paid.</p>'+
            '<div class="form-group"><label class="form-label">Total to schedule</label><input type="number" step="0.01" class="form-input" id="plTotal" value="'+(t.balance>0?n2(t.balance):0)+'"></div>'+
            '<div class="form-group"><label class="form-label">Deposit already collected (optional)</label><input type="number" step="0.01" class="form-input" id="plDep" value="0"></div>'+
            '<div class="form-group"><label class="form-label">Number of installments</label><input type="number" min="1" max="24" class="form-input" id="plCount" value="3"></div>'+
            '<div class="form-group"><label class="form-label">Cadence</label><select class="form-input" id="plCad"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="weekly">Weekly</option></select></div>'+
            '<div class="form-group"><label class="form-label">First installment due</label><input type="date" class="form-input" id="plFirst" value="'+todayISO()+'"></div>';
        var footer='<button class="btn btn-secondary" onclick="CampistryBilling.closeModal()">Cancel</button><button class="btn btn-primary" onclick="CampistryBilling.savePlan(\''+esc(key)+'\')">Create plan</button>';
        showModal('Set up payment plan', body, footer, false);
    }
    function savePlan(key){
        var total=n2(document.getElementById('plTotal').value);
        var dep=n2(document.getElementById('plDep').value);
        var count=parseInt(document.getElementById('plCount').value,10)||1;
        if(!(total>0)) return toast('Enter a total');
        createPlan(key, total, dep, count, document.getElementById('plCad').value, document.getElementById('plFirst').value);
        closeModal(); toast('Plan created'); refresh(); openAccount(key);
    }

    // ── invoice / statement print ────────────────────────────────────────────
    function printDoc(key, kind){
        var b=getBilling(); var a=b.accounts[key]; if(!a) return; var t=computeAccount(b,key); var s=b.settings;
        var title=kind==='invoice'?'Invoice':'Statement';
        var num=(s.invoicePrefix||'INV-')+String(Math.abs(hashStr(key))).slice(0,6);
        var lines;
        if(kind==='invoice'){
            // Amount due now: unpaid charges only.
            lines=t.charges.map(function(c){ return { d:c.label, dt:fmtDate(c.date), amt:c.amount }; });
        } else {
            lines=[];
            t.charges.forEach(function(c){ lines.push({ ts:c.ts, d:c.label, dt:fmtDate(c.date), amt:c.amount }); });
            t.payments.forEach(function(p){ lines.push({ ts:p.ts, d:'Payment — '+(METHOD_LABELS[p.method]||p.method)+(p.ref?' ('+p.ref+')':''), dt:fmtDate(p.date), amt:-p.amount }); });
            lines.sort(function(x,y){ return (x.ts||0)-(y.ts||0); });
        }
        var rowHtml=lines.map(function(l){ return '<tr><td>'+esc(l.dt)+'</td><td>'+esc(l.d)+'</td><td class="r">'+fm(l.amt)+'</td></tr>'; }).join('');
        var totalRow = kind==='invoice'
            ? '<tr class="tot"><td></td><td class="r">Amount due</td><td class="r">'+fm(t.balance)+'</td></tr>'
            : '<tr class="tot"><td></td><td class="r">Balance</td><td class="r">'+fm(t.balance)+'</td></tr>';
        var w=window.open('','_blank'); if(!w){ toast('Allow pop-ups to print'); return; }
        w.document.write('<!DOCTYPE html><html><head><title>'+esc(title)+' — '+esc(a.familyName)+'</title><style>'+
            'body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;padding:40px 48px;}'+
            '.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0E7C4A;padding-bottom:16px;margin-bottom:22px;}'+
            '.camp{font-size:22px;font-weight:800;color:#0E7C4A;}'+
            '.doc{font-size:13px;color:#555;text-align:right;}'+
            '.doc b{font-size:18px;color:#111;display:block;text-transform:uppercase;letter-spacing:.08em;}'+
            '.bill-to{font-size:13px;color:#333;margin-bottom:18px;line-height:1.6;}'+
            'table{width:100%;border-collapse:collapse;font-size:13px;}'+
            'th{text-align:left;border-bottom:1px solid #ccc;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666;}'+
            'td{padding:8px 6px;border-bottom:1px solid #eee;}'+
            '.r{text-align:right;font-variant-numeric:tabular-nums;}'+
            'tr.tot td{border-top:2px solid #333;border-bottom:none;font-weight:800;font-size:15px;padding-top:12px;}'+
            '.ft{margin-top:26px;font-size:12px;color:#666;border-top:1px solid #eee;padding-top:12px;}'+
            '</style></head><body>'+
            '<div class="hd"><div class="camp">'+esc(campName())+'</div><div class="doc"><b>'+esc(title)+'</b>'+esc(num)+'<br>'+esc(fmtDate(todayISO()))+'</div></div>'+
            '<div class="bill-to"><b>Bill to:</b> '+esc(a.familyName)+(a.parentEmail?'<br>'+esc(a.parentEmail):'')+(a.parentPhone?'<br>'+esc(a.parentPhone):'')+((a.camperNames||[]).length?'<br>Campers: '+esc(a.camperNames.join(', ')):'')+'</div>'+
            '<table><thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th></tr></thead><tbody>'+rowHtml+totalRow+'</tbody></table>'+
            (s.statementFooter?'<div class="ft">'+esc(s.statementFooter)+'</div>':'')+
            '</body></html>');
        w.document.close(); w.focus(); setTimeout(function(){ w.print(); },250);
    }
    function hashStr(s){ var h=0; s=String(s); for(var i=0;i<s.length;i++){ h=((h<<5)-h+s.charCodeAt(i))|0; } return h; }

    // ── settings mutations ───────────────────────────────────────────────────
    function toggleMethod(m,on){ var b=getBilling(); var arr=b.settings.methods||[]; var i=arr.indexOf(m); if(on&&i<0)arr.push(m); if(!on&&i>=0)arr.splice(i,1); b.settings.methods=arr; saveBilling(b); }
    function toggleStripe(on){ var b=getBilling(); b.settings.stripeEnabled=!!on; saveBilling(b); renderSettings(); }
    function saveSettings(){ var b=getBilling(); b.settings.invoicePrefix=document.getElementById('setPrefix').value.trim()||'INV-'; b.settings.statementFooter=document.getElementById('setFooter').value.trim(); saveBilling(b); toast('Settings saved'); }

    // ── toast ────────────────────────────────────────────────────────────────
    function toast(msg){ var el=document.getElementById('toastEl'); if(!el){ console.log('[Billing]',msg); return; } el.textContent=msg; el.className='toast'; requestAnimationFrame(function(){ el.classList.add('show'); setTimeout(function(){ el.classList.remove('show'); },2400); }); }

    // ── routing / refresh ────────────────────────────────────────────────────
    var _page='dashboard';
    function show(page){ _page=page; refresh(); }
    function refresh(){
        try{
            if(_page==='dashboard') renderDashboard();
            else if(_page==='families') renderFamilies();
            else if(_page==='payments') renderPayments();
            else if(_page==='plans') renderPlans();
            else if(_page==='settings') renderSettings();
        }catch(e){ console.warn('[Billing] render error:', e); }
    }
    function setSearch(q){ _search=q; if(_page==='families') renderFamilies(); }

    // ── cloud merge bridge (union by id; converges across devices) ───────────
    function conn(){ var d=window.CampistryDB; if(!d)return null; var c=d.getClient?d.getClient():null, id=d.getCampId?d.getCampId():null; return (c&&id&&c.from)?{c:c,id:id}:null; }
    function mergeMaps(local, cloud){ var out=Object.assign({}, cloud||{}); Object.keys(local||{}).forEach(function(k){ out[k]=local[k]; }); return out; }
    function cloudPull(){
        var cn=conn(); if(!cn) return;
        cn.c.from('camp_state_kv').select('value').eq('camp_id',cn.id).eq('key',BILLING_KEY).maybeSingle().then(function(res){
            if(!res||res.error||!res.data||!res.data.value) return;
            var cloud=res.data.value; var local=getBilling();
            var merged=defaults();
            merged.accounts=mergeMaps(local.accounts, cloud.accounts);
            merged.charges=mergeMaps(local.charges, cloud.charges);
            merged.payments=mergeMaps(local.payments, cloud.payments);
            merged.plans=mergeMaps(local.plans, cloud.plans);
            merged.bootstrapped=mergeMaps(local.bootstrapped, cloud.bootstrapped);
            merged.settings=Object.assign({}, cloud.settings||{}, local.settings||{});
            // Only rewrite + rerender when something actually differs.
            var before=JSON.stringify({a:local.accounts,c:local.charges,p:local.payments,pl:local.plans});
            var after=JSON.stringify({a:merged.accounts,c:merged.charges,p:merged.payments,pl:merged.plans});
            if(before!==after){
                saveBilling(merged);   // persists to localStorage + in-memory cache + cloud (converges)
                scheduleWriteback();
                refresh();
            }
        });
    }

    // ── init ─────────────────────────────────────────────────────────────────
    function init(){
        var email=document.getElementById('navUserEmail');
        if(email){ try{ var g=readGlobal(); email.textContent=(g.currentUserEmail)||'Office'; }catch(e){} }
        syncEnrollments(); writebackStatuses(); refresh();
        // Converge across devices.
        function start(){ cloudPull(); setInterval(cloudPull, 20000); }
        if(window.CampistryDB && window.CampistryDB.ready && window.CampistryDB.ready.then){ window.CampistryDB.ready.then(function(){ setTimeout(start,400); }); }
        else { setTimeout(start,1200); }
        window.addEventListener('campistry-cloud-hydrated', function(){ syncEnrollments(); writebackStatuses(); refresh(); });
        document.addEventListener('visibilitychange', function(){ if(!document.hidden) cloudPull(); });
    }

    window.CampistryBilling = {
        init:init, show:show, refresh:refresh, setSearch:setSearch,
        openAccount:openAccount, closeModal:closeModal,
        openPayment:openPayment, savePayment:savePayment,
        openCharge:openCharge, saveCharge:saveCharge,
        openPlan:openPlan, savePlan:savePlan,
        voidCharge:function(id){ var b=getBilling(); var acct=b.charges[id]&&b.charges[id].acct; voidCharge(id); refresh(); if(acct) openAccount(acct); },
        deletePayment:function(id,reopen){ var b=getBilling(); var acct=b.payments[id]&&b.payments[id].acct; deletePayment(id); refresh(); if(reopen&&acct) openAccount(acct); },
        deletePlan:function(id){ deletePlan(id); refresh(); },
        toggleMethod:toggleMethod, toggleStripe:toggleStripe, saveSettings:saveSettings,
        printDoc:printDoc,
        // exposed for tests / console
        _computeAccount:function(k){ return computeAccount(getBilling(), k); }, _syncEnrollments:syncEnrollments,
        _recordPayment:recordPayment, _writeback:writebackStatuses
    };

    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
