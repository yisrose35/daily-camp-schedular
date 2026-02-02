// =============================================================================
// campistry_me.js — Campistry Me Camper Management v1.0
// =============================================================================
//
// Provides camper database management for Campistry platform.
// Stores data in same format as Campistry Flow for seamless integration.
//
// Data Structure (compatible with app1.js camperRoster):
// {
//   "Camper Name": {
//     division: "Division A",
//     bunk: "Bunk 1",
//     team: "Red Team",
//     grade: "5"  // NEW field for Campistry Me
//   }
// }
//
// =============================================================================

(function() {
    'use strict';

    console.log('👤 Campistry Me v1.0 loading...');

    // =========================================================================
    // STATE
    // =========================================================================

    let camperRoster = {};       // Main camper data
    let divisions = {};          // Division/bunk structure from Flow
    let leagueTeams = [];        // Available league teams
    let currentEditCamper = null; // For edit mode
    let sortColumn = 'name';
    let sortDirection = 'asc';
    let pendingCsvData = [];     // CSV import staging

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function init() {
        console.log('👤 Initializing Campistry Me...');

        // Check auth
        const authed = await checkAuth();
        if (!authed) return;

        // Load data
        await loadAllData();

        // Setup UI
        setupEventListeners();
        renderCamperTable();
        updateStats();
        populateDropdowns();

        // Show main content
        document.getElementById('auth-loading-screen').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';

        console.log('👤 Campistry Me ready!');
    }

    // =========================================================================
    // AUTHENTICATION
    // =========================================================================

    async function checkAuth() {
        try {
            let attempts = 0;
            while (!window.supabase && attempts < 20) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            if (!window.supabase) {
                console.error('👤 Supabase not available');
                window.location.href = 'landing.html';
                return false;
            }

            const { data: { session }, error } = await window.supabase.auth.getSession();

            if (error || !session) {
                console.log('👤 No session, redirecting to login');
                window.location.href = 'landing.html';
                return false;
            }

            console.log('👤 Authenticated as:', session.user.email);
            return true;

        } catch (e) {
            console.error('👤 Auth check failed:', e);
            window.location.href = 'landing.html';
            return false;
        }
    }

    // =========================================================================
    // DATA LOADING
    // =========================================================================

    async function loadAllData() {
        // Wait for CampistryDB if available
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        // Load global settings (contains camper roster, divisions, leagues)
        const global = loadGlobalSettings();

        // Load camper roster
        camperRoster = global?.app1?.camperRoster || {};
        console.log('👤 Loaded', Object.keys(camperRoster).length, 'campers');

        // Load divisions/bunks structure
        divisions = global?.app1?.divisions || {};
        console.log('👤 Loaded', Object.keys(divisions).length, 'divisions');

        // Load league teams
        loadLeagueTeams(global);
    }

    function loadGlobalSettings() {
        try {
            // Try cloud-synced data first
            if (window.loadGlobalSettings) {
                return window.loadGlobalSettings();
            }
            
            // Fallback to localStorage
            const raw = localStorage.getItem('campistryGlobalSettings');
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            console.error('👤 Failed to load global settings:', e);
            return {};
        }
    }

    function loadLeagueTeams(global) {
        const teams = new Set();

        // Regular leagues
        const leagues = global?.leaguesByName || {};
        Object.values(leagues).forEach(league => {
            if (league.teams) {
                league.teams.forEach(t => teams.add(t));
            }
        });

        // Specialty leagues
        const specialtyLeagues = global?.specialtyLeagues || {};
        Object.values(specialtyLeagues).forEach(league => {
            if (league.teams) {
                league.teams.forEach(t => teams.add(t));
            }
        });

        leagueTeams = Array.from(teams).sort();
        console.log('👤 Loaded', leagueTeams.length, 'league teams');
    }

    // =========================================================================
    // DATA SAVING
    // =========================================================================

    function saveData() {
        try {
            setSyncStatus('syncing');

            // Get current global settings
            const global = loadGlobalSettings();
            
            // Ensure app1 exists
            if (!global.app1) global.app1 = {};
            
            // Update camper roster
            global.app1.camperRoster = camperRoster;

            // Save using saveGlobalSettings if available (handles cloud sync)
            if (window.saveGlobalSettings) {
                window.saveGlobalSettings('app1', global.app1);
            } else {
                // Fallback to localStorage
                localStorage.setItem('campistryGlobalSettings', JSON.stringify(global));
            }

            console.log('👤 Saved', Object.keys(camperRoster).length, 'campers');
            
            setTimeout(() => setSyncStatus('synced'), 500);
            
        } catch (e) {
            console.error('👤 Save failed:', e);
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
            dot.style.background = '#10b981';
            text.textContent = 'Synced';
        } else {
            dot.classList.remove('syncing');
            dot.style.background = '#ef4444';
            text.textContent = 'Sync error';
        }
    }

    // =========================================================================
    // UI RENDERING
    // =========================================================================

    function renderCamperTable() {
        const tbody = document.getElementById('camperTableBody');
        const emptyState = document.getElementById('emptyState');
        const searchInput = document.getElementById('searchInput');
        const filter = searchInput.value.toLowerCase().trim();

        // Get campers as array
        let campers = Object.entries(camperRoster).map(([name, data]) => ({
            name,
            grade: data.grade || '',
            division: data.division || '',
            bunk: data.bunk || '',
            team: data.team || ''
        }));

        // Filter
        if (filter) {
            campers = campers.filter(c => 
                c.name.toLowerCase().includes(filter) ||
                c.grade.toLowerCase().includes(filter) ||
                c.division.toLowerCase().includes(filter) ||
                c.bunk.toLowerCase().includes(filter) ||
                c.team.toLowerCase().includes(filter)
            );
        }

        // Sort
        campers.sort((a, b) => {
            let valA = a[sortColumn] || '';
            let valB = b[sortColumn] || '';
            
            // Numeric sort for grade
            if (sortColumn === 'grade') {
                valA = gradeToNumber(valA);
                valB = gradeToNumber(valB);
                return sortDirection === 'asc' ? valA - valB : valB - valA;
            }
            
            // String sort for others
            const cmp = valA.localeCompare(valB, undefined, { numeric: true });
            return sortDirection === 'asc' ? cmp : -cmp;
        });

        // Update sort indicators
        document.querySelectorAll('.me-table th[data-sort]').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            if (th.dataset.sort === sortColumn) {
                th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });

        // Show/hide empty state
        const totalCampers = Object.keys(camperRoster).length;
        if (totalCampers === 0) {
            tbody.innerHTML = '';
            emptyState.style.display = 'block';
            document.getElementById('camperCount').textContent = '';
            return;
        }
        
        emptyState.style.display = 'none';

        // Update count
        if (filter) {
            document.getElementById('camperCount').textContent = 
                `Showing ${campers.length} of ${totalCampers}`;
        } else {
            document.getElementById('camperCount').textContent = `${totalCampers} campers`;
        }

        // Build team options
        let teamOptions = '<option value="">—</option>';
        leagueTeams.forEach(t => {
            teamOptions += `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`;
        });

        // Build rows
        const fragment = document.createDocumentFragment();
        
        campers.forEach(camper => {
            const row = document.createElement('tr');
            
            // Team options with current selection
            let currentTeamOptions = teamOptions;
            if (camper.team) {
                currentTeamOptions = currentTeamOptions.replace(
                    `value="${escapeHtml(camper.team)}"`,
                    `value="${escapeHtml(camper.team)}" selected`
                );
            }

            row.innerHTML = `
                <td>
                    <strong style="cursor: pointer; color: #d97706;" 
                            onclick="window.CampistryMe.editCamper('${escapeHtml(camper.name)}')"
                            title="Click to edit">
                        ${escapeHtml(camper.name)}
                    </strong>
                </td>
                <td>${escapeHtml(camper.grade) || '—'}</td>
                <td>${escapeHtml(camper.division) || '—'}</td>
                <td>${escapeHtml(camper.bunk) || '—'}</td>
                <td>
                    <select class="team-selector" data-name="${escapeHtml(camper.name)}">
                        ${currentTeamOptions}
                    </select>
                </td>
                <td>
                    <button class="me-delete-btn" 
                            onclick="window.CampistryMe.deleteCamper('${escapeHtml(camper.name)}')"
                            title="Delete camper">
                        🗑️
                    </button>
                </td>
            `;
            
            fragment.appendChild(row);
        });

        tbody.innerHTML = '';
        tbody.appendChild(fragment);

        // Attach team change listeners
        tbody.querySelectorAll('.team-selector').forEach(select => {
            select.addEventListener('change', (e) => {
                const name = e.target.dataset.name;
                const newTeam = e.target.value;
                if (camperRoster[name]) {
                    camperRoster[name].team = newTeam;
                    saveData();
                    updateStats();
                    showToast('Team updated', 'success');
                }
            });
        });
    }

    function updateStats() {
        const total = Object.keys(camperRoster).length;
        const bunks = new Set(Object.values(camperRoster).map(c => c.bunk).filter(Boolean));
        const withTeams = Object.values(camperRoster).filter(c => c.team).length;

        document.getElementById('statTotalCampers').textContent = total;
        document.getElementById('statTotalBunks').textContent = bunks.size;
        document.getElementById('statWithTeams').textContent = withTeams;
    }

    function populateDropdowns() {
        // Populate division dropdown
        const divisionSelect = document.getElementById('camperDivision');
        divisionSelect.innerHTML = '<option value="">Select division...</option>';
        
        Object.keys(divisions).sort().forEach(divName => {
            const opt = document.createElement('option');
            opt.value = divName;
            opt.textContent = divName;
            divisionSelect.appendChild(opt);
        });

        // Populate team dropdown
        const teamSelect = document.getElementById('camperTeam');
        teamSelect.innerHTML = '<option value="">Select team...</option>';
        
        leagueTeams.forEach(team => {
            const opt = document.createElement('option');
            opt.value = team;
            opt.textContent = team;
            teamSelect.appendChild(opt);
        });
    }

    function populateBunksForDivision(divisionName) {
        const bunkSelect = document.getElementById('camperBunk');
        bunkSelect.innerHTML = '<option value="">Select bunk...</option>';

        if (!divisionName || !divisions[divisionName]) return;

        const bunks = divisions[divisionName].bunks || [];
        bunks.forEach(bunk => {
            const bunkName = typeof bunk === 'string' ? bunk : bunk.name;
            const opt = document.createElement('option');
            opt.value = bunkName;
            opt.textContent = bunkName;
            bunkSelect.appendChild(opt);
        });
    }

    // =========================================================================
    // CAMPER CRUD OPERATIONS
    // =========================================================================

    function openAddModal() {
        currentEditCamper = null;
        document.getElementById('modalTitle').textContent = 'Add Camper';
        document.getElementById('camperName').value = '';
        document.getElementById('camperGrade').value = '';
        document.getElementById('camperDivision').value = '';
        document.getElementById('camperBunk').innerHTML = '<option value="">Select bunk...</option>';
        document.getElementById('camperTeam').value = '';
        document.getElementById('camperName').disabled = false;
        
        document.getElementById('camperModal').classList.add('active');
        document.getElementById('camperName').focus();
    }

    function editCamper(name) {
        if (!camperRoster[name]) return;

        currentEditCamper = name;
        const data = camperRoster[name];

        document.getElementById('modalTitle').textContent = 'Edit Camper';
        document.getElementById('camperName').value = name;
        document.getElementById('camperName').disabled = true; // Don't allow name change
        document.getElementById('camperGrade').value = data.grade || '';
        document.getElementById('camperDivision').value = data.division || '';
        
        // Populate bunks and select current
        populateBunksForDivision(data.division);
        document.getElementById('camperBunk').value = data.bunk || '';
        
        document.getElementById('camperTeam').value = data.team || '';

        document.getElementById('camperModal').classList.add('active');
    }

    function saveCamper() {
        const name = document.getElementById('camperName').value.trim();
        const grade = document.getElementById('camperGrade').value;
        const division = document.getElementById('camperDivision').value;
        const bunk = document.getElementById('camperBunk').value;
        const team = document.getElementById('camperTeam').value;

        if (!name) {
            showToast('Please enter a name', 'error');
            return;
        }

        // Check for duplicate names (only when adding new)
        if (!currentEditCamper && camperRoster[name]) {
            showToast('A camper with this name already exists', 'error');
            return;
        }

        camperRoster[name] = {
            division,
            bunk,
            team,
            grade
        };

        saveData();
        closeModal();
        renderCamperTable();
        updateStats();
        showToast(currentEditCamper ? 'Camper updated' : 'Camper added', 'success');
    }

    function deleteCamper(name) {
        if (!confirm(`Delete "${name}" from the camper database?`)) return;

        delete camperRoster[name];
        saveData();
        renderCamperTable();
        updateStats();
        showToast('Camper deleted', 'success');
    }

    function clearAllCampers() {
        const count = Object.keys(camperRoster).length;
        if (!confirm(`Are you sure you want to delete ALL ${count} campers? This cannot be undone.`)) return;

        camperRoster = {};
        saveData();
        renderCamperTable();
        updateStats();
        showToast('All campers cleared', 'success');
    }

    function closeModal() {
        document.getElementById('camperModal').classList.remove('active');
        currentEditCamper = null;
    }

    // =========================================================================
    // CSV IMPORT/EXPORT
    // =========================================================================

    function openCsvModal() {
        pendingCsvData = [];
        document.getElementById('csvPreview').style.display = 'none';
        document.getElementById('csvImport').disabled = true;
        document.getElementById('csvModal').classList.add('active');
    }

    function closeCsvModal() {
        document.getElementById('csvModal').classList.remove('active');
        pendingCsvData = [];
    }

    function handleCsvFile(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target.result;
                parseCsvData(text);
            } catch (err) {
                showToast('Failed to read CSV file', 'error');
                console.error('CSV read error:', err);
            }
        };
        reader.readAsText(file);
    }

    function parseCsvData(text) {
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        
        if (lines.length === 0) {
            showToast('CSV file is empty', 'error');
            return;
        }

        // Detect if first row is header
        const firstLine = lines[0].toLowerCase();
        const hasHeader = firstLine.includes('name') || 
                         firstLine.includes('grade') || 
                         firstLine.includes('division') ||
                         firstLine.includes('bunk');

        const startIndex = hasHeader ? 1 : 0;
        pendingCsvData = [];

        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Parse CSV line (handle quoted values)
            const cols = parseCSVLine(line);

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

        // Show preview
        if (pendingCsvData.length > 0) {
            renderCsvPreview();
            document.getElementById('csvPreview').style.display = 'block';
            document.getElementById('csvImport').disabled = false;
            document.getElementById('csvPreviewCount').textContent = pendingCsvData.length;
        } else {
            showToast('No valid camper data found in CSV', 'error');
        }
    }

    function parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current);
        
        return result;
    }

    function renderCsvPreview() {
        const tbody = document.getElementById('csvPreviewBody');
        tbody.innerHTML = '';

        // Show first 10 rows
        const preview = pendingCsvData.slice(0, 10);
        
        preview.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHtml(row.name)}</td>
                <td>${escapeHtml(row.grade) || '—'}</td>
                <td>${escapeHtml(row.division) || '—'}</td>
                <td>${escapeHtml(row.bunk) || '—'}</td>
                <td>${escapeHtml(row.team) || '—'}</td>
            `;
            tbody.appendChild(tr);
        });

        if (pendingCsvData.length > 10) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="5" style="text-align: center; color: #6b7280;">
                ...and ${pendingCsvData.length - 10} more
            </td>`;
            tbody.appendChild(tr);
        }
    }

    function importCsvData() {
        if (pendingCsvData.length === 0) return;

        let added = 0;
        let updated = 0;

        pendingCsvData.forEach(row => {
            if (camperRoster[row.name]) {
                updated++;
            } else {
                added++;
            }

            camperRoster[row.name] = {
                division: row.division,
                bunk: row.bunk,
                team: row.team,
                grade: row.grade
            };
        });

        saveData();
        closeCsvModal();
        renderCamperTable();
        updateStats();
        populateDropdowns();

        showToast(`Imported ${added} new, ${updated} updated`, 'success');
    }

    function exportCsv() {
        const campers = Object.entries(camperRoster);
        
        if (campers.length === 0) {
            showToast('No campers to export', 'error');
            return;
        }

        // Build CSV
        let csv = 'Name,Grade,Division,Bunk,Team\n';
        
        campers.forEach(([name, data]) => {
            const row = [
                `"${name}"`,
                `"${data.grade || ''}"`,
                `"${data.division || ''}"`,
                `"${data.bunk || ''}"`,
                `"${data.team || ''}"`
            ];
            csv += row.join(',') + '\n';
        });

        // Download
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `campistry_campers_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);

        showToast(`Exported ${campers.length} campers`, 'success');
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    function setupEventListeners() {
        // Add camper button
        document.getElementById('addCamperBtn').addEventListener('click', openAddModal);

        // Modal controls
        document.getElementById('modalClose').addEventListener('click', closeModal);
        document.getElementById('modalCancel').addEventListener('click', closeModal);
        document.getElementById('modalSave').addEventListener('click', saveCamper);

        // Division change - update bunks
        document.getElementById('camperDivision').addEventListener('change', (e) => {
            populateBunksForDivision(e.target.value);
        });

        // Search
        document.getElementById('searchInput').addEventListener('input', () => {
            renderCamperTable();
        });

        // Sort
        document.querySelectorAll('.me-table th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.sort;
                if (sortColumn === col) {
                    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    sortColumn = col;
                    sortDirection = 'asc';
                }
                renderCamperTable();
            });
        });

        // Clear all
        document.getElementById('clearAllBtn').addEventListener('click', clearAllCampers);

        // CSV import
        document.getElementById('importCsvBtn').addEventListener('click', openCsvModal);
        document.getElementById('csvModalClose').addEventListener('click', closeCsvModal);
        document.getElementById('csvCancel').addEventListener('click', closeCsvModal);
        document.getElementById('csvImport').addEventListener('click', importCsvData);

        // CSV dropzone
        const dropzone = document.getElementById('csvDropzone');
        const fileInput = document.getElementById('csvFileInput');

        dropzone.addEventListener('click', () => fileInput.click());
        
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });
        
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) handleCsvFile(file);
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleCsvFile(file);
        });

        // CSV export
        document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);

        // Close modals on overlay click
        document.getElementById('camperModal').addEventListener('click', (e) => {
            if (e.target.id === 'camperModal') closeModal();
        });
        
        document.getElementById('csvModal').addEventListener('click', (e) => {
            if (e.target.id === 'csvModal') closeCsvModal();
        });

        // Enter key in modal
        document.getElementById('camperName').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveCamper();
        });
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function gradeToNumber(grade) {
        if (!grade) return 99;
        if (grade === 'K') return 0;
        if (grade === 'Staff') return 100;
        const num = parseInt(grade);
        return isNaN(num) ? 99 : num;
    }

    function showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        const icon = document.getElementById('toastIcon');
        const text = document.getElementById('toastMessage');

        icon.textContent = type === 'success' ? '✓' : '✕';
        text.textContent = message;
        
        toast.className = 'me-toast ' + type;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.CampistryMe = {
        editCamper,
        deleteCamper,
        getCamperRoster: () => camperRoster,
        getDivisions: () => divisions,
        getLeagueTeams: () => leagueTeams,
        refresh: async () => {
            await loadAllData();
            renderCamperTable();
            updateStats();
            populateDropdowns();
        }
    };

    // =========================================================================
    // BOOT
    // =========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 100);
    }

})();
