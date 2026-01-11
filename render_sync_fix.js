// ============================================================================
// render_sync_fix.js v1.0 - SCHEDULE DISPLAY SYNC FIX
// ============================================================================
// PROBLEM: Generated schedule data doesn't display in the Daily View
//
// ROOT CAUSES:
// 1. Slot index mismatch between generator and UI renderer
// 2. Skeleton events shown instead of actual assignments
// 3. availableDivisions may not include all divisions
//
// SOLUTION: Patch renderStaggeredView to ALWAYS check actual assignments
// ============================================================================

(function() {
    'use strict';

    console.log('[RenderSyncFix] Loading v1.0...');

    // =========================================================================
    // TIME HELPERS
    // =========================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== "string") return null;
        const m = str.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!m) return null;
        let h = parseInt(m[1]);
        const mins = parseInt(m[2]);
        const ap = m[3].toUpperCase();
        if (h === 12) h = (ap === "AM" ? 0 : 12);
        else if (ap === "PM") h += 12;
        return h * 60 + mins;
    }

    function minutesToTimeLabel(min) {
        const h24 = Math.floor(min / 60);
        const m = String(min % 60).padStart(2, "0");
        const ap = h24 >= 12 ? "PM" : "AM";
        const h12 = h24 % 12 || 12;
        return `${h12}:${m} ${ap}`;
    }

    // =========================================================================
    // SLOT FINDER - Find slot index for a given time in minutes
    // =========================================================================

    function findSlotIndexForTime(targetMins) {
        const times = window.unifiedTimes || [];
        if (times.length === 0) return -1;

        for (let i = 0; i < times.length; i++) {
            let slotStart;
            const t = times[i];
            
            if (t.start instanceof Date) {
                slotStart = t.start.getHours() * 60 + t.start.getMinutes();
            } else if (t.start) {
                const d = new Date(t.start);
                slotStart = d.getHours() * 60 + d.getMinutes();
            } else {
                continue;
            }

            // Match if slot starts at or near target time
            if (Math.abs(slotStart - targetMins) <= 15) {
                return i;
            }
        }

        // Fallback: find closest
        let closest = -1;
        let minDiff = Infinity;
        for (let i = 0; i < times.length; i++) {
            let slotStart;
            const t = times[i];
            if (t.start instanceof Date) {
                slotStart = t.start.getHours() * 60 + t.start.getMinutes();
            } else if (t.start) {
                slotStart = new Date(t.start).getHours() * 60 + new Date(t.start).getMinutes();
            } else continue;

            const diff = Math.abs(slotStart - targetMins);
            if (diff < minDiff) {
                minDiff = diff;
                closest = i;
            }
        }

        return closest;
    }

    // =========================================================================
    // GET ASSIGNMENT - Retrieve actual assignment for bunk/slot
    // =========================================================================

    function getAssignment(bunk, slotIdx) {
        const assignments = window.scheduleAssignments || {};
        if (!assignments[bunk]) return null;
        return assignments[bunk][slotIdx] || null;
    }

    function formatAssignment(entry) {
        if (!entry) return "";
        if (entry._isDismissal) return "Dismissal";
        if (entry._isSnack) return "Snacks";
        if (entry._isTransition) return "";
        
        const label = entry._activity || entry.field || "";
        if (label === "Free" || label === "") return "";
        if (entry._h2h) return entry.sport || "League";
        if (entry._fixed) return label;
        if (entry.sport && entry.field) return `${entry.field} – ${entry.sport}`;
        return label;
    }

    // =========================================================================
    // PATCHED RENDER FUNCTION
    // =========================================================================

    function patchedRenderStaggeredView(container) {
        if (!container) return;
        container.innerHTML = "";

        const divisions = window.divisions || {};
        
        // ★ FIX #1: Get ALL divisions, not just availableDivisions
        let divisionsToShow = Object.keys(divisions);
        
        // Sort numerically
        divisionsToShow.sort((a, b) => {
            const numA = parseInt(a);
            const numB = parseInt(b);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return String(a).localeCompare(String(b));
        });

        console.log('[RenderSyncFix] Rendering divisions:', divisionsToShow.join(', '));

        // Load skeleton
        const dailyData = window.loadCurrentDailyData?.() || {};
        const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const dateData = dailyData[dateKey] || dailyData;
        const manualSkeleton = dateData.manualSkeleton || window.manualSkeleton || window.skeleton || [];
        
        if (!Array.isArray(manualSkeleton) || manualSkeleton.length === 0) {
            container.innerHTML = `<p style="padding: 20px; color: #666;">No daily schedule generated for this date.</p>`;
            return;
        }

        console.log('[RenderSyncFix] Skeleton blocks:', manualSkeleton.length);
        console.log('[RenderSyncFix] Bunks in scheduleAssignments:', Object.keys(window.scheduleAssignments || {}).length);
        console.log('[RenderSyncFix] Time slots:', (window.unifiedTimes || []).length);

        const wrapper = document.createElement("div");
        wrapper.className = "schedule-view-wrapper";
        container.appendChild(wrapper);

        divisionsToShow.forEach((div) => {
            const divInfo = divisions[div];
            if (!divInfo) return;

            const bunks = (divInfo.bunks || []).slice().sort((a, b) =>
                String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
            );

            if (bunks.length === 0) return;

            const table = document.createElement("table");
            table.className = "schedule-division-table";

            // Header
            const thead = document.createElement("thead");
            const tr1 = document.createElement("tr");
            const th = document.createElement("th");
            th.colSpan = 1 + bunks.length;
            th.textContent = div;
            th.style.background = divInfo.color || "#444";
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

            // Body
            const tbody = document.createElement("tbody");

            // Get skeleton blocks for this division
            const blocks = manualSkeleton
                .filter((b) => b.division === div)
                .map((b) => ({
                    ...b,
                    startMin: parseTimeToMinutes(b.startTime),
                    endMin: parseTimeToMinutes(b.endTime),
                }))
                .filter((b) => b.startMin !== null && b.endMin !== null)
                .sort((a, b) => a.startMin - b.startMin);

            // Expand split blocks
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

                // ★ FIX #2: Find the CORRECT slot index for this block's time
                const slotIdx = findSlotIndexForTime(block.startMin);

                // League blocks - full width
                if (block.event?.startsWith("League Game") || block.event?.startsWith("Specialty League")) {
                    const td = document.createElement("td");
                    td.colSpan = bunks.length;
                    td.style.background = "#eef7f8";
                    td.style.fontWeight = "bold";

                    let allMatchups = [];
                    let gameLabel = "";
                    let titleHtml = block.event;

                    // Check leagueAssignments first
                    const leagueData = window.leagueAssignments?.[div]?.[slotIdx];
                    if (leagueData && leagueData.matchups) {
                        allMatchups = leagueData.matchups.map(m =>
                            `${m.teamA} vs ${m.teamB} — ${m.sport} @ ${m.field || 'TBD'}`
                        );
                        gameLabel = leagueData.gameLabel;
                    } else {
                        // Fallback: check bunk assignments
                        for (const b of bunks) {
                            const entry = getAssignment(b, slotIdx);
                            if (entry && entry._allMatchups) {
                                allMatchups = entry._allMatchups;
                                gameLabel = entry._gameLabel;
                                break;
                            }
                        }
                    }

                    if (gameLabel) {
                        titleHtml = block.event.includes("League Game") 
                            ? `${block.event} ${gameLabel.replace(/^Game\s+/i, '')}`
                            : `${block.event} (${gameLabel})`;
                    }

                    if (allMatchups.length === 0) {
                        td.textContent = titleHtml;
                    } else {
                        td.innerHTML = `<div>${titleHtml}</div><ul style="margin:4px 0 0 16px;padding:0;font-weight:normal;font-size:0.9em;">${allMatchups.map(m => `<li>${m}</li>`).join("")}</ul>`;
                    }
                    tr.appendChild(td);
                    tbody.appendChild(tr);
                    return;
                }

                // Elective blocks - full width
                if (block.type === "elective" || block.event?.toLowerCase().includes("elective")) {
                    const td = document.createElement("td");
                    td.colSpan = bunks.length;
                    td.style.background = "#f3e5f5";
                    td.innerHTML = `<div style="color:#6a1b9a;font-weight:bold;">🎯 Elective</div>`;
                    tr.appendChild(td);
                    tbody.appendChild(tr);
                    return;
                }

                // Regular activity cells - per bunk
                const isDismissal = block.event?.toLowerCase().includes("dismiss");
                const isSnack = block.event?.toLowerCase().includes("snack");
                const isLunch = block.event?.toLowerCase().includes("lunch");
                const isFixed = isDismissal || isSnack || isLunch || 
                               block.event?.toLowerCase().includes("arrival") ||
                               block.event?.toLowerCase().includes("mincha") ||
                               block.event?.toLowerCase().includes("lineup");

                bunks.forEach((bunk) => {
                    const td = document.createElement("td");
                    let label = "";
                    
                    // ★ FIX #3: ALWAYS check actual assignment FIRST
                    const entry = getAssignment(bunk, slotIdx);
                    const formattedEntry = formatAssignment(entry);
                    
                    if (isDismissal) {
                        label = "Dismissal";
                        td.style.background = "#ffdddd";
                    } else if (isSnack) {
                        label = "Snacks";
                        td.style.background = "#e7ffe7";
                    } else if (isLunch) {
                        label = "Lunch";
                        td.style.background = "#fff7cc";
                    } else if (formattedEntry && formattedEntry !== "") {
                        // ★ We have an ACTUAL assignment - use it!
                        label = formattedEntry;
                        td.style.background = "#f0f9ff"; // Light blue for generated
                    } else if (isFixed) {
                        // Fixed event with no assignment - show skeleton event
                        label = block.event;
                        td.style.background = "#fff7cc";
                    } else {
                        // Generated slot with no assignment - show "Free"
                        label = "Free";
                        td.style.background = "#f8f8f8";
                    }

                    td.textContent = label;
                    td.style.cursor = "pointer";
                    td.title = entry ? `Slot ${slotIdx}: ${JSON.stringify(entry).substring(0, 100)}...` : `Slot ${slotIdx}: empty`;
                    
                    tr.appendChild(td);
                });

                tbody.appendChild(tr);
            });

            table.appendChild(tbody);
            wrapper.appendChild(table);
        });

        console.log('[RenderSyncFix] Render complete');
    }

    // =========================================================================
    // INSTALL THE FIX
    // =========================================================================

    function installFix() {
        // Store original
        if (typeof window.renderStaggeredView === 'function') {
            window._originalRenderStaggeredView = window.renderStaggeredView;
        }
        
        // Replace with patched version
        window.renderStaggeredView = patchedRenderStaggeredView;
        
        // Also patch updateTable
        const originalUpdateTable = window.updateTable;
        window.updateTable = function() {
            const container = document.getElementById("scheduleTable");
            if (container) {
                patchedRenderStaggeredView(container);
            }
        };
        
        console.log('[RenderSyncFix] ✅ Patch installed');
        
        // Trigger immediate re-render
        window.updateTable();
    }

    // =========================================================================
    // QUICK DEBUG HELPER
    // =========================================================================

    window.debugSlotMapping = function(bunk, startTime) {
        const times = window.unifiedTimes || [];
        const targetMins = parseTimeToMinutes(startTime);
        const slotIdx = findSlotIndexForTime(targetMins);
        const entry = getAssignment(bunk, slotIdx);
        
        console.log(`\n=== DEBUG: ${bunk} at ${startTime} ===`);
        console.log(`Target minutes: ${targetMins}`);
        console.log(`Found slot index: ${slotIdx}`);
        console.log(`Assignment:`, entry);
        
        if (times[slotIdx]) {
            const t = times[slotIdx];
            let slotTime;
            if (t.start instanceof Date) {
                slotTime = t.start.toLocaleTimeString();
            } else {
                slotTime = new Date(t.start).toLocaleTimeString();
            }
            console.log(`Slot ${slotIdx} time:`, slotTime);
        }
        
        return { slotIdx, entry };
    };

    // =========================================================================
    // AUTO-INSTALL
    // =========================================================================

    function waitAndInstall() {
        if (document.getElementById('scheduleTable') && window.renderStaggeredView) {
            installFix();
        } else {
            setTimeout(waitAndInstall, 200);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitAndInstall);
    } else {
        waitAndInstall();
    }

    // Re-install after data updates
    window.addEventListener('campistry-daily-data-updated', () => {
        console.log('[RenderSyncFix] Data updated, refreshing...');
        setTimeout(() => window.updateTable?.(), 100);
    });

    console.log('[RenderSyncFix] Module loaded');

})();
