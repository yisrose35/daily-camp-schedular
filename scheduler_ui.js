// -------------------- scheduler_ui.js --------------------
//
// Staggered (YKLI-style) schedule renderer with persistent
// League / Specialty League counters across days.
//
// - Loads previous day's league counters
// - Increments counters sequentially for today
// - Saves today's final counters
// - Renders 1 table per division, event-based rows
// -----------------------------------------------------------------

(function () {
    'use strict';

    // ===== CONFIG / HELPERS =====
    const INCREMENT_MINS = 30; // Base optimizer grid size

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/g, "").trim();
        }

        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;

        if (mer) {
            if (hh === 12) {
                hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
            } else if (mer === "pm") {
                hh += 12; // 1pm -> 13
            }
        } else {
            return null; // AM/PM is required
        }

        return hh * 60 + mm;
    }

    function fieldLabel(f) {
        if (typeof f === "string") return f;
        if (f && typeof f === "object" && typeof f.name === "string") return f.name;
        return "";
    }

    function fmtTime(d) {
        if (!d) return "";
        if (typeof d === "string") {
            d = new Date(d);
        }
        let h = d.getHours();
        let m = d.getMinutes().toString().padStart(2, "0");
        const ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${m} ${ap}`;
    }

    /**
     * Converts minutes (e.g., 740) to a 12-hour string (e.g., "12:20 PM")
     */
    function minutesToTimeLabel(min) {
        if (min == null || Number.isNaN(min)) return "Invalid Time";
        let h = Math.floor(min / 60);
        const m = (min % 60).toString().padStart(2, "0");
        const ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${m} ${ap}`;
    }

    // ===== CORE HELPERS =====

    /**
     * Helper: Get schedule entry for a bunk at a slot index.
     */
    function getEntry(bunk, slotIndex) {
        const assignments = window.scheduleAssignments || {};
        if (bunk && assignments[bunk] && assignments[bunk][slotIndex]) {
            return assignments[bunk][slotIndex];
        }
        return null;
    }

    /**
     * Helper: Format an entry into text.
     */
    function formatEntry(entry) {
        if (!entry) return "";
        if (entry._h2h) {
            return `${entry.sport} @ ${fieldLabel(entry.field)}`;
        } else if (entry._fixed) {
            return fieldLabel(entry.field);
        } else if (entry.sport) {
            return `${fieldLabel(entry.field)} – ${entry.sport}`;
        } else {
            return fieldLabel(entry.field);
        }
    }

    /**
     * Finds the first 30-min slot index that contains the given startMin.
     * (slotStart <= startMin < slotEnd)
     */
    function findFirstSlotForTime(startMin) {
        if (startMin == null || !window.unifiedTimes) return -1;

        for (let i = 0; i < window.unifiedTimes.length; i++) {
            const slot = window.unifiedTimes[i];
            const startDate = new Date(slot.start);
            const slotStart = startDate.getHours() * 60 + startDate.getMinutes();

            const slotEnd = slotStart + INCREMENT_MINS;

            if (slotStart <= startMin && slotEnd > startMin) {
                return i;
            }
        }
        return -1;
    }

    // ===== MAIN RENDERER =====

    /**
     * Always renders the Staggered View.
     */
    function updateTable() {
        const container = document.getElementById("scheduleTable");
        if (!container) return;
        renderStaggeredView(container);
    }

    /**
     * Renders the "Staggered" (YKLI) view:
     * - One table per division
     * - Event-based rows
     * - League / Specialty counters persist across days
     */
    function renderStaggeredView(container) {
        container.innerHTML = "";

        const availableDivisions = window.availableDivisions || [];
        const divisions = window.divisions || {};

        const dailyData = window.loadCurrentDailyData?.() || {};
        const manualSkeleton = dailyData.manualSkeleton || [];

        // Load previous day's counters
        const prevDailyData = window.loadPreviousDailyData?.() || {};
        const prevCounters = prevDailyData.leagueDayCounters || {};
        const todayCounters = {};

        if (manualSkeleton.length === 0) {
            container.innerHTML =
                "<p>No schedule built for this day. Go to the 'Daily Adjustments' tab to build one.</p>";
            return;
        }

        // Wrapper to allow CSS to put tables side-by-side
        const wrapper = document.createElement("div");
        wrapper.className = "schedule-view-wrapper";
        container.appendChild(wrapper);

        // One table per division
        availableDivisions.forEach((divName) => {
            const divData = divisions[divName];
            const bunks = (divData?.bunks || []).slice().sort();
            if (!bunks.length) return;

            const table = document.createElement("table");
            table.className = "schedule-division-table";
            table.style.borderCollapse = "collapse";

            // ---- HEADER ----
            const thead = document.createElement("thead");

            // Row 1: Division name
            const tr1 = document.createElement("tr");
            const thDiv = document.createElement("th");
            thDiv.colSpan = 1 + bunks.length;
            thDiv.textContent = divName;
            thDiv.style.background = divData?.color || "#333";
            thDiv.style.color = "#fff";
            thDiv.style.border = "1px solid #999";
            tr1.appendChild(thDiv);
            thead.appendChild(tr1);

            // Row 2: Time + bunks
            const tr2 = document.createElement("tr");

            const thTime = document.createElement("th");
            thTime.textContent = "Time";
            thTime.style.minWidth = "100px";
            thTime.style.border = "1px solid #999";
            tr2.appendChild(thTime);

            bunks.forEach((b) => {
                const thBunk = document.createElement("th");
                thBunk.textContent = b;
                thBunk.style.border = "1px solid #999";
                thBunk.style.minWidth = "120px";
                tr2.appendChild(thBunk);
            });

            thead.appendChild(tr2);
            table.appendChild(thead);

            // ---- BODY ----
            const tbody = document.createElement("tbody");

            // Pre-filter / validate / sort blocks for this division
            const tempSortedBlocks = [];
            manualSkeleton.forEach((item) => {
                if (item.division !== divName) return;

                const startMin = parseTimeToMinutes(item.startTime);
                const endMin = parseTimeToMinutes(item.endTime);
                if (startMin == null || endMin == null) return;

                if (divData) {
                    const divStartMin = parseTimeToMinutes(divData.startTime);
                    const divEndMin = parseTimeToMinutes(divData.endTime);

                    if (divStartMin != null && endMin <= divStartMin) {
                        // block entirely before division's window
                        return;
                    }
                    if (divEndMin != null && startMin >= divEndMin) {
                        // block entirely after division's window
                        return;
                    }
                }

                tempSortedBlocks.push({ item, startMin, endMin });
            });

            tempSortedBlocks.sort((a, b) => a.startMin - b.startMin);

            // Counters: start from yesterday's totals
            const prevDivCounts = prevCounters[divName] || { league: 0, specialty: 0 };
            let todayLeagueCount = prevDivCounts.league;
            let todaySpecialtyCount = prevDivCounts.specialty;

            const divisionBlocks = [];

            tempSortedBlocks.forEach(({ item, startMin, endMin }) => {
                let eventName = item.event;

                if (item.event === "League Game") {
                    todayLeagueCount += 1;
                    eventName = `League Game ${todayLeagueCount}`;
                } else if (item.event === "Specialty League") {
                    todaySpecialtyCount += 1;
                    eventName = `Specialty League ${todaySpecialtyCount}`;
                }

                divisionBlocks.push({
                    label: `${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}`,
                    startMin,
                    endMin,
                    event: eventName,
                    type: item.type
                });
            });

            // Store today's counters for this division
            todayCounters[divName] = {
                league: todayLeagueCount,
                specialty: todaySpecialtyCount
            };

            // De-duplicate blocks by label
            const uniqueBlocks = divisionBlocks.filter((block, index, self) =>
                index === self.findIndex((t) => t.label === block.label)
            );

            // Flatten split blocks (first half / second half)
            const flattenedBlocks = [];
            uniqueBlocks.forEach((block) => {
                if (
                    block.type === "split" &&
                    block.startMin != null &&
                    block.endMin != null &&
                    block.endMin > block.startMin
                ) {
                    const midMin = Math.round(
                        block.startMin + (block.endMin - block.startMin) / 2
                    );

                    // First half
                    flattenedBlocks.push({
                        ...block,
                        label: `${minutesToTimeLabel(block.startMin)} - ${minutesToTimeLabel(
                            midMin
                        )}`,
                        startMin: block.startMin,
                        endMin: midMin,
                        splitPart: 1
                    });

                    // Second half
                    flattenedBlocks.push({
                        ...block,
                        label: `${minutesToTimeLabel(midMin)} - ${minutesToTimeLabel(
                            block.endMin
                        )}`,
                        startMin: midMin,
                        endMin: block.endMin,
                        splitPart: 2
                    });
                } else {
                    flattenedBlocks.push(block);
                }
            });

            if (!flattenedBlocks.length) {
                const tr = document.createElement("tr");
                const td = document.createElement("td");
                td.colSpan = bunks.length + 1;
                td.textContent =
                    "No schedule blocks found for this division in the template.";
                td.className = "grey-cell";
                tr.appendChild(td);
                tbody.appendChild(tr);
            } else {
                flattenedBlocks.forEach((eventBlock) => {
                    const tr = document.createElement("tr");

                    // Time cell
                    const tdTime = document.createElement("td");
                    tdTime.style.border = "1px solid #ccc";
                    tdTime.style.verticalAlign = "top";
                    tdTime.style.fontWeight = "bold";
                    tdTime.textContent = eventBlock.label;
                    tr.appendChild(tdTime);

                    const isLeague =
                        eventBlock.event &&
                        (eventBlock.event.startsWith("League Game") ||
                            eventBlock.event.startsWith("Specialty League"));

                    if (isLeague) {
                        // LEAGUE / SPECIALTY: merged cell across bunks
                        const tdLeague = document.createElement("td");
                        tdLeague.colSpan = bunks.length;
                        tdLeague.style.verticalAlign = "top";
                        tdLeague.style.textAlign = "left";
                        tdLeague.style.padding = "5px 8px";
                        tdLeague.style.background = "#f0f8f0";

                        const firstSlotIndex = findFirstSlotForTime(eventBlock.startMin);

                        if (eventBlock.event.startsWith("Specialty League")) {
                            // Specialty League: group by field
                            const gamesByField = new Map();

                            if (firstSlotIndex !== -1) {
                                const uniqueMatchups = new Set();
                                bunks.forEach((bunk) => {
                                    const entry = getEntry(bunk, firstSlotIndex);
                                    if (entry && entry._h2h && entry.sport) {
                                        if (!uniqueMatchups.has(entry.sport)) {
                                            uniqueMatchups.add(entry.sport);
                                            const field = fieldLabel(entry.field);
                                            if (!gamesByField.has(field)) {
                                                gamesByField.set(field, []);
                                            }
                                            gamesByField.get(field).push(entry.sport);
                                        }
                                    }
                                });
                            }

                            let html = "";
                            if (!gamesByField.size) {
                                html = `<p class="muted" style="margin:0; padding: 4px;">${eventBlock.event}</p>`;
                            } else {
                                html = `<p style="margin:2px 0 5px 4px; font-weight: bold;">${eventBlock.event}</p>`;
                                gamesByField.forEach((matchups, field) => {
                                    const matchupNames = matchups.map((m) =>
                                        m.substring(0, m.lastIndexOf("(")).trim()
                                    );
                                    html += `<div style="margin-bottom: 2px; padding-left: 4px;">
                                                <strong>${matchupNames.join(", ")}</strong> - ${field}
                                             </div>`;
                                });
                            }
                            tdLeague.innerHTML = html;
                        } else {
                            // Regular League: list "matchup @ field"
                            const games = new Map();

                            if (firstSlotIndex !== -1) {
                                bunks.forEach((bunk) => {
                                    const entry = getEntry(bunk, firstSlotIndex);
                                    if (entry && entry._h2h && entry.sport) {
                                        games.set(entry.sport, fieldLabel(entry.field));
                                    }
                                });
                            }

                            let html = "";
                            if (!games.size) {
                                html = `<p class="muted" style="margin:0; padding: 4px;">${eventBlock.event}</p>`;
                            } else {
                                html = `<p style="margin:2px 0 5px 4px; font-weight: bold;">${eventBlock.event}</p>`;
                                html += '<ul style="margin: 0; padding-left: 18px;">';
                                games.forEach((field, matchup) => {
                                    html += `<li>${matchup} @ ${field}</li>`;
                                });
                                html += "</ul>";
                            }
                            tdLeague.innerHTML = html;
                        }

                        tr.appendChild(tdLeague);
                    } else {
                        // Regular / split activities: individual bunk cells
                        const slotIndex = findFirstSlotForTime(eventBlock.startMin);

                        bunks.forEach((bunk) => {
                            const tdActivity = document.createElement("td");
                            tdActivity.style.border = "1px solid #ccc";
                            tdActivity.style.verticalAlign = "top";

                            const entry = getEntry(bunk, slotIndex);
                            if (entry) {
                                tdActivity.textContent = formatEntry(entry);
                                if (entry._h2h) {
                                    tdActivity.style.background = "#e8f4ff";
                                    tdActivity.style.fontWeight = "bold";
                                } else if (entry._fixed) {
                                    tdActivity.style.background = "#f1f1f1";
                                }
                            }
                            tr.appendChild(tdActivity);
                        });
                    }

                    tbody.appendChild(tr);
                });
            }

            table.appendChild(tbody);
            wrapper.appendChild(table);
        });

        // Save today's counters back to daily data
        window.saveCurrentDailyData?.("leagueDayCounters", todayCounters);
    }

    // ===== SAVE / LOAD / INIT =====

    function saveSchedule() {
        try {
            window.saveCurrentDailyData?.(
                "scheduleAssignments",
                window.scheduleAssignments
            );
            window.saveCurrentDailyData?.(
                "leagueAssignments",
                window.leagueAssignments
            );
            window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
        } catch (e) {
            // swallow errors
            console.error("saveSchedule failed:", e);
        }
    }

    function reconcileOrRenderSaved() {
        try {
            const data = window.loadCurrentDailyData?.() || {};
            window.scheduleAssignments = data.scheduleAssignments || {};
            window.leagueAssignments = data.leagueAssignments || {};

            const savedTimes = data.unifiedTimes || [];
            window.unifiedTimes = savedTimes.map((slot) => ({
                ...slot,
                start: new Date(slot.start),
                end: new Date(slot.end)
            }));
        } catch (e) {
            console.error("reconcileOrRenderSaved failed:", e);
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            window.unifiedTimes = [];
        }

        updateTable();
    }

    function initScheduleSystem() {
        try {
            window.scheduleAssignments = window.scheduleAssignments || {};
            window.leagueAssignments = window.leagueAssignments || {};
            reconcileOrRenderSaved();
        } catch (e) {
            console.error("initScheduleSystem failed, falling back to empty:", e);
            updateTable();
        }
    }

    // ===== EXPORTS =====
    window.updateTable = window.updateTable || updateTable;
    window.initScheduleSystem = window.initScheduleSystem || initScheduleSystem;
    window.saveSchedule = window.saveSchedule || saveSchedule;
})();
