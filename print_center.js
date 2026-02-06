// =================================================================
// print_center.js v3.5 — Visual Schedule Designer
// =================================================================
// v3.5 CHANGES:
// - Real-time live preview (no Preview button — updates on every change)
// - Zoom in/out for preview
// - Transpose: bunks-on-top vs time-on-top
// - Hide league matchups toggle (shows "League Game 4" instead of full matchups)
// - Per-division vs All-bunks-combined layout
// - Quick settings bar (logo, name, subtitle) always visible
// - Advanced design in collapsible slide-out drawer
// - Larger preview area (full workspace height)
// - Full data fallback chains matching unified_schedule_system.js
// =================================================================

(function() {
'use strict';

const VERSION = '3.5.0';
console.log(`🖨️ Print Center v${VERSION} loading...`);

// --- CONSTANTS ---
const INCREMENT_MINS = 30;
const DEFAULT_TEMPLATE = {
    id: 'default',
    name: 'Default Template',
    isDefault: true,
    // Header
    headerEnabled: true,
    campName: '',
    campLogo: null,
    headerBgColor: '#147D91',
    headerTextColor: '#FFFFFF',
    headerFont: 'Inter',
    headerFontSize: 24,
    showDate: true,
    showDivisionName: true,
    customSubtitle: '',
    // Grid
    gridFont: 'Inter',
    gridFontSize: 11,
    gridHeaderBgColor: '#F1F5F9',
    gridHeaderTextColor: '#0F172A',
    gridBorderColor: '#CBD5E1',
    gridBorderWidth: 1,
    gridRowAltColor: '#F8FAFC',
    gridRowColor: '#FFFFFF',
    cellPadding: 8,
    // Cell Colors
    pinnedBgColor: '#FFF8E1',
    pinnedTextColor: '#92400E',
    leagueBgColor: '#E8F4FF',
    leagueTextColor: '#1E40AF',
    generalBgColor: '#FFFFFF',
    generalTextColor: '#1E293B',
    freeBgColor: '#F9FAFB',
    freeTextColor: '#9CA3AF',
    // Time Column
    timeColWidth: 130,
    timeColBgColor: '#F8FAFC',
    timeColTextColor: '#475569',
    timeColFont: 'Inter',
    timeColFontSize: 11,
    timeColBold: true,
    // Layout
    orientation: 'landscape',
    paperSize: 'letter',
    padding: 20,
    showPageBreaks: true,
    // ★ v3.5 new
    tableOrientation: 'bunks-top',   // bunks-top | time-top
    hideLeagueMatchups: false,
    layoutMode: 'per-division',      // per-division | all-bunks
    // Watermark
    watermarkEnabled: false,
    watermarkText: '',
    watermarkOpacity: 0.08,
    watermarkColor: '#000000',
    // Footer
    footerEnabled: false,
    footerText: '',
    footerFont: 'Inter',
    footerFontSize: 9,
};

// --- STATE ---
let _currentTemplate = { ...DEFAULT_TEMPLATE };
let _savedTemplates = [];
let _activeView = 'division';
let _previewHtml = '';
let _advancedOpen = false;
let _zoomLevel = 85;
let _cloudSyncTimeout = null;
const CLOUD_SYNC_DEBOUNCE = 800;

// =========================================================================
// TIME UTILITIES
// =========================================================================

function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith("am") || s.endsWith("pm")) {
        mer = s.endsWith("am") ? "am" : "pm";
        s = s.replace(/am|pm/g, "").trim();
    }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    if (mer) {
        if (hh === 12) hh = mer === "am" ? 0 : 12;
        else if (mer === "pm") hh += 12;
    }
    return hh * 60 + mm;
}

function minutesToTimeLabel(min) {
    let h = Math.floor(min / 60);
    let m = min % 60;
    let ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ':' + m.toString().padStart(2, '0') + ' ' + ap;
}

function findFirstSlotForTime(startMin, divName) {
    if (divName && window.divisionTimes && window.divisionTimes[divName]) {
        const times = window.divisionTimes[divName];
        for (let i = 0; i < times.length; i++) {
            const slot = times[i];
            const slotStart = slot.startMin !== undefined ? slot.startMin : (new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes());
            if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) return i;
        }
        return -1;
    }
    const times = window.unifiedTimes || [];
    if (startMin === null || !times.length) return -1;
    for (let i = 0; i < times.length; i++) {
        const slot = times[i];
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) return i;
    }
    return -1;
}

function getEntry(bunk, slotIndex) {
    const assignments = window.scheduleAssignments || window.loadCurrentDailyData?.()?.scheduleAssignments || {};
    if (bunk && assignments[bunk] && assignments[bunk][slotIndex]) return assignments[bunk][slotIndex];
    return null;
}

function formatEntry(entry) {
    if (!entry) return "";
    if (entry._isDismissal) return "Dismissal";
    if (entry._isSnack) return "Snacks";
    let label = "";
    if (typeof entry.field === 'string') label = entry.field;
    else if (entry.field && entry.field.name) label = entry.field.name;
    if (entry._h2h) return entry.sport || "League Game";
    if (entry._fixed) return label || entry._activity || "";
    if (entry.sport) return label + ' – ' + entry.sport;
    return label;
}

