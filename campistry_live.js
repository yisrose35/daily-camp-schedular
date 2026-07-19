// =============================================================================
// campistry_live.js — Campistry Live v1.0
// Office Mission Control — Real-time camp-wide attendance & activity dashboard
//
// Features:
//   - Dashboard: live stats, current activity overview, division summary
//   - Activity Board: every activity right now with bunks and camper counts
//   - Bunk Tracker: follow every bunk through the day
//   - Roll Call: morning attendance by division
//   - Absences & Exceptions: absent, sick, late, appointments
//   - Early Pickups: track who's leaving early
//   - Reports: daily/weekly attendance export
// =============================================================================
(function () {
    'use strict';
    console.log('[Live] Campistry Live v1.0 loading...');

    // =========================================================================
    // DATA ACCESS — roster comes from Me's global settings; the day's roll call
    // (attendance / absences / early pickups) lives in the localStorage blob
    // `campistry_live_v1`, keyed by a noon-anchored date. These mirror the
    // private copies used by the page's inline scripts (Parent Requests bridge)
    // so this file is self-contained; both touch the same localStorage keys and
    // stay consistent. Roster access matches the sibling products (Health/Go).
    // =========================================================================
    var GLOBAL_KEY = 'campGlobalSettings_v1';
    var LIVE_STORE_KEY = 'campistry_live_v1';
    function readGlobal() { try { return JSON.parse(localStorage.getItem(GLOBAL_KEY) || '{}'); } catch (e) { return {}; } }
    function getRoster() { var g = readGlobal(); return (g.app1 && g.app1.camperRoster) || {}; }
    function getStructure() { return readGlobal().campStructure || {}; }
    function getCampName() { var g = readGlobal(); return g.camp_name || g.campName || localStorage.getItem('campistry_camp_name') || 'Your Camp'; }
    function getLive() { try { return JSON.parse(localStorage.getItem(LIVE_STORE_KEY) || '{}'); } catch (e) { return {}; } }
    function saveLive(d) { try { d.updated_at = new Date().toISOString(); localStorage.setItem(LIVE_STORE_KEY, JSON.stringify(d)); } catch (e) {} }
    function getTodayKey() { var d = new Date(); d.setHours(12, 0, 0, 0); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function getTodayData() { var data = getLive(), key = getTodayKey(); if (!data[key]) data[key] = { attendance: {}, absences: [], earlyPickups: [], notes: '' }; return data[key]; }
    function saveTodayData(t) { var d = getLive(); d[getTodayKey()] = t; saveLive(d); }

    // Shared UI helpers (each product defines its own, matching Health/Go).
    function esc(s) { if (s == null) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function toast(msg) {
        var el = document.getElementById('toastEl'); if (!el) return;
        el.textContent = msg; el.className = 'toast';
        requestAnimationFrame(function () { el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2500); });
    }

    // =========================================================================
    // RENDER: ROLL CALL
    // =========================================================================
    let _rcFilter = '';

    function rcIsPresent(name, today) {
        return !today.absences.some(a => a.name === name) && today.attendance[name] !== false;
    }

    function rcInitials(name) {
        return String(name).split(' ').map(p => p[0] || '').join('').slice(0, 2).toUpperCase();
    }

    function rcRow(name, c, today, showBunk) {
        const present = rcIsPresent(name, today);
        const check = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
        const x = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        return '<div class="rc-row ' + (present ? 'present' : 'absent') + '" data-camper="' + esc(name) + '" onclick="CampistryLive.toggleByEl(this)">' +
            '<div class="rc-avatar">' + esc(rcInitials(name)) + '</div>' +
            '<div class="rc-info">' +
            '<div class="rc-name">' + esc(name) + '</div>' +
            (showBunk && c.bunk ? '<div class="rc-detail">' + esc(c.bunk) + (c.division ? ' · ' + esc(c.division) : '') + '</div>' : '') +
            '</div>' +
            '<div class="rc-check">' + (present ? check : x) + '</div>' +
            '</div>';
    }

    function renderRollCall() {
        const struct = getStructure();
        const roster = getRoster();
        const today = getTodayData();
        const body = document.getElementById('rollCallBody');
        if (!body) return;

        const savedScroll = body.closest('.live-page')?.scrollTop || window.scrollY;
        const filter = _rcFilter.toLowerCase().trim();

        let html = '<div class="rc-search-wrap">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
            '<input id="rcSearchInput" type="text" placeholder="Search camper…" value="' + esc(filter) + '" oninput="CampistryLive.filterRollCall(this.value)" autocomplete="off">' +
            (filter ? '<button class="rc-clear" onclick="CampistryLive.clearRcFilter()">&times;</button>' : '') +
            '</div>';

        if (filter) {
            const matches = Object.entries(roster)
                .filter(([name]) => name.toLowerCase().includes(filter))
                .sort(([a], [b]) => a.localeCompare(b));

            if (!matches.length) {
                html += '<div class="empty-state">No campers matching “' + esc(filter) + '”</div>';
            } else {
                html += '<div class="rc-division"><div class="rc-div-header" style="border-left:none">' +
                    '<div class="rc-div-left"><div class="rc-div-name">Search results</div><div class="rc-div-sub">' + matches.length + ' camper' + (matches.length !== 1 ? 's' : '') + ' found</div></div></div>';
                matches.forEach(([name, c]) => { html += rcRow(name, c, today, true); });
                html += '</div>';
            }
        } else {
            const divEntries = Object.entries(struct);
            if (!divEntries.length) {
                html += '<div class="empty-state">No divisions configured. Set up camp structure in Campistry Me.</div>';
            }

            divEntries.forEach(([divName, divData]) => {
                const color = divData.color || '#3b82f6';
                const divCampers = Object.entries(roster).filter(([, c]) => c.division === divName);
                if (!divCampers.length) return;

                const presentInDiv = divCampers.filter(([n]) => rcIsPresent(n, today)).length;
                const pct = divCampers.length ? Math.round((presentInDiv / divCampers.length) * 100) : 0;

                // Group by bunk
                const bunkMap = {};
                divCampers.forEach(([name, c]) => {
                    const bk = c.bunk || '—';
                    if (!bunkMap[bk]) bunkMap[bk] = [];
                    bunkMap[bk].push([name, c]);
                });
                Object.values(bunkMap).forEach(list => list.sort(([a], [b]) => a.localeCompare(b)));

                html += '<div class="rc-division" style="border-left:4px solid ' + esc(color) + '">';
                html += '<div class="rc-div-header">' +
                    '<div class="rc-div-left"><div class="rc-div-name">' + esc(divName) + '</div>' +
                    '<div class="rc-div-sub">' + divCampers.length + ' campers &nbsp;&middot;&nbsp; ' + Object.keys(bunkMap).length + ' bunk' + (Object.keys(bunkMap).length !== 1 ? 's' : '') + '</div></div>' +
                    '<div class="rc-div-right">' +
                    '<div class="rc-div-count">' + presentInDiv + ' <span>/ ' + divCampers.length + '</span></div>' +
                    '<div class="rc-div-bar"><div class="rc-div-bar-fill" style="width:' + pct + '%;background:' + esc(color) + '"></div></div>' +
                    '</div></div>';

                Object.entries(bunkMap).forEach(([bunkName, campers]) => {
                    const presentInBunk = campers.filter(([n]) => rcIsPresent(n, today)).length;
                    html += '<div class="rc-bunk">' +
                        '<div class="rc-bunk-header">' +
                        '<span class="rc-bunk-name">' + esc(bunkName) + '</span>' +
                        '<span class="rc-bunk-count">' + presentInBunk + '/' + campers.length + '</span>' +
                        '<button class="rc-bunk-all" data-bunk="' + esc(bunkName) + '" onclick="event.stopPropagation();CampistryLive.markBunkByEl(this)">All Present</button>' +
                        '</div>';
                    campers.forEach(([name, c]) => { html += rcRow(name, c, today, false); });
                    html += '</div>';
                });

                html += '</div>';
            });
        }

        body.innerHTML = html;

        if (filter) {
            const inp = document.getElementById('rcSearchInput');
            if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
        }
    }

    function filterRollCall(val) {
        _rcFilter = val;
        renderRollCall();
    }

    function toggleAttendance(name) {
        const today = getTodayData();
        today.absences = today.absences.filter(a => a.name !== name);
        if (today.attendance[name] === false) {
            delete today.attendance[name];
        } else {
            today.attendance[name] = false;
        }
        saveTodayData(today);
        renderRollCall();
        renderDashboard();
        toast(name + (today.attendance[name] === false ? ' marked absent' : ' marked present'));
    }

    function markAllPresent() {
        const today = getTodayData();
        today.attendance = {};
        today.absences = [];
        saveTodayData(today);
        renderRollCall();
        renderDashboard();
        toast('All campers marked present');
    }

    function markBunkPresent(bunkName) {
        const roster = getRoster();
        const today = getTodayData();
        let count = 0;
        Object.entries(roster).forEach(([name, c]) => {
            if (c.bunk === bunkName) {
                today.absences = today.absences.filter(a => a.name !== name);
                delete today.attendance[name];
                count++;
            }
        });
        saveTodayData(today);
        renderRollCall();
        renderDashboard();
        toast(esc(bunkName) + ' — all ' + count + ' marked present');
    }

    function clearRcFilter() { _rcFilter = ''; renderRollCall(); }
    function filterRollCall(val) { _rcFilter = val || ''; renderRollCall(); }
    function toggleByEl(el) { toggleAttendance(el.getAttribute('data-camper')); }
    function markBunkByEl(el) { markBunkPresent(el.getAttribute('data-bunk')); }


    function getCurrentTimeMinutes() {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
    }

    function formatTimeMinutes(min) {
        const h = Math.floor(min / 60), m = min % 60;
        const p = h >= 12 ? 'PM' : 'AM', h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return h12 + ':' + String(m).padStart(2, '0') + ' ' + p;
    }

    function formatTimeNow() {
        const now = new Date();
        const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
        const p = h >= 12 ? 'PM' : 'AM', h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return h12 + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ' ' + p;
    }

    // =========================================================================
    // SCHEDULE READING — uses same data as camper_locator.js
    // =========================================================================

    function findDivisionSlotForTime(divisionName, timeMinutes) {
        const divSlots = window.divisionTimes?.[divisionName] || [];
        if (!divSlots.length) {
            if (window.SchedulerCoreUtils?.findSlotForTime) return window.SchedulerCoreUtils.findSlotForTime(divisionName, timeMinutes);
            return -1;
        }
        for (let i = 0; i < divSlots.length; i++) {
            if (divSlots[i].startMin <= timeMinutes && timeMinutes < divSlots[i].endMin) return i;
        }
        if (timeMinutes < divSlots[0].startMin) return 0;
        if (timeMinutes >= divSlots[divSlots.length - 1].endMin) return divSlots.length - 1;
        return -1;
    }

    function getSlotLabel(divisionName, slotIdx) {
        const divSlots = window.divisionTimes?.[divisionName] || [];
        const slot = divSlots[slotIdx];
        if (!slot) return 'Period ' + (slotIdx + 1);
        return formatTimeMinutes(slot.startMin) + ' – ' + formatTimeMinutes(slot.endMin);
    }

    function getCurrentPeriodInfo() {
        const struct = getStructure();
        const divNames = Object.keys(struct);
        if (!divNames.length) return { periodLabel: 'No schedule', slotIdx: -1 };
        const now = getCurrentTimeMinutes();
        const firstDiv = divNames[0];
        const idx = findDivisionSlotForTime(firstDiv, now);
        if (idx < 0) return { periodLabel: 'Outside schedule', slotIdx: -1 };
        return { periodLabel: 'Period ' + (idx + 1) + ' — ' + getSlotLabel(firstDiv, idx), slotIdx: idx };
    }

    // Get what a bunk is doing right now
    function getBunkActivity(bunkName, divisionName) {
        const now = getCurrentTimeMinutes();
        const slotIdx = findDivisionSlotForTime(divisionName, now);
        if (slotIdx < 0) return { activity: 'No schedule', location: '' };

        const settings = readGlobal();
        const schedule = settings.app1?.schedule;
        if (!schedule) return { activity: 'No schedule loaded', location: '' };

        // Find today's schedule
        const todayKey = getTodayKey();
        const todaySchedule = schedule[todayKey] || schedule;
        const bunks = todaySchedule.bunks || todaySchedule;

        // Look up this bunk's assignment
        const bunkData = bunks[bunkName];
        if (!bunkData) return { activity: 'Unscheduled', location: '' };

        const assignment = Array.isArray(bunkData) ? bunkData[slotIdx] : bunkData[slotIdx];
        if (!assignment) return { activity: 'Free', location: '' };

        if (typeof assignment === 'string') return { activity: assignment, location: '' };
        return { activity: assignment.activity || assignment.name || 'Unknown', location: assignment.field || assignment.location || '' };
    }

    // Build full activity map for current time
    function buildActivityMap() {
        const struct = getStructure();
        const roster = getRoster();
        const today = getTodayData();
        const absentNames = new Set(today.absences.map(a => a.name));
        const pickedUpNames = new Set(today.earlyPickups.map(p => p.name));
        const activities = {}; // activity → { location, bunks: [{bunkName, division, camperCount}] }

        Object.entries(struct).forEach(([divName, divData]) => {
            const grades = divData.grades || {};
            Object.entries(grades).forEach(([gradeName, gradeData]) => {
                const bunks = gradeData.bunks || [];
                bunks.forEach(bunkName => {
                    const { activity, location } = getBunkActivity(bunkName, divName);
                    if (!activity || activity === 'No schedule' || activity === 'No schedule loaded') return;

                    // Count campers in this bunk
                    let camperCount = 0;
                    Object.entries(roster).forEach(([name, c]) => {
                        if (c.bunk === bunkName && !absentNames.has(name) && !pickedUpNames.has(name)) camperCount++;
                    });

                    const key = activity + '||' + (location || '');
                    if (!activities[key]) activities[key] = { activity, location, bunks: [], totalKids: 0 };
                    activities[key].bunks.push({ bunkName, division: divName, camperCount });
                    activities[key].totalKids += camperCount;
                });
            });
        });

        return Object.values(activities).sort((a, b) => b.totalKids - a.totalKids);
    }

    // =========================================================================
    // RENDER: DASHBOARD
    // =========================================================================
    function renderDashboard() {
        const roster = getRoster();
        const struct = getStructure();
        const today = getTodayData();
        const camperNames = Object.keys(roster);
        const totalCampers = camperNames.length;
        const absentCount = today.absences.length;
        const pickedUpCount = today.earlyPickups.length;
        const presentCount = Math.max(0, totalCampers - absentCount - pickedUpCount);

        // Date line
        const dateEl = document.getElementById('dashDateLine');
        if (dateEl) {
            const d = new Date();
            const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            dateEl.textContent = getCampName() + ' — ' + d.toLocaleDateString('en-US', opts);
        }

        // Stats
        const el = id => document.getElementById(id);
        if (el('statTotalCampers')) el('statTotalCampers').textContent = totalCampers;
        if (el('statPresent')) el('statPresent').textContent = presentCount;
        if (el('statAbsent')) el('statAbsent').textContent = absentCount + pickedUpCount;
        const period = getCurrentPeriodInfo();
        if (el('statCurrentPeriod')) el('statCurrentPeriod').textContent = period.slotIdx >= 0 ? 'P' + (period.slotIdx + 1) : '—';
        if (el('currentPeriodLabel')) el('currentPeriodLabel').textContent = period.periodLabel;
        if (el('sbAbsentCount')) el('sbAbsentCount').textContent = absentCount;

        // Activity overview
        const actMap = buildActivityMap();
        const actBody = el('activityOverviewBody');
        if (actBody) {
            if (!actMap.length) {
                actBody.innerHTML = '<div class="empty-state">No schedule loaded for today. Generate a schedule in Flow first.</div>';
            } else {
                actBody.innerHTML = '<div class="activity-grid">' + actMap.map(a => {
                    const bunkChips = a.bunks.map(b => '<span class="bunk-chip">' + esc(b.bunkName) + '</span>').join('');
                    return '<div class="activity-cell"><div class="activity-cell-header"><span class="activity-name">' + esc(a.activity) + '</span>' + (a.location ? '<span class="activity-location">' + esc(a.location) + '</span>' : '') + '</div><div class="activity-bunks">' + bunkChips + '</div><div style="margin-top:6px"><span class="activity-count">' + a.totalKids + ' campers</span> · ' + a.bunks.length + ' bunk(s)</div></div>';
                }).join('') + '</div>';
            }
        }

        // Division summary
        const divBody = el('divisionSummaryBody');
        if (divBody) {
            const absentNames = new Set(today.absences.map(a => a.name));
            const pickedUpNames = new Set(today.earlyPickups.map(p => p.name));
            let html = '';
            Object.entries(struct).forEach(([divName, divData]) => {
                const color = divData.color || '#3b82f6';
                let total = 0, present = 0;
                Object.values(roster).forEach(c => {
                    if (c.division === divName) { total++; if (!absentNames.has(c.name) && !pickedUpNames.has(c.name)) present++; }
                });
                // Lookup current activity for first bunk in this division
                const firstBunk = Object.values(divData.grades || {})[0]?.bunks?.[0];
                const activity = firstBunk ? getBunkActivity(firstBunk, divName) : { activity: '—' };
                html += '<div class="division-row"><span class="division-dot" style="background:' + esc(color) + '"></span><span class="division-name">' + esc(divName) + '</span><span class="division-info">' + present + '/' + total + ' present · ' + esc(activity.activity) + '</span></div>';
            });
            divBody.innerHTML = html || '<div class="empty-state">No divisions configured</div>';
        }
    }

    // =========================================================================
    // RENDER: ACTIVITY BOARD
    // =========================================================================
    function renderActivityBoard() {
        const actMap = buildActivityMap();
        const body = document.getElementById('activityBoardBody');
        if (!body) return;
        if (!actMap.length) { body.innerHTML = '<div class="empty-state">No schedule loaded for today</div>'; return; }

        body.innerHTML = '<div class="activity-grid">' + actMap.map(a => {
            const bunkRows = a.bunks.map(b => '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:.8rem;border-bottom:1px solid var(--slate-50,#f8fafc);"><span style="font-weight:500;">' + esc(b.bunkName) + '</span><span style="color:var(--slate-500);font-size:.7rem;">' + esc(b.division) + '</span><span style="font-weight:600;">' + b.camperCount + '</span></div>').join('');
            return '<div class="activity-cell"><div class="activity-cell-header"><span class="activity-name">' + esc(a.activity) + '</span><span class="activity-count">' + a.totalKids + ' kids</span></div>' + (a.location ? '<div style="font-size:.7rem;color:var(--slate-500);margin-bottom:6px;">📍 ' + esc(a.location) + '</div>' : '') + '<div>' + bunkRows + '</div></div>';
        }).join('') + '</div>';
    }

    // =========================================================================
    // RENDER: BUNK TRACKER
    // =========================================================================
    let _bunkFilter = '';

    function renderBunkTracker() {
        const struct = getStructure();
        const roster = getRoster();
        const today = getTodayData();
        const absentNames = new Set(today.absences.map(a => a.name));
        const pickedUpNames = new Set(today.earlyPickups.map(p => p.name));
        const body = document.getElementById('bunkTrackerBody');
        if (!body) return;

        let html = '<div class="bunk-grid">';
        const filter = _bunkFilter.toLowerCase();

        Object.entries(struct).forEach(([divName, divData]) => {
            const color = divData.color || '#3b82f6';
            Object.entries(divData.grades || {}).forEach(([gradeName, gradeData]) => {
                (gradeData.bunks || []).forEach(bunkName => {
                    // Get campers in this bunk
                    const campers = Object.entries(roster).filter(([, c]) => c.bunk === bunkName);
                    if (filter && !bunkName.toLowerCase().includes(filter) && !campers.some(([n]) => n.toLowerCase().includes(filter))) return;

                    const { activity, location } = getBunkActivity(bunkName, divName);
                    const presentCount = campers.filter(([n]) => !absentNames.has(n) && !pickedUpNames.has(n)).length;

                    html += '<div class="bunk-card"><div class="bunk-card-header" style="background:' + esc(color) + '20;border-left:4px solid ' + esc(color) + ';"><span>' + esc(bunkName) + ' <span style="font-weight:400;font-size:.7rem;color:var(--slate-500);">' + esc(divName) + '</span></span><span style="font-size:.75rem;">' + presentCount + '/' + campers.length + ' · ' + esc(activity) + '</span></div><div class="bunk-card-body">';

                    campers.forEach(([name, c]) => {
                        const isAbsent = absentNames.has(name);
                        const isPickedUp = pickedUpNames.has(name);
                        const status = isPickedUp ? 'pickup' : isAbsent ? 'absent' : (today.attendance[name] === false ? 'absent' : 'present');
                        const statusLabel = isPickedUp ? 'Picked Up' : isAbsent ? 'Absent' : 'Present';
                        html += '<div class="bunk-camper-row"><span>' + esc(name) + '</span><span class="camper-status ' + status + '">' + statusLabel + '</span></div>';
                    });

                    html += '</div></div>';
                });
            });
        });

        html += '</div>';
        body.innerHTML = html;
    }

    function filterBunks(val) { _bunkFilter = val; renderBunkTracker(); }

    // =========================================================================
    // RENDER: ROLL CALL
    // =========================================================================
    function renderRollCall() {
        const struct = getStructure();
        const roster = getRoster();
        const today = getTodayData();
        const body = document.getElementById('rollCallBody');
        if (!body) return;

        let html = '';
        Object.entries(struct).forEach(([divName, divData]) => {
            const color = divData.color || '#3b82f6';
            const divCampers = Object.entries(roster).filter(([, c]) => c.division === divName).sort(([a], [b]) => a.localeCompare(b));
            const presentCount = divCampers.filter(([n]) => today.attendance[n] !== false && !today.absences.some(a => a.name === n)).length;

            html += '<div class="rollcall-division"><div class="rollcall-division-header"><span class="division-dot" style="background:' + esc(color) + '"></span><span>' + esc(divName) + '</span><span style="margin-left:auto;font-size:.75rem;color:var(--slate-500);">' + presentCount + '/' + divCampers.length + '</span></div><div class="rollcall-body">';

            divCampers.forEach(([name, c]) => {
                const isAbsent = today.absences.some(a => a.name === name);
                const isPresent = !isAbsent && today.attendance[name] !== false;
                html += '<div class="rollcall-row"><span class="rollcall-bunk">' + esc(c.bunk || '') + '</span><span class="rollcall-name">' + esc(name) + '</span><button class="rollcall-toggle ' + (isPresent ? 'on' : 'off') + '" onclick="CampistryLive.toggleAttendance(\'' + esc(name.replace(/'/g, "\\'")) + '\')" title="' + (isPresent ? 'Present' : 'Absent') + '"></button></div>';
            });

            html += '</div></div>';
        });

        body.innerHTML = html || '<div class="empty-state">No divisions configured. Set up camp structure in Campistry Me.</div>';
    }

    function toggleAttendance(name) {
        const today = getTodayData();
        // Remove from absences if present there
        today.absences = today.absences.filter(a => a.name !== name);
        // Toggle manual attendance
        if (today.attendance[name] === false) {
            delete today.attendance[name]; // back to present (default)
        } else {
            today.attendance[name] = false; // mark absent
        }
        saveTodayData(today);
        renderRollCall();
        renderDashboard();
        toast(name + (today.attendance[name] === false ? ' marked absent' : ' marked present'));
    }

    function markAllPresent() {
        const today = getTodayData();
        today.attendance = {};
        today.absences = [];
        saveTodayData(today);
        renderRollCall();
        renderDashboard();
        toast('All campers marked present');
    }

    // =========================================================================
    // ABSENCES & EXCEPTIONS
    // =========================================================================
    function renderAbsences() {
        const today = getTodayData();
        const body = document.getElementById('absencesBody');
        if (!body) return;
        if (!today.absences.length) { body.innerHTML = '<div class="empty-state">No absences recorded today</div>'; return; }

        body.innerHTML = '<div class="card"><div class="card-body">' + today.absences.map((a, i) => {
            return '<div class="absence-row"><span style="font-weight:600;flex:1;">' + esc(a.name) + '</span><span class="absence-reason ' + esc(a.reason) + '">' + esc(a.reason) + '</span>' + (a.notes ? '<span style="color:var(--slate-500);font-size:.75rem;flex:1;">' + esc(a.notes) + '</span>' : '') + '<span style="font-size:.7rem;color:var(--slate-400);">' + esc(a.time || '') + '</span><button class="btn btn-secondary" style="padding:4px 8px;font-size:.7rem;" onclick="CampistryLive.removeAbsence(' + i + ')">Remove</button></div>';
        }).join('') + '</div></div>';
    }

    function openAbsenceModal() {
        populateCamperSelect('absenceCamper');
        document.getElementById('absenceSearch').value = '';
        document.getElementById('absenceNotes').value = '';
        document.getElementById('absenceReason').value = 'absent';
        openModal('absenceModal');
        document.getElementById('absenceSearch').focus();
    }

    function filterAbsenceSearch(val) { filterCamperSelect(val, 'absenceCamper'); }

    function saveAbsence() {
        const name = document.getElementById('absenceCamper')?.value;
        if (!name) { toast('Select a camper', 'error'); return; }
        const reason = document.getElementById('absenceReason')?.value || 'absent';
        const notes = document.getElementById('absenceNotes')?.value.trim() || '';
        const today = getTodayData();
        // Don't duplicate
        if (today.absences.some(a => a.name === name)) { toast(name + ' already marked', 'error'); return; }
        today.absences.push({ name, reason, notes, time: formatTimeNow(), timestamp: Date.now() });
        today.attendance[name] = false;
        saveTodayData(today);
        closeModal('absenceModal');
        renderAbsences(); renderRollCall(); renderDashboard(); renderBunkTracker();
        toast(name + ' marked ' + reason);
    }

    function removeAbsence(idx) {
        const today = getTodayData();
        const removed = today.absences.splice(idx, 1)[0];
        if (removed) delete today.attendance[removed.name];
        saveTodayData(today);
        renderAbsences(); renderRollCall(); renderDashboard(); renderBunkTracker();
        toast((removed?.name || 'Camper') + ' absence removed');
    }

    // =========================================================================
    // EARLY PICKUPS
    // =========================================================================
    function renderEarlyPickups() {
        const today = getTodayData();
        const body = document.getElementById('earlyPickupBody');
        if (!body) return;
        if (!today.earlyPickups.length) { body.innerHTML = '<div class="empty-state">No early pickups today</div>'; return; }

        body.innerHTML = '<div class="card"><div class="card-body">' + today.earlyPickups.map((p, i) => {
            return '<div class="absence-row"><span style="font-weight:600;flex:1;">' + esc(p.name) + '</span><span style="font-size:.75rem;color:var(--slate-500);">Pickup: ' + esc(p.pickupTime || '') + '</span><span style="font-size:.75rem;color:var(--slate-500);">By: ' + esc(p.pickedUpBy || '—') + '</span>' + (p.reason ? '<span style="font-size:.75rem;color:var(--slate-400);">' + esc(p.reason) + '</span>' : '') + '<button class="btn btn-secondary" style="padding:4px 8px;font-size:.7rem;" onclick="CampistryLive.removePickup(' + i + ')">Remove</button></div>';
        }).join('') + '</div></div>';
    }

    function openPickupModal() {
        populateCamperSelect('pickupCamper');
        document.getElementById('pickupSearch').value = '';
        document.getElementById('pickupTime').value = '';
        document.getElementById('pickupBy').value = '';
        document.getElementById('pickupReason').value = '';
        openModal('pickupModal');
        document.getElementById('pickupSearch').focus();
    }

    function filterPickupSearch(val) { filterCamperSelect(val, 'pickupCamper'); }

    function savePickup() {
        const name = document.getElementById('pickupCamper')?.value;
        if (!name) { toast('Select a camper', 'error'); return; }
        const pickupTime = document.getElementById('pickupTime')?.value || formatTimeNow();
        const pickedUpBy = document.getElementById('pickupBy')?.value.trim() || '';
        const reason = document.getElementById('pickupReason')?.value.trim() || '';
        const today = getTodayData();
        if (today.earlyPickups.some(p => p.name === name)) { toast(name + ' already picked up', 'error'); return; }
        today.earlyPickups.push({ name, pickupTime, pickedUpBy, reason, timestamp: Date.now() });
        saveTodayData(today);
        closeModal('pickupModal');
        renderEarlyPickups(); renderDashboard(); renderBunkTracker();
        toast(name + ' early pickup recorded');
    }

    function removePickup(idx) {
        const today = getTodayData();
        const removed = today.earlyPickups.splice(idx, 1)[0];
        saveTodayData(today);
        renderEarlyPickups(); renderDashboard(); renderBunkTracker();
        toast((removed?.name || 'Camper') + ' pickup removed');
    }

    // =========================================================================
    // REPORTS
    // =========================================================================
    function renderReports() {
        const today = getTodayData();
        const roster = getRoster();
        const struct = getStructure();
        const body = document.getElementById('reportsBody');
        if (!body) return;

        const totalCampers = Object.keys(roster).length;
        const absentCount = today.absences.length;
        const pickedUpCount = today.earlyPickups.length;
        const presentCount = totalCampers - absentCount - pickedUpCount;
        const pct = totalCampers > 0 ? Math.round((presentCount / totalCampers) * 100) : 0;

        let html = '<div class="stats-grid" style="margin-bottom:20px;">';
        html += '<div class="stat-card"><div class="stat-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div><div><div class="stat-value">' + pct + '%</div><div class="stat-label">Attendance Rate</div></div></div>';
        html += '<div class="stat-card"><div class="stat-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/></svg></div><div><div class="stat-value">' + presentCount + '</div><div class="stat-label">Present</div></div></div>';
        html += '<div class="stat-card"><div class="stat-icon red"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/></svg></div><div><div class="stat-value">' + absentCount + '</div><div class="stat-label">Absent</div></div></div>';
        html += '<div class="stat-card"><div class="stat-icon purple"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></div><div><div class="stat-value">' + pickedUpCount + '</div><div class="stat-label">Early Pickups</div></div></div>';
        html += '</div>';

        // Per-division breakdown
        html += '<div class="card"><div class="card-header"><h2>By Division</h2></div><div class="card-body"><table style="width:100%;border-collapse:collapse;font-size:.8125rem;"><thead><tr style="border-bottom:2px solid var(--slate-200);"><th style="text-align:left;padding:8px;">Division</th><th style="text-align:center;padding:8px;">Total</th><th style="text-align:center;padding:8px;">Present</th><th style="text-align:center;padding:8px;">Absent</th><th style="text-align:center;padding:8px;">Rate</th></tr></thead><tbody>';

        const absentNames = new Set(today.absences.map(a => a.name));
        const pickedUpNames = new Set(today.earlyPickups.map(p => p.name));

        Object.entries(struct).forEach(([divName, divData]) => {
            let dt = 0, dp = 0;
            Object.entries(roster).forEach(([name, c]) => {
                if (c.division === divName) { dt++; if (!absentNames.has(name) && !pickedUpNames.has(name)) dp++; }
            });
            const da = dt - dp;
            const dr = dt > 0 ? Math.round((dp / dt) * 100) : 0;
            html += '<tr style="border-bottom:1px solid var(--slate-100);"><td style="padding:8px;font-weight:600;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + esc(divData.color || '#3b82f6') + ';margin-right:6px;"></span>' + esc(divName) + '</td><td style="text-align:center;padding:8px;">' + dt + '</td><td style="text-align:center;padding:8px;color:#16A34A;font-weight:600;">' + dp + '</td><td style="text-align:center;padding:8px;color:#DC2626;font-weight:600;">' + da + '</td><td style="text-align:center;padding:8px;font-weight:700;">' + dr + '%</td></tr>';
        });

        html += '</tbody></table></div></div>';

        // Absent list
        if (today.absences.length) {
            html += '<div class="card"><div class="card-header"><h2>Absent Campers</h2></div><div class="card-body"><table style="width:100%;border-collapse:collapse;font-size:.8125rem;"><thead><tr style="border-bottom:2px solid var(--slate-200);"><th style="text-align:left;padding:6px;">Name</th><th style="text-align:left;padding:6px;">Division</th><th style="text-align:left;padding:6px;">Bunk</th><th style="text-align:left;padding:6px;">Reason</th><th style="text-align:left;padding:6px;">Notes</th></tr></thead><tbody>';
            today.absences.forEach(a => {
                const c = roster[a.name] || {};
                html += '<tr style="border-bottom:1px solid var(--slate-100);"><td style="padding:6px;font-weight:600;">' + esc(a.name) + '</td><td style="padding:6px;">' + esc(c.division || '') + '</td><td style="padding:6px;">' + esc(c.bunk || '') + '</td><td style="padding:6px;"><span class="absence-reason ' + esc(a.reason) + '">' + esc(a.reason) + '</span></td><td style="padding:6px;color:var(--slate-500);">' + esc(a.notes || '') + '</td></tr>';
            });
            html += '</tbody></table></div></div>';
        }

        body.innerHTML = html;
    }

    function exportAttendanceCsv() {
        const roster = getRoster();
        const today = getTodayData();
        const absentNames = new Set(today.absences.map(a => a.name));
        const pickedUpNames = new Set(today.earlyPickups.map(p => p.name));
        const absenceMap = {};
        today.absences.forEach(a => { absenceMap[a.name] = a; });

        let csv = '\uFEFFName,Division,Bunk,Status,Reason,Notes\n';
        Object.entries(roster).sort(([a], [b]) => a.localeCompare(b)).forEach(([name, c]) => {
            const isAbsent = absentNames.has(name);
            const isPickedUp = pickedUpNames.has(name);
            const status = isPickedUp ? 'Early Pickup' : isAbsent ? 'Absent' : 'Present';
            const ab = absenceMap[name];
            const reason = ab?.reason || '';
            const notes = ab?.notes || '';
            csv += [name, c.division || '', c.bunk || '', status, reason, notes].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n';
        });

        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'campistry_attendance_' + getTodayKey() + '.csv';
        a.click();
        toast('Attendance exported');
    }

    // =========================================================================
    // CAMPER SELECT HELPERS
    // =========================================================================
    function populateCamperSelect(selectId) {
        const roster = getRoster();
        const names = Object.keys(roster).sort();
        const sel = document.getElementById(selectId);
        if (!sel) return;
        sel.innerHTML = '<option value="">— Select —</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
    }

    function filterCamperSelect(val, selectId) {
        const roster = getRoster();
        const q = (val || '').toLowerCase().trim();
        const names = Object.keys(roster).sort().filter(n => !q || n.toLowerCase().includes(q));
        const sel = document.getElementById(selectId);
        if (!sel) return;
        sel.innerHTML = '<option value="">— Select —</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
        if (names.length === 1) sel.value = names[0];
    }

    // =========================================================================
    // AUTO-REFRESH
    // =========================================================================
    let _refreshInterval = null;

    function startAutoRefresh() {
        // Refresh dashboard every 60 seconds for live updates
        _refreshInterval = setInterval(() => {
            renderDashboard();
        }, 60000);
    }

    // =========================================================================
    // INIT
    // =========================================================================
    function refresh() {
        renderDashboard();
        renderActivityBoard();
        renderBunkTracker();
        renderRollCall();
        renderAbsences();
        renderEarlyPickups();
        renderReports();
        toast('Refreshed');
    }

    function init() {
        console.log('[Live] Initializing...');
        startAutoRefresh();

        // Wait for cloud hydration if available
        const doRender = () => {
            renderDashboard();
            renderRollCall();
            renderAbsences();
            renderEarlyPickups();
            console.log('[Live] Ready —', Object.keys(getRoster()).length, 'campers');
        };

        // Try immediate render
        setTimeout(doRender, 300);

        // Re-render on cloud hydration
        window.addEventListener('campistry-cloud-hydrated', () => {
            console.log('[Live] Cloud data hydrated — refreshing');
            doRender();
        });
        window.addEventListener('storage', (e) => {
            if (e.key === 'campGlobalSettings_v1') doRender();
        });

        // Modal close handlers
        document.querySelectorAll('.modal-overlay').forEach(o => {
            o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
        });
    }

    // =========================================================================
    // ATTENDANCE SCANNER -- Template-based OMR (zero API cost)
    //
    // Template layout (must match printed template CSS):
    //   Page 816x1056px, QR at right=48,top=48, size=140x140
    //   Bubble rows start at top=220, height=52, bubble=32px at flex-end
    //   QR top-left=(628,48), bubble center X=752, row-i center Y=246+i*52
    //   Offsets from QR top-left: bDX=124, bDY0=198, bDDY=52
    // =========================================================================
    const SCAN_TMPL = {
        qrSize: 140,
        bDX: 124,
        bDY0: 198,
        bDDY: 52,
        sampleR: 14,
        fillThresh: 0.22
    };

    let _scanResults = [];
    let _scanBunkLabel = '';
    let _scanCanvas = null, _scanCtx = null;

    function scannerGetBunkCampers(bunkName) {
        return Object.entries(getRoster())
            .filter(([, c]) => c.bunk === bunkName)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name]) => name);
    }

    function scannerOpen() {
        _scanResults = []; _scanBunkLabel = ''; _scanCanvas = null; _scanCtx = null;
        const el = id => document.getElementById(id);
        if (el('scanStep1')) el('scanStep1').style.display = '';
        if (el('scanStep2')) el('scanStep2').style.display = 'none';
        if (el('scanConfirmBtn')) el('scanConfirmBtn').style.display = 'none';
        if (el('scanBackBtn')) el('scanBackBtn').style.display = 'none';
        if (el('scanFileInput')) el('scanFileInput').value = '';
        openModal('scanModal');
    }

    function scannerHandleDrop(e) {
        e.preventDefault();
        document.getElementById('scanDropZone').style.borderColor = '';
        const file = e.dataTransfer?.files?.[0];
        if (file && file.type.startsWith('image/')) scannerHandleFileSelect(file);
    }

    function scannerHandleFileSelect(file) {
        if (!file || !file.type.startsWith('image/')) { toast('Please select an image file', 'error'); return; }
        const el = id => document.getElementById(id);
        if (el('scanStep1')) el('scanStep1').style.display = 'none';
        if (el('scanStep2')) el('scanStep2').style.display = '';
        if (el('scanBackBtn')) el('scanBackBtn').style.display = '';
        if (el('scanConfirmBtn')) el('scanConfirmBtn').style.display = 'none';
        if (el('scanStatusMsg')) el('scanStatusMsg').innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;color:var(--slate-600);font-size:.875rem;">' +
            '<div style="width:18px;height:18px;border:2px solid #2563eb;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;"></div>' +
            'Scanning sheet...</div>';
        if (el('scanPreviewTable')) el('scanPreviewTable').innerHTML = '';

        const img = new Image();
        img.onload = () => {
            _scanCanvas = document.createElement('canvas');
            _scanCanvas.width = img.naturalWidth;
            _scanCanvas.height = img.naturalHeight;
            _scanCtx = _scanCanvas.getContext('2d', { willReadFrequently: true });
            _scanCtx.drawImage(img, 0, 0);
            URL.revokeObjectURL(img.src);
            scannerProcessImage();
        };
        img.onerror = () => scannerShowError('Could not load image. Please try a different file.');
        img.src = URL.createObjectURL(file);
    }

    function scannerProcessImage() {
        if (typeof jsQR === 'undefined') {
            scannerShowError('jsQR library not loaded. Check your internet connection and reload the page.');
            return;
        }
        const imgData = _scanCtx.getImageData(0, 0, _scanCanvas.width, _scanCanvas.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });

        if (!code) {
            scannerShowError('QR code not detected. Make sure the QR in the top-right corner is fully visible, in focus, and well-lit. Try photographing from directly above.');
            return;
        }

        let info;
        try { info = JSON.parse(code.data); } catch (_) { info = null; }
        if (!info || info.t !== 'cs-roll' || !info.bunk) {
            scannerShowError('QR code found but is not a Campistry template. Use templates printed from this app.');
            return;
        }

        const campers = scannerGetBunkCampers(info.bunk);
        if (!campers.length) {
            scannerShowError(`Bunk "${info.bunk}" has no campers in the roster. Make sure the roster is loaded.`);
            return;
        }

        const loc = code.location;
        const tl = loc.topLeftCorner, tr = loc.topRightCorner, bl = loc.bottomLeftCorner;
        const pxX = { x: (tr.x - tl.x) / SCAN_TMPL.qrSize, y: (tr.y - tl.y) / SCAN_TMPL.qrSize };
        const pxY = { x: (bl.x - tl.x) / SCAN_TMPL.qrSize, y: (bl.y - tl.y) / SCAN_TMPL.qrSize };
        const photoQrW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
        const sampleRPhoto = Math.round(SCAN_TMPL.sampleR * (photoQrW / SCAN_TMPL.qrSize));

        _scanBunkLabel = info.bunk + (info.date ? ' · ' + info.date : '');
        _scanResults = campers.map((name, i) => {
            const dx = SCAN_TMPL.bDX, dy = SCAN_TMPL.bDY0 + i * SCAN_TMPL.bDDY;
            const cx = Math.round(tl.x + dx * pxX.x + dy * pxY.x);
            const cy = Math.round(tl.y + dx * pxX.y + dy * pxY.y);
            const dark = scannerSampleDark(cx, cy, sampleRPhoto);
            return { name, present: dark >= SCAN_TMPL.fillThresh };
        });

        scannerRenderPreview();
    }

    function scannerSampleDark(cx, cy, r) {
        if (!_scanCtx) return 0;
        const ri = Math.max(2, r);
        let data;
        try { data = _scanCtx.getImageData(Math.max(0, cx - ri), Math.max(0, cy - ri), 2 * ri + 1, 2 * ri + 1); }
        catch (_) { return 0; }
        let dark = 0, total = 0;
        const size = 2 * ri + 1;
        for (let i = 0; i < data.data.length; i += 4) {
            const px = i / 4, dx = (px % size) - ri, dy = Math.floor(px / size) - ri;
            if (dx * dx + dy * dy <= ri * ri) {
                const luma = data.data[i] * 0.299 + data.data[i + 1] * 0.587 + data.data[i + 2] * 0.114;
                if (luma < 128) dark++;
                total++;
            }
        }
        return total > 0 ? dark / total : 0;
    }

    function scannerShowError(msg) {
        const el = id => document.getElementById(id);
        if (el('scanStatusMsg')) el('scanStatusMsg').innerHTML =
            '<div style="padding:12px;background:#fef2f2;border-radius:8px;color:#dc2626;font-size:.8rem;line-height:1.5;">' +
            '<strong>Could not read sheet — </strong>' + esc(msg) + '</div>';
        if (el('scanPreviewTable')) el('scanPreviewTable').innerHTML =
            '<div style="text-align:center;margin-top:12px;">' +
            '<button class="btn btn-secondary" onclick="AttendanceScanner.back()">&#8592; Try Again</button></div>';
    }

    function scannerRenderPreview() {
        const present = _scanResults.filter(r => r.present).length;
        const absent = _scanResults.length - present;
        const el = id => document.getElementById(id);

        if (el('scanStatusMsg')) el('scanStatusMsg').innerHTML =
            '<div style="padding:10px 14px;background:var(--slate-50);border-radius:8px;font-size:.8rem;margin-bottom:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">' +
            '<strong>' + esc(_scanBunkLabel) + '</strong>' +
            '<span style="color:#16a34a;font-weight:600;">' + present + ' present</span>' +
            '<span style="color:#dc2626;font-weight:600;">' + absent + ' absent</span>' +
            '</div>' +
            '<div style="font-size:.74rem;color:var(--slate-500);margin-bottom:8px;">Tap a pill to correct any errors before applying.</div>';

        let html = '<div style="max-height:300px;overflow-y:auto;border:1px solid var(--slate-200);border-radius:8px;">';
        html += '<table style="width:100%;border-collapse:collapse;font-size:.82rem;">';
        html += '<thead><tr style="background:var(--slate-50);position:sticky;top:0;">' +
            '<th style="text-align:left;padding:8px 10px;">#</th>' +
            '<th style="text-align:left;padding:8px 10px;">Camper</th>' +
            '<th style="text-align:center;padding:8px 10px;">Status</th></tr></thead><tbody>';

        _scanResults.forEach((r, i) => {
            const bg = r.present ? '#dcfce7' : '#fee2e2';
            const clr = r.present ? '#16a34a' : '#dc2626';
            const lbl = r.present ? '&#10003; Present' : '&#10007; Absent';
            html += '<tr style="border-top:1px solid var(--slate-100);">' +
                '<td style="padding:7px 10px;color:var(--slate-400);">' + (i + 1) + '</td>' +
                '<td style="padding:7px 10px;font-weight:500;">' + esc(r.name) + '</td>' +
                '<td style="padding:7px 10px;text-align:center;">' +
                '<button onclick="AttendanceScanner.toggleResult(' + i + ')" style="background:' + bg + ';color:' + clr + ';border:none;padding:3px 12px;border-radius:999px;cursor:pointer;font-weight:600;font-size:.74rem;">' + lbl + '</button>' +
                '</td></tr>';
        });

        html += '</tbody></table></div>';
        if (el('scanPreviewTable')) el('scanPreviewTable').innerHTML = html;
        if (el('scanConfirmBtn')) el('scanConfirmBtn').style.display = _scanResults.length ? '' : 'none';
    }

    function scannerToggleResult(i) {
        if (_scanResults[i]) { _scanResults[i].present = !_scanResults[i].present; scannerRenderPreview(); }
    }

    function scannerBack() {
        _scanResults = []; _scanBunkLabel = ''; _scanCanvas = null; _scanCtx = null;
        const el = id => document.getElementById(id);
        if (el('scanStep1')) el('scanStep1').style.display = '';
        if (el('scanStep2')) el('scanStep2').style.display = 'none';
        if (el('scanConfirmBtn')) el('scanConfirmBtn').style.display = 'none';
        if (el('scanBackBtn')) el('scanBackBtn').style.display = 'none';
        if (el('scanFileInput')) el('scanFileInput').value = '';
    }

    function scannerConfirm() {
        const today = getTodayData();
        _scanResults.forEach(r => {
            if (r.present) {
                today.absences = today.absences.filter(a => a.name !== r.name);
                delete today.attendance[r.name];
            } else {
                if (!today.absences.some(a => a.name === r.name)) {
                    today.absences.push({ name: r.name, reason: 'absent', notes: 'Via scan', time: formatTimeNow(), timestamp: Date.now() });
                }
                today.attendance[r.name] = false;
            }
        });
        saveTodayData(today);
        closeModal('scanModal');
        renderRollCall(); renderDashboard(); renderAbsences(); renderBunkTracker();
        toast('Attendance updated \u2014 ' + _scanResults.length + ' camper' + (_scanResults.length !== 1 ? 's' : '') + ' from scan');
    }

    function scannerPrintTemplates() {
        const struct = getStructure();
        const dateKey = getTodayKey();
        const bunkPages = [];
        Object.entries(struct).forEach(([, divData]) => {
            Object.entries(divData.grades || {}).forEach(([, gradeData]) => {
                (gradeData.bunks || []).forEach(bunkName => {
                    const campers = scannerGetBunkCampers(bunkName);
                    if (campers.length) bunkPages.push({ bunkName, campers });
                });
            });
        });

        if (!bunkPages.length) { toast('No campers found in any bunk', 'error'); return; }

        const win = window.open('', '_blank');
        if (!win) { toast('Pop-up blocked \u2014 please allow pop-ups for this site', 'error'); return; }

        const date = new Date(dateKey + 'T12:00:00');
        const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

        const pages = bunkPages.map(({ bunkName, campers }) => {
            const payload = JSON.stringify({ t: 'cs-roll', v: 1, bunk: bunkName, date: dateKey })
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            const rowDate = new Date(dateKey + 'T12:00:00')
                .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const rows = campers.map((name, i) =>
                `<div class="tmpl-row"><span class="tmpl-num">${i + 1}</span>` +
                `<span class="tmpl-name">${esc(name)}</span><div class="tmpl-bubble"></div></div>`
            ).join('');
            return `<div class="tmpl-page"><div class="tmpl-inner">` +
                `<div class="tmpl-qr" data-qr="${payload}"></div>` +
                `<div class="tmpl-head">${esc(bunkName)}</div>` +
                `<div class="tmpl-sub">${rowDate}</div>` +
                `<hr class="tmpl-hr"><div class="tmpl-instr">&#9679; Fill bubble = <strong>PRESENT</strong> &nbsp; &#9675; Empty = ABSENT</div>` +
                `<div class="tmpl-rows">${rows}</div></div></div>`;
        }).join('\n');

        win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Attendance ${dateKey}</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#eee}
@media print{body{background:#fff}.no-print{display:none!important}.tmpl-page{box-shadow:none!important;margin:0!important;page-break-after:always}}
.no-print{background:#1e293b;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:10;font-family:inherit}
.no-print button{background:#2563eb;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-size:14px;cursor:pointer}
.tmpl-page{width:816px;height:1056px;position:relative;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.18);margin:24px auto;overflow:hidden}
.tmpl-inner{padding:48px;height:100%}
.tmpl-qr{position:absolute;right:48px;top:48px;width:140px;height:140px}
.tmpl-qr svg{width:140px!important;height:140px!important;display:block}
.tmpl-head{font-size:30px;font-weight:700;color:#111;margin-bottom:4px;padding-right:160px}
.tmpl-sub{font-size:13px;color:#555;margin-bottom:10px;padding-right:160px}
.tmpl-hr{border:none;border-top:2px solid #ddd;margin:8px 0}
.tmpl-instr{font-size:11px;color:#555;padding:5px 8px;background:#f5f5f5;border-radius:4px;display:inline-block;margin-bottom:2px}
.tmpl-rows{position:absolute;left:48px;right:48px;top:220px}
.tmpl-row{display:flex;align-items:center;height:52px;border-bottom:1px solid #ebebeb}
.tmpl-num{font-size:11px;color:#bbb;width:22px;flex-shrink:0}
.tmpl-name{flex:1;font-size:15px;color:#111;padding-right:8px}
.tmpl-bubble{width:32px;height:32px;border:2.5px solid #222;border-radius:50%;flex-shrink:0}
</style></head><body>
<div class="no-print">
  <span style="font-weight:700">Campistry Attendance Templates</span>
  <span style="opacity:.7;font-size:13px">${dateStr}</span>
  <button onclick="window.print()">Print All (${bunkPages.length} sheets)</button>
  <span style="opacity:.55;font-size:12px">Fill bubble = present today</span>
</div>
${pages}
<script>
document.querySelectorAll('[data-qr]').forEach(function(el){
  try{var qr=qrcode(0,'M');qr.addData(el.getAttribute('data-qr'));qr.make();el.innerHTML=qr.createSvgTag(3,0);var s=el.querySelector('svg');if(s){s.setAttribute('width','140');s.setAttribute('height','140');}}catch(e){el.textContent='QR err';}
});
<\/script></body></html>`);
        win.document.close();
    }

    window.AttendanceScanner = {
        open: scannerOpen,
        handleDrop: scannerHandleDrop,
        handleFileSelect: scannerHandleFileSelect,
        toggleResult: scannerToggleResult,
        back: scannerBack,
        confirm: scannerConfirm,
        printTemplates: scannerPrintTemplates
    };

    // =========================================================================
    // MODALS — generic open/close by element id (modals are .modal-overlay,
    // shown via the .open class; matches the click/Escape handlers in init()).
    // Referenced by openAbsenceModal / openPickupModal / the scanner and the
    // public API below, so they must exist before the export is evaluated.
    // =========================================================================
    function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
    function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryLive = {
        refresh,
        toggleAttendance,
        toggleByEl,
        markAllPresent,
        markBunkPresent,
        markBunkByEl,
        filterRollCall,
        clearRcFilter,
        openAbsenceModal,
        filterAbsenceSearch,
        saveAbsence,
        removeAbsence,
        openPickupModal,
        filterPickupSearch,
        savePickup,
        removePickup,
        exportAttendanceCsv,
        filterBunks,
        openModal,
        closeModal
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
