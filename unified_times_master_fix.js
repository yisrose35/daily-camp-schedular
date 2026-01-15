// =============================================================================
// CAMPISTRY UNIFIED TIMES PERSISTENCE FIX v2.0
// =============================================================================
//
// ROOT CAUSE IDENTIFIED:
// The scheduler creates window.unifiedTimes during generation, but NO CODE
// ever saves it to localStorage! The saveToLocalStorage functions only save
// scheduleAssignments and leagueAssignments.
//
// THIS FIX:
// 1. Uses a DEDICATED localStorage key for unifiedTimes (not campDailyData_v1)
// 2. Hooks into EVERY possible save trigger to capture unifiedTimes
// 3. Loads unifiedTimes IMMEDIATELY on startup, before ANY render
// 4. Prevents buildUnifiedTimesFromSkeleton from overwriting valid data
//
// =============================================================================

(function() {
    'use strict';

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('⏰ UNIFIED TIMES PERSISTENCE FIX v2.0');
    console.log('═══════════════════════════════════════════════════════════════════════');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    // Dedicated storage key - separate from campDailyData_v1 to avoid conflicts
    const UNIFIED_TIMES_KEY = 'campistry_unifiedTimes_v1';
    const DAILY_DATA_KEY = 'campDailyData_v1';
    
    // =========================================================================
    // UTILITIES
    // =========================================================================

    function getDateKey() {
        return window.currentScheduleDate || 
               document.getElementById('calendar-date-picker')?.value ||
               document.getElementById('schedule-date-input')?.value ||
               new Date().toISOString().split('T')[0];
    }

    function serializeUnifiedTimes(times) {
        if (!times || !Array.isArray(times) || times.length === 0) return null;
        return times.map(t => {
            const startDate = t.start instanceof Date ? t.start : new Date(t.start);
            const endDate = t.end instanceof Date ? t.end : new Date(t.end);
            return {
                start: startDate.toISOString(),
                end: endDate.toISOString(),
                startMin: t.startMin ?? (startDate.getHours() * 60 + startDate.getMinutes()),
                endMin: t.endMin ?? (endDate.getHours() * 60 + endDate.getMinutes()),
                label: t.label || ''
            };
        });
    }

    function deserializeUnifiedTimes(times) {
        if (!times || !Array.isArray(times) || times.length === 0) return null;
        return times.map(t => {
            const startDate = t.start instanceof Date ? t.start : new Date(t.start);
            const endDate = t.end instanceof Date ? t.end : new Date(t.end);
            return {
                start: startDate,
                end: endDate,
                startMin: t.startMin ?? (startDate.getHours() * 60 + startDate.getMinutes()),
                endMin: t.endMin ?? (endDate.getHours() * 60 + endDate.getMinutes()),
                label: t.label || ''
            };
        });
    }

    // Check if this is the generic 30-min grid (bad) vs scheduler-generated (good)
    function isGeneric30MinGrid(times) {
        if (!times || times.length < 3) return true; // Empty/small = treat as generic
        for (let i = 1; i < times.length; i++) {
            const prev = times[i-1].startMin ?? 0;
            const curr = times[i].startMin ?? 0;
            if ((curr - prev) !== 30) return false; // Has non-30-min gap = scheduler-generated
        }
        return true; // All 30-min gaps = generic grid
    }

    // =========================================================================
    // CORE: SAVE UNIFIEDTIMES
    // =========================================================================

    function saveUnifiedTimes(dateKey, times) {
        if (!times || times.length === 0) {
            console.log('[UTFix] Nothing to save - unifiedTimes is empty');
            return false;
        }

        dateKey = dateKey || getDateKey();
        
        try {
            // Load existing storage
            const raw = localStorage.getItem(UNIFIED_TIMES_KEY);
            const storage = raw ? JSON.parse(raw) : {};
            
            // Serialize and save
            const serialized = serializeUnifiedTimes(times);
            if (!serialized) {
                console.log('[UTFix] Serialization failed');
                return false;
            }
            
            storage[dateKey] = {
                times: serialized,
                slotCount: times.length,
                savedAt: new Date().toISOString(),
                isGeneric: isGeneric30MinGrid(times)
            };
            
            localStorage.setItem(UNIFIED_TIMES_KEY, JSON.stringify(storage));
            
            console.log(`[UTFix] ✅ SAVED unifiedTimes for ${dateKey}: ${times.length} slots, generic=${storage[dateKey].isGeneric}`);
            
            // ALSO save to campDailyData_v1 for redundancy
            try {
                const dailyRaw = localStorage.getItem(DAILY_DATA_KEY);
                const dailyData = dailyRaw ? JSON.parse(dailyRaw) : {};
                if (!dailyData[dateKey]) dailyData[dateKey] = {};
                dailyData[dateKey].unifiedTimes = serialized;
                dailyData[dateKey].slotCount = times.length;
                localStorage.setItem(DAILY_DATA_KEY, JSON.stringify(dailyData));
                console.log(`[UTFix] ✅ Also saved to campDailyData_v1`);
            } catch (e) {
                console.warn('[UTFix] Failed to save to campDailyData_v1:', e);
            }
            
            return true;
        } catch (err) {
            console.error('[UTFix] Save error:', err);
            return false;
        }
    }

    // =========================================================================
    // CORE: LOAD UNIFIEDTIMES
    // =========================================================================

    function loadUnifiedTimes(dateKey) {
        dateKey = dateKey || getDateKey();
        
        try {
            // Try dedicated storage first
            const raw = localStorage.getItem(UNIFIED_TIMES_KEY);
            if (raw) {
                const storage = JSON.parse(raw);
                const dateData = storage[dateKey];
                
                if (dateData?.times && dateData.times.length > 0 && !dateData.isGeneric) {
                    const times = deserializeUnifiedTimes(dateData.times);
                    if (times && times.length > 0) {
                        console.log(`[UTFix] ✅ LOADED unifiedTimes for ${dateKey}: ${times.length} slots from dedicated storage`);
                        return times;
                    }
                }
            }
            
            // Fallback: try campDailyData_v1
            const dailyRaw = localStorage.getItem(DAILY_DATA_KEY);
            if (dailyRaw) {
                const dailyData = JSON.parse(dailyRaw);
                const dateData = dailyData[dateKey];
                
                if (dateData?.unifiedTimes && dateData.unifiedTimes.length > 0) {
                    const times = deserializeUnifiedTimes(dateData.unifiedTimes);
                    if (times && times.length > 0 && !isGeneric30MinGrid(times)) {
                        console.log(`[UTFix] ✅ LOADED unifiedTimes for ${dateKey}: ${times.length} slots from campDailyData`);
                        return times;
                    }
                }
            }
            
            console.log(`[UTFix] No valid unifiedTimes found for ${dateKey}`);
            return null;
        } catch (err) {
            console.error('[UTFix] Load error:', err);
            return null;
        }
    }

    // =========================================================================
    // CORE: APPLY UNIFIEDTIMES TO WINDOW
    // =========================================================================

    function applyUnifiedTimes(times) {
        if (!times || times.length === 0) return false;
        
        const current = window.unifiedTimes || [];
        const currentIsGeneric = isGeneric30MinGrid(current);
        const newIsGeneric = isGeneric30MinGrid(times);
        
        // Only apply if: current is empty, current is generic, or new has more slots
        if (current.length === 0 || currentIsGeneric || times.length > current.length) {
            console.log(`[UTFix] Applying unifiedTimes: ${current.length} (generic=${currentIsGeneric}) → ${times.length} (generic=${newIsGeneric})`);
            window.unifiedTimes = times;
            window._unifiedTimesFromStorage = true;
            window._unifiedTimesLoadedAt = Date.now();
            return true;
        }
        
        console.log(`[UTFix] Keeping current unifiedTimes: ${current.length} slots`);
        return false;
    }

    // =========================================================================
    // HOOK: GENERATION COMPLETE
    // =========================================================================

    function hookGenerationComplete() {
        // Listen for generation complete event
        window.addEventListener('campistry-generation-complete', () => {
            console.log('[UTFix] Generation complete - saving unifiedTimes...');
            setTimeout(() => {
                const times = window.unifiedTimes;
                if (times && times.length > 0 && !isGeneric30MinGrid(times)) {
                    saveUnifiedTimes(getDateKey(), times);
                } else {
                    console.log('[UTFix] unifiedTimes is empty or generic after generation');
                }
            }, 100);
        });
        
        console.log('[UTFix] ✅ Hooked generation complete event');
    }

    // =========================================================================
    // HOOK: SAVE TRIGGERS
    // =========================================================================

    function hookSaveTriggers() {
        // Hook saveCurrentDailyData
        const hookSaveCurrentDailyData = () => {
            const original = window.saveCurrentDailyData;
            if (original && !original._utfixHooked) {
                window.saveCurrentDailyData = function(...args) {
                    // Save unifiedTimes whenever any data is saved
                    const times = window.unifiedTimes;
                    if (times && times.length > 0 && !isGeneric30MinGrid(times)) {
                        saveUnifiedTimes(getDateKey(), times);
                    }
                    return original.apply(this, args);
                };
                window.saveCurrentDailyData._utfixHooked = true;
                console.log('[UTFix] ✅ Hooked saveCurrentDailyData');
            }
        };
        
        // Hook forceSyncToCloud
        const hookForceSyncToCloud = () => {
            const original = window.forceSyncToCloud;
            if (original && !original._utfixHooked) {
                window.forceSyncToCloud = async function(...args) {
                    // Save unifiedTimes before cloud sync
                    const times = window.unifiedTimes;
                    if (times && times.length > 0 && !isGeneric30MinGrid(times)) {
                        saveUnifiedTimes(getDateKey(), times);
                    }
                    return original.apply(this, args);
                };
                window.forceSyncToCloud._utfixHooked = true;
                console.log('[UTFix] ✅ Hooked forceSyncToCloud');
            }
        };
        
        // Try immediately and with delays
        hookSaveCurrentDailyData();
        hookForceSyncToCloud();
        
        setTimeout(() => { hookSaveCurrentDailyData(); hookForceSyncToCloud(); }, 100);
        setTimeout(() => { hookSaveCurrentDailyData(); hookForceSyncToCloud(); }, 500);
        setTimeout(() => { hookSaveCurrentDailyData(); hookForceSyncToCloud(); }, 1000);
        setTimeout(() => { hookSaveCurrentDailyData(); hookForceSyncToCloud(); }, 2000);
    }

    // =========================================================================
    // HOOK: PREVENT OVERWRITE BY GENERIC GRID
    // =========================================================================

    function preventGenericOverwrite() {
        // Watch for window.unifiedTimes changes and prevent generic overwrites
        let lastValidTimes = null;
        
        const checkAndProtect = () => {
            const current = window.unifiedTimes;
            
            // If we have valid stored times and current is generic, restore
            if (lastValidTimes && current && isGeneric30MinGrid(current) && !isGeneric30MinGrid(lastValidTimes)) {
                console.log('[UTFix] Detected generic overwrite, restoring...');
                window.unifiedTimes = lastValidTimes;
                window._unifiedTimesProtected = true;
                return;
            }
            
            // Save valid times for protection
            if (current && current.length > 0 && !isGeneric30MinGrid(current)) {
                lastValidTimes = [...current];
            }
        };
        
        // Check periodically
        setInterval(checkAndProtect, 500);
    }

    // =========================================================================
    // HOOK: CLOUD HYDRATION
    // =========================================================================

    function hookCloudHydration() {
        window.addEventListener('campistry-cloud-hydrated', () => {
            console.log('[UTFix] Cloud hydration detected - loading stored unifiedTimes...');
            
            setTimeout(() => {
                const dateKey = getDateKey();
                const times = loadUnifiedTimes(dateKey);
                
                if (times) {
                    applyUnifiedTimes(times);
                    
                    // Trigger re-render
                    if (window.updateTable) {
                        setTimeout(() => window.updateTable(), 100);
                    }
                }
            }, 300);
        });
        
        console.log('[UTFix] ✅ Hooked cloud hydration event');
    }

    // =========================================================================
    // IMMEDIATE LOAD ON STARTUP
    // =========================================================================

    function immediateLoad() {
        const dateKey = getDateKey();
        console.log(`[UTFix] Immediate load for ${dateKey}...`);
        
        const times = loadUnifiedTimes(dateKey);
        if (times) {
            // Set immediately before any other code runs
            window.unifiedTimes = times;
            window._unifiedTimesFromStorage = true;
            console.log(`[UTFix] ✅ Pre-loaded ${times.length} slots`);
        } else {
            console.log('[UTFix] No stored unifiedTimes to pre-load');
        }
    }

    // =========================================================================
    // PERIODIC CHECK & FIX
    // =========================================================================

    function startPeriodicFix() {
        const checkAndFix = () => {
            const current = window.unifiedTimes || [];
            
            // If current is generic (30-min grid), try to load from storage
            if (isGeneric30MinGrid(current)) {
                const stored = loadUnifiedTimes(getDateKey());
                if (stored && stored.length > 0 && !isGeneric30MinGrid(stored)) {
                    console.log('[UTFix] Periodic fix: Replacing generic grid with stored times');
                    window.unifiedTimes = stored;
                    window._unifiedTimesFromStorage = true;
                    
                    if (window.updateTable) {
                        window.updateTable();
                    }
                }
            }
        };
        
        // Check at specific intervals
        setTimeout(checkAndFix, 500);
        setTimeout(checkAndFix, 1500);
        setTimeout(checkAndFix, 3000);
        setTimeout(checkAndFix, 5000);
    }

    // =========================================================================
    // DIAGNOSTIC
    // =========================================================================

    function diagnose() {
        const dateKey = getDateKey();
        
        console.log('\n═══════════════════════════════════════════════════════════════════════');
        console.log('⏰ UNIFIED TIMES DIAGNOSTIC');
        console.log('═══════════════════════════════════════════════════════════════════════');
        console.log(`Date: ${dateKey}`);
        
        // Window state
        const current = window.unifiedTimes || [];
        console.log(`\nWindow unifiedTimes: ${current.length} slots`);
        console.log(`Is Generic 30-min Grid: ${isGeneric30MinGrid(current)}`);
        
        if (current.length > 0) {
            console.log('First 5 slots:');
            current.slice(0, 5).forEach((slot, i) => {
                const mins = slot.startMin ?? '?';
                console.log(`  [${i}] ${mins} min`);
            });
        }
        
        // Dedicated storage
        try {
            const raw = localStorage.getItem(UNIFIED_TIMES_KEY);
            if (raw) {
                const storage = JSON.parse(raw);
                const dateData = storage[dateKey];
                console.log(`\nDedicated Storage (${UNIFIED_TIMES_KEY}):`);
                if (dateData) {
                    console.log(`  Slots: ${dateData.slotCount || dateData.times?.length || 0}`);
                    console.log(`  Is Generic: ${dateData.isGeneric}`);
                    console.log(`  Saved At: ${dateData.savedAt}`);
                } else {
                    console.log(`  No data for ${dateKey}`);
                }
            } else {
                console.log(`\nDedicated Storage: Empty`);
            }
        } catch (e) {
            console.log(`\nDedicated Storage: Error - ${e.message}`);
        }
        
        // Daily data storage
        try {
            const raw = localStorage.getItem(DAILY_DATA_KEY);
            if (raw) {
                const daily = JSON.parse(raw);
                const dateData = daily[dateKey];
                console.log(`\nDaily Data Storage (${DAILY_DATA_KEY}):`);
                if (dateData?.unifiedTimes) {
                    console.log(`  Slots: ${dateData.unifiedTimes.length}`);
                } else {
                    console.log(`  No unifiedTimes for ${dateKey}`);
                }
            }
        } catch (e) {
            console.log(`\nDaily Data Storage: Error - ${e.message}`);
        }
        
        console.log('\n═══════════════════════════════════════════════════════════════════════');
        
        return {
            dateKey,
            windowSlots: current.length,
            isGeneric: isGeneric30MinGrid(current)
        };
    }

    // =========================================================================
    // FORCE FIX
    // =========================================================================

    function forceFix() {
        const dateKey = getDateKey();
        console.log(`[UTFix] Force fix for ${dateKey}...`);
        
        const times = loadUnifiedTimes(dateKey);
        if (times && times.length > 0) {
            window.unifiedTimes = times;
            window._unifiedTimesFromStorage = true;
            
            if (window.updateTable) {
                window.updateTable();
            }
            
            console.log(`[UTFix] ✅ Force fix applied: ${times.length} slots`);
            return true;
        } else {
            console.log('[UTFix] ⚠️ No stored times to restore');
            return false;
        }
    }

    // =========================================================================
    // FORCE SAVE (for manual use after generation)
    // =========================================================================

    function forceSave() {
        const times = window.unifiedTimes;
        if (!times || times.length === 0) {
            console.log('[UTFix] Nothing to save');
            return false;
        }
        
        const dateKey = getDateKey();
        return saveUnifiedTimes(dateKey, times);
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initialize() {
        console.log('[UTFix] Initializing...');
        
        // 1. Immediate load BEFORE anything else
        immediateLoad();
        
        // 2. Hook all events
        hookGenerationComplete();
        hookSaveTriggers();
        hookCloudHydration();
        
        // 3. Start periodic fix
        startPeriodicFix();
        
        // 4. Optional: prevent generic overwrite
        // preventGenericOverwrite();
        
        console.log('[UTFix] ✅ Initialization complete');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.UnifiedTimesFix = {
        version: '2.0',
        
        // Manual operations
        save: forceSave,
        load: () => loadUnifiedTimes(getDateKey()),
        forceFix: forceFix,
        diagnose: diagnose,
        
        // State
        getState: () => ({
            dateKey: getDateKey(),
            windowSlots: (window.unifiedTimes || []).length,
            isGeneric: isGeneric30MinGrid(window.unifiedTimes || []),
            fromStorage: window._unifiedTimesFromStorage || false
        }),
        
        // Debug
        isGenericGrid: isGeneric30MinGrid,
        saveUnifiedTimes: saveUnifiedTimes,
        loadUnifiedTimes: loadUnifiedTimes
    };

    // =========================================================================
    // STARTUP
    // =========================================================================

    // Run IMMEDIATELY - don't wait for DOM
    initialize();

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('⏰ UNIFIED TIMES PERSISTENCE FIX v2.0 LOADED');
    console.log('');
    console.log('   Commands:');
    console.log('   - UnifiedTimesFix.diagnose()  → Check current state');
    console.log('   - UnifiedTimesFix.forceFix()  → Force reload from storage');
    console.log('   - UnifiedTimesFix.save()      → Force save current times');
    console.log('   - UnifiedTimesFix.getState()  → Quick state summary');
    console.log('');
    console.log('   ⚠️  After generating, run: UnifiedTimesFix.save()');
    console.log('       This saves the scheduler-generated unifiedTimes');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════');

})();
