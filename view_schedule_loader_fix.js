// ============================================================================
// view_schedule_loader_fix.js v5.3 - MIGRATION + NO LEGACY ROOT FALLBACK
// ============================================================================
// FIXED: Migrates ROOT-level skeleton to date-specific (preserves shared structure)
// FIXED: Cleans ROOT-level user data (scheduleAssignments) that causes ghost data
// Data MUST be stored in date-keyed format: data["2026-01-11"].scheduleAssignments
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    console.log('[ViewScheduleFix] Loading v5.3 (MIGRATION + NO LEGACY ROOT FALLBACK)...');
    
    // --- TIME PARSER ---
    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        let s = str.trim().toLowerCase().replace(/[a-z]/g, '');
        const parts = s.split(':');
        let h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) || 0;
        if (str.toLowerCase().includes('pm') && h !== 12) h += 12;
        if (str.toLowerCase().includes('am') && h === 12) h = 0;
        return h * 60 + m;
    }

    // --- GRID REGENERATOR ---
    function regenerateUnifiedTimes(skeleton) {
        console.log('[ViewScheduleFix] Regenerating time grid from skeleton...');
        let minTime = 540, maxTime = 960; // Default 9am-4pm
        let found = false;

        // Scan Skeleton
        if (skeleton && Array.isArray(skeleton)) {
            skeleton.forEach(b => {
                const s = parseTimeToMinutes(b.startTime);
                const e = parseTimeToMinutes(b.endTime);
                if (s !== null) { minTime = Math.min(minTime, s); found = true; }
                if (e !== null) { maxTime = Math.max(maxTime, e); found = true; }
            });
        }
        
        // Scan Divisions
        if (window.divisions) {
            Object.values(window.divisions).forEach(div => {
                const s = parseTimeToMinutes(div.startTime);
                const e = parseTimeToMinutes(div.endTime);
                if (s !== null) { minTime = Math.min(minTime, s); found = true; }
                if (e !== null) { maxTime = Math.max(maxTime, e); found = true; }
            });
        }
        
        if (found && maxTime <= minTime) maxTime = minTime + 60;

        const times = [];
        for (let t = minTime; t < maxTime; t += 30) {
            let d = new Date(); d.setHours(0,0,0,0);
            const start = new Date(d.getTime() + t*60000);
            const end = new Date(d.getTime() + (t+30)*60000);
            let h = Math.floor(t/60), m = t%60, ap = h>=12?'PM':'AM';
            if(h>12) h-=12; if(h===0) h=12; else if(h===12) ap='PM';
            
            times.push({
                start: start.toISOString(),
                end: end.toISOString(),
                label: h + ':' + String(m).padStart(2,'0') + ' ' + ap
            });
        }
        return times;
    }

    // --- REPAIR DIVISIONS ---
    function repairDivisions() {
        if (!window.divisions) window.divisions = {};
        ['1','2','3','4','5','6'].forEach(id => {
            if (!window.divisions[id]) {
                window.divisions[id] = { id: id, name: 'Grade ' + id, bunks: [] };
            }
        });
        window.currentDivisionFilter = "All";
    }

    // --- MIGRATE LEGACY ROOT DATA ---
    // Migrate ROOT-level skeleton to date-specific location (skeleton is SHARED structure)
    // Clean ROOT-level schedule data (user-specific assignments)
    function cleanLegacyRootData(data, dateKey) {
        if (!data) return data;
        
        // Keys that are USER-SPECIFIC and should be cleaned from ROOT
        const userDataKeys = ['scheduleAssignments', 'leagueAssignments'];
        
        // Keys that are SHARED STRUCTURE and should be MIGRATED, not deleted
        const sharedStructureKeys = ['unifiedTimes', 'manualSkeleton', 'skeleton'];
        
        let changed = false;
        
        // Initialize date key if needed
        if (!data[dateKey]) {
            data[dateKey] = {};
        }
        
        // MIGRATE shared structure keys to date-specific location
        for (const key of sharedStructureKeys) {
            if (data[key] !== undefined && data[key] !== null) {
                // Only migrate if date-specific doesn't already have it
                if (!data[dateKey][key] || (Array.isArray(data[dateKey][key]) && data[dateKey][key].length === 0)) {
                    console.log(`[ViewScheduleFix] 📦 Migrating ROOT "${key}" to date ${dateKey}`);
                    data[dateKey][key] = data[key];
                    changed = true;
                }
                // Remove from ROOT after migration
                delete data[key];
                changed = true;
            }
        }
        
        // CLEAN user-specific data from ROOT (don't migrate - it's outdated)
        for (const key of userDataKeys) {
            if (data[key] !== undefined) {
                console.log(`[ViewScheduleFix] 🧹 Removing legacy ROOT key: ${key}`);
                delete data[key];
                changed = true;
            }
        }
        
        if (changed) {
            // Save migrated/cleaned data back
            try {
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(data));
                console.log('[ViewScheduleFix] ✅ Migrated/cleaned legacy ROOT data');
            } catch (e) {
                console.error('[ViewScheduleFix] Failed to save:', e);
            }
        }
        
        return data;
    }

    // --- MAIN LOADER ---
    function loadScheduleFromCorrectLocation() {
        // 1. Determine correct date
        let dateKey = window.currentScheduleDate;
        if (!dateKey) {
            const dateInput = document.getElementById('calendar-date-picker');
            if (dateInput && dateInput.value) {
                dateKey = dateInput.value;
            } else {
                dateKey = new Date().toISOString().split('T')[0];
            }
        }
        
        console.log('[ViewScheduleFix] Loading schedule for date:', dateKey);
        
        const raw = localStorage.getItem(DAILY_DATA_KEY);
        if (!raw) {
            console.log('[ViewScheduleFix] No daily data found in localStorage');
            // Initialize empty state
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            window.unifiedTimes = [];
            window.skeleton = [];
            window.manualSkeleton = [];
            return;
        }
        
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error('[ViewScheduleFix] Failed to parse daily data:', e);
            return;
        }
        
        // ★★★ CRITICAL FIX: Migrate legacy ROOT data (preserve skeleton) ★★★
        data = cleanLegacyRootData(data, dateKey);
        
        // Get date-specific data ONLY (no ROOT fallback!)
        const dateData = data[dateKey] || {};
        
        // 2. Load Assignments - DATE LEVEL ONLY
        if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
            console.log('[ViewScheduleFix] ✅ Loaded assignments from DATE folder:', Object.keys(dateData.scheduleAssignments).length, 'bunks');
        } else {
            // ★★★ NO ROOT FALLBACK - If no date-specific data, it's empty ★★★
            console.log('[ViewScheduleFix] No schedule data for this date');
            window.scheduleAssignments = {};
        }

        // 3. Draft Injection (subdivision schedules)
        if (dateData.subdivisionSchedules) {
            let injected = 0;
            if (!window.scheduleAssignments) window.scheduleAssignments = {};
            
            Object.values(dateData.subdivisionSchedules).forEach(sub => {
                if (sub.scheduleData) {
                    Object.entries(sub.scheduleData).forEach(function(entry) {
                        const bunk = entry[0];
                        const slots = entry[1];
                        if (!window.scheduleAssignments[bunk]) {
                            window.scheduleAssignments[bunk] = slots;
                            injected++;
                        }
                    });
                }
            });
            if (injected > 0) console.log('[ViewScheduleFix] Injected ' + injected + ' bunks from drafts');
        }

        // 4. Times - DATE LEVEL ONLY
        if (dateData.unifiedTimes && dateData.unifiedTimes.length > 0) {
            window.unifiedTimes = dateData.unifiedTimes.map(t => ({
                start: new Date(t.start),
                end: new Date(t.end),
                label: t.label
            }));
            console.log('[ViewScheduleFix] ✅ Loaded unifiedTimes from DATE data:', window.unifiedTimes.length, 'slots');
        } 
        else if (window.unifiedTimes && window.unifiedTimes.length > 0) {
            // Preserve existing memory if valid
            console.log('[ViewScheduleFix] 🛡️ Preserving existing window.unifiedTimes');
        } 
        else {
            // Regenerate from skeleton if available
            const skeleton = dateData.manualSkeleton || dateData.skeleton;
            if (skeleton && skeleton.length > 0) {
                const newTimes = regenerateUnifiedTimes(skeleton);
                if (newTimes && newTimes.length > 0) {
                    window.unifiedTimes = newTimes.map(t => ({
                        start: new Date(t.start),
                        end: new Date(t.end),
                        label: t.label
                    }));
                    console.log('[ViewScheduleFix] ⚠️ Regenerated time grid from skeleton');
                }
            } else {
                window.unifiedTimes = [];
            }
        }

        // 5. Skeleton - DATE LEVEL ONLY
        const dailySkeleton = dateData.manualSkeleton || dateData.skeleton;
        
        if (dailySkeleton && dailySkeleton.length > 0) {
            window.skeleton = dailySkeleton;
            window.manualSkeleton = dailySkeleton;
            console.log('[ViewScheduleFix] ✅ Loaded VISUAL SKELETON from DATE data');
        } else {
            // ★★★ NO ROOT FALLBACK ★★★
            console.log('[ViewScheduleFix] No skeleton for this date');
            window.skeleton = [];
            window.manualSkeleton = [];
        }
        
        // 6. League Assignments - DATE LEVEL ONLY
        if (dateData.leagueAssignments) {
            window.leagueAssignments = dateData.leagueAssignments;
        } else {
            window.leagueAssignments = {};
        }
        
        repairDivisions();
    }

    // --- SETUP ---
    function init() {
        console.log('[ViewScheduleFix] Initializing...');
        
        const run = function() {
            loadScheduleFromCorrectLocation();
            if (window.updateTable) {
                window.updateTable();
            }
        };

        window.reconcileOrRenderSaved = run;
        
        const origInit = window.initScheduleSystem;
        window.initScheduleSystem = function() {
            run();
            if (origInit) origInit.apply(this, arguments);
        };

        const origUpdate = window.updateTable;
        window.updateTable = function() {
            // Force reload if data looks empty or stale
            if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
                loadScheduleFromCorrectLocation();
            }
            if (origUpdate) origUpdate.apply(this, arguments);
        };

        run();
        setTimeout(run, 500); // Late refresh
        
        console.log('[ViewScheduleFix] Initialization complete');
    }

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
    
    window.addEventListener('campistry-daily-data-updated', function() {
        console.log('[ViewScheduleFix] Data update detected');
        loadScheduleFromCorrectLocation();
        if (window.updateTable) window.updateTable();
    });

    // Expose for debugging
    window.ViewScheduleFix = {
        loadScheduleFromCorrectLocation: loadScheduleFromCorrectLocation,
        regenerateUnifiedTimes: regenerateUnifiedTimes,
        repairDivisions: repairDivisions,
        cleanLegacyRootData: cleanLegacyRootData
    };

})();
