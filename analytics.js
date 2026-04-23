// ============================================================================
// analytics.js v3.2
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // TIME HELPERS
    // ========================================================================

    function parseTimeToMinutes(timeStr) {
        if (window.SchedulerCoreUtils?.parseTimeToMinutes) return window.SchedulerCoreUtils.parseTimeToMinutes(timeStr);
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

    function minutesToTimeLabel(mins) {
        if (window.SchedulerCoreUtils?.minutesToTimeLabel) return window.SchedulerCoreUtils.minutesToTimeLabel(mins);
        let h = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m < 10 ? '0' + m : m} ${ap}`;
    }

    function minutesToShortLabel(mins) {
        let h = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        return `${h}${m > 0 ? ':' + (m < 10 ? '0' + m : m) : ''}${ap}`;
    }

    function getCampTimes() {
        const gs = window.loadGlobalSettings?.() || {};
        const app1 = gs.app1 || window.app1 || {};
        let earliestStart = Infinity, latestEnd = 0;
        const divisionTimes = window.divisionTimes || {};
        Object.values(divisionTimes).forEach(slots => {
            if (!Array.isArray(slots)) return;
            slots.forEach(slot => {
                let sMin, eMin;
                if (slot.startMin !== undefined) { sMin = slot.startMin; eMin = slot.endMin; }
                else if (slot.start) {
                    const sd = new Date(slot.start), ed = new Date(slot.end);
                    sMin = sd.getHours() * 60 + sd.getMinutes();
                    eMin = ed.getHours() * 60 + ed.getMinutes();
                }
                if (sMin !== undefined && sMin < earliestStart) earliestStart = sMin;
                if (eMin !== undefined && eMin > latestEnd) latestEnd = eMin;
            });
        });
        if (earliestStart === Infinity) earliestStart = parseTimeToMinutes(app1.startTime || '9:00am') || 540;
        if (latestEnd === 0) latestEnd = parseTimeToMinutes(app1.endTime || '4:00pm') || 960;
        return { startMin: earliestStart, endMin: latestEnd };
    }

    // ========================================================================
    // STATE
    // ========================================================================

    let container = null;
    let allActivities = [];
    let availableDivisions = [];
    let divisionsDat = {};
    let allFieldsDat = [];
    let selectedDate = null;
    let currentView = 'field';
    let activityFilter = '';
    let _activityFilterTimer = null;

    // Professional, non-pastel division palette — avoids green (reserved for FREE)
    const DIV_COLORS = [
        { bg: '#eff6ff', border: '#2563eb', text: '#1e3a8a' },
        { bg: '#fff7ed', border: '#c2410c', text: '#7c2d12' },
        { bg: '#fdf4ff', border: '#7c3aed', text: '#4c1d95' },
        { bg: '#fff1f2', border: '#be123c', text: '#881337' },
        { bg: '#fefce8', border: '#a16207', text: '#713f12' },
        { bg: '#f0fdfa', border: '#0f766e', text: '#134e4a' },
        { bg: '#f8fafc', border: '#334155', text: '#0f172a' },
        { bg: '#fff0f6', border: '#be185d', text: '#831843' },
    ];

    const COLOR_AVAIL = '#86efac';  // muted green — available
    const COLOR_TAKEN = '#fca5a5';  // muted red   — taken
    const NOW_COLOR   = '#2563eb';  // blue  — current time line

    // ========================================================================
    // MASTER DATA
    // ========================================================================

    function loadMasterData() {
        try {
            const g = window.loadGlobalSettings?.() || {};
            divisionsDat = window.divisions || {};
            availableDivisions = (window.availableDivisions || Object.keys(divisionsDat)).sort();
            allFieldsDat = g.app1?.fields || [];
            const specials = g.app1?.specialActivities || [];
            allActivities = [
                ...allFieldsDat.flatMap(f => (f.activities || []).map(a => ({ name: a, type: 'sport', max: 0 }))),
                ...specials.map(s => ({ name: s.name, type: 'special', max: s.maxUsage || 0 }))
            ];
            const seen = new Set();
            allActivities = allActivities.filter(a => { if (seen.has(a.name)) return false; seen.add(a.name); return true; });
        } catch (e) {
            console.error('[Analytics] loadMasterData error:', e);
            allActivities = [];
        }
    }

    function getDivisionColor(divName) {
        const names = Object.keys(divisionsDat).sort();
        const idx = names.indexOf(divName);
        return DIV_COLORS[Math.max(0, idx) % DIV_COLORS.length];
    }

    function isSpecialByName(name) {
        return allActivities.some(a => a.name === name && a.type === 'special');
    }

    function getDivisionForBunk(bunkName) {
        if (window.SchedulerCoreUtils?.getDivisionForBunk) return window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
        for (const [divName, divData] of Object.entries(divisionsDat)) {
            if (divData.bunks?.includes(bunkName)) return divName;
        }
        return null;
    }

    // ========================================================================
    // DATA BUILDER
    // ========================================================================

    function buildUsageData(dateKey) {
        const allDaily = window.loadAllDailyData?.() || {};
        let assignments;
        if (dateKey && allDaily[dateKey]) {
            assignments = allDaily[dateKey].scheduleAssignments || {};
        } else {
            assignments = window.scheduleAssignments || window.loadCurrentDailyData?.()?.scheduleAssignments || {};
        }

        const dTimes = window.divisionTimes || {};
        const items = [];

        Object.entries(assignments).forEach(([bunk, schedule]) => {
            if (!Array.isArray(schedule)) return;
            const divName = getDivisionForBunk(bunk) || 'Unknown';
            const times = dTimes[divName] || [];

            schedule.forEach((entry, idx) => {
                if (!entry || entry.continuation || entry._isTransition) return;

                let startMin = entry._startMin;
                let endMin = entry._endMin;

                if (startMin === undefined || endMin === undefined) {
                    const slotInfo = times[idx];
                    if (slotInfo) {
                        if (slotInfo.startMin !== undefined) { startMin = slotInfo.startMin; endMin = slotInfo.endMin; }
                        else if (slotInfo.start) {
                            const sd = new Date(slotInfo.start), ed = new Date(slotInfo.end);
                            startMin = sd.getHours() * 60 + sd.getMinutes();
                            endMin = ed.getHours() * 60 + ed.getMinutes();
                        }
                    }
                }
                if (startMin === undefined || endMin === undefined) return;

                for (let i = idx + 1; i < schedule.length; i++) {
                    const next = schedule[i];
                    if (!next?.continuation) break;
                    if (next._endMin !== undefined) { endMin = next._endMin; }
                    else { const ns = times[i]; if (ns?.endMin !== undefined) endMin = ns.endMin; }
                }

                const activity = entry._activity || entry.activity || entry.sport || '';
                if (!activity || activity === 'Free' || activity.toLowerCase().includes('transition')) return;

                const fRaw = entry.field;
                let fName = typeof fRaw === 'object' ? (fRaw?.name || '') : (fRaw || '');
                if (fName.includes(' – ')) fName = fName.split(' – ')[0].trim();
                else if (fName.includes(' - ')) fName = fName.split(' - ')[0].trim();
                const hasField = fName && fName !== 'Free' && fName !== 'No Field';

                items.push({ bunk, division: divName, field: hasField ? fName : null, activity, startMin, endMin, isSpecial: isSpecialByName(activity) });
            });
        });

        return items;
    }

    // ========================================================================
    // REPORT TAB INITIALIZER
    // ========================================================================

    function initReportTab() {
        container = document.getElementById('report-content');
        if (!container) return;

        loadMasterData();
        selectedDate = window.currentScheduleDate || new Date().toLocaleDateString('en-CA');
        currentView = 'field';
        activityFilter = '';

        container.innerHTML = `
            <div class="league-nav" style="background:#e3f2fd;border-color:#90caf9;padding:10px;margin-bottom:15px;border-radius:8px;">
                <label for="report-view-select" style="color:#1565c0;font-weight:bold;">Select Report:</label>
                <select id="report-view-select" style="font-size:1em;padding:5px;">
                    <option value="availability">Field Availability</option>
                    <option value="rotation">Bunk Rotation & Usage</option>
                </select>
            </div>
            <div id="report-availability-content" class="league-content-pane active"></div>
            <div id="report-rotation-content" class="league-content-pane" style="display:none;"></div>
        `;

        renderAvailabilityShell();
        renderBunkRotationUI();

        const sel = document.getElementById('report-view-select');
        if (sel) {
            sel.onchange = (e) => {
                const val = e.target.value;
                document.querySelectorAll('.league-content-pane').forEach(el => el.style.display = 'none');
                document.getElementById(`report-${val}-content`).style.display = 'block';
                if (val === 'availability') renderGantt();
                else if (val === 'rotation') renderBunkRotationUI();
            };
        }
    }

    // ========================================================================
    // AVAILABILITY SHELL
    // ========================================================================

    function renderAvailabilityShell() {
        const wrapper = document.getElementById('report-availability-content');
        if (!wrapper) return;

        const allDaily = window.loadAllDailyData?.() || {};
        const dates = Object.keys(allDaily).sort().reverse();
        const dateOptions = dates.length
            ? dates.map(d => `<option value="${d}" ${d === selectedDate ? 'selected' : ''}>${formatDateDisplay(d)}</option>`).join('')
            : `<option value="${selectedDate}">${formatDateDisplay(selectedDate)}</option>`;

        const divOptions = availableDivisions.map(d => `<option value="${d}">${d}</option>`).join('');

        wrapper.innerHTML = `
            <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;">

                <div style="display:flex;align-items:center;gap:7px;">
                    <label style="font-size:0.72rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;">Date</label>
                    <select id="gantt-date-select" style="padding:5px 10px;border-radius:4px;border:1px solid #cbd5e1;font-size:0.83rem;color:#1e293b;background:#fff;">
                        ${dateOptions}
                    </select>
                </div>

                <div style="display:flex;border:1px solid #cbd5e1;border-radius:4px;overflow:hidden;flex-shrink:0;">
                    <button id="gantt-btn-field" style="padding:5px 14px;border:none;border-right:1px solid #cbd5e1;font-size:0.8rem;font-weight:600;cursor:pointer;background:#1e40af;color:#fff;">By Field</button>
                    <button id="gantt-btn-bunk" style="padding:5px 14px;border:none;font-size:0.8rem;font-weight:600;cursor:pointer;background:#fff;color:#475569;">By Bunk</button>
                </div>

                <div id="gantt-div-filter-wrap" style="display:none;align-items:center;gap:7px;">
                    <label style="font-size:0.72rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;">Division</label>
                    <select id="gantt-div-select" style="padding:5px 10px;border-radius:4px;border:1px solid #cbd5e1;font-size:0.83rem;color:#1e293b;background:#fff;">
                        <option value="">All Divisions</option>
                        ${divOptions}
                    </select>
                </div>

                <div style="display:flex;align-items:center;gap:7px;flex:1;min-width:150px;">
                    <label style="font-size:0.72rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;">Activity</label>
                    <div style="position:relative;flex:1;">
                        <input id="gantt-activity-filter" type="text" placeholder="Filter by activity…"
                            style="width:100%;padding:5px 28px 5px 10px;border-radius:4px;border:1px solid #cbd5e1;font-size:0.83rem;color:#1e293b;background:#fff;box-sizing:border-box;" />
                        <button id="gantt-activity-clear" title="Clear" style="display:none;position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:0.78rem;color:#94a3b8;padding:0;line-height:1;">✕</button>
                    </div>
                </div>

            </div>

            <div id="gantt-chart-area"></div>
        `;

        document.getElementById('gantt-date-select').onchange = e => { selectedDate = e.target.value; renderGantt(); };
        document.getElementById('gantt-btn-field').onclick = () => setView('field');
        document.getElementById('gantt-btn-bunk').onclick = () => setView('bunk');
        const divSel = document.getElementById('gantt-div-select');
        if (divSel) divSel.onchange = () => renderGantt();

        const actInput = document.getElementById('gantt-activity-filter');
        const actClear = document.getElementById('gantt-activity-clear');
        actInput.oninput = () => {
            activityFilter = actInput.value.trim().toLowerCase();
            actClear.style.display = activityFilter ? 'block' : 'none';
            clearTimeout(_activityFilterTimer);
            _activityFilterTimer = setTimeout(() => renderGantt(), 250);
        };
        actClear.onclick = () => {
            actInput.value = '';
            activityFilter = '';
            actClear.style.display = 'none';
            renderGantt();
        };

        renderGantt();
    }

    function setView(v) {
        currentView = v;
        const btnField = document.getElementById('gantt-btn-field');
        const btnBunk  = document.getElementById('gantt-btn-bunk');
        if (btnField) {
            btnField.style.background = v === 'field' ? '#1e40af' : '#fff';
            btnField.style.color      = v === 'field' ? '#fff'     : '#475569';
        }
        if (btnBunk) {
            btnBunk.style.background = v === 'bunk' ? '#1e40af' : '#fff';
            btnBunk.style.color      = v === 'bunk' ? '#fff'    : '#475569';
        }
        const divWrap = document.getElementById('gantt-div-filter-wrap');
        if (divWrap) divWrap.style.display = v === 'bunk' ? 'flex' : 'none';
        renderGantt();
    }

    // ========================================================================
    // GANTT DISPATCH
    // ========================================================================

    function renderGantt() {
        const area = document.getElementById('gantt-chart-area');
        if (!area) return;

        const items = buildUsageData(selectedDate);
        const { startMin, endMin } = getCampTimes();

        if (!items.length) {
            area.innerHTML = `
                <div style="padding:48px 32px;text-align:center;color:#94a3b8;background:#f8fafc;border:1px dashed #e2e8f0;border-radius:6px;">
                    <div style="font-size:0.95rem;font-weight:600;color:#64748b;margin-bottom:4px;">No schedule data for ${formatDateDisplay(selectedDate)}</div>
                    <div style="font-size:0.8rem;">Build or load a schedule first.</div>
                </div>`;
            return;
        }

        const today = new Date().toLocaleDateString('en-CA');
        const showNow = selectedDate === today;

        if (currentView === 'field') {
            renderFieldGantt(area, items, startMin, endMin, showNow);
        } else {
            const divFilter = document.getElementById('gantt-div-select')?.value || '';
            renderBunkGantt(area, items, startMin, endMin, divFilter, showNow);
        }
    }

    // ========================================================================
    // SHARED GANTT PRIMITIVES
    // ========================================================================

    // Time axis: bold labels at :00, lighter at :30
    function buildTimeAxis(campStart, campEnd, totalMin) {
        let labels = '', ticks = '';
        const first30 = Math.ceil(campStart / 30) * 30;
        for (let m = first30; m <= campEnd; m += 30) {
            const l = ((m - campStart) / totalMin * 100).toFixed(3);
            const mod = m % 60;
            if (mod === 0) {
                labels += `<span style="position:absolute;left:${l}%;transform:translateX(-50%);font-size:0.72rem;font-weight:700;color:#1e293b;white-space:nowrap;">${minutesToShortLabel(m)}</span>`;
                ticks  += `<div style="position:absolute;bottom:0;left:${l}%;width:1px;height:10px;background:#94a3b8;"></div>`;
            } else {
                labels += `<span style="position:absolute;left:${l}%;transform:translateX(-50%);font-size:0.64rem;font-weight:500;color:#64748b;white-space:nowrap;">${minutesToShortLabel(m)}</span>`;
                ticks  += `<div style="position:absolute;bottom:0;left:${l}%;width:1px;height:7px;background:#cbd5e1;"></div>`;
            }
        }
        return `
            <div style="position:relative;height:18px;margin-bottom:2px;">${labels}</div>
            <div style="position:relative;height:10px;margin-bottom:2px;">${ticks}</div>`;
    }

    // Vertical grid lines at hour + half-hour only
    function buildGridLines(campStart, campEnd, totalMin) {
        let lines = '';
        const first30 = Math.ceil(campStart / 30) * 30;
        for (let m = first30; m <= campEnd; m += 30) {
            const l = ((m - campStart) / totalMin * 100).toFixed(3);
            const mod = m % 60;
            const color = mod === 0 ? '#c8d0dc' : '#dde2ea';
            const width  = mod === 0 ? '1.5px' : '1px';
            lines += `<div style="position:absolute;top:0;bottom:0;left:${l}%;width:${width};background:${color};pointer-events:none;z-index:3;"></div>`;
        }
        return lines;
    }

    // -----------------------------------------------------------------------
    // BELL SCHEDULE HELPERS
    // -----------------------------------------------------------------------

    const PERIOD_COLORS = [
        { bg: '#dbeafe', text: '#1d4ed8' },
        { bg: '#dcfce7', text: '#15803d' },
        { bg: '#fef9c3', text: '#854d0e' },
        { bg: '#fce7f3', text: '#be185d' },
        { bg: '#ede9fe', text: '#6d28d9' },
        { bg: '#e0f2fe', text: '#0369a1' },
    ];
    const PERIOD_BAND_COLORS = ['', 'rgba(219,234,254,0.38)', 'rgba(220,252,231,0.3)', 'rgba(254,249,195,0.3)', 'rgba(252,231,243,0.25)', 'rgba(237,233,254,0.3)', 'rgba(224,242,254,0.3)'];

    function getBellPeriods(divName) {
        const cp = window.campPeriods || window.loadGlobalSettings?.('campPeriods') || {};
        let raw;
        if (divName) {
            raw = cp[divName] || [];
        } else {
            const all = Object.values(cp);
            raw = all.reduce((best, cur) => cur.length >= best.length ? cur : best, []);
        }
        return [...raw].sort((a, b) => a.startMin - b.startMin);
    }

    function buildPeriodHeader(periods, campStart, campEnd, totalMin) {
        if (!periods || !periods.length) return '';
        let html = '<div style="position:relative;height:22px;overflow:hidden;border-bottom:1px solid #e2e8f0;">';
        periods.forEach((p, i) => {
            if (p.endMin <= campStart || p.startMin >= campEnd) return;
            const s = Math.max(p.startMin, campStart);
            const e = Math.min(p.endMin, campEnd);
            const l = ((s - campStart) / totalMin * 100).toFixed(3);
            const w = ((e - s) / totalMin * 100).toFixed(3);
            const c = PERIOD_COLORS[i % PERIOD_COLORS.length];
            html += `<div style="position:absolute;top:0;bottom:0;left:${l}%;width:${w}%;background:${c.bg};
                                 display:flex;align-items:center;justify-content:center;
                                 border-right:1px solid rgba(148,163,184,0.35);overflow:hidden;">
                         <span style="font-size:0.63rem;font-weight:700;color:${c.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 5px;">${p.name}</span>
                     </div>`;
        });
        html += '</div>';
        return html;
    }

    function buildPeriodBands(periods, campStart, campEnd, totalMin) {
        if (!periods || !periods.length) return '';
        let html = '';
        periods.forEach((p, i) => {
            if (p.endMin <= campStart || p.startMin >= campEnd) return;
            const bg = PERIOD_BAND_COLORS[(i + 1) % PERIOD_BAND_COLORS.length];
            if (!bg) return;
            const s = Math.max(p.startMin, campStart);
            const e = Math.min(p.endMin, campEnd);
            const l = ((s - campStart) / totalMin * 100).toFixed(3);
            const w = ((e - s) / totalMin * 100).toFixed(3);
            html += `<div style="position:absolute;top:0;bottom:0;left:${l}%;width:${w}%;background:${bg};pointer-events:none;z-index:0;"></div>`;
        });
        return html;
    }

    function buildNowLine(campStart, totalMin) {
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const l = ((nowMin - campStart) / totalMin * 100).toFixed(3);
        return `<div style="position:absolute;top:0;bottom:0;left:${l}%;width:2px;background:${NOW_COLOR};z-index:20;pointer-events:none;">
            <div style="position:absolute;top:2px;left:50%;transform:translateX(-50%);width:6px;height:6px;background:${NOW_COLOR};border-radius:50%;border:1.5px solid #fff;"></div>
        </div>`;
    }

    function mergeIntervals(usages) {
        if (!usages.length) return [];
        const sorted = [...usages].sort((a, b) => a.startMin - b.startMin);
        const merged = [{ startMin: sorted[0].startMin, endMin: sorted[0].endMin }];
        for (let i = 1; i < sorted.length; i++) {
            const last = merged[merged.length - 1];
            if (sorted[i].startMin <= last.endMin) last.endMin = Math.max(last.endMin, sorted[i].endMin);
            else merged.push({ startMin: sorted[i].startMin, endMin: sorted[i].endMin });
        }
        return merged;
    }

    // Build the full track as red (taken) + green (available) solid blocks.
    // Each block carries a data-tip attribute for the hover tooltip.
    function buildTrack(usages, campStart, campEnd, totalMin, labelFn, periods) {
        const merged = mergeIntervals(usages);
        let html = buildPeriodBands(periods, campStart, campEnd, totalMin);
        html += buildGridLines(campStart, campEnd, totalMin);
        let cursor = campStart;

        const block = (s, e, color, tip) => {
            if (e <= s) return '';
            // 1px inset on each side so adjacent blocks have a hairline gap
            const l = ((s - campStart) / totalMin * 100).toFixed(4);
            const w = Math.max(0.2, ((e - s) / totalMin * 100)).toFixed(4);
            return `<div data-tip="${tip.replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}"
                         style="position:absolute;top:6px;bottom:6px;left:calc(${l}% + 1px);width:calc(${w}% - 2px);
                                background:${color};border-radius:3px;
                                box-shadow:inset 0 1px 0 rgba(255,255,255,0.25);
                                box-sizing:border-box;z-index:2;cursor:default;"></div>`;
        };

        merged.forEach(interval => {
            const dur = interval.startMin - cursor;
            if (dur > 0) {
                html += block(cursor, interval.startMin, COLOR_AVAIL,
                    `Available\n${minutesToTimeLabel(cursor)} – ${minutesToTimeLabel(interval.startMin)} (${dur} min)`);
            }
            const bDur = interval.endMin - interval.startMin;
            const label = usages
                .filter(u => u.startMin < interval.endMin && u.endMin > interval.startMin)
                .map(u => labelFn(u)).join(', ');
            html += block(interval.startMin, interval.endMin, COLOR_TAKEN,
                `Taken — ${minutesToTimeLabel(interval.startMin)} – ${minutesToTimeLabel(interval.endMin)} (${bDur} min)\n${label}`);
            cursor = interval.endMin;
        });

        if (cursor < campEnd) {
            const dur = campEnd - cursor;
            html += block(cursor, campEnd, COLOR_AVAIL,
                `Available\n${minutesToTimeLabel(cursor)} – ${minutesToTimeLabel(campEnd)} (${dur} min)`);
        }

        return html;
    }

    function buildRow(leftLabel, trackHtml, isAlternate, rowKey) {
        const rowBg = isAlternate ? '#fafafa' : '#fff';
        const rk = (rowKey || leftLabel).replace(/[^a-z0-9]/gi, '_');
        return `
            <div class="gantt-row" data-row="${rk}" style="display:flex;align-items:stretch;border-bottom:1px solid #f1f5f9;min-height:46px;transition:background 0.1s;">
                <div class="gantt-label" data-row="${rk}" style="width:168px;min-width:168px;padding:0 14px;display:flex;align-items:center;
                            font-size:0.8rem;font-weight:500;color:#374151;letter-spacing:0.01em;
                            border-right:1px solid #e9ecef;background:${rowBg};flex-shrink:0;overflow:hidden;
                            position:sticky;left:0;z-index:4;cursor:pointer;" title="${leftLabel}">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${leftLabel}</span>
                </div>
                <div class="gantt-track" data-row="${rk}" style="flex:1;position:relative;background:#f8fafc;overflow:hidden;">
                    ${trackHtml}
                </div>
            </div>`;
    }

    // Tooltip — created once, reused on every mousemove via event delegation
    function ensureTooltip() {
        let tip = document.getElementById('analytics-gantt-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'analytics-gantt-tip';
            tip.style.cssText = [
                'position:fixed', 'z-index:9999', 'pointer-events:none', 'display:none',
                'background:#1e293b', 'color:#f1f5f9', 'border-radius:5px',
                'padding:8px 12px', 'font-size:0.78rem', 'line-height:1.55',
                'white-space:pre', 'box-shadow:0 4px 14px rgba(0,0,0,0.25)'
            ].join(';');
            document.body.appendChild(tip);
        }
        return tip;
    }

    function bindTooltip(area) {
        const tip = ensureTooltip();
        area.addEventListener('mousemove', e => {
            const block = e.target.closest('[data-tip]');
            if (block) {
                tip.textContent = block.dataset.tip;
                tip.style.display = 'block';
                const x = e.clientX + 16, y = e.clientY - 10;
                // Keep within viewport
                tip.style.left = (x + tip.offsetWidth > window.innerWidth ? x - tip.offsetWidth - 20 : x) + 'px';
                tip.style.top  = (y + tip.offsetHeight > window.innerHeight ? y - tip.offsetHeight : y) + 'px';
            } else {
                tip.style.display = 'none';
            }
        });
        area.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }

    function bindChartInteractions(area, items, campStart, campEnd, viewType) {
        const outer      = area.querySelector('#gantt-scroll-outer');
        const body       = area.querySelector('#gantt-body');
        const cursor     = area.querySelector('#gantt-cursor');
        const cursorLbl  = area.querySelector('#gantt-cursor-label');
        const pinLine    = area.querySelector('#gantt-pin-line');
        if (!body || !cursor) return;

        const LABEL_W = 168;
        const totalMin = campEnd - campStart;

        function getAbsX(e) {
            const rect = body.getBoundingClientRect();
            return (e.clientX - rect.left) + (outer ? outer.scrollLeft : 0);
        }
        function absXToMin(absX) {
            const trackW = Math.max(1, body.scrollWidth - LABEL_W);
            return campStart + Math.max(0, Math.min(1, (absX - LABEL_W) / trackW)) * totalMin;
        }

        body.addEventListener('mousemove', e => {
            const absX  = getAbsX(e);
            const trackW = body.scrollWidth - LABEL_W;
            if (absX - LABEL_W < 0 || absX - LABEL_W > trackW) { cursor.style.display = 'none'; return; }
            cursor.style.left    = absX + 'px';
            cursor.style.display = 'block';
            if (cursorLbl) cursorLbl.textContent = minutesToTimeLabel(Math.round(absXToMin(absX)));
            const rowEl = e.target.closest('.gantt-row');
            body.querySelectorAll('.gantt-row').forEach(r => { r.style.background = r === rowEl ? 'rgba(37,99,235,0.05)' : ''; });
        });

        body.addEventListener('mouseleave', () => {
            cursor.style.display = 'none';
            body.querySelectorAll('.gantt-row').forEach(r => { r.style.background = ''; });
        });

        body.addEventListener('click', e => {
            if (e.target.closest('.gantt-label') && viewType === 'bunk') return;
            const absX = getAbsX(e);
            if (absX - LABEL_W < 0) return;
            const pinnedMin = Math.round(absXToMin(absX));
            if (pinLine) { pinLine.style.left = absX + 'px'; pinLine.style.display = 'block'; }
            renderPinPanel(area, pinnedMin, items, campStart, campEnd, viewType);
        });

        const freeNowBtn = area.querySelector('#gantt-free-now-btn');
        if (freeNowBtn) {
            freeNowBtn.addEventListener('click', e => {
                e.stopPropagation();
                const now = new Date();
                const nowMin = now.getHours() * 60 + now.getMinutes();
                const trackW = body.scrollWidth - LABEL_W;
                const absX = LABEL_W + ((nowMin - campStart) / totalMin) * trackW;
                if (pinLine) { pinLine.style.left = absX + 'px'; pinLine.style.display = 'block'; }
                renderPinPanel(area, nowMin, items, campStart, campEnd, viewType);
                area.querySelector('#gantt-pin-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        }

        if (viewType === 'bunk') {
            body.querySelectorAll('.gantt-label').forEach(lbl => {
                lbl.addEventListener('click', e => {
                    e.stopPropagation();
                    const rk = lbl.dataset.row;
                    const allRows = body.querySelectorAll('.gantt-row');
                    const focused = lbl.dataset.focused === '1';
                    if (focused) {
                        allRows.forEach(r => { r.style.opacity = ''; });
                        lbl.dataset.focused = '';
                    } else {
                        body.querySelectorAll('.gantt-label').forEach(l => { l.dataset.focused = ''; });
                        allRows.forEach(r => { r.style.opacity = r.dataset.row === rk ? '1' : '0.2'; });
                        lbl.dataset.focused = '1';
                    }
                });
            });
        }
    }

    function renderPinPanel(area, timeMin, items, campStart, campEnd, viewType) {
        const panel = area.querySelector('#gantt-pin-panel');
        if (!panel) return;
        panel.style.display = 'block';
        const timeLabel = minutesToTimeLabel(timeMin);
        const closeBtn = `<button onclick="document.getElementById('gantt-pin-panel').style.display='none';"
            style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:0.85rem;padding:2px 6px;line-height:1;">✕</button>`;

        if (viewType === 'field') {
            const gs = window.loadGlobalSettings?.() || {};
            const allRes = [
                ...(gs.app1?.fields || []).map(f => f.name),
                ...(gs.app1?.specialActivities || []).map(s => s.name)
            ].sort();
            const free = [], taken = [];
            allRes.forEach(name => {
                const hits = items.filter(it => (it.field === name || it.activity === name) && it.startMin <= timeMin && it.endMin > timeMin);
                if (hits.length) taken.push({ name, by: hits.map(u => u.bunk).join(', ') });
                else free.push(name);
            });
            panel.innerHTML = `
                <div style="border:1px solid #e2e8f0;border-radius:8px;padding:13px 16px;background:#fff;box-shadow:0 1px 4px rgba(15,23,42,0.06);">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                        <span style="font-size:0.83rem;font-weight:700;color:#1e293b;">Snapshot at ${timeLabel}</span>${closeBtn}
                    </div>
                    <div style="display:flex;gap:20px;flex-wrap:wrap;">
                        <div style="flex:1;min-width:130px;">
                            <div style="font-size:0.69rem;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">Free (${free.length})</div>
                            ${free.length ? free.map(f => `<div style="font-size:0.78rem;color:#374151;padding:2px 0;border-bottom:1px solid #f1f5f9;">${f}</div>`).join('') : '<div style="font-size:0.78rem;color:#94a3b8;">None</div>'}
                        </div>
                        <div style="flex:1;min-width:130px;">
                            <div style="font-size:0.69rem;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">Taken (${taken.length})</div>
                            ${taken.length ? taken.map(t => `<div style="font-size:0.78rem;color:#374151;padding:2px 0;border-bottom:1px solid #f1f5f9;">${t.name} <span style="color:#94a3b8;font-size:0.72rem;">— ${t.by}</span></div>`).join('') : '<div style="font-size:0.78rem;color:#94a3b8;">None</div>'}
                        </div>
                    </div>
                </div>`;
        } else {
            const active = items.filter(it => it.startMin <= timeMin && it.endMin > timeMin);
            panel.innerHTML = `
                <div style="border:1px solid #e2e8f0;border-radius:8px;padding:13px 16px;background:#fff;box-shadow:0 1px 4px rgba(15,23,42,0.06);">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                        <span style="font-size:0.83rem;font-weight:700;color:#1e293b;">Snapshot at ${timeLabel}</span>${closeBtn}
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:5px;">
                        ${active.length ? active.map(a => `<span style="padding:3px 9px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;font-size:0.75rem;color:#1e40af;">${a.bunk} — ${a.activity}${a.field ? ' @ ' + a.field : ''}</span>`).join('') : '<span style="font-size:0.78rem;color:#94a3b8;">All bunks free at this time</span>'}
                    </div>
                </div>`;
        }
    }

    function bindFindSlot(area, items, campStart, campEnd) {
        let selectedDur = null;
        area.querySelectorAll('.slot-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                area.querySelectorAll('.slot-chip').forEach(c => { c.style.background='#fff'; c.style.color='#475569'; c.style.borderColor='#cbd5e1'; });
                chip.style.background = '#1e40af'; chip.style.color = '#fff'; chip.style.borderColor = '#1e40af';
                selectedDur = parseInt(chip.dataset.dur);
            });
        });
        const searchBtn = area.querySelector('#slot-search-btn');
        if (searchBtn) {
            searchBtn.addEventListener('click', () => {
                const resultsEl = area.querySelector('#slot-results');
                if (!selectedDur) { if (resultsEl) resultsEl.innerHTML = '<div style="font-size:0.8rem;color:#dc2626;">Select a duration first.</div>'; return; }
                const actFilter = (area.querySelector('#slot-activity-input')?.value || '').trim().toLowerCase();
                renderSlotResults(area, findFreeWindows(selectedDur, items, campStart, campEnd, actFilter), selectedDur);
            });
        }
    }

    function findFreeWindows(durationMin, items, campStart, campEnd, actFilter) {
        const gs = window.loadGlobalSettings?.() || {};
        let fields = (gs.app1?.fields || []).map(f => ({ name: f.name, activities: f.activities || [] }));
        if (actFilter) fields = fields.filter(f => f.activities.some(a => a.toLowerCase().includes(actFilter)));
        return fields.reduce((acc, field) => {
            const merged = mergeIntervals(items.filter(it => it.field === field.name));
            let cur = campStart;
            const gaps = [];
            merged.forEach(iv => { if (iv.startMin - cur >= durationMin) gaps.push({ start: cur, end: iv.startMin }); cur = iv.endMin; });
            if (campEnd - cur >= durationMin) gaps.push({ start: cur, end: campEnd });
            if (gaps.length) acc.push({ field: field.name, gaps });
            return acc;
        }, []);
    }

    function renderSlotResults(area, windows, dur) {
        const cont = area.querySelector('#slot-results');
        if (!cont) return;
        if (!windows.length) { cont.innerHTML = `<div style="padding:8px 0;color:#94a3b8;font-size:0.82rem;text-align:center;">No fields have a free ${dur}-minute window.</div>`; return; }
        cont.innerHTML = windows.map(w => `
            <div style="padding:7px 12px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:5px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;background:#fff;">
                <span style="font-size:0.8rem;font-weight:700;color:#1e293b;min-width:110px;">${w.field}</span>
                <div style="display:flex;flex-wrap:wrap;gap:5px;">
                    ${w.gaps.map(g => `<span style="padding:2px 8px;background:#dcfce7;border:1px solid #86efac;border-radius:999px;font-size:0.72rem;color:#15803d;font-weight:600;">${minutesToTimeLabel(g.start)} – ${minutesToTimeLabel(g.end)} (${g.end - g.start}m)</span>`).join('')}
                </div>
            </div>`).join('');
    }

    function buildLegendItem(color, label) {
        return `<span style="display:inline-flex;align-items:center;gap:7px;">
                    <span style="width:14px;height:14px;background:${color};border-radius:3px;flex-shrink:0;box-shadow:inset 0 1px 0 rgba(255,255,255,0.2);"></span>
                    <span style="font-size:0.78rem;font-weight:500;color:#374151;">${label}</span>
                </span>`;
    }

    // ========================================================================
    // BY FIELD GANTT
    // ========================================================================

    function renderFieldGantt(area, items, campStart, campEnd, showNow) {
        const gs = window.loadGlobalSettings?.() || {};
        const rawFields  = gs.app1?.fields || [];
        const rawSpecials = gs.app1?.specialActivities || [];

        let fieldResources   = rawFields.map(f => ({ name: f.name, type: 'field', activities: f.activities || [] }));
        let specialResources = rawSpecials.map(s => ({ name: s.name, type: 'special', activities: [] }));

        if (activityFilter) {
            fieldResources   = fieldResources.filter(f => f.activities.some(a => a.toLowerCase().includes(activityFilter)));
            specialResources = specialResources.filter(s => s.name.toLowerCase().includes(activityFilter));
        }

        const resources = [...fieldResources, ...specialResources].sort((a, b) => a.name.localeCompare(b.name));

        if (!resources.length) {
            area.innerHTML = `
                <div style="padding:40px;text-align:center;color:#94a3b8;background:#f8fafc;border:1px dashed #e2e8f0;border-radius:6px;">
                    <div style="font-size:0.9rem;font-weight:600;color:#64748b;">No fields match "${activityFilter}"</div>
                    <div style="font-size:0.8rem;margin-top:4px;">Try a different activity name.</div>
                </div>`;
            return;
        }

        const totalMin = campEnd - campStart;

        const byField = {}, bySpecial = {};
        items.forEach(item => {
            if (item.field) (byField[item.field] = byField[item.field] || []).push(item);
            if (item.isSpecial) {
                const arr = (bySpecial[item.activity] = bySpecial[item.activity] || []);
                if (!arr.some(x => x.bunk === item.bunk && x.startMin === item.startMin)) arr.push(item);
            }
        });

        const nowLegend = showNow
            ? `<span style="display:inline-flex;align-items:center;gap:7px;">
                   <span style="width:2px;height:15px;background:${NOW_COLOR};border-radius:1px;flex-shrink:0;"></span>
                   <span style="font-size:0.78rem;font-weight:500;color:#374151;">Current time</span>
               </span>`
            : '';
        const filterBadge = activityFilter
            ? `<span style="padding:2px 10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;font-size:0.73rem;color:#1d4ed8;font-weight:600;">Filtered: ${activityFilter}</span>`
            : '<span style="font-size:0.73rem;color:#94a3b8;">Hover or click timeline for details</span>';
        const freeNowBtn = showNow
            ? `<button id="gantt-free-now-btn" style="padding:4px 12px;background:#16a34a;color:#fff;border:none;border-radius:4px;font-size:0.74rem;font-weight:600;cursor:pointer;white-space:nowrap;">What's free now?</button>`
            : '';

        const keyBar = `
            <div style="display:flex;align-items:center;gap:16px;padding:11px 18px;border-bottom:1px solid #e9ecef;background:#fff;flex-wrap:wrap;">
                ${buildLegendItem(COLOR_AVAIL, 'Available')}
                ${buildLegendItem(COLOR_TAKEN, 'Taken')}
                ${nowLegend}
                <div style="margin-left:auto;display:flex;align-items:center;gap:10px;">
                    ${freeNowBtn}
                    ${filterBadge}
                </div>
            </div>`;

        const fieldPeriods = getBellPeriods();
        let rows = '';
        resources.forEach((r, i) => {
            const usages = r.type === 'field' ? (byField[r.name] || []) : (bySpecial[r.name] || []);
            let track = buildTrack(usages, campStart, campEnd, totalMin, u => `${u.bunk}  ·  ${u.activity}`, fieldPeriods);
            if (showNow) track += buildNowLine(campStart, totalMin);
            rows += buildRow(r.name, track, i % 2 === 1);
        });

        const hasPeriods = fieldPeriods.length > 0;
        const axisRow = `
            <div style="display:flex;padding:${hasPeriods ? '0' : '14px'} 0 6px;border-bottom:1px solid #f1f5f9;">
                <div style="width:168px;min-width:168px;flex-shrink:0;position:sticky;left:0;z-index:5;background:#fff;${hasPeriods ? 'border-bottom:1px solid #e2e8f0;' : ''}"></div>
                <div style="flex:1;position:relative;">
                    ${hasPeriods ? buildPeriodHeader(fieldPeriods, campStart, campEnd, totalMin) : ''}
                    <div style="padding-top:${hasPeriods ? '6px' : '0'};">${buildTimeAxis(campStart, campEnd, totalMin)}</div>
                </div>
            </div>`;

        area.innerHTML = `
            <div id="gantt-card" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 1px 4px rgba(15,23,42,0.06),0 4px 16px rgba(15,23,42,0.04);">
                ${keyBar}
                <div id="gantt-scroll-outer" style="overflow-x:auto;">
                    <div id="gantt-body" style="position:relative;min-width:560px;padding-bottom:12px;cursor:crosshair;">
                        ${axisRow}
                        ${rows}
                        <div id="gantt-cursor" style="display:none;position:absolute;top:0;bottom:0;left:200px;width:0;pointer-events:none;z-index:25;">
                            <div id="gantt-cursor-label" style="position:absolute;top:3px;left:0;transform:translateX(-50%);background:#334155;color:#f8fafc;font-size:0.64rem;font-weight:600;padding:1px 5px;border-radius:2px;white-space:nowrap;"></div>
                            <div style="position:absolute;top:22px;bottom:0;left:0;width:1px;background:#94a3b8;opacity:0.65;"></div>
                        </div>
                        <div id="gantt-pin-line" style="display:none;position:absolute;top:0;bottom:0;left:200px;width:2px;background:#1e40af;pointer-events:none;z-index:24;opacity:0.8;"></div>
                    </div>
                </div>
            </div>
            <div id="gantt-pin-panel" style="display:none;margin-top:10px;"></div>
            <div id="gantt-find-slot-wrap" style="margin-top:10px;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;background:#fff;box-shadow:0 1px 4px rgba(15,23,42,0.06);">
                <div style="font-size:0.82rem;font-weight:700;color:#1e293b;margin-bottom:10px;">Find me a free slot</div>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <div style="display:flex;gap:5px;">
                        ${[15,30,45,60,90].map(d => `<button class="slot-chip" data-dur="${d}" style="padding:4px 11px;border:1px solid #cbd5e1;border-radius:999px;font-size:0.76rem;font-weight:600;cursor:pointer;background:#fff;color:#475569;">${d}m</button>`).join('')}
                    </div>
                    <input id="slot-activity-input" type="text" placeholder="Activity filter (optional)" style="padding:5px 10px;border:1px solid #cbd5e1;border-radius:4px;font-size:0.8rem;min-width:150px;flex:1;" />
                    <button id="slot-search-btn" style="padding:5px 14px;background:#1e40af;color:#fff;border:none;border-radius:4px;font-size:0.8rem;font-weight:600;cursor:pointer;">Search</button>
                </div>
                <div id="slot-results" style="margin-top:10px;"></div>
            </div>`;
        bindTooltip(area);
        bindChartInteractions(area, items, campStart, campEnd, 'field');
        bindFindSlot(area, items, campStart, campEnd);
    }

    // ========================================================================
    // BY BUNK GANTT
    // ========================================================================

    function renderBunkGantt(area, items, campStart, campEnd, divFilter, showNow) {
        const totalMin = campEnd - campStart;

        const bunkMap = {};
        items.forEach(item => {
            if (activityFilter && !item.activity.toLowerCase().includes(activityFilter)) return;
            (bunkMap[item.bunk] = bunkMap[item.bunk] || []).push(item);
        });

        const divs = divFilter
            ? (divisionsDat[divFilter] ? { [divFilter]: divisionsDat[divFilter] } : {})
            : divisionsDat;

        let rowCount = 0;
        let anyBunk = false;
        let rows = '';

        Object.entries(divs).forEach(([divName, divData]) => {
            if (!divData) return;
            const bunks = divData.bunks || [];
            if (!bunks.length) return;
            anyBunk = true;

            rows += `<div style="display:flex;border-bottom:1px solid #f1f5f9;">
                <div style="width:168px;min-width:168px;padding:5px 14px;font-size:0.67rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;border-right:1px solid #e9ecef;background:#fafafa;display:flex;align-items:center;position:sticky;left:0;z-index:4;">${divName}</div>
                <div style="flex:1;background:#fafafa;"></div>
            </div>`;

            const divPeriods = getBellPeriods(divName);
            bunks.forEach(bunk => {
                const usages = bunkMap[bunk] || [];
                let track = buildTrack(usages, campStart, campEnd, totalMin, u => u.activity, divPeriods);
                if (showNow) track += buildNowLine(campStart, totalMin);
                rows += buildRow(bunk, track, rowCount % 2 === 1);
                rowCount++;
            });
        });

        if (!anyBunk) {
            area.innerHTML = `<div style="padding:32px;text-align:center;color:#94a3b8;">No bunks found.</div>`;
            return;
        }

        const nowLegend = showNow
            ? `<span style="display:inline-flex;align-items:center;gap:7px;">
                   <span style="width:2px;height:15px;background:${NOW_COLOR};border-radius:1px;flex-shrink:0;"></span>
                   <span style="font-size:0.78rem;font-weight:500;color:#374151;">Current time</span>
               </span>`
            : '';
        const filterBadge = activityFilter
            ? `<span style="padding:2px 10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;font-size:0.73rem;color:#1d4ed8;font-weight:600;">Filtered: ${activityFilter}</span>`
            : '<span style="font-size:0.73rem;color:#94a3b8;">Click a bunk label to focus it</span>';

        const keyBar = `
            <div style="display:flex;align-items:center;gap:16px;padding:11px 18px;border-bottom:1px solid #e9ecef;background:#fff;flex-wrap:wrap;">
                ${buildLegendItem(COLOR_AVAIL, 'Available')}
                ${buildLegendItem(COLOR_TAKEN, 'Taken')}
                ${nowLegend}
                <div style="margin-left:auto;display:flex;align-items:center;gap:10px;">${filterBadge}</div>
            </div>`;

        const globalPeriods = getBellPeriods();
        const hasBunkPeriods = globalPeriods.length > 0;
        const axisRow = `
            <div style="display:flex;padding:${hasBunkPeriods ? '0' : '14px'} 0 6px;border-bottom:1px solid #f1f5f9;">
                <div style="width:168px;min-width:168px;flex-shrink:0;position:sticky;left:0;z-index:5;background:#fff;${hasBunkPeriods ? 'border-bottom:1px solid #e2e8f0;' : ''}"></div>
                <div style="flex:1;position:relative;">
                    ${hasBunkPeriods ? buildPeriodHeader(globalPeriods, campStart, campEnd, totalMin) : ''}
                    <div style="padding-top:${hasBunkPeriods ? '6px' : '0'};">${buildTimeAxis(campStart, campEnd, totalMin)}</div>
                </div>
            </div>`;

        area.innerHTML = `
            <div id="gantt-card" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 1px 4px rgba(15,23,42,0.06),0 4px 16px rgba(15,23,42,0.04);">
                ${keyBar}
                <div id="gantt-scroll-outer" style="overflow-x:auto;">
                    <div id="gantt-body" style="position:relative;min-width:560px;padding-bottom:12px;cursor:crosshair;">
                        ${axisRow}
                        ${rows}
                        <div id="gantt-cursor" style="display:none;position:absolute;top:0;bottom:0;left:200px;width:0;pointer-events:none;z-index:25;">
                            <div id="gantt-cursor-label" style="position:absolute;top:3px;left:0;transform:translateX(-50%);background:#334155;color:#f8fafc;font-size:0.64rem;font-weight:600;padding:1px 5px;border-radius:2px;white-space:nowrap;"></div>
                            <div style="position:absolute;top:22px;bottom:0;left:0;width:1px;background:#94a3b8;opacity:0.65;"></div>
                        </div>
                        <div id="gantt-pin-line" style="display:none;position:absolute;top:0;bottom:0;left:200px;width:2px;background:#1e40af;pointer-events:none;z-index:24;opacity:0.8;"></div>
                    </div>
                </div>
            </div>
            <div id="gantt-pin-panel" style="display:none;margin-top:10px;"></div>`;
        bindTooltip(area);
        bindChartInteractions(area, items, campStart, campEnd, 'bunk');
    }

    // ========================================================================
    // BUNK ROTATION REPORT
    // ========================================================================

    function renderBunkRotationUI() {
        const wrapper = document.getElementById('report-rotation-content');
        if (!wrapper) return;

        wrapper.innerHTML = `
            <div class="setup-card" style="margin-bottom:16px;">
                <div class="setup-card-header">
                    <div class="setup-step-pill" style="background:linear-gradient(135deg,#10b981,#059669);">Rotation</div>
                    <div class="setup-card-text">
                        <h3 style="margin:0;">Bunk Rotation & Usage</h3>
                        <p style="margin:2px 0 0;font-size:0.8rem;color:#6b7280;">Track activity counts, last done dates, and manual adjustments</p>
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

        const divSelect = document.getElementById('rotation-div-select');
        availableDivisions.forEach(d => { divSelect.innerHTML += `<option value="${d}">${d}</option>`; });
        divSelect.onchange = () => { populateRotationBunkFilter(divSelect.value); renderRotationTable(divSelect.value); };
        document.getElementById('rotation-type-filter').onchange = () => renderRotationTable(divSelect.value);
        document.getElementById('rotation-bunk-filter').onchange = () => renderRotationTable(divSelect.value);
        let _timer = null;
        document.getElementById('rotation-activity-filter').oninput = () => {
            clearTimeout(_timer); _timer = setTimeout(() => renderRotationTable(divSelect.value), 300);
        };
    }

    function populateRotationBunkFilter(divName) {
        const sel = document.getElementById('rotation-bunk-filter');
        if (!sel) return;
        sel.innerHTML = '<option value="">All Bunks</option>';
        if (!divName) return;
        (divisionsDat[divName]?.bunks || []).forEach(b => { sel.innerHTML += `<option value="${b}">${b}</option>`; });
    }

    function renderRotationTable(divName) {
        const cont = document.getElementById('rotation-table-container');
        if (!divName) {
            cont.innerHTML = `<div style="padding:30px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:12px;border:1px dashed #d1d5db;">
                <span style="font-size:0.9rem;">Select a division to view rotation data</span>
            </div>`;
            return;
        }

        const bunks = divisionsDat[divName]?.bunks || [];
        if (!bunks.length) {
            cont.innerHTML = `<div style="padding:20px;text-align:center;color:#b91c1c;background:#fee2e2;border-radius:12px;">No bunks in this division.</div>`;
            return;
        }

        const filter = document.getElementById('rotation-type-filter')?.value || 'all';
        let filteredActivities = allActivities;
        if (filter === 'sport') filteredActivities = allActivities.filter(a => a.type === 'sport');
        if (filter === 'special') filteredActivities = allActivities.filter(a => a.type === 'special');

        const actSearch = (document.getElementById('rotation-activity-filter')?.value || '').trim().toLowerCase();
        if (actSearch) filteredActivities = filteredActivities.filter(a => a.name.toLowerCase().includes(actSearch));

        if (!filteredActivities.length) {
            cont.innerHTML = `<div style="padding:20px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:12px;">No activities match the filter.</div>`;
            return;
        }

        const bunkFilter = document.getElementById('rotation-bunk-filter')?.value || '';
        const filteredBunks = bunkFilter ? bunks.filter(b => b === bunkFilter) : bunks;
        if (!filteredBunks.length) {
            cont.innerHTML = `<div style="padding:20px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:12px;">No bunks match the filter.</div>`;
            return;
        }

        const allDaily = window.loadAllDailyData?.() || {};
        const global = window.loadGlobalSettings?.() || {};
        const manualOffsets = global.manualUsageOffsets || {};
        const rawCounts = global.historicalCounts || {};
        const lastDone = {};

        const rotHist = window.loadRotationHistory?.() || { bunks: {} };
        Object.keys(allDaily).sort().forEach(dateKey => {
            const sched = allDaily[dateKey]?.scheduleAssignments || {};
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
                const d = new Date(ts).toISOString().split('T')[0];
                lastDone[bunk] = lastDone[bunk] || {};
                if (!lastDone[bunk][act] || d > lastDone[bunk][act]) lastDone[bunk][act] = d;
            });
        });

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
                        <tbody>`;

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
                    const diff = Math.floor((new Date() - new Date(lastDate)) / 86400000);
                    daysSince = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : `${diff}d ago`;
                }
                let rowBg = bunkBg, totalStyle = 'font-weight:600;';
                if (act.max > 0 && total >= act.max) { rowBg = '#fee2e2'; totalStyle += 'color:#b91c1c;'; }
                else if (total === 0) totalStyle += 'color:#d97706;';

                const typeTag = act.type === 'special'
                    ? '<span style="background:#ddd6fe;color:#7c3aed;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">SP</span>'
                    : '<span style="background:#dbeafe;color:#2563eb;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">SP</span>';

                // Correct type labels
                const typeLabel = act.type === 'special'
                    ? '<span style="background:#ddd6fe;color:#7c3aed;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">Special</span>'
                    : '<span style="background:#dbeafe;color:#2563eb;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">Sport</span>';

                html += `
                    <tr style="background:${rowBg};">
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;position:sticky;left:0;background:${rowBg};font-weight:${isFirstRow ? '600' : '400'};color:#111827;">${isFirstRow ? bunk : ''}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;color:#374151;">${act.name}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;">${typeLabel}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;color:#6b7280;">${hist}</td>
                        <td style="padding:4px 6px;border:1px solid #e5e7eb;text-align:center;">
                            <input type="number" class="rotation-adj-input" data-bunk="${bunk}" data-act="${act.name}" value="${offset}"
                                style="width:45px;text-align:center;padding:4px;border:1px solid #d1d5db;border-radius:999px;font-size:0.8rem;" />
                        </td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;${totalStyle}">${total}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;font-size:0.85em;">${lastDateFormatted} <span style="color:#9ca3af;font-size:0.85em;">${daysSince}</span></td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;${act.max > 0 && total >= act.max ? 'color:#b91c1c;font-weight:600;' : 'color:#6b7280;'}">${limit}</td>
                    </tr>`;
                isFirstRow = false;
            });
        });

        html += `</tbody></table></div></div>`;
        html += buildRotationSummary(filteredBunks, filteredActivities, rawCounts, manualOffsets);
        cont.innerHTML = html;

        cont.querySelectorAll('.rotation-adj-input').forEach(inp => {
            inp.onchange = (e) => {
                const b = e.target.dataset.bunk, a = e.target.dataset.act;
                const val = parseInt(e.target.value) || 0;
                const gs = window.loadGlobalSettings?.() || {};
                if (!gs.manualUsageOffsets) gs.manualUsageOffsets = {};
                if (!gs.manualUsageOffsets[b]) gs.manualUsageOffsets[b] = {};
                if (val === 0) delete gs.manualUsageOffsets[b][a];
                else gs.manualUsageOffsets[b][a] = val;
                window.saveGlobalSettings('manualUsageOffsets', gs.manualUsageOffsets);
                renderRotationTable(divName);
            };
        });
    }

    function buildRotationSummary(bunks, activities, rawCounts, manualOffsets) {
        const neverDone = [], atLimit = [];
        bunks.forEach(bunk => {
            activities.forEach(act => {
                const total = Math.max(0, (rawCounts[bunk]?.[act.name] || 0) + (manualOffsets[bunk]?.[act.name] || 0));
                if (total === 0) neverDone.push({ bunk, activity: act.name });
                if (act.max > 0 && total >= act.max) atLimit.push({ bunk, activity: act.name });
            });
        });

        let html = `<div class="setup-card" style="margin-top:16px;">
            <div class="setup-card-header">
                <div class="setup-step-pill setup-step-pill-muted">Summary</div>
                <div class="setup-card-text"><h3 style="margin:0;font-size:0.95rem;">Quick Stats</h3></div>
            </div>`;

        html += neverDone.length > 0
            ? `<div style="margin-bottom:10px;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:999px;">
                <strong style="color:#92400e;">Never Done (${neverDone.length}):</strong>
                <span style="font-size:0.85em;color:#78350f;margin-left:6px;">${neverDone.slice(0, 8).map(n => `${n.bunk} → ${n.activity}`).join(', ')}${neverDone.length > 8 ? '…' : ''}</span>
               </div>`
            : `<div style="margin-bottom:10px;padding:10px 12px;background:#d1fae5;border:1px solid #10b981;border-radius:999px;">
                <strong style="color:#047857;">All bunks have done all activities at least once.</strong>
               </div>`;

        if (atLimit.length > 0) {
            html += `<div style="padding:10px 12px;background:#fee2e2;border:1px solid #ef4444;border-radius:999px;">
                <strong style="color:#b91c1c;">At Limit (${atLimit.length}):</strong>
                <span style="font-size:0.85em;color:#7f1d1d;margin-left:6px;">${atLimit.map(a => `${a.bunk} → ${a.activity}`).join(', ')}</span>
             </div>`;
        }

        return html + '</div>';
    }

    // ========================================================================
    // DATE FORMATTER
    // ========================================================================

    function formatDateDisplay(dateKey) {
        if (!dateKey) return '';
        try { return new Date(dateKey + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }
        catch (e) { return dateKey; }
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    window.initReportTab = initReportTab;
    window.debugAnalytics = { buildUsageData, getCampTimes };

})();