function naturalSort(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function fontOptions(selected) {
    const fonts = ['Inter','Arial','Helvetica','Georgia','Times New Roman','Courier New','Verdana','Trebuchet MS','Palatino','Garamond'];
    return fonts.map(f => '<option value="' + f + '"' + (f === selected ? ' selected' : '') + '>' + f + '</option>').join('');
}

function formatDisplayDate(dateStr) {
    if (!dateStr) return '';
    try { const d = new Date(dateStr + 'T12:00:00'); return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return dateStr; }
}

// =========================================================================
// DATA HELPERS — full fallback chains matching unified_schedule_system.js
// =========================================================================

function getSkeleton() {
    const daily = window.loadCurrentDailyData?.() || {};
    let sk = daily.manualSkeleton || daily.skeleton ||
             window.dailyOverrideSkeleton || window.manualSkeleton || window.skeleton || [];
    if (sk.length === 0) {
        try { const dateKey = window.currentScheduleDate; const stored = dateKey ? localStorage.getItem('campManualSkeleton_' + dateKey) : null; if (stored) sk = JSON.parse(stored) || []; } catch (e) {}
    }
    if (sk.length === 0) {
        try { const dateKey = window.currentScheduleDate; const ms = window.loadGlobalSettings?.(); const cloud = ms?.app1?.dailySkeletons?.[dateKey]; if (cloud && cloud.length > 0) sk = cloud; } catch (e) {}
    }
    return sk;
}

function getDivisions() {
    return window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
}

function getAvailableDivisions() {
    const app1 = window.loadGlobalSettings?.()?.app1 || {};
    return window.availableDivisions || app1.availableDivisions || Object.keys(getDivisions());
}

function getAssignments() {
    return window.scheduleAssignments || window.loadCurrentDailyData?.()?.scheduleAssignments || {};
}

// =========================================================================
// TEMPLATE PERSISTENCE
// =========================================================================

function loadTemplates() {
    try {
        const g = window.loadGlobalSettings?.() || {};
        if (g.printTemplates && Array.isArray(g.printTemplates) && g.printTemplates.length > 0) { _savedTemplates = g.printTemplates; return; }
        const raw = localStorage.getItem('campistry_print_templates');
        if (raw) { _savedTemplates = JSON.parse(raw); return; }
    } catch (e) { console.warn('🖨️ Template load error:', e); }
    _savedTemplates = [];
}

function saveTemplates() {
    if (!canEditTemplates()) return false;
    try {
        localStorage.setItem('campistry_print_templates', JSON.stringify(_savedTemplates));
        window.saveGlobalSettings?.("printTemplates", _savedTemplates);
        clearTimeout(_cloudSyncTimeout);
        _cloudSyncTimeout = setTimeout(() => { window.forceSyncToCloud?.(); }, CLOUD_SYNC_DEBOUNCE);
        return true;
    } catch (e) { return false; }
}

function saveCurrentAsTemplate(name) {
    if (!canEditTemplates()) return false;
    const tpl = { ...JSON.parse(JSON.stringify(_currentTemplate)), id: 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name: name || 'Untitled', isDefault: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    _savedTemplates.push(tpl);
    saveTemplates();
    return tpl;
}

function updateTemplate(templateId) {
    if (!canEditTemplates()) return false;
    const idx = _savedTemplates.findIndex(t => t.id === templateId);
    if (idx === -1) return false;
    _savedTemplates[idx] = { ...JSON.parse(JSON.stringify(_currentTemplate)), id: templateId, name: _savedTemplates[idx].name, isDefault: false, createdAt: _savedTemplates[idx].createdAt, updatedAt: new Date().toISOString() };
    saveTemplates();
    return true;
}

function deleteTemplate(templateId) {
    if (!canEditTemplates()) return false;
    _savedTemplates = _savedTemplates.filter(t => t.id !== templateId);
    saveTemplates();
    return true;
}

function loadTemplate(templateId) {
    if (templateId === 'default') _currentTemplate = { ...DEFAULT_TEMPLATE };
    else { const tpl = _savedTemplates.find(t => t.id === templateId); if (tpl) _currentTemplate = { ...DEFAULT_TEMPLATE, ...JSON.parse(JSON.stringify(tpl)) }; }
    liveRefresh();
    renderTemplateDropdown();
}

// =========================================================================
// RBAC
// =========================================================================

function canEditTemplates() {
    if (window.AccessControl?.isOwner?.()) return true;
    if (window.AccessControl?.isAdmin?.()) return true;
    const role = window.CloudPermissions?.getRole?.() || window.CampistryDB?.getRole?.() || localStorage.getItem('campistry_role') || 'viewer';
    return role === 'owner' || role === 'admin';
}

// =========================================================================
// INIT
// =========================================================================

function initPrintCenter() {
    const container = document.getElementById("print-content");
    if (!container) return;
    console.log('🖨️ Print Center v' + VERSION + ' init');

    loadTemplates();
    const lastId = localStorage.getItem('campistry_last_print_template');
    if (lastId && lastId !== 'default') {
        const tpl = _savedTemplates.find(t => t.id === lastId);
        if (tpl) _currentTemplate = { ...DEFAULT_TEMPLATE, ...JSON.parse(JSON.stringify(tpl)) };
    }
    if (!_currentTemplate.campName) {
        const g = window.loadGlobalSettings?.() || {};
        _currentTemplate.campName = g.campName || g.app1?.campName || '';
    }

    container.innerHTML = buildMainUI();
    bindAll();
    populateSelectors();
    // Auto-select all and render immediately
    document.querySelectorAll('.pc-item-cb').forEach(cb => cb.checked = true);
    liveRefresh();
}

// =========================================================================
// MAIN UI — maximized preview, compact controls
// =========================================================================

function buildMainUI() {
    const isEditor = canEditTemplates();
    const t = _currentTemplate;

    return '<div class="pc-container">' +

    // ── TOP BAR ──
    '<div class="pc-topbar no-print">' +
        '<div class="pc-topbar-left">' +
            '<h1 class="pc-title">\uD83D\uDDA8\uFE0F Print Center</h1>' +
        '</div>' +
        '<div class="pc-topbar-right">' +
            (isEditor ? '<button class="pc-btn pc-btn-ghost pc-btn-sm" onclick="window._pcToggleAdvanced()" title="Advanced design settings">⚙️ Advanced</button>' : '') +
            '<button class="pc-btn pc-btn-secondary pc-btn-sm" onclick="window._pcExportExcel()">📊 Excel</button>' +
            '<button class="pc-btn pc-btn-primary pc-btn-sm" onclick="window._pcPrint()">🖨️ Print</button>' +
        '</div>' +
    '</div>' +

    // ── QUICK SETTINGS (always visible for editors) ──
    (isEditor ? buildQuickSettings() : '') +

    // ── CONTROLS ROW ──
    '<div class="pc-controls no-print">' +
        '<div class="pc-controls-top">' +
            '<div class="pc-view-tabs">' +
                '<button class="pc-view-tab active" data-view="division">📅 Divisions</button>' +
                '<button class="pc-view-tab" data-view="bunk">👤 Bunks</button>' +
                '<button class="pc-view-tab" data-view="location">📍 Locations</button>' +
            '</div>' +
            '<div class="pc-view-options">' +
                '<label class="pc-opt" title="Swap rows and columns"><input type="checkbox" id="pc-transpose"' + (t.tableOrientation === 'time-top' ? ' checked' : '') + '> ↔️ Transpose</label>' +
                '<label class="pc-opt" title="Show only league game number, hide matchup details"><input type="checkbox" id="pc-hide-matchups"' + (t.hideLeagueMatchups ? ' checked' : '') + '> 🏆 Hide Matchups</label>' +
                '<label class="pc-opt" title="Show all bunks in one wide table" id="pc-combined-wrap"><input type="checkbox" id="pc-combined"' + (t.layoutMode === 'all-bunks' ? ' checked' : '') + '> 📋 Combined</label>' +
                '<div class="pc-zoom-controls">' +
                    '<button class="pc-zoom-btn" onclick="window._pcZoom(-10)">−</button>' +
                    '<span class="pc-zoom-label" id="pc-zoom-label">' + _zoomLevel + '%</span>' +
                    '<button class="pc-zoom-btn" onclick="window._pcZoom(10)">+</button>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="pc-selector-row">' +
            '<div class="pc-selector-box" id="pc-selector-container"></div>' +
            '<div class="pc-selector-actions">' +
                '<button class="pc-btn pc-btn-xs" onclick="window._pcSelectAll()">All</button>' +
                '<button class="pc-btn pc-btn-xs pc-btn-ghost" onclick="window._pcDeselectAll()">Clear</button>' +
            '</div>' +
        '</div>' +
    '</div>' +

    // ── WORKSPACE ──
    '<div class="pc-workspace">' +
        // Advanced drawer (slide-over)
        '<aside class="pc-advanced-drawer no-print' + (_advancedOpen ? ' open' : '') + '" id="pc-advanced-drawer">' +
            '<div class="pc-adv-header"><strong>⚙️ Advanced Design</strong><button class="pc-adv-close" onclick="window._pcToggleAdvanced()">✕</button></div>' +
            '<div class="pc-adv-scroll">' + buildAdvancedSections() + '</div>' +
        '</aside>' +

        // Preview area (full width)
        '<div class="pc-preview-area" id="pc-preview-area">' +
            '<div class="pc-preview-empty" id="pc-preview-empty" style="display:none;">' +
                '<div class="pc-preview-empty-icon">📋</div>' +
                '<h3>Select divisions or bunks above</h3>' +
                '<p>Your styled schedule will appear here in real time.</p>' +
            '</div>' +
            '<div id="pc-preview-content" class="pc-preview-content" style="transform:scale(' + (_zoomLevel / 100) + '); transform-origin:top left;"></div>' +
        '</div>' +
    '</div>' +

    '<div id="printable-area"></div>' +
    '</div>';
}

// =========================================================================
// QUICK SETTINGS BAR — logo, name, subtitle always accessible
// =========================================================================

function buildQuickSettings() {
    const t = _currentTemplate;
    return '<div class="pc-quick no-print">' +
        '<div class="pc-quick-group">' +
            '<div class="pc-quick-logo">' +
                (t.campLogo
                    ? '<img src="' + t.campLogo + '" class="pc-logo-thumb" alt="Logo" onclick="document.getElementById(\'pc-logo-input\').click()" title="Click to change logo">' +
                      '<button class="pc-logo-x" onclick="window._pcRemoveLogo()" title="Remove logo">✕</button>'
                    : '<button class="pc-logo-add" onclick="document.getElementById(\'pc-logo-input\').click()" title="Upload camp logo">+ Logo</button>') +
                '<input type="file" id="pc-logo-input" accept="image/*" style="display:none" onchange="window._pcHandleLogo(this)">' +
            '</div>' +
            '<input type="text" class="pc-quick-input pc-quick-name" id="pc-camp-name" value="' + escHtml(t.campName) + '" placeholder="Camp Name">' +
            '<input type="text" class="pc-quick-input pc-quick-sub" id="pc-custom-subtitle" value="' + escHtml(t.customSubtitle) + '" placeholder="Subtitle (e.g. Week 3 — Color War)">' +
        '</div>' +
        '<div class="pc-quick-group pc-quick-toggles">' +
            '<label class="pc-opt"><input type="checkbox" id="pc-header-enabled"' + (t.headerEnabled ? ' checked' : '') + '> Header</label>' +
            '<label class="pc-opt"><input type="checkbox" id="pc-show-date"' + (t.showDate ? ' checked' : '') + '> Date</label>' +
            '<label class="pc-opt"><input type="checkbox" id="pc-show-div-name"' + (t.showDivisionName ? ' checked' : '') + '> Title</label>' +
        '</div>' +
        '<div class="pc-quick-group">' +
            '<select id="pc-template-select" class="pc-quick-tpl" onchange="window._pcLoadTemplate(this.value)"><option value="default">Default</option></select>' +
            (canEditTemplates()
                ? '<button class="pc-btn pc-btn-xs pc-btn-primary" onclick="window._pcSaveAsTemplate()" title="Save as new template">💾</button>' +
                  '<button class="pc-btn pc-btn-xs" onclick="window._pcUpdateTemplate()" id="pc-btn-update-tpl" style="display:none;" title="Update">🔄</button>' +
                  '<button class="pc-btn pc-btn-xs pc-btn-danger" onclick="window._pcDeleteTemplate()" id="pc-btn-delete-tpl" style="display:none;" title="Delete">🗑️</button>'
                : '') +
        '</div>' +
    '</div>';
}

// =========================================================================
// ADVANCED DESIGN DRAWER (collapsible sections)
// =========================================================================

function buildAdvancedSections() {
    const t = _currentTemplate;
    return '' +
    // Header Colors
    '<details class="pc-adv-section" open>' +
        '<summary>🏕️ Header Colors</summary>' +
        '<div class="pc-adv-body">' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>BG</label><input type="color" id="pc-header-bg" value="' + t.headerBgColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Text</label><input type="color" id="pc-header-text" value="' + t.headerTextColor + '"></div></div>' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Font</label><select id="pc-header-font">' + fontOptions(t.headerFont) + '</select></div><div class="pc-dp-field pc-dp-half"><label>Size</label><input type="number" id="pc-header-font-size" value="' + t.headerFontSize + '" min="12" max="48"></div></div>' +
        '</div>' +
    '</details>' +

    // Grid Styling
    '<details class="pc-adv-section">' +
        '<summary>📊 Grid Styling</summary>' +
        '<div class="pc-adv-body">' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Font</label><select id="pc-grid-font">' + fontOptions(t.gridFont) + '</select></div><div class="pc-dp-field pc-dp-half"><label>Size</label><input type="number" id="pc-grid-font-size" value="' + t.gridFontSize + '" min="8" max="18"></div></div>' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Header BG</label><input type="color" id="pc-grid-header-bg" value="' + t.gridHeaderBgColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Header Text</label><input type="color" id="pc-grid-header-text" value="' + t.gridHeaderTextColor + '"></div></div>' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Border</label><input type="color" id="pc-grid-border-color" value="' + t.gridBorderColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Width</label><input type="number" id="pc-grid-border-width" value="' + t.gridBorderWidth + '" min="0" max="4"></div></div>' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Row</label><input type="color" id="pc-grid-row-color" value="' + t.gridRowColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Alt Row</label><input type="color" id="pc-grid-row-alt" value="' + t.gridRowAltColor + '"></div></div>' +
            '<div class="pc-dp-field"><label>Cell Padding</label><input type="range" id="pc-cell-padding" min="2" max="20" value="' + t.cellPadding + '"></div>' +
        '</div>' +
    '</details>' +

    // Activity Colors
    '<details class="pc-adv-section">' +
        '<summary>🎨 Activity Colors</summary>' +
        '<div class="pc-adv-body">' +
            '<div class="pc-dp-color-grid">' +
                '<div class="pc-dp-color-pair"><span>General</span><input type="color" id="pc-general-bg" value="' + t.generalBgColor + '"><input type="color" id="pc-general-text" value="' + t.generalTextColor + '"></div>' +
                '<div class="pc-dp-color-pair"><span>Pinned</span><input type="color" id="pc-pinned-bg" value="' + t.pinnedBgColor + '"><input type="color" id="pc-pinned-text" value="' + t.pinnedTextColor + '"></div>' +
                '<div class="pc-dp-color-pair"><span>League</span><input type="color" id="pc-league-bg" value="' + t.leagueBgColor + '"><input type="color" id="pc-league-text" value="' + t.leagueTextColor + '"></div>' +
                '<div class="pc-dp-color-pair"><span>Free</span><input type="color" id="pc-free-bg" value="' + t.freeBgColor + '"><input type="color" id="pc-free-text" value="' + t.freeTextColor + '"></div>' +
            '</div>' +
        '</div>' +
    '</details>' +

    // Time Column
    '<details class="pc-adv-section">' +
        '<summary>🕐 Time Column</summary>' +
        '<div class="pc-adv-body">' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>BG</label><input type="color" id="pc-time-bg" value="' + t.timeColBgColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Text</label><input type="color" id="pc-time-text" value="' + t.timeColTextColor + '"></div></div>' +
            '<div class="pc-dp-field"><label>Width (px)</label><input type="number" id="pc-time-width" value="' + t.timeColWidth + '" min="60" max="200"></div>' +
            '<label class="pc-dp-toggle"><input type="checkbox" id="pc-time-bold"' + (t.timeColBold ? ' checked' : '') + '> Bold time</label>' +
        '</div>' +
    '</details>' +

    // Print Layout
    '<details class="pc-adv-section">' +
        '<summary>📐 Print Layout</summary>' +
        '<div class="pc-adv-body">' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Orientation</label><select id="pc-orientation"><option value="landscape"' + (t.orientation==='landscape'?' selected':'') + '>Landscape</option><option value="portrait"' + (t.orientation==='portrait'?' selected':'') + '>Portrait</option></select></div><div class="pc-dp-field pc-dp-half"><label>Paper</label><select id="pc-paper-size"><option value="letter"' + (t.paperSize==='letter'?' selected':'') + '>Letter</option><option value="a4"' + (t.paperSize==='a4'?' selected':'') + '>A4</option><option value="legal"' + (t.paperSize==='legal'?' selected':'') + '>Legal</option></select></div></div>' +
            '<label class="pc-dp-toggle"><input type="checkbox" id="pc-page-breaks"' + (t.showPageBreaks ? ' checked' : '') + '> Page breaks between items</label>' +
        '</div>' +
    '</details>' +

    // Watermark
    '<details class="pc-adv-section">' +
        '<summary>💧 Watermark</summary>' +
        '<div class="pc-adv-body">' +
            '<label class="pc-dp-toggle"><input type="checkbox" id="pc-watermark-enabled"' + (t.watermarkEnabled ? ' checked' : '') + '> Enable</label>' +
            '<div class="pc-dp-field"><label>Text</label><input type="text" id="pc-watermark-text" value="' + escHtml(t.watermarkText) + '" placeholder="DRAFT"></div>' +
            '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Color</label><input type="color" id="pc-watermark-color" value="' + t.watermarkColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Opacity</label><input type="range" id="pc-watermark-opacity" min="0.02" max="0.3" step="0.01" value="' + t.watermarkOpacity + '"></div></div>' +
        '</div>' +
    '</details>' +

    // Footer
    '<details class="pc-adv-section">' +
        '<summary>📝 Footer</summary>' +
        '<div class="pc-adv-body">' +
            '<label class="pc-dp-toggle"><input type="checkbox" id="pc-footer-enabled"' + (t.footerEnabled ? ' checked' : '') + '> Enable</label>' +
            '<div class="pc-dp-field"><label>Text</label><input type="text" id="pc-footer-text" value="' + escHtml(t.footerText) + '" placeholder="Confidential"></div>' +
        '</div>' +
    '</details>' +

    // Reset
    '<div style="padding:12px 0;"><button class="pc-btn pc-btn-ghost" style="width:100%;" onclick="window._pcResetToDefault()">↩️ Reset to Default</button></div>';
}

// =========================================================================
// EVENT BINDING
// =========================================================================

function bindAll() {
    // View tabs
    document.querySelectorAll('.pc-view-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.pc-view-tab').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            _activeView = btn.dataset.view;
            var cw = document.getElementById('pc-combined-wrap');
            if (cw) cw.style.display = _activeView === 'division' ? '' : 'none';
            populateSelectors();
            document.querySelectorAll('.pc-item-cb').forEach(function(cb) { cb.checked = true; });
            liveRefresh();
        });
    });

    // Selector changes → live
    var selContainer = document.getElementById('pc-selector-container');
    if (selContainer) selContainer.addEventListener('change', function(e) { if (e.target.matches('.pc-item-cb')) liveRefresh(); });

    // Quick settings live binding
    var debouncedLive = debounce(function() { readDesignValues(); liveRefresh(); }, 200);
    document.querySelectorAll('.pc-quick input, .pc-quick select').forEach(function(el) {
        el.addEventListener('input', debouncedLive);
        el.addEventListener('change', function() { readDesignValues(); liveRefresh(); });
    });

    // View option toggles
    ['pc-transpose', 'pc-hide-matchups', 'pc-combined'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function() { readDesignValues(); liveRefresh(); });
    });

    // Advanced drawer live binding
    var drawer = document.getElementById('pc-advanced-drawer');
    if (drawer) {
        var debouncedAdv = debounce(function() { readDesignValues(); liveRefresh(); }, 200);
        drawer.addEventListener('input', function(e) { if (e.target.matches('input, select')) debouncedAdv(); });
        drawer.addEventListener('change', function(e) { if (e.target.matches('input, select')) { readDesignValues(); liveRefresh(); }});
    }

    renderTemplateDropdown();
}

