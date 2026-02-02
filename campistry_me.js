// =============================================================================
// campistry_me.js — Campistry Me v5.1
// Professional UI, Cloud Sync, Fast inline inputs
// =============================================================================

(function() {
    'use strict';
    console.log('[Me] Campistry Me v5.1 loading...');

    let structure = {};
    let camperRoster = {};
    let leagueTeams = [];
    let expandedDivisions = new Set();
    let expandedGrades = new Set();
    let currentEditDivision = null;
    let currentEditCamper = null;
    let sortColumn = 'name';
    let sortDirection = 'asc';
    let pendingCsvData = [];

    const COLOR_PRESETS = ['#00C896','#6366F1','#F59E0B','#EF4444','#8B5CF6','#3B82F6','#10B981','#EC4899','#F97316','#14B8A6','#84CC16','#A855F7','#06B6D4','#F43F5E','#22C55E','#FBBF24'];

    async function init() {
        const authed = await checkAuth();
        if (!authed) return;
        await loadAllData();
        setupEventListeners();
        setupTabs();
        setupColorPresets();
        renderAll();
        document.getElementById('auth-loading-screen').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
        console.log('[Me] Ready');
    }

    async function checkAuth() {
        try {
            let attempts = 0;
            while (!window.supabase && attempts < 20) { await new Promise(r => setTimeout(r, 100)); attempts++; }
            if (!window.supabase) { window.location.href = 'landing.html'; return false; }
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) { window.location.href = 'landing.html'; return false; }
            return true;
        } catch (e) { window.location.href = 'landing.html'; return false; }
    }

    async function loadAllData() {
        // Wait for CampistryDB if available
        if (window.CampistryDB?.ready) await window.CampistryDB.ready;
        
        // Try to load from cloud first, then localStorage
        let global = await loadFromCloud() || loadGlobalSettings();
        
        camperRoster = global?.app1?.camperRoster || {};
        structure = global?.campStructure || migrateOldStructure(global?.app1?.divisions || {});
        
        // Collect league teams
        const teams = new Set();
        Object.values(global?.leaguesByName || {}).forEach(l => (l.teams || []).forEach(t => teams.add(t)));
        Object.values(global?.specialtyLeagues || {}).forEach(l => (l.teams || []).forEach(t => teams.add(t)));
        leagueTeams = Array.from(teams).sort();
        
        // Expand all divisions by default
        Object.keys(structure).forEach(d => expandedDivisions.add(d));
        
        console.log('[Me] Loaded', Object.keys(structure).length, 'divisions,', Object.keys(camperRoster).length, 'campers');
    }

    async function loadFromCloud() {
        if (!window.supabase) return null;
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session?.user?.id) return null;
            
            const { data, error } = await window.supabase
                .from('user_settings')
                .select('settings')
                .eq('user_id', session.user.id)
                .single();
            
            if (error || !data?.settings) return null;
            
            // Update localStorage with cloud data
            localStorage.setItem('campistryGlobalSettings', JSON.stringify(data.settings));
            console.log('[Me] Loaded from cloud');
            return data.settings;
        } catch (e) {
            console.log('[Me] Cloud load failed, using localStorage');
            return null;
        }
    }

    function migrateOldStructure(oldDivisions) {
        const newStructure = {};
        Object.entries(oldDivisions).forEach(([divName, divData]) => {
            const bunks = (divData.bunks || []).map(b => typeof b === 'string' ? b : b.name);
            newStructure[divName] = {
                color: divData.color || COLOR_PRESETS[Object.keys(newStructure).length % COLOR_PRESETS.length],
                grades: bunks.length > 0 ? { 'Default': { bunks } } : {}
            };
        });
        return newStructure;
    }

    function loadGlobalSettings() {
        try {
            if (window.loadGlobalSettings) return window.loadGlobalSettings();
            const raw = localStorage.getItem('campistryGlobalSettings');
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function saveData() {
        try {
            setSyncStatus('syncing');
            const global = loadGlobalSettings();
            global.campStructure = structure;
            if (!global.app1) global.app1 = {};
            global.app1.camperRoster = camperRoster;
            global.app1.divisions = convertToOldFormat(structure);
            
            // Save to localStorage first (immediate)
            localStorage.setItem('campistryGlobalSettings', JSON.stringify(global));
            
            // Then sync to cloud
            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('campStructure', structure);
                window.saveGlobalSettings('app1', global.app1);
                setTimeout(() => setSyncStatus('synced'), 500);
            } else {
                // Direct supabase sync fallback
                syncToCloud(global).then(() => {
                    setSyncStatus('synced');
                }).catch(() => {
                    setSyncStatus('error');
                });
            }
        } catch (e) { 
            console.error('[Me] Save error:', e);
            setSyncStatus('error'); 
        }
    }

    async function syncToCloud(global) {
        if (!window.supabase) return;
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session?.user?.id) return;
            
            const { error } = await window.supabase
                .from('user_settings')
                .upsert({
                    user_id: session.user.id,
                    settings: global,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });
            
            if (error) throw error;
            console.log('[Me] Cloud sync successful');
        } catch (e) {
            console.error('[Me] Cloud sync failed:', e);
            throw e;
        }
    }

    function convertToOldFormat(struct) {
        const oldFormat = {};
        Object.entries(struct).forEach(([divName, divData]) => {
            const allBunks = [];
            Object.values(divData.grades || {}).forEach(g => (g.bunks || []).forEach(b => allBunks.push(b)));
            oldFormat[divName] = { color: divData.color, bunks: allBunks };
        });
        return oldFormat;
    }

    function setSyncStatus(status) {
        const dot = document.getElementById('syncDot');
        const text = document.getElementById('syncText');
        if (status === 'syncing') { dot?.classList.add('syncing'); if(text) text.textContent = 'Syncing...'; }
        else if (status === 'synced') { dot?.classList.remove('syncing'); if(dot) dot.style.background = '#059669'; if(text) text.textContent = 'Synced'; }
        else { dot?.classList.remove('syncing'); if(dot) dot.style.background = '#ef4444'; if(text) text.textContent = 'Error'; }
    }

    function renderAll() { updateStats(); renderHierarchy(); renderCamperTable(); }

    function updateStats() {
        let gradeCount = 0, bunkCount = 0;
        Object.values(structure).forEach(div => {
            gradeCount += Object.keys(div.grades || {}).length;
            Object.values(div.grades || {}).forEach(g => bunkCount += (g.bunks || []).length);
        });
        const el = id => document.getElementById(id);
        if(el('statDivisions')) el('statDivisions').textContent = Object.keys(structure).length;
        if(el('statGrades')) el('statGrades').textContent = gradeCount;
        if(el('statBunks')) el('statBunks').textContent = bunkCount;
        if(el('statCampers')) el('statCampers').textContent = Object.keys(camperRoster).length;
    }

    function renderHierarchy() {
        const container = document.getElementById('hierarchyContainer');
        const empty = document.getElementById('structureEmptyState');
        if (!container) return;
        const divNames = Object.keys(structure).sort();
        if (divNames.length === 0) { container.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
        if (empty) empty.style.display = 'none';

        container.innerHTML = divNames.map(divName => {
            const div = structure[divName];
            const isExpanded = expandedDivisions.has(divName);
            const grades = div.grades || {};
            const gradeNames = Object.keys(grades).sort();
            const camperCount = Object.values(camperRoster).filter(c => c.division === divName).length;

            const gradesHtml = gradeNames.map(gradeName => {
                const gradeKey = divName + '||' + gradeName;
                const isGradeExpanded = expandedGrades.has(gradeKey);
                const bunks = grades[gradeName].bunks || [];
                return '<div class="grade-block"><div class="grade-header" onclick="CampistryMe.toggleGrade(\'' + esc(divName) + '\',\'' + esc(gradeName) + '\')"><div class="grade-left"><svg class="expand-icon ' + (isGradeExpanded ? '' : 'collapsed') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg><span class="grade-info">' + esc(gradeName) + '</span><span class="grade-count">' + bunks.length + ' bunk' + (bunks.length !== 1 ? 's' : '') + '</span></div><div class="grade-actions" onclick="event.stopPropagation()"><button class="icon-btn danger" onclick="CampistryMe.deleteGrade(\'' + esc(divName) + '\',\'' + esc(gradeName) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div><div class="grade-body ' + (isGradeExpanded ? '' : 'collapsed') + '"><div class="bunks-list">' + bunks.map(b => '<span class="bunk-chip">' + esc(b) + '<button class="icon-btn danger" onclick="CampistryMe.deleteBunk(\'' + esc(divName) + '\',\'' + esc(gradeName) + '\',\'' + esc(b) + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></span>').join('') + '<div class="quick-add"><input type="text" placeholder="+ Bunk" id="addBunk_' + esc(divName) + '_' + esc(gradeName) + '" onkeypress="if(event.key===\'Enter\'){CampistryMe.addBunkInline(\'' + esc(divName) + '\',\'' + esc(gradeName) + '\');event.preventDefault();}"><button class="quick-add-btn" onclick="CampistryMe.addBunkInline(\'' + esc(divName) + '\',\'' + esc(gradeName) + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div></div></div></div>';
            }).join('');

            return '<div class="division-block"><div class="division-header ' + (isExpanded ? '' : 'collapsed') + '" onclick="CampistryMe.toggleDivision(\'' + esc(divName) + '\')"><div class="division-left"><div class="division-color" style="background:' + (div.color || COLOR_PRESETS[0]) + '"></div><div class="division-info"><h3>' + esc(divName) + '</h3><div class="division-meta">' + gradeNames.length + ' grade' + (gradeNames.length !== 1 ? 's' : '') + ' · ' + camperCount + ' camper' + (camperCount !== 1 ? 's' : '') + '</div></div></div><div class="division-actions" onclick="event.stopPropagation()"><button class="icon-btn" onclick="CampistryMe.editDivision(\'' + esc(divName) + '\')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="icon-btn danger" onclick="CampistryMe.deleteDivision(\'' + esc(divName) + '\')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button><svg class="expand-icon ' + (isExpanded ? '' : 'collapsed') + '" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div><div class="division-body ' + (isExpanded ? '' : 'collapsed') + '"><div class="grades-section"><div class="grades-list">' + gradesHtml + '</div><div class="add-grade-inline"><div class="quick-add"><input type="text" placeholder="+ Add grade" style="width:150px" id="addGrade_' + esc(divName) + '" onkeypress="if(event.key===\'Enter\'){CampistryMe.addGradeInline(\'' + esc(divName) + '\');event.preventDefault();}"><button class="quick-add-btn" onclick="CampistryMe.addGradeInline(\'' + esc(divName) + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div></div></div></div></div>';
        }).join('');
    }

    function addGradeInline(divName) {
        const input = document.getElementById('addGrade_' + divName);
        const name = input?.value.trim();
        if (!name || !structure[divName]) return;
        if (!structure[divName].grades) structure[divName].grades = {};
        if (structure[divName].grades[name]) { toast('Grade exists', 'error'); return; }
        structure[divName].grades[name] = { bunks: [] };
        expandedGrades.add(divName + '||' + name);
        input.value = '';
        saveData(); renderHierarchy(); updateStats(); toast('Grade added');
        setTimeout(() => document.getElementById('addBunk_' + divName + '_' + name)?.focus(), 50);
    }

    function addBunkInline(divName, gradeName) {
        const input = document.getElementById('addBunk_' + divName + '_' + gradeName);
        const name = input?.value.trim();
        if (!name) return;
        const gradeData = structure[divName]?.grades?.[gradeName];
        if (!gradeData) return;
        if (!gradeData.bunks) gradeData.bunks = [];
        if (gradeData.bunks.includes(name)) { toast('Bunk exists', 'error'); return; }
        gradeData.bunks.push(name);
        input.value = '';
        saveData(); renderHierarchy(); updateStats(); toast('Bunk added');
        setTimeout(() => document.getElementById('addBunk_' + divName + '_' + gradeName)?.focus(), 50);
    }

    function toggleDivision(divName) {
        if (expandedDivisions.has(divName)) expandedDivisions.delete(divName);
        else expandedDivisions.add(divName);
        renderHierarchy();
    }

    function toggleGrade(divName, gradeName) {
        const key = divName + '||' + gradeName;
        if (expandedGrades.has(key)) expandedGrades.delete(key);
        else expandedGrades.add(key);
        renderHierarchy();
    }

    function expandAll() {
        Object.keys(structure).forEach(d => { expandedDivisions.add(d); Object.keys(structure[d].grades || {}).forEach(g => expandedGrades.add(d + '||' + g)); });
        renderHierarchy();
    }

    function collapseAll() { expandedDivisions.clear(); expandedGrades.clear(); renderHierarchy(); }

    function openDivisionModal(editName = null) {
        currentEditDivision = editName;
        document.getElementById('divisionModalTitle').textContent = editName ? 'Edit Division' : 'Add Division';
        if (editName && structure[editName]) {
            document.getElementById('divisionName').value = editName;
            document.getElementById('divisionColor').value = structure[editName].color || COLOR_PRESETS[0];
            updateColorPresetSelection(structure[editName].color || COLOR_PRESETS[0]);
        } else {
            document.getElementById('divisionName').value = '';
            const nextColor = COLOR_PRESETS[Object.keys(structure).length % COLOR_PRESETS.length];
            document.getElementById('divisionColor').value = nextColor;
            updateColorPresetSelection(nextColor);
        }
        openModal('divisionModal');
        document.getElementById('divisionName').focus();
    }

    function saveDivision() {
        const name = document.getElementById('divisionName').value.trim();
        const color = document.getElementById('divisionColor').value;
        if (!name) { toast('Enter a name', 'error'); return; }
        if (currentEditDivision && currentEditDivision !== name) {
            structure[name] = { ...structure[currentEditDivision], color };
            delete structure[currentEditDivision];
            Object.values(camperRoster).forEach(c => { if (c.division === currentEditDivision) c.division = name; });
            expandedDivisions.delete(currentEditDivision); expandedDivisions.add(name);
        } else if (currentEditDivision) {
            structure[currentEditDivision].color = color;
        } else {
            if (structure[name]) { toast('Division exists', 'error'); return; }
            structure[name] = { color, grades: {} };
            expandedDivisions.add(name);
        }
        saveData(); closeModal('divisionModal'); renderAll();
        toast(currentEditDivision ? 'Division updated' : 'Division added');
    }

    function deleteDivision(name) {
        if (!confirm('Delete "' + name + '" and all grades/bunks?')) return;
        delete structure[name];
        expandedDivisions.delete(name);
        Object.values(camperRoster).forEach(c => { if (c.division === name) { c.division = ''; c.grade = ''; c.bunk = ''; } });
        saveData(); renderAll(); toast('Division deleted');
    }

    function deleteGrade(divName, gradeName) {
        if (!confirm('Delete grade "' + gradeName + '"?')) return;
        delete structure[divName].grades[gradeName];
        expandedGrades.delete(divName + '||' + gradeName);
        Object.values(camperRoster).forEach(c => { if (c.division === divName && c.grade === gradeName) { c.grade = ''; c.bunk = ''; } });
        saveData(); renderAll(); toast('Grade deleted');
    }

    function deleteBunk(divName, gradeName, bunkName) {
        const gradeData = structure[divName]?.grades?.[gradeName];
        if (!gradeData) return;
        gradeData.bunks = (gradeData.bunks || []).filter(b => b !== bunkName);
        Object.values(camperRoster).forEach(c => { if (c.bunk === bunkName && c.division === divName && c.grade === gradeName) c.bunk = ''; });
        saveData(); renderHierarchy(); updateStats(); toast('Bunk removed');
    }

    function renderCamperTable() {
        const tbody = document.getElementById('camperTableBody');
        const empty = document.getElementById('campersEmptyState');
        if (!tbody) return;
        const filter = document.getElementById('searchInput')?.value.toLowerCase().trim() || '';
        let campers = Object.entries(camperRoster).map(([name, d]) => ({
            name, division: d.division || '', grade: d.grade || '', bunk: d.bunk || '', team: d.team || ''
        }));
        if (filter) campers = campers.filter(c => c.name.toLowerCase().includes(filter) || c.division.toLowerCase().includes(filter) || c.grade.toLowerCase().includes(filter) || c.bunk.toLowerCase().includes(filter) || c.team.toLowerCase().includes(filter));
        campers.sort((a, b) => { let va = a[sortColumn] || '', vb = b[sortColumn] || ''; const cmp = va.localeCompare(vb, undefined, { numeric: true }); return sortDirection === 'asc' ? cmp : -cmp; });

        document.querySelectorAll('#camperTable th[data-sort]').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            if (th.dataset.sort === sortColumn) th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
        });

        const total = Object.keys(camperRoster).length;
        const countEl = document.getElementById('camperCount');
        if (countEl) countEl.textContent = filter ? campers.length + ' of ' + total : total + ' camper' + (total !== 1 ? 's' : '');

        const divOptions = '<option value="">—</option>' + Object.keys(structure).sort().map(d => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('');
        const teamOptions = '<option value="">—</option>' + leagueTeams.map(t => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');

        let html = '<tr class="add-row"><td><input type="text" id="qaName" placeholder="Camper name" onkeypress="if(event.key===\'Enter\'){CampistryMe.quickAddCamper();event.preventDefault();}"></td><td><select id="qaDivision" onchange="CampistryMe.updateQAGrades()">' + divOptions + '</select></td><td><select id="qaGrade" onchange="CampistryMe.updateQABunks()"><option value="">—</option></select></td><td><select id="qaBunk"><option value="">—</option></select></td><td><select id="qaTeam">' + teamOptions + '</select></td><td><button class="btn btn-primary btn-sm" onclick="CampistryMe.quickAddCamper()">Add</button></td></tr>';

        if (campers.length === 0 && total === 0) { tbody.innerHTML = html; if (empty) empty.style.display = 'block'; return; }
        if (empty) empty.style.display = 'none';

        html += campers.map(c => '<tr><td><span class="clickable" onclick="CampistryMe.editCamper(\'' + esc(c.name) + '\')">' + esc(c.name) + '</span></td><td>' + (esc(c.division) || '—') + '</td><td>' + (esc(c.grade) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (esc(c.team) || '—') + '</td><td><button class="icon-btn danger" onclick="CampistryMe.deleteCamper(\'' + esc(c.name) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td></tr>').join('');
        tbody.innerHTML = html;
    }

    function updateQAGrades() {
        const divName = document.getElementById('qaDivision')?.value;
        const gradeSelect = document.getElementById('qaGrade');
        const bunkSelect = document.getElementById('qaBunk');
        if (!gradeSelect || !bunkSelect) return;
        gradeSelect.innerHTML = '<option value="">—</option>';
        bunkSelect.innerHTML = '<option value="">—</option>';
        if (divName && structure[divName]) {
            Object.keys(structure[divName].grades || {}).sort().forEach(g => { gradeSelect.innerHTML += '<option value="' + esc(g) + '">' + esc(g) + '</option>'; });
        }
    }

    function updateQABunks() {
        const divName = document.getElementById('qaDivision')?.value;
        const gradeName = document.getElementById('qaGrade')?.value;
        const bunkSelect = document.getElementById('qaBunk');
        if (!bunkSelect) return;
        bunkSelect.innerHTML = '<option value="">—</option>';
        if (divName && gradeName && structure[divName]?.grades?.[gradeName]) {
            (structure[divName].grades[gradeName].bunks || []).forEach(b => { bunkSelect.innerHTML += '<option value="' + esc(b) + '">' + esc(b) + '</option>'; });
        }
    }

    function quickAddCamper() {
        const nameInput = document.getElementById('qaName');
        const name = nameInput?.value.trim();
        if (!name) { toast('Enter a name', 'error'); nameInput?.focus(); return; }
        if (camperRoster[name]) { toast('Camper exists', 'error'); return; }
        camperRoster[name] = {
            division: document.getElementById('qaDivision')?.value || '',
            grade: document.getElementById('qaGrade')?.value || '',
            bunk: document.getElementById('qaBunk')?.value || '',
            team: document.getElementById('qaTeam')?.value || ''
        };
        saveData(); nameInput.value = ''; nameInput.focus(); renderCamperTable(); updateStats(); toast('Camper added');
    }

    function editCamper(name) {
        if (!camperRoster[name]) return;
        currentEditCamper = name;
        const c = camperRoster[name];
        document.getElementById('camperModalTitle').textContent = 'Edit Camper';
        document.getElementById('editCamperName').value = name;
        const divSelect = document.getElementById('editCamperDivision');
        divSelect.innerHTML = '<option value="">—</option>' + Object.keys(structure).sort().map(d => '<option value="' + esc(d) + '"' + (d === c.division ? ' selected' : '') + '>' + esc(d) + '</option>').join('');
        updateEditGrades(c.division, c.grade);
        updateEditBunks(c.division, c.grade, c.bunk);
        const teamSelect = document.getElementById('editCamperTeam');
        teamSelect.innerHTML = '<option value="">—</option>' + leagueTeams.map(t => '<option value="' + esc(t) + '"' + (t === c.team ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
        openModal('camperModal');
    }

    function updateEditGrades(divName, selectedGrade) {
        const gradeSelect = document.getElementById('editCamperGrade');
        if (!gradeSelect) return;
        gradeSelect.innerHTML = '<option value="">—</option>';
        if (divName && structure[divName]) {
            Object.keys(structure[divName].grades || {}).sort().forEach(g => { gradeSelect.innerHTML += '<option value="' + esc(g) + '"' + (g === selectedGrade ? ' selected' : '') + '>' + esc(g) + '</option>'; });
        }
    }

    function updateEditBunks(divName, gradeName, selectedBunk) {
        const bunkSelect = document.getElementById('editCamperBunk');
        if (!bunkSelect) return;
        bunkSelect.innerHTML = '<option value="">—</option>';
        if (divName && gradeName && structure[divName]?.grades?.[gradeName]) {
            (structure[divName].grades[gradeName].bunks || []).forEach(b => { bunkSelect.innerHTML += '<option value="' + esc(b) + '"' + (b === selectedBunk ? ' selected' : '') + '>' + esc(b) + '</option>'; });
        }
    }

    function saveCamper() {
        if (!currentEditCamper || !camperRoster[currentEditCamper]) return;
        camperRoster[currentEditCamper] = {
            division: document.getElementById('editCamperDivision')?.value || '',
            grade: document.getElementById('editCamperGrade')?.value || '',
            bunk: document.getElementById('editCamperBunk')?.value || '',
            team: document.getElementById('editCamperTeam')?.value || ''
        };
        saveData(); closeModal('camperModal'); renderCamperTable(); toast('Camper updated');
    }

    function deleteCamper(name) {
        if (!confirm('Delete "' + name + '"?')) return;
        delete camperRoster[name];
        saveData(); renderAll(); toast('Camper deleted');
    }

    function clearAllCampers() {
        const count = Object.keys(camperRoster).length;
        if (!count) { toast('No campers', 'error'); return; }
        if (!confirm('Delete all ' + count + ' campers?')) return;
        camperRoster = {};
        saveData(); renderAll(); toast('All campers cleared');
    }

    function downloadTemplate() {
        const csv = 'Name,Division,Grade,Bunk,Team\nJohn Smith,Junior Boys,5th Grade,Bunk 1,Red Team\nJane Doe,Junior Girls,6th Grade,Bunk 2,Blue Team\nMike Johnson,Senior Boys,7th Grade,Bunk 3,Green Team';
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'camper_import_template.csv';
        a.click();
        toast('Template downloaded');
    }

    function openCsvModal() {
        pendingCsvData = [];
        document.getElementById('csvPreview').style.display = 'none';
        document.getElementById('csvImportBtn').disabled = true;
        const fi = document.getElementById('csvFileInput'); if (fi) fi.value = '';
        openModal('csvModal');
    }

    function handleCsvFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => parseCsv(e.target.result);
        reader.readAsText(file);
    }

    function parseCsv(text) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (!lines.length) { toast('CSV is empty', 'error'); return; }
        const first = lines[0].toLowerCase();
        const hasHeader = first.includes('name') || first.includes('division');
        const start = hasHeader ? 1 : 0;
        pendingCsvData = [];
        for (let i = start; i < lines.length; i++) {
            const cols = parseCsvLine(lines[i]);
            const name = (cols[0] || '').trim();
            if (!name) continue;
            pendingCsvData.push({ name, division: (cols[1]||'').trim(), grade: (cols[2]||'').trim(), bunk: (cols[3]||'').trim(), team: (cols[4]||'').trim() });
        }
        if (pendingCsvData.length) {
            const tbody = document.getElementById('csvPreviewBody');
            if (tbody) {
                tbody.innerHTML = pendingCsvData.slice(0, 10).map(r => '<tr><td>' + esc(r.name) + '</td><td>' + (esc(r.division)||'—') + '</td><td>' + (esc(r.grade)||'—') + '</td><td>' + (esc(r.bunk)||'—') + '</td><td>' + (esc(r.team)||'—') + '</td></tr>').join('');
                if (pendingCsvData.length > 10) tbody.innerHTML += '<tr><td colspan="5" style="text-align:center;color:var(--slate-400)">...and ' + (pendingCsvData.length - 10) + ' more</td></tr>';
            }
            document.getElementById('csvPreview').style.display = 'block';
            document.getElementById('csvImportBtn').disabled = false;
            document.getElementById('csvPreviewCount').textContent = pendingCsvData.length;
        } else { toast('No valid data', 'error'); }
    }

    function parseCsvLine(line) {
        const result = []; let current = '', inQuotes = false;
        for (const char of line) {
            if (char === '"') inQuotes = !inQuotes;
            else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
            else current += char;
        }
        result.push(current);
        return result;
    }

    function importCsv() {
        if (!pendingCsvData.length) return;
        let added = 0, updated = 0;
        pendingCsvData.forEach(r => {
            if (camperRoster[r.name]) updated++; else added++;
            camperRoster[r.name] = { division: r.division, grade: r.grade, bunk: r.bunk, team: r.team };
        });
        saveData(); closeModal('csvModal'); renderAll(); toast('Imported ' + added + ' new, ' + updated + ' updated');
    }

    function exportCsv() {
        const entries = Object.entries(camperRoster);
        if (!entries.length) { toast('No campers', 'error'); return; }
        let csv = 'Name,Division,Grade,Bunk,Team\n';
        entries.forEach(([name, d]) => csv += '"' + name + '","' + (d.division||'') + '","' + (d.grade||'') + '","' + (d.bunk||'') + '","' + (d.team||'') + '"\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'campers_' + new Date().toISOString().split('T')[0] + '.csv';
        a.click();
        toast('Exported ' + entries.length + ' campers');
    }

    function setupTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('tab-' + btn.dataset.tab)?.classList.add('active');
            };
        });
    }

    function openModal(id) { document.getElementById(id)?.classList.add('active'); }
    function closeModal(id) { document.getElementById(id)?.classList.remove('active'); }

    function setupColorPresets() {
        const container = document.getElementById('colorPresets');
        if (!container) return;
        container.innerHTML = '';
        COLOR_PRESETS.forEach(c => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'color-preset';
            btn.style.background = c;
            btn.dataset.color = c;
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectColorPreset(c);
            };
            container.appendChild(btn);
        });
    }

    function selectColorPreset(color) { document.getElementById('divisionColor').value = color; updateColorPresetSelection(color); }
    function updateColorPresetSelection(color) { document.querySelectorAll('.color-preset').forEach(el => el.classList.toggle('selected', el.dataset.color === color)); }

    function setupEventListeners() {
        const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };
        on('addDivisionBtn', 'onclick', () => openDivisionModal());
        on('saveDivisionBtn', 'onclick', saveDivision);
        on('divisionColor', 'oninput', e => updateColorPresetSelection(e.target.value));
        on('divisionName', 'onkeypress', e => { if (e.key === 'Enter') saveDivision(); });
        on('expandAllBtn', 'onclick', expandAll);
        on('collapseAllBtn', 'onclick', collapseAll);
        on('downloadTemplateBtn', 'onclick', downloadTemplate);
        on('importCsvBtn', 'onclick', openCsvModal);
        on('exportCsvBtn', 'onclick', exportCsv);
        on('csvImportBtn', 'onclick', importCsv);
        on('searchInput', 'oninput', renderCamperTable);
        on('clearAllBtn', 'onclick', clearAllCampers);
        on('saveEditCamperBtn', 'onclick', saveCamper);
        on('editCamperDivision', 'onchange', e => { updateEditGrades(e.target.value, ''); updateEditBunks(e.target.value, '', ''); });
        on('editCamperGrade', 'onchange', e => { updateEditBunks(document.getElementById('editCamperDivision')?.value, e.target.value, ''); });

        document.querySelectorAll('#camperTable th[data-sort]').forEach(th => {
            th.onclick = () => {
                const col = th.dataset.sort;
                if (sortColumn === col) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                else { sortColumn = col; sortDirection = 'asc'; }
                renderCamperTable();
            };
        });

        const dropzone = document.getElementById('csvDropzone');
        const fileInput = document.getElementById('csvFileInput');
        if (dropzone && fileInput) {
            dropzone.onclick = () => fileInput.click();
            dropzone.ondragover = e => { e.preventDefault(); dropzone.classList.add('dragover'); };
            dropzone.ondragleave = () => dropzone.classList.remove('dragover');
            dropzone.ondrop = e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleCsvFile(e.dataTransfer.files[0]); };
            fileInput.onchange = e => handleCsvFile(e.target.files[0]);
        }

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.onclick = e => { if (e.target === overlay) closeModal(overlay.id); };
        });
    }

    function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;') : ''; }

    function toast(msg, type = 'success') {
        const t = document.getElementById('toast');
        if (!t) return;
        const icon = document.getElementById('toastIcon');
        if (icon) icon.innerHTML = type === 'error' ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>';
        document.getElementById('toastMessage').textContent = msg;
        t.className = 'toast ' + type + ' show';
        setTimeout(() => t.classList.remove('show'), 3000);
    }

    window.CampistryMe = {
        toggleDivision, toggleGrade, editDivision: openDivisionModal, deleteDivision,
        addGradeInline, deleteGrade, addBunkInline, deleteBunk,
        editCamper, deleteCamper, quickAddCamper,
        updateQAGrades, updateQABunks,
        selectColorPreset, closeModal
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 100);
})();
