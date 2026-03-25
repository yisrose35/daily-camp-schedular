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
        addresses: {}    // { camperName: { street, city, state, zip, lat, lng, geocoded } }
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

    // Distance (miles) between two lat/lng
    function haversineMi(lat1, lng1, lat2, lng2) {
        const R = 3958.8; // earth radius in miles
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
        const def = { setup: { campAddress:'',campName:'',avgSpeed:25,reserveSeats:2,dropoffMode:'door-to-door',avgStopTime:2,maxWalkDistance:500,orsApiKey:'' }, buses:[], shifts:[], monitors:[], counselors:[], addresses:{} };
        return { setup: { ...def.setup, ...(d.setup || {}) }, buses: d.buses || [], shifts: d.shifts || [], monitors: d.monitors || [], counselors: d.counselors || [], addresses: d.addresses || {} };
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
        // Track which divisions are already assigned
        const assignedDivs = new Set();
        D.shifts.forEach(sh => (sh.divisions || []).forEach(d => assignedDivs.add(d)));

        container.innerHTML = D.shifts.map((sh, idx) => {
            const chipsHtml = divNames.map(dName => {
                const isActive = (sh.divisions || []).includes(dName);
                const color = struct[dName]?.color || '#888';
                return '<span class="division-chip' + (isActive ? ' active' : '') + '" onclick="CampistryGo.toggleShiftDiv(\'' + sh.id + '\',\'' + esc(dName.replace(/'/g, "\\'")) + '\')"><span class="chip-dot" style="background:' + esc(color) + '"></span>' + esc(dName) + '</span>';
            }).join(' ');

            const camperCount = countCampersForDivisions(sh.divisions || []);

            return '<div class="shift-card"><div class="shift-card-header"><div class="shift-card-title"><span class="shift-num">' + (idx + 1) + '</span>' + esc(sh.label || 'Shift ' + (idx + 1)) + '<span style="font-size:.75rem;font-weight:400;color:var(--text-muted);margin-left:.5rem;">' + camperCount + ' campers</span></div><div style="display:flex;align-items:center;gap:.5rem;"><label style="font-size:.75rem;font-weight:600;color:var(--text-secondary)">Depart:</label><input type="time" class="form-input" value="' + esc(sh.departureTime || '16:00') + '" style="width:110px;padding:.35rem .5rem;font-size:.8125rem;" onchange="CampistryGo.updateShiftTime(\'' + sh.id + '\',this.value)"><button class="btn btn-ghost btn-sm" style="color:var(--red-500);" onclick="CampistryGo.deleteShift(\'' + sh.id + '\')">Remove</button></div></div><div style="display:flex;flex-wrap:wrap;gap:.5rem;">' + (divNames.length ? chipsHtml : '<span style="font-size:.8125rem;color:var(--text-muted)">No divisions in Campistry Me yet</span>') + '</div><div style="margin-top:.75rem;"><input type="text" class="form-input" value="' + esc(sh.label || '') + '" placeholder="Shift name (e.g. Freshies)" style="max-width:300px;font-size:.8125rem;" onchange="CampistryGo.renameShift(\'' + sh.id + '\',this.value)"></div></div>';
        }).join('');
    }
    function countCampersForDivisions(divs) {
        if (!divs.length) return 0;
        const roster = getRoster();
        const divSet = new Set(divs);
        return Object.values(roster).filter(c => divSet.has(c.division)).length;
    }
    function addShift() {
        const idx = D.shifts.length + 1;
        const prevTime = D.shifts.length ? D.shifts[D.shifts.length - 1].departureTime : '16:00';
        // Auto-increment by 45 min
        const prevMin = parseTime(prevTime);
        const newMin = prevMin + 45;
        const h = Math.floor(newMin / 60), m = newMin % 60;
        const newTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        D.shifts.push({ id: uid(), label: 'Shift ' + idx, divisions: [], departureTime: newTime });
        save(); renderShifts(); updateStats(); toast('Shift added');
    }
    function deleteShift(id) { D.shifts = D.shifts.filter(s => s.id !== id); save(); renderShifts(); updateStats(); toast('Shift removed'); }
    function toggleShiftDiv(shiftId, divName) {
        const sh = D.shifts.find(s => s.id === shiftId); if (!sh) return;
        if (!sh.divisions) sh.divisions = [];
        // Remove from any other shift first
        D.shifts.forEach(s => { if (s.id !== shiftId) s.divisions = (s.divisions || []).filter(d => d !== divName); });
        // Toggle in this shift
        const idx = sh.divisions.indexOf(divName);
        if (idx >= 0) sh.divisions.splice(idx, 1); else sh.divisions.push(divName);
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
        const key = D.setup.orsApiKey; if (!key) return false;
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
        if (!D.setup.orsApiKey) { toast('Set ORS key in Setup', 'error'); return; }
        const todo = Object.keys(D.addresses).filter(n => D.addresses[n]?.street && !D.addresses[n].geocoded);
        if (!todo.length) { toast('All geocoded!'); return; }
        toast('Geocoding ' + todo.length + '...');
        let ok = 0;
        for (let i = 0; i < todo.length; i++) { if (await geocodeOne(todo[i])) ok++; if (i < todo.length - 1) await new Promise(r => setTimeout(r, 1600)); if ((i + 1) % 10 === 0) { renderAddresses(); updateStats(); } }
        save(); renderAddresses(); updateStats(); toast(ok + ' geocoded');
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
        // Count campers in shifts
        let inShifts = 0; const shiftDivs = new Set(); D.shifts.forEach(s => (s.divisions || []).forEach(d => shiftDivs.add(d)));
        Object.values(roster).forEach(c => { if (shiftDivs.has(c.division)) inShifts++; });
        const checks = [
            { label: D.buses.length + ' bus(es)', status: D.buses.length > 0 ? 'ok' : 'fail', detail: D.buses.length === 0 ? 'Add buses in Fleet tab' : '' },
            { label: D.shifts.length + ' shift(s) configured', status: D.shifts.length > 0 ? 'ok' : 'fail', detail: D.shifts.length === 0 ? 'Add shifts in Shifts tab' : '' },
            { label: inShifts + ' of ' + camperCount + ' campers assigned to shifts', status: inShifts === camperCount && camperCount > 0 ? 'ok' : inShifts > 0 ? 'warn' : 'fail', detail: inShifts < camperCount ? (camperCount - inShifts) + ' campers have no shift (their division is unassigned)' : '' },
            { label: geocoded + ' of ' + camperCount + ' geocoded', status: geocoded === camperCount && camperCount > 0 ? 'ok' : geocoded > 0 ? 'warn' : 'fail', detail: geocoded < camperCount ? (camperCount - geocoded) + ' missing — will be skipped' : '' },
            { label: totalSeats + ' seats/shift for up to ' + Math.max(...D.shifts.map(s => countCampersForDivisions(s.divisions || [])), 0) + ' in largest shift', status: 'ok', detail: '' },
            { label: D.setup.campAddress ? 'Camp address set' : 'No camp address', status: D.setup.campAddress ? 'ok' : 'warn', detail: '' },
            { label: D.setup.orsApiKey ? 'ORS key set' : 'No ORS key (will use estimates)', status: D.setup.orsApiKey ? 'ok' : 'warn', detail: '' }
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
                const divSet = new Set(sh.divisions || []);
                let count = 0;
                reg.camperNames.forEach(n => { const c = roster[n]; if (c && divSet.has(c.division)) count++; });
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
            const divSet = new Set(sh.divisions || []);
            demand[sh.id] = {};
            regions.forEach(reg => {
                let count = 0;
                reg.camperNames.forEach(n => { const c = roster[n]; if (c && divSet.has(c.division)) count++; });
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
            return { busId: b.id, name: b.name, color: b.color || '#3b82f6', capacity: Math.max(0, (b.capacity || 0) - 1 - (mon ? 1 : 0) - couns.length - reserveSeats), monitor: mon, counselors: couns };
        });

        // Geocode camp
        let campCoords = null;
        if (D.setup.orsApiKey && D.setup.campAddress) {
            showProgress('Geocoding camp...', 5);
            campCoords = await geocodeSingle(D.setup.campAddress);
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

                // Get campers in this region for this shift
                const campers = [];
                reg.camperNames.forEach(name => {
                    const c = roster[name]; const a = D.addresses[name];
                    if (c && divSet.has(c.division) && a?.geocoded && a.lat && a.lng) {
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
        showProgress('Done!', 100);
        setTimeout(() => { hideProgress(); renderRouteResults(allShiftResults); }, 400);
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
            sorted.forEach(c => { if (used.has(c.name)) return; const cl = [c]; used.add(c.name); sorted.forEach(o => { if (used.has(o.name)) return; if (haversineMi(c.lat, c.lng, o.lat, o.lng) <= maxWalkMi) { cl.push(o); used.add(o.name); } }); const cLat = cl.reduce((s, x) => s + x.lat, 0) / cl.length, cLng = cl.reduce((s, x) => s + x.lng, 0) / cl.length; clusters.push({ lat: cLat, lng: cLng, address: cl.length === 1 ? cl[0].address : 'Shared stop (' + cl.length + ')', campers: cl.map(x => ({ name: x.name, division: x.division, bunk: x.bunk })), _count: cl.length }); });
            jobs = clusters;
        } else {
            jobs = campers.map(c => ({ ...c, campers: [{ name: c.name, division: c.division, bunk: c.bunk }], _count: 1 }));
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
        const key = D.setup.orsApiKey; if (!key) return null;
        try { const r = await fetch('https://api.openrouteservice.org/geocode/search?' + new URLSearchParams({ text: addr, size: '1', 'boundary.country': 'US' }), { headers: { 'Authorization': key, 'Accept': 'application/json' } }); if (!r.ok) return null; const d = await r.json(); if (d.features?.length) { const co = d.features[0].geometry.coordinates; return { lat: co[1], lng: co[0] }; } } catch (_) {} return null;
    }

    function showProgress(label, pct) { const c = document.getElementById('routeProgressCard'); c.style.display = ''; document.getElementById('routeProgressLabel').textContent = label; document.getElementById('routeProgressPct').textContent = Math.round(pct) + '%'; document.getElementById('routeProgressBar').style.width = pct + '%'; }
    function hideProgress() { document.getElementById('routeProgressCard').style.display = 'none'; }

    // =========================================================================
    // RENDER ROUTE RESULTS
    // =========================================================================
    function renderRouteResults(allShifts) {
        document.getElementById('routeResults').style.display = '';
        const container = document.getElementById('shiftResultsContainer');
        let html = '';

        // Show bus assignment summary
        if (_busAssignments && _detectedRegions) {
            html += '<div class="card" style="margin-bottom:1.5rem"><div class="card-header"><h2>Bus Region Assignments</h2></div><div class="card-body"><div style="font-size:.8125rem;color:var(--text-muted);margin-bottom:.75rem">Buses stay in the same region across shifts when possible. Changes are highlighted.</div>';
            html += '<div class="table-wrapper"><table class="data-table"><thead><tr><th>Bus</th>';
            D.shifts.forEach(sh => { html += '<th>' + esc(sh.label || 'Shift') + '</th>'; });
            html += '</tr></thead><tbody>';

            D.buses.forEach(b => {
                html += '<tr><td style="font-weight:600"><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(b.color) + ';display:inline-block"></span>' + esc(b.name) + '</span></td>';
                let prevRegion = null;
                D.shifts.forEach(sh => {
                    const regionId = Object.keys(_busAssignments[sh.id] || {}).find(rid => (_busAssignments[sh.id][rid] || []).includes(b.id));
                    const reg = _detectedRegions.find(r => r.id === regionId);
                    const changed = prevRegion && regionId !== prevRegion;
                    html += '<td style="' + (changed ? 'background:var(--amber-50);font-weight:700;color:var(--amber-700)' : '') + '">' + (reg ? '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:' + esc(reg.color) + ';display:inline-block"></span>' + esc(reg.name) + '</span>' : '—') + (changed ? ' ⚡' : '') + '</td>';
                    prevRegion = regionId;
                });
                html += '</tr>';
            });
            html += '</tbody></table></div></div></div>';
        }

        allShifts.forEach((sr, si) => {
            const { shift, routes } = sr;
            const totalCampers = routes.reduce((s, r) => s + r.camperCount, 0);
            const totalStops = routes.reduce((s, r) => s + r.stops.filter(st => !st.isMonitor && !st.isCounselor).length, 0);
            const longest = routes.length ? Math.max(...routes.map(r => r.totalDuration), 0) : 0;

            html += '<div style="margin-bottom:2.5rem;"><h2 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem;"><span class="shift-num">' + (si + 1) + '</span>' + esc(shift.label || 'Shift ' + (si + 1)) + ' <span style="font-size:.875rem;font-weight:400;color:var(--text-muted)">— Departs ' + esc(shift.departureTime || '?') + ' · ' + totalCampers + ' campers · ' + totalStops + ' stops · longest ' + longest + ' min</span></h2>';
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:1.5rem;">';
            routes.filter(r => r.stops.length > 0).forEach(r => {
                html += '<div class="route-card"><div class="route-card-header" style="background:' + esc(r.busColor) + '"><div><h3>' + esc(r.busName) + '</h3><div class="route-meta">' + r.camperCount + ' campers · ' + r.stops.length + ' stops</div></div><div style="text-align:right"><div style="font-size:1.25rem;font-weight:700">' + r.totalDuration + ' min</div><div class="route-meta">est. duration</div></div></div><ul class="route-stop-list">';
                r.stops.forEach(st => {
                    const names = st.isMonitor ? '🛡️ ' + esc(st.monitorName) + ' (Monitor)' : st.isCounselor ? '👤 ' + esc(st.counselorName) + ' (Counselor)' : st.campers.map(c => esc(c.name)).join(', ');
                    const cls = st.isMonitor ? ' monitor-stop' : st.isCounselor ? ' counselor-stop' : '';
                    html += '<li class="route-stop' + cls + '"><div class="route-stop-num" style="background:' + esc(r.busColor) + '">' + st.stopNum + '</div><div class="route-stop-info"><div class="route-stop-names">' + names + '</div><div class="route-stop-addr">' + esc(st.address) + '</div></div><div class="route-stop-time">' + (st.estimatedTime || '—') + '</div></li>';
                });
                html += '</ul><div class="route-card-footer"><span>' + (r.monitor ? '🛡️ ' + esc(r.monitor.name) : 'No monitor') + '</span><span>' + (r.counselors.length ? r.counselors.length + ' counselor(s)' : '') + '</span></div></div>';
            });
            html += '</div></div>';
        });

        container.innerHTML = html;
        renderMasterList(allShifts);
        // Init map after DOM is painted
        setTimeout(() => initMap(allShifts), 100);
    }

    function renderMasterList(allShifts) {
        const rows = [];
        allShifts.forEach(sr => { sr.routes.forEach(r => { r.stops.forEach(st => { if (st.isMonitor || st.isCounselor) return; st.campers.forEach(c => { const p = c.name.split(/\s+/); rows.push({ firstName: p[0] || '', lastName: p.slice(1).join(' ') || '', shift: sr.shift.label || '', busName: r.busName, busColor: r.busColor, stopNum: st.stopNum, address: st.address, time: st.estimatedTime || '—' }); }); }); }); });
        rows.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
        document.getElementById('masterListBody').innerHTML = rows.map(r => '<tr><td style="font-weight:600">' + esc(r.firstName) + '</td><td style="font-weight:600">' + esc(r.lastName) + '</td><td>' + esc(r.shift) + '</td><td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + esc(r.busColor) + ';display:inline-block"></span>' + esc(r.busName) + '</span></td><td style="font-weight:700;text-align:center">' + r.stopNum + '</td><td>' + esc(r.address) + '</td><td style="font-weight:600">' + r.time + '</td></tr>').join('');
    }

    // =========================================================================
    // ROUTE MAP (Leaflet)
    // =========================================================================
    let _map = null;
    let _mapLayers = []; // all current layers (polylines, markers)
    let _activeMapShift = 0;
    let _activeMapBus = 'all'; // 'all' or busId

    function initMap(allShifts) {
        // Populate shift selector
        const shiftSel = document.getElementById('mapShiftSelect');
        shiftSel.innerHTML = allShifts.map((sr, i) => '<option value="' + i + '">' + esc(sr.shift.label || 'Shift ' + (i + 1)) + '</option>').join('');
        _activeMapShift = 0;
        _activeMapBus = 'all';

        // Initialize map if needed
        const container = document.getElementById('routeMap');
        if (_map) { _map.remove(); _map = null; }

        _map = L.map(container, { scrollWheelZoom: true, zoomControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
            maxZoom: 19
        }).addTo(_map);

        renderMap();
    }

    function renderMap() {
        if (!_map || !_generatedRoutes) return;

        const shiftIdx = parseInt(document.getElementById('mapShiftSelect')?.value) || 0;
        _activeMapShift = shiftIdx;
        const sr = _generatedRoutes[shiftIdx];
        if (!sr) return;

        // Build bus tabs
        const tabsEl = document.getElementById('mapBusTabs');
        const routes = sr.routes.filter(r => r.stops.length > 0);
        tabsEl.innerHTML = '<button class="bus-tab all-tab' + (_activeMapBus === 'all' ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'all\')">All Buses</button>' +
            routes.map(r => '<button class="bus-tab' + (_activeMapBus === r.busId ? ' active' : '') + '" onclick="CampistryGo.selectMapBus(\'' + r.busId + '\')"><span class="bus-tab-dot" style="background:' + esc(r.busColor) + '"></span>' + esc(r.busName) + ' <span style="font-weight:400;color:var(--text-muted)">(' + r.camperCount + ')</span></button>').join('');

        // Clear existing layers
        _mapLayers.forEach(l => _map.removeLayer(l));
        _mapLayers = [];

        const allLatLngs = [];
        const visibleRoutes = _activeMapBus === 'all' ? routes : routes.filter(r => r.busId === _activeMapBus);

        visibleRoutes.forEach(route => {
            const stopsWithCoords = route.stops.filter(s => s.lat && s.lng);
            if (!stopsWithCoords.length) return;

            // Draw polyline between stops
            const latlngs = stopsWithCoords.map(s => [s.lat, s.lng]);
            allLatLngs.push(...latlngs);

            const polyline = L.polyline(latlngs, {
                color: route.busColor,
                weight: 4,
                opacity: _activeMapBus === 'all' ? 0.7 : 0.9,
                dashArray: null
            }).addTo(_map);
            _mapLayers.push(polyline);

            // Add stop markers
            stopsWithCoords.forEach(stop => {
                const isSpecial = stop.isMonitor || stop.isCounselor;
                const size = isSpecial ? 20 : 26;

                const icon = L.divIcon({
                    html: '<div class="stop-marker-icon" style="width:' + size + 'px;height:' + size + 'px;background:' + esc(route.busColor) + ';' + (isSpecial ? 'font-size:10px;' : '') + '">' + (isSpecial ? (stop.isMonitor ? 'M' : 'C') : stop.stopNum) + '</div>',
                    className: '',
                    iconSize: [size, size],
                    iconAnchor: [size / 2, size / 2]
                });

                const names = stop.isMonitor ? '🛡️ ' + (stop.monitorName || 'Monitor')
                    : stop.isCounselor ? '👤 ' + (stop.counselorName || 'Counselor')
                    : stop.campers.map(c => c.name).join('<br>');

                const popupContent = '<div style="font-family:DM Sans,sans-serif;min-width:140px;">'
                    + '<div style="font-weight:700;font-size:13px;margin-bottom:4px;color:' + route.busColor + '">' + esc(route.busName) + ' — Stop ' + stop.stopNum + '</div>'
                    + '<div style="font-size:12px;margin-bottom:4px;">' + names + '</div>'
                    + '<div style="font-size:11px;color:#888;">' + esc(stop.address) + '</div>'
                    + (stop.estimatedTime ? '<div style="font-size:12px;font-weight:600;margin-top:4px;">Est: ' + stop.estimatedTime + '</div>' : '')
                    + '</div>';

                const marker = L.marker([stop.lat, stop.lng], { icon }).addTo(_map);
                marker.bindPopup(popupContent);
                _mapLayers.push(marker);
            });
        });

        // Fit map to bounds
        if (allLatLngs.length > 0) {
            const bounds = L.latLngBounds(allLatLngs);
            _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
        }
    }

    function selectMapBus(busId) {
        _activeMapBus = busId;
        renderMap();
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
            if (t === 'fleet') renderFleet(); else if (t === 'shifts') renderShifts(); else if (t === 'staff') renderStaff(); else if (t === 'addresses') renderAddresses(); else if (t === 'routes') runPreflight();
        }));
        document.getElementById('addressSearch')?.addEventListener('input', () => { clearTimeout(_addrSearchTimer); _addrSearchTimer = setTimeout(renderAddresses, 200); });
    }
    let _addrSearchTimer;

    function init() {
        console.log('[Go] Initializing...');
        load(); initTabs(); populateSetup(); renderFleet(); renderShifts(); renderStaff(); renderAddresses(); updateStats(); updateBusSelects();

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
        openMonitorModal, saveMonitor, editMonitor, deleteMonitor,
        openCounselorModal, saveCounselor, editCounselor, deleteCounselor,
        editAddress, saveAddress, geocodeAll, downloadAddressTemplate, importAddressCsv,
        generateRoutes, exportRoutesCsv, printRoutes, detectRegions,
        renderMap, selectMapBus,
        closeModal, openModal
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
