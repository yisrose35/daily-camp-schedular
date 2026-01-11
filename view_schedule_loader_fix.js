// ============================================================================
// view_schedule_loader_fix.js v3.1 - Smart Grid & Data Recovery
// ============================================================================
// Fixes:
// 1. "Smart Grid": Checks GLOBAL DIVISIONS for start/end times (fixes 11am bug)
// 2. "Data Recovery": Auto-detects if data is in ROOT or DATE key
// 3. "Auto-Patching": Hooks into all system render calls
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    const INCREMENT_MINS = 30;
    
    console.log('[ViewScheduleFix] Loading v3.1 with Smart Grid support...');
    
    // =========================================================================
    // TIME PARSING HELPER
    // =========================================================================
    
    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        let s = str.trim().toLowerCase();
        let mer = s.endsWith('am') ? 'am' : s.endsWith('pm') ? 'pm' : null;
        if (!mer) return null;
        s = s.replace(/am|pm/g, '').trim();
        const m = s.match(/^(\d{1,2})\s*[:]\s*(\d{2})$/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (h === 12) h = (mer === 'am' ? 0 : 12);
        else if (mer === 'pm') h += 12;
        return h * 60 + mm;
    }
    
    // =========================================================================
    // REGENERATE unifiedTimes (SMART VERSION)
    // =========================================================================
    
    function regenerateUnifiedTimes(skeleton) {
        console.log('[ViewScheduleFix] Regenerating unifiedTimes (Smart Mode)...');
        
        let minTime = Infinity;
        let maxTime = 0;
        let foundData = false;

        // 1. Check Skeleton (Current working blocks)
        if (skeleton && skeleton.length > 0) {
            skeleton.forEach(block => {
                const start = parseTimeToMinutes(block.startTime);
                const end = parseTimeToMinutes(block.endTime);
                if (start !== null && start < minTime) { minTime = start; foundData = true; }
                if (end !== null && end > maxTime) { maxTime = end; foundData = true; }
            });
        }

        // 2. Check Global Divisions (CRITICAL FIX)
        // This checks your settings to find the "True" start time (e.g. 9:00 AM)
        if (window.divisions) {
            Object.values(window.divisions).forEach(div => {
                const s = parseTimeToMinutes(div.startTime);
                const e = parseTimeToMinutes(div.endTime);
                if (s !== null && s < minTime) { minTime = s; foundData = true; }
                if (e !== null && e > maxTime) { maxTime = e; foundData = true; }
            });
        }

        // 3. Defaults if nothing found
        if (!foundData) {
            console.log('[ViewScheduleFix] No time data found, using defaults (9am-4pm)');
            minTime = 540; // 9:00 AM
            maxTime = 960; // 4:00 PM
        }

        // Buffer: Ensure we don't start/end too tight if using strict skeleton
        if (maxTime <= minTime) maxTime = minTime + 60;

        console.log(`[ViewScheduleFix] Time Range Calculated: ${minTime} (${Math.floor(minTime/60)}:${minTime%60}) to ${maxTime}`);
        
        // Generate unified time slots
        const baseDate = new Date();
        baseDate.setHours(0, 0, 0, 0);
        
        const unifiedTimes = [];
        for (let t = minTime; t < maxTime; t += INCREMENT_MINS) {
            const startDate = new Date(baseDate.getTime() + t * 60000);
            const endDate = new Date(baseDate.getTime() + (t + INCREMENT_MINS) * 60000);
            const hour = Math.floor(t / 60);
            const minute = t % 60;
            const hour12 = hour % 12 || 12;
            const ampm = hour >= 12 ? 'PM' : 'AM';
            
            unifiedTimes.push({
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                label: `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`
            });
        }
        
        console.log(`[ViewScheduleFix] ✅ Generated ${unifiedTimes.length} time slots`);
        return unifiedTimes;
    }
    
    // =========================================================================
    // CORE FIX: Proper schedule loading from date key OR root
    // =========================================================================
    
    function loadScheduleFromCorrectLocation() {
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        console.log(`[ViewScheduleFix] Loading schedule for ${dateKey}...`);
        
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (!raw) {
                console.log('[ViewScheduleFix] No localStorage data');
                return false;
            }
            
            const dailyData = JSON.parse(raw);
            let loaded = false;
            
            // =====================================================================
            // STEP 1: Load scheduleAssignments (Date Key -> Root Fallback)
            // =====================================================================
            
            // 1A. Check Date Key (Preferred)
            if (dailyData[dateKey]?.scheduleAssignments && Object.keys(dailyData[dateKey].scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData[dateKey].scheduleAssignments;
                console.log(`[ViewScheduleFix] ✅ Loaded bunks from [${dateKey}].scheduleAssignments`);
                loaded = true;
            }
            // 1B. Check Root (Legacy/Fallback)
            else if (dailyData.scheduleAssignments && Object.keys(dailyData.scheduleAssignments).length > 0) {
                window.scheduleAssignments = dailyData.scheduleAssignments;
                console.log(`[ViewScheduleFix] ⚠️ Loaded bunks from ROOT (legacy location)`);
                loaded = true;
            }
            
            // =====================================================================
            // STEP 2: Load or regenerate unifiedTimes
            // =====================================================================
            
            if (dailyData.unifiedTimes && dailyData.unifiedTimes.length > 0) {
                window.unifiedTimes = dailyData.unifiedTimes.map(slot => ({
                    ...slot,
                    start: new Date(slot.start),
                    end: new Date(slot.end)
                }));
                console.log(`[ViewScheduleFix] ✅ Loaded ${window.unifiedTimes.length} unifiedTimes slots from storage`);
            } else {
                console.log('[ViewScheduleFix] ⚠️ unifiedTimes missing - regenerating...');
                const skeleton = dailyData.manualSkeleton || dailyData[dateKey]?.manualSkeleton;
                
                // Use the new SMART regenerator
                const regenerated = regenerateUnifiedTimes(skeleton);
                
                if (regenerated) {
                    dailyData.unifiedTimes = regenerated;
                    // Only save if we actually found data, to avoid empty overwrites
                    if(regenerated.length > 0) {
                        localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
                        console.log('[ViewScheduleFix] ✅ Saved regenerated unifiedTimes to localStorage');
                    }
                    
                    window.unifiedTimes = regenerated.map(slot => ({
                        ...slot,
                        start: new Date(slot.start),
                        end: new Date(slot.end)
                    }));
                }
            }
            
            // =====================================================================
            // STEP 3: Load skeleton
            // =====================================================================
            
            let skeleton = 
                dailyData[dateKey]?.skeleton || 
                dailyData.manualSkeleton || 
                dailyData[dateKey]?.manualSkeleton;
            
            if (skeleton && skeleton.length > 0) {
                window.skeleton = skeleton;
                console.log(`[ViewScheduleFix] ✅ Loaded skeleton: ${skeleton.length} blocks`);
            } else {
                console.log('[ViewScheduleFix] ⚠️ No skeleton found in localStorage');
            }
            
            // =====================================================================
            // STEP 4: Load leagueAssignments
            // =====================================================================
            
            if (dailyData.leagueAssignments) {
                window.leagueAssignments = dailyData.leagueAssignments;
            }
            
            return loaded;
            
        } catch (e) {
            console.error('[ViewScheduleFix] Error loading schedule:', e);
            return false;
        }
    }
    
    // =========================================================================
    // PATCHES: Hook into system
    // =========================================================================
    
    function installPatches() {
        // Patch Reconcile
        window.reconcileOrRenderSaved = function() {
            console.log('[ViewScheduleFix] Intercepted reconcileOrRenderSaved');
            loadScheduleFromCorrectLocation();
            if (typeof window.updateTable === 'function') window.updateTable();
        };

        // Patch Init
        const originalInit = window.initScheduleSystem;
        if (typeof originalInit === 'function') {
            window.initScheduleSystem = function() {
                console.log('[ViewScheduleFix] Intercepted initScheduleSystem');
                loadScheduleFromCorrectLocation();
                originalInit.call(this);
            };
        }

        // Patch UpdateTable (Fail-safe)
        const originalUpdate = window.updateTable;
        if (typeof originalUpdate === 'function') {
            window.updateTable = function() {
                if (!window.scheduleAssignments || !window.unifiedTimes) {
                    console.log('[ViewScheduleFix] updateTable: Missing data, attempting load...');
                    loadScheduleFromCorrectLocation();
                }
                originalUpdate.call(this);
            };
        }
        
        // Immediate Load
        const scheduleTable = document.getElementById('scheduleTable');
        if (scheduleTable) {
            console.log('[ViewScheduleFix] Schedule table found, loading data...');
            loadScheduleFromCorrectLocation();
            if (typeof window.updateTable === 'function') {
                setTimeout(() => window.updateTable(), 100);
            }
        }
    }
    
    // Install
    if (document.readyState === 'complete') installPatches();
    else window.addEventListener('load', installPatches);
    
    // Public API
    window.ViewScheduleFix = {
        version: '3.1',
        loadSchedule: loadScheduleFromCorrectLocation,
        regenerateUnifiedTimes: regenerateUnifiedTimes
    };
    
    console.log('[ViewScheduleFix] Module v3.1 loaded');
})();
