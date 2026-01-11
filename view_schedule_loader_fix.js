// ============================================================================
// view_schedule_loader_fix.js v3.3 - CLOUD DEFENDER EDITION
// ============================================================================
// 1. Smart Grid: Fixes 11:00 AM start time
// 2. Data Recovery: Finds data in Date Folder or Root
// 3. CLOUD SHIELD: Prevents Cloud Sync from wiping your just-generated schedule
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    const INCREMENT_MINS = 30;
    
    // MEMORY SHIELD
    window.scheduleMemoryShield = {
        data: null,
        dateKey: null,
        timestamp: 0
    };
    
    console.log('[ViewScheduleFix] Loading v3.3 (Cloud Defender)...');
    
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
        let minTime = Infinity, maxTime = 0, found = false;

        if (skeleton && Array.isArray(skeleton)) {
            skeleton.forEach(b => {
                const s = parseTimeToMinutes(b.startTime);
                const e = parseTimeToMinutes(b.endTime);
                if (s !== null && s < minTime) { minTime = s; found = true; }
                if (e !== null && e > maxTime) { maxTime = e; found = true; }
            });
        }

        if (window.divisions) {
            Object.values(window.divisions).forEach(div => {
                const s = parseTimeToMinutes(div.startTime);
                const e = parseTimeToMinutes(div.endTime);
                if (s !== null && s < minTime) { minTime = s; found = true; }
                if (e !== null && e > maxTime) { maxTime = e; found = true; }
            });
        }

        if (!found) { minTime = 540; maxTime = 960; }
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
    // CORE LOADER WITH SHIELD
    // =========================================================================
    function loadScheduleFromCorrectLocation() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) return false;
            
            const dailyData = JSON.parse(raw);
            let loadedSource = null;

            // 1. TRY MEMORY SHIELD RESTORE (If storage was wiped)
            if (window.scheduleMemoryShield.dateKey === dateKey && window.scheduleMemoryShield.data) {
                // If storage is empty/missing but Shield has data -> RESTORE IT
                const storageHasData = dailyData[dateKey]?.scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0;
                
                if (!storageHasData) {
                    console.warn("🛡️ [ViewScheduleFix] Cloud wiped data! Restoring from Shield...");
                    if (!dailyData[dateKey]) dailyData[dateKey] = {};
                    dailyData[dateKey].scheduleAssignments = window.scheduleMemoryShield.data;
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
                    
                    // Force push back to cloud to fix server
                    if(window.forceSyncToCloud) setTimeout(() => window.forceSyncToCloud(), 1000);
                }
            }

            // 2. LOAD ASSIGNMENTS
            if (dailyData[dateKey]?.scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData[dateKey].scheduleAssignments;
                loadedSource = "DATE_FOLDER";
                
                // UPDATE SHIELD
                window.scheduleMemoryShield.data = window.scheduleAssignments;
                window.scheduleMemoryShield.dateKey = dateKey;
                window.scheduleMemoryShield.timestamp = Date.now();
                
            } else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData.scheduleAssignments;
                loadedSource = "ROOT_FALLBACK";
            }

            console.log(`[ViewScheduleFix] Loaded schedule from: ${loadedSource || "NONE"}`);

            // 3. LOAD TIMES
            if (dailyData.unifiedTimes && dailyData.unifiedTimes.length > 0) {
                window.unifiedTimes = dailyData.unifiedTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            } else {
                const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
                const newTimes = regenerateUnifiedTimes(skel);
                if (newTimes) window.unifiedTimes = newTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            }

            // 4. LOAD SKELETON
            const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
            if (skel) window.skeleton = skel;

            // 5. LOAD LEAGUE
            if (dailyData.leagueAssignments) window.leagueAssignments = dailyData.leagueAssignments;

            return !!loadedSource;

        } catch (e) {
            console.error("[ViewScheduleFix] Error:", e);
            return false;
        }
    }

    // =========================================================================
    // PATCHING SYSTEM
    // =========================================================================
    function applyPatches() {
        // Patch Render
        window.reconcileOrRenderSaved = function() {
            loadScheduleFromCorrectLocation();
            if (window.updateTable) window.updateTable();
        };

        // Patch Init
        const originalInit = window.initScheduleSystem;
        window.initScheduleSystem = function() {
            loadScheduleFromCorrectLocation();
            if (originalInit) originalInit.call(this);
        };

        // Safety Net Update
        const originalUpdate = window.updateTable;
        if (originalUpdate) {
            window.updateTable = function() {
                if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
                    loadScheduleFromCorrectLocation();
                }
                originalUpdate.call(this);
            };
        }
        
        loadScheduleFromCorrectLocation();
    }

    if (document.readyState === 'complete') applyPatches();
    else window.addEventListener('load', applyPatches);
    
    // Listen for Cloud Updates and Re-Apply Shield
    window.addEventListener('campistry-daily-data-updated', () => {
        console.log("[ViewScheduleFix] Cloud update detected. Re-verifying data...");
        loadScheduleFromCorrectLocation();
        if(window.updateTable) window.updateTable();
    });

})();
