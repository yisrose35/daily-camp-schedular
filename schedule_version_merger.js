// =================================================================
// schedule_version_merger.js
// Aggregates distinct schedule versions into the main view
// Now includes "Smart" Time Grid Generation to handle staggered starts
// =================================================================

(function () {
    'use strict';

    console.log("🔄 Schedule Version Merger Service Loading...");

    const VERSIONS_TABLE = "schedule_versions";
    const INCREMENT_MINS = 30;

    // =================================================================
    // TIME & GRID UTILITIES (Ported from scheduler_ui.js)
    // =================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/g, "").trim();
        } else return null;

        const m = s.match(/^(\d{1,2})\s*[:]\s*(\d{2})$/);
        if (!m) return null;

        let h = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);

        if (mm < 0 || mm > 59) return null;

        if (h === 12) h = (mer === "am" ? 0 : 12);
        else if (mer === "pm") h += 12;

        return h * 60 + mm;
    }

    /**
     * Rebuilds the master time grid based on the skeleton/divisions.
     * This ensures the grid expands to fit the earliest start and latest end
     * of ALL divisions found in the data.
     */
    function regenerateTimesFromSkeleton(skeleton) {
        console.log("🔄 [VersionMerger] Regenerating master time grid...");
        
        let minTime = 540; // Default 9am
        let maxTime = 960; // Default 4pm
        let found = false;
        
        // 1. Check Skeleton Blocks
        if (skeleton && Array.isArray(skeleton)) {
            skeleton.forEach(b => {
                const s = parseTimeToMinutes(b.startTime);
                const e = parseTimeToMinutes(b.endTime);
                if (s !== null) { minTime = Math.min(minTime, s); found = true; }
                if (e !== null) { maxTime = Math.max(maxTime, e); found = true; }
            });
        }
        
        // 2. Check Global Divisions (if available in window context)
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
        for (let t = minTime; t < maxTime; t += INCREMENT_MINS) {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            const start = new Date(d.getTime() + t * 60000);
            const end = new Date(d.getTime() + (t + INCREMENT_MINS) * 60000);
            let h = Math.floor(t / 60), m = t % 60;
            const ap = h >= 12 ? 'PM' : 'AM';
            if (h > 12) h -= 12;
            if (h === 0) h = 12;
            
            times.push({
                start: start,
                end: end,
                label: h + ':' + String(m).padStart(2, '0') + ' ' + ap
            });
        }
        
        console.log(`🔄 [VersionMerger] Grid generated: ${times.length} slots (${times[0]?.label} - ${times[times.length-1]?.label})`);
        return times;
    }

    // =================================================================
    // DATA UTILITIES
    // =================================================================

    function getCampId() {
        if (window.getCampId) return window.getCampId();
        return localStorage.getItem('campistry_user_id');
    }

    async function getSupabase() {
        if (window.supabase) return window.supabase;
        return new Promise(resolve => setTimeout(() => resolve(window.supabase), 500));
    }

    // =================================================================
    // CORE MERGE LOGIC
    // =================================================================

    const ScheduleVersionMerger = {
        
        /**
         * Checks for multiple versions on a given date and merges them
         * into the active daily view, ensuring the Time Grid is correct.
         * @param {string} dateKey - The date to check (YYYY-MM-DD)
         */
        mergeAndPush: async function(dateKey) {
            if (!dateKey) return;
            console.log(`[VersionMerger] Checking for versions on ${dateKey}...`);
            
            const supabase = await getSupabase();
            const campId = getCampId();

            if (!supabase || !campId) {
                console.error("[VersionMerger] Supabase or Camp ID missing.");
                return { success: false, error: "Initialization failed" };
            }

            try {
                // 1. Fetch all versions for this date/camp
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

                console.log(`[VersionMerger] Found ${versions.length} versions. Analyzing structure...`);

                // 2. Identify the Master Skeleton & Rebuild Time Grid
                // We look for the MOST RECENT skeleton definition to ensure the grid is current.
                let latestSkeleton = null;
                let latestLeagueData = null;

                // Scan backwards to find the latest structural data
                for (let i = versions.length - 1; i >= 0; i--) {
                    let vData = versions[i].schedule_data || versions[i].data || versions[i].payload || versions[i].state || versions[i].json;
                    if (typeof vData === 'string') { try { vData = JSON.parse(vData); } catch(e){} }
                    
                    if (vData) {
                        if (!latestSkeleton && (vData.manualSkeleton || vData.skeleton)) {
                            latestSkeleton = vData.manualSkeleton || vData.skeleton;
                        }
                        if (!latestLeagueData && vData.leagueAssignments) {
                            latestLeagueData = vData.leagueAssignments;
                        }
                    }
                    if (latestSkeleton) break; // Optimization: stop once we have the latest structure
                }

                // If no skeleton in versions, try fallback to current window state or localstorage
                if (!latestSkeleton && window.manualSkeleton) latestSkeleton = window.manualSkeleton;

                let generatedTimes = null;
                if (latestSkeleton) {
                    // ★★★ SMART LOGIC: Regenerate Unified Times based on Skeleton ★★★
                    // This ensures that if Division A starts at 9am and Division B at 10am,
                    // the grid covers 9am onwards, and data is placed correctly.
                    generatedTimes = regenerateTimesFromSkeleton(latestSkeleton);
                    
                    // Push the correct time grid to state immediately
                    if (window.saveCurrentDailyData) {
                        window.saveCurrentDailyData("unifiedTimes", generatedTimes);
                        // Also update global variable for immediate access
                        window.unifiedTimes = generatedTimes;
                    }
                } else {
                    console.warn("[VersionMerger] No skeleton found. Merging arrays blindly (indices might be misaligned).");
                }

                // 3. Perform the Merge
                const mergedAssignments = {};
                let bunksTouched = new Set();

                versions.forEach((ver, index) => {
                    let scheduleData = ver.schedule_data || ver.data || ver.payload || ver.state || ver.json || ver.schedule;
                    
                    if (typeof scheduleData === 'string') {
                        try { scheduleData = JSON.parse(scheduleData); } catch(e) {}
                    }
                    
                    if (!scheduleData) return;

                    // Extract actual assignments
                    const assignments = scheduleData.scheduleAssignments || scheduleData;

                    if (assignments && typeof assignments === 'object') {
                        Object.entries(assignments).forEach(([bunkId, slots]) => {
                            // If we have generated times, we might want to validate array length here
                            // For now, we trust the DB data corresponds to the skeleton we found
                            mergedAssignments[bunkId] = slots;
                            bunksTouched.add(bunkId);
                        });
                    }
                });

                console.log(`[VersionMerger] Merge complete. Combined ${bunksTouched.size} bunks from ${versions.length} versions.`);

                // 4. Push to Daily Schedule View (Main State)
                if (window.saveScheduleAssignments) {
                    console.log("[VersionMerger] Pushing merged data to Daily View via Bridge...");
                    
                    const result = window.saveScheduleAssignments(dateKey, mergedAssignments);
                    
                    // If we found league data in the versions, push that too
                    if (latestLeagueData && window.saveCurrentDailyData) {
                        window.saveCurrentDailyData("leagueAssignments", latestLeagueData);
                    }
                    
                    if (result) {
                        console.log("[VersionMerger] ✅ Successfully updated Daily View.");
                        
                        // Optional: Trigger UI refresh if available
                        if (window.loadScheduleForDate) window.loadScheduleForDate(dateKey);
                        else if (window.updateTable) window.updateTable();
                        
                        return { success: true, count: versions.length, bunks: bunksTouched.size };
                    }
                } else {
                    // Fallback: Manual LocalStorage manipulation
                    console.warn("[VersionMerger] Bridge not found. Using fallback save.");
                    
                    const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
                    if (!dailyData[dateKey]) dailyData[dateKey] = {};
                    
                    // Merge assignments
                    dailyData[dateKey].scheduleAssignments = {
                        ...(dailyData[dateKey].scheduleAssignments || {}),
                        ...mergedAssignments
                    };

                    // Merge Times (Critical for alignment)
                    if (generatedTimes) {
                        dailyData[dateKey].unifiedTimes = generatedTimes;
                    }

                    // Merge League Data
                    if (latestLeagueData) {
                         dailyData[dateKey].leagueAssignments = latestLeagueData;
                    }
                    
                    localStorage.setItem('campDailyData_v1', JSON.stringify(dailyData));
                    
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
    // EXPORT & LISTENERS
    // =================================================================
    
    window.ScheduleVersionMerger = ScheduleVersionMerger;

    // 1. Hook into the cloud hydration event to auto-check on load
    window.addEventListener('campistry-cloud-hydrated', (e) => {
        if (e.detail && e.detail.hasData) {
            const dateInput = document.getElementById('calendar-date-picker') || document.getElementById('schedule-date-input');
            
            if (dateInput && dateInput.value) {
                setTimeout(() => {
                    ScheduleVersionMerger.mergeAndPush(dateInput.value);
                }, 2000);
            }
        }
    });

    // 2. Hook into date changes
    document.addEventListener('DOMContentLoaded', () => {
        const dateInput = document.getElementById('calendar-date-picker') || document.getElementById('schedule-date-input');
        if (dateInput) {
            dateInput.addEventListener('change', (e) => {
                setTimeout(() => {
                    ScheduleVersionMerger.mergeAndPush(e.target.value);
                }, 500);
            });
            console.log("[VersionMerger] Listening for date changes on:", dateInput.id);
        }
    });

})();
