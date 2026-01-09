// ============================================================================
// scheduler_subdivision_integration.js
// Intercepts the Generator to handle Multi-User logic
// ============================================================================

(function() {
    'use strict';

    console.log("[SchedulerSubdivisionIntegration] Loading v2.3 (FIXED)...");

    const Integration = {
        originalOptimizer: null,

        init: function() {
            // Hook into the optimizer function
            if (window.runSkeletonOptimizer && !this.originalOptimizer) {
                this.originalOptimizer = window.runSkeletonOptimizer;
                window.runSkeletonOptimizer = this.runOptimizerWrapper.bind(this);
                console.log("[Integration] ✅ Hooked runSkeletonOptimizer");
            } else {
                // Retry if not ready
                setTimeout(() => this.init(), 500);
            }
        },

        // Wrapper function that replaces the standard optimizer call
        runOptimizerWrapper: async function(manualSkeleton, externalOverrides, allowedDivisions, existingScheduleSnapshot) {
            console.log("\n══════════════════════════════════════════════════════════════════════");
            console.log("★★★ MULTI-SCHEDULER INTEGRATION v2.3 (FIXED) ★★★");
            console.log("══════════════════════════════════════════════════════════════════════");

            // 1. DETERMINE CONTEXT
            const dateKey = window.currentDateKey || new Date().toISOString().split('T')[0];
            const myDivisions = allowedDivisions || (window.AccessControl ? window.AccessControl.getUserManagedDivisions() : []);
            
            // Calculate background divisions (All - My)
            const allDivisions = Object.keys(window.divisions || {});
            const backgroundDivisions = allDivisions.filter(d => !myDivisions.includes(d));

            console.log(`[Integration] 📅 Date: ${dateKey}`);
            console.log(`[Integration] 🎯 My Divisions: ${myDivisions.join(', ')}`);
            console.log(`[Integration] 🔒 Background Divisions: ${backgroundDivisions.join(', ')}`);

            // 2. FILTER SKELETON (Only generate for my divisions)
            // Note: We filter the skeleton to prevent generating data for divisions we don't own.
            // The core optimizer also has a check, but this is an extra layer of safety.
            const mySkeleton = manualSkeleton.filter(item => myDivisions.includes(item.division));
            console.log(`[Integration] 🔍 Skeleton filtered: ${manualSkeleton.length} → ${mySkeleton.length} items`);

            // 3. LOAD EXISTING DATA (SNAPSHOT)
            let backgroundSnapshot = {};
            
            if (allowedDivisions && allowedDivisions.length > 0) {
                console.log("\n[Integration] STEP 1: Loading background schedules...");
                
                // Strategy: 
                // 1. Try to load from Cloud (Primary Source of Truth for *other* users' work)
                // 2. If Cloud empty/fails for this date, check Local Snapshot (passed from UI)
                // 3. Merge them (Cloud wins on conflict for background divisions)

                let cloudState = await this.loadCloudState(dateKey);
                
                // Fallback 1: If cloud has no data for this date, but UI passed a snapshot (e.g. from local session edits or previous load)
                if ((!cloudState || Object.keys(cloudState).length === 0) && existingScheduleSnapshot) {
                    console.log("[Integration] ⚠️ Cloud return empty for date, using local snapshot as fallback source.");
                    cloudState = existingScheduleSnapshot;
                }

                // ★★★ SECOND FALLBACK: CHECK GLOBAL STATE DIRECTLY ★★★
                // If both cloud fetch failed AND no snapshot was passed (e.g. direct call), try window.scheduleAssignments
                // This prevents wiping data if the cloud fetch returns empty for a valid day
                if ((!cloudState || Object.keys(cloudState).length === 0) && window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0) {
                     console.log("[Integration] ⚠️ No snapshot passed, using window.scheduleAssignments as emergency fallback.");
                     cloudState = JSON.parse(JSON.stringify(window.scheduleAssignments));
                }

                if (cloudState) {
                    // Extract schedules for divisions we are NOT editing
                    backgroundSnapshot = this.extractBackgroundSchedules(cloudState, backgroundDivisions);
                }
                
                console.log(`[Integration] 📸 Background snapshot: ${Object.keys(backgroundSnapshot).length} bunks`);
            }

            // 4. RUN CORE OPTIMIZER
            console.log("\n[Integration] STEP 3: Running optimizer...");
            // We pass the filtered skeleton and the background snapshot
            // The core optimizer will:
            // a. Restore the background snapshot (locking those bunks)
            // b. Generate schedules for 'mySkeleton'
            // c. Result in a merged window.scheduleAssignments
            await this.originalOptimizer(mySkeleton, externalOverrides, myDivisions, backgroundSnapshot);

            // 5. SYNC BACK TO CLOUD
            console.log("\n[Integration] STEP 4: Scheduling cloud sync...");
            if (window.saveSchedule) {
                window.saveSchedule();
            }

            console.log("\n══════════════════════════════════════════════════════════════════════");
            console.log("★★★ MULTI-SCHEDULER INTEGRATION COMPLETE ★★★");
            console.log("══════════════════════════════════════════════════════════════════════");
        },

        loadCloudState: async function(dateKey) {
            // Helper to fetch raw data from cloud/bridge without triggering a full UI reload
            if (window.CloudStorageBridge && window.CloudStorageBridge.loadDailyData) {
                try {
                    console.log("[Integration] 📡 Loading existing schedules from cloud...");
                    const data = await window.CloudStorageBridge.loadDailyData(dateKey, true); // true = silent/no-render
                    if (data) {
                        console.log("[Integration] ✅ Loaded cloud state");
                        return data.scheduleAssignments || {};
                    }
                } catch (e) {
                    console.error("[Integration] ❌ Failed to load cloud state:", e);
                }
            }
            return null;
        },

        extractBackgroundSchedules: function(assignments, backgroundDivisions) {
            const snapshot = {};
            const divisions = window.divisions || {};
            
            // Build map of Bunk -> Division
            const bunkDivMap = {};
            Object.keys(divisions).forEach(divName => {
                if (divisions[divName].bunks) {
                    divisions[divName].bunks.forEach(bunk => {
                        bunkDivMap[bunk] = divName;
                    });
                }
            });

            // Filter assignments
            Object.keys(assignments).forEach(bunk => {
                const div = bunkDivMap[bunk];
                // If this bunk belongs to a background division, keep it
                if (backgroundDivisions.includes(div)) {
                    snapshot[bunk] = assignments[bunk];
                }
            });

            return snapshot;
        }
    };

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Integration.init());
    } else {
        Integration.init();
    }
    
    // Expose for debugging
    window.SchedulerIntegration = Integration;

})();
