// =================================================================
// print_center.js v3.6 — Visual Schedule Designer
// =================================================================
// v3.6 CHANGES:
// - League games: merged cell spanning all bunks with matchups
// - Hide matchups: shows "League Game N" (still shows the row)
// - Combined mode: each division has own time grid, equal heights
// - Horizontal scroll with arrow buttons
// - Fullscreen toggle
// - Professional SVG icons (no emojis in UI)
// - Fixed advanced drawer close button centering
// - System-matching header font/style
// =================================================================

(function() {
'use strict';

var VERSION = '3.6.0';
console.log('[PrintCenter] v' + VERSION + ' loading');

// --- SVG ICONS (inline, 16x16) ---
var ICO = {
    print: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
    excel: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/></svg>',
    gear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
    expand: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>',
    shrink: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>',
    transpose: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4"/><path d="M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>',
    eyeOff: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    grid: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    calendar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    user: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    mapPin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    save: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
    refresh: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
    trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
    chevL: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    chevR: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
};

// --- CONSTANTS ---
var INCREMENT_MINS = 30;
var DEFAULT_TEMPLATE = {
    id: 'default', name: 'Default Template', isDefault: true,
    headerEnabled: true, campName: '', campLogo: null,
    headerBgColor: '#147D91', headerTextColor: '#FFFFFF',
    headerFont: 'Inter', headerFontSize: 22,
    showDate: true, showDivisionName: true, customSubtitle: '',
    gridFont: 'Inter', gridFontSize: 11,
    gridHeaderBgColor: '#F1F5F9', gridHeaderTextColor: '#0F172A',
    gridBorderColor: '#CBD5E1', gridBorderWidth: 1,
    gridRowAltColor: '#F8FAFC', gridRowColor: '#FFFFFF', cellPadding: 8,
    pinnedBgColor: '#FFF8E1', pinnedTextColor: '#92400E',
    leagueBgColor: '#EBF5FF', leagueTextColor: '#1E40AF',
    generalBgColor: '#FFFFFF', generalTextColor: '#1E293B',
    freeBgColor: '#F9FAFB', freeTextColor: '#9CA3AF',
    timeColWidth: 120, timeColBgColor: '#F8FAFC', timeColTextColor: '#475569',
    timeColFont: 'Inter', timeColFontSize: 11, timeColBold: true,
    orientation: 'landscape', paperSize: 'letter', padding: 20, showPageBreaks: true,
    tableOrientation: 'bunks-top', hideLeagueMatchups: false, layoutMode: 'per-division',
    watermarkEnabled: false, watermarkText: '', watermarkOpacity: 0.08, watermarkColor: '#000000',
    footerEnabled: false, footerText: '', footerFont: 'Inter', footerFontSize: 9,
};

// --- STATE ---
var _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE);
var _savedTemplates = [];
var _activeView = 'division';
var _previewHtml = '';
var _advancedOpen = false;
var _zoomLevel = 85;
var _isFullscreen = false;
var _cloudSyncTimeout = null;
var CLOUD_SYNC_DEBOUNCE = 800;

// =========================================================================
// UTILITIES
// =========================================================================

function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    var s = str.trim().toLowerCase();
    var mer = null;
    if (s.endsWith("am") || s.endsWith("pm")) { mer = s.slice(-2); s = s.slice(0, -2).trim(); }
    var m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    if (mer) { if (hh === 12) hh = mer === "am" ? 0 : 12; else if (mer === "pm") hh += 12; }
    return hh * 60 + mm;
}

function minutesToTimeLabel(min) {
    var h = Math.floor(min / 60), m = min % 60;
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
}

function findFirstSlotForTime(startMin, divName) {
    var times;
    if (divName && window.divisionTimes && window.divisionTimes[divName]) {
        times = window.divisionTimes[divName];
    } else {
        times = window.unifiedTimes || [];
    }
    if (startMin === null || !times.length) return -1;
    for (var i = 0; i < times.length; i++) {
        var slot = times[i];
        var slotStart = slot.startMin !== undefined ? slot.startMin : (new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes());
        if (slotStart >= startMin && slotStart < startMin + INCREMENT_MINS) return i;
    }
    return -1;
}

function getEntry(bunk, slotIndex) {
    var a = window.scheduleAssignments || (window.loadCurrentDailyData ? window.loadCurrentDailyData() : {}).scheduleAssignments || {};
    return (bunk && a[bunk] && a[bunk][slotIndex]) ? a[bunk][slotIndex] : null;
}

function formatEntry(entry) {
    if (!entry) return "";
    if (entry._isDismissal) return "Dismissal";
    if (entry._isSnack) return "Snacks";
    var label = "";
    if (typeof entry.field === 'string') label = entry.field;
    else if (entry.field && entry.field.name) label = entry.field.name;
    if (entry._h2h) return entry.sport || "League Game";
    if (entry._fixed) return label || entry._activity || "";
    if (entry.sport) return label + ' \u2013 ' + entry.sport;
    return label;
}

function naturalSort(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function debounce(fn, ms) { var t; return function() { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function(){ fn.apply(c, a); }, ms); }; }

function fontOptions(selected) {
    var fonts = ['Inter','Arial','Helvetica','Georgia','Times New Roman','Courier New','Verdana','Trebuchet MS','Palatino','Garamond'];
    return fonts.map(function(f) { return '<option value="' + f + '"' + (f === selected ? ' selected' : '') + '>' + f + '</option>'; }).join('');
}

function formatDisplayDate(dateStr) {
    if (!dateStr) return '';
    try { var d = new Date(dateStr + 'T12:00:00'); return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return dateStr; }
}

// =========================================================================
// DATA HELPERS — full fallback chains
// =========================================================================

function getSkeleton() {
    var daily = (window.loadCurrentDailyData ? window.loadCurrentDailyData() : null) || {};
    var sk = daily.manualSkeleton || daily.skeleton || window.dailyOverrideSkeleton || window.manualSkeleton || window.skeleton || [];
    if (!sk.length) { try { var dk = window.currentScheduleDate; var s = dk ? localStorage.getItem('campManualSkeleton_' + dk) : null; if (s) sk = JSON.parse(s) || []; } catch(e){} }
    if (!sk.length) { try { var dk2 = window.currentScheduleDate; var ms = window.loadGlobalSettings ? window.loadGlobalSettings() : null; var c = ms && ms.app1 && ms.app1.dailySkeletons ? ms.app1.dailySkeletons[dk2] : null; if (c && c.length) sk = c; } catch(e){} }
    return sk;
}
function getDivisions() { return window.divisions || (window.loadGlobalSettings ? (window.loadGlobalSettings().app1 || {}).divisions : null) || {}; }
function getAvailableDivisions() { var a1 = (window.loadGlobalSettings ? window.loadGlobalSettings().app1 : null) || {}; return window.availableDivisions || a1.availableDivisions || Object.keys(getDivisions()); }
function getAssignments() { return window.scheduleAssignments || ((window.loadCurrentDailyData ? window.loadCurrentDailyData() : {}).scheduleAssignments) || {}; }

// =========================================================================
// TEMPLATE PERSISTENCE
// =========================================================================

