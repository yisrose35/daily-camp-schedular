// =========================================================================
// schedule_calendar_views.js — Multi-View Calendar (Year / Month / Week / Day)
// =========================================================================
// Integrates into the #schedule tab. Adds a view switcher toolbar.
// Year / Month / Week views are rendered by this module.
// Day view delegates to the existing UnifiedScheduleSystem.renderStaggeredView.
// Reads schedule data from campDailyData_v1 localStorage + window.scheduleAssignments.
// Syncs with #calendar-date-picker and campistry-date-changed events.
// =========================================================================

(function () {
    'use strict';

    // ── Constants ────────────────────────────────────────────────────────
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const EVENT_COLORS = {
        swim:      { color: '#0284c7', bg: '#e0f2fe', icon: '~' },
        league:    { color: '#059669', bg: '#d1fae5', icon: '●' },
        special:   { color: '#7c3aed', bg: '#ede9fe', icon: '★' },
        sport:     { color: '#ea580c', bg: '#fff7ed', icon: '▲' },
        lunch:     { color: '#d97706', bg: '#fffbeb', icon: '◉' },
        snack:     { color: '#d97706', bg: '#fffbeb', icon: '◉' },
        dismissal: { color: '#64748b', bg: '#f1f5f9', icon: '▪' },
        free:      { color: '#94a3b8', bg: '#f8fafc', icon: '○' },
        pinned:    { color: '#b45309', bg: '#fef3c7', icon: '◆' },
        default:   { color: '#475569', bg: '#f1f5f9', icon: '•' },
    };

    // ── State ────────────────────────────────────────────────────────────
    let _currentView = 'day'; // year | month | week | day
    let _viewYear = null;
    let _viewMonth = null;
    let _viewDay = null;
    let _initialized = false;
    let _toolbar = null;
    let _calendarContainer = null;
    let _originalUpdateTable = null;

    // ── Helpers ──────────────────────────────────────────────────────────
    function getDateKey(y, m, d) {
        return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    function parseCurrentDate() {
        const picker = document.getElementById('calendar-date-picker');
        const val = picker?.value || window.currentScheduleDate || new Date().toISOString().split('T')[0];
        const parts = val.split('-');
        return { y: parseInt(parts[0]), m: parseInt(parts[1]) - 1, d: parseInt(parts[2]) };
    }

    function setPickerDate(y, m, d) {
        const key = getDateKey(y, m, d);
        const picker = document.getElementById('calendar-date-picker');
        if (picker && picker.value !== key) {
            picker.value = key;
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        }
        window.currentScheduleDate = key;
    }

    function isToday(y, m, d) {
        const t = new Date();
        return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d;
    }

    function minutesToTime(min) {
        const h = Math.floor(min / 60);
        const m = min % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hh = h % 12 || 12;
        return hh + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    }

    // ── Data Layer ──────────────────────────────────────────────────────
    // Pull schedule data for a given dateKey from localStorage
    function getScheduleDataForDate(dateKey) {
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            if (!raw) return null;
            const all = JSON.parse(raw);
            return all[dateKey] || null;
        } catch (e) { return null; }
    }

    // Get all dateKeys that have schedule data
    function getAllScheduledDates() {
        try {
            const raw = localStorage.getItem('campDailyData_v1');
            if (!raw) return {};
            return JSON.parse(raw);
        } catch (e) { return {}; }
    }

    // Extract summary events from schedule data for a given date
    function getEventSummary(dateKey) {
        const data = getScheduleDataForDate(dateKey);
        if (!data) return [];

        const events = [];
        const assignments = data.scheduleAssignments || {};
        const divisions = window.divisions || {};
        const divColors = {};
        Object.keys(divisions).forEach(d => {
            divColors[d] = divisions[d]?.color || '#64748b';
        });

        // Walk each bunk's timeline
        Object.entries(assignments).forEach(([bunkName, slots]) => {
            if (!Array.isArray(slots)) return;
            // Find which division this bunk belongs to
            let divName = '';
            Object.entries(divisions).forEach(([dName, dConf]) => {
                if (dConf.bunks && dConf.bunks.includes(bunkName)) divName = dName;
            });

            slots.forEach(slot => {
                if (!slot || !slot.activity) return;
                const act = (slot.activity || '').toLowerCase();
                if (act === 'free' || act === 'free play' || !act) return;

                let type = 'default';
                if (act.includes('swim') || act.includes('pool')) type = 'swim';
                else if (act.includes('league')) type = 'league';
                else if (act.includes('lunch')) type = 'lunch';
                else if (act.includes('snack')) type = 'snack';
                else if (act.includes('dismissal')) type = 'dismissal';
                else if (slot._isSpecial || slot._type === 'special') type = 'special';
                else if (slot._type === 'sport' || slot._type === 'sport_slot') type = 'sport';

                events.push({
                    type: type,
                    activity: slot.activity,
                    division: divName,
                    divColor: divColors[divName] || '#64748b',
                    startMin: slot.startMin || 0,
                    endMin: slot.endMin || 0,
                    bunk: bunkName,
                });
            });
        });

        return events;
    }

    // Deduplicate events for display (group by activity + time + division)
    function dedupeEvents(events) {
        const seen = {};
        const result = [];
        events.forEach(ev => {
            const key = `${ev.type}|${ev.activity}|${ev.startMin}|${ev.division}`;
            if (!seen[key]) {
                seen[key] = true;
                result.push(ev);
            }
        });
        // Sort by startMin
        result.sort((a, b) => a.startMin - b.startMin);
        return result;
    }

    // ── Division Colors ─────────────────────────────────────────────────
    function getDivisionColors() {
        const divisions = window.divisions || {};
        const colors = {};
        Object.keys(divisions).forEach(d => {
            colors[d] = divisions[d]?.color || '#64748b';
        });
        return colors;
    }

    // ── Toolbar ─────────────────────────────────────────────────────────
    function createToolbar() {
        const bar = document.createElement('div');
        bar.id = 'scv-toolbar';
        bar.innerHTML = `
            <div class="scv-toolbar-inner">
                <div class="scv-nav-group">
                    <button class="scv-nav-btn" data-action="prev">‹</button>
                    <h3 class="scv-header-label" id="scv-header-label"></h3>
                    <button class="scv-nav-btn" data-action="next">›</button>
                    <button class="scv-today-btn" data-action="today">Today</button>
                </div>
                <div class="scv-view-switcher">
                    <button class="scv-view-btn" data-view="year">Year</button>
                    <button class="scv-view-btn" data-view="month">Month</button>
                    <button class="scv-view-btn" data-view="week">Week</button>
                    <button class="scv-view-btn active" data-view="day">Day</button>
                </div>
                <button class="scv-validate-btn" onclick="window.validateSchedule?.()">Validate</button>
            </div>
        `;

        // Nav buttons
        bar.querySelector('[data-action="prev"]').onclick = () => navigate(-1);
        bar.querySelector('[data-action="next"]').onclick = () => navigate(1);
        bar.querySelector('[data-action="today"]').onclick = goToToday;

        // View buttons
        bar.querySelectorAll('.scv-view-btn').forEach(btn => {
            btn.onclick = () => switchView(btn.dataset.view);
        });

        return bar;
    }

    function updateToolbarLabel() {
        const label = document.getElementById('scv-header-label');
        if (!label) return;

        if (_currentView === 'year') {
            label.textContent = `${_viewYear}`;
        } else if (_currentView === 'month') {
            label.textContent = `${MONTHS[_viewMonth]} ${_viewYear}`;
        } else if (_currentView === 'week') {
            const start = new Date(_viewYear, _viewMonth, _viewDay);
            start.setDate(start.getDate() - start.getDay());
            const end = new Date(start);
            end.setDate(end.getDate() + 6);
            if (start.getMonth() === end.getMonth()) {
                label.textContent = `${SHORT_MONTHS[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
            } else {
                label.textContent = `${SHORT_MONTHS[start.getMonth()]} ${start.getDate()} – ${SHORT_MONTHS[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
            }
        } else {
            label.textContent = `${DAYS_FULL[new Date(_viewYear, _viewMonth, _viewDay).getDay()]}, ${MONTHS[_viewMonth]} ${_viewDay}, ${_viewYear}`;
        }

        // Update active button
        if (_toolbar) {
            _toolbar.querySelectorAll('.scv-view-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.view === _currentView);
            });
        }
    }

    // ── Navigation ──────────────────────────────────────────────────────
    function navigate(dir) {
        if (_currentView === 'year') {
            _viewYear += dir;
        } else if (_currentView === 'month') {
            _viewMonth += dir;
            if (_viewMonth < 0) { _viewMonth = 11; _viewYear--; }
            if (_viewMonth > 11) { _viewMonth = 0; _viewYear++; }
        } else if (_currentView === 'week') {
            const d = new Date(_viewYear, _viewMonth, _viewDay + dir * 7);
            _viewYear = d.getFullYear(); _viewMonth = d.getMonth(); _viewDay = d.getDate();
        } else {
            const d = new Date(_viewYear, _viewMonth, _viewDay + dir);
            _viewYear = d.getFullYear(); _viewMonth = d.getMonth(); _viewDay = d.getDate();
            setPickerDate(_viewYear, _viewMonth, _viewDay);
        }
        render();
    }

    function goToToday() {
        const t = new Date();
        _viewYear = t.getFullYear(); _viewMonth = t.getMonth(); _viewDay = t.getDate();
        setPickerDate(_viewYear, _viewMonth, _viewDay);
        render();
    }

    function switchView(view) {
        _currentView = view;
        if (view === 'day') {
            setPickerDate(_viewYear, _viewMonth, _viewDay);
        }
        render();
    }

    function drillDown(y, m, d) {
        _viewYear = y;
        _viewMonth = m;
        if (d !== undefined) _viewDay = d;

        if (_currentView === 'year') {
            _currentView = 'month';
        } else if (_currentView === 'month') {
            _viewDay = d;
            _currentView = 'week';
        } else if (_currentView === 'week') {
            _viewDay = d;
            _currentView = 'day';
            setPickerDate(_viewYear, _viewMonth, _viewDay);
        }
        render();
    }

    // ── Main Render ─────────────────────────────────────────────────────
    function render() {
        updateToolbarLabel();

        if (_currentView === 'day') {
            // Show #scheduleTable, delegate to original
            if (_calendarContainer) _calendarContainer.style.display = 'none';
            const st = document.getElementById('scheduleTable');
            if (st) {
                st.style.display = '';
                // Call original updateTable
                if (_originalUpdateTable) _originalUpdateTable();
                else if (window.UnifiedScheduleSystem?.updateTable) window.UnifiedScheduleSystem.updateTable();
            }
            return;
        }

        // Hide scheduleTable, show our container
        const st = document.getElementById('scheduleTable');
        if (st) st.style.display = 'none';
        if (!_calendarContainer) {
            _calendarContainer = document.createElement('div');
            _calendarContainer.id = 'scv-calendar-container';
            st?.parentNode?.insertBefore(_calendarContainer, st.nextSibling);
        }
        _calendarContainer.style.display = '';
        _calendarContainer.innerHTML = '';

        if (_currentView === 'year') renderYearView();
        else if (_currentView === 'month') renderMonthView();
        else if (_currentView === 'week') renderWeekView();
    }

    // ── YEAR VIEW ───────────────────────────────────────────────────────
    function renderYearView() {
        const allData = getAllScheduledDates();
        const grid = document.createElement('div');
        grid.className = 'scv-year-grid';

        for (let mi = 0; mi < 12; mi++) {
            const daysInMonth = new Date(_viewYear, mi + 1, 0).getDate();
            const firstDow = new Date(_viewYear, mi, 1).getDay();

            // Find which days have data
            const daysWithData = new Set();
            for (let d = 1; d <= daysInMonth; d++) {
                const key = getDateKey(_viewYear, mi, d);
                if (allData[key] && allData[key].scheduleAssignments && Object.keys(allData[key].scheduleAssignments).length > 0) {
                    daysWithData.add(d);
                }
            }

            const card = document.createElement('div');
            card.className = 'scv-year-month-card';
            card.onclick = () => drillDown(_viewYear, mi);

            let html = `<div class="scv-year-month-name">${MONTHS[mi]}</div>`;
            html += '<div class="scv-year-mini-grid">';
            // Day headers
            for (let i = 0; i < 7; i++) {
                html += `<div class="scv-year-mini-hdr">${DAYS[i][0]}</div>`;
            }
            // Blank spacers
            for (let i = 0; i < firstDow; i++) {
                html += '<div class="scv-year-mini-day empty"></div>';
            }
            // Days
            for (let d = 1; d <= daysInMonth; d++) {
                const today = isToday(_viewYear, mi, d);
                const hasData = daysWithData.has(d);
                let cls = 'scv-year-mini-day';
                if (today) cls += ' today';
                html += `<div class="${cls}">${d}${hasData && !today ? '<span class="scv-dot"></span>' : ''}</div>`;
            }
            html += '</div>';
            card.innerHTML = html;
            grid.appendChild(card);
        }

        _calendarContainer.appendChild(grid);
    }

    // ── MONTH VIEW ──────────────────────────────────────────────────────
    function renderMonthView() {
        const allData = getAllScheduledDates();
        const daysInMonth = new Date(_viewYear, _viewMonth + 1, 0).getDate();
        const firstDow = new Date(_viewYear, _viewMonth, 1).getDay();
        const prevMonthDays = new Date(_viewYear, _viewMonth, 0).getDate();
        const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

        const wrapper = document.createElement('div');
        wrapper.className = 'scv-month-wrapper';

        // Day headers
        let headerHtml = '<div class="scv-month-header-row">';
        DAYS.forEach(d => { headerHtml += `<div class="scv-month-hdr">${d}</div>`; });
        headerHtml += '</div>';
        wrapper.innerHTML = headerHtml;

        const grid = document.createElement('div');
        grid.className = 'scv-month-grid';

        for (let i = 0; i < totalCells; i++) {
            const dayNum = i - firstDow + 1;
            const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
            const display = inMonth ? dayNum : dayNum < 1 ? prevMonthDays + dayNum : dayNum - daysInMonth;
            const today = inMonth && isToday(_viewYear, _viewMonth, dayNum);
            const dow = i % 7;
            const isWeekend = dow === 0 || dow === 6;

            const cell = document.createElement('div');
            cell.className = 'scv-month-cell' + (inMonth ? '' : ' outside') + (isWeekend ? ' weekend' : '') + (today ? ' today' : '');

            if (inMonth) {
                cell.onclick = () => drillDown(_viewYear, _viewMonth, dayNum);
                cell.style.cursor = 'pointer';
            }

            // Day number
            let inner = '';
            if (today) {
                inner += `<span class="scv-month-day-num today-badge">${display}</span>`;
            } else {
                inner += `<span class="scv-month-day-num">${display}</span>`;
            }

            // Events for this day
            if (inMonth) {
                const dateKey = getDateKey(_viewYear, _viewMonth, dayNum);
                const events = dedupeEvents(getEventSummary(dateKey));
                const maxShow = 3;

                events.slice(0, maxShow).forEach(ev => {
                    const ec = EVENT_COLORS[ev.type] || EVENT_COLORS.default;
                    inner += `<div class="scv-month-event" style="background:${ec.bg};color:${ec.color};border-left:3px solid ${ec.color};">${ec.icon} ${escapeHtml(ev.activity)}</div>`;
                });
                if (events.length > maxShow) {
                    inner += `<div class="scv-month-more">+${events.length - maxShow} more</div>`;
                }
            }

            cell.innerHTML = inner;
            grid.appendChild(cell);
        }

        wrapper.appendChild(grid);
        _calendarContainer.appendChild(wrapper);
    }

    // ── WEEK VIEW ───────────────────────────────────────────────────────
    function renderWeekView() {
        const current = new Date(_viewYear, _viewMonth, _viewDay);
        const startOfWeek = new Date(current);
        startOfWeek.setDate(current.getDate() - current.getDay());

        const weekDays = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(startOfWeek);
            d.setDate(startOfWeek.getDate() + i);
            weekDays.push(d);
        }

        const START_HOUR = 8;
        const END_HOUR = 17;
        const HOUR_H = 56; // px per hour
        const totalH = (END_HOUR - START_HOUR) * HOUR_H;

        const wrapper = document.createElement('div');
        wrapper.className = 'scv-week-wrapper';

        // Header row
        let headerHtml = '<div class="scv-week-header"><div class="scv-week-gutter-hdr"></div>';
        weekDays.forEach(wd => {
            const today = isToday(wd.getFullYear(), wd.getMonth(), wd.getDate());
            headerHtml += `<div class="scv-week-day-hdr${today ? ' today' : ''}" data-y="${wd.getFullYear()}" data-m="${wd.getMonth()}" data-d="${wd.getDate()}">
                <span class="scv-week-day-name">${DAYS[wd.getDay()]}</span>
                <span class="scv-week-day-num${today ? ' today-badge' : ''}">${wd.getDate()}</span>
            </div>`;
        });
        headerHtml += '</div>';
        wrapper.innerHTML = headerHtml;

        // Click handlers on headers
        wrapper.querySelectorAll('.scv-week-day-hdr').forEach(hdr => {
            hdr.style.cursor = 'pointer';
            hdr.onclick = () => {
                drillDown(parseInt(hdr.dataset.y), parseInt(hdr.dataset.m), parseInt(hdr.dataset.d));
            };
        });

        // Body grid
        const body = document.createElement('div');
        body.className = 'scv-week-body';
        body.style.height = totalH + 'px';

        // Time gutter
        let gutterHtml = '<div class="scv-week-gutter">';
        for (let h = START_HOUR; h < END_HOUR; h++) {
            gutterHtml += `<div class="scv-week-time" style="top:${(h - START_HOUR) * HOUR_H}px;">${minutesToTime(h * 60).replace(':00 ', ' ')}</div>`;
        }
        gutterHtml += '</div>';
        body.innerHTML = gutterHtml;

        // Day columns
        weekDays.forEach(wd => {
            const col = document.createElement('div');
            col.className = 'scv-week-col';

            // Hour lines
            for (let h = START_HOUR; h < END_HOUR; h++) {
                const line = document.createElement('div');
                line.className = 'scv-week-hour-line';
                line.style.top = (h - START_HOUR) * HOUR_H + 'px';
                col.appendChild(line);
            }

            // Events
            const dateKey = getDateKey(wd.getFullYear(), wd.getMonth(), wd.getDate());
            const events = dedupeEvents(getEventSummary(dateKey));

            events.forEach(ev => {
                if (ev.startMin < START_HOUR * 60 || ev.startMin >= END_HOUR * 60) return;
                const topPx = (ev.startMin - START_HOUR * 60) * (HOUR_H / 60);
                const dur = Math.max(ev.endMin - ev.startMin, 15);
                const heightPx = Math.max(dur * (HOUR_H / 60) - 2, 14);
                const ec = EVENT_COLORS[ev.type] || EVENT_COLORS.default;

                const block = document.createElement('div');
                block.className = 'scv-week-event';
                block.style.cssText = `top:${topPx}px;height:${heightPx}px;background:${ec.bg};border-left:3px solid ${ec.color};color:${ec.color};`;
                block.innerHTML = `<div class="scv-week-event-title">${escapeHtml(ev.activity)}</div>`;
                if (heightPx > 22) {
                    block.innerHTML += `<div class="scv-week-event-time">${minutesToTime(ev.startMin)}</div>`;
                }
                col.appendChild(block);
            });

            // Now line
            if (isToday(wd.getFullYear(), wd.getMonth(), wd.getDate())) {
                const now = new Date();
                const nowMin = now.getHours() * 60 + now.getMinutes();
                if (nowMin >= START_HOUR * 60 && nowMin < END_HOUR * 60) {
                    const nowTop = (nowMin - START_HOUR * 60) * (HOUR_H / 60);
                    const nowLine = document.createElement('div');
                    nowLine.className = 'scv-now-line';
                    nowLine.style.top = nowTop + 'px';
                    nowLine.innerHTML = '<div class="scv-now-dot"></div><div class="scv-now-bar"></div>';
                    col.appendChild(nowLine);
                }
            }

            body.appendChild(col);
        });

        wrapper.appendChild(body);
        _calendarContainer.appendChild(wrapper);
    }

    // ── Escape HTML ─────────────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── CSS ─────────────────────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('scv-styles')) return;
        const style = document.createElement('style');
        style.id = 'scv-styles';
        style.textContent = `
/* ═══════════════════════════════════════════════════════════════════
   SCHEDULE CALENDAR VIEWS — Styles
   ═══════════════════════════════════════════════════════════════════ */

/* ── Toolbar ─────────────────────────────────────────── */
#scv-toolbar {
    margin-bottom: 16px;
}
.scv-toolbar-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
}
.scv-nav-group {
    display: flex;
    align-items: center;
    gap: 8px;
}
.scv-header-label {
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--slate-900, #0f172a);
    margin: 0;
    min-width: 220px;
    text-align: center;
    user-select: none;
}
.scv-nav-btn {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--slate-300, #cbd5e1);
    border-radius: 6px;
    background: #fff;
    font-size: 18px;
    color: var(--slate-700, #334155);
    cursor: pointer;
    transition: background 0.15s;
}
.scv-nav-btn:hover { background: var(--slate-100, #f1f5f9); }

.scv-today-btn {
    padding: 4px 14px;
    border: 1px solid var(--slate-300, #cbd5e1);
    border-radius: 6px;
    background: #fff;
    font-size: 13px;
    font-weight: 500;
    color: var(--slate-700, #334155);
    cursor: pointer;
    transition: background 0.15s;
}
.scv-today-btn:hover { background: var(--slate-100, #f1f5f9); }

.scv-view-switcher {
    display: flex;
    gap: 0;
    background: var(--slate-100, #f1f5f9);
    border-radius: 8px;
    padding: 3px;
}
.scv-view-btn {
    padding: 5px 16px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--slate-500, #64748b);
    background: transparent;
    cursor: pointer;
    transition: all 0.15s;
}
.scv-view-btn:hover { color: var(--slate-700, #334155); }
.scv-view-btn.active {
    background: #fff;
    color: var(--slate-900, #0f172a);
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

.scv-validate-btn {
    padding: 6px 16px;
    border: none;
    border-radius: 6px;
    background: #ff9800;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
}
.scv-validate-btn:hover { opacity: 0.85; }

/* ── Year View ───────────────────────────────────────── */
.scv-year-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
}
@media (max-width: 900px) { .scv-year-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 600px) { .scv-year-grid { grid-template-columns: repeat(2, 1fr); } }

.scv-year-month-card {
    padding: 12px;
    border: 1px solid var(--slate-200, #e2e8f0);
    border-radius: 10px;
    background: #fff;
    cursor: pointer;
    transition: box-shadow 0.15s, border-color 0.15s;
}
.scv-year-month-card:hover {
    box-shadow: 0 2px 10px rgba(0,0,0,0.06);
    border-color: var(--camp-green, #147D91);
}
.scv-year-month-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--slate-800, #1e293b);
    margin-bottom: 8px;
}
.scv-year-mini-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
    text-align: center;
}
.scv-year-mini-hdr {
    font-size: 9px;
    font-weight: 600;
    color: var(--slate-400, #94a3b8);
    line-height: 16px;
}
.scv-year-mini-day {
    font-size: 10px;
    line-height: 20px;
    color: var(--slate-600, #475569);
    border-radius: 50%;
    position: relative;
}
.scv-year-mini-day.empty { visibility: hidden; }
.scv-year-mini-day.today {
    background: var(--camp-green, #147D91);
    color: #fff;
    font-weight: 700;
}
.scv-dot {
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--camp-green, #147D91);
}

/* ── Month View ──────────────────────────────────────── */
.scv-month-wrapper {
    border: 1px solid var(--slate-200, #e2e8f0);
    border-radius: 10px;
    overflow: hidden;
    background: #fff;
}
.scv-month-header-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid var(--slate-200, #e2e8f0);
}
.scv-month-hdr {
    padding: 8px 0;
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    color: var(--slate-500, #64748b);
    background: var(--slate-50, #f8fafc);
}
.scv-month-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
}
.scv-month-cell {
    min-height: 100px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--slate-100, #f1f5f9);
    border-right: 1px solid var(--slate-100, #f1f5f9);
    transition: background 0.1s;
    overflow: hidden;
}
.scv-month-cell:nth-child(7n) { border-right: none; }
.scv-month-cell:hover { background: var(--slate-50, #f8fafc); }
.scv-month-cell.outside { opacity: 0.35; }
.scv-month-cell.weekend { background: var(--slate-50, #f8fafc); }
.scv-month-cell.weekend:hover { background: var(--slate-100, #f1f5f9); }

.scv-month-day-num {
    font-size: 12px;
    font-weight: 500;
    color: var(--slate-700, #334155);
    display: inline-block;
    margin-bottom: 4px;
}
.scv-month-cell.outside .scv-month-day-num { color: var(--slate-400, #94a3b8); }

.today-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--camp-green, #147D91);
    color: #fff !important;
    font-weight: 700;
    font-size: 11px;
}

.scv-month-event {
    font-size: 10px;
    line-height: 16px;
    padding: 1px 5px;
    border-radius: 4px;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
}
.scv-month-more {
    font-size: 10px;
    color: var(--slate-400, #94a3b8);
    padding-left: 5px;
}

/* ── Week View ───────────────────────────────────────── */
.scv-week-wrapper {
    border: 1px solid var(--slate-200, #e2e8f0);
    border-radius: 10px;
    overflow: hidden;
    background: #fff;
}
.scv-week-header {
    display: grid;
    grid-template-columns: 56px repeat(7, 1fr);
    border-bottom: 1px solid var(--slate-200, #e2e8f0);
}
.scv-week-gutter-hdr {
    background: var(--slate-50, #f8fafc);
}
.scv-week-day-hdr {
    padding: 8px 4px;
    text-align: center;
    background: var(--slate-50, #f8fafc);
    border-left: 1px solid var(--slate-100, #f1f5f9);
    transition: background 0.1s;
}
.scv-week-day-hdr:hover { background: var(--slate-100, #f1f5f9); }
.scv-week-day-hdr.today { background: rgba(20, 125, 145, 0.06); }
.scv-week-day-name {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--slate-500, #64748b);
}
.scv-week-day-num {
    display: inline-block;
    font-size: 16px;
    font-weight: 500;
    color: var(--slate-800, #1e293b);
    margin-top: 2px;
}
.scv-week-day-num.today-badge {
    font-size: 13px;
}

.scv-week-body {
    display: grid;
    grid-template-columns: 56px repeat(7, 1fr);
    position: relative;
    overflow-y: auto;
    max-height: 65vh;
}
.scv-week-gutter {
    position: relative;
    background: var(--slate-50, #f8fafc);
}
.scv-week-time {
    position: absolute;
    right: 8px;
    font-size: 10px;
    color: var(--slate-400, #94a3b8);
    line-height: 1;
    transform: translateY(-6px);
}
.scv-week-col {
    position: relative;
    border-left: 1px solid var(--slate-100, #f1f5f9);
}
.scv-week-hour-line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid var(--slate-100, #f1f5f9);
}
.scv-week-event {
    position: absolute;
    left: 2px;
    right: 2px;
    border-radius: 4px;
    padding: 2px 5px;
    font-size: 10px;
    overflow: hidden;
    cursor: default;
    font-weight: 500;
    transition: opacity 0.1s;
    z-index: 2;
}
.scv-week-event:hover { opacity: 0.8; }
.scv-week-event-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 14px;
}
.scv-week-event-time {
    font-size: 9px;
    opacity: 0.7;
}

/* Now line */
.scv-now-line {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 5;
    display: flex;
    align-items: center;
}
.scv-now-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ef4444;
    margin-left: -4px;
    flex-shrink: 0;
}
.scv-now-bar {
    flex: 1;
    height: 2px;
    background: #ef4444;
}

/* ── Responsive ──────────────────────────────────────── */
@media (max-width: 768px) {
    .scv-toolbar-inner { flex-direction: column; align-items: flex-start; }
    .scv-header-label { min-width: unset; text-align: left; font-size: 1rem; }
    .scv-month-cell { min-height: 70px; }
    .scv-month-event { font-size: 9px; }
    .scv-week-body { max-height: 50vh; }
}
        `;
        document.head.appendChild(style);
    }

    // ── Init ────────────────────────────────────────────────────────────
    function init() {
        if (_initialized) return;
        _initialized = true;

        injectStyles();

        const scheduleTab = document.getElementById('schedule');
        if (!scheduleTab) {
            console.warn('[CalendarViews] #schedule tab not found, retrying...');
            _initialized = false;
            setTimeout(init, 1000);
            return;
        }

        // Sync initial date
        const { y, m, d } = parseCurrentDate();
        _viewYear = y; _viewMonth = m; _viewDay = d;

        // Replace the old header row with our toolbar
        const oldHeader = scheduleTab.querySelector('div:first-child');
        if (oldHeader && oldHeader.querySelector('h3')) {
            _toolbar = createToolbar();
            oldHeader.parentNode.replaceChild(_toolbar, oldHeader);
        }

        // Hook updateTable — intercept when in non-day view
        if (window.updateTable && !window.updateTable._scvPatched) {
            _originalUpdateTable = window.updateTable;
            window.updateTable = function () {
                // Sync date from picker
                const { y, m, d } = parseCurrentDate();
                _viewYear = y; _viewMonth = m; _viewDay = d;

                if (_currentView === 'day') {
                    _originalUpdateTable();
                } else {
                    render();
                }
            };
            window.updateTable._scvPatched = true;
        }

        // Listen for date picker changes
        window.addEventListener('campistry-date-changed', (e) => {
            const dateKey = e.detail?.dateKey;
            if (dateKey) {
                const parts = dateKey.split('-');
                _viewYear = parseInt(parts[0]);
                _viewMonth = parseInt(parts[1]) - 1;
                _viewDay = parseInt(parts[2]);
                if (_currentView === 'day') render();
            }
        });

        // Initial render
        updateToolbarLabel();
        console.log('[CalendarViews] ✅ Initialized — view:', _currentView);
    }

    // ── Public API ──────────────────────────────────────────────────────
    window.ScheduleCalendarViews = {
        init: init,
        switchView: switchView,
        render: render,
        getView: () => _currentView,
    };

    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    } else {
        setTimeout(init, 500);
    }

})();
