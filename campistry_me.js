// =============================================================================
// campistry_me.js — Campistry Me v3.0
// =============================================================================
// Hierarchical camp structure: Division > Grade > Bunk
// Campers are assigned to grades (and optionally bunks)
// Colors for divisions matching app1 style
// =============================================================================

(function() {
    'use strict';

    console.log('[Me] Campistry Me v3.0 loading...');

    // =========================================================================
    // STATE
    // =========================================================================
    
    // Structure: { divisionName: { color, grades: { gradeName: { bunks: [] } } } }
    let structure = {};
    
    // Campers: { name: { division, grade, bunk, team } }
    let camperRoster = {};
    
    // League teams from Flow
    let leagueTeams = [];
    
    // UI State
    let expandedDivisions = new Set();
    let expandedGrades = new Set();
    let currentEditDivision = null;
    let currentGradeDivision = null;
    let currentBunkDivision = null;
    let currentBunkGrade = null;
    let currentEditCamper = null;
    let sortColumn = 'name';
    let sortDirection = 'asc';
    let pendingCsvData = [];

    // Color presets (matching app1)
    const COLOR_PRESETS = [
        '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
        '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
        '#6366F1', '#8B5CF6', '#D946EF', '#F43F5E', '#FB923C'
    ];

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
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
            while (!window.supabase && attempts < 20) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
            if (!window.supabase) {
                window.location.href = 'landing.html';
                return false;
            }
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) {
                window.location.href = 'landing.html';
                return false;
            }
            return true;
        } catch (e) {
            window.location.href = 'landing.html';
            return false;
        }
    }

    // =========================================================================
    // DATA LOADING
    // =========================================================================
    async function loadAllData() {
        if (window.CampistryDB?.ready) await window.CampistryDB.ready;
        
        const global = loadGlobalSettings();
        
        // Load camper roster
        camperRoster = global?.app1?.camperRoster || {};
        
        // Load or migrate structure
        if (global?.campStructure) {
            // New format exists
            structure = global.campStructure;
        } else if (global?.app1?.divisions) {
            // Migrate from old format
            structure = migrateOldStructure(global.app1.divisions);
        } else {
            structure = {};
        }
        
        // Load league teams
        const teams = new Set();
        const leagues = global?.leaguesByName || {};
        Object.values(leagues).forEach(l => {
            if (l.teams) l.teams.forEach(t => teams.add(t));
        });
        const specialtyLeagues = global?.specialtyLeagues || {};
        Object.values(specialtyLeagues).forEach(l => {
            if (l.teams) l.teams.forEach(t => teams.add(t));
        });
        leagueTeams = Array.from(teams).sort();
        
        // Expand all by default for first load
        Object.keys(structure).forEach(d => expandedDivisions.add(d));
        
        console.log('[Me] Loaded:', Object.keys(structure).length, 'divisions,', Object.keys(camperRoster).length, 'campers');
    }

    function migrateOldStructure(oldDivisions) {
        // Convert old flat division/bunk format to new hierarchical format
        const newStructure = {};
        Object.entries(oldDivisions).forEach(([divName, divData]) => {
            const color = divData.color || COLOR_PRESETS[Object.keys(newStructure).length % COLOR_PRESETS.length];
            newStructure[divName] = {
                color: color,
                grades: {
                    'Default': {
                        bunks: (divData.bunks || []).map(b => typeof b === 'string' ? b : b.name)
                    }
                }
            };
        });
        return newStructure;
    }

    function loadGlobalSettings() {
        try {
            if (window.loadGlobalSettings) return window.loadGlobalSettings();
            const raw = localStorage.getItem('campistryGlobalSettings');
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    // =========================================================================
    // DATA SAVING
    // =========================================================================
    function saveData() {
        try {
            setSyncStatus('syncing');
            const global = loadGlobalSettings();
            
            // Save new structure format
            global.campStructure = structure;
            
            // Also sync to old app1.divisions format for Flow compatibility
            if (!global.app1) global.app1 = {};
            global.app1.camperRoster = camperRoster;
            global.app1.divisions = convertToOldFormat(structure);

            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('campStructure', structure);
                window.saveGlobalSettings('app1', global.app1);
            } else {
                localStorage.setItem('campistryGlobalSettings', JSON.stringify(global));
            }
            
            setTimeout(() => setSyncStatus('synced'), 500);
        } catch (e) {
            console.error('[Me] Save failed:', e);
            setSyncStatus('error');
        }
    }

    function convertToOldFormat(struct) {
        // Convert new hierarchical format back to old flat format for Flow compatibility
        const oldFormat = {};
        Object.entries(struct).forEach(([divName, divData]) => {
            const allBunks = [];
            Object.values(divData.grades || {}).forEach(gradeData => {
                (gradeData.bunks || []).forEach(b => allBunks.push(b));
            });
            oldFormat[divName] = {
                color: divData.color,
                bunks: allBunks
            };
        });
        return oldFormat;
    }

    function setSyncStatus(status) {
        const dot = document.getElementById('syncDot');
        const text = document.getElementById('syncText');
        if (status === 'syncing') {
            dot.classList.add('syncing');
            text.textContent = 'Syncing...';
        } else if (status === 'synced') {
            dot.classList.remove('syncing');
            dot.style.background = '#059669';
            text.textContent = 'Synced';
        } else {
            dot.classList.remove('syncing');
            dot.style.background = '#ef4444';
            text.textContent = 'Error';
        }
    }

    // =========================================================================
    // RENDER ALL
    // =========================================================================
    function renderAll() {
        updateStats();
        renderHierarchy();
        renderCamperTable();
        populateCamperDropdowns();
    }

    function updateStats() {
        let gradeCount = 0, bunkCount = 0;
        Object.values(structure).forEach(div => {
            const grades = div.grades || {};
            gradeCount += Object.keys(grades).length;
            Object.values(grades).forEach(g => {
                bunkCount += (g.bunks || []).length;
            });
        });
        
        document.getElementById('statDivisions').textContent = Object.keys(structure).length;
        document.getElementById('statGrades').textContent = gradeCount;
        document.getElementById('statBunks').textContent = bunkCount;
        document.getElementById('statCampers').textContent = Object.keys(camperRoster).length;
    }

    // =========================================================================
    // HIERARCHY RENDERING
    // =========================================================================
    function renderHierarchy() {
        const container = document.getElementById('hierarchyContainer');
        const empty = document.getElementById('structureEmptyState');
        const divNames = Object.keys(structure).sort();

        if (divNames.length === 0) {
            container.innerHTML = '';
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';

        container.innerHTML = divNames.map(divName => {
            const div = structure[divName];
            const isExpanded = expandedDivisions.has(divName);
            const grades = div.grades || {};
            const gradeNames = Object.keys(grades).sort();
            const camperCount = Object.values(camperRoster).filter(c => c.division === divName).length;

            return `
                <div class="division-block" data-division="${esc(divName)}">
                    <div class="division-header ${isExpanded ? '' : 'collapsed'}" onclick="CampistryMe.toggleDivision('${esc(divName)}')">
                        <div class="division-left">
                            <div class="division-color" style="background: ${div.color || '#4F46E5'}"></div>
                            <div class="division-info">
                                <h3>${esc(divName)}</h3>
                                <div class="division-meta">${gradeNames.length} grade${gradeNames.length !== 1 ? 's' : ''} · ${camperCount} camper${camperCount !== 1 ? 's' : ''}</div>
                            </div>
                        </div>
                        <div class="division-actions">
                            <button class="icon-btn" onclick="event.stopPropagation(); CampistryMe.editDivision('${esc(divName)}')" title="Edit">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                            <button class="icon-btn danger" onclick="event.stopPropagation(); CampistryMe.deleteDivision('${esc(divName)}')" title="Delete">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                            <svg class="expand-icon ${isExpanded ? '' : 'collapsed'}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                    </div>
                    <div class="division-body ${isExpanded ? '' : 'collapsed'}">
                        <div class="grades-section">
                            <div class="grades-list">
                                ${gradeNames.map(gradeName => renderGrade(divName, gradeName, grades[gradeName])).join('')}
                            </div>
                            <div class="add-grade-row">
                                <button class="add-btn-inline" onclick="CampistryMe.openGradeModal('${esc(divName)}')">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    Add Grade
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderGrade(divName, gradeName, gradeData) {
        const key = `${divName}||${gradeName}`;
        const isExpanded = expandedGrades.has(key);
        const bunks = gradeData.bunks || [];
        const camperCount = Object.values(camperRoster).filter(c => c.division === divName && c.grade === gradeName).length;

        return `
            <div class="grade-block" data-division="${esc(divName)}" data-grade="${esc(gradeName)}">
                <div class="grade-header ${isExpanded ? '' : 'collapsed'}" onclick="CampistryMe.toggleGrade('${esc(divName)}', '${esc(gradeName)}')">
                    <div class="grade-left">
                        <svg class="expand-icon ${isExpanded ? '' : 'collapsed'}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        <span class="grade-info">${esc(gradeName)}</span>
                        <span class="grade-count">${bunks.length} bunk${bunks.length !== 1 ? 's' : ''} · ${camperCount} camper${camperCount !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="grade-actions">
                        <button class="icon-btn danger" onclick="event.stopPropagation(); CampistryMe.deleteGrade('${esc(divName)}', '${esc(gradeName)}')" title="Delete Grade">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                    </div>
                </div>
                <div class="grade-body ${isExpanded ? '' : 'collapsed'}">
                    <div class="bunks-list">
                        ${bunks.map(bunk => {
                            const bunkCampers = Object.values(camperRoster).filter(c => c.bunk === bunk).length;
                            return `
                                <div class="bunk-chip">
                                    <span>${esc(bunk)}</span>
                                    <span class="bunk-chip-count">(${bunkCampers})</span>
                                    <button class="icon-btn danger" onclick="CampistryMe.deleteBunk('${esc(divName)}', '${esc(gradeName)}', '${esc(bunk)}')" title="Delete">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                    </button>
                                </div>
                            `;
                        }).join('')}
                        <button class="add-btn-inline" onclick="CampistryMe.openBunkModal('${esc(divName)}', '${esc(gradeName)}')">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Bunk
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    // =========================================================================
    // TOGGLE EXPAND/COLLAPSE
    // =========================================================================
    function toggleDivision(divName) {
        if (expandedDivisions.has(divName)) {
            expandedDivisions.delete(divName);
        } else {
            expandedDivisions.add(divName);
        }
        renderHierarchy();
    }

    function toggleGrade(divName, gradeName) {
        const key = `${divName}||${gradeName}`;
        if (expandedGrades.has(key)) {
            expandedGrades.delete(key);
        } else {
            expandedGrades.add(key);
        }
        renderHierarchy();
    }

    // =========================================================================
    // DIVISION CRUD
    // =========================================================================
    function openDivisionModal(editName = null) {
        currentEditDivision = editName;
        document.getElementById('divisionModalTitle').textContent = editName ? 'Edit Division' : 'Add Division';
        
        if (editName && structure[editName]) {
            document.getElementById('divisionName').value = editName;
            document.getElementById('divisionColor').value = structure[editName].color || '#4F46E5';
            updateColorPresetSelection(structure[editName].color);
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
        
        if (!name) { toast('Please enter a division name', 'error'); return; }

        if (currentEditDivision && currentEditDivision !== name) {
            // Rename
            structure[name] = { ...structure[currentEditDivision], color };
            delete structure[currentEditDivision];
            // Update campers
            Object.values(camperRoster).forEach(c => {
                if (c.division === currentEditDivision) c.division = name;
            });
            expandedDivisions.delete(currentEditDivision);
            expandedDivisions.add(name);
        } else if (currentEditDivision) {
            // Just update color
            structure[currentEditDivision].color = color;
        } else {
            // New division
            if (structure[name]) { toast('Division already exists', 'error'); return; }
            structure[name] = { color, grades: {} };
            expandedDivisions.add(name);
        }

        saveData();
        closeModal('divisionModal');
        renderAll();
        toast(currentEditDivision ? 'Division updated' : 'Division added');
    }

    function deleteDivision(name) {
        const gradeCount = Object.keys(structure[name]?.grades || {}).length;
        const camperCount = Object.values(camperRoster).filter(c => c.division === name).length;
        
        let msg = `Delete "${name}"?`;
        if (gradeCount || camperCount) {
            msg += `\n\nThis will also remove ${gradeCount} grade(s) and unassign ${camperCount} camper(s).`;
        }
        
        if (!confirm(msg)) return;
        
        delete structure[name];
        expandedDivisions.delete(name);
        
        // Clear from campers
        Object.values(camperRoster).forEach(c => {
            if (c.division === name) {
                c.division = '';
                c.grade = '';
                c.bunk = '';
            }
        });
        
        saveData();
        renderAll();
        toast('Division deleted');
    }

    // =========================================================================
    // GRADE CRUD
    // =========================================================================
    function openGradeModal(divName) {
        currentGradeDivision = divName;
        document.getElementById('gradeModalTitle').textContent = 'Add Grade';
        document.getElementById('gradeForDivision').value = divName;
        document.getElementById('gradeName').value = '';
        openModal('gradeModal');
        document.getElementById('gradeName').focus();
    }

    function saveGrade() {
        const name = document.getElementById('gradeName').value.trim();
        if (!name) { toast('Please enter a grade name', 'error'); return; }
        if (!currentGradeDivision || !structure[currentGradeDivision]) { 
            toast('Invalid division', 'error'); 
            return; 
        }

        if (!structure[currentGradeDivision].grades) {
            structure[currentGradeDivision].grades = {};
        }
        
        if (structure[currentGradeDivision].grades[name]) {
            toast('Grade already exists in this division', 'error');
            return;
        }

        structure[currentGradeDivision].grades[name] = { bunks: [] };
        expandedGrades.add(`${currentGradeDivision}||${name}`);
        
        saveData();
        closeModal('gradeModal');
        renderAll();
        toast('Grade added');
    }

    function deleteGrade(divName, gradeName) {
        const camperCount = Object.values(camperRoster).filter(c => c.division === divName && c.grade === gradeName).length;
        
        let msg = `Delete grade "${gradeName}"?`;
        if (camperCount) {
            msg += `\n\nThis will unassign ${camperCount} camper(s) from this grade.`;
        }
        
        if (!confirm(msg)) return;
        
        delete structure[divName].grades[gradeName];
        expandedGrades.delete(`${divName}||${gradeName}`);
        
        // Clear from campers
        Object.values(camperRoster).forEach(c => {
            if (c.division === divName && c.grade === gradeName) {
                c.grade = '';
                c.bunk = '';
            }
        });
        
        saveData();
        renderAll();
        toast('Grade deleted');
    }

    // =========================================================================
    // BUNK CRUD
    // =========================================================================
    function openBunkModal(divName, gradeName) {
        currentBunkDivision = divName;
        currentBunkGrade = gradeName;
        document.getElementById('bunkModalTitle').textContent = 'Add Bunk';
        document.getElementById('bunkForDivision').value = divName;
        document.getElementById('bunkForGrade').value = gradeName;
        document.getElementById('bunkName').value = '';
        openModal('bunkModal');
        document.getElementById('bunkName').focus();
    }

    function saveBunk() {
        const name = document.getElementById('bunkName').value.trim();
        if (!name) { toast('Please enter a bunk name', 'error'); return; }
        
        const gradeData = structure[currentBunkDivision]?.grades?.[currentBunkGrade];
        if (!gradeData) { toast('Invalid grade', 'error'); return; }
        
        if (!gradeData.bunks) gradeData.bunks = [];
        if (gradeData.bunks.includes(name)) {
            toast('Bunk already exists in this grade', 'error');
            return;
        }

        gradeData.bunks.push(name);
        
        saveData();
        closeModal('bunkModal');
        renderAll();
        toast('Bunk added');
    }

    function deleteBunk(divName, gradeName, bunkName) {
        if (!confirm(`Delete bunk "${bunkName}"?`)) return;
        
        const gradeData = structure[divName]?.grades?.[gradeName];
        if (!gradeData) return;
        
        gradeData.bunks = (gradeData.bunks || []).filter(b => b !== bunkName);
        
        // Clear from campers
        Object.values(camperRoster).forEach(c => {
            if (c.bunk === bunkName) c.bunk = '';
        });
        
        saveData();
        renderAll();
        toast('Bunk deleted');
    }

    // =========================================================================
    // CAMPER TABLE
    // =========================================================================
    function renderCamperTable() {
        const tbody = document.getElementById('camperTableBody');
        const empty = document.getElementById('campersEmptyState');
        const filter = document.getElementById('searchInput').value.toLowerCase().trim();

        let campers = Object.entries(camperRoster).map(([name, d]) => ({
            name, 
            division: d.division || '', 
            grade: d.grade || '', 
            bunk: d.bunk || '', 
            team: d.team || ''
        }));

        if (filter) {
            campers = campers.filter(c =>
                c.name.toLowerCase().includes(filter) ||
                c.division.toLowerCase().includes(filter) ||
                c.grade.toLowerCase().includes(filter) ||
                c.bunk.toLowerCase().includes(filter) ||
                c.team.toLowerCase().includes(filter)
            );
        }

        campers.sort((a, b) => {
            let va = a[sortColumn] || '', vb = b[sortColumn] || '';
            const cmp = va.localeCompare(vb, undefined, { numeric: true });
            return sortDirection === 'asc' ? cmp : -cmp;
        });

        // Update sort indicators
        document.querySelectorAll('#camperTable th[data-sort]').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            if (th.dataset.sort === sortColumn) {
                th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });

        const total = Object.keys(camperRoster).length;
        if (total === 0) {
            tbody.innerHTML = '';
            empty.style.display = 'block';
            document.getElementById('camperCount').textContent = '';
            return;
        }
        
        empty.style.display = 'none';
        document.getElementById('camperCount').textContent = filter 
            ? `${campers.length} of ${total}` 
            : `${total} camper${total !== 1 ? 's' : ''}`;

        tbody.innerHTML = campers.map(c => `
            <tr>
                <td><span class="clickable" onclick="CampistryMe.editCamper('${esc(c.name)}')">${esc(c.name)}</span></td>
                <td>${esc(c.division) || '—'}</td>
                <td>${esc(c.grade) || '—'}</td>
                <td>${esc(c.bunk) || '—'}</td>
                <td>${esc(c.team) || '—'}</td>
                <td>
                    <button class="icon-btn danger" onclick="CampistryMe.deleteCamper('${esc(c.name)}')" title="Delete">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    // =========================================================================
    // CAMPER CRUD
    // =========================================================================
    function populateCamperDropdowns() {
        const divSelect = document.getElementById('camperDivision');
        divSelect.innerHTML = '<option value="">Select division...</option>';
        Object.keys(structure).sort().forEach(d => {
            divSelect.innerHTML += `<option value="${esc(d)}">${esc(d)}</option>`;
        });

        const teamSelect = document.getElementById('camperTeam');
        teamSelect.innerHTML = '<option value="">Select team...</option>';
        leagueTeams.forEach(t => {
            teamSelect.innerHTML += `<option value="${esc(t)}">${esc(t)}</option>`;
        });
    }

    function updateGradeDropdown(divName) {
        const gradeSelect = document.getElementById('camperGrade');
        gradeSelect.innerHTML = '<option value="">Select grade...</option>';
        
        if (divName && structure[divName]) {
            Object.keys(structure[divName].grades || {}).sort().forEach(g => {
                gradeSelect.innerHTML += `<option value="${esc(g)}">${esc(g)}</option>`;
            });
        }
        
        // Also reset bunk
        document.getElementById('camperBunk').innerHTML = '<option value="">Select bunk...</option>';
    }

    function updateBunkDropdown(divName, gradeName) {
        const bunkSelect = document.getElementById('camperBunk');
        bunkSelect.innerHTML = '<option value="">Select bunk...</option>';
        
        if (divName && gradeName && structure[divName]?.grades?.[gradeName]) {
            (structure[divName].grades[gradeName].bunks || []).forEach(b => {
                bunkSelect.innerHTML += `<option value="${esc(b)}">${esc(b)}</option>`;
            });
        }
    }

    function openCamperModal(editName = null) {
        currentEditCamper = editName;
        document.getElementById('camperModalTitle').textContent = editName ? 'Edit Camper' : 'Add Camper';
        document.getElementById('camperName').disabled = !!editName;

        populateCamperDropdowns();

        if (editName && camperRoster[editName]) {
            const c = camperRoster[editName];
            document.getElementById('camperName').value = editName;
            document.getElementById('camperDivision').value = c.division || '';
            updateGradeDropdown(c.division);
            document.getElementById('camperGrade').value = c.grade || '';
            updateBunkDropdown(c.division, c.grade);
            document.getElementById('camperBunk').value = c.bunk || '';
            document.getElementById('camperTeam').value = c.team || '';
        } else {
            document.getElementById('camperName').value = '';
            document.getElementById('camperDivision').value = '';
            document.getElementById('camperGrade').innerHTML = '<option value="">Select grade...</option>';
            document.getElementById('camperBunk').innerHTML = '<option value="">Select bunk...</option>';
            document.getElementById('camperTeam').value = '';
        }
        
        openModal('camperModal');
        if (!editName) document.getElementById('camperName').focus();
    }

    function saveCamper() {
        const name = document.getElementById('camperName').value.trim();
        if (!name) { toast('Please enter a name', 'error'); return; }
        if (!currentEditCamper && camperRoster[name]) { 
            toast('Camper already exists', 'error'); 
            return; 
        }

        camperRoster[name] = {
            division: document.getElementById('camperDivision').value,
            grade: document.getElementById('camperGrade').value,
            bunk: document.getElementById('camperBunk').value,
            team: document.getElementById('camperTeam').value
        };
        
        saveData();
        closeModal('camperModal');
        renderAll();
        toast(currentEditCamper ? 'Camper updated' : 'Camper added');
    }

    function deleteCamper(name) {
        if (!confirm(`Delete "${name}"?`)) return;
        delete camperRoster[name];
        saveData();
        renderAll();
        toast('Camper deleted');
    }

    function clearAllCampers() {
        const count = Object.keys(camperRoster).length;
        if (!count) { toast('No campers to clear', 'error'); return; }
        if (!confirm(`Delete all ${count} campers? This cannot be undone.`)) return;
        camperRoster = {};
        saveData();
        renderAll();
        toast('All campers cleared');
    }

    // =========================================================================
    // CSV IMPORT/EXPORT
    // =========================================================================
    function openCsvModal() {
        pendingCsvData = [];
        document.getElementById('csvPreview').style.display = 'none';
        document.getElementById('csvImportBtn').disabled = true;
        openModal('csvModal');
    }

    function handleCsvFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try { parseCsv(e.target.result); }
            catch (err) { toast('Failed to read CSV', 'error'); }
        };
        reader.readAsText(file);
    }

    function parseCsv(text) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (!lines.length) { toast('CSV is empty', 'error'); return; }

        const first = lines[0].toLowerCase();
        const hasHeader = first.includes('name') || first.includes('division') || first.includes('grade');
        const start = hasHeader ? 1 : 0;
        pendingCsvData = [];

        for (let i = start; i < lines.length; i++) {
            const cols = parseCsvLine(lines[i]);
            const name = (cols[0] || '').trim();
            if (!name) continue;
            pendingCsvData.push({
                name,
                division: (cols[1] || '').trim(),
                grade: (cols[2] || '').trim(),
                bunk: (cols[3] || '').trim(),
                team: (cols[4] || '').trim()
            });
        }

        if (pendingCsvData.length) {
            renderCsvPreview();
            document.getElementById('csvPreview').style.display = 'block';
            document.getElementById('csvImportBtn').disabled = false;
            document.getElementById('csvPreviewCount').textContent = pendingCsvData.length;
        } else {
            toast('No valid data found', 'error');
        }
    }

    function parseCsvLine(line) {
        const result = [];
        let current = '', inQuotes = false;
        for (const char of line) {
            if (char === '"') inQuotes = !inQuotes;
            else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
            else current += char;
        }
        result.push(current);
        return result;
    }

    function renderCsvPreview() {
        const tbody = document.getElementById('csvPreviewBody');
        tbody.innerHTML = pendingCsvData.slice(0, 10).map(r => `
            <tr>
                <td>${esc(r.name)}</td>
                <td>${esc(r.division) || '—'}</td>
                <td>${esc(r.grade) || '—'}</td>
                <td>${esc(r.bunk) || '—'}</td>
                <td>${esc(r.team) || '—'}</td>
            </tr>
        `).join('');
        if (pendingCsvData.length > 10) {
            tbody.innerHTML += `<tr><td colspan="5" style="text-align:center;color:var(--slate-400);">...and ${pendingCsvData.length - 10} more</td></tr>`;
        }
    }

    function importCsv() {
        if (!pendingCsvData.length) return;
        let added = 0, updated = 0;
        pendingCsvData.forEach(r => {
            if (camperRoster[r.name]) updated++; else added++;
            camperRoster[r.name] = { 
                division: r.division, 
                grade: r.grade,
                bunk: r.bunk, 
                team: r.team 
            };
        });
        saveData();
        closeModal('csvModal');
        renderAll();
        toast(`Imported ${added} new, ${updated} updated`);
    }

    function exportCsv() {
        const entries = Object.entries(camperRoster);
        if (!entries.length) { toast('No campers to export', 'error'); return; }
        let csv = 'Name,Division,Grade,Bunk,Team\n';
        entries.forEach(([name, d]) => {
            csv += `"${name}","${d.division || ''}","${d.grade || ''}","${d.bunk || ''}","${d.team || ''}"\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `campers_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        toast(`Exported ${entries.length} campers`);
    }

    // =========================================================================
    // TABS & MODALS
    // =========================================================================
    function setupTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            };
        });
    }

    function openModal(id) {
        document.getElementById(id).classList.add('active');
    }

    function closeModal(id) {
        document.getElementById(id).classList.remove('active');
    }

    // =========================================================================
    // COLOR PRESETS
    // =========================================================================
    function setupColorPresets() {
        const container = document.getElementById('colorPresets');
        container.innerHTML = COLOR_PRESETS.map(c => 
            `<div class="color-preset" style="background:${c}" data-color="${c}" onclick="CampistryMe.selectColorPreset('${c}')"></div>`
        ).join('');
    }

    function selectColorPreset(color) {
        document.getElementById('divisionColor').value = color;
        updateColorPresetSelection(color);
    }

    function updateColorPresetSelection(color) {
        document.querySelectorAll('.color-preset').forEach(el => {
            el.classList.toggle('selected', el.dataset.color === color);
        });
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================
    function setupEventListeners() {
        // Division
        document.getElementById('addDivisionBtn').onclick = () => openDivisionModal();
        document.getElementById('saveDivisionBtn').onclick = saveDivision;
        document.getElementById('divisionColor').oninput = e => updateColorPresetSelection(e.target.value);

        // Grade
        document.getElementById('saveGradeBtn').onclick = saveGrade;

        // Bunk
        document.getElementById('saveBunkBtn').onclick = saveBunk;

        // Camper
        document.getElementById('addCamperBtn').onclick = () => openCamperModal();
        document.getElementById('saveCamperBtn').onclick = saveCamper;
        document.getElementById('camperDivision').onchange = e => {
            updateGradeDropdown(e.target.value);
        };
        document.getElementById('camperGrade').onchange = e => {
            updateBunkDropdown(document.getElementById('camperDivision').value, e.target.value);
        };

        // Table
        document.getElementById('searchInput').oninput = renderCamperTable;
        document.getElementById('clearAllBtn').onclick = clearAllCampers;
        document.querySelectorAll('#camperTable th[data-sort]').forEach(th => {
            th.onclick = () => {
                const col = th.dataset.sort;
                if (sortColumn === col) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                else { sortColumn = col; sortDirection = 'asc'; }
                renderCamperTable();
            };
        });

        // CSV
        document.getElementById('importCsvBtn').onclick = openCsvModal;
        document.getElementById('exportCsvBtn').onclick = exportCsv;
        document.getElementById('csvImportBtn').onclick = importCsv;

        const dropzone = document.getElementById('csvDropzone');
        const fileInput = document.getElementById('csvFileInput');
        dropzone.onclick = () => fileInput.click();
        dropzone.ondragover = e => { e.preventDefault(); dropzone.classList.add('dragover'); };
        dropzone.ondragleave = () => dropzone.classList.remove('dragover');
        dropzone.ondrop = e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleCsvFile(e.dataTransfer.files[0]); };
        fileInput.onchange = e => handleCsvFile(e.target.files[0]);

        // Modal close on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.onclick = e => { if (e.target === overlay) closeModal(overlay.id); };
        });

        // Enter key support
        document.getElementById('divisionName').onkeypress = e => { if (e.key === 'Enter') saveDivision(); };
        document.getElementById('gradeName').onkeypress = e => { if (e.key === 'Enter') saveGrade(); };
        document.getElementById('bunkName').onkeypress = e => { if (e.key === 'Enter') saveBunk(); };
        document.getElementById('camperName').onkeypress = e => { if (e.key === 'Enter') saveCamper(); };
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================
    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function toast(msg, type = 'success') {
        const t = document.getElementById('toast');
        document.getElementById('toastMessage').textContent = msg;
        t.className = 'toast ' + type + ' show';
        setTimeout(() => t.classList.remove('show'), 3000);
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryMe = {
        toggleDivision,
        toggleGrade,
        editDivision: openDivisionModal,
        deleteDivision,
        openGradeModal,
        deleteGrade,
        openBunkModal,
        deleteBunk,
        editCamper: openCamperModal,
        deleteCamper,
        selectColorPreset,
        closeModal
    };

    // Boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 100);
    }

})();