function loadTemplates() {
    try { var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {}; if (g.printTemplates && g.printTemplates.length) { _savedTemplates = g.printTemplates; return; } var r = localStorage.getItem('campistry_print_templates'); if (r) { _savedTemplates = JSON.parse(r); return; } } catch(e){} _savedTemplates = [];
}
function saveTemplates() {
    if (!canEditTemplates()) return false;
    try { localStorage.setItem('campistry_print_templates', JSON.stringify(_savedTemplates)); if (window.saveGlobalSettings) window.saveGlobalSettings("printTemplates", _savedTemplates); clearTimeout(_cloudSyncTimeout); _cloudSyncTimeout = setTimeout(function(){ if (window.forceSyncToCloud) window.forceSyncToCloud(); }, CLOUD_SYNC_DEBOUNCE); return true; } catch(e){ return false; }
}
function saveCurrentAsTemplate(name) {
    if (!canEditTemplates()) return false;
    var tpl = JSON.parse(JSON.stringify(_currentTemplate)); tpl.id = 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); tpl.name = name || 'Untitled'; tpl.isDefault = false; tpl.createdAt = new Date().toISOString(); tpl.updatedAt = new Date().toISOString();
    _savedTemplates.push(tpl); saveTemplates(); return tpl;
}
function updateTemplate(tid) { if (!canEditTemplates()) return false; var idx = -1; for (var i=0;i<_savedTemplates.length;i++) { if (_savedTemplates[i].id===tid){idx=i;break;} } if (idx===-1) return false; var t2 = JSON.parse(JSON.stringify(_currentTemplate)); t2.id = tid; t2.name = _savedTemplates[idx].name; t2.isDefault = false; t2.createdAt = _savedTemplates[idx].createdAt; t2.updatedAt = new Date().toISOString(); _savedTemplates[idx] = t2; saveTemplates(); return true; }
function deleteTemplate(tid) { if (!canEditTemplates()) return false; _savedTemplates = _savedTemplates.filter(function(t){return t.id!==tid;}); saveTemplates(); return true; }
function loadTemplate(tid) { if (tid==='default') _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE); else { for (var i=0;i<_savedTemplates.length;i++) { if (_savedTemplates[i].id===tid) { _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE, JSON.parse(JSON.stringify(_savedTemplates[i]))); break; } } } liveRefresh(); renderTemplateDropdown(); }
function canEditTemplates() { if (window.AccessControl && window.AccessControl.isOwner && window.AccessControl.isOwner()) return true; if (window.AccessControl && window.AccessControl.isAdmin && window.AccessControl.isAdmin()) return true; var role = (window.CloudPermissions && window.CloudPermissions.getRole ? window.CloudPermissions.getRole() : '') || (window.CampistryDB && window.CampistryDB.getRole ? window.CampistryDB.getRole() : '') || localStorage.getItem('campistry_role') || 'viewer'; return role==='owner'||role==='admin'; }

// =========================================================================
// INIT
// =========================================================================

function initPrintCenter() {
    var container = document.getElementById("print-content");
    if (!container) return;
    console.log('[PrintCenter] v' + VERSION + ' init');
    loadTemplates();
    var lastId = localStorage.getItem('campistry_last_print_template');
    if (lastId && lastId !== 'default') { for (var i=0;i<_savedTemplates.length;i++) { if (_savedTemplates[i].id===lastId) { _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE, JSON.parse(JSON.stringify(_savedTemplates[i]))); break; } } }
    if (!_currentTemplate.campName) { var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {}; _currentTemplate.campName = g.campName || (g.app1 ? g.app1.campName : '') || ''; }
    container.innerHTML = buildMainUI();
    bindAll();
    populateSelectors();
    document.querySelectorAll('.pc-item-cb').forEach(function(cb){ cb.checked = true; });
    liveRefresh();
}

// =========================================================================
// MAIN UI
// =========================================================================

function buildMainUI() {
    var isEditor = canEditTemplates();
    var t = _currentTemplate;
    return '<div class="pc-container' + (_isFullscreen ? ' pc-fullscreen' : '') + '" id="pc-root">' +
    '<div class="pc-topbar no-print">' +
        '<div class="pc-topbar-left"><h1 class="pc-title">' + ICO.print + ' Print Center</h1></div>' +
        '<div class="pc-topbar-right">' +
            '<button class="pc-btn pc-btn-ghost pc-btn-sm" onclick="window._pcFullscreen()" title="Toggle fullscreen" id="pc-fs-btn">' + ICO.expand + '</button>' +
            (isEditor ? '<button class="pc-btn pc-btn-ghost pc-btn-sm" onclick="window._pcToggleAdvanced()" title="Advanced design settings">' + ICO.gear + ' Advanced</button>' : '') +
            '<button class="pc-btn pc-btn-secondary pc-btn-sm" onclick="window._pcExportExcel()">' + ICO.excel + ' Excel</button>' +
            '<button class="pc-btn pc-btn-primary pc-btn-sm" onclick="window._pcPrint()">' + ICO.print + ' Print</button>' +
        '</div>' +
    '</div>' +
    (isEditor ? buildQuickSettings() : '') +
    '<div class="pc-controls no-print">' +
        '<div class="pc-controls-top">' +
            '<div class="pc-view-tabs">' +
                '<button class="pc-view-tab active" data-view="division">' + ICO.calendar + ' Divisions</button>' +
                '<button class="pc-view-tab" data-view="bunk">' + ICO.user + ' Bunks</button>' +
                '<button class="pc-view-tab" data-view="location">' + ICO.mapPin + ' Locations</button>' +
            '</div>' +
            '<div class="pc-view-options">' +
                '<label class="pc-opt" title="Swap rows and columns"><input type="checkbox" id="pc-transpose"' + (t.tableOrientation === 'time-top' ? ' checked' : '') + '> ' + ICO.transpose + ' Transpose</label>' +
                '<label class="pc-opt" title="Hide league matchup details"><input type="checkbox" id="pc-hide-matchups"' + (t.hideLeagueMatchups ? ' checked' : '') + '> ' + ICO.eyeOff + ' Hide Matchups</label>' +
                '<label class="pc-opt" title="All divisions side by side" id="pc-combined-wrap"><input type="checkbox" id="pc-combined"' + (t.layoutMode === 'all-bunks' ? ' checked' : '') + '> ' + ICO.grid + ' Combined</label>' +
                '<div class="pc-zoom-controls">' +
                    '<button class="pc-zoom-btn" onclick="window._pcZoom(-10)" title="Zoom out">\u2212</button>' +
                    '<span class="pc-zoom-label" id="pc-zoom-label">' + _zoomLevel + '%</span>' +
                    '<button class="pc-zoom-btn" onclick="window._pcZoom(10)" title="Zoom in">+</button>' +
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
    '<div class="pc-workspace">' +
        '<aside class="pc-advanced-drawer no-print' + (_advancedOpen ? ' open' : '') + '" id="pc-advanced-drawer">' +
            '<div class="pc-adv-header"><strong>' + ICO.gear + ' Advanced Design</strong><button class="pc-adv-close" onclick="window._pcToggleAdvanced()" title="Close">' + ICO.x + '</button></div>' +
            '<div class="pc-adv-scroll">' + buildAdvancedSections() + '</div>' +
        '</aside>' +
        '<button class="pc-scroll-arrow pc-scroll-left no-print" onclick="window._pcScrollH(-300)" title="Scroll left">' + ICO.chevL + '</button>' +
        '<div class="pc-preview-area" id="pc-preview-area">' +
            '<div class="pc-preview-empty" id="pc-preview-empty" style="display:none;"><div style="color:#94A3B8; text-align:center; padding:40px;"><div style="font-size:36px; margin-bottom:8px; opacity:0.5;">' + ICO.calendar + '</div><h3 style="margin:0 0 6px; font-size:15px; color:#64748B;">Select divisions or bunks above</h3><p style="margin:0; font-size:12px; color:#94A3B8;">Your styled schedule will appear here in real time.</p></div></div>' +
            '<div id="pc-preview-content" class="pc-preview-content" style="transform:scale(' + (_zoomLevel/100) + '); transform-origin:top left;"></div>' +
        '</div>' +
        '<button class="pc-scroll-arrow pc-scroll-right no-print" onclick="window._pcScrollH(300)" title="Scroll right">' + ICO.chevR + '</button>' +
    '</div>' +
    '<div id="printable-area"></div>' +
    '</div>';
}

