// =============================================================================
// campistry_me.js — Campistry Me Camper Management v2.0
// =============================================================================
// Professional camper, division, bunk, and grade management
// Integrates with Campistry Flow data structures
// =============================================================================

(function() {
    'use strict';

    console.log('[Me] Campistry Me v2.0 loading...');

    // =========================================================================
    // STATE
    // =========================================================================
    let camperRoster = {};
    let divisions = {};
    let grades = [];
    let leagueTeams = [];
    let currentEditCamper = null;
    let currentEditDivision = null;
    let currentBunkDivision = null;
    let sortColumn = 'name';
    let sortDirection = 'asc';
    let pendingCsvData = [];

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    async function init() {
        const authed = await checkAuth();
        if (!authed) return;

        await loadAllData();
        setupEventListeners();
        setupTabs();
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
        camperRoster = global?.app1?.camperRoster || {};
        divisions = global?.app1?.divisions || {};
        grades = global?.grades || [];
        
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
        
        console.log('[Me] Loaded:', Object.keys(camperRoster).length, 'campers,', Object.keys(divisions).length, 'divisions,', grades.length, 'grades');
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
            if (!global.app1) global.app1 = {};
            global.app1.camperRoster = camperRoster;
            global.app1.divisions = divisions;
            global.grades = grades;

            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('app1', global.app1);
                window.saveGlobalSettings('grades', grades);
            } else {
                localStorage.setItem('campistryGlobalSettings', JSON.stringify(global));
            }
            setTimeout(() => setSyncStatus('synced'), 500);
        } catch (e) {
            console.error('[Me] Save failed:', e);
            setSyncStatus('error');
        }
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
        renderCamperTable();
        renderDivisions();
        renderGrades();
        populateDropdowns();
    }

    function updateStats() {
        document.getElementById('statCampers').textContent = Object.keys(camperRoster).length;
        let bunkCount = 0;
        Object.values(divisions).forEach(d => { bunkCount += (d.bunks || []).length; });
        document.getElementById('statBunks').textContent = bunkCount;
        document.getElementById('statDivisions').textContent = Object.keys(divisions).length;
        document.getElementById('statGrades').textContent = grades.length;
    }

    // =========================================================================
    // CAMPER TABLE
    // =========================================================================
    function renderCamperTable() {
        const tbody = document.getElementById('camperTableBody');
        const empty = document.getElementById('campersEmptyState');
        const filter = document.getElementById('searchInput').value.toLowerCase().trim();

        let campers = Object.entries(camperRoster).map(([name, d]) => ({
            name, grade: d.grade || '', division: d.division || '', bunk: d.bunk || '', team: d.team || ''
        }));

        if (filter) {
            campers = campers.filter(c =>
                c.name.toLowerCase().includes(filter) ||
                c.grade.toLowerCase().includes(filter) ||
                c.division.toLowerCase().includes(filter) ||
                c.bunk.toLowerCase().includes(filter) ||
                c.team.toLowerCase().includes(filter)
            );
        }

        campers.sort((a, b) => {
            let va = a[sortColumn] || '', vb = b[sortColumn] || '';
            if (sortColumn === 'grade') {
                va = gradeToNum(va); vb = gradeToNum(vb);
                return sortDirection === 'asc' ? va - vb : vb - va;
            }
            const cmp = va.localeCompare(vb, undefined, { numeric: true });
            return sortDirection === 'asc' ? cmp : -cmp;
        });

        document.querySelectorAll('#camperTable th[data-sort]').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            if (th.dataset.sort === sortColumn) th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
        });

        const total = Object.keys(camperRoster).length;
        if (total === 0) {
            tbody.innerHTML = '';
            empty.style.display = 'block';
            document.getElementById('camperCount').textContent = '';
            return;
        }
        empty.style.display = 'none';
        document.getElementById('camperCount').textContent = filter ? `${campers.length} of ${total}` : `${total} campers`;

        let teamOpts = '<option value="">—</option>';
        leagueTeams.forEach(t => { teamOpts += `<option value="${esc(t)}">${esc(t)}</option>`; });

        const frag = document.createDocumentFragment();
        campers.forEach(c => {
            const tr = document.createElement('tr');
            let opts = teamOpts;
            if (c.team) opts = opts.replace(`value="${esc(c.team)}"`, `value="${esc(c.team)}" selected`);
            tr.innerHTML = `
                <td><span class="clickable" onclick="CampistryMe.editCamper('${esc(c.name)}')">${esc(c.name)}</span></td>
                <td>${esc(c.grade) || '—'}</td>
                <td>${esc(c.division) || '—'}</td>
                <td>${esc(c.bunk) || '—'}</td>
                <td><select class="team-sel" data-name="${esc(c.name)}">${opts}</select></td>
                <td><button class="icon-btn danger" onclick="CampistryMe.deleteCamper('${esc(c.name)}')" title="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td>
            `;
            frag.appendChild(tr);
        });
        tbody.innerHTML = '';
        tbody.appendChild(frag);

        tbody.querySelectorAll('.team-sel').forEach(sel => {
            sel.onchange = e => {
                const name = e.target.dataset.name;
                if (camperRoster[name]) {
                    camperRoster[name].team = e.target.value;
                    saveData();
                    toast('Team updated');
                }
            };
        });
    }

    // =========================================================================
    // DIVISIONS
    // =========================================================================
    function renderDivisions() {
        const grid = document.getElementById('divisionsGrid');
        const empty = document.getElementById('divisionsEmptyState');
        const divNames = Object.keys(divisions).sort();

        if (divNames.length === 0) {
            grid.innerHTML = '';
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';

        grid.innerHTML = divNames.map(name => {
            const div = divisions[name];
            const bunks = div.bunks || [];
            const bunkHtml = bunks.length ? bunks.map(b => {
                const bName = typeof b === 'string' ? b : b.name;
                const count = Object.values(camperRoster).filter(c => c.bunk === bName).length;
                return `<li class="bunk-item"><span class="bunk-name">${esc(bName)}</span><span class="bunk-count">${count} campers</span><button class="icon-btn danger" onclick="CampistryMe.deleteBunk('${esc(name)}','${esc(bName)}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></li>`;
            }).join('') : '<li class="bunk-item" style="color:var(--slate-400);font-size:0.85rem;">No bunks yet</li>';

            return `
                <div class="division-card">
                    <div class="division-header">
                        <span class="division-name">${esc(name)}</span>
                        <div class="division-actions">
                            <button class="icon-btn" onclick="CampistryMe.editDivision('${esc(name)}')" title="Edit"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                            <button class="icon-btn danger" onclick="CampistryMe.deleteDivision('${esc(name)}')" title="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                        </div>
                    </div>
                    <div class="division-body">
                        <ul class="bunk-list">${bunkHtml}</ul>
                        <button class="add-bunk-btn" onclick="CampistryMe.openBunkModal('${esc(name)}')">+ Add Bunk</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // =========================================================================
    // GRADES
    // =========================================================================
    function renderGrades() {
        const grid = document.getElementById('gradesGrid');
        const empty = document.getElementById('gradesEmptyState');

        if (grades.length === 0) {
            grid.innerHTML = '';
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';

        grid.innerHTML = grades.map(g => `
            <div class="grade-chip">
                <span class="grade-chip-name">${esc(g)}</span>
                <button class="icon-btn danger" onclick="CampistryMe.deleteGrade('${esc(g)}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
        `).join('');
    }

    function addDefaultGrades() {
        const defaults = ['K', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', 'Staff'];
        let added = 0;
        defaults.forEach(g => {
            if (!grades.includes(g)) { grades.push(g); added++; }
        });
        if (added) {
            saveData();
            renderGrades();
            populateDropdowns();
            updateStats();
            toast(`Added ${added} grades`);
        } else {
            toast('Default grades already exist', 'error');
        }
    }

    // =========================================================================
    // DROPDOWNS
    // =========================================================================
    function populateDropdowns() {
        // Grades
        const gradeSelect = document.getElementById('camperGrade');
        gradeSelect.innerHTML = '<option value="">Select grade...</option>';
        grades.forEach(g => {
            gradeSelect.innerHTML += `<option value="${esc(g)}">${esc(g)}</option>`;
        });

        // Divisions
        const divSelect = document.getElementById('camperDivision');
        divSelect.innerHTML = '<option value="">Select division...</option>';
        Object.keys(divisions).sort().forEach(d => {
            divSelect.innerHTML += `<option value="${esc(d)}">${esc(d)}</option>`;
        });

        // Teams
        const teamSelect = document.getElementById('camperTeam');
        teamSelect.innerHTML = '<option value="">Select team...</option>';
        leagueTeams.forEach(t => {
            teamSelect.innerHTML += `<option value="${esc(t)}">${esc(t)}</option>`;
        });
    }

    function populateBunksFor(divName) {
        const bunkSelect = document.getElementById('camperBunk');
        bunkSelect.innerHTML = '<option value="">Select bunk...</option>';
        if (!divName || !divisions[divName]) return;
        (divisions[divName].bunks || []).forEach(b => {
            const name = typeof b === 'string' ? b : b.name;
            bunkSelect.innerHTML += `<option value="${esc(name)}">${esc(name)}</option>`;
        });
    }

    // =========================================================================
    // CAMPER CRUD
    // =========================================================================
    function openCamperModal(editName = null) {
        currentEditCamper = editName;
        document.getElementById('camperModalTitle').textContent = editName ? 'Edit Camper' : 'Add Camper';
        document.getElementById('camperName').disabled = !!editName;

        if (editName && camperRoster[editName]) {
            const c = camperRoster[editName];
            document.getElementById('camperName').value = editName;
            document.getElementById('camperGrade').value = c.grade || '';
            document.getElementById('camperDivision').value = c.division || '';
            populateBunksFor(c.division);
            document.getElementById('camperBunk').value = c.bunk || '';
            document.getElementById('camperTeam').value = c.team || '';
        } else {
            document.getElementById('camperName').value = '';
            document.getElementById('camperGrade').value = '';
            document.getElementById('camperDivision').value = '';
            document.getElementById('camperBunk').innerHTML = '<option value="">Select bunk...</option>';
            document.getElementById('camperTeam').value = '';
        }
        openModal('camperModal');
        if (!editName) document.getElementById('camperName').focus();
    }

    function saveCamper() {
        const name = document.getElementById('camperName').value.trim();
        if (!name) { toast('Please enter a name', 'error'); return; }
        if (!currentEditCamper && camperRoster[name]) { toast('Camper already exists', 'error'); return; }

        camperRoster[name] = {
            division: document.getElementById('camperDivision').value,
            bunk: document.getElementById('camperBunk').value,
            team: document.getElementById('camperTeam').value,
            grade: document.getElementById('camperGrade').value
        };
        saveData();
        closeModal('camperModal');
        renderCamperTable();
        updateStats();
        toast(currentEditCamper ? 'Camper updated' : 'Camper added');
    }

    function deleteCamper(name) {
        if (!confirm(`Delete "${name}"?`)) return;
        delete camperRoster[name];
        saveData();
        renderCamperTable();
        updateStats();
        toast('Camper deleted');
    }

    function clearAllCampers() {
        const count = Object.keys(camperRoster).length;
        if (!count) { toast('No campers to clear', 'error'); return; }
        if (!confirm(`Delete all ${count} campers?`)) return;
        camperRoster = {};
        saveData();
        renderCamperTable();
        updateStats();
        toast('All campers cleared');
    }

    // =========================================================================
    // DIVISION CRUD
    // =========================================================================
    function openDivisionModal(editName = null) {
        currentEditDivision = editName;
        document.getElementById('divisionModalTitle').textContent = editName ? 'Edit Division' : 'Add Division';
        document.getElementById('divisionName').value = editName || '';
        openModal('divisionModal');
        document.getElementById('divisionName').focus();
    }

    function saveDivision() {
        const name = document.getElementById('divisionName').value.trim();
        if (!name) { toast('Please enter a name', 'error'); return; }

        if (currentEditDivision && currentEditDivision !== name) {
            // Rename
            divisions[name] = divisions[currentEditDivision];
            delete divisions[currentEditDivision];
            // Update campers
            Object.values(camperRoster).forEach(c => {
                if (c.division === currentEditDivision) c.division = name;
            });
        } else if (!currentEditDivision) {
            if (divisions[name]) { toast('Division already exists', 'error'); return; }
            divisions[name] = { bunks: [] };
        }

        saveData();
        closeModal('divisionModal');
        renderAll();
        toast(currentEditDivision ? 'Division updated' : 'Division added');
    }

    function deleteDivision(name) {
        const bunks = (divisions[name]?.bunks || []).length;
        if (!confirm(`Delete "${name}"${bunks ? ` and its ${bunks} bunks` : ''}?`)) return;
        delete divisions[name];
        // Clear division/bunk from campers
        Object.values(camperRoster).forEach(c => {
            if (c.division === name) { c.division = ''; c.bunk = ''; }
        });
        saveData();
        renderAll();
        toast('Division deleted');
    }

    // =========================================================================
    // BUNK CRUD
    // =========================================================================
    function openBunkModal(divName) {
        currentBunkDivision = divName;
        document.getElementById('bunkDivisionDisplay').value = divName;
        document.getElementById('bunkName').value = '';
        openModal('bunkModal');
        document.getElementById('bunkName').focus();
    }

    function saveBunk() {
        const name = document.getElementById('bunkName').value.trim();
        if (!name) { toast('Please enter a name', 'error'); return; }
        if (!currentBunkDivision || !divisions[currentBunkDivision]) { toast('Invalid division', 'error'); return; }

        if (!divisions[currentBunkDivision].bunks) divisions[currentBunkDivision].bunks = [];
        const exists = divisions[currentBunkDivision].bunks.some(b => (typeof b === 'string' ? b : b.name) === name);
        if (exists) { toast('Bunk already exists', 'error'); return; }

        divisions[currentBunkDivision].bunks.push(name);
        saveData();
        closeModal('bunkModal');
        renderAll();
        toast('Bunk added');
    }

    function deleteBunk(divName, bunkName) {
        if (!confirm(`Delete bunk "${bunkName}"?`)) return;
        if (!divisions[divName]) return;
        divisions[divName].bunks = (divisions[divName].bunks || []).filter(b => (typeof b === 'string' ? b : b.name) !== bunkName);
        // Clear from campers
        Object.values(camperRoster).forEach(c => {
            if (c.bunk === bunkName) c.bunk = '';
        });
        saveData();
        renderAll();
        toast('Bunk deleted');
    }

    // =========================================================================
    // GRADE CRUD
    // =========================================================================
    function openGradeModal() {
        document.getElementById('gradeName').value = '';
        openModal('gradeModal');
        document.getElementById('gradeName').focus();
    }

    function saveGrade() {
        const name = document.getElementById('gradeName').value.trim();
        if (!name) { toast('Please enter a name', 'error'); return; }
        if (grades.includes(name)) { toast('Grade already exists', 'error'); return; }
        grades.push(name);
        saveData();
        closeModal('gradeModal');
        renderGrades();
        populateDropdowns();
        updateStats();
        toast('Grade added');
    }

    function deleteGrade(name) {
        if (!confirm(`Delete grade "${name}"?`)) return;
        grades = grades.filter(g => g !== name);
        saveData();
        renderGrades();
        populateDropdowns();
        updateStats();
        toast('Grade deleted');
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
        const hasHeader = first.includes('name') || first.includes('grade') || first.includes('division');
        const start = hasHeader ? 1 : 0;
        pendingCsvData = [];

        for (let i = start; i < lines.length; i++) {
            const cols = parseCsvLine(lines[i]);
            const name = (cols[0] || '').trim();
            if (!name) continue;
            pendingCsvData.push({
                name,
                grade: (cols[1] || '').trim(),
                division: (cols[2] || '').trim(),
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
            <tr><td>${esc(r.name)}</td><td>${esc(r.grade) || '—'}</td><td>${esc(r.division) || '—'}</td><td>${esc(r.bunk) || '—'}</td><td>${esc(r.team) || '—'}</td></tr>
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
            camperRoster[r.name] = { division: r.division, bunk: r.bunk, team: r.team, grade: r.grade };
        });
        saveData();
        closeModal('csvModal');
        renderAll();
        toast(`Imported ${added} new, ${updated} updated`);
    }

    function exportCsv() {
        const entries = Object.entries(camperRoster);
        if (!entries.length) { toast('No campers to export', 'error'); return; }
        let csv = 'Name,Grade,Division,Bunk,Team\n';
        entries.forEach(([name, d]) => {
            csv += `"${name}","${d.grade || ''}","${d.division || ''}","${d.bunk || ''}","${d.team || ''}"\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `campers_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        toast(`Exported ${entries.length} campers`);
    }

    // =========================================================================
    // TABS
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

    // =========================================================================
    // MODAL HELPERS
    // =========================================================================
    function openModal(id) {
        document.getElementById(id).classList.add('active');
    }

    function closeModal(id) {
        document.getElementById(id).classList.remove('active');
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================
    function setupEventListeners() {
        document.getElementById('addCamperBtn').onclick = () => openCamperModal();
        document.getElementById('saveCamperBtn').onclick = saveCamper;
        document.getElementById('camperDivision').onchange = e => populateBunksFor(e.target.value);
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

        document.getElementById('addDivisionBtn').onclick = () => openDivisionModal();
        document.getElementById('saveDivisionBtn').onclick = saveDivision;

        document.getElementById('saveBunkBtn').onclick = saveBunk;

        document.getElementById('addGradeBtn').onclick = openGradeModal;
        document.getElementById('addDefaultGradesBtn').onclick = addDefaultGrades;
        document.getElementById('saveGradeBtn').onclick = saveGrade;

        // Close modals on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.onclick = e => { if (e.target === overlay) closeModal(overlay.id); };
        });

        // Enter key support
        document.getElementById('camperName').onkeypress = e => { if (e.key === 'Enter') saveCamper(); };
        document.getElementById('divisionName').onkeypress = e => { if (e.key === 'Enter') saveDivision(); };
        document.getElementById('bunkName').onkeypress = e => { if (e.key === 'Enter') saveBunk(); };
        document.getElementById('gradeName').onkeypress = e => { if (e.key === 'Enter') saveGrade(); };
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================
    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function gradeToNum(g) {
        if (!g) return 99;
        if (g === 'K') return 0;
        if (g === 'Staff') return 100;
        const n = parseInt(g);
        return isNaN(n) ? 99 : n;
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
        editCamper: openCamperModal,
        deleteCamper,
        editDivision: openDivisionModal,
        deleteDivision,
        openBunkModal,
        deleteBunk,
        deleteGrade,
        closeModal
    };

    // Boot
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 100);

})();
