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
function renderFamilies(){
    var c=document.getElementById('page-families'),e=Object.entries(families);
    var h='<div class="sec-hd"><div><h2 class="sec-title">Families</h2><p class="sec-desc">'+e.length+' household'+(e.length!==1?'s':'')+'</p></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.addFamily()">+ Add Family</button></div></div>';
    if(!e.length){h+='<div class="me-empty"><h3>No families yet</h3><p>Add a family to get started.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.addFamily()">+ Add Family</button></div>'}
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
    if(filter){var q=filter.toLowerCase();entries=entries.filter(function([n,d]){return n.toLowerCase().includes(q)||(d.division||'').toLowerCase().includes(q)||(d.bunk||'').toLowerCase().includes(q)||(d.school||'').toLowerCase().includes(q)})}
    entries.sort(function(a,b){return a[0].localeCompare(b[0])});
    var h='<div class="sec-hd"><div><h2 class="sec-title">Campers</h2><p class="sec-desc">'+total+' total</p></div><div class="sec-actions"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.downloadTemplate()">Download Template</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openCsv()">Import CSV</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportCsv()">Export All</button><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add Camper</button></div></div>';
    if(!entries.length){h+='<div class="me-empty"><h3>No campers yet</h3><p>Add campers or import from CSV.</p><div style="display:flex;gap:6px;justify-content:center"><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add</button><button class="me-btn me-btn--sec" onclick="CampistryMe.openCsv()">Import</button></div></div>'}
    else{
        h+='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th style="width:50px">ID</th><th>Name</th><th>Age</th><th>School</th><th>Grade</th><th>Teacher</th><th>Division</th><th>Bunk</th><th>Medical</th><th style="width:60px"></th></tr></thead><tbody>';
        entries.forEach(function([n,d]){
            var hasMed=!!(d.allergies||d.medications);
            var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'—';
            h+='<tr class="click" onclick="CampistryMe.viewCamper(\''+je(n)+'\')">'+'<td style="font-family:monospace;font-size:.75rem;color:var(--s400)">#'+esc(idStr)+'</td><td class="bold">'+esc(n)+'</td><td>'+(d.dob?age(d.dob):'—')+'</td><td>'+esc(d.school||'—')+'</td><td>'+esc(d.schoolGrade||'—')+'</td><td>'+esc(d.teacher||'—')+'</td><td>'+(d.division?dtag(d.division):'<span style="color:var(--s300)">—</span>')+'</td><td>'+esc(d.bunk||'—')+'</td><td>'+(hasMed?'<span style="color:var(--err);font-size:.7rem;font-weight:600">⚠ '+esc((d.allergies||d.medications||'').split(',')[0])+'</span>':'<span style="color:var(--s300)">—</span>')+'</td><td style="text-align:right" onclick="event.stopPropagation()"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editCamper(\''+je(n)+'\')">Edit</button></td></tr>';
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

    document.getElementById('cvHead').innerHTML='<div style="display:flex;gap:16px;align-items:flex-start;padding:4px 0">'+photoHtml+'<div style="flex:1"><h3 class="cv-name">'+esc(n)+'</h3><div class="cv-tags" style="margin-top:6px"><span class="badge badge-gray" style="font-family:monospace">#'+esc(idStr)+'</span>'+(d.division?dtag(d.division):'')+(d.bunk?' '+bdg(d.bunk,'gray'):'')+'</div></div></div>';

    var b='';

    // Personal
    b+='<div class="cv-sec">Personal Information</div>';
    b+=cvR('Full Name',n);
    b+=cvR('Camper ID','#'+idStr);
    if(d.dob)b+=cvR('Date of Birth',new Date(d.dob+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})+' (age '+age(d.dob)+')');
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
    b+='<div class="cv-health" onclick="toast(\'Campistry Health coming soon\',\'error\')">Open in Campistry Health →</div>';

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

// ── BILLING / BROADCASTS / SOON ──────────────────────────────────
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

    // Custom question answers
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

    // Documents
    if(e.documents&&e.documents.length){
        b+=sec('Uploaded Documents');
        e.documents.forEach(function(doc){
            var sz=doc.size<1024?doc.size+'B':doc.size<1048576?Math.round(doc.size/1024)+'KB':Math.round(doc.size/1048576*10)/10+'MB';
            b+='<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.8rem"><span>📄</span><strong style="color:var(--s700)">'+esc(doc.name)+'</strong><span style="color:var(--s400);font-size:.72rem">'+sz+'</span>';
            if(doc.data)b+=' <a href="'+doc.data+'" download="'+esc(doc.name)+'" style="color:var(--me);font-size:.72rem;font-weight:600">Download</a>';
            b+='</div>';
        });
    }

    // Signature
    if(e.signature){
        b+=sec('Signature');
        b+='<img src="'+e.signature+'" style="max-width:300px;height:80px;border:1px solid var(--s200);border-radius:var(--r);object-fit:contain;background:#fff">';
    }

    // Sibling group
    if(e.siblingGroup){
        b+=sec('Sibling Group');
        var sibApps=Object.entries(enrollments).filter(function([,x]){return x.siblingGroup===e.siblingGroup||x.siblingGroup===id});
        if(sibApps.length>1){
            sibApps.forEach(function([sid,s]){
                if(sid!==id)b+=row('Sibling',esc(s.camperName)+' — '+s.status);
            });
        }
    }

    // Admin Notes
    b+=sec('Internal Notes');
    b+='<textarea id="avNotes" style="width:100%;padding:8px 10px;border:1.5px solid var(--s200);border-radius:var(--r);font-size:.82rem;font-family:var(--font);min-height:60px;resize:vertical;outline:none" placeholder="Add internal notes (only visible to admin)...">'+(e.adminNotes?esc(e.adminNotes):'')+'</textarea>';
    b+='<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.saveAppNote(\''+esc(id)+'\')">Save Notes</button>';

    document.getElementById('avBody').innerHTML=b;

    // Footer buttons
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

    function sec(t){return'<h2>'+t+'</h2><table>'}
    function row(l,v){return v?'<tr><td>'+l+'</td><td>'+v+'</td></tr>':''}
    function end(){return'</table>'}

    h+=sec('Camper');
    h+=row('Name',esc(e.camperName));h+=row('DOB',e.dob);h+=row('Gender',e.gender);
    h+=row('School',e.school);h+=row('Grade',e.schoolGrade);h+=row('Teacher',e.teacher);h+=end();

    h+=sec('Parent/Guardian');
    h+=row('Name',esc(e.parentName)+(e.parentRelation?' ('+e.parentRelation+')':''));
    h+=row('Phone',e.parentPhone);h+=row('Email',e.parentEmail);
    if(e.parent2Name)h+=row('Parent 2',esc(e.parent2Name)+(e.parent2Phone?' — '+e.parent2Phone:''));h+=end();

    h+=sec('Address');
    h+=row('Street',e.street);h+=row('City',e.city);h+=row('State',e.state);h+=row('ZIP',e.zip);h+=end();

    h+=sec('Emergency Contact');
    h+=row('Name',esc(e.emergencyName)+(e.emergencyRel?' ('+e.emergencyRel+')':''));h+=row('Phone',e.emergencyPhone);h+=end();

    h+=sec('Medical');
    h+=row('Allergies',e.allergies?'<span class="med">'+esc(e.allergies)+'</span>':'None');
    h+=row('Medications',e.medications?'<span class="med">'+esc(e.medications)+'</span>':'None');
    h+=row('Dietary',e.dietary||'None');h+=row('Notes',e.medicalNotes);h+=end();

    h+=sec('Preferences');
    h+=row('Bunkmate',e.bunkmate);h+=row('Separation',e.separateFrom);h+=row('T-Shirt',e.tshirtSize);h+=row('Notes',e.notes);h+=end();

    h+=sec('Payment');
    h+=row('Session',e.session);h+=row('Tuition',e.sessionTuition?'$'+Number(e.sessionTuition).toLocaleString():'—');
    h+=row('Method',e.paymentMethod);h+=row('Status',e.paymentStatus);
    if(e.discount&&e.discount.code)h+=row('Discount',e.discount.label);h+=end();

    if(e.customAnswers&&Object.keys(e.customAnswers).length){
        h+=sec('Custom Responses');
        var labels=e.customQuestionLabels||[];
        Object.entries(e.customAnswers).forEach(function([key,val]){
            var idx=parseInt(key.replace('q',''));var label=labels[idx]||('Question '+(idx+1));
            h+=row(label,Array.isArray(val)?val.join(', '):esc(val));
        });h+=end();
    }

    if(e.documents&&e.documents.length){
        h+=sec('Documents');
        e.documents.forEach(function(d){h+='<div style="padding:2px 0">📄 '+esc(d.name)+'</div>'});
    }

    if(e.signature){h+=sec('Signature');h+='<img src="'+e.signature+'">';}

    if(e.adminNotes){h+=sec('Admin Notes');h+='<p>'+esc(e.adminNotes)+'</p>';}

    h+='<div style="margin-top:30px;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0;padding-top:10px">Printed from Campistry Me · '+new Date().toLocaleString()+'</div>';
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
    h+='<div class="me-field"><label>Payment Plan</label><select id="sesPayPlan" class="me-input"><option value="full"'+(s.paymentPlan==='full'?' selected':'')+'  >Full payment required</option><option value="2"'+(s.paymentPlan==='2'?' selected':'')+'>2 installments (50/50)</option><option value="3"'+(s.paymentPlan==='3'?' selected':'')+'>3 installments (34/33/33)</option><option value="4"'+(s.paymentPlan==='4'?' selected':'')+'>4 installments (25 each)</option><option value="deposit"'+(s.paymentPlan==='deposit'?' selected':'')+'>Deposit + balance</option></select></div>';
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
        // Auto-generate date range label from dates if not manually set
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
    var sesOpts=sessions.map(function(s){return'<option value="'+esc(s.name)+'">'+esc(s.name)+' — '+fm(s.tuition)+'</option>'}).join('');
    var h='<div class="me-modal-form">';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="me-field"><label>Camper First Name</label><input type="text" id="appFirst" class="me-input" placeholder="First"></div><div class="me-field"><label>Last Name</label><input type="text" id="appLast" class="me-input" placeholder="Last"></div></div>';
    h+='<div class="me-field"><label>Session</label><select id="appSession" class="me-input"><option value="">— Select —</option>'+sesOpts+'</select></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="me-field"><label>Date of Birth</label><input type="date" id="appDob" class="me-input"></div><div class="me-field"><label>Gender</label><select id="appGender" class="me-input"><option value="">—</option><option>Male</option><option>Female</option></select></div></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="me-field"><label>School</label><input type="text" id="appSchool" class="me-input"></div><div class="me-field"><label>School Grade</label><input type="text" id="appSchoolGrade" class="me-input"></div></div>';
    h+='<div style="border-top:1px solid var(--s200);margin:14px 0;padding-top:14px"><div style="font-size:.75rem;font-weight:700;color:var(--s500);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Parent / Guardian</div></div>';
    h+='<div class="me-field"><label>Parent Name</label><input type="text" id="appParent" class="me-input" placeholder="Full name"></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="me-field"><label>Phone</label><input type="tel" id="appPhone" class="me-input"></div><div class="me-field"><label>Email</label><input type="email" id="appEmail" class="me-input"></div></div>';
    h+='<div style="border-top:1px solid var(--s200);margin:14px 0;padding-top:14px"><div style="font-size:.75rem;font-weight:700;color:var(--s500);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Address</div></div>';
    h+='<div class="me-field"><label>Street</label><input type="text" id="appStreet" class="me-input"></div>';
    h+='<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px"><div class="me-field"><label>City</label><input type="text" id="appCity" class="me-input"></div><div class="me-field"><label>State</label><input type="text" id="appState" class="me-input" value="NY" maxlength="2"></div><div class="me-field"><label>ZIP</label><input type="text" id="appZip" class="me-input" maxlength="10"></div></div>';
    h+='<div style="border-top:1px solid var(--s200);margin:14px 0;padding-top:14px"><div style="font-size:.75rem;font-weight:700;color:var(--s500);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Medical (optional)</div></div>';
    h+='<div class="me-field"><label>Allergies</label><input type="text" id="appAllergies" class="me-input" placeholder="None or list allergies"></div>';
    h+='<div class="me-field"><label>Medications</label><input type="text" id="appMeds" class="me-input" placeholder="None or list medications"></div>';
    h+='<div class="me-field"><label>Notes</label><textarea id="appNotes" class="me-input" rows="2" style="resize:vertical" placeholder="Special requests, bunkmate preferences, etc."></textarea></div>';
    h+='</div>';

    showModal('New Application',h,function(){
        var first=(document.getElementById('appFirst').value||'').trim();
        var last=(document.getElementById('appLast').value||'').trim();
        if(!first||!last){alert('Enter camper name');return}
        var camperName=first+' '+last;
        var session=document.getElementById('appSession').value||'';
        var sesObj=sessions.find(function(s){return s.name===session});
        // Check capacity
        if(sesObj&&sesObj.capacity>0){
            var enrolled=Object.values(enrollments).filter(function(e){return e.session===session&&(e.status==='enrolled'||e.status==='accepted')}).length;
            if(enrolled>=sesObj.capacity){
                if(!confirm(session+' is at capacity ('+enrolled+'/'+sesObj.capacity+'). Add to waitlist?'))return;
            }
        }
        var tuition=sesObj?sesObj.tuition:0;
        var id='enr_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
        enrollments[id]={
            camperName:camperName,camperLast:last,
            parentName:(document.getElementById('appParent').value||'').trim(),
            parentEmail:(document.getElementById('appEmail').value||'').trim(),
            parentPhone:(document.getElementById('appPhone').value||'').trim(),
            dob:document.getElementById('appDob').value||'',
            gender:document.getElementById('appGender').value||'',
            school:(document.getElementById('appSchool').value||'').trim(),
            schoolGrade:(document.getElementById('appSchoolGrade').value||'').trim(),
            street:(document.getElementById('appStreet').value||'').trim(),
            city:(document.getElementById('appCity').value||'').trim(),
            state:(document.getElementById('appState').value||'').trim(),
            zip:(document.getElementById('appZip').value||'').trim(),
            allergies:(document.getElementById('appAllergies').value||'').trim(),
            medications:(document.getElementById('appMeds').value||'').trim(),
            session:session,
            sessionTuition:tuition,
            status:sesObj&&sesObj.capacity>0&&Object.values(enrollments).filter(function(e){return e.session===session&&(e.status==='enrolled'||e.status==='accepted')}).length>=sesObj.capacity?'waitlisted':'applied',
            appliedDate:new Date().toISOString().split('T')[0],
            formsRequired:3,formsCompleted:0,
            paymentStatus:'pending',paymentAmount:0,
            notes:(document.getElementById('appNotes').value||'').trim()
        };
        save();closeModal('dynModal');renderEnrollment();
        toast(enrollments[id].status==='waitlisted'?camperName+' added to waitlist':camperName+' application received');
    });
}

function updateEnrollStatus(id,status){
    if(!enrollments[id])return;
    var prev=enrollments[id].status;
    enrollments[id].status=status;
    enrollments[id].statusHistory=enrollments[id].statusHistory||[];
    enrollments[id].statusHistory.push({from:prev,to:status,date:new Date().toISOString(),by:'office'});

    // If declining/withdrawing someone from a full session, auto-promote next waitlisted
    if((status==='declined'||status==='withdrawn')&&prev!=='waitlisted'){
        var session=enrollments[id].session;
        if(session) autoPromoteWaitlist(session);
    }
    save();renderEnrollment();toast('Status updated to '+status);
}

function autoPromoteWaitlist(sessionName){
    var sesObj=sessions.find(function(s){return s.name===sessionName});
    if(!sesObj||!sesObj.capacity)return; // no cap = no waitlist needed
    var enrolled=Object.values(enrollments).filter(function(e){return e.session===sessionName&&(e.status==='enrolled'||e.status==='accepted')}).length;
    if(enrolled>=sesObj.capacity)return; // still full
    // Find oldest waitlisted application for this session
    var waitlisted=Object.entries(enrollments).filter(function([,e]){return e.session===sessionName&&e.status==='waitlisted'}).sort(function(a,b){return(a[1].appliedDate||'').localeCompare(b[1].appliedDate||'')});
    if(waitlisted.length){
        var[wid,we]=waitlisted[0];
        we.status='accepted';
        we.statusHistory=we.statusHistory||[];
        we.statusHistory.push({from:'waitlisted',to:'accepted',date:new Date().toISOString(),by:'auto-promote'});
        toast('Auto-promoted '+we.camperName+' from waitlist!');
        console.log('[Me] Waitlist auto-promote: '+we.camperName+' for '+sessionName);
    }
}

function enrollCamper(id){
    var e=enrollments[id];if(!e)return;
    e.status='enrolled';
    // Auto-create camper in roster with ALL application data
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
        // Sync address to Go
        if(e.street)syncAddressToGo(e.camperName,roster[e.camperName]);
        toast('Enrolled — camper added to roster with all info');
    }else{
        // Update existing camper with any missing data from application
        var c=roster[e.camperName];
        if(!c.dob&&e.dob)c.dob=e.dob;
        if(!c.gender&&e.gender)c.gender=e.gender;
        if(!c.school&&e.school)c.school=e.school;
        if(!c.schoolGrade&&e.schoolGrade)c.schoolGrade=e.schoolGrade;
        if(!c.teacher&&e.teacher)c.teacher=e.teacher;
        if(!c.street&&e.street){c.street=e.street;c.city=e.city;c.state=e.state;c.zip=e.zip;syncAddressToGo(e.camperName,c)}
        if(!c.parent1Name&&e.parentName){c.parent1Name=e.parentName;c.parent1Phone=e.parentPhone;c.parent1Email=e.parentEmail}
        if(!c.emergencyName&&e.emergencyName){c.emergencyName=e.emergencyName;c.emergencyPhone=e.emergencyPhone;c.emergencyRel=e.emergencyRel}
        if(!c.allergies&&e.allergies)c.allergies=e.allergies;
        if(!c.medications&&e.medications)c.medications=e.medications;
        if(!c.dietary&&e.dietary)c.dietary=e.dietary;
        toast('Enrolled — updated existing camper');
    }
    // Auto-create family
    var lastName=e.camperName.split(' ').pop();
    var famKey='fam_'+lastName.toLowerCase().replace(/[^a-z0-9]/g,'');
    var addr=[e.street,e.city,e.state,e.zip].filter(Boolean).join(', ');
    var sesObj=sessions.find(function(s){return s.name===e.session});
    var tuition=e.sessionTuition||sesObj?.tuition||0;

    // Apply sibling discount if applicable
    if(sesObj&&sesObj.siblingDiscount>0&&families[famKey]&&families[famKey].camperIds.length>0){
        var discAmt=Math.round(tuition*sesObj.siblingDiscount/100);
        tuition-=discAmt;
        e.discount={pct:sesObj.siblingDiscount,amt:discAmt};
        console.log('[Me] Sibling discount applied: '+sesObj.siblingDiscount+'% (-'+fm(discAmt)+') for '+e.camperName);
    }

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

    // Generate payment plan / installment schedule
    if(sesObj&&sesObj.paymentPlan&&sesObj.paymentPlan!=='full'){
        var plan=sesObj.paymentPlan;
        e.installments=[];
        var today=new Date();
        if(plan==='deposit'){
            var dep=sesObj.depositAmount||Math.round(tuition*0.25);
            e.installments.push({label:'Deposit',amount:dep,dueDate:today.toISOString().split('T')[0],status:'pending'});
            e.installments.push({label:'Balance',amount:tuition-dep,dueDate:sesObj.startDate||'',status:'pending'});
        }else{
            var numPayments=parseInt(plan)||2;
            var perPayment=Math.floor(tuition/numPayments);
            var remainder=tuition-(perPayment*numPayments);
            for(var pi=0;pi<numPayments;pi++){
                var due=new Date(today);due.setDate(due.getDate()+30*(pi));
                var amt=perPayment+(pi===0?remainder:0);
                e.installments.push({label:'Payment '+(pi+1)+' of '+numPayments,amount:amt,dueDate:due.toISOString().split('T')[0],status:'pending'});
            }
        }
        console.log('[Me] Payment plan: '+e.installments.length+' installments for '+e.camperName);
    }

    e.enrolledDate=new Date().toISOString().split('T')[0];
    save();renderEnrollment();
}

// ── ANALYTICS & FINANCE ──────────────────────────────────────
var _finTab='overview';
var FIN_CATS=['Food & Catering','Supplies & Equipment','Facilities & Rent','Insurance','Transportation','Activities & Trips','Marketing','Utilities','Miscellaneous'];
var FIN_ROLES=['Head Counselor','Counselor','Junior Counselor','Specialist','Nurse','Kitchen Staff','Bus Driver','Office Staff','Director','Maintenance'];
var BAR_COLORS=['#D97706','#3B82F6','#10B981','#8B5CF6','#EF4444','#0EA5E9','#F59E0B','#EC4899','#6366F1','#14B8A6'];

function renderAnalytics(){
    var c=document.getElementById('page-analytics');

    // ═══ AUTO-GENERATE INVOICES FROM ENROLLMENTS ═══
    // Every enrolled camper = an invoice. No manual entry needed.
    var autoInvoices=[];
    var overdueDays=finBudget.overdueDays||30; // configurable threshold
    var todayStr=new Date().toISOString().split('T')[0];
    var todayMs=new Date().getTime();

    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled'&&e.status!=='accepted')return;
        var tuition=e.sessionTuition||0;
        if(!tuition)return;
        // Check if manual payment exists for this camper
        var manualPay=finPayments.filter(function(p){return p.family===e.camperName||p.family===(e.camperLast||'')+' Family'||p.enrollmentId===id});
        var paidAmount=manualPay.reduce(function(s,p){return s+p.amount},0);
        var payStatus='pending';
        if(paidAmount>=tuition)payStatus='paid';
        else if(paidAmount>0)payStatus='partial';
        else{
            // Check if overdue based on enrollment date
            var enrollDate=new Date(e.appliedDate||todayStr);
            var daysSince=Math.floor((todayMs-enrollDate.getTime())/(1000*60*60*24));
            if(daysSince>overdueDays)payStatus='overdue';
        }
        // Discount applied?
        var discountAmt=0;
        if(e.discount){
            if(e.discount.pct)discountAmt=Math.round(tuition*e.discount.pct/100);
            if(e.discount.amt)discountAmt+=e.discount.amt;
        }
        var netTuition=tuition-discountAmt;
        // Get Camper ID from roster
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId||0;
        var camperIdStr=camperId?String(camperId).padStart(4,'0'):'—';
        autoInvoices.push({
            id:id,camperId:camperId,camperIdStr:camperIdStr,
            camper:e.camperName,family:e.parentName,session:e.session||'',
            tuition:tuition,discount:discountAmt,netTuition:netTuition,
            paid:paidAmount,balance:Math.max(netTuition-paidAmount,0),
            status:payStatus,method:e.paymentMethod||'',
            enrollDate:e.appliedDate||'',dueDate:'',
            isOverdue:payStatus==='overdue'
        });
    });

    // ═══ AUTO-COMPUTE ALL TOTALS ═══
    var totalPayroll=finStaff.reduce(function(s,x){return s+(x.salary||0)},0);
    var totalExp=finExpenses.reduce(function(s,x){return s+(x.amount||0)},0);
    var projected=autoInvoices.reduce(function(s,inv){return s+inv.netTuition},0);
    var totalCollected=autoInvoices.reduce(function(s,inv){return s+inv.paid},0);
    var totalOutstanding=autoInvoices.reduce(function(s,inv){return s+inv.balance},0);
    var paidCount=autoInvoices.filter(function(inv){return inv.status==='paid'}).length;
    var partialCount=autoInvoices.filter(function(inv){return inv.status==='partial'}).length;
    var overdueCount=autoInvoices.filter(function(inv){return inv.status==='overdue'}).length;
    var pendingCount=autoInvoices.filter(function(inv){return inv.status==='pending'}).length;
    var netIncome=totalCollected-totalPayroll-totalExp;
    var enrolledCount=autoInvoices.length;

    var tabs=[{k:'overview',l:'Overview'},{k:'revenue',l:'Revenue'},{k:'payroll',l:'Payroll'},{k:'expenses',l:'Expenses'},{k:'budget',l:'Budget'},{k:'integrations',l:'Integrations'}];

    var h='<div class="sec-hd"><div><h2 class="sec-title">Analytics & Finance</h2><p class="sec-desc">Financial command center</p></div>';
    h+='<div class="sec-actions">';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finExportCSV()">↓ Export CSV</button>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finExportQB()">↓ QuickBooks</button>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finSetBudget()">Set Budget</button>';
    h+='</div></div>';

    // Sub-tabs
    h+='<div style="display:flex;gap:0;border-bottom:1px solid var(--s200);margin-bottom:14px">';
    tabs.forEach(function(t){
        h+='<button class="me-btn me-btn--ghost" style="padding:8px 16px;font-size:.8rem;font-weight:600;border-bottom:2px solid '+(_finTab===t.k?'var(--me)':'transparent')+';color:'+(_finTab===t.k?'var(--me)':'var(--s400)')+';border-radius:0" onclick="CampistryMe.finSetTab(\''+t.k+'\')">'+t.l+'</button>';
    });
    h+='</div>';

    function stat(label,value,sub,color){return'<div style="flex:1;min-width:140px;background:#fff;border-radius:var(--r);padding:12px 14px;border:1px solid var(--s200);border-left:3px solid '+color+'"><div style="font-size:.65rem;font-weight:700;color:var(--s400);text-transform:uppercase;letter-spacing:.04em">'+label+'</div><div style="font-size:1.2rem;font-weight:800;color:var(--s800);margin-top:2px">'+value+'</div>'+(sub?'<div style="font-size:.72rem;color:var(--s400);margin-top:1px">'+sub+'</div>':'')+'</div>'}
    function bar(items,maxVal){var bh='';items.forEach(function(item,i){var pct=maxVal>0?Math.round(item.value/maxVal*100):0;var color=BAR_COLORS[i%BAR_COLORS.length];bh+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="width:90px;font-size:.75rem;font-weight:600;color:var(--s500);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(item.name)+'</div><div style="flex:1;height:20px;background:var(--s100);border-radius:4px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:'+color+';border-radius:4px;transition:width .3s"></div></div><div style="width:60px;font-size:.75rem;font-weight:700;color:var(--s700);text-align:right">'+fm(item.value)+'</div></div>'});return bh}

    if(_finTab==='overview'){
        // Overdue alert banner
        if(overdueCount>0){
            h+='<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:var(--r);padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px"><span style="font-size:18px">⚠️</span><div><div style="font-size:.85rem;font-weight:700;color:var(--err)">'+overdueCount+' overdue account'+(overdueCount>1?'s':'')+'</div><div style="font-size:.75rem;color:#991B1B">'+fm(autoInvoices.filter(function(i){return i.isOverdue}).reduce(function(s,i){return s+i.balance},0))+' outstanding past '+overdueDays+' days</div></div></div>';
        }
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Projected Revenue',fm(projected),enrolledCount+' enrolled campers','var(--me)');
        h+=stat('Collected',fm(totalCollected),projected>0?Math.round(totalCollected/projected*100)+'% of projected':'','var(--ok)');
        h+=stat('Outstanding',fm(totalOutstanding),overdueCount+' overdue, '+pendingCount+' pending','var(--err)');
        h+=stat('Net Income',fm(netIncome),netIncome>=0?'Positive':'Deficit',netIncome>=0?'var(--ok)':'var(--err)');
        h+='</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">';
        h+=stat('Total Payroll',fm(totalPayroll),finStaff.length+' staff','#3B82F6');
        h+=stat('Total Expenses',fm(totalExp),finExpenses.length+' items','#8B5CF6');
        h+=stat('Total Costs',fm(totalPayroll+totalExp),'Payroll + Expenses','var(--s600)');
        h+=stat('Profit Margin',projected>0?Math.round(netIncome/projected*100)+'%':'—','Net / Revenue','#0EA5E9');
        h+='</div>';

        // Enrollment funnel
        var eArr=Object.entries(enrollments);
        var funnel=[{name:'Applied',count:eArr.length,color:'var(--s400)'},{name:'Accepted',count:eArr.filter(function([,e]){return e.status==='accepted'||e.status==='enrolled'}).length,color:'#3B82F6'},{name:'Enrolled',count:eArr.filter(function([,e]){return e.status==='enrolled'}).length,color:'var(--ok)'},{name:'Waitlisted',count:eArr.filter(function([,e]){return e.status==='waitlisted'}).length,color:'var(--me)'},{name:'Declined',count:eArr.filter(function([,e]){return e.status==='declined'}).length,color:'var(--err)'}];
        var maxFunnel=funnel[0].count||1;
        h+='<div style="display:flex;gap:14px;flex-wrap:wrap">';
        h+='<div class="me-card" style="flex:1;min-width:280px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Enrollment Funnel</h4>';
        funnel.forEach(function(f){var pct=Math.round(f.count/maxFunnel*100);h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="width:70px;font-size:.75rem;font-weight:600;color:var(--s500);text-align:right">'+f.name+'</div><div style="flex:1;height:22px;background:var(--s100);border-radius:4px;overflow:hidden;position:relative"><div style="width:'+pct+'%;height:100%;background:'+f.color+';border-radius:4px"></div><span style="position:absolute;right:6px;top:3px;font-size:.7rem;font-weight:700;color:var(--s600)">'+f.count+'</span></div></div>'});
        h+='</div>';

        // Payment status
        h+='<div class="me-card" style="flex:1;min-width:200px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Payment Status</h4>';
        var payStats=[{name:'Paid',count:paidCount,color:'var(--ok)'},{name:'Partial',count:partialCount,color:'var(--me)'},{name:'Overdue',count:overdueCount,color:'var(--err)'},{name:'Pending',count:pendingCount,color:'var(--s400)'}];
        var totalPayCount=autoInvoices.length||1;
        payStats.forEach(function(p){var pct=Math.round(p.count/totalPayCount*100);h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="width:10px;height:10px;border-radius:3px;background:'+p.color+';flex-shrink:0"></div><div style="flex:1;font-size:.82rem;font-weight:600;color:var(--s700)">'+p.name+'</div><div style="font-size:.82rem;font-weight:700;color:var(--s800)">'+p.count+'</div><div style="font-size:.72rem;color:var(--s400);width:35px;text-align:right">'+pct+'%</div></div>'});
        h+='</div></div>';

        // Expense breakdown
        var expByCat={};finExpenses.forEach(function(e){expByCat[e.cat]=(expByCat[e.cat]||0)+e.amount});
        var expItems=Object.entries(expByCat).map(function([name,value]){return{name:name,value:value}}).sort(function(a,b){return b.value-a.value});
        var maxExp=expItems.length?expItems[0].value:1;
        if(expItems.length){
            h+='<div class="me-card" style="margin-top:14px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Expense Categories</h4>';
            h+=bar(expItems,maxExp);
            h+='</div>';
        }
    }

    else if(_finTab==='revenue'){
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Total Invoiced',fm(projected),'','var(--me)');
        h+=stat('Collected',fm(totalCollected),'','var(--ok)');
        h+=stat('Outstanding',fm(totalOutstanding),'','var(--err)');
        h+=stat('Collection Rate',projected>0?Math.round(totalCollected/projected*100)+'%':'—','','#3B82F6');
        h+='</div>';

        // Auto-invoice explanation
        h+='<div style="background:#FFF7ED;border:1px solid #FDBA74;border-radius:var(--r);padding:10px 14px;margin-bottom:10px;font-size:.78rem;color:var(--s600)"><strong style="color:var(--me)">Auto-Generated Invoices</strong> — Each enrolled camper automatically creates an invoice based on their session tuition. Record payments below to update balances.</div>';

        // Overdue threshold setting
        h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px">';
        h+='<div style="font-size:.78rem;color:var(--s400)">Accounts are marked overdue after <strong>'+overdueDays+'</strong> days. <button class="me-btn me-btn--ghost me-btn--sm" style="font-size:.72rem" onclick="CampistryMe.finSetOverdue()">Change</button></div>';
        h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finAddPayment()">+ Record Payment</button>';
        h+='</div>';

        // Invoices table (auto-generated)
        h+='<div class="me-card"><div class="me-card-head"><h3>Tuition Invoices ('+autoInvoices.length+' accounts)</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th style="width:70px">Invoice #</th><th>Camper</th><th>Parent</th><th>Session</th><th>Tuition</th><th>Discount</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>';
        autoInvoices.sort(function(a,b){return a.status==='overdue'?-1:b.status==='overdue'?1:a.camper.localeCompare(b.camper)}).forEach(function(inv){
            var sc=inv.status==='paid'?'ok':inv.status==='partial'?'warn':inv.status==='overdue'?'err':'gray';
            var rowStyle=inv.isOverdue?'background:rgba(239,68,68,.03)':'';
            h+='<tr style="'+rowStyle+'">';
            h+='<td style="font-family:monospace;font-size:.78rem;color:var(--s500)">#'+esc(inv.camperIdStr)+'</td>';
            h+='<td class="bold">'+(inv.isOverdue?'⚠ ':'')+esc(inv.camper)+'</td>';
            h+='<td>'+esc(inv.family||'—')+'</td>';
            h+='<td style="font-size:.78rem">'+esc(inv.session||'—')+'</td>';
            h+='<td>'+fm(inv.tuition)+'</td>';
            h+='<td>'+(inv.discount?'<span style="color:var(--ok)">-'+fm(inv.discount)+'</span>':'—')+'</td>';
            h+='<td style="color:var(--ok);font-weight:600">'+fm(inv.paid)+'</td>';
            h+='<td style="font-weight:700;color:'+(inv.balance>0?'var(--err)':'var(--ok)')+'">'+fm(inv.balance)+'</td>';
            h+='<td>'+bdg(inv.status,sc)+'</td>';
            h+='</tr>';
        });
        h+='</tbody></table></div></div>';

        // Manual payment log (supplementary)
        if(finPayments.length){
            h+='<div class="me-card" style="margin-top:14px"><div class="me-card-head"><h3>Payment Log</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Family/Camper</th><th>Amount</th><th>Method</th><th></th></tr></thead><tbody>';
            finPayments.sort(function(a,b){return(b.date||'').localeCompare(a.date||'')}).forEach(function(p,i){
                h+='<tr><td style="font-size:.75rem;color:var(--s400)">'+esc(p.date||'—')+'</td><td class="bold">'+esc(p.family)+'</td><td style="font-weight:700;color:var(--ok)">'+fm(p.amount)+'</td><td>'+esc(p.method||'—')+'</td><td style="text-align:right"><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.finRemovePayment('+i+')">✕</button></td></tr>';
            });
            h+='</tbody></table></div></div>';
        }
    }

    else if(_finTab==='payroll'){
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Total Payroll',fm(totalPayroll),'','#3B82F6');
        h+=stat('Staff Count',finStaff.length+'','','#8B5CF6');
        h+=stat('Avg Salary',fm(finStaff.length?totalPayroll/finStaff.length:0),'','#0EA5E9');
        h+=stat('% of Revenue',projected>0?Math.round(totalPayroll/projected*100)+'%':'—','','var(--me)');
        h+='</div>';
        // Cost by role
        var roleCost={};finStaff.forEach(function(s){roleCost[s.role]=(roleCost[s.role]||0)+s.salary});
        var roleItems=Object.entries(roleCost).map(function([name,value]){return{name:name,value:value}}).sort(function(a,b){return b.value-a.value});
        if(roleItems.length){
            h+='<div class="me-card" style="margin-bottom:14px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Cost by Role</h4>';
            h+=bar(roleItems,roleItems[0].value);
            h+='</div>';
        }
        h+='<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finAddStaff()">+ Add Staff</button></div>';
        h+='<div class="me-card"><div class="me-card-head"><h3>Staff Directory</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Name</th><th>Role</th><th>Type</th><th>Salary</th><th></th></tr></thead><tbody>';
        finStaff.forEach(function(s,i){
            h+='<tr><td class="bold">'+esc(s.name)+'</td><td>'+esc(s.role)+'</td><td>'+bdg(s.type||'seasonal',s.type==='annual'?'ok':'gray')+'</td><td style="font-weight:700">'+fm(s.salary)+'</td><td style="text-align:right"><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.finRemoveStaff('+i+')">✕</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    }

    else if(_finTab==='expenses'){
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Total Expenses',fm(totalExp),'','var(--err)');
        h+=stat('Line Items',finExpenses.length+'','','#8B5CF6');
        h+=stat('Avg Item',fm(finExpenses.length?totalExp/finExpenses.length:0),'','#0EA5E9');
        h+=stat('% of Revenue',projected>0?Math.round(totalExp/projected*100)+'%':'—','','var(--me)');
        h+='</div>';
        var expByCat2={};finExpenses.forEach(function(e){expByCat2[e.cat]=(expByCat2[e.cat]||0)+e.amount});
        var expItems2=Object.entries(expByCat2).map(function([name,value]){return{name:name,value:value}}).sort(function(a,b){return b.value-a.value});
        if(expItems2.length){
            h+='<div class="me-card" style="margin-bottom:14px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Expenses by Category</h4>';
            h+=bar(expItems2,expItems2[0].value);
            h+='</div>';
        }
        h+='<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finAddExpense()">+ Add Expense</button></div>';
        h+='<div class="me-card"><div class="me-card-head"><h3>Expense Ledger</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th></th></tr></thead><tbody>';
        finExpenses.sort(function(a,b){return(b.date||'').localeCompare(a.date||'')}).forEach(function(e,i){
            h+='<tr><td style="font-size:.75rem;color:var(--s400)">'+esc(e.date||'—')+'</td><td class="bold">'+esc(e.desc)+'</td><td>'+bdg(e.cat,'gray')+'</td><td style="font-weight:700;color:var(--err)">'+fm(e.amount)+'</td><td style="text-align:right"><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.finRemoveExpense('+i+')">✕</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    }

    else if(_finTab==='budget'){
        var budgetItems=[
            {name:'Revenue',budget:finBudget.revenue||0,actual:totalCollected,good:true},
            {name:'Payroll',budget:finBudget.payroll||0,actual:totalPayroll,good:false},
            {name:'Expenses',budget:finBudget.expenses||0,actual:totalExp,good:false}
        ];
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">';
        budgetItems.forEach(function(b){
            var diff=b.actual-b.budget;var isOver=b.good?diff<0:diff>0;
            var sub=b.good?(diff>=0?'✓ On track':'⚠ '+fm(Math.abs(diff))+' below'):(diff<=0?'✓ Under budget':'⚠ '+fm(diff)+' over');
            h+=stat(b.name,fm(b.actual)+' / '+fm(b.budget),sub,isOver?'var(--err)':'var(--ok)');
        });
        h+='</div>';
        // Visual comparison
        h+='<div class="me-card" style="padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 14px">Budget vs Actual</h4>';
        var maxBudget=Math.max.apply(null,budgetItems.map(function(b){return Math.max(b.budget,b.actual)}))||1;
        budgetItems.forEach(function(b){
            var bPct=Math.round(b.budget/maxBudget*100);
            var aPct=Math.round(b.actual/maxBudget*100);
            var isOver=b.good?b.actual<b.budget:b.actual>b.budget;
            h+='<div style="margin-bottom:12px"><div style="font-size:.8rem;font-weight:600;color:var(--s700);margin-bottom:4px">'+b.name+'</div>';
            h+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><div style="width:50px;font-size:.7rem;color:var(--s400)">Budget</div><div style="flex:1;height:16px;background:var(--s100);border-radius:4px;overflow:hidden"><div style="width:'+bPct+'%;height:100%;background:var(--s300);border-radius:4px"></div></div><div style="width:65px;font-size:.75rem;font-weight:600;color:var(--s500);text-align:right">'+fm(b.budget)+'</div></div>';
            h+='<div style="display:flex;align-items:center;gap:6px"><div style="width:50px;font-size:.7rem;color:var(--s400)">Actual</div><div style="flex:1;height:16px;background:var(--s100);border-radius:4px;overflow:hidden"><div style="width:'+aPct+'%;height:100%;background:'+(isOver?'var(--err)':'var(--ok)')+';border-radius:4px"></div></div><div style="width:65px;font-size:.75rem;font-weight:700;color:'+(isOver?'var(--err)':'var(--ok)')+';text-align:right">'+fm(b.actual)+'</div></div></div>';
        });
        h+='</div>';
        h+='<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finSetBudget()">Edit Budget Targets</button></div>';
    }

    else if(_finTab==='integrations'){
        h+='<div class="me-card" style="padding:20px;margin-bottom:14px">';
        h+='<h4 style="font-size:.9rem;font-weight:700;color:var(--s800);margin:0 0 6px">Accounting Software Integration</h4>';
        h+='<p style="font-size:.82rem;color:var(--s500);margin-bottom:14px">Export your financial data in formats compatible with popular accounting software. Import transactions from your existing books.</p>';

        h+='<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">';
        var integrations=[
            {name:'QuickBooks Online',icon:'📗',desc:'Export as CSV for QBO import',action:'finExportQB'},
            {name:'QuickBooks Desktop',icon:'📘',desc:'Export as IIF file',action:'finExportIIF'},
            {name:'Xero',icon:'📙',desc:'Export as Xero-compatible CSV',action:'finExportXero'},
            {name:'General CSV',icon:'📊',desc:'Universal CSV format',action:'finExportCSV'},
            {name:'Journal Entries',icon:'📒',desc:'Double-entry journal format',action:'finExportJournal'}
        ];
        integrations.forEach(function(ig){
            h+='<div style="flex:1;min-width:180px;padding:14px;border:1px solid var(--s200);border-radius:var(--r);background:var(--s50)">';
            h+='<div style="font-size:24px;margin-bottom:6px">'+ig.icon+'</div>';
            h+='<div style="font-size:.85rem;font-weight:700;color:var(--s800)">'+ig.name+'</div>';
            h+='<div style="font-size:.72rem;color:var(--s400);margin:3px 0 8px">'+ig.desc+'</div>';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.'+ig.action+'()">↓ Export</button>';
            h+='</div>';
        });
        h+='</div>';

        h+='<div style="border-top:1px solid var(--s200);padding-top:14px">';
        h+='<h4 style="font-size:.85rem;font-weight:700;color:var(--s800);margin:0 0 6px">Import Transactions</h4>';
        h+='<p style="font-size:.78rem;color:var(--s400);margin-bottom:8px">Upload a CSV export from your accounting software to sync transactions into Campistry.</p>';
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finImportCSV()">↑ Import CSV</button>';
        h+='<input type="file" id="finImportInput" accept=".csv,.txt" style="display:none">';
        h+='</div>';

        h+='<div style="border-top:1px solid var(--s200);padding-top:14px;margin-top:14px">';
        h+='<h4 style="font-size:.85rem;font-weight:700;color:var(--s800);margin:0 0 4px">API Integration (Coming Soon)</h4>';
        h+='<p style="font-size:.78rem;color:var(--s400)">Direct QuickBooks Online / Xero API sync will be available soon. Contact <a href="mailto:campistryoffice@gmail.com" style="color:var(--me)">campistryoffice@gmail.com</a> to get early access.</p>';
        h+='</div></div>';
    }

    c.innerHTML=h;
}

// Finance actions
function finSetTab(t){_finTab=t;renderAnalytics()}
function finAddStaff(){
    var name=prompt('Staff name:');if(!name)return;
    var role=prompt('Role ('+FIN_ROLES.join(', ')+'):','Counselor');
    var salary=prompt('Salary ($):','');if(!salary)return;
    var type=prompt('Type (seasonal or annual):','seasonal');
    finStaff.push({id:Date.now(),name:name.trim(),role:(role||'Counselor').trim(),salary:parseFloat(salary)||0,type:(type||'seasonal').trim()});
    save();renderAnalytics();toast('Staff added');
}
function finRemoveStaff(i){finStaff.splice(i,1);save();renderAnalytics();toast('Removed')}
function finAddExpense(){
    var desc=prompt('Description:');if(!desc)return;
    var cat=prompt('Category ('+FIN_CATS.join(', ')+'):','Miscellaneous');
    var amount=prompt('Amount ($):','');if(!amount)return;
    var date=prompt('Date (YYYY-MM-DD):',new Date().toISOString().split('T')[0]);
    finExpenses.push({id:Date.now(),desc:desc.trim(),cat:(cat||'Miscellaneous').trim(),amount:parseFloat(amount)||0,date:(date||'').trim()});
    save();renderAnalytics();toast('Expense added');
}
function finRemoveExpense(i){finExpenses.splice(i,1);save();renderAnalytics();toast('Removed')}
function finAddPayment(){
    var family=prompt('Family name:');if(!family)return;
    var amount=prompt('Amount ($):','');if(!amount)return;
    var method=prompt('Method (Credit Card, ACH, Zelle, Check, Payment Plan):','Credit Card');
    var date=prompt('Date (YYYY-MM-DD):',new Date().toISOString().split('T')[0]);
    finPayments.push({id:Date.now(),family:family.trim(),amount:parseFloat(amount)||0,method:(method||'Credit Card').trim(),date:(date||'').trim(),status:'paid'});
    save();renderAnalytics();toast('Payment recorded');
}
function finRemovePayment(i){finPayments.splice(i,1);save();renderAnalytics();toast('Removed')}
function finSetBudget(){
    var rev=prompt('Revenue target ($):',finBudget.revenue||'');
    var pay=prompt('Payroll budget ($):',finBudget.payroll||'');
    var exp=prompt('Expense budget ($):',finBudget.expenses||'');
    finBudget={revenue:parseFloat(rev)||0,payroll:parseFloat(pay)||0,expenses:parseFloat(exp)||0,overdueDays:finBudget.overdueDays||30};
    save();renderAnalytics();toast('Budget targets saved');
}
function finSetOverdue(){
    var days=prompt('Mark accounts overdue after how many days?',finBudget.overdueDays||30);
    if(days===null)return;
    finBudget.overdueDays=parseInt(days)||30;
    save();renderAnalytics();toast('Overdue threshold set to '+finBudget.overdueDays+' days');
}

// ── EXPORT FUNCTIONS ─────────────────────────────────────────
function finExportCSV(){
    var csv='\uFEFFType,Date,Description,Category,Amount,Status,Method\n';
    finPayments.forEach(function(p){csv+='"Payment","'+p.date+'","'+p.family+'","Tuition","'+p.amount+'","'+p.status+'","'+(p.method||'')+'"\n'});
    finStaff.forEach(function(s){csv+='"Staff","","'+s.name+'","'+s.role+'","'+s.salary+'","'+(s.type||'seasonal')+'",""\n'});
    finExpenses.forEach(function(e){csv+='"Expense","'+e.date+'","'+e.desc+'","'+e.cat+'","'+e.amount+'","",""\n'});
    dlFile(csv,'campistry_financials_'+today()+'.csv','text/csv');
    toast('CSV exported');
}

function finExportQB(){
    // QuickBooks Online compatible CSV — includes auto-invoices from enrollments
    var csv='\uFEFFDate,Transaction Type,Num,Name,Account,Amount,Memo,Status\n';
    // Auto-invoices from enrolled campers — uses Camper ID as invoice number
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        csv+='"'+esc(e.appliedDate||'')+'","Invoice","INV-'+camperId+'","'+esc(e.camperName)+'","Tuition Income","'+tuition+'","'+esc(e.session||'')+' tuition","'+esc(e.paymentStatus||'pending')+'"\n';
    });
    // Manual payments
    finPayments.forEach(function(p){
        csv+='"'+p.date+'","Payment","","'+esc(p.family)+'","Tuition Income","'+p.amount+'","'+esc(p.method)+' payment","paid"\n';
    });
    // Expenses
    finExpenses.forEach(function(e){
        csv+='"'+e.date+'","Expense","","'+esc(e.desc)+'","'+esc(e.cat)+'","-'+e.amount+'","",""\n';
    });
    // Payroll
    finStaff.forEach(function(s){
        csv+='","Payroll","","'+esc(s.name)+'","Payroll Expense","-'+s.salary+'","'+esc(s.role)+' ('+esc(s.type||'seasonal')+')",""\n';
    });
    dlFile(csv,'campistry_quickbooks_'+today()+'.csv','text/csv');
    toast('QuickBooks CSV exported');
}

function finExportIIF(){
    // QuickBooks Desktop IIF format — uses Camper ID as reference
    var iif='!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO\tNUM\n!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO\tNUM\n!ENDTRNS\n';
    // Auto-invoices
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        iif+='TRNS\tINVOICE\t'+fmtIIFDate(e.appliedDate)+'\tAccounts Receivable\t'+e.camperName+'\t'+tuition+'\t'+esc(e.session||'')+' tuition\tINV-'+camperId+'\n';
        iif+='SPL\tINVOICE\t'+fmtIIFDate(e.appliedDate)+'\tTuition Income\t'+e.camperName+'\t-'+tuition+'\t\t\n';
        iif+='ENDTRNS\n';
    });
    finPayments.forEach(function(p){
        iif+='TRNS\tDEPOSIT\t'+fmtIIFDate(p.date)+'\tChecking\t'+p.family+'\t'+p.amount+'\tTuition payment\t\n';
        iif+='SPL\tDEPOSIT\t'+fmtIIFDate(p.date)+'\tAccounts Receivable\t'+p.family+'\t-'+p.amount+'\t\t\n';
        iif+='ENDTRNS\n';
    });
    finExpenses.forEach(function(e){
        iif+='TRNS\tCHECK\t'+fmtIIFDate(e.date)+'\tChecking\t'+e.desc+'\t-'+e.amount+'\t'+e.cat+'\n';
        iif+='SPL\tCHECK\t'+fmtIIFDate(e.date)+'\t'+e.cat+'\t'+e.desc+'\t'+e.amount+'\t\n';
        iif+='ENDTRNS\n';
    });
    dlFile(iif,'campistry_quickbooks_desktop_'+today()+'.iif','text/plain');
    toast('IIF file exported for QuickBooks Desktop');
}

function finExportXero(){
    // Xero-compatible CSV
    var csv='\uFEFF*ContactName,EmailAddress,InvoiceNumber,InvoiceDate,DueDate,Total,Description,AccountCode\n';
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        csv+='"'+esc(e.parentName||e.camperName)+'","'+esc(e.parentEmail||'')+'","INV-'+camperId+'","'+esc(e.appliedDate||'')+'","'+esc(e.appliedDate||'')+'","'+tuition+'","'+esc(e.session||'')+' tuition — '+esc(e.camperName)+'","200"\n';
    });
    finPayments.forEach(function(p,i){
        csv+='"'+esc(p.family)+'","","PMT-'+String(i+1).padStart(4,'0')+'","'+p.date+'","'+p.date+'","'+p.amount+'","Payment received via '+esc(p.method)+'","200"\n';
    });
    finExpenses.forEach(function(e,i){
        var camperId2=String(i+1).padStart(4,'0');
        csv+='"'+esc(e.desc)+'","","EXP-'+camperId2+'","'+e.date+'","'+e.date+'","'+e.amount+'","'+esc(e.cat)+'","400"\n';
    });
    dlFile(csv,'campistry_xero_'+today()+'.csv','text/csv');
    toast('Xero CSV exported');
}

function finExportJournal(){
    var csv='\uFEFFDate,Invoice #,Account,Debit,Credit,Description,Reference\n';
    // Auto-invoices
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        csv+='"'+esc(e.appliedDate||'')+'","INV-'+camperId+'","Accounts Receivable","'+tuition+'","","Tuition: '+esc(e.camperName)+'","'+esc(e.session||'')+'"\n';
        csv+='"'+esc(e.appliedDate||'')+'","INV-'+camperId+'","Tuition Revenue","","'+tuition+'","Tuition: '+esc(e.camperName)+'",""\n';
    });
    finPayments.forEach(function(p){
        csv+='"'+p.date+'","","Cash/Bank","'+p.amount+'","","Payment: '+esc(p.family)+'","'+esc(p.method)+'"\n';
        csv+='"'+p.date+'","","Accounts Receivable","","'+p.amount+'","Payment: '+esc(p.family)+'",""\n';
    });
    finExpenses.forEach(function(e){
        csv+='"'+e.date+'","","'+esc(e.cat)+'","'+e.amount+'","","'+esc(e.desc)+'",""\n';
        csv+='"'+e.date+'","","Cash/Bank","","'+e.amount+'","'+esc(e.desc)+'",""\n';
    });
    finStaff.forEach(function(s){
        csv+='","","Payroll Expense","'+s.salary+'","","'+esc(s.name)+' ('+esc(s.role)+')","'+esc(s.type||'seasonal')+'"\n';
        csv+='","","Cash/Bank","","'+s.salary+'","'+esc(s.name)+' salary",""\n';
    });
    dlFile(csv,'campistry_journal_entries_'+today()+'.csv','text/csv');
    toast('Journal entries exported');
}

function finImportCSV(){
    var inp=document.getElementById('finImportInput');
    inp.onchange=function(){
        var file=inp.files[0];if(!file)return;
        var reader=new FileReader();
        reader.onload=function(e){
            var text=e.target.result;
            if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
            var lines=text.split(/\r?\n/).filter(function(l){return l.trim()});
            if(lines.length<2){toast('Empty file','error');return}
            var hdr=lines[0].toLowerCase();
            var imported=0;
            for(var i=1;i<lines.length;i++){
                var cols=lines[i].split(',').map(function(s){return s.trim().replace(/^"|"$/g,'')});
                if(!cols[0])continue;
                // Try to auto-detect: if it has "payment" or positive amount with a name
                var amount=0;
                for(var c=0;c<cols.length;c++){var n=parseFloat(cols[c]);if(!isNaN(n)&&n>0){amount=n;break}}
                if(amount>0){
                    finPayments.push({id:Date.now()+i,family:cols[0]||'Imported',amount:amount,date:cols[1]||today(),method:'Imported',status:'paid'});
                    imported++;
                }
            }
            save();renderAnalytics();toast(imported+' transactions imported');
            inp.value='';
        };
        reader.readAsText(file);
    };
    inp.click();
}

function dlFile(content,filename,type){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:type}));a.download=filename;a.click()}
function today(){return new Date().toISOString().split('T')[0]}
function fmtIIFDate(d){if(!d)return'';var p=d.split('-');return p[1]+'/'+p[2]+'/'+p[0]}

// ═══════════════════════════════════════════════════════════════
// BILLING — Full payment hub
// ═══════════════════════════════════════════════════════════════
function renderBilling(){
    var c=document.getElementById('page-billing');
    // Compute totals from finPayments (real source) + family balances
    var totalCollected=0,totalOutstanding=0,totalInvoiced=0;
    finPayments.forEach(function(p){totalCollected+=Number(p.amount)||0});
    Object.values(families).forEach(function(f){totalOutstanding+=f.balance||0});
    // Auto-invoices from enrollments
    var invoices=[];
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status==='enrolled'||e.status==='accepted'){
            var tuition=Number(e.sessionTuition)||0;
            var discAmt=e.discount?Number(e.discount.amt)||0:0;
            var discPct=e.discount?Number(e.discount.pct)||0:0;
            if(discPct>0) discAmt=Math.round(tuition*discPct/100);
            var net=tuition-discAmt;
            var paid=0;
            finPayments.forEach(function(p){if(p.enrollmentId===id) paid+=Number(p.amount)||0});
            var bal=net-paid;
            totalInvoiced+=net;
            invoices.push({id:id,name:e.camperName||'',session:e.session||'',tuition:tuition,discount:discAmt,net:net,paid:paid,balance:bal,status:bal<=0?'Paid':paid>0?'Partial':'Pending'});
        }
    });

    var h='<div class="sec-hd"><div><h2 class="sec-title">Billing & Payments</h2><p class="sec-desc">'+invoices.length+' invoice'+(invoices.length!==1?'s':'')+' · '+finPayments.length+' payment'+(finPayments.length!==1?'s':'')+'</p></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.openPaymentModal()">+ Record Payment</button></div></div>';

    // Stats row
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:18px">';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--ok)">'+fm(totalCollected)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Collected</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--err)">'+fm(totalInvoiced-totalCollected)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Outstanding</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--s800)">'+fm(totalInvoiced)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Total Invoiced</div></div>';
    var rate=totalInvoiced>0?Math.round(totalCollected/totalInvoiced*100):0;
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--s800)">'+rate+'%</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Collection Rate</div></div>';
    h+='</div>';

    // Invoices table
    if(invoices.length){
        h+='<div class="me-card"><div class="me-card-head"><h3>Invoices</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Camper</th><th>Session</th><th>Tuition</th><th>Discount</th><th>Net</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>';
        invoices.sort(function(a,b){return a.name.localeCompare(b.name)}).forEach(function(inv){
            var sc=inv.status==='Paid'?'ok':inv.status==='Partial'?'warn':'err';
            h+='<tr><td class="bold">'+esc(inv.name)+'</td><td>'+esc(inv.session)+'</td><td>'+fm(inv.tuition)+'</td><td>'+(inv.discount>0?'-'+fm(inv.discount):'—')+'</td><td style="font-weight:600">'+fm(inv.net)+'</td><td style="color:var(--ok);font-weight:600">'+fm(inv.paid)+'</td><td style="color:'+(inv.balance>0?'var(--err)':'var(--ok)')+';font-weight:700">'+fm(inv.balance)+'</td><td>'+bdg(inv.status,sc)+'</td></tr>';
        });
        h+='</tbody></table></div></div>';
    }

    // Recent payments
    if(finPayments.length){
        var sorted=[...finPayments].sort(function(a,b){return(b.date||'').localeCompare(a.date||'')});
        h+='<div class="me-card"><div class="me-card-head"><h3>Recent Payments</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Family / Camper</th><th>Amount</th><th>Method</th><th></th></tr></thead><tbody>';
        sorted.forEach(function(p,i){
            h+='<tr><td>'+esc(p.date||'')+'</td><td class="bold">'+esc(p.family||p.camper||'')+'</td><td style="font-weight:700;color:var(--ok)">'+fm(p.amount)+'</td><td>'+esc(p.method||'')+'</td><td><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.removePayment('+i+')">×</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    } else {
        h+='<div class="me-empty"><h3>No payments recorded yet</h3><p>Click "+ Record Payment" to add one.</p></div>';
    }
    c.innerHTML=h;
}

function openPaymentModal(){
    var names=Object.keys(roster).sort();
    var famNames=Object.values(families).map(function(f){return f.name}).sort();
    var opts=famNames.map(function(n){return'<option value="'+esc(n)+'">'+esc(n)+'</option>'}).join('');
    opts+=names.map(function(n){return'<option value="'+esc(n)+'">'+esc(n)+' (camper)</option>'}).join('');
    var today=new Date().toISOString().split('T')[0];
    var h='<div class="me-modal-form"><div class="me-field"><label>Family or Camper</label><select id="payFamily" class="me-input">'+opts+'</select></div><div class="me-field"><label>Amount ($)</label><input type="number" id="payAmount" class="me-input" placeholder="0.00" step="0.01" min="0"></div><div class="me-field"><label>Date</label><input type="date" id="payDate" class="me-input" value="'+today+'"></div><div class="me-field"><label>Method</label><select id="payMethod" class="me-input"><option>Credit Card</option><option>Check</option><option>Cash</option><option>ACH/Bank Transfer</option><option>Other</option></select></div><div class="me-field"><label>Notes (optional)</label><input type="text" id="payNotes" class="me-input" placeholder="Check #, reference, etc."></div></div>';
    showModal('Record Payment',h,function(){
        var fam=document.getElementById('payFamily').value;
        var amt=parseFloat(document.getElementById('payAmount').value)||0;
        var date=document.getElementById('payDate').value;
        var method=document.getElementById('payMethod').value;
        var notes=document.getElementById('payNotes').value.trim();
        if(!amt){alert('Enter an amount');return}
        finPayments.push({id:'pay_'+Date.now(),family:fam,amount:amt,date:date,method:method,notes:notes,timestamp:Date.now()});
        // Update family balance if found
        var fObj=Object.values(families).find(function(f){return f.name===fam});
        if(fObj){fObj.totalPaid=(fObj.totalPaid||0)+amt;fObj.balance=Math.max(0,(fObj.balance||0)-amt)}
        save();closeModal();renderBilling();toast('Payment recorded');
    });
}
function removePayment(idx){
    if(!confirm('Remove this payment?'))return;
    finPayments.splice(idx,1);save();renderBilling();toast('Payment removed');
}

// ═══════════════════════════════════════════════════════════════
// BROADCASTS — Full messaging system
// ═══════════════════════════════════════════════════════════════
function renderBroadcasts(){
    var c=document.getElementById('page-broadcasts');
    var h='<div class="sec-hd"><div><h2 class="sec-title">Broadcasts & Messaging</h2><p class="sec-desc">'+broadcasts.length+' message'+(broadcasts.length!==1?'s':'')+' sent</p></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.openBroadcastModal()">+ New Broadcast</button></div></div>';

    // Quick stats
    var thisWeek=broadcasts.filter(function(b){return b.timestamp&&Date.now()-b.timestamp<7*86400000}).length;
    h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">';
    h+='<div style="flex:1;min-width:140px;background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800">'+broadcasts.length+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Total Sent</div></div>';
    h+='<div style="flex:1;min-width:140px;background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800">'+thisWeek+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">This Week</div></div>';
    h+='</div>';

    if(broadcasts.length){
        var sorted=[...broadcasts].sort(function(a,b){return(b.timestamp||0)-(a.timestamp||0)});
        h+='<div class="me-card"><div class="me-card-head"><h3>Message History</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Subject</th><th>To</th><th>Method</th><th>Recipients</th><th></th></tr></thead><tbody>';
        sorted.forEach(function(b,i){
            var d=b.timestamp?new Date(b.timestamp).toLocaleDateString():(b.date||'');
            h+='<tr><td>'+esc(d)+'</td><td class="bold">'+esc(b.subject||'(no subject)')+'</td><td>'+esc(b.to||'All')+'</td><td>'+bdg(b.method||'In-App','ok')+'</td><td style="font-weight:600">'+(b.recipientCount||'—')+'</td><td><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.viewBroadcast('+i+')">View</button><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.removeBroadcast('+i+')">×</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    } else {
        h+='<div class="me-empty"><h3>No broadcasts sent yet</h3><p>Send a message to parents, staff, or specific divisions.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.openBroadcastModal()">+ Send First Broadcast</button></div>';
    }
    c.innerHTML=h;
}

function openBroadcastModal(){
    var divOpts=Object.keys(structure).map(function(d){return'<option value="'+esc(d)+'">'+esc(d)+'</option>'}).join('');
    var h='<div class="me-modal-form"><div class="me-field"><label>To</label><select id="bcTo" class="me-input" onchange="document.getElementById(\'bcDivWrap\').style.display=this.value===\'division\'?\'block\':\'none\'"><option value="all">All Families</option><option value="division">Specific Division</option><option value="enrolled">Enrolled Families Only</option><option value="staff">Staff Only</option></select></div>';
    h+='<div id="bcDivWrap" style="display:none"><div class="me-field"><label>Division</label><select id="bcDiv" class="me-input">'+divOpts+'</select></div></div>';
    h+='<div class="me-field"><label>Method</label><select id="bcMethod" class="me-input"><option value="In-App">In-App (Parent Portal)</option><option value="Email">Email</option><option value="SMS">SMS</option><option value="All Channels">All Channels</option></select></div>';
    h+='<div class="me-field"><label>Subject</label><input type="text" id="bcSubject" class="me-input" placeholder="Message subject..."></div>';
    h+='<div class="me-field"><label>Message</label><textarea id="bcBody" class="me-input" rows="6" placeholder="Type your message here..." style="resize:vertical"></textarea></div></div>';
    showModal('New Broadcast',h,function(){
        var to=document.getElementById('bcTo').value;
        var div=document.getElementById('bcDiv')?.value||'';
        var method=document.getElementById('bcMethod').value;
        var subject=document.getElementById('bcSubject').value.trim();
        var body=document.getElementById('bcBody').value.trim();
        if(!subject&&!body){alert('Enter a subject or message');return}
        // Count recipients
        var count=0;
        if(to==='all') count=Object.keys(families).length||Object.keys(roster).length;
        else if(to==='division') count=Object.values(roster).filter(function(c){return c.division===div}).length;
        else if(to==='enrolled') count=Object.values(enrollments).filter(function(e){return e.status==='enrolled'}).length;
        else if(to==='staff') count=finStaff.length;
        var label=to==='division'?div:to==='enrolled'?'Enrolled':to==='staff'?'Staff':'All Families';
        broadcasts.push({subject:subject,body:body,to:label,method:method,recipientCount:count,timestamp:Date.now(),date:new Date().toISOString().split('T')[0]});
        save();closeModal();renderBroadcasts();
        toast('Broadcast sent to '+count+' recipient'+(count!==1?'s':''));
    });
}
function viewBroadcast(idx){
    var sorted=[...broadcasts].sort(function(a,b){return(b.timestamp||0)-(a.timestamp||0)});
    var b=sorted[idx];if(!b)return;
    var d=b.timestamp?new Date(b.timestamp).toLocaleString():(b.date||'');
    var h='<div style="margin-bottom:12px"><div style="font-size:.7rem;color:var(--s400);text-transform:uppercase;font-weight:600">Sent</div><div>'+esc(d)+'</div></div>';
    h+='<div style="margin-bottom:12px"><div style="font-size:.7rem;color:var(--s400);text-transform:uppercase;font-weight:600">To</div><div>'+esc(b.to||'All')+' · '+esc(b.method||'In-App')+' · '+(b.recipientCount||'?')+' recipients</div></div>';
    h+='<div style="margin-bottom:12px"><div style="font-size:.7rem;color:var(--s400);text-transform:uppercase;font-weight:600">Subject</div><div style="font-weight:600;font-size:1rem">'+esc(b.subject||'')+'</div></div>';
    h+='<div style="background:var(--s50);padding:14px;border-radius:var(--r);font-size:.85rem;line-height:1.6;white-space:pre-wrap">'+esc(b.body||'(no body)')+'</div>';
    showModal('Broadcast',h);
}
function removeBroadcast(idx){
    var sorted=[...broadcasts].sort(function(a,b){return(b.timestamp||0)-(a.timestamp||0)});
    if(!confirm('Delete this broadcast?'))return;
    var orig=broadcasts.indexOf(sorted[idx]);
    if(orig>=0) broadcasts.splice(orig,1);
    save();renderBroadcasts();toast('Broadcast removed');
}

// ═══════════════════════════════════════════════════════════════
// FORMS & DOCS — Digital form management
// ═══════════════════════════════════════════════════════════════
var campForms=[];
function loadForms(){var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campForms=(s.campistryMe&&s.campistryMe.forms)||[]}
function saveForms(){var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');if(!s.campistryMe)s.campistryMe={};s.campistryMe.forms=campForms;localStorage.setItem('campGlobalSettings_v1',JSON.stringify(s))}

function renderForms(){
    loadForms();
    var c=document.getElementById('page-forms');
    var completedCount=0,pendingCount=0;
    campForms.forEach(function(f){
        var completed=(f.responses||[]).length;
        var total=Object.keys(roster).length;
        completedCount+=completed;pendingCount+=(total-completed);
    });

    var h='<div class="sec-hd"><div><h2 class="sec-title">Forms & Documents</h2><p class="sec-desc">'+campForms.length+' form'+(campForms.length!==1?'s':'')+' · '+completedCount+' completed, '+pendingCount+' pending</p></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.addForm()">+ Create Form</button></div></div>';

    // Stats
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:18px">';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800">'+campForms.length+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Active Forms</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--ok)">'+completedCount+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Completed</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--warn)">'+pendingCount+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Pending</div></div>';
    h+='</div>';

    if(campForms.length){
        campForms.forEach(function(f,fi){
            var total=Object.keys(roster).length;
            var completed=(f.responses||[]).length;
            var pct=total>0?Math.round(completed/total*100):0;
            var barColor=pct===100?'var(--ok)':pct>50?'var(--warn)':'var(--err)';
            h+='<div class="me-card" style="margin-bottom:12px;padding:16px"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px"><div><div style="font-size:.95rem;font-weight:700">'+esc(f.name)+'</div><div style="font-size:.75rem;color:var(--s400);margin-top:2px">'+esc(f.type||'General')+' · Created '+(f.created?new Date(f.created).toLocaleDateString():'')+'</div></div><div style="display:flex;gap:6px">'+bdg(f.required?'Required':'Optional',f.required?'err':'warn')+'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.viewFormResponses('+fi+')">Responses</button><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.deleteForm('+fi+')">Delete</button></div></div>';
            h+='<div style="display:flex;align-items:center;gap:10px"><div style="flex:1;height:6px;background:var(--s100);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+barColor+';border-radius:3px;transition:width .3s"></div></div><span style="font-size:.75rem;font-weight:700;color:var(--s600)">'+completed+'/'+total+' ('+pct+'%)</span></div>';
            if(f.description) h+='<div style="font-size:.8rem;color:var(--s500);margin-top:6px">'+esc(f.description)+'</div>';
            h+='</div>';
        });
    } else {
        h+='<div class="me-empty"><h3>No forms created yet</h3><p>Create forms for health waivers, permission slips, emergency contacts, and more.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.addForm()">+ Create First Form</button></div>';
    }
    c.innerHTML=h;
}

function addForm(){
    var h='<div class="me-modal-form"><div class="me-field"><label>Form Name</label><input type="text" id="formName" class="me-input" placeholder="e.g., Health Waiver 2026"></div>';
    h+='<div class="me-field"><label>Type</label><select id="formType" class="me-input"><option>Health Form</option><option>Permission Slip</option><option>Liability Waiver</option><option>Emergency Contact</option><option>Media Release</option><option>Custom</option></select></div>';
    h+='<div class="me-field"><label>Description</label><textarea id="formDesc" class="me-input" rows="3" placeholder="What this form is for..." style="resize:vertical"></textarea></div>';
    h+='<div class="me-field"><label>Required?</label><select id="formReq" class="me-input"><option value="1">Yes — must complete before camp</option><option value="0">No — optional</option></select></div>';
    h+='<div class="me-field"><label>Fields (one per line)</label><textarea id="formFields" class="me-input" rows="6" placeholder="Full Name\nDate of Birth\nAllergies\nMedications\nDoctor Name\nDoctor Phone\nInsurance Provider\nParent Signature" style="resize:vertical;font-family:monospace;font-size:.8rem"></textarea></div></div>';
    showModal('Create Form',h,function(){
        var name=document.getElementById('formName').value.trim();
        if(!name){alert('Enter a form name');return}
        var fields=(document.getElementById('formFields').value||'').split('\n').map(function(l){return l.trim()}).filter(Boolean);
        campForms.push({
            id:'form_'+Date.now(),
            name:name,
            type:document.getElementById('formType').value,
            description:document.getElementById('formDesc').value.trim(),
            required:document.getElementById('formReq').value==='1',
            fields:fields,
            responses:[],
            created:Date.now()
        });
        saveForms();save();closeModal();renderForms();toast('Form created');
    });
}
function deleteForm(idx){if(!confirm('Delete this form?'))return;campForms.splice(idx,1);saveForms();save();renderForms();toast('Form deleted')}
function viewFormResponses(idx){
    var f=campForms[idx];if(!f)return;
    var completed=new Set((f.responses||[]).map(function(r){return r.camper}));
    var missing=Object.keys(roster).filter(function(n){return!completed.has(n)}).sort();
    var h='<div style="margin-bottom:14px"><strong>'+esc(f.name)+'</strong> — '+(f.responses||[]).length+' responses</div>';
    if((f.responses||[]).length){
        h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Camper</th><th>Submitted</th><th>Status</th></tr></thead><tbody>';
        f.responses.forEach(function(r){
            h+='<tr><td class="bold">'+esc(r.camper)+'</td><td>'+(r.date?new Date(r.date).toLocaleDateString():'')+'</td><td>'+bdg('Completed','ok')+'</td></tr>';
        });
        h+='</tbody></table></div>';
    }
    if(missing.length){
        h+='<div style="margin-top:14px;font-weight:600;color:var(--err)">Missing ('+missing.length+'):</div><div style="margin-top:6px;font-size:.8rem;color:var(--s600);column-count:2;column-gap:20px">';
        missing.forEach(function(n){h+='<div style="padding:2px 0">'+esc(n)+'</div>'});
        h+='</div>';
    }
    showModal('Form Responses',h);
}

// ═══════════════════════════════════════════════════════════════
// REPORTS — Roster, enrollment, attendance, financial reports
// ═══════════════════════════════════════════════════════════════
function renderReports(){
    var c=document.getElementById('page-reports');
    var h='<div class="sec-hd"><div><h2 class="sec-title">Reports & Export</h2><p class="sec-desc">Generate and download camp reports</p></div></div>';

    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">';

    // Roster report
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Camper Roster</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">Complete roster with divisions, bunks, medical info, contacts</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportRosterReport()">Download CSV</button></div>';

    // Family directory
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Family Directory</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">All families with parent contacts, addresses, billing status</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportFamilyReport()">Download CSV</button></div>';

    // Enrollment pipeline
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Enrollment Pipeline</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">All applications with status, payment, forms completion</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportEnrollmentReport()">Download CSV</button></div>';

    // Division breakdown
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Division Breakdown</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">Camper counts by division, grade, and bunk</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportDivisionReport()">Download CSV</button></div>';

    // Medical summary
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Medical Summary</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">All campers with allergies, medications, dietary restrictions</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportMedicalReport()">Download CSV</button></div>';

    // Financial summary
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Financial Summary</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">Revenue, payments, outstanding balances, payroll, expenses</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportFinancialReport()">Download CSV</button></div>';

    h+='</div>';
    c.innerHTML=h;
}

function dlCsv(name,csv){
    var blob=new Blob(['\uFEFF'+csv],{type:'text/csv'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();toast('Downloaded '+name);
}
function exportRosterReport(){
    var csv='Name,Camper ID,Division,Grade,Bunk,DOB,Gender,School,Parent 1,Parent 1 Phone,Parent 1 Email,Street,City,State,ZIP,Allergies,Medications,Dietary\n';
    Object.entries(roster).sort(function(a,b){return a[0].localeCompare(b[0])}).forEach(function([n,c]){
        csv+=[n,c.camperId||'',c.division||'',c.grade||'',c.bunk||'',c.dob||'',c.gender||'',c.school||'',c.parent1Name||'',c.parent1Phone||'',c.parent1Email||'',c.street||'',c.city||'',c.state||'',c.zip||'',c.allergies||'',c.medications||'',c.dietary||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_roster_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportFamilyReport(){
    var csv='Family,Campers,Primary Parent,Phone,Email,Address,Total Paid,Balance,Status\n';
    Object.values(families).sort(function(a,b){return(a.name||'').localeCompare(b.name||'')}).forEach(function(f){
        var pp=(f.households||[])[0]?.parents?.[0]||{};
        var addr=(f.households||[])[0]?.address||'';
        var status=f.balance>0?'Outstanding':f.totalPaid>0?'Paid':'Pending';
        csv+=[f.name||'',(f.camperIds||[]).join('; '),pp.name||'',pp.phone||'',pp.email||'',addr,f.totalPaid||0,f.balance||0,status].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_families_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportEnrollmentReport(){
    var csv='Camper,Session,Status,Applied Date,Tuition,Discount,Paid,Balance,Payment Status,Forms Done\n';
    Object.values(enrollments).sort(function(a,b){return(a.camperName||'').localeCompare(b.camperName||'')}).forEach(function(e){
        var disc=e.discount?(e.discount.amt||0):0;
        csv+=[e.camperName||'',e.session||'',e.status||'',e.appliedDate||'',e.sessionTuition||0,disc,0,0,e.paymentStatus||'',e.formsCompleted||0].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_enrollment_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportDivisionReport(){
    var csv='Division,Grade,Bunk,Camper Count\n';
    Object.entries(structure).forEach(function([div,d]){
        Object.entries(d.grades||{}).forEach(function([grade,g]){
            (g.bunks||[]).forEach(function(bunk){
                var count=Object.values(roster).filter(function(c){return c.bunk===bunk}).length;
                csv+=[div,grade,bunk,count].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
            });
        });
    });
    dlCsv('campistry_divisions_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportMedicalReport(){
    var csv='Name,Division,Bunk,Allergies,Medications,Dietary,Emergency Contact,Emergency Phone\n';
    Object.entries(roster).filter(function([,c]){return c.allergies||c.medications||c.dietary}).sort(function(a,b){return a[0].localeCompare(b[0])}).forEach(function([n,c]){
        csv+=[n,c.division||'',c.bunk||'',c.allergies||'',c.medications||'',c.dietary||'',c.emergencyName||'',c.emergencyPhone||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_medical_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportFinancialReport(){
    var csv='Type,Date,Description,Amount,Category\n';
    finPayments.forEach(function(p){csv+=['Payment',p.date||'',p.family||'',p.amount||0,p.method||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n'});
    finExpenses.forEach(function(e){csv+=['Expense',e.date||'',e.desc||'','-'+(e.amount||0),e.cat||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n'});
    finStaff.forEach(function(s){csv+=['Payroll','',s.name+' ('+s.role+')','-'+(s.salary||0),s.type||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n'});
    dlCsv('campistry_financial_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════
function renderSettings(){
    var c=document.getElementById('page-settings');
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    var campName=s.camp_name||s.campName||'';
    var h='<div class="sec-hd"><div><h2 class="sec-title">Camp Settings</h2></div></div>';
    h+='<div class="me-card" style="padding:18px;max-width:600px">';
    h+='<div class="me-field"><label style="font-weight:600;font-size:.8rem">Camp Name</label><input type="text" id="settCampName" class="me-input" value="'+esc(campName)+'" placeholder="Your Camp Name"></div>';
    h+='<div style="margin-top:14px"><button class="me-btn me-btn--pri" onclick="CampistryMe.saveSettings()">Save Settings</button></div>';
    h+='</div>';

    // Data management
    h+='<div class="me-card" style="padding:18px;max-width:600px;margin-top:18px"><h3 style="font-size:.9rem;font-weight:700;margin-bottom:12px">Data Management</h3>';
    h+='<div style="display:flex;gap:8px;flex-wrap:wrap">';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportAllData()">Export All Data (JSON)</button>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.importAllData()">Import Data (JSON)</button>';
    h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.clearAllData()">Clear All Data</button>';
    h+='</div></div>';
    c.innerHTML=h;
}
function saveSettings(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    s.camp_name=document.getElementById('settCampName').value.trim();
    s.campName=s.camp_name;
    localStorage.setItem('campGlobalSettings_v1',JSON.stringify(s));
    save();toast('Settings saved');
}
function exportAllData(){
    var s=localStorage.getItem('campGlobalSettings_v1')||'{}';
    var blob=new Blob([s],{type:'application/json'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='campistry_backup_'+new Date().toISOString().split('T')[0]+'.json';a.click();toast('Backup exported');
}
function importAllData(){
    var inp=document.createElement('input');inp.type='file';inp.accept='.json';
    inp.onchange=function(){
        if(!inp.files[0])return;
        var r=new FileReader();r.onload=function(e){
            try{
                var data=JSON.parse(e.target.result);
                if(!confirm('This will replace ALL your data. Are you sure?'))return;
                localStorage.setItem('campGlobalSettings_v1',JSON.stringify(data));
                loadData();render(curPage);toast('Data imported');
            }catch(err){alert('Invalid file: '+err.message)}
        };r.readAsText(inp.files[0]);
    };inp.click();
}
function clearAllData(){
    if(!confirm('This will DELETE ALL camp data. This cannot be undone. Are you absolutely sure?'))return;
    if(!confirm('FINAL WARNING: All campers, families, enrollment, financial data will be erased.'))return;
    localStorage.removeItem('campGlobalSettings_v1');
    loadData();render(curPage);toast('All data cleared');
}

// ── CSV ──────────────────────────────────────────────────────────
var CSV_HEADERS=['First Name','Last Name','Date of Birth','Gender','School Name','School Grade','Teacher','Division','Grade','Bunk','Street Address','City','State','ZIP','Parent 1 Name','Parent 1 Phone','Parent 1 Email','Emergency Name','Emergency Phone','Emergency Relation','Allergies','Medications','Dietary Restrictions'];

function downloadTemplate(){
    // Build template with headers + league columns
    var leagues=getLeagues();var leagueNames=Object.keys(leagues).sort();
    var headers=CSV_HEADERS.slice();
    leagueNames.forEach(function(lg){headers.push('Team: '+lg)});
    var csv='\uFEFF'+headers.map(function(h){return'"'+h+'"'}).join(',')+'\n';
    // Add 2 example rows
    csv+='"John","Smith","2015-03-15","Male","PS 123","3rd","Mrs. Johnson","Juniors","3rd Grade","Bunk 1","123 Main St","Brooklyn","NY","11230","Jane Smith","555-123-4567","jane@email.com","Bob Smith","555-987-6543","Uncle","Peanuts","",""\n';
    csv+='"Sarah","Cohen","2014-07-22","Female","Yeshiva Academy","4th","Rabbi Goldstein","Seniors","4th Grade","Bunk 7","456 Oak Ave","Woodmere","NY","11598","Rachel Cohen","555-222-3333","rachel@email.com","David Cohen","555-444-5555","Father","","Inhaler","Dairy-free"\n';
    csv+='"","","","","","","","","","","","","","","","","","","","","","",""\n';
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download='campistry_camper_template.csv';
    a.click();
    toast('Template downloaded — fill it out and import');
}

function handleCsv(file){
    if(!file)return;
    var reader=new FileReader();
    reader.onload=function(e){
        var text=e.target.result;
        if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
        var lines=text.split(/\r?\n/).filter(function(l){return l.trim()});
        if(!lines.length)return;

        // Parse header row to find column indices
        var hdr=parseCsvLine(lines[0]).map(function(h){return h.toLowerCase().trim()});
        var col=function(names){
            for(var i=0;i<names.length;i++){var idx=hdr.findIndex(function(h){return h.includes(names[i])});if(idx>=0)return idx}
            return-1;
        };

        var iFirst=col(['first name','first']);
        var iLast=col(['last name','last']);
        var iName=col(['name','camper']);
        var iDob=col(['date of birth','dob','birth']);
        var iGender=col(['gender','sex']);
        var iSchool=col(['school name','school']);
        var iSchoolGr=col(['school grade']);
        var iTeacher=col(['teacher']);
        var iDiv=col(['division']);
        var iGrade=col(['grade']);
        var iBunk=col(['bunk','cabin']);
        var iStreet=col(['street','address']);
        var iCity=col(['city']);
        var iState=col(['state']);
        var iZip=col(['zip','postal']);
        var iP1=col(['parent 1 name','parent name','parent1','mother','father']);
        var iP1Ph=col(['parent 1 phone','parent phone','parent1 phone']);
        var iP1Em=col(['parent 1 email','parent email','parent1 email']);
        var iEmN=col(['emergency name','emergency contact']);
        var iEmPh=col(['emergency phone']);
        var iEmR=col(['emergency relation']);
        var iAlg=col(['allergies','allergy']);
        var iMed=col(['medications','medication','meds']);
        var iDiet=col(['dietary','diet']);

        // Find league team columns (headers like "Team: League Name")
        var leagueCols={};
        hdr.forEach(function(h,idx){
            var m=h.match(/^team:\s*(.+)/i);
            if(m)leagueCols[m[1].trim()]=idx;
        });

        var start=1; // skip header
        var rows=[];
        for(var i=start;i<Math.min(lines.length,5001);i++){
            var c=parseCsvLine(lines[i]);
            var firstName=(iFirst>=0?c[iFirst]:'').trim();
            var lastName=(iLast>=0?c[iLast]:'').trim();
            var fullName='';
            if(firstName||lastName){fullName=(firstName+' '+lastName).trim()}
            else if(iName>=0){fullName=(c[iName]||'').trim()}
            if(!fullName)continue;

            var teams={};
            Object.entries(leagueCols).forEach(function([lg,idx]){
                var v=(c[idx]||'').trim();
                if(v)teams[lg]=v;
            });

            rows.push({
                name:fullName,
                dob:iDob>=0?(c[iDob]||'').trim():'',
                gender:iGender>=0?(c[iGender]||'').trim():'',
                school:iSchool>=0?(c[iSchool]||'').trim():'',
                schoolGrade:iSchoolGr>=0?(c[iSchoolGr]||'').trim():'',
                teacher:iTeacher>=0?(c[iTeacher]||'').trim():'',
                division:iDiv>=0?(c[iDiv]||'').trim():'',
                grade:iGrade>=0?(c[iGrade]||'').trim():'',
                bunk:iBunk>=0?(c[iBunk]||'').trim():'',
                street:iStreet>=0?(c[iStreet]||'').trim():'',
                city:iCity>=0?(c[iCity]||'').trim():'',
                state:iState>=0?(c[iState]||'').trim():'',
                zip:iZip>=0?(c[iZip]||'').trim():'',
                parent1Name:iP1>=0?(c[iP1]||'').trim():'',
                parent1Phone:iP1Ph>=0?(c[iP1Ph]||'').trim():'',
                parent1Email:iP1Em>=0?(c[iP1Em]||'').trim():'',
                emergencyName:iEmN>=0?(c[iEmN]||'').trim():'',
                emergencyPhone:iEmPh>=0?(c[iEmPh]||'').trim():'',
                emergencyRel:iEmR>=0?(c[iEmR]||'').trim():'',
                allergies:iAlg>=0?(c[iAlg]||'').trim():'',
                medications:iMed>=0?(c[iMed]||'').trim():'',
                dietary:iDiet>=0?(c[iDiet]||'').trim():'',
                teams:teams
            });
        }

        if(rows.length){
            var pvEl=document.getElementById('csvPV');
            if(pvEl){pvEl.style.display='block';pvEl.innerHTML='<div style="font-weight:600;margin:8px 0 4px">'+rows.length+' campers found</div><div style="font-size:.75rem;color:var(--s400)">Columns detected: '+hdr.filter(function(h){return h}).length+'</div>'}
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
    var added=0,updated=0,newDivisions=0,newGrades=0,newBunks=0,newFamilies=0;

    // ═══ WIPE EXISTING DATA — CSV is the new source of truth ═══
    roster={};
    structure={};
    families={};
    bunkAsgn={};
    nextCamperId=1;
    // Clear Go addresses too
    try{var goRaw=localStorage.getItem('campistry_go_data');var goData=goRaw?JSON.parse(goRaw):{};goData.addresses={};localStorage.setItem('campistry_go_data',JSON.stringify(goData))}catch(e){}
    // Also wipe the cloud settings so stale data doesn't survive
    try{
        var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        g.campStructure={};
        if(!g.app1)g.app1={};
        g.app1.camperRoster={};
        g.app1.divisions={};
        if(!g.campistryMe)g.campistryMe={};
        g.campistryMe.families={};
        g.campistryMe.bunkAssignments={};
        g.campistryMe.nextCamperId=1;
        localStorage.setItem('campGlobalSettings_v1',JSON.stringify(g));
    }catch(e){}

    // ═══ PASS 1: Build camp structure from CSV data ═══
    rows.forEach(function(r){
        if(r.division){
            if(!structure[r.division]){
                structure[r.division]={color:COLORS[Object.keys(structure).length%COLORS.length],grades:{}};
                newDivisions++;
            }
            if(r.grade&&!structure[r.division].grades[r.grade]){
                structure[r.division].grades[r.grade]={bunks:[]};
                newGrades++;
            }
            if(r.grade&&r.bunk&&structure[r.division].grades[r.grade]&&structure[r.division].grades[r.grade].bunks.indexOf(r.bunk)===-1){
                structure[r.division].grades[r.grade].bunks.push(r.bunk);
                newBunks++;
            }
        }
    });

    // ═══ PASS 2: Create campers ═══
    rows.forEach(function(r){
        added++;
        var existingId=nextCamperId;nextCamperId++;

        roster[r.name]={
            camperId:existingId,
            dob:r.dob||'',
            gender:r.gender||'',
            school:r.school||'',
            schoolGrade:r.schoolGrade||'',
            teacher:r.teacher||'',
            division:r.division||'',
            grade:r.grade||'',
            bunk:r.bunk||'',
            street:r.street||'',
            city:r.city||'',
            state:r.state||'',
            zip:r.zip||'',
            parent1Name:r.parent1Name||'',
            parent1Phone:r.parent1Phone||'',
            parent1Email:r.parent1Email||'',
            emergencyName:r.emergencyName||'',
            emergencyPhone:r.emergencyPhone||'',
            emergencyRel:r.emergencyRel||'',
            allergies:r.allergies||'',
            medications:r.medications||'',
            dietary:r.dietary||'',
            teams:r.teams||{},
            team:Object.values(r.teams)[0]||''
        };

        // Sync address to Go
        if(roster[r.name].street)syncAddressToGo(r.name,roster[r.name]);
    });

    // ═══ PASS 3: Auto-generate families from parent data ═══
    // Group campers by last name + parent name to create family units
    var familyMap={};
    rows.forEach(function(r){
        if(!r.parent1Name)return;
        var lastName=r.name.split(' ').pop();
        // Key by last name + parent name to handle split households
        var famKey='fam_'+lastName.toLowerCase().replace(/[^a-z0-9]/g,'');
        if(!familyMap[famKey]){
            familyMap[famKey]={
                lastName:lastName,
                parentName:r.parent1Name,
                parentPhone:r.parent1Phone||'',
                parentEmail:r.parent1Email||'',
                address:[r.street,r.city,r.state,r.zip].filter(Boolean).join(', '),
                campers:[]
            };
        }
        if(familyMap[famKey].campers.indexOf(r.name)===-1){
            familyMap[famKey].campers.push(r.name);
        }
    });

    Object.entries(familyMap).forEach(function([famKey,fam]){
        if(families[famKey]){
            // Update existing family — add any new campers
            fam.campers.forEach(function(cn){
                if(families[famKey].camperIds.indexOf(cn)===-1)families[famKey].camperIds.push(cn);
            });
        }else{
            // Create new family
            families[famKey]={
                name:fam.lastName+' Family',
                households:[{
                    label:'Primary',
                    parents:[{name:fam.parentName,phone:fam.parentPhone,email:fam.parentEmail,relation:'Parent'}],
                    address:fam.address,
                    billingContact:true
                }],
                camperIds:fam.campers,
                balance:0,totalPaid:0,
                notes:'Auto-created from CSV import'
            };
            newFamilies++;
        }
    });

    // ═══ PASS 4: Auto-populate bunk assignments ═══
    rows.forEach(function(r){
        if(r.bunk&&r.name){
            if(!bunkAsgn[r.bunk])bunkAsgn[r.bunk]=[];
            if(bunkAsgn[r.bunk].indexOf(r.name)===-1)bunkAsgn[r.bunk].push(r.name);
        }
    });

    // ═══ SAVE & REPORT ═══
    save();closeModal('csvModal');render(curPage);

    // Build summary
    var summary=added+' campers imported';
    if(newDivisions>0)summary+=', '+newDivisions+' division'+(newDivisions>1?'s':'');
    if(newGrades>0)summary+=', '+newGrades+' grade'+(newGrades>1?'s':'');
    if(newBunks>0)summary+=', '+newBunks+' bunk'+(newBunks>1?'s':'');
    if(newFamilies>0)summary+=', '+newFamilies+' famil'+(newFamilies>1?'ies':'y');
    summary+=' — previous data replaced';
    toast(summary);
    console.log('[Me] CSV import (full overwrite):',summary);
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
// Photo upload (stores as base64 data URL in camper record)
function uploadPhoto(camperName){
    var inp=document.createElement('input');
    inp.type='file';inp.accept='image/*';
    inp.onchange=function(){
        var file=inp.files[0];if(!file)return;
        if(file.size>2*1024*1024){toast('Photo must be under 2MB','error');return}
        var reader=new FileReader();
        reader.onload=function(e){
            if(roster[camperName]){
                roster[camperName].photoUrl=e.target.result;
                save();
                viewCamper(camperName); // refresh the modal
                toast('Photo added');
            }
        };
        reader.readAsDataURL(file);
    };
    inp.click();
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();

window.CampistryMe={
    nav:nav,closeModal:closeModal,
    viewCamper:viewCamper,editCamper:editCamper,addCamper:addCamper,
    addFamily:function(){openFamilyForm(null)},editFamily:function(id){openFamilyForm(id)},
    addDiv:function(){openDivForm(null)},editDiv:function(n){openDivForm(n)},deleteDiv:deleteDiv,
    openCsv:function(){openModal('csvModal')},exportCsv:exportCsv,downloadTemplate:downloadTemplate,
    bbDrop:bbDrop,autoAssign:autoAssign,clearBunks:clearBunks,
    addSession:addSession,deleteSession:deleteSession,editSession:editSession,toggleSessionReg:toggleSessionReg,copyRegLink:copyRegLink,addApplication:addApplication,autoPromoteWaitlist:autoPromoteWaitlist,
    viewApplication:viewApplication,updateEnrollStatus:updateEnrollStatus,enrollCamper:enrollCamper,
    saveAppNote:saveAppNote,printApplication:printApplication,
    openFormConfig:openFormConfig,saveFormConfig:saveFormConfig,addCustomQ:addCustomQ,addPromoRow:addPromoRow,
    finSetTab:finSetTab,finAddStaff:finAddStaff,finRemoveStaff:finRemoveStaff,
    finAddExpense:finAddExpense,finRemoveExpense:finRemoveExpense,
    finAddPayment:finAddPayment,finRemovePayment:finRemovePayment,
    finSetBudget:finSetBudget,finSetOverdue:finSetOverdue,
    finExportCSV:finExportCSV,finExportQB:finExportQB,finExportIIF:finExportIIF,
    finExportXero:finExportXero,finExportJournal:finExportJournal,finImportCSV:finImportCSV,
    _pickColor:_pickColor,_addGradeRow:_addGradeRow,
    uploadPhoto:uploadPhoto,
    // Billing
    openPaymentModal:openPaymentModal,removePayment:removePayment,
    // Broadcasts
    openBroadcastModal:openBroadcastModal,viewBroadcast:viewBroadcast,removeBroadcast:removeBroadcast,
    // Forms & Docs
    addForm:addForm,deleteForm:deleteForm,viewFormResponses:viewFormResponses,
    // Reports
    exportRosterReport:exportRosterReport,exportFamilyReport:exportFamilyReport,
    exportEnrollmentReport:exportEnrollmentReport,exportDivisionReport:exportDivisionReport,
    exportMedicalReport:exportMedicalReport,exportFinancialReport:exportFinancialReport,
    // Settings
    saveSettings:saveSettings,exportAllData:exportAllData,importAllData:importAllData,clearAllData:clearAllData,
};
})();
