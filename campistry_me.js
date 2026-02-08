// =============================================================================
// campistry_me.js — Campistry Me v7.0
// Professional UI, Cloud Sync, Fast inline inputs
// =============================================================================
// v7.0 — Final audit rewrite (18 issues resolved):
// ★ beforeunload actually flushes pending cloud saves via sendBeacon
// ★ saveCamper calls renderAll() so stat cards stay in sync
// ★ addBunkInline validates isUnsafeName (was only missing path)
// ★ Division rename updates expandedGrades keys (no more grade collapse)
// ★ visibilitychange throttled to 10s + skips when pending edits exist
// ★ loadFromCloud refreshes session (parity with saveToCloud)
// ★ migrateOldStructure null-guards corrupted divData
// ★ Toast timeout tracked — rapid toasts no longer cancel each other
// ★ quickAddCamper focuses AFTER render (not on destroyed DOM)
// ★ saveToCloudLegacy uses deep merge for app1 keys
// ★ Template CSV includes BOM for Excel consistency
// ★ Accessibility: aria-labels, role=status on toast, aria-label on search
// =============================================================================

(function() {
    'use strict';
    console.log('[Me] Campistry Me v7.0 loading...');

    let structure = {};
    let camperRoster = {};
    let leagueTeams = [];
    let _leagueData = []; // ★ v7.0: Stores { teams:[], divisions:[] } per league for grade filtering
    let expandedDivisions = new Set();
    let expandedGrades = new Set();
    let currentEditDivision = null;
    let currentEditCamper = null;
    let sortColumn = 'name';
    let sortDirection = 'asc';
    let pendingCsvData = [];

    // ★ Cloud sync state
    let _cloudSaveTimeout = null;
    let _cloudVersion = null;
    let _pendingMergeData = null;
    let _searchDebounceTimeout = null;
    let _toastTimeout = null; // ★ v7.0: Track toast timer to prevent overlap
    let _lastCloudFetchTime = 0; // ★ v7.0: Throttle visibilitychange cloud fetches
    const CLOUD_SAVE_DEBOUNCE_MS = 800;
    const CLOUD_FETCH_COOLDOWN_MS = 10000; // ★ v7.0: Min 10s between tab-focus fetches
    const MAX_NAME_LENGTH = 100;
    const MAX_CSV_FILE_SIZE = 5 * 1024 * 1024; // 5MB
    const MAX_CSV_ROWS = 10000;
    const MAX_CLOUD_RETRIES = 3;

    const COLOR_PRESETS = ['#00C896','#6366F1','#F59E0B','#EF4444','#8B5CF6','#3B82F6','#10B981','#EC4899','#F97316','#14B8A6','#84CC16','#A855F7','#06B6D4','#F43F5E','#22C55E','#FBBF24'];

    // =========================================================================
    // ★ CLOUD SYNC HELPERS (direct Supabase access)
    // =========================================================================

    function getSupabaseClient() {
        return window.CampistryDB?.getClient?.() || window.supabase || null;
    }

    function getCampId() {
        return window.CampistryDB?.getCampId?.() || 
               localStorage.getItem('campistry_camp_id') || 
               localStorage.getItem('campistry_user_id') || 
               null;
    }

    async function loadFromCloud() {
        const client = getSupabaseClient();
        const campId = getCampId();
        if (!client || !campId) {
            console.log('[Me] No client/campId for cloud load');
            return null;
        }
        try {
            // ★ v7.0: Refresh session before load (parity with saveToCloud)
            try {
                const { error: refreshErr } = await client.auth.getSession();
                if (refreshErr) console.warn('[Me] Session refresh warning:', refreshErr.message);
            } catch (_) { /* best effort */ }

            const { data, error } = await client
                .from('camp_state')
                .select('state, version')
                .eq('camp_id', campId)
                .single();
            if (error) {
                if (error.code === 'PGRST116') {
                    console.log('[Me] No cloud state found (new camp)');
                    return null;
                }
                console.warn('[Me] Cloud load error:', error.message);
                return null;
            }
            if (data?.state) {
                _cloudVersion = data.version || null;
                console.log('[Me] ☁️ Cloud data loaded:', {
                    divisions: Object.keys(data.state.divisions || data.state.campStructure || {}).length,
                    campers: Object.keys(data.state.app1?.camperRoster || {}).length,
                    version: _cloudVersion,
                    updated_at: data.state.updated_at
                });
                return data.state;
            }
            return null;
        } catch (e) {
            console.error('[Me] Cloud load exception:', e);
            return null;
        }
    }

    async function saveToCloud(mergeData, _retryCount) {
        const retryCount = _retryCount || 0;
        const client = getSupabaseClient();
        const campId = getCampId();
        if (!client || !campId) {
            console.log('[Me] No client/campId for cloud save');
            return false;
        }
        if (!navigator.onLine) {
            console.log('[Me] Offline - cloud save skipped');
            return false;
        }
        try {
            // ★ Refresh session if needed to prevent 401 on expired JWT
            try {
                const { error: refreshErr } = await client.auth.getSession();
                if (refreshErr) console.warn('[Me] Session refresh warning:', refreshErr.message);
            } catch (_) { /* best effort */ }

            // ★ Use atomic server-side merge to prevent race conditions
            const { data, error } = await client.rpc('merge_camp_state', {
                p_camp_id: campId,
                p_partial_state: mergeData,
                p_expected_version: _cloudVersion
            });

            if (error) {
                // ★ Detect auth/permission errors specifically
                const msg = error.message || '';
                if (msg.includes('401') || msg.includes('JWT') || msg.includes('expired')) {
                    console.error('[Me] Session expired — please reload');
                    toast('Session expired — please reload the page', 'error');
                    return false;
                }
                if (msg.includes('403') || msg.includes('permission') || msg.includes('denied')) {
                    console.error('[Me] Permission denied');
                    toast('Permission denied — check your access', 'error');
                    return false;
                }
                console.error('[Me] Cloud save RPC error:', msg);
                // Fallback to legacy upsert if RPC doesn't exist yet
                if (msg.includes('merge_camp_state')) {
                    return await saveToCloudLegacy(mergeData);
                }
                return false;
            }

            if (data && data.ok === false && data.error === 'version_conflict') {
                // ★ Cap retries to prevent infinite loop
                if (retryCount >= MAX_CLOUD_RETRIES) {
                    console.error('[Me] ☁️ Version conflict — max retries reached, giving up');
                    toast('Sync conflict — please reload', 'error');
                    return false;
                }
                console.warn('[Me] ☁️ Version conflict (retry', retryCount + 1, '/', MAX_CLOUD_RETRIES, ')');
                const fresh = await loadFromCloud();
                if (fresh) {
                    return await saveToCloud(mergeData, retryCount + 1);
                }
                return false;
            }

            if (data?.version) {
                _cloudVersion = data.version;
            }

            console.log('[Me] ☁️ Cloud save complete (v' + (_cloudVersion || '?') + '):', {
                campStructure: Object.keys(mergeData.campStructure || {}).length + ' divisions',
                campers: Object.keys(mergeData.app1?.camperRoster || {}).length
            });
            return true;
        } catch (e) {
            console.error('[Me] Cloud save exception:', e);
            return false;
        }
    }

    // ★ Legacy fallback if merge_camp_state RPC not deployed yet
    async function saveToCloudLegacy(mergeData) {
        const client = getSupabaseClient();
        const campId = getCampId();
        if (!client || !campId) return false;
        try {
            // ★ v7.0: Session refresh (may be called independently, not just from saveToCloud)
            try { await client.auth.getSession(); } catch (_) { /* best effort */ }

            const { data: current, error: fetchError } = await client
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .single();

            if (fetchError && fetchError.code !== 'PGRST116') {
                console.warn('[Me] Cloud fetch error:', fetchError.message);
            }

            const currentState = current?.state || {};
            // ★ v7.0: Deep merge — only overwrite Me-owned keys inside app1
            const currentApp1 = currentState.app1 || {};
            const mergeApp1 = mergeData.app1 || {};
            const mergedApp1 = { ...currentApp1 };
            if (mergeApp1.camperRoster !== undefined) mergedApp1.camperRoster = mergeApp1.camperRoster;
            if (mergeApp1.divisions !== undefined) mergedApp1.divisions = mergeApp1.divisions;
            const newState = {
                ...currentState,
                ...mergeData,
                app1: mergedApp1,
                updated_at: new Date().toISOString()
            };

            const { error: upsertError } = await client
                .from('camp_state')
                .upsert({
                    camp_id: campId,
                    state: newState,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'camp_id' });

            if (upsertError) {
                console.error('[Me] Legacy cloud save error:', upsertError.message);
                return false;
            }
            console.log('[Me] ☁️ Legacy cloud save complete');
            return true;
        } catch (e) {
            console.error('[Me] Legacy cloud save exception:', e);
            return false;
        }
    }

    function scheduleCloudSave(mergeData) {
        _pendingMergeData = mergeData; // ★ Track for beforeunload flush
        if (_cloudSaveTimeout) clearTimeout(_cloudSaveTimeout);
        _cloudSaveTimeout = setTimeout(async () => {
            _pendingMergeData = null;
            const success = await saveToCloud(mergeData);
            if (success) {
                setSyncStatus('synced');
            } else {
                setSyncStatus('error');
            }
        }, CLOUD_SAVE_DEBOUNCE_MS);
    }

    // =========================================================================
    // ★ UNIFIED LOCAL STORAGE (writes to BOTH keys for cross-page compat)
    // =========================================================================

    function readLocalSettings() {
        // Try integration_hooks key first (used by Flow page)
        try {
            const raw1 = localStorage.getItem('campGlobalSettings_v1');
            if (raw1) {
                const parsed = JSON.parse(raw1);
                if (Object.keys(parsed).length > 1) return parsed;
            }
        } catch (e) { /* ignore */ }
        
        // Fallback to legacy Me key
        try {
            const raw2 = localStorage.getItem('campistryGlobalSettings');
            if (raw2) return JSON.parse(raw2);
        } catch (e) { /* ignore */ }
        
        return {};
    }

    function writeLocalSettings(data) {
        const json = JSON.stringify(data);
        // Write to BOTH keys so Flow and Me stay in sync
        try {
            localStorage.setItem('campistryGlobalSettings', json);
            localStorage.setItem('campGlobalSettings_v1', json);
            localStorage.setItem('CAMPISTRY_LOCAL_CACHE', json);
        } catch (e) {
            console.error('[Me] localStorage write failed (quota exceeded?):', e.message);
            toast('Local storage full — data saved to cloud only', 'error');
        }
    }

    // =========================================================================
    // INIT / AUTH / LOAD
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
            while (!window.supabase && attempts < 20) { await new Promise(r => setTimeout(r, 100)); attempts++; }
            if (!window.supabase) { window.location.href = 'index.html'; return false; }
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) { window.location.href = 'landing.html'; return false; }
            return true;
        } catch (e) { window.location.href = 'landing.html'; return false; }
    }

    async function loadAllData() {
        // Wait for CampistryDB if available
        if (window.CampistryDB?.ready) await window.CampistryDB.ready;

        // ★ Step 1: Load from localStorage (fast, immediate)
        let local = readLocalSettings();
        
        // ★ Step 2: Load from cloud (may take a moment)
        let cloud = null;
        try {
            cloud = await loadFromCloud();
        } catch (e) {
            console.warn('[Me] Cloud load failed, using local only:', e);
        }
        
        // ★ Step 3: Smart merge - pick the best source
        let global;
        const localHasData = Object.keys(local.campStructure || local.app1?.divisions || {}).length > 0 ||
                             Object.keys(local.app1?.camperRoster || {}).length > 0;
        const cloudHasData = cloud && (
            Object.keys(cloud.campStructure || cloud.app1?.divisions || {}).length > 0 ||
            Object.keys(cloud.app1?.camperRoster || {}).length > 0
        );

        if (cloudHasData && localHasData) {
            // Both have data - use timestamps to decide
            const cloudTime = new Date(cloud.updated_at || 0).getTime();
            const localTime = new Date(local.updated_at || 0).getTime();
            
            if (localTime > cloudTime) {
                // ★ Deep merge — preserve cloud's non-Me keys inside app1
                const mergedApp1 = { ...(cloud.app1 || {}) };
                const localApp1 = local.app1 || {};
                // Only overwrite Me-owned keys, preserve everything else (skeletons, etc.)
                mergedApp1.camperRoster = localApp1.camperRoster || mergedApp1.camperRoster;
                mergedApp1.divisions = localApp1.divisions || mergedApp1.divisions;
                global = { ...cloud, ...local, app1: mergedApp1 };
                console.log('[Me] Using local data (newer by', Math.round((localTime - cloudTime) / 1000), 'seconds)');
                scheduleCloudSave({
                    campStructure: global.campStructure,
                    app1: global.app1,
                    updated_at: new Date().toISOString()
                });
            } else {
                global = cloud;
                console.log('[Me] Using cloud data (newer)');
                // Update local with cloud data
                writeLocalSettings(cloud);
            }
        } else if (cloudHasData) {
            global = cloud;
            console.log('[Me] Using cloud data (local empty)');
            writeLocalSettings(cloud);
        } else if (localHasData) {
            global = local;
            console.log('[Me] Using local data (cloud empty)');
            // Push local to cloud
            scheduleCloudSave({
                campStructure: local.campStructure,
                app1: local.app1,
                updated_at: new Date().toISOString()
            });
        } else {
            global = {};
            console.log('[Me] No data found (fresh start)');
        }

        // ★ Step 4: Extract into working variables
        camperRoster = global?.app1?.camperRoster || {};
        structure = global?.campStructure || migrateOldStructure(global?.app1?.divisions || {});
        
        // Collect league data with division associations for grade-filtered dropdowns
        _leagueData = [];
        const allTeams = new Set();
        const addLeague = l => {
            if (!l || !Array.isArray(l.teams) || l.teams.length === 0) return;
            _leagueData.push({ teams: l.teams, divisions: Array.isArray(l.divisions) ? l.divisions : [] });
            l.teams.forEach(t => allTeams.add(t));
        };
        Object.values(global?.leaguesByName || {}).forEach(addLeague);
        Object.values(global?.specialtyLeagues || {}).forEach(addLeague);
        leagueTeams = Array.from(allTeams).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        
        // Expand all divisions by default
        Object.keys(structure).forEach(d => expandedDivisions.add(d));
        
        console.log('[Me] Loaded', Object.keys(structure).length, 'divisions,', Object.keys(camperRoster).length, 'campers');
    }

    function migrateOldStructure(oldDivisions) {
        const newStructure = {};
        Object.entries(oldDivisions).forEach(([divName, divData]) => {
            if (isUnsafeName(divName)) return;
            if (!divData || typeof divData !== 'object') return; // ★ v7.0: guard null/corrupt entries
            const bunks = (divData.bunks || []).map(b => typeof b === 'string' ? b : b.name);
            newStructure[divName] = {
                color: sanitizeColor(divData.color) || COLOR_PRESETS[Object.keys(newStructure).length % COLOR_PRESETS.length],
                grades: bunks.length > 0 ? { 'Default': { bunks } } : {}
            };
        });
        return newStructure;
    }

    // =========================================================================
    // ★ SAVE DATA (localStorage + cloud)
    // =========================================================================

    function saveData() {
        try {
            setSyncStatus('syncing');
            
            // Build the full settings object
            const global = readLocalSettings();
            global.campStructure = structure;
            if (!global.app1) global.app1 = {};
            global.app1.camperRoster = camperRoster;
            global.app1.divisions = convertToOldFormat(structure);
            global.updated_at = new Date().toISOString();
            
            // ★ Save to localStorage immediately (both keys for cross-page compat)
            writeLocalSettings(global);
            
            // ★ Only use ONE cloud save path to prevent race conditions
            if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
                // integration_hooks.js is loaded — let IT handle cloud sync
                window.saveGlobalSettings('campStructure', structure);
                window.saveGlobalSettings('app1', global.app1);
            } else {
                // ★ Direct cloud sync (debounced) — standalone Me page
                scheduleCloudSave({
                    campStructure: structure,
                    app1: global.app1,
                    updated_at: global.updated_at
                });
            }
            
        } catch (e) { 
            console.error('[Me] Save error:', e);
            setSyncStatus('error'); 
        }
    }

    function convertToOldFormat(struct) {
        const oldFormat = {};
        Object.entries(struct).forEach(([divName, divData]) => {
            const allBunks = [];
            Object.values(divData.grades || {}).forEach(g => (g.bunks || []).forEach(b => allBunks.push(b)));
            oldFormat[divName] = { color: sanitizeColor(divData.color), bunks: allBunks };
        });
        return oldFormat;
    }

    // =========================================================================
    // ★ v7.0: GRADE-FILTERED LEAGUE TEAMS
    // Matches league.divisions[] against camper's division + grade using
    // smart matching (handles "1st grade", "Grade 1", "1", "1st", etc.)
    // =========================================================================

    function _extractGradeNumber(str) {
        if (!str) return null;
        const s = String(str).toLowerCase().trim();
        // "1st grade", "2nd", "3rd", "4th", "11th"
        const ordinal = s.match(/^(\d+)(st|nd|rd|th)?\s*(grade)?$/);
        if (ordinal) return parseInt(ordinal[1], 10);
        // "grade 1", "grade 11"
        const gradeN = s.match(/^grade\s*(\d+)$/);
        if (gradeN) return parseInt(gradeN[1], 10);
        // bare number "1", "11"
        const bare = s.match(/^(\d+)$/);
        if (bare) return parseInt(bare[1], 10);
        return null;
    }

    function _divisionMatches(leagueDiv, campValue) {
        if (!leagueDiv || !campValue) return false;
        const a = String(leagueDiv).toLowerCase().trim();
        const b = String(campValue).toLowerCase().trim();
        // Exact match
        if (a === b) return true;
        // Numeric grade match (prevents "1" matching "11")
        const numA = _extractGradeNumber(leagueDiv);
        const numB = _extractGradeNumber(campValue);
        if (numA !== null && numB !== null) return numA === numB;
        // Substring with word boundaries (for non-numeric like "Junior Boys")
        if (numA === null && numB === null) return a.includes(b) || b.includes(a);
        return false;
    }

    /** Get teams from leagues whose divisions match the given division OR grade */
    function getTeamsForContext(divName, gradeName) {
        if (!divName && !gradeName) return leagueTeams; // No context → show all
        const matched = new Set();
        _leagueData.forEach(ld => {
            if (ld.divisions.length === 0) {
                // League has no division filter → include its teams for everyone
                ld.teams.forEach(t => matched.add(t));
                return;
            }
            const divMatch = divName && ld.divisions.some(d => _divisionMatches(d, divName));
            const gradeMatch = gradeName && ld.divisions.some(d => _divisionMatches(d, gradeName));
            if (divMatch || gradeMatch) ld.teams.forEach(t => matched.add(t));
        });
        // If no leagues matched, fall back to all teams (don't leave dropdown empty)
        if (matched.size === 0) return leagueTeams;
        return Array.from(matched).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    // =========================================================================
    // SYNC STATUS UI
    // =========================================================================

    function setSyncStatus(status) {
        const dot = document.getElementById('syncDot');
        const text = document.getElementById('syncText');
        if (status === 'syncing') { dot?.classList.add('syncing'); if(text) text.textContent = 'Syncing...'; }
        else if (status === 'synced') { dot?.classList.remove('syncing'); if(dot) dot.style.background = '#059669'; if(text) text.textContent = 'Synced'; }
        else { dot?.classList.remove('syncing'); if(dot) dot.style.background = '#ef4444'; if(text) text.textContent = 'Error'; }
    }

    // =========================================================================
    // RENDER
    // =========================================================================

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

    // =========================================================================
    // ★ RENDER HIERARCHY — jsEsc for onclick, edit buttons added
    // =========================================================================

    // ★ Generate safe DOM element IDs from arbitrary names
    let _slugCounter = 0;
    const _slugMap = new Map();
    function slugId(name) {
        if (_slugMap.has(name)) return _slugMap.get(name);
        const slug = 'sid' + (++_slugCounter);
        _slugMap.set(name, slug);
        return slug;
    }

    function renderHierarchy() {
        const container = document.getElementById('hierarchyContainer');
        const empty = document.getElementById('structureEmptyState');
        if (!container) return;

        // ★ v7.0: Reset slug map each render to prevent unbounded growth after renames/deletes
        _slugMap.clear();
        _slugCounter = 0;

        const divNames = Object.keys(structure).sort();
        if (divNames.length === 0) { container.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
        if (empty) empty.style.display = 'none';

        // ★ Pre-compute camper counts per division (O(n) once instead of O(n) per div)
        const camperCountMap = {};
        Object.values(camperRoster).forEach(c => {
            if (c.division) camperCountMap[c.division] = (camperCountMap[c.division] || 0) + 1;
        });

        container.innerHTML = divNames.map(divName => {
            const div = structure[divName];
            if (!div || typeof div !== 'object') return ''; // ★ guard corrupted data
            const isExpanded = expandedDivisions.has(divName);
            const grades = div.grades || {};
            const gradeNames = Object.keys(grades).sort();
            const camperCount = camperCountMap[divName] || 0;
            const divColor = sanitizeColor(div.color);

            const escDiv = esc(divName);
            const jsDiv = jsEsc(divName);
            const divSlug = slugId(divName);

            // === Grades HTML ===
            const gradesHtml = gradeNames.map(gradeName => {
                const gradeKey = divName + '||' + gradeName;
                const isGradeExpanded = expandedGrades.has(gradeKey);
                const bunks = (grades[gradeName] && grades[gradeName].bunks) || [];
                const escGrade = esc(gradeName);
                const jsGrade = jsEsc(gradeName);
                const gradeSlug = slugId(divName + '||' + gradeName);

                const bunksHtml = bunks.map(b => {
                    const escB = esc(b);
                    const jsB = jsEsc(b);
                    return '<span class="bunk-chip">' + escB +
                        '<button class="icon-btn" onclick="event.stopPropagation(); CampistryMe.editBunk(\'' + jsDiv + '\',\'' + jsGrade + '\',\'' + jsB + '\')" title="Rename bunk" aria-label="Rename ' + escB + '">' +
                        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
                        '</button>' +
                        '<button class="icon-btn danger" onclick="event.stopPropagation(); CampistryMe.deleteBunk(\'' + jsDiv + '\',\'' + jsGrade + '\',\'' + jsB + '\')" aria-label="Delete ' + escB + '">' +
                        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
                        '</button></span>';
                }).join('');

                // ★ Use slug-based IDs instead of esc() names
                const addBunkHtml = '<div class="quick-add">' +
                    '<input type="text" placeholder="+ Bunk" maxlength="' + MAX_NAME_LENGTH + '" id="addBunk_' + gradeSlug + '" onkeypress="if(event.key===\'Enter\'){CampistryMe.addBunkInline(\'' + jsDiv + '\',\'' + jsGrade + '\');event.preventDefault();}">' +
                    '<button class="quick-add-btn" onclick="CampistryMe.addBunkInline(\'' + jsDiv + '\',\'' + jsGrade + '\')" aria-label="Add bunk">' +
                    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                    '</button></div>';

                return '<div class="grade-block">' +
                    '<div class="grade-header" onclick="CampistryMe.toggleGrade(\'' + jsDiv + '\',\'' + jsGrade + '\')">' +
                        '<div class="grade-left">' +
                            '<svg class="expand-icon ' + (isGradeExpanded ? '' : 'collapsed') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>' +
                            '<span class="grade-info">' + escGrade + '</span>' +
                            '<span class="grade-count">' + bunks.length + ' bunk' + (bunks.length !== 1 ? 's' : '') + '</span>' +
                        '</div>' +
                        '<div class="grade-actions" onclick="event.stopPropagation()">' +
                            '<button class="icon-btn" onclick="CampistryMe.editGrade(\'' + jsDiv + '\',\'' + jsGrade + '\')" title="Rename grade" aria-label="Rename ' + escGrade + '">' +
                            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
                            '</button>' +
                            '<button class="icon-btn danger" onclick="CampistryMe.deleteGrade(\'' + jsDiv + '\',\'' + jsGrade + '\')" aria-label="Delete ' + escGrade + '">' +
                            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                            '</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="grade-body ' + (isGradeExpanded ? '' : 'collapsed') + '">' +
                        '<div class="bunks-list">' + bunksHtml + addBunkHtml + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');

            // === Add Grade — slug-based ID ===
            const addGradeHtml = '<div class="add-grade-inline"><div class="quick-add">' +
                '<input type="text" placeholder="+ Add grade" maxlength="' + MAX_NAME_LENGTH + '" id="addGrade_' + divSlug + '" onkeypress="if(event.key===\'Enter\'){CampistryMe.addGradeInline(\'' + jsDiv + '\');event.preventDefault();}">' +
                '<button class="quick-add-btn" onclick="CampistryMe.addGradeInline(\'' + jsDiv + '\')" aria-label="Add grade">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                '</button></div></div>';

            // === Division block ===
            return '<div class="division-block">' +
                '<div class="division-header ' + (isExpanded ? '' : 'collapsed') + '" onclick="CampistryMe.toggleDivision(\'' + jsDiv + '\')">' +
                    '<div class="division-left">' +
                        '<div class="division-color" style="background:' + divColor + '"></div>' +
                        '<div class="division-info">' +
                            '<h3>' + escDiv + '</h3>' +
                            '<div class="division-meta">' + gradeNames.length + ' grade' + (gradeNames.length !== 1 ? 's' : '') + ' · ' + camperCount + ' camper' + (camperCount !== 1 ? 's' : '') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="division-actions" onclick="event.stopPropagation()">' +
                        '<button class="icon-btn" onclick="CampistryMe.editDivision(\'' + jsDiv + '\')" title="Edit division" aria-label="Edit ' + escDiv + '">' +
                        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
                        '</button>' +
                        '<button class="icon-btn danger" onclick="CampistryMe.deleteDivision(\'' + jsDiv + '\')" title="Delete division" aria-label="Delete ' + escDiv + '">' +
                        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                        '</button>' +
                        '<svg class="expand-icon ' + (isExpanded ? '' : 'collapsed') + '" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>' +
                    '</div>' +
                '</div>' +
                '<div class="division-body ' + (isExpanded ? '' : 'collapsed') + '">' +
                    '<div class="grades-section">' +
                        '<div class="grades-list">' + gradesHtml + '</div>' +
                        addGradeHtml +
                    '</div>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    // =========================================================================
    // STRUCTURE OPERATIONS
    // =========================================================================

    function addGradeInline(divName) {
        const input = document.getElementById('addGrade_' + slugId(divName));
        const name = (input?.value || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!name || !structure[divName]) return;
        if (isUnsafeName(name)) { toast('That name is reserved', 'error'); return; }
        if (!structure[divName].grades) structure[divName].grades = {};
        if (structure[divName].grades[name]) { toast('Grade exists', 'error'); return; }
        structure[divName].grades[name] = { bunks: [] };
        expandedGrades.add(divName + '||' + name);
        input.value = '';
        saveData(); renderHierarchy(); updateStats(); toast('Grade added');
        setTimeout(() => document.getElementById('addBunk_' + slugId(divName + '||' + name))?.focus(), 50);
    }

    function addBunkInline(divName, gradeName) {
        const input = document.getElementById('addBunk_' + slugId(divName + '||' + gradeName));
        const name = (input?.value || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!name) return;
        if (isUnsafeName(name)) { toast('That name is reserved', 'error'); return; } // ★ v7.0: was missing
        const gradeData = structure[divName]?.grades?.[gradeName];
        if (!gradeData) return;
        if (!gradeData.bunks) gradeData.bunks = [];
        if (gradeData.bunks.includes(name)) { toast('Bunk exists', 'error'); return; }
        gradeData.bunks.push(name);
        input.value = '';
        saveData(); renderHierarchy(); updateStats(); toast('Bunk added');
        setTimeout(() => document.getElementById('addBunk_' + slugId(divName + '||' + gradeName))?.focus(), 50);
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
        const isEdit = !!editName;
        document.getElementById('divisionModalTitle').textContent = isEdit ? 'Edit Division' : 'Add Division';
        
        // Only show color picker when editing
        const colorGroup = document.getElementById('colorPickerGroup');
        if (colorGroup) {
            colorGroup.style.display = isEdit ? 'block' : 'none';
        }
        
        if (isEdit && structure[editName]) {
            document.getElementById('divisionName').value = editName;
            document.getElementById('divisionColor').value = structure[editName].color || COLOR_PRESETS[0];
            setupColorPresets();
            updateColorPresetSelection(structure[editName].color || COLOR_PRESETS[0]);
        } else {
            document.getElementById('divisionName').value = '';
        }
        openModal('divisionModal');
        setTimeout(() => document.getElementById('divisionName').focus(), 50);
    }

    function getNextUniqueColor() {
        const usedColors = new Set(Object.values(structure).map(d => d.color).filter(Boolean));
        for (let i = 0; i < COLOR_PRESETS.length; i++) {
            if (!usedColors.has(COLOR_PRESETS[i])) return COLOR_PRESETS[i];
        }
        return COLOR_PRESETS[Object.keys(structure).length % COLOR_PRESETS.length];
    }

    function saveDivision() {
        const name = document.getElementById('divisionName').value.trim().slice(0, MAX_NAME_LENGTH);
        if (!name) { toast('Enter a name', 'error'); return; }
        if (isUnsafeName(name)) { toast('That name is reserved', 'error'); return; }
        
        if (currentEditDivision && currentEditDivision !== name) {
            // Renaming existing division — block if target name already exists
            if (structure[name]) { toast('Division "' + name + '" already exists', 'error'); return; }
            const color = sanitizeColor(document.getElementById('divisionColor').value);
            structure[name] = { ...structure[currentEditDivision], color };
            delete structure[currentEditDivision];
            Object.values(camperRoster).forEach(c => { if (c.division === currentEditDivision) c.division = name; });
            expandedDivisions.delete(currentEditDivision); expandedDivisions.add(name);
            // ★ v7.0: Migrate expandedGrades keys so grades stay expanded after div rename
            const staleKeys = [...expandedGrades].filter(k => k.startsWith(currentEditDivision + '||'));
            staleKeys.forEach(k => {
                expandedGrades.delete(k);
                expandedGrades.add(name + k.slice(currentEditDivision.length));
            });
        } else if (currentEditDivision) {
            // Editing existing division (same name)
            structure[currentEditDivision].color = sanitizeColor(document.getElementById('divisionColor').value);
        } else {
            // Adding new division - auto-assign color
            if (structure[name]) { toast('Division exists', 'error'); return; }
            structure[name] = { color: getNextUniqueColor(), grades: {} };
            expandedDivisions.add(name);
        }
        saveData(); closeModal('divisionModal'); renderAll();
        toast(currentEditDivision ? 'Division updated' : 'Division added');
    }

    function deleteDivision(name) {
        if (!structure[name]) return;
        if (!confirm('Delete "' + name + '" and all grades/bunks?')) return;
        delete structure[name];
        expandedDivisions.delete(name);
        // ★ v7.0: Clean stale expandedGrades entries for this division
        [...expandedGrades].filter(k => k.startsWith(name + '||')).forEach(k => expandedGrades.delete(k));
        Object.values(camperRoster).forEach(c => { if (c.division === name) { c.division = ''; c.grade = ''; c.bunk = ''; } });
        saveData(); renderAll(); toast('Division deleted');
    }

    function deleteGrade(divName, gradeName) {
        if (!structure[divName]?.grades?.[gradeName]) return;
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

    // =========================================================================
    // ★ EDIT GRADE & BUNK (NEW — were missing entirely)
    // =========================================================================

    function editGrade(divName, oldGradeName) {
        if (!structure[divName]?.grades?.[oldGradeName]) { toast('Grade not found', 'error'); return; }
        const newName = prompt('Rename grade "' + oldGradeName + '":', oldGradeName);
        if (!newName || newName.trim() === '' || newName.trim() === oldGradeName) return;
        const trimmed = newName.trim().slice(0, MAX_NAME_LENGTH);
        if (isUnsafeName(trimmed)) { toast('That name is reserved', 'error'); return; }
        if (structure[divName]?.grades?.[trimmed]) { toast('Grade "' + trimmed + '" already exists', 'error'); return; }
        // Move grade data to new key
        const gradeData = structure[divName].grades[oldGradeName];
        structure[divName].grades[trimmed] = gradeData;
        delete structure[divName].grades[oldGradeName];
        // Update expand state
        const oldKey = divName + '||' + oldGradeName;
        const newKey = divName + '||' + trimmed;
        if (expandedGrades.has(oldKey)) { expandedGrades.delete(oldKey); expandedGrades.add(newKey); }
        // Update camper references
        Object.values(camperRoster).forEach(c => { if (c.division === divName && c.grade === oldGradeName) c.grade = trimmed; });
        saveData(); renderAll(); toast('Grade renamed');
    }

    function editBunk(divName, gradeName, oldBunkName) {
        const gradeData = structure[divName]?.grades?.[gradeName];
        if (!gradeData || !(gradeData.bunks || []).includes(oldBunkName)) { toast('Bunk not found', 'error'); return; }
        const newName = prompt('Rename bunk "' + oldBunkName + '":', oldBunkName);
        if (!newName || newName.trim() === '' || newName.trim() === oldBunkName) return;
        const trimmed = newName.trim().slice(0, MAX_NAME_LENGTH);
        if (isUnsafeName(trimmed)) { toast('That name is reserved', 'error'); return; }
        if ((gradeData.bunks || []).includes(trimmed)) { toast('Bunk "' + trimmed + '" already exists', 'error'); return; }
        // Rename in bunks array
        const idx = (gradeData.bunks || []).indexOf(oldBunkName);
        if (idx === -1) return;
        gradeData.bunks[idx] = trimmed;
        // Update camper references
        Object.values(camperRoster).forEach(c => { if (c.division === divName && c.grade === gradeName && c.bunk === oldBunkName) c.bunk = trimmed; });
        saveData(); renderHierarchy(); updateStats(); toast('Bunk renamed');
    }

    // =========================================================================
    // CAMPER TABLE — ★ jsEsc in onclick handlers
    // =========================================================================

    function renderCamperTable() {
        const tbody = document.getElementById('camperTableBody');
        const empty = document.getElementById('campersEmptyState');
        if (!tbody) return;

        // ★ Save QA dropdown state before rebuild
        const savedQA = {
            div: document.getElementById('qaDivision')?.value || '',
            grade: document.getElementById('qaGrade')?.value || '',
            bunk: document.getElementById('qaBunk')?.value || '',
            team: document.getElementById('qaTeam')?.value || ''
        };

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

        const divOptions = '<option value="">—</option>' + Object.keys(structure).sort().map(d => '<option value="' + esc(d) + '"' + (d === savedQA.div ? ' selected' : '') + '>' + esc(d) + '</option>').join('');
        // ★ v7.0: Filter teams by selected division+grade, sort numerically
        const qaFilteredTeams = getTeamsForContext(savedQA.div, savedQA.grade);
        const teamOptions = '<option value="">—</option>' + qaFilteredTeams.map(t => '<option value="' + esc(t) + '"' + (t === savedQA.team ? ' selected' : '') + '>' + esc(t) + '</option>').join('');

        let html = '<tr class="add-row"><td><input type="text" id="qaName" placeholder="Camper name" maxlength="' + MAX_NAME_LENGTH + '" onkeypress="if(event.key===\'Enter\'){CampistryMe.quickAddCamper();event.preventDefault();}"></td><td><select id="qaDivision" onchange="CampistryMe.updateQAGrades()">' + divOptions + '</select></td><td><select id="qaGrade" onchange="CampistryMe.updateQABunks()"><option value="">—</option></select></td><td><select id="qaBunk"><option value="">—</option></select></td><td><select id="qaTeam">' + teamOptions + '</select></td><td><button class="btn btn-primary btn-sm" onclick="CampistryMe.quickAddCamper()">Add</button></td></tr>';

        if (campers.length === 0 && total === 0) { tbody.innerHTML = html; if (empty) empty.style.display = 'block'; _restoreQAState(savedQA); return; }
        if (empty) empty.style.display = 'none';

        html += campers.map(c => '<tr><td><span class="clickable" onclick="CampistryMe.editCamper(\'' + jsEsc(c.name) + '\')">' + esc(c.name) + '</span></td><td>' + (esc(c.division) || '—') + '</td><td>' + (esc(c.grade) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (esc(c.team) || '—') + '</td><td><button class="icon-btn danger" onclick="CampistryMe.deleteCamper(\'' + jsEsc(c.name) + '\')" aria-label="Delete camper"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td></tr>').join('');
        tbody.innerHTML = html;

        // ★ Restore QA dropdown state after rebuild
        _restoreQAState(savedQA);
    }

    // ★ Restore QA grade/bunk cascading selects after table rebuild
    function _restoreQAState(saved) {
        if (!saved.div) return;
        const divSel = document.getElementById('qaDivision');
        if (divSel) divSel.value = saved.div;
        // Rebuild grade options
        const gradeSelect = document.getElementById('qaGrade');
        const bunkSelect = document.getElementById('qaBunk');
        if (gradeSelect && saved.div && structure[saved.div]) {
            gradeSelect.innerHTML = '<option value="">—</option>';
            Object.keys(structure[saved.div].grades || {}).sort().forEach(g => {
                gradeSelect.innerHTML += '<option value="' + esc(g) + '"' + (g === saved.grade ? ' selected' : '') + '>' + esc(g) + '</option>';
            });
        }
        if (bunkSelect && saved.div && saved.grade && structure[saved.div]?.grades?.[saved.grade]) {
            bunkSelect.innerHTML = '<option value="">—</option>';
            (structure[saved.div].grades[saved.grade].bunks || []).forEach(b => {
                bunkSelect.innerHTML += '<option value="' + esc(b) + '"' + (b === saved.bunk ? ' selected' : '') + '>' + esc(b) + '</option>';
            });
        }
    }

    // =========================================================================
    // CAMPER OPERATIONS
    // =========================================================================

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
        // ★ v7.0: Division change also filters available teams
        updateQATeams();
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
        // ★ v7.0: Also refresh teams when grade changes (teams are grade-filtered)
        updateQATeams();
    }

    function updateQATeams() {
        const divName = document.getElementById('qaDivision')?.value || '';
        const gradeName = document.getElementById('qaGrade')?.value || '';
        const teamSelect = document.getElementById('qaTeam');
        if (!teamSelect) return;
        const currentTeam = teamSelect.value;
        const filtered = getTeamsForContext(divName, gradeName);
        teamSelect.innerHTML = '<option value="">—</option>';
        filtered.forEach(t => {
            teamSelect.innerHTML += '<option value="' + esc(t) + '"' + (t === currentTeam ? ' selected' : '') + '>' + esc(t) + '</option>';
        });
    }

    function quickAddCamper() {
        const nameInput = document.getElementById('qaName');
        const name = (nameInput?.value || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!name) { toast('Enter a name', 'error'); nameInput?.focus(); return; }
        if (isUnsafeName(name)) { toast('That name is reserved', 'error'); return; }
        if (camperRoster[name]) { toast('Camper exists', 'error'); return; }
        camperRoster[name] = {
            division: document.getElementById('qaDivision')?.value || '',
            grade: document.getElementById('qaGrade')?.value || '',
            bunk: document.getElementById('qaBunk')?.value || '',
            team: document.getElementById('qaTeam')?.value || ''
        };
        saveData(); renderCamperTable(); updateStats();
        // ★ v7.0: Re-acquire input AFTER render (old element is destroyed by innerHTML)
        document.getElementById('qaName')?.focus();
        toast('Camper added');
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
        // ★ v7.0: Filter teams by camper's division+grade
        const editFilteredTeams = getTeamsForContext(c.division, c.grade);
        teamSelect.innerHTML = '<option value="">—</option>' + editFilteredTeams.map(t => '<option value="' + esc(t) + '"' + (t === c.team ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
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

    // ★ v7.0: Refresh edit modal team dropdown when division/grade changes
    function updateEditTeams(divName, gradeName, selectedTeam) {
        const teamSelect = document.getElementById('editCamperTeam');
        if (!teamSelect) return;
        const filtered = getTeamsForContext(divName, gradeName);
        teamSelect.innerHTML = '<option value="">—</option>';
        filtered.forEach(t => {
            teamSelect.innerHTML += '<option value="' + esc(t) + '"' + (t === selectedTeam ? ' selected' : '') + '>' + esc(t) + '</option>';
        });
    }

    // ★ saveCamper now supports renaming campers
    function saveCamper() {
        if (!currentEditCamper || !camperRoster[currentEditCamper]) return;
        const newName = (document.getElementById('editCamperName')?.value || '').trim().slice(0, MAX_NAME_LENGTH);
        if (!newName) { toast('Name cannot be empty', 'error'); return; }
        if (isUnsafeName(newName)) { toast('That name is reserved', 'error'); return; }
        
        const data = {
            division: document.getElementById('editCamperDivision')?.value || '',
            grade: document.getElementById('editCamperGrade')?.value || '',
            bunk: document.getElementById('editCamperBunk')?.value || '',
            team: document.getElementById('editCamperTeam')?.value || ''
        };
        
        // Handle rename: if name changed, delete old key and create new
        if (newName !== currentEditCamper) {
            if (camperRoster[newName]) { toast('Camper "' + newName + '" already exists', 'error'); return; }
            delete camperRoster[currentEditCamper];
        }
        camperRoster[newName] = data;
        
        saveData(); closeModal('camperModal'); renderAll(); toast('Camper updated'); // ★ v7.0: renderAll not just table
    }

    function deleteCamper(name) {
        if (!camperRoster[name]) return; // ★ null guard for stale onclick
        if (!confirm('Delete "' + name + '"?')) return;
        delete camperRoster[name];
        saveData(); renderAll(); toast('Camper deleted');
    }

    function clearAllCampers() {
        const count = Object.keys(camperRoster).length;
        if (!count) { toast('No campers', 'error'); return; }
        if (!confirm('Delete all ' + count + ' campers? This cannot be undone.')) return;
        camperRoster = {};
        saveData(); renderAll(); toast('All campers cleared');
        // ★ Warn if cloud sync might not persist this destructive action
        if (!navigator.onLine) {
            toast('You are offline — clear may not persist to cloud', 'error');
        }
    }

    // =========================================================================
    // CSV IMPORT / EXPORT
    // =========================================================================

    function downloadTemplate() {
        // ★ v7.0: BOM prefix matches exportCsv for consistent Excel behavior
        const csv = '\uFEFFName,Division,Grade,Bunk,Team\nJohn Smith,Junior Boys,5th Grade,Bunk 1,Red Team\nJane Doe,Junior Girls,6th Grade,Bunk 2,Blue Team\nMike Johnson,Senior Boys,7th Grade,Bunk 3,Green Team';
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = 'camper_import_template.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        // ★ Cap file size to prevent browser freeze
        if (file.size > MAX_CSV_FILE_SIZE) {
            toast('File too large (max ' + Math.round(MAX_CSV_FILE_SIZE / 1024 / 1024) + 'MB)', 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = e => parseCsv(e.target.result);
        reader.readAsText(file);
    }

    function parseCsv(text) {
        // ★ Strip BOM from Excel-exported UTF-8 CSV
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (!lines.length) { toast('CSV is empty', 'error'); return; }
        const first = lines[0].toLowerCase();
        const hasHeader = first.includes('name') || first.includes('division');
        const start = hasHeader ? 1 : 0;
        pendingCsvData = [];
        // ★ Cap rows to prevent browser hang
        const maxRow = Math.min(lines.length, start + MAX_CSV_ROWS);
        for (let i = start; i < maxRow; i++) {
            const cols = parseCsvLine(lines[i]);
            const name = (cols[0] || '').trim().slice(0, MAX_NAME_LENGTH);
            if (!name) continue;
            pendingCsvData.push({
                name,
                division: (cols[1]||'').trim().slice(0, MAX_NAME_LENGTH),
                grade: (cols[2]||'').trim().slice(0, MAX_NAME_LENGTH),
                bunk: (cols[3]||'').trim().slice(0, MAX_NAME_LENGTH),
                team: (cols[4]||'').trim().slice(0, MAX_NAME_LENGTH)
            });
        }
        if (lines.length > maxRow) {
            toast('Capped at ' + MAX_CSV_ROWS + ' rows (file has ' + (lines.length - start) + ')', 'error');
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
        // ★ Unescape "" → " for RFC 4180 round-trip compatibility
        return result.map(s => s.replace(/""/g, '"'));
    }

    function importCsv() {
        if (!pendingCsvData.length) return;
        let added = 0, updated = 0, skipped = 0;
        let divsCreated = 0, gradesCreated = 0, bunksCreated = 0;

        // ★ Auto-create structure from CSV data
        const existingDivCount = Object.keys(structure).length;
        pendingCsvData.forEach(r => {
            const divName = r.division;
            const gradeName = r.grade;
            const bunkName = r.bunk;

            // ★ Block unsafe names from CSV import
            if (isUnsafeName(r.name) || isUnsafeName(divName) || isUnsafeName(gradeName) || isUnsafeName(bunkName)) {
                skipped++;
                return;
            }

            // Create division if it has a name and doesn't exist
            if (divName && !structure[divName]) {
                const colorIdx = (existingDivCount + divsCreated) % COLOR_PRESETS.length;
                structure[divName] = { color: COLOR_PRESETS[colorIdx], grades: {} };
                expandedDivisions.add(divName);
                divsCreated++;
            }

            // Create grade under division if both specified
            if (divName && gradeName && structure[divName]) {
                if (!structure[divName].grades) structure[divName].grades = {};
                if (!structure[divName].grades[gradeName]) {
                    structure[divName].grades[gradeName] = { bunks: [] };
                    expandedGrades.add(divName + '||' + gradeName);
                    gradesCreated++;
                }
            }

            // Create bunk under grade if all three specified
            if (divName && gradeName && bunkName && structure[divName]?.grades?.[gradeName]) {
                const bunks = structure[divName].grades[gradeName].bunks;
                if (!bunks.includes(bunkName)) {
                    bunks.push(bunkName);
                    bunksCreated++;
                }
            }

            // Add camper to roster
            if (camperRoster[r.name]) updated++; else added++;
            camperRoster[r.name] = { division: r.division, grade: r.grade, bunk: r.bunk, team: r.team };
        });

        saveData(); closeModal('csvModal'); renderAll();

        // Build summary toast
        const parts = [];
        if (added) parts.push(added + ' camper' + (added !== 1 ? 's' : '') + ' added');
        if (updated) parts.push(updated + ' updated');
        if (skipped) parts.push(skipped + ' skipped (reserved names)');
        if (divsCreated) parts.push(divsCreated + ' division' + (divsCreated !== 1 ? 's' : '') + ' created');
        if (gradesCreated) parts.push(gradesCreated + ' grade' + (gradesCreated !== 1 ? 's' : '') + ' created');
        if (bunksCreated) parts.push(bunksCreated + ' bunk' + (bunksCreated !== 1 ? 's' : '') + ' created');
        toast(parts.join(', ') || 'Import complete');
    }

    function exportCsv() {
        const entries = Object.entries(camperRoster);
        if (!entries.length) { toast('No campers', 'error'); return; }
        // ★ UTF-8 BOM prefix for Excel compatibility with non-ASCII names
        let csv = '\uFEFFName,Division,Grade,Bunk,Team\n';
        const csvField = (v) => '"' + String(v || '').replace(/"/g, '""') + '"';
        entries.forEach(([name, d]) => csv += csvField(name) + ',' + csvField(d.division) + ',' + csvField(d.grade) + ',' + csvField(d.bunk) + ',' + csvField(d.team) + '\n');
        const a = document.createElement('a');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.href = url;
        a.download = 'campers_' + new Date().toISOString().split('T')[0] + '.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('Exported ' + entries.length + ' campers');
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    function setupTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                document.getElementById('tab-' + btn.dataset.tab)?.classList.add('active');
            };
        });
    }

    function openModal(id) { document.getElementById(id)?.classList.add('active'); }
    function closeModal(id) { document.getElementById(id)?.classList.remove('active'); }

    function setupColorPresets() {
        const container = document.getElementById('colorPresets');
        if (!container) {
            console.warn('[Me] colorPresets container not found');
            return;
        }
        // Use divs instead of buttons to avoid browser button sizing issues
        container.innerHTML = COLOR_PRESETS.map(c => {
            const sc = sanitizeColor(c);
            return `<div class="color-preset" style="background:${sc}" data-color="${sc}" onclick="event.stopPropagation(); CampistryMe.selectColorPreset('${sc}')"></div>`;
        }).join('');
        console.log('[Me] Color presets initialized:', COLOR_PRESETS.length);
    }

    function selectColorPreset(color) { 
        console.log('[Me] Color preset selected:', color);
        document.getElementById('divisionColor').value = color; 
        updateColorPresetSelection(color); 
    }
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
        on('clearAllBtn', 'onclick', clearAllCampers);
        on('saveEditCamperBtn', 'onclick', saveCamper);
        on('editCamperDivision', 'onchange', e => { updateEditGrades(e.target.value, ''); updateEditBunks(e.target.value, '', ''); updateEditTeams(e.target.value, '', document.getElementById('editCamperTeam')?.value || ''); });
        on('editCamperGrade', 'onchange', e => { const div = document.getElementById('editCamperDivision')?.value || ''; updateEditBunks(div, e.target.value, ''); updateEditTeams(div, e.target.value, document.getElementById('editCamperTeam')?.value || ''); });

        // ★ Enter key in camper edit modal triggers save
        on('editCamperName', 'onkeypress', e => { if (e.key === 'Enter') saveCamper(); });

        // ★ Debounce search input for performance with large rosters
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.oninput = () => {
                if (_searchDebounceTimeout) clearTimeout(_searchDebounceTimeout);
                _searchDebounceTimeout = setTimeout(renderCamperTable, 150);
            };
        }

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
            // ★ v7.0: Keyboard accessibility — Enter/Space triggers file picker
            dropzone.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
            dropzone.ondragover = e => { e.preventDefault(); dropzone.classList.add('dragover'); };
            dropzone.ondragleave = () => dropzone.classList.remove('dragover');
            dropzone.ondrop = e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleCsvFile(e.dataTransfer.files[0]); };
            fileInput.onchange = e => handleCsvFile(e.target.files[0]);
        }

        // Modal close handlers - only close when clicking dark backdrop
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('mousedown', e => {
                // Only close if clicking directly on the overlay (dark backdrop)
                if (e.target === overlay) {
                    e.preventDefault();
                    closeModal(overlay.id);
                }
            });
        });
        
        // Prevent all clicks inside modal from doing anything unexpected
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('mousedown', e => e.stopPropagation());
            modal.addEventListener('click', e => e.stopPropagation());
        });

        // ★ Escape key closes any open modal
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(overlay => {
                    closeModal(overlay.id);
                });
            }
        });

        // ★ v7.0: Flush pending cloud save on page unload.
        // sendBeacon can't set Supabase auth headers, so we rely on:
        //   (a) localStorage already being saved during saveData(), and
        //   (b) cloud catching up on next page load via loadAllData's merge logic.
        // This handler ensures the debounce timer is cancelled and state is consistent.
        window.addEventListener('beforeunload', () => {
            if (_pendingMergeData && _cloudSaveTimeout) {
                clearTimeout(_cloudSaveTimeout);
                // Synchronous localStorage write as safety net (saveData already wrote, but
                // in case someone called scheduleCloudSave without saveData)
                try {
                    const global = readLocalSettings();
                    if (_pendingMergeData.campStructure) global.campStructure = _pendingMergeData.campStructure;
                    if (_pendingMergeData.app1) {
                        if (!global.app1) global.app1 = {};
                        if (_pendingMergeData.app1.camperRoster) global.app1.camperRoster = _pendingMergeData.app1.camperRoster;
                        if (_pendingMergeData.app1.divisions) global.app1.divisions = _pendingMergeData.app1.divisions;
                    }
                    global.updated_at = new Date().toISOString();
                    writeLocalSettings(global);
                } catch (_) { /* best effort */ }
                _pendingMergeData = null;
                console.log('[Me] beforeunload: flushed pending data to localStorage');
            }
        });

        // ★ v7.0: Retry cloud save when coming back online
        window.addEventListener('online', () => {
            console.log('[Me] Back online — retrying cloud save');
            setSyncStatus('syncing');
            saveData();
        });

        // ★ v7.0 FIX #5/#6: Throttled visibility refresh, skips when pending edits exist
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible') return;

            // Skip if there are unsaved local edits (don't overwrite with older cloud data)
            if (_pendingMergeData) {
                console.log('[Me] Tab visible but pending edits exist — skipping cloud refresh');
                return;
            }

            // Throttle: minimum CLOUD_FETCH_COOLDOWN_MS between fetches
            const now = Date.now();
            if (now - _lastCloudFetchTime < CLOUD_FETCH_COOLDOWN_MS) return;
            _lastCloudFetchTime = now;

            try {
                const cloud = await loadFromCloud();
                if (cloud) {
                    const cloudTime = new Date(cloud.updated_at || 0).getTime();
                    const local = readLocalSettings();
                    const localTime = new Date(local.updated_at || 0).getTime();
                    if (cloudTime > localTime) {
                        camperRoster = cloud.app1?.camperRoster || camperRoster;
                        structure = cloud.campStructure || structure;
                        writeLocalSettings(cloud);
                        renderAll();
                        console.log('[Me] Refreshed from cloud on tab focus');
                    }
                }
            } catch (e) {
                console.warn('[Me] Tab visibility refresh failed:', e);
            }
        });
    }

    function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;') : ''; }

    // ★ JS-safe escaping for onclick attributes (backslash-escapes quotes instead of HTML entities)
    function jsEsc(s) { return s ? String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n') : ''; }

    // ★ Sanitize color values to prevent CSS injection via crafted cloud/localStorage data
    function sanitizeColor(c) {
        if (!c || typeof c !== 'string') return COLOR_PRESETS[0];
        // Allow only valid hex colors
        if (/^#[0-9a-fA-F]{3,8}$/.test(c.trim())) return c.trim();
        // Allow only simple named colors (no semicolons, no quotes, no url())
        if (/^[a-zA-Z]{3,20}$/.test(c.trim())) return c.trim();
        return COLOR_PRESETS[0];
    }

    // ★ Block prototype pollution via dangerous object keys
    const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
    function isUnsafeName(name) { return UNSAFE_NAMES.has(name); }

    function toast(msg, type = 'success') {
        const t = document.getElementById('toast');
        if (!t) return;
        // ★ v7.0: Clear previous toast timeout so rapid toasts don't cancel each other
        if (_toastTimeout) clearTimeout(_toastTimeout);
        const icon = document.getElementById('toastIcon');
        if (icon) icon.innerHTML = type === 'error' ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>';
        document.getElementById('toastMessage').textContent = msg;
        t.className = 'toast ' + type + ' show';
        _toastTimeout = setTimeout(() => { t.classList.remove('show'); _toastTimeout = null; }, 3000);
    }

    // =========================================================================
    // PUBLIC API — ★ Added editGrade, editBunk
    // =========================================================================

    window.CampistryMe = {
        toggleDivision, toggleGrade, editDivision: openDivisionModal, deleteDivision,
        addGradeInline, editGrade, deleteGrade, addBunkInline, editBunk, deleteBunk,
        editCamper, deleteCamper, quickAddCamper,
        updateQAGrades, updateQABunks,
        selectColorPreset, closeModal
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 100);
})();
