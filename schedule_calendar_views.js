// =========================================================================
// schedule_calendar_views.js — Multi-View Calendar (Year / Month / Week / Day)
// =========================================================================
// v5.1 — Special events only + schedule-generated indicator
//         (green tint/checkmark when schedule exists for a day)
// =========================================================================

(function () {
    'use strict';

    const LOG = '[CalendarViews]';

    // ── Constants ────────────────────────────────────────────────────────
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    // Render-scoped cache: parsed ONCE per render cycle, cleared after.
    // Without this, year view parses the (potentially huge) campDailyData_v1
    // JSON blob 700+ times and freezes the browser.
    var _dataCache = null;
    var _rotCache = null;

    function beginRenderCache() {
        try {
            var raw = localStorage.getItem('campDailyData_v1');
            _dataCache = raw ? JSON.parse(raw) : {};
        } catch (e) { _dataCache = {}; }
        try {
            var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            _rotCache = Array.isArray(g.rotationEvents) ? g.rotationEvents : [];
        } catch (e) { _rotCache = []; }
    }

    function endRenderCache() {
        _dataCache = null;
        _rotCache = null;
    }

    function getAllDailyData() {
        if (_dataCache) return _dataCache;
        try {
            var raw = localStorage.getItem('campDailyData_v1');
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function getScheduleDataForDate(dateKey) {
        var all = getAllDailyData();
        return all[dateKey] || null;
    }

    function getRotationEvents() {
        if (_rotCache) return _rotCache;
        try {
            var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            return Array.isArray(g.rotationEvents) ? g.rotationEvents : [];
        } catch (e) { return []; }
    }

    // Does this day have a generated schedule?
    // Fast check: just confirms scheduleAssignments has bunk data.
    function hasSchedule(dateKey) {
        var data = getScheduleDataForDate(dateKey);
        if (!data || !data.scheduleAssignments) return false;
        var keys = Object.keys(data.scheduleAssignments);
        if (keys.length === 0) return false;
        // Quick: check first bunk has an array with entries
        var first = data.scheduleAssignments[keys[0]];
        return Array.isArray(first) && first.length > 0;
    }

    // ── Special Events Only ─────────────────────────────────────────────
    // The calendar ONLY shows truly notable/special things — NOT the
    // regular daily schedule. Three data sources:
    //
    //   1. TRIPS        → campDailyTrips_<dateKey> / dailyData.dailyTrips
    //   2. ROTATION EVT → globalSettings.rotationEvents (date-range based)
    //   3. CUSTOM PINS  → skeleton blocks with type "pinned" that are NOT
    //                      standard (swim/lunch/snacks/dismissal)
    //
    // Returns: [{ division, color, shortLabel, longLabel, startMin, endMin, category }]

    var STANDARD_PINS = { 'swim': 1, 'lunch': 1, 'snacks': 1, 'snack': 1, 'dismissal': 1 };

    function parseTimeStr(str) {
        if (!str) return null;
        str = str.toString().toLowerCase().replace(/\s/g, '');
        var m = str.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var min = parseInt(m[2], 10);
        if (m[3] === 'pm' && h < 12) h += 12;
        if (m[3] === 'am' && h === 12) h = 0;
        return h * 60 + min;
    }

    function getGradeEvents(dateKey) {
        var divs = getDivisions();
        var results = [];

        // ─── 1. TRIPS ────────────────────────────────────────────────
        var trips = [];
        try {
            var stored = localStorage.getItem('campDailyTrips_' + dateKey);
            if (stored) trips = JSON.parse(stored);
        } catch (e) { /* ignore */ }
        // Fallback: dailyData
        if (!trips.length) {
            var dd = getScheduleDataForDate(dateKey);
            if (dd && Array.isArray(dd.dailyTrips)) trips = dd.dailyTrips;
        }

        trips.forEach(function (trip) {
            var divName = trip.division;
            if (!divName) return;
            if (_selectedDivision !== 'all' && divName !== _selectedDivision) return;
            var color = (divs[divName] || {}).color || '#64748b';
            var name = trip.event || 'Trip';
            var startMin = trip.startMin != null ? trip.startMin : parseTimeStr(trip.startTime);
            var endMin = trip.endMin != null ? trip.endMin : parseTimeStr(trip.endTime);

            results.push({
                division: divName, color: color, category: 'trip',
                shortLabel: 'Trip',
                longLabel: name + (startMin != null && endMin != null ? ' \u2013 ' + minutesToTime(startMin) + ' to ' + minutesToTime(endMin) : ''),
                startMin: startMin || 0, endMin: endMin || 0,
            });
        });

        // ─── 2. ROTATION EVENTS ──────────────────────────────────────
        var rotEvents = getRotationEvents();

        rotEvents.forEach(function (evt) {
            if (!evt.dateRange || !evt.dateRange.start || !evt.dateRange.end) return;
            if (dateKey < evt.dateRange.start || dateKey > evt.dateRange.end) return;
            // Rotation events are camp-wide — show once with a neutral label,
            // or once per grade if filtered
            var name = evt.name || 'Event';
            var loc = evt.location || '';
            var startMin = evt.dailyWindow ? evt.dailyWindow.startMin : 0;
            var endMin = evt.dailyWindow ? evt.dailyWindow.endMin : 0;
            var longText = name;
            if (loc) longText += ' \u2013 ' + loc;
            if (startMin && endMin) longText += ' \u2013 ' + minutesToTime(startMin) + ' to ' + minutesToTime(endMin);

            if (_selectedDivision !== 'all') {
                // Show for the selected grade only
                var color = (divs[_selectedDivision] || {}).color || '#64748b';
                results.push({
                    division: _selectedDivision, color: color, category: 'rotation',
                    shortLabel: name,
                    longLabel: longText,
                    startMin: startMin || 0, endMin: endMin || 0,
                });
            } else {
                // Show once with camp-wide styling (use the event's color or teal)
                var evtColor = evt.color || '#147D91';
                results.push({
                    division: 'All Grades', color: evtColor, category: 'rotation',
                    shortLabel: name,
                    longLabel: longText,
                    startMin: startMin || 0, endMin: endMin || 0,
                });
            }
        });

        // ─── 3. CUSTOM SKELETON PINS ─────────────────────────────────
        // These are user-created pinned blocks like "Assembly", "Color War"
        // that are NOT standard swim/lunch/snacks/dismissal
        var skeleton = [];
        try {
            // Check dailyOverrideSkeleton in dailyData
            var dd2 = getScheduleDataForDate(dateKey);
            if (dd2 && Array.isArray(dd2.manualSkeleton)) skeleton = dd2.manualSkeleton;
            // Also check dedicated localStorage key
            if (!skeleton.length) {
                var raw = localStorage.getItem('campManualSkeleton_' + dateKey);
                if (raw) skeleton = JSON.parse(raw);
            }
            // Also check the global dailyData skeleton
            if (!skeleton.length) {
                var allDaily = getAllDailyData();
                var dayData = allDaily[dateKey];
                if (dayData && Array.isArray(dayData.dailyOverrideSkeleton)) skeleton = dayData.dailyOverrideSkeleton;
            }
        } catch (e) { /* ignore */ }

        skeleton.forEach(function (block) {
            if (!block || block.type !== 'pinned') return;
            var evtName = (block.event || '').toLowerCase().trim();
            if (STANDARD_PINS[evtName]) return; // skip swim, lunch, snacks, dismissal
            if (!evtName) return;

            var divName = block.division;
            if (!divName) return;
            if (_selectedDivision !== 'all' && divName !== _selectedDivision) return;
            var color = (divs[divName] || {}).color || '#64748b';
            var startMin = parseTimeStr(block.startTime);
            var endMin = parseTimeStr(block.endTime);

            var displayName = block.event || 'Event';
            var longText = displayName;
            if (startMin != null && endMin != null) {
                longText += ' \u2013 ' + minutesToTime(startMin) + ' to ' + minutesToTime(endMin);
            }

            results.push({
                division: divName, color: color, category: 'custom',
                shortLabel: displayName,
                longLabel: longText,
                startMin: startMin || 0, endMin: endMin || 0,
            });
        });

        // Sort: trips first, then rotation, then custom; within same category sort by division
        var catOrder = { trip: 0, rotation: 1, custom: 2 };
        results.sort(function (a, b) {
            var ca = catOrder[a.category] !== undefined ? catOrder[a.category] : 9;
            var cb = catOrder[b.category] !== undefined ? catOrder[b.category] : 9;
            if (ca !== cb) return ca - cb;
            return a.division.localeCompare(b.division);
        });

        return results;
    }

    // Which grades have any special event this day?
    function getActiveGrades(dateKey) {
        var events = getGradeEvents(dateKey);
        var seen = {};
        var result = [];
        events.forEach(function (ev) {
            if (!seen[ev.division]) {
                seen[ev.division] = true;
                result.push({ division: ev.division, color: ev.color });
            }
        });
        return result;
    }

    // Does this day have a generated schedule? (checks scheduleAssignments)
    function hasSchedule(dateKey) {
        var data = getScheduleDataForDate(dateKey);
        if (!data || !data.scheduleAssignments) return false;
        var bunks = Object.keys(data.scheduleAssignments);
        if (bunks.length === 0) return false;
        // Make sure at least one bunk has real slot data
        for (var i = 0; i < bunks.length; i++) {
            var slots = data.scheduleAssignments[bunks[i]];
            if (Array.isArray(slots) && slots.length > 0) return true;
        }
        return false;
    }

    // Lighten a hex color for backgrounds
    function lightenColor(hex, amt) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        var r = parseInt(hex.substring(0, 2), 16);
        var g = parseInt(hex.substring(2, 4), 16);
        var b = parseInt(hex.substring(4, 6), 16);
        r = Math.min(255, Math.round(r + (255 - r) * amt));
        g = Math.min(255, Math.round(g + (255 - g) * amt));
        b = Math.min(255, Math.round(b + (255 - b) * amt));
        return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
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

        // Parse localStorage ONCE for the entire render
        beginRenderCache();
        if (_currentView === 'year') renderYearView();
        else if (_currentView === 'month') renderMonthView();
        else if (_currentView === 'week') renderWeekView();
        endRenderCache();
    }

    // ══════════════════════════════════════════════════════════════════════
    // YEAR VIEW
    // ══════════════════════════════════════════════════════════════════════
    function renderYearView() {
        var grid = document.createElement('div');
        grid.className = 'scv-year-grid';

        for (var mi = 0; mi < 12; mi++) {
            (function (monthIdx) {
                var daysInMonth = new Date(_viewYear, monthIdx + 1, 0).getDate();
                var firstDow = new Date(_viewYear, monthIdx, 1).getDay();

                // Pre-compute which grades are active each day
                var dayGrades = {};
                var dayHasSchedule = {};
                for (var d = 1; d <= daysInMonth; d++) {
                    var key = getDateKey(_viewYear, monthIdx, d);
                    var grades = getActiveGrades(key);
                    if (grades.length > 0) dayGrades[d] = grades;
                    dayHasSchedule[d] = hasSchedule(key);
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
                    var grades = dayGrades[d];
                    var scheduled = dayHasSchedule[d];
                    var cls = 'scv-year-mini-day';
                    if (today) cls += ' today';
                    else if (scheduled) cls += ' has-sched';
                    html += '<div class="' + cls + '">' + d;
                    if (grades && !today) {
                        html += '<div class="scv-grade-dots">';
                        // Show up to 6 grade dots
                        var maxDots = Math.min(grades.length, 6);
                        for (var gi = 0; gi < maxDots; gi++) {
                            html += '<span class="scv-grade-dot" style="background:' + grades[gi].color + ';"></span>';
                        }
                        html += '</div>';
                    }
                    html += '</div>';
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
                    var events = getGradeEvents(dateKey);
                    var scheduled = hasSchedule(dateKey);
                    var maxShow = 3;
                    for (var gi = 0; gi < Math.min(events.length, maxShow); gi++) {
                        var ev = events[gi];
                        var bgColor = lightenColor(ev.color, 0.82);
                        inner += '<div class="scv-month-ev" style="background:' + bgColor + ';color:' + ev.color + ';border-left:3px solid ' + ev.color + ';">' +
                            escapeHtml(ev.division) + ' ' + escapeHtml(ev.shortLabel) + '</div>';
                    }
                    if (events.length > maxShow) {
                        inner += '<div class="scv-month-more">+' + (events.length - maxShow) + ' more</div>';
                    }
                    // Schedule status indicator
                    if (scheduled) {
                        inner += '<div class="scv-month-sched">\u2713 Schedule</div>';
                    } else {
                        var dow2 = idx % 7;
                        if (dow2 !== 0 && dow2 !== 6) {
                            inner += '<div class="scv-month-no-sched">No schedule</div>';
                        }
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

        var START_HOUR = 8, END_HOUR = 17, HOUR_H = 72;
        var totalH = (END_HOUR - START_HOUR) * HOUR_H;

        var wrapper = document.createElement('div');
        wrapper.className = 'scv-week-wrapper';

        var headerHtml = '<div class="scv-week-header"><div class="scv-week-gutter-hdr"></div>';
        weekDays.forEach(function (wd) {
            var today = isToday(wd.getFullYear(), wd.getMonth(), wd.getDate());
            var dateKey = getDateKey(wd.getFullYear(), wd.getMonth(), wd.getDate());
            var activeGrades = getActiveGrades(dateKey);
            var scheduled = hasSchedule(dateKey);
            var dotHtml = '';
            activeGrades.slice(0, 6).forEach(function (g) {
                dotHtml += '<span class="scv-week-hdr-dot" style="background:' + g.color + ';" title="' + escapeHtml(g.division) + '"></span>';
            });
            var schedBadge = scheduled
                ? '<span class="scv-week-sched-badge">\u2713</span>'
                : '<span class="scv-week-no-sched-badge">\u2013</span>';
            headerHtml += '<div class="scv-week-day-hdr' + (today ? ' today' : '') + '" data-y="' + wd.getFullYear() + '" data-m="' + wd.getMonth() + '" data-d="' + wd.getDate() + '">' +
                '<span class="scv-week-day-name">' + DAYS[wd.getDay()] + '</span>' +
                '<div class="scv-week-day-num-row">' +
                    '<span class="scv-week-day-num' + (today ? ' today-badge' : '') + '">' + wd.getDate() + '</span>' +
                    schedBadge +
                '</div>' +
                (dotHtml ? '<div class="scv-week-hdr-dots">' + dotHtml + '</div>' : '') +
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
            var events = getGradeEvents(dateKey);

            // Stack overlapping events into columns
            var colEnds = [];
            var colAssign = {};
            events.forEach(function (ev, evi) {
                if (ev.startMin < START_HOUR * 60 || ev.startMin >= END_HOUR * 60) return;
                var placed = false;
                for (var ci = 0; ci < colEnds.length; ci++) {
                    if (ev.startMin >= colEnds[ci]) {
                        colEnds[ci] = ev.endMin;
                        colAssign[evi] = { col: ci, total: colEnds.length };
                        placed = true; break;
                    }
                }
                if (!placed) {
                    colAssign[evi] = { col: colEnds.length, total: colEnds.length + 1 };
                    colEnds.push(ev.endMin);
                }
            });
            var maxCols = colEnds.length || 1;
            for (var ck in colAssign) colAssign[ck].total = maxCols;

            events.forEach(function (ev, evi) {
                if (ev.startMin < START_HOUR * 60 || ev.startMin >= END_HOUR * 60) return;
                var topPx = (ev.startMin - START_HOUR * 60) * (HOUR_H / 60);
                var dur = Math.max(ev.endMin - ev.startMin, 15);
                var heightPx = Math.max(dur * (HOUR_H / 60) - 2, 24);
                var bgColor = lightenColor(ev.color, 0.82);

                var layout = colAssign[evi] || { col: 0, total: 1 };
                var wPct = 100 / layout.total;
                var lPct = layout.col * wPct;

                var block = document.createElement('div');
                block.className = 'scv-week-event';
                block.style.cssText = 'top:' + topPx + 'px;height:' + heightPx + 'px;' +
                    'left:calc(' + lPct + '% + 1px);width:calc(' + wPct + '% - 3px);' +
                    'background:' + bgColor + ';border-left:3px solid ' + ev.color + ';color:' + ev.color + ';';

                // Full detail: "1st Grade Trip - Zoo - 11:00 AM to 2:00 PM"
                var blockHtml = '<div class="scv-week-event-title">' +
                    escapeHtml(ev.division) + ' ' + escapeHtml(ev.longLabel) + '</div>';

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
'.scv-year-mini-day{font-size:10px;line-height:20px;color:var(--slate-600,#475569);border-radius:50%;text-align:center}' +
'.scv-year-mini-day.empty{visibility:hidden}' +
'.scv-year-mini-day.today{background:var(--camp-green,#147D91);color:#fff;font-weight:700}' +
'.scv-year-mini-day.has-sched{background:rgba(16,185,129,0.15);color:var(--slate-700,#334155);font-weight:500;border-radius:50%}' +
'.scv-grade-dots{display:flex;justify-content:center;gap:1px;margin-top:-2px;min-height:5px}' +
'.scv-grade-dot{width:4px;height:4px;border-radius:50%;flex-shrink:0}' +

/* Month */
'.scv-month-wrapper{border:1px solid var(--slate-200,#e2e8f0);border-radius:10px;overflow:hidden;background:#fff}' +
'.scv-month-header-row{display:grid;grid-template-columns:repeat(7,1fr);border-bottom:1px solid var(--slate-200,#e2e8f0)}' +
'.scv-month-hdr{padding:8px 0;text-align:center;font-size:12px;font-weight:600;color:var(--slate-500,#64748b);background:var(--slate-50,#f8fafc)}' +
'.scv-month-grid{display:grid;grid-template-columns:repeat(7,1fr)}' +
'.scv-month-cell{min-height:100px;padding:4px 6px;border-bottom:1px solid var(--slate-100,#f1f5f9);border-right:1px solid var(--slate-100,#f1f5f9);transition:background .1s;overflow:hidden;display:flex;flex-direction:column}' +
'.scv-month-cell:nth-child(7n){border-right:none}' +
'.scv-month-cell:hover{background:var(--slate-50,#f8fafc)}' +
'.scv-month-cell.outside{opacity:.35}' +
'.scv-month-cell.weekend{background:var(--slate-50,#f8fafc)}' +
'.scv-month-cell.weekend:hover{background:var(--slate-100,#f1f5f9)}' +
'.scv-month-day-num{font-size:12px;font-weight:500;color:var(--slate-700,#334155);display:inline-block;margin-bottom:4px}' +
'.scv-month-cell.outside .scv-month-day-num{color:var(--slate-400,#94a3b8)}' +
'.today-badge{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--camp-green,#147D91);color:#fff!important;font-weight:700;font-size:11px}' +
'.scv-month-more{font-size:10px;color:var(--slate-400,#94a3b8);padding-left:5px}' +

/* Month event lines */
'.scv-month-ev{font-size:10px;line-height:15px;padding:2px 6px;border-radius:4px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}' +
'.scv-month-sched{font-size:9px;color:#059669;font-weight:600;margin-top:auto;padding-top:4px;opacity:.7}' +
'.scv-month-no-sched{font-size:9px;color:var(--slate-300,#cbd5e1);margin-top:auto;padding-top:4px}' +

/* Week */
'.scv-week-wrapper{border:1px solid var(--slate-200,#e2e8f0);border-radius:10px;overflow:hidden;background:#fff}' +
'.scv-week-header{display:grid;grid-template-columns:56px repeat(7,1fr);border-bottom:1px solid var(--slate-200,#e2e8f0)}' +
'.scv-week-gutter-hdr{background:var(--slate-50,#f8fafc)}' +
'.scv-week-day-hdr{padding:8px 4px;text-align:center;background:var(--slate-50,#f8fafc);border-left:1px solid var(--slate-100,#f1f5f9);transition:background .1s}' +
'.scv-week-day-hdr:hover{background:var(--slate-100,#f1f5f9)}' +
'.scv-week-day-hdr.today{background:rgba(20,125,145,.06)}' +
'.scv-week-day-num-row{display:flex;align-items:center;justify-content:center;gap:4px}' +
'.scv-week-sched-badge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:rgba(16,185,129,0.15);color:#059669;font-size:9px;font-weight:700}' +
'.scv-week-no-sched-badge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--slate-100,#f1f5f9);color:var(--slate-300,#cbd5e1);font-size:9px;font-weight:700}' +
'.scv-week-hdr-dots{display:flex;justify-content:center;gap:3px;margin-top:3px}' +
'.scv-week-hdr-dot{display:inline-block;width:7px;height:7px;border-radius:50%}' +
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
'.scv-week-event-title{overflow:hidden;text-overflow:ellipsis;line-height:14px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:normal;word-break:break-word}' +
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
