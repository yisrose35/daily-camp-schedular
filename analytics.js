// ============================================================================
// analytics.js v3.0
// Gantt-chart availability grid + Bunk Rotation report
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // TIME HELPERS
    // ========================================================================

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

        let earliestStart = Infinity;
        let latestEnd = 0;

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
    let selectedDate = null;
    let currentView = 'field';

    const DIV_COLORS = [
        { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
        { bg: '#dcfce7', border: '#16a34a', text: '#15803d' },
        { bg: '#fce7f3', border: '#db2777', text: '#9d174d' },
        { bg: '#fef9c3', border: '#ca8a04', text: '#854d0e' },
        { bg: '#ffe4e6', border: '#f43f5e', text: '#9f1239' },
        { bg: '#f3e8ff', border: '#9333ea', text: '#7e22ce' },
        { bg: '#ffedd5', border: '#ea580c', text: '#9a3412' },
        { bg: '#cffafe', border: '#0891b2', text: '#164e63' },
    ];

    // ========================================================================
    // MASTER DATA
    // ========================================================================

    function loadMasterData() {
        try {
            const g = window.loadGlobalSettings?.() || {};
            divisionsDat = window.divisions || {};
            availableDivisions = (window.availableDivisions || Object.keys(divisionsDat)).sort();

            const fields = g.app1?.fields || [];
            const specials = g.app1?.specialActivities || [];

            allActivities = [
                ...fields.flatMap(f => (f.activities || []).map(a => ({ name: a, type: 'sport', max: 0 }))),
                ...specials.map(s => ({ name: s.name, type: 'special', max: s.maxUsage || 0 }))
            ];

            const seen = new Set();
            allActivities = allActivities.filter(a => {
                if (seen.has(a.name)) return false;
                seen.add(a.name);
                return true;
            });
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
        if (window.SchedulerCoreUtils?.getDivisionForBunk) {
            return window.SchedulerCoreUtils.getDivisionForBunk(bunkName);
        }
        for (const [divName, divData] of Object.entries(divisionsDat)) {
            if (divData.bunks?.includes(bunkName)) return divName;
        }
        return null;
    }

    // ========================================================================
    // DATA BUILDER
    // Primary fix: read _startMin/_endMin directly from each entry instead of
    // relying on a slot-index lookup in divisionTimes (which fails when the
    // division lookup returns null or per-bunk slots are in use).
    // ========================================================================

    function buildUsageData(dateKey) {
        const allDaily = window.loadAllDailyData?.() || {};
        let assignments;

        if (dateKey && allDaily[dateKey]) {
            assignments = allDaily[dateKey].scheduleAssignments || {};
        } else {
            assignments = window.scheduleAssignments ||
                          window.loadCurrentDailyData?.()?.scheduleAssignments || {};
        }

        const dTimes = window.divisionTimes || {};
        const items = [];

        Object.entries(assignments).forEach(([bunk, schedule]) => {
            if (!Array.isArray(schedule)) return;
            const divName = getDivisionForBunk(bunk) || 'Unknown';
            const times = dTimes[divName] || [];

            schedule.forEach((entry, idx) => {
                if (!entry || entry.continuation || entry._isTransition) return;

                // Use times embedded on the entry first; fall back to divisionTimes by index
                let startMin = entry._startMin;
                let endMin = entry._endMin;

                if (startMin === undefined || endMin === undefined) {
                    const slotInfo = times[idx];
                    if (slotInfo) {
                        if (slotInfo.startMin !== undefined) {
                            startMin = slotInfo.startMin;
                            endMin = slotInfo.endMin;
                        } else if (slotInfo.start) {
                            const sd = new Date(slotInfo.start);
                            const ed = new Date(slotInfo.end);
                            startMin = sd.getHours() * 60 + sd.getMinutes();
                            endMin = ed.getHours() * 60 + ed.getMinutes();
                        }
                    }
                }

                if (startMin === undefined || endMin === undefined) return;

                // Extend through continuation slots to get the real block end time
                for (let i = idx + 1; i < schedule.length; i++) {
                    const next = schedule[i];
                    if (!next?.continuation) break;
                    if (next._endMin !== undefined) {
                        endMin = next._endMin;
                    } else {
                        const ns = times[i];
                        if (ns?.endMin !== undefined) endMin = ns.endMin;
                        else if (ns?.end) {
                            const ed = new Date(ns.end);
                            endMin = ed.getHours() * 60 + ed.getMinutes();
                        }
                    }
                }

                const activity = entry._activity || entry.activity || entry.sport || '';
                if (!activity || activity === 'Free') return;
                if (activity.toLowerCase().includes('transition')) return;

                const fRaw = entry.field;
                let fName = typeof fRaw === 'object' ? (fRaw?.name || '') : (fRaw || '');
                // Manual mode stores field as "Field – Activity" composite; extract the field part
                if (fName.includes(' – ')) fName = fName.split(' – ')[0].trim();
                else if (fName.includes(' - ')) fName = fName.split(' - ')[0].trim();
                const hasField = fName && fName !== 'Free' && fName !== 'No Field';

                items.push({
                    bunk,
                    division: divName,
                    field: hasField ? fName : null,
                    activity,
                    startMin,
                    endMin,
                    isSpecial: isSpecialByName(activity)
                });
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
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:12px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:0.72rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;">Date</label>
                    <select id="gantt-date-select" style="padding:6px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.84rem;background:#fff;">
                        ${dateOptions}
                    </select>
                </div>

                <div style="display:flex;background:#e5e7eb;border-radius:999px;padding:3px;gap:2px;flex-shrink:0;">
                    <button id="gantt-btn-field" style="padding:5px 16px;border:none;border-radius:999px;font-size:0.8rem;font-weight:600;cursor:pointer;background:#fff;color:#1e40af;box-shadow:0 1px 4px rgba(0,0,0,0.12);">By Field</button>
                    <button id="gantt-btn-bunk" style="padding:5px 16px;border:none;border-radius:999px;font-size:0.8rem;font-weight:600;cursor:pointer;background:transparent;color:#6b7280;box-shadow:none;">By Bunk</button>
                </div>

                <div id="gantt-div-filter-wrap" style="display:none;align-items:center;gap:8px;">
                    <label style="font-size:0.72rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;">Division</label>
                    <select id="gantt-div-select" style="padding:6px 12px;border-radius:999px;border:1px solid #d1d5db;font-size:0.84rem;background:#fff;">
                        <option value="">All Divisions</option>
                        ${divOptions}
                    </select>
                </div>
            </div>

            <div id="gantt-chart-area"></div>
        `;

        document.getElementById('gantt-date-select').onchange = e => {
            selectedDate = e.target.value;
            renderGantt();
        };

        document.getElementById('gantt-btn-field').onclick = () => setView('field');
        document.getElementById('gantt-btn-bunk').onclick = () => setView('bunk');

        const divSel = document.getElementById('gantt-div-select');
        if (divSel) divSel.onchange = () => renderGantt();

        renderGantt();
    }

    function setView(v) {
        currentView = v;
        ['field', 'bunk'].forEach(key => {
            const btn = document.getElementById(`gantt-btn-${key}`);
            if (!btn) return;
            const active = key === v;
            btn.style.background = active ? '#fff' : 'transparent';
            btn.style.color = active ? '#1e40af' : '#6b7280';
            btn.style.boxShadow = active ? '0 1px 4px rgba(0,0,0,0.12)' : 'none';
        });
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
                <div style="padding:56px 32px;text-align:center;color:#9ca3af;background:#f9fafb;border:1px dashed #d1d5db;border-radius:12px;">
                    <div style="font-size:2.5rem;margin-bottom:10px;">📋</div>
                    <div style="font-size:0.95rem;font-weight:600;color:#6b7280;">No schedule data for ${formatDateDisplay(selectedDate)}</div>
                    <div style="font-size:0.8rem;margin-top:6px;">Build or load a schedule first, then come back here.</div>
                </div>`;
            return;
        }

        if (currentView === 'field') {
            renderFieldGantt(area, items, startMin, endMin);
        } else {
            const divFilter = document.getElementById('gantt-div-select')?.value || '';
            renderBunkGantt(area, items, startMin, endMin, divFilter);
        }
    }

    // ========================================================================
    // SHARED GANTT PRIMITIVES
    // ========================================================================

    function buildTimeAxis(campStart, campEnd, totalMin) {
        const firstHour = Math.ceil(campStart / 60);
        const lastHour = Math.floor(campEnd / 60);
        let markers = '';
        for (let h = firstHour; h <= lastHour; h++) {
            const m = h * 60;
            if (m < campStart || m > campEnd) continue;
            const l = ((m - campStart) / totalMin * 100).toFixed(3);
            markers += `<span style="position:absolute;left:${l}%;transform:translateX(-50%);font-size:0.68rem;font-weight:600;color:#9ca3af;white-space:nowrap;">${minutesToShortLabel(m)}</span>`;
        }
        return `
            <div style="display:flex;margin-bottom:8px;">
                <div style="width:160px;min-width:160px;flex-shrink:0;"></div>
                <div style="flex:1;position:relative;height:16px;">${markers}</div>
            </div>`;
    }

    function buildGridLines(campStart, campEnd, totalMin) {
        const firstHour = Math.ceil(campStart / 60);
        const lastHour = Math.floor(campEnd / 60);
        let lines = '';
        for (let h = firstHour; h <= lastHour; h++) {
            const m = h * 60;
            if (m < campStart || m > campEnd) continue;
            const l = ((m - campStart) / totalMin * 100).toFixed(3);
            lines += `<div style="position:absolute;top:0;bottom:0;left:${l}%;width:1px;background:rgba(0,0,0,0.06);pointer-events:none;"></div>`;
        }
        return lines;
    }

    function buildBlock(item, campStart, totalMin, label, color) {
        const l = ((item.startMin - campStart) / totalMin * 100).toFixed(3);
        const w = Math.max(0.4, ((item.endMin - item.startMin) / totalMin * 100)).toFixed(3);
        const dur = item.endMin - item.startMin;
        const tip = `${item.bunk}: ${item.activity}${item.field ? ' @ ' + item.field : ''}\n${minutesToTimeLabel(item.startMin)} – ${minutesToTimeLabel(item.endMin)} (${dur} min)`;
        return `
            <div title="${tip.replace(/"/g, '&quot;')}"
                 style="position:absolute;top:5px;bottom:5px;left:${l}%;width:${w}%;
                        background:${color.bg};border:1.5px solid ${color.border};border-radius:5px;
                        display:flex;align-items:center;padding:0 6px;overflow:hidden;
                        cursor:default;box-sizing:border-box;min-width:2px;">
                <span style="font-size:0.68rem;font-weight:700;color:${color.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</span>
            </div>`;
    }

    function buildRow(leftLabel, trackHtml, isAlternate) {
        const rowBg = isAlternate ? '#fafafa' : '#ffffff';
        const trackBg = isAlternate ? '#f5f6f7' : '#f3f4f6';
        return `
            <div style="display:flex;align-items:stretch;margin-bottom:2px;min-height:42px;">
                <div style="width:160px;min-width:160px;padding:0 12px;display:flex;align-items:center;
                            font-size:0.78rem;font-weight:600;color:#374151;
                            border-right:2px solid #e9ecef;background:${rowBg};flex-shrink:0;
                            overflow:hidden;" title="${leftLabel}">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${leftLabel}</span>
                </div>
                <div style="flex:1;position:relative;background:${trackBg};min-height:42px;overflow:hidden;">
                    ${trackHtml}
                </div>
            </div>`;
    }

    function buildLegendSwatch(bg, border, label) {
        return `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;">
                    <span style="width:12px;height:12px;background:${bg};border:1.5px solid ${border};border-radius:3px;flex-shrink:0;"></span>
                    <span style="font-size:0.74rem;color:#6b7280;">${label}</span>
                </span>`;
    }

    // ========================================================================
    // BY FIELD GANTT
    // ========================================================================

    function renderFieldGantt(area, items, campStart, campEnd) {
        const gs = window.loadGlobalSettings?.() || {};
        const fields = (gs.app1?.fields || []).map(f => ({ name: f.name, type: 'field' }));
        const specials = (gs.app1?.specialActivities || []).map(s => ({ name: s.name, type: 'special' }));
        const resources = [...fields, ...specials].sort((a, b) => a.name.localeCompare(b.name));

        if (!resources.length) {
            area.innerHTML = `<div style="padding:32px;text-align:center;color:#9ca3af;">No fields or activities configured.</div>`;
            return;
        }

        const totalMin = campEnd - campStart;

        // Index items by field name and by special-activity name
        const byField = {};
        const bySpecial = {};
        items.forEach(item => {
            if (item.field) {
                (byField[item.field] = byField[item.field] || []).push(item);
            }
            if (item.isSpecial) {
                const arr = (bySpecial[item.activity] = bySpecial[item.activity] || []);
                const dup = arr.some(x => x.bunk === item.bunk && x.startMin === item.startMin);
                if (!dup) arr.push(item);
            }
        });

        let html = buildTimeAxis(campStart, campEnd, totalMin);

        resources.forEach((r, i) => {
            const usages = r.type === 'field' ? (byField[r.name] || []) : (bySpecial[r.name] || []);
            const icon = r.type === 'special' ? '⭐ ' : '🏟️ ';

            let track = buildGridLines(campStart, campEnd, totalMin);
            usages.forEach(item => {
                track += buildBlock(item, campStart, totalMin, item.bunk, getDivisionColor(item.division));
            });

            html += buildRow(icon + r.name, track, i % 2 === 1);
        });

        // Division colour legend
        const divNames = Object.keys(divisionsDat).sort();
        const legend = divNames.map((d, i) => {
            const c = DIV_COLORS[i % DIV_COLORS.length];
            return buildLegendSwatch(c.bg, c.border, d);
        }).join('');

        area.innerHTML = `
            <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,0.04);">
                <div style="padding:16px 20px 14px;">${html}</div>
                ${legend ? `<div style="padding:10px 20px 14px;border-top:1px solid #f3f4f6;display:flex;flex-wrap:wrap;align-items:center;gap:2px;">${legend}</div>` : ''}
            </div>`;
    }

    // ========================================================================
    // BY BUNK GANTT
    // ========================================================================

    function renderBunkGantt(area, items, campStart, campEnd, divFilter) {
        const totalMin = campEnd - campStart;

        const bunkMap = {};
        items.forEach(item => {
            (bunkMap[item.bunk] = bunkMap[item.bunk] || []).push(item);
        });

        const sportColor   = { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' };
        const specialColor = { bg: '#f3e8ff', border: '#9333ea', text: '#7e22ce' };

        const divs = divFilter
            ? (divisionsDat[divFilter] ? { [divFilter]: divisionsDat[divFilter] } : {})
            : divisionsDat;

        let html = buildTimeAxis(campStart, campEnd, totalMin);
        let rowCount = 0;
        let anyBunk = false;

        Object.entries(divs).forEach(([divName, divData]) => {
            if (!divData) return;
            const bunks = divData.bunks || [];
            if (!bunks.length) return;
            anyBunk = true;

            html += `
                <div style="margin:8px 0 4px;padding:3px 0;font-size:0.68rem;font-weight:700;
                            color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;
                            border-bottom:1px solid #e9ecef;">
                    ${divName}
                </div>`;

            bunks.forEach(bunk => {
                const usages = bunkMap[bunk] || [];
                let track = buildGridLines(campStart, campEnd, totalMin);
                usages.forEach(item => {
                    const color = item.isSpecial ? specialColor : sportColor;
                    track += buildBlock(item, campStart, totalMin, item.activity, color);
                });
                html += buildRow(bunk, track, rowCount % 2 === 1);
                rowCount++;
            });
        });

        if (!anyBunk) {
            area.innerHTML = `<div style="padding:32px;text-align:center;color:#9ca3af;">No bunks found for the selected division.</div>`;
            return;
        }

        const legend =
            buildLegendSwatch('#dbeafe', '#3b82f6', 'Sport') +
            buildLegendSwatch('#f3e8ff', '#9333ea', 'Special');

        area.innerHTML = `
            <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,0.04);">
                <div style="padding:16px 20px 14px;">${html}</div>
                <div style="padding:10px 20px 14px;border-top:1px solid #f3f4f6;display:flex;flex-wrap:wrap;align-items:center;">${legend}</div>
            </div>`;
    }

    // ========================================================================
    // BUNK ROTATION REPORT (unchanged logic)
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

        const divSelect = document.getElementById('rotation-div-select');
        availableDivisions.forEach(d => {
            divSelect.innerHTML += `<option value="${d}">${d}</option>`;
        });

        divSelect.onchange = () => {
            populateRotationBunkFilter(divSelect.value);
            renderRotationTable(divSelect.value);
        };
        document.getElementById('rotation-type-filter').onchange = () => renderRotationTable(divSelect.value);
        document.getElementById('rotation-bunk-filter').onchange = () => renderRotationTable(divSelect.value);

        let _timer = null;
        document.getElementById('rotation-activity-filter').oninput = () => {
            clearTimeout(_timer);
            _timer = setTimeout(() => renderRotationTable(divSelect.value), 300);
        };
    }

    function populateRotationBunkFilter(divName) {
        const sel = document.getElementById('rotation-bunk-filter');
        if (!sel) return;
        sel.innerHTML = '<option value="">All Bunks</option>';
        if (!divName) return;
        (divisionsDat[divName]?.bunks || []).forEach(b => {
            sel.innerHTML += `<option value="${b}">${b}</option>`;
        });
    }

    function renderRotationTable(divName) {
        const cont = document.getElementById('rotation-table-container');
        if (!divName) {
            cont.innerHTML = `<div style="padding:30px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:12px;border:1px dashed #d1d5db;">
                <span style="font-size:1.5em;">📋</span><br>
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
        const sortedDates = Object.keys(allDaily).sort();

        sortedDates.forEach(dateKey => {
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
                    const diff = Math.floor((new Date() - new Date(lastDate)) / 86400000);
                    if (diff === 0) daysSince = 'Today';
                    else if (diff === 1) daysSince = 'Yesterday';
                    else daysSince = `${diff}d ago`;
                }

                let rowBg = bunkBg;
                let totalStyle = 'font-weight:600;';
                if (act.max > 0 && total >= act.max) {
                    rowBg = '#fee2e2';
                    totalStyle += 'color:#b91c1c;';
                } else if (total === 0) {
                    totalStyle += 'color:#d97706;';
                }

                const typeIcon = act.type === 'special'
                    ? '<span style="background:#ddd6fe;color:#7c3aed;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">⭐</span>'
                    : '<span style="background:#dbeafe;color:#2563eb;padding:2px 6px;border-radius:999px;font-size:0.7rem;font-weight:600;">🏟️</span>';

                html += `
                    <tr style="background:${rowBg};">
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;position:sticky;left:0;background:${rowBg};font-weight:${isFirstRow ? '600' : '400'};color:#111827;">
                            ${isFirstRow ? bunk : ''}
                        </td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;color:#374151;">${act.name}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;">${typeIcon}</td>
                        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;color:#6b7280;">${hist}</td>
                        <td style="padding:4px 6px;border:1px solid #e5e7eb;text-align:center;">
                            <input type="number" class="rotation-adj-input"
                                data-bunk="${bunk}" data-act="${act.name}" value="${offset}"
                                style="width:45px;text-align:center;padding:4px;border:1px solid #d1d5db;border-radius:999px;font-size:0.8rem;" />
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
        html += buildRotationSummary(filteredBunks, filteredActivities, rawCounts, manualOffsets);
        cont.innerHTML = html;

        cont.querySelectorAll('.rotation-adj-input').forEach(inp => {
            inp.onchange = (e) => {
                const b = e.target.dataset.bunk;
                const a = e.target.dataset.act;
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
        const neverDone = [];
        const atLimit = [];

        bunks.forEach(bunk => {
            activities.forEach(act => {
                const total = Math.max(0, (rawCounts[bunk]?.[act.name] || 0) + (manualOffsets[bunk]?.[act.name] || 0));
                if (total === 0) neverDone.push({ bunk, activity: act.name });
                if (act.max > 0 && total >= act.max) atLimit.push({ bunk, activity: act.name, total, limit: act.max });
            });
        });

        let html = `
            <div class="setup-card" style="margin-top:16px;">
                <div class="setup-card-header">
                    <div class="setup-step-pill setup-step-pill-muted">Summary</div>
                    <div class="setup-card-text"><h3 style="margin:0;font-size:0.95rem;">Quick Stats</h3></div>
                </div>
        `;

        if (neverDone.length > 0) {
            html += `<div style="margin-bottom:10px;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:999px;">
                <strong style="color:#92400e;">⚠️ Never Done (${neverDone.length}):</strong>
                <span style="font-size:0.85em;color:#78350f;margin-left:6px;">${neverDone.slice(0, 8).map(n => `${n.bunk}→${n.activity}`).join(', ')}${neverDone.length > 8 ? '...' : ''}</span>
            </div>`;
        } else {
            html += `<div style="margin-bottom:10px;padding:10px 12px;background:#d1fae5;border:1px solid #10b981;border-radius:999px;">
                <strong style="color:#047857;">✅ All bunks have done all activities at least once!</strong>
            </div>`;
        }

        if (atLimit.length > 0) {
            html += `<div style="padding:10px 12px;background:#fee2e2;border:1px solid #ef4444;border-radius:999px;">
                <strong style="color:#b91c1c;">🛑 At Limit (${atLimit.length}):</strong>
                <span style="font-size:0.85em;color:#7f1d1d;margin-left:6px;">${atLimit.map(a => `${a.bunk}→${a.activity}`).join(', ')}</span>
            </div>`;
        }

        html += `</div>`;
        return html;
    }

    // ========================================================================
    // DATE FORMATTER
    // ========================================================================

    function formatDateDisplay(dateKey) {
        if (!dateKey) return '';
        try {
            return new Date(dateKey + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (e) {
            return dateKey;
        }
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    window.initReportTab = initReportTab;

    window.debugAnalytics = {
        buildUsageData,
        getCampTimes
    };

})();
