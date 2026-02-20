// ============================================================================
// analytics.js
//
// SUPERCHARGED VERSION v2:
// - Enhanced Field Availability Grid with clear partial availability display
// - Time slots on TOP (columns), Fields/Specials on SIDE (rows)
// - Bunk Rotation Report with activity counts + last done + manual adjustments
// - Matches site theme styling
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
     * Convert minutes to short label (e.g., 570 → "9:30a")
     */
    function minutesToShortLabel(mins) {
        let h = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        return `${h}:${m < 10 ? '0' + m : m}${ap}`;
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
     * Get camp start/end times - finds EARLIEST start and LATEST end
     * from division times, unified times, or config
     */
    function getCampTimes() {
        const gs = window.loadGlobalSettings?.() || {};
        const app1 = gs.app1 || window.app1 || {};
        
        let earliestStart = Infinity;
        let latestEnd = 0;

        // Check division times first
        const divisionTimes = window.divisionTimes || {};
        Object.values(divisionTimes).forEach(slots => {
            if (!Array.isArray(slots)) return;
            slots.forEach(slot => {
                let sMin, eMin;
                if (slot.startMin !== undefined) {
                    sMin = slot.startMin;
                    eMin = slot.endMin;
                } else if (slot.start) {
                    const sd = new Date(slot.start);
                    const ed = new Date(slot.end);
                    sMin = sd.getHours() * 60 + sd.getMinutes();
                    eMin = ed.getHours() * 60 + ed.getMinutes();
                }
                if (sMin !== undefined && sMin < earliestStart) earliestStart = sMin;
                if (eMin !== undefined && eMin > latestEnd) latestEnd = eMin;
            });
        });

        // Check unified times as fallback
        const unifiedTimes = window.unifiedTimes || [];
        unifiedTimes.forEach(slot => {
            let sMin, eMin;
            if (slot.startMin !== undefined) {
                sMin = slot.startMin;
                eMin = slot.endMin;
            } else if (slot.start) {
                const sd = new Date(slot.start);
                const ed = new Date(slot.end);
                sMin = sd.getHours() * 60 + sd.getMinutes();
                eMin = ed.getHours() * 60 + ed.getMinutes();
            }
            if (sMin !== undefined && sMin < earliestStart) earliestStart = sMin;
            if (eMin !== undefined && eMin > latestEnd) latestEnd = eMin;
        });

        // Fallback to config
        if (earliestStart === Infinity) {
            earliestStart = parseTimeToMinutes(app1.startTime || "9:00am") || 540;
        }
        if (latestEnd === 0) {
            latestEnd = parseTimeToMinutes(app1.endTime || "4:00pm") || 960;
        }

        return { 
            startMin: earliestStart, 
            endMin: latestEnd, 
            startTime: minutesToTimeLabel(earliestStart), 
            endTime: minutesToTimeLabel(latestEnd) 
        };
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
                label: minutesToTimeLabel(min),
                shortLabel: minutesToShortLabel(min)
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
    // FIELD AVAILABILITY GRID - SUPERCHARGED v2
    // Time on TOP, Fields/Specials on SIDE
    // ========================================================================

    function renderFieldAvailabilityGrid() {
        const wrapper = document.getElementById("report-availability-content");
        if (!wrapper) return;

        const { startTime, endTime } = getCampTimes();

        wrapper.innerHTML = `
            <div class="setup-card" style="margin-bottom:16px;">
                <div class="setup-card-header">
                    <div class="setup-step-pill">Availability</div>
                    <div class="setup-card-text">
                        <h3 style="margin:0;">Field & Activity Availability</h3>
                        <p style="margin:2px 0 0;font-size:0.8rem;color:#6b7280;">
                            Camp hours: <strong>${startTime}</strong> to <strong>${endTime}</strong> (30-min slots)
                        </p>
                    </div>
                </div>
                
                <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px;padding:12px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb;">
                    <div style="flex:1;min-width:180px;">
                        <label style="font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;display:block;margin-bottom:4px;">Search Field/Activity</label>
                        <select id="avail-field-search" style="width:100%;padding:8px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.85rem;">
                            <option value="">-- Select --</option>
                        </select>
                    </div>
                    <div style="flex:1;min-width:140px;">
                        <label style="font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;display:block;margin-bottom:4px;">Time Slot</label>
                        <select id="avail-time-search" style="width:100%;padding:8px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.85rem;">
                            <option value="">-- Select --</option>
                        </select>
                    </div>
                    <button id="avail-search-btn" style="padding:8px 20px;background:linear-gradient(135deg,#2563eb,#0ea5e9);color:#fff;border:none;border-radius:999px;font-size:0.85rem;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                        Check
                    </button>
                </div>
                
                <div id="avail-search-result" style="display:none;margin-bottom:14px;"></div>
                
                <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
                    <select id="avail-type-filter" style="padding:6px 14px;border-radius:999px;border:1px solid #d1d5db;font-size:0.85rem;">
                        <option value="all">All Resources</option>
                        <option value="field">Fields Only</option>
                        <option value="special">Special Activities Only</option>
                    </select>
                    
                    <div style="display:flex;gap:12px;font-size:0.8rem;color:#4b5563;">
                        <span style="display:flex;align-items:center;gap:4px;">
                            <span style="width:18px;height:18px;background:#d1fae5;border:2px solid #10b981;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#047857;">✓</span>
                            Free
                        </span>
                        <span style="display:flex;align-items:center;gap:4px;">
                            <span style="width:18px;height:18px;background:#fee2e2;border:2px solid #ef4444;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#b91c1c;">✗</span>
                            In Use
                        </span>
                        <span style="display:flex;align-items:center;gap:4px;">
                            <span style="width:36px;height:18px;background:linear-gradient(90deg,#fee2e2 50%,#d1fae5 50%);border:2px solid #6b7280;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:600;color:#374151;">→</span>
                            Partial
                        </span>
                    </div>
                </div>
            </div>

            <div id="avail-grid-wrapper" class="schedule-view-wrapper" style="border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;"></div>
        `;

        populateAvailabilityDropdowns();
        buildAvailabilityGrid();

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
            opt.textContent = r.name;
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
            resultDiv.innerHTML = `<div style="padding:10px 14px;background:#fef3c7;border:1px solid #f59e0b;border-radius:999px;color:#92400e;font-size:0.85rem;">⚠️ Please select both a field/activity and a time slot.</div>`;
            return;
        }

        const slotStartMin = parseInt(timeVal, 10);
        const slotEndMin = slotStartMin + 30;
        const usageData = buildDetailedUsageMap();
        const resourceUsage = usageData[fieldName] || [];

        const overlapping = resourceUsage.filter(u => u.startMin < slotEndMin && u.endMin > slotStartMin);

        resultDiv.style.display = 'block';

        if (overlapping.length === 0) {
            resultDiv.innerHTML = `
                <div style="padding:12px 16px;background:#d1fae5;border:2px solid #10b981;border-radius:12px;color:#047857;font-size:0.9rem;">
                    ✅ <strong>${fieldName}</strong> is <strong>AVAILABLE</strong> from ${minutesToTimeLabel(slotStartMin)} to ${minutesToTimeLabel(slotEndMin)}
                </div>`;
        } else {
            const fullyBlocked = overlapping.some(u => u.startMin <= slotStartMin && u.endMin >= slotEndMin);
            
            if (fullyBlocked) {
                const usage = overlapping[0];
                resultDiv.innerHTML = `
                    <div style="padding:12px 16px;background:#fee2e2;border:2px solid #ef4444;border-radius:12px;color:#b91c1c;font-size:0.9rem;">
                        ❌ <strong>${fieldName}</strong> is <strong>IN USE</strong> from ${minutesToTimeLabel(slotStartMin)} to ${minutesToTimeLabel(slotEndMin)}<br>
                        <span style="font-size:0.85em;color:#7f1d1d;">Used by: <strong>${usage.bunk}</strong> → ${usage.activity} (${minutesToTimeLabel(usage.startMin)} - ${minutesToTimeLabel(usage.endMin)})</span>
                    </div>`;
            } else {
                let details = overlapping.map(u => 
                    `• <strong>${u.bunk}</strong>: ${u.activity} (${minutesToTimeLabel(u.startMin)} - ${minutesToTimeLabel(u.endMin)})`
                ).join('<br>');
                
                resultDiv.innerHTML = `
                    <div style="padding:12px 16px;background:#fef3c7;border:2px solid #f59e0b;border-radius:12px;color:#92400e;font-size:0.9rem;">
                        ⚠️ <strong>${fieldName}</strong> is <strong>PARTIALLY AVAILABLE</strong><br>
                        <span style="font-size:0.85em;">${details}</span>
                    </div>`;
            }
        }
    }

    /**
     * Build detailed usage map with exact times
     */
    function buildDetailedUsageMap() {
        const usageMap = {};
        const assignments = window.scheduleAssignments || 
                           window.loadCurrentDailyData?.().scheduleAssignments || {};
        
        const divisionTimes = window.divisionTimes || {};
        const unifiedTimes = window.unifiedTimes || [];

        Object.entries(assignments).forEach(([bunk, schedule]) => {
            if (!Array.isArray(schedule)) return;

            const divName = getDivisionForBunk(bunk);
            const times = divisionTimes[divName] || unifiedTimes || [];

            schedule.forEach((entry, idx) => {
                if (!entry || entry.continuation) return;
                
                const field = entry.field || entry._field;
                const activity = entry._activity || entry.activity;
                
                if (!field || field === 'Free' || field === 'No Field') return;

                const fName = fieldLabel(field);
                if (!usageMap[fName]) usageMap[fName] = [];

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

                // Handle multi-slot activities
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
     * Build the availability grid - TIME on TOP, RESOURCES on SIDE
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
            gridDiv.innerHTML = "<p style='color:#6b7280;padding:20px;text-align:center;'>No resources configured.</p>";
            return;
        }

        const slots = generate30MinSlots();
        const usageMap = buildDetailedUsageMap();

        // TIME on TOP (columns), RESOURCES on SIDE (rows)
        let html = `
            <table style="border-collapse:collapse;width:100%;font-size:0.8rem;">
                <thead>
                    <tr style="background:linear-gradient(135deg,#f3f4f6,#e5e7eb);">
                        <th style="position:sticky;left:0;z-index:10;background:#f3f4f6;padding:10px 12px;border:1px solid #d1d5db;min-width:140px;text-align:left;font-weight:600;color:#374151;">
                            Resource
                        </th>
        `;

        // Time headers
        slots.forEach(slot => {
            html += `<th style="padding:8px 4px;border:1px solid #d1d5db;min-width:60px;font-weight:600;color:#374151;white-space:nowrap;font-size:0.75rem;">${slot.shortLabel}</th>`;
        });
        html += `</tr></thead><tbody>`;

        // Resource rows
        resources.forEach((r, rowIdx) => {
            const resourceUsage = usageMap[r.name] || [];
            const rowBg = rowIdx % 2 === 0 ? '#ffffff' : '#fafafa';
            const typeIcon = r.type === 'special' ? '⭐' : '🏟️';
            
            html += `
                <tr style="background:${rowBg};">
                    <td style="position:sticky;left:0;background:${rowBg};padding:8px 10px;border:1px solid #d1d5db;font-weight:600;color:#111827;white-space:nowrap;">
                        <span style="margin-right:4px;">${typeIcon}</span>${r.name}
                    </td>
            `;

            slots.forEach(slot => {
                const cellData = getCellAvailability(slot.startMin, slot.endMin, resourceUsage);
                html += renderAvailabilityCell(cellData, slot);
            });

            html += `</tr>`;
        });

        html += `</tbody></table>`;
        gridDiv.innerHTML = html;
    }

    /**
     * Determine availability status for a cell
     */
    function getCellAvailability(slotStart, slotEnd, usageList) {
        const overlapping = usageList.filter(u => u.startMin < slotEnd && u.endMin > slotStart);

        if (overlapping.length === 0) {
            return { status: 'available' };
        }

        const fullyBlocked = overlapping.some(u => u.startMin <= slotStart && u.endMin >= slotEnd);
        if (fullyBlocked) {
            return { status: 'unavailable', usage: overlapping[0] };
        }

        const usage = overlapping[0];
        
        if (usage.startMin > slotStart && usage.startMin < slotEnd) {
            return {
                status: 'partial',
                transitionTime: usage.startMin,
                transitionType: 'starts',
                usage
            };
        } else if (usage.endMin > slotStart && usage.endMin < slotEnd) {
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
     * Render a single availability cell with improved visuals
     */
    function renderAvailabilityCell(cellData, slot) {
        const { status, transitionTime, transitionType, usage } = cellData;

        if (status === 'available') {
            return `<td style="background:#d1fae5;text-align:center;padding:6px 2px;border:1px solid #d1d5db;">
                <span style="color:#047857;font-weight:700;font-size:1em;">✓</span>
            </td>`;
        }

        if (status === 'unavailable') {
            const title = usage ? `${usage.bunk}: ${usage.activity}` : '';
            return `<td style="background:#fee2e2;text-align:center;padding:6px 2px;border:1px solid #d1d5db;" title="${title}">
                <span style="color:#b91c1c;font-weight:700;font-size:1em;">✗</span>
            </td>`;
        }

        // Partial availability - clearer design
        const timeLabel = minutesToShortLabel(transitionTime);
        const title = usage ? `${usage.bunk}: ${usage.activity}` : '';

        if (transitionType === 'ends') {
            // Busy until transitionTime, then free
            return `
                <td style="padding:0;border:1px solid #d1d5db;position:relative;height:36px;" title="${title}: Free from ${timeLabel}">
                    <div style="display:flex;height:100%;">
                        <div style="flex:1;background:#fee2e2;display:flex;align-items:center;justify-content:center;">
                            <span style="color:#b91c1c;font-weight:700;font-size:0.85em;">✗</span>
                        </div>
                        <div style="flex:1;background:#d1fae5;display:flex;align-items:center;justify-content:center;">
                            <span style="color:#047857;font-weight:700;font-size:0.85em;">✓</span>
                        </div>
                    </div>
                    <div style="position:absolute;bottom:1px;left:50%;transform:translateX(-50%);font-size:8px;font-weight:600;color:#374151;background:rgba(255,255,255,0.95);padding:0 3px;border-radius:2px;white-space:nowrap;">${timeLabel}</div>
                </td>`;
        } else {
            // Free until transitionTime, then busy
            return `
                <td style="padding:0;border:1px solid #d1d5db;position:relative;height:36px;" title="${title}: In use from ${timeLabel}">
                    <div style="display:flex;height:100%;">
                        <div style="flex:1;background:#d1fae5;display:flex;align-items:center;justify-content:center;">
                            <span style="color:#047857;font-weight:700;font-size:0.85em;">✓</span>
                        </div>
                        <div style="flex:1;background:#fee2e2;display:flex;align-items:center;justify-content:center;">
                            <span style="color:#b91c1c;font-weight:700;font-size:0.85em;">✗</span>
                        </div>
                    </div>
                    <div style="position:absolute;bottom:1px;left:50%;transform:translateX(-50%);font-size:8px;font-weight:600;color:#374151;background:rgba(255,255,255,0.95);padding:0 3px;border-radius:2px;white-space:nowrap;">${timeLabel}</div>
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
            <div class="setup-card" style="margin-bottom:16px;">
                <div class="setup-card-header">
                    <div class="setup-step-pill" style="background:linear-gradient(135deg,#10b981,#059669);">Rotation</div>
                    <div class="setup-card-text">
                        <h3 style="margin:0;">Bunk Rotation & Usage</h3>
                        <p style="margin:2px 0 0;font-size:0.8rem;color:#6b7280;">
                            Track activity counts, last done dates, and manual adjustments
                        </p>
                    </div>
                </div>
                
                <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px;">
                    <div style="flex:1;min-width:160px;">
                        <label style="font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;display:block;margin-bottom:4px;">Division</label>
                        <select id="rotation-div-select" style="width:100%;padding:8px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.85rem;">
                            <option value="">-- Select Division --</option>
                        </select>
                    </div>
                    <div style="flex:1;min-width:120px;">
                        <label style="font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;display:block;margin-bottom:4px;">Type</label>
                        <select id="rotation-type-filter" style="width:100%;padding:8px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.85rem;">
                            <option value="all">All Activities</option>
                            <option value="sport">Sports Only</option>
                            <option value="special">Special Only</option>
                        </select>
                    </div>
                    <div style="flex:1;min-width:140px;">
                        <label style="font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;display:block;margin-bottom:4px;">Bunk</label>
                        <select id="rotation-bunk-filter" style="width:100%;padding:8px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.85rem;">
                            <option value="">All Bunks</option>
                        </select>
                    </div>
                    <div style="flex:1;min-width:160px;">
                        <label style="font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;display:block;margin-bottom:4px;">Activity</label>
                        <input id="rotation-activity-filter" type="text" placeholder="e.g. Basketball" style="width:100%;padding:8px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.85rem;box-sizing:border-box;" />
                    </div>
                </div>
            </div>

            <div id="rotation-table-container"></div>
        `;

        const divSelect = document.getElementById("rotation-div-select");
        availableDivisions.forEach(d => {
            divSelect.innerHTML += `<option value="${d}">${d}</option>`;
        });

        // When division changes, repopulate bunk dropdown then re-render
        divSelect.onchange = () => {
            populateRotationBunkFilter(divSelect.value);
            renderRotationTable(divSelect.value);
        };
        document.getElementById("rotation-type-filter").onchange = () => renderRotationTable(divSelect.value);
        document.getElementById("rotation-bunk-filter").onchange = () => renderRotationTable(divSelect.value);

        // Debounced activity search
        let _activityFilterTimer = null;
        document.getElementById("rotation-activity-filter").oninput = () => {
            clearTimeout(_activityFilterTimer);
            _activityFilterTimer = setTimeout(() => renderRotationTable(divSelect.value), 300);
        };
    }

    /**
     * Populate bunk filter dropdown for the selected division
     */
    function populateRotationBunkFilter(divName) {
        const bunkSelect = document.getElementById("rotation-bunk-filter");
        if (!bunkSelect) return;
        bunkSelect.innerHTML = '<option value="">All Bunks</option>';
        if (!divName) return;
        const bunks = divisions[divName]?.bunks || [];
        bunks.forEach(b => {
            bunkSelect.innerHTML += `<option value="${b}">${b}</option>`;
        });
    }

    /**
     * Render the rotation table for a division
     */
    function renderRotationTable(divName) {
        const container = document.getElementById("rotation-table-container");
        if (!divName) {
            container.innerHTML = `<div style="padding:30px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:12px;border:1px dashed #d1d5db;">
                <span style="font-size:1.5em;">📋</span><br>
                <span style="font-size:0.9rem;">Select a division to view rotation data</span>
            </div>`;
            return;
        }

        const bunks = divisions[divName]?.bunks || [];
        if (!bunks.length) {
            container.innerHTML = `<div style="padding:20px;text-align:center;color:#b91c1c;background:#fee2e2;border-radius:12px;">No bunks in this division.</div>`;
            return;
        }

        // Type filter (sport/special/all)
        const filter = document.getElementById("rotation-type-filter")?.value || 'all';
        let filteredActivities = allActivities;
        if (filter === 'sport') filteredActivities = allActivities.filter(a => a.type === 'sport');
        if (filter === 'special') filteredActivities = allActivities.filter(a => a.type === 'special');

        // Activity name search filter
        const activitySearch = (document.getElementById("rotation-activity-filter")?.value || '').trim().toLowerCase();
        if (activitySearch) {
            filteredActivities = filteredActivities.filter(a => a.name.toLowerCase().includes(activitySearch));
        }

        if (!filteredActivities.length) {
            container.innerHTML = `<div style="padding:20px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:12px;">No activities match the filter.</div>`;
            return;
        }

        // Bunk filter
        const bunkFilter = document.getElementById("rotation-bunk-filter")?.value || '';
        const filteredBunks = bunkFilter ? bunks.filter(b => b === bunkFilter) : bunks;

        if (!filteredBunks.length) {
            container.innerHTML = `<div style="padding:20px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:12px;">No bunks match the filter.</div>`;
            return;
        }

        // Load data
        const allDaily = window.loadAllDailyData?.() || {};
        const global = window.loadGlobalSettings?.() || {};
        const manualOffsets = global.manualUsageOffsets || {};

        // Compute raw historical counts and last done dates
        const rawCounts = global.historicalCounts || {};
        const lastDone = {};

        const rotHist = window.loadRotationHistory?.() || { bunks: {} };
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

                        lastDone[bunk] = lastDone[bunk] || {};
                        lastDone[bunk][act] = dateKey;
                    }
                });
            });
        });

        bunks.forEach(bunk => {
            const bunkRotHist = rotHist.bunks?.[bunk] || {};
            Object.keys(bunkRotHist).forEach(act => {
                const ts = bunkRotHist[act];
                if (!ts) return;
                const dateFromTs = new Date(ts).toISOString().split('T')[0];
                lastDone[bunk] = lastDone[bunk] || {};
                if (!lastDone[bunk][act] || dateFromTs > lastDone[bunk][act]) {
                    lastDone[bunk][act] = dateFromTs;
                }
            });
        });

        // Build table with themed styling
        let html = `
            <div style="border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,0.06);">
                <div style="overflow-x:auto;">
                    <table style="border-collapse:collapse;width:100%;font-size:0.8rem;">
                        <thead>
                            <tr style="background:linear-gradient(135deg,#f3f4f6,#e5e7eb);">
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:left;font-weight:600;color:#374151;position:sticky;left:0;background:#f3f4f6;z-index:5;min-width:100px;">Bunk</th>
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:left;font-weight:600;color:#374151;min-width:120px;">Activity</th>
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:center;font-weight:600;color:#374151;width:50px;">Type</th>
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:center;font-weight:600;color:#374151;width:60px;">Count</th>
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:center;font-weight:600;color:#374151;width:70px;">Adjust</th>
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:center;font-weight:600;color:#374151;width:60px;">Total</th>
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:left;font-weight:600;color:#374151;min-width:130px;">Last Done</th>
                                <th style="padding:10px 12px;border:1px solid #d1d5db;text-align:center;font-weight:600;color:#374151;width:50px;">Limit</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        filteredBunks.forEach((bunk, bunkIdx) => {
            let isFirstRow = true;
            const bunkBg = bunkIdx % 2 === 0 ? '#ffffff' : '#fafafa';

            filteredActivities.forEach(act => {
                const hist = rawCounts[bunk]?.[act.name] || 0;
                const offset = manualOffsets[bunk]?.[act.name] || 0;
                const total = Math.max(0, hist + offset);
                const limit = act.max > 0 ? act.max : '∞';
                const lastDate = lastDone[bunk]?.[act.name] || '';
                const lastDateFormatted = lastDate ? formatDateDisplay(lastDate) : '—';
                
                let daysSince = '';
                if (lastDate) {
                    const last = new Date(lastDate);
                    const today = new Date();
                    const diffDays = Math.floor((today - last) / (1000 * 60 * 60 * 24));
                    if (diffDays === 0) daysSince = 'Today';
                    else if (diffDays === 1) daysSince = 'Yesterday';
                    else daysSince = `${diffDays}d ago`;
                }

                // Row styling based on status
                let rowBg = bunkBg;
                let totalStyle = 'font-weight:600;';
                if (act.max > 0 && total >= act.max) {
                    rowBg = '#fee2e2';
                    totalStyle += 'color:#b91c1c;';
                } else if (total === 0) {
                    totalStyle += 'color:#d97706;';
                }

                const typeIcon = act.type === 'special' ? 
                    '<span style="background:#ddd6fe;color:#7c3aed;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">⭐</span>' : 
                    '<span style="background:#dbeafe;color:#2563eb;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">🏟️</span>';

                html += `
                    <tr style="background:${rowBg};">
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;position:sticky;left:0;background:${rowBg};font-weight:${isFirstRow ? '600' : '400'};color:#111827;">
                            ${isFirstRow ? bunk : ''}
                        </td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;color:#374151;">${act.name}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;">${typeIcon}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;color:#6b7280;">${hist}</td>
                        <td style="padding:4px 6px;border:1px solid #e5e7eb;text-align:center;">
                            <input
                                type="number"
                                class="rotation-adj-input"
                                data-bunk="${bunk}"
                                data-act="${act.name}"
                                value="${offset}"
                                style="width:45px;text-align:center;padding:4px;border:1px solid #d1d5db;border-radius:999px;font-size:0.8rem;"
                            />
                        </td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;${totalStyle}">${total}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;font-size:0.85em;">
                            ${lastDateFormatted} <span style="color:#9ca3af;font-size:0.85em;">${daysSince}</span>
                        </td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;${act.max > 0 && total >= act.max ? 'color:#b91c1c;font-weight:600;' : 'color:#6b7280;'}">${limit}</td>
                    </tr>
                `;

                isFirstRow = false;
            });
        });

        html += `</tbody></table></div></div>`;

        // Summary stats
        html += buildRotationSummary(filteredBunks, filteredActivities, rawCounts, manualOffsets);

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

        let html = `
            <div class="setup-card" style="margin-top:16px;">
                <div class="setup-card-header">
                    <div class="setup-step-pill setup-step-pill-muted">Summary</div>
                    <div class="setup-card-text">
                        <h3 style="margin:0;font-size:0.95rem;">Quick Stats</h3>
                    </div>
                </div>
        `;

        if (neverDone.length > 0) {
            html += `
                <div style="margin-bottom:10px;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:999px;">
                    <strong style="color:#92400e;">⚠️ Never Done (${neverDone.length}):</strong>
                    <span style="font-size:0.85em;color:#78350f;margin-left:6px;">
                        ${neverDone.slice(0, 8).map(n => `${n.bunk}→${n.activity}`).join(', ')}${neverDone.length > 8 ? '...' : ''}
                    </span>
                </div>`;
        } else {
            html += `
                <div style="margin-bottom:10px;padding:10px 12px;background:#d1fae5;border:1px solid #10b981;border-radius:999px;">
                    <strong style="color:#047857;">✅ All bunks have done all activities at least once!</strong>
                </div>`;
        }

        if (atLimit.length > 0) {
            html += `
                <div style="padding:10px 12px;background:#fee2e2;border:1px solid #ef4444;border-radius:999px;">
                    <strong style="color:#b91c1c;">🛑 At Limit (${atLimit.length}):</strong>
                    <span style="font-size:0.85em;color:#7f1d1d;margin-left:6px;">
                        ${atLimit.map(a => `${a.bunk}→${a.activity}`).join(', ')}
                    </span>
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
