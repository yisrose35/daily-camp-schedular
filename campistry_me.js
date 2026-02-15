// =============================================================================
// campistry_me.js — Campistry Me v7.1
// Professional UI, Cloud Sync, Fast inline inputs
// =============================================================================
// v7.1 — Critical cross-page compatibility fixes:
// ★ convertToOldFormat MERGES into existing app1.divisions instead of
//   overwriting — preserves Flow's start/stop/increments/lunchAfter data
// ★ Color picker always visible in division modal (was hidden on add)
// ★ Division color swatch in hierarchy is clickable to edit
// ★ All v7.0 fixes retained
// =============================================================================

(function() {
    'use strict';
    console.log('[Me] Campistry Me v7.1 loading...');

    let structure = {};
    let camperRoster = {};
    let leagueTeams = [];
    let _leagueData = [];
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
    // ★ CLOUD SYNC HELPERS (direct Supabase access)
    // =========================================================================

    function getSupabaseClient() {
        return window.CampistryDB?.getClient?.() || window.supabase || null;
    }

    let _cachedCampId = null;

    function getCampId() {
        // Return cached value if we have one (set during init/auth)
        if (_cachedCampId) return _cachedCampId;
        
        // Fallback chain
        return window.CampistryDB?.getCampId?.() || 
               localStorage.getItem('campistry_camp_id') || 
               localStorage.getItem('campistry_user_id') || 
               null;
    }

    // ★ v7.1: Async version that gets the proper UUID from Supabase session
    async function ensureCampId() {
        if (_cachedCampId) return _cachedCampId;
        try {
            const client = getSupabaseClient();
            if (client) {
                const { data } = await client.auth.getSession();
                if (data?.session?.user?.id) {
                    _cachedCampId = data.session.user.id;
                    return _cachedCampId;
                }
            }
        } catch (_) { /* fall through */ }
        return getCampId();
    }

    async function loadFromCloud() {
        const client = getSupabaseClient();
        const campId = await ensureCampId();
        if (!client || !campId) {
            console.log('[Me] No client/campId for cloud load');
            return null;
        }
        try {
            try {
                const { error: refreshErr } = await client.auth.getSession();
                if (refreshErr) console.warn('[Me] Session refresh warning:', refreshErr.message);
            } catch (_) {}

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
                    version: _cloudVersion
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
        const campId = await ensureCampId();
        if (!client || !campId) {
            console.log('[Me] No client/campId for cloud save');
            return false;
        }
        if (!navigator.onLine) {
            console.log('[Me] Offline - cloud save skipped');
            return false;
        }
        try {
            try {
                const { error: refreshErr } = await client.auth.getSession();
                if (refreshErr) console.warn('[Me] Session refresh warning:', refreshErr.message);
            } catch (_) {}

            const { data, error } = await client.rpc('merge_camp_state', {
                p_camp_id: campId,
                p_partial_state: mergeData,
                p_expected_version: _cloudVersion
            });

            if (error) {
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
                if (msg.includes('merge_camp_state')) {
                    return await saveToCloudLegacy(mergeData);
                }
                return false;
            }

            if (data && data.ok === false && data.error === 'version_conflict') {
                if (retryCount >= MAX_CLOUD_RETRIES) {
                    console.error('[Me] ☁️ Version conflict — max retries reached');
                    toast('Sync conflict — please reload', 'error');
                    return false;
                }
                console.warn('[Me] ☁️ Version conflict (retry', retryCount + 1, ')');
                const fresh = await loadFromCloud();
                if (fresh) {
                    return await saveToCloud(mergeData, retryCount + 1);
                }
                return false;
            }

            if (data?.version) {
                _cloudVersion = data.version;
            }

            console.log('[Me] ☁️ Cloud save complete (v' + (_cloudVersion || '?') + ')');
            return true;
        } catch (e) {
            console.error('[Me] Cloud save exception:', e);
            return false;
        }
    }

    async function saveToCloudLegacy(mergeData) {
        const client = getSupabaseClient();
        const campId = await ensureCampId();
        if (!client || !campId) return false;
        try {
            try { await client.auth.getSession(); } catch (_) {}

            const { data: current, error: fetchError } = await client
                .from('camp_state')
                .select('state')
                .eq('camp_id', campId)
                .single();

            if (fetchError && fetchError.code !== 'PGRST116') {
                console.warn('[Me] Cloud fetch error:', fetchError.message);
            }

            const currentState = current?.state || {};
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
        _pendingMergeData = mergeData;
        if (_cloudSaveTimeout) clearTimeout(_cloudSaveTimeout);
        _cloudSaveTimeout = setTimeout(async () => {
            _pendingMergeData = null;
            const success = await saveToCloud(mergeData);
            setSyncStatus(success ? 'synced' : 'error');
        }, CLOUD_SAVE_DEBOUNCE_MS);
    }

    // =========================================================================
    // ★ UNIFIED LOCAL STORAGE
    // =========================================================================

    function readLocalSettings() {
        try {
            const raw1 = localStorage.getItem('campGlobalSettings_v1');
            if (raw1) {
                const parsed = JSON.parse(raw1);
                if (Object.keys(parsed).length > 1) return parsed;
            }
        } catch (e) {}
        try {
            const raw2 = localStorage.getItem('campistryGlobalSettings');
            if (raw2) return JSON.parse(raw2);
        } catch (e) {}
        return {};
    }

    function writeLocalSettings(data) {
        const json = JSON.stringify(data);
        try {
            localStorage.setItem('campistryGlobalSettings', json);
            localStorage.setItem('campGlobalSettings_v1', json);
            localStorage.setItem('CAMPISTRY_LOCAL_CACHE', json);
        } catch (e) {
            console.error('[Me] localStorage write failed:', e.message);
            toast('Local storage full — data saved to cloud only', 'error');
        }
    }

    // =========================================================================
    // INIT / AUTH / LOAD
    // =========================================================================

    async function init() {
        const authed = await checkAuth();
        if (!authed) return;
        if (window.CampistryDB?.initialize) {
            try { await window.CampistryDB.initialize(); } 
            catch (e) { console.warn('[Me] CampistryDB init warning:', e); }
        }
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
            if (!session) { window.location.href = 'index.html'; return false; }
            // ★ v7.1: Cache the user UUID for cloud operations
            _cachedCampId = session.user.id;
            return true;
        } catch (e) { window.location.href = 'index.html'; return false; }
    }

    async function loadAllData() {
        if (window.CampistryDB?.ready) await window.CampistryDB.ready;

        let local = readLocalSettings();
        let cloud = null;
        try {
            cloud = await loadFromCloud();
        } catch (e) {
            console.warn('[Me] Cloud load failed, using local only:', e);
        }
        
        let global;
        const localHasData = Object.keys(local.campStructure || local.app1?.divisions || {}).length > 0 ||
                             Object.keys(local.app1?.camperRoster || {}).length > 0;
        const cloudHasData = cloud && (
            Object.keys(cloud.campStructure || cloud.app1?.divisions || {}).length > 0 ||
            Object.keys(cloud.app1?.camperRoster || {}).length > 0
        );

        if (cloudHasData && localHasData) {
            const cloudTime = new Date(cloud.updated_at || 0).getTime();
            const localTime = new Date(local.updated_at || 0).getTime();
            
            if (localTime > cloudTime) {
                const mergedApp1 = { ...(cloud.app1 || {}) };
                const localApp1 = local.app1 || {};
                mergedApp1.camperRoster = localApp1.camperRoster || mergedApp1.camperRoster;
                mergedApp1.divisions = localApp1.divisions || mergedApp1.divisions;
                global = { ...cloud, ...local, app1: mergedApp1 };
                console.log('[Me] Using local data (newer)');
                scheduleCloudSave({
                    campStructure: global.campStructure,
                    app1: global.app1,
                    updated_at: new Date().toISOString()
                });
            } else {
                global = cloud;
                console.log('[Me] Using cloud data (newer)');
                writeLocalSettings(cloud);
            }
        } else if (cloudHasData) {
            global = cloud;
            console.log('[Me] Using cloud data (local empty)');
            writeLocalSettings(cloud);
        } else if (localHasData) {
            global = local;
            console.log('[Me] Using local data (cloud empty)');
            scheduleCloudSave({
                campStructure: local.campStructure,
                app1: local.app1,
                updated_at: new Date().toISOString()
            });
        } else {
            global = {};
            console.log('[Me] No data found (fresh start)');
        }

        camperRoster = global?.app1?.camperRoster || {};
        
        // ★ v7.1: Always prefer campStructure (has colors + grades).
        // If missing, migrate from app1.divisions but preserve any colors
        // that were previously saved in localStorage's campStructure.
        if (global?.campStructure && Object.keys(global.campStructure).length > 0) {
            structure = global.campStructure;
        } else {
            // Cloud may not have campStructure — check localStorage as backup for colors
            const localBackup = readLocalSettings();
            const localCS = localBackup.campStructure || {};
            structure = migrateOldStructure(global?.app1?.divisions || {}, localCS);
        }
        
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
        
        Object.keys(structure).forEach(d => expandedDivisions.add(d));
        
        console.log('[Me] Loaded', Object.keys(structure).length, 'divisions,', Object.keys(camperRoster).length, 'campers');
    }

    function migrateOldStructure(oldDivisions, localCampStructure) {
        const localCS = localCampStructure || {};
        const newStructure = {};
        Object.entries(oldDivisions).forEach(([divName, divData]) => {
            if (isUnsafeName(divName)) return;
            if (!divData || typeof divData !== 'object') return;
            const bunks = (divData.bunks || []).map(b => typeof b === 'string' ? b : b.name);
            // ★ v7.1: Prefer color from: app1.divisions → localStorage campStructure → preset
            const color = (divData.color && divData.color !== '#00C896' ? divData.color : null)
                       || (localCS[divName]?.color)
                       || divData.color
                       || COLOR_PRESETS[Object.keys(newStructure).length % COLOR_PRESETS.length];
            newStructure[divName] = {
                color: sanitizeColor(color),
                grades: (localCS[divName]?.grades) || (bunks.length > 0 ? { 'Default': { bunks } } : {})
            };
        });
        return newStructure;
    }

    // =========================================================================
    // ★ v7.1 FIX: SAFE MERGE for app1.divisions — preserves Flow's time data
    // =========================================================================

    function convertToOldFormat(struct) {
        // ★ v7.1: Read EXISTING app1.divisions first so we preserve Flow's
        // time-related keys (start, stop, increments, lunchAfter, etc.)
        const existing = readLocalSettings();
        const existingDivs = (existing.app1 && existing.app1.divisions) || {};

        const merged = {};
        Object.entries(struct).forEach(([divName, divData]) => {
            const allBunks = [];
            Object.values(divData.grades || {}).forEach(g => (g.bunks || []).forEach(b => allBunks.push(b)));

            // ★ Start with whatever Flow already stored for this division
            const base = existingDivs[divName] || {};

            // ★ Only overwrite the keys Me owns: color and bunks
            merged[divName] = {
                ...base,               // Preserves: start, stop, increments, lunchAfter, etc.
                color: sanitizeColor(divData.color),
                bunks: allBunks
            };
        });

        // ★ Also preserve divisions that exist in Flow but NOT in Me's structure
        // (edge case: Flow has a division that Me hasn't loaded yet)
        Object.keys(existingDivs).forEach(divName => {
            if (!merged[divName]) {
                merged[divName] = existingDivs[divName];
            }
        });

        return merged;
    }

    // =========================================================================
    // ★ SAVE DATA (localStorage + cloud)
    // =========================================================================

    function saveData() {
        try {
            setSyncStatus('syncing');
            
            const global = readLocalSettings();
            global.campStructure = structure;
            if (!global.app1) global.app1 = {};
            global.app1.camperRoster = camperRoster;

            // ★ v7.1: MERGE into app1.divisions instead of overwriting
            global.app1.divisions = convertToOldFormat(structure);

            global.updated_at = new Date().toISOString();
            
            writeLocalSettings(global);
            
            if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
                window.saveGlobalSettings('campStructure', structure);
                window.saveGlobalSettings('app1', global.app1);
            } else {
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

    // =========================================================================
    // GRADE-FILTERED LEAGUE TEAMS
    // =========================================================================

    function _extractGradeNumber(str) {
        if (!str) return null;
        const s = String(str).toLowerCase().trim();
        const ordinal = s.match(/^(\d+)(st|nd|rd|th)?\s*(grade)?$/);
        if (ordinal) return parseInt(ordinal[1], 10);
        const gradeN = s.match(/^grade\s*(\d+)$/);
        if (gradeN) return parseInt(gradeN[1], 10);
        const bare = s.match(/^(\d+)$/);
        if (bare) return parseInt(bare[1], 10);
        return null;
    }

    function _divisionMatches(leagueDiv, campValue) {
        if (!leagueDiv || !campValue) return false;
        const a = String(leagueDiv).toLowerCase().trim();
        const b = String(campValue).toLowerCase().trim();
        if (a === b) return true;
        const numA = _extractGradeNumber(leagueDiv);
        const numB = _extractGradeNumber(campValue);
        if (numA !== null && numB !== null) return numA === numB;
        if (numA === null && numB === null) return a.includes(b) || b.includes(a);
        return false;
    }

    function getTeamsForContext(divName, gradeName) {
        if (!divName && !gradeName) return leagueTeams;
        const matched = new Set();
        _leagueData.forEach(ld => {
            if (ld.divisions.length === 0) {
                ld.teams.forEach(t => matched.add(t));
                return;
            }
            const divMatch = divName && ld.divisions.some(d => _divisionMatches(d, divName));
            const gradeMatch = gradeName && ld.divisions.some(d => _divisionMatches(d, gradeName));
            if (divMatch || gradeMatch) ld.teams.forEach(t => matched.add(t));
        });
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
    // RENDER HIERARCHY
    // =========================================================================

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

        _slugMap.clear();
        _slugCounter = 0;

        const divNames = Object.keys(structure).sort();
        if (divNames.length === 0) { container.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
        if (empty) empty.style.display = 'none';

        const camperCountMap = {};
        Object.values(camperRoster).forEach(c => {
            if (c.division) camperCountMap[c.division] = (camperCountMap[c.division] || 0) + 1;
        });

        container.innerHTML = divNames.map(divName => {
            const div = structure[divName];
            if (!div || typeof div !== 'object') return '';
            const isExpanded = expandedDivisions.has(divName);
            const grades = div.grades || {};
            const gradeNames = Object.keys(grades).sort();
            const camperCount = camperCountMap[divName] || 0;
            const divColor = sanitizeColor(div.color);

            const escDiv = esc(divName);
            const jsDiv = jsEsc(divName);
            const divSlug = slugId(divName);

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

            const addGradeHtml = '<div class="add-grade-inline"><div class="quick-add">' +
                '<input type="text" placeholder="+ Add grade" maxlength="' + MAX_NAME_LENGTH + '" id="addGrade_' + divSlug + '" onkeypress="if(event.key===\'Enter\'){CampistryMe.addGradeInline(\'' + jsDiv + '\');event.preventDefault();}">' +
                '<button class="quick-add-btn" onclick="CampistryMe.addGradeInline(\'' + jsDiv + '\')" aria-label="Add grade">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                '</button></div></div>';

            // ★ v7.1: Division color swatch is now clickable — opens edit modal
            return '<div class="division-block">' +
                '<div class="division-header ' + (isExpanded ? '' : 'collapsed') + '" onclick="CampistryMe.toggleDivision(\'' + jsDiv + '\')">' +
                    '<div class="division-left">' +
                        '<div class="division-color" style="background:' + divColor + '" onclick="event.stopPropagation(); CampistryMe.editDivision(\'' + jsDiv + '\')" title="Click to change color"></div>' +
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
        if (isUnsafeName(name)) { toast('That name is reserved', 'error'); return; }
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
        
        // ★ v7.1: Color picker ALWAYS visible (was hidden on "Add")
        const colorGroup = document.getElementById('colorPickerGroup');
        if (colorGroup) colorGroup.style.display = 'block';
        
        if (isEdit && structure[editName]) {
            document.getElementById('divisionName').value = editName;
            document.getElementById('divisionColor').value = structure[editName].color || COLOR_PRESETS[0];
            setupColorPresets();
            updateColorPresetSelection(structure[editName].color || COLOR_PRESETS[0]);
        } else {
            document.getElementById('divisionName').value = '';
            // ★ v7.1: Pre-select next unique color for new divisions
            const nextColor = getNextUniqueColor();
            document.getElementById('divisionColor').value = nextColor;
            setupColorPresets();
            updateColorPresetSelection(nextColor);
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
        
        // ★ v7.1: Always read color from the picker (it's always visible now)
        const selectedColor = sanitizeColor(document.getElementById('divisionColor').value);

        if (currentEditDivision && currentEditDivision !== name) {
            if (structure[name]) { toast('Division "' + name + '" already exists', 'error'); return; }
            structure[name] = { ...structure[currentEditDivision], color: selectedColor };
            delete structure[currentEditDivision];
            Object.values(camperRoster).forEach(c => { if (c.division === currentEditDivision) c.division = name; });
            expandedDivisions.delete(currentEditDivision); expandedDivisions.add(name);
            const staleKeys = [...expandedGrades].filter(k => k.startsWith(currentEditDivision + '||'));
            staleKeys.forEach(k => {
                expandedGrades.delete(k);
                expandedGrades.add(name + k.slice(currentEditDivision.length));
            });
        } else if (currentEditDivision) {
            structure[currentEditDivision].color = selectedColor;
        } else {
            if (structure[name]) { toast('Division exists', 'error'); return; }
            structure[name] = { color: selectedColor, grades: {} };
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

    function editGrade(divName, oldGradeName) {
        if (!structure[divName]?.grades?.[oldGradeName]) { toast('Grade not found', 'error'); return; }
        const newName = prompt('Rename grade "' + oldGradeName + '":', oldGradeName);
        if (!newName || newName.trim() === '' || newName.trim() === oldGradeName) return;
        const trimmed = newName.trim().slice(0, MAX_NAME_LENGTH);
        if (isUnsafeName(trimmed)) { toast('That name is reserved', 'error'); return; }
        if (structure[divName]?.grades?.[trimmed]) { toast('Grade "' + trimmed + '" already exists', 'error'); return; }
        const gradeData = structure[divName].grades[oldGradeName];
        structure[divName].grades[trimmed] = gradeData;
        delete structure[divName].grades[oldGradeName];
        const oldKey = divName + '||' + oldGradeName;
        const newKey = divName + '||' + trimmed;
        if (expandedGrades.has(oldKey)) { expandedGrades.delete(oldKey); expandedGrades.add(newKey); }
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
        const idx = (gradeData.bunks || []).indexOf(oldBunkName);
        if (idx === -1) return;
        gradeData.bunks[idx] = trimmed;
        Object.values(camperRoster).forEach(c => { if (c.division === divName && c.grade === gradeName && c.bunk === oldBunkName) c.bunk = trimmed; });
        saveData(); renderHierarchy(); updateStats(); toast('Bunk renamed');
    }

    // =========================================================================
    // CAMPER TABLE
    // =========================================================================

    function renderCamperTable() {
        const tbody = document.getElementById('camperTableBody');
        const empty = document.getElementById('campersEmptyState');
        if (!tbody) return;

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
        const qaFilteredTeams = getTeamsForContext(savedQA.div, savedQA.grade);
        const teamOptions = '<option value="">—</option>' + qaFilteredTeams.map(t => '<option value="' + esc(t) + '"' + (t === savedQA.team ? ' selected' : '') + '>' + esc(t) + '</option>').join('');

        let html = '<tr class="add-row"><td><input type="text" id="qaName" placeholder="Camper name" maxlength="' + MAX_NAME_LENGTH + '" onkeypress="if(event.key===\'Enter\'){CampistryMe.quickAddCamper();event.preventDefault();}"></td><td><select id="qaDivision" onchange="CampistryMe.updateQAGrades()">' + divOptions + '</select></td><td><select id="qaGrade" onchange="CampistryMe.updateQABunks()"><option value="">—</option></select></td><td><select id="qaBunk"><option value="">—</option></select></td><td><select id="qaTeam">' + teamOptions + '</select></td><td><button class="btn btn-primary btn-sm" onclick="CampistryMe.quickAddCamper()">Add</button></td></tr>';

        if (campers.length === 0 && total === 0) { tbody.innerHTML = html; if (empty) empty.style.display = 'block'; _restoreQAState(savedQA); return; }
        if (empty) empty.style.display = 'none';

        html += campers.map(c => '<tr><td><span class="clickable" onclick="CampistryMe.editCamper(\'' + jsEsc(c.name) + '\')">' + esc(c.name) + '</span></td><td>' + (esc(c.division) || '—') + '</td><td>' + (esc(c.grade) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (esc(c.team) || '—') + '</td><td><button class="icon-btn danger" onclick="CampistryMe.deleteCamper(\'' + jsEsc(c.name) + '\')" aria-label="Delete camper"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td></tr>').join('');
        tbody.innerHTML = html;
        _restoreQAState(savedQA);
    }

    function _restoreQAState(saved) {
        if (!saved.div) return;
        const divSel = document.getElementById('qaDivision');
        if (divSel) divSel.value = saved.div;
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

    function updateEditTeams(divName, gradeName, selectedTeam) {
        const teamSelect = document.getElementById('editCamperTeam');
        if (!teamSelect) return;
        const filtered = getTeamsForContext(divName, gradeName);
        teamSelect.innerHTML = '<option value="">—</option>';
        filtered.forEach(t => {
            teamSelect.innerHTML += '<option value="' + esc(t) + '"' + (t === selectedTeam ? ' selected' : '') + '>' + esc(t) + '</option>';
        });
    }

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
        
        if (newName !== currentEditCamper) {
            if (camperRoster[newName]) { toast('Camper "' + newName + '" already exists', 'error'); return; }
            delete camperRoster[currentEditCamper];
        }
        camperRoster[newName] = data;
        
        saveData(); closeModal('camperModal'); renderAll(); toast('Camper updated');
    }

    function deleteCamper(name) {
        if (!camperRoster[name]) return;
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
        if (!navigator.onLine) {
            toast('You are offline — clear may not persist to cloud', 'error');
        }
    }

    // =========================================================================
    // CSV IMPORT / EXPORT
    // =========================================================================

    function downloadTemplate() {
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
        if (file.size > MAX_CSV_FILE_SIZE) {
            toast('File too large (max ' + Math.round(MAX_CSV_FILE_SIZE / 1024 / 1024) + 'MB)', 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = e => parseCsv(e.target.result);
        reader.readAsText(file);
    }

    function parseCsv(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (!lines.length) { toast('CSV is empty', 'error'); return; }
        const first = lines[0].toLowerCase();
        const hasHeader = first.includes('name') || first.includes('division');
        const start = hasHeader ? 1 : 0;
        pendingCsvData = [];
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
            toast('Capped at ' + MAX_CSV_ROWS + ' rows', 'error');
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
        return result.map(s => s.replace(/""/g, '"'));
    }

    function importCsv() {
        if (!pendingCsvData.length) return;
        let added = 0, updated = 0, skipped = 0;
        let divsCreated = 0, gradesCreated = 0, bunksCreated = 0;

        const existingDivCount = Object.keys(structure).length;
        pendingCsvData.forEach(r => {
            const divName = r.division;
            const gradeName = r.grade;
            const bunkName = r.bunk;

            if (isUnsafeName(r.name) || isUnsafeName(divName) || isUnsafeName(gradeName) || isUnsafeName(bunkName)) {
                skipped++;
                return;
            }

            if (divName && !structure[divName]) {
                const colorIdx = (existingDivCount + divsCreated) % COLOR_PRESETS.length;
                structure[divName] = { color: COLOR_PRESETS[colorIdx], grades: {} };
                expandedDivisions.add(divName);
                divsCreated++;
            }

            if (divName && gradeName && structure[divName]) {
                if (!structure[divName].grades) structure[divName].grades = {};
                if (!structure[divName].grades[gradeName]) {
                    structure[divName].grades[gradeName] = { bunks: [] };
                    expandedGrades.add(divName + '||' + gradeName);
                    gradesCreated++;
                }
            }

            if (divName && gradeName && bunkName && structure[divName]?.grades?.[gradeName]) {
                const bunks = structure[divName].grades[gradeName].bunks;
                if (!bunks.includes(bunkName)) {
                    bunks.push(bunkName);
                    bunksCreated++;
                }
            }

            if (camperRoster[r.name]) updated++; else added++;
            camperRoster[r.name] = { division: r.division, grade: r.grade, bunk: r.bunk, team: r.team };
        });

        saveData(); closeModal('csvModal'); renderAll();

        const parts = [];
        if (added) parts.push(added + ' added');
        if (updated) parts.push(updated + ' updated');
        if (skipped) parts.push(skipped + ' skipped');
        if (divsCreated) parts.push(divsCreated + ' div' + (divsCreated !== 1 ? 's' : '') + ' created');
        if (gradesCreated) parts.push(gradesCreated + ' grade' + (gradesCreated !== 1 ? 's' : '') + ' created');
        if (bunksCreated) parts.push(bunksCreated + ' bunk' + (bunksCreated !== 1 ? 's' : '') + ' created');
        toast(parts.join(', ') || 'Import complete');
    }

    function exportCsv() {
        const entries = Object.entries(camperRoster);
        if (!entries.length) { toast('No campers', 'error'); return; }
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
        if (!container) return;
        container.innerHTML = COLOR_PRESETS.map(c => {
            const sc = sanitizeColor(c);
            return `<div class="color-preset" style="background:${sc}" data-color="${sc}" onclick="event.stopPropagation(); CampistryMe.selectColorPreset('${sc}')"></div>`;
        }).join('');
    }

    function selectColorPreset(color) { 
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
        on('editCamperName', 'onkeypress', e => { if (e.key === 'Enter') saveCamper(); });

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
            dropzone.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
            dropzone.ondragover = e => { e.preventDefault(); dropzone.classList.add('dragover'); };
            dropzone.ondragleave = () => dropzone.classList.remove('dragover');
            dropzone.ondrop = e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleCsvFile(e.dataTransfer.files[0]); };
            fileInput.onchange = e => handleCsvFile(e.target.files[0]);
        }

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('mousedown', e => {
                if (e.target === overlay) { e.preventDefault(); closeModal(overlay.id); }
            });
        });
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('mousedown', e => e.stopPropagation());
            modal.addEventListener('click', e => e.stopPropagation());
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(overlay => closeModal(overlay.id));
            }
        });

        window.addEventListener('beforeunload', () => {
            if (_pendingMergeData && _cloudSaveTimeout) {
                clearTimeout(_cloudSaveTimeout);
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
                } catch (_) {}
                _pendingMergeData = null;
            }
        });

        window.addEventListener('online', () => {
            setSyncStatus('syncing');
            saveData();
        });

        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible') return;
            if (_pendingMergeData) return;
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
                        // ★ v7.1: Only use cloud campStructure if it actually exists;
                        // otherwise keep local structure (which has user's color choices)
                        if (cloud.campStructure && Object.keys(cloud.campStructure).length > 0) {
                            structure = cloud.campStructure;
                        }
                        writeLocalSettings(cloud);
                        renderAll();
                    }
                }
            } catch (e) {
                console.warn('[Me] Tab visibility refresh failed:', e);
            }
        });
    }

    function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;') : ''; }
    function jsEsc(s) { return s ? String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n') : ''; }

    function sanitizeColor(c) {
        if (!c || typeof c !== 'string') return COLOR_PRESETS[0];
        if (/^#[0-9a-fA-F]{3,8}$/.test(c.trim())) return c.trim();
        if (/^[a-zA-Z]{3,20}$/.test(c.trim())) return c.trim();
        return COLOR_PRESETS[0];
    }

    const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
    function isUnsafeName(name) { return UNSAFE_NAMES.has(name); }

    function toast(msg, type = 'success') {
        const t = document.getElementById('toast');
        if (!t) return;
        if (_toastTimeout) clearTimeout(_toastTimeout);
        const icon = document.getElementById('toastIcon');
        if (icon) icon.innerHTML = type === 'error' ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' : '<polyline points="20 6 9 17 4 12"/>';
        document.getElementById('toastMessage').textContent = msg;
        t.className = 'toast ' + type + ' show';
        _toastTimeout = setTimeout(() => { t.classList.remove('show'); _toastTimeout = null; }, 3000);
    }

    // =========================================================================
    // PUBLIC API
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
