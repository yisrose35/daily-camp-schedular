// ============================================================================
// analytics.js
//
// UPDATED:
// - Added "Usage Manager" view to manually adjust activity counts.
// - Cleaned, formatted, structured into logical sections.
// - Refactored to use window.SchedulerCoreUtils for time/string helpers.
// ============================================================================

(function () {
    'use strict';

    const MIN_USABLE_GAP = 5;

    // ========================================================================
    // TIME HELPERS
    // ========================================================================

    // REMOVED: parseTimeToMinutes (Use window.SchedulerCoreUtils.parseTimeToMinutes)
    // REMOVED: minutesToTime (Use window.SchedulerCoreUtils.minutesToTimeLabel)
    // REMOVED: fieldLabel (Use window.SchedulerCoreUtils.fieldLabel)
    // REMOVED: isTimeAvailable (Use window.SchedulerCoreUtils.isTimeAvailable if needed)

    function getEntryTimes(entry, fallback, incMin) {
        let start = entry.start || entry.startTime || entry.s || (fallback ? fallback.start : null);
        let end = entry.end || entry.endTime || entry.e;

        if (start && !end) {
            // UPDATED: Use Utils
            const sm = window.SchedulerCoreUtils.parseTimeToMinutes(start);
            // UPDATED: Use Utils
            if (sm != null) end = window.SchedulerCoreUtils.minutesToTimeLabel(sm + incMin);
        }

        return { start, end };
    }


    // ========================================================================
    // STATE
    // ========================================================================

    let container = null;
    let allActivities = [];
    let availableDivisions = [];
    let divisions = {};


    // ========================================================================
    // REPORT TAB INITIALIZER
    // ========================================================================

    function initReportTab() {
        container = document.getElementById("report-content");
        if (!container) return;

        container.innerHTML = `
            <div class="league-nav" style="background:#e3f2fd;border-color:#90caf9;padding:10px;margin-bottom:15px;border-radius:8px;">
                <label for="report-view-select" style="color:#1565c0;font-weight:bold;">Select Report:</label>

                <select id="report-view-select" style="font-size:1em;padding:5px;">
                    <option value="availability">Field Availability Grid</option>
                    <option value="rotation">Bunk Rotation Report</option>
                    <option value="usage">Usage Manager (Limits)</option>
                </select>
            </div>

            <div id="report-availability-content" class="league-content-pane active"></div>
            <div id="report-rotation-content" class="league-content-pane" style="display:none;"></div>
            <div id="report-usage-content" class="league-content-pane" style="display:none;"></div>
        `;

        loadMasterData();
        renderFieldAvailabilityGrid();
        renderBunkRotationUI();
        renderUsageManagerUI();

        const select = document.getElementById("report-view-select");
        if (select) {
            select.onchange = (e) => {
                const val = e.target.value;

                // Hide all
                document.querySelectorAll(".league-content-pane")
                    .forEach(el => el.style.display = "none");

                // Show chosen
                document.getElementById(`report-${val}-content`).style.display = "block";

                if (val === "availability") renderFieldAvailabilityGrid();
                else if (val === "usage") renderUsageManagerUI();
            };
        }
    }


    // ========================================================================
    // MASTER DATA LOADING
    // ========================================================================

    function loadMasterData() {
        try {
            const g = window.loadGlobalSettings?.() || {};

            divisions = window.divisions || {};
            availableDivisions = (window.availableDivisions || []).sort();

            const fields = g.app1?.fields || [];
            const specials = g.app1?.specialActivities || [];

            allActivities = [

                // sports from fields
                ...fields.flatMap(f =>
                    (f.activities || []).map(a => ({
                        name: a,
                        type: "sport"
                    }))
                ),

                // special activities with limits
                ...specials.map(s => ({
                    name: s.name,
                    type: "special",
                    max: s.maxUsage || 0
                }))
            ];

        } catch (e) {
            allActivities = [];
        }
    }


    // ========================================================================
    // USAGE MANAGER – MAIN UI
    // ========================================================================

    function renderUsageManagerUI() {
        const wrapper = document.getElementById("report-usage-content");
        if (!wrapper) return;

        wrapper.innerHTML = `
            <h2 class="report-title" style="border-bottom:2px solid #007BFF;">
                Usage Manager
            </h2>

            <p style="color:#666;">
                Manually adjust counts here. If a bunk missed an activity, set Adjustment to
                <strong>-1</strong>. If they did extra, set <strong>+1</strong>.
            </p>

            <div style="margin-bottom:15px;">
                <label>Select Division:</label>
                <select id="usage-div-select" style="padding:5px;">
                    <option value="">-- Select --</option>
                </select>
            </div>

            <div id="usage-table-container"></div>
        `;

        const sel = document.getElementById("usage-div-select");
        availableDivisions.forEach(d =>
            sel.innerHTML += `<option value="${d}">${d}</option>`
        );

        sel.onchange = () => renderUsageTable(sel.value);
    }


    // ========================================================================
    // USAGE MANAGER – TABLE RENDER
    // ========================================================================

    function renderUsageTable(divName) {
        const container = document.getElementById("usage-table-container");
        if (!divName) {
            container.innerHTML = "";
            return;
        }

        const bunks = divisions[divName]?.bunks || [];
        if (!bunks.length) {
            container.innerHTML = "No bunks.";
            return;
        }

        // Only special activities (limited)
        const limitedActivities = allActivities.filter(a => a.type === "special");
        if (!limitedActivities.length) {
            container.innerHTML = "No special activities defined.";
            return;
        }

        // Load data
        const allDaily = window.loadAllDailyData?.() || {};
        const global = window.loadGlobalSettings?.() || {};
        const manualOffsets = global.manualUsageOffsets || {};

        // Compute raw historical counts
        const rawCounts = {};
        Object.values(allDaily).forEach(day => {
            const sched = day.scheduleAssignments || {};

            Object.keys(sched).forEach(bunk => {
                if (!bunks.includes(bunk)) return;

                (sched[bunk] || []).forEach(entry => {
                    if (entry && entry._activity && !entry.continuation) {
                        rawCounts[bunk] = rawCounts[bunk] || {};
                        rawCounts[bunk][entry._activity] =
                            (rawCounts[bunk][entry._activity] || 0) + 1;
                    }
                });
            });
        });

        // DEBUG hook
        window.debugAnalyticsRawCounts = rawCounts;

        // Build table
        let html = `
            <table class="report-table">
                <thead>
                    <tr>
                        <th>Bunk</th>
                        <th>Activity</th>
                        <th>History Count</th>
                        <th>Manual Adj (+/-)</th>
                        <th>Effective Total</th>
                        <th>Max Limit</th>
                    </tr>
                </thead>
                <tbody>
        `;

        bunks.forEach(bunk => {
            limitedActivities.forEach(act => {
                const hist = rawCounts[bunk]?.[act.name] || 0;
                const offset = manualOffsets[bunk]?.[act.name] || 0;
                const total = Math.max(0, hist + offset);
                const limit = act.max > 0 ? act.max : "∞";

                let rowStyle = "";
                if (act.max > 0 && total >= act.max)
                    rowStyle = "background:#ffebee;";

                html += `
                    <tr style="${rowStyle}">
                        <td><strong>${bunk}</strong></td>
                        <td>${act.name}</td>
                        <td style="text-align:center;">${hist}</td>

                        <td style="text-align:center;">
                            <input
                                type="number"
                                class="usage-adj-input"
                                data-bunk="${bunk}"
                                data-act="${act.name}"
                                value="${offset}"
                                style="width:50px;text-align:center;"
                            />
                        </td>

                        <td style="text-align:center;font-weight:bold;">
                            ${total}
                        </td>

                        <td style="text-align:center;">
                            ${limit}
                        </td>
                    </tr>
                `;
            });
        });

        html += `</tbody></table>`;
        container.innerHTML = html;

        // Bind input handlers
        container.querySelectorAll(".usage-adj-input").forEach(inp => {
            inp.onchange = (e) => {
                const bunk = e.target.dataset.bunk;
                const act = e.target.dataset.act;
                const val = parseInt(e.target.value) || 0;

                if (!global.manualUsageOffsets) global.manualUsageOffsets = {};
                if (!global.manualUsageOffsets[bunk]) global.manualUsageOffsets[bunk] = {};

                global.manualUsageOffsets[bunk][act] = val;

                // Clean up zero offsets
                if (val === 0) delete global.manualUsageOffsets[bunk][act];

                window.saveGlobalSettings("manualUsageOffsets", global.manualUsageOffsets);

                // Refresh UI
                renderUsageTable(divName);
            };
        });
    }


    // ========================================================================
    // FIELD AVAILABILITY GRID
    // ========================================================================

    function renderFieldAvailabilityGrid() {
        const wrapper = document.getElementById("report-availability-content");
        if (!wrapper) return;

        // First-time render: Insert controls
        if (!document.getElementById("avail-filter-controls")) {
            wrapper.innerHTML = `
                <div id="avail-filter-controls"
                     style="margin-bottom:15px;display:flex;gap:15px;align-items:center;flex-wrap:wrap;">
                     
                    <h2 style="margin:0;font-size:1.5em;color:#1a5fb4;">
                        Field Availability
                    </h2>

                    <select id="avail-type-filter" style="padding:5px;font-size:1rem;">
                        <option value="all">Show All Resources</option>
                        <option value="field">Fields Only</option>
                        <option value="special">Special Activities Only</option>
                    </select>

                    <div style="font-size:0.9em;color:#555;">
                        <strong>Key:</strong>
                        <span style="color:#2e7d32;background:#e8f5e9;padding:0 4px;font-weight:bold;">✓</span> Free 
                        <span style="color:#c62828;background:#ffebee;padding:0 4px;font-weight:bold;">X</span> Blocked
                    </div>
                </div>

                <div id="avail-grid-wrapper"></div>
            `;

            document.getElementById("avail-type-filter").onchange =
                renderFieldAvailabilityGrid;
        }

        const gridDiv = document.getElementById("avail-grid-wrapper");
        const filter = document.getElementById("avail-type-filter").value;

        const unifiedTimes =
            window.unifiedTimes ||
            window.loadCurrentDailyData?.().unifiedTimes ||
            [];

        if (!unifiedTimes.length) {
            gridDiv.innerHTML = "<p class='report-muted'>No schedule.</p>";
            return;
        }

        const gs = window.loadGlobalSettings?.().app1 || {};

        const fields = (gs.fields || []).map(f => ({
            ...f,
            type: "field"
        }));

        const specials = (gs.specialActivities || []).map(s => ({
            ...s,
            type: "special"
        }));

        let resources = [...fields, ...specials].sort((a, b) =>
            a.name.localeCompare(b.name)
        );

        if (filter === "field") resources = fields;
        if (filter === "special") resources = specials;


        // Build usage map from daily assignments
        const usageMap = {};
        const assignments =
            window.loadCurrentDailyData?.().scheduleAssignments || {};

        Object.values(assignments).forEach(sched => {
            if (!Array.isArray(sched)) return;

            sched.forEach((entry, idx) => {
                if (entry && entry.field && entry.field !== "Free" && entry.field !== "No Field") {
                    // UPDATED: Use Utils
                    const name = window.SchedulerCoreUtils.fieldLabel(entry.field);
                    if (!usageMap[idx]) usageMap[idx] = {};
                    usageMap[idx][name] = true;
                }
            });
        });


        // Build grid
        let html = `
            <div class="schedule-view-wrapper">
                <table class="availability-grid">
                    <thead>
                        <tr>
                            <th style="position:sticky;left:0;z-index:10;">Time</th>
        `;

        resources.forEach(r => html += `<th>${r.name}</th>`);
        html += `</tr></thead><tbody>`;

        unifiedTimes.forEach((slot, i) => {
            // Compute time label
            let tLabel = "Time";
            try {
                const d = new Date(slot.start);
                let h = d.getHours();
                const m = d.getMinutes();
                const ap = h >= 12 ? "PM" : "AM";
                h = h % 12 || 12;
                tLabel = `${h}:${m < 10 ? "0" + m : m} ${ap}`;
            } catch (e) { }

            html += `
                <tr>
                    <td style="position:sticky;left:0;background:#fdfdfd;font-weight:bold;">
                        ${tLabel}
                    </td>
            `;

            resources.forEach(r => {
                const isUsed = usageMap[i]?.[r.name];
                if (isUsed)
                    html += `<td class="avail-x">X</td>`;
                else
                    html += `<td class="avail-check">✓</td>`;
            });

            html += `</tr>`;
        });

        html += `</tbody></table></div>`;
        gridDiv.innerHTML = html;
    }


    // ========================================================================
    // ROTATION REPORT – PLACEHOLDER
    // ========================================================================

    function renderBunkRotationUI() {
        const el = document.getElementById("report-rotation-content");

        if (el && !el.innerHTML) {
            el.innerHTML = `
                <p class="report-muted">
                    Select 'Bunk Rotation Report' from dropdown to view.
                </p>
            `;
        }
    }


    // ========================================================================
    // EXPORT
    // ========================================================================

    window.initReportTab = initReportTab;

})();
