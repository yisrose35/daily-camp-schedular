// =============================================================================
// campistry_go.js — Campistry Go v2.0
// Multi-shift bus routing with geographic region affinity
// =============================================================================
(function () {
    'use strict';
    console.log('[Go] Campistry Go v2.0 loading...');

    // =========================================================================
    // STATE
    // =========================================================================
    let D = {
        setup: {
            campAddress: '', campName: '', avgSpeed: 25, // mph
            reserveSeats: 2, dropoffMode: 'door-to-door',
            avgStopTime: 2, maxWalkDistance: 500, orsApiKey: ''
        },
        buses: [],       // { id, name, capacity, color, notes }
        shifts: [],      // { id, label, divisions:[], departureTime:'16:00' }
        monitors: [],    // { id, name, address, phone, assignedBus }
        counselors: [],  // { id, name, address, bunk, needsStop, assignedBus }
        addresses: {},   // { camperName: { street, city, state, zip, lat, lng, geocoded } }
        savedRoutes: null, // last generated routes (persisted across reloads)
        dailyOverrides: {} // { 'YYYY-MM-DD': { camperName: { type, ... } } }
    };
    let _editBusId = null, _editMonitorId = null, _editCounselorId = null, _editCamper = null;
    let _generatedRoutes = null;
    let _toastTimer = null;
    const BUS_COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#8b5cf6','#14b8a6','#6366f1','#84cc16','#e11d48','#0ea5e9','#d946ef'];
    const STORE = 'campistry_go_data';

    // =========================================================================
    // HELPERS
    // =========================================================================
    const esc = s => { if (s == null) return ''; const m = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}; return String(s).replace(/[&<>"']/g, c => m[c]); };
    const uid = () => 'go_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    function toast(msg, type) { const el = document.getElementById('toastEl'); el.textContent = msg; el.className = 'toast' + (type === 'error' ? ' error' : ''); clearTimeout(_toastTimer); requestAnimationFrame(() => { el.classList.add('show'); _toastTimer = setTimeout(() => el.classList.remove('show'), 2500); }); }
    function openModal(id) { document.getElementById(id)?.classList.add('open'); }
    function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

    /** Get ORS API key — checks config.js first (platform key), then user-entered key */
    function getApiKey() {
        return window.__CAMPISTRY_ORS_KEY__ || D.setup.orsApiKey || '';
    }

    let _campCoordsCache = null; // { lat, lng } — cached camp geocode

    // Distance (miles) between two lat/lng
    function haversineMi(lat1, lng1, lat2, lng2) {
        const R = 3958.8;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Decode Google-style encoded polyline to [[lat,lng], ...] */
    function decodePolyline(encoded) {
        const points = [];
        let i = 0, lat = 0, lng = 0;
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
    function angleTo(cLat, cLng, lat, lng) { return Math.atan2(lng - cLng, lat - cLat); }
    function formatTime(totalMin) {
        const h = Math.floor(totalMin / 60), m = Math.round(totalMin % 60);
        const p = h >= 12 ? 'PM' : 'AM', h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return h12 + ':' + String(m).padStart(2, '0') + ' ' + p;
    }
    function parseTime(t) { const [h, m] = (t || '16:00').split(':').map(Number); return h * 60 + (m || 0); }

    // =========================================================================
    // DATA: LOAD / SAVE / ROSTER
    // Reads from Campistry's cloud-synced state (integration_hooks.js provides
    // loadGlobalSettings/saveGlobalSettings). Falls back to direct localStorage
    // reads if those aren't available yet (boot race condition).
    // =========================================================================

    /** Read the unified Campistry settings object from best available source */
    function readCampistrySettings() {
        // Source 1: integration_hooks.js loadGlobalSettings (cloud-synced)
        if (typeof window.loadGlobalSettings === 'function') {
            try { return window.loadGlobalSettings() || {}; } catch (_) {}
        }
        // Source 2: localStorage (same keys that integration_hooks reads)
        const keys = ['CAMPISTRY_UNIFIED_STATE', 'campGlobalSettings_v1', 'CAMPISTRY_LOCAL_CACHE'];
        for (const key of keys) {
            try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw) || {}; } catch (_) {}
        }
        return {};
    }

    function load() {
        try {
            // Go data: try cloud first, then localStorage
            const g = readCampistrySettings();
            if (g.campistryGo && Object.keys(g.campistryGo).length) {
                D = merge(g.campistryGo);
                console.log('[Go] Loaded from cloud settings');
                return;
            }
            const raw = localStorage.getItem(STORE);
            if (raw) { D = merge(JSON.parse(raw)); console.log('[Go] Loaded from localStorage'); }
        } catch (e) { console.error('[Go] Load error:', e); }
    }

    function merge(d) {
        const def = { setup: { campAddress:'',campName:'',avgSpeed:25,reserveSeats:2,dropoffMode:'door-to-door',avgStopTime:2,maxWalkDistance:500,orsApiKey:'',campLat:null,campLng:null }, buses:[], shifts:[], monitors:[], counselors:[], addresses:{}, savedRoutes:null, dailyOverrides:{} };
        return { setup: { ...def.setup, ...(d.setup || {}) }, buses: d.buses || [], shifts: d.shifts || [], monitors: d.monitors || [], counselors: d.counselors || [], addresses: d.addresses || {}, savedRoutes: d.savedRoutes || null, dailyOverrides: d.dailyOverrides || {} };
    }

    function save() {
        try {
            setSyncStatus('syncing');
            // Always write to own localStorage key (immediate, works offline)
            localStorage.setItem(STORE, JSON.stringify(D));
            // Also write to cloud via integration_hooks (batched + Supabase sync)
            if (typeof window.saveGlobalSettings === 'function') {
                window.saveGlobalSettings('campistryGo', D);
            }
            setTimeout(() => setSyncStatus('synced'), 300);
        } catch (e) { console.error('[Go] Save:', e); setSyncStatus('error'); }
    }

    function setSyncStatus(s) {
        const dot = document.getElementById('syncDot'), txt = document.getElementById('syncText');
        if (!dot) return;
        dot.className = 'sync-dot' + (s === 'syncing' ? ' syncing' : s === 'error' ? ' error' : '');
        txt.textContent = s === 'syncing' ? 'Saving...' : s === 'error' ? 'Error' : 'Synced';
    }

    /** Pull camper roster from Campistry Me (auto-sync, no manual import needed) */
    function getRoster() {
        const g = readCampistrySettings();
        return g?.app1?.camperRoster || {};
    }

    /** Pull division structure from Campistry Me */
    function getStructure() {
        const g = readCampistrySettings();
        return g?.campStructure || {};
    }
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
        save(); toast('Setup saved');
    }
    async function testApiKey() {
        const key = document.getElementById('orsApiKey')?.value.trim();
        const st = document.getElementById('apiKeyStatus');
        if (!key) { st.innerHTML = '<span style="color:var(--red-600)">Enter key first</span>'; return; }
        st.innerHTML = '<span style="color:var(--text-muted)">Testing...</span>';
        try {
            const r = await fetch('https://api.openrouteservice.org/geocode/search?text=Times+Square+New+York&size=1', { headers: { 'Authorization': key, 'Accept': 'application/json' } });
            st.innerHTML = r.status === 200 ? '<span style="color:var(--green-600)">✓ Connected</span>' : r.status === 401 ? '<span style="color:var(--red-600)">✗ Invalid key</span>' : '<span style="color:var(--amber-600)">⚠ HTTP ' + r.status + '</span>';
        } catch (_) { st.innerHTML = '<span style="color:var(--red-600)">✗ Network error</span>'; }
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
        if (!name) { toast('Enter name', 'error'); return; }
        if (!cap || cap < 1) { toast('Enter capacity', 'error'); return; }
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
            if (!sh.grades) sh.grades = {}; // { divName: 'all' | [grade1, grade2, ...] }

            // Division chips + grade sub-chips for active divisions
            const divChips = divNames.map(dName => {
                const isActive = (sh.divisions || []).includes(dName);
                const color = struct[dName]?.color || '#888';
                const gradeNames = Object.keys(struct[dName]?.grades || {}).sort();
                const gradeMode = sh.grades[dName]; // 'all', [array], or undefined

                let gradeHtml = '';
                if (isActive && gradeNames.length > 1) {
                    const allGrades = !gradeMode || gradeMode === 'all';
                    gradeHtml = '<div style="display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.375rem;margin-left:1.5rem;">' +
                        '<span class="division-chip' + (allGrades ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.setShiftGradeMode(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\',\'all\')">All Grades</span>' +
                        gradeNames.map(g => {
                            const gActive = allGrades || (Array.isArray(gradeMode) && gradeMode.includes(g));
                            return '<span class="division-chip' + (gActive ? ' active' : '') + '" style="font-size:.65rem;padding:.15rem .5rem;" onclick="CampistryGo.toggleShiftGrade(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\',\'' + esc(g.replace(/'/g, "\\'")) + '\')">' + esc(g) + '</span>';
                        }).join('') +
                        '</div>';
                }

                return '<div><span class="division-chip' + (isActive ? ' active' : '') + '" onclick="CampistryGo.toggleShiftDiv(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\')"><span class="chip-dot" style="background:' + esc(color) + '"></span>' + esc(dName) + '</span>' + gradeHtml + '</div>';
            }).join('');

            const camperCount = countCampersForShift(sh);

            return '<div class="shift-card"><div class="shift-card-header"><div class="shift-card-title"><span class="shift-num">' + (idx + 1) + '</span><input type="text" class="form-input" value="' + esc(sh.label || '') + '" placeholder="Shift name" style="max-width:200px;font-size:.875rem;font-weight:700;padding:.25rem .5rem;border:1px solid transparent;" onfocus="this.style.borderColor=\'var(--border-medium)\'" onblur="this.style.borderColor=\'transparent\';CampistryGo.renameShift(\'' + sh.id + '\',this.value)"><span style="font-size:.75rem;font-weight:400;color:var(--text-muted);">' + camperCount + ' campers</span></div><div style="display:flex;align-items:center;gap:.5rem;"><label style="font-size:.75rem;font-weight:600;color:var(--text-secondary)">Depart:</label><input type="time" class="form-input" value="' + esc(sh.departureTime || '16:00') + '" style="width:110px;padding:.35rem .5rem;font-size:.8125rem;" onchange="CampistryGo.updateShiftTime(\'' + sh.id + '\',this.value)"><button class="btn btn-ghost btn-sm" style="color:var(--red-500);" onclick="CampistryGo.deleteShift(\'' + sh.id + '\')">Remove</button></div></div><div style="display:flex;flex-direction:column;gap:.375rem;">' + (divNames.length ? divChips : '<span style="font-size:.8125rem;color:var(--text-muted)">No divisions in Campistry Me</span>') + '</div></div>';
        }).join('');
    }

    /** Count campers matching a shift's division + grade filters */
    function countCampersForShift(sh) {
        const roster = getRoster();
        const struct = getStructure();
        const divs = sh.divisions || [];
        if (!divs.length) return 0;
        return Object.values(roster).filter(c => {
            if (!divs.includes(c.division)) return false;
            const gradeMode = sh.grades?.[c.division];
            if (!gradeMode || gradeMode === 'all') return true;
            if (Array.isArray(gradeMode)) return gradeMode.includes(c.grade);
            return true;
        }).length;
    }

    /** Check if a camper matches a shift's division + grade filters */
    function camperMatchesShift(camper, shift) {
        if (!(shift.divisions || []).includes(camper.division)) return false;
        const gradeMode = shift.grades?.[camper.division];
        if (!gradeMode || gradeMode === 'all') return true;
        if (Array.isArray(gradeMode)) return gradeMode.includes(camper.grade);
        return true;
    }

    function addShift() {
        const idx = D.shifts.length + 1;
        const prevTime = D.shifts.length ? D.shifts[D.shifts.length - 1].departureTime : '16:00';
        const prevMin = parseTime(prevTime);
        const newMin = prevMin + 45;
        const h = Math.floor(newMin / 60), m = newMin % 60;
        const newTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        D.shifts.push({ id: uid(), label: 'Shift ' + idx, divisions: [], grades: {}, departureTime: newTime });
        save(); renderShifts(); updateStats(); toast('Shift added');
    }
    function deleteShift(id) { D.shifts = D.shifts.filter(s => s.id !== id); save(); renderShifts(); updateStats(); toast('Shift removed'); }
    function toggleShiftDiv(shiftId, divName) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return;
        if (!sh.divisions) sh.divisions = [];
        if (!sh.grades) sh.grades = {};
        // Remove from any other shift first
        D.shifts.forEach(s => {
            if (s.id !== shiftId) {
                s.divisions = (s.divisions || []).filter(d => d !== divName);
                if (s.grades) delete s.grades[divName];
            }
        });
        const idx = sh.divisions.indexOf(divName);
        if (idx >= 0) { sh.divisions.splice(idx, 1); delete sh.grades[divName]; }
        else { sh.divisions.push(divName); sh.grades[divName] = 'all'; }
        save(); renderShifts();
    }
    function toggleShiftGrade(shiftId, divName, gradeName) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return;
        if (!sh.grades) sh.grades = {};
        const struct = getStructure();
        const allGrades = Object.keys(struct[divName]?.grades || {});

        // If currently 'all', switch to all-minus-this
        if (!sh.grades[divName] || sh.grades[divName] === 'all') {
            sh.grades[divName] = allGrades.filter(g => g !== gradeName);
        } else {
            const arr = sh.grades[divName];
            const gi = arr.indexOf(gradeName);
            if (gi >= 0) { arr.splice(gi, 1); if (!arr.length) arr.push(allGrades[0] || gradeName); } // keep at least one
            else arr.push(gradeName);
            // If all grades selected, set back to 'all'
            if (arr.length >= allGrades.length) sh.grades[divName] = 'all';
        }
        save(); renderShifts();
    }
    function setShiftGradeMode(shiftId, divName, mode) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return;
        if (!sh.grades) sh.grades = {};
        sh.grades[divName] = mode;
        save(); renderShifts();
    }
    function updateShiftTime(id, val) { const sh = D.shifts.find(s => s.id === id); if (sh) { sh.departureTime = val; save(); } }
    function renameShift(id, val) { const sh = D.shifts.find(s => s.id === id); if (sh) { sh.label = val.trim(); save(); } }

    // =========================================================================
    // STAFF (Monitors + Counselors) — same CRUD pattern as v1
    // =========================================================================
    function renderStaff() { renderMonitors(); renderCounselors(); document.getElementById('staffCount').textContent = (D.monitors.length + D.counselors.length) + ' staff'; }
    function renderMonitors() {
        const tbody = document.getElementById('monitorTableBody'), empty = document.getElementById('monitorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('monitorCount').textContent = D.monitors.length;
        if (!D.monitors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.monitors.map(m => { const bus = D.buses.find(b => b.id === m.assignedBus); return '<tr><td style="font-weight:600">' + esc(m.name) + '</td><td>' + (esc(m.address) || '—') + '</td><td>' + (esc(m.phone) || '—') + '</td><td>' + (bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + ';display:inline-block"></span>' + esc(bus.name) + '</span>' : '<span style="color:var(--text-muted)">—</span>') + '</td><td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editMonitor(\'' + m.id + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.deleteMonitor(\'' + m.id + '\')">×</button></div></td></tr>'; }).join('');
    }
    function renderCounselors() {
        const tbody = document.getElementById('counselorTableBody'), empty = document.getElementById('counselorEmptyState');
        const tw = tbody?.closest('.table-wrapper');
        document.getElementById('counselorCount').textContent = D.counselors.length;
        if (!D.counselors.length) { if (tw) tw.style.display = 'none'; if (empty) empty.style.display = ''; return; }
        if (tw) tw.style.display = ''; if (empty) empty.style.display = 'none';
        tbody.innerHTML = D.counselors.map(c => { const bus = D.buses.find(b => b.id === c.assignedBus); return '<tr><td style="font-weight:600">' + esc(c.name) + '</td><td>' + (esc(c.address) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (c.needsStop === 'yes' ? '<span class="badge badge-warning">Yes</span>' : '<span class="badge badge-neutral">No</span>') + '</td><td>' + (bus ? '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(bus.color) + ';display:inline-block"></span>' + esc(bus.name) + '</span>' : '—') + '</td><td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editCounselor(\'' + c.id + '\')">Edit</button><button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.deleteCounselor(\'' + c.id + '\')">×</button></div></td></tr>'; }).join('');
    }
    // Monitor CRUD
    function openMonitorModal(eId) { _editMonitorId = eId || null; document.getElementById('monitorModalTitle').textContent = eId ? 'Edit Monitor' : 'Add Monitor'; updateBusSelects(); const m = eId ? D.monitors.find(x => x.id === eId) : null; document.getElementById('monitorName').value = m?.name || ''; document.getElementById('monitorAddress').value = m?.address || ''; document.getElementById('monitorPhone').value = m?.phone || ''; document.getElementById('monitorBusAssign').value = m?.assignedBus || ''; openModal('monitorModal'); document.getElementById('monitorName').focus(); }
    function saveMonitor() { const n = document.getElementById('monitorName')?.value.trim(); if (!n) { toast('Enter name', 'error'); return; } const a = document.getElementById('monitorAddress')?.value.trim(), p = document.getElementById('monitorPhone')?.value.trim(), b = document.getElementById('monitorBusAssign')?.value || ''; if (_editMonitorId) { const m = D.monitors.find(x => x.id === _editMonitorId); if (m) { m.name = n; m.address = a; m.phone = p; m.assignedBus = b; } } else D.monitors.push({ id: uid(), name: n, address: a, phone: p, assignedBus: b }); save(); closeModal('monitorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editMonitorId ? 'Updated' : 'Monitor added'); }
    function editMonitor(id) { openMonitorModal(id); }
    function deleteMonitor(id) { const m = D.monitors.find(x => x.id === id); if (!m || !confirm('Delete "' + m.name + '"?')) return; D.monitors = D.monitors.filter(x => x.id !== id); save(); renderStaff(); renderFleet(); updateStats(); toast('Deleted'); }
    // Counselor CRUD
    function openCounselorModal(eId) { _editCounselorId = eId || null; document.getElementById('counselorModalTitle').textContent = eId ? 'Edit Counselor' : 'Add Counselor'; updateBusSelects(); const c = eId ? D.counselors.find(x => x.id === eId) : null; document.getElementById('counselorName').value = c?.name || ''; document.getElementById('counselorAddress').value = c?.address || ''; document.getElementById('counselorBunk').value = c?.bunk || ''; document.getElementById('counselorNeedsStop').value = c?.needsStop || 'no'; document.getElementById('counselorBusAssign').value = c?.assignedBus || ''; openModal('counselorModal'); document.getElementById('counselorName').focus(); }
    function saveCounselor() { const n = document.getElementById('counselorName')?.value.trim(); if (!n) { toast('Enter name', 'error'); return; } const a = document.getElementById('counselorAddress')?.value.trim(), b = document.getElementById('counselorBunk')?.value.trim(), ns = document.getElementById('counselorNeedsStop')?.value || 'no', bus = document.getElementById('counselorBusAssign')?.value || ''; if (_editCounselorId) { const c = D.counselors.find(x => x.id === _editCounselorId); if (c) { c.name = n; c.address = a; c.bunk = b; c.needsStop = ns; c.assignedBus = bus; } } else D.counselors.push({ id: uid(), name: n, address: a, bunk: b, needsStop: ns, assignedBus: bus }); save(); closeModal('counselorModal'); renderStaff(); renderFleet(); updateStats(); toast(_editCounselorId ? 'Updated' : 'Counselor added'); }
    function editCounselor(id) { openCounselorModal(id); }
    function deleteCounselor(id) { const c = D.counselors.find(x => x.id === id); if (!c || !confirm('Delete "' + c.name + '"?')) return; D.counselors = D.counselors.filter(x => x.id !== id); save(); renderStaff(); renderFleet(); updateStats(); toast('Deleted'); }

    // =========================================================================
    // ADDRESSES (auto-pull from Me, just manage geocoding)
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
        let withAddr = 0;
        names.forEach(n => { if (D.addresses[n]?.street) withAddr++; });
        updateAddrProgress(withAddr, names.length);
        tbody.innerHTML = filtered.map(n => {
            const c = roster[n], a = D.addresses[n];
            const hasA = a?.street;
            const full = hasA ? [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') : '';
            const badge = hasA ? (a.geocoded ? '<span class="badge badge-success">Geocoded</span>' : '<span class="badge badge-warning">Not geocoded</span>') : '<span class="badge badge-danger">Missing</span>';
            return '<tr><td style="font-weight:600">' + esc(n) + '</td><td>' + (esc(c.division) || '—') + '</td><td>' + (esc(c.bunk) || '—') + '</td><td>' + (full ? esc(full) : '<span style="color:var(--text-muted)">No address</span>') + '</td><td>' + badge + '</td><td><button class="btn btn-ghost btn-sm" onclick="CampistryGo.editAddress(\'' + esc(n.replace(/'/g, "\\'")) + '\')">' + (hasA ? 'Edit' : 'Add') + '</button></td></tr>';
        }).join('');
    }
    function updateAddrProgress(n, t) { const p = t > 0 ? Math.round(n / t * 100) : 0; document.getElementById('addressProgressBar').style.width = p + '%'; document.getElementById('addressProgressText').textContent = n + ' of ' + t + ' (' + p + '%)'; }
    function editAddress(name) {
        _editCamper = name; const roster = getRoster(), c = roster[name] || {}, a = D.addresses[name] || {};
        document.getElementById('addressCamperName').textContent = name;
        document.getElementById('addressCamperBunk').textContent = [c.division, c.bunk].filter(Boolean).join(' / ');
        document.getElementById('addrStreet').value = a.street || '';
        document.getElementById('addrCity').value = a.city || '';
        document.getElementById('addrState').value = a.state || 'NY';
        document.getElementById('addrZip').value = a.zip || '';
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

    // Geocoding
    async function geocodeOne(name) {
        const a = D.addresses[name]; if (!a?.street) return false;
        const key = getApiKey(); if (!key) return false;
        const q = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
        try {
            const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams({ text: q, size: '1', 'boundary.country': 'US' }), { headers: { 'Authorization': key, 'Accept': 'application/json' } });
            if (!r.ok) return false;
            const d = await r.json();
            if (d.features?.length) { const co = d.features[0].geometry.coordinates; a.lng = co[0]; a.lat = co[1]; a.geocoded = true; return true; }
        } catch (_) {}
        return false;
    }
    async function geocodeAll() {
        if (!getApiKey()) { toast('Set ORS key in Setup', 'error'); return; }
        const todo = Object.keys(D.addresses).filter(n => D.addresses[n]?.street && !D.addresses[n].geocoded);
        if (!todo.length) { toast('All geocoded!'); return; }
        toast('Geocoding ' + todo.length + ' addresses...');
        let ok = 0, fail = 0;
        const BATCH = 5; // 5 parallel requests per batch
        const DELAY = 2000; // 2 sec between batches (~150/min, well within limits)
        for (let i = 0; i < todo.length; i += BATCH) {
            const batch = todo.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(n => geocodeOne(n)));
            results.forEach(r => { if (r) ok++; else fail++; });
            // Update UI every batch
            renderAddresses(); updateStats();
            toast('Geocoded ' + (i + batch.length) + ' of ' + todo.length + '...');
            // Pause between batches (not after last one)
            if (i + BATCH < todo.length) await new Promise(r => setTimeout(r, DELAY));
        }
        save(); renderAddresses(); updateStats();
        toast(ok + ' geocoded' + (fail ? ', ' + fail + ' failed' : '') + ' — done!');
    }
    function downloadAddressTemplate() {
        const roster = getRoster(); const names = Object.keys(roster).sort();
        let csv = '\uFEFFName,Division,Bunk,Street Address,City,State,ZIP\n';
        names.forEach(n => { const c = roster[n], a = D.addresses[n] || {}; csv += [n, c.division || '', c.bunk || '', a.street || '', a.city || '', a.state || 'NY', a.zip || ''].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n'; });
        const blob = new Blob([csv], { type: 'text/csv' }); const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = 'campistry_go_addresses.csv'; el.click(); toast('Template downloaded');
    }
    function importAddressCsv() { const inp = document.getElementById('csvFileInput'); inp.onchange = function () { if (!inp.files[0]) return; const r = new FileReader(); r.onload = e => { parseCsv(e.target.result); inp.value = ''; }; r.readAsText(inp.files[0]); }; inp.click(); }
    function parseCsv(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) { toast('Empty CSV', 'error'); return; }
        const hdr = parseLine(lines[0]).map(h => h.toLowerCase().trim());
        const ni = hdr.findIndex(h => h === 'name' || h.includes('camper')), si = hdr.findIndex(h => h.includes('street') || h === 'address'), ci = hdr.findIndex(h => h === 'city'), sti = hdr.findIndex(h => h === 'state'), zi = hdr.findIndex(h => h === 'zip' || h.includes('zip'));
        if (ni < 0 || si < 0) { toast('Need Name + Street columns', 'error'); return; }
        const roster = getRoster(); let up = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = parseLine(lines[i]); const name = (cols[ni] || '').trim(); if (!name) continue;
            const rn = Object.keys(roster).find(k => k.toLowerCase() === name.toLowerCase()) || name;
            const street = (cols[si] || '').trim(); if (!street) continue;
            D.addresses[rn] = { street, city: ci >= 0 ? (cols[ci] || '').trim() : '', state: sti >= 0 ? (cols[sti] || '').trim().toUpperCase() : 'NY', zip: zi >= 0 ? (cols[zi] || '').trim() : '', lat: null, lng: null, geocoded: false }; up++;
        }
        save(); renderAddresses(); updateStats(); toast(up + ' addresses imported');
    }
    function parseLine(line) { const r = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; } else { if (ch === '"') inQ = true; else if (ch === ',' || ch === '\t') { r.push(cur); cur = ''; } else cur += ch; } } r.push(cur); return r; }

    // =========================================================================
    // STATS
    // =========================================================================
    function updateStats() {
        const roster = getRoster(); const c = Object.keys(roster).length; let wA = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.street) wA++; });
        document.getElementById('statBuses').textContent = D.buses.length;
        document.getElementById('statCampers').textContent = c;
        document.getElementById('statShifts').textContent = D.shifts.length;
        document.getElementById('statAddresses').textContent = wA + '/' + c;
    }

    // =========================================================================
    // PREFLIGHT
    // =========================================================================
    function runPreflight() {
        const roster = getRoster(); const camperCount = Object.keys(roster).length;
        let geocoded = 0; Object.keys(roster).forEach(n => { if (D.addresses[n]?.geocoded) geocoded++; });
        const rs = parseInt(document.getElementById('routeReserveSeats')?.value) || D.setup.reserveSeats || 0;
        let totalSeats = 0; D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); totalSeats += Math.max(0, (b.capacity || 0) - 1 - (m ? 1 : 0) - co.length - rs); });
        // Count campers in shifts (grade-aware)
        let inShifts = 0;
        Object.entries(roster).forEach(([n, c]) => { if (D.shifts.some(sh => camperMatchesShift(c, sh))) inShifts++; });
        const largestShift = D.shifts.length ? Math.max(...D.shifts.map(s => countCampersForShift(s))) : 0;
        const checks = [
            { label: D.buses.length + ' bus(es)', status: D.buses.length > 0 ? 'ok' : 'fail', detail: D.buses.length === 0 ? 'Add buses in Fleet tab' : '' },
            { label: D.shifts.length + ' shift(s) configured', status: D.shifts.length > 0 ? 'ok' : 'fail', detail: D.shifts.length === 0 ? 'Add shifts in Shifts tab' : '' },
            { label: inShifts + ' of ' + camperCount + ' campers assigned to shifts', status: inShifts === camperCount && camperCount > 0 ? 'ok' : inShifts > 0 ? 'warn' : 'fail', detail: inShifts < camperCount ? (camperCount - inShifts) + ' campers have no shift' : '' },
            { label: geocoded + ' of ' + camperCount + ' geocoded', status: geocoded === camperCount && camperCount > 0 ? 'ok' : geocoded > 0 ? 'warn' : 'fail', detail: geocoded < camperCount ? (camperCount - geocoded) + ' missing — will be skipped' : '' },
            { label: totalSeats + ' seats/shift for up to ' + largestShift + ' in largest shift', status: 'ok', detail: '' },
            { label: D.setup.campAddress ? 'Camp address set' : 'No camp address', status: D.setup.campAddress ? 'ok' : 'warn', detail: '' },
            { label: getApiKey() ? 'ORS key set' : 'No ORS key (will use estimates)', status: getApiKey() ? 'ok' : 'warn', detail: '' }
        ];
        const anyFail = checks.some(c => c.status === 'fail');
        const canGen = D.buses.length > 0 && D.shifts.length > 0 && geocoded > 0;
        const badge = document.getElementById('preflightStatus'); badge.className = 'badge ' + (anyFail ? 'badge-danger' : canGen ? 'badge-success' : 'badge-warning'); badge.textContent = anyFail ? 'Not ready' : 'Ready';
        document.getElementById('preflightBody').innerHTML = checks.map(c => '<div class="preflight-item preflight-' + c.status + '"><div class="preflight-icon">' + (c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗') + '</div><div><div style="font-weight:600;color:var(--text-primary)">' + esc(c.label) + '</div>' + (c.detail ? '<div style="font-size:.75rem;color:var(--text-muted)">' + esc(c.detail) + '</div>' : '') + '</div></div>').join('');
        document.getElementById('routeMode').value = D.setup.dropoffMode || 'door-to-door';
        document.getElementById('routeReserveSeats').value = D.setup.reserveSeats ?? 2;
        const btn = document.getElementById('generateRoutesBtn'); btn.disabled = !canGen; btn.style.opacity = canGen ? '1' : '0.5';
    }

    // =========================================================================
    // REGION DETECTION
    // =========================================================================
    const REGION_COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#8b5cf6','#14b8a6','#6366f1','#e11d48'];
    let _detectedRegions = null; // [{ id, name, color, centroidLat, centroidLng, camperNames }]
    let _detectedRadius = null; // auto-calculated clustering radius in miles
    let _busAssignments = null;  // { shiftId: { regionId: [busId, ...] } }

    function detectRegions() {
        const roster = getRoster();
        const allCampers = [];
        Object.keys(roster).forEach(name => {
            const a = D.addresses[name];
            if (a?.geocoded && a.lat && a.lng) {
                allCampers.push({ name, lat: a.lat, lng: a.lng, city: a.city || '', division: roster[name].division || '' });
            }
        });
        if (!allCampers.length) { toast('No geocoded campers', 'error'); return; }

        // AUTO-DETECT clustering radius from camper density
        // For each camper, find distance to their Kth nearest neighbor.
        // Sort those distances and find the "elbow" — where the gap jumps.
        // Dense NYC neighborhoods → small radius. Spread-out suburbs → large radius.
        const K = Math.min(5, Math.max(2, Math.floor(allCampers.length * 0.05))); // 5% of campers, min 2, max 5
        const knnDistances = [];
        allCampers.forEach(c => {
            const dists = [];
            allCampers.forEach(o => {
                if (o.name === c.name) return;
                dists.push(haversineMi(c.lat, c.lng, o.lat, o.lng));
            });
            dists.sort((a, b) => a - b);
            if (dists.length >= K) knnDistances.push(dists[K - 1]);
            else if (dists.length) knnDistances.push(dists[dists.length - 1]);
        });
        knnDistances.sort((a, b) => a - b);

        // Find the elbow: biggest jump in the sorted knn distances
        let threshold;
        if (knnDistances.length < 3) {
            threshold = knnDistances.length ? knnDistances[knnDistances.length - 1] * 1.5 : 1.0;
        } else {
            // Calculate gaps between consecutive sorted distances
            let maxGapIdx = 0, maxGap = 0;
            for (let i = 1; i < knnDistances.length; i++) {
                const gap = knnDistances[i] - knnDistances[i - 1];
                if (gap > maxGap) { maxGap = gap; maxGapIdx = i; }
            }
            // Threshold = the value just before the biggest gap (the "elbow")
            // This separates "within-region" distances from "between-region" distances
            threshold = knnDistances[maxGapIdx];
            // Safety floor/ceiling: at least 0.1 mi, at most 20 mi
            threshold = Math.max(0.1, Math.min(20, threshold));
        }

        console.log('[Go] Auto-detected region radius:', threshold.toFixed(2), 'miles (K=' + K + ', campers=' + allCampers.length + ')');

        // DBSCAN-style clustering with adaptive threshold
        const assigned = new Set();
        const clusters = [];

        // Sort by lat for spatial locality
        allCampers.sort((a, b) => a.lat - b.lat);

        allCampers.forEach(camper => {
            if (assigned.has(camper.name)) return;
            const cluster = [camper];
            assigned.add(camper.name);

            // BFS expansion: find all campers within threshold of any cluster member
            let frontier = [camper];
            while (frontier.length) {
                const nextFrontier = [];
                allCampers.forEach(other => {
                    if (assigned.has(other.name)) return;
                    for (const f of frontier) {
                        if (haversineMi(f.lat, f.lng, other.lat, other.lng) <= threshold) {
                            cluster.push(other);
                            assigned.add(other.name);
                            nextFrontier.push(other);
                            break;
                        }
                    }
                });
                frontier = nextFrontier;
            }

            // Name the cluster by most common city
            const cities = {};
            cluster.forEach(c => { if (c.city) cities[c.city] = (cities[c.city] || 0) + 1; });
            const regionName = Object.keys(cities).sort((a, b) => cities[b] - cities[a])[0] || 'Region ' + (clusters.length + 1);
            const cLat = cluster.reduce((s, c) => s + c.lat, 0) / cluster.length;
            const cLng = cluster.reduce((s, c) => s + c.lng, 0) / cluster.length;

            clusters.push({
                id: 'reg_' + clusters.length,
                name: regionName,
                color: REGION_COLORS[clusters.length % REGION_COLORS.length],
                centroidLat: cLat, centroidLng: cLng,
                camperNames: cluster.map(c => c.name)
            });
        });

        // Merge tiny clusters (< 3 campers) into nearest larger cluster
        const merged = [];
        const tiny = clusters.filter(c => c.camperNames.length < 3);
        const big = clusters.filter(c => c.camperNames.length >= 3);

        if (big.length === 0) {
            // All small — just keep them
            merged.push(...clusters);
        } else {
            merged.push(...big);
            tiny.forEach(t => {
                let nearest = big[0], nearDist = Infinity;
                big.forEach(b => {
                    const d = haversineMi(t.centroidLat, t.centroidLng, b.centroidLat, b.centroidLng);
                    if (d < nearDist) { nearDist = d; nearest = b; }
                });
                nearest.camperNames.push(...t.camperNames);
                // Recalculate centroid
                const allNames = nearest.camperNames;
                let sLat = 0, sLng = 0, cnt = 0;
                allNames.forEach(n => { const a = D.addresses[n]; if (a?.lat) { sLat += a.lat; sLng += a.lng; cnt++; } });
                if (cnt) { nearest.centroidLat = sLat / cnt; nearest.centroidLng = sLng / cnt; }
            });
        }

        _detectedRegions = merged;
        _detectedRadius = threshold;
        renderRegionPreview();
        toast(merged.length + ' region' + (merged.length !== 1 ? 's' : '') + ' detected (radius: ' + threshold.toFixed(1) + ' mi)');
    }

    function renderRegionPreview() {
        const body = document.getElementById('regionPreviewBody');
        if (!_detectedRegions?.length) { body.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text-muted);font-size:.875rem;">No regions detected yet</div>'; return; }

        const roster = getRoster();
        const rs = parseInt(document.getElementById('routeReserveSeats')?.value) || D.setup.reserveSeats || 0;
        // Calculate per-bus capacity
        let perBusCap = 0;
        if (D.buses.length) {
            let totalCap = 0;
            D.buses.forEach(b => { const m = D.monitors.find(x => x.assignedBus === b.id); const co = D.counselors.filter(x => x.assignedBus === b.id); totalCap += Math.max(0, (b.capacity || 0) - 1 - (m ? 1 : 0) - co.length - rs); });
            perBusCap = Math.floor(totalCap / D.buses.length);
        }

        let html = '';
        _detectedRegions.forEach(reg => {
            // Count per-shift
            const shiftCounts = {};
            D.shifts.forEach(sh => {
                let count = 0;
                reg.camperNames.forEach(n => { const c = roster[n]; if (c && camperMatchesShift(c, sh)) count++; });
                shiftCounts[sh.id] = count;
            });

            const shiftBadges = D.shifts.map(sh => {
                const cnt = shiftCounts[sh.id] || 0;
                const busesNeeded = perBusCap > 0 ? Math.ceil(cnt / perBusCap) : '?';
                return '<span class="region-shift-badge">' + esc(sh.label || 'Shift') + ': <strong>' + cnt + '</strong> kids → <span class="region-buses">' + busesNeeded + ' bus' + (busesNeeded !== 1 ? 'es' : '') + '</span></span>';
            }).join('');

            html += '<div class="region-row"><span class="region-dot" style="background:' + esc(reg.color) + '"></span><span class="region-name">' + esc(reg.name) + '</span><span style="font-weight:600;min-width:40px;text-align:center">' + reg.camperNames.length + '</span><div class="region-counts">' + shiftBadges + '</div></div>';
        });

        // Summary
        const totalRegions = _detectedRegions.length;
        const totalBuses = D.buses.length;
        html = '<div style="margin-bottom:.75rem;font-size:.8125rem;color:var(--text-secondary);"><strong>' + totalRegions + '</strong> geographic region' + (totalRegions !== 1 ? 's' : '') + ' auto-detected from <strong>' + _detectedRegions.reduce((s, r) => s + r.camperNames.length, 0) + '</strong> addresses using a <strong>' + (_detectedRadius ? _detectedRadius.toFixed(1) : '?') + ' mi</strong> clustering radius (calculated from address density). <strong>' + totalBuses + '</strong> bus(es) available.</div>' + html;

        body.innerHTML = html;
    }

    // =========================================================================
    // STABLE BUS-TO-REGION ASSIGNMENT ACROSS SHIFTS
    // =========================================================================
    function assignBusesToRegions(vehicles, regions, shifts) {
        const roster = getRoster();
        const perBusCap = vehicles.length ? Math.floor(vehicles.reduce((s, v) => s + v.capacity, 0) / vehicles.length) : 30;

        // Build demand matrix: for each shift, how many buses does each region need?
        const demand = {}; // { shiftId: { regionId: busesNeeded } }
        shifts.forEach(sh => {
            demand[sh.id] = {};
            regions.forEach(reg => {
                let count = 0;
                reg.camperNames.forEach(n => { const c = roster[n]; if (c && camperMatchesShift(c, sh)) count++; });
                demand[sh.id][reg.id] = Math.ceil(count / Math.max(1, perBusCap));
            });
        });

        // Assignment: { shiftId: { regionId: [busId, ...] } }
        const assignments = {};
        let prevAssign = {}; // { busId: regionId } — from previous shift

        shifts.forEach((sh, si) => {
            assignments[sh.id] = {};
            regions.forEach(reg => { assignments[sh.id][reg.id] = []; });

            const needed = demand[sh.id];
            const currAssign = {}; // { busId: regionId } — for this shift
            const usedBuses = new Set();

            if (si === 0) {
                // Shift 1: assign buses greedily by region size (largest first)
                const regionsBySize = [...regions].sort((a, b) => (needed[b.id] || 0) - (needed[a.id] || 0));
                let busIdx = 0;
                regionsBySize.forEach(reg => {
                    const n = needed[reg.id] || 0;
                    for (let i = 0; i < n && busIdx < vehicles.length; i++) {
                        const v = vehicles[busIdx];
                        assignments[sh.id][reg.id].push(v.busId);
                        currAssign[v.busId] = reg.id;
                        usedBuses.add(v.busId);
                        busIdx++;
                    }
                });
                // Any leftover buses: assign to largest unmet demand
                while (busIdx < vehicles.length) {
                    const v = vehicles[busIdx];
                    const bestReg = regions.reduce((best, reg) => (needed[reg.id] || 0) > (needed[best.id] || 0) ? reg : best, regions[0]);
                    assignments[sh.id][bestReg.id].push(v.busId);
                    currAssign[v.busId] = bestReg.id;
                    busIdx++;
                }
            } else {
                // Shift 2+: MAXIMIZE STABILITY
                // Step 1: Keep buses in same region if still needed
                const remaining = { ...needed }; // copy
                vehicles.forEach(v => {
                    const prevRegion = prevAssign[v.busId];
                    if (prevRegion && remaining[prevRegion] > 0) {
                        assignments[sh.id][prevRegion].push(v.busId);
                        currAssign[v.busId] = prevRegion;
                        usedBuses.add(v.busId);
                        remaining[prevRegion]--;
                    }
                });

                // Step 2: Assign freed buses to regions that still need more
                // Sort unassigned buses by their previous region's centroid distance to needy regions
                const unassigned = vehicles.filter(v => !usedBuses.has(v.busId));
                const needyRegions = regions.filter(r => (remaining[r.id] || 0) > 0);

                // For each needy region, find closest unassigned bus (by previous region proximity)
                needyRegions.forEach(reg => {
                    while ((remaining[reg.id] || 0) > 0 && unassigned.length > 0) {
                        // Find unassigned bus whose previous region centroid is closest to this region
                        let bestIdx = 0, bestDist = Infinity;
                        unassigned.forEach((v, i) => {
                            const prevReg = prevAssign[v.busId];
                            const prevRegObj = prevReg ? regions.find(r => r.id === prevReg) : null;
                            const d = prevRegObj ? haversineMi(prevRegObj.centroidLat, prevRegObj.centroidLng, reg.centroidLat, reg.centroidLng) : 999;
                            if (d < bestDist) { bestDist = d; bestIdx = i; }
                        });
                        const v = unassigned.splice(bestIdx, 1)[0];
                        assignments[sh.id][reg.id].push(v.busId);
                        currAssign[v.busId] = reg.id;
                        remaining[reg.id]--;
                    }
                });

                // Step 3: Any still-unassigned buses go to biggest region
                unassigned.forEach(v => {
                    const biggest = regions.reduce((best, r) => (needed[r.id] || 0) > (needed[best.id] || 0) ? r : best, regions[0]);
                    assignments[sh.id][biggest.id].push(v.busId);
                    currAssign[v.busId] = biggest.id;
                });
            }

            prevAssign = currAssign;
        });

        _busAssignments = assignments;
        return assignments;
    }

    // =========================================================================
    // MULTI-SHIFT ROUTE GENERATION (Region-based)
    // =========================================================================
    async function generateRoutes() {
        const roster = getRoster();
        const mode = document.getElementById('routeMode')?.value || 'door-to-door';
        const reserveSeats = parseInt(document.getElementById('routeReserveSeats')?.value) || 0;
        const avgStopMin = D.setup.avgStopTime || 2;
        const avgSpeedMph = D.setup.avgSpeed || 25;

        // Auto-detect regions if not done yet
        if (!_detectedRegions?.length) detectRegions();
        if (!_detectedRegions?.length) { toast('No regions detected', 'error'); return; }

        // Build vehicles with effective capacities
        const vehicles = D.buses.map(b => {
            const mon = D.monitors.find(m => m.assignedBus === b.id);
            const couns = D.counselors.filter(c => c.assignedBus === b.id);
            return { busId: b.id, name: b.name, color: b.color || '#10b981', capacity: Math.max(0, (b.capacity || 0) - 1 - (mon ? 1 : 0) - couns.length - reserveSeats), monitor: mon, counselors: couns };
        });

        // Geocode camp
        let campCoords = null;
        if (getApiKey() && D.setup.campAddress) {
            showProgress('Geocoding camp...', 5);
            campCoords = await geocodeSingle(D.setup.campAddress);
            if (campCoords) {
                _campCoordsCache = campCoords;
                D.setup.campLat = campCoords.lat;
                D.setup.campLng = campCoords.lng;
            }
        }
        const campLat = campCoords?.lat || _detectedRegions[0].centroidLat;
        const campLng = campCoords?.lng || _detectedRegions[0].centroidLng;

        // Assign buses to regions with stability
        showProgress('Assigning buses to regions...', 10);
        const assignments = assignBusesToRegions(vehicles, _detectedRegions, D.shifts);

        const allShiftResults = [];

        for (let si = 0; si < D.shifts.length; si++) {
            const shift = D.shifts[si];
            const pctBase = (si / D.shifts.length) * 100;
            showProgress('Shift ' + (si + 1) + ': ' + (shift.label || '') + '...', pctBase + 15);

            const divSet = new Set(shift.divisions || []);
            const routes = [];

            // For each region, build routes with assigned buses
            _detectedRegions.forEach(reg => {
                const busIds = assignments[shift.id]?.[reg.id] || [];
                if (!busIds.length) return;

                const campers = [];
                reg.camperNames.forEach(name => {
                    const c = roster[name]; const a = D.addresses[name];
                    if (c && camperMatchesShift(c, shift) && a?.geocoded && a.lat && a.lng) {
                        campers.push({ name, division: c.division, bunk: c.bunk || '', lat: a.lat, lng: a.lng, address: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') });
                    }
                });
                if (!campers.length) return;

                // Split campers across assigned buses for this region
                const regionVehicles = busIds.map(bid => vehicles.find(v => v.busId === bid)).filter(Boolean);
                const regionRoutes = clientSideCluster(campers, regionVehicles, campLat, campLng, mode);
                routes.push(...regionRoutes);
            });

            // Add monitor + counselor stops
            routes.forEach(r => {
                if (r.monitor?.address) r.stops.push({ stopNum: r.stops.length + 1, campers: [], address: r.monitor.address, lat: null, lng: null, isMonitor: true, monitorName: r.monitor.name });
                r.counselors.filter(c => c.needsStop === 'yes' && c.address).forEach(c => { r.stops.push({ stopNum: r.stops.length + 1, campers: [], address: c.address, lat: null, lng: null, isCounselor: true, counselorName: c.name }); });
            });

            // Calculate drop-off times (mph based)
            const depMin = parseTime(shift.departureTime || '16:00');
            routes.forEach(r => {
                let cum = depMin;
                r.stops.forEach((stop, i) => {
                    if (i === 0) { cum += 15; }
                    else { const prev = r.stops[i - 1]; if (stop.lat && prev.lat) { const mi = haversineMi(prev.lat, prev.lng, stop.lat, stop.lng); cum += (mi / avgSpeedMph) * 60; } else cum += 3; }
                    cum += avgStopMin;
                    stop.estimatedTime = formatTime(cum);
                    stop.estimatedMin = cum;
                });
                r.totalDuration = Math.round(cum - depMin);
                r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);
            });

            allShiftResults.push({ shift, routes, camperCount: routes.reduce((s, r) => s + r.camperCount, 0) });
        }

        _generatedRoutes = allShiftResults;
        _routeGeomCache = {}; // clear road geometry cache for fresh routes
        D.savedRoutes = allShiftResults;
        save(); // persist routes across reloads
        showProgress('Done!', 100);
        setTimeout(() => { hideProgress(); renderRouteResults(applyOverrides(allShiftResults)); }, 400);
    }

    // =========================================================================
    // CLIENT-SIDE CLUSTERING (within a region)
    // =========================================================================
    function clientSideCluster(campers, vehicles, campLat, campLng, mode) {
        let jobs = campers;
        if (mode === 'optimized-stops') {
            const maxWalkMi = (D.setup.maxWalkDistance || 500) * 0.000189394;
            const clusters = []; const used = new Set();
            const sorted = [...campers].sort((a, b) => a.lat - b.lat);
            sorted.forEach(c => { if (used.has(c.name)) return; const cl = [c]; used.add(c.name); sorted.forEach(o => { if (used.has(o.name)) return; if (haversineMi(c.lat, c.lng, o.lat, o.lng) <= maxWalkMi) { cl.push(o); used.add(o.name); } }); const cLat = cl.reduce((s, x) => s + x.lat, 0) / cl.length, cLng = cl.reduce((s, x) => s + x.lng, 0) / cl.length;
                // Find the camper whose house is closest to the centroid
                let nearestAddr = cl[0].address, nearestDist = Infinity;
                cl.forEach(x => { const d = haversineMi(cLat, cLng, x.lat, x.lng); if (d < nearestDist) { nearestDist = d; nearestAddr = x.address; } });
                clusters.push({ lat: cLat, lng: cLng, address: nearestAddr, campers: cl.map(x => ({ name: x.name, division: x.division, bunk: x.bunk })), _count: cl.length }); });
            jobs = clusters;
        } else {
            // Door-to-door: merge campers at same address (siblings, neighbors)
            // Two campers within 0.02 mi (~100ft) share a stop
            const addrGroups = {};
            campers.forEach(c => {
                const key = Math.round(c.lat * 1000) + ',' + Math.round(c.lng * 1000); // ~300ft grid
                if (!addrGroups[key]) addrGroups[key] = [];
                addrGroups[key].push(c);
            });
            jobs = Object.values(addrGroups).map(group => ({
                lat: group[0].lat, lng: group[0].lng,
                address: group[0].address,
                campers: group.map(c => ({ name: c.name, division: c.division, bunk: c.bunk })),
                _count: group.length
            }));
        }

        const withAngle = jobs.map(j => ({ ...j, _angle: angleTo(campLat, campLng, j.lat, j.lng) }));
        withAngle.sort((a, b) => a._angle - b._angle);

        const routes = vehicles.map(v => ({ busId: v.busId, busName: v.name, busColor: v.color, monitor: v.monitor, counselors: v.counselors || [], stops: [], camperCount: 0, _cap: v.capacity, totalDuration: 0 }));
        if (!routes.length) return routes;

        let bi = 0;
        withAngle.forEach(job => {
            let tries = 0;
            while (tries < routes.length) {
                const r = routes[bi % routes.length];
                if (r.camperCount + job._count <= r._cap) { r.stops.push({ stopNum: r.stops.length + 1, campers: job.campers, address: job.address, lat: job.lat, lng: job.lng }); r.camperCount += job._count; break; }
                bi++; tries++;
            }
            if (tries >= routes.length) { const last = routes[routes.length - 1]; last.stops.push({ stopNum: last.stops.length + 1, campers: job.campers, address: job.address, lat: job.lat, lng: job.lng }); last.camperCount += job._count; }
        });

        // Nearest-neighbor reorder
        routes.forEach(r => {
            if (r.stops.length < 2) return;
            const ordered = []; const rem = [...r.stops]; let cLat = campLat, cLng = campLng;
            while (rem.length) { let ni = 0, nd = Infinity; rem.forEach((s, i) => { const d = haversineMi(cLat, cLng, s.lat, s.lng); if (d < nd) { nd = d; ni = i; } }); const nx = rem.splice(ni, 1)[0]; nx.stopNum = ordered.length + 1; ordered.push(nx); cLat = nx.lat; cLng = nx.lng; }
            r.stops = ordered;
        });

        return routes;
    }

    async function geocodeSingle(addr) {
        const key = getApiKey(); if (!key) return null;
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams({ text: addr, size: '1', 'boundary.country': 'US' }), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return null; const d = await r.json(); if (d.features?.length) { const co = d.features[0].geometry.coordinates; return { lat: co[1], lng: co[0] }; } } catch (_) {} return null;
    }

    function showProgress(label, pct) { const c = document.getElementById('routeProgressCard'); c.style.display = ''; document.getElementById('routeProgressLabel').textContent = label; document.getElementById('routeProgressPct').textContent = Math.round(pct) + '%'; document.getElementById('routeProgressBar').style.width = pct + '%'; }
    function hideProgress() { document.getElementById('routeProgressCard').style.display = 'none'; }

    // =========================================================================
    // RENDER ROUTE RESULTS
    // =========================================================================
    function renderRouteResults(allShifts) {
        document.getElementById('routeResults').style.display = '';

        // Update generate button to show "Regenerate"
        const btnLabel = document.getElementById('generateBtnLabel');
        if (btnLabel) btnLabel.textContent = 'Regenerate Routes';

        // Bus assignment table (in dedicated container)
        const assignEl = document.getElementById('busAssignmentTable');
        if (assignEl && _busAssignments && _detectedRegions) {
            let ah = '<div style="font-size:.8125rem;color:var(--text-muted);margin-bottom:.5rem">Buses stay in the same region across shifts. Changes highlighted with ⚡</div>';
            ah += '<div class="table-wrapper"><table class="data-table"><thead><tr><th>Bus</th>';
            D.shifts.forEach(sh => { ah += '<th>' + esc(sh.label || 'Shift') + '</th>'; });
            ah += '</tr></thead><tbody>';
            D.buses.forEach(b => {
                ah += '<tr><td style="font-weight:600"><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(b.color) + ';display:inline-block"></span>' + esc(b.name) + '</span></td>';
                let prevRegion = null;
                D.shifts.forEach(sh => {
                    const regionId = Object.keys(_busAssignments[sh.id] || {}).find(rid => (_busAssignments[sh.id][rid] || []).includes(b.id));
                    const reg = _detectedRegions.find(r => r.id === regionId);
                    const changed = prevRegion && regionId !== prevRegion;
                    ah += '<td style="' + (changed ? 'background:var(--amber-50);font-weight:700;color:var(--amber-700)' : '') + '">' + (reg ? '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:' + esc(reg.color) + ';display:inline-block"></span>' + esc(reg.name) + '</span>' : '—') + (changed ? ' ⚡' : '') + '</td>';
                    prevRegion = regionId;
                });
                ah += '</tr>';
            });
            ah += '</tbody></table></div>';
            assignEl.innerHTML = ah;
        }

        // Shift route cards (each shift is a collapsible section)
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
                    const isCamperStop = !st.isMonitor && !st.isCounselor;
                    const names = st.isMonitor ? '🛡️ ' + esc(st.monitorName) + ' (Monitor)' : st.isCounselor ? '👤 ' + esc(st.counselorName) + ' (Counselor)' : st.campers.map(c => '<span style="display:inline-flex;align-items:center;gap:2px;">' + esc(c.name) + ' <button onclick="CampistryGo.openMoveModal(\'' + esc(c.name.replace(/'/g, "\\'")) + '\',\'' + r.busId + '\',' + si + ')" style="background:none;border:none;cursor:pointer;padding:0 2px;color:var(--text-muted);font-size:10px;" title="Move to another bus">↔</button></span>').join(', ');
                    const cls = st.isMonitor ? ' monitor-stop' : st.isCounselor ? ' counselor-stop' : '';
                    html += '<li class="route-stop' + cls + '"><div class="route-stop-num" style="background:' + esc(r.busColor) + '">' + st.stopNum + '</div><div class="route-stop-info"><div class="route-stop-names">' + names + '</div><div class="route-stop-addr">' + esc(st.address) + '</div></div><div class="route-stop-time">' + (st.estimatedTime || '—') + '</div></li>';
                });
                html += '</ul><div class="route-card-footer"><span>' + (r.monitor ? '🛡️ ' + esc(r.monitor.name) : '') + '</span><span>' + (r.counselors.length ? r.counselors.length + ' counselor(s)' : '') + '</span></div></div>';
            });
            html += '</div></div></details>';
        });

        container.innerHTML = html;
        renderMasterList(allShifts);
        // Only init map if routes tab is visible; otherwise defer to tab switch
        const routesTab = document.getElementById('tab-routes');
        if (routesTab && routesTab.classList.contains('active')) {
            setTimeout(() => initMap(allShifts), 100);
        } else {
            _pendingMapInit = allShifts;
        }
    }

    function renderMasterList(allShifts) {
        _allMasterRows = [];
        allShifts.forEach((sr, si) => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); _allMasterRows.push({ firstName: p[0] || '', lastName: p.slice(1).join(' ') || '', shift: sr.shift.label || '', shiftIdx: si, busName: r.busName, busId: r.busId, busColor: r.busColor, stopNum: st.stopNum, address: st.address, time: st.estimatedTime || '—' }); }); }); }); });
        _allMasterRows.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
        renderFilteredMasterList();
    }

    let _allMasterRows = [];

    function renderFilteredMasterList() {
        let rows = _allMasterRows;
        // Filter by active shifts
        if (_activeShifts && _activeShifts.size < (_generatedRoutes?.length || 0)) {
            rows = rows.filter(r => _activeShifts.has(r.shiftIdx));
        }
        // Filter by active bus
        if (_activeMapBus && _activeMapBus !== 'all') {
            rows = rows.filter(r => r.busId === _activeMapBus);
        }
        const countEl = document.getElementById('masterListCount');
        const label = document.getElementById('masterListLabel');
        if (countEl) countEl.textContent = rows.length + (rows.length < _allMasterRows.length ? ' of ' + _allMasterRows.length : '');
        if (label) {
            if (rows.length < _allMasterRows.length) label.textContent = 'Master Drop-off List (filtered)';
            else label.textContent = 'Master Drop-off List';
        }
        document.getElementById('masterListBody').innerHTML = rows.map(r => '<tr><td style="font-weight:600">' + esc(r.firstName) + '</td><td style="font-weight:600">' + esc(r.lastName) + '</td><td>' + esc(r.shift) + '</td><td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(r.busColor) + ';display:inline-block"></span>' + esc(r.busName) + '</span></td><td style="font-weight:700;text-align:center">' + r.stopNum + '</td><td>' + esc(r.address) + '</td><td style="font-weight:600">' + r.time + '</td></tr>').join('');
    }

    // =========================================================================
    // ROUTE MAP (Leaflet)
    // =========================================================================
    let _map = null;
    let _mapLayers = [];
    let _activeShifts = new Set(); // set of shift indices to show
    let _activeMapBus = 'all';
    let _pendingMapInit = null;
    let _routeGeomCache = {}; // cache road geometry to avoid re-fetching

    function initMap(allShifts) {
        _activeShifts = new Set(allShifts.map((_, i) => i));
        _activeMapBus = 'all';

        const container = document.getElementById('routeMap');
        if (_map) { _map.remove(); _map = null; }
        _map = L.map(container, { scrollWheelZoom: true, zoomControl: true });

        // Map layers: Street + Satellite
        const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
            maxZoom: 19
        });
        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '&copy; Esri',
            maxZoom: 19
        });
        streetLayer.addTo(_map);
        L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }, null, { position: 'topright', collapsed: true }).addTo(_map);

        renderMap();
    }

    async function renderMap() {
        if (!_map || !_generatedRoutes) return;

        const shiftIndices = [..._activeShifts].sort();
        const multiShift = shiftIndices.length > 1;
        const totalShifts = _generatedRoutes.length;

        // Render shift toggle buttons
        const shiftBar = document.getElementById('mapShiftSelect');
        if (shiftBar) {
            const allActive = shiftIndices.length === totalShifts;
            shiftBar.innerHTML = '<button class="bus-tab all-tab' + (allActive ? ' active' : '') + '" onclick="CampistryGo.setMapShiftsAll()">All Shifts</button>' +
                _generatedRoutes.map((sr, i) => '<button class="bus-tab' + (_activeShifts.has(i) ? ' active' : '') + '" style="' + (_activeShifts.has(i) ? 'border-bottom-color:var(--blue-600);color:var(--text-primary);' : '') + '" onclick="CampistryGo.toggleMapShift(' + i + ')"><span class="shift-num" style="width:20px;height:20px;font-size:.65rem;">' + (i + 1) + '</span>' + esc(sr.shift.label || 'Shift ' + (i + 1)) + '</button>').join('');
        }

        // Collect all routes across selected shifts
        const allRoutes = [];
        shiftIndices.forEach(si => {
            const sr = _generatedRoutes[si];
            if (!sr) return;
            sr.routes.filter(r => r.stops.length > 0).forEach(r => {
                allRoutes.push({ ...r, shiftIdx: si, shiftLabel: sr.shift.label || 'Shift ' + (si + 1) });
            });
        });

        // Build bus tabs
        const tabsEl = document.getElementById('mapBusTabs');
        const uniqueBuses = [];
        const seen = new Set();
        allRoutes.forEach(r => { if (!seen.has(r.busId)) { seen.add(r.busId); uniqueBuses.push({ busId: r.busId, busName: r.busName, busColor: r.busColor }); } });
        tabsEl.innerHTML = '<button class="bus-tab all-tab' + (_activeMapBus === 'all' ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'all\')">All Buses</button>' +
            uniqueBuses.map(b => '<button class="bus-tab' + (_activeMapBus === b.busId ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'' + b.busId + '\')"><span class="bus-tab-dot" style="background:' + esc(b.busColor) + '"></span>' + esc(b.busName) + '</button>').join('');

        // Clear layers
        _mapLayers.forEach(l => _map.removeLayer(l));
        _mapLayers = [];
        const allLatLngs = [];

        // Camp origin marker (always visible)
        if (_campCoordsCache) {
            const campIcon = L.divIcon({
                html: '<div style="width:32px;height:32px;background:#1e293b;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.4);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>',
                className: '', iconSize: [32, 32], iconAnchor: [16, 16]
            });
            const campMarker = L.marker([_campCoordsCache.lat, _campCoordsCache.lng], { icon: campIcon, zIndexOffset: 1000 }).addTo(_map);
            campMarker.bindPopup('<div style="font-family:DM Sans,sans-serif;"><strong>' + esc(D.setup.campName || 'Camp') + '</strong><br><span style="font-size:11px;color:#888;">' + esc(D.setup.campAddress) + '</span><br><span style="font-size:11px;font-weight:600;">Starting Point</span></div>');
            _mapLayers.push(campMarker);
            allLatLngs.push([_campCoordsCache.lat, _campCoordsCache.lng]);
        }

        const visibleRoutes = _activeMapBus === 'all' ? allRoutes : allRoutes.filter(r => r.busId === _activeMapBus);

        // Dash rules: 1 shift=solid. 2 shifts: 1=solid, 2=long dash. 3+: 1=solid, 2=long, 3+=short
        function getDash(shiftIdx) {
            if (totalShifts <= 1 || !multiShift) return null;
            if (shiftIdx === 0) return null;
            if (shiftIdx === 1) return '18, 12';
            return '6, 10';
        }

        for (const route of visibleRoutes) {
            const stopsWithCoords = route.stops.filter(s => s.lat && s.lng);
            if (!stopsWithCoords.length) continue;

            // Full route: camp → stops → camp
            const straightCoords = [];
            if (_campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            stopsWithCoords.forEach(s => straightCoords.push([s.lat, s.lng]));
            if (_campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
            allLatLngs.push(...straightCoords);

            const dashPattern = getDash(route.shiftIdx);
            const lineWeight = _activeMapBus === 'all' ? 3 : 5;
            const lineOpacity = _activeMapBus === 'all' ? 0.7 : 0.9;
            const cacheKey = route.busId + '_' + route.shiftIdx;
            let roadCoords = _routeGeomCache[cacheKey];

            if (roadCoords) {
                const polyline = L.polyline(roadCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity, dashArray: dashPattern }).addTo(_map);
                polyline._goRouteKey = cacheKey;
                _mapLayers.push(polyline);
            } else {
                // Draw straight lines first (faded), fetch road geometry in background
                const tempLine = L.polyline(straightCoords, { color: route.busColor, weight: lineWeight, opacity: lineOpacity * 0.4, dashArray: dashPattern }).addTo(_map);
                tempLine._goRouteKey = cacheKey;
                _mapLayers.push(tempLine);

                if (getApiKey() && straightCoords.length >= 2) {
                    const wp = [];
                    if (_campCoordsCache) wp.push([_campCoordsCache.lng, _campCoordsCache.lat]);
                    stopsWithCoords.forEach(s => wp.push([s.lng, s.lat]));
                    if (_campCoordsCache) wp.push([_campCoordsCache.lng, _campCoordsCache.lat]);

                    (async function(waypoints, color, ck, temp, dash, w, o) {
                        try {
                            const MAX_WP = 50;
                            let pts = [];
                            for (let i = 0; i < waypoints.length - 1; i += MAX_WP - 1) {
                                const chunk = waypoints.slice(i, i + MAX_WP);
                                if (chunk.length < 2) break;
                                const resp = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
                                    method: 'POST',
                                    headers: {
                                        'Authorization': getApiKey(),
                                        'Content-Type': 'application/json; charset=utf-8',
                                        'Accept': 'application/json, application/geo+json'
                                    },
                                    body: JSON.stringify({ coordinates: chunk, radiuses: chunk.map(() => 1000) })
                                });
                                if (resp.ok) {
                                    const data = await resp.json();
                                    let seg = null;
                                    // GeoJSON format (features array)
                                    if (data.features?.[0]?.geometry?.coordinates) {
                                        seg = data.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
                                    }
                                    // Standard format (encoded polyline)
                                    else if (data.routes?.[0]?.geometry) {
                                        const geom = data.routes[0].geometry;
                                        if (typeof geom === 'string') {
                                            seg = decodePolyline(geom);
                                        } else if (geom.coordinates) {
                                            seg = geom.coordinates.map(c => [c[1], c[0]]);
                                        }
                                    }
                                    if (seg && seg.length > 0) {
                                        pts.push(...(pts.length ? seg.slice(1) : seg));
                                    } else {
                                        console.warn('[Go] No geometry in response:', Object.keys(data));
                                    }
                                } else {
                                    console.warn('[Go] Directions API:', resp.status, await resp.text().catch(() => ''));
                                    return;
                                }
                                if (i + MAX_WP - 1 < waypoints.length - 1) await new Promise(r => setTimeout(r, 250));
                            }
                            if (pts.length > 0 && _map) {
                                console.log('[Go] Road geometry for', ck, ':', pts.length, 'points');
                                _routeGeomCache[ck] = pts;
                                _map.removeLayer(temp);
                                const idx = _mapLayers.indexOf(temp);
                                if (idx >= 0) _mapLayers.splice(idx, 1);
                                const road = L.polyline(pts, { color: color, weight: w, opacity: o, dashArray: dash }).addTo(_map);
                                road._goRouteKey = ck;
                                _mapLayers.push(road);
                            }
                        } catch (e) { console.warn('[Go] Directions failed:', e.message); }
                    })(wp, route.busColor, cacheKey, tempLine, dashPattern, lineWeight, lineOpacity);
                }
            }

            // Stop markers (draggable)
            stopsWithCoords.forEach(stop => {
                const isSpecial = stop.isMonitor || stop.isCounselor;
                const size = isSpecial ? 20 : 26;
                const icon = L.divIcon({
                    html: '<div class="stop-marker-icon" style="width:' + size + 'px;height:' + size + 'px;background:' + esc(route.busColor) + ';' + (isSpecial ? 'font-size:10px;' : '') + '">' + (isSpecial ? (stop.isMonitor ? 'M' : 'C') : stop.stopNum) + '</div>',
                    className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2]
                });
                const names = stop.isMonitor ? '🛡️ ' + (stop.monitorName || 'Monitor') : stop.isCounselor ? '👤 ' + (stop.counselorName || 'Counselor') : stop.campers.map(c => c.name).join('<br>');
                const popup = '<div style="font-family:DM Sans,sans-serif;min-width:160px;"><div style="font-weight:700;font-size:13px;margin-bottom:4px;color:' + route.busColor + '">' + esc(route.busName) + ' — ' + esc(route.shiftLabel) + '</div><div style="font-weight:600;margin-bottom:2px;">Stop ' + stop.stopNum + '</div><div style="font-size:12px;margin-bottom:4px;">' + names + '</div><div style="font-size:11px;color:#888;">' + esc(stop.address) + '</div>' + (stop.estimatedTime ? '<div style="font-size:12px;font-weight:600;margin-top:4px;">Est: ' + stop.estimatedTime + '</div>' : '') + '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Drag to move stop</div></div>';
                const marker = L.marker([stop.lat, stop.lng], { icon, draggable: !isSpecial }).addTo(_map);
                marker.bindPopup(popup);
                _mapLayers.push(marker);

                // On drag end: update stop in place without resetting map
                if (!isSpecial) {
                    const _busId = route.busId;
                    const _shiftIdx = route.shiftIdx;
                    const _stopNum = stop.stopNum;
                    const _busColor = route.busColor;

                    marker.on('dragend', async function() {
                        const pos = marker.getLatLng();
                        if (!D.savedRoutes) return;
                        const sr = D.savedRoutes[_shiftIdx];
                        if (!sr) return;
                        const rt = sr.routes.find(r => r.busId === _busId);
                        if (!rt) return;
                        const st = rt.stops.find(s => s.stopNum === _stopNum);
                        if (!st) return;

                        st.lat = pos.lat;
                        st.lng = pos.lng;

                        // Reverse geocode in background
                        if (getApiKey()) {
                            try {
                                const r = await fetch('https://api.openrouteservice.org/geocode/reverse?point.lat=' + pos.lat + '&point.lon=' + pos.lng + '&size=1', {
                                    headers: { 'Authorization': getApiKey() }
                                });
                                const data = await r.json();
                                if (data.features?.[0]?.properties?.label) {
                                    st.address = data.features[0].properties.label;
                                    marker.setPopupContent('<div style="font-family:DM Sans,sans-serif;min-width:160px;"><div style="font-weight:700;font-size:13px;margin-bottom:4px;color:' + _busColor + '">Stop ' + _stopNum + '</div><div style="font-size:11px;color:#888;">' + esc(st.address) + '</div><div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Drag to move stop</div></div>');
                                }
                            } catch (e) { /* keep old address */ }
                        }

                        // Clear cached route for this bus and fetch new road geometry
                        const ck = _busId + '_' + _shiftIdx;
                        delete _routeGeomCache[ck];

                        // Remove only this bus's polyline from the map
                        const oldLines = _mapLayers.filter(l => l._goRouteKey === ck);
                        oldLines.forEach(l => { _map.removeLayer(l); const idx = _mapLayers.indexOf(l); if (idx >= 0) _mapLayers.splice(idx, 1); });

                        // Draw updated straight line immediately
                        const stopsWithCoords = rt.stops.filter(s => s.lat && s.lng);
                        const straightCoords = [];
                        if (_campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);
                        stopsWithCoords.forEach(s => straightCoords.push([s.lat, s.lng]));
                        if (_campCoordsCache) straightCoords.push([_campCoordsCache.lat, _campCoordsCache.lng]);

                        const shiftIndices = [..._activeShifts].sort();
                        const multiShift = shiftIndices.length > 1;
                        const totalShifts = _generatedRoutes.length;
                        function getDash(si) { if (totalShifts <= 1 || !multiShift) return null; if (si === 0) return null; if (si === 1) return '18, 12'; return '6, 10'; }
                        const dp = getDash(_shiftIdx);
                        const w = _activeMapBus === 'all' ? 3 : 5;
                        const o = _activeMapBus === 'all' ? 0.7 : 0.9;

                        const tempLine = L.polyline(straightCoords, { color: _busColor, weight: w, opacity: o * 0.4, dashArray: dp }).addTo(_map);
                        tempLine._goRouteKey = ck;
                        _mapLayers.push(tempLine);

                        // Fetch real road geometry in background
                        if (getApiKey() && straightCoords.length >= 2) {
                            try {
                                const wp = [];
                                if (_campCoordsCache) wp.push([_campCoordsCache.lng, _campCoordsCache.lat]);
                                stopsWithCoords.forEach(s => wp.push([s.lng, s.lat]));
                                if (_campCoordsCache) wp.push([_campCoordsCache.lng, _campCoordsCache.lat]);

                                const resp = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
                                    method: 'POST',
                                    headers: { 'Authorization': getApiKey(), 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json, application/geo+json' },
                                    body: JSON.stringify({ coordinates: wp, radiuses: wp.map(() => 1000) })
                                });
                                if (resp.ok) {
                                    const data = await resp.json();
                                    let seg = null;
                                    if (data.features?.[0]?.geometry?.coordinates) {
                                        seg = data.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
                                    } else if (data.routes?.[0]?.geometry) {
                                        const geom = data.routes[0].geometry;
                                        seg = typeof geom === 'string' ? decodePolyline(geom) : geom.coordinates?.map(c => [c[1], c[0]]);
                                    }
                                    if (seg && seg.length > 0 && _map) {
                                        _routeGeomCache[ck] = seg;
                                        _map.removeLayer(tempLine);
                                        const ti = _mapLayers.indexOf(tempLine);
                                        if (ti >= 0) _mapLayers.splice(ti, 1);
                                        const roadLine = L.polyline(seg, { color: _busColor, weight: w, opacity: o, dashArray: dp }).addTo(_map);
                                        roadLine._goRouteKey = ck;
                                        _mapLayers.push(roadLine);
                                    }
                                }
                            } catch (e) { /* keep straight line */ }
                        }

                        _generatedRoutes = D.savedRoutes;
                        save();
                        toast('Stop ' + _stopNum + ' moved');
                    });
                }
            });
        }

        if (allLatLngs.length > 0) {
            _map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50], maxZoom: 14 });
        }

        // Legend
        const legendEl = document.getElementById('mapLegend');
        if (legendEl) {
            if (multiShift) {
                const labels = shiftIndices.map(si => {
                    const sr = _generatedRoutes[si];
                    const d = getDash(si);
                    const svgLine = !d ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3"/>'
                        : d.startsWith('18') ? '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="9,6"/>'
                        : '<line x1="0" y1="6" x2="40" y2="6" stroke="#555" stroke-width="3" stroke-dasharray="3,5"/>';
                    return '<span style="display:inline-flex;align-items:center;gap:.375rem;font-size:.75rem;font-weight:500;color:var(--text-secondary);"><svg width="40" height="12">' + svgLine + '</svg>' + esc(sr.shift.label || 'Shift ' + (si + 1)) + '</span>';
                });
                legendEl.innerHTML = labels.join('<span style="margin:0 .5rem;color:var(--border-medium);">|</span>');
                legendEl.style.display = '';
            } else {
                legendEl.style.display = 'none';
            }
        }
    }

    function selectMapBus(busId) {
        _activeMapBus = busId;
        renderMap();
        renderFilteredMasterList();
    }

    function toggleMapShift(idx) {
        if (_activeShifts.has(idx)) {
            if (_activeShifts.size > 1) _activeShifts.delete(idx);
        } else {
            _activeShifts.add(idx);
        }
        renderMap();
        renderFilteredMasterList();
    }

    function setMapShiftsAll() {
        _activeShifts = new Set(_generatedRoutes.map((_, i) => i));
        renderMap();
        renderFilteredMasterList();
    }

    function toggleMapFullscreen() {
        const card = document.getElementById('routeMapCard');
        if (!card) return;
        card.classList.toggle('map-fullscreen');
        setTimeout(() => { if (_map) _map.invalidateSize(); }, 100);
    }

    // =========================================================================
    // DAILY OVERRIDES
    // =========================================================================
    function getTodayKey() {
        const d = new Date(); d.setHours(12, 0, 0, 0);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function getOverrides() {
        const key = getTodayKey();
        if (!D.dailyOverrides[key]) D.dailyOverrides[key] = {};
        return D.dailyOverrides[key];
    }

    function addOverride(camperName, type, details) {
        // type: 'not-riding' | 'ride-with' | 'add-rider'
        const ov = getOverrides();
        ov[camperName] = { type, ...details, timestamp: Date.now() };
        save();
        if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes));
        renderDailyOverrides();
        toast('Override added for ' + camperName);
    }

    function removeOverride(camperName) {
        const ov = getOverrides();
        delete ov[camperName];
        save();
        if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes));
        renderDailyOverrides();
        toast('Override removed');
    }

    /**
     * Deep-clone routes and apply today's overrides:
     * - not-riding: remove camper from all routes
     * - ride-with: move camper to target camper's bus/stop
     * - add-rider: inject camper into the best bus for their address
     */
    function applyOverrides(routes) {
        if (!routes) return routes;
        const ov = getOverrides();
        if (!Object.keys(ov).length) return routes;

        // Deep clone
        const clone = JSON.parse(JSON.stringify(routes));

        Object.entries(ov).forEach(([camperName, override]) => {
            if (override.type === 'not-riding') {
                // Remove camper from all stops across all shifts
                clone.forEach(sr => {
                    sr.routes.forEach(r => {
                        r.stops.forEach(st => {
                            st.campers = st.campers.filter(c => c.name !== camperName);
                        });
                        // Remove empty stops (unless monitor/counselor)
                        r.stops = r.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor);
                        // Renumber
                        r.stops.forEach((st, i) => { st.stopNum = i + 1; });
                        r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);
                    });
                });
            }

            if (override.type === 'ride-with') {
                const targetName = override.targetCamper;
                // Find which bus/stop the target is on
                let targetBusId = null, targetShiftIdx = null, targetStopIdx = null;
                clone.forEach((sr, si) => {
                    sr.routes.forEach(r => {
                        r.stops.forEach((st, sti) => {
                            if (st.campers.some(c => c.name === targetName)) {
                                targetBusId = r.busId;
                                targetShiftIdx = si;
                                targetStopIdx = sti;
                            }
                        });
                    });
                });

                if (targetBusId !== null) {
                    // Remove camper from current location
                    clone.forEach(sr => {
                        sr.routes.forEach(r => {
                            r.stops.forEach(st => {
                                st.campers = st.campers.filter(c => c.name !== camperName);
                            });
                            r.stops = r.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor);
                        });
                    });

                    // Add to target's stop
                    const targetRoute = clone[targetShiftIdx]?.routes.find(r => r.busId === targetBusId);
                    if (targetRoute) {
                        const targetStop = targetRoute.stops[targetStopIdx];
                        if (targetStop) {
                            const roster = getRoster();
                            const camper = roster[camperName] || {};
                            targetStop.campers.push({ name: camperName, division: camper.division || '', bunk: camper.bunk || '' });
                        }
                    }

                    // Recalculate counts
                    clone.forEach(sr => {
                        sr.routes.forEach(r => {
                            r.stops.forEach((st, i) => { st.stopNum = i + 1; });
                            r.camperCount = r.stops.reduce((s, st) => s + st.campers.length, 0);
                        });
                    });
                }
            }

            if (override.type === 'add-rider') {
                // Add a carpool kid to the best bus based on their address
                const addr = D.addresses[camperName];
                if (!addr?.geocoded) return;

                const roster = getRoster();
                const camper = roster[camperName] || {};

                // Find the shift that matches this camper's division
                clone.forEach(sr => {
                    const divSet = new Set(sr.shift.divisions || []);
                    if (!divSet.has(camper.division)) return;

                    // Find nearest stop across all routes in this shift
                    let bestRoute = null, bestStopIdx = -1, bestDist = Infinity;
                    sr.routes.forEach(r => {
                        r.stops.forEach((st, sti) => {
                            if (!st.lat || !st.lng) return;
                            const d = haversineMi(addr.lat, addr.lng, st.lat, st.lng);
                            if (d < bestDist) { bestDist = d; bestRoute = r; bestStopIdx = sti; }
                        });
                    });

                    if (bestRoute && bestStopIdx >= 0) {
                        // Add to nearest existing stop if within 0.3 mi, otherwise create new stop
                        if (bestDist <= 0.3) {
                            bestRoute.stops[bestStopIdx].campers.push({ name: camperName, division: camper.division || '', bunk: camper.bunk || '' });
                        } else {
                            bestRoute.stops.push({
                                stopNum: bestRoute.stops.length + 1,
                                campers: [{ name: camperName, division: camper.division || '', bunk: camper.bunk || '' }],
                                address: [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', '),
                                lat: addr.lat, lng: addr.lng,
                                estimatedTime: bestRoute.stops[bestStopIdx]?.estimatedTime || '—'
                            });
                        }
                        bestRoute.camperCount = bestRoute.stops.reduce((s, st) => s + st.campers.length, 0);
                    }
                });
            }
        });

        return clone;
    }

    function renderDailyOverrides() {
        const container = document.getElementById('dailyOverridesBody');
        if (!container) return;

        const ov = getOverrides();
        const entries = Object.entries(ov);
        const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        if (!entries.length) {
            container.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.875rem;">No overrides for today. All campers riding their regular routes.</div>';
            return;
        }

        container.innerHTML = '<div style="font-size:.75rem;color:var(--text-muted);margin-bottom:.5rem;">' + dateLabel + ' — ' + entries.length + ' override' + (entries.length !== 1 ? 's' : '') + '</div>' +
            entries.map(([name, ov]) => {
                let desc = '', badgeCls = 'badge-neutral';
                if (ov.type === 'not-riding') { desc = 'Not riding bus today'; badgeCls = 'badge-danger'; }
                else if (ov.type === 'ride-with') { desc = 'Riding with ' + esc(ov.targetCamper); badgeCls = 'badge-warning'; }
                else if (ov.type === 'add-rider') { desc = 'Added to bus (usually carpool)'; badgeCls = 'badge-success'; }
                return '<div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border-light);font-size:.8125rem;">' +
                    '<div><strong>' + esc(name) + '</strong> — <span class="badge ' + badgeCls + '">' + desc + '</span></div>' +
                    '<button class="btn btn-ghost btn-sm" style="color:var(--red-500)" onclick="CampistryGo.removeOverride(\'' + esc(name.replace(/'/g, "\\'")) + '\')">Remove</button></div>';
            }).join('');
    }

    // Override modal helpers
    function openOverrideModal() {
        const roster = getRoster();
        const names = Object.keys(roster).sort();
        const sel = document.getElementById('overrideCamper');
        sel.innerHTML = '<option value="">— Select camper —</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
        document.getElementById('overrideSearch').value = '';
        document.getElementById('overrideType').value = 'not-riding';
        document.getElementById('overrideRideWithGroup').style.display = 'none';
        openModal('overrideModal');
        document.getElementById('overrideSearch').focus();
    }

    function filterOverrideSelect(inputId, selectId) {
        const q = (document.getElementById(inputId)?.value || '').toLowerCase().trim();
        const sel = document.getElementById(selectId);
        const roster = getRoster();
        const names = Object.keys(roster).sort();
        const filtered = q ? names.filter(n => n.toLowerCase().includes(q)) : names;
        sel.innerHTML = '<option value="">— Select camper —</option>' + filtered.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
        if (filtered.length === 1) sel.value = filtered[0]; // auto-select if one match
    }

    function onOverrideTypeChange() {
        const type = document.getElementById('overrideType')?.value;
        document.getElementById('overrideRideWithGroup').style.display = type === 'ride-with' ? '' : 'none';
        if (type === 'ride-with') {
            document.getElementById('overrideTargetSearch').value = '';
            filterOverrideSelect('overrideTargetSearch', 'overrideTarget');
        }
    }

    function saveOverride() {
        const camper = document.getElementById('overrideCamper')?.value;
        const type = document.getElementById('overrideType')?.value;
        if (!camper) { toast('Select a camper', 'error'); return; }

        if (type === 'ride-with') {
            const target = document.getElementById('overrideTarget')?.value;
            if (!target) { toast('Select who they\'re riding with', 'error'); return; }
            if (target === camper) { toast('Can\'t ride with themselves', 'error'); return; }
            addOverride(camper, 'ride-with', { targetCamper: target });
        } else if (type === 'add-rider') {
            if (!D.addresses[camper]?.geocoded) { toast(camper + ' needs a geocoded address first', 'error'); return; }
            addOverride(camper, 'add-rider', {});
        } else {
            addOverride(camper, 'not-riding', {});
        }
        closeModal('overrideModal');
    }

    // =========================================================================
    // CAMPER SEARCH (find any camper across all routes)
    // =========================================================================
    function searchCamperInRoutes(query) {
        if (!_generatedRoutes || !query) return;
        const q = query.toLowerCase().trim();
        if (!q) { if (_generatedRoutes) renderRouteResults(applyOverrides(_generatedRoutes)); return; }

        const results = [];
        const applied = applyOverrides(_generatedRoutes);
        applied.forEach(sr => {
            sr.routes.forEach(r => {
                r.stops.forEach(st => {
                    st.campers.forEach(c => {
                        if (c.name.toLowerCase().includes(q)) {
                            results.push({
                                name: c.name, shift: sr.shift.label || '',
                                busName: r.busName, busColor: r.busColor, busId: r.busId,
                                stopNum: st.stopNum, address: st.address,
                                time: st.estimatedTime || '—', lat: st.lat, lng: st.lng,
                                shiftIdx: _generatedRoutes.indexOf(sr)
                            });
                        }
                    });
                });
            });
        });

        const container = document.getElementById('camperSearchResults');
        if (!container) return;

        if (!results.length) {
            container.innerHTML = '<div style="padding:.75rem;color:var(--text-muted);font-size:.875rem;">No camper found matching "' + esc(query) + '"</div>';
            container.style.display = '';
            return;
        }

        container.innerHTML = results.map(r => 
            '<div style="display:flex;align-items:center;gap:.75rem;padding:.625rem .75rem;border-bottom:1px solid var(--border-light);font-size:.8125rem;cursor:pointer;" onclick="CampistryGo.zoomToStop(' + (r.lat||0) + ',' + (r.lng||0) + ',\'' + esc(r.busId) + '\',' + r.shiftIdx + ')">' +
            '<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(r.busColor) + ';display:inline-block;"></span></span>' +
            '<strong>' + esc(r.name) + '</strong>' +
            '<span style="color:var(--text-muted)">' + esc(r.shift) + ' · ' + esc(r.busName) + ' · Stop ' + r.stopNum + '</span>' +
            '<span style="margin-left:auto;font-weight:600;">' + r.time + '</span>' +
            '</div>'
        ).join('');
        container.style.display = '';
    }

    function zoomToStop(lat, lng, busId, shiftIdx) {
        if (!_map || !lat || !lng) return;
        // Show just this shift and this bus
        _activeShifts = new Set([shiftIdx]);
        _activeMapBus = busId;
        renderMap();
        _map.setView([lat, lng], 16);
        const sr = document.getElementById('camperSearchResults');
        if (sr) sr.style.display = 'none';
    }

    // =========================================================================
    // ROUTE EDITING (move campers between buses without regenerating)
    // =========================================================================
    function moveCamperToBus(camperName, fromBusId, toBusId, shiftIdx) {
        if (!_generatedRoutes || !D.savedRoutes) return;
        const sr = D.savedRoutes[shiftIdx];
        if (!sr) return;

        // Find and remove camper from source bus
        let camperData = null, camperStop = null;
        const fromRoute = sr.routes.find(r => r.busId === fromBusId);
        if (fromRoute) {
            for (const st of fromRoute.stops) {
                const ci = st.campers.findIndex(c => c.name === camperName);
                if (ci >= 0) {
                    camperData = st.campers.splice(ci, 1)[0];
                    camperStop = st;
                    break;
                }
            }
            // Remove empty stops
            fromRoute.stops = fromRoute.stops.filter(st => st.campers.length > 0 || st.isMonitor || st.isCounselor);
            fromRoute.stops.forEach((st, i) => { st.stopNum = i + 1; });
            fromRoute.camperCount = fromRoute.stops.reduce((s, st) => s + st.campers.length, 0);
        }

        if (!camperData || !camperStop) { toast('Camper not found', 'error'); return; }

        // Add to target bus — find nearest existing stop or create new one
        const toRoute = sr.routes.find(r => r.busId === toBusId);
        if (!toRoute) { toast('Target bus not found', 'error'); return; }

        let added = false;
        if (camperStop.lat && camperStop.lng) {
            for (const st of toRoute.stops) {
                if (st.lat && st.lng && haversineMi(camperStop.lat, camperStop.lng, st.lat, st.lng) < 0.3) {
                    st.campers.push(camperData);
                    added = true;
                    break;
                }
            }
        }
        if (!added) {
            toRoute.stops.push({
                stopNum: toRoute.stops.length + 1,
                campers: [camperData],
                address: camperStop.address,
                lat: camperStop.lat, lng: camperStop.lng,
                estimatedTime: camperStop.estimatedTime
            });
        }
        toRoute.stops.forEach((st, i) => { st.stopNum = i + 1; });
        toRoute.camperCount = toRoute.stops.reduce((s, st) => s + st.campers.length, 0);

        _generatedRoutes = D.savedRoutes;
        save();
        renderRouteResults(applyOverrides(D.savedRoutes));
        toast(camperName + ' moved to ' + toRoute.busName);
    }

    function openMoveModal(camperName, fromBusId, shiftIdx) {
        const sr = _generatedRoutes?.[shiftIdx];
        if (!sr) return;
        const otherBuses = sr.routes.filter(r => r.busId !== fromBusId && r.stops.length > 0);
        document.getElementById('moveCamperName').textContent = camperName;
        const sel = document.getElementById('moveToBus');
        sel.innerHTML = otherBuses.map(r => '<option value="' + r.busId + '">' + esc(r.busName) + ' (' + r.camperCount + ' campers)</option>').join('');
        document.getElementById('moveConfirmBtn').onclick = function() {
            moveCamperToBus(camperName, fromBusId, sel.value, shiftIdx);
            closeModal('moveModal');
        };
        openModal('moveModal');
    }

    // =========================================================================
    // EXPORT / PRINT
    // =========================================================================
    function exportRoutesCsv() {
        if (!_generatedRoutes) { toast('Generate first', 'error'); return; }
        let csv = '\uFEFFFirst Name,Last Name,Shift,Bus,Stop #,Address,Est. Time\n';
        const rows = [];
        _generatedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); rows.push([p[0] || '', p.slice(1).join(' ') || '', sr.shift.label || '', r.busName, st.stopNum, st.address, st.estimatedTime || '']); }); }); }); });
        rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
        rows.forEach(r => { csv += r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n'; });
        const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'campistry_go_routes.csv'; a.click(); toast('Exported');
    }
    function printRoutes() {
        if (!_generatedRoutes) { toast('Generate first', 'error'); return; }
        const cn = D.setup.campName || 'Camp';
        let h = '<!DOCTYPE html><html><head><title>Bus Routes — ' + esc(cn) + '</title><style>body{font-family:Arial,sans-serif;font-size:11pt;color:#222;margin:20px}h1{font-size:18pt;margin-bottom:4px}h2{font-size:14pt;margin:20px 0 8px;padding:6px 10px;color:#fff;border-radius:4px}.sub{color:#666;font-size:10pt;margin-bottom:20px}table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:10pt}th{background:#f5f5f5;text-align:left;padding:6px 8px;border:1px solid #ddd;font-size:9pt;text-transform:uppercase}td{padding:5px 8px;border:1px solid #ddd}.bus-section{page-break-inside:avoid;margin-bottom:30px}.meta{font-size:9pt;color:#666;margin-bottom:10px}@media print{.no-print{display:none}}</style></head><body>';
        h += '<h1>' + esc(cn) + ' — Bus Routes</h1><div class="sub">Generated: ' + new Date().toLocaleDateString() + '</div>';
        _generatedRoutes.forEach((sr, si) => {
            h += '<h1 style="margin-top:30px">Shift ' + (si + 1) + ': ' + esc(sr.shift.label) + ' — Departs ' + esc(sr.shift.departureTime) + '</h1>';
            sr.routes.filter(r => r.stops.length > 0).forEach(r => {
                h += '<div class="bus-section"><h2 style="background:' + esc(r.busColor) + '">' + esc(r.busName) + ' — ' + r.camperCount + ' campers, ' + r.stops.length + ' stops (' + r.totalDuration + ' min)</h2>';
                if (r.monitor) h += '<div class="meta">Monitor: ' + esc(r.monitor.name) + '</div>';
                h += '<table><thead><tr><th>Stop</th><th>Camper(s)</th><th>Address</th><th>Est. Time</th></tr></thead><tbody>';
                r.stops.forEach(st => { const nm = st.isMonitor ? esc(st.monitorName) + ' (Monitor)' : st.isCounselor ? esc(st.counselorName) + ' (Counselor)' : st.campers.map(c => esc(c.name)).join(', '); h += '<tr><td style="text-align:center;font-weight:bold">' + st.stopNum + '</td><td>' + nm + '</td><td>' + esc(st.address) + '</td><td style="font-weight:600">' + (st.estimatedTime || '—') + '</td></tr>'; });
                h += '</tbody></table></div>';
            });
        });
        h += '<div style="page-break-before:always"></div><h1>Master Drop-off List</h1><div class="sub">All shifts, sorted by last name</div><table><thead><tr><th>First</th><th>Last</th><th>Shift</th><th>Bus</th><th>Stop</th><th>Address</th><th>Time</th></tr></thead><tbody>';
        const rows = []; _generatedRoutes.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); rows.push({ fn: p[0], ln: p.slice(1).join(' '), sh: sr.shift.label, bn: r.busName, sn: st.stopNum, ad: st.address, t: st.estimatedTime || '—' }); }); }); }); });
        rows.sort((a, b) => a.ln.localeCompare(b.ln) || a.fn.localeCompare(b.fn));
        rows.forEach(r => { h += '<tr><td>' + esc(r.fn) + '</td><td><strong>' + esc(r.ln) + '</strong></td><td>' + esc(r.sh) + '</td><td>' + esc(r.bn) + '</td><td style="text-align:center;font-weight:bold">' + r.sn + '</td><td>' + esc(r.ad) + '</td><td style="font-weight:600">' + r.t + '</td></tr>'; });
        h += '</tbody></table></body></html>';
        const w = window.open('', '_blank'); w.document.write(h); w.document.close(); setTimeout(() => w.print(), 500);
    }

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
                runPreflight(); // enables generate button
                renderDailyOverrides();
                if (_pendingMapInit) { setTimeout(function() { initMap(_pendingMapInit); _pendingMapInit = null; }, 150); }
                else { setTimeout(function() { if (_map) _map.invalidateSize(); }, 150); }
            }
        }));
        document.getElementById('addressSearch')?.addEventListener('input', () => { clearTimeout(_addrSearchTimer); _addrSearchTimer = setTimeout(renderAddresses, 200); });
    }
    let _addrSearchTimer;

    function init() {
        console.log('[Go] Initializing...');
        load(); initTabs(); populateSetup(); renderFleet(); renderShifts(); renderStaff(); renderAddresses(); updateStats(); updateBusSelects();

        // Restore camp coordinates from saved data
        if (D.setup.campLat && D.setup.campLng) {
            _campCoordsCache = { lat: D.setup.campLat, lng: D.setup.campLng };
            console.log('[Go] Restored camp coords:', _campCoordsCache.lat, _campCoordsCache.lng);
        }

        // Restore saved routes if they exist
        if (D.savedRoutes && D.savedRoutes.length) {
            // Migrate: fix "Shared stop" addresses with nearest house address
            let needsSave = false;
            D.savedRoutes.forEach(sr => {
                sr.routes.forEach(r => {
                    r.stops.forEach(st => {
                        if (st.address && st.address.startsWith('Shared stop')) {
                            // Find which camper's house is closest to the stop's lat/lng
                            let bestAddr = null, bestDist = Infinity;
                            (st.campers || []).forEach(c => {
                                const a = D.addresses[c.name];
                                if (a?.geocoded && a.lat && a.lng && st.lat && st.lng) {
                                    const d = haversineMi(st.lat, st.lng, a.lat, a.lng);
                                    if (d < bestDist) { bestDist = d; bestAddr = [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '); }
                                }
                            });
                            if (bestAddr) { st.address = bestAddr; needsSave = true; }
                        }
                    });
                });
            });
            if (needsSave) save(); // persist the fix
            _generatedRoutes = D.savedRoutes;
            console.log('[Go] Restoring saved routes (' + D.savedRoutes.length + ' shifts)');
            setTimeout(() => {
                renderRouteResults(applyOverrides(D.savedRoutes));
                toast('Saved routes loaded');
            }, 200);
        }

        // Close modals on overlay click + ESC
        document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });

        // Listen for cloud data arriving after boot (race condition)
        window.addEventListener('campistry-cloud-hydrated', () => {
            console.log('[Go] Cloud data hydrated — refreshing...');
            load(); renderAddresses(); updateStats(); renderShifts();
        });

        // Log data source status
        console.log('[Go] Ready —', D.buses.length, 'buses,', D.shifts.length, 'shifts,',
            Object.keys(getRoster()).length, 'campers in roster,',
            'cloud sync:', typeof window.saveGlobalSettings === 'function' ? 'YES' : 'localStorage only');
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    window.CampistryGo = {
        saveSetup, testApiKey,
        openBusModal, saveBus, editBus, deleteBus, _pickColor,
        addShift, deleteShift, toggleShiftDiv, updateShiftTime, renameShift,
        toggleShiftGrade, setShiftGradeMode,
        openMonitorModal, saveMonitor, editMonitor, deleteMonitor,
        openCounselorModal, saveCounselor, editCounselor, deleteCounselor,
        editAddress, saveAddress, geocodeAll, downloadAddressTemplate, importAddressCsv,
        generateRoutes, exportRoutesCsv, printRoutes, detectRegions,
        renderMap, selectMapBus, toggleMapShift, setMapShiftsAll, toggleMapFullscreen,
        openOverrideModal, onOverrideTypeChange, saveOverride, removeOverride,
        filterOverrideSelect,
        searchCamperInRoutes, zoomToStop,
        openMoveModal, renderFilteredMasterList,
        closeModal, openModal
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
