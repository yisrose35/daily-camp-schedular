// campistry_me.js — Campistry Me Engine (Premium Rebuild)
(function(){
'use strict';
console.log('📋 Campistry Me loading...');

var COLORS=['#D97706','#147D91','#8B5CF6','#0EA5E9','#10B981','#F43F5E','#EC4899','#84CC16','#6366F1','#14B8A6'];
var AV_BG=['#147D91','#6366F1','#0EA5E9','#10B981','#F43F5E','#8B5CF6','#D97706'];

var structure={}, roster={}, families={}, payments=[], broadcasts=[], bunkAsgn={};
var curPage='families', editingCamper=null, editingDiv=null, editingFam=null;
var nextCamperId=1;

// ═══ INIT ════════════════════════════════════════════════════════
function init(){
    loadData(); setupSidebar(); setupSearch(); setupModals();
    syncAllAddressesToGo();
    nav('families');
    console.log('📋 Me ready:',Object.keys(roster).length,'campers');
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
        var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        g.campStructure=structure;
        if(!g.app1)g.app1={};
        g.app1.camperRoster=roster;
        var ex=(g.app1.divisions)||{},m={};
        Object.entries(structure).forEach(function([d,dd]){var b=[];Object.values(dd.grades||{}).forEach(function(gr){(gr.bunks||[]).forEach(function(bk){b.push(bk)})});m[d]=Object.assign({},ex[d]||{},{color:dd.color,bunks:b})});
        Object.keys(ex).forEach(function(d){if(!m[d])m[d]=ex[d]});
        g.app1.divisions=m;
        g.campistryMe={families:families,payments:payments,broadcasts:broadcasts,bunkAssignments:bunkAsgn,nextCamperId:nextCamperId};
        g.updated_at=new Date().toISOString();
        localStorage.setItem('campGlobalSettings_v1',JSON.stringify(g));
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
    var m={families:renderFamilies,campers:renderCampers,structure:renderStructure,bunkbuilder:renderBB,billing:renderBilling,broadcasts:renderBroadcasts};
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
        (f.camperIds||[]).forEach(function(cn){h+='<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:6px;border:1px solid var(--s200);font-size:.7rem;font-weight:600;cursor:pointer" onclick="CampistryMe.viewCamper(\''+je(cn)+'\')">'+av(cn,'s')+' '+esc(cn.split(' ')[0])+'</span>'});
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
    var h='<div class="sec-hd"><div><h2 class="sec-title">Campers</h2><p class="sec-desc">'+total+' total</p></div><div class="sec-actions"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openCsv()">Import CSV</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportCsv()">Export</button><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add Camper</button></div></div>';
    if(!entries.length){h+='<div class="me-empty"><h3>No campers yet</h3><p>Add campers or import from CSV.</p><div style="display:flex;gap:6px;justify-content:center"><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add</button><button class="me-btn me-btn--sec" onclick="CampistryMe.openCsv()">Import</button></div></div>'}
    else{
        h+='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th style="width:32px"></th><th style="width:50px">ID</th><th>Name</th><th>Age</th><th>School</th><th>Division</th><th>Bunk</th><th>Medical</th><th style="width:60px"></th></tr></thead><tbody>';
        entries.forEach(function([n,d]){
            var hasMed=!!(d.allergies||d.medications);
            var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'—';
            h+='<tr class="click" onclick="CampistryMe.viewCamper(\''+je(n)+'\')">'+'<td>'+av(n,'s')+'</td><td style="font-family:monospace;font-size:.75rem;color:var(--s400)">#'+esc(idStr)+'</td><td class="bold">'+esc(n)+'</td><td>'+(d.dob?age(d.dob):'—')+'</td><td>'+esc(d.school||'—')+'</td><td>'+(d.division?dtag(d.division):'<span style="color:var(--s300)">—</span>')+'</td><td>'+esc(d.bunk||'—')+'</td><td>'+(hasMed?'<span style="color:var(--err);font-size:.7rem;font-weight:600">⚠ '+esc((d.allergies||d.medications||'').split(',')[0])+'</span>':'<span style="color:var(--s300)">—</span>')+'</td><td style="text-align:right" onclick="event.stopPropagation()"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editCamper(\''+je(n)+'\')">Edit</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    }
    c.innerHTML=h;
}

// Camper view (centered modal)
function viewCamper(n){
    var d=roster[n];if(!d)return;
    var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'—';
    document.getElementById('cvHead').innerHTML='<div class="cv-hd">'+av(n,'l')+'<div><h3 class="cv-name">'+esc(n)+'</h3><div class="cv-tags"><span class="badge badge-gray" style="font-family:monospace">#'+esc(idStr)+'</span>'+(d.division?dtag(d.division):'')+(d.bunk?' '+bdg(d.bunk,'gray'):'')+'</div></div></div>';
    var b='<div class="cv-sec">Personal</div>';
    if(d.dob)b+=cvR('Born',new Date(d.dob+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})+' (age '+age(d.dob)+')');
    b+=cvR('Gender',d.gender);b+=cvR('School',d.school);b+=cvR('School Grade',d.schoolGrade);
    // Teams
    var teams=d.teams||{};var teamKeys=Object.keys(teams);
    if(d.team&&!teamKeys.length)b+=cvR('Team',d.team);
    else if(teamKeys.length){b+='<div class="cv-sec">League Teams</div>';teamKeys.forEach(function(lg){b+=cvR(lg,teams[lg])})}
    b+='<div class="cv-sec">Medical Summary</div>';
    if(d.allergies)b+=cvR('Allergies',d.allergies,true);
    if(d.medications)b+=cvR('Medications',d.medications,true);
    if(d.dietary)b+=cvR('Dietary',d.dietary);
    if(!d.allergies&&!d.medications&&!d.dietary)b+='<div style="font-size:.8rem;color:var(--ok);padding:2px 0">✓ No medical flags</div>';
    b+='<div class="cv-health" onclick="toast(\'Campistry Health coming soon\',\'error\')">Open in Campistry Health →</div>';
    b+='<div class="cv-sec">Emergency Contact</div>';
    if(d.emergencyName){b+=cvR('Contact',d.emergencyName+(d.emergencyRel?' ('+d.emergencyRel+')':''));if(d.emergencyPhone)b+=cvR('Phone','<a href="tel:'+esc(d.emergencyPhone)+'">'+esc(d.emergencyPhone)+'</a>')}
    else b+='<div style="font-size:.8rem;color:var(--err);font-style:italic">Not on file</div>';
    b+='<div class="cv-sec">Parent/Guardian</div>';
    b+=cvR('Parent 1',d.parent1Name);if(d.parent1Phone)b+=cvR('Phone','<a href="tel:'+esc(d.parent1Phone)+'">'+esc(d.parent1Phone)+'</a>');if(d.parent1Email)b+=cvR('Email','<a href="mailto:'+esc(d.parent1Email)+'">'+esc(d.parent1Email)+'</a>');
    if(d.street){var fullAddr=[d.street,d.city,d.state,d.zip].filter(Boolean).join(', ');b+=cvR('Address',fullAddr)}
    document.getElementById('cvBody').innerHTML=b;
    document.getElementById('cvEditBtn').onclick=function(){closeModal('camperViewModal');editCamper(n)};
    openModal('camperViewModal');
}
function cvR(l,v,w){if(!v)return'';return'<div class="cv-row"><span class="cv-lbl">'+esc(l)+'</span><span class="cv-val'+(w?' cv-warn':'')+'">'+v+'</span></div>'}

// Camper edit
function editCamper(n){
    editingCamper=n;
    var d=n?roster[n]||{}:{};var parts=(n||'').split(' ');
    document.getElementById('ceTitle').textContent=n?'Edit Camper':'Add Camper';
    var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'Will be assigned on save';
    var h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div class="fsec" style="margin:0">Identity</div><span style="font-family:monospace;font-size:.8rem;color:var(--s400);background:var(--s100);padding:3px 10px;border-radius:var(--r)">Camper ID: #'+esc(idStr)+'</span></div>';
    h+='<div class="fr">'+ff('First Name','ceFirst',parts[0]||'')+ff('Last Name','ceLast',parts.slice(1).join(' ')||'')+'</div>';
    h+='<div class="fr">'+ff('Date of Birth','ceDob',d.dob||'','date')+ff('Gender','ceGender',d.gender||'','select',['','Male','Female','Non-binary','Other'])+'</div>';
    h+='<div class="fr">'+ff('School Name','ceSchool',d.school||'')+ff('School Grade','ceGrade',d.schoolGrade||'')+'</div>';

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

    document.getElementById('ceBody').innerHTML=h;
    // Cascade
    var divS=document.getElementById('ceDiv'),grS=document.getElementById('ceCGrade'),bkS=document.getElementById('ceBunk');
    if(divS)divS.onchange=function(){grS.innerHTML=grOpts(divS.value).map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('');bkS.innerHTML=bkOpts(divS.value,'').map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('')};
    if(grS)grS.onchange=function(){bkS.innerHTML=bkOpts(divS.value,grS.value).map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('')};
    document.getElementById('ceSave').onclick=saveCamper;
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
        school:document.getElementById('ceSchool').value||'',schoolGrade:document.getElementById('ceGrade').value||'',
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
        var goRaw=localStorage.getItem('campistry_go_data');
        var goData=goRaw?JSON.parse(goRaw):{};
        if(!goData.addresses)goData.addresses={};
        var existing=goData.addresses[camperName]||{};
        goData.addresses[camperName]={
            street:camperData.street||'',
            city:camperData.city||'',
            state:camperData.state||'NY',
            zip:camperData.zip||'',
            lat:existing.lat||null,
            lng:existing.lng||null,
            geocoded:false, // Mark for re-geocode since address may have changed
            transport:existing.transport||'bus',
            rideWith:existing.rideWith||''
        };
        // If street hasn't changed, preserve geocode status
        if(existing.street===camperData.street&&existing.city===camperData.city&&existing.geocoded){
            goData.addresses[camperName].lat=existing.lat;
            goData.addresses[camperName].lng=existing.lng;
            goData.addresses[camperName].geocoded=true;
        }
        localStorage.setItem('campistry_go_data',JSON.stringify(goData));
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
function bbC(n){var d=roster[n]||{};return'<div class="bb-c" draggable="true" ondragstart="event.dataTransfer.setData(\'text/plain\',\''+je(n)+'\')">'+av(n,'s')+'<div style="flex:1;min-width:0"><div class="bb-c-nm">'+esc(n)+'</div></div>'+(d.allergies||d.medications?'<span style="color:var(--err);font-size:.6rem">⚠</span>':'')+'</div>'}
function bbDrop(t,e){e.preventDefault();var n=e.dataTransfer.getData('text/plain');if(!n)return;Object.keys(bunkAsgn).forEach(function(b){bunkAsgn[b]=bunkAsgn[b].filter(function(x){return x!==n})});if(t!=='__pool__'){if(!bunkAsgn[t])bunkAsgn[t]=[];bunkAsgn[t].push(n)}save();renderBB()}
function autoAssign(){var allB=[];Object.entries(structure).forEach(function([div,d]){Object.entries(d.grades||{}).forEach(function([gr,g]){(g.bunks||[]).forEach(function(b){allB.push({name:b,gr:gr,div:div})})})});var next={};allB.forEach(function(b){next[b.name]=[]});var campers=Object.entries(roster);campers.sort(function(a,b){return(a[1].grade||'').localeCompare(b[1].grade||'')});campers.forEach(function([n,d]){var el=allB.filter(function(b){return b.gr===d.grade});if(!el.length)el=allB.filter(function(b){return b.div===d.division});if(!el.length)el=allB;if(!el.length)return;el.sort(function(a,b){return next[a.name].length-next[b.name].length});next[el[0].name].push(n)});bunkAsgn=next;save();renderBB();toast('Auto-assigned')}
function clearBunks(){if(!confirm('Clear all?'))return;bunkAsgn={};save();renderBB();toast('Cleared')}

// ── BILLING / BROADCASTS / SOON ──────────────────────────────────
function renderBilling(){var c=document.getElementById('page-billing');var tp=0,td=0;Object.values(families).forEach(function(f){tp+=f.totalPaid||0;td+=f.balance||0});c.innerHTML='<div class="sec-hd"><div><h2 class="sec-title">Billing</h2></div></div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px"><div style="flex:1;min-width:120px;background:#fff;border-radius:var(--r);padding:12px;border:1px solid var(--s200)"><div style="font-size:1.1rem;font-weight:700;color:var(--s800)">'+fm(tp)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Collected</div></div><div style="flex:1;min-width:120px;background:#fff;border-radius:var(--r);padding:12px;border:1px solid var(--s200)"><div style="font-size:1.1rem;font-weight:700;color:var(--s800)">'+fm(td)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Outstanding</div></div></div>'+(payments.length?'<div class="me-card"><div class="me-card-head"><h3>Payments</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Family</th><th>Amount</th><th>Status</th></tr></thead><tbody>'+payments.map(function(p){var f=families[p.familyId];return'<tr><td>'+(p.date||'')+'</td><td class="bold">'+(f?esc(f.name):'')+'</td><td style="font-weight:600">'+fm(p.amount)+'</td><td>'+bdg(p.status||'',p.status==='Paid'?'ok':'warn')+'</td></tr>'}).join('')+'</tbody></table></div></div>':'<div class="me-empty"><h3>No payments</h3></div>')}
function renderBroadcasts(){var c=document.getElementById('page-broadcasts');c.innerHTML='<div class="sec-hd"><div><h2 class="sec-title">Broadcasts</h2></div><div class="sec-actions"><button class="me-btn me-btn--pri">+ New</button></div></div>'+(broadcasts.length?broadcasts.map(function(b){return'<div class="me-card" style="margin-bottom:8px;padding:14px"><div style="font-size:.85rem;font-weight:600">'+esc(b.subject)+'</div><div style="font-size:.7rem;color:var(--s400);margin-top:2px">'+esc(b.to||'')+' · '+esc(b.method||'')+'</div></div>'}).join(''):'<div class="me-empty"><h3>No broadcasts</h3></div>')}
function renderSoon(p){var t={forms:'Forms & Docs',reports:'Reports',settings:'Settings'};document.getElementById('page-'+p).innerHTML='<div class="me-soon"><h2>'+(t[p]||p)+'</h2><p>Coming soon.</p></div>'}

// ── CSV ──────────────────────────────────────────────────────────
function handleCsv(file){if(!file)return;var r=new FileReader();r.onload=function(e){var t=e.target.result;if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);var lines=t.split(/\r?\n/).filter(function(l){return l.trim()});if(!lines.length)return;var start=lines[0].toLowerCase().includes('name')?1:0;var rows=[];for(var i=start;i<Math.min(lines.length,5001);i++){var cols=lines[i].split(',').map(function(s){return s.trim().replace(/^"|"$/g,'')});if(cols[0])rows.push({name:cols[0],division:cols[1]||'',grade:cols[2]||'',bunk:cols[3]||'',team:cols[4]||''})}if(rows.length){document.getElementById('csvPV').style.display='block';document.getElementById('csvPV').innerHTML='<div style="font-weight:600;margin:8px 0 4px">'+rows.length+' rows</div>';document.getElementById('csvBtn').disabled=false;document.getElementById('csvBtn').onclick=function(){var a=0;rows.forEach(function(r){if(r.division&&!structure[r.division])structure[r.division]={color:COLORS[Object.keys(structure).length%COLORS.length],grades:{}};if(r.division&&r.grade&&structure[r.division]&&!structure[r.division].grades[r.grade])structure[r.division].grades[r.grade]={bunks:[]};if(r.division&&r.grade&&r.bunk&&structure[r.division]?.grades?.[r.grade]&&structure[r.division].grades[r.grade].bunks.indexOf(r.bunk)===-1)structure[r.division].grades[r.grade].bunks.push(r.bunk);if(!roster[r.name])a++;roster[r.name]=Object.assign(roster[r.name]||{},{division:r.division,grade:r.grade,bunk:r.bunk,team:r.team})});save();closeModal('csvModal');render(curPage);toast(a+' imported')}}};r.readAsText(file)}
function exportCsv(){var e=Object.entries(roster);if(!e.length){toast('No campers','error');return}var csv='\uFEFFName,Division,Grade,Bunk,Team\n';e.forEach(function([n,d]){csv+='"'+n+'","'+(d.division||'')+'","'+(d.grade||'')+'","'+(d.bunk||'')+'","'+(d.team||'')+'"\n'});var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='campers_'+new Date().toISOString().split('T')[0]+'.csv';a.click();toast('Exported')}

// ═══ BOOT ════════════════════════════════════════════════════════
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();

window.CampistryMe={
    nav:nav,closeModal:closeModal,
    viewCamper:viewCamper,editCamper:editCamper,addCamper:addCamper,
    addFamily:function(){openFamilyForm(null)},editFamily:function(id){openFamilyForm(id)},
    addDiv:function(){openDivForm(null)},editDiv:function(n){openDivForm(n)},deleteDiv:deleteDiv,
    openCsv:function(){openModal('csvModal')},exportCsv:exportCsv,
    bbDrop:bbDrop,autoAssign:autoAssign,clearBunks:clearBunks,
    _pickColor:_pickColor,_addGradeRow:_addGradeRow,
};
})();
