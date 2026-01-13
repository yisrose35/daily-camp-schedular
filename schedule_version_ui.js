// =================================================================
// schedule_version_ui.js
// UI for Managing Schedule Versions (Save, Load, Merge)
// VERSION: v3.8 (DIRECT SAVE FIX)
// =================================================================

(function () {
    'use strict';

    console.log("📋 Schedule Version UI v3.8 (DIRECT SAVE FIX) loading...");

    // =================================================================
    // CONFIGURATION
    // =================================================================
    const CONTAINER_ID = "version-toolbar-container";
    
    // =================================================================
    // STATE
    // =================================================================
    let _currentDate = null;

    // =================================================================
    // HELPERS
    // =================================================================
    function getDate() {
        const input = document.getElementById('calendar-date-picker') || document.getElementById('schedule-date-input');
        return input ? input.value : null;
    }

    function getCampId() {
        // Try multiple sources for the ID
        return (window.getCampId && window.getCampId()) || 
               localStorage.getItem('campistry_user_id') || 
               'demo_camp_001';
    }

    // =================================================================
    // UI COMPONENTS
    // =================================================================

    function createButton(text, icon, onClick, variant = 'secondary') {
        const btn = document.createElement('button');
        btn.innerHTML = `<span>${icon}</span> ${text}`;
        btn.className = `version-btn version-btn-${variant}`;
        btn.style.cssText = `
            display: flex; align-items: center; gap: 6px;
            padding: 6px 12px; border-radius: 6px; border: 1px solid #ccc;
            cursor: pointer; font-size: 13px; font-weight: 500;
            background: ${variant === 'primary' ? '#3b82f6' : 'white'};
            color: ${variant === 'primary' ? 'white' : '#374151'};
            border-color: ${variant === 'primary' ? '#2563eb' : '#d1d5db'};
            transition: all 0.2s;
        `;
        if (variant === 'primary') {
            btn.onmouseover = () => btn.style.background = '#2563eb';
            btn.onmouseout = () => btn.style.background = '#3b82f6';
        } else if (variant === 'warning') {
            btn.style.background = '#f59e0b';
            btn.style.color = 'white';
            btn.style.borderColor = '#d97706';
            btn.onmouseover = () => btn.style.background = '#d97706';
            btn.onmouseout = () => btn.style.background = '#f59e0b';
        } else {
            btn.onmouseover = () => btn.style.background = '#f3f4f6';
            btn.onmouseout = () => btn.style.background = 'white';
        }
        
        btn.onclick = (e) => {
            e.preventDefault();
            onClick();
        };
        return btn;
    }

    // =================================================================
    // ACTIONS
    // =================================================================

    async function handleSaveVersion() {
        const date = getDate();
        if (!date) return alert("Please select a date first.");

        const name = prompt("Enter a name for this version (e.g. 'Draft 1', 'Morning Final'):");
        if (!name) return;

        // 1. Capture & Filter Data
        let payload = {};
        try {
            const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            const rawDateData = dailyData[date] || {};

            // ★ STRICT FILTERING ★
            // Only save what is strictly needed for the schedule grid.
            
            // Core Assignments (Bunks, Activities, Fields)
            if (rawDateData.scheduleAssignments) {
                payload.scheduleAssignments = rawDateData.scheduleAssignments;
            }

            // League Metadata (Matchups, Locations)
            if (rawDateData.leagueAssignments) {
                payload.leagueAssignments = rawDateData.leagueAssignments;
            }

            // Unified Times (Slot definitions)
            if (rawDateData.unifiedTimes) {
                payload.unifiedTimes = rawDateData.unifiedTimes;
            }

            // If empty, fallback to raw data to prevent saving nothing
            if (Object.keys(payload).length === 0) {
                console.warn("Payload empty after filtering, using raw data.");
                payload = rawDateData;
            }

        } catch (e) {
            console.error("Error reading local data:", e);
            alert("Failed to read schedule data.");
            return;
        }

        // 2. Direct Save to Supabase (Bypassing potentially buggy DB module)
        if (window.supabase) {
            console.log("📋 Saving version directly to Supabase...");
            const campId = getCampId();
            
            try {
                // Get current user ID for 'created_by'
                const { data: { user } } = await window.supabase.auth.getUser();
                const userId = user ? user.id : 'anon';

                const { data, error } = await window.supabase
                    .from('schedule_versions')
                    .insert({
                        camp_id: campId,
                        date: date,
                        name: name,
                        schedule_data: payload,
                        created_by: userId, 
                        created_at: new Date().toISOString()
                    })
                    .select();

                if (error) {
                    console.error("❌ Supabase Insert Error:", error);
                    alert(`Save Failed: ${error.message}\n(Check console for details)`);
                } else {
                    console.log("✅ Version Saved:", data);
                    alert("✅ Version saved successfully!");
                }
            } catch (err) {
                console.error("❌ Unexpected Error during save:", err);
                alert("An unexpected error occurred. Check console.");
            }

        } else {
            alert("❌ Supabase client not initialized.");
        }
    }

    async function handleLoadVersion() {
        const date = getDate();
        if (!date) return alert("Please select a date first.");

        // Direct Load from Supabase to ensure consistency
        if (!window.supabase) return alert("Supabase not loaded.");
        const campId = getCampId();

        try {
            const { data: versions, error } = await window.supabase
                .from('schedule_versions')
                .select('*')
                .eq('camp_id', campId)
                .eq('date', date)
                .order('created_at', { ascending: false });

            if (error) throw error;
            if (!versions || versions.length === 0) return alert("No saved versions found for this date.");

            // Simple prompt
            let msg = "Select a version to load (enter number):\n";
            versions.forEach((v, i) => {
                const time = new Date(v.created_at).toLocaleTimeString();
                msg += `${i + 1}. ${v.name || 'Untitled'} (${time})\n`;
            });

            const choice = prompt(msg);
            if (!choice) return;
            
            const index = parseInt(choice) - 1;
            if (isNaN(index) || index < 0 || index >= versions.length) return alert("Invalid selection.");

            const selected = versions[index];
            
            if (confirm(`Load "${selected.name}"? This will overwrite your current view.`)) {
                if (window.saveScheduleAssignments) {
                    // Extract data structure
                    let dataToLoad = selected.schedule_data;
                    if (typeof dataToLoad === 'string') {
                        try { dataToLoad = JSON.parse(dataToLoad); } catch(e) {}
                    }
                    const assignments = dataToLoad.scheduleAssignments || dataToLoad;
                    
                    window.saveScheduleAssignments(date, assignments);
                    alert("✅ Version loaded!");
                    
                    if(window.loadScheduleForDate) window.loadScheduleForDate(date);
                }
            }
        } catch (e) {
            console.error("Load Error:", e);
            alert("Failed to load versions: " + e.message);
        }
    }

    // ★★★ NEW MERGE FUNCTION ★★★
    async function handleMergeVersions() {
        const date = getDate();
        if (!date) return alert("Please select a date first.");

        if (!window.ScheduleVersionMerger) {
            return alert("❌ Merger service not loaded. Please refresh.");
        }

        if (!confirm(`Merge ALL saved versions for ${date} into your current view?\n\nThis is useful if multiple schedulers have saved separate parts of the schedule.`)) {
            return;
        }

        const btn = document.getElementById('btn-merge-versions');
        const originalText = btn ? btn.innerHTML : '';
        if(btn) btn.innerHTML = '<span>⏳</span> Merging...';

        try {
            const result = await window.ScheduleVersionMerger.mergeAndPush(date);
            
            if (result.success) {
                if (result.count === 0) {
                    alert("ℹ️ No saved versions found to merge.");
                } else {
                    alert(`✅ Successfully merged ${result.count} versions combining ${result.bunks} bunks!`);
                }
            } else {
                alert("❌ Merge failed: " + result.error);
            }
        } catch(e) {
            console.error(e);
            alert("❌ An error occurred during merge.");
        } finally {
            if(btn) btn.innerHTML = originalText;
        }
    }

    // =================================================================
    // INITIALIZATION
    // =================================================================

    function init() {
        let container = document.getElementById(CONTAINER_ID);
        if (!container) {
            const header = document.querySelector('.app-header');
            if (header) {
                const toolbarRow = document.createElement('div');
                toolbarRow.id = "version-toolbar-wrapper";
                toolbarRow.style.cssText = `
                    background: #f8fafc; border-bottom: 1px solid #e2e8f0;
                    padding: 8px 24px; display: flex; justify-content: flex-end; align-items: center;
                `;
                
                container = document.createElement('div');
                container.id = CONTAINER_ID;
                container.style.cssText = `display: flex; gap: 10px; align-items: center;`;
                
                toolbarRow.appendChild(container);
                header.parentNode.insertBefore(toolbarRow, header.nextSibling);
            } else {
                container = document.createElement('div');
                container.id = CONTAINER_ID;
                container.style.cssText = `
                    position: fixed; bottom: 20px; left: 20px; z-index: 1000;
                    background: white; padding: 10px; border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: flex; gap: 8px;
                `;
                document.body.appendChild(container);
            }
        }

        container.innerHTML = '';
        container.appendChild(createButton("Save Version", "💾", handleSaveVersion));
        container.appendChild(createButton("Load Version", "📂", handleLoadVersion));

        const mergeBtn = createButton("Merge & Sync", "⚡", handleMergeVersions, 'warning');
        mergeBtn.id = 'btn-merge-versions';
        mergeBtn.title = "Combine all saved versions for this date into one schedule";
        container.appendChild(mergeBtn);

        console.log("📋 ✅ Toolbar mounted successfully");
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 1000); 
    }

})();
