// =========================================================================
// schedule_calendar_views.js — Multi-View Calendar (Year / Month / Week / Day)
// =========================================================================
// v2.0 — Fixes: robust updateTable capture, proper orchestrator date load,
//         division filter for all views
// =========================================================================

(function () {
    'use strict';

    const LOG = '[CalendarViews]';

    // ── Constants ────────────────────────────────────────────────────────
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const EVENT_COLORS = {
        swim:      { color: '#0284c7', bg: '#e0f2fe', icon: '~' },
        league:    { color: '#059669', bg: '#d1fae5', icon: '\u25CF' },
        special:   { color: '#7c3aed', bg: '#ede9fe', icon: '\u2605' },
        sport:     { color: '#ea580c', bg: '#fff7ed', icon: '\u25B2' },
        trip:      { color: '#db2777', bg: '#fce7f3', icon: '\u279A' },
        lunch:     { color: '#d97706', bg: '#fffbeb', icon: '\u25C9' },
        snack:     { color: '#d97706', bg: '#fffbeb', icon: '\u25C9' },
        dismissal: { color: '#64748b', bg: '#f1f5f9', icon: '\u25AA' },
        free:      { color: '#94a3b8', bg: '#f8fafc', icon: '\u25CB' },
        pinned:    { color: '#b45309', bg: '#fef3c7', icon: '\u25C6' },
        default:   { color: '#475569', bg: '#f1f5f9', icon: '\u2022' },
    };

    // ── State ────────────────────────────────────────────────────────────
    let _currentView = 'day';
    let _viewYear = null;
    let _viewMonth = null;
    let _viewDay = null;
    let _selectedDivision = 'all';
    let _initialized = false;
    let _toolbar = null;
    let _calendarContainer = null;
    let _originalUpdateTable = null;
    let _patchAttempts = 0;

    // ── Helpers ──────────────────────────────────────────────────────────
    function getDateKey(y, m, d) {
        return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }

    function parseCurrentDate() {
        var picker = document.getElementById('calendar-date-picker');
        var val = (picker && picker.value) || window.currentScheduleDate || new Date().toISOString().split('T')[0];
        var parts = val.split('-');
        return { y: parseInt(parts[0]), m: parseInt(parts[1]) - 1, d: parseInt(parts[2]) };
    }

    function isToday(y, m, d) {
        var t = new Date();
        return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d;
    }

    function minutesToTime(min) {
        var h = Math.floor(min / 60);
        var m = min % 60;
        var ampm = h >= 12 ? 'PM' : 'AM';
        var hh = h % 12 || 12;
        return hh + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Division Helpers ────────────────────────────────────────────────
    function getDivisions() { return window.divisions || {}; }

    function getDivisionList() {
        return Object.keys(getDivisions()).sort(function (a, b) {
            var numA = parseInt(a), numB = parseInt(b);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return String(a).localeCompare(String(b));
        });
    }

    function getBunksForDivision(divName) {
        var divs = getDivisions();
        return (divs[divName] && divs[divName].bunks) || [];
    }

    function getDivisionForBunk(bunkName) {
        var divs = getDivisions();
        for (var dName in divs) {
            if (divs[dName].bunks && divs[dName].bunks.indexOf(bunkName) !== -1) return dName;
        }
        return '';
    }

    // ── Data Layer ──────────────────────────────────────────────────────
    function getAllDailyData() {
        try {
            var raw = localStorage.getItem('campDailyData_v1');
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function getScheduleDataForDate(dateKey) {
        var all = getAllDailyData();
        return all[dateKey] || null;
    }

    function getEventSummary(dateKey) {
        var data = getScheduleDataForDate(dateKey);
        if (!data) return [];
        var events = [];
        var assignments = data.scheduleAssignments || {};

        Object.keys(assignments).forEach(function (bunkName) {
            var slots = assignments[bunkName];
            if (!Array.isArray(slots)) return;
            var divName = getDivisionForBunk(bunkName);
            if (_selectedDivision !== 'all' && divName !== _selectedDivision) return;

            slots.forEach(function (slot) {
                if (!slot || !slot.activity) return;
                var act = (slot.activity || '').toLowerCase();
                if (act === 'free' || act === 'free play' || !act) return;

                var type = 'default';
                if (act.indexOf('swim') !== -1 || act.indexOf('pool') !== -1) type = 'swim';
                else if (act.indexOf('league') !== -1) type = 'league';
                else if (act.indexOf('lunch') !== -1) type = 'lunch';
                else if (act.indexOf('snack') !== -1) type = 'snack';
                else if (act.indexOf('dismissal') !== -1) type = 'dismissal';
                else if (slot._isSpecial || slot._type === 'special' || slot._type === 'special_slot') type = 'special';
                else if (slot._type === 'sport' || slot._type === 'sport_slot') type = 'sport';

                events.push({
                    type: type,
                    activity: slot.activity,
                    division: divName,
                    divColor: (getDivisions()[divName] || {}).color || '#64748b',
                    startMin: slot.startMin || 0,
                    endMin: slot.endMin || 0,
                    bunk: bunkName,
                });
            });
        });
        return events;
    }

    function dedupeEvents(events) {
        var seen = {};
        var result = [];
        events.forEach(function (ev) {
            var key = ev.type + '|' + ev.activity + '|' + ev.startMin + '|' + ev.division;
            if (!seen[key]) { seen[key] = true; result.push(ev); }
        });
        result.sort(function (a, b) { return a.startMin - b.startMin; });
        return result;
    }

    // ══════════════════════════════════════════════════════════════════════
    // DATE CHANGE — triggers the full orchestrator load chain
    // ══════════════════════════════════════════════════════════════════════
    function changeDateTo(y, m, d) {
        var newKey = getDateKey(y, m, d);
        var picker = document.getElementById('calendar-date-picker');
        var currentKey = (picker && picker.value) || window.currentScheduleDate || '';

        window.currentScheduleDate = newKey;

        if (currentKey === newKey) {
            // Same date — just trigger render directly
            console.log(LOG, 'Date unchanged (' + newKey + '), calling updateTable');
            callOriginalUpdateTable();
            return;
        }

        // Different date — set picker value, fire change event.
        // This triggers: calendar.js onDateChanged → campistry-date-changed
        //   → orchestrator loads data → hydrates globals → calls window.updateTable()
        console.log(LOG, 'Date changed:', currentKey, '->', newKey);
        if (picker) {
            picker.value = newKey;
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            window.dispatchEvent(new CustomEvent('campistry-date-changed', {
                detail: { dateKey: newKey, oldDateKey: currentKey }
            }));
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // updateTable CAPTURE — robust with retries
    // ══════════════════════════════════════════════════════════════════════
    function captureOriginalUpdateTable() {
        if (_originalUpdateTable && window.updateTable && window.updateTable._scvPatched) return true;

        var fn = window.updateTable;
        if (typeof fn !== 'function' || fn._scvPatched) {
            _patchAttempts++;
            if (_patchAttempts < 30) {
                setTimeout(captureOriginalUpdateTable, 300);
                console.log(LOG, 'updateTable not ready, retry #' + _patchAttempts);
            } else {
                console.warn(LOG, 'Could not capture updateTable after ' + _patchAttempts + ' attempts');
            }
            return false;
        }

        _originalUpdateTable = fn;
        console.log(LOG, 'Captured original updateTable');

        window.updateTable = function () {
            var parsed = parseCurrentDate();
            _viewYear = parsed.y; _viewMonth = parsed.m; _viewDay = parsed.d;

            if (_currentView === 'day') {
                _originalUpdateTable();
                updateToolbarLabel();
            } else {
                render();
            }
        };
        window.updateTable._scvPatched = true;
        return true;
    }

    function callOriginalUpdateTable() {
        if (_originalUpdateTable) {
            _originalUpdateTable();
        } else if (window.UnifiedScheduleSystem && typeof window.UnifiedScheduleSystem.renderStaggeredView === 'function') {
            var container = document.getElementById('scheduleTable');
            if (container) window.UnifiedScheduleSystem.renderStaggeredView(container);
        } else {
            console.warn(LOG, 'No updateTable available');
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // TOOLBAR
    // ══════════════════════════════════════════════════════════════════════
    function createToolbar() {
        var bar = document.createElement('div');
        bar.id = 'scv-toolbar';
        bar.innerHTML =
            '<div class="scv-toolbar-row">' +
                '<div class="scv-nav-group">' +
                    '<button class="scv-nav-btn" data-action="prev">\u2039</button>' +
                    '<h3 class="scv-header-label" id="scv-header-label"></h3>' +
                    '<button class="scv-nav-btn" data-action="next">\u203A</button>' +
                    '<button class="scv-today-btn" data-action="today">Today</button>' +
                '</div>' +
                '<div class="scv-right-group">' +
                    '<div class="scv-view-switcher">' +
                        '<button class="scv-view-btn" data-view="year">Year</button>' +
                        '<button class="scv-view-btn" data-view="month">Month</button>' +
                        '<button class="scv-view-btn" data-view="week">Week</button>' +
                        '<button class="scv-view-btn active" data-view="day">Day</button>' +
                    '</div>' +
                    '<button class="scv-validate-btn" onclick="window.validateSchedule &amp;&amp; window.validateSchedule()">Validate</button>' +
                '</div>' +
            '</div>' +
            '<div class="scv-filter-row" id="scv-filter-row"></div>';

        bar.querySelector('[data-action="prev"]').onclick = function () { navigate(-1); };
        bar.querySelector('[data-action="next"]').onclick = function () { navigate(1); };
        bar.querySelector('[data-action="today"]').onclick = goToToday;

        var viewBtns = bar.querySelectorAll('.scv-view-btn');
        for (var i = 0; i < viewBtns.length; i++) {
            (function (btn) {
                btn.onclick = function () { switchView(btn.getAttribute('data-view')); };
            })(viewBtns[i]);
        }

        return bar;
    }

    function renderDivisionFilter() {
        var row = document.getElementById('scv-filter-row');
        if (!row) return;

        var divList = getDivisionList();
        var divs = getDivisions();

        var html = '<button class="scv-div-chip' + (_selectedDivision === 'all' ? ' active' : '') + '" data-div="all">All grades</button>';
        divList.forEach(function (dName) {
            var color = (divs[dName] || {}).color || '#64748b';
            var isActive = _selectedDivision === dName;
            html += '<button class="scv-div-chip' + (isActive ? ' active' : '') +
                '" data-div="' + escapeHtml(dName) +
                '" style="--chip-color:' + color + ';--chip-bg:' + color + '18;">' +
                escapeHtml(dName) + '</button>';
        });
        row.innerHTML = html;

        var chips = row.querySelectorAll('.scv-div-chip');
        for (var i = 0; i < chips.length; i++) {
            (function (chip) {
                chip.onclick = function () {
                    _selectedDivision = chip.getAttribute('data-div');
                    renderDivisionFilter();
                    // For non-day views, re-render calendar; for day view do nothing (existing grid shows all)
                    if (_currentView !== 'day') render();
                };
            })(chips[i]);
        }
    }

    function updateToolbarLabel() {
        var label = document.getElementById('scv-header-label');
        if (!label) return;

        if (_currentView === 'year') {
            label.textContent = '' + _viewYear;
        } else if (_currentView === 'month') {
            label.textContent = MONTHS[_viewMonth] + ' ' + _viewYear;
        } else if (_currentView === 'week') {
            var start = new Date(_viewYear, _viewMonth, _viewDay);
            start.setDate(start.getDate() - start.getDay());
            var end = new Date(start); end.setDate(end.getDate() + 6);
            if (start.getMonth() === end.getMonth()) {
                label.textContent = SHORT_MONTHS[start.getMonth()] + ' ' + start.getDate() + '\u2013' + end.getDate() + ', ' + start.getFullYear();
            } else {
                label.textContent = SHORT_MONTHS[start.getMonth()] + ' ' + start.getDate() + ' \u2013 ' + SHORT_MONTHS[end.getMonth()] + ' ' + end.getDate() + ', ' + end.getFullYear();
            }
        } else {
            var dow = new Date(_viewYear, _viewMonth, _viewDay).getDay();
            label.textContent = DAYS_FULL[dow] + ', ' + MONTHS[_viewMonth] + ' ' + _viewDay + ', ' + _viewYear;
        }

        if (_toolbar) {
            var btns = _toolbar.querySelectorAll('.scv-view-btn');
            for (var i = 0; i < btns.length; i++) {
                btns[i].classList.toggle('active', btns[i].getAttribute('data-view') === _currentView);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // NAVIGATION
    // ══════════════════════════════════════════════════════════════════════
    function navigate(dir) {
        if (_currentView === 'year') {
            _viewYear += dir;
        } else if (_currentView === 'month') {
            _viewMonth += dir;
            if (_viewMonth < 0) { _viewMonth = 11; _viewYear--; }
            if (_viewMonth > 11) { _viewMonth = 0; _viewYear++; }
        } else if (_currentView === 'week') {
            var d = new Date(_viewYear, _viewMonth, _viewDay + dir * 7);
            _viewYear = d.getFullYear(); _viewMonth = d.getMonth(); _viewDay = d.getDate();
        } else {
            var d2 = new Date(_viewYear, _viewMonth, _viewDay + dir);
            _viewYear = d2.getFullYear(); _viewMonth = d2.getMonth(); _viewDay = d2.getDate();
            changeDateTo(_viewYear, _viewMonth, _viewDay);
        }
        render();
    }

    function goToToday() {
        var t = new Date();
        _viewYear = t.getFullYear(); _viewMonth = t.getMonth(); _viewDay = t.getDate();
        if (_currentView === 'day') changeDateTo(_viewYear, _viewMonth, _viewDay);
        render();
    }

    function switchView(view) {
        _currentView = view;
        if (view === 'day') changeDateTo(_viewYear, _viewMonth, _viewDay);
        render();
    }

    function drillDown(y, m, d) {
        _viewYear = y; _viewMonth = m;
        if (d !== undefined) _viewDay = d;

        if (_currentView === 'year') {
            _currentView = 'month';
        } else if (_currentView === 'month') {
            _viewDay = d;
            _currentView = 'week';
        } else if (_currentView === 'week') {
            _viewDay = d;
            _currentView = 'day';
            changeDateTo(_viewYear, _viewMonth, _viewDay);
        }
        render();
    }

    // ══════════════════════════════════════════════════════════════════════
    // MAIN RENDER
    // ══════════════════════════════════════════════════════════════════════
    function render() {
        updateToolbarLabel();
        renderDivisionFilter();

        var st = document.getElementById('scheduleTable');

        if (_currentView === 'day') {
            if (_calendarContainer) _calendarContainer.style.display = 'none';
            if (st) st.style.display = '';
            // Day view: the orchestrator chain handles rendering.
            // changeDateTo() already fired the picker change → orchestrator → updateTable.
            // Nothing more to do here.
            return;
        }

        // Non-day views
        if (st) st.style.display = 'none';
        if (!_calendarContainer) {
            _calendarContainer = document.createElement('div');
            _calendarContainer.id = 'scv-calendar-container';
            if (st && st.parentNode) st.parentNode.insertBefore(_calendarContainer, st.nextSibling);
        }
        _calendarContainer.style.display = '';
        _calendarContainer.innerHTML = '';

        if (_currentView === 'year') renderYearView();
        else if (_currentView === 'month') renderMonthView();
        else if (_currentView === 'week') renderWeekView();
    }

    // ══════════════════════════════════════════════════════════════════════
    // YEAR VIEW
    // ══════════════════════════════════════════════════════════════════════
    function renderYearView() {
        var allData = getAllDailyData();
        var grid = document.createElement('div');
        grid.className = 'scv-year-grid';

        for (var mi = 0; mi < 12; mi++) {
            (function (monthIdx) {
                var daysInMonth = new Date(_viewYear, monthIdx + 1, 0).getDate();
                var firstDow = new Date(_viewYear, monthIdx, 1).getDay();
                var daysWithData = {};

                for (var d = 1; d <= daysInMonth; d++) {
                    var key = getDateKey(_viewYear, monthIdx, d);
                    var dd = allData[key];
                    if (dd && dd.scheduleAssignments && Object.keys(dd.scheduleAssignments).length > 0) {
                        if (_selectedDivision === 'all') {
                            daysWithData[d] = true;
                        } else {
                            var bunks = getBunksForDivision(_selectedDivision);
                            for (var bi = 0; bi < bunks.length; bi++) {
                                if (dd.scheduleAssignments[bunks[bi]] && dd.scheduleAssignments[bunks[bi]].length > 0) {
                                    daysWithData[d] = true; break;
                                }
                            }
                        }
                    }
                }

                var card = document.createElement('div');
                card.className = 'scv-year-month-card';
                card.onclick = function () { drillDown(_viewYear, monthIdx); };

                var html = '<div class="scv-year-month-name">' + MONTHS[monthIdx] + '</div>';
                html += '<div class="scv-year-mini-grid">';
                for (var i = 0; i < 7; i++) html += '<div class="scv-year-mini-hdr">' + DAYS[i][0] + '</div>';
                for (var i = 0; i < firstDow; i++) html += '<div class="scv-year-mini-day empty"></div>';
                for (var d = 1; d <= daysInMonth; d++) {
                    var today = isToday(_viewYear, monthIdx, d);
                    var hasData = daysWithData[d];
                    var cls = 'scv-year-mini-day';
                    if (today) cls += ' today';
                    html += '<div class="' + cls + '">' + d + (hasData && !today ? '<span class="scv-dot"></span>' : '') + '</div>';
                }
                html += '</div>';
                card.innerHTML = html;
                grid.appendChild(card);
            })(mi);
        }

        _calendarContainer.appendChild(grid);
    }

    // ══════════════════════════════════════════════════════════════════════
    // MONTH VIEW
    // ══════════════════════════════════════════════════════════════════════
    function renderMonthView() {
        var daysInMonth = new Date(_viewYear, _viewMonth + 1, 0).getDate();
        var firstDow = new Date(_viewYear, _viewMonth, 1).getDay();
        var prevMonthDays = new Date(_viewYear, _viewMonth, 0).getDate();
        var totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

        var wrapper = document.createElement('div');
        wrapper.className = 'scv-month-wrapper';

        var headerHtml = '<div class="scv-month-header-row">';
        DAYS.forEach(function (d) { headerHtml += '<div class="scv-month-hdr">' + d + '</div>'; });
        headerHtml += '</div>';
        wrapper.innerHTML = headerHtml;

        var grid = document.createElement('div');
        grid.className = 'scv-month-grid';

        for (var i = 0; i < totalCells; i++) {
            (function (idx) {
                var dayNum = idx - firstDow + 1;
                var inMonth = dayNum >= 1 && dayNum <= daysInMonth;
                var display = inMonth ? dayNum : (dayNum < 1 ? prevMonthDays + dayNum : dayNum - daysInMonth);
                var today = inMonth && isToday(_viewYear, _viewMonth, dayNum);
                var dow = idx % 7;
                var isWeekend = dow === 0 || dow === 6;

                var cell = document.createElement('div');
                cell.className = 'scv-month-cell' + (inMonth ? '' : ' outside') + (isWeekend ? ' weekend' : '') + (today ? ' today' : '');
                if (inMonth) {
                    cell.style.cursor = 'pointer';
                    cell.onclick = function () { drillDown(_viewYear, _viewMonth, dayNum); };
                }

                var inner = today
                    ? '<span class="scv-month-day-num today-badge">' + display + '</span>'
                    : '<span class="scv-month-day-num">' + display + '</span>';

                if (inMonth) {
                    var dateKey = getDateKey(_viewYear, _viewMonth, dayNum);
                    var events = dedupeEvents(getEventSummary(dateKey));
                    var maxShow = 3;
                    for (var ei = 0; ei < Math.min(events.length, maxShow); ei++) {
                        var ev = events[ei];
                        var ec = EVENT_COLORS[ev.type] || EVENT_COLORS.default;
                        inner += '<div class="scv-month-event" style="background:' + ec.bg + ';color:' + ec.color + ';border-left:3px solid ' + ec.color + ';">' + ec.icon + ' ' + escapeHtml(ev.activity) + '</div>';
                    }
                    if (events.length > maxShow) {
                        inner += '<div class="scv-month-more">+' + (events.length - maxShow) + ' more</div>';
                    }
                }

                cell.innerHTML = inner;
                grid.appendChild(cell);
            })(i);
        }

        wrapper.appendChild(grid);
        _calendarContainer.appendChild(wrapper);
    }

    // ══════════════════════════════════════════════════════════════════════
    // WEEK VIEW
    // ══════════════════════════════════════════════════════════════════════
    function renderWeekView() {
        var current = new Date(_viewYear, _viewMonth, _viewDay);
        var startOfWeek = new Date(current);
        startOfWeek.setDate(current.getDate() - current.getDay());

        var weekDays = [];
        for (var i = 0; i < 7; i++) {
            var d = new Date(startOfWeek);
            d.setDate(startOfWeek.getDate() + i);
            weekDays.push(d);
        }

        var START_HOUR = 8, END_HOUR = 17, HOUR_H = 56;
        var totalH = (END_HOUR - START_HOUR) * HOUR_H;

        var wrapper = document.createElement('div');
        wrapper.className = 'scv-week-wrapper';

        var headerHtml = '<div class="scv-week-header"><div class="scv-week-gutter-hdr"></div>';
        weekDays.forEach(function (wd) {
            var today = isToday(wd.getFullYear(), wd.getMonth(), wd.getDate());
            headerHtml += '<div class="scv-week-day-hdr' + (today ? ' today' : '') + '" data-y="' + wd.getFullYear() + '" data-m="' + wd.getMonth() + '" data-d="' + wd.getDate() + '">' +
                '<span class="scv-week-day-name">' + DAYS[wd.getDay()] + '</span>' +
                '<span class="scv-week-day-num' + (today ? ' today-badge' : '') + '">' + wd.getDate() + '</span>' +
                '</div>';
        });
        headerHtml += '</div>';
        wrapper.innerHTML = headerHtml;

        var hdrEls = wrapper.querySelectorAll('.scv-week-day-hdr');
        for (var h = 0; h < hdrEls.length; h++) {
            (function (hdr) {
                hdr.style.cursor = 'pointer';
                hdr.onclick = function () {
                    drillDown(parseInt(hdr.getAttribute('data-y')), parseInt(hdr.getAttribute('data-m')), parseInt(hdr.getAttribute('data-d')));
                };
            })(hdrEls[h]);
        }

        var body = document.createElement('div');
        body.className = 'scv-week-body';
        body.style.height = totalH + 'px';

        var gutterHtml = '<div class="scv-week-gutter" style="height:' + totalH + 'px;">';
        for (var h = START_HOUR; h < END_HOUR; h++) {
            gutterHtml += '<div class="scv-week-time" style="top:' + ((h - START_HOUR) * HOUR_H) + 'px;">' + minutesToTime(h * 60).replace(':00 ', ' ') + '</div>';
        }
        gutterHtml += '</div>';
        body.innerHTML = gutterHtml;

        weekDays.forEach(function (wd) {
            var col = document.createElement('div');
            col.className = 'scv-week-col';
            col.style.height = totalH + 'px';

            for (var h = START_HOUR; h < END_HOUR; h++) {
                var line = document.createElement('div');
                line.className = 'scv-week-hour-line';
                line.style.top = (h - START_HOUR) * HOUR_H + 'px';
                col.appendChild(line);
            }

            var dateKey = getDateKey(wd.getFullYear(), wd.getMonth(), wd.getDate());
            var events = dedupeEvents(getEventSummary(dateKey));

            events.forEach(function (ev) {
                if (ev.startMin < START_HOUR * 60 || ev.startMin >= END_HOUR * 60) return;
                var topPx = (ev.startMin - START_HOUR * 60) * (HOUR_H / 60);
                var dur = Math.max(ev.endMin - ev.startMin, 15);
                var heightPx = Math.max(dur * (HOUR_H / 60) - 2, 14);
                var ec = EVENT_COLORS[ev.type] || EVENT_COLORS.default;

                var block = document.createElement('div');
                block.className = 'scv-week-event';
                block.style.cssText = 'top:' + topPx + 'px;height:' + heightPx + 'px;background:' + ec.bg + ';border-left:3px solid ' + ec.color + ';color:' + ec.color + ';';
                var blockHtml = '<div class="scv-week-event-title">' + escapeHtml(ev.activity) + '</div>';
                if (heightPx > 22) blockHtml += '<div class="scv-week-event-time">' + minutesToTime(ev.startMin) + '</div>';
                if (heightPx > 36 && ev.division) blockHtml += '<div class="scv-week-event-div">' + escapeHtml(ev.division) + '</div>';
                block.innerHTML = blockHtml;
                col.appendChild(block);
            });

            if (isToday(wd.getFullYear(), wd.getMonth(), wd.getDate())) {
                var now = new Date();
                var nowMin = now.getHours() * 60 + now.getMinutes();
                if (nowMin >= START_HOUR * 60 && nowMin < END_HOUR * 60) {
                    var nowTop = (nowMin - START_HOUR * 60) * (HOUR_H / 60);
                    var nowLine = document.createElement('div');
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

    // ══════════════════════════════════════════════════════════════════════
    // STYLES
    // ══════════════════════════════════════════════════════════════════════
    function injectStyles() {
        if (document.getElementById('scv-styles')) return;
        var style = document.createElement('style');
        style.id = 'scv-styles';
        style.textContent =
'#scv-toolbar{margin-bottom:12px}' +
'.scv-toolbar-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}' +
'.scv-nav-group{display:flex;align-items:center;gap:8px}' +
'.scv-right-group{display:flex;align-items:center;gap:10px}' +
'.scv-header-label{font-size:1.15rem;font-weight:600;color:var(--slate-900,#0f172a);margin:0;min-width:240px;text-align:center;user-select:none}' +
'.scv-nav-btn{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--slate-300,#cbd5e1);border-radius:6px;background:#fff;font-size:18px;color:var(--slate-700,#334155);cursor:pointer;transition:background .15s}' +
'.scv-nav-btn:hover{background:var(--slate-100,#f1f5f9)}' +
'.scv-today-btn{padding:4px 14px;border:1px solid var(--slate-300,#cbd5e1);border-radius:6px;background:#fff;font-size:13px;font-weight:500;color:var(--slate-700,#334155);cursor:pointer;transition:background .15s}' +
'.scv-today-btn:hover{background:var(--slate-100,#f1f5f9)}' +
'.scv-view-switcher{display:flex;gap:0;background:var(--slate-100,#f1f5f9);border-radius:8px;padding:3px}' +
'.scv-view-btn{padding:5px 16px;border:none;border-radius:6px;font-size:13px;font-weight:500;color:var(--slate-500,#64748b);background:transparent;cursor:pointer;transition:all .15s}' +
'.scv-view-btn:hover{color:var(--slate-700,#334155)}' +
'.scv-view-btn.active{background:#fff;color:var(--slate-900,#0f172a);box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
'.scv-validate-btn{padding:6px 16px;border:none;border-radius:6px;background:#ff9800;color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}' +
'.scv-validate-btn:hover{opacity:.85}' +

/* Filter */
'.scv-filter-row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}' +
'.scv-div-chip{padding:4px 14px;border:1.5px solid var(--slate-200,#e2e8f0);border-radius:20px;font-size:12px;font-weight:600;background:#fff;color:var(--slate-600,#475569);cursor:pointer;transition:all .15s}' +
'.scv-div-chip:hover{border-color:var(--chip-color,var(--slate-400,#94a3b8));background:var(--chip-bg,var(--slate-50,#f8fafc))}' +
'.scv-div-chip.active{background:var(--chip-color,var(--camp-green,#147D91));color:#fff;border-color:var(--chip-color,var(--camp-green,#147D91))}' +
'.scv-div-chip[data-div="all"].active{background:var(--slate-800,#1e293b);border-color:var(--slate-800,#1e293b);color:#fff}' +

/* Year */
'.scv-year-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}' +
'@media(max-width:900px){.scv-year-grid{grid-template-columns:repeat(3,1fr)}}' +
'@media(max-width:600px){.scv-year-grid{grid-template-columns:repeat(2,1fr)}}' +
'.scv-year-month-card{padding:12px;border:1px solid var(--slate-200,#e2e8f0);border-radius:10px;background:#fff;cursor:pointer;transition:box-shadow .15s,border-color .15s}' +
'.scv-year-month-card:hover{box-shadow:0 2px 10px rgba(0,0,0,.06);border-color:var(--camp-green,#147D91)}' +
'.scv-year-month-name{font-size:13px;font-weight:600;color:var(--slate-800,#1e293b);margin-bottom:8px}' +
'.scv-year-mini-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;text-align:center}' +
'.scv-year-mini-hdr{font-size:9px;font-weight:600;color:var(--slate-400,#94a3b8);line-height:16px}' +
'.scv-year-mini-day{font-size:10px;line-height:20px;color:var(--slate-600,#475569);border-radius:50%;position:relative}' +
'.scv-year-mini-day.empty{visibility:hidden}' +
'.scv-year-mini-day.today{background:var(--camp-green,#147D91);color:#fff;font-weight:700}' +
'.scv-dot{position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:4px;height:4px;border-radius:50%;background:var(--camp-green,#147D91)}' +

/* Month */
'.scv-month-wrapper{border:1px solid var(--slate-200,#e2e8f0);border-radius:10px;overflow:hidden;background:#fff}' +
'.scv-month-header-row{display:grid;grid-template-columns:repeat(7,1fr);border-bottom:1px solid var(--slate-200,#e2e8f0)}' +
'.scv-month-hdr{padding:8px 0;text-align:center;font-size:12px;font-weight:600;color:var(--slate-500,#64748b);background:var(--slate-50,#f8fafc)}' +
'.scv-month-grid{display:grid;grid-template-columns:repeat(7,1fr)}' +
'.scv-month-cell{min-height:100px;padding:4px 6px;border-bottom:1px solid var(--slate-100,#f1f5f9);border-right:1px solid var(--slate-100,#f1f5f9);transition:background .1s;overflow:hidden}' +
'.scv-month-cell:nth-child(7n){border-right:none}' +
'.scv-month-cell:hover{background:var(--slate-50,#f8fafc)}' +
'.scv-month-cell.outside{opacity:.35}' +
'.scv-month-cell.weekend{background:var(--slate-50,#f8fafc)}' +
'.scv-month-cell.weekend:hover{background:var(--slate-100,#f1f5f9)}' +
'.scv-month-day-num{font-size:12px;font-weight:500;color:var(--slate-700,#334155);display:inline-block;margin-bottom:4px}' +
'.scv-month-cell.outside .scv-month-day-num{color:var(--slate-400,#94a3b8)}' +
'.today-badge{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--camp-green,#147D91);color:#fff!important;font-weight:700;font-size:11px}' +
'.scv-month-event{font-size:10px;line-height:16px;padding:1px 5px;border-radius:4px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}' +
'.scv-month-more{font-size:10px;color:var(--slate-400,#94a3b8);padding-left:5px}' +

/* Week */
'.scv-week-wrapper{border:1px solid var(--slate-200,#e2e8f0);border-radius:10px;overflow:hidden;background:#fff}' +
'.scv-week-header{display:grid;grid-template-columns:56px repeat(7,1fr);border-bottom:1px solid var(--slate-200,#e2e8f0)}' +
'.scv-week-gutter-hdr{background:var(--slate-50,#f8fafc)}' +
'.scv-week-day-hdr{padding:8px 4px;text-align:center;background:var(--slate-50,#f8fafc);border-left:1px solid var(--slate-100,#f1f5f9);transition:background .1s}' +
'.scv-week-day-hdr:hover{background:var(--slate-100,#f1f5f9)}' +
'.scv-week-day-hdr.today{background:rgba(20,125,145,.06)}' +
'.scv-week-day-name{display:block;font-size:11px;font-weight:600;color:var(--slate-500,#64748b)}' +
'.scv-week-day-num{display:inline-block;font-size:16px;font-weight:500;color:var(--slate-800,#1e293b);margin-top:2px}' +
'.scv-week-day-num.today-badge{font-size:13px}' +
'.scv-week-body{display:grid;grid-template-columns:56px repeat(7,1fr);position:relative;overflow-y:auto;max-height:65vh}' +
'.scv-week-gutter{position:relative;background:var(--slate-50,#f8fafc)}' +
'.scv-week-time{position:absolute;right:8px;font-size:10px;color:var(--slate-400,#94a3b8);line-height:1;transform:translateY(-6px)}' +
'.scv-week-col{position:relative;border-left:1px solid var(--slate-100,#f1f5f9)}' +
'.scv-week-hour-line{position:absolute;left:0;right:0;border-top:1px solid var(--slate-100,#f1f5f9)}' +
'.scv-week-event{position:absolute;left:2px;right:2px;border-radius:4px;padding:2px 5px;font-size:10px;overflow:hidden;cursor:default;font-weight:500;transition:opacity .1s;z-index:2}' +
'.scv-week-event:hover{opacity:.8}' +
'.scv-week-event-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:14px}' +
'.scv-week-event-time{font-size:9px;opacity:.7}' +
'.scv-week-event-div{font-size:9px;opacity:.6;font-weight:600}' +
'.scv-now-line{position:absolute;left:0;right:0;z-index:5;display:flex;align-items:center}' +
'.scv-now-dot{width:8px;height:8px;border-radius:50%;background:#ef4444;margin-left:-4px;flex-shrink:0}' +
'.scv-now-bar{flex:1;height:2px;background:#ef4444}' +

/* Responsive */
'@media(max-width:768px){' +
  '.scv-toolbar-row{flex-direction:column;align-items:stretch}' +
  '.scv-nav-group{justify-content:center}' +
  '.scv-right-group{justify-content:center}' +
  '.scv-header-label{min-width:unset;font-size:1rem}' +
  '.scv-month-cell{min-height:70px}' +
  '.scv-month-event{font-size:9px}' +
  '.scv-week-body{max-height:50vh}' +
  '.scv-filter-row{justify-content:center}' +
'}';

        document.head.appendChild(style);
    }

    // ══════════════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════════════
    function init() {
        if (_initialized) return;

        var scheduleTab = document.getElementById('schedule');
        if (!scheduleTab) {
            console.warn(LOG, '#schedule tab not found, retrying...');
            setTimeout(init, 1000);
            return;
        }

        _initialized = true;
        injectStyles();

        var parsed = parseCurrentDate();
        _viewYear = parsed.y; _viewMonth = parsed.m; _viewDay = parsed.d;

        // Replace the old header with our toolbar
        var oldHeader = scheduleTab.querySelector('div:first-child');
        if (oldHeader && (oldHeader.querySelector('h3') || oldHeader.querySelector('button'))) {
            _toolbar = createToolbar();
            oldHeader.parentNode.replaceChild(_toolbar, oldHeader);
        } else {
            _toolbar = createToolbar();
            scheduleTab.insertBefore(_toolbar, scheduleTab.firstChild);
        }

        // Start capturing updateTable (with retries)
        captureOriginalUpdateTable();

        // Listen for date changes from external systems
        window.addEventListener('campistry-date-changed', function (e) {
            var dateKey = e.detail && e.detail.dateKey;
            if (dateKey) {
                var parts = dateKey.split('-');
                _viewYear = parseInt(parts[0]);
                _viewMonth = parseInt(parts[1]) - 1;
                _viewDay = parseInt(parts[2]);
                updateToolbarLabel();
            }
        });

        updateToolbarLabel();
        renderDivisionFilter();

        console.log(LOG, '\u2705 Initialized (v2) \u2014 view:', _currentView);
    }

    // Public API
    window.ScheduleCalendarViews = {
        init: init,
        switchView: switchView,
        render: render,
        getView: function () { return _currentView; },
        setDivision: function (d) { _selectedDivision = d; render(); },
    };

    // Auto-init with delay to ensure unified_schedule_system.js is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 800); });
    } else {
        setTimeout(init, 800);
    }

})();
