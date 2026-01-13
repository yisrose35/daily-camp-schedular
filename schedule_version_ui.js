// =================================================================
// schedule_version_ui.js
// UI for Managing Schedule Versions (Save, Load, Merge)
// VERSION: v3.9 (RESTORED DB MODULE)
// =================================================================

(function () {
    'use strict';

    console.log("📋 Schedule Version UI v3.9 (RESTORED DB MODULE) loading...");

    const CONTAINER_ID = "version-toolbar-container";

    // =================================================================
    // HELPERS
    // =================================================================
    function getDate() {
        const input = document.getElementById('calendar-date-picker') || document.getElementById('schedule-date-input');
        return input ? input.value : null;
    }

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
        // Styling logic omitted for brevity, identical to previous
        if (variant === 'warning') {
            btn.style.background = '#f59e0b'; btn.style.color = 'white'; btn.style.borderColor = '#d97706';
            btn.onmouseover = () => btn.style.background = '#d97706';
            btn.onmouseout = () => btn.style.background = '#f59e0b';
        } else {
            btn.onmouseover = () => btn.style.background = '#f3f4f6';
            btn.onmouseout = () => btn.style.background = 'white';
        }
        btn.onclick = (e) => { e.preventDefault(); onClick(); };
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

        // 1. Filter Data
        let payload = {};
        try {
            const dailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            const rawDateData = dailyData[date] || {};

            if (rawDateData.scheduleAssignments) payload.scheduleAssignments = rawDateData.scheduleAssignments;
            if (rawDateData.leagueAssignments) payload.leagueAssignments = rawDateData.leagueAssignments;
            if (rawDateData.unifiedTimes) payload.unifiedTimes = rawDateData.unifiedTimes;

            if (Object.keys(payload).length === 0) payload = rawDateData;
        } catch (e) {
            console.error("Error reading data", e);
            return alert("Failed to read schedule data");
        }

        // 2. Use DB Module
        if (window.ScheduleVersionsDB) {
            // Using the alias or main method
            const result = await window.ScheduleVersionsDB.createVersion(date, name, payload);
            
            if (result.success) {
                alert("✅ Version saved successfully!");
            } else {
                console.error("Save error:", result.error);
                alert("❌ Error saving version: " + result.error);
            }
        } else {
            alert("❌ DB Module not loaded. Refresh page.");
        }
    }

    async function handleLoadVersion() {
        const date = getDate();
        if (!date) return alert("Please select a date.");

        if (!window.ScheduleVersionsDB) return alert("DB Module not loaded.");

        const versions = await window.ScheduleVersionsDB.listVersions(date);
        if (!versions.length) return alert("No saved versions found.");

        let msg = "Select a version to load:\n";
        versions.forEach((v, i) => {
            const time = new Date(v.created_at).toLocaleTimeString();
            msg += `${i + 1}. ${v.name} (${time})\n`;
        });

        const choice = prompt(msg);
        if (!choice) return;
        const index = parseInt(choice) - 1;
        if (isNaN(index) || !versions[index]) return alert("Invalid selection");

        const selected = versions[index];
        if (confirm(`Load "${selected.name}"? Overwrites current view.`)) {
            if (window.saveScheduleAssignments) {
                // Handle JSON strings if necessary
                let data = selected.schedule_data;
                if (typeof data === 'string') try { data = JSON.parse(data); } catch(e){}
                
                const assignments = data.scheduleAssignments || data;
                window.saveScheduleAssignments(date, assignments);
                alert("✅ Loaded!");
                
                if (window.loadScheduleForDate) window.loadScheduleForDate(date);
            }
        }
    }

    async function handleMergeVersions() {
        const date = getDate();
        if (!date) return alert("Please select a date.");
        if (!window.ScheduleVersionMerger) return alert("Merger service not loaded.");

        if (!confirm(`Merge ALL versions for ${date}?`)) return;

        const btn = document.getElementById('btn-merge-versions');
        const orig = btn ? btn.innerHTML : '';
        if(btn) btn.innerHTML = '<span>⏳</span> Merging...';

        try {
            const result = await window.ScheduleVersionMerger.mergeAndPush(date);
            if (result.success) {
                alert(`✅ Merged ${result.count} versions (${result.bunks} bunks).`);
            } else {
                alert("❌ Merge failed: " + result.error);
            }
        } catch(e) {
            console.error(e);
            alert("Error merging.");
        } finally {
            if(btn) btn.innerHTML = orig;
        }
    }

    // =================================================================
    // INIT
    // =================================================================
    function init() {
        let container = document.getElementById(CONTAINER_ID);
        if (!container) {
            const header = document.querySelector('.app-header');
            if (header) {
                const wrapper = document.createElement('div');
                wrapper.style.cssText = "background:#f8fafc; border-bottom:1px solid #e2e8f0; padding:8px 24px; display:flex; justify-content:flex-end;";
                container = document.createElement('div');
                container.id = CONTAINER_ID;
                container.style.cssText = "display:flex; gap:10px;";
                wrapper.appendChild(container);
                header.parentNode.insertBefore(wrapper, header.nextSibling);
            } else {
                container = document.createElement('div');
                container.id = CONTAINER_ID;
                document.body.appendChild(container);
            }
        }

        container.innerHTML = '';
        container.appendChild(createButton("Save Version", "💾", handleSaveVersion));
        container.appendChild(createButton("Load Version", "📂", handleLoadVersion));
        
        const mergeBtn = createButton("Merge & Sync", "⚡", handleMergeVersions, 'warning');
        mergeBtn.id = "btn-merge-versions";
        container.appendChild(mergeBtn);
        
        console.log("📋 ✅ Toolbar mounted");
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 1000);

})();
