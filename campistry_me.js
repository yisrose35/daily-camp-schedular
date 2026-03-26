// campistry_me.js — Campistry Me Engine (Premium Rebuild)
(function(){
'use strict';
console.log('📋 Campistry Me loading...');

var COLORS=['#D97706','#147D91','#8B5CF6','#0EA5E9','#10B981','#F43F5E','#EC4899','#84CC16','#6366F1','#14B8A6'];
var AV_BG=['#147D91','#6366F1','#0EA5E9','#10B981','#F43F5E','#8B5CF6','#D97706'];

var structure={}, roster={}, families={}, payments=[], broadcasts=[], bunkAsgn={};
var enrollments={}, sessions=[], enrollSettings={};
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
        var ex=(g.app1.divisions)||{},m={};
        Object.entries(structure).forEach(function([d,dd]){var b=[];Object.values(dd.grades||{}).forEach(function(gr){(gr.bunks||[]).forEach(function(bk){b.push(bk)})});m[d]=Object.assign({},ex[d]||{},{color:dd.color,bunks:b})});
        Object.keys(ex).forEach(function(d){if(!m[d])m[d]=ex[d]});
        g.app1.divisions=m;
        g.campistryMe={families:families,payments:payments,broadcasts:broadcasts,bunkAssignments:bunkAsgn,nextCamperId:nextCamperId,enrollments:enrollments,sessions:sessions,enrollSettings:enrollSettings};
        g.updated_at=new Date().toISOString();
        var json=JSON.stringify(g);
        localStorage.setItem('campGlobalSettings_v1',json);
        // Also write to backup keys that other scripts may read
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE',json);
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
            window.saveGlobalSettings('campStructure',structure);
            window.saveGlobalSettings('app1',g.app1);
            window.saveGlobalSettings('campistryMe',g.campistryMe);
        }else if(typeof window.forceSyncToCloud==='function')window.forceSyncToCloud();
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
function closeModal(id){var e=document.getElementById(id);if(e)e.style.display='none'}
function setupModals(){document.querySelectorAll('.me-overlay').forEach(function(o){o.addEventListener('mousedown',function(e){if(e.target===o)closeModal(o.id)})});
    var dz=document.getElementById('csvDZ'),fi=document.getElementById('csvFI');
    if(dz&&fi){dz.onclick=function(){fi.click()};dz.ondragover=function(e){e.preventDefault();dz.classList.add('dragover')};dz.ondragleave=function(){dz.classList.remove('dragover')};dz.ondrop=function(e){e.preventDefault();dz.classList.remove('dragover');handleCsv(e.dataTransfer.files[0])};fi.onchange=function(e){handleCsv(e.target.files[0])}}
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
    var m={families:renderFamilies,campers:renderCampers,structure:renderStructure,bunkbuilder:renderBB,enrollment:renderEnrollment,billing:renderBilling,broadcasts:renderBroadcasts};
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
    try{
        // Write to Go's direct localStorage store
        var goRaw=localStorage.getItem('campistry_go_data');
        var goData=goRaw?JSON.parse(goRaw):{};
        if(!goData.addresses)goData.addresses={};
        var existing=goData.addresses[camperName]||{};
        var newAddr={
            street:camperData.street||'',
            city:camperData.city||'',
            state:camperData.state||'NY',
            zip:camperData.zip||'',
            lat:existing.lat||null,
            lng:existing.lng||null,
            geocoded:false,
            transport:existing.transport||'bus',
            rideWith:existing.rideWith||''
        };
        // Preserve geocode if address unchanged
        if(existing.street===camperData.street&&existing.city===camperData.city&&existing.geocoded){
            newAddr.lat=existing.lat;newAddr.lng=existing.lng;newAddr.geocoded=true;
        }
        goData.addresses[camperName]=newAddr;
        localStorage.setItem('campistry_go_data',JSON.stringify(goData));

        // Also write into the cloud-synced global settings path (Go checks this first)
        var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        if(!g.campistryGo)g.campistryGo={};
        if(!g.campistryGo.addresses)g.campistryGo.addresses={};
        var existingCloud=g.campistryGo.addresses[camperName]||{};
        g.campistryGo.addresses[camperName]={
            street:camperData.street||'',city:camperData.city||'',
            state:camperData.state||'NY',zip:camperData.zip||'',
            lat:existingCloud.lat||null,lng:existingCloud.lng||null,
            geocoded:existingCloud.geocoded||false,
            transport:existingCloud.transport||'bus',rideWith:existingCloud.rideWith||''
        };
        if(existingCloud.street===camperData.street&&existingCloud.city===camperData.city&&existingCloud.geocoded){
            g.campistryGo.addresses[camperName].lat=existingCloud.lat;
            g.campistryGo.addresses[camperName].lng=existingCloud.lng;
            g.campistryGo.addresses[camperName].geocoded=true;
        }
        localStorage.setItem('campGlobalSettings_v1',JSON.stringify(g));

        console.log('[Me→Go] Address synced for',camperName,':',camperData.street,camperData.city);
    }catch(e){console.warn('[Me] Go sync error:',e)}
}

// Bulk sync all addresses to Go on load
function syncAllAddressesToGo(){
    Object.entries(roster).forEach(function([name,data]){
        if(data.street)syncAddressToGo(name,data);
    });
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
    h+='<a href="campistry_register.html" target="_blank" class="me-btn me-btn--sec me-btn--sm" style="text-decoration:none">Preview Form</a></div>';

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
    b+=row('Additional Notes',e.notes);

    b+=sec('Payment');
    b+=row('Session',e.session);
    b+=row('Tuition',e.sessionTuition?fm(e.sessionTuition):'—');
    b+=row('Payment Method',e.paymentMethod||'Not selected');
    b+=row('Payment Status',e.paymentStatus||'pending');

    document.getElementById('avBody').innerHTML=b;

    // Footer buttons
    var f='';
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

function addSession(){
    var name=prompt('Session name (e.g., "Summer 2026 — Full Season"):');
    if(!name||!name.trim())return;
    var dates=prompt('Date range (e.g., "June 22 – August 14"):','');
    var cap=prompt('Capacity (leave blank for unlimited):','');
    var tuition=prompt('Tuition amount ($):','');
    var earlyBird=prompt('Early bird price ($ — leave blank for none):','');
    var earlyBirdDeadline='';
    if(earlyBird)earlyBirdDeadline=prompt('Early bird deadline (YYYY-MM-DD):','');
    sessions.push({name:name.trim(),dates:(dates||'').trim(),capacity:cap?parseInt(cap):0,tuition:tuition?parseFloat(tuition):0,earlyBird:earlyBird?parseFloat(earlyBird):0,earlyBirdDeadline:(earlyBirdDeadline||'').trim(),registrationOpen:true});
    save();renderEnrollment();toast('Session created');
}

function editSession(idx){
    var s=sessions[idx];if(!s)return;
    var name=prompt('Session name:',s.name);if(!name)return;
    var dates=prompt('Date range:',s.dates||'');
    var cap=prompt('Capacity:',s.capacity||'');
    var tuition=prompt('Tuition ($):',s.tuition||'');
    var earlyBird=prompt('Early bird price ($):',s.earlyBird||'');
    var earlyBirdDeadline=prompt('Early bird deadline (YYYY-MM-DD):',s.earlyBirdDeadline||'');
    sessions[idx]={name:name.trim(),dates:(dates||'').trim(),capacity:cap?parseInt(cap):0,tuition:tuition?parseFloat(tuition):0,earlyBird:earlyBird?parseFloat(earlyBird):0,earlyBirdDeadline:(earlyBirdDeadline||'').trim(),registrationOpen:s.registrationOpen!==false};
    save();renderEnrollment();toast('Session updated');
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
    // Gather basic info
    var camperName=prompt('Camper full name:');if(!camperName||!camperName.trim())return;
    var parentName=prompt('Parent/Guardian name:','');
    var parentEmail=prompt('Parent email:','');
    var parentPhone=prompt('Parent phone:','');
    var session='';
    if(sessions.length){
        var opts=sessions.map(function(s,i){return(i+1)+'. '+s.name}).join('\n');
        var pick=prompt('Select session:\n'+opts+'\n\nEnter number:','1');
        var idx=parseInt(pick)-1;
        if(idx>=0&&idx<sessions.length)session=sessions[idx].name;
    }
    var id='enr_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
    enrollments[id]={
        camperName:camperName.trim(),
        parentName:(parentName||'').trim(),
        parentEmail:(parentEmail||'').trim(),
        parentPhone:(parentPhone||'').trim(),
        session:session,
        status:'applied',
        appliedDate:new Date().toISOString().split('T')[0],
        formsRequired:3,
        formsCompleted:0,
        paymentStatus:'pending',
        paymentAmount:0,
        notes:''
    };
    save();renderEnrollment();toast('Application received');
}

function updateEnrollStatus(id,status){
    if(!enrollments[id])return;
    enrollments[id].status=status;
    save();renderEnrollment();toast('Status updated to '+status);
}

function enrollCamper(id){
    var e=enrollments[id];if(!e)return;
    e.status='enrolled';
    // Auto-create camper in roster if not exists
    if(!roster[e.camperName]){
        var newId=nextCamperId;nextCamperId++;
        roster[e.camperName]={
            camperId:newId,dob:'',gender:'',school:'',schoolGrade:'',teacher:'',
            division:'',grade:'',bunk:'',teams:{},team:'',
            street:'',city:'',state:'',zip:'',
            parent1Name:e.parentName||'',parent1Phone:e.parentPhone||'',parent1Email:e.parentEmail||'',
            emergencyName:'',emergencyPhone:'',emergencyRel:'',
            allergies:'',medications:'',dietary:''
        };
        toast('Enrolled — camper added to roster');
    }else{
        toast('Enrolled — camper already in roster');
    }
    // Auto-create family if not exists
    var lastName=e.camperName.split(' ').pop();
    var famKey='fam_'+lastName.toLowerCase().replace(/[^a-z0-9]/g,'');
    if(!families[famKey]&&e.parentName){
        families[famKey]={
            name:lastName+' Family',
            households:[{label:'Primary',parents:[{name:e.parentName,phone:e.parentPhone||'',email:e.parentEmail||'',relation:'Parent'}],address:'',billingContact:true}],
            camperIds:[e.camperName],
            balance:0,totalPaid:0,notes:'Enrolled via registration'
        };
    }else if(families[famKey]&&families[famKey].camperIds.indexOf(e.camperName)<0){
        families[famKey].camperIds.push(e.camperName);
    }
    save();renderEnrollment();
}

function renderBilling(){var c=document.getElementById('page-billing');var tp=0,td=0;Object.values(families).forEach(function(f){tp+=f.totalPaid||0;td+=f.balance||0});c.innerHTML='<div class="sec-hd"><div><h2 class="sec-title">Billing</h2></div></div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px"><div style="flex:1;min-width:120px;background:#fff;border-radius:var(--r);padding:12px;border:1px solid var(--s200)"><div style="font-size:1.1rem;font-weight:700;color:var(--s800)">'+fm(tp)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Collected</div></div><div style="flex:1;min-width:120px;background:#fff;border-radius:var(--r);padding:12px;border:1px solid var(--s200)"><div style="font-size:1.1rem;font-weight:700;color:var(--s800)">'+fm(td)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Outstanding</div></div></div>'+(payments.length?'<div class="me-card"><div class="me-card-head"><h3>Payments</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Family</th><th>Amount</th><th>Status</th></tr></thead><tbody>'+payments.map(function(p){var f=families[p.familyId];return'<tr><td>'+(p.date||'')+'</td><td class="bold">'+(f?esc(f.name):'')+'</td><td style="font-weight:600">'+fm(p.amount)+'</td><td>'+bdg(p.status||'',p.status==='Paid'?'ok':'warn')+'</td></tr>'}).join('')+'</tbody></table></div></div>':'<div class="me-empty"><h3>No payments</h3></div>')}
function renderBroadcasts(){var c=document.getElementById('page-broadcasts');c.innerHTML='<div class="sec-hd"><div><h2 class="sec-title">Broadcasts</h2></div><div class="sec-actions"><button class="me-btn me-btn--pri">+ New</button></div></div>'+(broadcasts.length?broadcasts.map(function(b){return'<div class="me-card" style="margin-bottom:8px;padding:14px"><div style="font-size:.85rem;font-weight:600">'+esc(b.subject)+'</div><div style="font-size:.7rem;color:var(--s400);margin-top:2px">'+esc(b.to||'')+' · '+esc(b.method||'')+'</div></div>'}).join(''):'<div class="me-empty"><h3>No broadcasts</h3></div>')}
function renderSoon(p){var t={forms:'Forms & Docs',reports:'Reports',settings:'Settings'};document.getElementById('page-'+p).innerHTML='<div class="me-soon"><h2>'+(t[p]||p)+'</h2><p>Coming soon.</p></div>'}

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
    var added=0;
    rows.forEach(function(r){
        // Create structure if needed
        if(r.division&&!structure[r.division])structure[r.division]={color:COLORS[Object.keys(structure).length%COLORS.length],grades:{}};
        if(r.division&&r.grade&&structure[r.division]&&!structure[r.division].grades[r.grade])structure[r.division].grades[r.grade]={bunks:[]};
        if(r.division&&r.grade&&r.bunk&&structure[r.division]&&structure[r.division].grades[r.grade]&&structure[r.division].grades[r.grade].bunks.indexOf(r.bunk)===-1)structure[r.division].grades[r.grade].bunks.push(r.bunk);

        var isNew=!roster[r.name];
        if(isNew)added++;
        var existingId=roster[r.name]?roster[r.name].camperId:null;
        if(!existingId){existingId=nextCamperId;nextCamperId++}

        // Merge: preserve existing data, overwrite with non-empty imported fields
        var existing=roster[r.name]||{};
        roster[r.name]={
            camperId:existingId,
            dob:r.dob||existing.dob||'',
            gender:r.gender||existing.gender||'',
            school:r.school||existing.school||'',
            schoolGrade:r.schoolGrade||existing.schoolGrade||'',
            teacher:r.teacher||existing.teacher||'',
            division:r.division||existing.division||'',
            grade:r.grade||existing.grade||'',
            bunk:r.bunk||existing.bunk||'',
            street:r.street||existing.street||'',
            city:r.city||existing.city||'',
            state:r.state||existing.state||'',
            zip:r.zip||existing.zip||'',
            parent1Name:r.parent1Name||existing.parent1Name||'',
            parent1Phone:r.parent1Phone||existing.parent1Phone||'',
            parent1Email:r.parent1Email||existing.parent1Email||'',
            emergencyName:r.emergencyName||existing.emergencyName||'',
            emergencyPhone:r.emergencyPhone||existing.emergencyPhone||'',
            emergencyRel:r.emergencyRel||existing.emergencyRel||'',
            allergies:r.allergies||existing.allergies||'',
            medications:r.medications||existing.medications||'',
            dietary:r.dietary||existing.dietary||'',
            teams:Object.keys(r.teams).length?r.teams:(existing.teams||{}),
            team:Object.values(r.teams)[0]||existing.team||''
        };
        // Sync address to Go
        if(roster[r.name].street)syncAddressToGo(r.name,roster[r.name]);
    });
    save();closeModal('csvModal');render(curPage);
    toast(added+' added, '+(rows.length-added)+' updated');
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
    addSession:addSession,deleteSession:deleteSession,editSession:editSession,toggleSessionReg:toggleSessionReg,copyRegLink:copyRegLink,addApplication:addApplication,
    viewApplication:viewApplication,updateEnrollStatus:updateEnrollStatus,enrollCamper:enrollCamper,
    _pickColor:_pickColor,_addGradeRow:_addGradeRow,
    uploadPhoto:uploadPhoto,
};
})();
