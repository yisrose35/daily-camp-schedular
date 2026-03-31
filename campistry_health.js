// ============================================================================
// campistry_health.js — Campistry Health Data Engine v1.0
// ============================================================================
// Reads camper roster LIVE from Campistry Me via localStorage
// key: campGlobalSettings_v1 → app1.camperRoster
//
// Me roster fields used:
//   camperId, dob, gender, school, schoolGrade, division, grade, bunk,
//   parent1Name, parent1Phone, parent1Email,
//   emergencyName, emergencyPhone, emergencyRel,
//   allergies, medications, dietary,
//   street, city, state, zip, photoUrl
//
// Health-specific data stored in campGlobalSettings_v1.campistryHealth:
//   medications[], dispensingLog[], sickVisits[], doctorVisits[],
//   allergyRecords[], bedwettingLog[], medicalForms{}
// ============================================================================

(function() {
    'use strict';
    console.log('💜 Campistry Health v1.0 loading...');

    const STORAGE_KEY = 'campGlobalSettings_v1';
    const HEALTH_KEY  = 'campistryHealth';

    // ── Data Access (from Me) ─────────────────────────────────────────────
    function readGlobal() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch(e) { return {}; }
    }
    function getRoster()    { var g = readGlobal(); return (g.app1 && g.app1.camperRoster) || {}; }
    function getStructure() { return readGlobal().campStructure || {}; }
    function getFamilies()  { var g = readGlobal(); return (g.campistryMe && g.campistryMe.families) || {}; }
    function getCampName()  { var g = readGlobal(); return g.camp_name || g.campName || localStorage.getItem('campistry_camp_name') || 'Your Camp'; }

    // ── Health Data (read/write) ──────────────────────────────────────────
    function getHealth() {
        var g = readGlobal();
        return g[HEALTH_KEY] || { dispensingLog:[], sickVisits:[], doctorVisits:[], bedwettingLog:[], medicalForms:{} };
    }
    function saveHealth(h) {
        try {
            var g = readGlobal();
            g[HEALTH_KEY] = h;
            g.updated_at = new Date().toISOString();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(g));
            if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler)
                window.saveGlobalSettings(HEALTH_KEY, h);
        } catch(e) { console.error('[Health] save failed', e); }
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    function esc(s) { if (s == null) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function ini(n) { var p = String(n).split(' '); return ((p[0]||'?')[0] + (p.length>1 ? (p[p.length-1]||'?')[0] : '')).toUpperCase(); }
    function avc(n) { var c = ['#8B5CF6','#EF4444','#F59E0B','#22C55E','#0EA5E9','#EC4899','#6366F1','#14B8A6','#F97316','#84CC16']; var h=0; for(var i=0;i<n.length;i++) h+=n.charCodeAt(i); return c[h%c.length]; }
    function age(dob) { if(!dob) return ''; var a = Math.floor((Date.now()-new Date(dob).getTime())/31557600000); return a>=0&&a<25?a:''; }
    function todayISO() { return new Date().toISOString().split('T')[0]; }
    function nowTime() { return new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); }
    function todayPretty() { return new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}); }
    function bdg(label,type) { return '<span class="badge badge-'+type+'">'+esc(label)+'</span>'; }
    function setText(id,v) { var el=document.getElementById(id); if(el) el.textContent=v; }
    function nurse() { return localStorage.getItem('campistry_nurse_name') || 'Nurse'; }
    function je(s) { return esc(s).replace(/'/g,"\\'"); }

    // ── Toast ─────────────────────────────────────────────────────────────
    function toast(msg, type) {
        var el = document.createElement('div');
        el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:10px;font-size:.82rem;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:opacity .3s;font-family:var(--font-body)';
        el.style.background = type === 'err' ? '#FEE2E2' : '#DCFCE7';
        el.style.color = type === 'err' ? '#DC2626' : '#16A34A';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(function(){ el.style.opacity='0'; setTimeout(function(){ el.remove(); },300); }, 2500);
    }

    // ══════════════════════════════════════════════════════════════════════
    // RENDERERS — each populates DOM elements by ID
    // ══════════════════════════════════════════════════════════════════════

    function renderDashboard() {
        var roster = getRoster(), names = Object.keys(roster).sort(), hd = getHealth();
        var medCampers = names.filter(function(n){return roster[n].medications;});
        var allergyCampers = names.filter(function(n){return roster[n].allergies;});
        var todayVisits = (hd.sickVisits||[]).filter(function(v){return v.date===todayISO();}).length;

        setText('statMedsDue', String(medCampers.length));
        setText('statGiven', String((hd.dispensingLog||[]).filter(function(d){return d.date===todayISO();}).length));
        setText('statVisits', String(todayVisits));
        setText('statFollowups', '0');
        setText('dashDateLine', todayPretty() + ' — ' + getCampName());

        // Med queue
        var qEl = document.getElementById('medQueueBody');
        if (qEl) {
            if (!medCampers.length) { qEl.innerHTML = '<div class="empty-state">No medications on file. Add medication info to campers in <a href="campistry_me.html" style="color:var(--health);font-weight:600">Campistry Me</a>.</div>'; }
            else {
                var h = '';
                medCampers.forEach(function(name) {
                    var c = roster[name];
                    (c.medications||'').split(',').map(function(m){return m.trim()}).filter(Boolean).forEach(function(med) {
                        h += '<div class="med-item upcoming"><div class="med-avatar" style="background:'+avc(name)+'">'+ini(name)+'</div><div class="med-info"><div class="med-name">'+esc(name)+'</div><div class="med-detail">'+esc(med)+' — '+esc(c.bunk||'No bunk')+(c.division?' ('+esc(c.division)+')':'')+'</div></div><div class="med-actions"><button class="btn-give" onclick="CampistryHealth.logDispensing(\''+je(name)+'\',\''+je(med)+'\')">Given</button><button class="btn-skip">Skip</button></div></div>';
                    });
                });
                qEl.innerHTML = h;
            }
        }

        // Recent visits
        var vEl = document.getElementById('recentVisitsBody');
        if (vEl) {
            if (!(hd.sickVisits||[]).length) { vEl.innerHTML = '<div class="empty-state">No visits logged yet. Use "Log Visit" to record.</div>'; }
            else {
                var vh = '';
                (hd.sickVisits||[]).slice(-5).reverse().forEach(function(v) {
                    vh += '<div class="visit-card"><div class="visit-time">'+esc(v.time||'')+'</div><div class="visit-body"><div class="visit-header"><span class="visit-camper">'+esc(v.camperName)+'</span>'+bdg(v.disposition||'Logged',v.disposition==='Returned to activity'?'green':'blue')+'</div><div class="visit-complaint">'+esc(v.complaint||'')+'</div>'+(v.treatment?'<div class="visit-treatment"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> '+esc(v.treatment)+'</div>':'')+'</div></div>';
                });
                vEl.innerHTML = vh;
            }
        }

        // Allergy alerts
        var aEl = document.getElementById('allergyAlertsBody');
        if (aEl) {
            if (!allergyCampers.length) { aEl.innerHTML = '<div class="empty-state">No allergies on file. Allergy data from Me appears here.</div>'; }
            else {
                var ah = '';
                allergyCampers.forEach(function(name) {
                    var c = roster[name];
                    var sev = (c.allergies||'').toLowerCase().match(/anaphyla|epipen|severe/) ? 'severe' : 'moderate';
                    ah += '<div class="allergy-card '+sev+'"><div class="allergy-camper">'+esc(name)+' '+bdg(sev==='severe'?'Severe':'Moderate',sev==='severe'?'red':'amber')+'</div><div class="allergy-detail">'+esc(c.allergies)+'</div></div>';
                });
                aEl.innerHTML = ah;
            }
        }
    }

    function renderMedications() {
        var roster = getRoster(), names = Object.keys(roster).sort();
        var tbody = document.getElementById('medTableBody'); if (!tbody) return;
        var meds = names.filter(function(n){return roster[n].medications;});
        if (!meds.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No medications on file. Add meds in Me.</td></tr>'; return; }
        var h = '';
        meds.forEach(function(name) {
            var c = roster[name];
            (c.medications||'').split(',').map(function(m){return m.trim()}).filter(Boolean).forEach(function(med) {
                h += '<tr><td style="font-weight:700">'+esc(name)+'</td><td>'+esc(med)+'</td><td>'+esc(c.bunk||'—')+'</td><td>'+(c.division?bdg(c.division,'purple'):'—')+'</td><td>'+bdg('Active','green')+'</td><td><button class="btn btn-sm btn-primary" onclick="CampistryHealth.logDispensing(\''+je(name)+'\',\''+je(med)+'\')">Give</button></td></tr>';
            });
        });
        tbody.innerHTML = h;
    }

    function renderSickVisits() {
        var hd = getHealth(), tbody = document.getElementById('visitsTableBody'); if (!tbody) return;
        if (!(hd.sickVisits||[]).length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No sick visits logged yet.</td></tr>'; return; }
        var h = '';
        (hd.sickVisits||[]).slice().reverse().forEach(function(v) {
            h += '<tr><td style="font-weight:600;color:var(--slate-500)">'+esc(v.time||v.date||'')+'</td><td style="font-weight:700">'+esc(v.camperName)+'</td><td>'+esc(v.bunk||'—')+'</td><td>'+esc(v.complaint||'')+'</td><td>'+esc(v.treatment||'—')+'</td><td>'+bdg(v.disposition||'Logged',v.disposition==='Returned to activity'?'green':'blue')+'</td><td>'+esc(v.nurse||'—')+'</td></tr>';
        });
        tbody.innerHTML = h;
    }

    function renderDoctorVisits() {
        var hd = getHealth(), tbody = document.getElementById('doctorTableBody'); if (!tbody) return;
        if (!(hd.doctorVisits||[]).length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No doctor visits logged.</td></tr>'; return; }
        var h = '';
        (hd.doctorVisits||[]).slice().reverse().forEach(function(v) {
            h += '<tr><td style="font-weight:600;color:var(--slate-500)">'+esc(v.date||'')+'</td><td style="font-weight:700">'+esc(v.camperName)+'</td><td>'+esc(v.reason||'')+'</td><td>'+esc(v.diagnosis||'—')+'</td><td>'+(v.restrictions?bdg(v.restrictions,'amber'):'—')+'</td><td>'+bdg(v.cleared?'Cleared':'Pending',v.cleared?'green':'amber')+'</td></tr>';
        });
        tbody.innerHTML = h;
    }

    function renderAllergies() {
        var roster = getRoster(), names = Object.keys(roster).sort();
        var tbody = document.getElementById('allergyTableBody'); if (!tbody) return;
        var hits = names.filter(function(n){return roster[n].allergies||roster[n].dietary;});
        if (!hits.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No allergy/dietary data. Syncs from Me.</td></tr>'; return; }
        var h = '';
        hits.forEach(function(name) {
            var c = roster[name];
            if (c.allergies) {
                var sev = (c.allergies.toLowerCase().match(/anaphyla|epipen|severe/))?'Severe':'Moderate';
                h += '<tr><td style="font-weight:700">'+esc(name)+'</td><td>'+esc(c.allergies)+'</td><td>'+bdg('Allergy','red')+'</td><td>'+bdg(sev,sev==='Severe'?'red':'amber')+'</td><td>'+esc(c.bunk||'—')+'</td></tr>';
            }
            if (c.dietary) {
                h += '<tr><td style="font-weight:700">'+esc(name)+'</td><td>'+esc(c.dietary)+'</td><td>'+bdg('Dietary','amber')+'</td><td>'+bdg('—','gray')+'</td><td>'+esc(c.bunk||'—')+'</td></tr>';
            }
        });
        tbody.innerHTML = h;
    }

    function renderNighttime() {
        var hd = getHealth(), el = document.getElementById('nighttimeBody'); if (!el) return;
        if (!(hd.bedwettingLog||[]).length) { el.innerHTML = '<div class="empty-state">No incidents logged. Use "Log Incident" to record.</div>'; return; }
        var h = '';
        (hd.bedwettingLog||[]).slice().reverse().forEach(function(e) {
            h += '<div class="visit-card"><div class="visit-time">'+esc(e.date||'')+'<br>'+esc(e.time||'')+'</div><div class="visit-body"><div class="visit-header"><span class="visit-camper">'+esc(e.camperInitials||'—')+'</span></div><div class="visit-complaint">'+esc(e.notes||'Linen changed.')+'</div></div></div>';
        });
        el.innerHTML = h;
    }

    function renderCamperDirectory(filterText) {
        var roster = getRoster(), names = Object.keys(roster).sort();
        var tbody = document.getElementById('camperDirBody'); if (!tbody) return;
        if (!names.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No campers yet. Add campers in <a href="campistry_me.html" style="color:var(--health);font-weight:600">Campistry Me</a>.</td></tr>';
            setText('statDirCount','0'); return;
        }
        var q = (filterText||'').toLowerCase();
        var filtered = names.filter(function(n) {
            if (!q) return true;
            var c = roster[n];
            return [n,c.division,c.bunk,c.allergies,c.medications,c.dietary,c.parent1Name,c.emergencyName].join(' ').toLowerCase().includes(q);
        });
        setText('statDirCount', String(filtered.length));
        if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No matches.</td></tr>'; return; }
        var h = '';
        filtered.forEach(function(name) {
            var c = roster[name];
            var flags = '';
            if (c.allergies) flags += bdg(c.allergies.split(',')[0].trim(),'red')+' ';
            if (c.medications) flags += bdg(c.medications.split(',')[0].trim(),'purple')+' ';
            if (c.dietary) flags += bdg(c.dietary.split(',')[0].trim(),'amber')+' ';
            if (!flags) flags = '<span style="color:var(--slate-300)">None</span>';
            var em = c.emergencyName||c.parent1Name||'—';
            var ph = c.emergencyPhone||c.parent1Phone||'';
            if (ph) em += ' · '+esc(ph);
            h += '<tr class="click" onclick="CampistryHealth.viewCamper(\''+je(name)+'\')">'+'<td><div class="med-avatar" style="background:'+avc(name)+';width:30px;height:30px;font-size:.6rem">'+ini(name)+'</div></td><td style="font-weight:700">'+esc(name)+'</td><td>'+(c.dob?age(c.dob):'—')+'</td><td>'+(c.division?bdg(c.division,'purple'):'—')+'</td><td>'+esc(c.bunk||'—')+'</td><td>'+flags+'</td><td style="font-size:.75rem;color:var(--slate-500)">'+em+'</td></tr>';
        });
        tbody.innerHTML = h;
    }

    function renderIntake() {
        var roster = getRoster(), names = Object.keys(roster).sort(), hd = getHealth();
        var forms = hd.medicalForms||{};
        var approved=0, pending=0, flagged=0;
        names.forEach(function(n){ var s=(forms[n]&&forms[n].status)||'not_started'; if(s==='approved')approved++;else if(s==='flagged')flagged++;else pending++; });
        var total=names.length, pct=total?Math.round(approved/total*100):0;
        setText('intakeApproved',String(approved)); setText('intakePending',String(pending));
        setText('intakeFlagged',String(flagged)); setText('intakeTotal',String(total));
        setText('intakePct',pct+'% ('+approved+'/'+total+')');
        var bar=document.getElementById('intakeProgressBar'); if(bar) bar.style.width=pct+'%';

        var tbody=document.getElementById('intakeTableBody'); if (!tbody) return;
        if (!total) { tbody.innerHTML='<tr><td colspan="5" class="empty-state">No campers yet. Add in Me first.</td></tr>'; return; }
        var h='';
        names.forEach(function(name){
            var c=roster[name], f=forms[name]||{status:'not_started'};
            var sb = f.status==='approved'?bdg('Approved','green'):f.status==='flagged'?bdg('Flagged','red'):f.status==='pending'?bdg('Pending','amber'):bdg('Not Started','gray');
            var ab = f.status==='approved'?'<button class="btn btn-sm btn-ghost">View</button>':f.status==='flagged'?'<button class="btn btn-sm btn-danger">Resolve</button>':'<button class="btn btn-sm btn-primary">Review</button>';
            h+='<tr><td style="font-weight:700">'+esc(name)+'</td><td>'+esc(c.bunk||'—')+'</td><td>'+sb+'</td><td style="font-size:.75rem;color:var(--slate-500)">'+esc(f.notes||'—')+'</td><td>'+ab+'</td></tr>';
        });
        tbody.innerHTML=h;
    }

    // ══════════════════════════════════════════════════════════════════════
    // ACTIONS
    // ══════════════════════════════════════════════════════════════════════

    function logDispensing(camperName, medName) {
        var hd = getHealth(); if (!hd.dispensingLog) hd.dispensingLog = [];
        hd.dispensingLog.push({ camperName:camperName, medication:medName, status:'Given', nurse:nurse(), timestamp:new Date().toISOString(), date:todayISO(), time:nowTime() });
        saveHealth(hd); toast(medName+' — Given to '+camperName,'ok'); renderDashboard(); renderMedications();
    }

    function saveSickVisit() {
        var inp = document.getElementById('visitCamperInput');
        if (!inp||!inp.value.trim()) { toast('Enter camper name','err'); return; }
        var name=inp.value.trim(), roster=getRoster(), c=roster[name]||{};
        var presets=[]; document.querySelectorAll('.complaint-preset.selected').forEach(function(b){presets.push(b.textContent.trim())});
        var custom = (document.getElementById('visitComplaint')||{}).value||'';
        var complaint = presets.concat(custom?[custom]:[]).join(', ');
        var temp = (document.getElementById('visitTemp')||{}).value||'';
        if (temp) complaint += ' ('+temp+'°F)';
        var hd = getHealth(); if (!hd.sickVisits) hd.sickVisits=[];
        hd.sickVisits.push({ camperName:name, bunk:c.bunk||'', complaint:complaint, treatment:((document.getElementById('visitTreatment')||{}).value||'').trim(), disposition:(document.getElementById('visitDisposition')||{}).value||'', nurse:nurse(), date:todayISO(), time:nowTime(), timestamp:new Date().toISOString() });
        saveHealth(hd); closeModal('visitModal'); toast('Visit logged for '+name,'ok');
        renderDashboard(); renderSickVisits();
        // clear form
        inp.value=''; if(document.getElementById('visitComplaint'))document.getElementById('visitComplaint').value='';
        if(document.getElementById('visitTemp'))document.getElementById('visitTemp').value='';
        if(document.getElementById('visitTreatment'))document.getElementById('visitTreatment').value='';
        document.querySelectorAll('.complaint-preset.selected').forEach(function(b){b.classList.remove('selected')});
    }

    function saveDispensing() {
        var inp=document.getElementById('medCamperInput');
        if (!inp||!inp.value.trim()) { toast('Enter camper name','err'); return; }
        var hd=getHealth(); if(!hd.dispensingLog) hd.dispensingLog=[];
        hd.dispensingLog.push({ camperName:inp.value.trim(), medication:(document.getElementById('medSelect')||{}).value||'', status:(document.getElementById('medStatus')||{}).value||'Given', nurse:nurse(), time:(document.getElementById('medTime')||{}).value||'', notes:((document.getElementById('medNotes')||{}).value||'').trim(), timestamp:new Date().toISOString(), date:todayISO() });
        saveHealth(hd); closeModal('medModal'); toast('Dispensing logged','ok'); renderDashboard(); renderMedications();
    }

    function viewCamper(name) {
        var c = getRoster()[name]; if (!c) return;
        var lines = ['CAMPER: '+name+(c.camperId?' (#'+String(c.camperId).padStart(4,'0')+')':''),'','Division: '+(c.division||'—'),'Bunk: '+(c.bunk||'—'),'Age: '+(c.dob?age(c.dob):'—'),'DOB: '+(c.dob||'—'),'Gender: '+(c.gender||'—'),'School: '+(c.school||'—'),'','── PARENT / GUARDIAN ──','Parent: '+(c.parent1Name||'—'),'Phone: '+(c.parent1Phone||'—'),'Email: '+(c.parent1Email||'—'),'','── EMERGENCY CONTACT ──','Name: '+(c.emergencyName||'—'),'Phone: '+(c.emergencyPhone||'—'),'Relation: '+(c.emergencyRel||'—'),'','── ADDRESS ──',[c.street,c.city,c.state,c.zip].filter(Boolean).join(', ')||'—','','── MEDICAL (from Me) ──','Allergies: '+(c.allergies||'None'),'Medications: '+(c.medications||'None'),'Dietary: '+(c.dietary||'None')];
        alert(lines.join('\n'));
    }

    // ── Camper Search Autocomplete ────────────────────────────────────────
    function setupSearch(inputId) {
        var input=document.getElementById(inputId); if(!input) return;
        input.addEventListener('input',function(){
            var q=input.value.toLowerCase(), roster=getRoster(), names=Object.keys(roster).filter(function(n){return n.toLowerCase().includes(q)});
            var old=input.parentElement.querySelector('.camper-dd'); if(old) old.remove();
            if(!q||!names.length) return;
            var dd=document.createElement('div'); dd.className='camper-dd';
            dd.style.cssText='position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid var(--slate-200);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.1);max-height:160px;overflow-y:auto;z-index:10';
            names.slice(0,8).forEach(function(n){
                var c=roster[n], item=document.createElement('div');
                item.style.cssText='padding:8px 12px;cursor:pointer;font-size:.82rem;display:flex;justify-content:space-between';
                item.innerHTML='<span style="font-weight:600">'+esc(n)+'</span><span style="color:var(--slate-400);font-size:.75rem">'+esc(c.bunk||'')+'</span>';
                item.onclick=function(){ input.value=n; dd.remove(); populateMedDrop(n); };
                item.onmouseenter=function(){item.style.background='var(--health-50)'}; item.onmouseleave=function(){item.style.background=''};
                dd.appendChild(item);
            });
            input.parentElement.style.position='relative'; input.parentElement.appendChild(dd);
        });
        document.addEventListener('click',function(e){ if(!input.contains(e.target)){var dd=input.parentElement.querySelector('.camper-dd');if(dd)dd.remove()} });
    }
    function populateMedDrop(name) {
        var sel=document.getElementById('medSelect'); if(!sel) return;
        var c=getRoster()[name]; if(!c||!c.medications) return;
        var meds=c.medications.split(',').map(function(m){return m.trim()}).filter(Boolean);
        sel.innerHTML='<option>Select medication...</option>';
        meds.forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o)});
    }

    function openModal(id){var el=document.getElementById(id);if(el)el.classList.add('open')}
    function closeModal(id){var el=document.getElementById(id);if(el)el.classList.remove('open')}

    // ══════════════════════════════════════════════════════════════════════
    // PAGE NAV HOOK + INIT
    // ══════════════════════════════════════════════════════════════════════

    function onPageChange(page) {
        switch(page) {
            case 'dashboard': renderDashboard(); break;
            case 'medications': renderMedications(); break;
            case 'sick-visits': renderSickVisits(); break;
            case 'doctor': renderDoctorVisits(); break;
            case 'allergies': renderAllergies(); break;
            case 'nighttime': renderNighttime(); break;
            case 'campers': renderCamperDirectory(); break;
            case 'intake': renderIntake(); break;
        }
    }

    function init() {
        console.log('💜 [Health] Init — '+Object.keys(getRoster()).length+' campers from Me');
        renderDashboard();
        setupSearch('visitCamperInput');
        setupSearch('medCamperInput');
        document.querySelectorAll('.complaint-preset').forEach(function(b){b.addEventListener('click',function(){b.classList.toggle('selected')})});
        // Directory search
        var dirSearch = document.getElementById('camperDirSearch');
        if (dirSearch) dirSearch.addEventListener('input', function(){ renderCamperDirectory(dirSearch.value); });
        console.log('💜 [Health] Ready');
    }

    // ── Public API ────────────────────────────────────────────────────────
    window.CampistryHealth = {
        init:init, onPageChange:onPageChange,
        renderDashboard:renderDashboard, renderMedications:renderMedications,
        renderSickVisits:renderSickVisits, renderDoctorVisits:renderDoctorVisits,
        renderAllergies:renderAllergies, renderNighttime:renderNighttime,
        renderCamperDirectory:renderCamperDirectory, renderIntake:renderIntake,
        logDispensing:logDispensing, saveSickVisit:saveSickVisit, saveDispensing:saveDispensing,
        viewCamper:viewCamper, getRoster:getRoster, getStructure:getStructure,
        getHealth:getHealth, saveHealth:saveHealth,
        openModal:openModal, closeModal:closeModal, toast:toast
    };

    console.log('💜 Campistry Health v1.0 loaded');
})();
