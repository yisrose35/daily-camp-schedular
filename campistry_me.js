// =============================================================================
// campistry_me.js — Campistry Me Application Engine
// =============================================================================
// Matches Flow's navigation pattern. No attendance module.
// Camper detail = centered modal. No auto-generated families.
// No bunk capacity limits. Full camper editing.
// =============================================================================

(function() {
    'use strict';
    console.log('📋 Campistry Me loading...');

    const COLOR_PRESETS = ['#147D91','#8B5CF6','#0EA5E9','#10B981','#F43F5E','#EC4899','#F59E0B','#84CC16'];
    const AVATAR_BG = ['#147D91','#6366F1','#0EA5E9','#10B981','#F43F5E','#8B5CF6','#F59E0B'];

    // ── State ────────────────────────────────────────────────────────
    let structure = {}, camperRoster = {}, families = {}, payments = [];
    let broadcasts = [], bunkAssignments = {};
    let currentPage = 'families';
    let editingCamper = null; // name of camper being edited

    // ── Init ─────────────────────────────────────────────────────────
    function init() {
        loadData();
        setupSidebar();
        setupSearch();
        setupModals();
        navigateTo('families');
        console.log('📋 Me ready:', Object.keys(camperRoster).length, 'campers');
    }

    // ── Data ─────────────────────────────────────────────────────────
    function loadData() {
        try {
            var s = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
            structure = s.campStructure || {};
            camperRoster = (s.app1 && s.app1.camperRoster) || {};
            var me = s.campistryMe || {};
            families = me.families || {};
            payments = me.payments || [];
            broadcasts = me.broadcasts || [];
            bunkAssignments = me.bunkAssignments || {};
        } catch (e) { console.warn('[Me] Load error:', e); }
    }

    function saveData() {
        try {
            var g = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
            g.campStructure = structure;
            if (!g.app1) g.app1 = {};
            g.app1.camperRoster = camperRoster;
            // Safe merge: preserve Flow's time data
            var existing = (g.app1 && g.app1.divisions) || {};
            var merged = {};
            Object.entries(structure).forEach(function([d, dd]) {
                var bunks = [];
                Object.values(dd.grades || {}).forEach(function(gr) { (gr.bunks || []).forEach(function(b) { bunks.push(b); }); });
                merged[d] = Object.assign({}, existing[d] || {}, { color: dd.color, bunks: bunks });
            });
            Object.keys(existing).forEach(function(d) { if (!merged[d]) merged[d] = existing[d]; });
            g.app1.divisions = merged;
            g.campistryMe = { families: families, payments: payments, broadcasts: broadcasts, bunkAssignments: bunkAssignments };
            g.updated_at = new Date().toISOString();
            localStorage.setItem('campGlobalSettings_v1', JSON.stringify(g));
            if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
                window.saveGlobalSettings('campStructure', structure);
                window.saveGlobalSettings('app1', g.app1);
                window.saveGlobalSettings('campistryMe', g.campistryMe);
            } else if (typeof window.forceSyncToCloud === 'function') { window.forceSyncToCloud(); }
        } catch (e) { console.error('[Me] Save error:', e); }
    }

    // ── Sidebar (Flow's hamburger pattern) ───────────────────────────
    function setupSidebar() {
        var hamburger = document.getElementById('hamburgerBtn');
        var backdrop = document.getElementById('sidebarBackdrop');
        var sidebar = document.getElementById('sidebar');
        function openSB() { document.body.classList.add('sidebar-open'); }
        function closeSB() { document.body.classList.remove('sidebar-open'); }
        if (hamburger) hamburger.onclick = function() { document.body.classList.contains('sidebar-open') ? closeSB() : openSB(); };
        if (backdrop) backdrop.onclick = closeSB;
        if (sidebar) sidebar.querySelectorAll('.sidebar-item').forEach(function(btn) {
            btn.onclick = function() { navigateTo(btn.dataset.page); closeSB(); };
        });
    }

    function navigateTo(page) {
        currentPage = page;
        document.querySelectorAll('.sidebar-item').forEach(function(b) { b.classList.toggle('active', b.dataset.page === page); });
        document.querySelectorAll('.me-page').forEach(function(p) { p.classList.toggle('active', p.id === 'page-' + page); });
        renderPage(page);
    }

    // ── Search ───────────────────────────────────────────────────────
    function setupSearch() {
        var input = document.getElementById('globalSearch');
        if (!input) return;
        var t;
        input.oninput = function() { clearTimeout(t); t = setTimeout(function() { if (currentPage === 'campers') renderCampers(input.value.trim()); }, 200); };
    }

    // ── Helpers ──────────────────────────────────────────────────────
    function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function getAge(dob) { if (!dob) return ''; var a = Math.floor((Date.now() - new Date(dob).getTime()) / 31557600000); return a >= 0 && a < 25 ? a : ''; }
    function getInitials(name) { var p = name.split(' '); return ((p[0]||'?')[0] + (p.length>1?(p[p.length-1]||'?')[0]:'')).toUpperCase(); }
    function avColor(name) { var h = 0; for (var i = 0; i < name.length; i++) h += name.charCodeAt(i); return AVATAR_BG[h % AVATAR_BG.length]; }
    function avHtml(name, size) {
        var w = size === 'lg' ? 52 : size === 'md' ? 38 : 28;
        var fs = size === 'lg' ? 17 : size === 'md' ? 13 : 10;
        return '<div class="me-avatar me-avatar--' + size + '" style="background:' + avColor(name) + '">' + esc(getInitials(name)) + '</div>';
    }
    function badge(label, type) { return '<span class="me-badge me-badge--' + type + '">' + esc(label) + '</span>'; }
    function divTag(div) {
        var c = (structure[div] && structure[div].color) || '#94A3B8';
        return '<span class="me-div-tag" style="background:' + c + '10;color:' + c + '"><span class="me-div-dot" style="background:' + c + '"></span>' + esc(div) + '</span>';
    }
    function fmtMoney(n) { return '$' + Number(n || 0).toLocaleString(); }
    function toast(msg, type) {
        var el = document.getElementById('meToast');
        if (!el) return;
        el.className = 'me-toast ' + (type || 'success') + ' visible';
        document.getElementById('toastIcon').textContent = type === 'error' ? '✕' : '✓';
        document.getElementById('toastMessage').textContent = msg;
        clearTimeout(el._t);
        el._t = setTimeout(function() { el.classList.remove('visible'); }, 2600);
    }

    // ── Modals ───────────────────────────────────────────────────────
    function setupModals() {
        document.querySelectorAll('.me-modal-overlay').forEach(function(o) {
            o.addEventListener('mousedown', function(e) { if (e.target === o) closeModal(o.id); });
        });
        var dz = document.getElementById('csvDropzone'), fi = document.getElementById('csvFileInput');
        if (dz && fi) {
            dz.onclick = function() { fi.click(); };
            dz.ondragover = function(e) { e.preventDefault(); dz.classList.add('dragover'); };
            dz.ondragleave = function() { dz.classList.remove('dragover'); };
            dz.ondrop = function(e) { e.preventDefault(); dz.classList.remove('dragover'); handleCsv(e.dataTransfer.files[0]); };
            fi.onchange = function(e) { handleCsv(e.target.files[0]); };
        }
    }
    function openModal(id) { var e = document.getElementById(id); if (e) e.style.display = 'flex'; }
    function closeModal(id) { var e = document.getElementById(id); if (e) e.style.display = 'none'; }

    // ── Page Renderers ───────────────────────────────────────────────
    function renderPage(p) {
        var map = { families: renderFamilies, campers: renderCampers, structure: renderStructure, bunkbuilder: renderBunkBuilder, billing: renderBilling, broadcasts: renderBroadcasts };
        if (map[p]) map[p]();
        else renderComingSoon(p);
    }

    // ─── FAMILIES ────────────────────────────────────────────────────
    function renderFamilies() {
        var c = document.getElementById('page-families');
        var entries = Object.entries(families);
        var h = '<div class="me-section-header"><div><h2 class="me-section-title">Families</h2><p class="me-section-desc">' + entries.length + ' household' + (entries.length !== 1 ? 's' : '') + '</p></div>' +
            '<div class="me-section-actions"><button class="me-btn me-btn--primary" onclick="CampistryMe.addFamily()">+ Add Family</button></div></div>';
        if (!entries.length) {
            h += '<div class="me-empty"><h3>No families yet</h3><p>Add families to manage households and billing.</p><button class="me-btn me-btn--primary" onclick="CampistryMe.addFamily()">+ Add Family</button></div>';
        } else {
            entries.forEach(function([id, f]) {
                h += '<div class="me-family-card"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
                    '<div><div style="font-size:0.95rem;font-weight:600;color:var(--slate-800)">' + esc(f.name) + '</div>' +
                    '<div style="font-size:0.75rem;color:var(--slate-500)">' + (f.camperIds||[]).length + ' camper' + ((f.camperIds||[]).length !== 1 ? 's' : '') + '</div></div>' +
                    (f.balance > 0 ? badge(fmtMoney(f.balance) + ' due', 'red') : f.totalPaid > 0 ? badge('Paid', 'green') : badge('Pending', 'amber')) + '</div>';
                (f.households || []).forEach(function(hh) {
                    h += '<div class="me-household"><div style="font-size:0.65rem;font-weight:600;color:var(--slate-400);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">' + esc(hh.label || 'Primary') + (hh.billingContact ? ' · Billing' : '') + '</div>';
                    (hh.parents || []).forEach(function(p) {
                        h += '<div style="font-size:0.8rem;margin-bottom:2px"><strong>' + esc(p.name) + '</strong>';
                        if (p.phone) h += ' — <a href="tel:' + esc(p.phone) + '" style="color:var(--camp-green)">' + esc(p.phone) + '</a>';
                        h += '</div>';
                    });
                    if (hh.address) h += '<div style="font-size:0.7rem;color:var(--slate-400);margin-top:2px">' + esc(hh.address) + '</div>';
                    h += '</div>';
                });
                h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">';
                (f.camperIds || []).forEach(function(cn) {
                    h += '<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:6px;border:1px solid var(--slate-200);font-size:0.7rem;font-weight:600;cursor:pointer" onclick="CampistryMe.viewCamper(\'' + esc(cn).replace(/'/g, "\\'") + '\')">' + avHtml(cn, 'sm') + ' ' + esc(cn.split(' ')[0]) + '</span>';
                });
                h += '</div></div>';
            });
        }
        c.innerHTML = h;
    }

    // ─── CAMPERS ─────────────────────────────────────────────────────
    function renderCampers(filter) {
        var c = document.getElementById('page-campers');
        var entries = Object.entries(camperRoster);
        var total = entries.length;
        if (filter) { var q = filter.toLowerCase(); entries = entries.filter(function([n, d]) { return n.toLowerCase().includes(q) || (d.division||'').toLowerCase().includes(q) || (d.bunk||'').toLowerCase().includes(q); }); }
        entries.sort(function(a, b) { return a[0].localeCompare(b[0]); });

        var h = '<div class="me-section-header"><div><h2 class="me-section-title">Campers</h2><p class="me-section-desc">' + total + ' total</p></div>' +
            '<div class="me-section-actions">' +
            '<button class="me-btn me-btn--secondary" onclick="CampistryMe.openCsvModal()">Import CSV</button>' +
            '<button class="me-btn me-btn--secondary" onclick="CampistryMe.exportCsv()">Export CSV</button>' +
            '<button class="me-btn me-btn--primary" onclick="CampistryMe.addCamper()">+ Add Camper</button></div></div>';

        if (!entries.length) {
            h += '<div class="me-empty"><h3>No campers yet</h3><p>Add campers individually or import from CSV.</p>' +
                '<div style="display:flex;gap:8px;justify-content:center"><button class="me-btn me-btn--primary" onclick="CampistryMe.addCamper()">+ Add Camper</button>' +
                '<button class="me-btn me-btn--secondary" onclick="CampistryMe.openCsvModal()">Import CSV</button></div></div>';
        } else {
            h += '<div class="me-card"><div class="me-table-wrap"><table class="me-table"><thead><tr>' +
                '<th style="width:32px"></th><th>Name</th><th>Age</th><th>Division</th><th>Bunk</th><th>Team</th><th>Medical</th><th style="width:80px"></th></tr></thead><tbody>';
            entries.forEach(function([name, d]) {
                var hasMed = !!(d.allergies || d.medications);
                h += '<tr class="clickable" onclick="CampistryMe.viewCamper(\'' + esc(name).replace(/'/g, "\\'") + '\')">' +
                    '<td>' + avHtml(name, 'sm') + '</td>' +
                    '<td class="td-name">' + esc(name) + '</td>' +
                    '<td>' + (d.dob ? getAge(d.dob) : '—') + '</td>' +
                    '<td>' + (d.division ? divTag(d.division) : '<span style="color:var(--slate-300)">—</span>') + '</td>' +
                    '<td>' + esc(d.bunk || '—') + '</td>' +
                    '<td>' + esc(d.team || '—') + '</td>' +
                    '<td>' + (hasMed ? '<span style="color:var(--red);font-size:0.7rem;font-weight:600">⚠ ' + esc((d.allergies||d.medications||'').split(',')[0]) + '</span>' : '<span style="color:var(--slate-300)">—</span>') + '</td>' +
                    '<td style="text-align:right" onclick="event.stopPropagation()">' +
                    '<button class="me-btn me-btn--sm me-btn--secondary" onclick="CampistryMe.editCamper(\'' + esc(name).replace(/'/g, "\\'") + '\')">Edit</button></td></tr>';
            });
            h += '</tbody></table></div></div>';
        }
        c.innerHTML = h;
    }

    // ─── VIEW CAMPER (centered modal) ────────────────────────────────
    function viewCamper(name) {
        var d = camperRoster[name];
        if (!d) return;
        var header = '<div class="cd-header">' + avHtml(name, 'lg') +
            '<div><h3 class="cd-name">' + esc(name) + '</h3><div class="cd-tags">' +
            (d.division ? divTag(d.division) : '') +
            (d.bunk ? ' <span class="me-badge me-badge--gray">' + esc(d.bunk) + '</span>' : '') +
            '</div></div></div>';
        document.getElementById('camperDetailHeader').innerHTML = header;

        var b = '';
        b += '<div class="cd-section-title">Personal</div>';
        if (d.dob) b += cdRow('Date of Birth', new Date(d.dob + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + ' (age ' + getAge(d.dob) + ')');
        b += cdRow('Gender', d.gender);
        b += cdRow('School Grade', d.schoolGrade);
        b += cdRow('Team', d.team);

        b += '<div class="cd-section-title">Medical Summary</div>';
        if (d.allergies) b += cdRow('Allergies', d.allergies, true);
        if (d.medications) b += cdRow('Medications', d.medications, true);
        if (d.dietary) b += cdRow('Dietary', d.dietary);
        if (!d.allergies && !d.medications && !d.dietary) b += '<div style="font-size:0.8rem;color:var(--green);padding:2px 0">✓ No medical flags</div>';
        b += '<div class="cd-health-link" onclick="toast(\'Campistry Health coming soon\',\'error\')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> Open in Campistry Health →</div>';

        b += '<div class="cd-section-title">Emergency Contact</div>';
        if (d.emergencyName) {
            b += cdRow('Contact', d.emergencyName + (d.emergencyRel ? ' (' + d.emergencyRel + ')' : ''));
            if (d.emergencyPhone) b += cdRow('Phone', '<a href="tel:' + esc(d.emergencyPhone) + '">' + esc(d.emergencyPhone) + '</a>');
        } else { b += '<div style="font-size:0.8rem;color:var(--red);font-style:italic">No emergency contact on file</div>'; }

        document.getElementById('camperDetailBody').innerHTML = b;
        document.getElementById('editCamperFromDetail').onclick = function() { closeModal('camperDetailModal'); editCamper(name); };
        openModal('camperDetailModal');
    }

    function cdRow(label, value, warn) {
        if (!value) return '';
        return '<div class="cd-row"><span class="cd-row-label">' + esc(label) + '</span><span class="cd-row-value' + (warn ? ' warn' : '') + '">' + value + '</span></div>';
    }

    // ─── EDIT / ADD CAMPER (full form modal) ─────────────────────────
    function editCamper(name) {
        editingCamper = name;
        var d = name ? camperRoster[name] || {} : {};
        var parts = (name || '').split(' ');
        document.getElementById('camperEditTitle').textContent = name ? 'Edit Camper' : 'Add Camper';

        var h = '<div class="me-form-section-title">Identity</div>' +
            '<div class="me-form-row">' + formField('First Name', 'ceFirst', parts[0] || '') + formField('Last Name', 'ceLast', parts.slice(1).join(' ') || '') + '</div>' +
            '<div class="me-form-row">' + formField('Date of Birth', 'ceDob', d.dob || '', 'date') + formField('Gender', 'ceGender', d.gender || '', 'select', ['','Male','Female','Non-binary','Other']) + '</div>' +
            formField('School Grade', 'ceSchool', d.schoolGrade || '');

        h += '<div class="me-form-section-title">Camp Assignment</div>' +
            '<div class="me-form-row">' + formField('Division', 'ceDiv', d.division || '', 'select', [''].concat(Object.keys(structure).sort())) + formField('Grade', 'ceGrade', d.grade || '', 'select', getGradeOpts(d.division)) + '</div>' +
            '<div class="me-form-row">' + formField('Bunk', 'ceBunk', d.bunk || '', 'select', getBunkOpts(d.division, d.grade)) + formField('Team', 'ceTeam', d.team || '') + '</div>';

        h += '<div class="me-form-section-title">Parent / Guardian</div>' +
            '<div class="me-form-row">' + formField('Parent 1 Name', 'ceP1Name', d.parent1Name || '') + formField('Parent 1 Phone', 'ceP1Phone', d.parent1Phone || '') + '</div>' +
            formField('Parent 1 Email', 'ceP1Email', d.parent1Email || '', 'email');

        h += '<div class="me-form-section-title">Emergency Contact</div>' +
            '<div class="me-form-row">' + formField('Name', 'ceEmName', d.emergencyName || '') + formField('Phone', 'ceEmPhone', d.emergencyPhone || '') + '</div>' +
            formField('Relation', 'ceEmRel', d.emergencyRel || '');

        h += '<div class="me-form-section-title">Medical (quick glance — full records in Health)</div>' +
            '<div class="me-form-row">' + formField('Allergies', 'ceAllergy', d.allergies || '') + formField('Medications', 'ceMeds', d.medications || '') + '</div>' +
            formField('Dietary Restrictions', 'ceDiet', d.dietary || '');

        document.getElementById('camperEditBody').innerHTML = h;

        // Wire cascading selects
        var divSel = document.getElementById('ceDiv');
        var gradeSel = document.getElementById('ceGrade');
        var bunkSel = document.getElementById('ceBunk');
        if (divSel) divSel.onchange = function() { gradeSel.innerHTML = optionsHtml(getGradeOpts(divSel.value)); bunkSel.innerHTML = optionsHtml(getBunkOpts(divSel.value, '')); };
        if (gradeSel) gradeSel.onchange = function() { bunkSel.innerHTML = optionsHtml(getBunkOpts(divSel.value, gradeSel.value)); };

        document.getElementById('saveCamperBtn').onclick = saveCamperForm;
        openModal('camperEditModal');
    }

    function addCamper() { editingCamper = null; editCamper(''); }

    function saveCamperForm() {
        var first = (document.getElementById('ceFirst').value || '').trim();
        var last = (document.getElementById('ceLast').value || '').trim();
        if (!first) { toast('First name required', 'error'); return; }
        var fullName = first + (last ? ' ' + last : '');

        if (editingCamper && editingCamper !== fullName) { delete camperRoster[editingCamper]; }
        if (!editingCamper && camperRoster[fullName]) { toast('Camper already exists', 'error'); return; }

        camperRoster[fullName] = {
            dob: document.getElementById('ceDob').value || '',
            gender: document.getElementById('ceGender').value || '',
            schoolGrade: document.getElementById('ceSchool').value || '',
            division: document.getElementById('ceDiv').value || '',
            grade: document.getElementById('ceGrade').value || '',
            bunk: document.getElementById('ceBunk').value || '',
            team: document.getElementById('ceTeam').value || '',
            parent1Name: document.getElementById('ceP1Name').value || '',
            parent1Phone: document.getElementById('ceP1Phone').value || '',
            parent1Email: document.getElementById('ceP1Email').value || '',
            emergencyName: document.getElementById('ceEmName').value || '',
            emergencyPhone: document.getElementById('ceEmPhone').value || '',
            emergencyRel: document.getElementById('ceEmRel').value || '',
            allergies: document.getElementById('ceAllergy').value || '',
            medications: document.getElementById('ceMeds').value || '',
            dietary: document.getElementById('ceDiet').value || '',
        };
        saveData();
        closeModal('camperEditModal');
        renderPage(currentPage);
        toast(editingCamper ? 'Camper updated' : 'Camper added');
    }

    function getGradeOpts(div) { var o = ['']; if (div && structure[div]) Object.keys(structure[div].grades || {}).sort().forEach(function(g) { o.push(g); }); return o; }
    function getBunkOpts(div, grade) { var o = ['']; if (div && grade && structure[div] && structure[div].grades && structure[div].grades[grade]) (structure[div].grades[grade].bunks || []).forEach(function(b) { o.push(b); }); return o; }
    function formField(label, id, value, type, opts) {
        var h = '<div class="me-form-group"><label class="me-form-label">' + esc(label) + '</label>';
        if (type === 'select' && opts) {
            h += '<select id="' + id + '" class="me-form-select">' + optionsHtml(opts, value) + '</select>';
        } else {
            h += '<input type="' + (type || 'text') + '" id="' + id + '" class="me-form-input" value="' + esc(value) + '">';
        }
        return h + '</div>';
    }
    function optionsHtml(opts, selected) {
        return opts.map(function(o) { return '<option value="' + esc(o) + '"' + (o === selected ? ' selected' : '') + '>' + (o || '—') + '</option>'; }).join('');
    }

    // ─── STRUCTURE ───────────────────────────────────────────────────
    function renderStructure() {
        var c = document.getElementById('page-structure');
        var divs = Object.entries(structure).sort(function(a,b){return a[0].localeCompare(b[0]);});
        var h = '<div class="me-section-header"><div><h2 class="me-section-title">Camp Structure</h2></div>' +
            '<div class="me-section-actions"><button class="me-btn me-btn--primary" onclick="CampistryMe.addDivision()">+ Add Division</button></div></div>';
        if (!divs.length) { h += '<div class="me-empty"><h3>No divisions yet</h3><p>Create divisions, grades, and bunks.</p></div>'; }
        else {
            divs.forEach(function([dn, dd]) {
                var grades = Object.entries(dd.grades || {}).sort(function(a,b){return a[0].localeCompare(b[0],undefined,{numeric:true});});
                var bunkCt = grades.reduce(function(s,e){return s+(e[1].bunks||[]).length;},0);
                var col = dd.color || '#94A3B8';
                h += '<div class="me-card" style="margin-bottom:10px"><div class="me-card-header"><div style="display:flex;align-items:center;gap:8px">' +
                    '<div style="width:10px;height:10px;border-radius:3px;background:'+col+'"></div>' +
                    '<h3 style="margin:0">' + esc(dn) + '</h3><span style="font-size:0.75rem;color:var(--slate-400)">' + grades.length + ' grades · ' + bunkCt + ' bunks</span></div>' +
                    '<button class="me-btn me-btn--danger me-btn--sm" onclick="CampistryMe.deleteDivision(\''+esc(dn).replace(/'/g,"\\'")+'\')">Delete</button></div>';
                h += '<div style="padding:14px 18px">';
                grades.forEach(function([gn, gd]) {
                    h += '<div style="margin-bottom:10px"><div style="font-size:0.8rem;font-weight:600;color:var(--slate-700);margin-bottom:4px">' + esc(gn) + '</div>' +
                        '<div style="display:flex;flex-wrap:wrap;gap:4px">';
                    (gd.bunks||[]).forEach(function(b) {
                        h += '<span style="padding:3px 8px;border-radius:6px;border:1px solid var(--slate-200);font-size:0.7rem;font-weight:600;color:var(--slate-600)">' + esc(b) + '</span>';
                    });
                    h += '</div></div>';
                });
                h += '</div></div>';
            });
        }
        c.innerHTML = h;
    }

    // ─── BUNK BUILDER (no capacity limits) ───────────────────────────
    function renderBunkBuilder() {
        var c = document.getElementById('page-bunkbuilder');
        var allBunks = [];
        Object.entries(structure).forEach(function([div, d]) {
            Object.entries(d.grades || {}).forEach(function([grade, g]) {
                (g.bunks || []).forEach(function(bunk) { allBunks.push({ name: bunk, division: div, grade: grade, color: d.color || '#94A3B8' }); });
            });
        });
        var camperArr = Object.keys(camperRoster);
        var assignedSet = {};
        Object.values(bunkAssignments).forEach(function(ids) { ids.forEach(function(id) { assignedSet[id] = true; }); });
        var unassigned = camperArr.filter(function(n) { return !assignedSet[n]; });
        var placed = camperArr.length - unassigned.length;

        var h = '<div class="me-section-header"><div><h2 class="me-section-title">Bunk Builder</h2><p class="me-section-desc">' + placed + '/' + camperArr.length + ' placed</p></div>' +
            '<div class="me-section-actions">' +
            '<button class="me-btn me-btn--primary me-btn--sm" onclick="CampistryMe.autoAssign()">⚡ Auto-Assign</button>' +
            '<button class="me-btn me-btn--secondary me-btn--sm" onclick="CampistryMe.clearBunks()">Clear</button></div></div>';

        if (!allBunks.length) { h += '<div class="me-empty"><h3>No bunks configured</h3><p>Create divisions and bunks in Camp Structure first.</p></div>'; }
        else {
            h += '<div class="bb-layout">';
            // Pool
            h += '<div class="bb-pool" ondragover="event.preventDefault();this.querySelector(\'.bb-pool-body\').classList.add(\'dragover\')" ondragleave="this.querySelector(\'.bb-pool-body\').classList.remove(\'dragover\')" ondrop="CampistryMe.bbDrop(\'__pool__\',event);this.querySelector(\'.bb-pool-body\').classList.remove(\'dragover\')">';
            h += '<div class="bb-pool-header"><h3>Unassigned (' + unassigned.length + ')</h3></div><div class="bb-pool-body">';
            if (!unassigned.length) h += '<div style="text-align:center;padding:20px 8px;color:var(--green);font-size:0.8rem;font-weight:600">All placed ✓</div>';
            else unassigned.forEach(function(n) { h += bbCard(n); });
            h += '</div></div>';

            // Board
            h += '<div class="bb-board">';
            var lastDiv = '';
            allBunks.forEach(function(bk) {
                if (bk.division !== lastDiv) { if (lastDiv) h += '</div>'; lastDiv = bk.division; h += '<div class="bb-division-title"><span class="bb-division-dot" style="background:'+bk.color+'"></span>'+esc(bk.division)+'</div><div class="bb-grade-label">'+esc(bk.grade)+'</div><div class="bb-bunk-grid">'; }
                var ids = bunkAssignments[bk.name] || [];
                h += '<div class="bb-bunk-card" ondragover="event.preventDefault();this.classList.add(\'dragover\')" ondragleave="this.classList.remove(\'dragover\')" ondrop="CampistryMe.bbDrop(\''+esc(bk.name).replace(/'/g,"\\'")+'\',event);this.classList.remove(\'dragover\')">';
                h += '<div class="bb-bunk-header"><span class="bb-bunk-name">'+esc(bk.name)+'</span><span class="bb-bunk-count">'+ids.length+'</span></div>';
                h += '<div class="bb-bunk-campers">';
                if (!ids.length) h += '<div class="bb-bunk-empty">Drop campers here</div>';
                else ids.forEach(function(n) { h += bbCard(n); });
                h += '</div></div>';
            });
            if (lastDiv) h += '</div>';
            h += '</div></div>';
        }
        c.innerHTML = h;
    }

    function bbCard(name) {
        var d = camperRoster[name] || {};
        var hasMed = !!(d.allergies || d.medications);
        return '<div class="bb-camper" draggable="true" ondragstart="event.dataTransfer.setData(\'text/plain\',\'' + esc(name).replace(/'/g, "\\'") + '\')">' +
            avHtml(name, 'sm') + '<div style="flex:1;min-width:0"><div class="bb-camper-name">' + esc(name) + '</div>' +
            '<div class="bb-camper-meta">' + esc(d.grade || '') + '</div></div>' +
            (hasMed ? '<span style="color:var(--red);font-size:0.65rem">⚠</span>' : '') + '</div>';
    }

    function bbDrop(target, event) {
        event.preventDefault();
        var name = event.dataTransfer.getData('text/plain');
        if (!name) return;
        Object.keys(bunkAssignments).forEach(function(b) { bunkAssignments[b] = bunkAssignments[b].filter(function(n) { return n !== name; }); });
        if (target !== '__pool__') { if (!bunkAssignments[target]) bunkAssignments[target] = []; bunkAssignments[target].push(name); }
        saveData(); renderBunkBuilder();
    }

    function autoAssign() {
        var allBunks = [];
        Object.entries(structure).forEach(function([div, d]) {
            Object.entries(d.grades || {}).forEach(function([grade, g]) {
                (g.bunks || []).forEach(function(bunk) { allBunks.push({ name: bunk, grade: grade, division: div }); });
            });
        });
        var next = {}; allBunks.forEach(function(b) { next[b.name] = []; });
        var campers = Object.entries(camperRoster);
        campers.sort(function(a, b) { return (a[1].grade||'').localeCompare(b[1].grade||''); });
        campers.forEach(function([name, d]) {
            var eligible = allBunks.filter(function(b) { return b.grade === d.grade; });
            if (!eligible.length) eligible = allBunks.filter(function(b) { return b.division === d.division; });
            if (!eligible.length) eligible = allBunks;
            if (!eligible.length) return;
            eligible.sort(function(a, b) { return next[a.name].length - next[b.name].length; });
            next[eligible[0].name].push(name);
        });
        bunkAssignments = next; saveData(); renderBunkBuilder(); toast('Auto-assigned ' + campers.length + ' campers');
    }

    function clearBunks() { if (!confirm('Clear all assignments?')) return; bunkAssignments = {}; saveData(); renderBunkBuilder(); toast('Cleared'); }

    // ─── BILLING ─────────────────────────────────────────────────────
    function renderBilling() {
        var c = document.getElementById('page-billing');
        var tp = 0, td = 0;
        Object.values(families).forEach(function(f) { tp += f.totalPaid || 0; td += f.balance || 0; });
        var h = '<div class="me-section-header"><div><h2 class="me-section-title">Billing</h2></div></div>' +
            '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">' +
            '<div style="flex:1;min-width:120px;background:#fff;border-radius:var(--radius-sm);padding:14px;border:1px solid var(--slate-200)"><div style="font-size:1.2rem;font-weight:700;color:var(--slate-800)">' + fmtMoney(tp) + '</div><div style="font-size:0.7rem;color:var(--slate-400);font-weight:600;text-transform:uppercase">Collected</div></div>' +
            '<div style="flex:1;min-width:120px;background:#fff;border-radius:var(--radius-sm);padding:14px;border:1px solid var(--slate-200)"><div style="font-size:1.2rem;font-weight:700;color:var(--slate-800)">' + fmtMoney(td) + '</div><div style="font-size:0.7rem;color:var(--slate-400);font-weight:600;text-transform:uppercase">Outstanding</div></div>' +
            '</div>';
        if (payments.length) {
            h += '<div class="me-card"><div class="me-card-header"><h3>Payment Ledger</h3></div><div class="me-table-wrap"><table class="me-table"><thead><tr><th>Date</th><th>Family</th><th>Amount</th><th>Method</th><th>Status</th><th>Note</th></tr></thead><tbody>';
            payments.forEach(function(p) { var f = families[p.familyId]; h += '<tr><td>'+(p.date||'')+'</td><td class="td-name">'+(f?esc(f.name):'')+'</td><td style="font-weight:600">'+fmtMoney(p.amount)+'</td><td>'+esc(p.method||'')+'</td><td>'+badge(p.status||'',p.status==='Paid'?'green':'amber')+'</td><td style="color:var(--slate-500)">'+esc(p.note||'')+'</td></tr>'; });
            h += '</tbody></table></div></div>';
        } else { h += '<div class="me-empty"><h3>No payments recorded</h3></div>'; }
        c.innerHTML = h;
    }

    // ─── BROADCASTS ──────────────────────────────────────────────────
    function renderBroadcasts() {
        var c = document.getElementById('page-broadcasts');
        var h = '<div class="me-section-header"><div><h2 class="me-section-title">Broadcasts</h2></div>' +
            '<div class="me-section-actions"><button class="me-btn me-btn--primary">+ New Broadcast</button></div></div>';
        if (!broadcasts.length) { h += '<div class="me-empty"><h3>No broadcasts yet</h3><p>Send emails and SMS to families.</p></div>'; }
        else { broadcasts.forEach(function(b) { h += '<div class="me-card" style="margin-bottom:8px;padding:14px"><div style="font-size:0.85rem;font-weight:600">' + esc(b.subject) + '</div><div style="font-size:0.7rem;color:var(--slate-400);margin-top:2px">' + esc(b.to || '') + ' · ' + esc(b.method || '') + '</div></div>'; }); }
        c.innerHTML = h;
    }

    // ─── COMING SOON ─────────────────────────────────────────────────
    function renderComingSoon(p) {
        var titles = { forms:'Forms & Documents', reports:'Reports', settings:'Settings' };
        document.getElementById('page-' + p).innerHTML = '<div class="me-coming-soon"><h2>' + (titles[p] || p) + '</h2><p>This module is in development.</p></div>';
    }

    // ─── CSV ─────────────────────────────────────────────────────────
    function handleCsv(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(e) {
            var text = e.target.result; if (text.charCodeAt(0)===0xFEFF) text=text.slice(1);
            var lines = text.split(/\r?\n/).filter(function(l){return l.trim();});
            if (!lines.length) return;
            var start = lines[0].toLowerCase().includes('name') ? 1 : 0;
            var rows = [];
            for (var i = start; i < Math.min(lines.length, 5001); i++) {
                var cols = lines[i].split(',').map(function(s){return s.trim().replace(/^"|"$/g,'');});
                if (cols[0]) rows.push({name:cols[0],division:cols[1]||'',grade:cols[2]||'',bunk:cols[3]||'',team:cols[4]||''});
            }
            if (rows.length) {
                document.getElementById('csvPreviewArea').style.display = 'block';
                document.getElementById('csvPreviewArea').innerHTML = '<div style="font-weight:600;margin:10px 0 6px">' + rows.length + ' rows found</div>';
                document.getElementById('csvImportBtn').disabled = false;
                document.getElementById('csvImportBtn').onclick = function() {
                    var added = 0;
                    rows.forEach(function(r) {
                        if (r.division && !structure[r.division]) structure[r.division] = { color: COLOR_PRESETS[Object.keys(structure).length % COLOR_PRESETS.length], grades: {} };
                        if (r.division && r.grade && structure[r.division] && !structure[r.division].grades[r.grade]) structure[r.division].grades[r.grade] = { bunks: [] };
                        if (r.division && r.grade && r.bunk && structure[r.division]?.grades?.[r.grade] && structure[r.division].grades[r.grade].bunks.indexOf(r.bunk) === -1) structure[r.division].grades[r.grade].bunks.push(r.bunk);
                        if (!camperRoster[r.name]) added++;
                        camperRoster[r.name] = { division:r.division, grade:r.grade, bunk:r.bunk, team:r.team };
                    });
                    saveData(); closeModal('csvModal'); renderPage(currentPage); toast(added + ' campers imported');
                };
            }
        };
        reader.readAsText(file);
    }

    function exportCsv() {
        var entries = Object.entries(camperRoster);
        if (!entries.length) { toast('No campers', 'error'); return; }
        var csv = '\uFEFFName,Division,Grade,Bunk,Team\n';
        entries.forEach(function([n, d]) { csv += '"'+n+'","'+(d.division||'')+'","'+(d.grade||'')+'","'+(d.bunk||'')+'","'+(d.team||'')+'"\n'; });
        var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
        a.download = 'campers_' + new Date().toISOString().split('T')[0] + '.csv'; a.click();
        toast('Exported ' + entries.length + ' campers');
    }

    // ─── Division CRUD ───────────────────────────────────────────────
    function addDivision() { toast('Division creation — use Camp Structure tab in Flow for now', 'error'); }
    function deleteDivision(name) {
        if (!confirm('Delete "' + name + '"?')) return;
        delete structure[name];
        Object.values(camperRoster).forEach(function(c) { if (c.division === name) { c.division = ''; c.grade = ''; c.bunk = ''; } });
        saveData(); renderPage(currentPage); toast('Division deleted');
    }
    function addFamily() { toast('Family management — coming in next update', 'error'); }

    // ── Boot ─────────────────────────────────────────────────────────
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // ── Public API ───────────────────────────────────────────────────
    window.CampistryMe = {
        nav: navigateTo, viewCamper: viewCamper, editCamper: editCamper, addCamper: addCamper,
        addFamily: addFamily, addDivision: addDivision, deleteDivision: deleteDivision,
        openCsvModal: function() { openModal('csvModal'); }, exportCsv: exportCsv,
        closeModal: closeModal,
        bbDrop: bbDrop, autoAssign: autoAssign, clearBunks: clearBunks,
    };
    console.log('📋 Campistry Me loaded');
})();