// =========================================================================
// QUICK SETTINGS
// =========================================================================

function buildQuickSettings() {
    var t = _currentTemplate;
    return '<div class="pc-quick no-print">' +
        '<div class="pc-quick-group">' +
            '<div class="pc-quick-logo">' +
                (t.campLogo
                    ? '<img src="' + t.campLogo + '" class="pc-logo-thumb" alt="Logo" onclick="document.getElementById(\'pc-logo-input\').click()" title="Click to change logo">' +
                      '<button class="pc-logo-x" onclick="window._pcRemoveLogo()" title="Remove logo">' + ICO.x + '</button>'
                    : '<button class="pc-logo-add" onclick="document.getElementById(\'pc-logo-input\').click()" title="Upload camp logo">' + ICO.image + '</button>') +
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
            (canEditTemplates() ? '<button class="pc-btn pc-btn-xs pc-btn-primary" onclick="window._pcSaveAsTemplate()" title="Save template">' + ICO.save + '</button><button class="pc-btn pc-btn-xs" onclick="window._pcUpdateTemplate()" id="pc-btn-update-tpl" style="display:none;" title="Update">' + ICO.refresh + '</button><button class="pc-btn pc-btn-xs pc-btn-danger" onclick="window._pcDeleteTemplate()" id="pc-btn-delete-tpl" style="display:none;" title="Delete">' + ICO.trash + '</button>' : '') +
        '</div>' +
    '</div>';
}

// =========================================================================
// ADVANCED SECTIONS
// =========================================================================

function buildAdvancedSections() {
    var t = _currentTemplate;
    return '' +
    '<details class="pc-adv-section" open><summary>Header Colors</summary><div class="pc-adv-body">' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>BG</label><input type="color" id="pc-header-bg" value="' + t.headerBgColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Text</label><input type="color" id="pc-header-text" value="' + t.headerTextColor + '"></div></div>' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Font</label><select id="pc-header-font">' + fontOptions(t.headerFont) + '</select></div><div class="pc-dp-field pc-dp-half"><label>Size</label><input type="number" id="pc-header-font-size" value="' + t.headerFontSize + '" min="12" max="48"></div></div>' +
    '</div></details>' +
    '<details class="pc-adv-section"><summary>Grid Styling</summary><div class="pc-adv-body">' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Font</label><select id="pc-grid-font">' + fontOptions(t.gridFont) + '</select></div><div class="pc-dp-field pc-dp-half"><label>Size</label><input type="number" id="pc-grid-font-size" value="' + t.gridFontSize + '" min="8" max="18"></div></div>' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Header BG</label><input type="color" id="pc-grid-header-bg" value="' + t.gridHeaderBgColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Header Text</label><input type="color" id="pc-grid-header-text" value="' + t.gridHeaderTextColor + '"></div></div>' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Border</label><input type="color" id="pc-grid-border-color" value="' + t.gridBorderColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Width</label><input type="number" id="pc-grid-border-width" value="' + t.gridBorderWidth + '" min="0" max="4"></div></div>' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Row</label><input type="color" id="pc-grid-row-color" value="' + t.gridRowColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Alt Row</label><input type="color" id="pc-grid-row-alt" value="' + t.gridRowAltColor + '"></div></div>' +
        '<div class="pc-dp-field"><label>Cell Padding</label><input type="range" id="pc-cell-padding" min="2" max="20" value="' + t.cellPadding + '"></div>' +
    '</div></details>' +
    '<details class="pc-adv-section"><summary>Activity Colors</summary><div class="pc-adv-body"><div class="pc-dp-color-grid">' +
        '<div class="pc-dp-color-pair"><span>General</span><input type="color" id="pc-general-bg" value="' + t.generalBgColor + '"><input type="color" id="pc-general-text" value="' + t.generalTextColor + '"></div>' +
        '<div class="pc-dp-color-pair"><span>Pinned</span><input type="color" id="pc-pinned-bg" value="' + t.pinnedBgColor + '"><input type="color" id="pc-pinned-text" value="' + t.pinnedTextColor + '"></div>' +
        '<div class="pc-dp-color-pair"><span>League</span><input type="color" id="pc-league-bg" value="' + t.leagueBgColor + '"><input type="color" id="pc-league-text" value="' + t.leagueTextColor + '"></div>' +
        '<div class="pc-dp-color-pair"><span>Free</span><input type="color" id="pc-free-bg" value="' + t.freeBgColor + '"><input type="color" id="pc-free-text" value="' + t.freeTextColor + '"></div>' +
    '</div></div></details>' +
    '<details class="pc-adv-section"><summary>Time Column</summary><div class="pc-adv-body">' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>BG</label><input type="color" id="pc-time-bg" value="' + t.timeColBgColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Text</label><input type="color" id="pc-time-text" value="' + t.timeColTextColor + '"></div></div>' +
        '<div class="pc-dp-field"><label>Width (px)</label><input type="number" id="pc-time-width" value="' + t.timeColWidth + '" min="60" max="200"></div>' +
        '<label class="pc-dp-toggle"><input type="checkbox" id="pc-time-bold"' + (t.timeColBold ? ' checked' : '') + '> Bold time</label>' +
    '</div></details>' +
    '<details class="pc-adv-section"><summary>Print Layout</summary><div class="pc-adv-body">' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Orientation</label><select id="pc-orientation"><option value="landscape"' + (t.orientation==='landscape'?' selected':'') + '>Landscape</option><option value="portrait"' + (t.orientation==='portrait'?' selected':'') + '>Portrait</option></select></div><div class="pc-dp-field pc-dp-half"><label>Paper</label><select id="pc-paper-size"><option value="letter"' + (t.paperSize==='letter'?' selected':'') + '>Letter</option><option value="a4"' + (t.paperSize==='a4'?' selected':'') + '>A4</option><option value="legal"' + (t.paperSize==='legal'?' selected':'') + '>Legal</option></select></div></div>' +
        '<label class="pc-dp-toggle"><input type="checkbox" id="pc-page-breaks"' + (t.showPageBreaks ? ' checked' : '') + '> Page breaks between items</label>' +
    '</div></details>' +
    '<details class="pc-adv-section"><summary>Watermark</summary><div class="pc-adv-body">' +
        '<label class="pc-dp-toggle"><input type="checkbox" id="pc-watermark-enabled"' + (t.watermarkEnabled ? ' checked' : '') + '> Enable</label>' +
        '<div class="pc-dp-field"><label>Text</label><input type="text" id="pc-watermark-text" value="' + escHtml(t.watermarkText) + '" placeholder="DRAFT"></div>' +
        '<div class="pc-dp-row"><div class="pc-dp-field pc-dp-half"><label>Color</label><input type="color" id="pc-watermark-color" value="' + t.watermarkColor + '"></div><div class="pc-dp-field pc-dp-half"><label>Opacity</label><input type="range" id="pc-watermark-opacity" min="0.02" max="0.3" step="0.01" value="' + t.watermarkOpacity + '"></div></div>' +
    '</div></details>' +
    '<details class="pc-adv-section"><summary>Footer</summary><div class="pc-adv-body">' +
        '<label class="pc-dp-toggle"><input type="checkbox" id="pc-footer-enabled"' + (t.footerEnabled ? ' checked' : '') + '> Enable</label>' +
        '<div class="pc-dp-field"><label>Text</label><input type="text" id="pc-footer-text" value="' + escHtml(t.footerText) + '" placeholder="Confidential"></div>' +
    '</div></details>' +
    '<div style="padding:12px 0;"><button class="pc-btn pc-btn-ghost" style="width:100%;" onclick="window._pcResetToDefault()">Reset to Default</button></div>';
}