// =========================================================================
// POPULATE SELECTORS
// =========================================================================

function populateSelectors() {
    var container = document.getElementById('pc-selector-container');
    if (!container) return;
    var divisions = getDivisions();
    var availableDivisions = getAvailableDivisions();
    var app1 = window.loadGlobalSettings?.()?.app1 || {};
    var fields = app1.fields || [];
    var specials = app1.specialActivities || [];

    var html = '';
    if (_activeView === 'division') {
        availableDivisions.forEach(function(dv) { html += '<label class="pc-selector-item"><input type="checkbox" value="' + escHtml(dv) + '" class="pc-item-cb"> ' + escHtml(dv) + '</label>'; });
    } else if (_activeView === 'bunk') {
        availableDivisions.forEach(function(dv) {
            var bunks = (divisions[dv]?.bunks || []).sort(naturalSort);
            if (bunks.length > 0) {
                html += '<div class="pc-selector-group">' + escHtml(dv) + '</div>';
                bunks.forEach(function(b) { html += '<label class="pc-selector-item"><input type="checkbox" value="' + escHtml(b) + '" class="pc-item-cb"> ' + escHtml(b) + '</label>'; });
            }
        });
    } else if (_activeView === 'location') {
        var allLocs = fields.map(function(f){return f.name;}).concat(specials.map(function(s){return s.name;})).sort(naturalSort);
        allLocs.forEach(function(loc) { html += '<label class="pc-selector-item"><input type="checkbox" value="' + escHtml(loc) + '" class="pc-item-cb"> ' + escHtml(loc) + '</label>'; });
    }
    container.innerHTML = html;
}

