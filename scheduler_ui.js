// ============================================================================
// scheduler_ui.js (COMBINED: CAMPISTRY + ELECTIVE DISPLAY + LEAGUE SOURCE OF TRUTH)
// ============================================================================

// Wait for Campistry cloud system
(function waitForCampistry() {
    if (!window.__CAMPISTRY_READY__) {
        setTimeout(waitForCampistry, 50);
        return;
    }
})();

(function () {
    "use strict";

    const INCREMENT_MINS = 30;

    // =========================================================================
    // TIME HELPERS
    // =========================================================================

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

    function minutesToTimeLabel(min) {
        const h24 = Math.floor(min / 60);
        const m = String(min % 60).padStart(2, "0");
        const ap = h24 >= 12 ? "PM" : "AM";
        const h12 = h24 % 12 || 12;
        return `${h12}:${m} ${ap}`;
    }

    // =========================================================================
    // RESOURCE RESOLVER
    // =========================================================================

    function resolveResourceName(input, knownNames) {
        if (!input || !knownNames) return null;
        const cleanInput = String(input).toLowerCase().trim();

        if (knownNames.includes(input)) return input;

        const sortedNames = [...knownNames].sort((a, b) => b.length - a.length);
        for (const name of sortedNames) {
            const cleanName = name.toLowerCase().trim();
            if (cleanInput.startsWith(cleanName)) {
                return name;
            }
        }
        return null;
    }

    // =========================================================================
    // DETECT GENERATED EVENTS
    // =========================================================================

    const UI_GENERATED_EVENTS = new Set([
        "general activity", "general activity slot", "activity", "activities", "sports", "sport", "sports slot", "special activity", "swim", "league game", "specialty league"
    ]);

    function uiIsGeneratedEventName(name) {
        if (!name) return false;
        return UI_GENERATED_EVENTS.has(String(name).trim().toLowerCase());
    }

    // =========================================================================
    // SLOT FINDER
    // =========================================================================

    function findSlotsForRange(startMin, endMin) {
        const slots = [];
        const times = window.unifiedTimes;
        if (!times) return slots;

        for (let i = 0; i < times.length; i++) {
            const slotStart = new Date(times[i].start).getHours() * 60 + new Date(times[i].start).getMinutes();
            let slotEnd;
            if (times[i].end) {
                slotEnd = new Date(times[i].end).getHours() * 60 + new Date(times[i].end).getMinutes();
            } else {
                slotEnd = slotStart + INCREMENT_MINS;
            }

            if (startMin < slotEnd && endMin > slotStart) {
                slots.push(i);
            }
        }
        return slots;
    }

    // =========================================================================
    // EDIT CELL
    // =========================================================================

    function editCell(bunk, startMin, endMin, current) {
        if (!bunk) return;
        
        // CHECK PERMISSIONS FOR EDITING THIS BUNK
        if (window.AccessControl && !window.AccessControl.canEditBunk(bunk)) {
            alert("You do not have permission to edit this schedule.");
            return;
        }

        // 1. Get user input
        const newName = prompt(`Edit activity for ${bunk}\n${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}\n(Enter CLEAR or FREE to empty)`, current);
        if (newName === null) return;

        const value = newName.trim();
        const isClear = (value === "" || value.toUpperCase() === "CLEAR" || value.toUpperCase() === "FREE");

        // --- VALIDATION GATE ---
        if (!isClear && window.SchedulerCoreUtils && typeof window.SchedulerCoreUtils.loadAndFilterData === 'function') {
            const warnings = [];
            const config = window.SchedulerCoreUtils.loadAndFilterData();
            const { activityProperties, historicalCounts, lastUsedDates } = config;

            const allKnown = Object.keys(activityProperties);
            const resolvedName = resolveResourceName(value, allKnown) || value;
            const props = activityProperties[resolvedName];

            // A. SAME BUNK CHECK
            const currentSchedule = window.scheduleAssignments[bunk] || [];
            const targetSlots = findSlotsForRange(startMin, endMin);

            currentSchedule.forEach((entry, idx) => {
                if (targetSlots.includes(idx)) return;
                if (entry && !entry.continuation) {
                    const entryRaw = entry.field || entry._activity;
                    if (String(entryRaw).trim().toLowerCase() === String(value).trim().toLowerCase()) {
                        const timeLabel = window.unifiedTimes[idx]?.label || minutesToTimeLabel(window.unifiedTimes[idx].start);
                        warnings.push(`⚠️ DUPLICATE: ${bunk} is already scheduled for "${entryRaw}" at ${timeLabel}.`);
                    }
                }
            });

            if (props) {
                // B. MAX USAGE CHECK
                const max = props.maxUsage || 0;
                if (max > 0) {
                    const historyCount = historicalCounts[bunk]?.[resolvedName] || 0;
                    let todayCount = 0;
                    currentSchedule.forEach((entry, idx) => {
                        if (targetSlots.includes(idx)) return;
                        if (entry && !entry.continuation) {
                            const entryRes = resolveResourceName(entry.field || entry._activity, allKnown);
                            if (String(entryRes).toLowerCase() === String(resolvedName).toLowerCase()) todayCount++;
                        }
                    });

                    const total = historyCount + todayCount + 1;
                    if (total > max) {
                        const lastDateStr = lastUsedDates[bunk]?.[resolvedName];
                        const dateInfo = lastDateStr ? ` (Last used: ${lastDateStr})` : "";
                        warnings.push(`⚠️ MAX USAGE: ${bunk} has used "${resolvedName}" ${historyCount + todayCount} times${dateInfo}. Limit is ${max}.`);
                    }
                }

                // C. TIMELINE CAPACITY CHECK
                let capacityLimit = 1;
                if (props.sharableWith?.capacity) capacityLimit = parseInt(props.sharableWith.capacity);
                else if (props.sharable || props.sharableWith?.type === 'all' || props.sharableWith?.type === 'custom') capacityLimit = 2;

                let myWeight = 1;

                const isAvailable = window.SchedulerCoreUtils.timeline.checkAvailability(
                    resolvedName,
                    startMin,
                    endMin,
                    myWeight,
                    capacityLimit,
                    bunk
                );

                if (!isAvailable) {
                    const currentPeak = window.SchedulerCoreUtils.timeline.getPeakUsage(resolvedName, startMin, endMin, bunk);
                    warnings.push(`⚠️ CAPACITY CONFLICT: "${resolvedName}" is full during this time.\n    Current Peak: ${currentPeak} bunks.\n    Limit: ${capacityLimit}.`);
                }

                // D. TIME RULES CHECK
                if (!window.SchedulerCoreUtils.isTimeAvailable(startMin, endMin, props)) {
                    warnings.push(`⚠️ TIME RESTRICTION: "${resolvedName}" is closed/unavailable during this time block.`);
                }
            }

            if (warnings.length > 0) {
                const msg = warnings.join("\n\n") + "\n\nDo you want to OVERRIDE these rules and schedule anyway?";
                if (!confirm(msg)) {
                    return;
                }
            }
        }

        // --- APPLY EDIT ---
        const slots = findSlotsForRange(startMin, endMin);

        if (!slots || slots.length === 0) {
            alert("Error: Could not match this time range to the internal schedule grid. Please refresh the page.");
            return;
        }

        if (!window.scheduleAssignments[bunk])
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);

        if (isClear) {
            slots.forEach((idx, i) => {
                window.scheduleAssignments[bunk][idx] = {
                    field: "Free", sport: null, continuation: i > 0, _fixed: true, _activity: "Free"
                };
            });
        } else {
            slots.forEach((idx, i) => {
                window.scheduleAssignments[bunk][idx] = {
                    field: value, sport: null, continuation: i > 0, _fixed: true, _activity: value
                };
            });
        }

        saveSchedule();
        updateTable();
    }

    function getEntry(bunk, slotIndex) {
        const a = window.scheduleAssignments || {};
        if (!a[bunk]) return null;
        return a[bunk][slotIndex] || null;
    }

    function formatEntry(entry) {
        if (!entry) return "";
        if (entry._isDismissal) return "Dismissal";
        if (entry._isSnack) return "Snacks";
        const label = entry._activity || entry.field || "";
        if (entry._h2h) return entry.sport || "League Game";
        if (entry._fixed) return label;
        if (entry.sport) return `${entry.field} – ${entry.sport}`;
        return label;
    }

    function findFirstSlotForTime(startMin) {
        if (!window.unifiedTimes) return -1;
        for (let i = 0; i < window.unifiedTimes.length; i++) {
            const slotStart = new Date(window.unifiedTimes[i].start).getHours() * 60 + new Date(window.unifiedTimes[i].start).getMinutes();
            if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) return i;
        }
        return -1;
    }

    function updateTable() {
        const container = document.getElementById("scheduleTable");
        if (!container) return;
        renderStaggeredView(container);
    }

    // --- DYNAMIC GRID (RENDERER) ---
    function renderStaggeredView(container) {
        container.innerHTML = "";
        const divisions = window.divisions || {};
        
        // ★★★ UPDATE: DYNAMIC DISCOVERY OF DIVISIONS ★★★
        const assignments = window.scheduleAssignments || {};
        const daily = window.loadCurrentDailyData?.() || {};
        const manualSkeleton = daily.manualSkeleton || [];

        const divisionsWithData = new Set();
        let hasAnyData = false;

        // 1. Scan Assignments (find bunks with actual data)
        Object.keys(assignments).forEach(bunkName => {
            const bunkSchedule = assignments[bunkName];
            // Check if bunk has real assignments (not just empty array)
            const hasRealItems = bunkSchedule && Array.isArray(bunkSchedule) && bunkSchedule.some(s => s && s.field);
            
            if (hasRealItems) {
                // Find division for this bunk
                for (const [divName, divInfo] of Object.entries(divisions)) {
                    if (divInfo.bunks && (divInfo.bunks.includes(bunkName) || divInfo.bunks.map(String).includes(String(bunkName)))) {
                        divisionsWithData.add(divName);
                        hasAnyData = true;
                        break;
                    }
                }
            }
        });

        // 2. Scan Skeleton (find divisions with planned blocks)
        if (Array.isArray(manualSkeleton)) {
            manualSkeleton.forEach(block => {
                if (block.division) {
                    divisionsWithData.add(block.division);
                    hasAnyData = true;
                }
            });
        }

        let divisionsToShow = [];

        if (hasAnyData) {
            // Sort by defined order in window.divisions
            const allDivs = Object.keys(divisions);
            divisionsToShow = Array.from(divisionsWithData).sort((a, b) => {
                return allDivs.indexOf(a) - allDivs.indexOf(b);
            });
        } else {
            // Fallback: If no data exists, show default available based on permissions
            if (window.AccessControl && window.AccessControl.getUserManagedDivisions) {
                divisionsToShow = window.AccessControl.getUserManagedDivisions();
            } else {
                divisionsToShow = window.availableDivisions || Object.keys(divisions);
            }
        }

        console.log(`[UI] Render Divisions: ${divisionsToShow.join(', ')}`);

        if (divisionsToShow.length === 0) {
            container.innerHTML = `<p>No schedule data available for viewable divisions.</p>`;
            return;
        }

        const wrapper = document.createElement("div");
        wrapper.className = "schedule-view-wrapper";
        container.appendChild(wrapper);

        divisionsToShow.forEach((div) => {
            const bunks = (divisions[div]?.bunks || []).slice().sort((a, b) =>
                String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
            );

            if (bunks.length === 0) return;

            const table = document.createElement("table");
            table.className = "schedule-division-table";

            const thead = document.createElement("thead");
            const tr1 = document.createElement("tr");
            const th = document.createElement("th");
            th.colSpan = 1 + bunks.length;
            th.textContent = div;
            th.style.background = divisions[div]?.color || "#444";
            th.style.color = "#fff";
            tr1.appendChild(th);
            thead.appendChild(tr1);

            const tr2 = document.createElement("tr");
            const thTime = document.createElement("th");
            thTime.textContent = "Time";
            tr2.appendChild(thTime);

            bunks.forEach((b) => {
                const thB = document.createElement("th");
                thB.textContent = b;
                tr2.appendChild(thB);
            });
            thead.appendChild(tr2);
            table.appendChild(thead);

            const tbody = document.createElement("tbody");

            const blocks = manualSkeleton
                .filter((b) => b.division === div)
                .map((b) => ({
                    ...b,
                    startMin: parseTimeToMinutes(b.startTime),
                    endMin: parseTimeToMinutes(b.endTime),
                }))
                .filter((b) => b.startMin !== null && b.endMin !== null)
                .sort((a, b) => a.startMin - b.startMin);

            const expanded = [];
            blocks.forEach((b) => {
                if (b.type === "split") {
                    const mid = b.startMin + (b.endMin - b.startMin) / 2;
                    expanded.push({ ...b, endMin: mid, label: `${minutesToTimeLabel(b.startMin)} - ${minutesToTimeLabel(mid)}` });
                    expanded.push({ ...b, startMin: mid, label: `${minutesToTimeLabel(mid)} - ${minutesToTimeLabel(b.endMin)}` });
                } else {
                    expanded.push({ ...b, label: `${minutesToTimeLabel(b.startMin)} - ${minutesToTimeLabel(b.endMin)}` });
                }
            });

            expanded.forEach((block) => {
                const tr = document.createElement("tr");
                const tdTime = document.createElement("td");
                tdTime.textContent = block.label;
                tr.appendChild(tdTime);

                // --- LEAGUE BLOCK RENDERER ---
                if (block.event.startsWith("League Game") || block.event.startsWith("Specialty League")) {
                    const td = document.createElement("td");
                    td.colSpan = bunks.length;
                    td.style.background = "#eef7f8";
                    td.style.fontWeight = "bold";

                    const slotIdx = findFirstSlotForTime(block.startMin);
                    let allMatchups = [];
                    let gameLabel = "";
                    let titleHtml = block.event;

                    // 1. CHECK THE MASTER SOURCE (window.leagueAssignments)
                    const leagueData = window.leagueAssignments?.[div]?.[slotIdx];

                    if (leagueData && leagueData.matchups) {
                        allMatchups = leagueData.matchups.map(m =>
                            `${m.teamA} vs ${m.teamB} — ${m.sport} @ ${m.field || 'TBD'}`
                        );
                        gameLabel = leagueData.gameLabel;
                    } else {
                        // Fallback: Scan bunks (legacy support)
                        for (const b of bunks) {
                            const entry = getEntry(b, slotIdx);
                            if (entry && entry._allMatchups && entry._allMatchups.length > 0) {
                                allMatchups = entry._allMatchups;
                                gameLabel = entry._gameLabel;
                                break;
                            }
                        }
                    }

                    if (gameLabel) {
                        if (block.event.trim() === "League Game") {
                            titleHtml = `${block.event} ${gameLabel.replace(/^Game\s+/i, '')}`;
                        } else {
                            titleHtml = `${block.event} (${gameLabel})`;
                        }
                    }

                    if (allMatchups.length === 0) {
                        td.textContent = titleHtml;
                    } else {
                        td.innerHTML = `<div>${titleHtml}</div><ul>${allMatchups.map((m) => `<li>${m}</li>`).join("")}</ul>`;
                    }
                    td.style.cursor = "pointer";
                    td.onclick = () => editCell(bunks[0], block.startMin, block.endMin, block.event);
                    tr.appendChild(td);
                    tbody.appendChild(tr);
                    return;
                }

                // --- ELECTIVE BLOCK RENDERER ---
                if (block.type === "elective" || block.event.toLowerCase().startsWith("elective")) {
                    const td = document.createElement("td");
                    td.colSpan = bunks.length;
                    td.style.background = "#f3e5f5"; // Light purple
                    td.style.fontWeight = "bold";

                    const activities = block.electiveActivities || block.reservedFields || [];

                    let contentHtml = `<div style="color:#6a1b9a;">🎯 Elective</div>`;
                    if (activities.length > 0) {
                        contentHtml += `<div style="font-size:0.9em;font-weight:normal;margin-top:4px;">`;
                        contentHtml += `<strong>Reserved for ${div}:</strong> ${activities.join(', ')}`;
                        contentHtml += `</div>`;
                        contentHtml += `<div style="font-size:0.8em;color:#666;margin-top:2px;">`;
                        contentHtml += `Other divisions cannot use these activities during this time.`;
                        contentHtml += `</div>`;
                    } else {
                        contentHtml += `<div style="font-size:0.85em;color:#666;">No activities specified</div>`;
                    }

                    td.innerHTML = contentHtml;
                    td.style.cursor = "pointer";
                    td.onclick = () => {
                        const msg = `Elective Block for ${div}\n\n` +
                            `Time: ${block.label}\n` +
                            `Reserved Activities: ${activities.join(', ') || 'None'}\n\n` +
                            `These activities are locked for other divisions during this time.`;
                        alert(msg);
                    };
                    tr.appendChild(td);
                    tbody.appendChild(tr);
                    return;
                }

                const isDismissal = block.event.toLowerCase().includes("dismiss");
                const isSnack = block.event.toLowerCase().includes("snack");
                const isGeneratedSlot = uiIsGeneratedEventName(block.event) || block.event.includes("/");

                bunks.forEach((bunk) => {
                    const td = document.createElement("td");
                    let label = block.event;
                    const slotIdx = findFirstSlotForTime(block.startMin);

                    if (isDismissal) {
                        label = "Dismissal";
                        td.style.background = "#ffdddd";
                    } else if (isSnack) {
                        label = "Snacks";
                        td.style.background = "#e7ffe7";
                    } else if (!isGeneratedSlot) {
                        td.style.background = "#fff7cc";
                        label = block.event;
                    } else {
                        const entry = getEntry(bunk, slotIdx);
                        label = formatEntry(entry);
                    }

                    td.textContent = label;
                    td.style.cursor = "pointer";
                    td.onclick = () => editCell(bunk, block.startMin, block.endMin, label);
                    tr.appendChild(td);
                });

                tbody.appendChild(tr);
            });

            table.appendChild(tbody);
            wrapper.appendChild(table);
        });
    }

    function saveSchedule() {
        window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
        window.saveCurrentDailyData?.("leagueAssignments", window.leagueAssignments);
        window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
    }

    function reconcileOrRenderSaved() {
        try {
            const data = window.loadCurrentDailyData?.() || {};
            window.scheduleAssignments = data.scheduleAssignments || {};
            window.leagueAssignments = data.leagueAssignments || {};
            const savedTimes = data.unifiedTimes || [];
            window.unifiedTimes = savedTimes.map((slot) => ({ ...slot, start: new Date(slot.start), end: new Date(slot.end) }));
        } catch (e) {
            console.error("Schedule load error:", e);
            window.scheduleAssignments = {};
            window.leagueAssignments = {};
            window.unifiedTimes = [];
        }
        updateTable();
    }

    function initScheduleSystem() {
        reconcileOrRenderSaved();
        
        // HOOK UP GENERATOR BUTTON
        const genBtn = document.getElementById("btn-generate-schedule");
        if (genBtn) {
            genBtn.onclick = async () => {
                if (window.AccessControl && !window.AccessControl.canRunGenerator()) {
                    alert("You do not have permission to run the generator.");
                    return;
                }
                
                genBtn.disabled = true;
                genBtn.textContent = "Generating...";
                
                try {
                    // 1. Get permissions
                    const allowedDivisions = window.AccessControl 
                        ? window.AccessControl.getUserManagedDivisions() 
                        : null;
                        
                    // 2. Capture snapshot for locking
                    let snapshot = null;
                    if (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0) {
                        snapshot = JSON.parse(JSON.stringify(window.scheduleAssignments));
                    }
                    
                    // 3. Get inputs
                    const daily = window.loadCurrentDailyData?.() || {};
                    const manualSkeleton = daily.manualSkeleton || [];
                    const externalOverrides = []; // Simplified for now
                    
                    // 4. Run!
                    if (window.runSkeletonOptimizer) {
                        await window.runSkeletonOptimizer(
                            manualSkeleton, 
                            externalOverrides, 
                            allowedDivisions, 
                            snapshot
                        );
                        alert("Schedule Generated Successfully!");
                    } else {
                        alert("Error: Scheduler Core not loaded.");
                    }
                } catch (e) {
                    console.error(e);
                    alert("An error occurred during generation.");
                } finally {
                    genBtn.disabled = false;
                    genBtn.textContent = "Generate Schedule";
                    updateTable();
                }
            };
        }
    }

    window.updateTable = updateTable;
    window.initScheduleSystem = initScheduleSystem;
    window.saveSchedule = saveSchedule;
})();
