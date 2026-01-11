// ============================================================================
// view_schedule_loader_fix.js v3.6 - VISIBILITY & LEAGUE RESTORATION
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    const INCREMENT_MINS = 30;
    
    // MEMORY SHIELD (Prevents Cloud Wipe)
    window.scheduleMemoryShield = { data: null, dateKey: null, timestamp: 0 };
    
    console.log('[ViewScheduleFix] Loading v3.6 (Leagues + Visibility Fix)...');
    
    // --- HELPER: Parse Time ---
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

    // --- HELPER: Regenerate Grid (Smart Start Time) ---
    function regenerateUnifiedTimes(skeleton) {
        let minTime = Infinity, maxTime = 0, found = false;

        // Check Skeleton
        if (skeleton && Array.isArray(skeleton)) {
            skeleton.forEach(b => {
                const s = parseTimeToMinutes(b.startTime);
                const e = parseTimeToMinutes(b.endTime);
                if (s !== null && s < minTime) { minTime = s; found = true; }
                if (e !== null && e > maxTime) { maxTime = e; found = true; }
            });
        }
        // Check Global Divisions (The 11AM Fix)
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

    // --- HELPER: Reset Filters (Force Show 4, 5, 6) ---
    function forceShowAllDivisions() {
        // 1. Reset Internal Filter
        window.currentDivisionFilter = "All";
        
        // 2. Force Checkboxes
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            if (cb.id.toLowerCase().includes('div') || cb.className.toLowerCase().includes('filter')) {
                cb.checked = true;
            }
        });
        
        // 3. Force Show User's Own Divisions
        // If the table rows are hidden by CSS or logic, we try to expose them
        if (window.userSubdivisions) {
             // (Logic handled by app, but we ensure filter doesn't hide them)
        }
    }

    // --- MAIN LOADER ---
    function loadScheduleFromCorrectLocation() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) return false;
            
            const dailyData = JSON.parse(raw);
            let loadedSource = null;

            // 1. SHIELD RESTORE (If Cloud Wiped It)
            if (window.scheduleMemoryShield.dateKey === dateKey && window.scheduleMemoryShield.data) {
                const storageHasData = dailyData[dateKey]?.scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0;
                
                if (!storageHasData) {
                    console.warn("🛡️ [ViewScheduleFix] Cloud wiped data! Restoring...");
                    
                    // Restore to storage
                    if (!dailyData[dateKey]) dailyData[dateKey] = {};
                    dailyData[dateKey].scheduleAssignments = window.scheduleMemoryShield.data;
                    
                    // Restore Leagues too if we have them
                    if (window.scheduleMemoryShield.leagues) {
                        dailyData[dateKey].leagueAssignments = window.scheduleMemoryShield.leagues;
                    }

                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
                    
                    // Push back to cloud
                    if(window.forceSyncToCloud) setTimeout(() => window.forceSyncToCloud(), 1000);
                    
                    // Force repaint
                    setTimeout(() => { 
                        window.scheduleAssignments = window.scheduleMemoryShield.data; 
                        window.leagueAssignments = window.scheduleMemoryShield.leagues;
                        window.updateTable && window.updateTable(); 
                    }, 50);
                }
            }

            // 2. LOAD SCHEDULE ASSIGNMENTS
            if (dailyData[dateKey]?.scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData[dateKey].scheduleAssignments;
                loadedSource = "DATE_FOLDER";
                
                // Update Shield
                window.scheduleMemoryShield.data = window.scheduleAssignments;
                window.scheduleMemoryShield.dateKey = dateKey;
                
            } else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData.scheduleAssignments;
                loadedSource = "ROOT_FALLBACK";
            }

            // 3. LOAD LEAGUE ASSIGNMENTS (The Missing Link)
            // Priority: Date Folder -> Root Folder
            if (dailyData[dateKey]?.leagueAssignments) {
                window.leagueAssignments = dailyData[dateKey].leagueAssignments;
                window.scheduleMemoryShield.leagues = window.leagueAssignments; // Shield it
            } else if (dailyData.leagueAssignments) {
                window.leagueAssignments = dailyData.leagueAssignments;
            }

            // 4. LOAD TIMES
            if (dailyData.unifiedTimes && dailyData.unifiedTimes.length > 0) {
                window.unifiedTimes = dailyData.unifiedTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            } else {
                const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
                const newTimes = regenerateUnifiedTimes(skel);
                if (newTimes) window.unifiedTimes = newTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            }

            // 5. LOAD SKELETON
            const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
            if (skel) window.skeleton = skel;

            return !!loadedSource;

        } catch (e) { console.error(e); return false; }
    }

    // --- INSTALLER ---
    function applyPatches() {
        const runAll = () => {
            loadScheduleFromCorrectLocation();
            forceShowAllDivisions();
            if (window.updateTable) window.updateTable();
        };

        window.reconcileOrRenderSaved = runAll;

        const originalInit = window.initScheduleSystem;
        window.initScheduleSystem = function() {
            runAll();
            if (originalInit) originalInit.call(this);
        };

        // Safety Net
        const originalUpdate = window.updateTable;
        if (originalUpdate) {
            window.updateTable = function() {
                if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
                    loadScheduleFromCorrectLocation();
                }
                originalUpdate.call(this);
            };
        }
        
        // Run Immediately
        runAll();
        // Run again shortly after to catch slow DOM
        setTimeout(runAll, 500);
    }

    if (document.readyState === 'complete') applyPatches();
    else window.addEventListener('load', applyPatches);
    
    // Cloud Listeners
    window.addEventListener('campistry-daily-data-updated', () => {
        console.log("[ViewScheduleFix] Data update detected. Refreshing...");
        loadScheduleFromCorrectLocation();
        forceShowAllDivisions();
        if(window.updateTable) window.updateTable();
    });

})();
