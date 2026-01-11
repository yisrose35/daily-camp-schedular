// ============================================================================
// view_schedule_loader_fix.js v4.1 - SYNTAX FIX
// ============================================================================
// FIXED: Removed errant backticks that were wrapping the entire file
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    console.log('[ViewScheduleFix] Loading v4.1 (Syntax Fix)...');
    
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
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
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
        
        console.log('[ViewScheduleFix] Daily data keys:', Object.keys(data));
        console.log('[ViewScheduleFix] Date data keys:', Object.keys(dateData));
        
        // 1. Load Assignments (Priority: Date -> Root)
        if (dateData.scheduleAssignments && Object.keys(dateData.scheduleAssignments).length > 0) {
            window.scheduleAssignments = dateData.scheduleAssignments;
            console.log('[ViewScheduleFix] ✅ Loaded', Object.keys(dateData.scheduleAssignments).length, 'bunks from DATE folder');
        } else if (data.scheduleAssignments && Object.keys(data.scheduleAssignments).length > 0) {
            window.scheduleAssignments = data.scheduleAssignments;
            console.log('[ViewScheduleFix] ⚠️ Loaded from ROOT folder (legacy)');
        } else {
            console.log('[ViewScheduleFix] ❌ No scheduleAssignments found');
        }

        // 2. Draft Injection (VISIBILITY FIX: Allow ALL roles to see drafts)
        // This ensures Schedulers can see each other's work even if not "finalized"
        if (dateData.subdivisionSchedules) {
            let injected = 0;
            if (!window.scheduleAssignments) window.scheduleAssignments = {};
            
            Object.values(dateData.subdivisionSchedules).forEach(sub => {
                if (sub.scheduleData) {
                    Object.entries(sub.scheduleData).forEach(function(entry) {
                        const bunk = entry[0];
                        const slots = entry[1];
                        // Only inject if missing (Prefer main schedule, fill gaps with drafts)
                        if (!window.scheduleAssignments[bunk]) {
                            window.scheduleAssignments[bunk] = slots;
                            injected++;
                        }
                    });
                }
            });
            if (injected > 0) {
                console.log('[ViewScheduleFix] Injected ' + injected + ' bunks from drafts (Visible to all)');
            }
        }

       // 3. Times
        // FIX: Check dateData (daily) first, then data (root)
        const sourceTimes = dateData.unifiedTimes || data.unifiedTimes;

        if (sourceTimes && sourceTimes.length > 0) {
            window.unifiedTimes = sourceTimes.map(function(t) {
                return {
                    start: new Date(t.start),
                    end: new Date(t.end),
                    label: t.label
                };
            });
            console.log('[ViewScheduleFix] ✅ Loaded unifiedTimes from storage');
        } else {
            console.log('[ViewScheduleFix] ⚠️ Regenerating unifiedTimes (Fallback)');
            const newTimes = regenerateUnifiedTimes(dateData.skeleton || data.manualSkeleton);
            if (newTimes) {
                window.unifiedTimes = newTimes.map(function(t) {
                    return {
                        start: new Date(t.start),
                        end: new Date(t.end),
                        label: t.label
                    };
                });
            }
        }

        // 4. Skeleton & Leagues
        window.skeleton = dateData.skeleton || data.manualSkeleton || window.skeleton;
        window.manualSkeleton = window.skeleton; // Ensure both are set
        
        if (dateData.leagueAssignments) {
            window.leagueAssignments = dateData.leagueAssignments;
        } else if (data.leagueAssignments) {
            window.leagueAssignments = data.leagueAssignments;
        }
        
        repairDivisions();
        
        // Debug output
        console.log('[ViewScheduleFix] Final state:');
        console.log('  - scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
        console.log('  - unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
        console.log('  - skeleton:', (window.skeleton || []).length, 'blocks');
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
