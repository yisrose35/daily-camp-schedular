// ============================================================================
// fluid_scheduler_ui.js — UI Components for Fluid Scheduling (v1.0)
// ============================================================================
//
// Adds two new sections to the Special Activities detail pane:
//   1. Activity Duration — how long this activity takes
//   2. Fluid Scheduling — available days + must-schedule flag
//
// These functions are designed to be called from special_activities.js
// via the section() builder, just like renderMaxUsageSettings etc.
//
// OPTION A: Paste these functions directly into special_activities.js
// OPTION B: Load this file after special_activities.js (uses window hooks)
//
// LOAD ORDER: After special_activities.js
// ============================================================================

(function() {
    'use strict';

    // ========================================================================
    // RENDER: Activity Duration Settings
    // ========================================================================

    function renderDurationSettings(item) {
        const container = document.createElement("div");
        const saveData = window._fluidUI_saveData || function() {
            // Fallback: try to call the special_activities save
            if (window.saveGlobalSpecialActivities) {
                const all = [...(window.getSpecialActivities?.() || []), ...(window.getRainyDayActivities?.() || [])];
                window.saveGlobalSpecialActivities(all);
            }
        };

        const updateSummary = () => {
            const s = container.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (s) {
                const d = parseInt(item.duration) || 0;
                if (d <= 0) s.textContent = 'Not set';
                else if (item.prepDuration > 0) s.textContent = d + 'min (+' + item.prepDuration + 'min prep)';
                else s.textContent = d + ' minutes';
            }
        };

        const currentVal = parseInt(item.duration) || 0;
        const isSet = currentVal > 0;
        const prepMin = parseInt(item.prepDuration) || 0;

        const desc = document.createElement("p");
        desc.style.cssText = "font-size:0.85rem; color:#6b7280; margin:0 0 14px 0;";
        desc.innerHTML = 'How long this activity takes when scheduled. Used by the <strong>Auto Scheduler</strong> to build time slots around activity needs. In structured mode, helps validate slot sizes.';
        container.appendChild(desc);

        const inputArea = document.createElement("div");
        inputArea.style.cssText = "background:#f0f9fb; border:1px solid #b2dce6; border-radius:10px; padding:14px;";

        // Toggle
        const toggleRow = document.createElement("div");
        toggleRow.style.cssText = "display:flex; align-items:center; gap:12px; margin-bottom:" + (isSet ? "12px" : "0") + ";";
        toggleRow.innerHTML = '<div style="flex:1;"><div style="font-weight:600; color:' + (isSet ? '#0A4A56' : '#374151') + ';">' + (isSet ? 'Fixed Duration' : 'No Duration Set') + '</div><div style="font-size:0.8rem; color:' + (isSet ? '#0F5F6E' : '#6b7280') + ';">' + (isSet ? currentVal + ' minutes' : 'Uses whatever slot size is given') + '</div></div><label class="switch"><input type="checkbox" id="fluid-duration-toggle" ' + (isSet ? 'checked' : '') + '><span class="slider"></span></label>';
        inputArea.appendChild(toggleRow);

        // Config
        const configDiv = document.createElement("div");
        configDiv.id = "fluid-duration-config";
        configDiv.style.display = isSet ? "block" : "none";

        // Input row
        const inputRow = document.createElement("div");
        inputRow.style.cssText = "display:flex; align-items:center; gap:10px; padding:10px; background:white; border-radius:8px; border:1px solid #b2dce6;";
        inputRow.innerHTML = '<label style="font-size:0.85rem; font-weight:500;">Duration:</label><input type="number" id="fluid-duration-input" min="5" max="180" step="5" value="' + (currentVal || 30) + '" style="width:70px; padding:6px 10px; border:1px solid #b2dce6; border-radius:6px; text-align:center;"><span style="font-size:0.85rem; color:#64748b;">minutes</span>';
        configDiv.appendChild(inputRow);

        // Prep total
        if (prepMin > 0) {
            const totalNote = document.createElement("div");
            totalNote.id = "fluid-duration-total";
            totalNote.style.cssText = "margin-top:8px; padding:8px 10px; background:#faf5ff; border:1px solid #e9d5ff; border-radius:8px; font-size:0.82rem; color:#6b21a8;";
            totalNote.innerHTML = '⏱️ Total: <strong>' + ((currentVal || 30) + prepMin) + 'min</strong> (' + (currentVal || 30) + ' activity + ' + prepMin + ' prep)';
            configDiv.appendChild(totalNote);
        }

        // Quick-set
        const quickSet = document.createElement("div");
        quickSet.style.cssText = "margin-top:10px; display:flex; gap:6px; flex-wrap:wrap;";
        [15, 20, 25, 30, 40, 45, 60, 90].forEach(mins => {
            const btn = document.createElement("button");
            btn.textContent = mins + 'm';
            const isActive = currentVal === mins;
            btn.style.cssText = "padding:4px 10px; border:1px solid " + (isActive ? '#147D91' : '#d1d5db') + "; background:" + (isActive ? '#e6f4f7' : 'white') + "; border-radius:6px; font-size:0.8rem; cursor:pointer; color:" + (isActive ? '#0A4A56' : '#374151') + ";";
            btn.onclick = () => {
                item.duration = mins;
                const inp = configDiv.querySelector("#fluid-duration-input");
                if (inp) inp.value = mins;
                quickSet.querySelectorAll("button").forEach(b => {
                    const v = parseInt(b.textContent);
                    b.style.borderColor = v === mins ? '#147D91' : '#d1d5db';
                    b.style.background = v === mins ? '#e6f4f7' : 'white';
                    b.style.color = v === mins ? '#0A4A56' : '#374151';
                });
                const tn = configDiv.querySelector("#fluid-duration-total");
                if (tn) tn.innerHTML = '⏱️ Total: <strong>' + (mins + prepMin) + 'min</strong> (' + mins + ' + ' + prepMin + ' prep)';
                saveData();
                updateSummary();
            };
            quickSet.appendChild(btn);
        });
        configDiv.appendChild(quickSet);
        inputArea.appendChild(configDiv);
        container.appendChild(inputArea);

        // Bind toggle
        const tog = container.querySelector("#fluid-duration-toggle");
        if (tog) {
            tog.addEventListener("change", function() {
                configDiv.style.display = this.checked ? "block" : "none";
                item.duration = this.checked ? (parseInt(container.querySelector("#fluid-duration-input")?.value, 10) || 30) : null;
                saveData();
                updateSummary();
            });
        }

        // Bind input
        const durInput = container.querySelector("#fluid-duration-input");
        if (durInput) {
            durInput.addEventListener("change", function() {
                const v = parseInt(this.value, 10);
                if (!isNaN(v) && v >= 5 && v <= 180) {
                    item.duration = v;
                    const tn = configDiv.querySelector("#fluid-duration-total");
                    if (tn) tn.innerHTML = '⏱️ Total: <strong>' + (v + prepMin) + 'min</strong> (' + v + ' + ' + prepMin + ' prep)';
                    quickSet.querySelectorAll("button").forEach(b => {
                        const bv = parseInt(b.textContent);
                        b.style.borderColor = bv === v ? '#147D91' : '#d1d5db';
                        b.style.background = bv === v ? '#e6f4f7' : 'white';
                        b.style.color = bv === v ? '#0A4A56' : '#374151';
                    });
                    saveData();
                    updateSummary();
                }
            });
        }

        return container;
    }

    // ========================================================================
    // RENDER: Fluid Scheduling Mode Settings
    // ========================================================================

    function renderFluidModeSettings(item) {
        const container = document.createElement("div");
        const saveData = window._fluidUI_saveData || function() {
            if (window.saveGlobalSpecialActivities) {
                const all = [...(window.getSpecialActivities?.() || []), ...(window.getRainyDayActivities?.() || [])];
                window.saveGlobalSpecialActivities(all);
            }
        };

        const updateSummary = () => {
            const s = container.closest('.detail-section')?.querySelector('.detail-section-summary');
            if (s) {
                const parts = [];
                if (item.mustScheduleWhenAvailable) parts.push('Must schedule');
                if (item.availableDays?.length > 0) parts.push(item.availableDays.map(d => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(', '));
                s.textContent = parts.length > 0 ? parts.join(' · ') : 'Standard rotation';
            }
        };

        // Description
        const desc = document.createElement("p");
        desc.style.cssText = "font-size:0.85rem; color:#6b7280; margin:0 0 14px 0;";
        desc.innerHTML = 'For <strong>external visitors</strong> or activities that only happen on certain days. When enabled, the scheduler will <strong>prioritize</strong> this activity on the days it\'s available and ensure every bunk gets it.';
        container.appendChild(desc);

        // Must Schedule Toggle
        const mustSchedule = item.mustScheduleWhenAvailable === true;
        const mustDiv = document.createElement("div");
        mustDiv.style.cssText = "background:" + (mustSchedule ? '#fef0e8' : '#f9fafb') + "; border:1px solid " + (mustSchedule ? '#f5c6a5' : '#e5e7eb') + "; border-radius:10px; padding:14px; margin-bottom:14px;";
        mustDiv.innerHTML = '<div style="display:flex; align-items:center; gap:12px;"><div style="flex:1;"><div style="font-weight:600; color:' + (mustSchedule ? '#dc6b35' : '#374151') + ';">' + (mustSchedule ? 'Must Schedule When Available' : 'Standard Rotation') + '</div><div style="font-size:0.8rem; color:' + (mustSchedule ? '#c2571f' : '#6b7280') + ';">' + (mustSchedule ? 'Every bunk gets this on days it\'s available' : 'Scheduled through normal rotation fairness') + '</div></div><label class="switch"><input type="checkbox" id="fluid-must-toggle" ' + (mustSchedule ? 'checked' : '') + '><span class="slider"></span></label></div>';
        container.appendChild(mustDiv);

        // Available Days
        const daysSection = document.createElement("div");
        daysSection.id = "fluid-days-section";
        daysSection.style.display = mustSchedule ? "block" : "none";

        const daysLabel = document.createElement("div");
        daysLabel.style.cssText = "font-weight:600; font-size:0.85rem; margin-bottom:8px; color:#374151;";
        daysLabel.textContent = "Available Days";
        daysSection.appendChild(daysLabel);

        const daysHint = document.createElement("div");
        daysHint.style.cssText = "font-size:0.82rem; color:#6b7280; margin-bottom:10px;";
        daysHint.textContent = "Which days of the week does this person/activity come? Leave all unchecked for every day.";
        daysSection.appendChild(daysHint);

        const daysGrid = document.createElement("div");
        daysGrid.style.cssText = "display:flex; gap:6px; flex-wrap:wrap;";

        const allDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
        const currentDays = item.availableDays || [];

        allDays.forEach(day => {
            const isActive = currentDays.includes(day);
            const chip = document.createElement("button");
            chip.textContent = day.charAt(0).toUpperCase() + day.slice(1, 3);
            chip.dataset.day = day;
            chip.style.cssText = "padding:6px 14px; border:1px solid " + (isActive ? '#147D91' : '#d1d5db') + "; background:" + (isActive ? '#e6f4f7' : 'white') + "; border-radius:8px; font-size:0.85rem; cursor:pointer; font-weight:" + (isActive ? '600' : '400') + "; color:" + (isActive ? '#0A4A56' : '#6b7280') + "; transition:all 0.15s;";

            chip.onclick = () => {
                if (!item.availableDays) item.availableDays = [];

                if (item.availableDays.includes(day)) {
                    item.availableDays = item.availableDays.filter(d => d !== day);
                } else {
                    item.availableDays.push(day);
                }

                // If empty, set to null (means every day)
                if (item.availableDays.length === 0) item.availableDays = null;

                // Update all chip styles
                daysGrid.querySelectorAll("button").forEach(b => {
                    const d = b.dataset.day;
                    const active = item.availableDays?.includes(d);
                    b.style.borderColor = active ? '#147D91' : '#d1d5db';
                    b.style.background = active ? '#e6f4f7' : 'white';
                    b.style.fontWeight = active ? '600' : '400';
                    b.style.color = active ? '#0A4A56' : '#6b7280';
                });

                saveData();
                updateSummary();
            };

            daysGrid.appendChild(chip);
        });

        daysSection.appendChild(daysGrid);

        // Note about all unchecked
        const allNote = document.createElement("div");
        allNote.style.cssText = "margin-top:8px; font-size:0.78rem; color:#9CA3AF; font-style:italic;";
        allNote.textContent = "No days selected = available every day";
        daysSection.appendChild(allNote);

        container.appendChild(daysSection);

        // Bind must-schedule toggle
        const mustTog = container.querySelector("#fluid-must-toggle");
        if (mustTog) {
            mustTog.addEventListener("change", function() {
                item.mustScheduleWhenAvailable = this.checked;
                daysSection.style.display = this.checked ? "block" : "none";

                // Update the must-schedule card styling
                mustDiv.style.background = this.checked ? '#fef0e8' : '#f9fafb';
                mustDiv.style.borderColor = this.checked ? '#f5c6a5' : '#e5e7eb';
                const titleEl = mustDiv.querySelector('div > div > div:first-child');
                const subtitleEl = mustDiv.querySelector('div > div > div:nth-child(2)');
                if (titleEl) {
                    titleEl.style.color = this.checked ? '#dc6b35' : '#374151';
                    titleEl.textContent = this.checked ? 'Must Schedule When Available' : 'Standard Rotation';
                }
                if (subtitleEl) {
                    subtitleEl.style.color = this.checked ? '#c2571f' : '#6b7280';
                    subtitleEl.textContent = this.checked ? 'Every bunk gets this on days it\'s available' : 'Scheduled through normal rotation fairness';
                }

                saveData();
                updateSummary();
            });
        }

        return container;
    }

    // ========================================================================
    // EXPORTS — Attach to window so special_activities.js can use them
    // ========================================================================

    window.renderDurationSettings = renderDurationSettings;
    window.renderFluidModeSettings = renderFluidModeSettings;

    console.log('🌊 Auto Scheduler UI components loaded');

})();
