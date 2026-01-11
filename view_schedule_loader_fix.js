// ============================================================================
// view_schedule_loader_fix.js v5.0 - PRIORITY & SAFETY FIX
// ============================================================================
// FIXED: Prioritizes Daily Times > Root Times > Existing Window Times
// FIXED: Prevents overwriting valid time grids with generic 30-min defaults
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    console.log('[ViewScheduleFix] Loading v5.0 (Priority Fix)...');
    
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
        console.log('[ViewScheduleFix] ⚠️ Regenerating generic 30-min grid (Fallback active)');
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
        
        // Force Show All (unless restricted by RBAC later)
        window.currentDivisionFilter = "All";
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
            return;
        }
        
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error('[ViewScheduleFix] Failed to parse daily data:', e);
            return;
        }
        
        const dateData = data[dateKey] || {};
        
        // 2. Load Assignments (Priority: Date -> Root)
        if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
            console.log('[ViewScheduleFix] ✅ Loaded assignments from DATE folder');
        } else if (data.scheduleAssignments && Object.keys(data.scheduleAssignments).length > 0) {
            window.scheduleAssignments = data.scheduleAssignments;
            console.log('[ViewScheduleFix] ⚠️ Loaded assignments from ROOT folder (legacy)');
        }

        // 3. Draft Injection
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

        // 4. Times - CRITICAL FIX
        // Priority 1: Daily Unified Times (Correct Grid)
        // Priority 2: Root Unified Times (Legacy Grid)
        // Priority 3: Existing Window Times (Don't overwrite if valid!)
        // Priority 4: Regenerate (Last Resort)
        
        const dailyTimes = dateData.unifiedTimes;
        const rootTimes = data.unifiedTimes;
        
        if (dailyTimes && dailyTimes.length > 0) {
            window.unifiedTimes = dailyTimes.map(t => ({
                start: new Date(t.start),
                end: new Date(t.end),
                label: t.label
            }));
            console.log('[ViewScheduleFix] ✅ Loaded unifiedTimes from DATE data');
        } 
        else if (rootTimes && rootTimes.length > 0) {
            window.unifiedTimes = rootTimes.map(t => ({
                start: new Date(t.start),
                end: new Date(t.end),
                label: t.label
            }));
            console.log('[ViewScheduleFix] ⚠️ Loaded unifiedTimes from ROOT data');
        } 
        else if (window.unifiedTimes && window.unifiedTimes.length > 0) {
            console.log('[ViewScheduleFix] 🛡️ Preserving existing window.unifiedTimes (Safety Check)');
        } 
        else {
            const newTimes = regenerateUnifiedTimes(dateData.skeleton || data.manualSkeleton);
            if (newTimes) {
                window.unifiedTimes = newTimes.map(t => ({
                    start: new Date(t.start),
                    end: new Date(t.end),
                    label: t.label
                }));
                console.log('[ViewScheduleFix] ⚠️ Regenerated default grid');
            }
        }

        // 5. Skeleton & Leagues
        window.skeleton = dateData.skeleton || data.manualSkeleton || window.skeleton;
        window.manualSkeleton = window.skeleton;
        
        if (dateData.leagueAssignments) {
            window.leagueAssignments = dateData.leagueAssignments;
        } else if (data.leagueAssignments) {
            window.leagueAssignments = data.leagueAssignments;
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
        repairDivisions: repairDivisions
    };

})();
