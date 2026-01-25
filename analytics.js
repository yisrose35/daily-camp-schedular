// ============================================================================
// analytics.js
//
// SUPERCHARGED VERSION:
// - Enhanced Field Availability Grid with partial availability display
// - Bunk Rotation Report with activity counts + last done + manual adjustments
// - Removed separate Usage Manager (merged into Rotation Report)
// - 30-minute increments from camp start to end time
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // TIME HELPERS
    // ========================================================================

    /**
     * Parse time string to minutes since midnight
     * Supports: "9:00am", "9:00 AM", "09:00", "9:00"
     */
    function parseTimeToMinutes(timeStr) {
        if (window.SchedulerCoreUtils?.parseTimeToMinutes) {
            return window.SchedulerCoreUtils.parseTimeToMinutes(timeStr);
        }
        if (!timeStr) return null;
        const str = timeStr.toString().toLowerCase().trim();
        const match = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
        if (!match) return null;
        let h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        const ap = match[3];
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return h * 60 + m;
    }

    /**
     * Convert minutes to time label (e.g., 570 → "9:30 AM")
     */
    function minutesToTimeLabel(mins) {
        if (window.SchedulerCoreUtils?.minutesToTimeLabel) {
            return window.SchedulerCoreUtils.minutesToTimeLabel(mins);
        }
        let h = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m < 10 ? '0' + m : m} ${ap}`;
    }

    /**
     * Get field label (handle object vs string)
     */
    function fieldLabel(f) {
        if (window.SchedulerCoreUtils?.fieldLabel) {
            return window.SchedulerCoreUtils.fieldLabel(f);
        }
        if (!f) return '';
        return typeof f === 'object' ? (f.name || f.field || '') : f;
    }

    /**
     * Get camp start/end times from config
     */
    function getCampTimes() {
        const gs = window.loadGlobalSettings?.() || {};
        const app1 = gs.app1 || window.app1 || {};
        
        const startTime = app1.startTime || "9:00am";
        const endTime = app1.endTime || "4:00pm";
        
        const startMin = parseTimeToMinutes(startTime) || 540; // 9:00 AM
        const endMin = parseTimeToMinutes(endTime) || 960;     // 4:00 PM
        
        return { startMin, endMin, startTime, endTime };
    }

    /**
     * Generate 30-minute time slots from camp start to end
     */
    function generate30MinSlots() {
        const { startMin, endMin } = getCampTimes();
        const slots = [];
        
        for (let min = startMin; min < endMin; min += 30) {
            slots.push({
                startMin: min,
                endMin: min + 30,
                label: minutesToTimeLabel(min) + ' - ' + minutesToTimeLabel(min + 30)
            });
        }
        
        return slots;
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
                    <option value="rotation">Bunk Rotation & Usage</option>
                </select>
            </div>

            <div id="report-availability-content" class="league-content-pane active"></div>
            <div id="report-rotation-content" class="league-content-pane" style="display:none;"></div>
        `;

        loadMasterData();
        renderFieldAvailabilityGrid();
        renderBunkRotationUI();

        const select = document.getElementById("report-view-select");
        if (select) {
            select.onchange = (e) => {
                const val = e.target.value;

                document.querySelectorAll(".league-content-pane")
                    .forEach(el => el.style.display = "none");

                document.getElementById(`report-${val}-content`).style.display = "block";

                if (val === "availability") renderFieldAvailabilityGrid();
                else if (val === "rotation") renderBunkRotationUI();
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
                // Sports from fields
                ...fields.flatMap(f =>
                    (f.activities || []).map(a => ({
                        name: a,
                        type: "sport",
                        max: 0
                    }))
                ),
                // Special activities with limits
                ...specials.map(s => ({
                    name: s.name,
                    type: "special",
                    max: s.maxUsage || 0
                }))
            ];

            // Deduplicate by name
            const seen = new Set();
            allActivities = allActivities.filter(a => {
                if (seen.has(a.name)) return false;
                seen.add(a.name);
                return true;
            });

        } catch (e) {
            console.error('[Analytics] Error loading master data:', e);
            allActivities = [];
        }
    }

    // ========================================================================
    // FIELD AVAILABILITY GRID - SUPERCHARGED
    // ========================================================================

    function renderFieldAvailabilityGrid() {
        const wrapper = document.getElementById("report-availability-content");
        if (!wrapper) return;

        const { startTime, endTime } = getCampTimes();

        wrapper.innerHTML = `
            <h2 class="report-title" style="border-bottom:2px solid #1a5fb4;margin-bottom:15px;">
                📊 Field Availability Grid
            </h2>
            
            <div style="margin-bottom:15px;padding:12px;background:#f8f9fa;border-radius:8px;border:1px solid #dee2e6;">
                <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;">
                    <div>
                        <label style="font-weight:600;color:#495057;">🔍 Quick Search:</label>
                        <select id="avail-field-search" style="padding:6px 10px;margin-left:8px;border-radius:4px;border:1px solid #ced4da;">
                            <option value="">-- Select Field/Activity --</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-weight:600;color:#495057;">⏰ Time:</label>
                        <select id="avail-time-search" style="padding:6px 10px;margin-left:8px;border-radius:4px;border:1px solid #ced4da;">
                            <option value="">-- Select Time --</option>
                        </select>
                    </div>
                    <button id="avail-search-btn" style="padding:6px 16px;background:#1a5fb4;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">
                        Check Availability
                    </button>
                </div>
                <div id="avail-search-result" style="margin-top:10px;display:none;"></div>
            </div>
            
            <div style="margin-bottom:15px;display:flex;gap:15px;align-items:center;flex-wrap:wrap;">
                <select id="avail-type-filter" style="padding:6px 10px;border-radius:4px;border:1px solid #ced4da;">
                    <option value="all">Show All Resources</option>
                    <option value="field">Fields Only</option>
                    <option value="special">Special Activities Only</option>
                </select>
                
                <div style="font-size:0.85em;color:#555;display:flex;gap:15px;flex-wrap:wrap;">
                    <span><span style="display:inline-block;width:20px;height:20px;background:#d4edda;border:1px solid #28a745;text-align:center;line-height:20px;font-weight:bold;color:#155724;">✓</span> Available</span>
                    <span><span style="display:inline-block;width:20px;height:20px;background:#f8d7da;border:1px solid #dc3545;text-align:center;line-height:20px;font-weight:bold;color:#721c24;">✗</span> In Use</span>
                    <span><span style="display:inline-block;width:40px;height:20px;background:linear-gradient(90deg, #f8d7da 50%, #d4edda 50%);border:1px solid #6c757d;text-align:center;line-height:20px;font-size:10px;">⟷</span> Partial</span>
                </div>
            </div>
            
            <p style="color:#6c757d;font-size:0.85em;margin-bottom:10px;">
                Camp hours: <strong>${startTime}</strong> to <strong>${endTime}</strong> (30-minute increments)
            </p>

            <div id="avail-grid-wrapper" style="overflow-x:auto;"></div>
        `;

        // Populate dropdowns and render grid
        populateAvailabilityDropdowns();
        buildAvailabilityGrid();

        // Event listeners
        document.getElementById("avail-type-filter").onchange = buildAvailabilityGrid;
        document.getElementById("avail-search-btn").onclick = performAvailabilitySearch;
    }

    /**
     * Populate the search dropdowns with fields and times
     */
    function populateAvailabilityDropdowns() {
        const gs = window.loadGlobalSettings?.().app1 || {};
        const fields = (gs.fields || []).map(f => ({ name: f.name, type: 'field' }));
        const specials = (gs.specialActivities || []).map(s => ({ name: s.name, type: 'special' }));
        const resources = [...fields, ...specials].sort((a, b) => a.name.localeCompare(b.name));

        const fieldSelect = document.getElementById("avail-field-search");
        resources.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.name;
            opt.textContent = `${r.name} (${r.type})`;
            fieldSelect.appendChild(opt);
        });

        const timeSelect = document.getElementById("avail-time-search");
        const slots = generate30MinSlots();
        slots.forEach(slot => {
            const opt = document.createElement('option');
            opt.value = slot.startMin;
            opt.textContent = slot.label;
            timeSelect.appendChild(opt);
        });
    }

    /**
     * Perform quick availability search
     */
    function performAvailabilitySearch() {
        const fieldName = document.getElementById("avail-field-search").value;
        const timeVal = document.getElementById("avail-time-search").value;
        const resultDiv = document.getElementById("avail-search-result");

        if (!fieldName || !timeVal) {
            resultDiv.style.display = 'block';
            resultDiv.innerHTML = `<div style="color:#856404;background:#fff3cd;padding:8px 12px;border-radius:4px;border:1px solid #ffc107;">⚠️ Please select both a field/activity and a time.</div>`;
            return;
        }

        const slotStartMin = parseInt(timeVal, 10);
        const slotEndMin = slotStartMin + 30;
        const usageData = buildDetailedUsageMap();
        const resourceUsage = usageData[fieldName] || [];

        // Find any usage that overlaps with this slot
        const overlapping = resourceUsage.filter(u => u.startMin < slotEndMin && u.endMin > slotStartMin);

        resultDiv.style.display = 'block';

        if (overlapping.length === 0) {
            resultDiv.innerHTML = `
                <div style="color:#155724;background:#d4edda;padding:10px 14px;border-radius:4px;border:1px solid #28a745;">
                    ✅ <strong>${fieldName}</strong> is <strong>AVAILABLE</strong> from ${minutesToTimeLabel(slotStartMin)} to ${minutesToTimeLabel(slotEndMin)}
                </div>`;
        } else {
            // Check if fully or partially blocked
            const fullyBlocked = overlapping.some(u => u.startMin <= slotStartMin && u.endMin >= slotEndMin);
            
            if (fullyBlocked) {
                const usage = overlapping[0];
                resultDiv.innerHTML = `
                    <div style="color:#721c24;background:#f8d7da;padding:10px 14px;border-radius:4px;border:1px solid #dc3545;">
                        ❌ <strong>${fieldName}</strong> is <strong>UNAVAILABLE</strong> from ${minutesToTimeLabel(slotStartMin)} to ${minutesToTimeLabel(slotEndMin)}<br>
                        <span style="font-size:0.9em;">Used by: <strong>${usage.bunk}</strong> for <strong>${usage.activity}</strong> (${minutesToTimeLabel(usage.startMin)} - ${minutesToTimeLabel(usage.endMin)})</span>
                    </div>`;
            } else {
                // Partial availability
                let details = overlapping.map(u => 
                    `<li><strong>${u.bunk}</strong>: ${u.activity} (${minutesToTimeLabel(u.startMin)} - ${minutesToTimeLabel(u.endMin)})</li>`
                ).join('');
                
                resultDiv.innerHTML = `
                    <div style="color:#856404;background:#fff3cd;padding:10px 14px;border-radius:4px;border:1px solid #ffc107;">
                        ⚠️ <strong>${fieldName}</strong> is <strong>PARTIALLY AVAILABLE</strong> from ${minutesToTimeLabel(slotStartMin)} to ${minutesToTimeLabel(slotEndMin)}<br>
                        <span style="font-size:0.9em;">Conflicts:</span>
                        <ul style="margin:5px 0 0 20px;padding:0;">${details}</ul>
                    </div>`;
            }
        }
    }

    /**
     * Build detailed usage map with exact times
     * Returns: { fieldName: [{ bunk, activity, startMin, endMin }, ...] }
     */
    function buildDetailedUsageMap() {
        const usageMap = {};
        const assignments = window.scheduleAssignments || 
                           window.loadCurrentDailyData?.().scheduleAssignments || {};
        
        // Get division times for accurate slot timing
        const divisionTimes = window.divisionTimes || {};
        const unifiedTimes = window.unifiedTimes || [];

        Object.entries(assignments).forEach(([bunk, schedule]) => {
            if (!Array.isArray(schedule)) return;

            // Determine which division this bunk belongs to
            const divName = getDivisionForBunk(bunk);
            const times = divisionTimes[divName] || unifiedTimes || [];

            schedule.forEach((entry, idx) => {
                if (!entry || entry.continuation) return;
                
                const field = entry.field || entry._field;
                const activity = entry._activity || entry.activity;
                
                if (!field || field === 'Free' || field === 'No Field') return;

                const fName = fieldLabel(field);
                if (!usageMap[fName]) usageMap[fName] = [];

                // Get actual time from slot
                const slotInfo = times[idx];
                let startMin, endMin;

                if (slotInfo) {
                    if (slotInfo.startMin !== undefined) {
                        startMin = slotInfo.startMin;
                        endMin = slotInfo.endMin;
                    } else if (slotInfo.start) {
                        const startDate = new Date(slotInfo.start);
                        const endDate = new Date(slotInfo.end);
                        startMin = startDate.getHours() * 60 + startDate.getMinutes();
                        endMin = endDate.getHours() * 60 + endDate.getMinutes();
                    }
                }

                // Handle multi-slot activities (check for continuations)
                let actualEndMin = endMin;
                for (let i = idx + 1; i < schedule.length; i++) {
                    const nextEntry = schedule[i];
                    if (nextEntry && nextEntry.continuation && 
                        fieldLabel(nextEntry.field || nextEntry._field) === fName) {
                        const nextSlot = times[i];
                        if (nextSlot) {
                            if (nextSlot.endMin !== undefined) {
                                actualEndMin = nextSlot.endMin;
                            } else if (nextSlot.end) {
                                const d = new Date(nextSlot.end);
                                actualEndMin = d.getHours() * 60 + d.getMinutes();
                            }
                        }
                    } else {
                        break;
                    }
                }

                if (startMin !== undefined) {
                    usageMap[fName].push({
                        bunk,
                        activity: activity || 'Unknown',
                        startMin,
                        endMin: actualEndMin || endMin
                    });
                }
            });
        });

        // Also check special activities usage
        Object.entries(assignments).forEach(([bunk, schedule]) => {
            if (!Array.isArray(schedule)) return;

            const divName = getDivisionForBunk(bunk);
            const times = divisionTimes[divName] || unifiedTimes || [];

            schedule.forEach((entry, idx) => {
                if (!entry || entry.continuation) return;
                
                const activity = entry._activity || entry.activity;
                if (!activity || activity === 'Free') return;

                // Check if this is a special activity (not field-based)
                const isSpecial = allActivities.some(a => a.name === activity && a.type === 'special');
                if (!isSpecial) return;

                if (!usageMap[activity]) usageMap[activity] = [];

                const slotInfo = times[idx];
                let startMin, endMin;

                if (slotInfo) {
                    if (slotInfo.startMin !== undefined) {
                        startMin = slotInfo.startMin;
                        endMin = slotInfo.endMin;
                    } else if (slotInfo.start) {
                        const startDate = new Date(slotInfo.start);
                        const endDate = new Date(slotInfo.end);
                        startMin = startDate.getHours() * 60 + startDate.getMinutes();
                        endMin = endDate.getHours() * 60 + endDate.getMinutes();
                    }
                }

                // Handle multi-slot
                let actualEndMin = endMin;
                for (let i = idx + 1; i < schedule.length; i++) {
                    const nextEntry = schedule[i];
                    if (nextEntry && nextEntry.continuation && 
                        (nextEntry._activity || nextEntry.activity) === activity) {
                        const nextSlot = times[i];
                        if (nextSlot) {
                            if (nextSlot.endMin !== undefined) {
                                actualEndMin = nextSlot.endMin;
                            } else if (nextSlot.end) {
                                const d = new Date(nextSlot.end);
                                actualEndMin = d.getHours() * 60 + d.getMinutes();
                            }
                        }
                    } else {
                        break;
                    }
                }

                if (startMin !== undefined) {
                    // Avoid duplicates if already added via field
                    const exists = usageMap[activity].some(u => 
                        u.bunk === bunk && u.startMin === startMin);
                    if (!exists) {
                        usageMap[activity].push({
                            bunk,
                            activity,
                            startMin,
                            endMin: actualEndMin || endMin
                        });
                    }
                }
            });
        });

        return usageMap;
    }

    /**
     * Get division name for a bunk
     */
    function getDivisionForBunk(bunkName) {
        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            return window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
        }
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks?.includes(bunkName)) return divName;
        }
        return null;
    }

    /**
     * Build the availability grid with partial availability support
     */
    function buildAvailabilityGrid() {
        const gridDiv = document.getElementById("avail-grid-wrapper");
        const filter = document.getElementById("avail-type-filter")?.value || 'all';

        const gs = window.loadGlobalSettings?.().app1 || {};
        const fields = (gs.fields || []).map(f => ({ ...f, type: 'field' }));
        const specials = (gs.specialActivities || []).map(s => ({ ...s, type: 'special' }));

        let resources = [...fields, ...specials].sort((a, b) => a.name.localeCompare(b.name));
        if (filter === 'field') resources = fields;
        if (filter === 'special') resources = specials;

        if (!resources.length) {
            gridDiv.innerHTML = "<p style='color:#6c757d;'>No resources configured.</p>";
            return;
        }

        const slots = generate30MinSlots();
        const usageMap = buildDetailedUsageMap();

        let html = `
            <table class="availability-grid" style="border-collapse:collapse;width:100%;font-size:0.85em;">
                <thead>
                    <tr style="background:#e9ecef;">
                        <th style="position:sticky;left:0;background:#e9ecef;z-index:10;padding:8px;border:1px solid #dee2e6;min-width:100px;">Time</th>
        `;

        resources.forEach(r => {
            html += `<th style="padding:8px;border:1px solid #dee2e6;min-width:80px;white-space:nowrap;">${r.name}</th>`;
        });
        html += `</tr></thead><tbody>`;

        slots.forEach(slot => {
            html += `
                <tr>
                    <td style="position:sticky;left:0;background:#f8f9fa;font-weight:600;padding:6px 8px;border:1px solid #dee2e6;white-space:nowrap;">
                        ${minutesToTimeLabel(slot.startMin)}
                    </td>
            `;

            resources.forEach(r => {
                const resourceUsage = usageMap[r.name] || [];
                const cellData = getCellAvailability(slot.startMin, slot.endMin, resourceUsage);
                html += renderAvailabilityCell(cellData);
            });

            html += `</tr>`;
        });

        html += `</tbody></table>`;
        gridDiv.innerHTML = html;
    }

    /**
     * Determine availability status for a cell
     * Returns: { status: 'available'|'unavailable'|'partial', transitionTime, transitionType, usage }
     */
    function getCellAvailability(slotStart, slotEnd, usageList) {
        const overlapping = usageList.filter(u => u.startMin < slotEnd && u.endMin > slotStart);

        if (overlapping.length === 0) {
            return { status: 'available' };
        }

        // Check if fully blocked
        const fullyBlocked = overlapping.some(u => u.startMin <= slotStart && u.endMin >= slotEnd);
        if (fullyBlocked) {
            return { status: 'unavailable', usage: overlapping[0] };
        }

        // Partial - find the transition time
        const usage = overlapping[0];
        
        if (usage.startMin > slotStart && usage.startMin < slotEnd) {
            // Activity STARTS during this slot (available → unavailable)
            return {
                status: 'partial',
                transitionTime: usage.startMin,
                transitionType: 'starts',
                usage
            };
        } else if (usage.endMin > slotStart && usage.endMin < slotEnd) {
            // Activity ENDS during this slot (unavailable → available)
            return {
                status: 'partial',
                transitionTime: usage.endMin,
                transitionType: 'ends',
                usage
            };
        }

        return { status: 'unavailable', usage };
    }

    /**
     * Render a single availability cell
     */
    function renderAvailabilityCell(cellData) {
        const { status, transitionTime, transitionType, usage } = cellData;

        if (status === 'available') {
            return `<td style="background:#d4edda;text-align:center;padding:6px;border:1px solid #dee2e6;color:#155724;font-weight:bold;">✓</td>`;
        }

        if (status === 'unavailable') {
            const title = usage ? `${usage.bunk}: ${usage.activity}` : '';
            return `<td style="background:#f8d7da;text-align:center;padding:6px;border:1px solid #dee2e6;color:#721c24;font-weight:bold;" title="${title}">✗</td>`;
        }

        // Partial availability
        const timeLabel = minutesToTimeLabel(transitionTime);
        const title = usage ? `${usage.bunk}: ${usage.activity}` : '';

        if (transitionType === 'ends') {
            // Unavailable → Available (X | ✓)
            return `
                <td style="padding:0;border:1px solid #dee2e6;position:relative;" title="${title}">
                    <div style="display:flex;height:100%;">
                        <div style="flex:1;background:#f8d7da;display:flex;align-items:center;justify-content:center;color:#721c24;font-weight:bold;">✗</div>
                        <div style="flex:1;background:#d4edda;display:flex;align-items:center;justify-content:center;color:#155724;font-weight:bold;">✓</div>
                    </div>
                    <div style="position:absolute;bottom:0;left:0;right:0;text-align:center;font-size:9px;background:rgba(255,255,255,0.9);color:#495057;padding:1px;">${timeLabel}</div>
                </td>`;
        } else {
            // Available → Unavailable (✓ | X)
            return `
                <td style="padding:0;border:1px solid #dee2e6;position:relative;" title="${title}">
                    <div style="display:flex;height:100%;">
                        <div style="flex:1;background:#d4edda;display:flex;align-items:center;justify-content:center;color:#155724;font-weight:bold;">✓</div>
                        <div style="flex:1;background:#f8d7da;display:flex;align-items:center;justify-content:center;color:#721c24;font-weight:bold;">✗</div>
                    </div>
                    <div style="position:absolute;bottom:0;left:0;right:0;text-align:center;font-size:9px;background:rgba(255,255,255,0.9);color:#495057;padding:1px;">${timeLabel}</div>
                </td>`;
        }
    }

    // ========================================================================
    // BUNK ROTATION REPORT - WITH USAGE MANAGER MERGED
    // ========================================================================

    function renderBunkRotationUI() {
        const wrapper = document.getElementById("report-rotation-content");
        if (!wrapper) return;

        wrapper.innerHTML = `
            <h2 class="report-title" style="border-bottom:2px solid #28a745;margin-bottom:15px;">
                📈 Bunk Rotation & Usage Report
            </h2>

            <p style="color:#666;margin-bottom:15px;">
                View how many times each bunk has done each activity, when they last did it, and manually adjust counts if needed.
            </p>

            <div style="margin-bottom:15px;display:flex;gap:15px;align-items:center;flex-wrap:wrap;">
                <div>
                    <label style="font-weight:600;">Select Division:</label>
                    <select id="rotation-div-select" style="padding:6px 10px;margin-left:8px;border-radius:4px;border:1px solid #ced4da;">
                        <option value="">-- Select --</option>
                    </select>
                </div>
                <div>
                    <label style="font-weight:600;">Filter Activities:</label>
                    <select id="rotation-type-filter" style="padding:6px 10px;margin-left:8px;border-radius:4px;border:1px solid #ced4da;">
                        <option value="all">All Activities</option>
                        <option value="sport">Sports Only</option>
                        <option value="special">Special Activities Only</option>
                    </select>
                </div>
                <button id="rotation-rebuild-btn" style="padding:6px 12px;background:#6c757d;color:white;border:none;border-radius:4px;cursor:pointer;" title="Rebuild counts from all saved schedules">
                    🔄 Rebuild Counts
                </button>
            </div>

            <div id="rotation-table-container"></div>
        `;

        const divSelect = document.getElementById("rotation-div-select");
        availableDivisions.forEach(d => {
            divSelect.innerHTML += `<option value="${d}">${d}</option>`;
        });

        divSelect.onchange = () => renderRotationTable(divSelect.value);
        document.getElementById("rotation-type-filter").onchange = () => renderRotationTable(divSelect.value);
        document.getElementById("rotation-rebuild-btn").onclick = () => {
            if (window.rebuildHistoricalCounts) {
                window.rebuildHistoricalCounts(true);
                alert('Historical counts rebuilt from all saved schedules!');
                renderRotationTable(divSelect.value);
            } else {
                alert('rebuildHistoricalCounts function not available.');
            }
        };
    }

    /**
     * Render the rotation table for a division
     */
    function renderRotationTable(divName) {
        const container = document.getElementById("rotation-table-container");
        if (!divName) {
            container.innerHTML = "<p style='color:#6c757d;'>Select a division to view rotation data.</p>";
            return;
        }

        const bunks = divisions[divName]?.bunks || [];
        if (!bunks.length) {
            container.innerHTML = "<p style='color:#dc3545;'>No bunks in this division.</p>";
            return;
        }

        const filter = document.getElementById("rotation-type-filter")?.value || 'all';
        let filteredActivities = allActivities;
        if (filter === 'sport') filteredActivities = allActivities.filter(a => a.type === 'sport');
        if (filter === 'special') filteredActivities = allActivities.filter(a => a.type === 'special');

        if (!filteredActivities.length) {
            container.innerHTML = "<p style='color:#6c757d;'>No activities match the filter.</p>";
            return;
        }

        // Load data
        const allDaily = window.loadAllDailyData?.() || {};
        const global = window.loadGlobalSettings?.() || {};
        const manualOffsets = global.manualUsageOffsets || {};
        const rotationHistory = window.loadRotationHistory?.() || { bunks: {} };

        // Compute raw historical counts and last done dates
        const rawCounts = {};
        const lastDone = {}; // { bunk: { activity: dateKey } }

        // Sort dates to process chronologically
        const sortedDates = Object.keys(allDaily).sort();

        sortedDates.forEach(dateKey => {
            const day = allDaily[dateKey];
            const sched = day?.scheduleAssignments || {};

            Object.keys(sched).forEach(bunk => {
                if (!bunks.includes(bunk)) return;

                (sched[bunk] || []).forEach(entry => {
                    if (entry && entry._activity && !entry.continuation) {
                        const act = entry._activity;
                        if (act === 'Free' || act.toLowerCase().includes('transition')) return;

                        rawCounts[bunk] = rawCounts[bunk] || {};
                        rawCounts[bunk][act] = (rawCounts[bunk][act] || 0) + 1;

                        lastDone[bunk] = lastDone[bunk] || {};
                        lastDone[bunk][act] = dateKey; // Will end up with the latest date
                    }
                });
            });
        });

        // Build table
        let html = `
            <div style="overflow-x:auto;">
                <table class="report-table" style="border-collapse:collapse;width:100%;font-size:0.85em;">
                    <thead>
                        <tr style="background:#e9ecef;">
                            <th style="padding:8px;border:1px solid #dee2e6;position:sticky;left:0;background:#e9ecef;z-index:5;">Bunk</th>
                            <th style="padding:8px;border:1px solid #dee2e6;">Activity</th>
                            <th style="padding:8px;border:1px solid #dee2e6;">Type</th>
                            <th style="padding:8px;border:1px solid #dee2e6;text-align:center;">Count</th>
                            <th style="padding:8px;border:1px solid #dee2e6;text-align:center;">Adjust (+/-)</th>
                            <th style="padding:8px;border:1px solid #dee2e6;text-align:center;font-weight:bold;">Total</th>
                            <th style="padding:8px;border:1px solid #dee2e6;">Last Done</th>
                            <th style="padding:8px;border:1px solid #dee2e6;text-align:center;">Limit</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        bunks.forEach(bunk => {
            let isFirstRow = true;

            filteredActivities.forEach(act => {
                const hist = rawCounts[bunk]?.[act.name] || 0;
                const offset = manualOffsets[bunk]?.[act.name] || 0;
                const total = Math.max(0, hist + offset);
                const limit = act.max > 0 ? act.max : '∞';
                const lastDate = lastDone[bunk]?.[act.name] || '';
                const lastDateFormatted = lastDate ? formatDateDisplay(lastDate) : 'Never';
                
                // Calculate days since
                let daysSince = '';
                if (lastDate) {
                    const last = new Date(lastDate);
                    const today = new Date();
                    const diffDays = Math.floor((today - last) / (1000 * 60 * 60 * 24));
                    daysSince = diffDays === 0 ? '(Today)' : diffDays === 1 ? '(Yesterday)' : `(${diffDays}d ago)`;
                }

                // Row styling
                let rowStyle = "";
                if (act.max > 0 && total >= act.max) {
                    rowStyle = "background:#ffebee;"; // At or over limit
                } else if (total === 0) {
                    rowStyle = "background:#fff3cd;"; // Never done - highlight
                }

                const typeLabel = act.type === 'special' ? 
                    '<span style="color:#6f42c1;font-weight:500;">Special</span>' : 
                    '<span style="color:#0d6efd;font-weight:500;">Sport</span>';

                html += `
                    <tr style="${rowStyle}">
                        <td style="padding:6px 8px;border:1px solid #dee2e6;position:sticky;left:0;background:${rowStyle ? '#ffebee' : '#fff'};font-weight:${isFirstRow ? '600' : '400'};">
                            ${isFirstRow ? bunk : ''}
                        </td>
                        <td style="padding:6px 8px;border:1px solid #dee2e6;">${act.name}</td>
                        <td style="padding:6px 8px;border:1px solid #dee2e6;">${typeLabel}</td>
                        <td style="padding:6px 8px;border:1px solid #dee2e6;text-align:center;">${hist}</td>
                        <td style="padding:6px 8px;border:1px solid #dee2e6;text-align:center;">
                            <input
                                type="number"
                                class="rotation-adj-input"
                                data-bunk="${bunk}"
                                data-act="${act.name}"
                                value="${offset}"
                                style="width:50px;text-align:center;padding:2px;border:1px solid #ced4da;border-radius:3px;"
                            />
                        </td>
                        <td style="padding:6px 8px;border:1px solid #dee2e6;text-align:center;font-weight:bold;${total === 0 ? 'color:#dc3545;' : ''}">${total}</td>
                        <td style="padding:6px 8px;border:1px solid #dee2e6;font-size:0.9em;">
                            ${lastDateFormatted} <span style="color:#6c757d;">${daysSince}</span>
                        </td>
                        <td style="padding:6px 8px;border:1px solid #dee2e6;text-align:center;${act.max > 0 && total >= act.max ? 'color:#dc3545;font-weight:bold;' : ''}">${limit}</td>
                    </tr>
                `;

                isFirstRow = false;
            });

            // Add separator row between bunks
            html += `<tr style="height:4px;background:#dee2e6;"><td colspan="8"></td></tr>`;
        });

        html += `</tbody></table></div>`;

        // Summary stats
        html += buildRotationSummary(bunks, filteredActivities, rawCounts, manualOffsets);

        container.innerHTML = html;

        // Bind input handlers
        container.querySelectorAll(".rotation-adj-input").forEach(inp => {
            inp.onchange = (e) => {
                const bunk = e.target.dataset.bunk;
                const act = e.target.dataset.act;
                const val = parseInt(e.target.value) || 0;

                const globalSettings = window.loadGlobalSettings?.() || {};
                if (!globalSettings.manualUsageOffsets) globalSettings.manualUsageOffsets = {};
                if (!globalSettings.manualUsageOffsets[bunk]) globalSettings.manualUsageOffsets[bunk] = {};

                globalSettings.manualUsageOffsets[bunk][act] = val;

                if (val === 0) delete globalSettings.manualUsageOffsets[bunk][act];

                window.saveGlobalSettings("manualUsageOffsets", globalSettings.manualUsageOffsets);
                renderRotationTable(divName);
            };
        });
    }

    /**
     * Format date for display (YYYY-MM-DD → readable)
     */
    function formatDateDisplay(dateKey) {
        if (!dateKey) return '';
        try {
            const d = new Date(dateKey + 'T12:00:00');
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch (e) {
            return dateKey;
        }
    }

    /**
     * Build summary statistics for rotation report
     */
    function buildRotationSummary(bunks, activities, rawCounts, manualOffsets) {
        // Find bunks with never-done activities
        const neverDone = [];
        const atLimit = [];

        bunks.forEach(bunk => {
            activities.forEach(act => {
                const hist = rawCounts[bunk]?.[act.name] || 0;
                const offset = manualOffsets[bunk]?.[act.name] || 0;
                const total = Math.max(0, hist + offset);

                if (total === 0) {
                    neverDone.push({ bunk, activity: act.name });
                }
                if (act.max > 0 && total >= act.max) {
                    atLimit.push({ bunk, activity: act.name, total, limit: act.max });
                }
            });
        });

        let html = `<div style="margin-top:20px;padding:15px;background:#f8f9fa;border-radius:8px;border:1px solid #dee2e6;">`;
        html += `<h4 style="margin:0 0 10px 0;color:#495057;">📊 Summary</h4>`;

        if (neverDone.length > 0) {
            html += `<div style="margin-bottom:10px;">
                <strong style="color:#856404;">⚠️ Never Done (${neverDone.length}):</strong>
                <span style="font-size:0.9em;color:#666;"> ${neverDone.slice(0, 10).map(n => `${n.bunk}→${n.activity}`).join(', ')}${neverDone.length > 10 ? '...' : ''}</span>
            </div>`;
        } else {
            html += `<div style="margin-bottom:10px;color:#155724;">✅ All bunks have done all activities at least once!</div>`;
        }

        if (atLimit.length > 0) {
            html += `<div>
                <strong style="color:#721c24;">🛑 At Limit (${atLimit.length}):</strong>
                <span style="font-size:0.9em;color:#666;"> ${atLimit.map(a => `${a.bunk}→${a.activity} (${a.total}/${a.limit})`).join(', ')}</span>
            </div>`;
        }

        html += `</div>`;
        return html;
    }

    // ========================================================================
    // EXPORT
    // ========================================================================

    window.initReportTab = initReportTab;

    // Debug exports
    window.debugAnalytics = {
        buildDetailedUsageMap,
        generate30MinSlots,
        getCampTimes
    };

})();
