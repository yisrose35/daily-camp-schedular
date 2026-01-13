// =================================================================
// schedule_version_merger.js
// Aggregates distinct schedule versions into the main view
// =================================================================

(function () {
    'use strict';

    console.log("🔄 Schedule Version Merger Service Loading...");

    const VERSIONS_TABLE = "schedule_versions";

    // =================================================================
    // UTILITIES
    // =================================================================

    function getCampId() {
        if (window.getCampId) return window.getCampId();
        return localStorage.getItem('campistry_user_id');
    }

    async function getSupabase() {
        if (window.supabase) return window.supabase;
        // Wait briefly if not ready
        return new Promise(resolve => setTimeout(() => resolve(window.supabase), 500));
    }

    // =================================================================
    // CORE MERGE LOGIC
    // =================================================================

    const ScheduleVersionMerger = {
        
        /**
         * Checks for multiple versions on a given date and merges them
         * into the active daily view.
         * @param {string} dateKey - The date to check (YYYY-MM-DD)
         */
        mergeAndPush: async function(dateKey) {
            console.log(`[VersionMerger] Checking for versions on ${dateKey}...`);
            
            const supabase = await getSupabase();
            const campId = getCampId();

            if (!supabase || !campId) {
                console.error("[VersionMerger] Supabase or Camp ID missing.");
                return { success: false, error: "Initialization failed" };
            }

            try {
                // 1. Fetch all versions for this date/camp
                // We select * to handle whatever columns exist in the pre-existing table
                const { data: versions, error } = await supabase
                    .from(VERSIONS_TABLE)
                    .select('*')
                    .eq('camp_id', campId)
                    .eq('date', dateKey)
                    .order('created_at', { ascending: true }); // Oldest to newest

                if (error) throw error;

                if (!versions || versions.length === 0) {
                    console.log(`[VersionMerger] No versions found for ${dateKey}.`);
                    return { success: true, count: 0 };
                }

                console.log(`[VersionMerger] Found ${versions.length} versions. merging...`);

                // 2. Perform the Merge
                // We start with an empty object and layer versions on top.
                const mergedAssignments = {};
                let bunksTouched = new Set();
                let schemaDetected = false;

                versions.forEach((ver, index) => {
                    // ROBUSTNESS FIX: Check multiple potential column names for the data
                    // This supports existing tables that might use 'data', 'payload', or 'state'
                    let scheduleData = ver.schedule_data || ver.data || ver.payload || ver.state || ver.json || ver.schedule;
                    
                    if (index === 0 && !scheduleData) {
                         console.warn("[VersionMerger] ⚠️ Could not find schedule data in version record. Available keys:", Object.keys(ver));
                    } else if (!schemaDetected && scheduleData) {
                        schemaDetected = true;
                        // console.log("[VersionMerger] Successfully detected data schema.");
                    }

                    // Handle stringified JSON if necessary
                    if (typeof scheduleData === 'string') {
                        try { scheduleData = JSON.parse(scheduleData); } catch(e) {}
                    }
                    
                    if (!scheduleData) return;

                    // Extract actual assignments (handle various data shapes)
                    // Sometimes the data is the assignments object itself, sometimes it's nested
                    const assignments = scheduleData.scheduleAssignments || scheduleData;

                    if (assignments && typeof assignments === 'object') {
                        Object.entries(assignments).forEach(([bunkId, slots]) => {
                            // Add to merged set
                            mergedAssignments[bunkId] = slots;
                            bunksTouched.add(bunkId);
                        });
                    }
                });

                console.log(`[VersionMerger] Merge complete. Combined ${bunksTouched.size} bunks from ${versions.length} versions.`);

                // 3. Push to Daily Schedule View (Main State)
                // We use the existing Cloud Bridge exposed method if available to ensure
                // it follows standard save protocols (and syncs to other users).
                if (window.saveScheduleAssignments) {
                    console.log("[VersionMerger] Pushing merged data to Daily View via Bridge...");
                    
                    const result = window.saveScheduleAssignments(dateKey, mergedAssignments);
                    
                    if (result) {
                        console.log("[VersionMerger] ✅ Successfully updated Daily View.");
                        
                        // Optional: Trigger UI refresh
                        if (window.loadScheduleForDate) window.loadScheduleForDate(dateKey);
                        
                        return { success: true, count: versions.length, bunks: bunksTouched.size };
                    }
                } else {
                    console.warn("[VersionMerger] window.saveScheduleAssignments not found. Cannot push to view.");
                    // Fallback: Manual LocalStorage manipulation + Sync Trigger
                    const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                    if (!dailyData[dateKey]) dailyData[dateKey] = {};
                    
                    // Merge into local storage
                    dailyData[dateKey].scheduleAssignments = {
                        ...(dailyData[dateKey].scheduleAssignments || {}),
                        ...mergedAssignments
                    };
                    
                    localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
                    
                    // Force Sync
                    if (window.scheduleCloudSync) window.scheduleCloudSync();
                    
                    return { success: true, mode: 'fallback' };
                }

            } catch (err) {
                console.error("[VersionMerger] Error merging versions:", err);
                return { success: false, error: err.message };
            }
        }
    };

    // =================================================================
    // EXPORT & AUTO-RUN CHECK
    // =================================================================
    
    window.ScheduleVersionMerger = ScheduleVersionMerger;

    // Optional: Hook into the cloud hydration event to auto-check on load
    window.addEventListener('campistry-cloud-hydrated', (e) => {
        if (e.detail && e.detail.hasData) {
            // Check the currently viewed date if possible
            const dateInput = document.getElementById('schedule-date-input');
            if (dateInput && dateInput.value) {
                // We debounce this slightly to allow the UI to settle
                setTimeout(() => {
                    ScheduleVersionMerger.mergeAndPush(dateInput.value);
                }, 2000);
            }
        }
    });

})();
