// =============================================================================
// campistry_me.js — Campistry Me v8.0
// Unified: Structure + Campers + Staff + Profiles + CSV + Cloud Sync
// =============================================================================
(function() {
    'use strict';
    console.log('[Me] Campistry Me v8.0 loading...');

    // =========================================================================
    // STATE
    // =========================================================================
    let structure = {};
    let camperRoster = {};
    let staffRoster = {};
    let leagueTeams = [];
    let _leagueData = [];
    let expandedDivisions = new Set();
    let expandedGrades = new Set();
    let currentEditDivision = null;
    let currentEditCamper = null;
    let sortColumn = 'name';
    let sortDirection = 'asc';
    let pendingCsvData = [];

    // Panel state
    let currentPanel = null; // { type:'camper'|'staff', name }
    let panelTab = 'info';
    let panelEditing = false;
    let panelForm = {};

    // Cloud sync
    let _cloudSaveTimeout = null;
    let _cloudVersion = null;
    let _pendingMergeData = null;
    let _searchDebounceTimeout = null;
    let _toastTimeout = null;
    let _lastCloudFetchTime = 0;
    const CLOUD_SAVE_DEBOUNCE_MS = 800;
    const CLOUD_FETCH_COOLDOWN_MS = 10000;
    const MAX_NAME_LENGTH = 100;
    const MAX_CSV_FILE_SIZE = 5 * 1024 * 1024;
    const MAX_CSV_ROWS = 10000;
    const MAX_CLOUD_RETRIES = 3;

    const COLOR_PRESETS = ['#00C896','#6366F1','#F59E0B','#EF4444','#8B5CF6','#3B82F6','#10B981','#EC4899','#F97316','#14B8A6','#84CC16','#A855F7','#06B6D4','#F43F5E','#22C55E','#FBBF24'];

    // =========================================================================
    // CLOUD SYNC HELPERS
    // =========================================================================
    function getSupabaseClient() { return window.CampistryDB?.getClient?.() || window.supabase || null; }
    let _cachedCampId = null;
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function isValidUuid(s) { return s && typeof s === 'string' && UUID_REGEX.test(s); }

    function getCampId() {
        if (_cachedCampId) return _cachedCampId;
        const candidates = [window.CampistryDB?.getCampId?.(), localStorage.getItem('campistry_camp_id'), localStorage.getItem('campistry_user_id')];
        for (const c of candidates) { if (isValidUuid(c)) return c; }
        return null;
    }

    async function ensureCampId() {
        if (_cachedCampId) return _cachedCampId;
        try { const client = getSupabaseClient(); if (client) { const { data } = await client.auth.getSession(); if (data?.session?.user?.id) { _cachedCampId = data.session.user.id; return _cachedCampId; } } } catch (_) {}
        return getCampId();
    }

    async function loadFromCloud() {
        const client = getSupabaseClient(); const campId = await ensureCampId();
        if (!client || !campId) return null;
        try {
            try { await client.auth.getSession(); } catch (_) {}
            const { data, error } = await client.from('camp_state').select('state, version').eq('camp_id', campId).single();
            if (error) { if (error.code === 'PGRST116') return null; console.warn('[Me] Cloud load error:', error.message); return null; }
            if (data?.state) { _cloudVersion = data.version || null; return data.state; }
            return null;
        } catch (e) { console.error('[Me] Cloud load exception:', e); return null; }
    }

    async function saveToCloud(mergeData, _retryCount) {
        const retryCount = _retryCount || 0;
        const client = getSupabaseClient(); const campId = await ensureCampId();
        if (!client || !campId || !navigator.onLine) return false;
        try {
            try { await client.auth.getSession(); } catch (_) {}
            const { data: current, error: fetchError } = await client.from('camp_state').select('state, version').eq('camp_id', campId).single();
            if (fetchError && fetchError.code !== 'PGRST116') {
                const msg = fetchError.message || '';
                if (msg.includes('401') || msg.includes('JWT') || msg.includes('expired')) { toast('Session expired — please reload', 'error'); return false; }
                if (msg.includes('403') || msg.includes('permission')) { toast('Permission denied', 'error'); return false; }
            }
            const currentState = current?.state || {};
            const currentVersion = current?.version || null;
            if (_cloudVersion && currentVersion && currentVersion !== _cloudVersion) {
                if (retryCount >= MAX_CLOUD_RETRIES) { toast('Sync conflict — please reload', 'error'); return false; }
                _cloudVersion = currentVersion;
                return await saveToCloud(mergeData, retryCount + 1);
            }
            const currentApp1 = currentState.app1 || {};
            const mergeApp1 = mergeData.app1 || {};
            const mergedApp1 = { ...currentApp1 };
            if (mergeApp1.camperRoster !== undefined) mergedApp1.camperRoster = mergeApp1.camperRoster;
            if (mergeApp1.divisions !== undefined) mergedApp1.divisions = mergeApp1.divisions;
            if (mergeApp1.staffRoster !== undefined) mergedApp1.staffRoster = mergeApp1.staffRoster;
            const newState = { ...currentState, ...mergeData, app1: mergedApp1, updated_at: new Date().toISOString() };
            const { data: upsertData, error: upsertError } = await client.from('camp_state').upsert({ camp_id: campId, state: newState, updated_at: new Date().toISOString() }, { onConflict: 'camp_id' }).select('version').single();
            if (upsertError) { console.error('[Me] Cloud save error:', upsertError.message); return false; }
            if (upsertData?.version) _cloudVersion = upsertData.version;
            return true;
        } catch (e) { console.error('[Me] Cloud save exception:', e); return false; }
    }

    function scheduleCloudSave(mergeData) {
        _pendingMergeData = mergeData;
        if (_cloudSaveTimeout) clearTimeout(_cloudSaveTimeout);
        _cloudSaveTimeout = setTimeout(async () => { _pendingMergeData = null; const ok = await saveToCloud(mergeData); setSyncStatus(ok ? 'synced' : 'error'); }, CLOUD_SAVE_DEBOUNCE_MS);
    }

    // =========================================================================
    // LOCAL STORAGE
    // =========================================================================
    function readLocalSettings() {
        try { const r = localStorage.getItem('campGlobalSettings_v1'); if (r) { const p = JSON.parse(r); if (Object.keys(p).length > 1) return p; } } catch (e) {}
        try { const r = localStorage.getItem('campistryGlobalSettings'); if (r) return JSON.parse(r); } catch (e) {}
        return {};
    }
    function writeLocalSettings(data) {
        const json = JSON.stringify(data);
        try { localStorage.setItem('campistryGlobalSettings', json); localStorage.setItem('campGlobalSettings_v1', json); localStorage.setItem('CAMPISTRY_LOCAL_CACHE', json); }
        catch (e) { console.error('[Me] localStorage write failed:', e.message); toast('Local storage full', 'error'); }
    }

    // =========================================================================
    // INIT / AUTH / LOAD
    // =========================================================================
    async function init() {
        const authed = await checkAuth();
        if (!authed) return;
        if (window.CampistryDB?.initialize) { try { await window.CampistryDB.initialize(); } catch (e) {} }
        await loadAllData();
        setupEventListeners();
        setupTabs();
        setupColorPresets();
        renderAll();
        renderStaffTab();
        renderV8Stats();
        document.getElementById('auth-loading-screen').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
        setTimeout(patchCamperTable, 300);
        console.log('[Me] Ready');
    }

    async function checkAuth() {
        const cachedUserId = localStorage.getItem('campistry_auth_user_id');
        const cachedCampId = localStorage.getItem('campistry_camp_id');
        const hasLocalAuth = !!(cachedUserId && cachedCampId);
        try {
            let attempts = 0;
            while ((!window.supabase || !window.supabase.auth) && attempts < 20) { await new Promise(r => setTimeout(r, 100)); attempts++; }
            if (!window.supabase || !window.supabase.auth) { if (hasLocalAuth) { _cachedCampId = cachedCampId; return true; } window.location.href = 'index.html'; return false; }
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) {
                if (hasLocalAuth) {
                    const { data: rd, error: re } = await window.supabase.auth.refreshSession();
                    if (re || !rd?.session) { if (hasLocalAuth) { _cachedCampId = cachedCampId; return true; } window.location.href = 'index.html'; return false; }
                    _cachedCampId = rd.session.user.id; return true;
                }
                window.location.href = 'index.html'; return false;
            }
            _cachedCampId = session.user.id; return true;
        } catch (e) { if (hasLocalAuth) { _cachedCampId = cachedCampId; return true; } window.location.href = 'index.html'; return false; }
    }

    async function loadAllData() {
        if (window.CampistryDB?.ready) await window.CampistryDB.ready;
        let local = readLocalSettings(); let cloud = null;
        try { cloud = await loadFromCloud(); } catch (e) {}
        let global;
        const localHasData = Object.keys(local.campStructure || local.app1?.divisions || {}).length > 0 || Object.keys(local.app1?.camperRoster || {}).length > 0;
        const cloudHasData = cloud && (Object.keys(cloud.campStructure || cloud.app1?.divisions || {}).length > 0 || Object.keys(cloud.app1?.camperRoster || {}).length > 0);
        if (cloudHasData && localHasData) {
            const ct = new Date(cloud.updated_at || 0).getTime(); const lt = new Date(local.updated_at || 0).getTime();
            if (lt > ct) { const ma = { ...(cloud.app1 || {}) }; const la = local.app1 || {}; ma.camperRoster = la.camperRoster || ma.camperRoster; ma.divisions = la.divisions || ma.divisions; ma.staffRoster = la.staffRoster || ma.staffRoster; global = { ...cloud, ...local, app1: ma }; scheduleCloudSave({ campStructure: global.campStructure, app1: global.app1, updated_at: new Date().toISOString() }); }
            else { global = cloud; writeLocalSettings(cloud); }
        } else if (cloudHasData) { global = cloud; writeLocalSettings(cloud); }
        else if (localHasData) { global = local; scheduleCloudSave({ campStructure: local.campStructure, app1: local.app1, updated_at: new Date().toISOString() }); }
        else { global = {}; }

        camperRoster = global?.app1?.camperRoster || {};
        staffRoster = global?.app1?.staffRoster || {};

        if (global?.campStructure && Object.keys(global.campStructure).length > 0) { structure = global.campStructure; }
        else { const lb = readLocalSettings(); structure = migrateOldStructure(global?.app1?.divisions || {}, lb.campStructure || {}); }

        _leagueData = []; const allTeams = new Set();
        const addL = l => { if (!l || !Array.isArray(l.teams) || !l.teams.length) return; _leagueData.push({ teams: l.teams, divisions: Array.isArray(l.divisions) ? l.divisions : [] }); l.teams.forEach(t => allTeams.add(t)); };
        Object.values(global?.leaguesByName || {}).forEach(addL);
        Object.values(global?.specialtyLeagues || {}).forEach(addL);
        leagueTeams = Array.from(allTeams).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        Object.keys(structure).forEach(d => expandedDivisions.add(d));
        console.log('[Me] Loaded', Object.keys(structure).length, 'divisions,', Object.keys(camperRoster).length, 'campers,', Object.keys(staffRoster).length, 'staff');
    }

    function migrateOldStructure(oldDivisions, localCS) {
        const ns = {};
        Object.entries(oldDivisions).forEach(([dn, dd]) => {
            if (isUnsafeName(dn) || !dd || typeof dd !== 'object') return;
            const bunks = (dd.bunks || []).map(b => typeof b === 'string' ? b : b.name);
            const color = (dd.color && dd.color !== '#00C896' ? dd.color : null) || localCS[dn]?.color || dd.color || COLOR_PRESETS[Object.keys(ns).length % COLOR_PRESETS.length];
            ns[dn] = { color: sanitizeColor(color), grades: localCS[dn]?.grades || (bunks.length > 0 ? { 'Default': { bunks } } : {}) };
        });
        return ns;
    }

    function convertToOldFormat(struct) {
        const existing = readLocalSettings();
        const existingDivs = (existing.app1 && existing.app1.divisions) || {};
        const merged = {};
        Object.entries(struct).forEach(([dn, dd]) => {
            const allBunks = []; Object.values(dd.grades || {}).forEach(g => (g.bunks || []).forEach(b => allBunks.push(b)));
            merged[dn] = { ...(existingDivs[dn] || {}), color: sanitizeColor(dd.color), bunks: allBunks };
        });
        Object.keys(existingDivs).forEach(dn => { if (!merged[dn]) merged[dn] = existingDivs[dn]; });
        return merged;
    }

    // =========================================================================
    // SAVE DATA
    // =========================================================================
    function saveData() {
        try {
            setSyncStatus('syncing');
            const global = readLocalSettings();
            global.campStructure = structure;
            if (!global.app1) global.app1 = {};
            global.app1.camperRoster = camperRoster;
            global.app1.staffRoster = staffRoster;
            global.app1.divisions = convertToOldFormat(structure);
            global.updated_at = new Date().toISOString();
            writeLocalSettings(global);
            if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
                window.saveGlobalSettings('campStructure', structure);
                window.saveGlobalSettings('app1', global.app1);
            } else {
                scheduleCloudSave({ campStructure: structure, app1: global.app1, updated_at: global.updated_at });
            }
        } catch (e) { console.error('[Me] Save error:', e); setSyncStatus('error'); }
    }

    // League team filtering
    function _extractGradeNumber(str) { if(!str)return null; const s=String(str).toLowerCase().trim(); const o=s.match(/^(\d+)(st|nd|rd|th)?\s*(grade)?$/); if(o)return parseInt(o[1],10); const g=s.match(/^grade\s*(\d+)$/); if(g)return parseInt(g[1],10); const b=s.match(/^(\d+)$/); if(b)return parseInt(b[1],10); return null; }
    function _divisionMatches(a,b) { if(!a||!b)return false; const la=String(a).toLowerCase().trim(),lb=String(b).toLowerCase().trim(); if(la===lb)return true; const na=_extractGradeNumber(a),nb=_extractGradeNumber(b); if(na!==null&&nb!==null)return na===nb; if(na===null&&nb===null)return la.includes(lb)||lb.includes(la); return false; }
    function getTeamsForContext(div,grade) {
        if(!div&&!grade) return leagueTeams;
        const m=new Set(); _leagueData.forEach(ld=>{ if(!ld.divisions.length){ld.teams.forEach(t=>m.add(t));return;} if((div&&ld.divisions.some(d=>_divisionMatches(d,div)))||(grade&&ld.divisions.some(d=>_divisionMatches(d,grade)))) ld.teams.forEach(t=>m.add(t)); });
        return m.size?Array.from(m).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})):leagueTeams;
    }

    // Sync status
    function setSyncStatus(status) {
        const dot=document.getElementById('syncDot'), text=document.getElementById('syncText');
        if(status==='syncing'){dot?.classList.add('syncing');if(text)text.textContent='Syncing...';}
        else if(status==='synced'){dot?.classList.remove('syncing');if(dot)dot.style.background='#059669';if(text)text.textContent='Synced';}
        else{dot?.classList.remove('syncing');if(dot)dot.style.background='#ef4444';if(text)text.textContent='Error';}
    }

    // =========================================================================
    // RENDER
    // =========================================================================
    function renderAll() { updateStats(); renderHierarchy(); renderCamperTable(); renderV8Stats(); }

    function updateStats() {
        let gc=0,bc=0; Object.values(structure).forEach(d=>{gc+=Object.keys(d.grades||{}).length;Object.values(d.grades||{}).forEach(g=>bc+=(g.bunks||[]).length);});
        const el=id=>document.getElementById(id);
        if(el('statDivisions'))el('statDivisions').textContent=Object.keys(structure).length;
        if(el('statGrades'))el('statGrades').textContent=gc;
        if(el('statBunks'))el('statBunks').textContent=bc;
        if(el('statCampers'))el('statCampers').textContent=Object.keys(camperRoster).length;
    }

    function renderV8Stats() {
        const el=document.getElementById('v8StatsBar'); if(!el) return;
        const med=Object.values(camperRoster).filter(c=>c.allergies||c.medications).length;
        const tOwe=Object.values(camperRoster).reduce((s,c)=>s+Math.max(0,(c.tuitionTotal||0)-(c.tuitionPaid||0)),0);
        const sOwe=Object.values(staffRoster).reduce((s,m)=>s+Math.max(0,(m.salaryAmount||0)-(m.salaryPaid||0)),0);
        const sc=Object.keys(staffRoster).length;
        const st=(l,v,w)=>'<div class="me-stat"><span class="me-stat-val'+(w?' warn':'')+'">'+ esc(String(v))+'</span><span class="me-stat-label">'+esc(l)+'</span></div>';
        el.innerHTML=st('Staff',sc)+(med>0?st('Medical Flags',med,true):'')+(tOwe>0?st('Tuition Owed',fmtMoney(tOwe),true):'')+(sOwe>0?st('Salary Owed',fmtMoney(sOwe),true):'');
    }

    // =========================================================================
    // HIERARCHY
    // =========================================================================
    let _slugCounter=0; const _slugMap=new Map();
    function slugId(name){if(_slugMap.has(name))return _slugMap.get(name);const s='sid'+(++_slugCounter);_slugMap.set(name,s);return s;}

    function renderHierarchy() {
        const container=document.getElementById('hierarchyContainer'),empty=document.getElementById('structureEmptyState');
        if(!container)return; _slugMap.clear();_slugCounter=0;
        const divNames=Object.keys(structure).sort();
        if(!divNames.length){container.innerHTML='';if(empty)empty.style.display='block';return;}
        if(empty)empty.style.display='none';
        const ccm={}; Object.values(camperRoster).forEach(c=>{if(c.division)ccm[c.division]=(ccm[c.division]||0)+1;});
        container.innerHTML=divNames.map(divName=>{
            const div=structure[divName]; if(!div||typeof div!=='object')return '';
            const isExp=expandedDivisions.has(divName); const grades=div.grades||{}; const gNames=Object.keys(grades).sort();
            const cc=ccm[divName]||0; const dc=sanitizeColor(div.color);
            const ed=esc(divName),jd=jsEsc(divName),ds=slugId(divName);
            const gradesHtml=gNames.map(gn=>{
                const gk=divName+'||'+gn,isGE=expandedGrades.has(gk),bunks=(grades[gn]&&grades[gn].bunks)||[];
                const eg=esc(gn),jg=jsEsc(gn),gs=slugId(gk);
                const bH=bunks.map(b=>{const eb=esc(b),jb=jsEsc(b);return '<span class="bunk-chip">'+eb+'<button class="icon-btn" onclick="event.stopPropagation();CampistryMe.editBunk(\''+jd+'\',\''+jg+'\',\''+jb+'\')" title="Rename"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="icon-btn danger" onclick="event.stopPropagation();CampistryMe.deleteBunk(\''+jd+'\',\''+jg+'\',\''+jb+'\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></span>';}).join('');
                const abH='<div class="quick-add"><input type="text" placeholder="+ Bunk" maxlength="'+MAX_NAME_LENGTH+'" id="addBunk_'+gs+'" onkeypress="if(event.key===\'Enter\'){CampistryMe.addBunkInline(\''+jd+'\',\''+jg+'\');event.preventDefault();}"><button class="quick-add-btn" onclick="CampistryMe.addBunkInline(\''+jd+'\',\''+jg+'\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div>';
                return '<div class="grade-block"><div class="grade-header" onclick="CampistryMe.toggleGrade(\''+jd+'\',\''+jg+'\')"><div class="grade-left"><svg class="expand-icon '+(isGE?'':'collapsed')+'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg><span class="grade-info">'+eg+'</span><span class="grade-count">'+bunks.length+' bunk'+(bunks.length!==1?'s':'')+'</span></div><div class="grade-actions" onclick="event.stopPropagation()"><button class="icon-btn" onclick="CampistryMe.editGrade(\''+jd+'\',\''+jg+'\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="icon-btn danger" onclick="CampistryMe.deleteGrade(\''+jd+'\',\''+jg+'\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div><div class="grade-body '+(isGE?'':'collapsed')+'"><div class="bunks-list">'+bH+abH+'</div></div></div>';
            }).join('');
            const agH='<div class="add-grade-inline"><div class="quick-add"><input type="text" placeholder="+ Add grade" maxlength="'+MAX_NAME_LENGTH+'" id="addGrade_'+ds+'" onkeypress="if(event.key===\'Enter\'){CampistryMe.addGradeInline(\''+jd+'\');event.preventDefault();}"><button class="quick-add-btn" onclick="CampistryMe.addGradeInline(\''+jd+'\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div></div>';
            return '<div class="division-block"><div class="division-header '+(isExp?'':'collapsed')+'" onclick="CampistryMe.toggleDivision(\''+jd+'\')"><div class="division-left"><div class="division-color" style="background:'+dc+'" onclick="event.stopPropagation();CampistryMe.editDivision(\''+jd+'\')" title="Click to change color"></div><div class="division-info"><h3>'+ed+'</h3><div class="division-meta">'+gNames.length+' grade'+(gNames.length!==1?'s':'')+' · '+cc+' camper'+(cc!==1?'s':'')+'</div></div></div><div class="division-actions" onclick="event.stopPropagation()"><button class="icon-btn" onclick="CampistryMe.editDivision(\''+jd+'\')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="icon-btn danger" onclick="CampistryMe.deleteDivision(\''+jd+'\')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button><svg class="expand-icon '+(isExp?'':'collapsed')+'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div><div class="division-body '+(isExp?'':'collapsed')+'"><div class="grades-section"><div class="grades-list">'+gradesHtml+'</div>'+agH+'</div></div></div>';
        }).join('');
    }

    // =========================================================================
    // STRUCTURE OPS
    // =========================================================================
    function addGradeInline(dn){const i=document.getElementById('addGrade_'+slugId(dn));const n=(i?.value||'').trim().slice(0,MAX_NAME_LENGTH);if(!n||!structure[dn])return;if(isUnsafeName(n)){toast('Reserved','error');return;}if(!structure[dn].grades)structure[dn].grades={};if(structure[dn].grades[n]){toast('Exists','error');return;}structure[dn].grades[n]={bunks:[]};expandedGrades.add(dn+'||'+n);i.value='';saveData();renderHierarchy();updateStats();toast('Grade added');setTimeout(()=>document.getElementById('addBunk_'+slugId(dn+'||'+n))?.focus(),50);}
    function addBunkInline(dn,gn){const i=document.getElementById('addBunk_'+slugId(dn+'||'+gn));const n=(i?.value||'').trim().slice(0,MAX_NAME_LENGTH);if(!n)return;if(isUnsafeName(n)){toast('Reserved','error');return;}const gd=structure[dn]?.grades?.[gn];if(!gd)return;if(!gd.bunks)gd.bunks=[];if(gd.bunks.includes(n)){toast('Exists','error');return;}gd.bunks.push(n);i.value='';saveData();renderHierarchy();updateStats();toast('Bunk added');}
    function toggleDivision(dn){if(expandedDivisions.has(dn))expandedDivisions.delete(dn);else expandedDivisions.add(dn);renderHierarchy();}
    function toggleGrade(dn,gn){const k=dn+'||'+gn;if(expandedGrades.has(k))expandedGrades.delete(k);else expandedGrades.add(k);renderHierarchy();}
    function expandAll(){Object.keys(structure).forEach(d=>{expandedDivisions.add(d);Object.keys(structure[d].grades||{}).forEach(g=>expandedGrades.add(d+'||'+g));});renderHierarchy();}
    function collapseAll(){expandedDivisions.clear();expandedGrades.clear();renderHierarchy();}

    function openDivisionModal(editName=null){
        currentEditDivision=editName; const isEdit=!!editName;
        document.getElementById('divisionModalTitle').textContent=isEdit?'Edit Division':'Add Division';
        document.getElementById('colorPickerGroup').style.display='block';
        if(isEdit&&structure[editName]){document.getElementById('divisionName').value=editName;document.getElementById('divisionColor').value=structure[editName].color||COLOR_PRESETS[0];setupColorPresets();updateColorPresetSelection(structure[editName].color||COLOR_PRESETS[0]);}
        else{document.getElementById('divisionName').value='';const nc=getNextUniqueColor();document.getElementById('divisionColor').value=nc;setupColorPresets();updateColorPresetSelection(nc);}
        openModal('divisionModal');setTimeout(()=>document.getElementById('divisionName').focus(),50);
    }
    function getNextUniqueColor(){const u=new Set(Object.values(structure).map(d=>d.color).filter(Boolean));for(let i=0;i<COLOR_PRESETS.length;i++)if(!u.has(COLOR_PRESETS[i]))return COLOR_PRESETS[i];return COLOR_PRESETS[Object.keys(structure).length%COLOR_PRESETS.length];}
    function saveDivision(){const n=document.getElementById('divisionName').value.trim().slice(0,MAX_NAME_LENGTH);if(!n){toast('Enter a name','error');return;}if(isUnsafeName(n)){toast('Reserved','error');return;}const sc=sanitizeColor(document.getElementById('divisionColor').value);if(currentEditDivision&&currentEditDivision!==n){if(structure[n]){toast('Exists','error');return;}structure[n]={...structure[currentEditDivision],color:sc};delete structure[currentEditDivision];Object.values(camperRoster).forEach(c=>{if(c.division===currentEditDivision)c.division=n;});expandedDivisions.delete(currentEditDivision);expandedDivisions.add(n);[...expandedGrades].filter(k=>k.startsWith(currentEditDivision+'||')).forEach(k=>{expandedGrades.delete(k);expandedGrades.add(n+k.slice(currentEditDivision.length));});}else if(currentEditDivision){structure[currentEditDivision].color=sc;}else{if(structure[n]){toast('Exists','error');return;}structure[n]={color:sc,grades:{}};expandedDivisions.add(n);}saveData();closeModal('divisionModal');renderAll();toast(currentEditDivision?'Updated':'Added');}
    function deleteDivision(n){if(!structure[n])return;if(!confirm('Delete "'+n+'" and all grades/bunks?'))return;delete structure[n];expandedDivisions.delete(n);[...expandedGrades].filter(k=>k.startsWith(n+'||')).forEach(k=>expandedGrades.delete(k));Object.values(camperRoster).forEach(c=>{if(c.division===n){c.division='';c.grade='';c.bunk='';}});saveData();renderAll();toast('Deleted');}
    function deleteGrade(dn,gn){if(!structure[dn]?.grades?.[gn])return;if(!confirm('Delete grade "'+gn+'"?'))return;delete structure[dn].grades[gn];expandedGrades.delete(dn+'||'+gn);Object.values(camperRoster).forEach(c=>{if(c.division===dn&&c.grade===gn){c.grade='';c.bunk='';}});saveData();renderAll();toast('Deleted');}
    function deleteBunk(dn,gn,bn){const gd=structure[dn]?.grades?.[gn];if(!gd)return;gd.bunks=(gd.bunks||[]).filter(b=>b!==bn);Object.values(camperRoster).forEach(c=>{if(c.bunk===bn&&c.division===dn&&c.grade===gn)c.bunk='';});saveData();renderHierarchy();updateStats();toast('Removed');}
    function editGrade(dn,old){if(!structure[dn]?.grades?.[old])return;const n=prompt('Rename "'+old+'":',old);if(!n||!n.trim()||n.trim()===old)return;const t=n.trim().slice(0,MAX_NAME_LENGTH);if(isUnsafeName(t)){toast('Reserved','error');return;}if(structure[dn]?.grades?.[t]){toast('Exists','error');return;}structure[dn].grades[t]=structure[dn].grades[old];delete structure[dn].grades[old];const ok=dn+'||'+old,nk=dn+'||'+t;if(expandedGrades.has(ok)){expandedGrades.delete(ok);expandedGrades.add(nk);}Object.values(camperRoster).forEach(c=>{if(c.division===dn&&c.grade===old)c.grade=t;});saveData();renderAll();toast('Renamed');}
    function editBunk(dn,gn,old){const gd=structure[dn]?.grades?.[gn];if(!gd||!(gd.bunks||[]).includes(old))return;const n=prompt('Rename "'+old+'":',old);if(!n||!n.trim()||n.trim()===old)return;const t=n.trim().slice(0,MAX_NAME_LENGTH);if(isUnsafeName(t)){toast('Reserved','error');return;}if((gd.bunks||[]).includes(t)){toast('Exists','error');return;}const i=(gd.bunks||[]).indexOf(old);if(i===-1)return;gd.bunks[i]=t;Object.values(camperRoster).forEach(c=>{if(c.division===dn&&c.grade===gn&&c.bunk===old)c.bunk=t;});saveData();renderHierarchy();updateStats();toast('Renamed');}

    // =========================================================================
    // CAMPER TABLE
    // =========================================================================
    function renderCamperTable() {
        const tbody=document.getElementById('camperTableBody'),empty=document.getElementById('campersEmptyState');
        if(!tbody) return;
        const savedQA={div:document.getElementById('qaDivision')?.value||'',grade:document.getElementById('qaGrade')?.value||'',bunk:document.getElementById('qaBunk')?.value||'',team:document.getElementById('qaTeam')?.value||''};
        const filter=(document.getElementById('searchInput')?.value||'').toLowerCase().trim();
        let campers=Object.entries(camperRoster).map(([name,d])=>({name,division:d.division||'',grade:d.grade||'',bunk:d.bunk||'',team:d.team||''}));
        if(filter)campers=campers.filter(c=>c.name.toLowerCase().includes(filter)||c.division.toLowerCase().includes(filter)||c.grade.toLowerCase().includes(filter)||c.bunk.toLowerCase().includes(filter));
        campers.sort((a,b)=>{const va=a[sortColumn]||'',vb=b[sortColumn]||'';return sortDirection==='asc'?va.localeCompare(vb,undefined,{numeric:true}):-va.localeCompare(vb,undefined,{numeric:true});});
        document.querySelectorAll('#camperTable th[data-sort]').forEach(th=>{th.classList.remove('sorted-asc','sorted-desc');if(th.dataset.sort===sortColumn)th.classList.add(sortDirection==='asc'?'sorted-asc':'sorted-desc');});
        const total=Object.keys(camperRoster).length;
        const countEl=document.getElementById('camperCount');
        if(countEl)countEl.textContent=filter?campers.length+' of '+total:total+' camper'+(total!==1?'s':'');
        const divOpts='<option value="">—</option>'+Object.keys(structure).sort().map(d=>'<option value="'+esc(d)+'"'+(d===savedQA.div?' selected':'')+'>'+esc(d)+'</option>').join('');
        const teamOpts='<option value="">—</option>'+getTeamsForContext(savedQA.div,savedQA.grade).map(t=>'<option value="'+esc(t)+'"'+(t===savedQA.team?' selected':'')+'>'+esc(t)+'</option>').join('');
        let html='<tr class="add-row"><td><input type="text" id="qaName" placeholder="Camper name" maxlength="'+MAX_NAME_LENGTH+'" onkeypress="if(event.key===\'Enter\'){CampistryMe.quickAddCamper();event.preventDefault();}"></td><td><select id="qaDivision" onchange="CampistryMe.updateQAGrades()">'+divOpts+'</select></td><td><select id="qaGrade" onchange="CampistryMe.updateQABunks()"><option value="">—</option></select></td><td><select id="qaBunk"><option value="">—</option></select></td><td colspan="2"><select id="qaTeam">'+teamOpts+'</select></td><td><button class="btn btn-primary btn-sm" onclick="CampistryMe.quickAddCamper()">Add</button></td></tr>';
        if(!campers.length&&!total){tbody.innerHTML=html;if(empty)empty.style.display='block';_restoreQA(savedQA);return;}
        if(empty)empty.style.display='none';
        html+=campers.map(c=>'<tr style="cursor:pointer" onclick="CampistryMe.openCamperPanel(\''+jsEsc(c.name)+'\')"><td><span class="clickable">'+esc(c.name)+'</span></td><td>'+(esc(c.division)||'—')+'</td><td>'+(esc(c.grade)||'—')+'</td><td>'+(esc(c.bunk)||'—')+'</td><td></td><td></td><td><button class="icon-btn danger" onclick="event.stopPropagation();CampistryMe.deleteCamper(\''+jsEsc(c.name)+'\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td></tr>').join('');
        tbody.innerHTML=html; _restoreQA(savedQA);
        setTimeout(patchCamperTable,50);
    }
    function _restoreQA(s){if(!s.div)return;const ds=document.getElementById('qaDivision');if(ds)ds.value=s.div;const gs=document.getElementById('qaGrade'),bs=document.getElementById('qaBunk');if(gs&&s.div&&structure[s.div]){gs.innerHTML='<option value="">—</option>';Object.keys(structure[s.div].grades||{}).sort().forEach(g=>{gs.innerHTML+='<option value="'+esc(g)+'"'+(g===s.grade?' selected':'')+'>'+esc(g)+'</option>';});}if(bs&&s.div&&s.grade&&structure[s.div]?.grades?.[s.grade]){bs.innerHTML='<option value="">—</option>';(structure[s.div].grades[s.grade].bunks||[]).forEach(b=>{bs.innerHTML+='<option value="'+esc(b)+'"'+(b===s.bunk?' selected':'')+'>'+esc(b)+'</option>';});}}

    function patchCamperTable() {
        const table=document.getElementById('camperTable'); if(!table)return;
        table.querySelectorAll('tbody tr:not(.add-row)').forEach(row=>{
            if(row.dataset.v8p) return; row.dataset.v8p='1';
            const nameEl=row.querySelector('td:first-child .clickable');
            const name=nameEl?.textContent?.trim(); if(!name||!camperRoster[name])return;
            const c=camperRoster[name];
            // Fill medical (5th td) and tuition (6th td)
            const tds=row.querySelectorAll('td');
            if(tds[4]){let f='';if(c.allergies)f+='<span class="me-flag me-flag-allergy">'+esc(c.allergies)+'</span> ';if(c.medications)f+='<span class="me-flag me-flag-med">Meds</span> ';if(c.dietary)f+='<span class="me-flag me-flag-diet">'+esc(c.dietary)+'</span>';tds[4].innerHTML=f||'<span style="color:var(--border-medium);font-size:12px">—</span>';}
            if(tds[5]){const bal=(c.tuitionTotal||0)-(c.tuitionPaid||0);if(c.tuitionTotal>0)tds[5].innerHTML=bal>0?'<span style="font-weight:600;color:#B45309;font-size:12px">'+fmtMoney(bal)+' due</span>':'<span style="font-weight:600;color:#059669;font-size:12px">Paid</span>';else tds[5].innerHTML='<span style="color:var(--border-medium);font-size:12px">—</span>';}
        });
    }

    // =========================================================================
    // CAMPER OPS
    // =========================================================================
    function updateQAGrades(){const dn=document.getElementById('qaDivision')?.value;const gs=document.getElementById('qaGrade'),bs=document.getElementById('qaBunk');if(!gs||!bs)return;gs.innerHTML='<option value="">—</option>';bs.innerHTML='<option value="">—</option>';if(dn&&structure[dn])Object.keys(structure[dn].grades||{}).sort().forEach(g=>{gs.innerHTML+='<option value="'+esc(g)+'">'+esc(g)+'</option>';});updateQATeams();}
    function updateQABunks(){const dn=document.getElementById('qaDivision')?.value,gn=document.getElementById('qaGrade')?.value,bs=document.getElementById('qaBunk');if(!bs)return;bs.innerHTML='<option value="">—</option>';if(dn&&gn&&structure[dn]?.grades?.[gn])(structure[dn].grades[gn].bunks||[]).forEach(b=>{bs.innerHTML+='<option value="'+esc(b)+'">'+esc(b)+'</option>';});updateQATeams();}
    function updateQATeams(){const dn=document.getElementById('qaDivision')?.value||'',gn=document.getElementById('qaGrade')?.value||'',ts=document.getElementById('qaTeam');if(!ts)return;const cv=ts.value;ts.innerHTML='<option value="">—</option>';getTeamsForContext(dn,gn).forEach(t=>{ts.innerHTML+='<option value="'+esc(t)+'"'+(t===cv?' selected':'')+'>'+esc(t)+'</option>';});}
    function quickAddCamper(){const ni=document.getElementById('qaName');const n=(ni?.value||'').trim().slice(0,MAX_NAME_LENGTH);if(!n){toast('Enter a name','error');ni?.focus();return;}if(isUnsafeName(n)){toast('Reserved','error');return;}if(camperRoster[n]){toast('Exists','error');return;}camperRoster[n]={division:document.getElementById('qaDivision')?.value||'',grade:document.getElementById('qaGrade')?.value||'',bunk:document.getElementById('qaBunk')?.value||'',team:document.getElementById('qaTeam')?.value||''};saveData();renderCamperTable();updateStats();renderV8Stats();document.getElementById('qaName')?.focus();toast('Added');}
    function editCamper(name){if(!camperRoster[name])return;openCamperPanel(name);}
    function deleteCamper(name){if(!camperRoster[name])return;if(!confirm('Delete "'+name+'"?'))return;delete camperRoster[name];saveData();renderAll();toast('Deleted');}
    function clearAllCampers(){const c=Object.keys(camperRoster).length;if(!c){toast('No campers','error');return;}if(!confirm('Delete all '+c+' campers?'))return;camperRoster={};saveData();renderAll();toast('All cleared');}

    // =========================================================================
    // GRANULAR CSV — CAMPERS
    // Columns: First Name, Middle Name, Last Name, Division, Grade, Bunk, Team,
    // Birthday, Address, City, State, Zip, Allergies, Dietary, Medications,
    // Parent 1 First, Parent 1 Last, Parent 1 Phone, Parent 1 Email, Parent 1 Relation,
    // Parent 2 First, Parent 2 Last, Parent 2 Phone, Parent 2 Email, Parent 2 Relation,
    // Tuition Total, Tuition Paid
    // =========================================================================
    function downloadTemplate() {
        const hdr='First Name,Middle Name,Last Name,Division,Grade,Bunk,Team,Birthday,Address,City,State,Zip,Allergies,Dietary,Medications,Parent 1 First,Parent 1 Last,Parent 1 Phone,Parent 1 Email,Parent 1 Relation,Parent 2 First,Parent 2 Last,Parent 2 Phone,Parent 2 Email,Parent 2 Relation,Tuition Total,Tuition Paid';
        const r1='Ethan,,Miller,Junior Boys,3rd Grade,Bunk 1A,Red,2016-05-14,42 Maple St,Woodmere,NY,11598,Peanuts,Nut-free,EpiPen,Sarah,Miller,(555) 234-5678,sarah@email.com,Mother,David,Miller,(555) 345-6789,david@email.com,Father,8500,5000';
        const r2='Olivia,,Chen,Junior Girls,3rd Grade,Bunk 3A,Blue,2016-08-22,118 Ocean Ave,Brooklyn,NY,11225,,Vegetarian,,Lisa,Chen,(555) 456-7890,lisa@email.com,Mother,,,,,,8500,8500';
        const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\uFEFF'+hdr+'\n'+r1+'\n'+r2],{type:'text/csv'}));a.download='camper_import_template.csv';a.click();toast('Template downloaded');
    }
    function openCsvImport() {
        const input=document.createElement('input');input.type='file';input.accept='.csv,.txt,.xlsx,.xls';
        input.onchange=e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>MAX_CSV_FILE_SIZE){toast('File too large','error');return;}const r=new FileReader();r.onload=ev=>processCamperCsv(ev.target.result);r.readAsText(f);};
        input.click();
    }
    function processCamperCsv(text) {
        if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
        const lines=text.split(/\r?\n/).filter(l=>l.trim());
        if(lines.length<2){toast('Need header + data','error');return;}
        const hdr=parseCsvLine(lines[0]).map(h=>h.toLowerCase().trim());
        const col=n=>hdr.indexOf(n); const get=(c,n)=>{const i=col(n);return i>=0?(c[i]||'').trim():'';};
        let added=0,updated=0,divsCreated=0,gradesCreated=0,bunksCreated=0;
        const existDivCount=Object.keys(structure).length;
        for(let i=1;i<Math.min(lines.length,MAX_CSV_ROWS+1);i++){
            const c=parseCsvLine(lines[i]);
            const first=get(c,'first name'),mid=get(c,'middle name'),last=get(c,'last name');
            let fullName=[first,mid,last].filter(Boolean).join(' ');
            if(!fullName) fullName=get(c,'name');
            if(!fullName||isUnsafeName(fullName)) continue;
            const division=get(c,'division'),grade=get(c,'grade'),bunk=get(c,'bunk'),team=get(c,'team');
            // Auto-create structure
            if(division&&!structure[division]){structure[division]={color:COLOR_PRESETS[(existDivCount+divsCreated)%COLOR_PRESETS.length],grades:{}};expandedDivisions.add(division);divsCreated++;}
            if(division&&grade&&structure[division]){if(!structure[division].grades)structure[division].grades={};if(!structure[division].grades[grade]){structure[division].grades[grade]={bunks:[]};expandedGrades.add(division+'||'+grade);gradesCreated++;}}
            if(division&&grade&&bunk&&structure[division]?.grades?.[grade]){const bks=structure[division].grades[grade].bunks;if(!bks.includes(bunk)){bks.push(bunk);bunksCreated++;}}
            const existing=camperRoster[fullName]||{};
            if(camperRoster[fullName]) updated++; else added++;
            camperRoster[fullName]={...existing,firstName:first||existing.firstName||'',middleName:mid||existing.middleName||'',lastName:last||existing.lastName||'',division,grade,bunk,team:team||existing.team||'',birthday:get(c,'birthday')||existing.birthday||'',address:get(c,'address')||existing.address||'',city:get(c,'city')||existing.city||'',state:get(c,'state')||existing.state||'',zip:get(c,'zip')||existing.zip||'',allergies:get(c,'allergies')||existing.allergies||'',dietary:get(c,'dietary')||existing.dietary||'',medications:get(c,'medications')||existing.medications||''};
            const tt=get(c,'tuition total');if(tt)camperRoster[fullName].tuitionTotal=Number(tt)||0;
            const tp=get(c,'tuition paid');if(tp)camperRoster[fullName].tuitionPaid=Number(tp)||0;
            // Guardians
            if(!camperRoster[fullName].guardians) camperRoster[fullName].guardians=[];
            const gs=camperRoster[fullName].guardians;
            const p1f=get(c,'parent 1 first'),p1l=get(c,'parent 1 last');
            if(p1f||p1l){const g1={firstName:p1f,lastName:p1l,name:[p1f,p1l].filter(Boolean).join(' '),phone:get(c,'parent 1 phone'),email:get(c,'parent 1 email'),relation:get(c,'parent 1 relation')};if(gs.length>0)gs[0]={...gs[0],...g1};else gs.push(g1);}
            const p2f=get(c,'parent 2 first'),p2l=get(c,'parent 2 last');
            if(p2f||p2l){const g2={firstName:p2f,lastName:p2l,name:[p2f,p2l].filter(Boolean).join(' '),phone:get(c,'parent 2 phone'),email:get(c,'parent 2 email'),relation:get(c,'parent 2 relation')};if(gs.length>1)gs[1]={...gs[1],...g2};else gs.push(g2);}
        }
        saveData();renderAll();
        const parts=[];if(added)parts.push(added+' added');if(updated)parts.push(updated+' updated');if(divsCreated)parts.push(divsCreated+' div(s) created');if(gradesCreated)parts.push(gradesCreated+' grade(s)');if(bunksCreated)parts.push(bunksCreated+' bunk(s)');
        toast(parts.join(', ')||'Import complete');
    }
    function exportCsv() {
        const entries=Object.entries(camperRoster);if(!entries.length){toast('No campers','error');return;}
        const hdr='First Name,Middle Name,Last Name,Division,Grade,Bunk,Team,Birthday,Address,City,State,Zip,Allergies,Dietary,Medications,Parent 1 First,Parent 1 Last,Parent 1 Phone,Parent 1 Email,Parent 1 Relation,Parent 2 First,Parent 2 Last,Parent 2 Phone,Parent 2 Email,Parent 2 Relation,Tuition Total,Tuition Paid';
        const cf=v=>'"'+String(v||'').replace(/"/g,'""')+'"';
        let csv='\uFEFF'+hdr+'\n';
        entries.forEach(([name,d])=>{const p=name.split(' ');const fn=d.firstName||p[0]||'';const ln=d.lastName||p[p.length-1]||'';const mn=d.middleName||(p.length>2?p.slice(1,-1).join(' '):'');const g1=(d.guardians||[])[0]||{};const g2=(d.guardians||[])[1]||{};
            csv+=[fn,mn,ln,d.division,d.grade,d.bunk,d.team,d.birthday,d.address,d.city,d.state,d.zip,d.allergies,d.dietary,d.medications,g1.firstName||'',g1.lastName||'',g1.phone||'',g1.email||'',g1.relation||'',g2.firstName||'',g2.lastName||'',g2.phone||'',g2.email||'',g2.relation||'',d.tuitionTotal||'',d.tuitionPaid||''].map(cf).join(',')+'\n';});
        const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='campers_'+new Date().toISOString().split('T')[0]+'.csv';a.click();toast('Exported '+entries.length);
    }

    // =========================================================================
    // STAFF CSV
    // =========================================================================
    function downloadStaffTemplate(){
        const hdr='First Name,Middle Name,Last Name,Role,Division,Phone,Email,Address,City,State,Zip,Birthday,Start Date,Salary Type,Salary Amount';
        const r1='Jake,,Torres,Head Counselor,Junior Boys,(555) 700-1001,jake@camp.com,15 Elm St,Valley Stream,NY,11580,1998-06-12,2024-06-15,seasonal,6500';
        const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\uFEFF'+hdr+'\n'+r1],{type:'text/csv'}));a.download='staff_import_template.csv';a.click();toast('Template downloaded');
    }
    function importStaffCsv(){
        const input=document.createElement('input');input.type='file';input.accept='.csv,.txt';
        input.onchange=e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>processStaffCsv(ev.target.result);r.readAsText(f);};input.click();
    }
    function processStaffCsv(text){
        if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
        const lines=text.split(/\r?\n/).filter(l=>l.trim());if(lines.length<2){toast('Need header + data','error');return;}
        const hdr=parseCsvLine(lines[0]).map(h=>h.toLowerCase().trim());
        const col=n=>hdr.indexOf(n);const get=(c,n)=>{const i=col(n);return i>=0?(c[i]||'').trim():'';};
        let added=0;
        for(let i=1;i<Math.min(lines.length,5001);i++){
            const c=parseCsvLine(lines[i]);
            let name=[get(c,'first name'),get(c,'middle name'),get(c,'last name')].filter(Boolean).join(' ');
            if(!name)name=get(c,'name');if(!name)continue;if(staffRoster[name])continue;
            staffRoster[name]={firstName:get(c,'first name'),middleName:get(c,'middle name'),lastName:get(c,'last name'),role:get(c,'role'),division:get(c,'division'),phone:get(c,'phone'),email:get(c,'email'),address:get(c,'address'),city:get(c,'city'),state:get(c,'state'),zip:get(c,'zip'),birthday:get(c,'birthday'),startDate:get(c,'start date'),salaryType:get(c,'salary type')||'seasonal',salaryAmount:Number(get(c,'salary amount'))||0,salaryPaid:0,salaryNotes:'',photo:'',notes:''};added++;
        }
        saveData();renderStaffTab();renderV8Stats();toast(added+' staff imported');
    }
    function parseCsvLine(line){const r=[];let cur='',q=false;for(const ch of line){if(ch==='"')q=!q;else if(ch===','&&!q){r.push(cur);cur='';}else cur+=ch;}r.push(cur);return r.map(s=>s.replace(/""/g,'"').trim());}

    // =========================================================================
    // STAFF TABLE
    // =========================================================================
    function renderStaffTab() {
        const tbody=document.getElementById('staffTableBody');if(!tbody)return;
        const q=(document.getElementById('staffSearchInput')?.value||'').toLowerCase();
        const entries=Object.entries(staffRoster).filter(([n,s])=>!q||n.toLowerCase().includes(q)||(s.role||'').toLowerCase().includes(q)).sort((a,b)=>a[0].localeCompare(b[0]));
        const ct=document.getElementById('staffCount');if(ct)ct.textContent=entries.length+' staff';
        if(!entries.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">No staff yet.</td></tr>';return;}
        tbody.innerHTML=entries.map(([name,s])=>{
            const bal=(s.salaryAmount||0)-(s.salaryPaid||0);
            const sal=s.salaryType==='hourly'?fmtMoney(s.salaryAmount)+'/hr':fmtMoney(s.salaryAmount);
            const balH=bal>0?' <span style="color:#1E40AF">('+fmtMoney(bal)+' owed)</span>':'';
            const ph=s.photo?'<img src="'+esc(s.photo)+'" class="me-row-photo" alt="">':'<div class="me-row-initials" style="background:#E0F2FE;color:#0284C7">'+initials(name)+'</div>';
            return '<tr onclick="CampistryMe.openStaffPanel(\''+jsEsc(name)+'\')"><td><div style="display:flex;align-items:center;gap:8px">'+ph+'<span style="font-weight:600;font-size:13px;color:var(--text-primary)">'+esc(name)+'</span></div></td><td>'+esc(s.role)+'</td><td>'+esc(s.division)+'</td><td>'+esc(s.phone)+'</td><td style="font-weight:600;color:'+(bal>0?'#1E40AF':'#059669')+'">'+sal+balH+'</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();CampistryMe.openStaffPanel(\''+jsEsc(name)+'\')">Open</button></td></tr>';
        }).join('');
    }
    function addStaff(){const n=prompt('Staff member full name:');if(!n||!n.trim())return;if(staffRoster[n.trim()]){toast('Already exists','error');return;}staffRoster[n.trim()]={role:'',division:'',phone:'',email:'',address:'',city:'',state:'',zip:'',birthday:'',startDate:'',salaryType:'seasonal',salaryAmount:0,salaryPaid:0,salaryNotes:'',photo:'',notes:''};saveData();renderStaffTab();renderV8Stats();toast('Staff added');openStaffPanel(n.trim());}

    // =========================================================================
    // SIDE PANEL (Camper + Staff profiles)
    // =========================================================================
    function openCamperPanel(name){currentPanel={type:'camper',name};panelTab='info';panelEditing=false;panelForm=JSON.parse(JSON.stringify(camperRoster[name]||{}));if(!panelForm.guardians)panelForm.guardians=[];renderPanel();document.getElementById('mePanelOverlay')?.classList.add('active');}
    function openStaffPanel(name){currentPanel={type:'staff',name};panelTab='personal';panelEditing=false;panelForm=JSON.parse(JSON.stringify(staffRoster[name]||{}));renderPanel();document.getElementById('mePanelOverlay')?.classList.add('active');}
    function closePanel(){document.getElementById('mePanelOverlay')?.classList.remove('active');currentPanel=null;panelEditing=false;}

    function renderPanel(){
        if(!currentPanel)return;const panel=document.getElementById('mePanel');if(!panel)return;
        const {type,name}=currentPanel;const data=type==='camper'?(camperRoster[name]||{}):(staffRoster[name]||{});
        const d=panelEditing?panelForm:data;const hasFlags=data.allergies||data.medications;const age=getAge(data.birthday);
        const addr=[data.address,data.city,data.state,data.zip].filter(Boolean).join(', ');
        const photo=panelEditing?panelForm.photo:data.photo;
        const photoH=photo?'<img src="'+esc(photo)+'" style="width:100%;height:100%;object-fit:cover">':'<span>Add<br>Photo</span>';
        let h='<div class="me-panel-header"><div class="me-panel-header-info"><div class="me-photo-upload" '+(panelEditing?'onclick="document.getElementById(\'_pphi\').click()"':'style="border-style:solid;cursor:default"')+'>'+photoH+(panelEditing?'<input type="file" id="_pphi" accept="image/*" style="display:none" onchange="CampistryMe._panelPhoto(event)">':'')+'</div><div style="flex:1">'+(panelEditing?'<input type="text" id="_ppn" value="'+esc(panelForm._dn||name)+'" style="font-size:16px;font-weight:700;padding:5px 10px" placeholder="Full name">':'<div class="me-panel-name">'+esc(name)+'</div>')+'<div class="me-panel-sub">'+esc(data.division||'')+''+(data.grade?' · '+esc(data.grade):'')+(data.bunk?' · '+esc(data.bunk):'')+(data.role?' · '+esc(data.role):'')+(age!==null?' · Age '+age:'')+'</div></div></div><button class="me-panel-close" onclick="CampistryMe.closePanel()">✕</button></div>';
        if(type==='camper'&&hasFlags&&!panelEditing) h+='<div class="me-panel-alert">⚠ '+esc([data.allergies,data.medications].filter(Boolean).join('  ·  '))+'</div>';
        const tabs=type==='camper'?[{id:'info',l:'Info'},{id:'medical',l:'Medical'+(hasFlags?' ●':'')},{id:'guardians',l:'Guardians'},{id:'tuition',l:'Tuition'},{id:'notes',l:'Notes'}]:[{id:'personal',l:'Info'},{id:'salary',l:'Salary'},{id:'notes',l:'Notes'}];
        h+='<div class="me-panel-tabs">'+tabs.map(t=>'<button class="me-panel-tab'+(panelTab===t.id?' active':'')+'" onclick="CampistryMe._ptab(\''+t.id+'\')">'+t.l+'</button>').join('')+'</div>';
        h+='<div class="me-panel-body">'+(type==='camper'?camperPanelBody(name,d,addr):staffPanelBody(name,d))+'</div>';
        if(panelEditing) h+='<div class="me-panel-footer"><button class="me-pill me-pill-danger me-pill-xs" onclick="CampistryMe._pdel()">Delete</button><div style="display:flex;gap:6px"><button class="me-pill me-pill-secondary me-pill-sm" onclick="CampistryMe._pcancel()">Cancel</button><button class="me-pill me-pill-primary me-pill-sm" onclick="CampistryMe._psave()">Save</button></div></div>';
        else h+='<div class="me-panel-footer"><span></span><button class="me-pill me-pill-secondary me-pill-sm" onclick="CampistryMe._pedit()">Edit Profile</button></div>';
        panel.innerHTML=h;
    }

    function FR(label,val,key,opts={}){const{type='text',ph='',ta=false,money=false}=opts;const display=money?fmtMoney(val):(type==='date'?fmtDate(val):(val||'—'));
        if(panelEditing){const v=esc(panelForm[key]!==undefined?panelForm[key]:val||'');
            if(ta)return '<div class="me-field-row"><div class="me-field-label">'+label+'</div><div style="flex:1"><textarea onchange="CampistryMe._pset(\''+key+'\',this.value)" placeholder="'+esc(ph)+'">'+v+'</textarea></div></div>';
            return '<div class="me-field-row"><div class="me-field-label">'+label+'</div><div style="flex:1"><input type="'+type+'" value="'+v+'" onchange="CampistryMe._pset(\''+key+'\','+(type==='number'?'Number(this.value)':'this.value')+')" placeholder="'+esc(ph)+'"></div></div>';}
        return '<div class="me-field-row"><div class="me-field-label">'+label+'</div><div class="me-field-value'+(!val?' empty':'')+'">'+esc(display)+'</div></div>';}
    function SH(t){return '<div class="me-section-head">'+t+'</div>';}

    function camperPanelBody(name,d,addr){
        const st=structure,divs=Object.keys(st);
        if(panelTab==='info'){let h=FR('Birthday',d.birthday,'birthday',{type:'date'});if(!panelEditing&&getAge(d.birthday)!==null)h+=FR('Age',getAge(d.birthday)+' years','_');
            if(panelEditing){h+=FR('Address',d.address,'address',{ph:'Street'});h+=FR('City',d.city,'city');h+=FR('State',d.state,'state');h+=FR('Zip',d.zip,'zip');
                const grades=panelForm.division&&st[panelForm.division]?Object.keys(st[panelForm.division].grades||{}):[];const bunks=panelForm.division&&panelForm.grade&&st[panelForm.division]?.grades?.[panelForm.grade]?st[panelForm.division].grades[panelForm.grade].bunks||[]:[];
                h+='<div class="me-field-row"><div class="me-field-label">Division</div><div style="flex:1"><select onchange="CampistryMe._pset(\'division\',this.value);CampistryMe._pset(\'grade\',\'\');CampistryMe._pset(\'bunk\',\'\');CampistryMe.renderPanel()"><option value="">—</option>'+divs.map(dv=>'<option'+(dv===panelForm.division?' selected':'')+'>'+esc(dv)+'</option>').join('')+'</select></div></div>';
                h+='<div class="me-field-row"><div class="me-field-label">Grade</div><div style="flex:1"><select onchange="CampistryMe._pset(\'grade\',this.value);CampistryMe._pset(\'bunk\',\'\');CampistryMe.renderPanel()"><option value="">—</option>'+grades.map(g=>'<option'+(g===panelForm.grade?' selected':'')+'>'+esc(g)+'</option>').join('')+'</select></div></div>';
                h+='<div class="me-field-row"><div class="me-field-label">Bunk</div><div style="flex:1"><select onchange="CampistryMe._pset(\'bunk\',this.value)"><option value="">—</option>'+bunks.map(b=>'<option'+(b===panelForm.bunk?' selected':'')+'>'+esc(b)+'</option>').join('')+'</select></div></div>';
            }else{h+=FR('Address',addr,'_');h+=FR('Division',d.division,'division');h+=FR('Grade',d.grade,'grade');h+=FR('Bunk',d.bunk,'bunk');}
            h+=FR('Team',d.team,'team');return h;}
        if(panelTab==='medical')return SH('ALLERGIES & DIETARY')+FR('Allergies',d.allergies,'allergies',{ph:'e.g., Peanuts'})+FR('Dietary',d.dietary,'dietary',{ph:'e.g., Vegetarian'})+SH('MEDICATIONS')+FR('Medications',d.medications,'medications',{ph:'Name, dosage',ta:true})+SH('MEDICAL NOTES')+FR('Notes',d.medicalNotes,'medicalNotes',{ph:'Staff instructions…',ta:true});
        if(panelTab==='guardians'){
            const gs=panelEditing?(panelForm.guardians||[]):(d.guardians||[]);let h='';
            gs.forEach((g,i)=>{h+='<div class="me-guardian-card"><div class="me-guardian-label"><span>'+esc(g.relation||'Guardian')+' '+(i===0?'(Primary)':'#'+(i+1))+'</span>'+(panelEditing&&gs.length>1?'<button class="me-pill me-pill-danger me-pill-xs" onclick="CampistryMe._grmv('+i+')">Remove</button>':'')+'</div>';
                if(panelEditing){h+='<div style="display:flex;flex-wrap:wrap;gap:10px">';
                    [['firstName','First Name'],['lastName','Last Name'],['relation','Relation'],['phone','Phone'],['email','Email']].forEach(([k,l])=>{h+='<div style="flex:1 1 45%;min-width:140px"><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:2px">'+l+'</label><input type="'+(k==='email'?'email':k==='phone'?'tel':'text')+'" value="'+esc(g[k]||'')+'" onchange="CampistryMe._gset('+i+',\''+k+'\',this.value)"></div>';});
                    h+='</div>';}else{const gn=[g.firstName,g.lastName].filter(Boolean).join(' ')||g.name||'';h+=FR('Name',gn,'_');h+=FR('Relation',g.relation,'_');h+=FR('Email',g.email,'_');h+=FR('Phone',g.phone,'_');if(g.phone)h+='<div style="display:flex;gap:6px;margin-top:8px"><a href="tel:'+esc(g.phone)+'" class="me-action-link">Call</a>'+(g.email?'<a href="mailto:'+esc(g.email)+'" class="me-action-link">Email</a>':'')+'</div>';}
                h+='</div>';});
            if(!gs.length&&!panelEditing)h+='<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">No guardians yet.</div>';
            if(panelEditing)h+='<button class="me-pill me-pill-secondary me-pill-sm" onclick="CampistryMe._gadd()">+ Add Guardian</button>';return h;}
        if(panelTab==='tuition'){let h=FR('Total',d.tuitionTotal,'tuitionTotal',{type:'number',money:true})+FR('Paid',d.tuitionPaid,'tuitionPaid',{type:'number',money:true});
            if(!panelEditing&&d.tuitionTotal>0){const bal=(d.tuitionTotal||0)-(d.tuitionPaid||0);h+='<div class="me-balance-card '+(bal<=0?'paid':'owed')+'"><div class="me-balance-label">'+(bal<=0?'Paid in Full':'Balance')+'</div><div class="me-balance-amount">'+fmtMoney(Math.abs(bal))+'</div></div>';}
            h+='<div style="margin-top:14px">'+FR('Notes',d.tuitionNotes,'tuitionNotes',{ph:'Payment plan…',ta:true})+'</div>';return h;}
        if(panelTab==='notes')return FR('Notes',d.notes,'notes',{ph:'Personality, interests…',ta:true});return '';
    }
    function staffPanelBody(name,d){
        if(panelTab==='personal'){let h=FR('Birthday',d.birthday,'birthday',{type:'date'})+FR('Start Date',d.startDate,'startDate',{type:'date'})+FR('Phone',d.phone,'phone',{type:'tel'})+FR('Email',d.email,'email',{type:'email'});
            if(panelEditing){h+=FR('Address',d.address,'address',{ph:'Street'});h+=FR('City',d.city,'city');h+=FR('State',d.state,'state');h+=FR('Zip',d.zip,'zip');}else{h+=FR('Address',[d.address,d.city,d.state,d.zip].filter(Boolean).join(', '),'_');}
            h+=FR('Role',d.role,'role')+FR('Division',d.division,'division');return h;}
        if(panelTab==='salary'){let h=FR('Pay Type',d.salaryType,'salaryType',{ph:'seasonal, hourly'})+FR(d.salaryType==='hourly'?'Rate':'Total',d.salaryAmount,'salaryAmount',{type:'number',money:true})+FR('Paid',d.salaryPaid,'salaryPaid',{type:'number',money:true});
            if(!panelEditing){const bal=(d.salaryAmount||0)-(d.salaryPaid||0);h+='<div class="me-balance-card '+(bal<=0?'paid':'owed-staff')+'"><div class="me-balance-label">'+(bal<=0?'Fully Paid':'Remaining')+'</div><div class="me-balance-amount">'+fmtMoney(Math.abs(bal))+'</div></div>';}
            h+='<div style="margin-top:12px">'+FR('Notes',d.salaryNotes,'salaryNotes',{ph:'Schedule…',ta:true})+'</div>';return h;}
        if(panelTab==='notes')return FR('Notes',d.notes,'notes',{ph:'Certifications…',ta:true});return '';
    }

    // Panel actions
    function _pedit(){const{type,name}=currentPanel;panelForm=JSON.parse(JSON.stringify(type==='camper'?(camperRoster[name]||{}):(staffRoster[name]||{})));if(type==='camper'&&!panelForm.guardians)panelForm.guardians=[];panelForm._dn=name;panelEditing=true;renderPanel();}
    function _pcancel(){panelEditing=false;renderPanel();}
    function _psave(){
        const{type,name}=currentPanel;const newN=document.getElementById('_ppn')?.value?.trim()||name;
        if(type==='camper'){if(newN!==name){camperRoster[newN]={...panelForm};delete camperRoster[name];currentPanel.name=newN;}else camperRoster[name]={...panelForm};}
        else{if(newN!==name){staffRoster[newN]={...panelForm};delete staffRoster[name];currentPanel.name=newN;}else staffRoster[name]={...panelForm};}
        panelEditing=false;saveData();renderPanel();renderAll();renderStaffTab();renderV8Stats();setTimeout(patchCamperTable,100);toast('Saved');
    }
    function _pdel(){const{type,name}=currentPanel;if(!confirm('Delete "'+name+'"?'))return;if(type==='camper')delete camperRoster[name];else delete staffRoster[name];closePanel();saveData();renderAll();renderStaffTab();renderV8Stats();toast('Deleted');}

    // =========================================================================
    // UI HELPERS
    // =========================================================================
    function setupTabs(){document.querySelectorAll('.tab-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.tab-btn').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-selected','false');});document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));btn.classList.add('active');btn.setAttribute('aria-selected','true');document.getElementById('tab-'+btn.dataset.tab)?.classList.add('active');if(btn.dataset.tab==='staff')renderStaffTab();if(btn.dataset.tab==='campers')setTimeout(patchCamperTable,100);};});}
    function openModal(id){document.getElementById(id)?.classList.add('active');}
    function closeModal(id){document.getElementById(id)?.classList.remove('active');}
    function setupColorPresets(){const c=document.getElementById('colorPresets');if(!c)return;c.innerHTML=COLOR_PRESETS.map(cl=>{const sc=sanitizeColor(cl);return '<div class="color-preset" style="background:'+sc+'" data-color="'+sc+'" onclick="event.stopPropagation();CampistryMe.selectColorPreset(\''+sc+'\')"></div>';}).join('');}
    function selectColorPreset(c){document.getElementById('divisionColor').value=c;updateColorPresetSelection(c);}
    function updateColorPresetSelection(c){document.querySelectorAll('.color-preset').forEach(el=>el.classList.toggle('selected',el.dataset.color===c));}

    function setupEventListeners(){
        const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el[ev]=fn;};
        on('addDivisionBtn','onclick',()=>openDivisionModal());
        on('saveDivisionBtn','onclick',saveDivision);
        on('divisionColor','oninput',e=>updateColorPresetSelection(e.target.value));
        on('divisionName','onkeypress',e=>{if(e.key==='Enter')saveDivision();});
        on('expandAllBtn','onclick',expandAll);on('collapseAllBtn','onclick',collapseAll);
        on('downloadTemplateBtn','onclick',downloadTemplate);
        on('importCsvBtn','onclick',openCsvImport);
        on('exportCsvBtn','onclick',exportCsv);
        on('clearAllBtn','onclick',clearAllCampers);
        on('saveEditCamperBtn','onclick',saveCamperFromModal);
        on('editCamperDivision','onchange',e=>{updateEditGrades(e.target.value,'');updateEditBunks(e.target.value,'','');});
        on('editCamperGrade','onchange',e=>{const div=document.getElementById('editCamperDivision')?.value||'';updateEditBunks(div,e.target.value,'');});
        on('editCamperName','onkeypress',e=>{if(e.key==='Enter')saveCamperFromModal();});
        on('addStaffBtn','onclick',addStaff);
        on('downloadStaffTemplateBtn','onclick',downloadStaffTemplate);
        on('importStaffCsvBtn','onclick',importStaffCsv);
        const si=document.getElementById('searchInput');if(si)si.oninput=()=>{if(_searchDebounceTimeout)clearTimeout(_searchDebounceTimeout);_searchDebounceTimeout=setTimeout(renderCamperTable,150);};
        const ssi=document.getElementById('staffSearchInput');if(ssi)ssi.oninput=()=>{clearTimeout(ssi._d);ssi._d=setTimeout(renderStaffTab,150);};
        document.querySelectorAll('#camperTable th[data-sort]').forEach(th=>{th.onclick=()=>{const c=th.dataset.sort;if(sortColumn===c)sortDirection=sortDirection==='asc'?'desc':'asc';else{sortColumn=c;sortDirection='asc';}renderCamperTable();};});
        const dz=document.getElementById('csvDropzone'),fi=document.getElementById('csvFileInput');
        if(dz&&fi){dz.onclick=()=>fi.click();dz.ondragover=e=>{e.preventDefault();dz.classList.add('dragover');};dz.ondragleave=()=>dz.classList.remove('dragover');dz.ondrop=e=>{e.preventDefault();dz.classList.remove('dragover');const f=e.dataTransfer.files[0];if(f){const r=new FileReader();r.onload=ev=>processCamperCsv(ev.target.result);r.readAsText(f);}};fi.onchange=e=>{const f=e.target.files[0];if(f){const r=new FileReader();r.onload=ev=>processCamperCsv(ev.target.result);r.readAsText(f);}};}
        document.querySelectorAll('.modal-overlay').forEach(o=>{o.addEventListener('mousedown',e=>{if(e.target===o)closeModal(o.id);});});
        document.querySelectorAll('.modal').forEach(m=>{m.addEventListener('mousedown',e=>e.stopPropagation());});
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelectorAll('.modal-overlay.active').forEach(o=>closeModal(o.id));if(currentPanel)closePanel();}});
        document.getElementById('mePanelOverlay')?.addEventListener('click',e=>{if(e.target.id==='mePanelOverlay')closePanel();});
        window.addEventListener('beforeunload',()=>{if(_pendingMergeData&&_cloudSaveTimeout){clearTimeout(_cloudSaveTimeout);try{const g=readLocalSettings();if(_pendingMergeData.campStructure)g.campStructure=_pendingMergeData.campStructure;if(_pendingMergeData.app1){if(!g.app1)g.app1={};Object.assign(g.app1,_pendingMergeData.app1);}g.updated_at=new Date().toISOString();writeLocalSettings(g);}catch(_){}_pendingMergeData=null;}});
        window.addEventListener('online',()=>{setSyncStatus('syncing');saveData();});
        document.addEventListener('visibilitychange',async()=>{if(document.visibilityState!=='visible'||_pendingMergeData)return;const now=Date.now();if(now-_lastCloudFetchTime<CLOUD_FETCH_COOLDOWN_MS)return;_lastCloudFetchTime=now;try{const cloud=await loadFromCloud();if(cloud){const ct=new Date(cloud.updated_at||0).getTime(),lt=new Date(readLocalSettings().updated_at||0).getTime();if(ct>lt){camperRoster=cloud.app1?.camperRoster||camperRoster;staffRoster=cloud.app1?.staffRoster||staffRoster;if(cloud.campStructure&&Object.keys(cloud.campStructure).length>0)structure=cloud.campStructure;writeLocalSettings(cloud);renderAll();renderStaffTab();}}}catch(e){}});
    }

    // Legacy camper edit modal support
    function saveCamperFromModal(){if(!currentEditCamper||!camperRoster[currentEditCamper])return;const nn=(document.getElementById('editCamperName')?.value||'').trim().slice(0,MAX_NAME_LENGTH);if(!nn){toast('Name empty','error');return;}if(isUnsafeName(nn)){toast('Reserved','error');return;}const data={division:document.getElementById('editCamperDivision')?.value||'',grade:document.getElementById('editCamperGrade')?.value||'',bunk:document.getElementById('editCamperBunk')?.value||'',team:document.getElementById('editCamperTeam')?.value||''};if(nn!==currentEditCamper){if(camperRoster[nn]){toast('Exists','error');return;}delete camperRoster[currentEditCamper];}camperRoster[nn]={...camperRoster[nn],...data};saveData();closeModal('camperModal');renderAll();toast('Updated');}
    function updateEditGrades(dn,sel){const gs=document.getElementById('editCamperGrade');if(!gs)return;gs.innerHTML='<option value="">—</option>';if(dn&&structure[dn])Object.keys(structure[dn].grades||{}).sort().forEach(g=>{gs.innerHTML+='<option value="'+esc(g)+'"'+(g===sel?' selected':'')+'>'+esc(g)+'</option>';});}
    function updateEditBunks(dn,gn,sel){const bs=document.getElementById('editCamperBunk');if(!bs)return;bs.innerHTML='<option value="">—</option>';if(dn&&gn&&structure[dn]?.grades?.[gn])(structure[dn].grades[gn].bunks||[]).forEach(b=>{bs.innerHTML+='<option value="'+esc(b)+'"'+(b===sel?' selected':'')+'>'+esc(b)+'</option>';});}

    // =========================================================================
    // UTILITIES
    // =========================================================================
    function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'):'';};
    function jsEsc(s){return s?String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/\n/g,'\\n'):'';};
    function sanitizeColor(c){if(!c||typeof c!=='string')return COLOR_PRESETS[0];if(/^#[0-9a-fA-F]{3,8}$/.test(c.trim()))return c.trim();if(/^[a-zA-Z]{3,20}$/.test(c.trim()))return c.trim();return COLOR_PRESETS[0];}
    const UNSAFE_NAMES=new Set(['__proto__','constructor','prototype','toString','valueOf','hasOwnProperty']);
    function isUnsafeName(n){return UNSAFE_NAMES.has(n);}
    function fmtDate(d){if(!d)return '—';try{return new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}catch(e){return d;}}
    function fmtMoney(n){return '$'+Number(n||0).toLocaleString();}
    function getAge(b){if(!b)return null;const d=new Date(b+'T00:00:00'),n=new Date();let a=n.getFullYear()-d.getFullYear();if(n.getMonth()<d.getMonth()||(n.getMonth()===d.getMonth()&&n.getDate()<d.getDate()))a--;return a;}
    function initials(n){return(n||'').split(' ').map(w=>w[0]||'').join('').toUpperCase().slice(0,2);}
    function toast(msg,type='success'){const t=document.getElementById('toast');if(!t)return;if(_toastTimeout)clearTimeout(_toastTimeout);const ic=document.getElementById('toastIcon');if(ic)ic.innerHTML=type==='error'?'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>':'<polyline points="20 6 9 17 4 12"/>';document.getElementById('toastMessage').textContent=msg;t.className='toast '+type+' show';_toastTimeout=setTimeout(()=>{t.classList.remove('show');_toastTimeout=null;},3000);}

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryMe = {
        toggleDivision, toggleGrade, editDivision: openDivisionModal, deleteDivision,
        addGradeInline, editGrade, deleteGrade, addBunkInline, editBunk, deleteBunk,
        editCamper, deleteCamper, quickAddCamper,
        updateQAGrades, updateQABunks,
        selectColorPreset, closeModal,
        // v8
        openCamperPanel, openStaffPanel, closePanel, renderPanel, addStaff,
        renderStaffTab, renderAll,
        _ptab:(t)=>{panelTab=t;renderPanel();},
        _pedit, _pcancel, _psave, _pdel,
        _pset:(k,v)=>{panelForm[k]=v;},
        _gadd:()=>{if(!panelForm.guardians)panelForm.guardians=[];panelForm.guardians.push({firstName:'',lastName:'',phone:'',email:'',relation:''});renderPanel();},
        _grmv:(i)=>{panelForm.guardians.splice(i,1);renderPanel();},
        _gset:(i,k,v)=>{if(panelForm.guardians?.[i])panelForm.guardians[i][k]=v;},
        _panelPhoto:(e)=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>{panelForm.photo=ev.target.result;renderPanel();};r.readAsDataURL(f);},
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 100);
})();
