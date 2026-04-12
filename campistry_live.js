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
    // STORAGE
    // =========================================================================
    const STORAGE_KEY = 'campGlobalSettings_v1';
    const LIVE_KEY = 'campistry_live_v1';

    function readGlobal() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; }
    }
    function getRoster() { const g = readGlobal(); return (g.app1 && g.app1.camperRoster) || {}; }
    function getStructure() { return readGlobal().campStructure || {}; }
    function getCampName() { const g = readGlobal(); return g.camp_name || g.campName || 'Camp'; }

    function getLiveData() {
        try { return JSON.parse(localStorage.getItem(LIVE_KEY) || '{}'); } catch (e) { return {}; }
    }
    function saveLiveData(data) {
        try { data.updated_at = new Date().toISOString(); localStorage.setItem(LIVE_KEY, JSON.stringify(data)); } catch (e) { console.error('[Live] Save failed', e); }
    }

    function getTodayKey() {
        const d = new Date(); d.setHours(12, 0, 0, 0);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function getTodayData() {
        const data = getLiveData();
        const key = getTodayKey();
        if (!data[key]) data[key] = { attendance: {}, absences: [], earlyPickups: [], notes: '' };
        return data[key];
    }

    function saveTodayData(today) {
        const data = getLiveData();
        data[getTodayKey()] = today;
        saveLiveData(data);
    }

    // =========================================================================
    // HELPERS
    // =========================================================================
    const esc = s => { if (s == null) return ''; const m = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }; return String(s).replace(/[&<>"']/g, c => m[c]); };

    let _toastTimer = null;
    function toast(msg, type) {
        const el = document.getElementById('toastEl');
        if (!el) return;
        el.textContent = msg;
        el.className = 'toast' + (type === 'error' ? ' error' : '');
        clearTimeout(_toastTimer);
        requestAnimationFrame(() => { el.classList.add('show'); _toastTimer = setTimeout(() => el.classList.remove('show'), 2500); });
    }
    function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
    function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }

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
    // CLOCK & AUTO-REFRESH
    // =========================================================================
    let _clockInterval = null;
    let _refreshInterval = null;

    function startClock() {
        const el = document.getElementById('liveClock');
        if (!el) return;
        function tick() { el.textContent = formatTimeNow(); }
        tick();
        _clockInterval = setInterval(tick, 1000);
    }

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
        startClock();
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
    // PUBLIC API
    // =========================================================================
    window.CampistryLive = {
        refresh,
        toggleAttendance,
        markAllPresent,
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
