// ============================================================================
// view_schedule_loader_fix.js v3.2 - AGGRESSIVE LOADER
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    const INCREMENT_MINS = 30;
    
    console.log('[ViewScheduleFix] Loading v3.2 (Aggressive Date Loader)...');
    
    // =========================================================================
    // SMART TIME GRID GENERATOR
    // =========================================================================
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

    function regenerateUnifiedTimes(skeleton) {
        console.log('[ViewScheduleFix] Regenerating Smart Grid...');
        let minTime = Infinity, maxTime = 0, found = false;

        // 1. Scan Skeleton
        if (skeleton && Array.isArray(skeleton)) {
            skeleton.forEach(b => {
                const s = parseTimeToMinutes(b.startTime);
                const e = parseTimeToMinutes(b.endTime);
                if (s !== null && s < minTime) { minTime = s; found = true; }
                if (e !== null && e > maxTime) { maxTime = e; found = true; }
            });
        }

        // 2. Scan Global Divisions (The "Anti-11AM" Fix)
        if (window.divisions) {
            Object.values(window.divisions).forEach(div => {
                const s = parseTimeToMinutes(div.startTime);
                const e = parseTimeToMinutes(div.endTime);
                if (s !== null && s < minTime) { minTime = s; found = true; }
                if (e !== null && e > maxTime) { maxTime = e; found = true; }
            });
        }

        if (!found) { minTime = 540; maxTime = 960; } // Default 9am-4pm
        if (maxTime <= minTime) maxTime = minTime + 60;

        const times = [];
        for (let t = minTime; t < maxTime; t += INCREMENT_MINS) {
            let d = new Date(); d.setHours(0,0,0,0);
            const start = new Date(d.getTime() + t*60000);
            const end = new Date(d.getTime() + (t+INCREMENT_MINS)*60000);
            let h = Math.floor(t/60), m = t%60, ap = h>=12?'PM':'AM';
            if(h>12) h-=12; if(h===0) h=12; else if(h===12) ap='PM';
            
            times.push({
                start: start.toISOString(),
                end: end.toISOString(),
                label: `${h}:${String(m).padStart(2,'0')} ${ap}`
            });
        }
        return times;
    }

    // =========================================================================
    // CORE LOADER
    // =========================================================================
    function loadScheduleFromCorrectLocation() {
        // 1. Determine Date Key
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) return false;
            
            const dailyData = JSON.parse(raw);
            let loaded = false;

            // 2. Load Assignments (Priority: Date Key -> Root)
            if (dailyData[dateKey] && dailyData[dateKey].scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData[dateKey].scheduleAssignments;
                console.log(`[ViewScheduleFix] ✅ LOADED from [${dateKey}] (${Object.keys(window.scheduleAssignments).length} bunks)`);
                loaded = true;
            } else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData.scheduleAssignments;
                console.log(`[ViewScheduleFix] ⚠️ LOADED from ROOT (Legacy) (${Object.keys(window.scheduleAssignments).length} bunks)`);
                loaded = true;
            } else {
                console.warn(`[ViewScheduleFix] ❌ No scheduleAssignments found in [${dateKey}] or ROOT.`);
            }

            // 3. Load/Regen Times
            if (dailyData.unifiedTimes && dailyData.unifiedTimes.length > 0) {
                window.unifiedTimes = dailyData.unifiedTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            } else {
                const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
                const newTimes = regenerateUnifiedTimes(skel);
                if (newTimes) window.unifiedTimes = newTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            }

            // 4. Load Skeleton
            const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
            if (skel) window.skeleton = skel;

            // 5. Load League Assignments
            if (dailyData.leagueAssignments) window.leagueAssignments = dailyData.leagueAssignments;

            return loaded;

        } catch (e) {
            console.error("[ViewScheduleFix] Error:", e);
            return false;
        }
    }

    // =========================================================================
    // PATCHING SYSTEM
    // =========================================================================
    function applyPatches() {
        // Patch Init
        const originalInit = window.initScheduleSystem;
        window.initScheduleSystem = function() {
            loadScheduleFromCorrectLocation();
            if (originalInit) originalInit.call(this);
        };

        // Patch Render
        window.reconcileOrRenderSaved = function() {
            loadScheduleFromCorrectLocation();
            if (window.updateTable) window.updateTable();
        };

        // Patch Table Update (Safety Net)
        const originalUpdate = window.updateTable;
        if (originalUpdate) {
            window.updateTable = function() {
                if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
                    console.log("[ViewScheduleFix] Data missing during update, forcing load...");
                    loadScheduleFromCorrectLocation();
                }
                originalUpdate.call(this);
            };
        }
        
        // Initial Load
        loadScheduleFromCorrectLocation();
    }

    // Initialize
    if (document.readyState === 'complete') applyPatches();
    else window.addEventListener('load', applyPatches);
    
    // Listen for updates
    window.addEventListener('campistry-daily-data-updated', () => {
        console.log("[ViewScheduleFix] Data update detected!");
        loadScheduleFromCorrectLocation();
        if(window.updateTable) window.updateTable();
    });

})();