// =========================================================================
// BINDINGS
// =========================================================================

function bindAll() {
    document.querySelectorAll('.pc-view-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.pc-view-tab').forEach(function(b){b.classList.remove('active');});
            btn.classList.add('active');
            _activeView = btn.dataset.view;
            var cw = document.getElementById('pc-combined-wrap');
            if (cw) cw.style.display = _activeView === 'division' ? '' : 'none';
            populateSelectors();
            document.querySelectorAll('.pc-item-cb').forEach(function(cb){ cb.checked = true; });
            liveRefresh();
        });
    });
    var sc = document.getElementById('pc-selector-container');
    if (sc) sc.addEventListener('change', function(e) { if (e.target.matches('.pc-item-cb')) liveRefresh(); });
    var dl = debounce(function(){ readDesignValues(); liveRefresh(); }, 200);
    document.querySelectorAll('.pc-quick input, .pc-quick select').forEach(function(el) { el.addEventListener('input', dl); el.addEventListener('change', function(){ readDesignValues(); liveRefresh(); }); });
    ['pc-transpose','pc-hide-matchups','pc-combined'].forEach(function(id) { var el = document.getElementById(id); if (el) el.addEventListener('change', function(){ readDesignValues(); liveRefresh(); }); });
    var dw = document.getElementById('pc-advanced-drawer');
    if (dw) { var da = debounce(function(){ readDesignValues(); liveRefresh(); }, 200); dw.addEventListener('input', function(e){ if (e.target.matches('input,select')) da(); }); dw.addEventListener('change', function(e){ if (e.target.matches('input,select')){ readDesignValues(); liveRefresh(); }}); }
    renderTemplateDropdown();
}

function populateSelectors() {
    var c = document.getElementById('pc-selector-container'); if (!c) return;
    var divs = getDivisions(), avail = getAvailableDivisions();
    var a1 = (window.loadGlobalSettings ? window.loadGlobalSettings().app1 : null) || {};
    var html = '';
    if (_activeView === 'division') {
        avail.forEach(function(dv) { html += '<label class="pc-selector-item"><input type="checkbox" value="' + escHtml(dv) + '" class="pc-item-cb"> ' + escHtml(dv) + '</label>'; });
    } else if (_activeView === 'bunk') {
        avail.forEach(function(dv) { var bk = (divs[dv] && divs[dv].bunks ? divs[dv].bunks : []).sort(naturalSort); if (bk.length) { html += '<div class="pc-selector-group">' + escHtml(dv) + '</div>'; bk.forEach(function(b){ html += '<label class="pc-selector-item"><input type="checkbox" value="' + escHtml(b) + '" class="pc-item-cb"> ' + escHtml(b) + '</label>'; }); } });
    } else if (_activeView === 'location') {
        var locs = (a1.fields||[]).map(function(f){return f.name;}).concat((a1.specialActivities||[]).map(function(s){return s.name;})).sort(naturalSort);
        locs.forEach(function(l) { html += '<label class="pc-selector-item"><input type="checkbox" value="' + escHtml(l) + '" class="pc-item-cb"> ' + escHtml(l) + '</label>'; });
    }
    c.innerHTML = html;
}

function getSelectedItems() { return Array.from(document.querySelectorAll('.pc-item-cb:checked')).map(function(cb){return cb.value;}); }

// =========================================================================
// READ DESIGN VALUES
// =========================================================================

function readDesignValues() {
    var t = _currentTemplate;
    var el = function(id){ return document.getElementById(id); };
    t.headerEnabled = !!(el('pc-header-enabled') && el('pc-header-enabled').checked);
    t.campName = el('pc-camp-name') ? el('pc-camp-name').value : t.campName;
    t.customSubtitle = el('pc-custom-subtitle') ? el('pc-custom-subtitle').value : t.customSubtitle;
    t.showDate = !!(el('pc-show-date') && el('pc-show-date').checked);
    t.showDivisionName = !!(el('pc-show-div-name') && el('pc-show-div-name').checked);
    t.tableOrientation = (el('pc-transpose') && el('pc-transpose').checked) ? 'time-top' : 'bunks-top';
    t.hideLeagueMatchups = !!(el('pc-hide-matchups') && el('pc-hide-matchups').checked);
    t.layoutMode = (el('pc-combined') && el('pc-combined').checked) ? 'all-bunks' : 'per-division';
    // Advanced fields — only read if they exist in DOM
    var map = {
        'pc-header-bg':'headerBgColor','pc-header-text':'headerTextColor','pc-header-font':'headerFont',
        'pc-grid-font':'gridFont','pc-grid-header-bg':'gridHeaderBgColor','pc-grid-header-text':'gridHeaderTextColor',
        'pc-grid-border-color':'gridBorderColor','pc-grid-row-color':'gridRowColor','pc-grid-row-alt':'gridRowAltColor',
        'pc-general-bg':'generalBgColor','pc-general-text':'generalTextColor',
        'pc-pinned-bg':'pinnedBgColor','pc-pinned-text':'pinnedTextColor',
        'pc-league-bg':'leagueBgColor','pc-league-text':'leagueTextColor',
        'pc-free-bg':'freeBgColor','pc-free-text':'freeTextColor',
        'pc-time-bg':'timeColBgColor','pc-time-text':'timeColTextColor',
        'pc-watermark-color':'watermarkColor','pc-orientation':'orientation','pc-paper-size':'paperSize'
    };
    for (var eid in map) { var e = el(eid); if (e) t[map[eid]] = e.value; }
    var intMap = {'pc-header-font-size':'headerFontSize','pc-grid-font-size':'gridFontSize','pc-grid-border-width':'gridBorderWidth','pc-cell-padding':'cellPadding','pc-time-width':'timeColWidth'};
    for (var eid2 in intMap) { var e2 = el(eid2); if (e2) t[intMap[eid2]] = parseInt(e2.value) || t[intMap[eid2]]; }
    var chkMap = {'pc-time-bold':'timeColBold','pc-page-breaks':'showPageBreaks','pc-watermark-enabled':'watermarkEnabled','pc-footer-enabled':'footerEnabled'};
    for (var eid3 in chkMap) { var e3 = el(eid3); if (e3) t[chkMap[eid3]] = !!e3.checked; }
    if (el('pc-watermark-text')) t.watermarkText = el('pc-watermark-text').value;
    if (el('pc-watermark-opacity')) t.watermarkOpacity = parseFloat(el('pc-watermark-opacity').value) || 0.08;
    if (el('pc-footer-text')) t.footerText = el('pc-footer-text').value;
}

