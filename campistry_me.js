// =============================================================================
// campistry_me_v5.js — Campistry Me Application Engine v5.0
// =============================================================================
//
// The camp management hub. Handles:
// ✅ Families (split households)    ✅ Campers (full profiles)
// ✅ Camp Structure (div/grade/bunk) ✅ Bunk Builder (drag-drop)
// ✅ Attendance (tap-to-mark)       ✅ Billing (payment ledger)
// ✅ Broadcasts (message history)   ✅ Camper Detail Drawer
// ✅ CSV Import/Export              ✅ Cloud sync integration
//
// Health Center & Wellness Notes → moved to Campistry Health (Purple)
// Camper Locator → stays in Campistry Flow (Teal)
//
// =============================================================================

(function() {
    'use strict';

    console.log('📋 Campistry Me v5.0 loading...');

    // =========================================================================
    // CONSTANTS
    // =========================================================================

    const VERSION = '5.0';
    const MAX_NAME = 100;
    const COLOR_PRESETS = ['#147D91','#8B5CF6','#0EA5E9','#10B981','#F43F5E','#EC4899','#F59E0B','#84CC16','#14B8A6','#6366F1'];
    const AVATAR_COLORS = ['#147D91','#8B5CF6','#0EA5E9','#10B981','#F43F5E','#EC4899','#F59E0B'];

    // =========================================================================
    // STATE
    // =========================================================================

    let structure = {};        // { divName: { color, grades: { gradeName: { bunks: [] } } } }
    let camperRoster = {};     // { camperName: { division, grade, bunk, team, ...profile } }
    let families = {};         // { familyId: { name, households: [...], ... } }
    let payments = [];         // [{ id, familyId, date, amount, method, status, note }]
    let attendance = {};       // { camperId: "present"|"late"|"absent" }
    let broadcasts = [];       // [{ id, date, subject, to, method, sent, opened }]
    let bunkAssignments = {};  // { bunkName: [camperId, ...] } — for bunk builder
    let currentPage = 'families';
    let sidebarCollapsed = false;
    let drawerOpen = false;
    let drawerCamperId = null;
    let drawerTab = 'overview';

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function init() {
        console.log('📋 Me v5 initializing...');

        loadData();
        setupNavigation();
        setupSidebarToggle();
        setupSearch();
        setupDrawer();
        setupModals();

        // Render initial page
        navigateTo('families');

        console.log('📋 Me v5 ready:', Object.keys(camperRoster).length, 'campers,', Object.keys(structure).length, 'divisions');
    }

    // =========================================================================
    // DATA LAYER
    // =========================================================================

    function loadData() {
        try {
            const settings = readLocalSettings();
            structure = settings.campStructure || {};
            camperRoster = (settings.app1 && settings.app1.camperRoster) || {};

            // Load extended Me data
            const meData = settings.campistryMe || {};
            families = meData.families || buildFamiliesFromRoster();
            payments = meData.payments || [];
            attendance = meData.attendance || {};
            broadcasts = meData.broadcasts || [];
            bunkAssignments = meData.bunkAssignments || {};

        } catch (e) {
            console.warn('[Me v5] Load error:', e);
        }
    }

    function saveData() {
        try {
            setSyncStatus('syncing');
            const global = readLocalSettings();

            global.campStructure = structure;
            if (!global.app1) global.app1 = {};
            global.app1.camperRoster = camperRoster;
            global.app1.divisions = convertToOldFormat(structure);
            global.campistryMe = {
                families, payments, attendance, broadcasts, bunkAssignments
            };
            global.updated_at = new Date().toISOString();

            writeLocalSettings(global);
            scheduleCloudSave(global);
            setSyncStatus('synced');
        } catch (e) {
            console.error('[Me v5] Save error:', e);
            setSyncStatus('error');
        }
    }

    function readLocalSettings() {
        try { return JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}'); }
        catch { return {}; }
    }

    function writeLocalSettings(data) {
        localStorage.setItem('campGlobalSettings_v1', JSON.stringify(data));
    }

    function scheduleCloudSave(data) {
        if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
            window.saveGlobalSettings('campStructure', data.campStructure);
            window.saveGlobalSettings('campistryMe', data.campistryMe);
            window.saveGlobalSettings('app1', data.app1);
        } else if (typeof window.forceSyncToCloud === 'function') {
            window.forceSyncToCloud();
        }
    }

    function convertToOldFormat(struct) {
        const existing = readLocalSettings();
        const existingDivs = (existing.app1 && existing.app1.divisions) || {};
        const merged = {};
        Object.entries(struct).forEach(function([divName, divData]) {
            const allBunks = [];
            Object.values(divData.grades || {}).forEach(function(g) {
                (g.bunks || []).forEach(function(b) { allBunks.push(b); });
            });
            const base = existingDivs[divName] || {};
            merged[divName] = Object.assign({}, base, { color: divData.color, bunks: allBunks });
        });
        Object.keys(existingDivs).forEach(function(d) {
            if (!merged[d]) merged[d] = existingDivs[d];
        });
        return merged;
    }

    function buildFamiliesFromRoster() {
        // Auto-generate family entries from camper last names
        const fams = {};
        Object.entries(camperRoster).forEach(function([name, data]) {
            const parts = name.split(' ');
            const last = parts.length > 1 ? parts[parts.length - 1] : parts[0];
            const famKey = 'fam_' + last.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!fams[famKey]) {
                fams[famKey] = {
                    name: last + ' Family',
                    households: [{ id: 'h_' + famKey, label: 'Primary', parents: [], address: '', billingContact: true }],
                    camperIds: [],
                    balance: 0, totalPaid: 0, notes: '', status: 'pending'
                };
            }
            fams[famKey].camperIds.push(name);
        });
        return fams;
    }

    // =========================================================================
    // NAVIGATION
    // =========================================================================

    function setupNavigation() {
        document.querySelectorAll('.me-nav-item').forEach(function(btn) {
            btn.addEventListener('click', function() {
                navigateTo(btn.dataset.page);
            });
        });
    }

    function navigateTo(page) {
        currentPage = page;

        // Update nav active state
        document.querySelectorAll('.me-nav-item').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.page === page);
        });

        // Update page title
        var titleMap = {
            families: 'Families', campers: 'Campers', structure: 'Camp Structure',
            bunkbuilder: 'Bunk Builder', attendance: 'Attendance', billing: 'Billing',
            broadcasts: 'Broadcasts', forms: 'Forms & Docs', reports: 'Reports', settings: 'Settings'
        };
        document.getElementById('pageTitle').textContent = titleMap[page] || page;

        // Show/hide pages
        document.querySelectorAll('.me-page').forEach(function(p) {
            p.classList.toggle('active', p.id === 'page-' + page);
        });

        // Render the page content
        renderPage(page);

        // Close mobile sidebar
        document.getElementById('meSidebar').classList.remove('mobile-open');
    }

    // =========================================================================
    // SIDEBAR TOGGLE
    // =========================================================================

    function setupSidebarToggle() {
        document.getElementById('sidebarToggle').addEventListener('click', function() {
            sidebarCollapsed = !sidebarCollapsed;
            document.getElementById('meSidebar').classList.toggle('collapsed', sidebarCollapsed);
        });
        var mobileBtn = document.getElementById('mobileSidebarToggle');
        if (mobileBtn) {
            mobileBtn.addEventListener('click', function() {
                document.getElementById('meSidebar').classList.toggle('mobile-open');
            });
        }
    }

    // =========================================================================
    // SYNC STATUS
    // =========================================================================

    function setSyncStatus(status) {
        var badge = document.getElementById('syncBadge');
        if (!badge) return;
        badge.className = 'me-sync-badge' + (status === 'syncing' ? ' syncing' : status === 'error' ? ' error' : '');
        var text = badge.querySelector('.me-sync-text');
        if (text) text.textContent = status === 'syncing' ? 'Saving...' : status === 'error' ? 'Error' : 'Synced';
    }

    // =========================================================================
    // TOAST
    // =========================================================================

    function toast(msg, type) {
        type = type || 'success';
        var el = document.getElementById('meToast');
        if (!el) return;
        el.className = 'me-toast ' + type + ' visible';
        document.getElementById('toastIcon').textContent = type === 'error' ? '✕' : '✓';
        document.getElementById('toastMessage').textContent = msg;
        clearTimeout(el._timer);
        el._timer = setTimeout(function() { el.classList.remove('visible'); }, 2600);
    }

    // =========================================================================
    // SEARCH
    // =========================================================================

    function setupSearch() {
        var input = document.getElementById('globalSearch');
        if (!input) return;
        var debounce;
        input.addEventListener('input', function() {
            clearTimeout(debounce);
            debounce = setTimeout(function() {
                // If on campers page, re-render with filter
                if (currentPage === 'campers') renderCampers(input.value.trim());
            }, 200);
        });
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function esc(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
    function getAge(dob) { if (!dob) return ''; var d = new Date(dob); var a = Math.floor((Date.now() - d.getTime()) / 31557600000); return a >= 0 && a < 25 ? a : ''; }
    function getInitials(name) { var p = name.split(' '); return (p[0] ? p[0][0] : '?') + (p.length > 1 ? p[p.length-1][0] : ''); }
    function avatarColor(name) { var h = 0; for (var i = 0; i < name.length; i++) h += name.charCodeAt(i); return AVATAR_COLORS[h % AVATAR_COLORS.length]; }
    function avatarHtml(name, size) {
        size = size || 'sm';
        var cls = 'me-avatar me-avatar--' + size;
        var bg = avatarColor(name);
        return '<div class="' + cls + '" style="background:linear-gradient(135deg,' + bg + ',' + bg + 'bb)">' + esc(getInitials(name).toUpperCase()) + '</div>';
    }
    function badgeHtml(label, type) { return '<span class="me-badge me-badge--' + type + '">' + esc(label) + '</span>'; }
    function divTagHtml(divName) {
        var color = (structure[divName] && structure[divName].color) || '#94A3B8';
        return '<span class="me-div-tag" style="background:' + color + '14;color:' + color + ';border:1px solid ' + color + '30">' +
            '<span class="me-div-dot" style="background:' + color + '"></span>' + esc(divName) + '</span>';
    }
    function fmtMoney(n) { return '$' + Number(n || 0).toLocaleString(); }
    function fmtDate(d) { if (!d) return ''; return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
    function profilePct(c) {
        var fields = ['division', 'grade', 'bunk'];
        var filled = fields.filter(function(f) { return c[f]; }).length;
        return Math.round((filled / fields.length) * 100);
    }
    function ringHtml(pct, size) {
        size = size || 24;
        var c = pct >= 80 ? '#10B981' : pct >= 50 ? '#F59E0B' : '#EF4444';
        var r = size / 2 - 3, circ = 2 * Math.PI * r;
        return '<svg class="me-ring" width="' + size + '" height="' + size + '" style="transform:rotate(-90deg)">' +
            '<circle cx="' + size/2 + '" cy="' + size/2 + '" r="' + r + '" stroke="#F1F5F9" stroke-width="2.5" fill="none"/>' +
            '<circle cx="' + size/2 + '" cy="' + size/2 + '" r="' + r + '" stroke="' + c + '" stroke-width="2.5" fill="none" ' +
            'stroke-dasharray="' + circ + '" stroke-dashoffset="' + circ * (1 - pct/100) + '" stroke-linecap="round"/>' +
            '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" style="transform:rotate(90deg);transform-origin:center;font-size:' + (size*0.28) + 'px;font-weight:800;fill:' + c + '">' + pct + '</text></svg>';
    }

    // =========================================================================
    // PAGE RENDERERS
    // =========================================================================

    function renderPage(page) {
        switch (page) {
            case 'families': renderFamilies(); break;
            case 'campers': renderCampers(); break;
            case 'structure': renderStructure(); break;
            case 'bunkbuilder': renderBunkBuilder(); break;
            case 'attendance': renderAttendance(); break;
            case 'billing': renderBilling(); break;
            case 'broadcasts': renderBroadcasts(); break;
            case 'forms':
            case 'reports':
            case 'settings':
                renderComingSoon(page); break;
        }
    }

    // ─── FAMILIES ────────────────────────────────────────────────────
    function renderFamilies() {
        var container = document.getElementById('page-families');
        var famEntries = Object.entries(families);

        var html = '<div class="me-section-header">' +
            '<div><p style="font-size:12px;color:var(--s500);margin:0">' + famEntries.length + ' household' + (famEntries.length !== 1 ? 's' : '') +
            ' — <strong style="color:var(--camp-teal)">split household support enabled</strong></p></div>' +
            '<div class="me-section-actions">' +
            '<button class="me-btn me-btn--primary" onclick="CampistryMeV5.addFamily()">+ Add Family</button>' +
            '</div></div>';

        if (famEntries.length === 0) {
            html += '<div class="me-empty"><div class="me-empty-icon"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg></div>' +
                '<h3>No families yet</h3><p>Add families to start managing your camp roster.</p>' +
                '<button class="me-btn me-btn--primary" onclick="CampistryMeV5.addFamily()">+ Add First Family</button></div>';
        } else {
            famEntries.forEach(function([id, f]) {
                var statusBadge = f.balance > 0 ? badgeHtml(fmtMoney(f.balance) + ' due', 'red') :
                    f.totalPaid > 0 ? badgeHtml('Paid in Full', 'green') : badgeHtml('Pending', 'amber');

                html += '<div class="me-family-card">' +
                    '<div class="me-family-header">' +
                    '<div style="display:flex;align-items:center;gap:10px">' +
                    '<div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,var(--camp-teal),var(--camp-teal-light));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:14px">' + esc(f.name[0]) + '</div>' +
                    '<div><div class="me-family-name">' + esc(f.name) + '</div>' +
                    '<div class="me-family-meta">' + f.camperIds.length + ' camper' + (f.camperIds.length !== 1 ? 's' : '') + ' · ' +
                    (f.households || []).length + ' household' + ((f.households || []).length !== 1 ? 's' : '') + '</div></div></div>' +
                    statusBadge + '</div>';

                // Households
                if (f.households && f.households.length > 0) {
                    html += '<div class="me-household-grid">';
                    f.households.forEach(function(h) {
                        html += '<div class="me-household">' +
                            '<div class="me-household-label">' + esc(h.label) +
                            (h.billingContact ? ' <span class="me-household-billing">· 💳 Billing</span>' : '') + '</div>';
                        (h.parents || []).forEach(function(p) {
                            html += '<div style="font-size:12px;margin-bottom:2px"><strong>' + esc(p.name) + '</strong> (' + esc(p.relation || 'Parent') + ')';
                            if (p.phone) html += ' — <a href="tel:' + esc(p.phone) + '" style="color:var(--camp-teal);text-decoration:none">' + esc(p.phone) + '</a>';
                            html += '</div>';
                        });
                        if (h.address) html += '<div style="font-size:10px;color:var(--s400);margin-top:3px">📍 ' + esc(h.address) + '</div>';
                        html += '</div>';
                    });
                    html += '</div>';
                }

                // Linked campers
                html += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
                f.camperIds.forEach(function(cName) {
                    var c = camperRoster[cName];
                    if (!c) return;
                    var first = cName.split(' ')[0];
                    html += '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;border:1px solid var(--s200);background:#fff;font-size:11px;font-weight:600;cursor:pointer" onclick="CampistryMeV5.openDrawer(\'' + esc(cName).replace(/'/g, "\\'") + '\')">' +
                        avatarHtml(cName, 'sm') + ' ' + esc(first) + '</span>';
                });
                html += '</div>';

                if (f.notes) html += '<div style="font-size:11px;color:var(--color-warning);font-weight:600;margin-top:8px">📝 ' + esc(f.notes) + '</div>';
                html += '</div>';
            });
        }

        container.innerHTML = html;
    }

    // ─── CAMPERS ─────────────────────────────────────────────────────
    function renderCampers(filter) {
        var container = document.getElementById('page-campers');
        var entries = Object.entries(camperRoster);
        var total = entries.length;

        if (filter) {
            var q = filter.toLowerCase();
            entries = entries.filter(function([name, c]) {
                return name.toLowerCase().includes(q) ||
                    (c.division || '').toLowerCase().includes(q) ||
                    (c.bunk || '').toLowerCase().includes(q) ||
                    (c.team || '').toLowerCase().includes(q);
            });
        }

        entries.sort(function(a, b) { return a[0].localeCompare(b[0]); });

        var html = '<div class="me-section-header">' +
            '<div><p style="font-size:12px;color:var(--s500);margin:0">' + total + ' camper' + (total !== 1 ? 's' : '') + '</p></div>' +
            '<div class="me-section-actions">' +
            '<button class="me-btn me-btn--secondary" onclick="CampistryMeV5.openCsvModal()"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 5 17 10"/><line x1="12" y1="5" x2="12" y2="15"/></svg> Import</button>' +
            '<button class="me-btn me-btn--secondary" onclick="CampistryMeV5.exportCsv()"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Export</button>' +
            '<button class="me-btn me-btn--primary" onclick="CampistryMeV5.addCamper()">+ Add Camper</button>' +
            '</div></div>';

        if (entries.length === 0) {
            html += '<div class="me-empty"><div class="me-empty-icon"><svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
                '<h3>No campers yet</h3><p>Add campers or import from CSV.</p>' +
                '<div style="display:flex;gap:8px;justify-content:center">' +
                '<button class="me-btn me-btn--primary" onclick="CampistryMeV5.addCamper()">+ Add Camper</button>' +
                '<button class="me-btn me-btn--secondary" onclick="CampistryMeV5.openCsvModal()">Import CSV</button></div></div>';
        } else {
            html += '<div class="me-card"><div class="me-table-wrap"><table class="me-table">' +
                '<thead><tr><th style="width:36px"></th><th data-sort="name">Name</th><th>Age</th><th>Division</th><th>Bunk</th><th>Team</th>' +
                '<th>Medical</th><th>Profile</th><th style="width:40px"></th></tr></thead><tbody>';

            entries.forEach(function([name, c]) {
                var hasMed = !!(c.allergies || c.medications);
                var pct = profilePct(c);
                var divColor = (structure[c.division] && structure[c.division].color) || 'var(--s400)';

                html += '<tr class="clickable" onclick="CampistryMeV5.openDrawer(\'' + esc(name).replace(/'/g, "\\'") + '\')">' +
                    '<td>' + avatarHtml(name, 'sm') + '</td>' +
                    '<td class="td-name">' + esc(name) + '</td>' +
                    '<td>' + (c.dob ? getAge(c.dob) : '—') + '</td>' +
                    '<td>' + (c.division ? divTagHtml(c.division) : '—') + '</td>' +
                    '<td>' + esc(c.bunk || '—') + '</td>' +
                    '<td>' + esc(c.team || '—') + '</td>' +
                    '<td>' + (hasMed ? '<span style="color:var(--color-error);font-weight:700;font-size:10px">⚠ ' + esc((c.allergies || c.medications || '').split(',')[0]) + '</span>' : '<span style="color:var(--s300)">—</span>') + '</td>' +
                    '<td>' + ringHtml(pct, 22) + '</td>' +
                    '<td></td></tr>';
            });

            html += '</tbody></table></div></div>';
        }

        container.innerHTML = html;
    }

    // ─── CAMP STRUCTURE ──────────────────────────────────────────────
    function renderStructure() {
        var container = document.getElementById('page-structure');
        var divEntries = Object.entries(structure).sort(function(a, b) { return a[0].localeCompare(b[0]); });

        var totalGrades = 0, totalBunks = 0;
        divEntries.forEach(function([, d]) {
            var grades = Object.keys(d.grades || {});
            totalGrades += grades.length;
            grades.forEach(function(g) { totalBunks += ((d.grades[g] || {}).bunks || []).length; });
        });

        var html = '<div class="me-section-header">' +
            '<div><h2 class="me-section-title">Camp Structure</h2>' +
            '<p class="me-section-desc">' + divEntries.length + ' divisions · ' + totalGrades + ' grades · ' + totalBunks + ' bunks</p></div>' +
            '<div class="me-section-actions">' +
            '<button class="me-btn me-btn--primary" onclick="CampistryMeV5.addDivision()">+ Add Division</button></div></div>';

        if (divEntries.length === 0) {
            html += '<div class="me-empty"><div class="me-empty-icon"><svg viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></div>' +
                '<h3>No divisions yet</h3><p>Create your camp structure.</p>' +
                '<button class="me-btn me-btn--primary" onclick="CampistryMeV5.addDivision()">+ Create Division</button></div>';
        } else {
            divEntries.forEach(function([divName, divData]) {
                var gradeEntries = Object.entries(divData.grades || {}).sort(function(a, b) { return a[0].localeCompare(b[0], undefined, { numeric: true }); });
                var bunkCount = gradeEntries.reduce(function(s, e) { return s + (e[1].bunks || []).length; }, 0);
                var color = divData.color || COLOR_PRESETS[0];

                html += '<div class="me-card" style="margin-bottom:12px">' +
                    '<div class="me-card-header">' +
                    '<div style="display:flex;align-items:center;gap:10px">' +
                    '<div style="width:12px;height:12px;border-radius:4px;background:' + color + '"></div>' +
                    '<div><h3 style="margin:0;font-size:15px">' + esc(divName) + '</h3>' +
                    '<span style="font-size:11px;color:var(--s400)">' + gradeEntries.length + ' grades · ' + bunkCount + ' bunks</span></div></div>' +
                    '<div style="display:flex;gap:4px">' +
                    '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMeV5.editDivision(\'' + esc(divName).replace(/'/g, "\\'") + '\')">Edit</button>' +
                    '<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--color-error)" onclick="CampistryMeV5.deleteDivision(\'' + esc(divName).replace(/'/g, "\\'") + '\')">Delete</button>' +
                    '</div></div>';

                html += '<div class="me-card-body">';
                gradeEntries.forEach(function([gradeName, gradeData]) {
                    var bunks = gradeData.bunks || [];
                    html += '<div style="margin-bottom:12px">' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
                        '<span style="font-size:12px;font-weight:700;color:var(--s700)">' + esc(gradeName) + '</span>' +
                        '<span style="font-size:10px;color:var(--s400)">' + bunks.length + ' bunks</span></div>' +
                        '<div style="display:flex;flex-wrap:wrap;gap:6px">';
                    bunks.forEach(function(b) {
                        html += '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:7px;border:1px solid var(--s200);font-size:11px;font-weight:600;color:var(--s600)">' +
                            '<span style="width:6px;height:6px;border-radius:3px;background:' + color + '"></span>' + esc(b) + '</span>';
                    });
                    html += '</div></div>';
                });
                html += '</div></div>';
            });
        }

        container.innerHTML = html;
    }

    // ─── BUNK BUILDER ────────────────────────────────────────────────
    function renderBunkBuilder() {
        var container = document.getElementById('page-bunkbuilder');

        // Flatten all bunks from structure
        var allBunks = [];
        Object.entries(structure).forEach(function([div, d]) {
            Object.entries(d.grades || {}).forEach(function([grade, g]) {
                (g.bunks || []).forEach(function(bunk) {
                    allBunks.push({ name: bunk, division: div, grade: grade, capacity: g.capacity || 10, color: d.color || '#94A3B8' });
                });
            });
        });

        // Get all campers as array
        var camperArr = Object.entries(camperRoster).map(function([name, data]) {
            return Object.assign({ id: name }, data);
        });

        // Assigned set
        var assignedSet = {};
        Object.values(bunkAssignments).forEach(function(ids) {
            ids.forEach(function(id) { assignedSet[id] = true; });
        });

        var unassigned = camperArr.filter(function(c) { return !assignedSet[c.id]; });
        var placedCount = Object.keys(assignedSet).length;

        // Stats bar
        var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">' +
            '<div style="display:flex;gap:8px;align-items:center">' +
            badgeHtml(placedCount + '/' + camperArr.length + ' placed', placedCount === camperArr.length ? 'green' : 'amber') +
            '</div>' +
            '<div style="display:flex;gap:6px">' +
            '<button class="me-btn me-btn--teal me-btn--sm" onclick="CampistryMeV5.autoAssignBunks()">⚡ Auto-Assign</button>' +
            '<button class="me-btn me-btn--secondary me-btn--sm" onclick="CampistryMeV5.clearBunkAssignments()">Clear All</button>' +
            '</div></div>';

        if (allBunks.length === 0) {
            html += '<div class="me-empty"><div class="me-empty-icon"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>' +
                '<h3>No bunks configured</h3><p>Go to <strong>Camp Structure</strong> to create divisions, grades, and bunks first.</p>' +
                '<button class="me-btn me-btn--primary" onclick="CampistryMeV5.nav(\'structure\')">Go to Structure</button></div>';
        } else {
            html += '<div class="bb-layout">';

            // Pool
            html += '<div class="bb-pool" id="bbPool" ondragover="event.preventDefault();this.querySelector(\'.bb-pool-body\').classList.add(\'dragover\')" ondragleave="this.querySelector(\'.bb-pool-body\').classList.remove(\'dragover\')" ondrop="CampistryMeV5.bbDrop(\'__pool__\',event);this.querySelector(\'.bb-pool-body\').classList.remove(\'dragover\')">' +
                '<div class="bb-pool-header"><h3>Unassigned (' + unassigned.length + ')</h3></div>' +
                '<div class="bb-pool-body">';

            if (unassigned.length === 0) {
                html += '<div style="text-align:center;padding:30px 10px;color:var(--color-success);font-weight:700;font-size:13px">🎉 All placed!</div>';
            } else {
                unassigned.forEach(function(c) {
                    html += bbCamperCard(c);
                });
            }
            html += '</div>' +
                '<div class="bb-pool-footer"><strong>Legend:</strong> ⚠ Medical · 🔗 Friend req</div></div>';

            // Board
            html += '<div class="bb-board">';
            var lastDiv = '';
            allBunks.forEach(function(bunk) {
                if (bunk.division !== lastDiv) {
                    if (lastDiv) html += '</div>'; // close prev grid
                    lastDiv = bunk.division;
                    html += '<div class="bb-division-title"><span class="bb-division-dot" style="background:' + bunk.color + '"></span>' + esc(bunk.division) + '</div>';
                    html += '<div class="bb-grade-label">' + esc(bunk.grade) + '</div>';
                    html += '<div class="bb-bunk-grid">';
                }

                var bunkIds = bunkAssignments[bunk.name] || [];
                var bunkCampers = bunkIds.map(function(id) { return camperArr.find(function(c) { return c.id === id; }); }).filter(Boolean);
                var pct = Math.min(bunkCampers.length / bunk.capacity, 1);
                var isOver = bunkCampers.length > bunk.capacity;
                var barColor = isOver ? 'var(--color-error)' : pct >= 0.8 ? 'var(--color-warning)' : 'var(--camp-teal)';
                var countColor = isOver ? 'var(--color-error)' : bunkCampers.length === bunk.capacity ? 'var(--color-success)' : 'var(--s400)';

                html += '<div class="bb-bunk-card' + (isOver ? ' has-error' : '') + '" ' +
                    'ondragover="event.preventDefault();this.classList.add(\'dragover\')" ' +
                    'ondragleave="this.classList.remove(\'dragover\')" ' +
                    'ondrop="CampistryMeV5.bbDrop(\'' + esc(bunk.name).replace(/'/g, "\\'") + '\',event);this.classList.remove(\'dragover\')">' +
                    '<div class="bb-bunk-header">' +
                    '<span class="bb-bunk-name">' + esc(bunk.name) + '</span>' +
                    '<span class="bb-bunk-count" style="color:' + countColor + '">' + bunkCampers.length + '/' + bunk.capacity + '</span></div>' +
                    '<div class="bb-capacity-bar"><div class="bb-capacity-fill" style="width:' + (pct * 100) + '%;background:' + barColor + '"></div></div>' +
                    '<div class="bb-bunk-campers">';

                if (bunkCampers.length === 0) {
                    html += '<div class="bb-bunk-empty">Drop campers here</div>';
                } else {
                    bunkCampers.forEach(function(c) { html += bbCamperCard(c); });
                }

                html += '</div></div>';
            });
            if (lastDiv) html += '</div>'; // close last grid
            html += '</div>'; // close board
            html += '</div>'; // close bb-layout
        }

        container.innerHTML = html;
    }

    function bbCamperCard(c) {
        var hasMed = !!(c.allergies || c.medications);
        var hasFriendReq = c.friendReq && c.friendReq.length > 0;
        return '<div class="bb-camper" draggable="true" ondragstart="event.dataTransfer.setData(\'text/plain\',\'' + esc(c.id).replace(/'/g, "\\'") + '\')">' +
            avatarHtml(c.id, 'sm') +
            '<div style="flex:1;min-width:0"><div class="bb-camper-name">' + esc(c.id) + '</div>' +
            '<div class="bb-camper-meta">' + esc(c.grade || '') + '</div></div>' +
            '<div class="bb-camper-indicators">' +
            (hasMed ? '<span title="' + esc(c.allergies || c.medications) + '" style="color:var(--color-error);font-size:10px">⚠</span>' : '') +
            (hasFriendReq ? '<span style="color:var(--s300);font-size:9px">🔗</span>' : '') +
            '</div></div>';
    }

    // Bunk builder drag & drop
    function bbDrop(target, event) {
        event.preventDefault();
        var camperId = event.dataTransfer.getData('text/plain');
        if (!camperId) return;

        // Remove from all bunks
        Object.keys(bunkAssignments).forEach(function(bunk) {
            bunkAssignments[bunk] = bunkAssignments[bunk].filter(function(id) { return id !== camperId; });
        });

        // Add to target (unless pool)
        if (target !== '__pool__') {
            if (!bunkAssignments[target]) bunkAssignments[target] = [];
            if (bunkAssignments[target].indexOf(camperId) === -1) {
                bunkAssignments[target].push(camperId);
            }
        }

        saveData();
        renderBunkBuilder();
    }

    // Auto-assign
    function autoAssignBunks() {
        var allBunks = [];
        Object.entries(structure).forEach(function([div, d]) {
            Object.entries(d.grades || {}).forEach(function([grade, g]) {
                (g.bunks || []).forEach(function(bunk) {
                    allBunks.push({ name: bunk, division: div, grade: grade, capacity: g.capacity || 10 });
                });
            });
        });

        var next = {};
        allBunks.forEach(function(b) { next[b.name] = []; });

        var camperArr = Object.entries(camperRoster).map(function([name, data]) {
            return Object.assign({ id: name }, data);
        });

        // Sort: those with grade first
        camperArr.sort(function(a, b) { return (a.grade || '').localeCompare(b.grade || ''); });

        camperArr.forEach(function(camper) {
            // Find matching bunks by grade
            var eligible = allBunks.filter(function(b) {
                return b.grade === camper.grade && next[b.name].length < b.capacity;
            });
            if (eligible.length === 0) {
                // Fallback: any bunk in same division
                eligible = allBunks.filter(function(b) {
                    return b.division === camper.division && next[b.name].length < b.capacity;
                });
            }
            if (eligible.length === 0) return;

            // Pick least full
            eligible.sort(function(a, b) { return next[a.name].length - next[b.name].length; });
            next[eligible[0].name].push(camper.id);
        });

        bunkAssignments = next;
        saveData();
        renderBunkBuilder();
        toast('Auto-assigned ' + camperArr.length + ' campers');
    }

    function clearBunkAssignments() {
        if (!confirm('Clear all bunk assignments?')) return;
        bunkAssignments = {};
        saveData();
        renderBunkBuilder();
        toast('Assignments cleared');
    }

    // ─── ATTENDANCE ──────────────────────────────────────────────────
    function renderAttendance() {
        var container = document.getElementById('page-attendance');
        var entries = Object.entries(camperRoster);

        var html = '<div class="me-section-header">' +
            '<div><p style="font-size:12px;color:var(--s500);margin:0">Daily check-in · ' + entries.length + ' campers</p></div>' +
            '<div class="me-section-actions">' +
            '<input type="date" value="2026-06-26" style="padding:6px 12px;border:1px solid var(--s200);border-radius:8px;font-size:12px;font-family:var(--font)">' +
            '</div></div>';

        html += '<div class="me-card"><div class="me-table-wrap"><table class="me-table">' +
            '<thead><tr><th style="width:36px"></th><th>Camper</th><th>Bunk</th><th>Division</th><th>Status</th><th style="width:160px">Mark</th></tr></thead><tbody>';

        entries.forEach(function([name, c]) {
            var st = attendance[name] || 'unmarked';
            var stBadge = st === 'present' ? badgeHtml('Present', 'green') :
                st === 'late' ? badgeHtml('Late', 'amber') :
                st === 'absent' ? badgeHtml('Absent', 'red') : badgeHtml('Unmarked', 'gray');

            html += '<tr><td>' + avatarHtml(name, 'sm') + '</td>' +
                '<td class="td-name">' + esc(name) + '</td>' +
                '<td>' + esc(c.bunk || '—') + '</td>' +
                '<td>' + (c.division ? divTagHtml(c.division) : '—') + '</td>' +
                '<td>' + stBadge + '</td>' +
                '<td><div style="display:flex;gap:4px">';

            ['present', 'late', 'absent'].forEach(function(s) {
                var active = st === s;
                var color = s === 'present' ? 'var(--color-success)' : s === 'late' ? 'var(--color-warning)' : 'var(--color-error)';
                var label = s === 'present' ? '✓ In' : s === 'late' ? '⏰ Late' : '✕ Out';
                html += '<button class="me-btn me-btn--sm" style="border:1px solid ' + (active ? color : 'var(--s200)') + ';background:' +
                    (active ? color + '14' : '#fff') + ';color:' + (active ? color : 'var(--s400)') + '" ' +
                    'onclick="CampistryMeV5.markAttendance(\'' + esc(name).replace(/'/g, "\\'") + '\',\'' + s + '\')">' + label + '</button>';
            });

            html += '</div></td></tr>';
        });

        html += '</tbody></table></div></div>';
        container.innerHTML = html;
    }

    function markAttendance(name, status) {
        attendance[name] = status;
        saveData();
        renderAttendance();
    }

    // ─── BILLING ─────────────────────────────────────────────────────
    function renderBilling() {
        var container = document.getElementById('page-billing');
        var totalPaid = 0, totalDue = 0;
        Object.values(families).forEach(function(f) { totalPaid += f.totalPaid || 0; totalDue += f.balance || 0; });

        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:18px">' +
            '<div class="me-stat" style="border-left:3px solid var(--color-success)"><div><div class="me-stat-value" style="color:var(--color-success)">' + fmtMoney(totalPaid) + '</div><div class="me-stat-label">Collected</div></div></div>' +
            '<div class="me-stat" style="border-left:3px solid var(--color-error)"><div><div class="me-stat-value" style="color:var(--color-error)">' + fmtMoney(totalDue) + '</div><div class="me-stat-label">Outstanding</div></div></div>' +
            '<div class="me-stat" style="border-left:3px solid var(--camp-teal)"><div><div class="me-stat-value" style="color:var(--camp-teal)">' + fmtMoney(totalPaid + totalDue) + '</div><div class="me-stat-label">Total Billed</div></div></div>' +
            '</div>';

        html += '<div class="me-card"><div class="me-card-header"><h3>Payment Ledger</h3>' +
            '<button class="me-btn me-btn--primary me-btn--sm">+ Record Payment</button></div>' +
            '<div class="me-table-wrap"><table class="me-table">' +
            '<thead><tr><th>Date</th><th>Family</th><th>Amount</th><th>Method</th><th>Status</th><th>Note</th></tr></thead><tbody>';

        payments.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); }).forEach(function(p) {
            var fam = families[p.familyId];
            html += '<tr>' +
                '<td>' + fmtDate(p.date) + '</td>' +
                '<td class="td-name">' + esc(fam ? fam.name : p.familyId) + '</td>' +
                '<td style="font-weight:700;color:' + (p.amount > 0 ? 'var(--color-success)' : 'var(--s400)') + '">' + fmtMoney(p.amount) + '</td>' +
                '<td>' + esc(p.method) + '</td>' +
                '<td>' + badgeHtml(p.status, p.status === 'Paid' ? 'green' : 'amber') + '</td>' +
                '<td style="color:var(--s500)">' + esc(p.note || '') + '</td></tr>';
        });

        html += '</tbody></table></div></div>';
        container.innerHTML = html;
    }

    // ─── BROADCASTS ──────────────────────────────────────────────────
    function renderBroadcasts() {
        var container = document.getElementById('page-broadcasts');

        var html = '<div class="me-section-header">' +
            '<div><p style="font-size:12px;color:var(--s500);margin:0">' + broadcasts.length + ' messages sent</p></div>' +
            '<div class="me-section-actions"><button class="me-btn me-btn--primary">+ New Broadcast</button></div></div>';

        if (broadcasts.length === 0) {
            html += '<div class="me-empty"><div class="me-empty-icon"><svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></div>' +
                '<h3>No broadcasts yet</h3><p>Send emails and SMS to camp families.</p></div>';
        } else {
            broadcasts.forEach(function(b) {
                var openPct = b.sent > 0 ? Math.round((b.opened / b.sent) * 100) : 0;
                html += '<div class="me-card" style="margin-bottom:10px;padding:16px;display:flex;gap:14px;align-items:center">' +
                    '<div style="width:38px;height:38px;border-radius:9px;background:' + (b.method && b.method.includes('SMS') ? 'rgba(16,185,129,0.1)' : 'rgba(59,130,246,0.1)') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
                    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="' + (b.method && b.method.includes('SMS') ? 'var(--color-success)' : 'var(--color-info)') + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></div>' +
                    '<div style="flex:1"><div style="font-size:13px;font-weight:700">' + esc(b.subject) + '</div>' +
                    '<div style="display:flex;gap:10px;font-size:10px;color:var(--s400);margin-top:3px">' +
                    '<span>📅 ' + fmtDate(b.date) + '</span><span>👥 ' + esc(b.to) + '</span><span>📨 ' + esc(b.method) + '</span>' +
                    '<span>✓ ' + b.opened + '/' + b.sent + ' opened (' + openPct + '%)</span></div></div></div>';
            });
        }

        container.innerHTML = html;
    }

    // ─── COMING SOON ─────────────────────────────────────────────────
    function renderComingSoon(page) {
        var container = document.getElementById('page-' + page);
        var titles = { forms: 'Forms & Documents', reports: 'Reports', settings: 'Settings' };
        var descs = {
            forms: 'Custom form builder for waivers, health history, parent agreements. E-signatures, document uploads, and auto-reminders.',
            reports: 'Bunk rosters, financial summaries, attendance trends, missing forms. One-click PDF/CSV export.',
            settings: 'Season rollover, custom fields, permissions, camp branding, payment processing setup.'
        };
        var iconPaths = {
            forms: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
            reports: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
            settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06"/>'
        };

        container.innerHTML = '<div class="me-coming-soon">' +
            '<div class="me-coming-soon-icon"><svg viewBox="0 0 24 24">' + (iconPaths[page] || '') + '</svg></div>' +
            '<h2>' + (titles[page] || page) + '</h2>' +
            '<p>' + (descs[page] || 'This module is in development.') + '</p>' +
            '<div class="me-coming-soon-badge">Coming Soon</div></div>';
    }

    // =========================================================================
    // DRAWER (Camper Detail Panel)
    // =========================================================================

    function setupDrawer() {
        var overlay = document.getElementById('camperDrawer');
        if (!overlay) return;

        overlay.querySelector('.me-drawer-backdrop').addEventListener('click', closeDrawer);

        overlay.querySelectorAll('.me-drawer-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                drawerTab = tab.dataset.dtab;
                overlay.querySelectorAll('.me-drawer-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.dtab === drawerTab); });
                renderDrawerBody();
            });
        });
    }

    function openDrawer(camperName) {
        drawerCamperId = camperName;
        drawerTab = 'overview';
        var overlay = document.getElementById('camperDrawer');
        overlay.style.display = 'flex';
        overlay.querySelectorAll('.me-drawer-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.dtab === 'overview'); });
        renderDrawerHeader();
        renderDrawerBody();
    }

    function closeDrawer() {
        document.getElementById('camperDrawer').style.display = 'none';
        drawerCamperId = null;
    }

    function renderDrawerHeader() {
        var c = camperRoster[drawerCamperId];
        if (!c) return;
        var name = drawerCamperId;
        var divColor = (structure[c.division] && structure[c.division].color) || 'var(--camp-teal)';

        var html = '<div style="display:flex;justify-content:space-between;margin-bottom:12px">' +
            '<button onclick="CampistryMeV5.closeDrawer()" class="me-btn me-btn--ghost" style="font-size:12px">✕ Close</button></div>' +
            '<div style="display:flex;align-items:center;gap:14px">' +
            avatarHtml(name, 'lg') +
            '<div><h2 style="font-size:17px;font-weight:800;margin:0">' + esc(name) + '</h2>' +
            '<div style="display:flex;gap:5px;margin-top:5px;flex-wrap:wrap">' +
            (c.division ? divTagHtml(c.division) : '') +
            (c.bunk ? '<span style="font-size:10px;font-weight:600;color:var(--s500);background:var(--s100);padding:2px 7px;border-radius:5px">' + esc(c.bunk) + '</span>' : '') +
            ringHtml(profilePct(c), 22) +
            '</div></div></div>';

        document.getElementById('drawerHeader').innerHTML = html;
    }

    function renderDrawerBody() {
        var c = camperRoster[drawerCamperId];
        if (!c) return;
        var html = '';

        if (drawerTab === 'overview') {
            // Personal
            html += '<div style="margin-bottom:8px"><div class="me-drawer-section-title" style="padding:8px 0;border-bottom:1px solid var(--s100);font-size:12px;font-weight:700;color:var(--s700);margin-bottom:6px">Personal</div>';
            if (c.dob) html += drawerRow('DOB', fmtDate(c.dob) + ' (age ' + getAge(c.dob) + ')');
            if (c.gender) html += drawerRow('Gender', c.gender);
            if (c.schoolGrade) html += drawerRow('School Grade', c.schoolGrade);
            if (c.team) html += drawerRow('Team', c.team);
            html += '</div>';

            // Medical Summary (read-only, links to Health)
            html += '<div style="margin-bottom:8px"><div class="me-drawer-section-title" style="padding:8px 0;border-bottom:1px solid var(--s100);font-size:12px;font-weight:700;color:var(--s700);margin-bottom:6px">Medical Summary</div>';
            if (c.allergies) html += drawerRow('Allergies', c.allergies, true);
            if (c.medications) html += drawerRow('Medications', c.medications, true);
            if (c.dietary) html += drawerRow('Dietary', c.dietary);
            if (!c.allergies && !c.medications && !c.dietary) {
                html += '<div style="font-size:11px;color:var(--color-success);font-weight:600;padding:3px 0">✓ No medical flags on file</div>';
            }
            html += '<div class="me-health-link"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> Open in Campistry Health →</div>';
            html += '</div>';

            // Emergency
            html += '<div style="margin-bottom:8px"><div class="me-drawer-section-title" style="padding:8px 0;border-bottom:1px solid var(--s100);font-size:12px;font-weight:700;color:var(--s700);margin-bottom:6px">Emergency Contact</div>';
            if (c.emergencyName) {
                html += drawerRow('Contact', c.emergencyName + (c.emergencyRel ? ' (' + c.emergencyRel + ')' : ''));
                if (c.emergencyPhone) html += drawerRow('Phone', '<a href="tel:' + esc(c.emergencyPhone) + '" style="color:var(--camp-teal);text-decoration:none">' + esc(c.emergencyPhone) + '</a>');
            } else {
                html += '<div style="font-size:11px;color:var(--color-error);font-style:italic;padding:3px 0">No emergency contact on file</div>';
            }
            html += '</div>';

        } else if (drawerTab === 'timeline') {
            html += '<div style="text-align:center;padding:40px 16px;color:var(--s400)">' +
                '<div style="font-size:24px;margin-bottom:8px">📋</div>' +
                '<div style="font-size:13px;font-weight:600">Timeline Coming Soon</div>' +
                '<div style="font-size:11px;margin-top:4px">Enrollment, payments, forms, assignments — all in one feed.</div></div>';
        }

        document.getElementById('drawerBody').innerHTML = html;
    }

    function drawerRow(label, value, warn) {
        return '<div class="me-drawer-row"><span class="me-drawer-row-label">' + esc(label) + '</span>' +
            '<span class="me-drawer-row-value' + (warn ? ' warn' : '') + '">' + (value || '—') + '</span></div>';
    }

    // =========================================================================
    // MODALS
    // =========================================================================

    function setupModals() {
        // CSV dropzone
        var dropzone = document.getElementById('csvDropzone');
        var fileInput = document.getElementById('csvFileInput');
        if (dropzone && fileInput) {
            dropzone.addEventListener('click', function() { fileInput.click(); });
            dropzone.addEventListener('dragover', function(e) { e.preventDefault(); dropzone.classList.add('dragover'); });
            dropzone.addEventListener('dragleave', function() { dropzone.classList.remove('dragover'); });
            dropzone.addEventListener('drop', function(e) { e.preventDefault(); dropzone.classList.remove('dragover'); handleCsvFile(e.dataTransfer.files[0]); });
            fileInput.addEventListener('change', function(e) { handleCsvFile(e.target.files[0]); });
        }

        // Close modals on backdrop click
        document.querySelectorAll('.me-modal-overlay').forEach(function(overlay) {
            overlay.addEventListener('mousedown', function(e) {
                if (e.target === overlay) closeModal(overlay.id);
            });
        });
    }

    function openModal(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'flex';
    }

    function closeModal(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }

    function openCsvModal() { openModal('csvModal'); }

    function handleCsvFile(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(e) {
            var text = e.target.result;
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            var lines = text.split(/\r?\n/).filter(function(l) { return l.trim(); });
            if (!lines.length) { toast('CSV is empty', 'error'); return; }
            var first = lines[0].toLowerCase();
            var start = (first.includes('name') || first.includes('division')) ? 1 : 0;
            var rows = [];
            for (var i = start; i < Math.min(lines.length, 5001); i++) {
                var cols = lines[i].split(',').map(function(s) { return s.trim().replace(/^"|"$/g, ''); });
                if (cols[0]) rows.push({ name: cols[0], division: cols[1] || '', grade: cols[2] || '', bunk: cols[3] || '', team: cols[4] || '' });
            }
            if (rows.length > 0) {
                document.getElementById('csvPreviewArea').style.display = 'block';
                document.getElementById('csvPreviewArea').innerHTML = '<div style="font-weight:700;font-size:13px;margin:12px 0 8px">' + rows.length + ' rows found</div>';
                document.getElementById('csvImportBtn').disabled = false;
                document.getElementById('csvImportBtn').onclick = function() { importCsvRows(rows); };
            }
        };
        reader.readAsText(file);
    }

    function importCsvRows(rows) {
        var added = 0;
        rows.forEach(function(r) {
            if (r.division && !structure[r.division]) {
                structure[r.division] = { color: COLOR_PRESETS[Object.keys(structure).length % COLOR_PRESETS.length], grades: {} };
            }
            if (r.division && r.grade && structure[r.division] && !structure[r.division].grades[r.grade]) {
                structure[r.division].grades[r.grade] = { bunks: [] };
            }
            if (r.division && r.grade && r.bunk && structure[r.division] && structure[r.division].grades[r.grade]) {
                var bunks = structure[r.division].grades[r.grade].bunks;
                if (bunks.indexOf(r.bunk) === -1) bunks.push(r.bunk);
            }
            if (!camperRoster[r.name]) added++;
            camperRoster[r.name] = { division: r.division, grade: r.grade, bunk: r.bunk, team: r.team };
        });
        families = buildFamiliesFromRoster();
        saveData();
        closeModal('csvModal');
        renderPage(currentPage);
        toast(added + ' campers imported');
    }

    function exportCsv() {
        var entries = Object.entries(camperRoster);
        if (!entries.length) { toast('No campers', 'error'); return; }
        var csv = '\uFEFFName,Division,Grade,Bunk,Team\n';
        entries.forEach(function([name, d]) {
            csv += '"' + name + '","' + (d.division || '') + '","' + (d.grade || '') + '","' + (d.bunk || '') + '","' + (d.team || '') + '"\n';
        });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'campers_' + new Date().toISOString().split('T')[0] + '.csv';
        a.click();
        toast('Exported ' + entries.length + ' campers');
    }

    // Placeholder action handlers
    function addFamily() { toast('Family creation — coming in next update', 'error'); }
    function addCamper() { toast('Camper creation — coming in next update', 'error'); }
    function addDivision() { toast('Division creation — coming in next update', 'error'); }
    function editDivision(name) { toast('Edit "' + name + '" — coming in next update', 'error'); }
    function deleteDivision(name) {
        if (!confirm('Delete "' + name + '"?')) return;
        delete structure[name];
        Object.values(camperRoster).forEach(function(c) {
            if (c.division === name) { c.division = ''; c.grade = ''; c.bunk = ''; }
        });
        saveData();
        renderPage(currentPage);
        toast('Division deleted');
    }

    // =========================================================================
    // BOOT
    // =========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.CampistryMeV5 = {
        // Navigation
        nav: navigateTo,

        // Drawer
        openDrawer: openDrawer,
        closeDrawer: closeDrawer,

        // Modals
        closeModal: closeModal,
        openCsvModal: openCsvModal,

        // Actions
        addFamily: addFamily,
        addCamper: addCamper,
        addDivision: addDivision,
        editDivision: editDivision,
        deleteDivision: deleteDivision,
        exportCsv: exportCsv,

        // Attendance
        markAttendance: markAttendance,

        // Bunk Builder
        bbDrop: bbDrop,
        autoAssignBunks: autoAssignBunks,
        clearBunkAssignments: clearBunkAssignments,
    };

    console.log('📋 Campistry Me v5.0 loaded');

})();
