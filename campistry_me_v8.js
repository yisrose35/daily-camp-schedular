// =============================================================================
// campistry_me_v8.js — Enhancement Module for Campistry Me
// Loads AFTER campistry_me.js
// =============================================================================
// Features: Staff roster + salary, enhanced camper profiles (address, birthday,
// photo, guardians, medical, tuition), profile side panel, granular CSV import
// with separate columns for first/middle/last name, parent fields, address parts
// =============================================================================
(function() {
    'use strict';
    console.log('[Me v8] Loading...');

    let staffRoster = {};
    let currentPanel = null;
    let panelTab = 'info';
    let panelEditing = false;
    let panelForm = {};

    // =========================================================================
    // HELPERS
    // =========================================================================
    function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;') : ''; }
    function jsE(s) { return s ? String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'") : ''; }
    function fmtDate(d) { if(!d) return '—'; try { return new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); } catch(e) { return d; } }
    function fmtMoney(n) { return '$'+Number(n||0).toLocaleString(); }
    function getAge(b) { if(!b)return null; const d=new Date(b+'T00:00:00'),n=new Date(); let a=n.getFullYear()-d.getFullYear(); if(n.getMonth()<d.getMonth()||(n.getMonth()===d.getMonth()&&n.getDate()<d.getDate()))a--; return a; }
    function initials(n) { return (n||'').split(' ').map(w=>w[0]||'').join('').toUpperCase().slice(0,2); }
    function toast(msg, type) { if(window.CampistryMe?.toast) window.CampistryMe.toast(msg,type); }
    function getStructure() { return window.CampistryMe?._getStructure?.() || {}; }
    function getCampers() { return window.CampistryMe?._getCamperRoster?.() || {}; }
    function triggerSave() { if(window.CampistryMe?.saveData) window.CampistryMe.saveData(); }
    function triggerRender() { if(window.CampistryMe?.renderAll) window.CampistryMe.renderAll(); }

    // =========================================================================
    // LOCAL STORAGE
    // =========================================================================
    function readLocal() {
        try { const r=localStorage.getItem('campGlobalSettings_v1')||localStorage.getItem('campistryGlobalSettings'); return r?JSON.parse(r):{}; } catch(e) { return {}; }
    }
    function writeLocal(global) {
        const j=JSON.stringify(global);
        try { localStorage.setItem('campistryGlobalSettings',j); localStorage.setItem('campGlobalSettings_v1',j); localStorage.setItem('CAMPISTRY_LOCAL_CACHE',j); } catch(e) {}
    }
    function loadStaff() {
        staffRoster = readLocal()?.app1?.staffRoster || {};
        console.log('[Me v8] Staff:',Object.keys(staffRoster).length);
    }
    function saveStaff() {
        const g=readLocal(); if(!g.app1) g.app1={}; g.app1.staffRoster=staffRoster; g.updated_at=new Date().toISOString(); writeLocal(g);
        if(window.CampistryMe?._scheduleCloudSave) window.CampistryMe._scheduleCloudSave({app1:g.app1,updated_at:g.updated_at});
    }
    function saveCamperExt(name, data) {
        const g=readLocal(); if(!g.app1) g.app1={}; if(!g.app1.camperRoster) g.app1.camperRoster={};
        g.app1.camperRoster[name] = {...(g.app1.camperRoster[name]||{}), ...data};
        g.updated_at=new Date().toISOString(); writeLocal(g);
        if(window.CampistryMe?._scheduleCloudSave) window.CampistryMe._scheduleCloudSave({app1:g.app1,updated_at:g.updated_at});
    }

    // =========================================================================
    // STATS BAR
    // =========================================================================
    function renderStats() {
        const el=document.getElementById('v8StatsBar'); if(!el) return;
        const c=getCampers(); const med=Object.values(c).filter(x=>x.allergies||x.medications).length;
        const tOwe=Object.values(c).reduce((s,x)=>s+Math.max(0,(x.tuitionTotal||0)-(x.tuitionPaid||0)),0);
        const sOwe=Object.values(staffRoster).reduce((s,x)=>s+Math.max(0,(x.salaryAmount||0)-(x.salaryPaid||0)),0);
        const sc=Object.keys(staffRoster).length;
        const stat=(l,v,w)=>`<div class="me-stat"><span class="me-stat-val${w?' warn':''}">${esc(String(v))}</span><span class="me-stat-label">${esc(l)}</span></div>`;
        el.innerHTML = stat('Staff',sc) + (med>0?stat('Medical Flags',med,true):'') + (tOwe>0?stat('Tuition Owed',fmtMoney(tOwe),true):'') + (sOwe>0?stat('Salary Owed',fmtMoney(sOwe),true):'');
    }

    // =========================================================================
    // STAFF TABLE
    // =========================================================================
    function renderStaffTab() {
        const tbody=document.getElementById('staffTableBody'); if(!tbody) return;
        const q=(document.getElementById('staffSearchInput')?.value||'').toLowerCase();
        const entries=Object.entries(staffRoster).filter(([n,s])=>!q||n.toLowerCase().includes(q)||(s.role||'').toLowerCase().includes(q)).sort((a,b)=>a[0].localeCompare(b[0]));
        document.getElementById('staffCount').textContent=entries.length+' staff';
        if(!entries.length) { tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">No staff members.</td></tr>'; return; }
        tbody.innerHTML=entries.map(([name,s])=>{
            const bal=(s.salaryAmount||0)-(s.salaryPaid||0);
            const sal=s.salaryType==='hourly'?fmtMoney(s.salaryAmount)+'/hr':fmtMoney(s.salaryAmount);
            const balHtml=bal>0?` <span style="color:#1E40AF">(${fmtMoney(bal)} owed)</span>`:'';
            const ph=s.photo?`<img src="${esc(s.photo)}" class="me-row-photo" alt="">`:`<div class="me-row-initials" style="background:#E0F2FE;color:#0284C7">${initials(name)}</div>`;
            return `<tr onclick="CampistryMeV8.openPanel('staff','${jsE(name)}')"><td><div style="display:flex;align-items:center;gap:8px">${ph}<span style="font-weight:600;font-size:13px;color:var(--text-primary)">${esc(name)}</span></div></td><td>${esc(s.role)}</td><td>${esc(s.division)}</td><td>${esc(s.phone)}</td><td style="font-weight:600;color:${bal>0?'#1E40AF':'#059669'}">${sal}${balHtml}</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();CampistryMeV8.openPanel('staff','${jsE(name)}')">Open</button></td></tr>`;
        }).join('');
    }

    // =========================================================================
    // PATCH CAMPER TABLE (add medical + tuition columns + click-to-profile)
    // =========================================================================
    function patchCamperTable() {
        const table=document.getElementById('camperTable'); if(!table) return;
        const campers=getCampers();
        const rows=table.querySelectorAll('tbody tr:not(.add-row)');
        rows.forEach(row=>{
            if(row.dataset.v8patched) return; row.dataset.v8patched='1';
            const nameEl=row.querySelector('td:first-child .clickable');
            const name=nameEl?.textContent?.trim();
            if(!name||!campers[name]) return;
            const c=campers[name];
            const actionTd=row.querySelector('td:last-child');
            if(!actionTd) return;
            // Medical
            const medTd=document.createElement('td');
            let flags='';
            if(c.allergies) flags+=`<span class="me-flag me-flag-allergy">${esc(c.allergies)}</span> `;
            if(c.medications) flags+=`<span class="me-flag me-flag-med">Meds</span> `;
            if(c.dietary) flags+=`<span class="me-flag me-flag-diet">${esc(c.dietary)}</span>`;
            medTd.innerHTML=flags||'<span style="color:var(--border-medium);font-size:12px">—</span>';
            row.insertBefore(medTd,actionTd);
            // Tuition
            const tuiTd=document.createElement('td');
            const bal=(c.tuitionTotal||0)-(c.tuitionPaid||0);
            if(c.tuitionTotal>0) tuiTd.innerHTML=bal>0?`<span style="font-weight:600;color:#B45309;font-size:12px">${fmtMoney(bal)} due</span>`:`<span style="font-weight:600;color:#059669;font-size:12px">Paid</span>`;
            else tuiTd.innerHTML='<span style="color:var(--border-medium);font-size:12px">—</span>';
            row.insertBefore(tuiTd,actionTd);
            // Click
            row.style.cursor='pointer';
            row.onclick=function(e){ if(e.target.tagName==='BUTTON'||e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return; CampistryMeV8.openPanel('camper',name); };
        });
    }

    // =========================================================================
    // SIDE PANEL
    // =========================================================================
    function openPanel(type,name) {
        currentPanel={type,name}; panelTab=type==='camper'?'info':'personal'; panelEditing=false;
        panelForm=JSON.parse(JSON.stringify(type==='camper'?(getCampers()[name]||{}):(staffRoster[name]||{})));
        if(type==='camper'&&!panelForm.guardians) panelForm.guardians=[];
        renderPanel();
        document.getElementById('mePanelOverlay').classList.add('active');
    }
    function closePanel() { document.getElementById('mePanelOverlay')?.classList.remove('active'); currentPanel=null; panelEditing=false; }

    function renderPanel() {
        if(!currentPanel) return;
        const panel=document.getElementById('mePanel'); if(!panel) return;
        const {type,name}=currentPanel;
        const data=type==='camper'?(getCampers()[name]||{}):(staffRoster[name]||{});
        const d=panelEditing?panelForm:data;
        const hasFlags=data.allergies||data.medications;
        const age=getAge(data.birthday);
        const addr=[data.address,data.city,data.state,data.zip].filter(Boolean).join(', ');

        // Photo
        const photo=panelEditing?panelForm.photo:data.photo;
        const photoHtml=photo?`<img src="${esc(photo)}" style="width:100%;height:100%;object-fit:cover">`:'<span>Add<br>Photo</span>';

        // Header
        let html=`<div class="me-panel-header"><div class="me-panel-header-info">
            <div class="me-photo-upload" ${panelEditing?'onclick="document.getElementById(\'panelPhotoIn\').click()"':'style="border-style:solid;cursor:default"'}>${photoHtml}${panelEditing?'<input type="file" id="panelPhotoIn" accept="image/*" style="display:none" onchange="CampistryMeV8._handlePhoto(event)">':''}</div>
            <div style="flex:1">${panelEditing?`<input type="text" id="pnName" value="${esc(panelForm._displayName||name)}" style="font-size:16px;font-weight:700;padding:5px 10px" placeholder="Full name">`:`<div class="me-panel-name">${esc(name)}</div>`}
            <div class="me-panel-sub">${esc(data.division||'')}${data.grade?' · '+esc(data.grade):''}${data.bunk?' · '+esc(data.bunk):''}${data.role?' · '+esc(data.role):''}${age!==null?' · Age '+age:''}</div></div>
        </div><button class="me-panel-close" onclick="CampistryMeV8.closePanel()">✕</button></div>`;

        if(type==='camper'&&hasFlags&&!panelEditing) html+=`<div class="me-panel-alert">⚠ ${esc([data.allergies,data.medications].filter(Boolean).join('  ·  '))}</div>`;

        // Tabs
        const tabs=type==='camper'?[{id:'info',l:'Info'},{id:'medical',l:'Medical'+(hasFlags?' ●':'')},{id:'guardians',l:'Guardians'},{id:'tuition',l:'Tuition'},{id:'notes',l:'Notes'}]:[{id:'personal',l:'Info'},{id:'salary',l:'Salary'},{id:'notes',l:'Notes'}];
        html+=`<div class="me-panel-tabs">${tabs.map(t=>`<button class="me-panel-tab${panelTab===t.id?' active':''}" onclick="CampistryMeV8._setTab('${t.id}')">${t.l}</button>`).join('')}</div>`;

        // Body
        html+='<div class="me-panel-body">';
        if(type==='camper') html+=camperBody(name,d,addr);
        else html+=staffBody(name,d);
        html+='</div>';

        // Footer
        if(panelEditing) html+=`<div class="me-panel-footer"><button class="me-pill me-pill-danger me-pill-xs" onclick="CampistryMeV8._delete()">Delete</button><div style="display:flex;gap:6px"><button class="me-pill me-pill-secondary me-pill-sm" onclick="CampistryMeV8._cancelEdit()">Cancel</button><button class="me-pill me-pill-primary me-pill-sm" onclick="CampistryMeV8._saveEdit()">Save</button></div></div>`;
        else html+=`<div class="me-panel-footer"><span></span><button class="me-pill me-pill-secondary me-pill-sm" onclick="CampistryMeV8._startEdit()">Edit Profile</button></div>`;

        panel.innerHTML=html;
    }

    function FR(label,val,key,opts={}) {
        const {type='text',ph='',ta=false,money=false}=opts;
        const display=money?fmtMoney(val):(type==='date'?fmtDate(val):(val||'—'));
        if(panelEditing) {
            const v=esc(panelForm[key]!==undefined?panelForm[key]:val||'');
            if(ta) return `<div class="me-field-row"><div class="me-field-label">${label}</div><div style="flex:1"><textarea onchange="CampistryMeV8._set('${key}',this.value)" placeholder="${esc(ph)}">${v}</textarea></div></div>`;
            return `<div class="me-field-row"><div class="me-field-label">${label}</div><div style="flex:1"><input type="${type}" value="${v}" onchange="CampistryMeV8._set('${key}',${type==='number'?'Number(this.value)':'this.value'})" placeholder="${esc(ph)}"></div></div>`;
        }
        return `<div class="me-field-row"><div class="me-field-label">${label}</div><div class="me-field-value${!val?' empty':''}">${esc(display)}</div></div>`;
    }
    function SH(t) { return `<div class="me-section-head">${t}</div>`; }

    function camperBody(name,d,addr) {
        const st=getStructure(); const divs=Object.keys(st);
        if(panelTab==='info') {
            let h=FR('Birthday',d.birthday,'birthday',{type:'date'});
            if(!panelEditing&&getAge(d.birthday)!==null) h+=FR('Age',getAge(d.birthday)+' years','_');
            if(panelEditing) {
                h+=FR('Address',d.address,'address',{ph:'Street address'});
                h+=FR('City',d.city,'city',{ph:'City'}); h+=FR('State',d.state,'state',{ph:'State'}); h+=FR('Zip',d.zip,'zip',{ph:'ZIP code'});
            } else {
                h+=FR('Address',addr,'_addr');
            }
            if(panelEditing) {
                const grades=panelForm.division&&st[panelForm.division]?Object.keys(st[panelForm.division].grades||{}):[];
                const bunks=panelForm.division&&panelForm.grade&&st[panelForm.division]?.grades?.[panelForm.grade]?st[panelForm.division].grades[panelForm.grade].bunks||[]:[];
                h+=`<div class="me-field-row"><div class="me-field-label">Division</div><div style="flex:1"><select onchange="CampistryMeV8._set('division',this.value);CampistryMeV8._set('grade','');CampistryMeV8._set('bunk','');CampistryMeV8.renderPanel()"><option value="">—</option>${divs.map(dv=>`<option${dv===panelForm.division?' selected':''}>${esc(dv)}</option>`).join('')}</select></div></div>`;
                h+=`<div class="me-field-row"><div class="me-field-label">Grade</div><div style="flex:1"><select onchange="CampistryMeV8._set('grade',this.value);CampistryMeV8._set('bunk','');CampistryMeV8.renderPanel()"><option value="">—</option>${grades.map(g=>`<option${g===panelForm.grade?' selected':''}>${esc(g)}</option>`).join('')}</select></div></div>`;
                h+=`<div class="me-field-row"><div class="me-field-label">Bunk</div><div style="flex:1"><select onchange="CampistryMeV8._set('bunk',this.value)"><option value="">—</option>${bunks.map(b=>`<option${b===panelForm.bunk?' selected':''}>${esc(b)}</option>`).join('')}</select></div></div>`;
            } else { h+=FR('Division',d.division,'division'); h+=FR('Grade',d.grade,'grade'); h+=FR('Bunk',d.bunk,'bunk'); }
            h+=FR('Team',d.team,'team');
            return h;
        }
        if(panelTab==='medical') {
            return SH('ALLERGIES & DIETARY')+FR('Allergies',d.allergies,'allergies',{ph:'e.g., Peanuts, Bee stings'})+FR('Dietary',d.dietary,'dietary',{ph:'e.g., Vegetarian'})+SH('MEDICATIONS')+FR('Medications',d.medications,'medications',{ph:'Name, dosage, timing',ta:true})+SH('MEDICAL NOTES')+FR('Notes',d.medicalNotes,'medicalNotes',{ph:'Conditions, staff instructions…',ta:true});
        }
        if(panelTab==='guardians') {
            const gs=panelEditing?(panelForm.guardians||[]):(d.guardians||[]);
            let h='';
            gs.forEach((g,i)=>{
                h+=`<div class="me-guardian-card"><div class="me-guardian-label"><span>${esc(g.relation||'Guardian')} ${i===0?'(Primary)':'#'+(i+1)}</span>${panelEditing&&gs.length>1?`<button class="me-pill me-pill-danger me-pill-xs" onclick="CampistryMeV8._rmGuardian(${i})">Remove</button>`:''}</div>`;
                if(panelEditing) {
                    h+=`<div style="display:flex;flex-wrap:wrap;gap:10px">`;
                    ['firstName','lastName','relation','phone','email'].forEach(k=>{
                        const lbl={firstName:'First Name',lastName:'Last Name',relation:'Relation',phone:'Phone',email:'Email'}[k];
                        h+=`<div style="flex:1 1 45%;min-width:140px"><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:2px">${lbl}</label><input type="${k==='email'?'email':k==='phone'?'tel':'text'}" value="${esc(g[k]||g.name||'')}" onchange="CampistryMeV8._setG(${i},'${k}',this.value)"></div>`;
                    });
                    h+='</div>';
                } else {
                    const gname=[g.firstName,g.lastName].filter(Boolean).join(' ')||g.name||'';
                    h+=FR('Name',gname,'_'); h+=FR('Relation',g.relation,'_'); h+=FR('Email',g.email,'_'); h+=FR('Phone',g.phone,'_');
                    if(g.phone) h+=`<div style="display:flex;gap:6px;margin-top:8px"><a href="tel:${esc(g.phone)}" class="me-action-link">Call</a>${g.email?`<a href="mailto:${esc(g.email)}" class="me-action-link">Email</a>`:''}</div>`;
                }
                h+='</div>';
            });
            if(!gs.length&&!panelEditing) h+='<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">No guardians added yet.</div>';
            if(panelEditing) h+=`<button class="me-pill me-pill-secondary me-pill-sm" onclick="CampistryMeV8._addGuardian()">+ Add Guardian</button>`;
            return h;
        }
        if(panelTab==='tuition') {
            let h=FR('Total',d.tuitionTotal,'tuitionTotal',{type:'number',money:true})+FR('Paid',d.tuitionPaid,'tuitionPaid',{type:'number',money:true});
            if(!panelEditing&&d.tuitionTotal>0) { const bal=(d.tuitionTotal||0)-(d.tuitionPaid||0); h+=`<div class="me-balance-card ${bal<=0?'paid':'owed'}"><div class="me-balance-label">${bal<=0?'Paid in Full':'Balance'}</div><div class="me-balance-amount">${fmtMoney(Math.abs(bal))}</div></div>`; }
            h+='<div style="margin-top:14px">'+FR('Notes',d.tuitionNotes,'tuitionNotes',{ph:'Payment plan, scholarship…',ta:true})+'</div>';
            return h;
        }
        if(panelTab==='notes') return FR('Notes',d.notes,'notes',{ph:'Personality, interests…',ta:true});
        return '';
    }

    function staffBody(name,d) {
        if(panelTab==='personal') {
            let h=FR('Birthday',d.birthday,'birthday',{type:'date'})+FR('Start Date',d.startDate,'startDate',{type:'date'})+FR('Phone',d.phone,'phone',{type:'tel'})+FR('Email',d.email,'email',{type:'email'});
            if(panelEditing) { h+=FR('Address',d.address,'address',{ph:'Street'})+FR('City',d.city,'city')+FR('State',d.state,'state')+FR('Zip',d.zip,'zip'); }
            else { const addr=[d.address,d.city,d.state,d.zip].filter(Boolean).join(', '); h+=FR('Address',addr,'_'); }
            h+=FR('Role',d.role,'role')+FR('Division',d.division,'division');
            return h;
        }
        if(panelTab==='salary') {
            let h=FR('Pay Type',d.salaryType,'salaryType',{ph:'seasonal, hourly'})+FR(d.salaryType==='hourly'?'Rate':'Total',d.salaryAmount,'salaryAmount',{type:'number',money:true})+FR('Paid',d.salaryPaid,'salaryPaid',{type:'number',money:true});
            if(!panelEditing) { const bal=(d.salaryAmount||0)-(d.salaryPaid||0); h+=`<div class="me-balance-card ${bal<=0?'paid':'owed-staff'}"><div class="me-balance-label">${bal<=0?'Fully Paid':'Remaining'}</div><div class="me-balance-amount">${fmtMoney(Math.abs(bal))}</div></div>`; }
            h+='<div style="margin-top:12px">'+FR('Notes',d.salaryNotes,'salaryNotes',{ph:'Schedule…',ta:true})+'</div>';
            return h;
        }
        if(panelTab==='notes') return FR('Notes',d.notes,'notes',{ph:'Certifications…',ta:true});
        return '';
    }

    // ── Panel actions ──
    function _startEdit() {
        const {type,name}=currentPanel;
        panelForm=JSON.parse(JSON.stringify(type==='camper'?(getCampers()[name]||{}):(staffRoster[name]||{})));
        if(type==='camper'&&!panelForm.guardians) panelForm.guardians=[];
        panelForm._displayName=name;
        panelEditing=true; renderPanel();
    }
    function _cancelEdit() { panelEditing=false; renderPanel(); }
    function _saveEdit() {
        const {type,name}=currentPanel;
        const newName=document.getElementById('pnName')?.value?.trim()||name;
        if(type==='camper') {
            saveCamperExt(newName!==name?newName:name,panelForm);
            if(newName!==name) { const g=readLocal(); if(g.app1?.camperRoster?.[name]) { delete g.app1.camperRoster[name]; writeLocal(g); } currentPanel.name=newName; }
            triggerSave();
        } else {
            if(newName!==name) { staffRoster[newName]={...panelForm}; delete staffRoster[name]; currentPanel.name=newName; }
            else staffRoster[name]={...panelForm};
            saveStaff();
        }
        panelEditing=false; renderPanel(); renderStats(); renderStaffTab(); triggerRender(); setTimeout(patchCamperTable,100); toast('Saved');
    }
    function _delete() {
        const {type,name}=currentPanel;
        if(!confirm('Delete "'+name+'"?')) return;
        if(type==='camper') { const g=readLocal(); if(g.app1?.camperRoster?.[name]) delete g.app1.camperRoster[name]; writeLocal(g); triggerSave(); }
        else { delete staffRoster[name]; saveStaff(); }
        closePanel(); renderStats(); renderStaffTab(); triggerRender(); setTimeout(patchCamperTable,100); toast('Deleted');
    }

    // =========================================================================
    // GRANULAR CSV IMPORT — CAMPERS
    // =========================================================================
    // Columns: First Name, Middle Name, Last Name, Division, Grade, Bunk, Team,
    // Birthday, Address, City, State, Zip, Allergies, Dietary, Medications,
    // Parent 1 First, Parent 1 Last, Parent 1 Phone, Parent 1 Email, Parent 1 Relation,
    // Parent 2 First, Parent 2 Last, Parent 2 Phone, Parent 2 Email, Parent 2 Relation,
    // Tuition Total, Tuition Paid
    function downloadCamperTemplate() {
        const hdr='First Name,Middle Name,Last Name,Division,Grade,Bunk,Team,Birthday,Address,City,State,Zip,Allergies,Dietary,Medications,Parent 1 First,Parent 1 Last,Parent 1 Phone,Parent 1 Email,Parent 1 Relation,Parent 2 First,Parent 2 Last,Parent 2 Phone,Parent 2 Email,Parent 2 Relation,Tuition Total,Tuition Paid';
        const row1='Ethan,,Miller,Junior Boys,3rd Grade,Bunk 1A,Red,2016-05-14,42 Maple St,Woodmere,NY,11598,Peanuts,Nut-free,EpiPen,Sarah,Miller,(555) 234-5678,sarah@email.com,Mother,David,Miller,(555) 345-6789,david@email.com,Father,8500,5000';
        const row2='Olivia,,Chen,Junior Girls,3rd Grade,Bunk 3A,Blue,2016-08-22,118 Ocean Ave,Brooklyn,NY,11225,,Vegetarian,,Lisa,Chen,(555) 456-7890,lisa@email.com,Mother,,,,,,8500,8500';
        const csv='\uFEFF'+hdr+'\n'+row1+'\n'+row2;
        const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
        a.download='camper_import_template.csv'; a.click(); toast('Template downloaded');
    }

    function importCamperCsv() {
        const input=document.createElement('input'); input.type='file'; input.accept='.csv,.txt';
        input.onchange=e=>{
            const file=e.target.files?.[0]; if(!file) return;
            const reader=new FileReader();
            reader.onload=ev=>processCamperCsv(ev.target.result);
            reader.readAsText(file);
        };
        input.click();
    }

    function processCamperCsv(text) {
        if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
        const lines=text.split(/\r?\n/).filter(l=>l.trim());
        if(lines.length<2) { toast('CSV needs header + data','error'); return; }
        // Parse header
        const hdr=parseLine(lines[0]).map(h=>h.toLowerCase().trim());
        const col=name=>hdr.indexOf(name);
        const get=(cols,name)=>{const i=col(name);return i>=0?(cols[i]||'').trim():'';};

        let added=0,updated=0;
        for(let i=1;i<Math.min(lines.length,10001);i++) {
            const c=parseLine(lines[i]);
            const first=get(c,'first name'); const mid=get(c,'middle name'); const last=get(c,'last name');
            // Also support single "Name" column for backward compat
            let fullName=[first,mid,last].filter(Boolean).join(' ');
            if(!fullName) fullName=get(c,'name');
            if(!fullName) continue;

            const existing=getCampers()[fullName]||{};
            const data={
                ...existing,
                firstName:first||existing.firstName||'', middleName:mid||existing.middleName||'', lastName:last||existing.lastName||'',
                division:get(c,'division')||existing.division||'', grade:get(c,'grade')||existing.grade||'',
                bunk:get(c,'bunk')||existing.bunk||'', team:get(c,'team')||existing.team||'',
                birthday:get(c,'birthday')||existing.birthday||'',
                address:get(c,'address')||existing.address||'', city:get(c,'city')||existing.city||'',
                state:get(c,'state')||existing.state||'', zip:get(c,'zip')||existing.zip||'',
                allergies:get(c,'allergies')||existing.allergies||'', dietary:get(c,'dietary')||existing.dietary||'',
                medications:get(c,'medications')||existing.medications||'',
            };
            // Tuition
            const tt=get(c,'tuition total'); if(tt) data.tuitionTotal=Number(tt)||0;
            const tp=get(c,'tuition paid'); if(tp) data.tuitionPaid=Number(tp)||0;

            // Guardians from parent columns
            const guardians=existing.guardians?[...existing.guardians]:[];
            const p1f=get(c,'parent 1 first'); const p1l=get(c,'parent 1 last');
            if(p1f||p1l) {
                const g1={firstName:p1f,lastName:p1l,phone:get(c,'parent 1 phone'),email:get(c,'parent 1 email'),relation:get(c,'parent 1 relation'),name:[p1f,p1l].filter(Boolean).join(' ')};
                if(guardians.length>0) guardians[0]={...guardians[0],...g1}; else guardians.push(g1);
            }
            const p2f=get(c,'parent 2 first'); const p2l=get(c,'parent 2 last');
            if(p2f||p2l) {
                const g2={firstName:p2f,lastName:p2l,phone:get(c,'parent 2 phone'),email:get(c,'parent 2 email'),relation:get(c,'parent 2 relation'),name:[p2f,p2l].filter(Boolean).join(' ')};
                if(guardians.length>1) guardians[1]={...guardians[1],...g2}; else guardians.push(g2);
            }
            if(guardians.length>0) data.guardians=guardians;

            if(getCampers()[fullName]) updated++; else added++;
            saveCamperExt(fullName,data);

            // Also ensure the base roster entry exists (for Flow compatibility)
            const g=readLocal(); if(!g.app1) g.app1={}; if(!g.app1.camperRoster) g.app1.camperRoster={};
            if(!g.app1.camperRoster[fullName]) g.app1.camperRoster[fullName]={division:data.division,grade:data.grade,bunk:data.bunk,team:data.team};
            else Object.assign(g.app1.camperRoster[fullName],{division:data.division,grade:data.grade,bunk:data.bunk,team:data.team});
            writeLocal(g);
        }
        triggerSave(); triggerRender(); renderStats(); setTimeout(patchCamperTable,200);
        toast(`${added} added, ${updated} updated`);
    }

    // =========================================================================
    // GRANULAR CSV IMPORT — STAFF
    // =========================================================================
    function downloadStaffTemplate() {
        const hdr='First Name,Middle Name,Last Name,Role,Division,Phone,Email,Address,City,State,Zip,Birthday,Start Date,Salary Type,Salary Amount';
        const row1='Jake,,Torres,Head Counselor,Junior Boys,(555) 700-1001,jake@camp.com,15 Elm St,Valley Stream,NY,11580,1998-06-12,2024-06-15,seasonal,6500';
        const csv='\uFEFF'+hdr+'\n'+row1;
        const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
        a.download='staff_import_template.csv'; a.click(); toast('Template downloaded');
    }

    function importStaffCsv() {
        const input=document.createElement('input'); input.type='file'; input.accept='.csv,.txt';
        input.onchange=e=>{
            const file=e.target.files?.[0]; if(!file) return;
            const reader=new FileReader();
            reader.onload=ev=>processStaffCsv(ev.target.result);
            reader.readAsText(file);
        };
        input.click();
    }

    function processStaffCsv(text) {
        if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
        const lines=text.split(/\r?\n/).filter(l=>l.trim());
        if(lines.length<2) { toast('CSV needs header + data','error'); return; }
        const hdr=parseLine(lines[0]).map(h=>h.toLowerCase().trim());
        const col=name=>hdr.indexOf(name); const get=(c,n)=>{const i=col(n);return i>=0?(c[i]||'').trim():'';};
        let added=0;
        for(let i=1;i<Math.min(lines.length,5001);i++) {
            const c=parseLine(lines[i]);
            const first=get(c,'first name'); const mid=get(c,'middle name'); const last=get(c,'last name');
            let name=[first,mid,last].filter(Boolean).join(' ');
            if(!name) name=get(c,'name');
            if(!name) continue;
            if(staffRoster[name]) continue; // skip duplicates
            staffRoster[name]={
                firstName:first,middleName:mid,lastName:last,
                role:get(c,'role'),division:get(c,'division'),phone:get(c,'phone'),email:get(c,'email'),
                address:get(c,'address'),city:get(c,'city'),state:get(c,'state'),zip:get(c,'zip'),
                birthday:get(c,'birthday'),startDate:get(c,'start date'),
                salaryType:get(c,'salary type')||'seasonal',salaryAmount:Number(get(c,'salary amount'))||0,
                salaryPaid:0,salaryNotes:'',photo:'',notes:''
            };
            added++;
        }
        saveStaff(); renderStaffTab(); renderStats(); toast(added+' staff imported');
    }

    function parseLine(line) { const r=[]; let cur='',q=false; for(const ch of line){if(ch==='"')q=!q;else if(ch===','&&!q){r.push(cur);cur='';}else cur+=ch;} r.push(cur); return r.map(s=>s.replace(/""/g,'"').trim()); }

    // =========================================================================
    // ADD STAFF (simple prompt-based for now)
    // =========================================================================
    function addStaff() {
        const name=prompt('Staff member full name:');
        if(!name||!name.trim()) return;
        if(staffRoster[name.trim()]) { toast('Already exists','error'); return; }
        staffRoster[name.trim()]={role:'',division:'',phone:'',email:'',address:'',city:'',state:'',zip:'',birthday:'',startDate:'',salaryType:'seasonal',salaryAmount:0,salaryPaid:0,salaryNotes:'',photo:'',notes:''};
        saveStaff(); renderStaffTab(); renderStats(); toast('Staff added');
        openPanel('staff',name.trim());
    }

    // =========================================================================
    // EXPORT CAMPER CSV (granular columns)
    // =========================================================================
    function exportCamperCsv() {
        const campers=getCampers(); const entries=Object.entries(campers);
        if(!entries.length) { toast('No campers','error'); return; }
        const hdr='First Name,Middle Name,Last Name,Division,Grade,Bunk,Team,Birthday,Address,City,State,Zip,Allergies,Dietary,Medications,Parent 1 First,Parent 1 Last,Parent 1 Phone,Parent 1 Email,Parent 1 Relation,Parent 2 First,Parent 2 Last,Parent 2 Phone,Parent 2 Email,Parent 2 Relation,Tuition Total,Tuition Paid';
        const cf=v=>'"'+String(v||'').replace(/"/g,'""')+'"';
        let csv='\uFEFF'+hdr+'\n';
        entries.forEach(([name,d])=>{
            const parts=name.split(' '); const first=d.firstName||parts[0]||''; const last=d.lastName||parts[parts.length-1]||''; const mid=d.middleName||(parts.length>2?parts.slice(1,-1).join(' '):'');
            const g1=(d.guardians||[])[0]||{}; const g2=(d.guardians||[])[1]||{};
            csv+=[first,mid,last,d.division,d.grade,d.bunk,d.team,d.birthday,d.address,d.city,d.state,d.zip,d.allergies,d.dietary,d.medications,g1.firstName||'',g1.lastName||'',g1.phone||'',g1.email||'',g1.relation||'',g2.firstName||'',g2.lastName||'',g2.phone||'',g2.email||'',g2.relation||'',d.tuitionTotal||'',d.tuitionPaid||''].map(cf).join(',')+'\n';
        });
        const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
        a.download='campers_'+new Date().toISOString().split('T')[0]+'.csv'; a.click(); toast('Exported '+entries.length+' campers');
    }

    // =========================================================================
    // INIT
    // =========================================================================
    function init() {
        loadStaff(); renderStats();

        // Wire up buttons
        document.getElementById('addStaffBtn')?.addEventListener('click',addStaff);
        document.getElementById('downloadStaffTemplateBtn')?.addEventListener('click',downloadStaffTemplate);
        document.getElementById('importStaffCsvBtn')?.addEventListener('click',importStaffCsv);
        document.getElementById('staffSearchInput')?.addEventListener('input',function(){clearTimeout(this._d);this._d=setTimeout(renderStaffTab,150);});

        // Override camper CSV buttons to use granular format
        const dlBtn=document.getElementById('downloadTemplateBtn');
        if(dlBtn) { dlBtn.onclick=null; dlBtn.addEventListener('click',function(e){e.stopPropagation();downloadCamperTemplate();}); }
        const impBtn=document.getElementById('importCsvBtn');
        if(impBtn) { impBtn.onclick=null; impBtn.addEventListener('click',function(e){e.stopPropagation();importCamperCsv();}); }
        const expBtn=document.getElementById('exportCsvBtn');
        if(expBtn) { expBtn.onclick=null; expBtn.addEventListener('click',function(e){e.stopPropagation();exportCamperCsv();}); }

        // Monkey-patch camper table render
        const origRender=window.CampistryMe?.renderCamperTable;
        if(origRender) { window.CampistryMe.renderCamperTable=function(){origRender.apply(this,arguments);setTimeout(patchCamperTable,50);}; }

        // Tab switches
        document.querySelectorAll('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>setTimeout(()=>{patchCamperTable();renderStats();renderStaffTab();},100)));

        // Panel overlay click-to-close
        document.getElementById('mePanelOverlay')?.addEventListener('click',e=>{if(e.target.id==='mePanelOverlay')closePanel();});
        document.addEventListener('keydown',e=>{if(e.key==='Escape'&&currentPanel)closePanel();});

        renderStaffTab(); setTimeout(patchCamperTable,500);
        console.log('[Me v8] Ready');
    }

    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(init,300));
    else setTimeout(init,300);

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryMeV8={
        openPanel, closePanel, renderPanel, renderStaffTab, renderStats,
        _startEdit, _cancelEdit, _saveEdit, _delete,
        _set:(k,v)=>{panelForm[k]=v;},
        _setTab:(t)=>{panelTab=t;renderPanel();},
        _setG:(i,k,v)=>{if(panelForm.guardians?.[i])panelForm.guardians[i][k]=v;},
        _addGuardian:()=>{if(!panelForm.guardians)panelForm.guardians=[];panelForm.guardians.push({firstName:'',lastName:'',phone:'',email:'',relation:''});renderPanel();},
        _rmGuardian:(i)=>{panelForm.guardians.splice(i,1);renderPanel();},
        _handlePhoto:(e)=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>{panelForm.photo=ev.target.result;renderPanel();};r.readAsDataURL(f);},
    };
})();