function renderTemplateDropdown() {
    var sel = document.getElementById('pc-template-select'); if (!sel) return;
    var cid = _currentTemplate.id || 'default';
    var h = '<option value="default"' + (cid==='default'?' selected':'') + '>Default</option>';
    _savedTemplates.forEach(function(tp){ h += '<option value="' + tp.id + '"' + (cid===tp.id?' selected':'') + '>' + escHtml(tp.name) + '</option>'; });
    sel.innerHTML = h;
    var ic = cid !== 'default' && canEditTemplates();
    var ub = document.getElementById('pc-btn-update-tpl'); if (ub) ub.style.display = ic ? 'inline-flex' : 'none';
    var db = document.getElementById('pc-btn-delete-tpl'); if (db) db.style.display = ic ? 'inline-flex' : 'none';
}

// =========================================================================
// STYLED HTML BUILDERS
// =========================================================================

function buildStyledHeader(titleText) {
    var t = _currentTemplate;
    if (!t.headerEnabled) return '';
    var h = '<div style="background:' + t.headerBgColor + '; color:' + t.headerTextColor + '; font-family:\'' + t.headerFont + '\',-apple-system,BlinkMacSystemFont,sans-serif; padding:12px 20px; display:flex; align-items:center; gap:14px; border-bottom:1px solid rgba(0,0,0,0.1);">';
    if (t.campLogo) h += '<img src="' + t.campLogo + '" style="height:' + (t.headerFontSize + 14) + 'px; max-width:100px; object-fit:contain;" alt="">';
    h += '<div style="flex:1; min-width:0;">';
    if (t.campName) h += '<div style="font-size:' + t.headerFontSize + 'px; font-weight:700; letter-spacing:-0.02em; line-height:1.2;">' + escHtml(t.campName) + '</div>';
    if (t.showDivisionName && titleText) h += '<div style="font-size:' + Math.max(12, t.headerFontSize - 6) + 'px; opacity:0.9; margin-top:2px; font-weight:500;">' + escHtml(titleText) + '</div>';
    if (t.customSubtitle) h += '<div style="font-size:' + Math.max(10, t.headerFontSize - 10) + 'px; opacity:0.7; margin-top:1px;">' + escHtml(t.customSubtitle) + '</div>';
    h += '</div>';
    if (t.showDate) h += '<div style="font-size:' + Math.max(10, t.headerFontSize - 9) + 'px; opacity:0.8; text-align:right; white-space:nowrap; font-weight:500;">' + formatDisplayDate(window.currentScheduleDate) + '</div>';
    h += '</div>';
    return h;
}
function buildStyledFooter() { var t = _currentTemplate; if (!t.footerEnabled || !t.footerText) return ''; return '<div style="font-family:\'' + t.footerFont + '\',sans-serif; font-size:' + t.footerFontSize + 'px; color:#94A3B8; text-align:center; padding:6px 16px; border-top:1px solid ' + t.gridBorderColor + ';">' + escHtml(t.footerText) + '</div>'; }
function buildWatermark() { var t = _currentTemplate; if (!t.watermarkEnabled || !t.watermarkText) return ''; return '<div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-35deg); font-size:72px; font-weight:900; color:' + t.watermarkColor + '; opacity:' + t.watermarkOpacity + '; pointer-events:none; white-space:nowrap; z-index:1;">' + escHtml(t.watermarkText) + '</div>'; }

function cellStyle(type, isAlt) {
    var t = _currentTemplate, bg, cl;
    switch(type) { case 'pinned': bg=t.pinnedBgColor; cl=t.pinnedTextColor; break; case 'league': bg=t.leagueBgColor; cl=t.leagueTextColor; break; case 'free': bg=t.freeBgColor; cl=t.freeTextColor; break; default: bg=isAlt?t.gridRowAltColor:t.gridRowColor; cl=t.generalTextColor; }
    return 'background:'+bg+';color:'+cl+';padding:'+t.cellPadding+'px;font-family:\''+t.gridFont+'\',sans-serif;font-size:'+t.gridFontSize+'px;border:'+t.gridBorderWidth+'px solid '+t.gridBorderColor+';';
}
function timeStyle() { var t=_currentTemplate; return 'background:'+t.timeColBgColor+';color:'+t.timeColTextColor+';font-family:\''+(t.timeColFont||t.gridFont)+'\',sans-serif;font-size:'+(t.timeColFontSize||t.gridFontSize)+'px;font-weight:'+(t.timeColBold?'700':'400')+';padding:'+t.cellPadding+'px;border:'+t.gridBorderWidth+'px solid '+t.gridBorderColor+';width:'+t.timeColWidth+'px;white-space:nowrap;'; }
function headerCellStyle() { var t=_currentTemplate; return 'background:'+t.gridHeaderBgColor+';color:'+t.gridHeaderTextColor+';font-family:\''+t.gridFont+'\',sans-serif;font-size:'+t.gridFontSize+'px;font-weight:600;padding:'+t.cellPadding+'px;border:'+t.gridBorderWidth+'px solid '+t.gridBorderColor+';'; }

// =========================================================================
// BUILD DIVISION BLOCKS
// =========================================================================

function buildDivisionBlocks(divName) {
    var skeleton = getSkeleton(), sorted = [];
    skeleton.forEach(function(item) {
        if (item.division === divName) {
            var s = parseTimeToMinutes(item.startTime), e = parseTimeToMinutes(item.endTime);
            if (s !== null && e !== null) sorted.push({ item: item, startMin: s, endMin: e });
        }
    });
    sorted.sort(function(a,b){ return a.startMin - b.startMin; });
    var blocks = [], lc = 0, sc2 = 0;
    sorted.forEach(function(bl) {
        var ev = bl.item.event;
        if (ev === "League Game") { lc++; ev = "League Game " + lc; }
        else if (ev === "Specialty League") { sc2++; ev = "Specialty League " + sc2; }
        blocks.push({ label: minutesToTimeLabel(bl.startMin) + ' \u2013 ' + minutesToTimeLabel(bl.endMin), startMin: bl.startMin, endMin: bl.endMin, event: ev, type: bl.item.type, isLeague: bl.item.event === "League Game" || bl.item.event === "Specialty League" });
    });
    var unique = blocks.filter(function(b,i,s){ return i === s.findIndex(function(t2){return t2.label===b.label;}); });
    var flat = [];
    unique.forEach(function(bl) {
        if (bl.type === "split" && bl.startMin !== null && bl.endMin !== null) {
            var mid = Math.round(bl.startMin + (bl.endMin - bl.startMin) / 2);
            flat.push({ label: minutesToTimeLabel(bl.startMin) + ' \u2013 ' + minutesToTimeLabel(mid), startMin: bl.startMin, endMin: mid, event: bl.event, type: bl.type, isLeague: bl.isLeague, splitPart: 1 });
            flat.push({ label: minutesToTimeLabel(mid) + ' \u2013 ' + minutesToTimeLabel(bl.endMin), startMin: mid, endMin: bl.endMin, event: bl.event, type: bl.type, isLeague: bl.isLeague, splitPart: 2 });
        } else { flat.push(bl); }
    });
    return flat;
}

// =========================================================================
// BUILD LEAGUE CELL (merged across all bunks)
// =========================================================================