function getSelectedItems() {
    return Array.from(document.querySelectorAll('.pc-item-cb:checked')).map(function(cb) { return cb.value; });
}

// =========================================================================
// READ DESIGN VALUES FROM UI
// =========================================================================

function readDesignValues() {
    var t = _currentTemplate;
    var el = function(id) { return document.getElementById(id); };

    t.headerEnabled = !!el('pc-header-enabled')?.checked;
    t.campName = el('pc-camp-name')?.value || '';
    t.customSubtitle = el('pc-custom-subtitle')?.value || '';
    t.showDate = !!el('pc-show-date')?.checked;
    t.showDivisionName = !!el('pc-show-div-name')?.checked;

    // View options
    t.tableOrientation = el('pc-transpose')?.checked ? 'time-top' : 'bunks-top';
    t.hideLeagueMatchups = !!el('pc-hide-matchups')?.checked;
    t.layoutMode = el('pc-combined')?.checked ? 'all-bunks' : 'per-division';

    // Advanced (only read if present)
    if (el('pc-header-bg')) t.headerBgColor = el('pc-header-bg').value;
    if (el('pc-header-text')) t.headerTextColor = el('pc-header-text').value;
    if (el('pc-header-font')) t.headerFont = el('pc-header-font').value;
    if (el('pc-header-font-size')) t.headerFontSize = parseInt(el('pc-header-font-size').value) || t.headerFontSize;
    if (el('pc-grid-font')) t.gridFont = el('pc-grid-font').value;
    if (el('pc-grid-font-size')) t.gridFontSize = parseInt(el('pc-grid-font-size').value) || t.gridFontSize;
    if (el('pc-grid-header-bg')) t.gridHeaderBgColor = el('pc-grid-header-bg').value;
    if (el('pc-grid-header-text')) t.gridHeaderTextColor = el('pc-grid-header-text').value;
    if (el('pc-grid-border-color')) t.gridBorderColor = el('pc-grid-border-color').value;
    if (el('pc-grid-border-width')) t.gridBorderWidth = parseInt(el('pc-grid-border-width').value) || 1;
    if (el('pc-grid-row-color')) t.gridRowColor = el('pc-grid-row-color').value;
    if (el('pc-grid-row-alt')) t.gridRowAltColor = el('pc-grid-row-alt').value;
    if (el('pc-cell-padding')) t.cellPadding = parseInt(el('pc-cell-padding').value) || 8;
    if (el('pc-general-bg')) t.generalBgColor = el('pc-general-bg').value;
    if (el('pc-general-text')) t.generalTextColor = el('pc-general-text').value;
    if (el('pc-pinned-bg')) t.pinnedBgColor = el('pc-pinned-bg').value;
    if (el('pc-pinned-text')) t.pinnedTextColor = el('pc-pinned-text').value;
    if (el('pc-league-bg')) t.leagueBgColor = el('pc-league-bg').value;
    if (el('pc-league-text')) t.leagueTextColor = el('pc-league-text').value;
    if (el('pc-free-bg')) t.freeBgColor = el('pc-free-bg').value;
    if (el('pc-free-text')) t.freeTextColor = el('pc-free-text').value;
    if (el('pc-time-bg')) t.timeColBgColor = el('pc-time-bg').value;
    if (el('pc-time-text')) t.timeColTextColor = el('pc-time-text').value;
    if (el('pc-time-width')) t.timeColWidth = parseInt(el('pc-time-width').value) || 130;
    if (el('pc-time-bold')) t.timeColBold = !!el('pc-time-bold').checked;
    if (el('pc-orientation')) t.orientation = el('pc-orientation').value;
    if (el('pc-paper-size')) t.paperSize = el('pc-paper-size').value;
    if (el('pc-page-breaks')) t.showPageBreaks = !!el('pc-page-breaks').checked;
    if (el('pc-watermark-enabled')) t.watermarkEnabled = !!el('pc-watermark-enabled').checked;
    if (el('pc-watermark-text')) t.watermarkText = el('pc-watermark-text').value;
    if (el('pc-watermark-color')) t.watermarkColor = el('pc-watermark-color').value;
    if (el('pc-watermark-opacity')) t.watermarkOpacity = parseFloat(el('pc-watermark-opacity').value) || 0.08;
    if (el('pc-footer-enabled')) t.footerEnabled = !!el('pc-footer-enabled').checked;
    if (el('pc-footer-text')) t.footerText = el('pc-footer-text').value;
}

