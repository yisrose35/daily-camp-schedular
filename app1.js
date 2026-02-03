// =================================================================
// app1.js — v5.1: Grades Are The Scheduling Units (Read-Only Structure)
//
// THEME: Modern Pro Camp (Emerald/White)
// VERSION: 5.1 - Grades (not divisions) drive the scheduler
// 
// KEY CONCEPT:
//   Division (e.g. "Juniors")    = organizational parent group
//   Grade    (e.g. "1st Grade")  = the SCHEDULING UNIT (columns in builder)
//   Bunk     (e.g. "1A", "1B")   = individual groups within a grade
//
// Previously "division 1" was the scheduling unit. Now grades fill that role.
// state.divisions / window.divisions is keyed by GRADE name.
// Master Builder, Daily Adjustments, Scheduler Core all consume
// window.divisions — so they automatically get grades with zero changes.
//
// v5.1 CHANGES vs v5.0:
// - Structure (divisions/grades/bunks) is READ-ONLY — managed in Campistry Me
// - loadData() extracts GRADES as scheduling units from campStructure
// - Each grade entry has parentDivision for grouping/color
// - UI groups grades by parent division in the left panel
// - Detail pane shows grade info with parent division context
// - "Apply to All in [Division]" button for times
// - Campistry Me link banner at top
// - All window exports preserved for scheduler compatibility
// =================================================================
(function () {
    "use strict";
    
    // ==================== CONSTANTS ====================
    const VERSION = "5.1";
    const DEBOUNCE_MS = 150;
    const DEFAULT_BUNK_SIZE = 0;
    
    const DEFAULT_COLORS = Object.freeze([
        "#00C896", "#6366F1", "#F59E0B", "#EF4444",
        "#8B5CF6", "#3B82F6", "#10B981", "#EC4899",
        "#F97316", "#14B8A6", "#84CC16", "#A855F7",
        "#06B6D4", "#F43F5E", "#22C55E", "#FBBF24"
    ]);
    
    const DEFAULT_SPORTS = Object.freeze([
        "Baseball", "Basketball", "Football", "Hockey", "Kickball",
        "Lacrosse", "Newcomb", "Punchball", "Soccer", "Volleyball"
    ]);
    
    const DEFAULT_DURATIONS = Object.freeze({
        "General Activity": 60,
        "Sports Slot": 60,
        "Special Activity": 60,
        "Swim": 60,
        "League Game": 60,
        "Specialty League": 60
    });

    // ==================== STATE ====================
    const state = {
        bunks: [],
        divisions: {},              // ★ Keyed by GRADE name: { gradeName: { startTime, endTime, bunks[], color, parentDivision } }
        specialActivities: [],
        availableDivisions: [],     // ★ Array of GRADE names (the scheduling units)
        selectedDivision: null,     // ★ Selected GRADE name
        bunkMetaData: {},
        sportMetaData: {},
        allSports: [...DEFAULT_SPORTS],
        savedSkeletons: {},
        skeletonAssignments: {},
        // Parent division groups (for UI grouping only)
        divisionGroups: {}          // { parentDivName: { color, grades: [gradeName, ...] } }
    };

    // ==================== UTILITIES ====================
    
    function deepClone(obj) {
        if (obj === null || obj === undefined) return obj;
        try { return structuredClone(obj); }
        catch { return JSON.parse(JSON.stringify(obj)); }
    }
    
    function debounce(fn, delay = DEBOUNCE_MS) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn.apply(this, args), delay);
        };
    }
    
    function safeGet(obj, path, defaultVal = null) {
        if (!obj || !path) return defaultVal;
        const keys = path.split('.');
        let result = obj;
        for (const key of keys) {
            if (result === null || result === undefined) return defaultVal;
            result = result[key];
        }
        return result ?? defaultVal;
    }
    
    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let meridiem = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            meridiem = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/gi, "").trim();
        }
        const match = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!match) return null;
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
        if (meridiem) {
            if (hours === 12) hours = meridiem === "am" ? 0 : 12;
            else if (meridiem === "pm" && hours < 12) hours += 12;
        }
        return hours * 60 + minutes;
    }
    
    function compareBunks(a, b) {
        return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
    }
    
    function sortBunksInPlace(arr) {
        if (!Array.isArray(arr)) return;
        arr.sort(compareBunks);
    }
    
    function escapeHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // ==================== SYNC SPINE ====================
    
    function syncSpine() {
        window.setGlobalDivisions?.(deepClone(state.divisions));
        window.setGlobalBunks?.(deepClone(state.bunks));
    }

    // ==================== COLOR MANAGEMENT ====================
    
    function getColorIndex() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.divisionColorIndex || 0;
    }
    
    function setColorIndex(index) {
        window.saveGlobalSettings?.('divisionColorIndex', index);
    }
    
    function getNextDivisionColor() {
        const index = getColorIndex();
        const color = DEFAULT_COLORS[index % DEFAULT_COLORS.length];
        setColorIndex(index + 1);
        return color;
    }
    
    function getNextUniqueDivisionColor(divisionsObj = state.divisions) {
        const usedColors = new Set(
            Object.values(divisionsObj || {}).map(d => d?.color).filter(Boolean)
        );
        const startIndex = getColorIndex();
        for (let i = 0; i < DEFAULT_COLORS.length; i++) {
            const index = (startIndex + i) % DEFAULT_COLORS.length;
            const color = DEFAULT_COLORS[index];
            if (!usedColors.has(color)) {
                setColorIndex(index + 1);
                return color;
            }
        }
        return getNextDivisionColor();
    }

    // ==================== SKELETON DIVISION MIGRATION ====================
    // Handles the transition from parent-division-named events (e.g. "Juniors")
    // to grade-named events (e.g. "1", "2", "3"). Also handles any future
    // renaming of grades by checking against a stored divisionNameMap.

    /**
     * Build a smart mapping from old division names to current grade names.
     * Handles cases like "1" → "1st Grade", "3rd grade" → "3rd Grade", etc.
     *
     * Strategy (in priority order):
     *  1. Case-insensitive exact match: "1st grade" → "1st Grade"
     *  2. Old name is pure number, grade starts with same number: "1" → "1st Grade"
     *  3. Leading number extraction matches: "1st" → "1st Grade"
     *  4. Old name is a unique substring of exactly one grade: "3rd" → "3rd Grade"
     */
    function buildSmartOldToNewMap(unknownNames) {
        const map = {};
        if (!unknownNames || unknownNames.size === 0) return map;

        const grades = state.availableDivisions;
        if (!grades.length) return map;

        // Pre-build lookups
        const lowerToGrade = {};
        const numberToGrade = {};
        grades.forEach(g => {
            lowerToGrade[g.toLowerCase()] = g;
            const m = g.match(/^(\d+)/);
            if (m) numberToGrade[parseInt(m[1], 10)] = g;
        });

        unknownNames.forEach(oldName => {
            if (!oldName) return;
            const lower = oldName.trim().toLowerCase();

            // 1. Case-insensitive exact match
            if (lowerToGrade[lower]) {
                map[oldName] = lowerToGrade[lower];
                return;
            }

            // 2. Pure number → grade that starts with that number
            //    "1" → 1 → "1st Grade", "2" → 2 → "2nd Grade"
            const asNum = parseInt(oldName, 10);
            if (!isNaN(asNum) && String(asNum) === oldName.trim() && numberToGrade[asNum]) {
                map[oldName] = numberToGrade[asNum];
                return;
            }

            // 3. Leading number extraction: "1st" → 1 → "1st Grade"
            const leadMatch = oldName.match(/^(\d+)/);
            if (leadMatch) {
                const n = parseInt(leadMatch[1], 10);
                if (numberToGrade[n]) {
                    map[oldName] = numberToGrade[n];
                    return;
                }
            }

            // 4. Unique substring: "3rd" is contained in exactly one grade
            const containing = grades.filter(g => g.toLowerCase().includes(lower));
            if (containing.length === 1) {
                map[oldName] = containing[0];
                return;
            }
        });

        if (Object.keys(map).length > 0) {
            console.log('[app1 v5.1] Smart division→grade mapping:', map);
        }
        return map;
    }

    /**
     * Migrate a single skeleton event array.
     * - Events whose division matches a current grade: kept as-is
     * - Events whose division matches a parent division name: expanded to one event per grade
     * - Events whose division matches an old name in divisionNameMap: remapped
     * - Events whose division smart-matches a grade (e.g. "1" → "1st Grade"): remapped
     * - Everything else: kept as-is (orphaned events ignored by grid)
     *
     * Returns { events: [...], changed: boolean }
     */
    function migrateSkeletonEvents(events) {
        if (!Array.isArray(events) || events.length === 0) return { events, changed: false };

        const currentDivs = new Set(state.availableDivisions);

        // Parent division name → array of grade names
        const parentToGrades = {};
        Object.entries(state.divisionGroups).forEach(([parentName, group]) => {
            if (parentName !== "All" && group.grades?.length > 0) {
                parentToGrades[parentName] = group.grades;
            }
        });
        const parentNames = new Set(Object.keys(parentToGrades));

        // divisionNameMap: old name → new name (single) for grade renames
        const globalData = window.loadGlobalSettings?.() || {};
        const nameMap = globalData.divisionNameMap || {};

        // ★ Collect unknown division names that need smart matching
        const unknownNames = new Set();
        events.forEach(ev => {
            if (ev?.division && !currentDivs.has(ev.division) &&
                !parentNames.has(ev.division) && !nameMap[ev.division]) {
                unknownNames.add(ev.division);
            }
        });

        // ★ Build smart old→new mapping (e.g. "1" → "1st Grade")
        const smartMap = buildSmartOldToNewMap(unknownNames);

        // Quick check: does anything need migration?
        const anyNeedsMigration = events.some(ev =>
            ev?.division && !currentDivs.has(ev.division) &&
            (parentNames.has(ev.division) || nameMap[ev.division] || smartMap[ev.division])
        );
        if (!anyNeedsMigration) return { events, changed: false };

        const migrated = [];
        events.forEach(ev => {
            if (!ev || !ev.division) { migrated.push(ev); return; }

            // Already matches a current grade — keep
            if (currentDivs.has(ev.division)) { migrated.push(ev); return; }

            // Matches a parent division — expand to all its grades
            if (parentToGrades[ev.division]) {
                parentToGrades[ev.division].forEach(gradeName => {
                    migrated.push({
                        ...ev,
                        division: gradeName,
                        id: (ev.id || String(Date.now())) + '_' + gradeName
                    });
                });
                return;
            }

            // Matches a stored rename — remap to new name
            if (nameMap[ev.division]) {
                const newName = nameMap[ev.division];
                if (currentDivs.has(newName)) {
                    migrated.push({ ...ev, division: newName });
                    return;
                }
            }

            // ★ Smart match: "1" → "1st Grade", "3rd" → "3rd Grade", etc.
            if (smartMap[ev.division]) {
                migrated.push({ ...ev, division: smartMap[ev.division] });
                return;
            }

            // Unknown — keep as-is
            migrated.push(ev);
        });

        return { events: migrated, changed: true };
    }

    // ==================== GENERIC MIGRATION HELPERS ====================

    /**
     * Rename keys in an object using the migration map.
     * Returns { result: newObj, changed: boolean }
     */
    function remapObjectKeys(obj, map) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { result: obj, changed: false };
        let changed = false;
        const result = {};
        Object.entries(obj).forEach(([key, val]) => {
            if (map[key]) {
                result[map[key]] = val;
                changed = true;
            } else {
                result[key] = val;
            }
        });
        return { result, changed };
    }

    /**
     * Remap string values in an array using the migration map.
     * Returns { result: newArr, changed: boolean }
     */
    function remapArrayValues(arr, map) {
        if (!Array.isArray(arr)) return { result: arr, changed: false };
        let changed = false;
        const result = arr.map(val => {
            if (typeof val === 'string' && map[val]) {
                changed = true;
                return map[val];
            }
            return val;
        });
        return { result, changed };
    }

    /**
     * Build a comprehensive old→new name map from current grade names.
     * Covers: pure numbers ("1"→"1st Grade"), parent division names,
     * stored renames, and case variations.
     */
    function buildComprehensiveMigrationMap() {
        const map = {};
        const grades = state.availableDivisions;
        if (!grades.length) return map;

        // Number → grade: "1" → "1st Grade", "2" → "2nd Grade"
        grades.forEach(g => {
            const m = g.match(/^(\d+)/);
            if (m) {
                const n = m[1]; // string "1", "2", etc.
                map[n] = g;
                // Also handle ordinal fragments: "1st" → "1st Grade"
                const ordinals = [n + 'st', n + 'nd', n + 'rd', n + 'th'];
                ordinals.forEach(o => { if (g.toLowerCase().startsWith(o)) map[o] = g; });
            }
            // Case-insensitive: "1st grade" → "1st Grade"
            if (g.toLowerCase() !== g) map[g.toLowerCase()] = g;
        });

        // Add parent division → expansion marker (handled in skeleton migration)
        // Parent names map to MULTIPLE grades, not a single one, so NOT added to this map

        // Merge any stored renames
        const globalData = window.loadGlobalSettings?.() || {};
        const nameMap = globalData.divisionNameMap || {};
        Object.entries(nameMap).forEach(([old, newName]) => {
            if (grades.includes(newName)) map[old] = newName;
        });

        return map;
    }

    // ==================== COMPREHENSIVE DATA MIGRATION ====================

    /**
     * Run migration across ALL stored data:
     *   1. state.savedSkeletons (templates)
     *   2. localStorage per-date skeleton keys
     *   3. Master schedule draft in localStorage
     *   4. Compound campistryDailyData
     *   5. divisionTimes in localStorage (CRITICAL for scheduler)
     *   6. Special activities (limitUsage, sharableWith)
     *   7. League division references
     *   8. Subdivision division mappings
     *   9. Historical counts
     */
    function migrateAllStoredSkeletons() {
        // Only migrate if we have parent divisions (campStructure loaded)
        const hasParents = Object.keys(state.divisionGroups).some(k => k !== "All");
        if (!hasParents) return;

        // Build comprehensive map once
        const migMap = buildComprehensiveMigrationMap();
        if (Object.keys(migMap).length === 0) return;

        // ★ Expose globally so ALL modules can use it at runtime
        window.divisionNameMigrationMap = migMap;

        let anyMigrated = false;

        // ==============================================================
        // 1. Saved skeleton templates
        // ==============================================================
        Object.keys(state.savedSkeletons).forEach(name => {
            const result = migrateSkeletonEvents(state.savedSkeletons[name]);
            if (result.changed) {
                state.savedSkeletons[name] = result.events;
                anyMigrated = true;
                console.log(`[app1] Migrated template "${name}" (${state.savedSkeletons[name].length} events)`);
            }
        });

        // ==============================================================
        // 2. Per-date localStorage skeleton keys
        // ==============================================================
        try {
            const keysToCheck = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (
                    key.startsWith('campManualSkeleton_') ||
                    key.startsWith('campDailyOverrideSkeleton_')
                )) {
                    keysToCheck.push(key);
                }
            }
            keysToCheck.forEach(key => {
                try {
                    const raw = localStorage.getItem(key);
                    if (!raw) return;
                    const events = JSON.parse(raw);
                    const result = migrateSkeletonEvents(events);
                    if (result.changed) {
                        localStorage.setItem(key, JSON.stringify(result.events));
                        anyMigrated = true;
                        console.log(`[app1] Migrated localStorage: ${key}`);
                    }
                } catch (e) { /* skip invalid */ }
            });
        } catch (e) { console.warn('[app1] localStorage migration error:', e); }

        // ==============================================================
        // 3. Master schedule draft
        // ==============================================================
        try {
            const draftRaw = localStorage.getItem('master-schedule-draft');
            if (draftRaw) {
                const events = JSON.parse(draftRaw);
                const result = migrateSkeletonEvents(events);
                if (result.changed) {
                    localStorage.setItem('master-schedule-draft', JSON.stringify(result.events));
                    anyMigrated = true;
                    console.log('[app1] Migrated master-schedule-draft');
                }
            }
        } catch (e) { /* skip */ }

        // ==============================================================
        // 4. Compound campistryDailyData key
        // ==============================================================
        try {
            const dailyRaw = localStorage.getItem('campistryDailyData');
            if (dailyRaw) {
                const dailyData = JSON.parse(dailyRaw);
                let changed = false;
                Object.keys(dailyData).forEach(dateKey => {
                    const dd = dailyData[dateKey];
                    if (dd?.manualSkeleton) {
                        const r = migrateSkeletonEvents(dd.manualSkeleton);
                        if (r.changed) { dd.manualSkeleton = r.events; changed = true; }
                    }
                    if (dd?.skeleton) {
                        const r = migrateSkeletonEvents(dd.skeleton);
                        if (r.changed) { dd.skeleton = r.events; changed = true; }
                    }
                    // Also migrate divisionTimes inside daily data
                    if (dd?.divisionTimes) {
                        const r = remapObjectKeys(dd.divisionTimes, migMap);
                        if (r.changed) { dd.divisionTimes = r.result; changed = true; }
                    }
                });
                if (changed) {
                    localStorage.setItem('campistryDailyData', JSON.stringify(dailyData));
                    anyMigrated = true;
                    console.log('[app1] Migrated campistryDailyData (skeletons + divisionTimes)');
                }
            }
        } catch (e) { /* skip */ }

        // ==============================================================
        // 5. ★ CRITICAL: divisionTimes in localStorage
        //    This fixes "[findSlotsForRange] No divisionTimes for: X"
        //    The DivTimesIntegration module restores from localStorage
        //    between scheduler steps, overwriting freshly-built data.
        // ==============================================================
        try {
            const dtKeys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (
                    key === 'divisionTimes' ||
                    key.startsWith('divisionTimes_') ||
                    key.startsWith('campistryDivisionTimes')
                )) {
                    dtKeys.push(key);
                }
            }
            dtKeys.forEach(key => {
                try {
                    const raw = localStorage.getItem(key);
                    if (!raw) return;
                    const dt = JSON.parse(raw);
                    const r = remapObjectKeys(dt, migMap);
                    if (r.changed) {
                        localStorage.setItem(key, JSON.stringify(r.result));
                        anyMigrated = true;
                        console.log(`[app1] Migrated divisionTimes key: ${key}`);
                    }
                } catch (e) { /* skip */ }
            });

            // Also check if divisionTimes is embedded inside schedule state keys
            const stateKeys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (
                    key.startsWith('scheduleState_') ||
                    key.startsWith('campSchedule_') ||
                    key.startsWith('campDailySchedule_')
                )) {
                    stateKeys.push(key);
                }
            }
            stateKeys.forEach(key => {
                try {
                    const raw = localStorage.getItem(key);
                    if (!raw) return;
                    const data = JSON.parse(raw);
                    let changed = false;
                    if (data?.divisionTimes) {
                        const r = remapObjectKeys(data.divisionTimes, migMap);
                        if (r.changed) { data.divisionTimes = r.result; changed = true; }
                    }
                    if (data?.scheduleAssignments) {
                        // Schedule assignments are keyed by bunk name — no change needed
                        // But check for any division references inside
                    }
                    if (changed) {
                        localStorage.setItem(key, JSON.stringify(data));
                        anyMigrated = true;
                        console.log(`[app1] Migrated divisionTimes in: ${key}`);
                    }
                } catch (e) { /* skip */ }
            });

            // Also update window.divisionTimes if it exists with old keys
            if (window.divisionTimes && typeof window.divisionTimes === 'object') {
                const r = remapObjectKeys(window.divisionTimes, migMap);
                if (r.changed) {
                    window.divisionTimes = r.result;
                    anyMigrated = true;
                    console.log('[app1] Migrated window.divisionTimes in memory');
                }
            }
        } catch (e) { console.warn('[app1] divisionTimes migration error:', e); }

        // ==============================================================
        // 6. Special Activities — limitUsage keys + sharableWith values
        //    Prevents "Removed orphaned division" stripping
        // ==============================================================
        try {
            const gs = window.loadGlobalSettings?.() || {};
            const specials = gs.app1?.specialActivities || gs.specialActivities || [];
            if (Array.isArray(specials) && specials.length > 0) {
                let changed = false;
                specials.forEach(act => {
                    if (!act) return;
                    // limitUsage: { "1": 2, "2": 3 } → { "1st Grade": 2, "2nd Grade": 3 }
                    if (act.limitUsage && typeof act.limitUsage === 'object') {
                        const r = remapObjectKeys(act.limitUsage, migMap);
                        if (r.changed) { act.limitUsage = r.result; changed = true; }
                    }
                    // sharableWith: ["1", "2"] → ["1st Grade", "2nd Grade"]
                    if (Array.isArray(act.sharableWith)) {
                        const r = remapArrayValues(act.sharableWith, migMap);
                        if (r.changed) { act.sharableWith = r.result; changed = true; }
                    }
                    // divisions: ["1", "2"] → ["1st Grade", "2nd Grade"]
                    if (Array.isArray(act.divisions)) {
                        const r = remapArrayValues(act.divisions, migMap);
                        if (r.changed) { act.divisions = r.result; changed = true; }
                    }
                    // excludeDivisions
                    if (Array.isArray(act.excludeDivisions)) {
                        const r = remapArrayValues(act.excludeDivisions, migMap);
                        if (r.changed) { act.excludeDivisions = r.result; changed = true; }
                    }
                });
                if (changed) {
                    // Save back — check both locations
                    if (gs.app1?.specialActivities) {
                        const app1Data = { ...gs.app1, specialActivities: specials };
                        window.saveGlobalSettings?.("app1", app1Data);
                    }
                    if (gs.specialActivities) {
                        window.saveGlobalSettings?.("specialActivities", specials);
                    }
                    // Also update in-memory state
                    state.specialActivities = specials;
                    anyMigrated = true;
                    console.log(`[app1] Migrated special activities division refs (${specials.length} activities)`);
                }
            }
        } catch (e) { console.warn('[app1] special activities migration error:', e); }

        // ==============================================================
        // 7. League division references
        //    Prevents "Removed stale division" stripping
        // ==============================================================
        try {
            const gs = window.loadGlobalSettings?.() || {};
            const leagues = gs.leagues || [];
            if (Array.isArray(leagues) && leagues.length > 0) {
                let changed = false;
                leagues.forEach(league => {
                    if (!league) return;
                    // divisions: ["1", "2"] → ["1st Grade", "2nd Grade"]
                    if (Array.isArray(league.divisions)) {
                        const r = remapArrayValues(league.divisions, migMap);
                        if (r.changed) { league.divisions = r.result; changed = true; }
                    }
                    // teams may reference divisions
                    if (Array.isArray(league.teams)) {
                        league.teams.forEach(team => {
                            if (team?.division && migMap[team.division]) {
                                team.division = migMap[team.division];
                                changed = true;
                            }
                        });
                    }
                });
                if (changed) {
                    window.saveGlobalSettings?.("leagues", leagues);
                    anyMigrated = true;
                    console.log(`[app1] Migrated league division refs (${leagues.length} leagues)`);
                }
            }

            // Also migrate leagueHistory keys
            const lh = gs.leagueHistory || {};
            if (Object.keys(lh).length > 0) {
                const r = remapObjectKeys(lh, migMap);
                if (r.changed) {
                    window.saveGlobalSettings?.("leagueHistory", r.result);
                    anyMigrated = true;
                    console.log('[app1] Migrated leagueHistory division keys');
                }
            }
        } catch (e) { console.warn('[app1] leagues migration error:', e); }

        // ==============================================================
        // 8. Subdivision division mappings
        //    "Juniors: 1, 2, 3" → "Juniors: 1st Grade, 2nd Grade, 3rd Grade"
        // ==============================================================
        try {
            const gs = window.loadGlobalSettings?.() || {};
            const subdivisions = gs.subdivisions || [];
            if (Array.isArray(subdivisions) && subdivisions.length > 0) {
                let changed = false;
                subdivisions.forEach(sub => {
                    if (!sub) return;
                    if (Array.isArray(sub.divisions)) {
                        const r = remapArrayValues(sub.divisions, migMap);
                        if (r.changed) { sub.divisions = r.result; changed = true; }
                    }
                    // Also handle 'grades' array if present
                    if (Array.isArray(sub.grades)) {
                        const r = remapArrayValues(sub.grades, migMap);
                        if (r.changed) { sub.grades = r.result; changed = true; }
                    }
                });
                if (changed) {
                    window.saveGlobalSettings?.("subdivisions", subdivisions);
                    anyMigrated = true;
                    console.log(`[app1] Migrated subdivision division mappings (${subdivisions.length} subdivisions)`);
                }
            }
        } catch (e) { console.warn('[app1] subdivision migration error:', e); }

        // ==============================================================
        // 9. Historical counts (keyed by bunk name — usually fine,
        //    but check for any division-keyed entries)
        // ==============================================================
        try {
            const gs = window.loadGlobalSettings?.() || {};
            const hc = gs.historicalCounts || {};
            // Historical counts are keyed by bunk name, not division — 
            // typically no migration needed. But check rotationHistory.
            const rh = gs.rotationHistory || {};
            if (Object.keys(rh).length > 0) {
                const r = remapObjectKeys(rh, migMap);
                if (r.changed) {
                    window.saveGlobalSettings?.("rotationHistory", r.result);
                    anyMigrated = true;
                    console.log('[app1] Migrated rotationHistory division keys');
                }
            }
        } catch (e) { /* skip */ }

        // ==============================================================
        // 10. Persist the migration map for future use + emit event
        // ==============================================================
        if (anyMigrated) {
            // Persist map so it's available even before app1 loads
            window.saveGlobalSettings?.("divisionNameMap", migMap);
            saveData();

            console.log('[app1 v5.1] ✅ All data migrated from old division names to grade names');
            console.log('[app1 v5.1] Migration map:', migMap);

            // Notify other modules that names have changed
            try {
                window.dispatchEvent(new CustomEvent('campistry-division-names-migrated', {
                    detail: { map: migMap }
                }));
            } catch (e) { /* skip */ }
        }
    }

    // ==================== STYLES ====================
    
    function ensureSharedSetupStyles() {
        if (document.getElementById("setup-shared-styles")) return;
        
        const style = document.createElement("style");
        style.id = "setup-shared-styles";
        style.textContent = `
            /* ===== Global Setup / Detail Pane Shell (Modern Pro Camp) ===== */
            .detail-pane {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                padding: 18px 20px;
                background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%);
                min-height: 360px;
                box-shadow: 0 18px 40px rgba(15, 23, 42, 0.06);
            }
            
            .division-card {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                background: #FFFFFF;
                padding: 10px 16px;
                margin: 4px 0;
                box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
                cursor: pointer;
                transition: all 0.16s ease;
            }
            
            .division-card:hover {
                box-shadow: 0 12px 26px rgba(15, 23, 42, 0.12);
                transform: translateY(-1px);
                background-color: #F9FAFB;
            }
            
            .division-card.selected {
                border-color: #00C896;
                box-shadow: 0 0 0 1px rgba(0, 200, 150, 0.55);
                background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 65%);
            }
            
            .division-card-top {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 4px;
            }
            
            .division-pill {
                padding: 4px 16px;
                border-radius: 999px;
                color: #FFFFFF;
                font-weight: 600;
                font-size: 0.9rem;
                min-width: 32px;
                display: flex;
                justify-content: center;
                align-items: center;
                box-shadow: 0 4px 10px rgba(15, 23, 42, 0.22);
            }
            
            .division-color-chip-list {
                width: 22px;
                height: 22px;
                border-radius: 6px;
                border: 1px solid rgba(15, 23, 42, 0.12);
                box-shadow: 0 2px 6px rgba(15, 23, 42, 0.15);
            }
            
            .division-card-subline {
                font-size: 0.8rem;
                color: #6B7280;
            }
            
            .division-edit-shell {
                padding: 4px 0 0;
                border-radius: 16px;
                background: transparent;
            }
            
            .division-edit-header {
                display: flex;
                justify-content: space-between;
                align-items: baseline;
                padding-bottom: 10px;
                border-bottom: 1px solid #E5E7EB;
                margin-bottom: 14px;
            }
            
            .division-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: 600;
                font-size: 0.98rem;
                color: #111827;
            }
            
            .division-status-dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            
            .division-name {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .division-header-summary {
                font-size: 0.8rem;
                color: #6B7280;
                font-weight: 400;
            }
            
            .division-edit-grid {
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            
            .division-mini-card {
                background: #FFFFFF;
                border: 1px solid #E5E7EB;
                border-radius: 12px;
                padding: 12px 14px;
                box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
            }
            
            .division-mini-header {
                font-weight: 600;
                font-size: 0.82rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #374151;
                margin-bottom: 6px;
            }
            
            .division-mini-help {
                font-size: 0.78rem;
                color: #9CA3AF;
                margin: 0 0 6px;
            }
            
            .division-bunk-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 5px 12px;
                border-radius: 999px;
                background: #F1F5F9;
                color: #1E293B;
                font-size: 0.8rem;
                font-weight: 500;
                border: 1px solid transparent;
                transition: all 0.15s ease;
            }
            
            .division-bunk-pill:hover {
                background: rgba(13, 124, 92, 0.12);
                border-color: #0D7C5C;
            }
            
            .bunk-size-badge {
                background: #E2E8F0;
                color: #64748B;
                padding: 1px 6px;
                border-radius: 999px;
                font-size: 0.7rem;
                font-weight: 500;
            }
            
            .division-color-row {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 0.8rem;
                color: #6B7280;
                margin-bottom: 12px;
            }

            /* ===== Parent Division Group Headers (v5.1) ===== */
            .parent-division-label {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 4px 2px;
                font-size: 0.72rem;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #6B7280;
            }

            .parent-division-label:not(:first-child) {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid #F3F4F6;
            }

            .parent-division-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
            }

            .bunk-delete-confirm {
                background: #FEF2F2;
                border-color: #FECACA;
                animation: shake 0.3s ease-in-out;
            }
            
            @keyframes shake {
                0%, 100% { transform: translateX(0); }
                25% { transform: translateX(-2px); }
                75% { transform: translateX(2px); }
            }
        `;
        document.head.appendChild(style);
    }

    // ==================== CAMPISTRY ME LINK BANNER ====================

    function renderCampistryMeLink() {
        if (document.getElementById("me-link-banner")) return;
        
        const grid = document.querySelector(".setup-grid");
        const target = grid || document.getElementById("division-detail-pane")?.parentNode;
        if (!target) return;
        
        const card = document.createElement("section");
        card.className = "setup-card setup-card-wide bulk-card";
        card.id = "me-link-banner";
        
        card.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;">
                <div style="flex:1; min-width:200px;">
                    <h3 style="margin:0; font-size:1.1rem; color:#111827; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        Camp Setup &amp; Configuration
                        <span style="font-size:0.7rem; background:#8A5DFF; color:white; padding:2px 8px; border-radius:999px;">Step 1</span>
                    </h3>
                    <p class="muted" style="margin:4px 0 0;">
                        Divisions, grades, bunks &amp; campers are managed in <a href="campistry_me.html" style="color:#7C3AED; font-weight:600;">Campistry Me</a>.
                        Configure <strong>times</strong> and <strong>scheduling settings</strong> here.
                        <br><span style="font-size:0.78rem; color:#9CA3AF;">Grades are the scheduling units — they appear as columns in the Master Builder and schedule grid.</span>
                    </p>
                </div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <a href="campistry_me.html" style="background:#7C3AED; color:white; border:none; padding:8px 18px; border-radius:999px; font-size:0.85rem; cursor:pointer; font-weight:600; text-decoration:none; transition:all 0.15s ease;">
                        Open Campistry Me
                    </a>
                </div>
            </div>
        `;
        
        target.prepend(card);
    }

    // ==================== UI RENDERING ====================
    
    /**
     * Render grade cards in the left panel, grouped by parent division
     */
    function setupDivisionButtons() {
        const container = document.getElementById("divisionButtons");
        if (!container) return;
        
        container.innerHTML = "";
        
        if (!state.availableDivisions?.length) {
            container.innerHTML = `
                <p class="muted">
                    No grades yet. <a href="campistry_me.html" style="color:#7C3AED; font-weight:600;">Open Campistry Me</a> to create divisions, grades, and bunks.
                </p>
            `;
            renderDivisionDetailPane();
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        // ★ v5.1: Group grades by parent division
        const groupOrder = Object.keys(state.divisionGroups);
        
        groupOrder.forEach(parentDivName => {
            const group = state.divisionGroups[parentDivName];
            if (!group || !group.grades?.length) return;
            
            // Parent division header (only show if there are real named groups)
            if (parentDivName !== "All") {
                const groupHeader = document.createElement("div");
                groupHeader.className = "parent-division-label";
                groupHeader.innerHTML = `
                    <span class="parent-division-dot" style="background-color:${escapeHtml(group.color)};"></span>
                    ${escapeHtml(parentDivName)}
                `;
                fragment.appendChild(groupHeader);
            }
            
            // Grade cards within this parent division
            group.grades.forEach(gradeName => {
                const divObj = state.divisions[gradeName];
                if (!divObj) return;
                
                let totalKids = 0;
                (divObj.bunks || []).forEach(b => {
                    totalKids += state.bunkMetaData[b]?.size || 0;
                });
                
                const card = document.createElement("div");
                card.className = "division-card";
                if (state.selectedDivision === gradeName) {
                    card.classList.add("selected");
                }
                
                card.addEventListener("click", () => {
                    state.selectedDivision = gradeName;
                    saveData();
                    setupDivisionButtons();
                    renderDivisionDetailPane();
                });
                
                const color = divObj.color || DEFAULT_COLORS[0];
                const bunkCount = (divObj.bunks || []).length;
                
                card.innerHTML = `
                    <div class="division-card-top">
                        <div class="division-pill" style="background-color:${escapeHtml(color)}">
                            ${escapeHtml(gradeName)}
                        </div>
                    </div>
                    <div class="division-card-subline">
                        ${bunkCount} bunk${bunkCount !== 1 ? 's' : ''} · <strong>${totalKids}</strong> camper${totalKids !== 1 ? 's' : ''}
                    </div>
                `;
                
                fragment.appendChild(card);
            });
        });
        
        container.appendChild(fragment);
        renderDivisionDetailPane();
    }
    
    /**
     * Render grade detail pane — times are editable, structure is read-only
     */
    function renderDivisionDetailPane() {
        const pane = document.getElementById("division-detail-pane");
        if (!pane) return;
        
        pane.innerHTML = "";
        
        if (!state.selectedDivision || !state.divisions[state.selectedDivision]) {
            pane.innerHTML = `
                <p class="muted">
                    Click a grade on the left to set its <strong>times</strong>
                    and view its <strong>bunks</strong>.
                </p>
            `;
            return;
        }
        
        const gradeName = state.selectedDivision;
        const divObj = state.divisions[gradeName];
        const color = divObj.color || DEFAULT_COLORS[0];
        const parentDiv = divObj.parentDivision || "";
        
        let totalKids = 0;
        (divObj.bunks || []).forEach(b => { totalKids += state.bunkMetaData[b]?.size || 0; });
        
        const bunkCount = (divObj.bunks || []).length;
        const timesSummary = divObj.startTime && divObj.endTime
            ? `${divObj.startTime} – ${divObj.endTime}` : "Times not set";
        
        // ====== HEADER ======
        pane.innerHTML = `
            <div class="detail-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #E5E7EB; padding-bottom:8px; margin-bottom:10px; column-gap:12px;">
                <h3 style="margin:0; font-size:1rem; font-weight:600; color:#111827;">
                    Grade Details
                </h3>
                ${parentDiv ? `<span style="font-size:0.78rem; color:#9CA3AF; font-weight:400;">Division: <strong style="color:#6B7280;">${escapeHtml(parentDiv)}</strong></span>` : ''}
            </div>
            
            <div class="division-color-row">
                <span>Color${parentDiv ? ` (from ${escapeHtml(parentDiv)})` : ''}</span>
                <div style="width:24px; height:24px; border-radius:6px; background-color:${escapeHtml(color)}; border:1px solid rgba(15,23,42,0.12);"></div>
            </div>
            
            <div class="division-edit-shell">
                <div class="division-edit-header">
                    <div class="division-header-left">
                        <span class="division-status-dot" style="background-color:${escapeHtml(color)}; box-shadow:0 0 0 4px ${escapeHtml(color)}33;"></span>
                        <span class="division-name">${escapeHtml(gradeName)}</span>
                    </div>
                    <div class="division-header-summary">
                        ${bunkCount} bunk${bunkCount !== 1 ? 's' : ''} · <strong>${totalKids}</strong> camper${totalKids !== 1 ? 's' : ''} · ${escapeHtml(timesSummary)}
                    </div>
                </div>
                
                <div class="division-edit-grid">
                    <!-- TIMES CARD (editable) -->
                    <div class="division-mini-card">
                        <div class="division-mini-header"><span>Grade Times</span></div>
                        <p class="division-mini-help">Set the daily time window for this grade.</p>
                        <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
                            <input id="time-start-input" value="${escapeHtml(divObj.startTime || "")}" placeholder="9:00am" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                            <span style="color:#9CA3AF;">to</span>
                            <input id="time-end-input" value="${escapeHtml(divObj.endTime || "")}" placeholder="4:00pm" style="width:80px; padding:4px 8px; border-radius:8px; border:1px solid #D1D5DB; font-size:0.85rem;">
                            <button id="save-times-btn" style="background:#111827; color:white; border:none; padding:5px 14px; border-radius:8px; font-size:0.8rem; cursor:pointer; font-weight:500;">Save Times</button>
                            ${parentDiv ? `<button id="apply-times-all-btn" style="background:#F3F4F6; color:#374151; border:1px solid #D1D5DB; padding:5px 14px; border-radius:8px; font-size:0.78rem; cursor:pointer; font-weight:500;" title="Apply these times to all grades in ${escapeHtml(parentDiv)}">Apply to All in ${escapeHtml(parentDiv)}</button>` : ''}
                        </div>
                    </div>
                    
                    <!-- BUNKS (read-only) -->
                    <div class="division-mini-card">
                        <div class="division-mini-header"><span>Bunks</span></div>
                        <p class="division-mini-help">Bunks in this grade. <a href="campistry_me.html" style="color:#7C3AED; font-weight:500;">Edit in Campistry Me</a></p>
                        <div id="bunk-list" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;"></div>
                    </div>
                </div>
            </div>
        `;
        
        // ====== WIRE UP: Times ======
        const startInput = pane.querySelector("#time-start-input");
        const endInput = pane.querySelector("#time-end-input");
        const saveTimesBtn = pane.querySelector("#save-times-btn");
        const applyAllBtn = pane.querySelector("#apply-times-all-btn");
        
        const saveTimes = () => {
            divObj.startTime = startInput?.value || "";
            divObj.endTime = endInput?.value || "";
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
        };
        
        saveTimesBtn?.addEventListener("click", saveTimes);
        startInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        endInput?.addEventListener("keydown", (e) => e.key === "Enter" && saveTimes());
        
        // ★ v5.1: "Apply to All in Division" — sets same times for all sibling grades
        applyAllBtn?.addEventListener("click", () => {
            const newStart = startInput?.value || "";
            const newEnd = endInput?.value || "";
            if (!newStart && !newEnd) return;
            
            const group = state.divisionGroups[parentDiv];
            if (!group) return;
            
            group.grades.forEach(siblingGrade => {
                const sibling = state.divisions[siblingGrade];
                if (sibling) {
                    sibling.startTime = newStart;
                    sibling.endTime = newEnd;
                }
            });
            
            syncSpine();
            saveData();
            setupDivisionButtons();
            renderDivisionDetailPane();
        });
        
        // ====== BUNK LIST (read-only pills) ======
        const bunkList = pane.querySelector("#bunk-list");
        if (bunkList) {
            if (!divObj.bunks?.length) {
                bunkList.innerHTML = '<p class="muted">No bunks assigned yet.</p>';
            } else {
                const sorted = [...divObj.bunks].sort(compareBunks);
                sorted.forEach(bunkName => {
                    const meta = state.bunkMetaData[bunkName] || { size: 0 };
                    const pill = document.createElement("span");
                    pill.className = "division-bunk-pill";
                    pill.style.cursor = "default";
                    pill.innerHTML = `
                        ${escapeHtml(bunkName)} 
                        <span class="bunk-size-badge">${meta.size || 0}</span>
                    `;
                    bunkList.appendChild(pill);
                });
            }
        }
    }

    // ==================== PERSISTENCE ====================
    
    function saveData() {
        const app1Data = window.loadGlobalSettings?.()?.app1 || {};
        
        const data = {
            ...app1Data,
            bunks: state.bunks,
            divisions: state.divisions,
            availableDivisions: state.availableDivisions,
            selectedDivision: state.selectedDivision,
            allSports: state.allSports,
            savedSkeletons: state.savedSkeletons,
            skeletonAssignments: state.skeletonAssignments,
            specialActivities: state.specialActivities,
            bunkMetaData: state.bunkMetaData,
            sportMetaData: state.sportMetaData,
            divisionGroups: state.divisionGroups
        };
        
        window.saveGlobalSettings?.("app1", data);
        
        // NOTE: campStructure is NOT written from app1 — Campistry Me owns it
        
        updateWindowApp1();
    }
    
    function loadData() {
        const globalData = window.loadGlobalSettings?.() || {};
        const data = globalData.app1 || {};
        const campStructure = globalData.campStructure || {};
        
        try {
            // ================================================================
            // COLLECT EXISTING TIMES
            // Times may be stored under grade names (new) or old division
            // names (legacy). Collect both for fallback matching.
            // ================================================================
            const existingTimes = {};
            if (data.divisions) {
                Object.entries(data.divisions).forEach(([name, div]) => {
                    if (div?.startTime || div?.endTime) {
                        existingTimes[name] = {
                            startTime: div.startTime || "",
                            endTime: div.endTime || ""
                        };
                    }
                });
            }
            
            // ================================================================
            // ★ SOURCE OF TRUTH: campStructure from Campistry Me
            //
            // KEY CHANGE in v5.1:
            //   Division (e.g. "Juniors") = organizational parent group
            //   Grade (e.g. "1st Grade")  = THE SCHEDULING UNIT
            //
            // state.divisions is now keyed by GRADE name.
            // This means window.divisions, window.availableDivisions,
            // and everything the Master Builder / Daily Adjustments /
            // Scheduler Core reads is now grade-based.
            // ================================================================
            if (Object.keys(campStructure).length > 0) {
                console.log("[app1 v5.1] Loading GRADES as scheduling units from campStructure");
                const gradeBasedDivisions = {};
                const allBunks = [];
                const divGroups = {};
                
                // Detect grade name collisions across parent divisions
                const gradeNameCounts = {};
                Object.entries(campStructure).forEach(([divName, divData]) => {
                    if (typeof divData !== 'object' || divData === null) return;
                    Object.keys(divData.grades || {}).forEach(gradeName => {
                        gradeNameCounts[gradeName] = (gradeNameCounts[gradeName] || 0) + 1;
                    });
                });
                
                Object.entries(campStructure).forEach(([divName, divData]) => {
                    if (typeof divData !== 'object' || divData === null) return;
                    
                    const parentColor = divData.color || getNextUniqueDivisionColor(gradeBasedDivisions);
                    const gradeNames = Object.keys(divData.grades || {});
                    
                    divGroups[divName] = { color: parentColor, grades: [] };
                    
                    gradeNames.forEach(gradeName => {
                        const gradeData = divData.grades[gradeName];
                        const bunks = gradeData.bunks || [];
                        bunks.forEach(b => { if (!allBunks.includes(b)) allBunks.push(b); });
                        
                        // ★ If grade name collides across parent divisions, qualify it
                        const key = gradeNameCounts[gradeName] > 1
                            ? `${divName} > ${gradeName}`
                            : gradeName;
                        
                        if (gradeNameCounts[gradeName] > 1) {
                            console.warn(`[app1 v5.1] Grade "${gradeName}" exists in multiple divisions — using "${key}"`);
                        }
                        
                        // ★ Look up times: qualified key → raw grade name → parent div name → empty
                        const times = existingTimes[key] || existingTimes[gradeName] || existingTimes[divName] || {};
                        
                        gradeBasedDivisions[key] = {
                            startTime: times.startTime || "",
                            endTime: times.endTime || "",
                            bunks: [...bunks].sort(compareBunks),
                            color: parentColor,
                            parentDivision: divName
                        };
                        
                        divGroups[divName].grades.push(key);
                    });
                });
                
                state.divisions = gradeBasedDivisions;
                state.bunks = allBunks;
                state.divisionGroups = divGroups;
                
            } else {
                // ============================================================
                // FALLBACK: No campStructure — use old flat divisions as-is
                // (These ARE the scheduling units already — the old "divisions"
                //  were effectively grades under the old naming convention)
                // ============================================================
                console.log("[app1 v5.1] No campStructure found, falling back to flat divisions");
                const globalDivisions = window.getGlobalDivisions?.() || {};
                const globalBunks = window.getGlobalBunks?.() || [];
                
                if (Object.keys(globalDivisions).length > 0) {
                    state.divisions = deepClone(globalDivisions);
                } else if (data.divisions && Object.keys(data.divisions).length > 0) {
                    state.divisions = deepClone(data.divisions);
                } else {
                    state.divisions = {};
                }
                
                if (globalBunks.length > 0) {
                    state.bunks = deepClone(globalBunks);
                } else if (data.bunks?.length > 0) {
                    state.bunks = deepClone(data.bunks);
                } else {
                    state.bunks = [];
                }
                
                // Validate and fix division data
                const validDivisions = {};
                Object.entries(state.divisions).forEach(([divName, div]) => {
                    if (typeof div !== 'object' || div === null) return;
                    validDivisions[divName] = {
                        startTime: div.startTime || "",
                        endTime: div.endTime || "",
                        bunks: Array.isArray(div.bunks) ? div.bunks : [],
                        color: div.color || getNextUniqueDivisionColor(validDivisions)
                    };
                    sortBunksInPlace(validDivisions[divName].bunks);
                });
                state.divisions = validDivisions;
                
                // Single flat group for legacy mode
                state.divisionGroups = { "All": { color: "#6B7280", grades: Object.keys(state.divisions) } };
            }
            
            // Update derived state
            state.availableDivisions = Object.keys(state.divisions);
            state.specialActivities = data.specialActivities || [];
            state.bunkMetaData = data.bunkMetaData || {};
            state.sportMetaData = data.sportMetaData || {};
            state.selectedDivision = data.selectedDivision || state.availableDivisions[0] || null;
            state.allSports = Array.isArray(data.allSports) ? data.allSports : [...DEFAULT_SPORTS];
            state.savedSkeletons = data.savedSkeletons || {};
            state.skeletonAssignments = data.skeletonAssignments || {};
            
            // Compute bunk sizes from camperRoster if available
            const camperRoster = data.camperRoster || {};
            const bunkCounts = {};
            Object.values(camperRoster).forEach(camper => {
                if (camper?.bunk) {
                    bunkCounts[camper.bunk] = (bunkCounts[camper.bunk] || 0) + 1;
                }
            });
            Object.entries(bunkCounts).forEach(([bunk, count]) => {
                if (!state.bunkMetaData[bunk]) state.bunkMetaData[bunk] = {};
                if (!state.bunkMetaData[bunk].size) {
                    state.bunkMetaData[bunk].size = count;
                }
            });
            
            updateWindowApp1();
            
            // ★ v5.1: Migrate any skeleton events that use old parent-division names
            migrateAllStoredSkeletons();
            
            console.log(`[app1 v5.1] Loaded ${state.availableDivisions.length} grades as scheduling units:`, state.availableDivisions);
            
        } catch (e) {
            console.error("Error loading app1 data:", e);
        }
    }
    
    function updateWindowApp1() {
        window.app1 = {
            get divisions() { return state.divisions; },
            get bunks() { return state.bunks; },
            get availableDivisions() { return state.availableDivisions; },
            startTime: "9:00am",
            endTime: "4:00pm",
            defaultDurations: { ...DEFAULT_DURATIONS },
            increments: 30,
            get activities() { return state.specialActivities; },
            get bunkMetaData() { return state.bunkMetaData; },
            get sportMetaData() { return state.sportMetaData; },
            get divisionGroups() { return state.divisionGroups; }
        };
        
        window.divisions = state.divisions;
        window.availableDivisions = state.availableDivisions;
        window.bunks = state.bunks;
        window.allSports = state.allSports;
    }

    // ==================== INITIALIZATION ====================
    
    function initApp1() {
        ensureSharedSetupStyles();
        loadData();
        
        // ★ v5.1: Hide the division input row (managed in Campistry Me)
        const divisionInput = document.getElementById("divisionInput");
        const addDivisionBtn = document.getElementById("addDivisionBtn");
        if (divisionInput) {
            const fieldRow = divisionInput.closest('.setup-field-row');
            if (fieldRow) fieldRow.style.display = 'none';
        }
        if (addDivisionBtn && !divisionInput) {
            const fieldRow = addDivisionBtn.closest('.setup-field-row');
            if (fieldRow) fieldRow.style.display = 'none';
        }
        
        // Hide the enable color toggle (auto-managed)
        const enableColor = document.getElementById("enableColor");
        if (enableColor) {
            const label = enableColor.closest('label');
            if (label) label.style.display = 'none';
        }
        
        // Style detail pane
        const detailPane = document.getElementById("division-detail-pane");
        if (detailPane) {
            detailPane.classList.add("detail-pane");
            detailPane.style.marginTop = "8px";
        }
        
        // --- Wire up the Erase All Button ---
        const eraseAllBtn = document.getElementById("eraseAllBtn");
        if (eraseAllBtn) {
            const newBtn = eraseAllBtn.cloneNode(true);
            eraseAllBtn.parentNode.replaceChild(newBtn, eraseAllBtn);
            
            newBtn.addEventListener("click", async () => {
                if (!window.AccessControl?.canEraseData?.()) {
                    window.AccessControl?.showPermissionDenied?.('erase all camp data');
                    return;
                }
                if (confirm("⚠️ WARNING: This will delete ALL camp data, divisions, bunks, and schedules.\n\nThis action cannot be undone.\n\nAre you sure?")) {
                    const confirm2 = confirm("Are you absolutely sure? All data will be lost forever.");
                    if (confirm2) {
                        if (window.resetCloudState) {
                            newBtn.textContent = "Erasing...";
                            newBtn.disabled = true;
                            newBtn.style.opacity = "0.7";
                            
                            const success = await window.resetCloudState();
                            
                            if (success) {
                                alert("All data erased successfully.");
                                window.location.reload();
                            } else {
                                alert("Error erasing data from cloud. Please check connection.");
                                newBtn.textContent = "Erase All Camp Data";
                                newBtn.disabled = false;
                                newBtn.style.opacity = "1";
                            }
                        } else {
                            localStorage.clear();
                            window.location.reload();
                        }
                    }
                }
            });
        }
        
        // Initial render
        setupDivisionButtons();
        renderDivisionDetailPane();
        renderCampistryMeLink();
        
        console.log(`[app1] v${VERSION} initialized — grades are scheduling units`);
    }

    // ==================== WINDOW EXPORTS ====================
    
    // Core initialization
    window.initApp1 = initApp1;
    
    // Getters that always return current state
    window.getDivisions = () => state.divisions;
    window.getBunkMetaData = () => state.bunkMetaData;
    window.getSportMetaData = () => state.sportMetaData;
    window.getGlobalSpecialActivities = () => state.specialActivities;
    window.getAllGlobalSports = () => [...state.allSports].sort();
    window.getSavedSkeletons = () => state.savedSkeletons || {};
    window.getSkeletonAssignments = () => state.skeletonAssignments || {};
    
    // ★ v5.1: New exports for parent division awareness
    window.getDivisionGroups = () => state.divisionGroups;
    window.getCampStructure = () => {
        const globalData = window.loadGlobalSettings?.() || {};
        return globalData.campStructure || {};
    };
    window.getParentDivision = (gradeName) => {
        return state.divisions[gradeName]?.parentDivision || null;
    };
    
    // ★ v5.1: Skeleton migration — available to all modules at runtime
    window.migrateSkeletonDivisions = (events) => {
        const result = migrateSkeletonEvents(events);
        return result.events;
    };
    
    // ★ v5.1: Store a divisionNameMap entry (for grade renames)
    //   Call: window.recordDivisionRename("oldName", "newName")
    window.recordDivisionRename = (oldName, newName) => {
        if (!oldName || !newName) return;
        const globalData = window.loadGlobalSettings?.() || {};
        const nameMap = globalData.divisionNameMap || {};
        nameMap[oldName] = newName;
        window.saveGlobalSettings?.("divisionNameMap", nameMap);
        console.log(`[app1] Recorded rename: "${oldName}" → "${newName}"`);
    };
    
    // Setters
    window.addGlobalSport = (sportName) => {
        if (!sportName) return;
        const s = sportName.trim();
        if (s && !state.allSports.find(sp => sp.toLowerCase() === s.toLowerCase())) {
            state.allSports.push(s);
            saveData();
        }
    };

    window.removeGlobalSport = (sportName) => {
        if (!sportName) return;
        const idx = state.allSports.findIndex(sp => 
            sp.toLowerCase() === sportName.toLowerCase()
        );
        if (idx !== -1) {
            state.allSports.splice(idx, 1);
            saveData();
            window.forceSyncToCloud?.();
        }
    };
    
    window.saveSkeleton = (name, skeletonData) => {
        if (!name || !skeletonData) return;
        state.savedSkeletons[name] = skeletonData;
        saveData();
    };
    
    window.deleteSkeleton = (name) => {
        if (!name) return;
        delete state.savedSkeletons[name];
        Object.keys(state.skeletonAssignments).forEach(day => {
            if (state.skeletonAssignments[day] === name) {
                delete state.skeletonAssignments[day];
            }
        });
        saveData();
    };
    
    window.saveSkeletonAssignments = (assignments) => {
        if (!assignments) return;
        state.skeletonAssignments = assignments;
        saveData();
    };
    
    window.saveGlobalSpecialActivities = (updatedActivities) => {
        state.specialActivities = updatedActivities;
        saveData();
    };
    
    // Legacy export — deprecated, structure managed in Campistry Me
    window.addDivisionBunk = (divName, bunkName) => {
        console.warn("[app1] addDivisionBunk is deprecated — manage bunks in Campistry Me");
        return false;
    };
    
    // Color utilities
    window.getNextDivisionColor = getNextDivisionColor;
    window.getNextUniqueDivisionColor = getNextUniqueDivisionColor;
    window.getColorIndex = getColorIndex;
    window.incrementColorIndex = () => setColorIndex(getColorIndex() + 1);
    
    // Initialize window.app1 with getters
    updateWindowApp1();

})();
