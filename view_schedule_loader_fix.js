// ============================================================================
// view_schedule_loader_fix.js v3.8 - OWNER DRAFT INJECTION
// ============================================================================
// 1. Smart Grid: Fixes 11:00 AM start time
// 2. Data Recovery: Finds data in Date Folder or Root
// 3. Cloud Shield: Prevents auto-wipe
// 4. Division Repair: Forces Div 4, 5, 6 to appear
// 5. DRAFT INJECTION: Auto-merges team drafts for the Owner view
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    const INCREMENT_MINS = 30;
    
    window.scheduleMemoryShield = { data: null, dateKey: null, timestamp: 0 };
    
    console.log('[ViewScheduleFix] Loading v3.8 (Owner Draft Injection)...');
    
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

    // --- HELPER: Regenerate Grid ---
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

    // --- HELPER: Inject Drafts (THE FIX) ---
    function injectDraftsForOwner(dailyData, dateKey) {
        // Only run if Owner/Admin
        const role = window.AccessControl?.getCurrentRole?.();
        if (role !== 'owner' && role !== 'admin') return;

        const drafts = dailyData.subdivisionSchedules || (dailyData[dateKey] ? dailyData[dateKey].subdivisionSchedules : null);
        
        if (drafts) {
            let injectedCount = 0;
            // Initialize scheduleAssignments if missing
            if (!window.scheduleAssignments) window.scheduleAssignments = {};
            
            Object.values(drafts).forEach(sub => {
                if (sub.scheduleData) { // Look for 'scheduleData' inside the draft
                    Object.entries(sub.scheduleData).forEach(([bunk, slots]) => {
                        // Merge logic: Overwrite only if bunk is empty in main schedule
                        if (!window.scheduleAssignments[bunk] || window.scheduleAssignments[bunk].length === 0) {
                            window.scheduleAssignments[bunk] = slots;
                            injectedCount++;
                        }
                    });
                }
            });
            
            if (injectedCount > 0) {
                console.log(`[ViewScheduleFix] 💉 Injected ${injectedCount} bunks from drafts for Owner view`);
            }
        }
    }

    // --- HELPER: Restore Missing Divisions ---
    function repairDivisions() {
        if (!window.scheduleAssignments) return;
        if (!window.divisions) window.divisions = {};
        
        const requiredDivisions = ['1', '2', '3', '4', '5', '6'];
        requiredDivisions.forEach(divId => {
            if (!window.divisions[divId]) {
                window.divisions[divId] = {
                    id: divId,
                    name: (divId.length === 1 ? `Grade ${divId}` : divId),
                    bunks: [],
                    startTime: '9:00 AM',
                    endTime: '4:00 PM'
                };
            }
        });
        
        // Force Show All
        window.currentDivisionFilter = "All";
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            if (cb.id.toLowerCase().includes('div') || cb.className.toLowerCase().includes('filter')) {
                cb.checked = true;
            }
        });
    }

    // --- MAIN LOADER ---
    function loadScheduleFromCorrectLocation() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) return false;
            
            const dailyData = JSON.parse(raw);
            let loadedSource = null;

            // 1. SHIELD RESTORE
            if (window.scheduleMemoryShield.dateKey === dateKey && window.scheduleMemoryShield.data) {
                const storageHasData = dailyData[dateKey]?.scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0;
                
                if (!storageHasData) {
                    console.warn("🛡️ [ViewScheduleFix] Cloud wiped data! Restoring...");
                    if (!dailyData[dateKey]) dailyData[dateKey] = {};
                    dailyData[dateKey].scheduleAssignments = window.scheduleMemoryShield.data;
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
                    if(window.forceSyncToCloud) setTimeout(() => window.forceSyncToCloud(), 1000);
                    
                    setTimeout(() => { 
                        window.scheduleAssignments = window.scheduleMemoryShield.data; 
                        injectDraftsForOwner(dailyData, dateKey); // <--- Inject
                        repairDivisions(); 
                        window.updateTable && window.updateTable(); 
                    }, 50);
                }
            }

            // 2. LOAD SCHEDULE
            if (dailyData[dateKey]?.scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData[dateKey].scheduleAssignments;
                loadedSource = "DATE_FOLDER";
                window.scheduleMemoryShield.data = window.scheduleAssignments;
                window.scheduleMemoryShield.dateKey = dateKey;
            } else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData.scheduleAssignments;
                loadedSource = "ROOT_FALLBACK";
            }

            // 3. INJECT DRAFTS (The new magic step)
            injectDraftsForOwner(dailyData, dateKey);

            // 4. LOAD LEAGUES
            if (dailyData[dateKey]?.leagueAssignments) {
                window.leagueAssignments = dailyData[dateKey].leagueAssignments;
                window.scheduleMemoryShield.leagues = window.leagueAssignments;
            } else if (dailyData.leagueAssignments) {
                window.leagueAssignments = dailyData.leagueAssignments;
            }

            // 5. TIMES & SKELETON
            if (dailyData.unifiedTimes && dailyData.unifiedTimes.length > 0) {
                window.unifiedTimes = dailyData.unifiedTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            } else {
                const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
                const newTimes = regenerateUnifiedTimes(skel);
                if (newTimes) window.unifiedTimes = newTimes.map(t => ({...t, start: new Date(t.start), end: new Date(t.end)}));
            }
            const skel = dailyData[dateKey]?.skeleton || dailyData.manualSkeleton;
            if (skel) window.skeleton = skel;

            return !!loadedSource;

        } catch (e) { console.error(e); return false; }
    }

    // --- INSTALLER ---
    function applyPatches() {
        const runAll = () => {
            loadScheduleFromCorrectLocation();
            repairDivisions();
            if (window.updateTable) window.updateTable();
        };

        window.reconcileOrRenderSaved = runAll;

        const originalInit = window.initScheduleSystem;
        window.initScheduleSystem = function() {
            runAll();
            if (originalInit) originalInit.call(this);
        };

        const originalUpdate = window.updateTable;
        if (originalUpdate) {
            window.updateTable = function() {
                if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
                    loadScheduleFromCorrectLocation();
                }
                repairDivisions();
                originalUpdate.call(this);
            };
        }
        
        runAll();
        setTimeout(runAll, 800);
    }

    if (document.readyState === 'complete') applyPatches();
    else window.addEventListener('load', applyPatches);
    
    window.addEventListener('campistry-daily-data-updated', () => {
        console.log("[ViewScheduleFix] Data update detected. Refreshing...");
        loadScheduleFromCorrectLocation();
        repairDivisions();
        if(window.updateTable) window.updateTable();
    });

})();