function renderTemplateDropdown() {
    var select = document.getElementById('pc-template-select');
    if (!select) return;
    var currentId = _currentTemplate.id || 'default';
    var html = '<option value="default"' + (currentId === 'default' ? ' selected' : '') + '>Default</option>';
    _savedTemplates.forEach(function(tpl) { html += '<option value="' + tpl.id + '"' + (currentId === tpl.id ? ' selected' : '') + '>' + escHtml(tpl.name) + '</option>'; });
    select.innerHTML = html;
    var isCustom = currentId !== 'default';
    var updateBtn = document.getElementById('pc-btn-update-tpl');
    var deleteBtn = document.getElementById('pc-btn-delete-tpl');
    if (updateBtn) updateBtn.style.display = isCustom && canEditTemplates() ? 'inline-block' : 'none';
    if (deleteBtn) deleteBtn.style.display = isCustom && canEditTemplates() ? 'inline-block' : 'none';
}

// =========================================================================
// STYLED HTML BUILDERS
// =========================================================================

function buildStyledHeader(titleText) {
    var t = _currentTemplate;
    if (!t.headerEnabled) return '';
    var h = '<div style="background:' + t.headerBgColor + '; color:' + t.headerTextColor + '; font-family:\'' + t.headerFont + '\',sans-serif; padding:14px 20px; display:flex; align-items:center; gap:14px;">';
    if (t.campLogo) h += '<img src="' + t.campLogo + '" style="height:' + (t.headerFontSize + 16) + 'px; max-width:120px; object-fit:contain; border-radius:4px;" alt="Logo">';
    h += '<div style="flex:1;">';
    if (t.campName) h += '<div style="font-size:' + t.headerFontSize + 'px; font-weight:700; letter-spacing:-0.02em;">' + escHtml(t.campName) + '</div>';
    if (t.showDivisionName && titleText) h += '<div style="font-size:' + Math.max(12, t.headerFontSize - 6) + 'px; opacity:0.9; margin-top:2px;">' + escHtml(titleText) + '</div>';
    if (t.customSubtitle) h += '<div style="font-size:' + Math.max(10, t.headerFontSize - 10) + 'px; opacity:0.75; margin-top:2px;">' + escHtml(t.customSubtitle) + '</div>';
    h += '</div>';
    if (t.showDate) h += '<div style="font-size:' + Math.max(11, t.headerFontSize - 8) + 'px; opacity:0.85; text-align:right; white-space:nowrap;">' + formatDisplayDate(window.currentScheduleDate) + '</div>';
    h += '</div>';
    return h;
}

function buildStyledFooter() {
    var t = _currentTemplate;
    if (!t.footerEnabled || !t.footerText) return '';
    return '<div style="font-family:\'' + t.footerFont + '\',sans-serif; font-size:' + t.footerFontSize + 'px; color:#94A3B8; text-align:center; padding:8px 16px; border-top:1px solid ' + t.gridBorderColor + ';">' + escHtml(t.footerText) + '</div>';
}

function buildWatermark() {
    var t = _currentTemplate;
    if (!t.watermarkEnabled || !t.watermarkText) return '';
    return '<div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-35deg); font-size:72px; font-weight:900; color:' + t.watermarkColor + '; opacity:' + t.watermarkOpacity + '; pointer-events:none; white-space:nowrap; z-index:1; letter-spacing:0.1em;">' + escHtml(t.watermarkText) + '</div>';
}

function cellStyle(type, isAltRow) {
    var t = _currentTemplate;
    var bg, color;
    switch (type) {
        case 'pinned': bg = t.pinnedBgColor; color = t.pinnedTextColor; break;
        case 'league': bg = t.leagueBgColor; color = t.leagueTextColor; break;
        case 'free':   bg = t.freeBgColor;   color = t.freeTextColor;   break;
        default:       bg = isAltRow ? t.gridRowAltColor : t.gridRowColor; color = t.generalTextColor;
    }
    return 'background:' + bg + '; color:' + color + '; padding:' + t.cellPadding + 'px; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px; border:' + t.gridBorderWidth + 'px solid ' + t.gridBorderColor + ';';
}

function timeStyle() {
    var t = _currentTemplate;
    return 'background:' + t.timeColBgColor + '; color:' + t.timeColTextColor + '; font-family:\'' + (t.timeColFont || t.gridFont) + '\',sans-serif; font-size:' + (t.timeColFontSize || t.gridFontSize) + 'px; font-weight:' + (t.timeColBold ? '700' : '400') + '; padding:' + t.cellPadding + 'px; border:' + t.gridBorderWidth + 'px solid ' + t.gridBorderColor + '; width:' + t.timeColWidth + 'px; white-space:nowrap;';
}

function headerCellStyle() {
    var t = _currentTemplate;
    return 'background:' + t.gridHeaderBgColor + '; color:' + t.gridHeaderTextColor + '; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px; font-weight:600; padding:' + t.cellPadding + 'px; border:' + t.gridBorderWidth + 'px solid ' + t.gridBorderColor + ';';
}

// =========================================================================
// BUILD DIVISION BLOCKS (shared)
// =========================================================================