function buildLeagueCellHtml(eventBlock, bunks, divName) {
    var t = _currentTemplate;
    // Get matchups from first bunk's entry
    var slotIndex = findFirstSlotForTime(eventBlock.startMin, divName);
    var matchups = [];
    if (slotIndex >= 0) {
        for (var i = 0; i < bunks.length; i++) {
            var entry = getEntry(bunks[i], slotIndex);
            if (entry && entry._allMatchups && entry._allMatchups.length) { matchups = entry._allMatchups; break; }
            // Also check individual matchup format
            if (entry && entry._h2h && entry._matchup) { matchups.push(entry._matchup); }
        }
    }
    if (t.hideLeagueMatchups) {
        return '<strong>' + escHtml(eventBlock.event) + '</strong>';
    }
    var html = '<strong>' + escHtml(eventBlock.event) + '</strong>';
    if (matchups.length > 0) {
        html += '<div style="margin-top:4px; font-size:0.9em;">';
        matchups.forEach(function(m) { html += '<span style="display:inline-block; margin:1px 8px 1px 0; padding:1px 6px; background:rgba(0,0,0,0.04); border-radius:3px;">' + escHtml(m) + '</span>'; });
        html += '</div>';
    }
    return html;
}

// =========================================================================
// DIVISION HTML — BUNKS ON TOP (default)
// =========================================================================

function generateDivisionHTML_bunksTop(divName) {
    var t = _currentTemplate, divs = getDivisions();
    var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).sort(naturalSort);
    if (!bunks.length) return "";
    var blocks = buildDivisionBlocks(divName);
    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks?'always':'auto') + '; margin-bottom:20px;">';
    html += buildWatermark() + buildStyledHeader(divName);
    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';
    html += '<thead><tr><th style="' + headerCellStyle() + 'width:' + t.timeColWidth + 'px;">Time</th>';
    bunks.forEach(function(b){ html += '<th style="' + headerCellStyle() + '">' + escHtml(b) + '</th>'; });
    html += '</tr></thead><tbody>';
    if (!blocks.length) html += '<tr><td colspan="' + (bunks.length+1) + '" style="text-align:center;padding:20px;color:#94A3B8;">No schedule blocks found.</td></tr>';

    blocks.forEach(function(eb, ri) {
        var isAlt = ri % 2 === 1;
        html += '<tr><td style="' + timeStyle() + '">' + eb.label + '</td>';
        if (eb.isLeague) {
            // ★ MERGED CELL — spans all bunk columns
            html += '<td colspan="' + bunks.length + '" style="' + cellStyle('league', isAlt) + 'text-align:center;">' + buildLeagueCellHtml(eb, bunks, divName) + '</td>';
        } else {
            bunks.forEach(function(b) {
                var si = findFirstSlotForTime(eb.startMin, divName);
                var entry = si >= 0 ? getEntry(b, si) : null;
                var type = 'general', label = '';
                if (!entry) { type = 'free'; label = ''; }
                else if (entry._fixed) { type = 'pinned'; label = escHtml(formatEntry(entry)); }
                else { label = escHtml(formatEntry(entry)); if (!label) { type = 'free'; label = '\u2014'; } }
                html += '<td style="' + cellStyle(type, isAlt) + '">' + label + '</td>';
            });
        }
        html += '</tr>';
    });
    html += '</tbody></table>' + buildStyledFooter() + '</div>';
    return html;
}

// =========================================================================
// DIVISION HTML — TIME ON TOP (transposed)
// =========================================================================

function generateDivisionHTML_timeTop(divName) {
    var t = _currentTemplate, divs = getDivisions();
    var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).sort(naturalSort);
    if (!bunks.length) return "";
    var blocks = buildDivisionBlocks(divName);
    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks?'always':'auto') + '; margin-bottom:20px;">';
    html += buildWatermark() + buildStyledHeader(divName);
    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';

    // Find which columns are league games
    var leagueCols = {};
    blocks.forEach(function(eb, idx) { if (eb.isLeague) leagueCols[idx] = eb; });

    html += '<thead><tr><th style="' + headerCellStyle() + '">Bunk</th>';
    blocks.forEach(function(bl) { html += '<th style="' + headerCellStyle() + 'white-space:nowrap;font-size:' + Math.max(8,t.gridFontSize-1) + 'px;">' + bl.label + '</th>'; });
    html += '</tr></thead><tbody>';

    // For league columns: show merged info only in first bunk row, rowspan the rest
    var leagueRendered = {};

    bunks.forEach(function(b, bi) {
        var isAlt = bi % 2 === 1;
        html += '<tr><td style="' + timeStyle() + '">' + escHtml(b) + '</td>';
        blocks.forEach(function(eb, ci) {
            if (eb.isLeague) {
                if (bi === 0) {
                    // First bunk: render merged cell with rowspan
                    html += '<td rowspan="' + bunks.length + '" style="' + cellStyle('league', false) + 'text-align:center;vertical-align:middle;">' + buildLeagueCellHtml(eb, bunks, divName) + '</td>';
                }
                // else: skip (covered by rowspan)
            } else {
                var si = findFirstSlotForTime(eb.startMin, divName);
                var entry = si >= 0 ? getEntry(b, si) : null;
                var type = 'general', label = '';
                if (!entry) { type = 'free'; label = ''; }
                else if (entry._fixed) { type = 'pinned'; label = escHtml(formatEntry(entry)); }
                else { label = escHtml(formatEntry(entry)); if (!label) { type = 'free'; label = '\u2014'; } }
                html += '<td style="' + cellStyle(type, isAlt) + '">' + label + '</td>';
            }
        });
        html += '</tr>';
    });
    html += '</tbody></table>' + buildStyledFooter() + '</div>';
    return html;
}

// =========================================================================
// COMBINED VIEW — each division side by side with own time grid
// =========================================================================

