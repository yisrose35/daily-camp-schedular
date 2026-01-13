// =============================================================================
// multi_scheduler_integration.js — Wiring Guide & Auto-Hooks
// VERSION: v1.0.0
// =============================================================================
//
// This file automatically hooks the new multi-scheduler modules into your
// existing Campistry codebase. It patches key functions to add:
//
// 1. Cloud fetch on scheduler view open
// 2. Blocked resource checks before drag-drop
// 3. Auto-merge on save
//
// =============================================================================

(function() {
    'use strict';

    console.log("🔌 Multi-Scheduler Integration v1.0.0 loading...");

    // =========================================================================
    // INTEGRATION 1: Fetch Cloud Data When Scheduler Opens
    // =========================================================================
    
    /**
     * Hook into initMasterScheduler to fetch blocked resources first
     */
    function hookMasterSchedulerInit() {
        const originalInit = window.initMasterScheduler;
        
        if (!originalInit) {
            console.log('🔌 Waiting for initMasterScheduler...');
            setTimeout(hookMasterSchedulerInit, 500);
            return;
        }
        
        if (window._masterSchedulerHooked) return;
        
        window.initMasterScheduler = async function(...args) {
            console.log('🔌 Master Scheduler opening - fetching cloud blocked resources...');
            
            const dateKey = window.currentScheduleDate || 
                           document.getElementById('calendar-date-picker')?.value ||
                           new Date().toISOString().split('T')[0];
            
            // Fetch blocked resources from cloud BEFORE initializing
            if (window.SchedulerCloudFetch?.initializeSchedulerView) {
                try {
                    const result = await window.SchedulerCloudFetch.initializeSchedulerView(dateKey);
                    console.log('🔌 Blocked resources loaded:', result.blockedMap?.stats);
                } catch (e) {
                    console.warn('🔌 Cloud fetch warning:', e);
                }
            }
            
            // Now run the original init
            if (originalInit) {
                return originalInit.apply(this, args);
            }
        };
        
        window._masterSchedulerHooked = true;
        console.log('🔌 ✅ Hooked initMasterScheduler');
    }

    // =========================================================================
    // INTEGRATION 2: Block Invalid Drag-Drop in Optimizer
    // =========================================================================
    
    /**
     * Hook into runSkeletonOptimizer to check blocked resources
     */
    function hookSkeletonOptimizer() {
        const originalOptimizer = window.runSkeletonOptimizer;
        
        if (!originalOptimizer) {
            console.log('🔌 Waiting for runSkeletonOptimizer...');
            setTimeout(hookSkeletonOptimizer, 500);
            return;
        }
        
        if (window._optimizerBlockingHooked) return;
        
        window.runSkeletonOptimizer = async function(skeleton, overrides, allowedDivisions, existingSnapshot) {
            console.log('🔌 Optimizer starting - applying blocked resource constraints...');
            
            // Get blocked map
            const blockedMap = window._cloudBlockedResources;
            
            if (blockedMap && Object.keys(blockedMap.bySlotField).length > 0) {
                // Register blocked fields in GlobalFieldLocks
                if (window.GlobalFieldLocks) {
                    console.log('🔌 Registering cloud blocks in GlobalFieldLocks...');
                    
                    for (const [slotIndex, fields] of Object.entries(blockedMap.bySlotField)) {
                        for (const [fieldName, info] of Object.entries(fields)) {
                            if (info.isBlocked) {
                                window.GlobalFieldLocks.lockField(fieldName, [parseInt(slotIndex)], {
                                    lockedBy: 'cloud_scheduler',
                                    activity: `Claimed by: ${info.claimedBy.join(', ')}`,
                                    division: 'external'
                                });
                            }
                        }
                    }
                }
                
                // Also inject into existingSnapshot if not already
                if (!existingSnapshot && blockedMap.byBunkSlot) {
                    existingSnapshot = {};
                    
                    for (const [bunkId, slots] of Object.entries(blockedMap.byBunkSlot)) {
                        if (!existingSnapshot[bunkId]) existingSnapshot[bunkId] = [];
                        
                        for (const [slotIndex, info] of Object.entries(slots)) {
                            existingSnapshot[bunkId][parseInt(slotIndex)] = {
                                field: info.fieldName,
                                _activity: info.fieldName,
                                _locked: true,
                                _fromCloudScheduler: true
                            };
                        }
                    }
                    
                    console.log(`🔌 Injected ${Object.keys(existingSnapshot).length} bunks into existingSnapshot`);
                }
            }
            
            // Run original optimizer with enhanced snapshot
            return originalOptimizer.call(this, skeleton, overrides, allowedDivisions, existingSnapshot);
        };
        
        window._optimizerBlockingHooked = true;
        console.log('🔌 ✅ Hooked runSkeletonOptimizer');
    }

    // =========================================================================
    // INTEGRATION 3: Auto-Merge After Save
    // =========================================================================
    
    /**
     * Hook into forceSyncToCloud to trigger merge after successful sync
     */
    function hookCloudSync() {
        const originalSync = window.forceSyncToCloud || window.syncNow;
        
        if (!originalSync) {
            console.log('🔌 Waiting for forceSyncToCloud...');
            setTimeout(hookCloudSync, 500);
            return;
        }
        
        if (window._cloudSyncMergeHooked) return;
        
        const hookedSync = async function(...args) {
            console.log('🔌 Cloud sync starting...');
            
            // Run original sync
            const result = await originalSync.apply(this, args);
            
            if (result) {
                console.log('🔌 Cloud sync successful - triggering merge view update...');
                
                // Dispatch event for merge UI to update
                window.dispatchEvent(new CustomEvent('campistry-sync-complete', {
                    detail: { timestamp: Date.now() }
                }));
                
                // Auto-create unified view (don't save, just for display)
                if (window.ScheduleMergeEngine?.createUnifiedView) {
                    const dateKey = window.currentScheduleDate || 
                                   new Date().toISOString().split('T')[0];
                    
                    // Only auto-merge if we have data from multiple sources
                    const blockedMap = window._cloudBlockedResources;
                    if (blockedMap?.stats?.totalBlockedSlots > 0) {
                        console.log('🔌 Multiple schedulers detected - unified view available');
                        // Don't auto-merge, just notify that merge is available
                        window.dispatchEvent(new CustomEvent('campistry-merge-available', {
                            detail: { dateKey }
                        }));
                    }
                }
            }
            
            return result;
        };
        
        window.forceSyncToCloud = hookedSync;
        window.syncNow = hookedSync;
        
        window._cloudSyncMergeHooked = true;
        console.log('🔌 ✅ Hooked cloud sync');
    }

    // =========================================================================
    // INTEGRATION 4: Date Change Handler
    // =========================================================================
    
    /**
     * Re-fetch blocked resources when date changes
     */
    function hookDateChange() {
        const dateInput = document.getElementById('calendar-date-picker');
        if (!dateInput) {
            setTimeout(hookDateChange, 500);
            return;
        }
        
        if (dateInput._blockingHooked) return;
        
        dateInput.addEventListener('change', async (e) => {
            const newDate = e.target.value;
            console.log(`🔌 Date changed to ${newDate} - refreshing blocked resources...`);
            
            // Clear old blocked resources
            window._cloudBlockedResources = null;
            window._cloudScheduleData = null;
            
            // Fetch new blocked resources
            if (window.SchedulerCloudFetch?.initializeSchedulerView) {
                await window.SchedulerCloudFetch.initializeSchedulerView(newDate);
            }
            
            // Refresh UI blocking
            if (window.SchedulerUIBlocking?.refresh) {
                window.SchedulerUIBlocking.refresh();
            }
        });
        
        dateInput._blockingHooked = true;
        console.log('🔌 ✅ Hooked date picker');
    }

    // =========================================================================
    // INTEGRATION 5: Add Merge Button to UI
    // =========================================================================
    
    function addMergeButton() {
        // Find the version toolbar or create one
        let toolbar = document.getElementById('version-toolbar-container');
        
        if (!toolbar) {
            // Wait for it to be created by schedule_version_ui.js
            setTimeout(addMergeButton, 1000);
            return;
        }
        
        // Check if merge button already exists
        if (document.getElementById('btn-unified-merge')) return;
        
        // Create merge button
        const mergeBtn = document.createElement('button');
        mergeBtn.id = 'btn-unified-merge';
        mergeBtn.innerHTML = '🔀 Create Unified Schedule';
        mergeBtn.style.cssText = `
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 6px;
            border: 1px solid #8b5cf6;
            background: #8b5cf6;
            color: white;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        `;
        
        mergeBtn.onmouseover = () => mergeBtn.style.background = '#7c3aed';
        mergeBtn.onmouseout = () => mergeBtn.style.background = '#8b5cf6';
        
        mergeBtn.onclick = async (e) => {
            e.preventDefault();
            
            const dateKey = window.currentScheduleDate || 
                           document.getElementById('calendar-date-picker')?.value;
            
            if (!dateKey) {
                alert('Please select a date first');
                return;
            }
            
            if (!confirm(`Create unified schedule for ${dateKey}? This will merge all schedulers' work.`)) {
                return;
            }
            
            mergeBtn.innerHTML = '⏳ Merging...';
            mergeBtn.disabled = true;
            
            try {
                const result = await window.ScheduleMergeEngine.executeMerge({
                    dateKey,
                    strategy: 'priority',
                    preview: false
                });
                
                if (result.success) {
                    alert(`✅ Unified schedule created!\n\n` +
                          `• ${result.stats.mergedBunks} bunks merged\n` +
                          `• ${result.stats.mergedSlots} slots total\n` +
                          `• ${result.stats.conflicts} conflicts resolved`);
                    
                    // Refresh the view
                    if (window.updateTable) window.updateTable();
                } else if (result.unresolvedConflicts.length > 0) {
                    alert(`⚠️ ${result.unresolvedConflicts.length} conflicts need manual resolution.\n\n` +
                          `Please review the schedule and resolve conflicts.`);
                } else {
                    alert('❌ Merge failed: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                console.error('Merge error:', error);
                alert('❌ Merge failed: ' + error.message);
            } finally {
                mergeBtn.innerHTML = '🔀 Create Unified Schedule';
                mergeBtn.disabled = false;
            }
        };
        
        toolbar.appendChild(mergeBtn);
        console.log('🔌 ✅ Added merge button');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    
    function initialize() {
        console.log('🔌 Initializing multi-scheduler integrations...');
        
        // Hook into key functions
        hookMasterSchedulerInit();
        hookSkeletonOptimizer();
        hookCloudSync();
        hookDateChange();
        
        // Hook generate button for pre-clear
        setTimeout(hookGenerateButton, 1000);
        setTimeout(hookGenerateButton, 2000); // Retry in case button loads late
        
        // Add UI elements
        setTimeout(addMergeButton, 2000);
        
        console.log('🔌 Multi-scheduler integration complete');
    }
    
    // Start integration when DOM is ready
    if (document.readyState === 'complete') {
        setTimeout(initialize, 100);
    } else {
        window.addEventListener('load', () => setTimeout(initialize, 100));
    }

    // =========================================================================
    // INTEGRATION 6: Hook Into Generate Button for Pre-Clear
    // =========================================================================
    
    function hookGenerateButton() {
        // Delegate to SchedulerDataManagement if available (it has more comprehensive hooking)
        if (window.SchedulerDataManagement?.hookGenerateButton) {
            window.SchedulerDataManagement.hookGenerateButton();
            return;
        }
        
        // Fallback: basic hook
        const generateBtns = document.querySelectorAll(
            '[onclick*="runSkeletonOptimizer"], ' +
            '[onclick*="generateSchedule"], ' +
            '#generateScheduleBtn, ' +
            '#btnGenerateSchedule'
        );
        
        generateBtns.forEach(btn => {
            if (btn._preClearHooked) return;
            
            const originalOnClick = btn.onclick;
            
            btn.onclick = async function(e) {
                const dateKey = window.currentScheduleDate;
                
                // Check if user has existing data
                const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                const dateData = dailyData[dateKey]?.scheduleAssignments || {};
                
                const myDivisions = window.AccessControl?.getEditableDivisions?.() || 
                                   Object.keys(window.divisions || {});
                const myBunks = new Set();
                const allDivisions = window.divisions || {};
                
                for (const divName of myDivisions) {
                    const divInfo = allDivisions[divName];
                    if (divInfo?.bunks) {
                        divInfo.bunks.forEach(b => myBunks.add(b));
                    }
                }
                
                const hasExistingData = [...myBunks].some(b => {
                    const slots = dateData[b];
                    return slots && slots.some(s => s && !s.continuation && s.field);
                });
                
                if (hasExistingData) {
                    const confirmRegen = confirm(
                        `⚠️ You already have a schedule for ${dateKey}.\n\n` +
                        `Generating will REPLACE your current schedule.\n` +
                        `Other schedulers' data will be preserved.\n\n` +
                        `Continue?`
                    );
                    
                    if (!confirmRegen) {
                        e.preventDefault();
                        return false;
                    }
                    
                    // Clear my data before regenerating
                    if (window.SchedulerDataManagement?.clearMyScheduleBeforeRegenerate) {
                        console.log('🔌 Clearing existing data before regenerate...');
                        await window.SchedulerDataManagement.clearMyScheduleBeforeRegenerate(dateKey, true);
                        window.loadCurrentDailyData?.();
                    }
                }
                
                // Run original generation
                if (originalOnClick) {
                    return originalOnClick.call(this, e);
                }
            };
            
            btn._preClearHooked = true;
            console.log('🔌 ✅ Hooked generate button:', btn.id || btn.className);
        });
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.MultiSchedulerIntegration = {
        initialize,
        hookMasterSchedulerInit,
        hookSkeletonOptimizer,
        hookCloudSync,
        hookDateChange,
        addMergeButton,
        hookGenerateButton
    };
    
    console.log("🔌 Multi-Scheduler Integration v1.0.0 loaded");

})();
