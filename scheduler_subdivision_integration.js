// =================================================================
// scheduler_subdivision_integration.js
// Bridges the Core Scheduler with the Subdivision/Multi-Scheduler System
// VERSION: v2.4 (PARANOID DATA RESCUE)
// =================================================================

(function () {
    'use strict';

    console.log("[Integration] Loading v2.4 (PARANOID DATA RESCUE)...");

    const INTEGRATION_KEY = "campistry_subdivision_integration";

    // =================================================================
    // STATE
    // =================================================================
    let _isMultiMode = false;
    let _mySubdivisions = [];
    let _otherSubdivisions = [];
    let _blockedResources = {}; // Map<SlotIndex, Set<ResourceID>>
    
    // REDUNDANT BACKUP: Keep preserved bunks here in closure scope 
    // to prevent loss if window globals are wiped.
    let _preservedBunksBackup = {};   
    
    let _generationDate = null;

    // =================================================================
    // HELPER: CLOUD SYNC TRIGGER
    // =================================================================
    function triggerCloudSave() {
        if (window.scheduleCloudSync) {
            console.log("[Integration] ☁️ Triggering cloud sync...");
            window.scheduleCloudSync();
        } else {
            console.warn("[Integration] ⚠️ Cloud bridge not found, data saved locally only.");
        }
    }

    // =================================================================
    // 1. INTERCEPT GENERATION START
    // =================================================================
    
    // We hook into the UI's "Generate" button or the Scheduler's start method
    function hookGeneration(dateKey, mode, specificSubdivisions = null) {
        if (!window.SubdivisionScheduleManager || !window.SubdivisionScheduleManager.isInitialized) {
            console.warn("[Integration] Subdivision Manager not ready. Running standard generation.");
            return false; // Proceed with standard generation
        }

        // Check if we are in a role that requires subdivision logic
        const role = window.AccessControl ? window.AccessControl.getRole() : 'admin';
        
        if (role === 'admin' && !specificSubdivisions) {
            console.log("[Integration] Admin mode: Generating full schedule standardly.");
            return false;
        }

        console.log(`[Integration] Intercepting generation for ${dateKey}. Role: ${role}`);
        
        _generationDate = dateKey;
        _isMultiMode = true;

        return startMultiSchedulerGeneration(dateKey);
    }

    // =================================================================
    // 2. PREPARE MULTI-SCHEDULER CONTEXT
    // =================================================================

    async function startMultiSchedulerGeneration(dateKey) {
        console.log("\n══════════════════════════════════════════════════════════════════════");
        console.log("🎯 MULTI-SCHEDULER GENERATION v2.4");
        console.log("══════════════════════════════════════════════════════════════════════");
        console.log(`Date: ${dateKey}`);
        
        const role = window.AccessControl ? window.AccessControl.getRole() : 'unknown';
        console.log(`Role: ${role}`);

        // 1. Identify "My" Subdivisions vs "Other" Subdivisions
        const allDivs = Object.keys(window.divisions || {});
        const myDivs = window.AccessControl ? window.AccessControl.getEditableDivisions() : allDivs;
        
        console.log(`Mode: ${role === 'admin' ? 'FULL (Admin)' : 'SCHEDULER (Partial Generation)'}`);
        console.log(`\nDivisions to schedule: ${myDivs.join(', ')}`);

        // Get bunks for these divisions
        const allBunks = window.bunks || [];
        const myBunks = allBunks.filter(b => myDivs.includes(String(b.divisionId)));
        console.log(` Bunks to schedule: ${myBunks.length} total`);

        // 2. Fetch Existing Schedule (The "Background")
        console.log("\n[Step 2] Loading existing schedule...");
        const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
        const todayData = dailyData[dateKey] || {};
        const existingAssignments = todayData.scheduleAssignments || todayData; 

        // 3. Extract "Blocked" Resources from OTHER people's schedules
        console.log("\n[Step 3] Extracting blocked resources from other schedulers...");
        _blockedResources = {};
        _preservedBunksBackup = {}; // Clear backup

        let preservedCount = 0;
        let blockedCount = 0;

        if (existingAssignments) {
            // Iterate all bunks in the existing schedule
            Object.keys(existingAssignments).forEach(bunkId => {
                // Is this bunk mine?
                const isMine = myBunks.some(b => String(b.id) === String(bunkId));
                
                if (!isMine) {
                    // This is someone else's bunk. PRESERVE IT.
                    _preservedBunksBackup[bunkId] = existingAssignments[bunkId];
                    preservedCount++;
                    
                    // Mark its resources as blocked
                    const schedule = existingAssignments[bunkId];
                    if (Array.isArray(schedule)) {
                        schedule.forEach((block, slotIndex) => {
                            if (!block) return;
                            if (!_blockedResources[slotIndex]) _blockedResources[slotIndex] = new Set();
                            if (block.field) _blockedResources[slotIndex].add(block.field);
                            if (block.activity) _blockedResources[slotIndex].add(block.activity);
                            blockedCount++;
                        });
                    }
                }
            });
            console.log(`    Found ${Object.keys(_blockedResources).length} slots with blocked resources`);
            
            // REGISTER BLOCKS WITH GLOBAL LOCK SYSTEM
            if (window.GlobalFieldLocks) {
                window.GlobalFieldLocks.reset();
                Object.entries(_blockedResources).forEach(([slot, resources]) => {
                    resources.forEach(res => {
                        window.GlobalFieldLocks.addLock(parseInt(slot), res, 'background_schedule', 'GLOBAL');
                    });
                });
                console.log(`[Integration] 🔒 Registered ${blockedCount} blocked slots in GlobalFieldLocks`);
            }
        }

        // 4. Prepare Context
        console.log("\n[Step 4] Preparing schedule space...");
        console.log(`    Preserved ${preservedCount} bunks from other schedulers`);

        const fullSkeleton = window.campSkeleton || [];

        console.log("\n[Step 6] Running core optimizer...");
        
        // We set a global flag that the Scheduler Core can check
        window.__MULTI_SCHEDULER_CONTEXT__ = {
            isActive: true,
            myBunks: myBunks.map(b => b.id),
            preservedBunks: { ..._preservedBunksBackup }, // Pass a copy
            allowedDivisions: myDivs
        };

        // Start the standard generation!
        if (window.generateSchedule) {
            await window.generateSchedule(dateKey);
        } else {
            console.error("[Integration] ❌ window.generateSchedule not found!");
        }
        
        return true;
    }

    // =================================================================
    // 3. POST-GENERATION MERGE & SAVE (THE FIX)
    // =================================================================
    
    function finalizeMultiSchedulerGeneration(generatedAssignments, dateKey) {
        console.log("\n[Step 7] Verifying merge integrity...");
        
        // 1. Get the preserved bunks (Primary Source: Closure Backup)
        let preserved = { ..._preservedBunksBackup };
        let source = "Closure Backup";

        // 2. FALLBACK RESCUE: If backup is empty, verify against Storage
        if (Object.keys(preserved).length === 0) {
            console.log("    ⚠️ No preserved bunks in backup. Checking localStorage for rescue...");
            try {
                const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                const todayData = dailyData[dateKey] || {};
                const stored = todayData.scheduleAssignments || todayData;
                
                // Identify "Theirs" again
                const allDivs = Object.keys(window.divisions || {});
                const myDivs = window.AccessControl ? window.AccessControl.getEditableDivisions() : allDivs;
                const allBunks = window.bunks || [];
                const myBunkIds = allBunks.filter(b => myDivs.includes(String(b.divisionId))).map(b => String(b.id));

                Object.keys(stored).forEach(bunkId => {
                    if (!myBunkIds.includes(String(bunkId))) {
                         preserved[bunkId] = stored[bunkId];
                    }
                });
                if (Object.keys(preserved).length > 0) source = "Storage Rescue";
            } catch(e) { console.error("Rescue failed:", e); }
        }

        console.log(`    Preserved Source: ${source}`);
        console.log(`    Preserved Count: ${Object.keys(preserved).length}`);

        // 3. Combine Generated + Preserved
        const finalAssignments = { ...generatedAssignments };
        
        // CRITICAL: Force overwrite any "generated" data for preserved bunks (safety net)
        // This ensures that even if the optimizer accidentally scheduled a Senior bunk when it shouldn't have,
        // or tried to schedule a Junior bunk, we revert to the preserved state for "Theirs".
        Object.keys(preserved).forEach(bunkId => {
            finalAssignments[bunkId] = preserved[bunkId];
        });
        
        console.log(`    Total bunks in final schedule: ${Object.keys(finalAssignments).length}`);
        
        // 4. Save to Storage
        console.log("\n[Step 8] Saving to storage...");
        saveToLocalStorage(dateKey, finalAssignments);

        // 5. Update Subdivision Status
        console.log("[Step 9] Marking subdivisions as draft...");
        if (window.SubdivisionScheduleManager) {
            const myAssignments = {};
            // Filter only what I generated to save as MY draft
            const myDivs = window.AccessControl ? window.AccessControl.getEditableDivisions() : [];
            const allBunks = window.bunks || [];
            
            Object.keys(finalAssignments).forEach(bId => {
                 const bunk = allBunks.find(b => String(b.id) === String(bId));
                 if (bunk && myDivs.includes(String(bunk.divisionId))) {
                     myAssignments[bId] = finalAssignments[bId];
                 }
            });
            
            window.SubdivisionScheduleManager.markMySubdivisionsAsDraft(dateKey, myAssignments);
        }

        // 6. Cleanup
        window.__MULTI_SCHEDULER_CONTEXT__ = null;
        _isMultiMode = false;
        
        console.log("\n[Step 10] Refreshing UI...");
        if (window.loadScheduleForDate) window.loadScheduleForDate(dateKey);
        
        console.log("\n══════════════════════════════════════════════════════════════════════");
        console.log("✅ GENERATION COMPLETE");
        console.log("══════════════════════════════════════════════════════════════════════");
    }

    function saveToLocalStorage(dateKey, assignments) {
        console.log(`[Integration] 💾 Saving schedule for ${dateKey}...`);
        
        // 1. Load current daily data
        let dailyData = {};
        try {
            dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
        } catch (e) {
            console.error("Error reading daily data", e);
        }

        // 2. Init date object if needed
        if (!dailyData[dateKey]) dailyData[dateKey] = {};

        // 3. Update assignments
        dailyData[dateKey].scheduleAssignments = assignments;

        // 4. Persist
        localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
        console.log(`[Integration] 💾 Saved ${Object.keys(assignments).length} bunks to localStorage`);

        // 5. TRIGGER CLOUD SYNC
        if (window.saveScheduleAssignments) {
            console.log("[Integration] ☁️ Handing off to Cloud Bridge via saveScheduleAssignments...");
            window.saveScheduleAssignments(dateKey, assignments);
        } else {
            console.log("[Integration] ☁️ Triggering manual Cloud Sync...");
            triggerCloudSave();
        }
    }

    // =================================================================
    // EXPORT
    // =================================================================
    window.SchedulerSubdivisionIntegration = {
        hookGeneration,
        finalizeMultiSchedulerGeneration,
        triggerCloudSave
    };

    // Auto-install hooks if scheduler core is present
    setTimeout(() => {
        if (window.generateSchedule) {
            const originalGenerate = window.generateSchedule;
            window.generateSchedule = async function(dateKey, ...args) {
                // Check if we should intercept
                if (window.AccessControl && window.AccessControl.isTeamMember()) {
                    const handled = hookGeneration(dateKey);
                    if (handled) return; 
                }
                return originalGenerate(dateKey, ...args);
            };
            console.log("[Integration] ✅ Scheduler hooks installed for multi-scheduler support");
        }
        
        if (!window.unifiedTimes) {
             try {
                 const settings = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
                 if (settings.unifiedTimes) window.unifiedTimes = settings.unifiedTimes;
             } catch(e) {}
        }
        
        if (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length === 0) {
             const date = document.getElementById('schedule-date-input')?.value;
             if (date) {
                 const daily = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                 if (daily[date] && daily[date].scheduleAssignments) {
                     window.scheduleAssignments = daily[date].scheduleAssignments;
                     console.log("[Integration] Reloaded scheduleAssignments from localStorage");
                 }
             }
        }

    }, 1000);

})();
