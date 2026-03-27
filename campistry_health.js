// campistry_health.js — Campistry Health Engine v1.0
// Reads campers from Me roster (loadGlobalSettings), stores health data alongside it
(function(){
'use strict';
console.log('💜 Campistry Health loading...');

// ═══ COLORS ══════════════════════════════════════════════════
var AV_BG = ['#8B5CF6','#6366F1','#0EA5E9','#10B981','#F43F5E','#D97706','#14B8A6'];

// ═══ STATE ═══════════════════════════════════════════════════
var roster = {};       // from Me — read only
var structure = {};    // from Me — read only
var healthData = {};   // OUR data: meds, visits, allergies, etc.
var curTab = 'dashboard';
var editingMed = null;
var editingVisit = null;

// ═══ INIT ════════════════════════════════════════════════════
function init() {
    loadData();
    buildSidebar();
    showTab('dashboard');
    console.log('💜 Health ready:', Object.keys(roster).length, 'campers from Me');
}

// ═══ DATA LAYER ══════════════════════════════════════════════
// Reads camper roster + structure from Me (via cloud-synced global settings)
// Stores health-specific data under "campistryHealth" key
function loadData() {
    try {
        var g = readSettings();
        structure = g.campStructure || {};
        roster = (g.app1 && g.app1.camperRoster) || {};
        healthData = g.campistryHealth || {
            medications: [],
            dispensingLog: [],
            sickVisits: [],
            doctorVisits: [],
            allergies: [],
            dietary: [],
            nightLog: [],
            formStatus: {}
        };
        // Ensure all arrays exist
        if (!healthData.medications) healthData.medications = [];
        if (!healthData.dispensingLog) healthData.dispensingLog = [];
        if (!healthData.sickVisits) healthData.sickVisits = [];
        if (!healthData.doctorVisits) healthData.doctorVisits = [];
        if (!healthData.allergies) healthData.allergies = [];
        if (!healthData.dietary) healthData.dietary = [];
        if (!healthData.nightLog) healthData.nightLog = [];
        if (!healthData.formStatus) healthData.formStatus = {};
    } catch(e) { console.warn('[Health] loadData:', e); }
}

function readSettings() {
    if (typeof window.loadGlobalSettings === 'function') {
        try { return window.loadGlobalSettings() || {}; } catch(_) {}
    }
    var keys = ['campGlobalSettings_v1', 'CAMPISTRY_LOCAL_CACHE'];
    for (var i = 0; i < keys.length; i++) {
        try { var raw = localStorage.getItem(keys[i]); if (raw) return JSON.parse(raw) || {}; } catch(_) {}
    }
    return {};
}

function save() {
    try {
        var g = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
        g.campistryHealth = healthData;
        g.updated_at = new Date().toISOString();
        localStorage.setItem('campGlobalSettings_v1', JSON.stringify(g));
        if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
            window.saveGlobalSettings('campistryHealth', healthData);
        } else if (typeof window.forceSyncToCloud === 'function') {
            window.forceSyncToCloud();
        }
        setSyncStatus('synced');
    } catch(e) { console.error('[Health] Save:', e); setSyncStatus('error'); }
}

function setSyncStatus(s) {
    var dot = document.getElementById('syncDot');
    var txt = document.getElementById('syncText');
    if (dot) dot.className = 'sync-dot' + (s === 'syncing' ? ' syncing' : s === 'error' ? ' error' : '');
    if (txt) txt.textContent = s === 'syncing' ? 'Saving...' : s === 'error' ? 'Error' : 'Synced';
}

// ═══ HELPERS ═════════════════════════════════════════════════
function esc(s) { if (s === null || s === undefined) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function uid() { return 'h_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }
function initials(name) { var p = (name || '').split(' '); return (p[0] ? p[0][0] : '') + (p[1] ? p[1][0] : ''); }
function avColor(name) { var h = 0; for (var i = 0; i < (name||'').length; i++) h = (name||'').charCodeAt(i) + ((h << 5) - h); return AV_BG[Math.abs(h) % AV_BG.length]; }
function avatar(name, size) { var sz = size || 38; return '<div class="med-avatar" style="background:' + avColor(name) + ';width:' + sz + 'px;height:' + sz + 'px;font-size:' + (sz * 0.2) + 'rem;">' + esc(initials(name)) + '</div>'; }
function today() { return new Date().toISOString().split('T')[0]; }
function timeNow() { var d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
function formatDate(d) { if (!d) return '—'; try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch(e) { return d; } }
function formatTime12(t) { if (!t) return ''; var p = t.split(':'); var h = parseInt(p[0]); var m = p[1] || '00'; var ampm = h >= 12 ? 'PM' : 'AM'; h = h === 0 ? 12 : h > 12 ? h - 12 : h; return h + ':' + m + ' ' + ampm; }
function camperNames() { return Object.keys(roster).sort(); }

function toast(msg, type) {
    var el = document.getElementById('healthToast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.classList.add('show');
    setTimeout(function() { el.classList.remove('show'); }, 2500);
}

// ═══ SIDEBAR ═════════════════════════════════════════════════
function buildSidebar() {
    // Badge counts
    var medsDue = healthData.medications.filter(function(m) { return m.active; }).length;
    var visitsToday = healthData.sickVisits.filter(function(v) { return v.date === today(); }).length;
    updateBadge('medsBadge', medsDue);
    updateBadge('visitsBadge', visitsToday);
    updateBadge('campersBadge', Object.keys(roster).length);
}

function updateBadge(id, count) {
    var el = document.getElementById(id);
    if (el) { el.textContent = count; el.style.display = count > 0 ? '' : 'none'; }
}

// ═══ TAB NAVIGATION ══════════════════════════════════════════
function showTab(tab) {
    curTab = tab;
    // Hide all, show target
    document.querySelectorAll('.tab-content').forEach(function(t) { t.style.display = 'none'; });
    var target = document.getElementById('tab-' + tab);
    if (target) target.style.display = '';
    // Update sidebar active
    document.querySelectorAll('.sb-item').forEach(function(s) { s.classList.remove('active'); });
    var activeBtn = document.querySelector('.sb-item[data-tab="' + tab + '"]');
    if (activeBtn) activeBtn.classList.add('active');
    // Render
    loadData(); // refresh roster from Me on every tab switch
    if (tab === 'dashboard') renderDashboard();
    else if (tab === 'medications') renderMedications();
    else if (tab === 'sick-visits') renderSickVisits();
    else if (tab === 'allergies') renderAllergies();
    else if (tab === 'campers') renderCamperDirectory();
}

// ═══ DASHBOARD ═══════════════════════════════════════════════
function renderDashboard() {
    var names = camperNames();
    var meds = healthData.medications.filter(function(m) { return m.active; });
    var todayVisits = healthData.sickVisits.filter(function(v) { return v.date === today(); });
    var givenToday = healthData.dispensingLog.filter(function(d) { return d.date === today() && d.status === 'given'; });
    var severeAllergies = healthData.allergies.filter(function(a) { return a.severity === 'severe'; });

    // Stats
    document.getElementById('statMedsDue').textContent = meds.length;
    document.getElementById('statGiven').textContent = givenToday.length;
    document.getElementById('statVisits').textContent = todayVisits.length;
    document.getElementById('statAllergies').textContent = severeAllergies.length;

    // Med queue
    var queueEl = document.getElementById('medQueue');
    if (meds.length === 0) {
        queueEl.innerHTML = '<div class="empty-state"><h3>No medications</h3><p>Add medications in the Medications tab</p></div>';
    } else {
        var h = '';
        meds.forEach(function(m) {
            var wasGiven = healthData.dispensingLog.some(function(d) { return d.medId === m.id && d.date === today() && d.status === 'given'; });
            var cls = wasGiven ? 'done' : 'due-now';
            h += '<div class="med-item ' + cls + '">';
            h += avatar(m.camper);
            h += '<div class="med-info"><div class="med-name">' + esc(m.camper) + '</div>';
            h += '<div class="med-detail">' + esc(m.name) + ' ' + esc(m.dosage) + ' — ' + esc(m.schedule) + '</div></div>';
            h += '<div class="med-actions">';
            if (!wasGiven) {
                h += '<button class="btn btn-sm btn-ok" onclick="CampistryHealth.dispenseMed(\'' + esc(m.id) + '\')">Given</button>';
                h += '<button class="btn btn-sm btn-ghost" onclick="CampistryHealth.skipMed(\'' + esc(m.id) + '\')">Skip</button>';
            } else {
                h += '<span class="badge badge-green">Done</span>';
            }
            h += '</div></div>';
        });
        queueEl.innerHTML = h;
    }

    // Recent visits
    var visitEl = document.getElementById('recentVisits');
    if (todayVisits.length === 0) {
        visitEl.innerHTML = '<div class="empty-state"><h3>No visits today</h3><p>Visits will appear here when logged</p></div>';
    } else {
        var vh = '';
        todayVisits.slice().reverse().forEach(function(v) {
            vh += '<div class="visit-card"><div class="visit-time">' + formatTime12(v.time) + '</div>';
            vh += '<div class="visit-body"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">';
            vh += '<span class="visit-camper">' + esc(v.camper) + '</span>';
            vh += '<span class="badge badge-' + (v.disposition === 'returned' ? 'green' : v.disposition === 'infirmary' ? 'blue' : 'amber') + '">' + esc(v.disposition || 'pending') + '</span>';
            vh += '</div><div style="font-size:.82rem;color:var(--text-secondary)">' + esc(v.complaint) + '</div>';
            if (v.treatment) vh += '<div style="font-size:.75rem;color:var(--text-muted);margin-top:4px">Tx: ' + esc(v.treatment) + '</div>';
            vh += '</div></div>';
        });
        visitEl.innerHTML = vh;
    }

    // Allergy alerts
    var allergyEl = document.getElementById('allergyAlerts');
    if (severeAllergies.length === 0) {
        allergyEl.innerHTML = '<div class="empty-state"><p>No severe allergies on file</p></div>';
    } else {
        var ah = '';
        severeAllergies.forEach(function(a) {
            ah += '<div style="padding:10px 14px;background:#FEE2E2;border:1px solid #FECACA;border-radius:var(--r);margin-bottom:8px;font-size:.82rem;">';
            ah += '<strong>' + esc(a.camper) + '</strong> — ' + esc(a.allergen) + ' (Severe)';
            if (a.protocol) ah += '<div style="font-size:.72rem;color:var(--text-muted);margin-top:4px">' + esc(a.protocol) + '</div>';
            ah += '</div>';
        });
        allergyEl.innerHTML = ah;
    }

    buildSidebar();
}

// ═══ MEDICATIONS TAB ═════════════════════════════════════════
function renderMedications() {
    var meds = healthData.medications;
    var container = document.getElementById('medTable');
    if (meds.length === 0) {
        container.innerHTML = '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"/></svg><h3>No medications yet</h3><p>Add a camper\'s medication to start tracking</p></div>';
        return;
    }
    var h = '<table class="data-table"><thead><tr><th></th><th>Camper</th><th>Medication</th><th>Dosage</th><th>Schedule</th><th>Status</th><th></th></tr></thead><tbody>';
    meds.forEach(function(m) {
        var givenToday = healthData.dispensingLog.some(function(d) { return d.medId === m.id && d.date === today() && d.status === 'given'; });
        h += '<tr>';
        h += '<td>' + avatar(m.camper, 32) + '</td>';
        h += '<td style="font-weight:700">' + esc(m.camper) + '</td>';
        h += '<td>' + esc(m.name) + '</td>';
        h += '<td>' + esc(m.dosage) + '</td>';
        h += '<td>' + esc(m.schedule) + '</td>';
        h += '<td><span class="badge ' + (givenToday ? 'badge-green' : m.active ? 'badge-purple' : 'badge-gray') + '">' + (givenToday ? 'Given today' : m.active ? 'Active' : 'Inactive') + '</span></td>';
        h += '<td><button class="btn btn-sm btn-ghost" onclick="CampistryHealth.editMed(\'' + esc(m.id) + '\')">Edit</button> ';
        h += '<button class="btn btn-sm btn-danger" onclick="CampistryHealth.deleteMed(\'' + esc(m.id) + '\')">×</button></td>';
        h += '</tr>';
    });
    h += '</tbody></table>';
    container.innerHTML = h;
}

function openMedModal(id) {
    editingMed = id || null;
    var m = id ? healthData.medications.find(function(x) { return x.id === id; }) : null;
    document.getElementById('medModalTitle').textContent = id ? 'Edit Medication' : 'Add Medication';
    // Populate camper select
    var sel = document.getElementById('medCamper');
    sel.innerHTML = '<option value="">Select camper...</option>' + camperNames().map(function(n) {
        return '<option value="' + esc(n) + '"' + (m && m.camper === n ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
    document.getElementById('medName').value = m ? m.name : '';
    document.getElementById('medDosage').value = m ? m.dosage : '';
    document.getElementById('medSchedule').value = m ? m.schedule : '';
    document.getElementById('medNotes').value = m ? m.notes || '' : '';
    document.getElementById('medActive').checked = m ? m.active : true;
    openModal('medModal');
}

function saveMed() {
    var camper = document.getElementById('medCamper').value;
    var name = document.getElementById('medName').value.trim();
    if (!camper || !name) { toast('Camper and medication name required', 'error'); return; }
    var data = {
        id: editingMed || uid(),
        camper: camper,
        name: name,
        dosage: document.getElementById('medDosage').value.trim(),
        schedule: document.getElementById('medSchedule').value.trim(),
        notes: document.getElementById('medNotes').value.trim(),
        active: document.getElementById('medActive').checked,
        createdAt: editingMed ? undefined : new Date().toISOString()
    };
    if (editingMed) {
        var idx = healthData.medications.findIndex(function(m) { return m.id === editingMed; });
        if (idx >= 0) { var existing = healthData.medications[idx]; data.createdAt = existing.createdAt; healthData.medications[idx] = data; }
    } else {
        healthData.medications.push(data);
    }
    save(); closeModal('medModal'); showTab(curTab); toast(editingMed ? 'Medication updated' : 'Medication added');
}

function deleteMed(id) {
    if (!confirm('Delete this medication?')) return;
    healthData.medications = healthData.medications.filter(function(m) { return m.id !== id; });
    save(); showTab(curTab); toast('Medication deleted');
}

function editMed(id) { openMedModal(id); }

function dispenseMed(id) {
    healthData.dispensingLog.push({ id: uid(), medId: id, date: today(), time: timeNow(), status: 'given', nurse: 'Current User' });
    save(); showTab(curTab); toast('Medication marked as given');
}

function skipMed(id) {
    healthData.dispensingLog.push({ id: uid(), medId: id, date: today(), time: timeNow(), status: 'skipped', nurse: 'Current User' });
    save(); showTab(curTab); toast('Medication skipped');
}

// ═══ SICK VISITS TAB ═════════════════════════════════════════
function renderSickVisits() {
    var visits = healthData.sickVisits;
    var container = document.getElementById('visitTable');
    if (visits.length === 0) {
        container.innerHTML = '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><h3>No visits recorded</h3><p>Log a sick visit when a camper comes to the health center</p></div>';
        return;
    }
    var h = '<table class="data-table"><thead><tr><th>Date</th><th>Time</th><th>Camper</th><th>Complaint</th><th>Treatment</th><th>Disposition</th><th></th></tr></thead><tbody>';
    visits.slice().reverse().forEach(function(v) {
        h += '<tr>';
        h += '<td style="font-weight:600;color:var(--text-muted)">' + formatDate(v.date) + '</td>';
        h += '<td>' + formatTime12(v.time) + '</td>';
        h += '<td style="font-weight:700">' + esc(v.camper) + '</td>';
        h += '<td>' + esc(v.complaint) + '</td>';
        h += '<td>' + esc(v.treatment || '—') + '</td>';
        h += '<td><span class="badge badge-' + (v.disposition === 'returned' ? 'green' : v.disposition === 'infirmary' ? 'blue' : v.disposition === 'sent-home' ? 'red' : 'amber') + '">' + esc(v.disposition || 'pending') + '</span></td>';
        h += '<td><button class="btn btn-sm btn-danger" onclick="CampistryHealth.deleteVisit(\'' + esc(v.id) + '\')">×</button></td>';
        h += '</tr>';
    });
    h += '</tbody></table>';
    container.innerHTML = h;
}

function openVisitModal() {
    editingVisit = null;
    var sel = document.getElementById('visitCamper');
    sel.innerHTML = '<option value="">Select camper...</option>' + camperNames().map(function(n) {
        return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    }).join('');
    document.getElementById('visitComplaint').value = '';
    document.getElementById('visitTemp').value = '';
    document.getElementById('visitTreatment').value = '';
    document.getElementById('visitDisposition').value = 'returned';
    document.getElementById('visitNotes').value = '';
    // Reset chips
    document.querySelectorAll('#visitChips .form-chip').forEach(function(c) { c.classList.remove('selected'); });
    openModal('visitModal');
}

function saveVisit() {
    var camper = document.getElementById('visitCamper').value;
    var complaint = document.getElementById('visitComplaint').value.trim();
    // Also grab selected chips
    var chips = [];
    document.querySelectorAll('#visitChips .form-chip.selected').forEach(function(c) { chips.push(c.textContent); });
    if (chips.length && !complaint) complaint = chips.join(', ');
    if (!camper) { toast('Select a camper', 'error'); return; }
    if (!complaint) { toast('Enter a complaint', 'error'); return; }
    var visit = {
        id: uid(), camper: camper, date: today(), time: timeNow(),
        complaint: complaint,
        temperature: document.getElementById('visitTemp').value.trim(),
        treatment: document.getElementById('visitTreatment').value.trim(),
        disposition: document.getElementById('visitDisposition').value,
        notes: document.getElementById('visitNotes').value.trim()
    };
    healthData.sickVisits.push(visit);
    save(); closeModal('visitModal'); showTab(curTab); toast('Visit logged');
}

function deleteVisit(id) {
    if (!confirm('Delete this visit record?')) return;
    healthData.sickVisits = healthData.sickVisits.filter(function(v) { return v.id !== id; });
    save(); showTab(curTab); toast('Visit deleted');
}

// ═══ ALLERGIES TAB ═══════════════════════════════════════════
function renderAllergies() {
    var allergies = healthData.allergies;
    var container = document.getElementById('allergyTable');
    if (allergies.length === 0) {
        container.innerHTML = '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z"/></svg><h3>No allergies recorded</h3><p>Add allergy records for campers</p></div>';
        return;
    }
    var h = '<table class="data-table"><thead><tr><th>Camper</th><th>Allergen</th><th>Category</th><th>Severity</th><th>Protocol</th><th></th></tr></thead><tbody>';
    allergies.forEach(function(a) {
        h += '<tr>';
        h += '<td style="font-weight:700">' + esc(a.camper) + '</td>';
        h += '<td>' + esc(a.allergen) + '</td>';
        h += '<td><span class="badge badge-gray">' + esc(a.category || 'Other') + '</span></td>';
        h += '<td><span class="badge badge-' + (a.severity === 'severe' ? 'red' : a.severity === 'moderate' ? 'amber' : 'green') + '">' + esc(a.severity) + '</span></td>';
        h += '<td style="font-size:.78rem">' + esc(a.protocol || '—') + '</td>';
        h += '<td><button class="btn btn-sm btn-danger" onclick="CampistryHealth.deleteAllergy(\'' + esc(a.id) + '\')">×</button></td>';
        h += '</tr>';
    });
    h += '</tbody></table>';
    container.innerHTML = h;
}

function openAllergyModal() {
    var sel = document.getElementById('allergyCamper');
    sel.innerHTML = '<option value="">Select camper...</option>' + camperNames().map(function(n) {
        return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    }).join('');
    document.getElementById('allergyAllergen').value = '';
    document.getElementById('allergyCategory').value = 'food';
    document.getElementById('allergySeverity').value = 'moderate';
    document.getElementById('allergyProtocol').value = '';
    openModal('allergyModal');
}

function saveAllergy() {
    var camper = document.getElementById('allergyCamper').value;
    var allergen = document.getElementById('allergyAllergen').value.trim();
    if (!camper || !allergen) { toast('Camper and allergen required', 'error'); return; }
    healthData.allergies.push({
        id: uid(), camper: camper, allergen: allergen,
        category: document.getElementById('allergyCategory').value,
        severity: document.getElementById('allergySeverity').value,
        protocol: document.getElementById('allergyProtocol').value.trim()
    });
    save(); closeModal('allergyModal'); showTab(curTab); toast('Allergy added');
}

function deleteAllergy(id) {
    if (!confirm('Delete this allergy record?')) return;
    healthData.allergies = healthData.allergies.filter(function(a) { return a.id !== id; });
    save(); showTab(curTab); toast('Allergy deleted');
}

// ═══ CAMPER DIRECTORY ════════════════════════════════════════
function renderCamperDirectory() {
    var names = camperNames();
    var container = document.getElementById('camperTableBody');
    if (names.length === 0) {
        container.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">No campers found. Add campers in <a href="campistry_me.html" style="color:var(--health);font-weight:600">Campistry Me</a> first.</td></tr>';
        return;
    }
    var h = '';
    names.forEach(function(n) {
        var c = roster[n];
        var hasMed = (c.allergies || c.medications);
        h += '<tr class="click" onclick="CampistryHealth.viewCamper(\'' + esc(n).replace(/'/g, "\\'") + '\')">';
        h += '<td>' + avatar(n, 32) + '</td>';
        h += '<td style="font-weight:700">' + esc(n) + '</td>';
        h += '<td>' + esc(c.division || '—') + '</td>';
        h += '<td>' + esc(c.bunk || '—') + '</td>';
        h += '<td>' + (hasMed ? '<span class="badge badge-red" style="font-size:.65rem">⚠ ' + esc((c.allergies || c.medications || '').split(',')[0]) + '</span>' : '<span style="color:var(--text-muted)">—</span>') + '</td>';
        h += '<td style="font-size:.78rem">' + esc(c.parent1Name || '—') + '</td>';
        h += '<td style="font-size:.78rem">' + (c.emergencyPhone ? '<a href="tel:' + esc(c.emergencyPhone) + '" style="color:var(--health)">' + esc(c.emergencyPhone) + '</a>' : '—') + '</td>';
        h += '</tr>';
    });
    container.innerHTML = h;
}

function viewCamper(name) {
    var c = roster[name];
    if (!c) return;
    var idStr = c.camperId ? String(c.camperId).padStart(4, '0') : '—';
    var h = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">' + avatar(name, 48);
    h += '<div><div style="font-weight:700;font-size:1.1rem">' + esc(name) + '</div>';
    h += '<div style="font-size:.78rem;color:var(--text-muted)">' + esc(c.division || '') + ' · ' + esc(c.bunk || '') + ' · #' + esc(idStr) + '</div></div></div>';
    // Contact info
    h += '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:16px 0 8px">Contact (from Campistry Me)</div>';
    if (c.parent1Name) h += infoRow('Parent', c.parent1Name);
    if (c.parent1Phone) h += infoRow('Phone', '<a href="tel:' + esc(c.parent1Phone) + '" style="color:var(--health);font-weight:600">' + esc(c.parent1Phone) + '</a>');
    if (c.parent1Email) h += infoRow('Email', '<a href="mailto:' + esc(c.parent1Email) + '" style="color:var(--health);font-weight:600">' + esc(c.parent1Email) + '</a>');
    // Emergency
    h += '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:16px 0 8px">Emergency Contact</div>';
    if (c.emergencyName) h += infoRow('Name', c.emergencyName + (c.emergencyRel ? ' (' + c.emergencyRel + ')' : ''));
    if (c.emergencyPhone) h += infoRow('Phone', '<a href="tel:' + esc(c.emergencyPhone) + '" style="color:var(--health);font-weight:600">' + esc(c.emergencyPhone) + '</a>');
    if (!c.emergencyName && !c.emergencyPhone) h += '<div style="font-size:.82rem;color:var(--err)">Not on file</div>';
    // Medical flags from Me
    h += '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:16px 0 8px">Medical Flags (from Me)</div>';
    if (c.allergies) h += infoRow('Allergies', '<span style="color:var(--err);font-weight:600">' + esc(c.allergies) + '</span>');
    if (c.medications) h += infoRow('Medications', esc(c.medications));
    if (c.dietary) h += infoRow('Dietary', esc(c.dietary));
    if (!c.allergies && !c.medications && !c.dietary) h += '<div style="font-size:.82rem;color:var(--ok)">✓ No medical flags</div>';
    // Health records
    var camperMeds = healthData.medications.filter(function(m) { return m.camper === name; });
    var camperVisits = healthData.sickVisits.filter(function(v) { return v.camper === name; });
    var camperAllergies = healthData.allergies.filter(function(a) { return a.camper === name; });
    h += '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:16px 0 8px">Health Records</div>';
    h += infoRow('Medications', camperMeds.length + ' active');
    h += infoRow('Sick Visits', camperVisits.length + ' total');
    h += infoRow('Allergies', camperAllergies.length + ' on file');

    document.getElementById('camperDetailBody').innerHTML = h;
    document.getElementById('camperDetailTitle').textContent = name;
    openModal('camperDetailModal');
}

function infoRow(label, value) {
    return '<div style="display:flex;justify-content:space-between;align-items:flex-start;font-size:.82rem;padding:4px 0;gap:12px"><span style="color:var(--text-muted);font-weight:500;flex-shrink:0;min-width:80px">' + esc(label) + '</span><span style="color:var(--text-primary);text-align:right">' + value + '</span></div>';
}

function filterCampers(q) {
    q = q.toLowerCase();
    document.querySelectorAll('#camperTableBody tr').forEach(function(row) {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}

// ═══ MODAL HELPERS ═══════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function toggleChip(el) {
    el.classList.toggle('selected');
}

// ═══ PUBLIC API ══════════════════════════════════════════════
window.CampistryHealth = {
    init: init,
    showTab: showTab,
    openMedModal: openMedModal, saveMed: saveMed, editMed: editMed, deleteMed: deleteMed,
    dispenseMed: dispenseMed, skipMed: skipMed,
    openVisitModal: openVisitModal, saveVisit: saveVisit, deleteVisit: deleteVisit,
    openAllergyModal: openAllergyModal, saveAllergy: saveAllergy, deleteAllergy: deleteAllergy,
    viewCamper: viewCamper, filterCampers: filterCampers,
    openModal: openModal, closeModal: closeModal, toggleChip: toggleChip
};

// Close modals on overlay click + ESC
document.addEventListener('click', function(e) { if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open'); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(function(m) { m.classList.remove('open'); }); });

// Listen for cloud data arriving
window.addEventListener('campistry-cloud-hydrated', function() { console.log('[Health] Cloud data hydrated'); loadData(); showTab(curTab); });

})();