function generateCombinedHTML(selectedDivisions) {
    var t = _currentTemplate, divs = getDivisions();
    // Compute max blocks across all divisions for equal height
    var divData = [];
    var maxBlocks = 0;
    selectedDivisions.forEach(function(dn) {
        var bunks = (divs[dn] && divs[dn].bunks ? divs[dn].bunks : []).sort(naturalSort);
        var blocks = buildDivisionBlocks(dn);
        if (blocks.length > maxBlocks) maxBlocks = blocks.length;
        divData.push({ name: dn, bunks: bunks, blocks: blocks });
    });
    if (!divData.length) return "";

    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks?'always':'auto') + '; margin-bottom:20px;">';
    html += buildWatermark() + buildStyledHeader('All Divisions');

    // Flex container — divisions side by side
    html += '<div style="display:flex; align-items:stretch; gap:0; overflow-x:auto;">';

    divData.forEach(function(dd, di) {
        var bunks = dd.bunks, blocks = dd.blocks;
        var borderLeft = di > 0 ? 'border-left:2px solid ' + t.gridBorderColor + ';' : '';

        html += '<div style="flex:1; min-width:0;' + borderLeft + '">';

        if (t.tableOrientation === 'time-top') {
            // Transposed: bunk names down left, time across top
            html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px; height:100%;">';
            // Division name header row
            html += '<thead><tr><th colspan="' + (blocks.length + 1) + '" style="' + headerCellStyle() + 'text-align:center;font-weight:700;font-size:' + (t.gridFontSize+1) + 'px;">' + escHtml(dd.name) + '</th></tr>';
            html += '<tr><th style="' + headerCellStyle() + '">Bunk</th>';
            blocks.forEach(function(bl) { html += '<th style="' + headerCellStyle() + 'white-space:nowrap;font-size:' + Math.max(8,t.gridFontSize-1) + 'px;">' + bl.label + '</th>'; });
            html += '</tr></thead><tbody>';

            bunks.forEach(function(b, bi) {
                var isAlt = bi % 2 === 1;
                html += '<tr><td style="' + timeStyle() + '">' + escHtml(b) + '</td>';
                blocks.forEach(function(eb, ci) {
                    if (eb.isLeague) {
                        if (bi === 0) html += '<td rowspan="' + bunks.length + '" style="' + cellStyle('league',false) + 'text-align:center;vertical-align:middle;">' + buildLeagueCellHtml(eb, bunks, dd.name) + '</td>';
                    } else {
                        var si = findFirstSlotForTime(eb.startMin, dd.name);
                        var entry = si >= 0 ? getEntry(b, si) : null;
                        var type = 'general', label = '';
                        if (!entry) { type = 'free'; label = ''; }
                        else if (entry._fixed) { type = 'pinned'; label = escHtml(formatEntry(entry)); }
                        else { label = escHtml(formatEntry(entry)); if (!label) { type = 'free'; label = '\u2014'; } }
                        html += '<td style="' + cellStyle(type, isAlt) + '">' + label + '</td>';
                    }
                });
                html += '</tr>';
            });
        } else {
            // Normal: time down left, bunks across top
            // Calculate min row height to equalize with max blocks
            var minRowH = maxBlocks > 0 && blocks.length < maxBlocks ? Math.round(maxBlocks / blocks.length * 32) : 0;
            var rowHStyle = minRowH > 32 ? 'height:' + minRowH + 'px;' : '';

            html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px; height:100%;">';
            // Division name header row
            html += '<thead><tr><th colspan="' + (bunks.length + 1) + '" style="' + headerCellStyle() + 'text-align:center;font-weight:700;font-size:' + (t.gridFontSize+1) + 'px;">' + escHtml(dd.name) + '</th></tr>';
            html += '<tr><th style="' + headerCellStyle() + 'width:' + t.timeColWidth + 'px;">Time</th>';
            bunks.forEach(function(b){ html += '<th style="' + headerCellStyle() + '">' + escHtml(b) + '</th>'; });
            html += '</tr></thead><tbody>';

            blocks.forEach(function(eb, ri) {
                var isAlt = ri % 2 === 1;
                html += '<tr style="' + rowHStyle + '"><td style="' + timeStyle() + 'vertical-align:middle;">' + eb.label + '</td>';
                if (eb.isLeague) {
                    html += '<td colspan="' + bunks.length + '" style="' + cellStyle('league', isAlt) + 'text-align:center;vertical-align:middle;">' + buildLeagueCellHtml(eb, bunks, dd.name) + '</td>';
                } else {
                    bunks.forEach(function(b) {
                        var si = findFirstSlotForTime(eb.startMin, dd.name);
                        var entry = si >= 0 ? getEntry(b, si) : null;
                        var type = 'general', label = '';
                        if (!entry) { type = 'free'; label = ''; }
                        else if (entry._fixed) { type = 'pinned'; label = escHtml(formatEntry(entry)); }
                        else { label = escHtml(formatEntry(entry)); if (!label) { type = 'free'; label = '\u2014'; } }
                        html += '<td style="' + cellStyle(type, isAlt) + 'vertical-align:middle;">' + label + '</td>';
                    });
                }
                html += '</tr>';
            });
        }
        html += '</tbody></table></div>';
    });

    html += '</div>' + buildStyledFooter() + '</div>';
    return html;
}

// =========================================================================
// BUNK / LOCATION GENERATORS
// =========================================================================

function generateStyledBunkHTML(bunk) {
    var t = _currentTemplate, aa = getAssignments(), sched = aa[bunk] || [], dn = null, divs = getDivisions();
    for (var d in divs) { if (divs[d].bunks && divs[d].bunks.indexOf(bunk) >= 0) { dn = d; break; } }
    var times = (dn && window.divisionTimes && window.divisionTimes[dn]) ? window.divisionTimes[dn] : (window.unifiedTimes || []);
    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks?'always':'auto') + '; margin-bottom:20px;">';
    html += buildWatermark() + buildStyledHeader(bunk + (dn ? ' (' + dn + ')' : ''));
    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';
    html += '<thead><tr><th style="' + headerCellStyle() + 'width:' + t.timeColWidth + 'px;">Time</th><th style="' + headerCellStyle() + '">Activity / Location</th></tr></thead><tbody>';
    times.forEach(function(slot, i) {
        var entry = sched[i]; if (!entry || entry.continuation) return;
        var isAlt = i % 2 === 1, type = 'general', label = '';
        if (entry._fixed) { type = 'pinned'; label = escHtml(formatEntry(entry)); }
        else if (entry._h2h) {
            type = 'league';
            if (t.hideLeagueMatchups) label = '<strong>' + escHtml(entry.sport || 'League Game') + '</strong>';
            else label = '<strong>' + escHtml(formatEntry(entry)) + '</strong>';
        }
        else { label = escHtml(formatEntry(entry)); if (!label) { type = 'free'; label = '\u2014'; } }
        var tl = slot.label || (minutesToTimeLabel(slot.startMin||0) + ' \u2013 ' + minutesToTimeLabel(slot.endMin||0));
        html += '<tr><td style="' + timeStyle() + '">' + tl + '</td><td style="' + cellStyle(type, isAlt) + '">' + label + '</td></tr>';
    });
    if (!times.length) html += '<tr><td colspan="2" style="text-align:center;padding:20px;color:#94A3B8;">No schedule data found.</td></tr>';
    html += '</tbody></table>' + buildStyledFooter() + '</div>';
    return html;
}

function generateStyledLocationHTML(loc) {
    var t = _currentTemplate, times = window.unifiedTimes || [], aa = getAssignments();
    var html = '<div class="pc-print-page" style="position:relative; page-break-after:' + (t.showPageBreaks?'always':'auto') + '; margin-bottom:20px;">';
    html += buildWatermark() + buildStyledHeader(loc + ' Schedule');
    html += '<table style="width:100%; border-collapse:collapse; font-family:\'' + t.gridFont + '\',sans-serif; font-size:' + t.gridFontSize + 'px;">';
    html += '<thead><tr><th style="' + headerCellStyle() + 'width:' + t.timeColWidth + 'px;">Time</th><th style="' + headerCellStyle() + '">Bunks</th></tr></thead><tbody>';
    times.forEach(function(slot, i) {
        var isAlt = i % 2 === 1, found = [];
        for (var bk in aa) { var e = aa[bk] && aa[bk][i]; if (!e || e.continuation) continue; var fn = (typeof e.field === 'string') ? e.field : (e.field && e.field.name ? e.field.name : ''); if (fn === loc) found.push(bk); }
        if (!found.length) return;
        var tl = slot.label || (minutesToTimeLabel(slot.startMin||0) + ' \u2013 ' + minutesToTimeLabel(slot.endMin||0));
        html += '<tr><td style="' + timeStyle() + '">' + tl + '</td><td style="' + cellStyle('general', isAlt) + '">' + found.sort(naturalSort).map(function(b){return escHtml(b);}).join(', ') + '</td></tr>';
    });
    html += '</tbody></table>' + buildStyledFooter() + '</div>';
    return html;
}

// =========================================================================
// LIVE REFRESH
// =========================================================================