function buildDivisionBlocks(divName) {
    var skeleton = getSkeleton();
    var tempSorted = [];
    skeleton.forEach(function(item) {
        if (item.division === divName) {
            var startMin = parseTimeToMinutes(item.startTime);
            var endMin = parseTimeToMinutes(item.endTime);
            if (startMin !== null && endMin !== null) tempSorted.push({ item: item, startMin: startMin, endMin: endMin });
        }
    });
    tempSorted.sort(function(a, b) { return a.startMin - b.startMin; });

    var blocks = [];
    var leagueCounter = 0, specialtyCounter = 0;
    tempSorted.forEach(function(block) {
        var eventName = block.item.event;
        if (block.item.event === "League Game") { leagueCounter++; eventName = "League Game " + leagueCounter; }
        else if (block.item.event === "Specialty League") { specialtyCounter++; eventName = "Specialty League " + specialtyCounter; }
        blocks.push({ label: minutesToTimeLabel(block.startMin) + ' - ' + minutesToTimeLabel(block.endMin), startMin: block.startMin, endMin: block.endMin, event: eventName, type: block.item.type });
    });

    var unique = blocks.filter(function(b, i, self) { return i === self.findIndex(function(t2) { return t2.label === b.label; }); });
    var flat = [];
    unique.forEach(function(block) {
        if (block.type === "split" && block.startMin !== null && block.endMin !== null) {
            var mid = Math.round(block.startMin + (block.endMin - block.startMin) / 2);
            flat.push({ label: minutesToTimeLabel(block.startMin) + ' - ' + minutesToTimeLabel(mid), startMin: block.startMin, endMin: mid, event: block.event, type: block.type, splitPart: 1 });
            flat.push({ label: minutesToTimeLabel(mid) + ' - ' + minutesToTimeLabel(block.endMin), startMin: mid, endMin: block.endMin, event: block.event, type: block.type, splitPart: 2 });
        } else {
            flat.push(block);
        }
    });
    return flat;
}

// =========================================================================
// CELL CONTENT (respects hideLeagueMatchups)
// =========================================================================

function getCellContent(entry, divName, eventBlock) {
    if (!entry) return { html: '', type: 'free' };
    var t = _currentTemplate;
    var type = 'general';
    var label = '';

    if (entry._fixed) {
        type = 'pinned';
        label = escHtml(formatEntry(entry));
    } else if (entry._h2h) {
        type = 'league';
        if (t.hideLeagueMatchups) {
            // ★ Just show "League Game N" — no matchup details
            label = '<strong>' + escHtml(eventBlock?.event || entry.sport || 'League Game') + '</strong>';
        } else {
            if (entry._allMatchups && entry._allMatchups.length > 0) {
                label = '<strong>' + escHtml(entry.sport || 'League Game') + '</strong>';
                label += '<ul style="margin:3px 0 0 14px; padding:0; font-size:0.85em; list-style:disc;">';
                entry._allMatchups.forEach(function(m) { label += '<li>' + escHtml(m) + '</li>'; });
                label += '</ul>';
            } else {
                label = '<strong>' + escHtml(entry.sport || 'League Game') + '</strong>';
            }
        }
    } else {
        label = escHtml(formatEntry(entry));
        if (!label) { type = 'free'; label = '—'; }
    }
    return { html: label, type: type };
}

// =========================================================================
// DIVISION HTML — BUNKS ON TOP (default)
// =========================================================================

