// =============================================================================
// campistry_go.js — Campistry Go v3.0
// VROOM-powered bus routing with ZIP-based region clustering
// =============================================================================
(function () {
    'use strict';
    console.log('[Go] Campistry Go v3.0 loading...');

    // =========================================================================
    // STATE
    // =========================================================================
    let D = {
        setup: {
            campAddress: '', campName: '', avgSpeed: 25,
            reserveSeats: 2, dropoffMode: 'door-to-door',
            avgStopTime: 2, maxWalkDistance: 500, orsApiKey: '', graphhopperKey: '', mapboxToken: '',
            campLat: null, campLng: null
        },
        activeMode: 'dismissal',
        buses: [], shifts: [], monitors: [], counselors: [],
        savedRoutes: null, dismissal: null, arrival: null,
        addresses: {}, dailyOverrides: {}, carpoolGroups: {}
    };
    let _editBusId = null, _editMonitorId = null, _editCounselorId = null, _editCamper = null;
    let _generatedRoutes = null;
    let _toastTimer = null;
    const BUS_COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#8b5cf6','#14b8a6','#6366f1','#84cc16','#e11d48','#0ea5e9','#d946ef'];
    const STORE = 'campistry_go_data';
    const REGION_COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#8b5cf6','#14b8a6','#6366f1','#e11d48'];
    let _detectedRegions = null;
    let _detectedRadius = null;
    let _busAssignments = null;

    // =========================================================================
    // HELPERS
    // =========================================================================
    const esc = s => { if (s == null) return ''; const m = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}; return String(s).replace(/[&<>"']/g, c => m[c]); };
    const uid = () => 'go_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    function toast(msg, type) { const el = document.getElementById('toastEl'); el.textContent = msg; el.className = 'toast' + (type === 'error' ? ' error' : ''); clearTimeout(_toastTimer); requestAnimationFrame(() => { el.classList.add('show'); _toastTimer = setTimeout(() => el.classList.remove('show'), 2500); }); }
    function openModal(id) { document.getElementById(id)?.classList.add('open'); }
    function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
    function getApiKey() { return window.__CAMPISTRY_ORS_KEY__ || D.setup.orsApiKey || ''; }
    let _campCoordsCache = null;

    function haversineMi(lat1, lng1, lat2, lng2) {
        const R = 3958.8, toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function decodePolyline(encoded) {
        const points = []; let i = 0, lat = 0, lng = 0;
        while (i < encoded.length) {
            let b, shift = 0, result = 0;
            do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);
            shift = 0; result = 0;
            do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);
            points.push([lat / 1e5, lng / 1e5]);
        }
        return points;
    }

    function censusGeocode(address) {
        return new Promise((resolve) => {
            const cbName = '_cg_' + Math.random().toString(36).slice(2, 8);
            const timeout = setTimeout(() => { cleanup(); resolve(null); }, 10000);
            function cleanup() { clearTimeout(timeout); try { delete window[cbName]; } catch(_) {} document.querySelectorAll('script[data-census="' + cbName + '"]').forEach(s => s.remove()); }
            window[cbName] = function(data) { cleanup(); resolve(data); };
            const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' + new URLSearchParams({ address: address, benchmark: 'Public_AR_Current', format: 'jsonp', callback: cbName });
            const script = document.createElement('script');
            script.setAttribute('data-census', cbName);
            script.setAttribute('data-campistry-allowed', 'true');
            script.src = url;
            script.onerror = function() { cleanup(); resolve(null); };
            document.head.appendChild(script);
        });
    }

    function formatTime(totalMin) {
        const h = Math.floor(totalMin / 60), m = Math.round(totalMin % 60);
        const p = h >= 12 ? 'PM' : 'AM', h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return h12 + ':' + String(m).padStart(2, '0') + ' ' + p;
    }
    function parseTime(t) { const [h, m] = (t || '16:00').split(':').map(Number); return h * 60 + (m || 0); }


    // =========================================================================
    // DATA: LOAD / SAVE / ROSTER
    // =========================================================================
    function readCampistrySettings() {
        if (typeof window.loadGlobalSettings === 'function') { try { return window.loadGlobalSettings() || {}; } catch (_) {} }
        const keys = ['CAMPISTRY_UNIFIED_STATE', 'campGlobalSettings_v1', 'CAMPISTRY_LOCAL_CACHE'];
        for (const key of keys) { try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw) || {}; } catch (_) {} }
        return {};
    }

    function load() {
        try {
            const g = readCampistrySettings();
            if (g.campistryGo && Object.keys(g.campistryGo).length) { D = merge(g.campistryGo); console.log('[Go] Loaded from cloud settings'); return; }
            const raw = localStorage.getItem(STORE);
            if (raw) { D = merge(JSON.parse(raw)); console.log('[Go] Loaded from localStorage'); }
        } catch (e) { console.error('[Go] Load error:', e); }
    }

    function merge(d) {
        const def = { setup: { campAddress:'',campName:'',avgSpeed:25,reserveSeats:2,dropoffMode:'door-to-door',avgStopTime:2,maxWalkDistance:500,orsApiKey:'',graphhopperKey:'',mapboxToken:'',campLat:null,campLng:null }, activeMode:'dismissal', buses:[], shifts:[], monitors:[], counselors:[], addresses:{}, savedRoutes:null, dismissal:null, arrival:null, dailyOverrides:{}, carpoolGroups:{} };
        const result = { setup: { ...def.setup, ...(d.setup || {}) }, activeMode: d.activeMode || 'dismissal', buses: d.buses || [], shifts: d.shifts || [], monitors: d.monitors || [], counselors: d.counselors || [], addresses: d.addresses || {}, savedRoutes: d.savedRoutes || null, dismissal: d.dismissal || null, arrival: d.arrival || null, dailyOverrides: d.dailyOverrides || {}, carpoolGroups: d.carpoolGroups || {} };
        if (!result.dismissal && result.buses.length) { result.dismissal = { buses: [...result.buses], shifts: [...result.shifts], monitors: [...result.monitors], counselors: [...result.counselors], savedRoutes: result.savedRoutes }; }
        if (!result.arrival) { result.arrival = { buses: [], shifts: [], monitors: [], counselors: [], savedRoutes: null }; }
        return result;
    }

    function save() {
        try {
            setSyncStatus('syncing');
            saveModeData();
            localStorage.setItem(STORE, JSON.stringify(D));
            if (typeof window.saveGlobalSettings === 'function') window.saveGlobalSettings('campistryGo', D);
            setTimeout(() => setSyncStatus('synced'), 300);
        } catch (e) { console.error('[Go] Save:', e); setSyncStatus('error'); }
    }

    function setSyncStatus(s) {
        const dot = document.getElementById('syncDot'), txt = document.getElementById('syncText');
        if (!dot) return;
        dot.className = 'sync-dot' + (s === 'syncing' ? ' syncing' : s === 'error' ? ' error' : '');
        txt.textContent = s === 'syncing' ? 'Saving...' : s === 'error' ? 'Error' : 'Synced';
    }

    // =========================================================================
    // ARRIVAL / DISMISSAL MODE SWITCHING
    // =========================================================================
    function saveModeData() { D[D.activeMode] = { buses: D.buses, shifts: D.shifts, monitors: D.monitors, counselors: D.counselors, savedRoutes: D.savedRoutes }; }
    function loadModeData(mode) { const data = D[mode] || { buses: [], shifts: [], monitors: [], counselors: [], savedRoutes: null }; D.buses = data.buses || []; D.shifts = data.shifts || []; D.monitors = data.monitors || []; D.counselors = data.counselors || []; D.savedRoutes = data.savedRoutes || null; }

    function switchMode(mode) {
        if (mode === D.activeMode) return;
        saveModeData(); D.activeMode = mode; loadModeData(mode);
        _routeGeomCache = {}; window._routeGeomCache = _routeGeomCache; _generatedRoutes = D.savedRoutes;
        save(); renderFleet(); renderShifts(); renderStaff(); renderAddresses(); updateStats(); updateBusSelects();
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        const sub = document.getElementById('modeLabel');
        if (sub) sub.textContent = mode === 'arrival' ? 'Morning Pickup Routes' : 'Afternoon Drop-off Routes';
        if (D.savedRoutes) { renderRouteResults(applyOverrides(D.savedRoutes)); }
        else { document.getElementById('routeResults').style.display = 'none'; document.getElementById('shiftResultsContainer').innerHTML = ''; }
        toast('Switched to ' + (mode === 'arrival' ? 'Arrival' : 'Dismissal') + ' mode');
    }

    // =========================================================================
    // CAPACITY WARNINGS
    // =========================================================================
    function getCapacityWarnings() {
        if (!_generatedRoutes) return [];
        const applied = applyOverrides(_generatedRoutes);
        const warnings = [];
        applied.forEach(sr => { sr.routes.forEach(r => { const bus = D.buses.find(b => b.id === r.busId); if (!bus) return; const rs = D.setup.reserveSeats || 0; const mon = D.monitors.find(m => m.assignedBus === bus.id); const couns = D.counselors.filter(c => c.assignedBus === bus.id); const maxCampers = Math.max(0, (bus.capacity || 0) - 1 - (mon ? 1 : 0) - couns.length - rs); if (r.camperCount > maxCampers) warnings.push({ busName: r.busName, busColor: r.busColor, shift: sr.shift.label || 'Shift', actual: r.camperCount, max: maxCampers, over: r.camperCount - maxCampers }); }); });
        return warnings;
    }

    function renderCapacityWarnings() {
        const el = document.getElementById('capacityWarnings');
        if (!el) return;
        const warnings = getCapacityWarnings();
        if (!warnings.length) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.innerHTML = warnings.map(w => '<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;background:var(--red-50);border:1px solid var(--red-100);border-radius:var(--radius-sm);margin-bottom:.375rem;font-size:.8125rem;"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(w.busColor) + ';flex-shrink:0;"></span><strong style="color:var(--red-600);">⚠ ' + esc(w.busName) + '</strong> (' + esc(w.shift) + ') — <span>' + w.actual + ' campers, only ' + w.max + ' seats (' + w.over + ' over)</span></div>').join('');
    }

    // =========================================================================
    // ROSTER (from Campistry Me — auto-synced)
    // =========================================================================
    function getRoster() {
        const g = readCampistrySettings();
        const roster = g?.app1?.camperRoster || {};
        // Backfill camper IDs if missing
        let needsSave = false, maxId = 0;
        Object.values(roster).forEach(c => { if (c.camperId && c.camperId > maxId) maxId = c.camperId; });
        let nextId = (g?.campistryMe?.nextCamperId) || maxId + 1;
        if (maxId >= nextId) nextId = maxId + 1;
        Object.entries(roster).forEach(([n, c]) => { if (!c.camperId) { c.camperId = nextId; nextId++; needsSave = true; } });
        if (needsSave) {
            try { const raw = localStorage.getItem('campGlobalSettings_v1'); if (raw) { const data = JSON.parse(raw); data.app1.camperRoster = roster; if (!data.campistryMe) data.campistryMe = {}; data.campistryMe.nextCamperId = nextId; localStorage.setItem('campGlobalSettings_v1', JSON.stringify(data)); } } catch (e) {}
        }
        return roster;
    }
    function getStructure() { const g = readCampistrySettings(); return g?.campStructure || {}; }
    function getDivisionNames() { return Object.keys(getStructure()).sort(); }

    // =========================================================================
    // SETUP
    // =========================================================================
    function populateSetup() {
        const s = D.setup;
        document.getElementById('campAddress').value = s.campAddress || '';
        document.getElementById('campName').value = s.campName || '';
        document.getElementById('avgSpeed').value = s.avgSpeed ?? 25;
        document.getElementById('reserveSeats').value = s.reserveSeats ?? 2;
        document.getElementById('dropoffMode').value = s.dropoffMode || 'door-to-door';
        document.getElementById('avgStopTime').value = s.avgStopTime ?? 2;
        document.getElementById('maxWalkDistance').value = s.maxWalkDistance ?? 500;
        document.getElementById('orsApiKey').value = s.orsApiKey || '';
        if (document.getElementById('ghApiKey')) document.getElementById('ghApiKey').value = s.graphhopperKey || '';
        if (document.getElementById('mapboxToken')) document.getElementById('mapboxToken').value = s.mapboxToken || '';
    }
    function saveSetup() {
        const el = id => document.getElementById(id);
        D.setup.campAddress = el('campAddress')?.value.trim() || '';
        D.setup.campName = el('campName')?.value.trim() || '';
        D.setup.avgSpeed = parseInt(el('avgSpeed')?.value) || 25;
        D.setup.reserveSeats = parseInt(el('reserveSeats')?.value) || 0;
        D.setup.dropoffMode = el('dropoffMode')?.value || 'door-to-door';
        D.setup.avgStopTime = parseInt(el('avgStopTime')?.value) || 2;
        D.setup.maxWalkDistance = parseInt(el('maxWalkDistance')?.value) || 500;
        D.setup.orsApiKey = el('orsApiKey')?.value.trim() || '';
        D.setup.graphhopperKey = el('ghApiKey')?.value.trim() || '';
        D.setup.mapboxToken = el('mapboxToken')?.value.trim() || '';
        save(); toast('Setup saved');
    }
    async function testApiKey() {
        const key = document.getElementById('orsApiKey')?.value.trim();
        const st = document.getElementById('apiKeyStatus');
        if (!key) { st.innerHTML = '<span style="color:var(--red-600)">Enter key first</span>'; return; }
        st.innerHTML = '<span style="color:var(--text-muted)">Testing...</span>';
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?text=Times+Square+New+York&size=1', { headers: { 'Authorization': key, 'Accept': 'application/json' } }); st.innerHTML = r.status === 200 ? '<span style="color:var(--green-600)">✓ Connected</span>' : r.status === 401 ? '<span style="color:var(--red-600)">✗ Invalid key</span>' : '<span style="color:var(--amber-600)">⚠ HTTP ' + r.status + '</span>'; } catch (_) { st.innerHTML = '<span style="color:var(--red-600)">✗ Network error</span>'; }
    }

    // =========================================================================
    // BUS FLEET
    // =========================================================================
    function renderFleet() {
        const c = document.getElementById('fleetContainer'), e = document.getElementById('fleetEmptyState');
        document.getElementById('fleetCount').textContent = D.buses.length + ' bus' + (D.buses.length !== 1 ? 'es' : '');
        if (!D.buses.length) { c.innerHTML = ''; c.style.display = 'none'; e.style.display = ''; return; }
        e.style.display = 'none'; c.style.display = '';
        const rs = D.setup.reserveSeats || 0;
        c.innerHTML = '<div class="fleet-grid">' + D.buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(x => x.assignedBus === b.id);
            const staff = (mon ? 1 : 0) + couns.length;
            const avail = Math.max(0, (b.capacity || 0) - 1 - staff - rs);
            return '<div class="bus-card"><div class="bus-card-stripe" style="background:' + esc(b.color) + '"></div><div class="bus-card-header"><div><div class="bus-card-name">' + esc(b.name) + '</div>' + (b.notes ? '<div class="bus-card-number">' + esc(b.notes) + '</div>' : '') + '</div><div class="bus-card-actions"><button onclick="CampistryGo.editBus(\'' + b.id + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="delete" onclick="CampistryGo.deleteBus(\'' + b.id + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></div></div><div class="bus-card-stats"><div class="bus-stat"><div class="bus-stat-value">' + b.capacity + '</div><div class="bus-stat-label">Total</div></div><div class="bus-stat"><div class="bus-stat-value">' + avail + '</div><div class="bus-stat-label">For Kids</div></div><div class="bus-stat"><div class="bus-stat-value">' + staff + '</div><div class="bus-stat-label">Staff</div></div><div class="bus-stat"><div class="bus-stat-value">' + rs + '</div><div class="bus-stat-label">Reserved</div></div></div>' + (mon ? '<div style="margin-top:.75rem;font-size:.75rem;color:var(--text-muted)">Monitor: <strong style="color:var(--text-secondary)">' + esc(mon.name) + '</strong></div>' : '') + '</div>';
        }).join('') + '</div>';
    }
    function openBusModal(editId) {
        _editBusId = editId || null;
        document.getElementById('busModalTitle').textContent = editId ? 'Edit Bus' : 'Add Bus';
        const ex = editId ? D.buses.find(b => b.id === editId) : null;
        const col = ex?.color || BUS_COLORS[D.buses.length % BUS_COLORS.length];
        document.getElementById('busColorPicker').innerHTML = BUS_COLORS.map(c => '<div class="color-swatch' + (c === col ? ' selected' : '') + '" style="background:' + c + '" data-color="' + c + '" onclick="CampistryGo._pickColor(this)"></div>').join('');
        document.getElementById('busName').value = ex?.name || '';
        document.getElementById('busCapacity').value = ex?.capacity || '';
        document.getElementById('busNotes').value = ex?.notes || '';
        openModal('busModal'); document.getElementById('busName').focus();
    }
    function _pickColor(el) { el.parentElement.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected')); el.classList.add('selected'); }
    function saveBus() {
        const name = document.getElementById('busName')?.value.trim(), cap = parseInt(document.getElementById('busCapacity')?.value);
        const color = document.querySelector('#busColorPicker .color-swatch.selected')?.dataset.color || BUS_COLORS[0];
        const notes = document.getElementById('busNotes')?.value.trim();
        if (!name) { toast('Enter name', 'error'); return; } if (!cap || cap < 1) { toast('Enter capacity', 'error'); return; }
        if (_editBusId) { const b = D.buses.find(x => x.id === _editBusId); if (b) { b.name = name; b.capacity = cap; b.color = color; b.notes = notes; } }
        else D.buses.push({ id: uid(), name, capacity: cap, color, notes });
        save(); closeModal('busModal'); renderFleet(); updateStats(); updateBusSelects(); toast(_editBusId ? 'Updated' : 'Bus added');
    }
    function editBus(id) { openBusModal(id); }
    function deleteBus(id) { const b = D.buses.find(x => x.id === id); if (!b || !confirm('Delete "' + b.name + '"?')) return; D.buses = D.buses.filter(x => x.id !== id); D.monitors.forEach(m => { if (m.assignedBus === id) m.assignedBus = ''; }); D.counselors.forEach(c => { if (c.assignedBus === id) c.assignedBus = ''; }); save(); renderFleet(); renderStaff(); updateStats(); updateBusSelects(); toast('Deleted'); }
    function updateBusSelects() { ['monitorBusAssign', 'counselorBusAssign'].forEach(sid => { const s = document.getElementById(sid); if (!s) return; const cur = s.value; s.innerHTML = '<option value="">— Later —</option>' + D.buses.map(b => '<option value="' + esc(b.id) + '"' + (b.id === cur ? ' selected' : '') + '>' + esc(b.name) + '</option>').join(''); }); }

    // =========================================================================
    // SHIFTS
    // =========================================================================
    function renderShifts() {
        const container = document.getElementById('shiftsContainer'), empty = document.getElementById('shiftsEmptyState');
        document.getElementById('shiftCount').textContent = D.shifts.length + ' shift' + (D.shifts.length !== 1 ? 's' : '');
        if (!D.shifts.length) { container.innerHTML = ''; empty.style.display = ''; return; }
        empty.style.display = 'none';
        const divNames = getDivisionNames();
        const struct = getStructure();
        container.innerHTML = D.shifts.map((sh, idx) => {
            if (!sh.grades) sh.grades = {};
            const divChips = divNames.map(dName => {
                const isActive = (sh.divisions || []).includes(dName);
                const color = struct[dName]?.color || '#888';
                const gradeNames = Object.keys(struct[dName]?.grades || {}).sort();
                const gradeMode = sh.grades[dName];
                let gradeHtml = '';
                if (isActive && gradeNames.length > 1) {
                    const allGrades = !gradeMode || gradeMode === 'all';
                    gradeHtml = '<div style="display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.375rem;margin-left:1.5rem;">' +
                        '<span class="division-chip' + (allGrades ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.setShiftGradeMode(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\',\'all\')">All Grades</span>' +
                        gradeNames.map(g => {
                            const gActive = allGrades || (Array.isArray(gradeMode) && gradeMode.includes(g));
                            return '<span class="division-chip' + (gActive ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.toggleShiftGrade(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\',\'' + esc(g.replace(/'/g, "\\'")) + '\')">' + esc(g) + '</span>';
                        }).join('') + '</div>';
                }
                return '<div><span class="division-chip' + (isActive ? ' active' : '') + '" onclick="CampistryGo.toggleShiftDiv(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\')"><span class="chip-dot" style="background:' + esc(color) + '"></span>' + esc(dName) + '</span>' + gradeHtml + '</div>';
            }).join('');
            const camperCount = countCampersForShift(sh);
            const isArrival = D.activeMode === 'arrival';
            const timeLabel = isArrival ? 'Arrive by:' : 'Depart:';
            if (!sh.assignedBuses) sh.assignedBuses = D.buses.map(b => b.id);
            const busChips = D.buses.map(b => {
                const active = sh.assignedBuses.includes(b.id);
                return '<span class="division-chip' + (active ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.toggleShiftBus(\'' + sh.id + '\',\'' + b.id + '\')"><span class="chip-dot" style="background:' + esc(b.color || '#10b981') + '"></span>' + esc(b.name) + '</span>';
            }).join('');
            const busCount = sh.assignedBuses.length;
            const busSection = D.buses.length ? '<div style="margin-top:.5rem;border-top:1px solid var(--border-light);padding-top:.5rem;"><div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.375rem;"><span style="font-size:.75rem;font-weight:600;color:var(--text-secondary);">Buses (' + busCount + '/' + D.buses.length + '):</span><span class="division-chip' + (busCount === D.buses.length ? ' active' : '') + '" style="font-size:.6rem;padding:.1rem .4rem;" onclick="CampistryGo.setAllShiftBuses(\'' + sh.id + '\')">All</span></div><div style="display:flex;flex-wrap:wrap;gap:.25rem;">' + busChips + '</div></div>' : '';
            return '<div class="shift-card"><div class="shift-card-header"><div class="shift-card-title"><span class="shift-num">' + (idx + 1) + '</span><input type="text" class="form-input" value="' + esc(sh.label || '') + '" placeholder="Shift name" style="max-width:200px;font-size:.875rem;font-weight:700;padding:.25rem .5rem;border:1px solid transparent;" onfocus="this.style.borderColor=\'var(--border-medium)\'" onblur="this.style.borderColor=\'transparent\';CampistryGo.renameShift(\'' + sh.id + '\',this.value)"><span style="font-size:.75rem;font-weight:400;color:var(--text-muted);">' + camperCount + ' campers</span></div><div style="display:flex;align-items:center;gap:.5rem;"><label style="font-size:.75rem;font-weight:600;color:var(--text-secondary)">' + timeLabel + '</label><input type="time" class="form-input" value="' + esc(sh.departureTime || (isArrival ? '08:00' : '16:00')) + '" style="width:110px;padding:.35rem .5rem;font-size:.8125rem;" onchange="CampistryGo.updateShiftTime(\'' + sh.id + '\',this.value)"><button class="btn btn-ghost btn-sm" style="color:var(--red-500);" onclick="CampistryGo.deleteShift(\'' + sh.id + '\')">Remove</button></div></div><div style="display:flex;flex-direction:column;gap:.375rem;">' + (divNames.length ? divChips : '<span style="font-size:.8125rem;color:var(--text-muted)">No divisions in Campistry Me</span>') + '</div>' + busSection + '</div>';
        }).join('');
    }

    function countCampersForShift(sh) {
        const roster = getRoster(); const divs = sh.divisions || []; if (!divs.length) return 0;
        return Object.values(roster).filter(c => { if (!divs.includes(c.division)) return false; const gm = sh.grades?.[c.division]; if (!gm || gm === 'all') return true; if (Array.isArray(gm)) return gm.includes(c.grade); return true; }).length;
    }
    function camperMatchesShift(camper, shift) {
        if (!(shift.divisions || []).includes(camper.division)) return false;
        const gm = shift.grades?.[camper.division]; if (!gm || gm === 'all') return true; if (Array.isArray(gm)) return gm.includes(camper.grade); return true;
    }
    function addShift() {
        const idx = D.shifts.length + 1; const isArrival = D.activeMode === 'arrival'; const defaultTime = isArrival ? '08:00' : '16:00';
        const prevTime = D.shifts.length ? D.shifts[D.shifts.length - 1].departureTime : defaultTime;
        const prevMin = parseTime(prevTime); const newMin = isArrival ? prevMin - 45 : prevMin + 45;
        const h = Math.floor(Math.max(0, newMin) / 60), m = Math.max(0, newMin) % 60;
        const newTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        D.shifts.push({ id: uid(), label: 'Shift ' + idx, divisions: [], grades: {}, departureTime: newTime, assignedBuses: D.buses.map(b => b.id) });
        save(); renderShifts(); updateStats(); toast('Shift added');
    }
    function deleteShift(id) { D.shifts = D.shifts.filter(s => s.id !== id); save(); renderShifts(); updateStats(); toast('Shift removed'); }
    function toggleShiftDiv(shiftId, divName) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return;
        if (!sh.divisions) sh.divisions = []; if (!sh.grades) sh.grades = {};
        D.shifts.forEach(s => { if (s.id !== shiftId) { s.divisions = (s.divisions || []).filter(d => d !== divName); if (s.grades) delete s.grades[divName]; } });
        const idx = sh.divisions.indexOf(divName);
        if (idx >= 0) { sh.divisions.splice(idx, 1); delete sh.grades[divName]; } else { sh.divisions.push(divName); sh.grades[divName] = 'all'; }
        save(); renderShifts();
    }
    function toggleShiftGrade(shiftId, divName, gradeName) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; if (!sh.grades) sh.grades = {};
        const struct = getStructure(); const allGrades = Object.keys(struct[divName]?.grades || {});
        if (!sh.grades[divName] || sh.grades[divName] === 'all') { sh.grades[divName] = allGrades.filter(g => g !== gradeName); }
        else { const arr = sh.grades[divName]; const gi = arr.indexOf(gradeName); if (gi >= 0) { arr.splice(gi, 1); if (!arr.length) arr.push(allGrades[0] || gradeName); } else arr.push(gradeName); if (arr.length >= allGrades.length) sh.grades[divName] = 'all'; }
        save(); renderShifts();
    }
    function setShiftGradeMode(shiftId, divName, mode) { const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; if (!sh.grades) sh.grades = {}; sh.grades[divName] = mode; save(); renderShifts(); }
    function updateShiftTime(id, val) { const sh = D.shifts.find(s => s.id === id); if (sh) { sh.departureTime = val; save(); } }
    function toggleShiftBus(shiftId, busId) { const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; if (!sh.assignedBuses) sh.assignedBuses = D.buses.map(b => b.id); const idx = sh.assignedBuses.indexOf(busId); if (idx >= 0) { if (sh.assignedBuses.length > 1) sh.assignedBuses.splice(idx, 1); } else sh.assignedBuses.push(busId); save(); renderShifts(); }
    function setAllShiftBuses(shiftId) { const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return; sh.assignedBuses = D.buses.map(b => b.id); save(); renderShifts(); }
    function renameShift(id, val) { const sh = D.shifts.find(s => s.id === id); if (sh) { sh.label = val.trim(); save(); } }

    // =========================================================================
    // STAFF (Monitors + Counselors)
    // =========================================================================
    function renderStaff() { renderMonitors(); renderCounselors(); document.getElementById('staffCount').textContent = (D.monitors.length + D.counselors.length) + ' staff'; }
    function renderMonitors() {
        const tbody = document.getElementById('monitorTableBody'), empty = document.getElementById('monitorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('monitorCount').textContent = D.monitors.length;
        if (!D.monitors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.monitors.map(m => { const bus = D.buses.find(b => b.id === m.assignedBus); return '<tr><td style="font-weight:600">' + esc(m.name) + '</td><td>' + (esc(m.address) || '—') + '</td><td>' + (esc(m.phone) || '—') + '</td><td>' + (bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + '"></span>' + esc(bus.name) + '</span>' : '—') + '</td><td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editMonitor(\'' + m.id + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.deleteMonitor(\'' + m.id + '\')">×</button></div></td></tr>'; }).join('');
    }
    function renderCounselors() {
        const tbody = document.getElementById('counselorTableBody'), empty = document.getElementById('counselorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('counselorCount').textContent = D.counselors.length;
        if (!D.counselors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.counselors.map(c => { const bus = D.buses.find(b => b.id === c.assignedBus); return '<tr><td style="font-weight:600">' + esc(c.name) + '</td><td>' + (esc(c.address) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (c.needsStop === 'yes' ? '<span class="badge badge-warning">Yes</span>' : '<span class="badge badge-neutral">No</span>') + '</td><td>' + (bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + '"></span>' + esc(bus.name) + '</span>' : '—') + '</td><td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editCounselor(\'' + c.id + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.deleteCounselor(\'' + c.id + '\')">×</button></div></td></tr>'; }).join('');
    }
    function openMonitorModal(eId) { _editMonitorId = eId || null; document.getElementById('monitorModalTitle').textContent = eId ? 'Edit Monitor' : 'Add Monitor'; updateBusSelects(); const m = eId ? D.monitors.find(x => x.id === eId) : null; document.getElementById('monitorName').value = m?.name || ''; document.getElementById('monitorAddress').value = m?.address || ''; document.getElementById('monitorPhone').value = m?.phone || ''; document.getElementById('monitorBusAssign').value = m?.assignedBus || ''; openModal('monitorModal'); document.getElementById('monitorName').focus(); }
    function saveMonitor() { const n = document.getElementById('monitorName')?.value.trim(); if (!n) { toast('Enter name', 'error'); return; } const a = document.getElementById('monitorAddress')?.value.trim(), p = document.getElementById('monitorPhone')?.value.trim(), b = document.getElementById('monitorBusAssign')?.value || ''; if (_editMonitorId) { const m = D.monitors.find(x => x.id === _editMonitorId); if (m) { m.name = n; m.address = a; m.phone = p; m.assignedBus = b; } } else D.monitors.push({ id: uid(), name: n, address: a, phone: p, assignedBus: b }); save(); closeModal('monitorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editMonitorId ? 'Updated' : 'Monitor added'); }
    function editMonitor(id) { openMonitorModal(id); }
    function deleteMonitor(id) { const m = D.monitors.find(x => x.id === id); if (!m || !confirm('Delete "' + m.name + '"?')) return; D.monitors = D.monitors.filter(x => x.id !== id); save(); renderStaff(); renderFleet(); updateStats(); toast('Deleted'); }
    function openCounselorModal(eId) { _editCounselorId = eId || null; document.getElementById('counselorModalTitle').textContent = eId ? 'Edit Counselor' : 'Add Counselor'; updateBusSelects(); const c = eId ? D.counselors.find(x => x.id === eId) : null; document.getElementById('counselorName').value = c?.name || ''; document.getElementById('counselorAddress').value = c?.address || ''; document.getElementById('counselorBunk').value = c?.bunk || ''; document.getElementById('counselorNeedsStop').value = c?.needsStop || 'no'; document.getElementById('counselorBusAssign').value = c?.assignedBus || ''; openModal('counselorModal'); document.getElementById('counselorName').focus(); }
    function saveCounselor() { const n = document.getElementById('counselorName')?.value.trim(); if (!n) { toast('Enter name', 'error'); return; } const a = document.getElementById('counselorAddress')?.value.trim(), b = document.getElementById('counselorBunk')?.value.trim(), ns = document.getElementById('counselorNeedsStop')?.value || 'no', bus = document.getElementById('counselorBusAssign')?.value || ''; if (_editCounselorId) { const c = D.counselors.find(x => x.id === _editCounselorId); if (c) { c.name = n; c.address = a; c.bunk = b; c.needsStop = ns; c.assignedBus = bus; } } else D.counselors.push({ id: uid(), name: n, address: a, bunk: b, needsStop: ns, assignedBus: bus }); save(); closeModal('counselorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editCounselorId ? 'Updated' : 'Counselor added'); }
    function editCounselor(id) { openCounselorModal(id); }
    function deleteCounselor(id) { const c = D.counselors.find(x => x.id === id); if (!c || !confirm('Delete "' + c.name + '"?')) return; D.counselors = D.counselors.filter(x => x.id !== id); save(); renderStaff(); renderFleet(); updateStats(); toast('Deleted'); }

    // =========================================================================
    // ADDRESSES
    // =========================================================================
    function renderAddresses() {
        const roster = getRoster();
        const names = Object.keys(roster).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const filter = (document.getElementById('addressSearch')?.value || '').toLowerCase().trim();
        let filtered = names;
        if (filter) filtered = names.filter(n => { const c = roster[n]; const a = D.addresses[n]; return n.toLowerCase().includes(filter) || (c.division || '').toLowerCase().includes(filter) || (a?.street || '').toLowerCase().includes(filter) || (a?.city || '').toLowerCase().includes(filter); });
        const tbody = document.getElementById('addressTableBody'), empty = document.getElementById('addressEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('addressCount').textContent = filter ? filtered.length + ' of ' + names.length : names.length;
        if (!names.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; updateAddrProgress(0, 0); return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        let withAddr = 0; names.forEach(n => { if (D.addresses[n]?.street) withAddr++; });
        updateAddrProgress(withAddr, names.length);
        tbody.innerHTML = filtered.map(n => {
            const c = roster[n], a = D.addresses[n];
            const hasA = a?.street;
            const full = hasA ? [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') : '';
            const badge = hasA ? (a.geocoded ? (a._zipMismatch ? '<span class="badge badge-warning" title="ZIP mismatch">⚠ Check</span>' : '<span class="badge badge-success">Geocoded</span>') : '<span class="badge badge-warning">Not geocoded</span>') : '<span class="badge badge-danger">Missing</span>';
            return '<tr><td style="font-size:.75rem;color:var(--text-muted);font-family:monospace;">' + (c.camperId ? '#' + String(c.camperId).padStart(4, '0') : '') + '</td><td style="font-weight:600">' + esc(n) + '</td><td>' + (esc(c.division) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (full ? esc(full) : '<span style="color:var(--text-muted)">No address</span>') + '</td><td>' + badge + '</td><td><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editAddress(\'' + esc(n.replace(/'/g, "\\'")) + '\')">' + (hasA ? 'Edit' : 'Add') + '</button></td></tr>';
        }).join('');
    }
    function updateAddrProgress(n, t) { const p = t > 0 ? Math.round(n / t * 100) : 0; document.getElementById('addressProgressBar').style.width = p + '%'; document.getElementById('addressProgressText').textContent = n + ' of ' + t + ' (' + p + '%)'; }
    function editAddress(name) {
        _editCamper = name; const roster = getRoster(), c = roster[name] || {}, a = D.addresses[name] || {};
        document.getElementById('addressCamperName').textContent = name;
        document.getElementById('addressCamperBunk').textContent = [c.division, c.bunk].filter(Boolean).join(' / ');
        document.getElementById('addrStreet').value = a.street || ''; document.getElementById('addrCity').value = a.city || '';
        document.getElementById('addrState').value = a.state || 'NY'; document.getElementById('addrZip').value = a.zip || '';
        openModal('addressModal'); document.getElementById('addrStreet').focus();
    }
    function saveAddress() {
        if (!_editCamper) return;
        const st = document.getElementById('addrStreet')?.value.trim(), ci = document.getElementById('addrCity')?.value.trim(), sa = document.getElementById('addrState')?.value.trim().toUpperCase(), z = document.getElementById('addrZip')?.value.trim();
        if (!st) { delete D.addresses[_editCamper]; save(); closeModal('addressModal'); renderAddresses(); updateStats(); toast('Address cleared'); return; }
        D.addresses[_editCamper] = { street: st, city: ci, state: sa, zip: z, lat: null, lng: null, geocoded: false };
        save(); closeModal('addressModal'); renderAddresses(); updateStats(); toast('Saved — geocoding...');
        geocodeOne(_editCamper).then(ok => { if (ok) { save(); renderAddresses(); toast('Geocoded'); } });
    }

    // =========================================================================
    // GEOCODING
    // =========================================================================
    async function geocodeOne(name) {
        const a = D.addresses[name]; if (!a?.street) return false;
        const q = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
        try { const d = await censusGeocode(q); if (d?.result?.addressMatches?.length) { const best = d.result.addressMatches[0]; a.lat = best.coordinates.y; a.lng = best.coordinates.x; a.geocoded = true; a._zipMismatch = false; a._geocodeSource = 'census'; return true; } } catch (e) { console.warn('[Go] Census error for', name, e.message); }
        const key = getApiKey(); if (!key) return false;
        const params = { text: q, size: '5', 'boundary.country': 'US' };
        if (_campCoordsCache) { params['focus.point.lat'] = _campCoordsCache.lat; params['focus.point.lon'] = _campCoordsCache.lng; }
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams(params), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return false; const d = await r.json(); if (!d.features?.length) return false; let best = null; if (a.zip) best = d.features.find(f => (f.properties?.postalcode || '') === a.zip); if (!best) best = d.features[0]; const co = best.geometry.coordinates; a.lng = co[0]; a.lat = co[1]; a.geocoded = true; a._geocodeSource = 'ors'; a._zipMismatch = !!(a.zip && best.properties?.postalcode && best.properties.postalcode !== a.zip); return true; } catch (e) { return false; }
    }

    async function geocodeAll(force) {
        if (!_campCoordsCache && D.setup.campAddress) { toast('Geocoding camp address first...'); const cc = await geocodeSingle(D.setup.campAddress); if (cc) { _campCoordsCache = cc; D.setup.campLat = cc.lat; D.setup.campLng = cc.lng; save(); } }
        const todo = Object.keys(D.addresses).filter(n => { const a = D.addresses[n]; if (!a?.street) return false; if (force) { a.geocoded = false; a.lat = null; a.lng = null; a._zipMismatch = false; return true; } return !a.geocoded; });
        if (!todo.length) { toast('All addresses already geocoded!'); return; }
        toast('Pass 1: Census — ' + todo.length + ' addresses...');
        let censusOk = 0, censusFail = [];
        for (let i = 0; i < todo.length; i++) {
            const name = todo[i]; const a = D.addresses[name]; if (!a?.street) { censusFail.push(name); continue; }
            const q = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
            try { const d = await censusGeocode(q); if (d?.result?.addressMatches?.length) { const best = d.result.addressMatches[0]; a.lat = best.coordinates.y; a.lng = best.coordinates.x; a.geocoded = true; a._zipMismatch = false; a._geocodeSource = 'census'; censusOk++; } else censusFail.push(name); } catch (e) { censusFail.push(name); }
            if ((i + 1) % 10 === 0 || i === todo.length - 1) { renderAddresses(); updateStats(); toast('Census: ' + censusOk + ' ✓  ' + censusFail.length + ' remaining  (' + (i + 1) + '/' + todo.length + ')'); }
            if (i < todo.length - 1) await new Promise(r => setTimeout(r, 300));
        }
        save();
        if (censusFail.length > 0 && getApiKey()) {
            toast('Pass 2: ORS — ' + censusFail.length + ' addresses...'); let orsOk = 0, orsFail = 0;
            for (let i = 0; i < censusFail.length; i++) {
                const name = censusFail[i]; const a = D.addresses[name]; if (!a?.street || a.geocoded) continue;
                const q = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
                const params = { text: q, size: '5', 'boundary.country': 'US' }; if (_campCoordsCache) { params['focus.point.lat'] = _campCoordsCache.lat; params['focus.point.lon'] = _campCoordsCache.lng; }
                try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams(params), { headers: { 'Authorization': getApiKey(), 'Accept': 'application/json' } }); if (r.ok) { const d = await r.json(); if (d.features?.length) { let best = null; if (a.zip) best = d.features.find(f => (f.properties?.postalcode || '') === a.zip); if (!best) best = d.features[0]; const co = best.geometry.coordinates; a.lng = co[0]; a.lat = co[1]; a.geocoded = true; a._geocodeSource = 'ors'; a._zipMismatch = !!(a.zip && best.properties?.postalcode && best.properties.postalcode !== a.zip); orsOk++; } else orsFail++; } else { orsFail++; if (r.status === 429 || r.status === 403) { orsFail += censusFail.length - i - 1; break; } } } catch (e) { orsFail++; }
                if ((i + 1) % 5 === 0 || i === censusFail.length - 1) { renderAddresses(); updateStats(); toast('ORS: ' + orsOk + ' ✓  ' + orsFail + ' ✗  (' + (i + 1) + '/' + censusFail.length + ')'); }
                if (i < censusFail.length - 1) await new Promise(r => setTimeout(r, 1500));
            }
            save(); renderAddresses(); updateStats();
            const totalOk = censusOk + orsOk, totalFail = censusFail.length - orsOk;
            if (totalFail > 0) toast(totalOk + ' geocoded, ' + totalFail + ' failed', 'error');
            else toast('All ' + totalOk + ' geocoded!');
        } else {
            renderAddresses(); updateStats();
            if (censusFail.length > 0) toast(censusOk + ' geocoded, ' + censusFail.length + ' failed', 'error');
            else toast('All ' + censusOk + ' geocoded via Census!');
        }
    }

    async function geocodeSingle(addr) {
        try { const d = await censusGeocode(addr); if (d?.result?.addressMatches?.length) { const m = d.result.addressMatches[0]; return { lat: m.coordinates.y, lng: m.coordinates.x }; } } catch (_) {}
        const key = getApiKey(); if (!key) return null;
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams({ text: addr, size: '1', 'boundary.country': 'US' }), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return null; const d = await r.json(); if (d.features?.length) { const co = d.features[0].geometry.coordinates; return { lat: co[1], lng: co[0] }; } } catch (_) {} return null;
    }

    // =========================================================================
    // SYSTEM CHECK
    // =========================================================================
    async function systemCheck() {
        let pass = 0, fail = 0, warn = 0;
        function P(msg) { pass++; console.log('✅ ' + msg); } function F(msg) { fail++; console.log('❌ ' + msg); } function Wr(msg) { warn++; console.log('⚠️  ' + msg); }
        console.log('\n╔══════════════════════════════════════╗\n║   CAMPISTRY GO v3 — SYSTEM CHECK     ║\n╚══════════════════════════════════════╝\n');
        const roster = getRoster(); const cc = Object.keys(roster).length;
        cc > 0 ? P('Roster: ' + cc + ' campers') : F('Roster: EMPTY');
        const ac = Object.keys(D.addresses).length, gc = Object.values(D.addresses).filter(a => a.geocoded).length;
        ac > 0 ? P('Addresses: ' + ac) : F('Addresses: NONE'); gc > 0 ? P('Geocoded: ' + gc + '/' + ac) : F('Geocoded: 0');
        P('Mode: ' + D.activeMode); D.buses.length > 0 ? P('Buses: ' + D.buses.length) : F('Buses: NONE');
        D.setup.campAddress ? P('Camp: ' + D.setup.campAddress) : F('Camp address: NOT SET');
        const key = getApiKey(); key ? P('ORS key: set') : Wr('ORS key: not set — VROOM optimization will not work');
        // Test VROOM
        if (key) { try { const r = await fetch('https://api.openrouteservice.org/optimization', { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs: [{ id: 1, location: [-73.747, 40.606], service: 60 }], vehicles: [{ id: 1, profile: 'driving-car', start: [-73.747, 40.606], end: [-73.747, 40.606], capacity: [47] }] }) }); r.ok ? P('VROOM optimization: working') : F('VROOM: HTTP ' + r.status); } catch (e) { F('VROOM: ' + e.message); } }
        try { const tr = await fetch('https://a.tile.openstreetmap.org/0/0/0.png', { method: 'HEAD' }); tr.ok ? P('OSM tiles: OK') : F('OSM tiles: ' + tr.status); } catch (e) { F('OSM tiles: BLOCKED'); }
        console.log('\n' + pass + ' passed | ' + fail + ' failed | ' + warn + ' warnings');
        if (fail === 0) console.log('🟢 System ready!'); else console.log('🔴 Fix ' + fail + ' failure(s)');
    }
    const testGeocode = systemCheck;

    // =========================================================================
    // CSV IMPORT / EXPORT
    // =========================================================================
    function downloadAddressTemplate() {
        const roster = getRoster(); const names = Object.keys(roster).sort();
        let csv = '\uFEFFID,Name,Division,Bunk,Street Address,City,State,ZIP,Transport,Ride With\n';
        names.forEach(n => { const c = roster[n], a = D.addresses[n] || {}; csv += [c.camperId ? String(c.camperId).padStart(4, '0') : '', n, c.division || '', c.bunk || '', a.street || '', a.city || '', a.state || 'NY', a.zip || '', a.transport || 'bus', a.rideWith || ''].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n'; });
        const blob = new Blob([csv], { type: 'text/csv' }); const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = 'campistry_go_addresses.csv'; el.click(); toast('Template downloaded');
    }
    function importAddressCsv() { const inp = document.getElementById('csvFileInput'); inp.onchange = function () { if (!inp.files[0]) return; const r = new FileReader(); r.onload = e => { parseCsv(e.target.result); inp.value = ''; }; r.readAsText(inp.files[0]); }; inp.click(); }
    function parseCsv(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) { toast('Empty CSV', 'error'); return; }
        const hdr = parseLine(lines[0]).map(h => h.toLowerCase().trim());
        const ni = hdr.findIndex(h => h === 'name' || h === 'camper name' || h === 'camper'), si = hdr.findIndex(h => h.includes('street') || h === 'address'), ci = hdr.findIndex(h => h === 'city'), sti = hdr.findIndex(h => h === 'state'), zi = hdr.findIndex(h => h === 'zip' || h.includes('zip')), tri = hdr.findIndex(h => h === 'transport' || h === 'mode' || h.includes('pickup') || h.includes('carpool')), rwi = hdr.findIndex(h => h === 'ride-with' || h === 'ridewith' || h === 'ride with' || h.includes('pair'));
        if (ni < 0 || si < 0) { toast('Need Name + Street columns', 'error'); return; }
        D.addresses = {};
        const roster = getRoster(); let up = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = parseLine(lines[i]); const name = (cols[ni] || '').trim(); if (!name) continue;
            const rn = Object.keys(roster).find(k => k.toLowerCase() === name.toLowerCase()) || name;
            const street = (cols[si] || '').trim(); if (!street) continue;
            const transport = tri >= 0 ? (cols[tri] || '').trim().toLowerCase() : 'bus';
            const rideWith = rwi >= 0 ? (cols[rwi] || '').trim() : '';
            D.addresses[rn] = { street, city: ci >= 0 ? (cols[ci] || '').trim() : '', state: sti >= 0 ? (cols[sti] || '').trim().toUpperCase() : 'NY', zip: zi >= 0 ? (cols[zi] || '').trim() : '', lat: null, lng: null, geocoded: false, transport: (transport === 'pickup' || transport === 'carpool') ? 'pickup' : 'bus', rideWith: rideWith }; up++;
        }
        save(); renderAddresses(); updateStats(); toast(up + ' addresses imported');
    }
    function parseLine(line) { const r = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; } else { if (ch === '"') inQ = true; else if (ch === ',' || ch === '\t') { r.push(cur); cur = ''; } else cur += ch; } } r.push(cur); return r; }
    function updateStats() {
        const roster = getRoster(); const c = Object.keys(roster).length; let wA = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.street) wA++; });
        document.getElementById('statBuses').textContent = D.buses.length; document.getElementById('statCampers').textContent = c;
        document.getElementById('statShifts').textContent = D.shifts.length; document.getElementById('statAddresses').textContent = wA + '/' + c;
    }

    // =========================================================================
    // PREFLIGHT
    // =========================================================================
    function runPreflight() {
        const roster = getRoster(); const camperCount = Object.keys(roster).length;
        let geocoded = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.geocoded) geocoded++; });
        const rs = parseInt(document.getElementById('routeReserveSeats')?.value) || D.setup.reserveSeats || 0;
        let totalSeats = 0; D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); totalSeats += Math.max(0, (b.capacity || 0) - 1 - (m ? 1 : 0) - co.length - rs); });
        let inShifts = 0; Object.entries(roster).forEach(([n, c]) => { if (D.shifts.some(sh => camperMatchesShift(c, sh))) inShifts++; });
        const largestShift = D.shifts.length ? Math.max(...D.shifts.map(s => countCampersForShift(s))) : 0;
        let pickupCount = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.transport === 'pickup') pickupCount++; });
        const checks = [
            { label: D.buses.length + ' bus(es)', status: D.buses.length > 0 ? 'ok' : 'fail' },
            { label: D.shifts.length + ' shift(s)', status: D.shifts.length > 0 ? 'ok' : 'warn', detail: D.shifts.length === 0 ? 'No shifts — all campers in one group' : '' },
            { label: inShifts + '/' + camperCount + ' campers in shifts', status: inShifts === camperCount && camperCount > 0 ? 'ok' : inShifts > 0 ? 'warn' : 'fail' },
            { label: geocoded + '/' + camperCount + ' geocoded', status: geocoded === camperCount && camperCount > 0 ? 'ok' : geocoded > 0 ? 'warn' : 'fail' },
            { label: totalSeats + ' seats for ' + largestShift + ' in largest shift', status: 'ok' },
            { label: D.setup.campAddress ? 'Camp address set' : 'No camp address', status: D.setup.campAddress ? 'ok' : 'warn' },
            { label: getApiKey() ? 'ORS key set (VROOM enabled)' : 'No ORS key — VROOM disabled', status: getApiKey() ? 'ok' : 'fail', detail: getApiKey() ? '' : 'VROOM optimization requires an ORS API key' },
            { label: pickupCount + ' carpool/pickup (excluded)', status: 'ok' }
        ];
        const anyFail = checks.some(c => c.status === 'fail'); const canGen = D.buses.length > 0 && geocoded > 0 && getApiKey();
        const badge = document.getElementById('preflightStatus'); badge.className = 'badge ' + (anyFail ? 'badge-danger' : canGen ? 'badge-success' : 'badge-warning'); badge.textContent = anyFail ? 'Not ready' : 'Ready';
        document.getElementById('preflightBody').innerHTML = checks.map(c => '<div class="preflight-item preflight-' + c.status + '"><div class="preflight-icon">' + (c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗') + '</div><div><div style="font-weight:600;color:var(--text-primary)">' + esc(c.label) + '</div>' + (c.detail ? '<div style="font-size:.75rem;color:var(--text-muted)">' + esc(c.detail) + '</div>' : '') + '</div></div>').join('');
        document.getElementById('routeMode').value = D.setup.dropoffMode || 'door-to-door';
        document.getElementById('routeReserveSeats').value = D.setup.reserveSeats ?? 2;
        const btn = document.getElementById('generateRoutesBtn'); btn.disabled = !canGen; btn.style.opacity = canGen ? '1' : '0.5';
    }

    // =========================================================================
    // REGION DETECTION (ZIP-based)
    // =========================================================================
    function detectRegions() {
        const roster = getRoster(); const zipGroups = {};
        Object.keys(roster).forEach(name => { const a = D.addresses[name]; if (!a?.geocoded || !a.lat || !a.lng) return; if (a.transport === 'pickup') return; const zip = (a.zip || '').trim(); if (!zip) return; if (!zipGroups[zip]) zipGroups[zip] = { campers: [], cities: {} }; zipGroups[zip].campers.push({ name, lat: a.lat, lng: a.lng, city: a.city || '', division: roster[name].division || '' }); const city = a.city || 'Unknown'; zipGroups[zip].cities[city] = (zipGroups[zip].cities[city] || 0) + 1; });
        if (!Object.keys(zipGroups).length) { toast('No geocoded campers with ZIP codes', 'error'); return; }
        const clusters = [];
        Object.entries(zipGroups).forEach(([zip, data]) => { const campers = data.campers; const regionName = Object.keys(data.cities).sort((a, b) => data.cities[b] - data.cities[a])[0] || zip; const cLat = campers.reduce((s, c) => s + c.lat, 0) / campers.length; const cLng = campers.reduce((s, c) => s + c.lng, 0) / campers.length; clusters.push({ id: 'zip_' + zip, name: regionName + ' (' + zip + ')', color: REGION_COLORS[clusters.length % REGION_COLORS.length], centroidLat: cLat, centroidLng: cLng, camperNames: campers.map(c => c.name), zip: zip }); });
        clusters.sort((a, b) => b.camperNames.length - a.camperNames.length);
        _detectedRegions = clusters; _detectedRadius = null; renderRegionPreview();
        console.log('[Go] ZIP-based regions:'); clusters.forEach(r => console.log('[Go]   ' + r.name + ': ' + r.camperNames.length + ' campers'));
        toast(clusters.length + ' regions from ZIP codes');
    }

    function renderRegionPreview() {
        const body = document.getElementById('regionPreviewBody');
        if (!_detectedRegions?.length) { body.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text-muted);">No regions detected yet</div>'; return; }
        const roster = getRoster(); const rs = parseInt(document.getElementById('routeReserveSeats')?.value) || D.setup.reserveSeats || 0;
        let perBusCap = 0; if (D.buses.length) { let tc = 0; D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); tc += Math.max(0, (b.capacity || 0) - 1 - (m ? 1 : 0) - co.length - rs); }); perBusCap = Math.floor(tc / D.buses.length); }
        let html = '';
        _detectedRegions.forEach(reg => {
            const shiftBadges = D.shifts.map(sh => { let count = 0; reg.camperNames.forEach(n => { const c = roster[n]; if (c && camperMatchesShift(c, sh)) count++; }); const busesNeeded = perBusCap > 0 ? Math.ceil(count / perBusCap) : '?'; return '<span class="region-shift-badge">' + esc(sh.label || 'Shift') + ': <strong>' + count + '</strong> → ' + busesNeeded + ' bus(es)</span>'; }).join('');
            html += '<div class="region-row"><span class="region-dot" style="background:' + esc(reg.color) + '"></span><span class="region-name">' + esc(reg.name) + '</span><span style="font-weight:600;min-width:40px;text-align:center">' + reg.camperNames.length + '</span><div class="region-counts">' + shiftBadges + '</div></div>';
        });
        html = '<div style="margin-bottom:.75rem;font-size:.8125rem;color:var(--text-secondary);"><strong>' + _detectedRegions.length + '</strong> regions from <strong>' + _detectedRegions.reduce((s, r) => s + r.camperNames.length, 0) + '</strong> addresses. <strong>' + D.buses.length + '</strong> bus(es).</div>' + html;
        body.innerHTML = html;
    }

    function assignBusesToRegions(vehicles, regions, shifts) {
        const roster = getRoster(); const perBusCap = vehicles.length ? Math.floor(vehicles.reduce((s, v) => s + v.capacity, 0) / vehicles.length) : 30;
        const demand = {}; shifts.forEach(sh => { demand[sh.id] = {}; regions.forEach(reg => { let count = 0; reg.camperNames.forEach(n => { const c = roster[n]; if (c && camperMatchesShift(c, sh)) count++; }); demand[sh.id][reg.id] = Math.ceil(count / Math.max(1, perBusCap)); }); });
        const assignments = {}; let prevAssign = {};
        shifts.forEach((sh, si) => {
            assignments[sh.id] = {}; regions.forEach(reg => { assignments[sh.id][reg.id] = []; });
            const needed = demand[sh.id]; const currAssign = {}; const usedBuses = new Set();
            if (si === 0) {
                const regionsBySize = [...regions].sort((a, b) => (needed[b.id] || 0) - (needed[a.id] || 0)); let busIdx = 0;
                regionsBySize.forEach(reg => { const n = needed[reg.id] || 0; for (let i = 0; i < n && busIdx < vehicles.length; i++) { const v = vehicles[busIdx]; assignments[sh.id][reg.id].push(v.busId); currAssign[v.busId] = reg.id; busIdx++; } });
                while (busIdx < vehicles.length) { const v = vehicles[busIdx]; const bestReg = regions.reduce((best, reg) => (needed[reg.id] || 0) > (needed[best.id] || 0) ? reg : best, regions[0]); assignments[sh.id][bestReg.id].push(v.busId); currAssign[v.busId] = bestReg.id; busIdx++; }
            } else {
                const remaining = { ...needed };
                vehicles.forEach(v => { const prevRegion = prevAssign[v.busId]; if (prevRegion && remaining[prevRegion] > 0) { assignments[sh.id][prevRegion].push(v.busId); currAssign[v.busId] = prevRegion; usedBuses.add(v.busId); remaining[prevRegion]--; } });
                const unassigned = vehicles.filter(v => !usedBuses.has(v.busId));
                regions.filter(r => (remaining[r.id] || 0) > 0).forEach(reg => { while ((remaining[reg.id] || 0) > 0 && unassigned.length > 0) { let bestIdx = 0, bestDist = Infinity; unassigned.forEach((v, i) => { const prevReg = prevAssign[v.busId]; const prevRegObj = prevReg ? regions.find(r => r.id === prevReg) : null; const d = prevRegObj ? haversineMi(prevRegObj.centroidLat, prevRegObj.centroidLng, reg.centroidLat, reg.centroidLng) : 999; if (d < bestDist) { bestDist = d; bestIdx = i; } }); const v = unassigned.splice(bestIdx, 1)[0]; assignments[sh.id][reg.id].push(v.busId); currAssign[v.busId] = reg.id; remaining[reg.id]--; } });
                unassigned.forEach(v => { const biggest = regions.reduce((best, r) => (needed[r.id] || 0) > (needed[best.id] || 0) ? r : best, regions[0]); assignments[sh.id][biggest.id].push(v.busId); currAssign[v.busId] = biggest.id; });
            }
            prevAssign = currAssign;
        });
        _busAssignments = assignments; return assignments;
    }

    // =========================================================================
    // ROUTING ENGINE v10 — VROOM-powered
    //
    // Replaces the custom TSP + K-Means + inter-bus optimization with a single
    // call to OpenRouteService's VROOM endpoint. VROOM solves bus ASSIGNMENT
    // and stop ORDERING simultaneously using a proper VRP metaheuristic.
    //
    // Phase 1: Create stops (door-to-door / optimized / corner)
    // Phase 2: Build VROOM request (jobs + vehicles)
    // Phase 3: Call ORS optimization endpoint → get optimal routes
    // Phase 4: Parse response into our route format
    // Phase 5: Orient for arrival/dismissal, calculate ETAs
    // =========================================================================

    async function generateRoutes() {
        const roster = getRoster();
        const mode = document.getElementById('routeMode')?.value || 'door-to-door';
        const reserveSeats = parseInt(document.getElementById('routeReserveSeats')?.value) || 0;
        const avgStopMin = D.setup.avgStopTime || 2;
        const avgSpeedMph = D.setup.avgSpeed || 25;
        const key = getApiKey();
        if (!key) { toast('ORS API key required for VROOM optimization', 'error'); return; }

        if (!_detectedRegions?.length) detectRegions();
        if (!_detectedRegions?.length) { toast('No regions detected', 'error'); return; }

        const vehicles = D.buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(c => c.assignedBus === b.id);
            return { busId: b.id, name: b.name, color: b.color || '#10b981', capacity: Math.max(0, (b.capacity || 0) - 1 - (mon ? 1 : 0) - couns.length - reserveSeats), monitor: mon, counselors: couns };
        });

        let campCoords = null;
        if (D.setup.campAddress) {
            showProgress('Geocoding camp...', 5);
            campCoords = _campCoordsCache || await geocodeSingle(D.setup.campAddress);
            if (campCoords) { _campCoordsCache = campCoords; D.setup.campLat = campCoords.lat; D.setup.campLng = campCoords.lng; }
        }
        const campLat = campCoords?.lat || _detectedRegions[0].centroidLat;
        const campLng = campCoords?.lng || _detectedRegions[0].centroidLng;

        showProgress('Assigning buses to regions...', 10);
        const assignments = assignBusesToRegions(vehicles, _detectedRegions, D.shifts);

        const allShiftResults = [];
        const shifts = D.shifts.length ? D.shifts : [{ id: '__all__', label: 'All Campers', divisions: [], departureTime: D.activeMode === 'arrival' ? '07:00' : '16:00', _isVirtual: true }];

        for (let si = 0; si < shifts.length; si++) {
            const shift = shifts[si];
            const pctBase = (si / shifts.length) * 100;
            showProgress((shift.label || 'Shift ' + (si + 1)) + ': creating stops...', pctBase + 10);

            const shiftBusIds = shift.assignedBuses?.length ? shift.assignedBuses : vehicles.map(v => v.busId);
            const shiftVehicles = shiftBusIds.map(bid => vehicles.find(v => v.busId === bid)).filter(Boolean);

            const allCampers = [];
            Object.keys(roster).forEach(name => {
                const c = roster[name]; const a = D.addresses[name];
                if (!c || !a?.geocoded || !a.lat || !a.lng) return;
                if (a.transport === 'pickup') return;
                if (shift._isVirtual || camperMatchesShift(c, shift)) {
                    allCampers.push({ name, division: c.division, bunk: c.bunk || '', lat: a.lat, lng: a.lng, address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') });
                }
            });

            let routes = [];
            if (allCampers.length && shiftVehicles.length) {
                routes = await solveWithVROOM(allCampers, shiftVehicles, campLat, campLng, mode, key, shift, si, shifts.length);
            }

            // Add monitor + counselor stops
            routes.forEach(r => {
                if (r.monitor?.address) r.stops.push({ stopNum: r.stops.length + 1, campers: [], address: r.monitor.address, lat: null, lng: null, isMonitor: true, monitorName: r.monitor.name });
                r.counselors.filter(c => c.needsStop === 'yes' && c.address).forEach(c => { r.stops.push({ stopNum: r.stops.length + 1, campers: [], address: c.address, lat: null, lng: null, isCounselor: true, counselorName: c.name }); });
            });

            // Calculate ETAs
            const isArrival = D.activeMode === 'arrival';
            const timeMin = parseTime(shift.departureTime || (isArrival ? '08:00' : '16:00'));
            routes.forEach(r => {
                if (isArrival) {
                    let totalDur = 0;
                    r.stops.forEach((stop, i) => { if (i === 0) totalDur += 15; else { const prev = r.stops[i - 1]; if (stop.lat && prev.lat) totalDur += (haversineMi(prev.lat, prev.lng, stop.lat, stop.lng) / avgSpeedMph) * 60; else totalDur += 3; } totalDur += avgStopMin; });
                    const lastStop = r.stops[r.stops.length - 1];
                    if (lastStop?.lat && _campCoordsCache) totalDur += (haversineMi(lastStop.lat, lastStop.lng, _campCoordsCache.lat, _campCoordsCache.lng) / avgSpeedMph) * 60;
                    let cum = timeMin - totalDur;
                    r.stops.forEach((stop, i) => { if (i > 0) { const prev = r.stops[i - 1]; if (stop.lat && prev.lat) cum += (haversineMi(prev.lat, prev.lng, stop.lat, stop.lng) / avgSpeedMph) * 60; else cum += 3; } cum += avgStopMin; stop.estimatedTime = formatTime(cum); stop.estimatedMin = cum; });
                    r.totalDuration = Math.round(totalDur);
                } else {
                    let cum = timeMin;
                    r.stops.forEach((stop, i) => { if (i === 0) cum += 15; else { const prev = r.stops[i - 1]; if (stop.lat && prev.lat) cum += (haversineMi(prev.lat, prev.lng, stop.lat, stop.lng) / avgSpeedMph) * 60; else cum += 3; } cum += avgStopMin; stop.estimatedTime = formatTime(cum); stop.estimatedMin = cum; });
                    r.totalDuration = Math.round(cum - timeMin);
                }
                r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);
            });

            allShiftResults.push({ shift, routes, camperCount: routes.reduce((s, r) => s + r.camperCount, 0) });
        }

        _generatedRoutes = allShiftResults;
        _routeGeomCache = {}; window._routeGeomCache = _routeGeomCache;
        D.savedRoutes = allShiftResults;
        save();
        showProgress('Done!', 100);
        setTimeout(() => { hideProgress(); renderRouteResults(applyOverrides(allShiftResults)); }, 400);
    }

    // =========================================================================
    // VROOM SOLVER — the core engine
    // =========================================================================
    async function solveWithVROOM(campers, vehicles, campLat, campLng, mode, apiKey, shift, shiftIdx, totalShifts) {
        const isArrival = D.activeMode === 'arrival';
        const hasShifts = totalShifts > 1;
        const numBuses = vehicles.length;
        const serviceTime = (D.setup.avgStopTime || 2) * 60; // VROOM uses seconds

        // Phase 1: Create stops
        let stops;
        if (mode === 'optimized-stops') stops = createOptimizedStops(campers);
        else if (mode === 'corner-stops') stops = createCornerStops(campers);
        else stops = createHouseStops(campers);
        if (!stops.length) return [];

        console.log('[Go] VROOM Engine: ' + stops.length + ' stops, ' + numBuses + ' buses, mode=' + mode);

        // Phase 2: Split by region to stay under ORS 70-location limit
        // Each ZIP region gets its own VROOM call with its own buses
        showProgress('Optimizing routes (VROOM)...', 25 + (shiftIdx / totalShifts) * 50);

        // Group stops by region
        const regionChunks = {};
        if (_detectedRegions && _detectedRegions.length > 0) {
            _detectedRegions.forEach(reg => { regionChunks[reg.id] = []; });
            stops.forEach((stop, i) => {
                let bestReg = _detectedRegions[0].id;
                _detectedRegions.forEach(reg => { if (stop.campers.some(c => reg.camperNames.includes(c.name))) bestReg = reg.id; });
                if (!regionChunks[bestReg]) regionChunks[bestReg] = [];
                regionChunks[bestReg].push({ stop, globalIdx: i });
            });
        } else {
            regionChunks['all'] = stops.map((stop, i) => ({ stop, globalIdx: i }));
        }

        // Allocate vehicles to regions proportionally
        const regionDemandV = {};
        Object.entries(regionChunks).forEach(([regId, items]) => {
            regionDemandV[regId] = items.reduce((s, it) => s + it.stop.campers.length, 0);
        });
        let vehiclePoolV = [...vehicles];
        const regionVehiclesV = {};
        const sortedRegsV = Object.entries(regionDemandV).filter(([_, d]) => d > 0).sort((a, b) => b[1] - a[1]);
        sortedRegsV.forEach(([regId]) => { regionVehiclesV[regId] = []; });

        // At least 1 bus per region
        sortedRegsV.forEach(([regId]) => { if (vehiclePoolV.length) regionVehiclesV[regId].push(vehiclePoolV.shift()); });

        // Distribute remaining by worst campers-per-capacity ratio
        while (vehiclePoolV.length) {
            let worstReg = sortedRegsV[0][0], worstRatio = 0;
            sortedRegsV.forEach(([regId, dem]) => {
                const cap = regionVehiclesV[regId].reduce((s, v) => s + v.capacity, 0);
                const ratio = dem / Math.max(1, cap);
                if (ratio > worstRatio) { worstRatio = ratio; worstReg = regId; }
            });
            regionVehiclesV[worstReg].push(vehiclePoolV.shift());
        }

        // Send one VROOM request per region
        const allRoutes = [];
        const regionEntries = Object.entries(regionChunks).filter(([_, items]) => items.length > 0);

        for (let ri = 0; ri < regionEntries.length; ri++) {
            const [regId, items] = regionEntries[ri];
            const regVehicles = regionVehiclesV[regId] || [];
            if (!regVehicles.length || !items.length) continue;

            const regName = _detectedRegions?.find(r => r.id === regId)?.name || regId;
            showProgress('VROOM: ' + regName + '...', 30 + (ri / regionEntries.length) * 50);

            const jobs = items.map((it, i) => ({
                id: i + 1, location: [it.stop.lng, it.stop.lat],
                service: serviceTime, amount: [it.stop.campers.length], description: it.stop.address
            }));

            const vroomVehicles = regVehicles.map((v, vi) => {
                const veh = { id: vi + 1, profile: 'driving-car', capacity: [v.capacity], description: v.name };
                if (isArrival) { veh.end = [campLng, campLat]; }
                else { veh.start = [campLng, campLat]; if (hasShifts) veh.end = [campLng, campLat]; }
                return veh;
            });

            try {
                console.log('[Go] VROOM request for ' + regName + ': ' + jobs.length + ' jobs, ' + vroomVehicles.length + ' vehicles');
                const resp = await fetch('https://api.openrouteservice.org/optimization', {
                    method: 'POST', headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobs, vehicles: vroomVehicles })
                });

                if (!resp.ok) {
                    const errText = await resp.text().catch(() => '');
                    console.error('[Go] VROOM error for ' + regName + ':', resp.status, errText);
                    allRoutes.push(...fallbackRegionRouting(items.map(it => it.stop), regVehicles, campLat, campLng));
                    continue;
                }

                const result = await resp.json();
                console.log('[Go] VROOM ' + regName + ': ' + (result.routes?.length || 0) + ' routes, ' + (result.unassigned?.length || 0) + ' unassigned');

                (result.routes || []).forEach(vroomRoute => {
                    const vehicleIdx = vroomRoute.vehicle - 1;
                    const v = regVehicles[vehicleIdx]; if (!v) return;
                    const routeStops = [];
                    vroomRoute.steps.forEach(step => {
                        if (step.type !== 'job') return;
                        const item = items[step.id - 1]; if (!item) return;
                        routeStops.push({ stopNum: routeStops.length + 1, campers: item.stop.campers, address: item.stop.address, lat: item.stop.lat, lng: item.stop.lng });
                    });
                    if (routeStops.length > 0) {
                        allRoutes.push({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: routeStops, camperCount: routeStops.reduce((s, st) => s + st.campers.length, 0), _cap: v.capacity, totalDuration: Math.round((vroomRoute.duration || 0) / 60) });
                    }
                });

                // Handle unassigned in this region
                if (result.unassigned?.length) {
                    result.unassigned.forEach(ua => {
                        const item = items[ua.id - 1]; if (!item) return;
                        let bestRoute = null, bestDist = Infinity;
                        allRoutes.forEach(r => { if (r.camperCount + item.stop.campers.length > r._cap) return; const last = r.stops[r.stops.length - 1]; if (last?.lat) { const d = haversineMi(last.lat, last.lng, item.stop.lat, item.stop.lng); if (d < bestDist) { bestDist = d; bestRoute = r; } } });
                        if (bestRoute) { bestRoute.stops.push({ stopNum: bestRoute.stops.length + 1, campers: item.stop.campers, address: item.stop.address, lat: item.stop.lat, lng: item.stop.lng }); bestRoute.camperCount += item.stop.campers.length; }
                    });
                }
            } catch (e) {
                console.error('[Go] VROOM failed for ' + regName + ':', e);
                allRoutes.push(...fallbackRegionRouting(items.map(it => it.stop), regVehicles, campLat, campLng));
            }

            // Rate limit between region requests
            if (ri < regionEntries.length - 1) await new Promise(r => setTimeout(r, 500));
        }

        // Ensure all buses have entries
        vehicles.forEach(v => { if (!allRoutes.find(r => r.busId === v.busId)) allRoutes.push({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: [], camperCount: 0, _cap: v.capacity, totalDuration: 0 }); });

        // ── OSRM /trip — optimal stop ordering on the road network ──
        // VROOM assigns stops to buses. Now OSRM /trip solves TSP per bus
        // on actual roads — no zigzags, no haversine guessing.
        //
        // Three modes:
        //   1. ARRIVAL: bus starts at farthest stop, picks up toward camp, ends at camp
        //      → source=first (farthest stop), destination=last (camp)
        //   2. DISMISSAL (no shifts): bus leaves camp, drops nearest first outward, doesn't return
        //      → source=first (camp), no destination constraint
        //   3. DISMISSAL (with shifts): same as #2 but returns to camp
        //      → source=first (camp), destination=last (camp)
        //
        showProgress('Optimizing stop order (OSRM)...', 80);

        for (let ri = 0; ri < allRoutes.length; ri++) {
            const r = allRoutes[ri];
            if (r.stops.length < 2) { r.stops.forEach((s, i) => { s.stopNum = i + 1; }); continue; }

            try {
                // Build coordinates: always include camp as anchor point
                const stopCoords = r.stops.map(s => s.lng + ',' + s.lat);
                const campCoord = campLng + ',' + campLat;
                let coords, campIdx, tripUrl;

                if (isArrival) {
                    // ARRIVAL: stops first, camp last
                    // Bus picks up from farthest, works toward camp
                    coords = [...stopCoords, campCoord];
                    campIdx = coords.length - 1;
                    tripUrl = 'https://router.project-osrm.org/trip/v1/driving/' + coords.join(';') +
                        '?roundtrip=false&destination=last&geometries=geojson';
                } else if (hasShifts) {
                    // DISMISSAL WITH SHIFTS: camp first, stops, camp last (round trip)
                    coords = [campCoord, ...stopCoords, campCoord];
                    tripUrl = 'https://router.project-osrm.org/trip/v1/driving/' + coords.join(';') +
                        '?roundtrip=false&source=first&destination=last&geometries=geojson';
                } else {
                    // DISMISSAL NO SHIFTS: camp first, stops, no return
                    coords = [campCoord, ...stopCoords];
                    tripUrl = 'https://router.project-osrm.org/trip/v1/driving/' + coords.join(';') +
                        '?roundtrip=false&source=first&geometries=geojson';
                }

                const resp = await fetch(tripUrl);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.code === 'Ok' && data.waypoints?.length) {
                        // Extract the ordering OSRM chose
                        // waypoints[i].waypoint_index = position in the optimal trip
                        const wpOrder = data.waypoints.map((wp, inputIdx) => ({
                            inputIdx,
                            tripPos: wp.waypoint_index
                        })).sort((a, b) => a.tripPos - b.tripPos);

                        // Filter out camp coordinate(s), keep only stop indices
                        const orderedStopIndices = [];
                        wpOrder.forEach(wp => {
                            if (isArrival) {
                                // Arrival: indices 0..N-1 are stops, N is camp
                                if (wp.inputIdx < r.stops.length) orderedStopIndices.push(wp.inputIdx);
                            } else if (hasShifts) {
                                // Dismissal+shifts: index 0 is camp, 1..N are stops, N+1 is camp
                                if (wp.inputIdx >= 1 && wp.inputIdx <= r.stops.length) orderedStopIndices.push(wp.inputIdx - 1);
                            } else {
                                // Dismissal no shifts: index 0 is camp, 1..N are stops
                                if (wp.inputIdx >= 1) orderedStopIndices.push(wp.inputIdx - 1);
                            }
                        });

                        if (orderedStopIndices.length === r.stops.length) {
                            const newStops = orderedStopIndices.map(i => r.stops[i]);
                            r.stops = newStops;
                            r.stops.forEach((s, i) => { s.stopNum = i + 1; });
                            console.log('[Go] OSRM trip: ' + r.busName + ' ✓ (' + r.stops.length + ' stops)');
                        } else {
                            console.warn('[Go] OSRM trip: ' + r.busName + ' — index mismatch (' + orderedStopIndices.length + ' vs ' + r.stops.length + '), using fallback sort');
                            sortStopsFallback(r, campLat, campLng, isArrival);
                        }
                    } else {
                        console.warn('[Go] OSRM trip: ' + r.busName + ' — bad response, using fallback sort');
                        sortStopsFallback(r, campLat, campLng, isArrival);
                    }
                } else {
                    console.warn('[Go] OSRM trip: ' + r.busName + ' — HTTP ' + resp.status + ', using fallback sort');
                    sortStopsFallback(r, campLat, campLng, isArrival);
                }
            } catch (e) {
                console.warn('[Go] OSRM trip error for ' + r.busName + ':', e.message);
                sortStopsFallback(r, campLat, campLng, isArrival);
            }

            // Small delay between OSRM calls to be polite to public server
            if (ri < allRoutes.length - 1) await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log('[Go] VROOM + OSRM complete:');
        allRoutes.forEach(r => console.log('[Go]   ' + r.busName + ': ' + r.stops.length + ' stops, ' + r.camperCount + ' campers'));
        return allRoutes;
    }

    /** Fallback stop sorting when OSRM /trip is unavailable */
    function sortStopsFallback(route, campLat, campLng, isArrival) {
        // Simple nearest-neighbor from camp (dismissal) or from farthest (arrival)
        route.stops.forEach(s => { s._dist = haversineMi(campLat, campLng, s.lat, s.lng); });

        const sorted = [];
        const remaining = [...route.stops];

        if (isArrival) {
            // Arrival: start at farthest, work toward camp
            remaining.sort((a, b) => b._dist - a._dist);
        } else {
            // Dismissal: start at nearest to camp (first drop-off), work outward
            remaining.sort((a, b) => a._dist - b._dist);
        }
        sorted.push(remaining.shift());

        // Nearest-neighbor from current position
        while (remaining.length) {
            const last = sorted[sorted.length - 1];
            let bestIdx = 0, bestDist = Infinity;
            remaining.forEach((s, i) => {
                const d = haversineMi(last.lat, last.lng, s.lat, s.lng);
                if (d < bestDist) { bestDist = d; bestIdx = i; }
            });
            sorted.push(remaining.splice(bestIdx, 1)[0]);
        }

        route.stops = sorted;
        route.stops.forEach((s, i) => { s.stopNum = i + 1; delete s._dist; });
    }

    // =========================================================================
    // FALLBACK ROUTING (if VROOM fails — simple geographic clustering)
    // =========================================================================
    function fallbackRouting(stops, vehicles, campLat, campLng) {
        console.warn('[Go] Using fallback geographic routing');
        const numBuses = vehicles.length;
        stops.forEach(s => { s._angle = Math.atan2(s.lng - campLng, s.lat - campLat); });
        stops.sort((a, b) => a._angle - b._angle);
        const routes = [];
        const perBus = Math.ceil(stops.length / numBuses);
        for (let i = 0; i < numBuses; i++) {
            const v = vehicles[i];
            const busStops = stops.slice(i * perBus, (i + 1) * perBus);
            busStops.sort((a, b) => haversineMi(b.lat, b.lng, campLat, campLng) - haversineMi(a.lat, a.lng, campLat, campLng));
            busStops.forEach((s, si) => { s.stopNum = si + 1; delete s._angle; });
            routes.push({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: busStops, camperCount: busStops.reduce((s, st) => s + st.campers.length, 0), _cap: v.capacity, totalDuration: 0 });
        }
        return routes;
    }

    function fallbackRegionRouting(stops, vehicles, campLat, campLng) {
        const routes = [];
        const perBus = Math.ceil(stops.length / vehicles.length);
        stops.sort((a, b) => haversineMi(b.lat, b.lng, campLat, campLng) - haversineMi(a.lat, a.lng, campLat, campLng));
        for (let i = 0; i < vehicles.length; i++) {
            const v = vehicles[i];
            const busStops = stops.slice(i * perBus, (i + 1) * perBus);
            busStops.forEach((s, si) => { s.stopNum = si + 1; });
            routes.push({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: busStops, camperCount: busStops.reduce((s, st) => s + st.campers.length, 0), _cap: v.capacity, totalDuration: 0 });
        }
        return routes;
    }

    // =========================================================================
    // STOP CREATION
    // =========================================================================
    function createHouseStops(campers) {
        const camperMap = {}; campers.forEach(c => { camperMap[c.name] = c; });
        campers.forEach(c => { const a = D.addresses[c.name]; if (a?.rideWith) { const partner = camperMap[a.rideWith]; if (partner) { c.lat = partner.lat; c.lng = partner.lng; c.address = partner.address; } } });
        const groups = {};
        campers.forEach(c => { const key = Math.round(c.lat * 3000) + ',' + Math.round(c.lng * 3000); if (!groups[key]) groups[key] = []; groups[key].push(c); });
        return Object.values(groups).map(g => ({ lat: g[0].lat, lng: g[0].lng, address: g[0].address, campers: g.map(c => ({ name: c.name, division: c.division, bunk: c.bunk })) }));
    }

    function createOptimizedStops(campers) {
        const maxWalkMi = (D.setup.maxWalkDistance || 500) * 0.000189394;
        const used = new Set(); const stops = []; const sorted = [...campers].sort((a, b) => a.lat - b.lat);
        sorted.forEach(c => { if (used.has(c.name)) return; const cl = [c]; used.add(c.name); sorted.forEach(o => { if (!used.has(o.name) && haversineMi(c.lat, c.lng, o.lat, o.lng) <= maxWalkMi) { cl.push(o); used.add(o.name); } }); const cLat = cl.reduce((s, x) => s + x.lat, 0) / cl.length; const cLng = cl.reduce((s, x) => s + x.lng, 0) / cl.length; let nearestAddr = cl[0].address, nearestDist = Infinity; cl.forEach(x => { const dd = haversineMi(cLat, cLng, x.lat, x.lng); if (dd < nearestDist) { nearestDist = dd; nearestAddr = x.address; } }); stops.push({ lat: cLat, lng: cLng, address: nearestAddr, campers: cl.map(x => ({ name: x.name, division: x.division, bunk: x.bunk })) }); });
        return stops;
    }

    function createCornerStops(campers) {
        const walkFt = D.setup.maxWalkDistance || 500;
        const walkMi = walkFt * 0.000189394;
        const gridLat = walkMi / 69.17;
        const gridLng = walkMi / 53;
        const groups = {};
        campers.forEach(c => { const snapLat = Math.round(c.lat / gridLat) * gridLat; const snapLng = Math.round(c.lng / gridLng) * gridLng; const key = snapLat.toFixed(6) + ',' + snapLng.toFixed(6); if (!groups[key]) groups[key] = { lat: snapLat, lng: snapLng, campers: [], streets: {} }; groups[key].campers.push(c); const street = extractStreetName(c.address); if (street) groups[key].streets[street] = (groups[key].streets[street] || 0) + 1; });
        return Object.values(groups).map(g => { const sn = Object.keys(g.streets).sort((a, b) => g.streets[b] - g.streets[a]); let cornerName; if (sn.length >= 2) cornerName = 'Corner of ' + sn[0] + ' & ' + sn[1]; else if (sn.length === 1) cornerName = sn[0] + ' (corner stop)'; else cornerName = 'Corner stop'; return { lat: g.lat, lng: g.lng, address: cornerName, campers: g.campers.map(c => ({ name: c.name, division: c.division, bunk: c.bunk })) }; });
    }

    function extractStreetName(address) { if (!address) return ''; const firstPart = address.split(',')[0].trim(); return firstPart.replace(/^\d+\s*[-/]?\s*\d*\s+/, '').trim(); }

    function showProgress(label, pct) { const c = document.getElementById('routeProgressCard'); c.style.display = ''; document.getElementById('routeProgressLabel').textContent = label; document.getElementById('routeProgressPct').textContent = Math.round(pct) + '%'; document.getElementById('routeProgressBar').style.width = pct + '%'; }
    function hideProgress() { document.getElementById('routeProgressCard').style.display = 'none'; }

    // =========================================================================
    // RENDER ROUTE RESULTS (same as v2)
    // =========================================================================
    function renderRouteResults(allShifts) {
        document.getElementById('routeResults').style.display = '';
        const btnLabel = document.getElementById('generateBtnLabel');
        if (btnLabel) btnLabel.textContent = 'Regenerate Routes';

        const assignEl = document.getElementById('busAssignmentTable');
        if (assignEl && _busAssignments && _detectedRegions) {
            let ah = '<div style="font-size:.8125rem;color:var(--text-muted);margin-bottom:.5rem">Buses stay in the same region across shifts.</div>';
            ah += '<div class="table-wrapper"><table class="data-table"><thead><tr><th>Bus</th>';
            D.shifts.forEach(sh => { ah += '<th>' + esc(sh.label || 'Shift') + '</th>'; });
            ah += '</tr></thead><tbody>';
            D.buses.forEach(b => {
                ah += '<tr><td style="font-weight:600"><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(b.color) + '"></span>' + esc(b.name) + '</span></td>';
                let prevRegion = null;
                D.shifts.forEach(sh => { const regionId = Object.keys(_busAssignments[sh.id] || {}).find(rid => (_busAssignments[sh.id][rid] || []).includes(b.id)); const reg = _detectedRegions.find(r => r.id === regionId); const changed = prevRegion && regionId !== prevRegion; ah += '<td style="' + (changed ? 'background:var(--amber-50);font-weight:700;color:var(--amber-700)' : '') + '">' + (reg ? '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:' + esc(reg.color) + '"></span>' + esc(reg.name) + '</span>' : '—') + (changed ? ' ⚡' : '') + '</td>'; prevRegion = regionId; });
                ah += '</tr>';
            });
            ah += '</tbody></table></div>'; assignEl.innerHTML = ah;
        }

        const container = document.getElementById('shiftResultsContainer');
        let html = '';
        allShifts.forEach((sr, si) => {
            const { shift, routes } = sr;
            const totalCampers = routes.reduce((s, r) => s + r.camperCount, 0);
            const totalStops = routes.reduce((s, r) => s + r.stops.filter(st => !st.isMonitor && !st.isCounselor).length, 0);
            const longest = routes.length ? Math.max(...routes.map(r => r.totalDuration), 0) : 0;
            html += '<details class="collapsible-card" open><summary class="collapsible-header"><span style="display:flex;align-items:center;gap:.5rem;"><span class="shift-num">' + (si + 1) + '</span>' + esc(shift.label || 'Shift ' + (si + 1)) + '</span><span style="font-size:.75rem;font-weight:400;color:var(--text-muted);">' + totalCampers + ' campers · ' + totalStops + ' stops · ' + longest + ' min</span></summary>';
            html += '<div class="collapsible-body" style="padding:.75rem;"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem;">';
            routes.filter(r => r.stops.length > 0).forEach(r => {
                html += '<div class="route-card"><div class="route-card-header" style="background:' + esc(r.busColor) + '"><div><h3>' + esc(r.busName) + '</h3><div class="route-meta">' + r.camperCount + ' campers · ' + r.stops.length + ' stops</div></div><div style="text-align:right"><div style="font-size:1.25rem;font-weight:700">' + r.totalDuration + ' min</div></div></div><ul class="route-stop-list">';
                r.stops.forEach(st => {
                    const names = st.isMonitor ? '🛡️ ' + esc(st.monitorName) : st.isCounselor ? '👤 ' + esc(st.counselorName) : st.campers.map(c => '<span style="display:inline-flex;align-items:center;gap:2px;">' + esc(c.name) + ' <button onclick="CampistryGo.openMoveModal(\'' + esc(c.name.replace(/'/g, "\\'")) + '\',\'' + r.busId + '\',' + si + ')" style="background:none;border:none;cursor:pointer;padding:0 2px;color:var(--text-muted);font-size:10px;" title="Move">↔</button></span>').join(', ');
                    html += '<li class="route-stop' + (st.isMonitor ? ' monitor-stop' : st.isCounselor ? ' counselor-stop' : '') + '"><div class="route-stop-num" style="background:' + esc(r.busColor) + '">' + st.stopNum + '</div><div class="route-stop-info"><div class="route-stop-names">' + names + '</div><div class="route-stop-addr">' + esc(st.address) + '</div></div><div class="route-stop-time">' + (st.estimatedTime || '—') + '</div></li>';
                });
                html += '</ul><div class="route-card-footer"><span>' + (r.monitor ? '🛡️ ' + esc(r.monitor.name) : '') + '</span><span>' + (r.counselors.length ? r.counselors.length + ' counselor(s)' : '') + '</span></div></div>';
            });
            html += '</div></div></details>';
        });
        container.innerHTML = html;
        renderMasterList(allShifts);
        const routesTab = document.getElementById('tab-routes');
        if (routesTab && routesTab.classList.contains('active')) setTimeout(() => initMap(allShifts), 100);
        else _pendingMapInit = allShifts;
        renderCapacityWarnings();
        renderCarpool();
    }

    function renderMasterList(allShifts) {
        _allMasterRows = [];
        allShifts.forEach((sr, si) => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); _allMasterRows.push({ firstName: p[0] || '', lastName: p.slice(1).join(' ') || '', shift: sr.shift.label || '', shiftIdx: si, busName: r.busName, busId: r.busId, busColor: r.busColor, stopNum: st.stopNum, address: st.address, time: st.estimatedTime || '—' }); }); }); }); });
        _allMasterRows.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
        renderFilteredMasterList();
    }

    let _allMasterRows = [];
    let _masterSort = { col: 'lastName', dir: 'asc' };
    function sortMasterBy(col) { if (_masterSort.col === col) _masterSort.dir = _masterSort.dir === 'asc' ? 'desc' : 'asc'; else { _masterSort.col = col; _masterSort.dir = 'asc'; } renderFilteredMasterList(); }
    function renderFilteredMasterList() {
        let rows = [..._allMasterRows];
        if (_activeShifts && _activeShifts.size < (_generatedRoutes?.length || 0)) rows = rows.filter(r => _activeShifts.has(r.shiftIdx));
        if (_activeMapBus && _activeMapBus !== 'all') rows = rows.filter(r => r.busId === _activeMapBus);
        const dir = _masterSort.dir === 'asc' ? 1 : -1; const col = _masterSort.col;
        rows.sort((a, b) => { const av = col === 'stopNum' ? a[col] : String(a[col] || '').toLowerCase(); const bv = col === 'stopNum' ? b[col] : String(b[col] || '').toLowerCase(); if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0; });
        const countEl = document.getElementById('masterListCount'); const label = document.getElementById('masterListLabel');
        const modeLabel = D.activeMode === 'arrival' ? 'Pickup' : 'Drop-off';
        if (countEl) countEl.textContent = rows.length + (rows.length < _allMasterRows.length ? ' of ' + _allMasterRows.length : '');
        if (label) label.textContent = rows.length < _allMasterRows.length ? 'Master ' + modeLabel + ' List (filtered)' : 'Master ' + modeLabel + ' List';
        function arrow(c) { return _masterSort.col === c ? (_masterSort.dir === 'asc' ? ' ▲' : ' ▼') : ''; }
        const thead = document.getElementById('masterListHead');
        if (thead) thead.innerHTML = '<tr><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'firstName\')">First' + arrow('firstName') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'lastName\')">Last' + arrow('lastName') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'shift\')">Shift' + arrow('shift') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'busName\')">Bus' + arrow('busName') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'stopNum\')">Stop' + arrow('stopNum') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'address\')">Address' + arrow('address') + '</th><th style="cursor:pointer" onclick="CampistryGo.sortMasterBy(\'time\')">Time' + arrow('time') + '</th></tr>';
        document.getElementById('masterListBody').innerHTML = rows.map(r => '<tr><td style="font-weight:600">' + esc(r.firstName) + '</td><td style="font-weight:600">' + esc(r.lastName) + '</td><td>' + esc(r.shift) + '</td><td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(r.busColor) + '"></span>' + esc(r.busName) + '</span></td><td style="font-weight:700;text-align:center">' + r.stopNum + '</td><td>' + esc(r.address) + '</td><td style="font-weight:600">' + r.time + '</td></tr>').join('');
    }

    // =========================================================================
    // ROUTE MAP (Leaflet)
    // =========================================================================
    let _map = null;
    let _mapLayers = [];
    let _activeShifts = new Set();
    let _activeMapBus = 'all';
    let _pendingMapInit = null;
    let _routeGeomCache = {};
    window._routeGeomCache = _routeGeomCache;

    function addArrowsToLine(coords, color, map) {
        if (!coords || coords.length < 4) return [];
        const markers = []; let totalDist = 0;
        for (let i = 0; i < coords.length - 1; i++) totalDist += haversineMi(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
        if (totalDist < 0.2) return [];
        const numArrows = Math.max(2, Math.min(12, Math.floor(totalDist / 0.4)));
        const interval = totalDist / (numArrows + 1);
        let accDist = 0, arrowIdx = 1;
        for (let i = 0; i < coords.length - 1 && arrowIdx <= numArrows; i++) {
            const segDist = haversineMi(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
            while (accDist + segDist >= interval * arrowIdx && arrowIdx <= numArrows) {
                const frac = (interval * arrowIdx - accDist) / segDist;
                const lat = coords[i][0] + frac * (coords[i + 1][0] - coords[i][0]);
                const lng = coords[i][1] + frac * (coords[i + 1][1] - coords[i][1]);
                const dLng = (coords[i + 1][1] - coords[i][1]) * Math.PI / 180;
                const lat1 = coords[i][0] * Math.PI / 180, lat2 = coords[i + 1][0] * Math.PI / 180;
                const y = Math.sin(dLng) * Math.cos(lat2);
                const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
                const bearing = Math.atan2(y, x) * 180 / Math.PI;
                const icon = L.divIcon({ html: '<div style="font-size:11px;font-weight:900;color:' + color + ';transform:rotate(' + bearing + 'deg);opacity:0.85;text-shadow:-1px 0 0 #fff,1px 0 0 #fff;">›</div>', className: '', iconSize: [10, 10], iconAnchor: [5, 5] });
                const m = L.marker([lat, lng], { icon, interactive: false }).addTo(map);
                markers.push(m); arrowIdx++;
            }
            accDist += segDist;
        }
        return markers;
    }

    function initMap(allShifts) {
        _activeShifts = new Set(allShifts.map((_, i) => i));
        _activeMapBus = 'all';
        const container = document.getElementById('routeMap');
        if (_map) { _map.remove(); _map = null; }
        _map = L.map(container, { scrollWheelZoom: true, zoomControl: true });
        const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM', maxZoom: 19 });
        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: '&copy; Esri', maxZoom: 19 });
        streetLayer.addTo(_map);
        L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }, null, { position: 'topright', collapsed: true }).addTo(_map);
        renderMap();
    }

    async function renderMap() {
        if (!_map || !_generatedRoutes) return;
        const shiftIndices = [..._activeShifts].sort();
        const multiShift = shiftIndices.length > 1;
        const totalShifts = _generatedRoutes.length;

        const shiftBar = document.getElementById('mapShiftSelect');
        if (shiftBar) {
            shiftBar.innerHTML = '<button class="bus-tab all-tab' + (shiftIndices.length === totalShifts ? ' active' : '') + '" onclick="CampistryGo.setMapShiftsAll()">All Shifts</button>' +
                _generatedRoutes.map((sr, i) => '<button class="bus-tab' + (_activeShifts.has(i) ? ' active' : '') + '" onclick="CampistryGo.toggleMapShift(' + i + ')"><span class="shift-num" style="width:20px;height:20px;font-size:.65rem;">' + (i + 1) + '</span>' + esc(sr.shift.label || 'Shift ' + (i + 1)) + '</button>').join('');
        }

        const allRoutes = [];
        shiftIndices.forEach(si => { const sr = _generatedRoutes[si]; if (!sr) return; sr.routes.filter(r => r.stops.length > 0).forEach(r => { allRoutes.push({ ...r, shiftIdx: si, shiftLabel: sr.shift.label || 'Shift ' + (si + 1) }); }); });

        const tabsEl = document.getElementById('mapBusTabs');
        const uniqueBuses = []; const seen = new Set();
        allRoutes.forEach(r => { if (!seen.has(r.busId)) { seen.add(r.busId); uniqueBuses.push({ busId: r.busId, busName: r.busName, busColor: r.busColor }); } });
        tabsEl.innerHTML = '<button class="bus-tab all-tab' + (_activeMapBus === 'all' ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'all\')">All Buses</button>' +
            uniqueBuses.map(b => '<button class="bus-tab' + (_activeMapBus === b.busId ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'' + b.busId + '\')"><span class="bus-tab-dot" style="background:' + esc(b.busColor) + '"></span>' + esc(b.busName) + '</button>').join('');

        _mapLayers.forEach(l => _map.removeLayer(l)); _mapLayers = [];
        const allLatLngs = [];

        if (_campCoordsCache) {
            const campIcon = L.divIcon({ html: '<div style="width:32px;height:32px;background:#1e293b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.4);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>', className: '', iconSize: [32, 32], iconAnchor: [16, 16] });
            const campMarker = L.marker([_campCoordsCache.lat, _campCoordsCache.lng], { icon: campIcon, zIndexOffset: 1000 }).addTo(_map);
            campMarker.bindPopup('<strong>' + esc(D.setup.campName || 'Camp') + '</strong><br>' + esc(D.setup.campAddress));
            _mapLayers.push(campMarker); allLatLngs.push([_campCoordsCache.lat, _campCoordsCache.lng]);
        }

        const visibleRoutes = _activeMapBus === 'all' ? allRoutes : allRoutes.filter(r => r.busId === _activeMapBus);
        function getDash(shiftIdx) { if (totalShifts <= 1 || !multiShift) return null; if (shiftIdx === 0) return null; if (shiftIdx === 1) return '18, 12'; return '6, 10'; }

        for (const route of visibleRoutes) {
            const stopsWithCoords = route.stops.filter(s => s.lat && s.lng);
            if (!stopsWithCoords.length) continue;
            const isArrival = D.activeMode === 'arrival';
            const needsReturn = !isArrival && D.shifts.length > 1;
            const straightCoords = [];
            if (!isArrival && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            stopsWithCoords.forEach(s => straightCoords.push([s.lat, s.lng]));
            if (isArrival && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            if (needsReturn && _campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            allLatLngs.push(...straightCoords);

            const dashPattern = getDash(route.shiftIdx);
            const lineWeight = _activeMapBus === 'all' ? 3 : 5;
            const lineOpacity = _activeMapBus === 'all' ? 0.7 : 0.9;
            const cacheKey = route.busId + '_' + route.shiftIdx;
            let roadCoords = _routeGeomCache[cacheKey];

            if (roadCoords) {
                const polyline = L.polyline(roadCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity, dashArray: dashPattern }).addTo(_map);
                polyline._goRouteKey = cacheKey; _mapLayers.push(polyline);
                const arrows = addArrowsToLine(roadCoords, route.busColor, _map);
                arrows.forEach(a => { a._goRouteKey = cacheKey; _mapLayers.push(a); });
            } else {
                const tempLine = L.polyline(straightCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity * 0.4, dashArray: dashPattern }).addTo(_map);
                tempLine._goRouteKey = cacheKey; _mapLayers.push(tempLine);

                if (straightCoords.length >= 2) {
                    const mbToken = D.setup.mapboxToken || '';
                    const wp = [];
                    if (!isArrival && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    stopsWithCoords.forEach(s => wp.push(s.lng + ',' + s.lat));
                    if (isArrival && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    if (needsReturn && _campCoordsCache) wp.push(_campCoordsCache.lng + ',' + _campCoordsCache.lat);
                    (async function(coordStr, color, ck, temp, dash, w, o) {
                        try {
                            const url = mbToken ? 'https://api.mapbox.com/directions/v5/mapbox/driving/' + coordStr + '?overview=full&geometries=geojson&access_token=' + mbToken : 'https://router.project-osrm.org/route/v1/driving/' + coordStr + '?overview=full&geometries=geojson&continue_straight=true';
                            const resp = await fetch(url); if (resp.ok) { const data = await resp.json(); const coords = data.routes?.[0]?.geometry?.coordinates; if (coords) { const pts = coords.map(c => [c[1], c[0]]); if (pts.length > 0 && _map) { _routeGeomCache[ck] = pts; _map.removeLayer(temp); const idx = _mapLayers.indexOf(temp); if (idx >= 0) _mapLayers.splice(idx, 1); const road = L.polyline(pts, { color, weight: w, opacity: o, dashArray: dash }).addTo(_map); road._goRouteKey = ck; _mapLayers.push(road); const arrows = addArrowsToLine(pts, color, _map); arrows.forEach(a => { a._goRouteKey = ck; _mapLayers.push(a); }); } } }
                        } catch (e) { console.warn('[Go] Road geometry failed:', e.message); }
                    })(wp.join(';'), route.busColor, cacheKey, tempLine, dashPattern, lineWeight, lineOpacity);
                }
            }

            // Stop markers
            stopsWithCoords.forEach(stop => {
                const isSpecial = stop.isMonitor || stop.isCounselor;
                const size = isSpecial ? 20 : 26;
                const icon = L.divIcon({ html: '<div class="stop-marker-icon" style="width:' + size + 'px;height:' + size + 'px;background:' + esc(route.busColor) + ';' + (isSpecial ? 'font-size:10px;' : '') + '">' + (isSpecial ? (stop.isMonitor ? 'M' : 'C') : stop.stopNum) + '</div>', className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
                const names = stop.isMonitor ? '🛡️ ' + (stop.monitorName || 'Monitor') : stop.isCounselor ? '👤 ' + (stop.counselorName || 'Counselor') : stop.campers.map(c => c.name).join('<br>');
                const popup = '<div style="font-family:DM Sans,sans-serif;min-width:160px;"><div style="font-weight:700;color:' + route.busColor + '">' + esc(route.busName) + ' — ' + esc(route.shiftLabel) + '</div><div style="font-weight:600;">Stop ' + stop.stopNum + '</div><div style="font-size:12px;">' + names + '</div><div style="font-size:11px;color:#888;">' + esc(stop.address) + '</div>' + (stop.estimatedTime ? '<div style="font-weight:600;">Est: ' + stop.estimatedTime + '</div>' : '') + '</div>';
                const marker = L.marker([stop.lat, stop.lng], { icon, draggable: !isSpecial }).addTo(_map);
                marker.bindPopup(popup);
                (function(theStop, theBusId, theShiftIdx) { marker.on('click', function(e) { if (window._mapEditorStopClick && window._mapEditorStopClick(theStop, theBusId, theShiftIdx)) marker.closePopup(); }); })(stop, route.busId, route.shiftIdx);
                _mapLayers.push(marker);
            });
        }

        if (allLatLngs.length > 0) _map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50], maxZoom: 14 });

        const legendEl = document.getElementById('mapLegend');
        if (legendEl) {
            if (multiShift) { legendEl.innerHTML = shiftIndices.map(si => { const sr = _generatedRoutes[si]; const d = getDash(si); const svgLine = !d ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3"/>' : d.startsWith('18') ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="9,6"/>' : '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="3,5"/>'; return '<span style="display:inline-flex;align-items:center;gap:.375rem;font-size:.75rem;"><svg width="40" height="12">' + svgLine + '</svg>' + esc(sr.shift.label || 'Shift ' + (si + 1)) + '</span>'; }).join('<span style="margin:0 .5rem;color:var(--border-medium);">|</span>'); legendEl.style.display = ''; }
            else legendEl.style.display = 'none';
        }
    }

    function selectMapBus(busId) { _activeMapBus = busId; renderMap(); renderFilteredMasterList(); }
    function toggleMapShift(idx) { if (_activeShifts.has(idx)) { if (_activeShifts.size > 1) _activeShifts.delete(idx); } else _activeShifts.add(idx); renderMap(); renderFilteredMasterList(); }
    function setMapShiftsAll() { _activeShifts = new Set(_generatedRoutes.map((_, i) => i)); renderMap(); renderFilteredMasterList(); }
    function toggleMapFullscreen() { const card = document.getElementById('routeMapCard'); if (!card) return; card.classList.toggle('map-fullscreen'); setTimeout(() => { if (_map) _map.invalidateSize(); }, 100); }

    // =========================================================================
    // DAILY OVERRIDES
    // =========================================================================
    function getTodayKey() { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function getOverrides() { const key = getTodayKey(); if (!D.dailyOverrides[key]) D.dailyOverrides[key] = {}; return D.dailyOverrides[key]; }
    function addOverride(camperName, type, details) { const ov = getOverrides(); ov[camperName] = { type, ...details, timestamp: Date.now() }; save(); if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes)); renderDailyOverrides(); toast('Override added for ' + camperName); }
    function removeOverride(camperName) { const ov = getOverrides(); delete ov[camperName]; save(); if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes)); renderDailyOverrides(); toast('Override removed'); }

    function applyOverrides(routes) {
        if (!routes) return routes;
        const ov = getOverrides(); if (!Object.keys(ov).length) return routes;
        const clone = JSON.parse(JSON.stringify(routes));
        Object.entries(ov).forEach(([camperName, override]) => {
            if (override.type === 'not-riding') {
                clone.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { st.campers = st.campers.filter(c => c.name !== camperName); }); r.stops = r.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor); r.stops.forEach((st, i) => { st.stopNum = i + 1; }); r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0); }); });
            }
            if (override.type === 'ride-with') {
                const targetName = override.targetCamper;
                let targetBusId = null, targetShiftIdx = null, targetStopIdx = null;
                clone.forEach((sr, si) => { sr.routes.forEach(r => { r.stops.forEach((st, sti) => { if (st.campers.some(c => c.name === targetName)) { targetBusId = r.busId; targetShiftIdx = si; targetStopIdx = sti; } }); }); });
                if (targetBusId !== null) {
                    clone.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { st.campers = st.campers.filter(c => c.name !== camperName); }); r.stops = r.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor); }); });
                    const targetRoute = clone[targetShiftIdx]?.routes.find(r => r.busId === targetBusId);
                    if (targetRoute?.stops[targetStopIdx]) { const roster = getRoster(); const camper = roster[camperName] || {}; targetRoute.stops[targetStopIdx].campers.push({ name: camperName, division: camper.division || '', bunk: camper.bunk || '' }); }
                    clone.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach((st, i) => { st.stopNum = i + 1; }); r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0); }); });
                }
            }
            if (override.type === 'add-rider') {
                const addr = D.addresses[camperName]; if (!addr?.geocoded) return;
                const roster = getRoster(); const camper = roster[camperName] || {};
                clone.forEach(sr => { const divSet = new Set(sr.shift.divisions || []); if (!divSet.has(camper.division)) return; let bestRoute = null, bestStopIdx = -1, bestDist = Infinity; sr.routes.forEach(r => { r.stops.forEach((st, sti) => { if (!st.lat || !st.lng) return; const d = haversineMi(addr.lat, addr.lng, st.lat, st.lng); if (d < bestDist) { bestDist = d; bestRoute = r; bestStopIdx = sti; } }); }); if (bestRoute && bestStopIdx >= 0) { if (bestDist <= 0.3) bestRoute.stops[bestStopIdx].campers.push({ name: camperName, division: camper.division || '', bunk: camper.bunk || '' }); else bestRoute.stops.push({ stopNum: bestRoute.stops.length + 1, campers: [{ name: camperName, division: camper.division || '', bunk: camper.bunk || '' }], address: [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', '), lat: addr.lat, lng: addr.lng }); bestRoute.camperCount = bestRoute.stops.reduce((s, st) => s + st.campers.length, 0); } });
            }
        });
        return clone;
    }

    function renderDailyOverrides() {
        const container = document.getElementById('dailyOverridesBody'); if (!container) return;
        const ov = getOverrides(); const entries = Object.entries(ov);
        if (!entries.length) { container.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);">No overrides for today.</div>'; return; }
        container.innerHTML = entries.map(([name, ov]) => { let desc = '', badgeCls = 'badge-neutral'; if (ov.type === 'not-riding') { desc = 'Not riding'; badgeCls = 'badge-danger'; } else if (ov.type === 'ride-with') { desc = 'With ' + esc(ov.targetCamper); badgeCls = 'badge-warning'; } else if (ov.type === 'add-rider') { desc = 'Added to bus'; badgeCls = 'badge-success'; } return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;"><div><strong>' + esc(name) + '</strong> — <span class="badge ' + badgeCls + '">' + desc + '</span></div><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.removeOverride(\'' + esc(name.replace(/'/g, "\\'")) + '\')">Remove</button></div>'; }).join('');
    }

    function openOverrideModal() { const roster = getRoster(); const names = Object.keys(roster).sort(); const sel = document.getElementById('overrideCamper'); sel.innerHTML = '<option value="">— Select —</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join(''); document.getElementById('overrideSearch').value = ''; document.getElementById('overrideType').value = 'not-riding'; document.getElementById('overrideRideWithGroup').style.display = 'none'; openModal('overrideModal'); }
    function filterOverrideSelect(inputId, selectId) { const q = (document.getElementById(inputId)?.value || '').toLowerCase().trim(); const sel = document.getElementById(selectId); const roster = getRoster(); const names = Object.keys(roster).sort(); const filtered = q ? names.filter(n => n.toLowerCase().includes(q)) : names; sel.innerHTML = '<option value="">— Select —</option>' + filtered.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join(''); if (filtered.length === 1) sel.value = filtered[0]; }
    function onOverrideTypeChange() { const type = document.getElementById('overrideType')?.value; document.getElementById('overrideRideWithGroup').style.display = type === 'ride-with' ? '' : 'none'; if (type === 'ride-with') { document.getElementById('overrideTargetSearch').value = ''; filterOverrideSelect('overrideTargetSearch', 'overrideTarget'); } }
    function saveOverride() { const camper = document.getElementById('overrideCamper')?.value; const type = document.getElementById('overrideType')?.value; if (!camper) { toast('Select a camper', 'error'); return; } if (type === 'ride-with') { const target = document.getElementById('overrideTarget')?.value; if (!target) { toast('Select target', 'error'); return; } addOverride(camper, 'ride-with', { targetCamper: target }); } else if (type === 'add-rider') { if (!D.addresses[camper]?.geocoded) { toast('Need geocoded address', 'error'); return; } addOverride(camper, 'add-rider', {}); } else addOverride(camper, 'not-riding', {}); closeModal('overrideModal'); }

    // =========================================================================
    // CAMPER SEARCH + MOVE
    // =========================================================================
    function searchCamperInRoutes(query) {
        if (!_generatedRoutes || !query) return;
        const q = query.toLowerCase().trim(); if (!q) { if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes)); return; }
        const results = []; const applied = applyOverrides(_generatedRoutes);
        applied.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { st.campers.forEach(c => { if (c.name.toLowerCase().includes(q)) results.push({ name: c.name, shift: sr.shift.label || '', busName: r.busName, busColor: r.busColor, busId: r.busId, stopNum: st.stopNum, address: st.address, time: st.estimatedTime || '—', lat: st.lat, lng: st.lng, shiftIdx: _generatedRoutes.indexOf(sr) }); }); }); }); });
        const container = document.getElementById('camperSearchResults'); if (!container) return;
        if (!results.length) { container.innerHTML = '<div style="padding:.75rem;color:var(--text-muted);">No match for "' + esc(query) + '"</div>'; container.style.display = ''; return; }
        container.innerHTML = results.map(r => '<div style="display:flex;align-items:center;gap:.75rem;padding:.625rem .75rem;border-bottom:1px solid var(--border-light);font-size:.8125rem;cursor:pointer;" onclick="CampistryGo.zoomToStop(' + (r.lat||0) + ',' + (r.lng||0) + ',\'' + esc(r.busId) + '\',' + r.shiftIdx + ')"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(r.busColor) + ';display:inline-block;"></span><strong>' + esc(r.name) + '</strong><span style="color:var(--text-muted)">' + esc(r.shift) + ' · ' + esc(r.busName) + ' · Stop ' + r.stopNum + '</span><span style="margin-left:auto;font-weight:600;">' + r.time + '</span></div>').join('');
        container.style.display = '';
    }
    function zoomToStop(lat, lng, busId, shiftIdx) { if (!_map || !lat || !lng) return; _activeShifts = new Set([shiftIdx]); _activeMapBus = busId; renderMap(); _map.setView([lat, lng], 16); const sr = document.getElementById('camperSearchResults'); if (sr) sr.style.display = 'none'; }

    function moveCamperToBus(camperName, fromBusId, toBusId, shiftIdx) {
        if (!_generatedRoutes || !D.savedRoutes) return;
        const sr = D.savedRoutes[shiftIdx]; if (!sr) return;
        let camperData = null, camperStop = null;
        const fromRoute = sr.routes.find(r => r.busId === fromBusId);
        if (fromRoute) { for (const st of fromRoute.stops) { const ci = st.campers.findIndex(c => c.name === camperName); if (ci >= 0) { camperData = st.campers.splice(ci, 1)[0]; camperStop = st; break; } } fromRoute.stops = fromRoute.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor); fromRoute.stops.forEach((st, i) => { st.stopNum = i + 1; }); fromRoute.camperCount = fromRoute.stops.reduce((s, st) => s + st.campers.length, 0); }
        if (!camperData || !camperStop) { toast('Camper not found', 'error'); return; }
        const toRoute = sr.routes.find(r => r.busId === toBusId); if (!toRoute) { toast('Bus not found', 'error'); return; }
        let added = false;
        if (camperStop.lat && camperStop.lng) { for (const st of toRoute.stops) { if (st.lat && st.lng && haversineMi(camperStop.lat, camperStop.lng, st.lat, st.lng) < 0.3) { st.campers.push(camperData); added = true; break; } } }
        if (!added) toRoute.stops.push({ stopNum: toRoute.stops.length + 1, campers: [camperData], address: camperStop.address, lat: camperStop.lat, lng: camperStop.lng, estimatedTime: camperStop.estimatedTime });
        toRoute.stops.forEach((st, i) => { st.stopNum = i + 1; }); toRoute.camperCount = toRoute.stops.reduce((s, st) => s + st.campers.length, 0);
        _generatedRoutes = D.savedRoutes; save(); renderRouteResults(applyOverrides(D.savedRoutes)); toast(camperName + ' moved to ' + toRoute.busName);
    }
    function openMoveModal(camperName, fromBusId, shiftIdx) { const sr = _generatedRoutes?.[shiftIdx]; if (!sr) return; const otherBuses = sr.routes.filter(r => r.busId !== fromBusId && r.stops.length > 0); document.getElementById('moveCamperName').textContent = camperName; const sel = document.getElementById('moveToBus'); sel.innerHTML = otherBuses.map(r => '<option value="' + r.busId + '">' + esc(r.busName) + ' (' + r.camperCount + ')</option>').join(''); document.getElementById('moveConfirmBtn').onclick = function() { moveCamperToBus(camperName, fromBusId, sel.value, shiftIdx); closeModal('moveModal'); }; openModal('moveModal'); }

    // =========================================================================
    // EXPORT / PRINT
    // =========================================================================
    function exportRoutesCsv() {
        if (!_generatedRoutes) { toast('Generate first', 'error'); return; }
        const roster = getRoster(); const modeLabel = D.activeMode === 'arrival' ? 'Pickup' : 'Drop-off';
        let csv = '\uFEFFID,First Name,Last Name,Division,Grade,Bunk,Address,City,State,ZIP,Transport,Bus,Stop #,' + modeLabel + ' Location,Est. Time,Shift\n';
        const rows = [];
        _generatedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); const cd = roster[c.name] || {}; const addr = D.addresses[c.name] || {}; rows.push([cd.camperId ? String(cd.camperId).padStart(4, '0') : '', p[0] || '', p.slice(1).join(' ') || '', c.division || cd.division || '', cd.grade || '', c.bunk || cd.bunk || '', addr.street || '', addr.city || '', addr.state || '', addr.zip || '', 'Bus', r.busName, st.stopNum, st.address, st.estimatedTime || '', sr.shift.label || '']); }); }); }); });
        Object.keys(roster).forEach(name => { const a = D.addresses[name]; if (a?.transport !== 'pickup') return; const c = roster[name]; const p = name.split(/\s+/); let carpoolLabel = 'Pickup'; if (D.carpoolGroups) Object.entries(D.carpoolGroups).forEach(([num, g]) => { if ((g.kids || []).includes(name)) carpoolLabel = 'Carpool ' + num; }); rows.push([c.camperId ? String(c.camperId).padStart(4, '0') : '', p[0] || '', p.slice(1).join(' ') || '', c.division || '', c.grade || '', c.bunk || '', a?.street || '', a?.city || '', a?.state || '', a?.zip || '', carpoolLabel, '', '', '', '', '']); });
        rows.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]));
        rows.forEach(r => { csv += r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n'; });
        const blob = new Blob([csv], { type: 'text/csv' }); const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = 'campistry_go_' + D.activeMode + '_routes.csv'; el.click(); toast('Exported ' + rows.length + ' campers');
    }

    function printRoutes(printWhat) {
        if (!_generatedRoutes) { toast('Generate first', 'error'); return; }
        if (!printWhat) { const modal = '<div style="display:flex;flex-direction:column;gap:.75rem;padding:1rem;"><h3 style="margin:0;">Print Options</h3><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'routes\');CampistryGo.closeModal(\'printModal\')">Bus Routes</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'master\');CampistryGo.closeModal(\'printModal\')">Master List</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'busSheets\');CampistryGo.closeModal(\'printModal\')">Bus Sheets (1/page)</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'driverSheets\');CampistryGo.closeModal(\'printModal\')">Driver Sheets</button><button class="btn btn-primary" onclick="CampistryGo.printRoutes(\'all\');CampistryGo.closeModal(\'printModal\')">Everything</button><button class="btn btn-secondary" onclick="CampistryGo.closeModal(\'printModal\')">Cancel</button></div>'; let overlay = document.getElementById('printModal'); if (!overlay) { overlay = document.createElement('div'); overlay.id = 'printModal'; overlay.className = 'modal-overlay'; overlay.innerHTML = '<div class="modal" style="max-width:360px;">' + modal + '</div>'; document.body.appendChild(overlay); overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); }); } else overlay.querySelector('.modal').innerHTML = modal; overlay.classList.add('open'); return; }
        const cn = D.setup.campName || 'Camp'; const modeLabel = D.activeMode === 'arrival' ? 'Pickup' : 'Drop-off'; const timeLabel = D.activeMode === 'arrival' ? 'Arrive by' : 'Departs';
        let h = '<!DOCTYPE html><html><head><title>Bus Routes — ' + esc(cn) + '</title><style>body{font-family:Arial,sans-serif;font-size:11pt;color:#222;margin:20px}h1{font-size:18pt;margin-bottom:4px}h2{font-size:14pt;margin:20px 0 8px;padding:6px 10px;color:#fff;border-radius:4px}.sub{color:#666;font-size:10pt;margin-bottom:20px}table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:10pt}th{background:#f5f5f5;text-align:left;padding:6px 8px;border:1px solid #ddd;font-size:9pt;text-transform:uppercase}td{padding:5px 8px;border:1px solid #ddd}@media print{.no-print{display:none}}</style></head><body>';
        h += '<h1>' + esc(cn) + ' — ' + modeLabel + ' Routes</h1><div class="sub">Generated: ' + new Date().toLocaleDateString() + ' | Powered by VROOM</div>';
        if (printWhat === 'routes' || printWhat === 'all') { _generatedRoutes.forEach((sr, si) => { h += '<h1 style="margin-top:30px">' + esc(sr.shift.label || 'Shift ' + (si + 1)) + ' — ' + timeLabel + ' ' + esc(sr.shift.departureTime) + '</h1>'; sr.routes.filter(r => r.stops.length > 0).forEach(r => { h += '<div style="page-break-inside:avoid"><h2 style="background:' + esc(r.busColor) + '">' + esc(r.busName) + ' — ' + r.camperCount + ' campers, ' + r.stops.length + ' stops (' + r.totalDuration + ' min)</h2><table><thead><tr><th>Stop</th><th>Camper(s)</th><th>Address</th><th>Time</th></tr></thead><tbody>'; r.stops.forEach(st => { const nm = st.isMonitor ? esc(st.monitorName) : st.isCounselor ? esc(st.counselorName) : st.campers.map(c => esc(c.name)).join(', '); h += '<tr><td style="text-align:center;font-weight:bold">' + st.stopNum + '</td><td>' + nm + '</td><td>' + esc(st.address) + '</td><td style="font-weight:600">' + (st.estimatedTime || '—') + '</td></tr>'; }); h += '</tbody></table></div>'; }); }); }
        if (printWhat === 'busSheets') { _generatedRoutes.forEach((sr, si) => { sr.routes.filter(r => r.stops.length > 0).forEach((r, ri) => { if (ri > 0 || si > 0) h += '<div style="page-break-before:always"></div>'; h += '<h1>' + esc(r.busName) + '</h1><div class="sub">' + esc(sr.shift.label || 'Shift') + ' | ' + r.camperCount + ' campers | ' + r.stops.length + ' stops | ' + r.totalDuration + ' min</div><table><thead><tr><th>Stop</th><th>Camper(s)</th><th>Address</th><th>Time</th></tr></thead><tbody>'; r.stops.forEach(st => { const nm = st.isMonitor ? esc(st.monitorName) : st.isCounselor ? esc(st.counselorName) : st.campers.map(c => esc(c.name)).join(', '); h += '<tr><td style="text-align:center;font-weight:bold;font-size:14pt;">' + st.stopNum + '</td><td>' + nm + '</td><td>' + esc(st.address) + '</td><td style="font-weight:600">' + (st.estimatedTime || '—') + '</td></tr>'; }); h += '</tbody></table>'; }); }); }
        if (printWhat === 'driverSheets') { const action = D.activeMode === 'arrival' ? 'PICKUP' : 'DROP-OFF'; _generatedRoutes.forEach((sr, si) => { sr.routes.filter(r => r.stops.length > 0).forEach((r, ri) => { if (ri > 0 || si > 0) h += '<div style="page-break-before:always"></div>'; h += '<div style="border:3px solid ' + esc(r.busColor) + ';border-radius:8px;padding:20px;"><div style="display:flex;justify-content:space-between;margin-bottom:15px;padding-bottom:10px;border-bottom:3px solid ' + esc(r.busColor) + ';"><div><h1 style="margin:0;color:' + esc(r.busColor) + ';">' + esc(r.busName) + '</h1><div style="color:#666;">' + esc(sr.shift.label || 'Shift') + ' — ' + action + '</div></div><div style="text-align:right;"><div style="font-size:14pt;font-weight:bold;">' + r.stops.filter(s => !s.isMonitor && !s.isCounselor).length + ' Stops</div><div style="color:#666;">' + r.camperCount + ' campers · ' + r.totalDuration + ' min</div></div></div><table style="width:100%;border-collapse:collapse;"><thead><tr><th style="width:60px;text-align:center;padding:8px;border:2px solid #ddd;background:#f0f0f0;">STOP</th><th style="padding:8px;border:2px solid #ddd;background:#f0f0f0;">' + action + ' ADDRESS</th><th style="width:70px;text-align:center;padding:8px;border:2px solid #ddd;background:#f0f0f0;">TIME</th><th style="width:50px;text-align:center;padding:8px;border:2px solid #ddd;background:#f0f0f0;">KIDS</th></tr></thead><tbody>'; r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; h += '<tr><td style="text-align:center;font-weight:bold;font-size:18pt;padding:10px;border:2px solid #ddd;color:' + esc(r.busColor) + ';">' + st.stopNum + '</td><td style="padding:10px;border:2px solid #ddd;font-size:12pt;font-weight:600;">' + esc(st.address) + '</td><td style="text-align:center;padding:10px;border:2px solid #ddd;font-weight:700;">' + (st.estimatedTime || '—') + '</td><td style="text-align:center;padding:10px;border:2px solid #ddd;font-weight:bold;">' + st.campers.length + '</td></tr>'; }); h += '</tbody></table></div>'; }); }); }
        if (printWhat === 'master' || printWhat === 'all') { if (printWhat === 'all') h += '<div style="page-break-before:always"></div>'; h += '<h1>Master ' + modeLabel + ' List</h1><table><thead><tr><th>First</th><th>Last</th><th>Shift</th><th>Bus</th><th>Stop</th><th>Address</th><th>Time</th></tr></thead><tbody>'; const rows = []; _generatedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); rows.push({ fn: p[0], ln: p.slice(1).join(' '), sh: sr.shift.label, bn: r.busName, sn: st.stopNum, ad: st.address, t: st.estimatedTime || '—' }); }); }); }); }); rows.sort((a, b) => a.ln.localeCompare(b.ln)); rows.forEach(r => { h += '<tr><td>' + esc(r.fn) + '</td><td><strong>' + esc(r.ln) + '</strong></td><td>' + esc(r.sh) + '</td><td>' + esc(r.bn) + '</td><td style="text-align:center;font-weight:bold">' + r.sn + '</td><td>' + esc(r.ad) + '</td><td style="font-weight:600">' + r.t + '</td></tr>'; }); h += '</tbody></table>'; }
        h += '</body></html>'; const w = window.open('', '_blank'); w.document.write(h); w.document.close(); setTimeout(() => w.print(), 500);
    }

    // =========================================================================
    // CARPOOL & RIDE-WITH
    // =========================================================================
    function renderCarpool() {
        const card = document.getElementById('carpoolCard'), body = document.getElementById('carpoolBody'), countEl = document.getElementById('carpoolCount');
        if (!card || !body) return;
        const roster = getRoster(); if (!D.carpoolGroups) D.carpoolGroups = {};
        const pickups = [], rideWithPairs = [], allKidsInGroups = new Set();
        Object.values(D.carpoolGroups).forEach(g => (g.kids || []).forEach(k => allKidsInGroups.add(k)));
        Object.keys(roster).forEach(name => { const a = D.addresses[name]; if (!a) return; if (a.transport === 'pickup') pickups.push({ name, division: roster[name].division || '', address: [a.street, a.city].filter(Boolean).join(', ') }); if (a.rideWith) rideWithPairs.push({ name, partner: a.rideWith, division: roster[name].division || '' }); });
        const ungrouped = pickups.filter(p => !allKidsInGroups.has(p.name));
        const groups = Object.entries(D.carpoolGroups).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
        card.style.display = '';
        if (countEl) countEl.textContent = pickups.length + ' pickup, ' + groups.length + ' group' + (groups.length !== 1 ? 's' : '');
        let html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;"><div style="font-size:.875rem;font-weight:700;">🚗 Carpool Groups</div><button class="btn btn-primary btn-sm" onclick="CampistryGo.openCarpoolGroupModal()">+ New Group</button></div>';
        if (groups.length) { html += groups.map(([num, g]) => { const kidRows = (g.kids || []).map(kid => { const c = roster[kid]; return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border-light);"><span style="font-size:.8125rem;"><strong>' + esc(kid) + '</strong>' + (c?.division ? ' <span style="color:var(--text-muted);font-size:.75rem;">' + esc(c.division) + '</span>' : '') + '</span><button class="btn btn-ghost btn-sm" style="color:var(--red-500);font-size:.7rem;padding:2px 6px;" onclick="CampistryGo.removeFromCarpoolGroup(\'' + esc(num) + '\',\'' + esc(kid.replace(/'/g, "\\'")) + '\')">×</button></div>'; }).join(''); return '<div style="border:1px solid var(--border-light);border-radius:8px;margin-bottom:.75rem;overflow:hidden;"><div style="display:flex;align-items:center;justify-content:space-between;padding:.625rem .75rem;background:var(--surface-secondary,#f9fafb);"><div><span style="font-weight:700;font-size:.875rem;">Carpool ' + esc(num) + '</span>' + (g.driver ? ' <span style="font-size:.75rem;color:var(--text-muted);">— ' + esc(g.driver) + (g.phone ? ' · ' + esc(g.phone) : '') + '</span>' : '') + '</div><div style="display:flex;gap:4px;"><button class="btn btn-ghost btn-sm" style="font-size:.7rem;" onclick="CampistryGo.openAddToCarpoolModal(\'' + esc(num) + '\')">+ Add</button><button class="btn btn-ghost btn-sm" style="font-size:.7rem;" onclick="CampistryGo.editCarpoolGroup(\'' + esc(num) + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500);font-size:.7rem;" onclick="CampistryGo.deleteCarpoolGroup(\'' + esc(num) + '\')">Delete</button></div></div><div style="padding:.5rem .75rem;">' + (kidRows || '<div style="font-size:.8125rem;color:var(--text-muted);">No kids yet</div>') + '</div></div>'; }).join(''); }
        else html += '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.8125rem;border:1px dashed var(--border-light);border-radius:8px;">No carpool groups yet</div>';
        if (ungrouped.length) { html += '<div style="margin-top:.75rem;border-top:1px solid var(--border-light);padding-top:.75rem;"><div style="font-size:.8125rem;font-weight:700;color:var(--text-secondary);margin-bottom:.5rem;">Ungrouped Pickup Kids (' + ungrouped.length + ')</div>'; html += ungrouped.map(p => { const opts = groups.map(([n]) => '<option value="' + esc(n) + '">Carpool ' + esc(n) + '</option>').join(''); return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;"><strong>' + esc(p.name) + '</strong><div style="display:flex;gap:4px;">' + (groups.length ? '<select class="form-input" style="font-size:.7rem;padding:2px 4px;width:auto;" onchange="if(this.value)CampistryGo.addToCarpoolGroup(this.value,\'' + esc(p.name.replace(/'/g, "\\'")) + '\');this.value=\'\'"><option value="">Add to...</option>' + opts + '</select>' : '') + '<button class="btn btn-ghost btn-sm" style="font-size:.7rem;" onclick="CampistryGo.setTransport(\'' + esc(p.name.replace(/'/g, "\\'")) + '\',\'bus\')">→ Bus</button></div></div>'; }).join(''); html += '</div>'; }
        if (rideWithPairs.length) { html += '<div style="margin-top:.75rem;border-top:1px solid var(--border-light);padding-top:.75rem;"><div style="font-size:.8125rem;font-weight:700;color:var(--text-secondary);margin-bottom:.5rem;">🤝 Ride-With Pairs (' + rideWithPairs.length + ')</div>'; rideWithPairs.forEach(p => { html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;"><span><strong>' + esc(p.name) + '</strong> rides with <strong>' + esc(p.partner) + '</strong></span><button class="btn btn-ghost btn-sm" style="color:var(--red-500);font-size:.7rem;" onclick="CampistryGo.removeRideWith(\'' + esc(p.name.replace(/'/g, "\\'")) + '\')">Remove</button></div>'; }); html += '</div>'; }
        body.innerHTML = html;
    }

    function setTransport(name, mode) { if (!D.addresses[name]) return; D.addresses[name].transport = mode; save(); renderCarpool(); renderAddresses(); updateStats(); toast(name + ' → ' + (mode === 'pickup' ? 'carpool' : 'bus')); }
    function setRideWith(name, partner) { if (!D.addresses[name]) return; D.addresses[name].rideWith = partner; save(); renderCarpool(); toast(name + ' paired with ' + partner); }
    function removeRideWith(name) { if (!D.addresses[name]) return; D.addresses[name].rideWith = ''; save(); renderCarpool(); toast('Pairing removed'); }
    function openCarpoolGroupModal(editNum) { const existing = editNum ? D.carpoolGroups[editNum] : null; document.getElementById('carpoolGroupNum').value = editNum || ''; document.getElementById('carpoolGroupDriver').value = existing?.driver || ''; document.getElementById('carpoolGroupPhone').value = existing?.phone || ''; document.getElementById('carpoolGroupNum').disabled = !!editNum; document.getElementById('carpoolGroupModalTitle').textContent = editNum ? 'Edit Carpool ' + editNum : 'New Carpool Group'; openModal('carpoolGroupModal'); }
    function saveCarpoolGroup() { const num = document.getElementById('carpoolGroupNum')?.value.trim(); if (!num) { toast('Enter a number', 'error'); return; } if (!D.carpoolGroups) D.carpoolGroups = {}; if (!D.carpoolGroups[num]) D.carpoolGroups[num] = { label: 'Carpool ' + num, driver: '', phone: '', kids: [] }; D.carpoolGroups[num].driver = document.getElementById('carpoolGroupDriver')?.value.trim() || ''; D.carpoolGroups[num].phone = document.getElementById('carpoolGroupPhone')?.value.trim() || ''; save(); closeModal('carpoolGroupModal'); renderCarpool(); toast('Carpool ' + num + ' saved'); }
    function editCarpoolGroup(num) { openCarpoolGroupModal(num); }
    function deleteCarpoolGroup(num) { if (!D.carpoolGroups?.[num]) return; if (!confirm('Delete Carpool ' + num + '?')) return; delete D.carpoolGroups[num]; save(); renderCarpool(); toast('Deleted'); }
    function addToCarpoolGroup(num, kidName) { if (!D.carpoolGroups?.[num]) return; if (!D.carpoolGroups[num].kids) D.carpoolGroups[num].kids = []; if (!D.carpoolGroups[num].kids.includes(kidName)) D.carpoolGroups[num].kids.push(kidName); if (D.addresses[kidName]) D.addresses[kidName].transport = 'pickup'; save(); renderCarpool(); toast(kidName + ' → Carpool ' + num); }
    function removeFromCarpoolGroup(num, kidName) { if (!D.carpoolGroups?.[num]) return; D.carpoolGroups[num].kids = (D.carpoolGroups[num].kids || []).filter(k => k !== kidName); save(); renderCarpool(); toast(kidName + ' removed'); }
    function openAddToCarpoolModal(num) { const roster = getRoster(); const existing = new Set(D.carpoolGroups[num]?.kids || []); const available = Object.keys(roster).sort().filter(n => D.addresses[n] && !existing.has(n)); const sel = document.getElementById('addToCarpoolSelect'); if (sel) sel.innerHTML = '<option value="">— Select —</option>' + available.map(n => '<option value="' + esc(n) + '">' + esc(n) + (D.addresses[n]?.transport === 'pickup' ? ' 🚗' : ' 🚌') + '</option>').join(''); document.getElementById('addToCarpoolSearch').value = ''; document.getElementById('addToCarpoolNum').value = num; document.getElementById('addToCarpoolTitle').textContent = 'Add to Carpool ' + num; openModal('addToCarpoolModal'); }
    function filterAddToCarpool() { const q = (document.getElementById('addToCarpoolSearch')?.value || '').toLowerCase().trim(); const num = document.getElementById('addToCarpoolNum')?.value; const roster = getRoster(); const existing = new Set(D.carpoolGroups[num]?.kids || []); const names = Object.keys(roster).sort().filter(n => D.addresses[n] && !existing.has(n) && (!q || n.toLowerCase().includes(q))); const sel = document.getElementById('addToCarpoolSelect'); if (sel) sel.innerHTML = '<option value="">— Select —</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + (D.addresses[n]?.transport === 'pickup' ? ' 🚗' : ' 🚌') + '</option>').join(''); if (names.length === 1 && sel) sel.value = names[0]; }
    function confirmAddToCarpool() { const num = document.getElementById('addToCarpoolNum')?.value; const kid = document.getElementById('addToCarpoolSelect')?.value; if (!num || !kid) { toast('Select a camper', 'error'); return; } addToCarpoolGroup(num, kid); closeModal('addToCarpoolModal'); }

    // =========================================================================
    // TABS + INIT
    // =========================================================================
    function initTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const t = btn.dataset.tab; document.getElementById('tab-' + t)?.classList.add('active');
            if (t === 'fleet') renderFleet(); else if (t === 'shifts') renderShifts(); else if (t === 'staff') renderStaff(); else if (t === 'addresses') renderAddresses(); else if (t === 'preflight') runPreflight(); else if (t === 'routes') {
                runPreflight(); renderDailyOverrides(); renderCarpool();
                if (_pendingMapInit) { setTimeout(function() { initMap(_pendingMapInit); _pendingMapInit = null; }, 150); }
                else { setTimeout(function() { if (_map) _map.invalidateSize(); }, 150); }
            }
        }));
        document.getElementById('addressSearch')?.addEventListener('input', () => { clearTimeout(_addrSearchTimer); _addrSearchTimer = setTimeout(renderAddresses, 200); });
    }
    let _addrSearchTimer;

    function init() {
        console.log('[Go] Initializing v3.0 (VROOM)...');
        load();
        if (D[D.activeMode]) loadModeData(D.activeMode);
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === D.activeMode));
        const modeLabel = document.getElementById('modeLabel');
        if (modeLabel) modeLabel.textContent = D.activeMode === 'arrival' ? 'Morning Pickup Routes' : 'Afternoon Drop-off Routes';
        initTabs(); populateSetup(); renderFleet(); renderShifts(); renderStaff(); renderAddresses(); updateStats(); updateBusSelects();
        if (D.setup.campLat && D.setup.campLng) { _campCoordsCache = { lat: D.setup.campLat, lng: D.setup.campLng }; }
        if (D.savedRoutes && D.savedRoutes.length) {
            let needsSave = false;
            D.savedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.address && st.address.startsWith('Shared stop')) { let bestAddr = null, bestDist = Infinity; (st.campers || []).forEach(c => { const a = D.addresses[c.name]; if (a?.geocoded && a.lat && a.lng && st.lat && st.lng) { const d = haversineMi(st.lat, st.lng, a.lat, a.lng); if (d < bestDist) { bestDist = d; bestAddr = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '); } } }); if (bestAddr) { st.address = bestAddr; needsSave = true; } } }); }); });
            if (needsSave) save();
            _generatedRoutes = D.savedRoutes;
            setTimeout(() => { renderRouteResults(applyOverrides(D.savedRoutes)); toast('Saved routes loaded'); }, 200);
        }
        document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });
        window.addEventListener('campistry-cloud-hydrated', () => { console.log('[Go] Cloud data hydrated'); load(); renderAddresses(); updateStats(); renderShifts(); });
        window.addEventListener('storage', (e) => { if (e.key === 'campGlobalSettings_v1') { console.log('[Go] Roster changed — refreshing'); renderAddresses(); updateStats(); } });
        console.log('[Go] Ready —', D.buses.length, 'buses,', D.shifts.length, 'shifts,', Object.keys(getRoster()).length, 'campers');
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryGo = {
        saveSetup, testApiKey,
        openBusModal, saveBus, editBus, deleteBus, _pickColor,
        addShift, deleteShift, toggleShiftDiv, updateShiftTime, renameShift,
        toggleShiftGrade, setShiftGradeMode, toggleShiftBus, setAllShiftBuses,
        openMonitorModal, saveMonitor, editMonitor, deleteMonitor,
        openCounselorModal, saveCounselor, editCounselor, deleteCounselor,
        editAddress, saveAddress, geocodeAll, downloadAddressTemplate, importAddressCsv,
        regeocodeAll: function() { geocodeAll(true); },
        testGeocode, systemCheck,
        generateRoutes, exportRoutesCsv, printRoutes, detectRegions,
        renderMap, selectMapBus, toggleMapShift, setMapShiftsAll, toggleMapFullscreen,
        openOverrideModal, onOverrideTypeChange, saveOverride, removeOverride, filterOverrideSelect,
        searchCamperInRoutes, zoomToStop, openMoveModal, renderFilteredMasterList, sortMasterBy,
        switchMode,
        setTransport, setRideWith, removeRideWith, renderCarpool,
        openCarpoolGroupModal, saveCarpoolGroup, editCarpoolGroup, deleteCarpoolGroup,
        addToCarpoolGroup, removeFromCarpoolGroup,
        openAddToCarpoolModal, filterAddToCarpool, confirmAddToCarpool,
        closeModal, openModal,
        _getMap: function() { return _map; },
        _getSavedRoutes: function() { return D.savedRoutes; },
        _setSavedRoutes: function(r) { D.savedRoutes = r; _generatedRoutes = r; },
        _save: function() { save(); },
        _refreshRoutes: function() {
            if (D.savedRoutes) {
                _generatedRoutes = D.savedRoutes;
                var c = _map ? _map.getCenter() : null, z = _map ? _map.getZoom() : null;
                renderRouteResults(applyOverrides(D.savedRoutes));
                if (_map && c && z != null) setTimeout(function() { _map.setView(c, z, { animate: false }); }, 200);
            }
        },
        _getRouteGeomCache: function() { return _routeGeomCache; },
        _clearGeomCache: function(key) { if (key) delete _routeGeomCache[key]; else _routeGeomCache = {}; }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
