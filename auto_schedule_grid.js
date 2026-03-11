// =================================================================
// auto_schedule_grid.js — Auto Mode Schedule Grid Renderer v2.0
// =================================================================
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
    // INJECT STYLES (once)
    // ─────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('asg-v2-styles')) return;
        var s = document.createElement('style');
        s.id = 'asg-v2-styles';
        s.textContent = `
/* ── Auto Schedule Grid v2 ── */
.asg-wrap {
    border-radius: 10px;
    overflow: hidden;
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
    border: 1px solid #e5e7eb;
    border-top: none;
    border-radius: 0 0 10px 10px;
}

/* THE GRID */
.asg-grid {
    display: grid;
    /* columns set inline: 64px (ruler) + N bunk cols */
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
}
.asg-free span { font-size: 0.58rem; color: #9ca3af; font-weight: 500; }

/* ════════════════════════════════════════
   LEAGUE ROW — the whole point of this rewrite
   ════════════════════════════════════════ */
.asg-league-row {
    /* spans all bunk columns; column range set inline */
    position: relative;
    background: linear-gradient(160deg, #1e3a8a 0%, #1d4ed8 45%, #2563eb 100%);
    border-left: none;
    overflow: hidden;
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
    background: rgba(0,0,0,0.18);
    flex-shrink: 0;
    border-bottom: 1px solid rgba(255,255,255,0.12);
}
.asg-league-badge {
    display: flex; align-items: center; gap: 5px;
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.25);
    border-radius: 999px;
    padding: 2px 10px 2px 7px;
    font-size: 0.68rem; font-weight: 700;
    color: #fff; text-transform: uppercase; letter-spacing: 0.07em;
    white-space: nowrap;
}
.asg-league-name {
    font-size: 0.75rem; font-weight: 600; color: rgba(255,255,255,0.85);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.asg-league-label {
    margin-left: auto;
    font-size: 0.65rem; color: rgba(255,255,255,0.5);
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
/* Custom scrollbar */
.asg-league-matchups::-webkit-scrollbar { width: 4px; }
.asg-league-matchups::-webkit-scrollbar-track { background: transparent; }
.asg-league-matchups::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }

.asg-matchup-card {
    display: flex;
    align-items: stretch;
    background: rgba(255,255,255,0.10);
    border: 1px solid rgba(255,255,255,0.16);
    border-radius: 6px;
    overflow: hidden;
    min-height: 36px;
}
.asg-matchup-sport-pill {
    display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.15);
    border-right: 1px solid rgba(255,255,255,0.12);
    padding: 4px 8px;
    font-size: 0.6rem; font-weight: 700;
    color: rgba(255,255,255,0.9);
    text-transform: uppercase; letter-spacing: 0.06em;
    writing-mode: horizontal-tb;
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
    font-size: 0.75rem; font-weight: 700; color: #fff;
    line-height: 1.2;
}
.asg-matchup-field {
    font-size: 0.63rem; color: rgba(255,255,255,0.6);
    display: flex; align-items: center; gap: 3px;
}

.asg-league-empty {
    color: rgba(255,255,255,0.45);
    font-size: 0.75rem;
    font-style: italic;
    padding: 10px 14px;
}

/* Ruler cell beside league row */
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

        // Division config
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

        // ── CSS GRID ─────────────────────────────
        // Columns: 64px ruler + bunkColWidth per bunk
        var bunkColW = Math.max(88, Math.min(150, Math.floor(780 / Math.max(bunks.length, 1))));
        var gridCols = '64px ' + bunks.map(function () { return bunkColW + 'px'; }).join(' ');

        // Build time ticks
        var ticks = [];
        for (var tm = dayStart; tm <= dayEnd; tm += increment) ticks.push(tm);

        // League slots for this division
        var leagueSlots = getLeagueSlotsForDiv(divName, bunks);
        // Map startMin → league data for quick lookup
        var leagueByStart = {};
        leagueSlots.forEach(function (ls) { leagueByStart[ls.startMin] = ls; });

        // Per-bunk activity lists (pre-computed)
        var bunkActivities = {};
        bunks.forEach(function (b) { bunkActivities[b] = getBunkActivities(b, divName); });

        // ─────────────────────────────────────────
        // Build grid rows
        // We iterate tick by tick; for each tick we either:
        //   (a) render a normal row (ruler cell + N bunk cells), or
        //   (b) start a league row that spans the league duration
        // ─────────────────────────────────────────

        var grid = document.createElement('div');
        grid.className = 'asg-grid';
        grid.style.gridTemplateColumns = gridCols;

        // Row 1: header
        var HEADER_H = 36;
        grid.style.gridTemplateRows = HEADER_H + 'px'; // will be extended by content

        // Ruler header
        var rulerHead = document.createElement('div');
        rulerHead.className = 'asg-ruler-head';
        rulerHead.style.height = HEADER_H + 'px';
        rulerHead.textContent = 'Time';
        grid.appendChild(rulerHead);

        // Bunk headers
        bunks.forEach(function (bunk, ci) {
            var bh = document.createElement('div');
            bh.className = 'asg-bunk-head';
            bh.style.gridColumn = String(ci + 2);
            bh.style.height = HEADER_H + 'px';
            bh.textContent = bunk;
            grid.appendChild(bh);
        });

        // Track which minutes are covered by a league block (so we skip their ticks)
        var leagueCoveredUntil = {}; // bunk → minute covered until

        // We need to track absolute row index for CSS grid placement.
        // Row 1 = header. Subsequent rows = time ticks.
        // However, because league rows have variable height (px, not grid rows),
        // we render them as a single tall grid cell spanning 1 grid-row but with
        // explicit height set in px. Same for all cells — each tick row is increment*PX_PER_MIN tall.

        var tickRowH = increment * PX_PER_MIN; // px per grid row after header

        var skipUntil = {}; // startMin → endMin (league coverage per tick range)

        ticks.forEach(function (tickMin, rowIdx) {
            var gridRow = rowIdx + 2; // +2 because row 1 is header
            var cellH   = tickRowH;

            // ── Check if this tick starts a league block ──────────
            var ls = leagueByStart[tickMin];
            if (ls) {
                var leagueH = (ls.endMin - ls.startMin) * PX_PER_MIN;

                // Ruler cell (styled for league)
                var lRuler = document.createElement('div');
                lRuler.className = 'asg-league-time-ruler';
                lRuler.style.cssText += 'grid-row:' + gridRow + '; height:' + leagueH + 'px;';
                var lRulerLabel = document.createElement('span');
                lRulerLabel.className = 'asg-time-label';
                lRulerLabel.textContent = toLabel(tickMin);
                lRuler.appendChild(lRulerLabel);
                grid.appendChild(lRuler);

                // League content cell — spans all bunk columns
                var lRow = document.createElement('div');
                lRow.className = 'asg-league-row';
                lRow.style.cssText =
                    'grid-row:' + gridRow + ';' +
                    'grid-column: 2 / ' + (bunks.length + 2) + ';' +
                    'height:' + leagueH + 'px;';

                // Header bar
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
                timeRange.style.cssText = 'margin-left:auto; font-size:0.65rem; color:rgba(255,255,255,0.55); white-space:nowrap; flex-shrink:0;';
                timeRange.textContent = toLabel(ls.startMin) + ' – ' + toLabel(ls.endMin);
                lHdr.appendChild(timeRange);

                if (ls.gameLabel) {
                    var lLabel = document.createElement('span');
                    lLabel.className = 'asg-league-label';
                    lLabel.textContent = ls.gameLabel;
                    lHdr.appendChild(lLabel);
                }

                lRow.appendChild(lHdr);

                // Matchups grid
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
                        // Bold the "vs" separator
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
                            field.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="opacity:0.6"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>' +
                                esc(mu.field);
                            body.appendChild(field);
                        }

                        card.appendChild(body);
                        muGrid.appendChild(card);
                    });
                }

                lRow.appendChild(muGrid);
                grid.appendChild(lRow);

                // Mark ticks covered by this league block so bunk cells are skipped
                skipUntil[tickMin] = ls.endMin;
                return; // done with this tick
            }

            // ── Check if this tick is inside a league block ───────
            // (i.e. a tick that falls within a league we already rendered)
            var insideLeague = false;
            for (var lStart in skipUntil) {
                if (tickMin > parseInt(lStart) && tickMin < skipUntil[lStart]) {
                    insideLeague = true;
                    break;
                }
            }
            if (insideLeague) return; // skip — covered by the league row above

            // ── Normal tick row ───────────────────────────────────
            var isMajor = tickMin % 60 === 0;

            // Ruler cell
            var rCell = document.createElement('div');
            rCell.className = 'asg-time-cell' + (isMajor ? ' major' : '');
            rCell.style.cssText = 'grid-row:' + gridRow + '; height:' + cellH + 'px;';
            var rLabel = document.createElement('span');
            rLabel.className = 'asg-time-label';
            rLabel.textContent = isMajor ? toLabel(tickMin) : (tickMin % 30 === 0 ? toLabel(tickMin) : '');
            rCell.appendChild(rLabel);
            grid.appendChild(rCell);

            // Bunk cells
            bunks.forEach(function (bunk, ci) {
                var cell = document.createElement('div');
                cell.className = 'asg-bunk-cell';
                cell.style.cssText = 'grid-row:' + gridRow + '; grid-column:' + (ci + 2) + '; height:' + cellH + 'px;';

                // Find activities that overlap this tick window
                var tickEnd = tickMin + increment;
                var acts = bunkActivities[bunk].filter(function (a) {
                    return !a.isLeague && a.startMin < tickEnd && a.endMin > tickMin;
                });

                acts.forEach(function (act) {
                    // Clip to this tick cell's bounds
                    var clipStart = Math.max(act.startMin, tickMin);
                    var clipEnd   = Math.min(act.endMin, tickEnd);
                    var clipTop   = (clipStart - tickMin) * PX_PER_MIN;
                    var clipH     = (clipEnd - clipStart) * PX_PER_MIN;
                    if (clipH < 2) return;

                    // Only render the block's LABEL in the first tick it appears in
                    var isFirst = act.startMin >= tickMin && act.startMin < tickEnd;
                    // For continuation: draw a connector strip without label
                    var style = blockStyle(act.entry);

                    var blk = document.createElement('div');
                    blk.className = 'asg-block';
                    blk.style.cssText +=
                        'top:' + clipTop + 'px;' +
                        'height:' + (clipH - 2) + 'px;' +
                        'background:' + style.bg + ';' +
                        'border:1px solid ' + style.border + ';' +
                        'color:' + style.text + ';';

                    if (isFirst) {
                        var totalH = act.duration * PX_PER_MIN;
                        var name = act.entry?._activity || act.entry?.field || '';
                        var sub  = act.entry?.sport || '';

                        if (totalH >= 40) {
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
                            if (totalH >= 55) {
                                var durEl = document.createElement('div');
                                durEl.className = 'asg-block-sub';
                                durEl.style.color = style.text;
                                durEl.textContent = act.duration + 'min';
                                blk.appendChild(durEl);
                            }
                        } else if (totalH >= 22) {
                            var nameEl2 = document.createElement('div');
                            nameEl2.className = 'asg-block-name';
                            nameEl2.style.color = style.text;
                            nameEl2.textContent = name;
                            blk.appendChild(nameEl2);
                        } else {
                            blk.title = name + ' (' + act.duration + 'min)';
                        }
                    }

                    blk.title = (act.entry?._activity || act.entry?.field || '') +
                        '\n' + toLabel(act.startMin) + ' – ' + toLabel(act.endMin) +
                        ' (' + act.duration + 'min)';

                    cell.appendChild(blk);
                });

                // Free stripe if no activities in this tick
                if (acts.length === 0) {
                    var free = document.createElement('div');
                    free.className = 'asg-free';
                    free.style.cssText += 'top:1px; height:' + (cellH - 2) + 'px;';
                    if (cellH >= 20) {
                        var fLabel = document.createElement('span');
                        fLabel.textContent = 'Free';
                        free.appendChild(fLabel);
                    }
                    cell.appendChild(free);
                }

                grid.appendChild(cell);
            });
        });

        scroll.appendChild(grid);
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
        VERSION:         '2.0.0'
    };

    console.log('[AutoScheduleGrid] v2.0.0 loaded — CSS Grid architecture');

})();
