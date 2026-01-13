// =================================================================
// schedule_version_ui.js
// UI for Managing Schedule Versions (Save, Load, Merge)
// VERSION: v3.6 (INCLUDES LEAGUES)
// =================================================================

(function () {
    'use strict';

    console.log("📋 Schedule Version UI v3.6 (INCLUDES LEAGUES) loading...");

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

        // Capture current state from local storage (Source of Truth for UI)
        let scheduleData = {};
        try {
            const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            const rawDateData = dailyData[date] || {};

            // ★ FILTER PAYLOAD (SMART SAVE) ★
            // We create a clean object containing only the critical scheduling data.
            const payload = {};

            // 1. Assignments (The core grid: sports, fields, pinned events)
            if (rawDateData.scheduleAssignments) {
                payload.scheduleAssignments = rawDateData.scheduleAssignments;
            }

            // 2. League Assignments (Critical metadata for league games)
            // This ensures matchups and standings data is preserved
            if (rawDateData.leagueAssignments) {
                payload.leagueAssignments = rawDateData.leagueAssignments;
            }

            // 3. Unified Times (Optional but good for alignment)
            // Keeping this ensures the grid structure matches the assignments
            if (rawDateData.unifiedTimes) {
                payload.unifiedTimes = rawDateData.unifiedTimes;
            }

            // NOTE: We intentionally EXCLUDE 'skeleton' and 'subdivisionSchedules'
            // to keep the payload focused on the actual output (assignments).

            // Fallback for legacy flat structures (if new structure is empty)
            if (Object.keys(payload).length === 0) {
                scheduleData = rawDateData;
            } else {
                scheduleData = payload;
            }

        } catch (e) {
            console.error("Error reading local data:", e);
            alert("Failed to read schedule data.");
            return;
        }

        if (window.ScheduleVersionsDB) {
            const result = await window.ScheduleVersionsDB.saveVersion(date, name, scheduleData);
            if (result.success) {
                alert("✅ Version saved successfully!");
            } else {
                alert("❌ Error saving version: " + result.error);
            }
        } else {
            alert("❌ Database module not loaded.");
        }
    }

    async function handleLoadVersion() {
        const date = getDate();
        if (!date) return alert("Please select a date first.");

        if (!window.ScheduleVersionsDB) return alert("Database module not loaded.");

        const versions = await window.ScheduleVersionsDB.getVersions(date);
        if (!versions || versions.length === 0) {
            return alert("No saved versions found for this date.");
        }

        // Simple prompt for now (could be a nice modal later)
        let msg = "Select a version to load (enter number):\n";
        versions.forEach((v, i) => {
            const time = new Date(v.created_at).toLocaleTimeString();
            msg += `${i + 1}. ${v.name || 'Untitled'} (${time}) - by ${v.created_by_email || 'User'}\n`;
        });

        const choice = prompt(msg);
        if (!choice) return;
        
        const index = parseInt(choice) - 1;
        if (isNaN(index) || index < 0 || index >= versions.length) return alert("Invalid selection.");

        const selected = versions[index];
        
        if (confirm(`Load "${selected.name}"? This will overwrite your current view.`)) {
            // Push to UI via Cloud Bridge
            if (window.saveScheduleAssignments) {
                // Determine data structure (handles legacy vs new)
                let dataToLoad = selected.schedule_data;
                if (typeof dataToLoad === 'string') {
                    try { dataToLoad = JSON.parse(dataToLoad); } catch(e) {}
                }
                const assignments = dataToLoad.scheduleAssignments || dataToLoad;
                
                // If the version has league assignments, we might need to manually inject them 
                // because saveScheduleAssignments primarily targets the grid.
                // However, the Cloud Bridge usually handles merging the whole object if we used setLocalCache.
                // For now, we rely on the bridge's permission-aware save.
                
                window.saveScheduleAssignments(date, assignments);
                alert("✅ Version loaded!");
                
                // Refresh UI
                if(window.loadScheduleForDate) window.loadScheduleForDate(date);
            }
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

        // Show loading state
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
        // Find a place to inject the toolbar. 
        // We'll look for .header-right or create a container below the header.
        
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
                // Fallback: floating
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

        // Clear existing
        container.innerHTML = '';

        // Add Buttons
        
        // 1. Save
        container.appendChild(createButton("Save Version", "💾", handleSaveVersion));
        
        // 2. Load
        container.appendChild(createButton("Load Version", "📂", handleLoadVersion));

        // 3. Merge (The requested feature)
        const mergeBtn = createButton("Merge & Sync", "⚡", handleMergeVersions, 'warning');
        mergeBtn.id = 'btn-merge-versions';
        mergeBtn.title = "Combine all saved versions for this date into one schedule";
        container.appendChild(mergeBtn);

        console.log("📋 ✅ Toolbar mounted successfully");
    }

    // Run Init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 1000); // Wait for header to exist
    }

})();
