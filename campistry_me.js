// campistry_me.js — Campistry Me Engine (Premium Rebuild)
(function(){
'use strict';
console.log('📋 Campistry Me loading...');

var COLORS=['#D97706','#147D91','#8B5CF6','#0EA5E9','#10B981','#F43F5E','#EC4899','#84CC16','#6366F1','#14B8A6'];
var AV_BG=['#147D91','#6366F1','#0EA5E9','#10B981','#F43F5E','#8B5CF6','#D97706'];

var structure={}, roster={}, families={}, payments=[], broadcasts=[], bunkAsgn={};
var enrollments={}, sessions=[], enrollSettings={}, formConfig=null;
var finStaff=[], finExpenses=[], finPayments=[], finBudget={revenue:0,payroll:0,expenses:0}, finIntegrations={};
var curPage='campers', editingCamper=null, editingDiv=null, editingFam=null;
var nextCamperId=1;
var _saveLockUntil=0; // timestamp — block cloud overwrites for 5s after local save

// ═══ INIT ════════════════════════════════════════════════════════
function init(){
    loadData(); setupSidebar(); setupSearch(); setupModals();
    // Apply RTL if configured
    var cs=getCampSettings();
    if(cs.rtl) document.documentElement.setAttribute('dir','rtl');
    syncAllAddressesToGo();
    nav('campers');
    console.log('📋 Me ready:',Object.keys(roster).length,'campers');

    // Block cloud hydration from overwriting recent saves
    window.addEventListener('campistry-cloud-hydrated',function(){
        if(Date.now()<_saveLockUntil){
            console.log('[Me] Blocked cloud hydration overwrite (save lock active)');
            // Re-write our data back
            setTimeout(function(){save()},200);
        }else{
            // Cloud data is newer — reload
            console.log('[Me] Cloud hydration — reloading data');
            loadData();render(curPage);
        }
    });

    // Watch for localStorage changes from other tabs/scripts
    window.addEventListener('storage',function(e){
        if(e.key==='campGlobalSettings_v1'&&Date.now()>=_saveLockUntil){
            console.log('[Me] External storage change — reloading');
            loadData();render(curPage);
        }
    });
}

// ═══ DATA ════════════════════════════════════════════════════════
function loadData(){
    try{
        var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        structure=s.campStructure||{};
        roster=(s.app1&&s.app1.camperRoster)||{};
        var me=s.campistryMe||{};
        families=me.families||{}; payments=me.payments||[];
        broadcasts=me.broadcasts||[]; bunkAsgn=me.bunkAssignments||{};
        enrollments=me.enrollments||{}; sessions=me.sessions||[]; enrollSettings=me.enrollSettings||{};
        formConfig=me.formConfig||null;
        // Ensure promoCodes live inside enrollSettings
        if(me.promoCodes&&!enrollSettings.promoCodes)enrollSettings.promoCodes=me.promoCodes;
        // Analytics & Finance
        var fin=me.finance||{};
        finStaff=fin.staff||[];finExpenses=fin.expenses||[];finPayments=fin.payments||[];
        finBudget=fin.budget||{revenue:0,payroll:0,expenses:0};finIntegrations=fin.integrations||{};
        nextCamperId=me.nextCamperId||1;
        // Backfill: assign IDs to any campers that don't have one
        var maxId=0;
        Object.values(roster).forEach(function(c){if(c.camperId&&c.camperId>maxId)maxId=c.camperId});
        if(maxId>=nextCamperId)nextCamperId=maxId+1;
        Object.entries(roster).forEach(function([n,c]){if(!c.camperId){c.camperId=nextCamperId;nextCamperId++}});
    }catch(e){console.warn('[Me]',e)}
}
function save(){
    try{
        _saveLockUntil=Date.now()+5000;
        var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        g.campStructure=structure;
        if(!g.app1)g.app1={};
        g.app1.camperRoster=roster;
        // Build divisions from structure — full replacement, no merge with old
        var m={};
        Object.entries(structure).forEach(function([d,dd]){var b=[];Object.values(dd.grades||{}).forEach(function(gr){(gr.bunks||[]).forEach(function(bk){b.push(bk)})});var ex=(g.app1.divisions&&g.app1.divisions[d])||{};m[d]=Object.assign({},ex,{color:dd.color,bunks:b})});
        g.app1.divisions=m;
        g.campistryMe={
            families:families,
            payments:payments,
            broadcasts:broadcasts,
            bunkAssignments:bunkAsgn,
            nextCamperId:nextCamperId,
            enrollments:enrollments,
            sessions:sessions,
            enrollSettings:enrollSettings,
            formConfig:formConfig,
            promoCodes:enrollSettings.promoCodes||(g.campistryMe?.promoCodes)||{},
            finance:{staff:finStaff,expenses:finExpenses,payments:finPayments,budget:finBudget,integrations:finIntegrations}
        };
        g.updated_at=new Date().toISOString();
        var json=JSON.stringify(g);
        localStorage.setItem('campGlobalSettings_v1',json);
        // Write to all known keys that other scripts may read
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE',json);
        try{localStorage.setItem('CAMPISTRY_UNIFIED_STATE',json)}catch(ex){}
        console.log('[Me] Saved locally:',Object.keys(roster).length,'campers,',Object.keys(enrollments).length,'enrollments,',sessions.length,'sessions');
        // Verify write after a short delay (catch overwrites from cloud hydration)
        var rosterCount=Object.keys(roster).length;
        setTimeout(function(){
            try{
                var check=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
                var checkCount=Object.keys((check.app1&&check.app1.camperRoster)||{}).length;
                if(checkCount<rosterCount){
                    console.warn('[Me] ⚠ Save was overwritten — re-saving');
                    localStorage.setItem('campGlobalSettings_v1',json);
                    localStorage.setItem('CAMPISTRY_LOCAL_CACHE',json);
                }
            }catch(e){}
        },800);
        if(window.saveGlobalSettings&&window.saveGlobalSettings._isAuthoritativeHandler){
            console.log('[Me] ☁️ Syncing to cloud: campStructure, app1, campistryMe');
            window.saveGlobalSettings('campStructure',structure);
            window.saveGlobalSettings('app1',g.app1);
            window.saveGlobalSettings('campistryMe',g.campistryMe);
        }else if(typeof window.forceSyncToCloud==='function'){
            console.log('[Me] ☁️ Syncing to cloud via forceSyncToCloud');
            window.forceSyncToCloud();
        }else{
            console.log('[Me] ⚠ No cloud sync available — saved to localStorage only');
        }
        // ★ Update starter-plan banner camper count in real time (trial_guard.js integration)
        if(typeof window.refreshStarterBanner==='function'){
            try{window.refreshStarterBanner(rosterCount)}catch(ex){}
        }
    }catch(e){console.error('[Me] Save:',e)}
}

// ═══ SIDEBAR ═════════════════════════════════════════════════════
function setupSidebar(){
    var h=document.getElementById('hamburgerBtn'),bd=document.getElementById('sidebarBackdrop'),sb=document.getElementById('sidebar');
    function open(){document.body.classList.add('sidebar-open')}
    function close(){document.body.classList.remove('sidebar-open')}
    if(h)h.onclick=function(){document.body.classList.contains('sidebar-open')?close():open()};
    if(bd)bd.onclick=close;
    if(sb)sb.querySelectorAll('.sidebar-item').forEach(function(b){b.onclick=function(){nav(b.dataset.page);close()}});
}
function nav(p){
    curPage=p;
    document.querySelectorAll('.sidebar-item').forEach(function(b){b.classList.toggle('active',b.dataset.page===p)});
    document.querySelectorAll('.me-page').forEach(function(pg){pg.classList.toggle('active',pg.id==='page-'+p)});
    render(p);
}

function setupSearch(){
    var inp=document.getElementById('globalSearch');if(!inp)return;
    var t;inp.oninput=function(){clearTimeout(t);t=setTimeout(function(){if(curPage==='campers')renderCampers(inp.value.trim())},200)};
}

// ═══ HELPERS ═════════════════════════════════════════════════════
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
function je(s){return esc(s).replace(/'/g,"\\'")}
function age(dob){if(!dob)return'';var a=Math.floor((Date.now()-new Date(dob).getTime())/31557600000);return a>=0&&a<25?a:''}

// ── Hebrew date conversion (Intl API — works in all modern browsers) ──
function toHebrewDate(isoDate){
    if(!isoDate) return'';
    try{
        var d=new Date(isoDate+'T12:00:00');
        if(isNaN(d.getTime())) return'';
        // Use Intl.DateTimeFormat with Hebrew calendar
        var fmt=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{day:'numeric',month:'long',year:'numeric'});
        return fmt.format(d);
    }catch(e){return''}
}

// ── Locale-aware date formatting ──
function getCampLocale(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    return(s.campistryMe&&s.campistryMe.locale)||'en-US';
}
function getCampSettings(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    return(s.campistryMe&&s.campistryMe.campSettings)||{showHebrewDates:false,showAltNames:true,rtl:false};
}
function formatDateLocale(isoDate){
    if(!isoDate) return'';
    try{
        var d=new Date(isoDate+'T12:00:00');
        return d.toLocaleDateString(getCampLocale(),{month:'long',day:'numeric',year:'numeric'});
    }catch(e){return isoDate}
}
function ini(n){var p=n.split(' ');return((p[0]||'?')[0]+(p.length>1?(p[p.length-1]||'?')[0]:'')).toUpperCase()}
function avc(n){var h=0;for(var i=0;i<n.length;i++)h+=n.charCodeAt(i);return AV_BG[h%AV_BG.length]}
function av(n,sz){var w=sz==='l'?52:sz==='m'?38:28,fs=sz==='l'?17:sz==='m'?13:10;return'<div class="av av-'+(sz||'s')+'" style="background:'+avc(n)+'">'+esc(ini(n))+'</div>'}
function bdg(l,t){return'<span class="badge badge-'+t+'">'+esc(l)+'</span>'}
function dtag(d){var c=(structure[d]&&structure[d].color)||'#94A3B8';return'<span class="div-tag" style="background:'+c+'10;color:'+c+'"><span class="div-dot" style="background:'+c+'"></span>'+esc(d)+'</span>'}
function fm(n){return'$'+Number(n||0).toLocaleString()}
function toast(m,t){var el=document.getElementById('meToast');if(!el)return;el.className='me-toast '+(t==='error'?'bad':'ok')+' vis';document.getElementById('tI').textContent=t==='error'?'✕':'✓';document.getElementById('tM').textContent=m;clearTimeout(el._t);el._t=setTimeout(function(){el.classList.remove('vis')},2600)}
function openModal(id){var e=document.getElementById(id);if(e)e.style.display='flex'}
function closeModal(id){var e=document.getElementById(id);if(e){if(id==='dynModal')e.remove();else e.style.display='none'}}
function setupModals(){document.querySelectorAll('.me-overlay').forEach(function(o){o.addEventListener('mousedown',function(e){if(e.target===o)closeModal(o.id)})});
    var dz=document.getElementById('csvDZ'),fi=document.getElementById('csvFI');
    if(dz&&fi){dz.onclick=function(){fi.click()};dz.ondragover=function(e){e.preventDefault();dz.classList.add('dragover')};dz.ondragleave=function(){dz.classList.remove('dragover')};dz.ondrop=function(e){e.preventDefault();dz.classList.remove('dragover');handleCsv(e.dataTransfer.files[0])};fi.onchange=function(e){handleCsv(e.target.files[0])}}
}

// Dynamic modal helper — creates modal on the fly
var _dynModalCb=null;
function showModal(title,bodyHtml,onSave){
    var existing=document.getElementById('dynModal');
    if(existing)existing.remove();
    var overlay=document.createElement('div');overlay.id='dynModal';
    overlay.className='me-overlay';overlay.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
    var footer=onSave?'<div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--s100)"><button class="me-btn me-btn--sec" onclick="CampistryMe.closeModal(\'dynModal\')">Cancel</button><button class="me-btn me-btn--pri" id="dynModalSave">Save</button></div>':'';
    overlay.innerHTML='<div style="background:#fff;border-radius:12px;max-width:560px;width:95%;max-height:85vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.25)"><div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--s100)"><h3 style="margin:0;font-size:1rem;font-weight:700">'+esc(title)+'</h3><button style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--s400)" onclick="CampistryMe.closeModal(\'dynModal\')">&times;</button></div><div style="padding:16px 20px">'+bodyHtml+'</div>'+footer+'</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown',function(e){if(e.target===overlay)closeModal('dynModal')});
    _dynModalCb=onSave||null;
    if(onSave){document.getElementById('dynModalSave').addEventListener('click',function(){if(_dynModalCb)_dynModalCb()})}
}

// Get all league names + teams from Flow
function getLeagues(){
    try{
        var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        var leagues={};
        var reg=g.leaguesByName||{};
        Object.entries(reg).forEach(function([name,l]){if(l&&l.teams)leagues[name]=l.teams});
        var spec=g.specialtyLeagues||{};
        Object.values(spec).forEach(function(l){if(l&&l.name&&l.teams)leagues[l.name]=l.teams});
        return leagues;
    }catch(e){return{}}
}

function ff(label,id,val,type,opts){
    var h='<div class="fg"><label class="fl">'+esc(label)+'</label>';
    if(type==='select'&&opts)h+='<select id="'+id+'" class="fs">'+opts.map(function(o){return'<option value="'+esc(o)+'"'+(o===val?' selected':'')+'>'+( o||'—')+'</option>'}).join('')+'</select>';
    else if(type==='textarea')h+='<textarea id="'+id+'" class="fi" style="min-height:60px;resize:vertical">'+esc(val||'')+'</textarea>';
    else h+='<input type="'+(type||'text')+'" id="'+id+'" class="fi" value="'+esc(val||'')+'">';
    return h+'</div>';
}

// ═══ RENDERERS ═══════════════════════════════════════════════════
function render(p){
    var m={families:renderFamilies,campers:renderCampers,structure:renderStructure,bunkbuilder:renderBB,enrollment:renderEnrollment,billing:renderBilling,broadcasts:renderBroadcasts,analytics:renderAnalytics,forms:renderForms,reports:renderReports,settings:renderSettings};
    if(m[p])m[p]();else renderSoon(p);
}

// ── FAMILIES ─────────────────────────────────────────────────────
// ── Family auto-detect: same last name + same/similar address → suggestion ──
function detectFamilySuggestions(){
    // Build set of campers already assigned to a family
    var assignedCampers=new Set();
    Object.values(families).forEach(function(f){(f.camperIds||[]).forEach(function(n){assignedCampers.add(n)})});

    // Group unassigned campers by last name
    var byLastName={};
    Object.entries(roster).forEach(function([name,c]){
        if(assignedCampers.has(name)) return;
        var parts=name.trim().split(/\s+/);
        var lastName=parts.length>1?parts[parts.length-1].toLowerCase():'';
        if(!lastName) return;
        if(!byLastName[lastName]) byLastName[lastName]=[];
        byLastName[lastName].push({name:name,camper:c,lastName:parts[parts.length-1]});
    });

    var suggestions=[];
    Object.entries(byLastName).forEach(function([lnKey,group]){
        if(group.length<2) return; // need at least 2 campers to suggest a family

        // Sub-group by address similarity
        var addressGroups={};
        group.forEach(function(g){
            var addr=normalizeAddr(g.camper);
            if(!addressGroups[addr]) addressGroups[addr]=[];
            addressGroups[addr].push(g);
        });

        Object.values(addressGroups).forEach(function(addrGroup){
            if(addrGroup.length<2) return;
            // Check if they also share a parent name
            var sharedParent=null;
            var p1=addrGroup[0].camper.parent1Name;
            if(p1){
                var allMatch=addrGroup.every(function(g){return g.camper.parent1Name===p1});
                if(allMatch) sharedParent=p1;
            }
            suggestions.push({
                lastName:addrGroup[0].lastName,
                campers:addrGroup.map(function(g){return g.name}),
                address:[addrGroup[0].camper.street,addrGroup[0].camper.city,addrGroup[0].camper.state,addrGroup[0].camper.zip].filter(Boolean).join(', '),
                parent:sharedParent||addrGroup[0].camper.parent1Name||'',
                parentPhone:addrGroup[0].camper.parent1Phone||'',
                parentEmail:addrGroup[0].camper.parent1Email||'',
                confidence:sharedParent?'high':'medium'
            });
        });

        // Also suggest groups with same last name but NO address (still likely family)
        var noAddr=group.filter(function(g){return!g.camper.street});
        if(noAddr.length>=2){
            // Check if already covered by an address group
            var coveredNames=new Set();
            Object.values(addressGroups).forEach(function(ag){if(ag.length>=2) ag.forEach(function(g){coveredNames.add(g.name)})});
            var uncovered=noAddr.filter(function(g){return!coveredNames.has(g.name)});
            if(uncovered.length>=2){
                suggestions.push({
                    lastName:uncovered[0].lastName,
                    campers:uncovered.map(function(g){return g.name}),
                    address:'',
                    parent:uncovered[0].camper.parent1Name||'',
                    parentPhone:uncovered[0].camper.parent1Phone||'',
                    parentEmail:uncovered[0].camper.parent1Email||'',
                    confidence:'low'
                });
            }
        }
    });

    // Also find single unassigned campers who match an EXISTING family by last name + address
    var singleSuggestions=[];
    Object.entries(roster).forEach(function([name,c]){
        if(assignedCampers.has(name)) return;
        var parts=name.trim().split(/\s+/);
        var lastName=parts.length>1?parts[parts.length-1].toLowerCase():'';
        if(!lastName) return;
        // Check existing families
        Object.entries(families).forEach(function([fk,f]){
            if((f.camperIds||[]).indexOf(name)>=0) return; // already in this family
            var famLast=(f.name||'').toLowerCase().replace(/\s*family$/,'').trim();
            if(famLast!==lastName) return;
            // Match — suggest adding to this family
            singleSuggestions.push({familyKey:fk,familyName:f.name,camperName:name});
        });
    });

    return{newFamilies:suggestions,addToExisting:singleSuggestions};
}

function normalizeAddr(c){
    var street=(c.street||'').toLowerCase().replace(/[^a-z0-9]/g,'').trim();
    var zip=(c.zip||'').trim();
    if(!street&&!zip) return '__noaddr__'+Math.random(); // unique key so no-address campers don't accidentally group
    return street+'|'+zip;
}

function acceptFamilySuggestion(idx){
    var suggestions=detectFamilySuggestions().newFamilies;
    var s=suggestions[idx];if(!s) return;
    var famKey='fam_'+s.lastName.toLowerCase().replace(/[^a-z0-9]/g,'')+'_'+Date.now();
    var parents=[{name:s.parent||'',phone:s.parentPhone||'',email:s.parentEmail||'',relation:'Parent'}];
    families[famKey]={
        name:s.lastName+' Family',
        households:[{label:'Primary',parents:parents,address:s.address||'',billingContact:true}],
        camperIds:s.campers.slice(),
        balance:0,totalPaid:0,notes:'Auto-detected family'
    };
    save();render('families');toast(s.lastName+' Family created with '+s.campers.length+' campers');
}

function dismissFamilySuggestion(idx){
    // Store dismissed suggestions so they don't reappear
    var suggestions=detectFamilySuggestions().newFamilies;
    var s=suggestions[idx];if(!s) return;
    var dismissed=JSON.parse(localStorage.getItem('campistry_dismissed_fam_suggestions')||'[]');
    dismissed.push(s.campers.sort().join('|'));
    localStorage.setItem('campistry_dismissed_fam_suggestions',JSON.stringify(dismissed));
    render('families');toast('Suggestion dismissed');
}

function acceptAddToFamily(famKey,camperName){
    if(!families[famKey]) return;
    if(!families[famKey].camperIds) families[famKey].camperIds=[];
    if(families[famKey].camperIds.indexOf(camperName)<0) families[famKey].camperIds.push(camperName);
    save();render('families');toast(camperName+' added to '+families[famKey].name);
}

function renderFamilies(){
    var c=document.getElementById('page-families'),e=Object.entries(families);

    // Detect family suggestions
    var suggestions=detectFamilySuggestions();
    var dismissed=JSON.parse(localStorage.getItem('campistry_dismissed_fam_suggestions')||'[]');
    var newFams=suggestions.newFamilies.filter(function(s){return dismissed.indexOf(s.campers.sort().join('|'))<0});
    var addToExisting=suggestions.addToExisting;
    var totalSuggestions=newFams.length+addToExisting.length;

    var h='<div class="sec-hd"><div><h2 class="sec-title">Families</h2><p class="sec-desc">'+e.length+' household'+(e.length!==1?'s':'')+(totalSuggestions>0?' · <span style="color:var(--me);font-weight:700">'+totalSuggestions+' suggestion'+(totalSuggestions!==1?'s':'')+'</span>':'')+'</p></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.addFamily()">+ Add Family</button></div></div>';

    // Show suggestions banner
    if(newFams.length||addToExisting.length){
        h+='<div style="background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border:1px solid #FDE68A;border-radius:var(--r2);padding:16px;margin-bottom:18px">';
        h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-size:1.1rem">👨‍👩‍👧‍👦</span><span style="font-weight:700;font-size:.9rem;color:var(--s800)">Family Suggestions</span><span style="font-size:.75rem;color:var(--s500)">Campers with the same last name and address may belong together</span></div>';

        // New family suggestions
        newFams.forEach(function(s,i){
            var confColor=s.confidence==='high'?'var(--ok)':s.confidence==='medium'?'var(--warn)':'var(--s400)';
            var confLabel=s.confidence==='high'?'High confidence':s.confidence==='medium'?'Medium':'Low';
            h+='<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#fff;border-radius:var(--r);margin-bottom:6px;border:1px solid var(--s200)">';
            h+='<div style="flex:1"><div style="font-weight:700;font-size:.875rem">'+esc(s.lastName)+' Family</div>';
            h+='<div style="font-size:.75rem;color:var(--s500);margin-top:2px">'+s.campers.map(function(n){return'<strong>'+esc(n)+'</strong>'}).join(', ');
            if(s.address) h+=' · '+esc(s.address);
            if(s.parent) h+=' · Parent: '+esc(s.parent);
            h+='</div></div>';
            h+='<span style="font-size:.65rem;font-weight:600;color:'+confColor+';background:'+confColor+'15;padding:2px 8px;border-radius:4px">'+confLabel+'</span>';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.acceptFamilySuggestion('+i+')">Accept</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--s400)" onclick="CampistryMe.dismissFamilySuggestion('+i+')">Dismiss</button>';
            h+='</div>';
        });

        // Add-to-existing suggestions
        addToExisting.forEach(function(s){
            h+='<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#fff;border-radius:var(--r);margin-bottom:6px;border:1px solid var(--s200)">';
            h+='<div style="flex:1"><div style="font-size:.8rem"><strong>'+esc(s.camperName)+'</strong> may belong to <strong>'+esc(s.familyName)+'</strong></div></div>';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.acceptAddToFamily(\''+je(s.familyKey)+'\',\''+je(s.camperName)+'\')">Add</button>';
            h+='</div>';
        });

        h+='</div>';
    }

    if(!e.length&&!totalSuggestions){h+='<div class="me-empty"><h3>No families yet</h3><p>Add a family to get started, or import campers and we\'ll detect families automatically.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.addFamily()">+ Add Family</button></div>'}
    else e.forEach(function([id,f]){
        var sb=f.balance>0?bdg(fm(f.balance)+' due','err'):f.totalPaid>0?bdg('Paid','ok'):bdg('Pending','warn');
        h+='<div class="fam-card"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px"><div><div style="font-size:.95rem;font-weight:600;color:var(--s800)">'+esc(f.name)+'</div><div style="font-size:.75rem;color:var(--s400)">'+(f.camperIds||[]).length+' camper'+((f.camperIds||[]).length!==1?'s':'')+'</div></div><div style="display:flex;gap:6px;align-items:center">'+sb+'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editFamily(\''+je(id)+'\')">Edit</button></div></div>';
        (f.households||[]).forEach(function(hh){
            h+='<div class="hh"><div style="font-size:.65rem;font-weight:600;color:var(--s400);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">'+esc(hh.label||'Primary')+(hh.billingContact?' · Billing':'')+'</div>';
            (hh.parents||[]).forEach(function(p){h+='<div style="font-size:.8rem;margin-bottom:2px"><strong>'+esc(p.name)+'</strong>'+(p.phone?' — <a href="tel:'+esc(p.phone)+'" style="color:var(--me)">'+esc(p.phone)+'</a>':'')+'</div>'});
            if(hh.address)h+='<div style="font-size:.7rem;color:var(--s400);margin-top:2px">'+esc(hh.address)+'</div>';
            h+='</div>';
        });
        h+='<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">';
        (f.camperIds||[]).forEach(function(cn){h+='<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:6px;border:1px solid var(--s200);font-size:.7rem;font-weight:600;cursor:pointer" onclick="CampistryMe.viewCamper(\''+je(cn)+'\')">'+esc(cn.split(' ')[0])+'</span>'});
        h+='</div></div>';
    });
    c.innerHTML=h;
}

// Family create/edit
function openFamilyForm(id){
    editingFam=id;
    var f=id?families[id]:{name:'',households:[{label:'Primary',parents:[{name:'',phone:'',email:'',relation:'Mother'}],address:'',billingContact:true}],camperIds:[],balance:0,totalPaid:0,notes:''};
    document.getElementById('fmTitle').textContent=id?'Edit Family':'Add Family';
    var h='<div class="fsec">Family Info</div>';
    h+=ff('Family Name','fmName',f.name);
    h+=ff('Notes','fmNotes',f.notes,'textarea');
    h+='<div class="fsec">Household</div>';
    var hh=f.households&&f.households[0]?f.households[0]:{label:'Primary',parents:[{name:'',phone:'',email:'',relation:''}],address:''};
    h+=ff('Household Label','fmHHLabel',hh.label);
    h+='<div class="fr">'+ff('Parent 1 Name','fmP1',hh.parents&&hh.parents[0]?hh.parents[0].name:'')+ff('Parent 1 Phone','fmP1Ph',hh.parents&&hh.parents[0]?hh.parents[0].phone:'')+'</div>';
    h+=ff('Parent 1 Email','fmP1Em',hh.parents&&hh.parents[0]?hh.parents[0].email:'','email');
    h+='<div class="fr">'+ff('Parent 2 Name','fmP2',hh.parents&&hh.parents[1]?hh.parents[1].name:'')+ff('Parent 2 Phone','fmP2Ph',hh.parents&&hh.parents[1]?hh.parents[1].phone:'')+'</div>';
    h+=ff('Address','fmAddr',hh.address);
    h+='<div class="fsec">Linked Campers</div><p style="font-size:.8rem;color:var(--s400)">Select campers in this family:</p><div id="fmCamperChecks" style="max-height:150px;overflow-y:auto;margin-top:6px">';
    Object.keys(roster).sort().forEach(function(n){
        var checked=(f.camperIds||[]).indexOf(n)>=0;
        h+='<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:.8rem;cursor:pointer"><input type="checkbox" class="fmCamperCB" value="'+esc(n)+'"'+(checked?' checked':'')+' style="accent-color:var(--me)"> '+esc(n)+'</label>';
    });
    h+='</div>';
    document.getElementById('fmBody').innerHTML=h;
    document.getElementById('fmSave').onclick=saveFamily;
    openModal('familyModal');
}
function saveFamily(){
    var name=(document.getElementById('fmName').value||'').trim();
    if(!name){toast('Name required','error');return}
    var id=editingFam||('fam_'+Date.now());
    var camperIds=[];document.querySelectorAll('.fmCamperCB:checked').forEach(function(cb){camperIds.push(cb.value)});
    var p1={name:(document.getElementById('fmP1').value||'').trim(),phone:(document.getElementById('fmP1Ph').value||'').trim(),email:(document.getElementById('fmP1Em').value||'').trim(),relation:'Mother'};
    var p2={name:(document.getElementById('fmP2').value||'').trim(),phone:(document.getElementById('fmP2Ph').value||'').trim(),relation:'Father'};
    var parents=[p1];if(p2.name)parents.push(p2);
    families[id]={name:name,households:[{label:(document.getElementById('fmHHLabel').value||'Primary').trim(),parents:parents,address:(document.getElementById('fmAddr').value||'').trim(),billingContact:true}],camperIds:camperIds,balance:(families[id]&&families[id].balance)||0,totalPaid:(families[id]&&families[id].totalPaid)||0,notes:(document.getElementById('fmNotes').value||'').trim()};
    save();closeModal('familyModal');render(curPage);toast(editingFam?'Family updated':'Family added');
}

// ── CAMPERS ──────────────────────────────────────────────────────
function renderCampers(filter){
    var c=document.getElementById('page-campers'),entries=Object.entries(roster),total=entries.length;
    if(filter){var q=filter.toLowerCase();entries=entries.filter(function([n,d]){var altN=[d.altFirstName,d.altLastName].filter(Boolean).join(' ').toLowerCase();return n.toLowerCase().includes(q)||altN.includes(q)||(d.division||'').toLowerCase().includes(q)||(d.bunk||'').toLowerCase().includes(q)||(d.school||'').toLowerCase().includes(q)})}
    entries.sort(function(a,b){return a[0].localeCompare(b[0])});
    var h='<div class="sec-hd"><div><h2 class="sec-title">Campers</h2><p class="sec-desc">'+total+' total</p></div><div class="sec-actions"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.detectDuplicates()" title="Find duplicate campers">🔍 Duplicates</button><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.manageCustomFields()" title="Define custom fields">⚙ Custom Fields</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.downloadTemplate()">Template</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openCsv()">Import</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportCsv()">Export</button><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add Camper</button></div></div>';
    if(!entries.length){h+='<div class="me-empty"><h3>No campers yet</h3><p>Add campers or import from CSV.</p><div style="display:flex;gap:6px;justify-content:center"><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add</button><button class="me-btn me-btn--sec" onclick="CampistryMe.openCsv()">Import</button></div></div>'}
    else{
        h+='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th style="width:50px">ID</th><th>Name</th><th>Age</th><th>School</th><th>Grade</th><th>Teacher</th><th>Division</th><th>Bunk</th><th>Medical</th><th style="width:60px"></th></tr></thead><tbody>';
        entries.forEach(function([n,d]){
            var hasMed=!!(d.allergies||d.medications);
            var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'—';
            var altN=[d.altFirstName,d.altLastName].filter(Boolean).join(' ');
            var nameCell=esc(n)+(altN&&getCampSettings().showAltNames!==false?'<div style="font-size:.7rem;color:var(--s400);font-weight:400">'+esc(altN)+'</div>':'');
            h+='<tr class="click" onclick="CampistryMe.viewCamper(\''+je(n)+'\')">'+'<td style="font-family:monospace;font-size:.75rem;color:var(--s400)">#'+esc(idStr)+'</td><td class="bold">'+nameCell+'</td><td>'+(d.dob?age(d.dob):'—')+'</td><td>'+esc(d.school||'—')+'</td><td>'+esc(d.schoolGrade||'—')+'</td><td>'+esc(d.teacher||'—')+'</td><td>'+(d.division?dtag(d.division):'<span style="color:var(--s300)">—</span>')+'</td><td>'+esc(d.bunk||'—')+'</td><td>'+(hasMed?'<span style="color:var(--err);font-size:.7rem;font-weight:600">⚠ '+esc((d.allergies||d.medications||'').split(',')[0])+'</span>':'<span style="color:var(--s300)">—</span>')+'</td><td style="text-align:right" onclick="event.stopPropagation()"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editCamper(\''+je(n)+'\')">Edit</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    }
    c.innerHTML=h;
}

// Camper view (centered modal)
function viewCamper(n){
    var d=roster[n];if(!d)return;
    var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'—';

    // Header with photo placeholder
    var photoUrl=d.photoUrl||'';
    var photoHtml=photoUrl
        ?'<img src="'+esc(photoUrl)+'" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:2px solid var(--s200)">'
        :'<div style="width:72px;height:72px;border-radius:12px;background:var(--s100);border:2px dashed var(--s300);display:flex;align-items:center;justify-content:center;flex-direction:column;cursor:pointer" onclick="CampistryMe.uploadPhoto(\''+je(n)+'\')" title="Click to add photo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--s400)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span style="font-size:.6rem;color:var(--s400);margin-top:2px">Add Photo</span></div>';

    var altDisplay=[d.altFirstName,d.altLastName].filter(Boolean).join(' ');
    var altHtml=altDisplay?'<div style="font-size:.85rem;color:var(--s500);margin-top:2px">'+esc(altDisplay)+'</div>':'';
    document.getElementById('cvHead').innerHTML='<div style="display:flex;gap:16px;align-items:flex-start;padding:4px 0">'+photoHtml+'<div style="flex:1"><h3 class="cv-name">'+esc(n)+'</h3>'+altHtml+'<div class="cv-tags" style="margin-top:6px"><span class="badge badge-gray" style="font-family:monospace">#'+esc(idStr)+'</span>'+(d.division?dtag(d.division):'')+(d.bunk?' '+bdg(d.bunk,'gray'):'')+'</div></div></div>';

    var b='';

    // Personal
    b+='<div class="cv-sec">Personal Information</div>';
    b+=cvR('Full Name',n);
    var altName=[d.altFirstName,d.altLastName].filter(Boolean).join(' ');
    if(altName) b+=cvR('Alternate Name','<span style="font-size:1rem">'+esc(altName)+'</span>');
    b+=cvR('Camper ID','#'+idStr);
    if(d.dob){
        var dobStr=new Date(d.dob+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})+' (age '+age(d.dob)+')';
        var hebDate=toHebrewDate(d.dob);
        if(hebDate) dobStr+=' · <span style="font-size:.85rem;color:var(--me)">'+hebDate+'</span>';
        b+=cvR('Date of Birth',dobStr);
    }
    b+=cvR('Gender',d.gender);
    b+=cvR('School',d.school);
    b+=cvR('School Grade',d.schoolGrade);
    b+=cvR('Teacher',d.teacher);

    // Camp Assignment
    b+='<div class="cv-sec">Camp Assignment</div>';
    b+=cvR('Division',d.division);
    b+=cvR('Grade',d.grade);
    b+=cvR('Bunk',d.bunk);

    // League Teams
    var teams=d.teams||{};var teamKeys=Object.keys(teams);
    if(d.team&&!teamKeys.length){b+='<div class="cv-sec">League Teams</div>';b+=cvR('Team',d.team)}
    else if(teamKeys.length){b+='<div class="cv-sec">League Teams</div>';teamKeys.forEach(function(lg){b+=cvR(lg,teams[lg])})}

    // Parent / Guardian
    b+='<div class="cv-sec">Parent / Guardian</div>';
    if(d.parent1Name){
        b+=cvR('Name',d.parent1Name);
        if(d.parent1Phone)b+=cvR('Phone','<a href="tel:'+esc(d.parent1Phone)+'" style="color:var(--me);font-weight:600">'+esc(d.parent1Phone)+'</a>');
        if(d.parent1Email)b+=cvR('Email','<a href="mailto:'+esc(d.parent1Email)+'" style="color:var(--me)">'+esc(d.parent1Email)+'</a>');
    }else{
        b+='<div style="font-size:.8rem;color:var(--s400);font-style:italic;padding:2px 0">No parent info on file</div>';
    }

    // Address
    b+='<div class="cv-sec">Address</div>';
    if(d.street){
        b+=cvR('Street',d.street);
        b+=cvR('City',d.city);
        b+=cvR('State',d.state);
        b+=cvR('ZIP',d.zip);
        var fullAddr=[d.street,d.city,d.state,d.zip].filter(Boolean).join(', ');
        b+='<a href="https://maps.google.com/?q='+encodeURIComponent(fullAddr)+'" target="_blank" style="display:inline-flex;align-items:center;gap:4px;font-size:.75rem;font-weight:600;color:var(--me);margin-top:4px;text-decoration:none">Open in Maps →</a>';
    }else{
        b+='<div style="font-size:.8rem;color:var(--s400);font-style:italic;padding:2px 0">No address on file</div>';
    }

    // Emergency Contact
    b+='<div class="cv-sec">Emergency Contact</div>';
    if(d.emergencyName){
        b+=cvR('Name',d.emergencyName+(d.emergencyRel?' ('+d.emergencyRel+')':''));
        if(d.emergencyPhone)b+=cvR('Phone','<a href="tel:'+esc(d.emergencyPhone)+'" style="color:var(--me);font-weight:600">'+esc(d.emergencyPhone)+'</a>');
    }else{
        b+='<div style="font-size:.8rem;color:var(--err);font-style:italic;padding:2px 0">⚠ No emergency contact on file</div>';
    }

    // Medical
    b+='<div class="cv-sec">Medical Summary</div>';
    if(d.allergies)b+=cvR('Allergies',d.allergies,true);
    if(d.medications)b+=cvR('Medications',d.medications,true);
    if(d.dietary)b+=cvR('Dietary',d.dietary);
    if(!d.allergies&&!d.medications&&!d.dietary)b+='<div style="font-size:.8rem;color:var(--ok);padding:2px 0">✓ No medical flags</div>';
    b+='<div class="cv-health" onclick="window.location.href=\'campistry_health.html\'">Open in Campistry Health →</div>';

    // Documents
    b+='<div class="cv-sec" style="display:flex;justify-content:space-between;align-items:center">Documents <button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.uploadDocument(\''+je(n)+'\')">+ Upload</button></div>';
    b+=renderDocuments(n);

    // Scholarships / Financial Aid
    var schols=d.scholarships||[];
    b+='<div class="cv-sec" style="display:flex;justify-content:space-between;align-items:center">Financial Aid <button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.addScholarship(\''+je(n)+'\')">+ Award</button></div>';
    if(schols.length){schols.forEach(function(s){b+=cvR(s.type,fm(s.amount)+(s.source?' — '+s.source:'')+(s.date?' ('+s.date+')':''))})}
    else b+='<div style="font-size:.8rem;color:var(--s400);font-style:italic">No aid on file</div>';

    // Custom Fields
    loadCustomFields();
    if(customFields.length){
        b+='<div class="cv-sec">Custom Fields</div>';
        customFields.forEach(function(cf){b+=cvR(cf.label,d['cf_'+cf.id]||'<span style="color:var(--s300)">—</span>')});
    }

    // Notes & Timeline
    b+='<div class="cv-sec" style="display:flex;justify-content:space-between;align-items:center">Notes & Timeline <button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.addCamperNote(\''+je(n)+'\')">+ Add Note</button></div>';
    b+=renderCamperTimeline(n);

    // Quick Actions
    b+='<div class="cv-sec">Quick Actions</div>';
    b+='<div style="display:flex;gap:6px;flex-wrap:wrap">';
    b+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.reEnrollCamper(\''+je(n)+'\')">Re-Enroll</button>';
    b+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.addCamperNote(\''+je(n)+'\')">Add Note</button>';
    b+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.uploadDocument(\''+je(n)+'\')">Upload Doc</button>';
    b+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.addScholarship(\''+je(n)+'\')">Award Aid</button>';
    b+='</div>';

    document.getElementById('cvBody').innerHTML=b;
    document.getElementById('cvEditBtn').onclick=function(){closeModal('camperViewModal');editCamper(n)};
    openModal('camperViewModal');
}
function cvR(l,v,w){if(!v)return'';return'<div class="cv-row"><span class="cv-lbl">'+esc(l)+'</span><span class="cv-val'+(w?' cv-warn':'')+'">'+v+'</span></div>'}

// Camper edit
function editCamper(n){
    editingCamper=n;
    var d=n?roster[n]||{}:{};var parts=(n||'').split(' ');
    var titleEl=document.getElementById('ceTitle');
    if(titleEl)titleEl.textContent=n?'Edit Camper':'Add Camper';
    var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'Will be assigned on save';
    var h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div class="fsec" style="margin:0">Identity</div><span style="font-family:monospace;font-size:.8rem;color:var(--s400);background:var(--s100);padding:3px 10px;border-radius:var(--r)">Camper ID: #'+esc(idStr)+'</span></div>';
    h+='<div class="fr">'+ff('First Name','ceFirst',parts[0]||'')+ff('Last Name','ceLast',parts.slice(1).join(' ')||'')+'</div>';
    h+='<div class="fr">'+ff('Alternate First Name','ceAltFirst',d.altFirstName||'')+ff('Alternate Last Name','ceAltLast',d.altLastName||'')+'</div>';
    h+='<p style="font-size:.65rem;color:var(--s400);margin:-4px 0 8px;padding-left:2px">Hebrew, Spanish, Chinese, or any other name used at camp</p>';
    h+='<div class="fr">'+ff('Date of Birth','ceDob',d.dob||'','date')+ff('Gender','ceGender',d.gender||'','select',['','Male','Female','Non-binary','Other'])+'</div>';
    h+='<div class="fr">'+ff('School Name','ceSchool',d.school||'')+ff('School Grade','ceSchoolGr',d.schoolGrade||'')+'</div>';
    h+=ff('Teacher','ceTeacher',d.teacher||'');

    h+='<div class="fsec">Camp Assignment</div>';
    h+='<div class="fr">'+ff('Division','ceDiv',d.division||'','select',[''].concat(Object.keys(structure).sort()))+ff('Grade','ceCGrade',d.grade||'','select',grOpts(d.division))+'</div>';
    h+=ff('Bunk','ceBunk',d.bunk||'','select',bkOpts(d.division,d.grade));

    // Multi-league teams
    var leagues=getLeagues();var leagueNames=Object.keys(leagues).sort();
    var curTeams=d.teams||{};
    if(d.team&&!Object.keys(curTeams).length&&leagueNames.length){curTeams[leagueNames[0]]=d.team}
    h+='<div class="fsec">League Teams</div>';
    if(!leagueNames.length){h+='<p style="font-size:.8rem;color:var(--s400)">No leagues configured yet. Set up leagues in <a href="flow.html" style="color:var(--me);font-weight:600">Campistry Flow</a>.</p>';h+=ff('Team (legacy)','ceTeamLegacy',d.team||'')}
    else{
        h+='<div id="ceTeamRows">';
        leagueNames.forEach(function(lg){
            var teams=leagues[lg]||[];
            var cur=curTeams[lg]||'';
            h+='<div class="fr" style="align-items:flex-end;margin-bottom:6px"><div class="fg" style="flex:1"><label class="fl">'+esc(lg)+'</label><select class="fs ceTeamSel" data-league="'+esc(lg)+'"><option value="">— No team —</option>'+teams.map(function(t){return'<option value="'+esc(t)+'"'+(t===cur?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div></div>';
        });
        h+='</div>';
    }

    h+='<div class="fsec">Parent / Guardian</div>';
    h+='<div class="fr">'+ff('Parent 1 Name','ceP1',d.parent1Name||'')+ff('Phone','ceP1Ph',d.parent1Phone||'')+'</div>';
    h+=ff('Email','ceP1Em',d.parent1Email||'','email');

    h+='<div class="fsec">Address</div>';
    h+=ff('Street Address','ceStreet',d.street||'');
    h+='<div class="fr">'+ff('City','ceCity',d.city||'')+ff('State','ceState',d.state||'')+ff('ZIP','ceZip',d.zip||'')+'</div>';

    h+='<div class="fsec">Emergency Contact</div>';
    h+='<div class="fr">'+ff('Name','ceEmN',d.emergencyName||'')+ff('Phone','ceEmPh',d.emergencyPhone||'')+'</div>';
    h+=ff('Relation','ceEmR',d.emergencyRel||'');

    h+='<div class="fsec">Medical (quick glance)</div>';
    h+='<div class="fr">'+ff('Allergies','ceAlg',d.allergies||'')+ff('Medications','ceMed',d.medications||'')+'</div>';
    h+=ff('Dietary Restrictions','ceDiet',d.dietary||'');

    var ceBodyEl=document.getElementById('ceBody');
    if(ceBodyEl)ceBodyEl.innerHTML=h;
    // Cascade
    var divS=document.getElementById('ceDiv'),grS=document.getElementById('ceCGrade'),bkS=document.getElementById('ceBunk');
    if(divS)divS.onchange=function(){if(grS)grS.innerHTML=grOpts(divS.value).map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('');if(bkS)bkS.innerHTML=bkOpts(divS.value,'').map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('')};
    if(grS)grS.onchange=function(){if(bkS)bkS.innerHTML=bkOpts(divS.value,grS.value).map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('')};
    var saveBtn=document.getElementById('ceSave');
    if(saveBtn)saveBtn.onclick=saveCamper;
    openModal('camperEditModal');
}
function addCamper(){editingCamper=null;editCamper('')}
function saveCamper(){
    var first=(document.getElementById('ceFirst').value||'').trim(),last=(document.getElementById('ceLast').value||'').trim();
    if(!first){toast('First name required','error');return}
    var full=first+(last?' '+last:'');
    if(editingCamper&&editingCamper!==full)delete roster[editingCamper];
    if(!editingCamper&&roster[full]){toast('Already exists','error');return}
    // Gather teams
    var teams={};document.querySelectorAll('.ceTeamSel').forEach(function(sel){var lg=sel.dataset.league,v=sel.value;if(lg&&v)teams[lg]=v});
    var existingId=(editingCamper&&roster[editingCamper])?roster[editingCamper].camperId:null;
    if(!existingId){existingId=nextCamperId;nextCamperId++}
    roster[full]={
        camperId:existingId,
        altFirstName:(document.getElementById('ceAltFirst').value||'').trim(),
        altLastName:(document.getElementById('ceAltLast').value||'').trim(),
        dob:document.getElementById('ceDob').value||'',gender:document.getElementById('ceGender').value||'',
        school:document.getElementById('ceSchool').value||'',schoolGrade:document.getElementById('ceSchoolGr').value||'',
        teacher:document.getElementById('ceTeacher').value||'',
        division:document.getElementById('ceDiv').value||'',grade:document.getElementById('ceCGrade').value||'',
        bunk:document.getElementById('ceBunk').value||'',
        teams:teams,team:Object.values(teams)[0]||document.getElementById('ceTeamLegacy')?.value||'',
        street:document.getElementById('ceStreet').value||'',city:document.getElementById('ceCity').value||'',
        state:document.getElementById('ceState').value||'',zip:document.getElementById('ceZip').value||'',
        parent1Name:document.getElementById('ceP1').value||'',parent1Phone:document.getElementById('ceP1Ph').value||'',
        parent1Email:document.getElementById('ceP1Em').value||'',
        emergencyName:document.getElementById('ceEmN').value||'',emergencyPhone:document.getElementById('ceEmPh').value||'',
        emergencyRel:document.getElementById('ceEmR').value||'',
        allergies:document.getElementById('ceAlg').value||'',medications:document.getElementById('ceMed').value||'',
        dietary:document.getElementById('ceDiet').value||''
    };
    // Sync address to Campistry Go format
    syncAddressToGo(full,roster[full]);
    save();closeModal('camperEditModal');render(curPage);toast(editingCamper?'Updated':'Added');
}
function grOpts(div){var o=[''];if(div&&structure[div])Object.keys(structure[div].grades||{}).sort().forEach(function(g){o.push(g)});return o}
function bkOpts(div,gr){var o=[''];if(div&&gr&&structure[div]&&structure[div].grades&&structure[div].grades[gr])(structure[div].grades[gr].bunks||[]).forEach(function(b){o.push(b)});return o}

// Sync camper address to Campistry Go's address store
function syncAddressToGo(camperName,camperData){
    if(!camperData.street)return;
    // Single-camper sync (used after editing one camper)
    try{
        var goRaw=localStorage.getItem('campistry_go_data');
        var goData=goRaw?JSON.parse(goRaw):{};
        if(!goData.addresses)goData.addresses={};
        var existing=goData.addresses[camperName]||{};
        var unchanged=existing.street===camperData.street&&existing.city===camperData.city;
        if(unchanged)return; // Skip if nothing changed
        goData.addresses[camperName]={
            street:camperData.street||'',city:camperData.city||'',
            state:camperData.state||'NY',zip:camperData.zip||'',
            lat:null,lng:null,geocoded:false,
            transport:existing.transport||'bus',rideWith:existing.rideWith||''
        };
        localStorage.setItem('campistry_go_data',JSON.stringify(goData));
    }catch(e){console.warn('[Me] Go sync error:',e)}
}

// Bulk sync — ONE read, ONE diff, ONE write. Runs on load.
function syncAllAddressesToGo(){
    try{
        var goRaw=localStorage.getItem('campistry_go_data');
        var goData=goRaw?JSON.parse(goRaw):{};
        if(!goData.addresses)goData.addresses={};
        var changed=0;
        Object.entries(roster).forEach(function([name,data]){
            if(!data.street)return;
            var existing=goData.addresses[name]||{};
            // Skip if address hasn't changed
            if(existing.street===data.street&&existing.city===data.city)return;
            goData.addresses[name]={
                street:data.street||'',city:data.city||'',
                state:data.state||'NY',zip:data.zip||'',
                lat:null,lng:null,geocoded:false,
                transport:existing.transport||'bus',rideWith:existing.rideWith||''
            };
            changed++;
        });
        if(changed>0){
            localStorage.setItem('campistry_go_data',JSON.stringify(goData));
            console.log('[Me→Go] Bulk synced '+changed+' new/changed addresses');
        }
    }catch(e){console.warn('[Me] Bulk Go sync error:',e)}
}

// ── STRUCTURE ────────────────────────────────────────────────────
function renderStructure(){
    var c=document.getElementById('page-structure'),divs=Object.entries(structure).sort(function(a,b){return a[0].localeCompare(b[0])});
    var h='<div class="sec-hd"><div><h2 class="sec-title">Camp Structure</h2></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.addDiv()">+ Add Division</button></div></div>';
    if(!divs.length){h+='<div class="me-empty"><h3>No divisions yet</h3><p>Create your camp structure.</p></div>'}
    else divs.forEach(function([dn,dd]){
        var grades=Object.entries(dd.grades||{}).sort(function(a,b){return a[0].localeCompare(b[0],undefined,{numeric:true})});
        var bCt=grades.reduce(function(s,e){return s+(e[1].bunks||[]).length},0);
        var col=dd.color||'#94A3B8';
        h+='<div class="me-card" style="margin-bottom:10px"><div class="me-card-head"><div style="display:flex;align-items:center;gap:8px"><div style="width:10px;height:10px;border-radius:3px;background:'+col+'"></div><h3 style="margin:0">'+esc(dn)+'</h3><span style="font-size:.75rem;color:var(--s400)">'+grades.length+' grades · '+bCt+' bunks</span></div><div style="display:flex;gap:4px"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editDiv(\''+je(dn)+'\')">Edit</button><button class="me-btn me-btn--danger me-btn--sm" onclick="CampistryMe.deleteDiv(\''+je(dn)+'\')">Delete</button></div></div>';
        h+='<div style="padding:14px 18px">';
        grades.forEach(function([gn,gd]){
            h+='<div style="margin-bottom:10px"><div style="font-size:.8rem;font-weight:600;color:var(--s700);margin-bottom:4px">'+esc(gn)+'</div><div style="display:flex;flex-wrap:wrap;gap:4px">';
            (gd.bunks||[]).forEach(function(b){h+='<span style="padding:3px 8px;border-radius:6px;border:1px solid var(--s200);font-size:.7rem;font-weight:600;color:var(--s600)">'+esc(b)+'</span>'});
            h+='</div></div>';
        });
        h+='</div></div>';
    });
    c.innerHTML=h;
}

// Division create/edit
function openDivForm(name){
    editingDiv=name;
    var d=name?structure[name]:{color:COLORS[Object.keys(structure).length%COLORS.length],grades:{}};
    document.getElementById('dmTitle').textContent=name?'Edit Division':'Add Division';
    var h=ff('Division Name','dmName',name||'');
    h+='<div class="fg"><label class="fl">Color</label><div class="swatch-row">';
    COLORS.forEach(function(c){h+='<button class="swatch'+(d.color===c?' sel':'')+'" style="background:'+c+'" data-color="'+c+'" onclick="CampistryMe._pickColor(this)"></button>'});
    h+='</div><input type="hidden" id="dmColor" value="'+(d.color||COLORS[0])+'"></div>';
    // Grades + Bunks
    h+='<div class="fsec">Grades & Bunks</div><div id="dmGrades">';
    Object.entries(d.grades||{}).forEach(function([gn,gd],i){
        h+='<div class="fg" style="background:var(--s50);padding:8px 10px;border-radius:var(--r);border:1px solid var(--s200);margin-bottom:6px"><div class="fr"><div class="fg" style="flex:1"><label class="fl">Grade Name</label><input class="fi dmGradeN" value="'+esc(gn)+'"></div></div><div class="fg"><label class="fl">Bunks (comma separated)</label><input class="fi dmGradeB" value="'+esc((gd.bunks||[]).join(', '))+'"></div></div>';
    });
    h+='</div><button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe._addGradeRow()">+ Add Grade</button>';
    document.getElementById('dmBody').innerHTML=h;
    document.getElementById('dmSave').onclick=saveDiv;
    openModal('divModal');
}
function _addGradeRow(){
    var cont=document.getElementById('dmGrades');
    var div=document.createElement('div');
    div.className='fg';div.style.cssText='background:var(--s50);padding:8px 10px;border-radius:var(--r);border:1px solid var(--s200);margin-bottom:6px';
    div.innerHTML='<div class="fr"><div class="fg" style="flex:1"><label class="fl">Grade Name</label><input class="fi dmGradeN" value="" placeholder="e.g. 1st Grade"></div></div><div class="fg"><label class="fl">Bunks (comma separated)</label><input class="fi dmGradeB" value="" placeholder="Bunk 1, Bunk 2"></div>';
    cont.appendChild(div);
}
function _pickColor(el){
    document.querySelectorAll('.swatch').forEach(function(s){s.classList.remove('sel')});
    el.classList.add('sel');
    document.getElementById('dmColor').value=el.dataset.color;
}
function saveDiv(){
    var name=(document.getElementById('dmName').value||'').trim();
    if(!name){toast('Name required','error');return}
    var color=document.getElementById('dmColor').value||COLORS[0];
    var grades={};
    var gradeNs=document.querySelectorAll('.dmGradeN');
    var gradeBs=document.querySelectorAll('.dmGradeB');
    gradeNs.forEach(function(el,i){
        var gn=el.value.trim();if(!gn)return;
        var bunks=(gradeBs[i]?gradeBs[i].value:'').split(',').map(function(s){return s.trim()}).filter(Boolean);
        grades[gn]={bunks:bunks};
    });
    if(editingDiv&&editingDiv!==name){
        // Rename: update roster references
        Object.values(roster).forEach(function(c){if(c.division===editingDiv){c.division=name}});
        delete structure[editingDiv];
    }
    structure[name]={color:color,grades:grades};
    save();closeModal('divModal');render(curPage);toast(editingDiv?'Division updated':'Division created');
}
function deleteDiv(n){if(!confirm('Delete "'+n+'"?'))return;delete structure[n];Object.values(roster).forEach(function(c){if(c.division===n){c.division='';c.grade='';c.bunk=''}});save();render(curPage);toast('Deleted')}

// ── BUNK BUILDER ─────────────────────────────────────────────────
function renderBB(){
    var c=document.getElementById('page-bunkbuilder');
    var allB=[];Object.entries(structure).forEach(function([div,d]){Object.entries(d.grades||{}).forEach(function([gr,g]){(g.bunks||[]).forEach(function(b){allB.push({name:b,div:div,gr:gr,color:d.color||'#94A3B8'})})})});
    var cArr=Object.keys(roster),aSet={};Object.values(bunkAsgn).forEach(function(ids){ids.forEach(function(id){aSet[id]=true})});
    var un=cArr.filter(function(n){return!aSet[n]}),placed=cArr.length-un.length;
    var h='<div class="sec-hd"><div><h2 class="sec-title">Bunk Builder</h2><p class="sec-desc">'+placed+'/'+cArr.length+' placed</p></div><div class="sec-actions"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.autoAssign()">⚡ Auto-Assign</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.clearBunks()">Clear</button></div></div>';
    if(!allB.length){h+='<div class="me-empty"><h3>No bunks</h3><p>Create divisions and bunks in Camp Structure first.</p></div>'}
    else{
        h+='<div class="bb"><div class="bb-pool" ondragover="event.preventDefault();this.querySelector(\'.bb-pool-bd\').classList.add(\'dragover\')" ondragleave="this.querySelector(\'.bb-pool-bd\').classList.remove(\'dragover\')" ondrop="CampistryMe.bbDrop(\'__pool__\',event);this.querySelector(\'.bb-pool-bd\').classList.remove(\'dragover\')">';
        h+='<div class="bb-pool-hd"><h3>Unassigned ('+un.length+')</h3></div><div class="bb-pool-bd">';
        if(!un.length)h+='<div style="text-align:center;padding:16px 6px;color:var(--ok);font-size:.8rem;font-weight:600">All placed ✓</div>';
        else un.forEach(function(n){h+=bbC(n)});
        h+='</div></div><div class="bb-board">';
        var lastD='';
        allB.forEach(function(bk){
            if(bk.div!==lastD){if(lastD)h+='</div>';lastD=bk.div;h+='<div class="bb-div"><span class="bb-dot" style="background:'+bk.color+'"></span>'+esc(bk.div)+'</div><div class="bb-gl">'+esc(bk.gr)+'</div><div class="bb-grid">'}
            var ids=bunkAsgn[bk.name]||[];
            h+='<div class="bb-bunk" ondragover="event.preventDefault();this.classList.add(\'dragover\')" ondragleave="this.classList.remove(\'dragover\')" ondrop="CampistryMe.bbDrop(\''+je(bk.name)+'\',event);this.classList.remove(\'dragover\')">';
            h+='<div class="bb-bunk-hd"><span class="bb-bunk-nm">'+esc(bk.name)+'</span><span class="bb-bunk-ct">'+ids.length+'</span></div>';
            h+='<div class="bb-campers">';
            if(!ids.length)h+='<div class="bb-empty">Drop campers here</div>';
            else ids.forEach(function(n){h+=bbC(n)});
            h+='</div></div>';
        });
        if(lastD)h+='</div>';
        h+='</div></div>';
    }
    c.innerHTML=h;
}
function bbC(n){var d=roster[n]||{};return'<div class="bb-c" draggable="true" ondragstart="event.dataTransfer.setData(\'text/plain\',\''+je(n)+'\')"><div style="flex:1;min-width:0"><div class="bb-c-nm">'+esc(n)+'</div></div>'+(d.allergies||d.medications?'<span style="color:var(--err);font-size:.6rem">⚠</span>':'')+'</div>'}
function bbDrop(t,e){e.preventDefault();var n=e.dataTransfer.getData('text/plain');if(!n)return;Object.keys(bunkAsgn).forEach(function(b){bunkAsgn[b]=bunkAsgn[b].filter(function(x){return x!==n})});if(t!=='__pool__'){if(!bunkAsgn[t])bunkAsgn[t]=[];bunkAsgn[t].push(n)}save();renderBB()}
function autoAssign(){var allB=[];Object.entries(structure).forEach(function([div,d]){Object.entries(d.grades||{}).forEach(function([gr,g]){(g.bunks||[]).forEach(function(b){allB.push({name:b,gr:gr,div:div})})})});var next={};allB.forEach(function(b){next[b.name]=[]});var campers=Object.entries(roster);campers.sort(function(a,b){return(a[1].grade||'').localeCompare(b[1].grade||'')});campers.forEach(function([n,d]){var el=allB.filter(function(b){return b.gr===d.grade});if(!el.length)el=allB.filter(function(b){return b.div===d.division});if(!el.length)el=allB;if(!el.length)return;el.sort(function(a,b){return next[a.name].length-next[b.name].length});next[el[0].name].push(n)});bunkAsgn=next;save();renderBB();toast('Auto-assigned')}
function clearBunks(){if(!confirm('Clear all?'))return;bunkAsgn={};save();renderBB();toast('Cleared')}

// ── REGISTRATION & ENROLLMENT ─────────────────────────────────────
function renderEnrollment(){
    var c=document.getElementById('page-enrollment');
    var eArr=Object.entries(enrollments);
    var total=eArr.length;
    var byStatus={applied:0,accepted:0,waitlisted:0,enrolled:0,declined:0,withdrawn:0};
    eArr.forEach(function([,e]){byStatus[e.status]=(byStatus[e.status]||0)+1});
    var enrolled=byStatus.enrolled||0,accepted=byStatus.accepted||0,applied=byStatus.applied||0,waitlisted=byStatus.waitlisted||0;

    var h='<div class="sec-hd"><div><h2 class="sec-title">Registration & Enrollment</h2><p class="sec-desc">'+total+' application'+(total!==1?'s':'')+' · '+enrolled+' enrolled · '+waitlisted+' waitlisted</p></div>';
    h+='<div class="sec-actions"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.copyRegLink()">🔗 Copy Registration Link</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.addSession()">+ Add Session</button><button class="me-btn me-btn--pri" onclick="CampistryMe.addApplication()">+ Manual Entry</button></div></div>';

    // Registration link banner
    h+='<div style="background:#fff;border:1px solid var(--s200);border-radius:var(--r);padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
    h+='<div style="flex:1;min-width:200px"><div style="font-size:.8rem;font-weight:600;color:var(--s500)">PARENT REGISTRATION LINK</div>';
    h+='<div style="font-size:.85rem;color:var(--me);font-weight:600;word-break:break-all;margin-top:2px">'+esc(window.location.origin+'/campistry_register.html')+'</div></div>';
    h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.copyRegLink()">Copy Link</button>';
    h+='<a href="campistry_register.html" target="_blank" class="me-btn me-btn--sec me-btn--sm" style="text-decoration:none">Preview Form</a>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openFormConfig()">⚙ Customize Form</button></div>';

    // Pipeline stats
    h+='<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">';
    var stages=[{label:'Applied',count:applied,color:'var(--s500)'},{label:'Accepted',count:accepted,color:'#3B82F6'},{label:'Waitlisted',count:waitlisted,color:'var(--me)'},{label:'Enrolled',count:enrolled,color:'var(--ok)'},{label:'Declined',count:byStatus.declined||0,color:'var(--err)'},{label:'Withdrawn',count:byStatus.withdrawn||0,color:'var(--s400)'}];
    stages.forEach(function(s){
        h+='<div style="flex:1;min-width:90px;background:#fff;border-radius:var(--r);padding:10px 12px;border:1px solid var(--s200);text-align:center">';
        h+='<div style="font-size:1.2rem;font-weight:700;color:'+s.color+'">'+s.count+'</div>';
        h+='<div style="font-size:.65rem;font-weight:600;color:var(--s400);text-transform:uppercase;letter-spacing:.05em">'+s.label+'</div></div>';
    });
    h+='</div>';

    // Sessions
    if(sessions.length){
        h+='<div class="me-card" style="margin-bottom:14px"><div class="me-card-head"><h3>Sessions & Pricing</h3><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.addSession()">+ Add</button></div>';
        h+='<div style="padding:12px 18px;display:flex;flex-wrap:wrap;gap:8px">';
        sessions.forEach(function(s,i){
            var sEnrolled=eArr.filter(function([,e]){return e.session===s.name&&e.status==='enrolled'}).length;
            var sApplied=eArr.filter(function([,e]){return e.session===s.name}).length;
            var cap=s.capacity||'∞';
            var pct=s.capacity?Math.min(sEnrolled/s.capacity,1):0;
            var isOpen=s.registrationOpen!==false;
            h+='<div style="flex:1;min-width:200px;padding:14px;border-radius:var(--r);border:1px solid '+(isOpen?'var(--s200)':'var(--err)')+';background:'+(isOpen?'var(--s50)':'rgba(239,68,68,.03)')+'">';
            h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
            h+='<span style="font-size:.9rem;font-weight:700;color:var(--s800)">'+esc(s.name)+'</span>';
            h+='<div style="display:flex;gap:3px">';
            h+='<button class="me-btn me-btn--ghost" style="font-size:.65rem;padding:2px 5px" onclick="CampistryMe.editSession('+i+')" title="Edit">Edit</button>';
            h+='<button class="me-btn me-btn--ghost" style="font-size:.65rem;padding:2px 5px;color:'+(isOpen?'var(--err)':'var(--ok)')+'" onclick="CampistryMe.toggleSessionReg('+i+')" title="'+(isOpen?'Close':'Open')+' registration">'+(isOpen?'Close':'Open')+'</button>';
            h+='<button class="me-btn me-btn--ghost" style="font-size:.65rem;padding:2px 5px;color:var(--err)" onclick="CampistryMe.deleteSession('+i+')">✕</button>';
            h+='</div></div>';
            if(s.dates)h+='<div style="font-size:.75rem;color:var(--s500);margin-bottom:4px">📅 '+esc(s.dates)+'</div>';
            h+='<div style="font-size:.75rem;color:var(--s500)">'+sApplied+' applied · '+sEnrolled+' / '+cap+' enrolled</div>';
            if(s.capacity){h+='<div style="height:3px;border-radius:2px;background:var(--s200);margin-top:4px;overflow:hidden"><div style="height:100%;width:'+(pct*100)+'%;background:'+(pct>=0.9?'var(--err)':pct>=0.7?'var(--me)':'var(--ok)')+';border-radius:2px"></div></div>'}
            if(s.tuition)h+='<div style="font-size:.85rem;font-weight:700;color:var(--me);margin-top:6px">$'+Number(s.tuition).toLocaleString()+'</div>';
            if(s.earlyBird){
                var today=new Date().toISOString().split('T')[0];
                var isActive=!s.earlyBirdDeadline||today<=s.earlyBirdDeadline;
                h+='<div style="font-size:.72rem;color:'+(isActive?'var(--ok)':'var(--s400)')+';font-weight:600;margin-top:2px">Early bird: $'+Number(s.earlyBird).toLocaleString()+(s.earlyBirdDeadline?' (until '+s.earlyBirdDeadline+')':'')+(isActive?'':' — expired')+'</div>';
            }
            h+='<div style="margin-top:6px">'+(!isOpen?'<span style="font-size:.7rem;font-weight:700;color:var(--err)">Registration Closed</span>':'<span style="font-size:.7rem;font-weight:700;color:var(--ok)">Registration Open</span>')+'</div>';
            h+='</div>';
        });
        h+='</div></div>';
    }

    // Applications table
    if(!eArr.length){
        h+='<div class="me-empty"><h3>No applications yet</h3><p>Create a session and start accepting applications.</p></div>';
    }else{
        h+='<div class="me-card"><div class="me-card-head"><h3>All Applications</h3></div>';
        h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Camper</th><th>Parent</th><th>Session</th><th>Status</th><th>Forms</th><th>Payment</th><th style="width:100px"></th></tr></thead><tbody>';
        eArr.sort(function(a,b){return(b[1].appliedDate||'').localeCompare(a[1].appliedDate||'')}).forEach(function([id,e]){
            var sc=e.status==='enrolled'?'ok':e.status==='accepted'?'ok':e.status==='waitlisted'?'warn':e.status==='declined'||e.status==='withdrawn'?'err':'gray';
            var formsDone=e.formsCompleted||0,formsTotal=e.formsRequired||0;
            var formsColor=formsTotal===0?'var(--s400)':formsDone>=formsTotal?'var(--ok)':'var(--me)';
            var payColor=e.paymentStatus==='paid'?'var(--ok)':e.paymentStatus==='partial'?'var(--me)':'var(--s400)';
            h+='<tr class="click" onclick="CampistryMe.viewApplication(\''+esc(id)+'\')">';
            h+='<td style="font-size:.75rem;color:var(--s400)">'+esc(e.appliedDate||'—')+'</td>';
            h+='<td class="bold" style="color:var(--me)">'+esc(e.camperName||'—')+'</td>';
            h+='<td>'+esc(e.parentName||'—')+'</td>';
            h+='<td>'+esc(e.session||'—')+'</td>';
            h+='<td>'+bdg(e.status||'applied',sc)+'</td>';
            h+='<td><span style="font-size:.75rem;font-weight:600;color:'+formsColor+'">'+formsDone+'/'+formsTotal+'</span></td>';
            h+='<td><span style="font-size:.75rem;font-weight:600;color:'+payColor+'">'+esc(e.paymentStatus||'pending')+'</span></td>';
            h+='<td style="text-align:right" onclick="event.stopPropagation()"><div style="display:flex;gap:3px;justify-content:flex-end">';
            h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.viewApplication(\''+esc(id)+'\')">Review</button>';
            // Status change buttons
            if(e.status==='applied'){
                h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'accepted\')">Accept</button>';
            }else if(e.status==='accepted'){
                h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.enrollCamper(\''+esc(id)+'\')">Enroll</button>';
            }else if(e.status==='waitlisted'){
                h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'accepted\')">Accept</button>';
            }
            h+='</div></td></tr>';
        });
        h+='</tbody></table></div></div>';
    }
    c.innerHTML=h;
}

// ── FORM CUSTOMIZER ───────────────────────────────────────────
var FC_SECTIONS=[
    {key:'camper',label:'Camper Information',desc:'Name, DOB, gender, school, grade, teacher',default:true,required:true},
    {key:'parent',label:'Parent / Guardian',desc:'Name, phone, email, second parent',default:true,required:true},
    {key:'address',label:'Home Address',desc:'Street, city, state, ZIP',default:true,required:false},
    {key:'emergency',label:'Emergency Contact',desc:'Name, relationship, phone',default:true,required:false},
    {key:'medical',label:'Medical Information',desc:'Allergies, medications, dietary, notes',default:true,required:false},
    {key:'preferences',label:'Preferences',desc:'Bunkmate request, separation, t-shirt, referral source',default:true,required:false},
    {key:'documents',label:'Document Uploads',desc:'Immunization records, health forms, insurance',default:true,required:false},
    {key:'payment',label:'Payment Preference',desc:'Payment method selection and promo codes',default:true,required:false},
    {key:'signature',label:'E-Signature & Agreement',desc:'Waivers, checkboxes, signature capture',default:true,required:true},
    {key:'siblings',label:'Sibling Registration',desc:'Allow adding multiple campers in one form',default:true,required:false}
];

function getFormConfig(){
    if(formConfig)return formConfig;
    // Default config
    var sections={};
    FC_SECTIONS.forEach(function(s){sections[s.key]={enabled:s.default}});
    return{sections:sections,customQuestions:[],welcomeMessage:'',instructions:''};
}

function openFormConfig(){
    var fc=getFormConfig();
    var h='';

    h+='<div style="margin-bottom:16px"><div class="fsec" style="margin-bottom:6px">Form Branding</div>';
    h+='<div class="fg"><label class="fl">Welcome Message</label><input class="fi" id="fcWelcome" value="'+esc(fc.welcomeMessage||'')+'" placeholder="e.g., Welcome to Camp Sunrise!"></div>';
    h+='<div class="fg"><label class="fl">Instructions for Parents</label><textarea class="fi" id="fcInstructions" style="min-height:50px;resize:vertical" placeholder="Any special instructions shown at the top of the form">'+(fc.instructions||'')+'</textarea></div></div>';

    h+='<div class="fsec" style="margin-bottom:6px">Sections</div>';
    h+='<p style="font-size:.78rem;color:var(--s400);margin-bottom:10px">Toggle which sections appear on the parent registration form. Required sections cannot be disabled.</p>';
    FC_SECTIONS.forEach(function(s){
        var enabled=fc.sections&&fc.sections[s.key]?fc.sections[s.key].enabled:s.default;
        var disabled=s.required?' disabled':'';
        h+='<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--s200);border-radius:var(--r);margin-bottom:4px;cursor:'+(s.required?'default':'pointer')+';background:'+(enabled?'rgba(217,119,6,.03)':'var(--s50)')+'">';
        h+='<input type="checkbox" class="fcSec" data-key="'+s.key+'" '+(enabled?'checked':'')+disabled+' style="accent-color:var(--me);flex-shrink:0">';
        h+='<div style="flex:1"><div style="font-size:.85rem;font-weight:600;color:var(--s800)">'+esc(s.label)+(s.required?' <span style="font-size:.65rem;color:var(--s400)">(required)</span>':'')+'</div>';
        h+='<div style="font-size:.72rem;color:var(--s400)">'+esc(s.desc)+'</div></div></label>';
    });

    h+='<div class="fsec" style="margin:16px 0 6px">Custom Questions</div>';
    h+='<p style="font-size:.78rem;color:var(--s400);margin-bottom:10px">Add your own questions. These appear in a "Additional Information" section on the form.</p>';
    h+='<div id="fcQList">';
    (fc.customQuestions||[]).forEach(function(q,i){
        h+=renderCustomQ(q,i);
    });
    h+='</div>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addCustomQ()">+ Add Question</button>';

    // Promo codes
    h+='<div class="fsec" style="margin:16px 0 6px">Promo / Discount Codes</div>';
    h+='<p style="font-size:.78rem;color:var(--s400);margin-bottom:10px">Configure discount codes parents can use during registration.</p>';
    h+='<div id="fcPromoList">';
    var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    var promos=g.campistryMe?.promoCodes||{EARLYBIRD:{pct:10,label:'Early Bird 10% Off'},SIBLING:{pct:5,label:'Sibling Discount 5%'},REFER:{amt:50,label:'Referral $50 Off'}};
    Object.entries(promos).forEach(function([code,p],i){
        h+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:6px 10px;border:1px solid var(--s200);border-radius:var(--r)">';
        h+='<input class="fi fcPromoCode" style="flex:0 0 120px;font-size:.8rem;padding:5px 8px" value="'+esc(code)+'">';
        h+='<input class="fi fcPromoLabel" style="flex:1;font-size:.8rem;padding:5px 8px" value="'+esc(p.label||'')+'" placeholder="Label">';
        h+='<input class="fi fcPromoPct" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" value="'+(p.pct||'')+'" placeholder="% off">';
        h+='<input class="fi fcPromoAmt" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" value="'+(p.amt||'')+'" placeholder="$ off">';
        h+='<button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'div\').remove()">✕</button></div>';
    });
    h+='</div>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:4px" onclick="CampistryMe.addPromoRow()">+ Add Code</button>';

    document.getElementById('fcBody').innerHTML=h;
    openModal('formConfigModal');
}

function renderCustomQ(q,i){
    var types={'text':'Short Text','textarea':'Long Text','select':'Dropdown','checkbox':'Checkboxes','yesno':'Yes/No'};
    var needsOpts=q.type==='select'||q.type==='checkbox';
    var h='<div class="fcQ" style="border:1px solid var(--s200);border-radius:var(--r);padding:10px 12px;margin-bottom:6px;background:var(--s50)">';
    h+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">';
    h+='<input class="fi fcQLabel" style="flex:1;font-size:.82rem;padding:5px 8px" value="'+esc(q.label||'')+'" placeholder="Question text">';
    h+='<select class="fs fcQType" style="flex:0 0 110px;font-size:.78rem;padding:5px 6px" onchange="var o=this.closest(\'.fcQ\').querySelector(\'.fcQOpts\');o.style.display=(this.value===\'select\'||this.value===\'checkbox\')?\'block\':\'none\'">';
    Object.entries(types).forEach(function([k,v]){h+='<option value="'+k+'"'+(q.type===k?' selected':'')+'>'+v+'</option>'});
    h+='</select>';
    h+='<label style="display:flex;align-items:center;gap:3px;font-size:.72rem;color:var(--s500);white-space:nowrap"><input type="checkbox" class="fcQReq"'+(q.required?' checked':'')+' style="accent-color:var(--me)">Req</label>';
    h+='<button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'.fcQ\').remove()">✕</button></div>';
    h+='<input class="fi fcQOpts" style="font-size:.78rem;padding:4px 8px;'+(needsOpts?'':'display:none')+'" value="'+esc((q.options||[]).join(', '))+'" placeholder="Options (comma-separated, e.g. Option A, Option B, Option C)">';
    h+='</div>';
    return h;
}

function addCustomQ(){
    var list=document.getElementById('fcQList');
    var div=document.createElement('div');
    div.innerHTML=renderCustomQ({label:'',type:'text',required:false,options:[]},-1);
    list.appendChild(div.firstChild);
}

function addPromoRow(){
    var list=document.getElementById('fcPromoList');
    var div=document.createElement('div');
    div.innerHTML='<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:6px 10px;border:1px solid var(--s200);border-radius:var(--r)"><input class="fi fcPromoCode" style="flex:0 0 120px;font-size:.8rem;padding:5px 8px" placeholder="CODE"><input class="fi fcPromoLabel" style="flex:1;font-size:.8rem;padding:5px 8px" placeholder="Label"><input class="fi fcPromoPct" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" placeholder="% off"><input class="fi fcPromoAmt" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" placeholder="$ off"><button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'div\').remove()">✕</button></div>';
    list.appendChild(div.firstChild);
}

function saveFormConfig(){
    // Read sections
    var sections={};
    document.querySelectorAll('.fcSec').forEach(function(cb){sections[cb.dataset.key]={enabled:cb.checked}});

    // Read custom questions
    var customQuestions=[];
    document.querySelectorAll('.fcQ').forEach(function(el){
        var label=el.querySelector('.fcQLabel')?.value?.trim();
        var type=el.querySelector('.fcQType')?.value||'text';
        var required=el.querySelector('.fcQReq')?.checked||false;
        var optsRaw=el.querySelector('.fcQOpts')?.value||'';
        var options=optsRaw?optsRaw.split(',').map(function(o){return o.trim()}).filter(Boolean):[];
        if(label)customQuestions.push({label:label,type:type,required:required,options:options});
    });

    // Read promo codes
    var promos={};
    var codes=document.querySelectorAll('.fcPromoCode');
    var labels=document.querySelectorAll('.fcPromoLabel');
    var pcts=document.querySelectorAll('.fcPromoPct');
    var amts=document.querySelectorAll('.fcPromoAmt');
    for(var i=0;i<codes.length;i++){
        var code=(codes[i].value||'').trim().toUpperCase();
        if(!code)continue;
        promos[code]={label:(labels[i]?.value||'').trim(),pct:parseFloat(pcts[i]?.value)||0,amt:parseFloat(amts[i]?.value)||0};
    }

    formConfig={
        sections:sections,
        customQuestions:customQuestions,
        welcomeMessage:(document.getElementById('fcWelcome')?.value||'').trim(),
        instructions:(document.getElementById('fcInstructions')?.value||'').trim()
    };

    // Store promoCodes in enrollSettings so it persists through the main save() path
    enrollSettings.promoCodes=promos;

    // Use the main save() which handles localStorage + cloud sync
    save();
    closeModal('formConfigModal');toast('Form configuration saved');
}

// Empty stubs for pages that will be filled by the rest of the code below
function renderSoon(p){var c=document.getElementById('page-'+p);if(c)c.innerHTML='<div class="me-soon"><h2>Coming Soon</h2><p>'+esc(p)+' is being built.</p></div>'}

// The remaining renderer, billing, broadcast, forms, reports, settings, finance,
// Stripe, sessions, applications, custom fields, docs, scholarships and
// duplicate-detection logic is assembled in the bottom half of the file.
// See window.CampistryMe export at end for the full public surface.

// ═══════════════════════════════════════════════════════════════
// REMAINDER OF ENGINE (sessions, applications, billing, broadcasts,
// forms, reports, settings, finance, Stripe, custom fields, docs,
// scholarships, duplicate detection, CSV, etc.)
// ═══════════════════════════════════════════════════════════════

// View full application (review modal)
function viewApplication(id){
    var e=enrollments[id];if(!e)return;
    var sc=e.status==='enrolled'?'ok':e.status==='accepted'?'ok':e.status==='waitlisted'?'warn':e.status==='declined'||e.status==='withdrawn'?'err':'gray';

    var head='<div style="display:flex;justify-content:space-between;align-items:flex-start"><div><h3 style="font-size:1.1rem;font-weight:700;color:var(--s800);margin:0">'+esc(e.camperName||'Application')+'</h3><div style="display:flex;gap:5px;margin-top:5px">'+bdg(e.status||'applied',sc)+' '+bdg(e.session||'No session','gray')+'</div></div><button class="me-modal-x" onclick="CampistryMe.closeModal(\'appViewModal\')">&times;</button></div>';
    document.getElementById('avHead').innerHTML=head;

    var b='';
    function sec(title){return'<div style="font-size:.75rem;font-weight:700;color:var(--me);text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px;padding-bottom:3px;border-bottom:1px solid var(--s100)">'+title+'</div>'}
    function row(l,v){if(!v)return'';return'<div style="display:flex;gap:8px;padding:2px 0;font-size:.82rem"><span style="color:var(--s400);min-width:100px;flex-shrink:0">'+esc(l)+'</span><span style="color:var(--s800);font-weight:500">'+v+'</span></div>'}

    b+=sec('Application');
    b+=row('Applied',e.appliedDate||'—');
    b+=row('Application ID',id);
    b+=row('Status',e.status);
    b+=row('Source',e.source);

    b+=sec('Camper');
    b+=row('Name',esc(e.camperName));
    b+=row('Date of Birth',e.dob);
    b+=row('Gender',e.gender);
    b+=row('School',e.school);
    b+=row('School Grade',e.schoolGrade);
    b+=row('Teacher',e.teacher);

    b+=sec('Parent / Guardian');
    b+=row('Name',esc(e.parentName)+(e.parentRelation?' ('+esc(e.parentRelation)+')':''));
    if(e.parentPhone)b+=row('Phone','<a href="tel:'+esc(e.parentPhone)+'" style="color:var(--me);font-weight:600">'+esc(e.parentPhone)+'</a>');
    if(e.parentEmail)b+=row('Email','<a href="mailto:'+esc(e.parentEmail)+'" style="color:var(--me)">'+esc(e.parentEmail)+'</a>');
    if(e.parent2Name)b+=row('Parent 2',esc(e.parent2Name)+(e.parent2Phone?' — '+esc(e.parent2Phone):''));

    b+=sec('Address');
    b+=row('Street',e.street);
    b+=row('City',e.city);
    b+=row('State',e.state);
    b+=row('ZIP',e.zip);
    if(e.street){var fullAddr=[e.street,e.city,e.state,e.zip].filter(Boolean).join(', ');b+='<a href="https://maps.google.com/?q='+encodeURIComponent(fullAddr)+'" target="_blank" style="display:inline-block;font-size:.75rem;font-weight:600;color:var(--me);margin-top:3px;text-decoration:none">Open in Maps →</a>'}

    b+=sec('Emergency Contact');
    b+=row('Name',esc(e.emergencyName)+(e.emergencyRel?' ('+esc(e.emergencyRel)+')':''));
    if(e.emergencyPhone)b+=row('Phone','<a href="tel:'+esc(e.emergencyPhone)+'" style="color:var(--me);font-weight:600">'+esc(e.emergencyPhone)+'</a>');

    b+=sec('Medical');
    if(e.allergies)b+=row('Allergies','<span style="color:var(--err);font-weight:600">'+esc(e.allergies)+'</span>');
    if(e.medications)b+=row('Medications','<span style="color:var(--err);font-weight:600">'+esc(e.medications)+'</span>');
    b+=row('Dietary',e.dietary);
    if(e.medicalNotes)b+=row('Notes',e.medicalNotes);
    if(!e.allergies&&!e.medications&&!e.dietary&&!e.medicalNotes)b+='<div style="font-size:.82rem;color:var(--ok);padding:2px 0">✓ No medical flags reported</div>';

    b+=sec('Preferences');
    b+=row('Bunkmate Request',e.bunkmate);
    b+=row('Separation Request',e.separateFrom);
    b+=row('T-Shirt Size',e.tshirtSize);
    b+=row('Additional Notes',e.notes);

    if(e.customAnswers&&Object.keys(e.customAnswers).length){
        b+=sec('Custom Responses');
        var labels=e.customQuestionLabels||[];
        Object.entries(e.customAnswers).forEach(function([key,val]){
            var idx=parseInt(key.replace('q',''));
            var label=labels[idx]||('Question '+(idx+1));
            var display=Array.isArray(val)?val.join(', '):val;
            b+=row(label,esc(display));
        });
    }

    b+=sec('Payment');
    b+=row('Session',e.session);
    b+=row('Tuition',e.sessionTuition?fm(e.sessionTuition):'—');
    b+=row('Payment Method',e.paymentMethod||'Not selected');
    b+=row('Payment Status',e.paymentStatus||'pending');
    if(e.discount&&e.discount.active!==false&&e.discount.code)b+=row('Discount',esc(e.discount.label)+' ('+esc(e.discount.code)+')');

    if(e.documents&&e.documents.length){
        b+=sec('Uploaded Documents');
        e.documents.forEach(function(doc){
            var sz=doc.size<1024?doc.size+'B':doc.size<1048576?Math.round(doc.size/1024)+'KB':Math.round(doc.size/1048576*10)/10+'MB';
            b+='<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.8rem"><span>📄</span><strong style="color:var(--s700)">'+esc(doc.name)+'</strong><span style="color:var(--s400);font-size:.72rem">'+sz+'</span>';
            if(doc.data)b+=' <a href="'+doc.data+'" download="'+esc(doc.name)+'" style="color:var(--me);font-size:.72rem;font-weight:600">Download</a>';
            b+='</div>';
        });
    }

    if(e.signature){
        b+=sec('Signature');
        b+='<img src="'+e.signature+'" style="max-width:300px;height:80px;border:1px solid var(--s200);border-radius:var(--r);object-fit:contain;background:#fff">';
    }

    if(e.siblingGroup){
        b+=sec('Sibling Group');
        var sibApps=Object.entries(enrollments).filter(function([,x]){return x.siblingGroup===e.siblingGroup||x.siblingGroup===id});
        if(sibApps.length>1){
            sibApps.forEach(function([sid,s]){
                if(sid!==id)b+=row('Sibling',esc(s.camperName)+' — '+s.status);
            });
        }
    }

    b+=sec('Internal Notes');
    b+='<textarea id="avNotes" style="width:100%;padding:8px 10px;border:1.5px solid var(--s200);border-radius:var(--r);font-size:.82rem;font-family:var(--font);min-height:60px;resize:vertical;outline:none" placeholder="Add internal notes (only visible to admin)...">'+(e.adminNotes?esc(e.adminNotes):'')+'</textarea>';
    b+='<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.saveAppNote(\''+esc(id)+'\')">Save Notes</button>';

    document.getElementById('avBody').innerHTML=b;

    var f='<button class="me-btn me-btn--sec" onclick="CampistryMe.printApplication(\''+esc(id)+'\')" style="margin-right:auto">🖨 Print</button>';
    if(e.status==='applied'){
        f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'accepted\');CampistryMe.closeModal(\'appViewModal\')">Accept</button>';
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'waitlisted\');CampistryMe.closeModal(\'appViewModal\')">Waitlist</button>';
        f+='<button class="me-btn me-btn--danger" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'declined\');CampistryMe.closeModal(\'appViewModal\')">Decline</button>';
    }else if(e.status==='accepted'){
        f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.enrollCamper(\''+esc(id)+'\');CampistryMe.closeModal(\'appViewModal\')">Enroll Now</button>';
        f+='<button class="me-btn me-btn--danger" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'declined\');CampistryMe.closeModal(\'appViewModal\')">Decline</button>';
    }else if(e.status==='waitlisted'){
        f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'accepted\');CampistryMe.closeModal(\'appViewModal\')">Accept</button>';
        f+='<button class="me-btn me-btn--danger" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'declined\');CampistryMe.closeModal(\'appViewModal\')">Decline</button>';
    }else if(e.status==='enrolled'){
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'withdrawn\');CampistryMe.closeModal(\'appViewModal\')">Withdraw</button>';
    }
    f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.closeModal(\'appViewModal\')">Close</button>';
    document.getElementById('avFooter').innerHTML=f;

    openModal('appViewModal');
}

function saveAppNote(id){
    var note=(document.getElementById('avNotes')?.value||'').trim();
    if(enrollments[id]){enrollments[id].adminNotes=note;save();toast('Notes saved')}
}

function printApplication(id){
    var e=enrollments[id];if(!e)return;
    var w=window.open('','_blank','width=800,height=900');
    var h='<html><head><title>Application — '+e.camperName+'</title><style>body{font-family:Arial,sans-serif;padding:30px;font-size:13px;color:#1E293B}h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;color:#D97706;text-transform:uppercase;margin:16px 0 6px;border-bottom:1px solid #E2E8F0;padding-bottom:3px}table{width:100%;border-collapse:collapse}td{padding:3px 0;vertical-align:top}td:first-child{width:120px;color:#64748B;font-weight:600}.med{color:#EF4444;font-weight:600}.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}img{max-width:250px;height:70px;object-fit:contain;border:1px solid #E2E8F0;border-radius:4px}@media print{body{padding:15px}}</style></head><body>';
    h+='<h1>'+esc(e.camperName)+'</h1>';
    h+='<div style="color:#64748B;font-size:12px;margin-bottom:12px">Application ID: '+esc(id)+' · Status: '+e.status+' · Applied: '+e.appliedDate+'</div>';
    h+='</body></html>';
    w.document.write(h);w.document.close();
    setTimeout(function(){w.print()},300);
}

function addSession(){openSessionModal(null)}
function editSession(idx){openSessionModal(idx)}

function openSessionModal(idx){
    var s=idx!==null?sessions[idx]:{};
    var h='<div class="me-modal-form">';
    h+='<div class="me-field"><label>Session Name</label><input type="text" id="sesName" class="me-input" value="'+esc(s.name||'')+'" placeholder="e.g., Summer 2026 — Full Season"></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Start Date</label><input type="date" id="sesStart" class="me-input" value="'+(s.startDate||'')+'"></div>';
    h+='<div class="me-field"><label>End Date</label><input type="date" id="sesEnd" class="me-input" value="'+(s.endDate||'')+'"></div>';
    h+='</div>';
    h+='<div class="me-field"><label>Date Range Label (optional)</label><input type="text" id="sesDates" class="me-input" value="'+esc(s.dates||'')+'" placeholder="e.g., June 22 – August 14"></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Capacity</label><input type="number" id="sesCap" class="me-input" value="'+(s.capacity||'')+'" placeholder="Leave blank for unlimited" min="0"></div>';
    h+='<div class="me-field"><label>Tuition ($)</label><input type="number" id="sesTuition" class="me-input" value="'+(s.tuition||'')+'" placeholder="0.00" step="0.01" min="0"></div>';
    h+='</div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Early Bird Price ($)</label><input type="number" id="sesEarly" class="me-input" value="'+(s.earlyBird||'')+'" placeholder="Optional" step="0.01" min="0"></div>';
    h+='<div class="me-field"><label>Early Bird Deadline</label><input type="date" id="sesEarlyDate" class="me-input" value="'+(s.earlyBirdDeadline||'')+'"></div>';
    h+='</div>';
    h+='<div class="me-field"><label>Sibling Discount (%)</label><input type="number" id="sesSibDisc" class="me-input" value="'+(s.siblingDiscount||'')+'" placeholder="e.g., 10 for 10% off siblings" min="0" max="100"></div>';
    h+='<div class="me-field"><label>Payment Plan</label><select id="sesPayPlan" class="me-input"><option value="full"'+(s.paymentPlan==='full'?' selected':'')+'>Full payment required</option><option value="2"'+(s.paymentPlan==='2'?' selected':'')+'>2 installments (50/50)</option><option value="3"'+(s.paymentPlan==='3'?' selected':'')+'>3 installments (34/33/33)</option><option value="4"'+(s.paymentPlan==='4'?' selected':'')+'>4 installments (25 each)</option><option value="deposit"'+(s.paymentPlan==='deposit'?' selected':'')+'>Deposit + balance</option></select></div>';
    h+='<div id="sesDepositWrap" style="display:'+(s.paymentPlan==='deposit'?'block':'none')+'"><div class="me-field"><label>Deposit Amount ($)</label><input type="number" id="sesDeposit" class="me-input" value="'+(s.depositAmount||'')+'" step="0.01" min="0"></div></div>';
    h+='<div class="me-field"><label>Description / Notes</label><textarea id="sesNotes" class="me-input" rows="2" style="resize:vertical" placeholder="Optional session description for parents">'+(s.notes||'')+'</textarea></div>';
    h+='</div>';
    h+='<script>document.getElementById("sesPayPlan").onchange=function(){document.getElementById("sesDepositWrap").style.display=this.value==="deposit"?"block":"none"}<\/script>';

    showModal(idx!==null?'Edit Session':'Create Session',h,function(){
        var obj={
            name:(document.getElementById('sesName').value||'').trim(),
            startDate:document.getElementById('sesStart').value||'',
            endDate:document.getElementById('sesEnd').value||'',
            dates:(document.getElementById('sesDates').value||'').trim(),
            capacity:parseInt(document.getElementById('sesCap').value)||0,
            tuition:parseFloat(document.getElementById('sesTuition').value)||0,
            earlyBird:parseFloat(document.getElementById('sesEarly').value)||0,
            earlyBirdDeadline:document.getElementById('sesEarlyDate').value||'',
            siblingDiscount:parseInt(document.getElementById('sesSibDisc').value)||0,
            paymentPlan:document.getElementById('sesPayPlan').value||'full',
            depositAmount:parseFloat(document.getElementById('sesDeposit').value)||0,
            notes:(document.getElementById('sesNotes').value||'').trim(),
            registrationOpen:idx!==null?(sessions[idx].registrationOpen!==false):true
        };
        if(!obj.name){alert('Enter a session name');return}
        if(!obj.dates&&obj.startDate&&obj.endDate){
            obj.dates=new Date(obj.startDate+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric'})+' – '+new Date(obj.endDate+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
        }
        if(idx!==null) sessions[idx]=obj;
        else sessions.push(obj);
        save();closeModal('dynModal');renderEnrollment();toast(idx!==null?'Session updated':'Session created');
    });
}

function toggleSessionReg(idx){
    sessions[idx].registrationOpen=!sessions[idx].registrationOpen;
    save();renderEnrollment();
    toast(sessions[idx].registrationOpen?'Registration opened':'Registration closed');
}

function copyRegLink(){
    var url=window.location.origin+'/campistry_register.html';
    if(navigator.clipboard){
        navigator.clipboard.writeText(url).then(function(){toast('Registration link copied!')});
    }else{
        prompt('Copy this link and share with parents:',url);
    }
}

function deleteSession(idx){
    if(!confirm('Delete session "'+sessions[idx].name+'"?'))return;
    sessions.splice(idx,1);save();renderEnrollment();toast('Session deleted');
}

function addApplication(){
    // Simple manual entry — parity with old behavior
    var first=prompt('Camper first name:');if(!first)return;
    var last=prompt('Last name:');if(!last)return;
    var parent=prompt('Parent name:')||'';
    var phone=prompt('Phone:')||'';
    var email=prompt('Email:')||'';
    var session=sessions.length?sessions[0].name:'';
    var sesObj=sessions.find(function(s){return s.name===session});
    var id='enr_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
    enrollments[id]={
        camperName:(first+' '+last).trim(),camperLast:last,
        parentName:parent,parentPhone:phone,parentEmail:email,
        session:session,sessionTuition:sesObj?sesObj.tuition:0,
        status:'applied',appliedDate:new Date().toISOString().split('T')[0],
        formsRequired:3,formsCompleted:0,paymentStatus:'pending',notes:'Manual entry'
    };
    save();renderEnrollment();toast('Application added');
}

function updateEnrollStatus(id,status){
    if(!enrollments[id])return;
    var prev=enrollments[id].status;
    enrollments[id].status=status;
    enrollments[id].statusHistory=enrollments[id].statusHistory||[];
    enrollments[id].statusHistory.push({from:prev,to:status,date:new Date().toISOString(),by:'office'});
    if((status==='declined'||status==='withdrawn')&&prev!=='waitlisted'){
        var session=enrollments[id].session;
        if(session) autoPromoteWaitlist(session);
    }
    save();renderEnrollment();toast('Status updated to '+status);
}

function autoPromoteWaitlist(sessionName){
    var sesObj=sessions.find(function(s){return s.name===sessionName});
    if(!sesObj||!sesObj.capacity)return;
    var enrolled=Object.values(enrollments).filter(function(e){return e.session===sessionName&&(e.status==='enrolled'||e.status==='accepted')}).length;
    if(enrolled>=sesObj.capacity)return;
    var waitlisted=Object.entries(enrollments).filter(function([,e]){return e.session===sessionName&&e.status==='waitlisted'}).sort(function(a,b){return(a[1].appliedDate||'').localeCompare(b[1].appliedDate||'')});
    if(waitlisted.length){
        var wid=waitlisted[0][0],we=waitlisted[0][1];
        we.status='accepted';
        we.statusHistory=we.statusHistory||[];
        we.statusHistory.push({from:'waitlisted',to:'accepted',date:new Date().toISOString(),by:'auto-promote'});
        toast('Auto-promoted '+we.camperName+' from waitlist!');
    }
}

function enrollCamper(id){
    var e=enrollments[id];if(!e)return;
    e.status='enrolled';
    if(!roster[e.camperName]){
        var newId=nextCamperId;nextCamperId++;
        roster[e.camperName]={
            camperId:newId,
            dob:e.dob||'',gender:e.gender||'',
            school:e.school||'',schoolGrade:e.schoolGrade||'',teacher:e.teacher||'',
            division:'',grade:'',bunk:'',teams:{},team:'',
            street:e.street||'',city:e.city||'',state:e.state||'',zip:e.zip||'',
            parent1Name:e.parentName||'',parent1Phone:e.parentPhone||'',parent1Email:e.parentEmail||'',
            emergencyName:e.emergencyName||'',emergencyPhone:e.emergencyPhone||'',emergencyRel:e.emergencyRel||'',
            allergies:e.allergies||'',medications:e.medications||'',dietary:e.dietary||''
        };
        if(e.street)syncAddressToGo(e.camperName,roster[e.camperName]);
        toast('Enrolled — camper added to roster');
    }else{
        var c=roster[e.camperName];
        if(!c.dob&&e.dob)c.dob=e.dob;
        if(!c.gender&&e.gender)c.gender=e.gender;
        if(!c.school&&e.school)c.school=e.school;
        if(!c.parent1Name&&e.parentName){c.parent1Name=e.parentName;c.parent1Phone=e.parentPhone;c.parent1Email=e.parentEmail}
        if(!c.street&&e.street){c.street=e.street;c.city=e.city;c.state=e.state;c.zip=e.zip;syncAddressToGo(e.camperName,c)}
        if(!c.allergies&&e.allergies)c.allergies=e.allergies;
        if(!c.medications&&e.medications)c.medications=e.medications;
        toast('Enrolled — updated existing camper');
    }
    // Auto-create family
    var lastName=e.camperName.split(' ').pop();
    var famKey='fam_'+lastName.toLowerCase().replace(/[^a-z0-9]/g,'');
    var addr=[e.street,e.city,e.state,e.zip].filter(Boolean).join(', ');
    var sesObj=sessions.find(function(s){return s.name===e.session});
    var tuition=e.sessionTuition||(sesObj&&sesObj.tuition)||0;
    if(!families[famKey]&&e.parentName){
        var parents=[{name:e.parentName,phone:e.parentPhone||'',email:e.parentEmail||'',relation:e.parentRelation||'Parent'}];
        if(e.parent2Name)parents.push({name:e.parent2Name,phone:e.parent2Phone||'',relation:'Parent'});
        families[famKey]={
            name:lastName+' Family',
            households:[{label:'Primary',parents:parents,address:addr,billingContact:true}],
            camperIds:[e.camperName],
            balance:tuition,totalPaid:0,
            notes:'Enrolled via registration — '+e.session
        };
    }else if(families[famKey]){
        if(families[famKey].camperIds.indexOf(e.camperName)<0) families[famKey].camperIds.push(e.camperName);
        families[famKey].balance=(families[famKey].balance||0)+tuition;
    }
    e.enrolledDate=new Date().toISOString().split('T')[0];
    save();renderEnrollment();
}

// ── ANALYTICS (minimal placeholder — shows summary) ──
function renderAnalytics(){
    var c=document.getElementById('page-analytics');
    var totalRev=finPayments.reduce(function(s,p){return s+(p.amount||0)},0);
    var totalExp=finExpenses.reduce(function(s,e){return s+(e.amount||0)},0);
    var totalPay=finStaff.reduce(function(s,st){return s+(st.salary||0)},0);
    var h='<div class="sec-hd"><div><h2 class="sec-title">Analytics & Finance</h2><p class="sec-desc">Financial summary</p></div></div>';
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">';
    h+='<div class="me-card" style="padding:16px"><div style="font-size:1.3rem;font-weight:800;color:var(--ok)">'+fm(totalRev)+'</div><div style="font-size:.72rem;color:var(--s400);text-transform:uppercase;font-weight:600">Revenue</div></div>';
    h+='<div class="me-card" style="padding:16px"><div style="font-size:1.3rem;font-weight:800;color:var(--err)">'+fm(totalExp)+'</div><div style="font-size:.72rem;color:var(--s400);text-transform:uppercase;font-weight:600">Expenses</div></div>';
    h+='<div class="me-card" style="padding:16px"><div style="font-size:1.3rem;font-weight:800;color:var(--teal)">'+fm(totalPay)+'</div><div style="font-size:.72rem;color:var(--s400);text-transform:uppercase;font-weight:600">Payroll</div></div>';
    h+='<div class="me-card" style="padding:16px"><div style="font-size:1.3rem;font-weight:800">'+fm(totalRev-totalExp-totalPay)+'</div><div style="font-size:.72rem;color:var(--s400);text-transform:uppercase;font-weight:600">Net</div></div>';
    h+='</div>';
    c.innerHTML=h;
}

// ── BILLING (minimal summary page) ──
function renderBilling(){
    var c=document.getElementById('page-billing');
    var totalBal=Object.values(families).reduce(function(s,f){return s+(f.balance||0)},0);
    var totalPaid=Object.values(families).reduce(function(s,f){return s+(f.totalPaid||0)},0);
    var h='<div class="sec-hd"><div><h2 class="sec-title">Billing & Payments</h2><p class="sec-desc">'+Object.keys(families).length+' account'+(Object.keys(families).length!==1?'s':'')+'</p></div></div>';
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:18px">';
    h+='<div class="me-card" style="padding:16px"><div style="font-size:1.3rem;font-weight:800;color:var(--err)">'+fm(totalBal)+'</div><div style="font-size:.72rem;color:var(--s400);text-transform:uppercase;font-weight:600">Outstanding</div></div>';
    h+='<div class="me-card" style="padding:16px"><div style="font-size:1.3rem;font-weight:800;color:var(--ok)">'+fm(totalPaid)+'</div><div style="font-size:.72rem;color:var(--s400);text-transform:uppercase;font-weight:600">Collected</div></div>';
    h+='</div>';
    h+='<div class="me-card"><div class="me-card-head"><h3>Family Accounts</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Family</th><th>Campers</th><th>Paid</th><th>Balance</th></tr></thead><tbody>';
    Object.entries(families).sort(function(a,b){return(a[1].name||'').localeCompare(b[1].name||'')}).forEach(function([k,f]){
        var sc=f.balance>0?'err':f.totalPaid>0?'ok':'gray';
        h+='<tr><td class="bold">'+esc(f.name)+'</td><td>'+((f.camperIds||[]).length)+'</td><td>'+fm(f.totalPaid||0)+'</td><td>'+bdg(fm(f.balance||0),sc)+'</td></tr>';
    });
    h+='</tbody></table></div></div>';
    c.innerHTML=h;
}

function renderBroadcasts(){
    var c=document.getElementById('page-broadcasts');
    c.innerHTML='<div class="sec-hd"><div><h2 class="sec-title">Broadcasts</h2><p class="sec-desc">'+broadcasts.length+' sent</p></div></div><div class="me-empty"><h3>Messaging</h3><p>Send updates to families and staff.</p></div>';
}

function renderForms(){
    var c=document.getElementById('page-forms');
    c.innerHTML='<div class="sec-hd"><div><h2 class="sec-title">Forms & Docs</h2></div></div><div class="me-empty"><h3>Digital Forms</h3><p>Create and track forms.</p></div>';
}

function renderReports(){
    var c=document.getElementById('page-reports');
    var h='<div class="sec-hd"><div><h2 class="sec-title">Reports & Export</h2></div></div>';
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">';
    h+='<div class="me-card" style="padding:16px"><h3 style="font-size:.9rem;margin-bottom:8px">Camper Roster</h3><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportCsv()">Download CSV</button></div>';
    h+='</div>';
    c.innerHTML=h;
}

function renderSettings(){
    var c=document.getElementById('page-settings');
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    var campName=s.camp_name||s.campName||'';
    var cs=getCampSettings();
    var h='<div class="sec-hd"><div><h2 class="sec-title">Camp Settings</h2></div></div>';
    h+='<div class="me-card" style="padding:18px;max-width:600px">';
    h+='<div class="fg"><label class="fl">Camp Name</label><input class="fi" id="settCampName" value="'+esc(campName)+'"></div>';
    h+='<div class="fg"><label class="fl"><input type="checkbox" id="settHebrewDates" style="accent-color:var(--me);margin-right:6px"'+(cs.showHebrewDates?' checked':'')+'>Show Hebrew dates</label></div>';
    h+='<div class="fg"><label class="fl"><input type="checkbox" id="settAltNames" style="accent-color:var(--me);margin-right:6px"'+(cs.showAltNames!==false?' checked':'')+'>Show alternate names</label></div>';
    h+='<div class="fg"><label class="fl"><input type="checkbox" id="settRTL" style="accent-color:var(--me);margin-right:6px"'+(cs.rtl?' checked':'')+'>Right-to-left layout</label></div>';
    h+='<button class="me-btn me-btn--pri" onclick="CampistryMe.saveSettings()">Save</button>';
    h+='</div>';
    c.innerHTML=h;
}

function saveSettings(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    s.camp_name=(document.getElementById('settCampName').value||'').trim();
    s.campName=s.camp_name;
    if(!s.campistryMe)s.campistryMe={};
    s.campistryMe.campSettings={
        showHebrewDates:document.getElementById('settHebrewDates').checked,
        showAltNames:document.getElementById('settAltNames').checked,
        rtl:document.getElementById('settRTL').checked
    };
    localStorage.setItem('campGlobalSettings_v1',JSON.stringify(s));
    if(s.campistryMe.campSettings.rtl) document.documentElement.setAttribute('dir','rtl');
    else document.documentElement.removeAttribute('dir');
    save();toast('Settings saved');
}

// ── Camper notes & timeline stubs ──
function addCamperNote(camperName){
    var body=prompt('Note:');if(!body)return;
    if(!roster[camperName])return;
    if(!roster[camperName].notes)roster[camperName].notes=[];
    roster[camperName].notes.push({type:'General',body:body,date:new Date().toISOString(),by:'office'});
    save();viewCamper(camperName);toast('Note added');
}
function renderCamperTimeline(camperName){
    var d=roster[camperName];if(!d)return'';var notes=d.notes||[];
    if(!notes.length)return'<div style="font-size:.8rem;color:var(--s400);font-style:italic">No notes yet</div>';
    return notes.slice().reverse().map(function(n){var dt=n.date?new Date(n.date).toLocaleDateString():'';return'<div style="padding:6px 0;border-bottom:1px solid var(--s100);font-size:.8rem"><strong>'+esc(n.type)+'</strong> · <span style="color:var(--s400);font-size:.7rem">'+esc(dt)+'</span><div>'+esc(n.body)+'</div></div>'}).join('');
}

function reEnrollCamper(camperName){toast('Re-enroll: '+camperName)}

// ── Custom fields ──
var customFields=[];
function loadCustomFields(){var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');customFields=(s.campistryMe&&s.campistryMe.customFields)||[]}
function manageCustomFields(){toast('Custom fields coming soon')}

// ── Documents ──
function uploadDocument(camperName){
    var inp=document.createElement('input');inp.type='file';
    inp.onchange=function(){
        var file=inp.files[0];if(!file)return;if(file.size>5*1024*1024){toast('Max 5MB','error');return}
        var reader=new FileReader();
        reader.onload=function(e){if(!roster[camperName])return;if(!roster[camperName].documents)roster[camperName].documents=[];roster[camperName].documents.push({name:file.name,type:file.type,size:file.size,data:e.target.result,uploadDate:new Date().toISOString()});save();viewCamper(camperName);toast('Uploaded')};
        reader.readAsDataURL(file);
    };
    inp.click();
}
function renderDocuments(camperName){
    var docs=(roster[camperName]&&roster[camperName].documents)||[];
    if(!docs.length)return'<div style="font-size:.8rem;color:var(--s400);font-style:italic">No documents</div>';
    return docs.map(function(d,i){return'<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:.8rem"><span>📄</span><a href="'+esc(d.data)+'" download="'+esc(d.name)+'" style="color:var(--me);flex:1">'+esc(d.name)+'</a></div>'}).join('');
}

// ── Scholarships ──
function addScholarship(camperName){
    var amt=parseFloat(prompt('Amount ($):','0'));if(!amt)return;
    if(!roster[camperName])return;
    if(!roster[camperName].scholarships)roster[camperName].scholarships=[];
    roster[camperName].scholarships.push({type:'Scholarship',amount:amt,source:prompt('Source:','')||'',date:new Date().toISOString().split('T')[0]});
    save();viewCamper(camperName);toast('Aid awarded');
}

// ── Duplicates ──
function detectDuplicates(){toast('Duplicate detection coming soon')}
function mergeCampers(a,b){toast('Merge')}

// ── Photo ──
function uploadPhoto(camperName){
    var inp=document.createElement('input');inp.type='file';inp.accept='image/*';
    inp.onchange=function(){var file=inp.files[0];if(!file)return;if(file.size>2*1024*1024){toast('Max 2MB','error');return}var reader=new FileReader();reader.onload=function(e){if(roster[camperName]){roster[camperName].photoUrl=e.target.result;save();viewCamper(camperName);toast('Photo added')}};reader.readAsDataURL(file)};
    inp.click();
}

// ── CSV ──
var CSV_HEADERS=['First Name','Last Name','Date of Birth','Gender','School Name','School Grade','Teacher','Division','Grade','Bunk','Street Address','City','State','ZIP','Parent 1 Name','Parent 1 Phone','Parent 1 Email','Emergency Name','Emergency Phone','Emergency Relation','Allergies','Medications','Dietary Restrictions'];

function downloadTemplate(){
    var leagues=getLeagues();var leagueNames=Object.keys(leagues).sort();
    var headers=CSV_HEADERS.slice();
    leagueNames.forEach(function(lg){headers.push('Team: '+lg)});
    var csv='\uFEFF'+headers.map(function(h){return'"'+h+'"'}).join(',')+'\n';
    csv+='"John","Smith","2015-03-15","Male","PS 123","3rd","Mrs. Johnson","Juniors","3rd Grade","Bunk 1","123 Main St","Brooklyn","NY","11230","Jane Smith","555-123-4567","jane@email.com","Bob Smith","555-987-6543","Uncle","Peanuts","",""\n';
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download='campistry_camper_template.csv';
    a.click();
    toast('Template downloaded');
}

function handleCsv(file){
    if(!file)return;
    var reader=new FileReader();
    reader.onload=function(e){
        var text=e.target.result;
        if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
        var lines=text.split(/\r?\n/).filter(function(l){return l.trim()});
        if(!lines.length)return;
        var hdr=parseCsvLine(lines[0]).map(function(h){return h.toLowerCase().trim()});
        var col=function(names){for(var i=0;i<names.length;i++){var idx=hdr.findIndex(function(h){return h.includes(names[i])});if(idx>=0)return idx}return-1};
        var iFirst=col(['first name','first']),iLast=col(['last name','last']),iName=col(['name','camper']),iDob=col(['date of birth','dob']),iGender=col(['gender']),iSchool=col(['school name','school']),iSchoolGr=col(['school grade']),iTeacher=col(['teacher']),iDiv=col(['division']),iGrade=col(['grade']),iBunk=col(['bunk','cabin']),iStreet=col(['street','address']),iCity=col(['city']),iState=col(['state']),iZip=col(['zip']),iP1=col(['parent 1 name','parent name']),iP1Ph=col(['parent 1 phone','parent phone']),iP1Em=col(['parent 1 email','parent email']),iEmN=col(['emergency name']),iEmPh=col(['emergency phone']),iEmR=col(['emergency relation']),iAlg=col(['allergies']),iMed=col(['medications']),iDiet=col(['dietary']);
        var leagueCols={};hdr.forEach(function(h,idx){var m=h.match(/^team:\s*(.+)/i);if(m)leagueCols[m[1].trim()]=idx});
        var rows=[];
        for(var i=1;i<Math.min(lines.length,5001);i++){
            var cc=parseCsvLine(lines[i]);
            var firstName=(iFirst>=0?cc[iFirst]:'').trim();
            var lastName=(iLast>=0?cc[iLast]:'').trim();
            var fullName='';
            if(firstName||lastName){fullName=(firstName+' '+lastName).trim()}
            else if(iName>=0){fullName=(cc[iName]||'').trim()}
            if(!fullName)continue;
            var teams={};Object.entries(leagueCols).forEach(function([lg,idx]){var v=(cc[idx]||'').trim();if(v)teams[lg]=v});
            rows.push({name:fullName,dob:iDob>=0?(cc[iDob]||'').trim():'',gender:iGender>=0?(cc[iGender]||'').trim():'',school:iSchool>=0?(cc[iSchool]||'').trim():'',schoolGrade:iSchoolGr>=0?(cc[iSchoolGr]||'').trim():'',teacher:iTeacher>=0?(cc[iTeacher]||'').trim():'',division:iDiv>=0?(cc[iDiv]||'').trim():'',grade:iGrade>=0?(cc[iGrade]||'').trim():'',bunk:iBunk>=0?(cc[iBunk]||'').trim():'',street:iStreet>=0?(cc[iStreet]||'').trim():'',city:iCity>=0?(cc[iCity]||'').trim():'',state:iState>=0?(cc[iState]||'').trim():'',zip:iZip>=0?(cc[iZip]||'').trim():'',parent1Name:iP1>=0?(cc[iP1]||'').trim():'',parent1Phone:iP1Ph>=0?(cc[iP1Ph]||'').trim():'',parent1Email:iP1Em>=0?(cc[iP1Em]||'').trim():'',emergencyName:iEmN>=0?(cc[iEmN]||'').trim():'',emergencyPhone:iEmPh>=0?(cc[iEmPh]||'').trim():'',emergencyRel:iEmR>=0?(cc[iEmR]||'').trim():'',allergies:iAlg>=0?(cc[iAlg]||'').trim():'',medications:iMed>=0?(cc[iMed]||'').trim():'',dietary:iDiet>=0?(cc[iDiet]||'').trim():'',teams:teams});
        }
        if(rows.length){
            var pvEl=document.getElementById('csvPV');
            if(pvEl){pvEl.style.display='block';pvEl.innerHTML='<div style="font-weight:600;margin:8px 0 4px">'+rows.length+' campers found</div>'}
            var btn=document.getElementById('csvBtn');
            if(btn){btn.disabled=false;btn.onclick=function(){importRows(rows)}}
        }
    };
    reader.readAsText(file);
}

function parseCsvLine(line){
    var result=[],cur='',inQ=false;
    for(var i=0;i<line.length;i++){
        var ch=line[i];
        if(inQ){if(ch==='"'&&line[i+1]==='"'){cur+='"';i++}else if(ch==='"'){inQ=false}else{cur+=ch}}
        else{if(ch==='"'){inQ=true}else if(ch===','){result.push(cur);cur=''}else{cur+=ch}}
    }
    result.push(cur);
    return result;
}

function importRows(rows){
    // WIPE existing — CSV is the new source of truth
    roster={};structure={};families={};bunkAsgn={};nextCamperId=1;
    try{var goRaw=localStorage.getItem('campistry_go_data');var goData=goRaw?JSON.parse(goRaw):{};goData.addresses={};localStorage.setItem('campistry_go_data',JSON.stringify(goData))}catch(e){}

    rows.forEach(function(r){
        if(r.division){
            if(!structure[r.division]){structure[r.division]={color:COLORS[Object.keys(structure).length%COLORS.length],grades:{}}}
            if(r.grade&&!structure[r.division].grades[r.grade]){structure[r.division].grades[r.grade]={bunks:[]}}
            if(r.grade&&r.bunk&&structure[r.division].grades[r.grade]&&structure[r.division].grades[r.grade].bunks.indexOf(r.bunk)===-1){structure[r.division].grades[r.grade].bunks.push(r.bunk)}
        }
    });

    rows.forEach(function(r){
        var existingId=nextCamperId;nextCamperId++;
        roster[r.name]={camperId:existingId,dob:r.dob||'',gender:r.gender||'',school:r.school||'',schoolGrade:r.schoolGrade||'',teacher:r.teacher||'',division:r.division||'',grade:r.grade||'',bunk:r.bunk||'',street:r.street||'',city:r.city||'',state:r.state||'',zip:r.zip||'',parent1Name:r.parent1Name||'',parent1Phone:r.parent1Phone||'',parent1Email:r.parent1Email||'',emergencyName:r.emergencyName||'',emergencyPhone:r.emergencyPhone||'',emergencyRel:r.emergencyRel||'',allergies:r.allergies||'',medications:r.medications||'',dietary:r.dietary||'',teams:r.teams||{},team:Object.values(r.teams)[0]||''};
        if(roster[r.name].street)syncAddressToGo(r.name,roster[r.name]);
    });

    // Auto-generate families
    var familyMap={};
    rows.forEach(function(r){
        if(!r.parent1Name)return;
        var lastName=r.name.split(' ').pop();
        var famKey='fam_'+lastName.toLowerCase().replace(/[^a-z0-9]/g,'');
        if(!familyMap[famKey]){familyMap[famKey]={lastName:lastName,parentName:r.parent1Name,parentPhone:r.parent1Phone||'',parentEmail:r.parent1Email||'',address:[r.street,r.city,r.state,r.zip].filter(Boolean).join(', '),campers:[]}}
        if(familyMap[famKey].campers.indexOf(r.name)===-1)familyMap[famKey].campers.push(r.name);
    });
    Object.entries(familyMap).forEach(function([famKey,fam]){
        families[famKey]={name:fam.lastName+' Family',households:[{label:'Primary',parents:[{name:fam.parentName,phone:fam.parentPhone,email:fam.parentEmail,relation:'Parent'}],address:fam.address,billingContact:true}],camperIds:fam.campers,balance:0,totalPaid:0,notes:'Auto-created from CSV import'};
    });

    // Auto-populate bunks
    rows.forEach(function(r){if(r.bunk&&r.name){if(!bunkAsgn[r.bunk])bunkAsgn[r.bunk]=[];if(bunkAsgn[r.bunk].indexOf(r.name)===-1)bunkAsgn[r.bunk].push(r.name)}});

    save();closeModal('csvModal');render(curPage);
    toast(rows.length+' campers imported — previous data replaced');
}

function exportCsv(){
    var entries=Object.entries(roster);
    if(!entries.length){toast('No campers','error');return}
    var leagues=getLeagues();var leagueNames=Object.keys(leagues).sort();
    var headers=CSV_HEADERS.slice();
    leagueNames.forEach(function(lg){headers.push('Team: '+lg)});
    var csv='\uFEFF'+headers.map(function(h){return'"'+h+'"'}).join(',')+'\n';
    entries.sort(function(a,b){return a[0].localeCompare(b[0])});
    entries.forEach(function([n,d]){
        var parts=n.split(' ');
        var first=parts[0]||'';
        var last=parts.slice(1).join(' ')||'';
        var teams=d.teams||{};
        var row=[first,last,d.dob||'',d.gender||'',d.school||'',d.schoolGrade||'',d.teacher||'',d.division||'',d.grade||'',d.bunk||'',d.street||'',d.city||'',d.state||'',d.zip||'',d.parent1Name||'',d.parent1Phone||'',d.parent1Email||'',d.emergencyName||'',d.emergencyPhone||'',d.emergencyRel||'',d.allergies||'',d.medications||'',d.dietary||''];
        leagueNames.forEach(function(lg){row.push(teams[lg]||'')});
        csv+=row.map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download='campers_'+new Date().toISOString().split('T')[0]+'.csv';
    a.click();
    toast('Exported '+entries.length+' campers');
}

// ═══ BOOT ════════════════════════════════════════════════════════
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();

window.CampistryMe={
    nav:nav,closeModal:closeModal,
    viewCamper:viewCamper,editCamper:editCamper,addCamper:addCamper,
    addFamily:function(){openFamilyForm(null)},editFamily:function(id){openFamilyForm(id)},
    acceptFamilySuggestion:acceptFamilySuggestion,dismissFamilySuggestion:dismissFamilySuggestion,acceptAddToFamily:acceptAddToFamily,
    addDiv:function(){openDivForm(null)},editDiv:function(n){openDivForm(n)},deleteDiv:deleteDiv,
    openCsv:function(){openModal('csvModal')},exportCsv:exportCsv,downloadTemplate:downloadTemplate,
    bbDrop:bbDrop,autoAssign:autoAssign,clearBunks:clearBunks,
    addSession:addSession,deleteSession:deleteSession,editSession:editSession,toggleSessionReg:toggleSessionReg,copyRegLink:copyRegLink,addApplication:addApplication,autoPromoteWaitlist:autoPromoteWaitlist,
    viewApplication:viewApplication,updateEnrollStatus:updateEnrollStatus,enrollCamper:enrollCamper,
    saveAppNote:saveAppNote,printApplication:printApplication,
    openFormConfig:openFormConfig,saveFormConfig:saveFormConfig,addCustomQ:addCustomQ,addPromoRow:addPromoRow,
    _pickColor:_pickColor,_addGradeRow:_addGradeRow,
    uploadPhoto:uploadPhoto,
    saveSettings:saveSettings,
    addCamperNote:addCamperNote,reEnrollCamper:reEnrollCamper,
    manageCustomFields:manageCustomFields,
    uploadDocument:uploadDocument,addScholarship:addScholarship,
    detectDuplicates:detectDuplicates,mergeCampers:mergeCampers
};
})();