function generateDivisionHTML_bunksTop(divName) {
    var t = _currentTemplate;
    var divisions = getDivisions();
    var bunks = (divisions[divName]?.bunks || []).sort(naturalSort);
    if (bunks.length === 0) return "";

    var flatBlocks = buildDivisionBlocks(divName);

    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks ? 'always' : 'auto') + '; margin-bottom:24px;">';
    html += buildWatermark();
    html += buildStyledHeader(divName);

    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';
    html += '<thead><tr><th style="' + headerCellStyle() + ' width:' + t.timeColWidth + 'px;">Time</th>';
    bunks.forEach(function(b) { html += '<th style="' + headerCellStyle() + '">' + escHtml(b) + '</th>'; });
    html += '</tr></thead><tbody>';

    if (flatBlocks.length === 0) {
        html += '<tr><td colspan="' + (bunks.length + 1) + '" style="text-align:center; padding:20px; color:#94A3B8;">No schedule blocks found for this date.</td></tr>';
    }

    flatBlocks.forEach(function(eventBlock, rowIdx) {
        var isAlt = rowIdx % 2 === 1;
        html += '<tr><td style="' + timeStyle() + '">' + eventBlock.label + '</td>';
        var isLeague = eventBlock.event.indexOf("League Game") === 0 || eventBlock.event.indexOf("Specialty League") === 0;

        bunks.forEach(function(b) {
            var slotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
            var entry = slotIndex >= 0 ? getEntry(b, slotIndex) : null;
            // Attach all matchups from first bunk for league display
            if (isLeague && entry && entry._h2h) {
                var firstEntry = getEntry(bunks[0], slotIndex);
                if (firstEntry && firstEntry._allMatchups) entry = Object.assign({}, entry, { _allMatchups: firstEntry._allMatchups });
            }
            var cell = getCellContent(entry, divName, eventBlock);
            html += '<td style="' + cellStyle(cell.type, isAlt) + '">' + cell.html + '</td>';
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    html += buildStyledFooter();
    html += '</div>';
    return html;
}

// =========================================================================
// DIVISION HTML — TIME ON TOP (transposed)
// =========================================================================

function generateDivisionHTML_timeTop(divName) {
    var t = _currentTemplate;
    var divisions = getDivisions();
    var bunks = (divisions[divName]?.bunks || []).sort(naturalSort);
    if (bunks.length === 0) return "";

    var flatBlocks = buildDivisionBlocks(divName);

    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks ? 'always' : 'auto') + '; margin-bottom:24px;">';
    html += buildWatermark();
    html += buildStyledHeader(divName);

    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';
    // Header row = time slots
    html += '<thead><tr><th style="' + headerCellStyle() + '">Bunk</th>';
    flatBlocks.forEach(function(block) { html += '<th style="' + headerCellStyle() + ' white-space:nowrap; font-size:' + Math.max(8, t.gridFontSize - 1) + 'px;">' + block.label + '</th>'; });
    html += '</tr></thead><tbody>';

    if (flatBlocks.length === 0) {
        html += '<tr><td style="text-align:center; padding:20px; color:#94A3B8;">No schedule blocks found.</td></tr>';
    }

    // Each row = one bunk
    bunks.forEach(function(b, bunkIdx) {
        var isAlt = bunkIdx % 2 === 1;
        html += '<tr><td style="' + timeStyle() + '">' + escHtml(b) + '</td>';
        flatBlocks.forEach(function(eventBlock) {
            var slotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
            var entry = slotIndex >= 0 ? getEntry(b, slotIndex) : null;
            var cell = getCellContent(entry, divName, eventBlock);
            html += '<td style="' + cellStyle(cell.type, isAlt) + '">' + cell.html + '</td>';
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    html += buildStyledFooter();
    html += '</div>';
    return html;
}

// =========================================================================
// COMBINED ALL-BUNKS VIEW (one wide table, all selected divisions)
// =========================================================================

function generateCombinedHTML(selectedDivisions) {
    var t = _currentTemplate;
    var divisions = getDivisions();
    var allBunks = [];
    var divForBunk = {};
    selectedDivisions.forEach(function(divName) {
        var bunks = (divisions[divName]?.bunks || []).sort(naturalSort);
        bunks.forEach(function(b) { allBunks.push(b); divForBunk[b] = divName; });
    });
    if (allBunks.length === 0) return "";

    // Use first division's blocks as the time structure
    var flatBlocks = buildDivisionBlocks(selectedDivisions[0]);

    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks ? 'always' : 'auto') + '; margin-bottom:24px;">';
    html += buildWatermark();
    html += buildStyledHeader('All Divisions');

    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';

    if (t.tableOrientation === 'time-top') {
        // Transposed: bunks down, time across
        html += '<thead><tr><th style="' + headerCellStyle() + '">Bunk</th>';
        flatBlocks.forEach(function(block) { html += '<th style="' + headerCellStyle() + ' white-space:nowrap; font-size:' + Math.max(8, t.gridFontSize - 1) + 'px;">' + block.label + '</th>'; });
        html += '</tr></thead><tbody>';

        var lastDiv = '';
        allBunks.forEach(function(b, idx) {
            var div = divForBunk[b];
            if (div !== lastDiv) {
                html += '<tr><td colspan="' + (flatBlocks.length + 1) + '" style="background:' + t.gridHeaderBgColor + '; color:' + t.gridHeaderTextColor + '; font-weight:700; padding:6px ' + t.cellPadding + 'px; font-size:' + t.gridFontSize + 'px; border:' + t.gridBorderWidth + 'px solid ' + t.gridBorderColor + ';">📋 ' + escHtml(div) + '</td></tr>';
                lastDiv = div;
            }
            var isAlt = idx % 2 === 1;
            html += '<tr><td style="' + timeStyle() + '">' + escHtml(b) + '</td>';
            var bunkBlocks = buildDivisionBlocks(div);
            (bunkBlocks.length > 0 ? bunkBlocks : flatBlocks).forEach(function(eb) {
                var si = findFirstSlotForTime(eb.startMin, div);
                var entry = si >= 0 ? getEntry(b, si) : null;
                var cell = getCellContent(entry, div, eb);
                html += '<td style="' + cellStyle(cell.type, isAlt) + '">' + cell.html + '</td>';
            });
            html += '</tr>';
        });
    } else {
        // Normal: time down, bunks across
        html += '<thead><tr><th style="' + headerCellStyle() + ' width:' + t.timeColWidth + 'px;">Time</th>';
        allBunks.forEach(function(b) { html += '<th style="' + headerCellStyle() + ' font-size:' + Math.max(8, t.gridFontSize - 1) + 'px;">' + escHtml(b) + '</th>'; });
        html += '</tr></thead><tbody>';

        flatBlocks.forEach(function(eventBlock, rowIdx) {
            var isAlt = rowIdx % 2 === 1;
            html += '<tr><td style="' + timeStyle() + '">' + eventBlock.label + '</td>';
            allBunks.forEach(function(b) {
                var div = divForBunk[b];
                var si = findFirstSlotForTime(eventBlock.startMin, div);
                var entry = si >= 0 ? getEntry(b, si) : null;
                var cell = getCellContent(entry, div, eventBlock);
                html += '<td style="' + cellStyle(cell.type, isAlt) + '">' + cell.html + '</td>';
            });
            html += '</tr>';
        });
    }

    html += '</tbody></table>';
    html += buildStyledFooter();
    html += '</div>';
    return html;
}

// =========================================================================
// BUNK HTML GENERATOR
// =========================================================================

function generateStyledBunkHTML(bunk) {
    var t = _currentTemplate;
    var allAssignments = getAssignments();
    var schedule = allAssignments[bunk] || [];
    var divName = null;
    var divisions = getDivisions();
    for (var dName in divisions) {
        if (divisions[dName].bunks && divisions[dName].bunks.includes(bunk)) { divName = dName; break; }
    }
    var times = (divName && window.divisionTimes?.[divName]) || window.unifiedTimes || [];

    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks ? 'always' : 'auto') + '; margin-bottom:24px;">';
    html += buildWatermark();
    html += buildStyledHeader(bunk + (divName ? ' (' + divName + ')' : ''));

    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';
    html += '<thead><tr><th style="' + headerCellStyle() + ' width:' + t.timeColWidth + 'px;">Time</th><th style="' + headerCellStyle() + '">Activity / Location</th></tr></thead><tbody>';

    times.forEach(function(slot, i) {
        var entry = schedule[i];
        if (!entry || entry.continuation) return;
        var isAlt = i % 2 === 1;
        var cell = getCellContent(entry, divName, null);
        if (cell.type === 'general' && !cell.html) cell.html = escHtml(formatEntry(entry));
        var timeLabel = slot.label || (minutesToTimeLabel(slot.startMin || 0) + ' - ' + minutesToTimeLabel(slot.endMin || 0));
        html += '<tr><td style="' + timeStyle() + '">' + timeLabel + '</td><td style="' + cellStyle(cell.type, isAlt) + '">' + cell.html + '</td></tr>';
    });

    if (times.length === 0) html += '<tr><td colspan="2" style="text-align:center; padding:20px; color:#94A3B8;">No schedule data found.</td></tr>';

    html += '</tbody></table>';
    html += buildStyledFooter();
    html += '</div>';
    return html;
}

// =========================================================================
// LOCATION HTML GENERATOR
// =========================================================================

function generateStyledLocationHTML(loc) {
    var t = _currentTemplate;
    var times = window.unifiedTimes || [];
    var assignments = getAssignments();

    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks ? 'always' : 'auto') + '; margin-bottom:24px;">';
    html += buildWatermark();
    html += buildStyledHeader(loc + ' Schedule');

    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';
    html += '<thead><tr><th style="' + headerCellStyle() + ' width:' + t.timeColWidth + 'px;">Time</th><th style="' + headerCellStyle() + '">Event / Bunks</th></tr></thead><tbody>';

    times.forEach(function(slot, i) {
        var isAlt = i % 2 === 1;
        var bunksAtLoc = [];
        Object.entries(assignments).forEach(function(pair) {
            var bunk = pair[0], slots = pair[1];
            var entry = slots?.[i];
            if (!entry || entry.continuation) return;
            var fieldName = '';
            if (typeof entry.field === 'string') fieldName = entry.field;
            else if (entry.field?.name) fieldName = entry.field.name;
            if (fieldName === loc) bunksAtLoc.push(bunk);
        });
        if (bunksAtLoc.length === 0) return;
        var timeLabel = slot.label || (minutesToTimeLabel(slot.startMin || 0) + ' - ' + minutesToTimeLabel(slot.endMin || 0));
        html += '<tr><td style="' + timeStyle() + '">' + timeLabel + '</td><td style="' + cellStyle('general', isAlt) + '">' + bunksAtLoc.sort(naturalSort).map(function(b){return escHtml(b);}).join(', ') + '</td></tr>';
    });

    html += '</tbody></table>';
    html += buildStyledFooter();
    html += '</div>';
    return html;
}

// =========================================================================
// LIVE REFRESH — real-time preview
// =========================================================================

function liveRefresh() {
    var selected = getSelectedItems();
    var previewContent = document.getElementById('pc-preview-content');
    var previewEmpty = document.getElementById('pc-preview-empty');
    if (!previewContent) return;

    if (selected.length === 0) {
        previewContent.style.display = 'none';
        if (previewEmpty) previewEmpty.style.display = 'flex';
        return;
    }
    previewContent.style.display = 'block';
    if (previewEmpty) previewEmpty.style.display = 'none';

    var t = _currentTemplate;
    var html = '';

    if (_activeView === 'division') {
        if (t.layoutMode === 'all-bunks') {
            html = generateCombinedHTML(selected);
        } else {
            selected.forEach(function(div) {
                html += t.tableOrientation === 'time-top' ? generateDivisionHTML_timeTop(div) : generateDivisionHTML_bunksTop(div);
            });
        }
    } else if (_activeView === 'bunk') {
        selected.forEach(function(bunk) { html += generateStyledBunkHTML(bunk); });
    } else if (_activeView === 'location') {
        selected.forEach(function(loc) { html += generateStyledLocationHTML(loc); });
    }

    if (!html) html = '<div style="text-align:center; padding:40px; color:#94A3B8;">No schedule data found. Generate a schedule first.</div>';

    previewContent.innerHTML = html;
    _previewHtml = html;
    previewContent.style.transform = 'scale(' + (_zoomLevel / 100) + ')';
    previewContent.style.transformOrigin = 'top left';
}

// =========================================================================
// PRINT & EXPORT
// =========================================================================

function triggerPrint() {
    var selected = getSelectedItems();
    if (selected.length === 0) return alert("Select at least one item to print.");
    readDesignValues();

    var html = '';
    var t = _currentTemplate;
    if (_activeView === 'division') {
        if (t.layoutMode === 'all-bunks') html = generateCombinedHTML(selected);
        else selected.forEach(function(div) { html += t.tableOrientation === 'time-top' ? generateDivisionHTML_timeTop(div) : generateDivisionHTML_bunksTop(div); });
    } else if (_activeView === 'bunk') {
        selected.forEach(function(bunk) { html += generateStyledBunkHTML(bunk); });
    } else if (_activeView === 'location') {
        selected.forEach(function(loc) { html += generateStyledLocationHTML(loc); });
    }

    var area = document.getElementById("printable-area");
    if (!area) return;
    area.innerHTML = html;

    var printStyle = document.getElementById('pc-print-style') || document.createElement('style');
    printStyle.id = 'pc-print-style';
    printStyle.textContent = '@media print { @page { size:' + t.paperSize + ' ' + t.orientation + '; margin:0.5in; } body * { visibility:hidden; } #printable-area, #printable-area * { visibility:visible; } #printable-area { display:block !important; position:absolute; left:0; top:0; width:100%; } .pc-print-page { page-break-inside:avoid; } .no-print { display:none !important; } }';
    if (!document.getElementById('pc-print-style')) document.head.appendChild(printStyle);
    window.print();
}

function exportExcel() {
    var selected = getSelectedItems();
    if (selected.length === 0) return alert("Select at least one item to export.");
    readDesignValues();

    var html = '';
    if (_activeView === 'division') {
        if (_currentTemplate.layoutMode === 'all-bunks') html = generateCombinedHTML(selected);
        else selected.forEach(function(div) { html += generateDivisionHTML_bunksTop(div); });
    } else if (_activeView === 'bunk') {
        selected.forEach(function(bunk) { html += generateStyledBunkHTML(bunk); });
    } else if (_activeView === 'location') {
        selected.forEach(function(loc) { html += generateStyledLocationHTML(loc); });
    }

    var blob = new Blob(['<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>' + html + '</body></html>'], { type: 'application/vnd.ms-excel' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Schedule_' + _activeView + '_' + (window.currentScheduleDate || 'export') + '.xls';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// =========================================================================
// LOGO
// =========================================================================

function handleLogoUpload(input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    if (file.size > 2 * 1024 * 1024) { alert("Logo must be under 2MB."); return; }
    var reader = new FileReader();
    reader.onload = function(e) {
        _currentTemplate.campLogo = e.target.result;
        rebuildQuickBar();
        liveRefresh();
    };
    reader.readAsDataURL(file);
}

function removeLogo() {
    _currentTemplate.campLogo = null;
    rebuildQuickBar();
    liveRefresh();
}

function rebuildQuickBar() {
    var old = document.querySelector('.pc-quick');
    if (!old) return;
    old.outerHTML = buildQuickSettings();
    var debouncedLive = debounce(function() { readDesignValues(); liveRefresh(); }, 200);
    document.querySelectorAll('.pc-quick input, .pc-quick select').forEach(function(el) {
        el.addEventListener('input', debouncedLive);
        el.addEventListener('change', function() { readDesignValues(); liveRefresh(); });
    });
    renderTemplateDropdown();
}

// =========================================================================
// GLOBAL WINDOW BINDINGS
// =========================================================================

window._pcToggleAdvanced = function() {
    _advancedOpen = !_advancedOpen;
    var drawer = document.getElementById('pc-advanced-drawer');
    if (drawer) drawer.classList.toggle('open', _advancedOpen);
};

window._pcZoom = function(delta) {
    _zoomLevel = Math.max(30, Math.min(200, _zoomLevel + delta));
    var label = document.getElementById('pc-zoom-label');
    if (label) label.textContent = _zoomLevel + '%';
    var content = document.getElementById('pc-preview-content');
    if (content) { content.style.transform = 'scale(' + (_zoomLevel / 100) + ')'; content.style.transformOrigin = 'top left'; }
};

window._pcSelectAll = function() {
    document.querySelectorAll('.pc-item-cb').forEach(function(cb) { cb.checked = true; });
    liveRefresh();
};

window._pcDeselectAll = function() {
    document.querySelectorAll('.pc-item-cb').forEach(function(cb) { cb.checked = false; });
    liveRefresh();
};

window._pcPrint = triggerPrint;
window._pcExportExcel = exportExcel;
window._pcHandleLogo = handleLogoUpload;
window._pcRemoveLogo = removeLogo;

window._pcLoadTemplate = function(templateId) {
    loadTemplate(templateId);
    localStorage.setItem('campistry_last_print_template', templateId);
};

window._pcSaveAsTemplate = function() {
    if (!canEditTemplates()) { alert('Only owners and admins can save templates.'); return; }
    var name = prompt('Template name:', 'My Custom Template');
    if (!name) return;
    readDesignValues();
    var tpl = saveCurrentAsTemplate(name);
    if (tpl) { _currentTemplate.id = tpl.id; renderTemplateDropdown(); localStorage.setItem('campistry_last_print_template', tpl.id); if (typeof window.showToast === 'function') window.showToast('Template saved!', 'success'); }
};

window._pcUpdateTemplate = function() {
    if (!canEditTemplates()) return;
    var currentId = _currentTemplate.id;
    if (!currentId || currentId === 'default') return;
    readDesignValues();
    if (updateTemplate(currentId)) { if (typeof window.showToast === 'function') window.showToast('Template updated!', 'success'); }
};

window._pcDeleteTemplate = function() {
    if (!canEditTemplates()) return;
    var currentId = _currentTemplate.id;
    if (!currentId || currentId === 'default') return;
    if (!confirm('Delete this template?')) return;
    deleteTemplate(currentId);
    _currentTemplate = { ...DEFAULT_TEMPLATE };
    renderTemplateDropdown();
    localStorage.setItem('campistry_last_print_template', 'default');
    liveRefresh();
    if (typeof window.showToast === 'function') window.showToast('Template deleted.', 'info');
};

window._pcResetToDefault = function() {
    _currentTemplate = { ...DEFAULT_TEMPLATE };
    initPrintCenter();
};

// Legacy compatibility
window.printAllDivisions = function() { _activeView = 'division'; populateSelectors(); window._pcSelectAll(); readDesignValues(); triggerPrint(); };
window.exportAllDivisionsToExcel = function() { _activeView = 'division'; populateSelectors(); window._pcSelectAll(); readDesignValues(); exportExcel(); };

window.initPrintCenter = initPrintCenter;

})();
