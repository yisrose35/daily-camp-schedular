// ============================================================================
// view_schedule_loader_fix.js v3 - Complete fix for View Schedule loading
// ============================================================================
// Fixes:
// 1. Loads scheduleAssignments from correct date key location
// 2. Regenerates unifiedTimes if missing (required for rendering)
// 3. Loads skeleton/manualSkeleton (required for rendering)
// ============================================================================

(function() {
    'use strict';
    
    const DAILY_DATA_KEY = 'campDailyData_v1';
    const INCREMENT_MINS = 30;
    
    console.log('[ViewScheduleFix] Loading v3 with skeleton support...');
    
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
    // REGENERATE unifiedTimes FROM manualSkeleton
    // =========================================================================
    
    function regenerateUnifiedTimes(skeleton) {
        if (!skeleton || skeleton.length === 0) {
            console.log('[ViewScheduleFix] No skeleton to generate unifiedTimes from');
            return null;
        }
        
        // Find earliest and latest times from skeleton
        let minTime = Infinity, maxTime = 0;
        skeleton.forEach(block => {
            const start = parseTimeToMinutes(block.startTime);
            const end = parseTimeToMinutes(block.endTime);
            if (start !== null && start < minTime) minTime = start;
            if (end !== null && end > maxTime) maxTime = end;
        });
        
        if (minTime === Infinity || maxTime === 0) {
            console.log('[ViewScheduleFix] Could not determine time range from skeleton');
            return null;
        }
        
        console.log(`[ViewScheduleFix] Regenerating unifiedTimes: ${minTime} to ${maxTime} minutes`);
        
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
    // CORE FIX: Proper schedule loading from date key
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
            // STEP 1: Load scheduleAssignments
            // =====================================================================
            
            // Check INSIDE the date key first (correct location)
            if (dailyData[dateKey]?.scheduleAssignments) {
                const scheduleData = dailyData[dateKey].scheduleAssignments;
                const bunkCount = Object.keys(scheduleData).length;
                
                if (bunkCount > 0) {
                    window.scheduleAssignments = scheduleData;
                    console.log(`[ViewScheduleFix] ✅ Loaded ${bunkCount} bunks from [${dateKey}].scheduleAssignments`);
                    loaded = true;
                }
            }
            
            // Fallback: Check root level (legacy location)
            if (!loaded && dailyData.scheduleAssignments) {
                const bunkCount = Object.keys(dailyData.scheduleAssignments).length;
                if (bunkCount > 0) {
                    window.scheduleAssignments = dailyData.scheduleAssignments;
                    console.log(`[ViewScheduleFix] ⚠️ Loaded ${bunkCount} bunks from ROOT (legacy location)`);
                    loaded = true;
                }
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
                console.log(`[ViewScheduleFix] ✅ Loaded ${window.unifiedTimes.length} unifiedTimes slots`);
            } else {
                // Need to regenerate from skeleton
                console.log('[ViewScheduleFix] ⚠️ unifiedTimes missing - regenerating...');
                
                const skeleton = dailyData.manualSkeleton || dailyData[dateKey]?.manualSkeleton;
                const regenerated = regenerateUnifiedTimes(skeleton);
                
                if (regenerated) {
                    // Save to localStorage for future use
                    dailyData.unifiedTimes = regenerated;
                    localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
                    console.log('[ViewScheduleFix] ✅ Saved regenerated unifiedTimes to localStorage');
                    
                    // Load into window
                    window.unifiedTimes = regenerated.map(slot => ({
                        ...slot,
                        start: new Date(slot.start),
                        end: new Date(slot.end)
                    }));
                }
            }
            
            // =====================================================================
            // STEP 3: Load skeleton (CRITICAL FOR RENDERING)
            // =====================================================================
            
            // Try multiple locations for skeleton
            let skeleton = null;
            
            // First try date-specific skeleton
            if (dailyData[dateKey]?.skeleton && dailyData[dateKey].skeleton.length > 0) {
                skeleton = dailyData[dateKey].skeleton;
                console.log(`[ViewScheduleFix] ✅ Loaded skeleton from [${dateKey}].skeleton: ${skeleton.length} blocks`);
            }
            // Then try manualSkeleton at root (most common location)
            else if (dailyData.manualSkeleton && dailyData.manualSkeleton.length > 0) {
                skeleton = dailyData.manualSkeleton;
                console.log(`[ViewScheduleFix] ✅ Loaded skeleton from manualSkeleton: ${skeleton.length} blocks`);
            }
            // Try date-specific manualSkeleton
            else if (dailyData[dateKey]?.manualSkeleton && dailyData[dateKey].manualSkeleton.length > 0) {
                skeleton = dailyData[dateKey].manualSkeleton;
                console.log(`[ViewScheduleFix] ✅ Loaded skeleton from [${dateKey}].manualSkeleton: ${skeleton.length} blocks`);
            }
            
            if (skeleton) {
                window.skeleton = skeleton;
            } else {
                console.log('[ViewScheduleFix] ⚠️ No skeleton found in localStorage');
            }
            
            // =====================================================================
            // STEP 4: Load leagueAssignments
            // =====================================================================
            
            if (dailyData.leagueAssignments) {
                window.leagueAssignments = dailyData.leagueAssignments;
                console.log(`[ViewScheduleFix] ✅ Loaded leagueAssignments for ${Object.keys(dailyData.leagueAssignments).length} divisions`);
            }
            
            return loaded;
            
        } catch (e) {
            console.error('[ViewScheduleFix] Error loading schedule:', e);
            return false;
        }
    }
    
    // =========================================================================
    // PATCH: Override reconcileOrRenderSaved to use correct loader
    // =========================================================================
    
    function patchReconcile() {
        const originalReconcile = window.reconcileOrRenderSaved;
        
        window.reconcileOrRenderSaved = function() {
            console.log('[ViewScheduleFix] Intercepted reconcileOrRenderSaved');
            loadScheduleFromCorrectLocation();
            
            if (typeof window.updateTable === 'function') {
                window.updateTable();
            }
        };
        
        console.log('[ViewScheduleFix] ✅ Patched reconcileOrRenderSaved');
    }
    
    // =========================================================================
    // PATCH: Hook into initScheduleSystem
    // =========================================================================
    
    function patchInitScheduleSystem() {
        const originalInit = window.initScheduleSystem;
        
        if (typeof originalInit === 'function') {
            window.initScheduleSystem = function() {
                console.log('[ViewScheduleFix] Intercepted initScheduleSystem');
                loadScheduleFromCorrectLocation();
                originalInit.call(this);
            };
            
            console.log('[ViewScheduleFix] ✅ Patched initScheduleSystem');
        }
    }
    
    // =========================================================================
    // PATCH: Hook into updateTable to ensure data is loaded
    // =========================================================================
    
    function patchUpdateTable() {
        const originalUpdate = window.updateTable;
        
        if (typeof originalUpdate === 'function') {
            window.updateTable = function() {
                // Check if we have all required data
                const hasSchedule = window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0;
                const hasUnifiedTimes = window.unifiedTimes && window.unifiedTimes.length > 0;
                const hasSkeleton = window.skeleton && window.skeleton.length > 0;
                
                if (!hasSchedule || !hasUnifiedTimes || !hasSkeleton) {
                    console.log('[ViewScheduleFix] updateTable: Missing data, attempting load...');
                    console.log(`  scheduleAssignments: ${hasSchedule}, unifiedTimes: ${hasUnifiedTimes}, skeleton: ${hasSkeleton}`);
                    loadScheduleFromCorrectLocation();
                }
                
                originalUpdate.call(this);
            };
            
            console.log('[ViewScheduleFix] ✅ Patched updateTable');
        }
    }
    
    // =========================================================================
    // Listen for data update events
    // =========================================================================
    
    window.addEventListener('campistry-daily-data-updated', function() {
        console.log('[ViewScheduleFix] Data update event - reloading schedule');
        loadScheduleFromCorrectLocation();
        
        if (typeof window.updateTable === 'function') {
            window.updateTable();
        }
    });
    
    // =========================================================================
    // PUBLIC API
    // =========================================================================
    
    window.ViewScheduleFix = {
        version: '3.0',
        loadSchedule: loadScheduleFromCorrectLocation,
        regenerateUnifiedTimes: function() {
            const raw = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
            const skeleton = raw.manualSkeleton;
            return regenerateUnifiedTimes(skeleton);
        },
        
        forceRefresh: function() {
            loadScheduleFromCorrectLocation();
            if (typeof window.updateTable === 'function') {
                window.updateTable();
            }
        },
        
        debug: function() {
            const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
            console.log('\n=== ViewScheduleFix v3 Debug ===');
            console.log('Date key:', dateKey);
            console.log('window.scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length, 'bunks');
            console.log('window.unifiedTimes:', (window.unifiedTimes || []).length, 'slots');
            console.log('window.skeleton:', (window.skeleton || []).length, 'blocks');
            console.log('window.leagueAssignments:', Object.keys(window.leagueAssignments || {}).length, 'divisions');
            
            try {
                const raw = JSON.parse(localStorage.getItem(DAILY_DATA_KEY) || '{}');
                console.log('\nlocalStorage structure:');
                console.log('  Root keys:', Object.keys(raw));
                console.log('  Root scheduleAssignments:', Object.keys(raw.scheduleAssignments || {}).length, 'bunks');
                console.log('  Root unifiedTimes:', (raw.unifiedTimes || []).length, 'slots');
                console.log('  Root manualSkeleton:', (raw.manualSkeleton || []).length, 'blocks');
                console.log('  [' + dateKey + '] keys:', Object.keys(raw[dateKey] || {}));
                console.log('  [' + dateKey + '].scheduleAssignments:', Object.keys(raw[dateKey]?.scheduleAssignments || {}).length, 'bunks');
            } catch(e) {
                console.error('Debug error:', e);
            }
        }
    };
    
    // =========================================================================
    // INSTALL PATCHES
    // =========================================================================
    
    function installPatches() {
        patchReconcile();
        patchInitScheduleSystem();
        patchUpdateTable();
        
        // Also do an immediate load if we're on the schedule page
        const scheduleTable = document.getElementById('scheduleTable');
        if (scheduleTable) {
            console.log('[ViewScheduleFix] Schedule table found, loading data...');
            loadScheduleFromCorrectLocation();
            
            if (typeof window.updateTable === 'function') {
                setTimeout(() => {
                    window.updateTable();
                }, 100);
            }
        }
    }
    
    // Install when ready
    if (document.readyState === 'complete') {
        installPatches();
    } else {
        window.addEventListener('load', installPatches);
    }
    
    // Also try after delays in case scheduler_ui.js loads late
    setTimeout(installPatches, 100);
    setTimeout(installPatches, 500);
    setTimeout(installPatches, 1000);
    
    console.log('[ViewScheduleFix] Module v3 loaded');
    
})();
