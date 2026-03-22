// =================================================================
// auto_schedule_grid.js — Auto Mode Schedule Grid Renderer v2.1
// =================================================================
// v2.1 CHANGES:
// ★★★ POST-EDIT INTEGRATION ★★★
//   - Activity blocks are clickable when isEditable=true
//   - Clicking opens the integrated edit modal (same as manual mode)
//   - Free/empty gaps are clickable to add new activities
//   - Full conflict detection, rotation tracking, and smart reassignment
//   - Bypass save for cross-division edits
//
// Architecture: CSS Grid with time-rows × bunk-columns.
// League slots interrupt the column layout as TRUE full-width rows
// using grid-column: span N — not overlays, not patches.
//
// Each division renders as a CSS grid where:
//   - Column 0: time ruler
//   - Columns 1…N: one per bunk
//   - Rows: one per time increment tick
//   - League rows: grid cells with colspan = bunks.length
//
// =================================================================

(function () {
    'use strict';

    // ─────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────
    var PX_PER_MIN = 2.5;
    var DEFAULT_INCREMENT = 30;

    function getIncrement() {
        try { var s = localStorage.getItem('campistry_autoGridIncrement'); if (s) return parseInt(s) || DEFAULT_INCREMENT; } catch (e) {}
        return DEFAULT_INCREMENT;
    }
    function setIncrement(val) {
        try { localStorage.setItem('campistry_autoGridIncrement', String(val)); } catch (e) {}
    }

    // ─────────────────────────────────────────────
    // UTILS
    // ─────────────────────────────────────────────
    function toLabel(min) {
        var h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
    }

    function esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function snapToIncrement(min, inc) {
        return Math.round(min / inc) * inc;
    }

    // ─────────────────────────────────────────────
    // ★★★ v2.1: SLOT INDEX LOOKUP FOR POST-EDIT ★★★
    // Finds the per-bunk slot index matching a time range.
    // This is needed to bridge the timeline view (time-based)
    // with the scheduleAssignments array (index-based).
    // ─────────────────────────────────────────────
   function findSlotIndex(bunk, divName, startMin, endMin) {
        // Method 1: Per-bunk slots (auto mode canonical)
        var perBunkSlots = (window.divisionTimes || {})[divName];
        if (perBunkSlots && perBunkSlots._perBunkSlots) {
            var bunkSlots = perBunkSlots._perBunkSlots[String(bunk)];
            if (bunkSlots) {
                // Exact match (single-slot block)
                for (var i = 0; i < bunkSlots.length; i++) {
                    if (bunkSlots[i].startMin === startMin && bunkSlots[i].endMin === endMin) return i;
                }
                // ★★★ FIX: Match on startMin only — handles multi-slot continuation blocks
                // where getBunkActivities merged slots 3+4 into one block with combined endMin.
                // We need the FIRST slot (the one with the actual assignment, not continuation).
                for (var j = 0; j < bunkSlots.length; j++) {
                    if (bunkSlots[j].startMin === startMin) return j;
                }
                // Last resort: overlapping match
                for (var k = 0; k < bunkSlots.length; k++) {
                    if (bunkSlots[k].startMin >= startMin && bunkSlots[k].startMin < endMin) return k;
                }
            }
        }

        // Method 2: Division-level slots (non-auto fallback)
        var divSlots = (window.divisionTimes || {})[divName];
        if (divSlots && Array.isArray(divSlots)) {
            for (var m = 0; m < divSlots.length; m++) {
                if (divSlots[m].startMin === startMin) return m;
            }
        }

        // Method 3: Use SchedulerCoreUtils with bunk context
        if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.findSlotsForRange) {
            var slots = window.SchedulerCoreUtils.findSlotsForRange(startMin, endMin, divName, String(bunk));
            if (slots.length > 0) return slots[0];
        }

        return -1;
    }

    // ─────────────────────────────────────────────
    // ★★★ v2.1: OPEN EDIT FOR BLOCK ★★★
    // Entry point when user clicks an activity block.
    // Delegates to the integrated edit modal (same as manual mode).
    // ─────────────────────────────────────────────
    function openEditForBlock(bunk, divName, startMin, endMin, entry) {
        var slotIdx = findSlotIndex(bunk, divName, startMin, endMin);

        if (slotIdx === -1) {
            console.warn('[AutoGrid] Could not find slot index for', bunk, startMin, '-', endMin);
            // Fallback: use enhancedEditCell with time range
            if (typeof window.enhancedEditCell === 'function') {
                var currentText = entry ? (entry._activity || entry.field || '') : '';
                window.enhancedEditCell(bunk, startMin, endMin, currentText);
            }
            return;
        }

        var existingEntry = (window.scheduleAssignments || {})[bunk];
        existingEntry = existingEntry ? existingEntry[slotIdx] : null;

        // Prefer the integrated edit modal (scope selection + multi-bunk)
        if (typeof window.openIntegratedEditModal === 'function') {
            window.openIntegratedEditModal(bunk, slotIdx, existingEntry);
        }
        // Fallback: legacy edit modal
        else if (typeof window.enhancedEditCell === 'function') {
            var text = existingEntry ? (existingEntry._activity || existingEntry.field || '') : '';
            window.enhancedEditCell(bunk, startMin, endMin, text);
        }
        else {
            console.error('[AutoGrid] No edit modal available');
        }
    }

    // ─────────────────────────────────────────────
    // ★★★ v2.1: OPEN EDIT FOR FREE GAP ★★★
    // When clicking an empty area, open edit to add a new activity.
    // ─────────────────────────────────────────────
    function openEditForGap(bunk, divName, startMin, endMin) {
        var slotIdx = findSlotIndex(bunk, divName, startMin, endMin);

        if (slotIdx !== -1 && typeof window.openIntegratedEditModal === 'function') {
            window.openIntegratedEditModal(bunk, slotIdx, null);
        } else if (typeof window.enhancedEditCell === 'function') {
            window.enhancedEditCell(bunk, startMin, endMin, '');
        }
    }

    // ─────────────────────────────────────────────
    // ACTIVITY COLOR PALETTE
    // ─────────────────────────────────────────────
    function blockStyle(entry) {
        if (!entry) return { bg: '#f3f4f6', border: '#d1d5db', text: '#9ca3af', label: 'Free' };
        var act = (entry._activity || entry.field || '').toLowerCase();

        if (entry._fixed || entry._pinned) {
            if (act.includes('lunch'))    return { bg: '#fff7ed', border: '#fb923c', text: '#9a3412', accent: '#f97316' };
            if (act.includes('snack'))    return { bg: '#fefce8', border: '#facc15', text: '#854d0e', accent: '#eab308' };
            if (act.includes('dismissal'))return { bg: '#fef2f2', border: '#f87171', text: '#991b1b', accent: '#ef4444' };
            if (act.includes('swim'))     return { bg: '#ecfeff', border: '#22d3ee', text: '#164e63', accent: '#06b6d4' };
            return { bg: '#eef2ff', border: '#818cf8', text: '#3730a3', accent: '#6366f1' };
        }
        if (entry._h2h || act.includes('league')) return { bg: '#eff6ff', border: '#60a5fa', text: '#1e3a8a', accent: '#3b82f6' };

        if (window.RotationEngine?.isSpecialActivity?.(entry._activity))
            return { bg: '#faf5ff', border: '#c084fc', text: '#6b21a8', accent: '#a855f7' };

        if (!act || act === 'free' || act === 'free play')
            return { bg: '#f9fafb', border: '#e5e7eb', text: '#9ca3af' };

        return { bg: '#f0fdf4', border: '#4ade80', text: '#14532d', accent: '#22c55e' };
    }

    // ─────────────────────────────────────────────
    // COLLECT ACTIVITIES FOR A BUNK (time-based)
    // ─────────────────────────────────────────────
    function getBunkActivities(bunk, divName) {
        var assignments = (window.scheduleAssignments || {})[bunk];
        if (!Array.isArray(assignments)) return [];

        var allDivSlots = (window.divisionTimes || {})[divName] || [];
        var divSlots = (allDivSlots._perBunkSlots && allDivSlots._perBunkSlots[bunk])
            ? allDivSlots._perBunkSlots[bunk]
            : allDivSlots;
        if (!divSlots.length) return [];

        var out = [], i = 0;
        while (i < assignments.length && i < divSlots.length) {
            var entry = assignments[i];
            var slot  = divSlots[i];
            if (!entry || entry._isTransition || entry.continuation) { i++; continue; }

            var end = i;
            while (end + 1 < assignments.length && end + 1 < divSlots.length && assignments[end + 1]?.continuation) end++;

            if (!divSlots[i] || !divSlots[end]) { i = end + 1; continue; }

            out.push({
                startMin: divSlots[i].startMin,
                endMin:   divSlots[end].endMin,
                duration: divSlots[end].endMin - divSlots[i].startMin,
                entry:    entry,
                slotIdx:  i,  // ★★★ v2.1: Track slot index for edit
                isLeague: !!(entry._league || entry._h2h)
            });
            i = end + 1;
        }
        return out;
    }

    // ─────────────────────────────────────────────
    // COLLECT LEAGUE SLOTS FOR A DIVISION
    // ─────────────────────────────────────────────
    function getLeagueSlotsForDiv(divName, bunks) {
        var perBunkSlots = (window.divisionTimes?.[divName])?._perBunkSlots;
        if (!perBunkSlots) return [];

        var seen = {}, result = [];
        bunks.forEach(function (bunk) {
            var bSlots = perBunkSlots[String(bunk)] || [];
            var assignments = (window.scheduleAssignments || {})[String(bunk)] || [];
            bSlots.forEach(function (slot, idx) {
                var a = assignments[idx];
                if (a && a._league && !seen[slot.startMin]) {
                    seen[slot.startMin] = true;

                    // Pull full matchup data from leagueAssignments (authoritative)
                    var matchups = a.matchups || [];
                    var gameLabel = a._gameLabel || '';
                    var leagueName = a._leagueName || '';
                    var sport = a.sport || '';

                    var la = window.leagueAssignments || {};
                    var divEntry = la[divName];
                    if (divEntry) {
                        var first = Object.values(divEntry)[0];
                        if (first) {
                            if (first.matchups && first.matchups.length) matchups = first.matchups;
                            gameLabel  = first.gameLabel  || gameLabel;
                            leagueName = first.leagueName || leagueName;
                            sport      = first.sport      || sport;
                        }
                    }

                    result.push({
                        startMin:  slot.startMin,
                        endMin:    slot.endMin,
                        matchups:  matchups,
                        gameLabel: gameLabel,
                        leagueName: leagueName,
                        sport:     sport
                    });
                }
            });
        });
        return result;
    }

    // ─────────────────────────────────────────────
    // PARSE MATCHUP STRING
    // "Team1 vs Team2 @ Field (Sport)" → { teams, sport, field }
    // ─────────────────────────────────────────────
    function parseMatchup(raw, fallbackSport) {
        var text = String(raw || '');
        var m = text.match(/^(.+?)\s*@\s*(.+?)\s*\((.+?)\)$/);
        if (m) return { teams: m[1].trim(), field: m[2].trim(), sport: m[3].trim() };
        // Try "Team1 vs Team2 - Sport - Field"
        var parts = text.split(' — ');
        if (parts.length >= 2) return { teams: parts[0].trim(), sport: parts[1].trim(), field: parts[2] ? parts[2].trim() : '' };
        return { teams: text, sport: fallbackSport || '', field: '' };
    }

    // ─────────────────────────────────────────────
    // ★★★ v2.1: COMPUTE FREE GAPS FOR A BUNK ★★★
    // Returns array of { startMin, endMin } for unoccupied time.
    // Used to render clickable free-gap indicators.
    // ─────────────────────────────────────────────
    function computeFreeGaps(bunk, divName, dayStart, dayEnd) {
        var activities = getBunkActivities(bunk, divName);
        var gaps = [];
        var cursor = dayStart;

        // Sort by startMin
        activities.sort(function (a, b) { return a.startMin - b.startMin; });

        for (var i = 0; i < activities.length; i++) {
            if (activities[i].startMin > cursor) {
                gaps.push({ startMin: cursor, endMin: activities[i].startMin });
            }
            cursor = Math.max(cursor, activities[i].endMin);
        }
        if (cursor < dayEnd) {
            gaps.push({ startMin: cursor, endMin: dayEnd });
        }

        // Only return gaps large enough to be meaningful (≥10 min)
        return gaps.filter(function (g) { return g.endMin - g.startMin >= 10; });
    }

    // ─────────────────────────────────────────────
    // INJECT STYLES (once)
    // ─────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('asg-v2-styles')) return;
        var s = document.createElement('style');
        s.id = 'asg-v2-styles';
        s.textContent = `
/* ── Auto Schedule Grid v2.1 ── */
.asg-wrap {
    border-radius: 10px;
    overflow: hidden;
    width: 100%;
    box-sizing: border-box;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    margin-bottom: 24px;
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.asg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 18px;
    border-radius: 10px 10px 0 0;
}
.asg-header-title { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em; }
.asg-inc-wrap { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; opacity: 0.9; }
.asg-inc-select {
    padding: 2px 7px; border-radius: 5px;
    border: 1px solid rgba(255,255,255,0.35);
    background: rgba(255,255,255,0.18); color: #fff;
    font-size: 0.78rem; cursor: pointer;
}
.asg-inc-select option { color: #1f2937; background: #fff; }

/* Grid scroll wrapper */
.asg-scroll {
    overflow-x: auto;
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #e5e7eb;
    border-top: none;
    border-radius: 0 0 10px 10px;
}

/* THE GRID */
.asg-grid {
    display: grid;
    position: relative;
    background: #fff;
    min-width: max-content;
}

/* Sticky bunk header row */
.asg-grid-header-row {
    display: contents;
}
.asg-ruler-head {
    position: sticky; top: 0; z-index: 10;
    background: #f9fafb;
    border-right: 1px solid #e5e7eb;
    border-bottom: 2px solid #e5e7eb;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.7rem; font-weight: 600; color: #6b7280;
    padding: 0 6px;
    grid-row: 1; grid-column: 1;
}
.asg-bunk-head {
    position: sticky; top: 0; z-index: 10;
    background: #f9fafb;
    border-right: 1px solid #f0f0f0;
    border-bottom: 2px solid #e5e7eb;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.72rem; font-weight: 700; color: #1f2937;
    text-align: center;
    grid-row: 1;
    padding: 0 4px;
}

/* Time cells in ruler column */
.asg-time-cell {
    grid-column: 1;
    border-right: 1px solid #e5e7eb;
    display: flex; align-items: flex-start;
    padding: 2px 6px 0;
    position: relative;
}
.asg-time-cell::after {
    content: '';
    position: absolute; right: 0; left: 64px;
    top: 0; height: 0;
    border-top: 1px solid #f0f0f0;
    pointer-events: none;
}
.asg-time-cell.major::after { border-top-color: #e5e7eb; }
.asg-time-label {
    font-size: 0.65rem; color: #9ca3af; white-space: nowrap;
    padding-top: 1px;
}
.asg-time-cell.major .asg-time-label { font-size: 0.7rem; color: #4b5563; font-weight: 600; }

/* Bunk activity cells */
.asg-bunk-cell {
    border-right: 1px solid #f0f0f0;
    position: relative;
    overflow: hidden;
}

/* Activity block */
.asg-block {
    position: absolute;
    left: 3px; right: 3px;
    border-radius: 5px;
    overflow: hidden;
    display: flex; flex-direction: column; justify-content: center;
    padding: 3px 6px;
    box-sizing: border-box;
    transition: filter 0.15s, transform 0.1s;
    cursor: default;
}
.asg-block:hover {
    filter: brightness(0.96);
    transform: scaleY(1.01);
    z-index: 3;
}
/* ★★★ v2.1: Editable block styling ★★★ */
.asg-block.asg-editable {
    cursor: pointer;
}
.asg-block.asg-editable:hover {
    filter: brightness(0.92);
    transform: scaleY(1.02);
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    z-index: 4;
}
.asg-block.asg-editable:active {
    transform: scaleY(0.99);
}
.asg-block-name {
    font-size: 0.68rem; font-weight: 700;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    line-height: 1.25;
}
.asg-block-sub {
    font-size: 0.58rem; opacity: 0.72;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Free / gap stripe */
.asg-free {
    position: absolute; left: 3px; right: 3px;
    border-radius: 5px;
    background: repeating-linear-gradient(
        45deg,
        #f9fafb, #f9fafb 4px,
        #f3f4f6 4px, #f3f4f6 8px
    );
    border: 1px dashed #d1d5db;
    display: flex; align-items: center; justify-content: center;
    cursor: default;
}
/* ★★★ v2.1: Editable free gap styling ★★★ */
.asg-free.asg-editable {
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
}
.asg-free.asg-editable:hover {
    background: repeating-linear-gradient(
        45deg,
        #eff6ff, #eff6ff 4px,
        #dbeafe 4px, #dbeafe 8px
    );
    border-color: #93c5fd;
    box-shadow: 0 1px 4px rgba(59,130,246,0.15);
}
.asg-free span { font-size: 0.58rem; color: #9ca3af; font-weight: 500; }
.asg-free.asg-editable span { color: #6b7280; }
.asg-free.asg-editable:hover span { color: #2563eb; }

/* ★★★ v2.1: Edit indicator on blocks ★★★ */
.asg-edit-icon {
    position: absolute;
    top: 2px; right: 4px;
    font-size: 0.55rem;
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
}
.asg-block.asg-editable:hover .asg-edit-icon {
    opacity: 0.6;
}

/* ════════════════════════════════════════
   LEAGUE ROW — the whole point of this rewrite
   ════════════════════════════════════════ */
.asg-league-row {
    position: relative;
    background: #f8fafc;
    border-left: none;
    border-top: 2px solid #e2e8f0;
    border-bottom: 2px solid #e2e8f0;
    overflow: visible;
    display: flex;
    flex-direction: column;
}

/* Diagonal shine effect */
.asg-league-row::before {
    content: '';
    position: absolute;
    top: -40%; left: -20%;
    width: 60%; height: 200%;
    background: linear-gradient(105deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 60%);
    pointer-events: none;
}

.asg-league-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px 6px;
    background: #f1f5f9;
    border-bottom: 1px solid #e2e8f0;
    flex-shrink: 0;
    border-bottom: 1px solid rgba(255,255,255,0.12);
}
.asg-league-badge {
    display: flex; align-items: center; gap: 5px;
    background: #e2e8f0;
    border: 1px solid #cbd5e1;
    border-radius: 999px;
    padding: 2px 10px 2px 7px;
    font-size: 0.68rem; font-weight: 700;
    color: #1e293b; text-transform: uppercase; letter-spacing: 0.07em;
    white-space: nowrap;
}
.asg-league-name {
    font-size: 0.75rem; font-weight: 600; color: #334155;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.asg-league-label {
    margin-left: auto;
    font-size: 0.65rem; color: #64748b;
    white-space: nowrap;
}

.asg-league-matchups {
    flex: 1;
    overflow-y: auto;
    padding: 6px 10px 8px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 5px;
    align-content: start;
}
.asg-league-matchups::-webkit-scrollbar { width: 4px; }
.asg-league-matchups::-webkit-scrollbar-track { background: transparent; }
.asg-league-matchups::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }

.asg-matchup-card {
    display: flex;
    align-items: stretch;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    overflow: hidden;
    min-height: 36px;
}
.asg-matchup-sport-pill {
    display: flex; align-items: center; justify-content: center;
    background: #e2e8f0;
    border-right: 1px solid #cbd5e1;
    padding: 4px 8px;
    font-size: 0.6rem; font-weight: 700;
    color: #1e293b;
    text-transform: uppercase; letter-spacing: 0.06em;
    white-space: nowrap;
    flex-shrink: 0;
}
.asg-matchup-body {
    display: flex; flex-direction: column; justify-content: center;
    padding: 4px 10px;
    flex: 1;
    gap: 1px;
}
.asg-matchup-teams {
    font-size: 0.75rem; font-weight: 700; color: #1e293b;
    line-height: 1.2;
}
.asg-matchup-field {
   font-size: 0.63rem; color: #64748b;
    display: flex; align-items: center; gap: 3px;
}

.asg-league-empty {
    color: rgba(255,255,255,0.45);
    font-size: 0.75rem;
    font-style: italic;
    padding: 10px 14px;
}

.asg-league-time-ruler {
    grid-column: 1;
    background: #1e3a8a;
    border-right: 1px solid rgba(255,255,255,0.15);
    display: flex; align-items: flex-start;
    padding: 8px 6px 0;
}
.asg-league-time-ruler .asg-time-label {
    color: rgba(255,255,255,0.7);
    font-weight: 600;
}
        `;
        document.head.appendChild(s);
    }

    // ─────────────────────────────────────────────
    // MAIN RENDER
    // ─────────────────────────────────────────────
    function renderDivisionGrid(divName, divInfo, bunks, isEditable) {
        injectStyles();

        var wrap = document.createElement('div');
        wrap.className = 'asg-wrap';

        var divConfig = (window.divisions || {})[divName] || divInfo || {};
        var divColor  = divConfig.color || '#147D91';
        var increment = getIncrement();

        function parseTime(v) {
            if (typeof v === 'number') return v;
            return window.SchedulerCoreUtils?.parseTimeToMinutes?.(v) ||
                   window.AutoBuildEngine?.parseTime?.(v) || null;
        }
        var dayStart = parseTime(divConfig.startTime) || 540;
        var dayEnd   = parseTime(divConfig.endTime)   || 960;
        var totalMin = dayEnd - dayStart;
        var totalH   = totalMin * PX_PER_MIN;

        // ── HEADER ──────────────────────────────
        var hdr = document.createElement('div');
        hdr.className = 'asg-header';
        hdr.style.background = divColor;
        hdr.style.color = '#fff';

        var titleEl = document.createElement('span');
        titleEl.className = 'asg-header-title';
        titleEl.textContent = divName;
        hdr.appendChild(titleEl);

        var incWrap = document.createElement('div');
        incWrap.className = 'asg-inc-wrap';
        incWrap.innerHTML = '<span>Grid:</span>';
        var incSel = document.createElement('select');
        incSel.className = 'asg-inc-select';
        [15, 30, 60].forEach(function (v) {
            var o = document.createElement('option');
            o.value = v; o.textContent = v + 'min';
            if (v === increment) o.selected = true;
            incSel.appendChild(o);
        });
        incSel.addEventListener('change', function () {
            setIncrement(parseInt(this.value));
            if (window.UnifiedScheduleSystem?.renderStaggeredView) window.UnifiedScheduleSystem.renderStaggeredView();
            else if (window.updateTable) window.updateTable();
        });
        incWrap.appendChild(incSel);
        hdr.appendChild(incWrap);
        wrap.appendChild(hdr);

        // ── SCROLL WRAPPER ───────────────────────
        var scroll = document.createElement('div');
        scroll.className = 'asg-scroll';
        scroll.style.width = '100%';
        scroll.style.boxSizing = 'border-box';

        // ── OUTER CONTAINER ──────────────────────
        var container = document.createElement('div');
        container.style.cssText = [
            'display:flex',
            'flex-direction:row',
            'position:relative',
            'width:100%',
            'background:#fff'
        ].join(';');

        // ── RULER COLUMN ─────────────────────────
        var ruler = document.createElement('div');
        ruler.style.cssText = [
            'width:64px',
            'flex-shrink:0',
            'position:relative',
            'border-right:1px solid #e5e7eb',
            'background:#f9fafb',
            'z-index:2'
        ].join(';');

        var rulerHead = document.createElement('div');
        rulerHead.style.cssText = [
            'height:36px',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'font-size:0.7rem',
            'font-weight:600',
            'color:#6b7280',
            'border-bottom:2px solid #e5e7eb',
            'position:sticky',
            'top:0',
            'z-index:5',
            'background:#f9fafb'
        ].join(';');
        rulerHead.textContent = 'Time';
        ruler.appendChild(rulerHead);

        var rulerBody = document.createElement('div');
        rulerBody.style.cssText = [
            'position:relative',
            'height:' + totalH + 'px'
        ].join(';');

        // League slots
        var leagueSlots = getLeagueSlotsForDiv(divName, bunks);
        var leagueByStart = {};
        leagueSlots.forEach(function (ls) { leagueByStart[ls.startMin] = ls; });

        // Draw ruler ticks
        for (var tm = dayStart; tm <= dayEnd; tm += increment) {
            var topPx = (tm - dayStart) * PX_PER_MIN;
            var isMajor = tm % 60 === 0;
            var showLabel = isMajor || increment <= 30;

            var inLeague = false;
            for (var ls2 in leagueByStart) {
                var lsData = leagueByStart[parseInt(ls2)];
                if (tm > parseInt(ls2) && tm < lsData.endMin) { inLeague = true; break; }
            }

            var tick = document.createElement('div');
            tick.style.cssText = [
                'position:absolute',
                'top:' + topPx + 'px',
                'left:0',
                'right:0',
                'height:' + (increment * PX_PER_MIN) + 'px',
                'border-top:1px solid ' + (isMajor ? '#e5e7eb' : '#f3f4f6'),
                'display:flex',
                'align-items:flex-start',
                'padding:2px 6px 0',
                inLeague ? 'background:#1e3a8a;' : ''
            ].join(';');

            if (showLabel) {
                var lbl = document.createElement('span');
                lbl.style.cssText = [
                    'font-size:' + (isMajor ? '0.7rem' : '0.63rem'),
                    'color:' + (inLeague ? 'rgba(255,255,255,0.7)' : (isMajor ? '#4b5563' : '#9ca3af')),
                    'font-weight:' + (isMajor ? '600' : '400'),
                    'white-space:nowrap'
                ].join(';');
                lbl.textContent = toLabel(tm);
                tick.appendChild(lbl);
            }
            rulerBody.appendChild(tick);
        }

        ruler.appendChild(rulerBody);
        container.appendChild(ruler);

        // ── BUNK COLUMNS AREA ────────────────────
        var columnsWrap = document.createElement('div');
        columnsWrap.style.cssText = [
            'display:flex',
            'flex-direction:column',
            'flex:1',
            'min-width:0',
            'overflow:hidden'
        ].join(';');

        var headerRow = document.createElement('div');
        headerRow.style.cssText = [
            'display:flex',
            'flex-direction:row',
            'height:36px',
            'flex-shrink:0',
            'position:sticky',
            'top:0',
            'z-index:4',
            'background:#f9fafb',
            'border-bottom:2px solid #e5e7eb'
        ].join(';');

        bunks.forEach(function (bunk) {
            var bh = document.createElement('div');
            bh.style.cssText = [
                'flex:1',
                'min-width:80px',
                'display:flex',
                'align-items:center',
                'justify-content:center',
                'font-size:0.72rem',
                'font-weight:700',
                'color:#1f2937',
                'border-right:1px solid #f0f0f0',
                'text-align:center',
                'padding:0 4px'
            ].join(';');
            bh.textContent = bunk;
            headerRow.appendChild(bh);
        });
        columnsWrap.appendChild(headerRow);

        // Body row
        var bodyRow = document.createElement('div');
        bodyRow.style.cssText = [
            'display:flex',
            'flex-direction:row',
            'position:relative',
            'height:' + totalH + 'px'
        ].join(';');

        // Per-bunk activity lists
        var bunkActivities = {};
        bunks.forEach(function (b) { bunkActivities[b] = getBunkActivities(b, divName); });

        // Draw each bunk column
        bunks.forEach(function (bunk, ci) {
            var col = document.createElement('div');
            col.style.cssText = [
                'flex:1',
                'min-width:80px',
                'position:relative',
                'border-right:1px solid #f0f0f0',
                'height:' + totalH + 'px'
            ].join(';');

            // Background tick lines
            for (var tm2 = dayStart; tm2 <= dayEnd; tm2 += increment) {
                var lineTop = (tm2 - dayStart) * PX_PER_MIN;
                var line = document.createElement('div');
                line.style.cssText = [
                    'position:absolute',
                    'top:' + lineTop + 'px',
                    'left:0',
                    'right:0',
                    'height:0',
                    'border-top:1px solid ' + (tm2 % 60 === 0 ? '#e5e7eb' : '#f3f4f6'),
                    'pointer-events:none'
                ].join(';');
                col.appendChild(line);
            }

            // Activity blocks
            var acts = bunkActivities[bunk];
            acts.forEach(function (act) {
                if (act.isLeague) return;

                var blockTop = (act.startMin - dayStart) * PX_PER_MIN;
                var blockH   = act.duration * PX_PER_MIN;
                if (blockH < 2) return;

                var style = blockStyle(act.entry);
                var name  = act.entry?._activity || act.entry?.field || '';
                var fieldName = act.entry?.field || '';
                var sub   = (fieldName && fieldName !== name && fieldName !== 'Free') ? fieldName : '';

                var blk = document.createElement('div');
                blk.className = 'asg-block' + (isEditable ? ' asg-editable' : '');
                blk.style.cssText = [
                    'position:absolute',
                    'top:' + (blockTop + 2) + 'px',
                    'left:3px',
                    'right:3px',
                    'height:' + (blockH - 4) + 'px',
                    'background:' + style.bg,
                    'border:1px solid ' + style.border,
                    'color:' + style.text,
                    'border-radius:5px',
                    'overflow:hidden',
                    'display:flex',
                    'flex-direction:column',
                    'justify-content:center',
                    'padding:3px 6px',
                    'box-sizing:border-box',
                    'z-index:1'
                ].join(';');

                if (blockH >= 40) {
                    var nameEl = document.createElement('div');
                    nameEl.className = 'asg-block-name';
                    nameEl.style.color = style.text;
                    nameEl.textContent = name;
                    blk.appendChild(nameEl);
                    if (sub && sub !== name) {
                        var subEl = document.createElement('div');
                        subEl.className = 'asg-block-sub';
                        subEl.style.color = style.text;
                        subEl.textContent = sub;
                        blk.appendChild(subEl);
                    }
                    if (blockH >= 55) {
                        var durEl = document.createElement('div');
                        durEl.className = 'asg-block-sub';
                        durEl.style.color = style.text;
                        durEl.textContent = act.duration + 'min';
                        blk.appendChild(durEl);
                    }
                } else if (blockH >= 22) {
                    var nameEl2 = document.createElement('div');
                    nameEl2.className = 'asg-block-name';
                    nameEl2.style.color = style.text;
                    nameEl2.style.fontSize = '0.63rem';
                    nameEl2.textContent = name;
                    blk.appendChild(nameEl2);
                } else {
                    blk.title = name;
                }

                blk.title = name + '\n' + toLabel(act.startMin) + ' – ' + toLabel(act.endMin) + ' (' + act.duration + 'min)';

                // ★★★ v2.1: EDIT INDICATOR ★★★
                if (isEditable) {
                    var editIcon = document.createElement('span');
                    editIcon.className = 'asg-edit-icon';
                    editIcon.textContent = '✏️';
                    blk.appendChild(editIcon);
                }

                // ★★★ v2.1: CLICK HANDLER FOR POST-EDIT ★★★
                if (isEditable) {
                    (function (bunkName, dName, sMin, eMin, entryRef) {
                        blk.addEventListener('click', function (e) {
                            e.stopPropagation();
                            openEditForBlock(bunkName, dName, sMin, eMin, entryRef);
                        });
                    })(bunk, divName, act.startMin, act.endMin, act.entry);
                }

                col.appendChild(blk);
            });

            // ★★★ v2.1: FREE GAP INDICATORS (clickable) ★★★
            if (isEditable) {
                var gaps = computeFreeGaps(bunk, divName, dayStart, dayEnd);
                gaps.forEach(function (gap) {
                    var gapTop = (gap.startMin - dayStart) * PX_PER_MIN;
                    var gapH = (gap.endMin - gap.startMin) * PX_PER_MIN;
                    if (gapH < 15) return; // too small to click

                    var gapEl = document.createElement('div');
                    gapEl.className = 'asg-free asg-editable';
                    gapEl.style.cssText = [
                        'top:' + (gapTop + 2) + 'px',
                        'height:' + (gapH - 4) + 'px'
                    ].join(';');

                    if (gapH >= 30) {
                        var gapLabel = document.createElement('span');
                        gapLabel.textContent = '+ Add';
                        gapEl.appendChild(gapLabel);
                    }

                    gapEl.title = 'Add activity\n' + toLabel(gap.startMin) + ' – ' + toLabel(gap.endMin);

                    (function (bunkName, dName, sMin, eMin) {
                        gapEl.addEventListener('click', function (e) {
                            e.stopPropagation();
                            openEditForGap(bunkName, dName, sMin, eMin);
                        });
                    })(bunk, divName, gap.startMin, gap.endMin);

                    col.appendChild(gapEl);
                });
            }

            bodyRow.appendChild(col);
        });

        // ── LEAGUE OVERLAYS ───────────────────────
        leagueSlots.forEach(function (ls) {
            var leagueTop = (ls.startMin - dayStart) * PX_PER_MIN;
            var leagueH   = (ls.endMin - ls.startMin) * PX_PER_MIN;

            var overlay = document.createElement('div');
            overlay.className = 'asg-league-row';
            overlay.style.cssText = [
                'position:absolute',
                'top:' + leagueTop + 'px',
                'left:0',
                'right:0',
                'min-height:' + leagueH + 'px',
                'z-index:3',
                'border-radius:0'
            ].join(';');

            var lHdr = document.createElement('div');
            lHdr.className = 'asg-league-header';

            var badge = document.createElement('div');
            badge.className = 'asg-league-badge';
            badge.innerHTML = '🏆 League Game';
            lHdr.appendChild(badge);

            if (ls.leagueName) {
                var lName = document.createElement('span');
                lName.className = 'asg-league-name';
                lName.textContent = ls.leagueName;
                lHdr.appendChild(lName);
            }

            var timeRange = document.createElement('span');
            timeRange.style.cssText = 'margin-left:auto; font-size:0.65rem; color:#64748b; white-space:nowrap; flex-shrink:0;';
            timeRange.textContent = toLabel(ls.startMin) + ' – ' + toLabel(ls.endMin);
            lHdr.appendChild(timeRange);

            if (ls.gameLabel) {
                var lLabel = document.createElement('span');
                lLabel.className = 'asg-league-label';
                lLabel.textContent = ls.gameLabel;
                lHdr.appendChild(lLabel);
            }

            overlay.appendChild(lHdr);

            var muGrid = document.createElement('div');
            muGrid.className = 'asg-league-matchups';

            if (!ls.matchups || ls.matchups.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'asg-league-empty';
                empty.textContent = 'Matchups not yet assigned';
                muGrid.appendChild(empty);
            } else {
                ls.matchups.forEach(function (raw) {
                    var mu = parseMatchup(raw, ls.sport);
                    var card = document.createElement('div');
                    card.className = 'asg-matchup-card';

                    if (mu.sport) {
                        var pill = document.createElement('div');
                        pill.className = 'asg-matchup-sport-pill';
                        pill.textContent = mu.sport;
                        card.appendChild(pill);
                    }

                    var body = document.createElement('div');
                    body.className = 'asg-matchup-body';

                    var teams = document.createElement('div');
                    teams.className = 'asg-matchup-teams';
                    var parts = mu.teams.split(/\s+vs\.?\s+/i);
                    if (parts.length === 2) {
                        teams.innerHTML = esc(parts[0]) +
                            '<span style="font-weight:400; opacity:0.6; margin:0 4px;">vs</span>' +
                            esc(parts[1]);
                    } else {
                        teams.textContent = mu.teams;
                    }
                    body.appendChild(teams);

                    if (mu.field) {
                        var field = document.createElement('div');
                        field.className = 'asg-matchup-field';
                        field.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="opacity:0.6"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>' + esc(mu.field);
                        body.appendChild(field);
                    }

                    card.appendChild(body);
                    muGrid.appendChild(card);
                });
            }

            overlay.appendChild(muGrid);
            bodyRow.appendChild(overlay);
        });

        columnsWrap.appendChild(bodyRow);
        container.appendChild(columnsWrap);
        scroll.appendChild(container);
        wrap.appendChild(scroll);
        return wrap;
    }

    // ─────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────
    window.AutoScheduleGrid = {
        render:          renderDivisionGrid,
        getIncrement:    getIncrement,
        setIncrement:    setIncrement,
        PIXELS_PER_MINUTE: PX_PER_MIN,
        VERSION:         '2.1.0'
    };

    console.log('[AutoScheduleGrid] v2.1.0 loaded — CSS Grid + Post-Edit Integration');

})();