function liveRefresh() {
    var sel = getSelectedItems(), pc = document.getElementById('pc-preview-content'), pe = document.getElementById('pc-preview-empty');
    if (!pc) return;
    if (!sel.length) { pc.style.display = 'none'; if (pe) pe.style.display = 'flex'; return; }
    pc.style.display = 'block'; if (pe) pe.style.display = 'none';
    var t = _currentTemplate, html = '';
    if (_activeView === 'division') {
        if (t.layoutMode === 'all-bunks') html = generateCombinedHTML(sel);
        else sel.forEach(function(d){ html += t.tableOrientation === 'time-top' ? generateDivisionHTML_timeTop(d) : generateDivisionHTML_bunksTop(d); });
    } else if (_activeView === 'bunk') { sel.forEach(function(b){ html += generateStyledBunkHTML(b); }); }
    else if (_activeView === 'location') { sel.forEach(function(l){ html += generateStyledLocationHTML(l); }); }
    if (!html) html = '<div style="text-align:center;padding:40px;color:#94A3B8;">No schedule data found. Generate a schedule first.</div>';
    pc.innerHTML = html; _previewHtml = html;
    pc.style.transform = 'scale(' + (_zoomLevel/100) + ')';
    pc.style.transformOrigin = 'top left';
}

// =========================================================================
// PRINT & EXPORT
// =========================================================================

function triggerPrint() {
    var sel = getSelectedItems(); if (!sel.length) return alert("Select at least one item to print.");
    readDesignValues(); var t = _currentTemplate, html = '';
    if (_activeView==='division') { if (t.layoutMode==='all-bunks') html=generateCombinedHTML(sel); else sel.forEach(function(d){html+=t.tableOrientation==='time-top'?generateDivisionHTML_timeTop(d):generateDivisionHTML_bunksTop(d);}); }
    else if (_activeView==='bunk') sel.forEach(function(b){html+=generateStyledBunkHTML(b);});
    else if (_activeView==='location') sel.forEach(function(l){html+=generateStyledLocationHTML(l);});
    var area = document.getElementById("printable-area"); if (!area) return; area.innerHTML = html;
    var ps = document.getElementById('pc-print-style') || document.createElement('style');
    ps.id = 'pc-print-style';
    ps.textContent = '@media print{@page{size:'+t.paperSize+' '+t.orientation+';margin:0.5in;}body *{visibility:hidden}#printable-area,#printable-area *{visibility:visible}#printable-area{display:block!important;position:absolute;left:0;top:0;width:100%}.pc-print-page{page-break-inside:avoid}.no-print{display:none!important}}';
    if (!document.getElementById('pc-print-style')) document.head.appendChild(ps);
    window.print();
}

function exportExcel() {
    var sel = getSelectedItems(); if (!sel.length) return alert("Select at least one item.");
    readDesignValues(); var html = '';
    if (_activeView==='division') { if (_currentTemplate.layoutMode==='all-bunks') html=generateCombinedHTML(sel); else sel.forEach(function(d){html+=generateDivisionHTML_bunksTop(d);}); }
    else if (_activeView==='bunk') sel.forEach(function(b){html+=generateStyledBunkHTML(b);});
    else sel.forEach(function(l){html+=generateStyledLocationHTML(l);});
    var blob = new Blob(['<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>'+html+'</body></html>'], {type:'application/vnd.ms-excel'});
    var u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = 'Schedule_' + _activeView + '_' + (window.currentScheduleDate||'export') + '.xls';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u);
}

// =========================================================================
// LOGO
// =========================================================================

function handleLogoUpload(input) {
    if (!input.files || !input.files[0]) return;
    if (input.files[0].size > 2*1024*1024) { alert("Logo must be under 2MB."); return; }
    var r = new FileReader();
    r.onload = function(e) { _currentTemplate.campLogo = e.target.result; rebuildQuickBar(); liveRefresh(); };
    r.readAsDataURL(input.files[0]);
}
function removeLogo() { _currentTemplate.campLogo = null; rebuildQuickBar(); liveRefresh(); }
function rebuildQuickBar() {
    var old = document.querySelector('.pc-quick'); if (!old) return;
    old.outerHTML = buildQuickSettings();
    var dl = debounce(function(){readDesignValues();liveRefresh();}, 200);
    document.querySelectorAll('.pc-quick input, .pc-quick select').forEach(function(el){ el.addEventListener('input',dl); el.addEventListener('change',function(){readDesignValues();liveRefresh();}); });
    renderTemplateDropdown();
}

// =========================================================================
// GLOBAL BINDINGS
// =========================================================================

window._pcToggleAdvanced = function() { _advancedOpen = !_advancedOpen; var d = document.getElementById('pc-advanced-drawer'); if (d) d.classList.toggle('open', _advancedOpen); };
window._pcZoom = function(delta) { _zoomLevel = Math.max(30, Math.min(200, _zoomLevel + delta)); var l = document.getElementById('pc-zoom-label'); if (l) l.textContent = _zoomLevel + '%'; var c = document.getElementById('pc-preview-content'); if (c) { c.style.transform = 'scale(' + (_zoomLevel/100) + ')'; c.style.transformOrigin = 'top left'; } };
window._pcScrollH = function(dx) { var a = document.getElementById('pc-preview-area'); if (a) a.scrollBy({ left: dx, behavior: 'smooth' }); };
window._pcFullscreen = function() {
    _isFullscreen = !_isFullscreen;
    var root = document.getElementById('pc-root');
    if (root) root.classList.toggle('pc-fullscreen', _isFullscreen);
    var btn = document.getElementById('pc-fs-btn');
    if (btn) btn.innerHTML = _isFullscreen ? ICO.shrink : ICO.expand;
};
window._pcSelectAll = function() { document.querySelectorAll('.pc-item-cb').forEach(function(cb){cb.checked=true;}); liveRefresh(); };
window._pcDeselectAll = function() { document.querySelectorAll('.pc-item-cb').forEach(function(cb){cb.checked=false;}); liveRefresh(); };
window._pcPrint = triggerPrint;
window._pcExportExcel = exportExcel;
window._pcHandleLogo = handleLogoUpload;
window._pcRemoveLogo = removeLogo;
window._pcLoadTemplate = function(tid) { loadTemplate(tid); localStorage.setItem('campistry_last_print_template', tid); };
window._pcSaveAsTemplate = function() { if (!canEditTemplates()){alert('Only owners/admins can save templates.');return;} var nm = prompt('Template name:','My Template'); if (!nm) return; readDesignValues(); var tp = saveCurrentAsTemplate(nm); if (tp){_currentTemplate.id=tp.id;renderTemplateDropdown();localStorage.setItem('campistry_last_print_template',tp.id);if(window.showToast)window.showToast('Template saved!','success');} };
window._pcUpdateTemplate = function() { if(!canEditTemplates())return; var cid=_currentTemplate.id; if(!cid||cid==='default')return; readDesignValues(); if(updateTemplate(cid)){if(window.showToast)window.showToast('Template updated!','success');} };
window._pcDeleteTemplate = function() { if(!canEditTemplates())return; var cid=_currentTemplate.id; if(!cid||cid==='default')return; if(!confirm('Delete this template?'))return; deleteTemplate(cid); _currentTemplate=Object.assign({},DEFAULT_TEMPLATE); renderTemplateDropdown(); localStorage.setItem('campistry_last_print_template','default'); liveRefresh(); if(window.showToast)window.showToast('Template deleted.','info'); };
window._pcResetToDefault = function() { _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE); initPrintCenter(); };
window.printAllDivisions = function() { _activeView='division'; populateSelectors(); window._pcSelectAll(); readDesignValues(); triggerPrint(); };
window.exportAllDivisionsToExcel = function() { _activeView='division'; populateSelectors(); window._pcSelectAll(); readDesignValues(); exportExcel(); };
window.initPrintCenter = initPrintCenter;

})();
