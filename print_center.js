// =============================================================================
// print_center.js  v3.0 — Full Rewrite
// =============================================================================
// FEATURES:
//   • Google Sheets/Excel-style spreadsheet UI with frozen headers, cell grid
//   • Auto Builder mode: per-bunk rendering (each bunk has its own time slots)
//   • Manual Builder mode: slot-based rendering (division-level unified slots)
//   • Live Mode: fullscreen schedule display with real-time cursor tracking
//   • Template system (save/load/delete design presets)
//   • Views: Division, Bunk, Location
//   • Export: Print, Excel (XLSX via SheetJS)
//   • Advanced design panel (fonts, colors, borders, watermark, footer)
//   • Formula bar showing cell info on hover/click
//   • Column/row resize handles
//   • Zoom slider with keyboard shortcuts
//   • Freeze panes (row/column headers always visible)
// =============================================================================
(function () {
'use strict';

var VERSION = '3.0';

// =========================================================================
// ICONS (inline SVG)
// =========================================================================
var ICO = {
    grid:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
    user:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    mapPin:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    print:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
    excel:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
    gear:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    save:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
    trash:    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V3h6v3"/></svg>',
    x:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    expand:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    play:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    pause:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    refresh:  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    zoomIn:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    zoomOut:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    monitor:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    check:    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
    chevD:    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>'
};

// =========================================================================
// FONT LIST
// =========================================================================
var FONTS = ['DM Sans','Inter','Roboto','Helvetica','Arial','Georgia','Courier New','Trebuchet MS','Verdana','Palatino','Garamond','Futura','Avenir','Montserrat','Lato','Open Sans','Nunito','Poppins','Source Sans Pro','Merriweather'];

// =========================================================================
// DEFAULT TEMPLATE
// =========================================================================
var DEFAULT_TEMPLATE = {
    id: 'default', name: 'Default', isDefault: true,
    campName: '', campLogo: '', customSubtitle: '',
    showHeader: true, showDate: true, showDivisionName: true,
    headerBgColor: '#147D91', headerTextColor: '#FFFFFF',
    headerFont: 'DM Sans', headerFontSize: 22,
    gridFont: 'DM Sans', gridFontSize: 11,
    gridHeaderBgColor: '#F1F5F9', gridHeaderTextColor: '#1E293B',
    gridBorderColor: '#E2E8F0', gridBorderWidth: 1,
    gridRowColor: '#FFFFFF', gridRowAltColor: '#F8FAFC',
    generalBgColor: '#FFFFFF', generalTextColor: '#334155',
    pinnedBgColor: '#FFF8E1', pinnedTextColor: '#92400E',
    leagueBgColor: '#EFF6FF', leagueTextColor: '#1E40AF',
    freeBgColor: '#F9FAFB', freeTextColor: '#94A3B8',
    timeColBgColor: '#F8FAFC', timeColTextColor: '#475569',
    timeColFont: '', timeColFontSize: 11, timeColBold: true, timeColWidth: 90,
    cellPadding: 6,
    tableOrientation: 'bunks-top', layoutMode: 'all-bunks',
    orientation: 'landscape', paperSize: 'letter',
    showPageBreaks: true,
    hideLeagueMatchups: false,
    watermarkEnabled: false, watermarkText: 'DRAFT', watermarkColor: '#CBD5E1', watermarkOpacity: 0.08,
    footerEnabled: false, footerText: ''
};

// =========================================================================
// MODULE STATE
// =========================================================================
var _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE);
var _savedTemplates = [];
var _activeView = 'division';
var _zoomLevel = 100;
var _isFullscreen = false;
var _advancedOpen = false;
var _inspectMode = false;
var _openPopover = null;
var _activePreset = 'classic';
var _activePack = null;
var _savedLayouts = []; // [{ id, name, preset, view, layout, selection (null = current at apply time), inspectMode }]

function loadSavedLayouts() {
    try {
        var raw = localStorage.getItem('campistry_pc3_layouts');
        _savedLayouts = raw ? JSON.parse(raw) : [];
    } catch (e) { _savedLayouts = []; }
}
function persistSavedLayouts() {
    try { localStorage.setItem('campistry_pc3_layouts', JSON.stringify(_savedLayouts)); } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────
// PRINT PACKS — outcome-oriented one-click workflows.
// A pack is a bundle: preset + view + layout flags + selection rule.
// Click a pack and the print center configures itself for that workflow.
// ─────────────────────────────────────────────────────────────────────────
var PRINT_PACKS = [
    {
        id: 'director',
        name: "Director's Pack",
        tagline: 'Master view of every division on one stack of pages.',
        icon: 'grid',
        preset: 'classic',
        view: 'division',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'landscape' },
        selection: 'all'
    },
    {
        id: 'parent-handout',
        name: 'Parent Handout',
        tagline: 'One clean page per division. No matchups, minimal styling.',
        icon: 'user',
        preset: 'minimal',
        view: 'division',
        layout: { tableOrientation: 'time-top', layoutMode: 'per-division', hideLeagueMatchups: true, orientation: 'portrait' },
        selection: 'all'
    },
    {
        id: 'per-bunk',
        name: 'Per-Bunk Sheets',
        tagline: 'One slip per bunk. Hand them out at line-up.',
        icon: 'user',
        preset: 'classic',
        view: 'bunk',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'portrait', pageBreakPerBunk: true },
        selection: 'all'
    },
    {
        id: 'counselor',
        name: 'Counselor Pack',
        tagline: 'Per-bunk sheets, big type — for staff at line-up.',
        icon: 'user',
        preset: 'bold',
        view: 'bunk',
        layout: { tableOrientation: 'time-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'portrait', pageBreakPerBunk: true, hideLocations: false },
        selection: 'all'
    },
    {
        id: 'week-stack',
        name: 'Week Pack (7 days)',
        tagline: 'Print Mon–Sun stacked. One page per day.',
        icon: 'grid',
        preset: 'classic',
        view: 'division',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'landscape', pageBreakPerBunk: false },
        selection: 'all',
        afterApply: function () { try { window._pc3PrintWeekStack && window._pc3PrintWeekStack(); } catch (e) { console.warn('week-stack failed', e); } }
    },
    {
        id: 'week-glance',
        name: 'Week At-A-Glance',
        tagline: 'One landscape page — every bunk, all 7 days.',
        icon: 'grid',
        preset: 'classic',
        view: 'week',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'per-division', hideLeagueMatchups: true, orientation: 'landscape', pageBreakPerBunk: false },
        selection: 'all'
    },
    {
        id: 'front-desk',
        name: 'Front Desk Pack',
        tagline: 'Big, scannable, all bunks on one wall.',
        icon: 'monitor',
        preset: 'bold',
        view: 'division',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'all-bunks', hideLeagueMatchups: false, orientation: 'landscape', pageBreakPerBunk: false },
        selection: 'all',
        afterApply: function () { try { window._pc3OpenLive && window._pc3OpenLive(); } catch (e) {} }
    },
    {
        id: 'location-roster',
        name: 'Facility Rosters',
        tagline: 'Who is on each facility (field, court, room) all day.',
        icon: 'mapPin',
        preset: 'classic',
        view: 'location',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'landscape' },
        selection: 'all'
    },
    {
        id: 'office-tv',
        name: 'Office TV',
        tagline: 'Dark theme, Live view, fullscreen.',
        icon: 'monitor',
        preset: 'dark',
        view: 'division',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'all-bunks', hideLeagueMatchups: false, orientation: 'landscape' },
        selection: 'all',
        afterApply: function () { try { window._pc3OpenLive && window._pc3OpenLive(); } catch (e) {} }
    },
    {
        id: 'leagues-only',
        name: 'Leagues Only',
        tagline: 'Just the leagues — for league directors and refs.',
        icon: 'grid',
        preset: 'bold',
        view: 'division',
        layout: { tableOrientation: 'time-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'landscape' },
        selection: 'all'
    }
];

// Style presets — Classic (default), Bold, Minimal, Dark.
// Each preset is a partial overlay applied on top of DEFAULT_TEMPLATE.
var STYLE_PRESETS = [
    {
        id: 'classic',
        name: 'Classic',
        description: 'Campistry teal header, soft grays.',
        swatch: ['#147D91', '#FFF8E1', '#EFF6FF'],
        overlay: {} // identity (DEFAULT_TEMPLATE is Classic)
    },
    {
        id: 'bold',
        name: 'Bold',
        description: 'Strong contrast, big type, dark grid header.',
        swatch: ['#0F172A', '#FBBF24', '#1E293B'],
        overlay: {
            headerBgColor: '#0F172A', headerTextColor: '#F8FAFC',
            headerFontSize: 28,
            gridFontSize: 13, gridBorderWidth: 2, gridBorderColor: '#334155',
            gridHeaderBgColor: '#1E293B', gridHeaderTextColor: '#F8FAFC',
            gridRowColor: '#FFFFFF', gridRowAltColor: '#F1F5F9',
            pinnedBgColor: '#FEF3C7', pinnedTextColor: '#78350F',
            leagueBgColor: '#DBEAFE', leagueTextColor: '#1E3A8A',
            timeColBgColor: '#1E293B', timeColTextColor: '#F1F5F9',
            cellPadding: 8
        }
    },
    {
        id: 'minimal',
        name: 'Minimal',
        description: 'No color, no alternating rows, generous whitespace.',
        swatch: ['#FFFFFF', '#F5F5F4', '#A8A29E'],
        overlay: {
            headerBgColor: '#FFFFFF', headerTextColor: '#0F172A',
            headerFontSize: 22,
            gridHeaderBgColor: '#FFFFFF', gridHeaderTextColor: '#44403C',
            gridBorderColor: '#F5F5F4', gridBorderWidth: 1,
            gridRowColor: '#FFFFFF', gridRowAltColor: '#FFFFFF',
            generalBgColor: '#FFFFFF', generalTextColor: '#1C1917',
            pinnedBgColor: '#FAFAF9', pinnedTextColor: '#44403C',
            leagueBgColor: '#FAFAF9', leagueTextColor: '#44403C',
            freeBgColor: '#FFFFFF', freeTextColor: '#A8A29E',
            timeColBgColor: '#FFFFFF', timeColTextColor: '#78716C',
            cellPadding: 10
        }
    },
    {
        id: 'dark',
        name: 'Dark',
        description: 'Bright on dark — for TV screens and dim rooms.',
        swatch: ['#0F172A', '#FBBF24', '#818CF8'],
        overlay: {
            headerBgColor: '#0F172A', headerTextColor: '#F8FAFC',
            headerFontSize: 24,
            gridHeaderBgColor: '#1E293B', gridHeaderTextColor: '#E2E8F0',
            gridBorderColor: '#334155',
            gridRowColor: '#0F172A', gridRowAltColor: '#1E293B',
            generalBgColor: '#1E293B', generalTextColor: '#E2E8F0',
            pinnedBgColor: '#422006', pinnedTextColor: '#FBBF24',
            leagueBgColor: '#1E1B4B', leagueTextColor: '#A5B4FC',
            freeBgColor: '#0F172A', freeTextColor: '#475569',
            timeColBgColor: '#1E293B', timeColTextColor: '#94A3B8'
        }
    }
];
var _previewHtml = '';
var _cloudSyncTimeout = null;
var _liveInterval = null;
var _liveCursorInterval = null;
var _liveWindow = null;
var _livePageIndex = 0;
var _numLivePages = 1;
var _livePageTimer = null;
var _LIVE_PAGE_MS = 20000; // ms between page rotations
var _timeIncrement = 15; // minutes: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60
// ★ Day 22.5+ Print Center reinvention — activity-aligned columns, per-bunk page breaks,
//   content toggles. These are persisted via localStorage so the user's setup survives
//   page reloads. Defaults bias toward "looks good on paper out-of-the-box".
var _activityAligned = true;   // true → columns sized by activity duration (no fixed grid)
var _hideDurations = false;    // hide the "50m" duration line under activity titles
var _hideLocations = false;    // hide "vs Bunk Name" / "(Location)" supplementary text
var _pageBreakPerBunk = true;  // print: each bunk on its own page in Bunks view
var _sidebarCollapsed = false; // collapsible left sidebar for max preview width
var _highlightGaps = false;    // visually flag Free cells (coverage gaps overlay)
var _colorByCategory = false;  // tint cells by category (league/special/general/free)
var _quickFilter = 'all';      // 'all' | 'leagues' | 'specials' | 'general' | 'free' — dim non-matching cells

// Week View — at-a-glance Mon-Sun grid pulling from cloud.
//   _weekData: { [dateKey]: { scheduleAssignments, leagueAssignments } | null }
//   _weekAnchor: the Monday (date key) of the week being shown
//   _weekLoading: true while async fetch in progress
var _weekData = {};
var _weekAnchor = null;
var _weekLoading = false;
var CLOUD_SYNC_DEBOUNCE = 2000;

// Excel-style cell selection state
var _selAnchor = null;   // {sheet, r, c}
var _selFocus  = null;   // {sheet, r, c}
var _activeSheet = null; // table element id of currently focused sheet

// =========================================================================
// UTILITY HELPERS
// =========================================================================
function el(id) { return document.getElementById(id); }
function escHtml(s) { return window.CampUtils.escapeHtml(s); }  // → campistry_utils.js (canonical; now also escapes quotes → closes attr-context gap)
function parseTimeToMinutes(t) { return window.CampUtils.parseTimeToMinutes(t); }  // → campistry_utils.js (canonical superset; handles num/Date/am-pm, harness-proven)
function minutesToTimeLabel(mins) { return window.CampUtils.minutesToTimeLabel(mins); }  // → campistry_utils.js (canonical; identical for valid input)
function naturalSort(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
function formatDisplayDate(dateStr) {
    if (!dateStr) return '';
    try { var d = new Date(dateStr + 'T12:00:00'); return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return dateStr; }
}
function fontOptions(sel) {
    return FONTS.map(function (f) { return '<option value="' + f + '"' + (f === sel ? ' selected' : '') + '>' + f + '</option>'; }).join('');
}
function getNowMinutes() {
    var now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

// Excel-style coordinate helpers
function colLetter(c) {
    var s = ''; var n = c + 1;
    while (n > 0) {
        var rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}
function cellId(r, c) { return colLetter(c) + (r + 1); }

// ── Week View helpers ──────────────────────────────────────────────────
// Build the 7 dateKeys (Mon-Sun) of the week containing the given date.
function getWeekDateKeys(anchorDateStr) {
    if (!anchorDateStr) return [];
    var d = new Date(anchorDateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return [];
    // Roll back to Monday (Mon=1..Sun=0 in JS; we want week to start Monday)
    var dow = d.getDay();
    var offsetToMon = (dow === 0) ? -6 : (1 - dow);
    d.setDate(d.getDate() + offsetToMon);
    var keys = [];
    for (var i = 0; i < 7; i++) {
        var dd = new Date(d.getTime());
        dd.setDate(d.getDate() + i);
        var yyyy = dd.getFullYear();
        var mm = String(dd.getMonth() + 1).padStart(2, '0');
        var dy = String(dd.getDate()).padStart(2, '0');
        keys.push(yyyy + '-' + mm + '-' + dy);
    }
    return keys;
}
function formatWeekDayLabel(dateStr) {
    if (!dateStr) return '';
    try {
        var d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    } catch (e) { return dateStr; }
}
// Kick off async fetch of all 7 days for the current week, then refresh.
// Uses window.ScheduleDB.loadSchedule under the hood (cloud-or-local).
function ensureWeekDataLoaded(force) {
    var anchor = window.currentScheduleDate;
    if (!anchor) return;
    var keys = getWeekDateKeys(anchor);
    if (!keys.length) return;
    var weekId = keys[0];
    if (!force && _weekAnchor === weekId && Object.keys(_weekData).length === 7) {
        // ★★★ CB-78: the anchor (current) day's slot was a point-in-time snapshot of
        // window.scheduleAssignments taken at view-open. An in-session regen/edit
        // updates memory but this cache guard kept the STALE snapshot the whole
        // session. Refresh just the anchor slot from live memory before the
        // early-return — guarded by the _scheduleAssignmentsDate coherence stamp so
        // a navigated-away memory never overwrites the anchor slot with wrong data.
        if (anchor && _weekData[anchor] && window._scheduleAssignmentsDate === anchor) {
            _weekData[anchor] = { scheduleAssignments: window.scheduleAssignments || {}, leagueAssignments: window.leagueAssignments || {} };
        }
        return;
    }
    _weekAnchor = weekId;
    _weekData = {};
    _weekLoading = true;
    if (!window.ScheduleDB || typeof window.ScheduleDB.loadSchedule !== 'function') {
        // No cloud API available — at least show today's data in its slot
        keys.forEach(function (k) {
            _weekData[k] = (k === anchor) ? { scheduleAssignments: window.scheduleAssignments || {}, leagueAssignments: window.leagueAssignments || {} } : null;
        });
        _weekLoading = false;
        if (_activeView === 'week') liveRefresh();
        return;
    }
    var remaining = keys.length;
    keys.forEach(function (k) {
        // For the currently-loaded date, use in-memory data directly to avoid an async hop.
        if (k === anchor) {
            _weekData[k] = { scheduleAssignments: window.scheduleAssignments || {}, leagueAssignments: window.leagueAssignments || {} };
            remaining--;
            if (remaining === 0) { _weekLoading = false; if (_activeView === 'week') liveRefresh(); }
            return;
        }
        try {
            window.ScheduleDB.loadSchedule(k).then(function (res) {
                _weekData[k] = (res && res.success && res.data) ? res.data : null;
            }).catch(function () { _weekData[k] = null; }).finally(function () {
                remaining--;
                if (remaining === 0) { _weekLoading = false; if (_activeView === 'week') liveRefresh(); }
            });
        } catch (e) {
            _weekData[k] = null;
            remaining--;
            if (remaining === 0) { _weekLoading = false; if (_activeView === 'week') liveRefresh(); }
        }
    });
}
// Summarize a bunk's day as a short list of activity labels.
function summarizeBunkDay(scheduleAssignments, bunk) {
    if (!scheduleAssignments || !scheduleAssignments[bunk]) return [];
    var labels = [];
    var seen = {};
    (scheduleAssignments[bunk] || []).forEach(function (entry) {
        if (!entry || entry.continuation) return;
        var act = entry._activity || entry.sport || entry.activity || '';
        if (!act || act === 'Free' || act === 'Transition' || act === 'Change' || act === 'Cleanup' || act === 'Lineup') return;
        if (seen[act]) return;
        seen[act] = 1;
        labels.push(act);
    });
    return labels;
}

// =========================================================================
// DATA HELPERS
// =========================================================================
function getBuilderMode() {
    return (window.getCampBuilderMode ? window.getCampBuilderMode() : null) || window._daBuilderMode || 'manual';
}

function isAutoMode() {
    return getBuilderMode() === 'auto';
}

function getSkeleton() {
    // ★ The per-date Daily-Adjustments board is authoritative for what's actually on a
    //   given day — read it BY DATE first, exactly like loadDailySkeleton + the unified
    //   view (campManualSkeleton_<date> -> app1.dailySkeletons[date]). Previously the
    //   volatile window.manualSkeleton / loadCurrentDailyData().manualSkeleton (which the
    //   Master Scheduler overwrites with the day-of-week TEMPLATE when that page loads)
    //   could win — leaking the template's league/other tiles into the print for a date
    //   that doesn't have them, while unified (reading the per-date board) showed only the
    //   real tiles. Fixes "print center shows league tiles that aren't in Daily Adjustments".
    var _dk = window.currentScheduleDate;
    if (_dk) {
        try { var _raw = localStorage.getItem('campManualSkeleton_' + _dk); if (_raw) { var _p = JSON.parse(_raw); if (Array.isArray(_p) && _p.length) return _p; } } catch (e) { }
        try { var _ms = window.loadGlobalSettings ? window.loadGlobalSettings() : null; var _c = _ms && _ms.app1 && _ms.app1.dailySkeletons ? _ms.app1.dailySkeletons[_dk] : null; if (Array.isArray(_c) && _c.length) return _c; } catch (e) { }
    }
    var daily = (window.loadCurrentDailyData ? window.loadCurrentDailyData() : null) || {};
    var sk = daily.manualSkeleton || daily.skeleton || window.dailyOverrideSkeleton || window.manualSkeleton || window.skeleton || [];
    if (!sk.length) { try { var dk = window.currentScheduleDate; var s = dk ? localStorage.getItem('campManualSkeleton_' + dk) : null; if (s) sk = JSON.parse(s) || []; } catch (e) { } }
    if (!sk.length) { try { var dk2 = window.currentScheduleDate; var ms = window.loadGlobalSettings ? window.loadGlobalSettings() : null; var c = ms && ms.app1 && ms.app1.dailySkeletons ? ms.app1.dailySkeletons[dk2] : null; if (c && c.length) sk = c; } catch (e) { } }
    return sk;
}

function getDivisions() {
    return window.divisions || (window.loadGlobalSettings ? (window.loadGlobalSettings().app1 || {}).divisions : null) || {};
}

function getAvailableDivisions() {
    var a1 = (window.loadGlobalSettings ? window.loadGlobalSettings().app1 : null) || {};
    return window.availableDivisions || a1.availableDivisions || Object.keys(getDivisions());
}

function getAssignments() {
    return window.scheduleAssignments || ((window.loadCurrentDailyData ? window.loadCurrentDailyData() : {}).scheduleAssignments) || {};
}

function getEntry(bunk, slotIdx) {
    var aa = getAssignments();
    return (aa[bunk] && aa[bunk][slotIdx]) ? aa[bunk][slotIdx] : null;
}

/**
 * Read the bell schedule (DAW layers) for a division.
 * Follows the same priority chain as daily_adjustments.js loadDAAutoLayers:
 *   1. Date-specific layers in localStorage (campAutoLayers_<date>)
 *   2. Date-specific layers in cloud (app1.dailyAutoLayers[date])
 *   3. Template assigned to today's day-of-week (skeletonAssignments → autoLayerTemplates)
 *   4. '_current' draft template
 * Returns the layer array for the requested division, or null.
 */
function getBellScheduleLayers(divName) {
    try {
        var dateKey = window.currentScheduleDate || '';
        var layers = null;

        // Priority 1: Date-specific localStorage
        try {
            var stored = localStorage.getItem('campAutoLayers_' + dateKey);
            if (stored) {
                var parsed = JSON.parse(stored);
                if (parsed && parsed[divName] && parsed[divName].length > 0) {
                    return parsed[divName];
                }
                if (parsed && parsed[String(divName)] && parsed[String(divName)].length > 0) {
                    return parsed[String(divName)];
                }
            }
        } catch (e) { /* ignore */ }

        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : null;
        if (!g || !g.app1) return null;

        // Priority 2: Date-specific cloud
        var cloudLayers = g.app1.dailyAutoLayers;
        if (cloudLayers && cloudLayers[dateKey]) {
            var dayLayers = cloudLayers[dateKey];
            if (dayLayers[divName] && dayLayers[divName].length > 0) return dayLayers[divName];
            if (dayLayers[String(divName)] && dayLayers[String(divName)].length > 0) return dayLayers[String(divName)];
        }

        // Priority 3: Template for today's day-of-week
        var autoTemplates = g.app1.autoLayerTemplates || {};
        var assignments = (window.getSkeletonAssignments ? window.getSkeletonAssignments() : null) || g.app1.skeletonAssignments || {};
        var dow = 0;
        if (dateKey) {
            var parts = dateKey.split('-').map(Number);
            if (parts[0] && parts[1] && parts[2]) dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
        }
        var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        var tmplName = assignments[dayNames[dow]] || assignments['Default'];

        var tmpl = null;
        if (tmplName && autoTemplates[tmplName]) tmpl = autoTemplates[tmplName];
        else if (autoTemplates['_current']) tmpl = autoTemplates['_current'];

        if (tmpl) {
            if (tmpl[divName] && tmpl[divName].length > 0) return tmpl[divName];
            if (tmpl[String(divName)] && tmpl[String(divName)].length > 0) return tmpl[String(divName)];
        }

        return null;
    } catch (e) {
        return null;
    }
}

// ★ Build a Set of special activity names so we can exclude them from sharers.
function _pcSpecialNamesSet() {
    var out = {};
    try {
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        var specials = (g.app1 && g.app1.specialActivities) || [];
        for (var i = 0; i < specials.length; i++) {
            if (specials[i] && specials[i].name) {
                out[String(specials[i].name).toLowerCase().trim()] = true;
            }
        }
    } catch (e) { /* ignore */ }
    return out;
}

// ★ Find OTHER bunks (any division) that share this bunk's field at this time.
//   Sports only — pinned events, electives, leagues, transitions, and configured
//   special activities (Gameroom, Canteen, Arts & Crafts, etc.) are skipped.
function pcFindFieldSharers(bunk, slotIdx, divName) {
    var myEntry = window.scheduleAssignments && window.scheduleAssignments[bunk] && window.scheduleAssignments[bunk][slotIdx];
    if (!myEntry) return [];
    if (myEntry._swimElective || myEntry._isTransition || myEntry.continuation) return [];
    if (myEntry._h2h || myEntry._isSpecialtyLeague || myEntry._allMatchups) return [];
    if (myEntry._isDismissal || myEntry._isSnack) return [];
    if (myEntry._pinned) return [];
    var _myAct = (myEntry._activity || myEntry.sport || '').toLowerCase().trim();
    var _myField = (typeof myEntry.field === 'string' ? myEntry.field
        : (myEntry.field && myEntry.field.name) || '').toLowerCase().trim();
    var NON_SPORTS = ['swim', 'pool', 'swimming', 'lunch', 'snacks', 'snack',
                      'dismissal', 'change', 'free', 'free play', 'free time', 'rest',
                      'regroup', 'flagpole', 'assembly', 'davening', 'shacharis', 'mincha',
                      'maariv', 'tefillah', 'learning', 'shiur'];
    for (var ni = 0; ni < NON_SPORTS.length; ni++) {
        if (_myAct === NON_SPORTS[ni] || _myAct.indexOf(NON_SPORTS[ni]) !== -1) return [];
    }
    var _specials = _pcSpecialNamesSet();
    if (_specials[_myAct] || _specials[_myField]) return [];
    var myField = (typeof myEntry.field === 'string') ? myEntry.field
        : (myEntry.field && myEntry.field.name ? myEntry.field.name : '');
    if (!myField) return [];
    var myFieldKey = myField.toLowerCase().trim();
    // ★★★ CB-80: resolve the slot time from the BUNK's per-bunk geometry, not the
    // division-level table indexed by the per-bunk slotIdx (auto mode they
    // diverge → wrong/missing "vs Bunk" sharer annotations). _resolveSlotArray
    // (CB-73) returns the bunk's _perBunkSlots, falling back to the division array.
    var _mySlots80 = (window.SchedulerCoreUtils && window.SchedulerCoreUtils._resolveSlotArray)
        ? window.SchedulerCoreUtils._resolveSlotArray(bunk)
        : ((window.divisionTimes && window.divisionTimes[divName]) || []);
    var mySlot = _mySlots80[slotIdx];
    if (!mySlot || mySlot.startMin == null) return [];
    var myStart = mySlot.startMin, myEnd = mySlot.endMin;
    var sharers = [];
    var seen = {};
    var allBunks = window.scheduleAssignments || {};
    for (var otherBunk in allBunks) {
        if (otherBunk === bunk || seen[otherBunk]) continue;
        var otherDiv = (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDivisionForBunk)
            ? window.SchedulerCoreUtils.getDivisionForBunk(otherBunk)
            : ((window.DivisionTimesSystem && window.DivisionTimesSystem.getDivisionForBunk)
                ? window.DivisionTimesSystem.getDivisionForBunk(otherBunk) : null);
        // ★★★ CB-80: per-bunk slot times for the OTHER bunk too, so its per-bunk
        // entry index maps to the right window (else cross-division share overlap
        // is computed against the wrong times).
        var otherSlots = (window.SchedulerCoreUtils && window.SchedulerCoreUtils._resolveSlotArray)
            ? window.SchedulerCoreUtils._resolveSlotArray(otherBunk)
            : ((window.divisionTimes && window.divisionTimes[otherDiv]) || []);
        var otherEntries = allBunks[otherBunk] || [];
        for (var si = 0; si < otherSlots.length; si++) {
            var oslot = otherSlots[si];
            if (!oslot || oslot.startMin == null) continue;
            if (oslot.startMin >= myEnd || oslot.endMin <= myStart) continue;
            var oentry = otherEntries[si];
            if (!oentry || oentry.continuation) continue;
            var ofield = (typeof oentry.field === 'string') ? oentry.field
                : (oentry.field && oentry.field.name ? oentry.field.name : '');
            if (!ofield) continue;
            if (ofield.toLowerCase().trim() === myFieldKey) {
                sharers.push(otherBunk);
                seen[otherBunk] = true;
                break;
            }
        }
    }
    if (typeof naturalSort === 'function') sharers.sort(naturalSort);
    else sharers.sort();
    return sharers;
}

function formatEntry(entry) {
    if (!entry) return '';
    if (entry.continuation) return '';
    if (entry._isTransition) return entry.sport || 'Transition';
    // ★ Swim + Elective hybrid: list "Swim" + each reserved elective field.
    if (entry._swimElective) {
        var sePoolLc = (entry._swimLocation || '').toLowerCase().trim();
        var seActs = (entry._electiveActivities && entry._electiveActivities.length)
            ? entry._electiveActivities
            : (entry._reservedFields || entry.reservedFields || []);
        var seFiltered = seActs.filter(function (a) { return (a || '').toLowerCase().trim() !== sePoolLc; });
        return ['Swim'].concat(seFiltered).join(', ');
    }
    var parts = [];
    var act = entry._activity || entry.sport || '';
    var label = entry._partLabel || act; // \u2605 Day 19: show "Baking 1/3" for multiPart specials
    // ★ Custom/pinned tile with specific fields → list every reserved field
    //   ("Field 1, Field 2"), matching the unified grid. Skip swim+elective
    //   (handled above); otherwise fall back to the entry's single field.
    var field;
    if (!entry._swimElective && Array.isArray(entry._reservedFields) && entry._reservedFields.filter(Boolean).length) {
        field = entry._reservedFields.filter(Boolean).join(', ');
    } else {
        field = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
    }
    if (act && field && act !== field && field.indexOf(act) === -1 && act.indexOf(field) === -1) {
        parts.push(label); parts.push(field);
    } else if (field) { parts.push(entry._partLabel ? label : field); }
    else if (act) { parts.push(label); }
    return parts.join(' \u2013 ');
}

function getEntryType(entry) {
    if (!entry) return 'free';
    if (entry._isTransition) return 'transition';
    if (entry._league || entry._h2h) return 'league';
    if (entry._pinned || entry._fixed) return 'pinned';
    return 'general';
}

function findFirstSlotForTime(startMin, divName) {
    if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.findFirstSlotForTime)
        return window.SchedulerCoreUtils.findFirstSlotForTime(startMin, divName);
    var divSlots = window.divisionTimes && window.divisionTimes[divName] ? window.divisionTimes[divName] : (window.unifiedTimes || []);
    for (var i = 0; i < divSlots.length; i++) {
        var s = divSlots[i];
        var sm = s.startMin !== undefined ? s.startMin : (s.start ? (new Date(s.start).getHours() * 60 + new Date(s.start).getMinutes()) : null);
        if (sm === startMin) return i;
    }
    return -1;
}

// =========================================================================
// ★★★ AUTO MODE: Per-Bunk Data Builder ★★★
// In auto mode, each bunk can have its own unique set of time slots
// =========================================================================
function getPerBunkSchedule(bunk, divName) {
    var perBunkSlots = window.divisionTimes && window.divisionTimes[divName] && window.divisionTimes[divName]._perBunkSlots
        ? window.divisionTimes[divName]._perBunkSlots[String(bunk)] : null;

    if (!perBunkSlots || perBunkSlots.length === 0) {
        // Fallback to division-level slots
        var divSlots = window.divisionTimes && window.divisionTimes[divName] ? window.divisionTimes[divName] : [];
        return divSlots.map(function (s, i) {
            return { startMin: s.startMin, endMin: s.endMin, event: s.event, type: s.type, slotIndex: i, label: minutesToTimeLabel(s.startMin) + ' \u2013 ' + minutesToTimeLabel(s.endMin) };
        });
    }

    return perBunkSlots.map(function (s, i) {
        return {
            startMin: s.startMin, endMin: s.endMin,
            event: s.event || 'GA', type: s.type || 'slot',
            slotIndex: i,
            label: minutesToTimeLabel(s.startMin) + ' \u2013 ' + minutesToTimeLabel(s.endMin)
        };
    });
}

// =========================================================================
// ★★★ Helper: render a cell with optional Change → Swim → Change subdivision
// Returns just the inner HTML (without <td>...</td>); caller wraps it.
// =========================================================================
function pcCellInnerHtml(text, type, opts) {
    opts = opts || {};
    var preMin = opts.preChange || 0;
    var postMin = opts.postChange || 0;
    var pillBg = type === 'pinned' ? '#FFF8E1' : type === 'league' ? '#EFF6FF' : type === 'free' ? '#F9FAFB' : '#EEF6FF';
    var pillTx = type === 'pinned' ? '#92400E' : type === 'league' ? '#1E40AF' : type === 'free' ? '#94A3B8' : '#1E3A5F';
    if (preMin > 0 || postMin > 0) {
        var html = '<div style="border-radius:5px;overflow:hidden;display:flex;flex-direction:column;">';
        if (preMin > 0) {
            html += '<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;text-align:center;font-size:10px;font-weight:600;border-bottom:1px solid #F59E0B;">Change ' + preMin + 'm</div>';
        }
        html += '<div style="background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;text-align:center;flex:1;">';
        html += '<span style="font-size:11px;font-weight:500;">' + escHtml(text) + '</span>';
        html += '</div>';
        if (postMin > 0) {
            html += '<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;text-align:center;font-size:10px;font-weight:600;border-top:1px solid #F59E0B;">Change ' + postMin + 'm</div>';
        }
        html += '</div>';
        return html;
    }
    return escHtml(text);
}

// =========================================================================
// ★★★ MANUAL MODE: Division Block Builder ★★★
// In manual mode, all bunks in a division share the same time slots
// =========================================================================
function buildDivisionBlocks(divName) {
    var skeleton = getSkeleton(), sorted = [];
    skeleton.forEach(function (item) {
        if (item.division === divName) {
            var s = parseTimeToMinutes(item.startTime), e = parseTimeToMinutes(item.endTime);
            if (s !== null && e !== null) sorted.push({ item: item, startMin: s, endMin: e });
        }
    });
    sorted.sort(function (a, b) { return a.startMin - b.startMin; });

    var divs = getDivisions();
    var divBunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).slice();
    var lc = 0, sc2 = 0;
    var blocks = [];
    var la = window.leagueAssignments || {};
    var divKey = divName;

    sorted.forEach(function (bl) {
        var evName = bl.item.event || bl.item.type || '';
        var isLeagueBlock = (bl.item.type === 'league' || bl.item.type === 'specialty_league' || evName === 'League Game' || evName === 'Specialty League' || (typeof window.isConfiguredLeagueName === 'function' && window.isConfiguredLeagueName(evName)));
        var ev = evName;
        if (isLeagueBlock) {
            var isSpecialty = (bl.item.type === 'specialty_league' || evName === 'Specialty League');
            var divLA = la[divKey] || {};
            var slotIdx = findFirstSlotForTime(bl.startMin, divName);
            var foundLabel = null;
            var trySlots = slotIdx >= 0 ? [slotIdx] : [];
            for (var off = 1; off <= 2; off++) { trySlots.push(slotIdx + off, slotIdx - off); }
            trySlots.push(bl.startMin);
            for (var off2 = 1; off2 <= 2; off2++) { trySlots.push(bl.startMin + off2, bl.startMin - off2); }
            for (var ts = 0; ts < trySlots.length && !foundLabel; ts++) {
                var sd = divLA[trySlots[ts]];
                if (sd && sd.gameLabel) foundLabel = sd.gameLabel;
            }
            if (foundLabel) { ev = foundLabel; }
            else { if (isSpecialty) { sc2++; ev = 'Specialty League ' + sc2; } else { lc++; ev = 'League Game ' + lc; } }
        }
        // \u2605 Split-tile expansion: split items become TWO half-blocks so each
        // half renders its own per-bunk activity. Each half-block carries
        // _splitHalf so render code can find the correct slot.
        if (bl.item.type === 'split') {
            var midMin = Math.floor((bl.startMin + bl.endMin) / 2);
            blocks.push({
                label: minutesToTimeLabel(bl.startMin) + ' \u2013 ' + minutesToTimeLabel(midMin),
                startMin: bl.startMin, endMin: midMin,
                event: ev, type: 'split_half', isLeague: false,
                _splitHalf: 1, _splitParent: ev,
                _preChangeMin: bl.item._preChangeMin || 0,
                _postChangeMin: bl.item._postChangeMin || 0
            });
            blocks.push({
                label: minutesToTimeLabel(midMin) + ' \u2013 ' + minutesToTimeLabel(bl.endMin),
                startMin: midMin, endMin: bl.endMin,
                event: ev, type: 'split_half', isLeague: false,
                _splitHalf: 2, _splitParent: ev,
                _preChangeMin: bl.item._preChangeMin || 0,
                _postChangeMin: bl.item._postChangeMin || 0
            });
        } else {
            blocks.push({
                label: minutesToTimeLabel(bl.startMin) + ' \u2013 ' + minutesToTimeLabel(bl.endMin),
                startMin: bl.startMin, endMin: bl.endMin,
                event: ev, type: bl.item.type, isLeague: isLeagueBlock
            });
        }
    });

    // Dedup by startMin
    var unique = blocks.filter(function (b, i, s) {
        return i === s.findIndex(function (t2) { return t2.startMin === b.startMin && t2.endMin === b.endMin; });
    });

    // Trim after last Dismissal
    var lastDismissalIdx = -1;
    for (var di = unique.length - 1; di >= 0; di--) {
        if ((unique[di].event || '').toLowerCase().indexOf('dismissal') >= 0) { lastDismissalIdx = di; break; }
    }
    if (lastDismissalIdx >= 0 && lastDismissalIdx < unique.length - 1) {
        unique = unique.slice(0, lastDismissalIdx + 1);
    }
    return unique;
}

// =========================================================================
// LEAGUE MATCHUP BUILDER
// =========================================================================
// Returns { label, matchups: [string] } for a league happening at divName/startMin,
// or null if no league. Looks at leagueAssignments first, then falls back to a per-bunk entry probe.
function pcLeagueInfoAt(divName, startMin) {
    if (!divName || startMin == null) return null;
    var la = window.leagueAssignments || {};
    var divLA = la[divName] || {};
    var slotIdx = findFirstSlotForTime(startMin, divName);
    var entry = null;
    var keys = [slotIdx, String(slotIdx), startMin, String(startMin)];
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k != null && divLA[k]) { entry = divLA[k]; break; }
    }
    // Also try +/- 2 slot tolerance (some pipelines store at slightly different keys)
    if (!entry && slotIdx >= 0) {
        for (var off = 1; off <= 2; off++) {
            if (divLA[slotIdx + off]) { entry = divLA[slotIdx + off]; break; }
            if (divLA[slotIdx - off]) { entry = divLA[slotIdx - off]; break; }
        }
    }
    if (!entry) return null;
    var label = entry.gameLabel || entry.leagueName || 'League Game';
    var matchups = [];
    (entry.matchups || []).forEach(function (m) {
        if (typeof m === 'string') matchups.push(m);
        else if (m.display) matchups.push(m.display);
        else {
            var tA = m.teamA || m.team1 || '', tB = m.teamB || m.team2 || '';
            if (tA && tB) {
                var s = tA + ' vs ' + tB;
                if (m.sport) s += ' – ' + (m.sport.charAt(0).toUpperCase() + m.sport.slice(1));
                if (m.field) s += ' (' + m.field + ')';
                matchups.push(s);
            }
        }
    });
    return { label: label, matchups: matchups };
}

function buildLeagueMatchups(eventBlock, divName) {
    var matchups = [];
    var la = window.leagueAssignments || {};
    var divLA = la[divName] || {};

    var slotIdx = findFirstSlotForTime(eventBlock.startMin, divName);
    var allSlotEntries = [];
    Object.keys(divLA).forEach(function (k) {
        var slotData = divLA[k];
        if (!slotData) return;
        var sk = parseInt(k);
        if ((slotIdx >= 0 && Math.abs(sk - slotIdx) <= 2) || Math.abs(sk - eventBlock.startMin) <= 2) {
            var dist = slotIdx >= 0 ? Math.abs(sk - slotIdx) : Math.abs(sk - eventBlock.startMin);
            allSlotEntries.push({ key: k, data: slotData, dist: dist });
        }
    });
    allSlotEntries.sort(function(a, b) { return a.dist - b.dist; });

    if (allSlotEntries.length > 0) {
        var bestEntry = allSlotEntries[0].data;
        if (bestEntry && bestEntry.matchups) {
            bestEntry.matchups.forEach(function (m) {
                var desc = '';
                if (typeof m === 'string') { desc = m; }
                else if (m.display) { desc = m.display; }
                else {
                    var tA = m.teamA || m.team1 || '', tB = m.teamB || m.team2 || '';
                    if (tA && tB) {
                        desc = tA + ' vs ' + tB;
                        if (m.sport || m.field) desc += ' \u2013 ';
                        if (m.sport) desc += m.sport.charAt(0).toUpperCase() + m.sport.slice(1);
                        if (m.field) desc += ' (' + m.field + ')';
                    } else if (m.matchup) { desc = m.matchup; }
                }
                if (desc) matchups.push(desc);
            });
        }
    }

    // Fallback: lastLeagueMatchups
    if (!matchups.length) {
        var llm = window.lastLeagueMatchups;
        if (llm && llm[divName] && llm[divName].matchups) {
            llm[divName].matchups.forEach(function (m5) {
                var d5 = '';
                if (typeof m5 === 'string') d5 = m5;
                else d5 = m5.display || ((m5.teamA || '') + ' vs ' + (m5.teamB || ''));
                if (d5) matchups.push(d5);
            });
        }
    }
    return matchups;
}

// =========================================================================
// TEMPLATE PERSISTENCE
// =========================================================================
function loadTemplates() {
    try {
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        if (g.printTemplates && g.printTemplates.length) { _savedTemplates = g.printTemplates; return; }
        var r = localStorage.getItem('campistry_print_templates');
        if (r) { _savedTemplates = JSON.parse(r); return; }
    } catch (e) { }
    _savedTemplates = [];
}
function saveTemplates() {
    if (!canEditTemplates()) return false;
    try {
        localStorage.setItem('campistry_print_templates', JSON.stringify(_savedTemplates));
        if (window.saveGlobalSettings) window.saveGlobalSettings('printTemplates', _savedTemplates);
        clearTimeout(_cloudSyncTimeout);
        _cloudSyncTimeout = setTimeout(function () { if (window.forceSyncToCloud) window.forceSyncToCloud(); }, CLOUD_SYNC_DEBOUNCE);
        return true;
    } catch (e) { return false; }
}
function saveCurrentAsTemplate(name) {
    if (!canEditTemplates()) return false;
    var tpl = JSON.parse(JSON.stringify(_currentTemplate));
    tpl.id = 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    tpl.name = name || 'Untitled'; tpl.isDefault = false;
    tpl.createdAt = new Date().toISOString(); tpl.updatedAt = new Date().toISOString();
    _savedTemplates.push(tpl); saveTemplates(); return tpl;
}
function updateTemplate(tid) {
    if (!canEditTemplates()) return false;
    var idx = _savedTemplates.findIndex(function (t) { return t.id === tid; });
    if (idx === -1) return false;
    var t2 = JSON.parse(JSON.stringify(_currentTemplate));
    t2.id = tid; t2.name = _savedTemplates[idx].name; t2.isDefault = false;
    t2.createdAt = _savedTemplates[idx].createdAt; t2.updatedAt = new Date().toISOString();
    _savedTemplates[idx] = t2; saveTemplates(); return true;
}
function deleteTemplate(tid) { if (!canEditTemplates()) return false; /* ★ CB-100: gate like sibling mutators (saveTemplates/saveCurrentAsTemplate/updateTemplate) — without it a scheduler's "delete" mutated _savedTemplates + returned true while saveTemplates() silently no-op'd the persist, so the template reappeared on next load */ _savedTemplates = _savedTemplates.filter(function (t) { return t.id !== tid; }); saveTemplates(); return true; }
function loadTemplate(tid) {
    if (tid === 'default') _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE);
    else { _savedTemplates.forEach(function (t) { if (t.id === tid) _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE, JSON.parse(JSON.stringify(t))); }); }
    liveRefresh(); renderTemplateDropdown();
}
function canEditTemplates() {
    if (window.AccessControl && window.AccessControl.isOwner && window.AccessControl.isOwner()) return true;
    if (window.AccessControl && window.AccessControl.isAdmin && window.AccessControl.isAdmin()) return true;
    var role = (window.CloudPermissions && window.CloudPermissions.getRole ? window.CloudPermissions.getRole() : '') || localStorage.getItem('campistry_role') || 'viewer';
    return role === 'owner' || role === 'admin';
}

// =========================================================================
// STYLES (injected into container)
// =========================================================================
function getStyles() {
    return '<style id="pc-styles">' +
    /* ── Override the global .tab-content chrome so the print center can use the full viewport ── */
    '#print.tab-content{padding:0!important;margin:0!important;border:none!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;height:calc(100vh - 84px);min-height:600px;}' +
    '#print-content{height:100%;}' +
    /* ── Container ── */
    '.pc3{font-family:"DM Sans",system-ui,sans-serif;font-size:13px;color:#0f172a;display:flex;flex-direction:column;height:100%;min-height:0;background:#fafaf9;position:relative;}' +
    '.pc3.pc3-fullscreen{position:fixed;inset:0;z-index:9999;background:#fafaf9;}' +

    /* ── Hero header ── */
    '.pc3-hero{display:flex;align-items:center;gap:18px;padding:10px 18px;background:#fff;border-bottom:1px solid #e7e5e4;flex-shrink:0;}' +
    '.pc3-hero-title-block{flex:1;min-width:0;}' +
    '.pc3-hero h1{margin:0;font-size:18px;font-weight:700;letter-spacing:-.01em;color:#0f172a;line-height:1.2;}' +
    '.pc3-hero-meta{font-size:11px;color:#78716c;font-weight:500;display:flex;align-items:center;gap:6px;margin-top:1px;}' +
    '.pc3-hero-meta-dot{width:3px;height:3px;border-radius:50%;background:#a8a29e;}' +
    '.pc3-hero-mode{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:99px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;}' +
    '.pc3-hero-mode.auto{background:#eff6ff;color:#1d4ed8;}' +
    '.pc3-hero-mode.manual{background:#f0fdf4;color:#15803d;}' +
    '.pc3-hero-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}' +
    '.pc3-hero-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid #e7e5e4;border-radius:7px;background:#fff;color:#1c1917;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,box-shadow .15s,transform .05s;}' +
    '.pc3-hero-btn:hover{background:#fafaf9;border-color:#d6d3d1;}' +
    '.pc3-hero-btn:active{transform:translateY(1px);}' +
    '.pc3-hero-btn.primary{background:#147D91;color:#fff;border-color:#0F6E80;box-shadow:0 1px 2px rgba(15,110,128,.2);}' +
    '.pc3-hero-btn.primary:hover{background:#10657a;border-color:#0a5566;}' +
    '.pc3-hero-btn.live-on{background:#dc2626;color:#fff;border-color:#b91c1c;}' +
    '.pc3-hero-btn.live-on:hover{background:#b91c1c;}' +
    '.pc3-hero-btn .pc3-live-dot{width:7px;height:7px;border-radius:50%;background:#fff;animation:pc3-pulse-dot 1.6s infinite;}' +
    '@keyframes pc3-pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}' +
    '.pc3-hero-icon-btn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid #e7e5e4;border-radius:7px;background:#fff;color:#57534e;cursor:pointer;transition:background .15s,border-color .15s;}' +
    '.pc3-hero-icon-btn:hover{background:#fafaf9;border-color:#d6d3d1;color:#1c1917;}' +

    /* ── Tab bar ── */
    '.pc3-tabbar{display:flex;align-items:center;gap:24px;padding:0 18px;background:#fff;border-bottom:1px solid #e7e5e4;flex-shrink:0;flex-wrap:wrap;}' +
    '.pc3-tabs{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}' +
    '.pc3-tab{position:relative;padding:10px 14px;margin:0;border:none;background:transparent;color:#78716c;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:color .15s;white-space:nowrap;}' +
    '.pc3-tab:hover{color:#1c1917;}' +
    '.pc3-tab.active{color:#147D91;}' +
    '.pc3-tab.active::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:#147D91;border-radius:2px 2px 0 0;}' +
    '.pc3-tab-actions{margin-left:auto;display:flex;align-items:center;gap:4px;}' +
    '.pc3-tab-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border:1px solid transparent;border-radius:7px;background:transparent;color:#57534e;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s,color .15s;}' +
    '.pc3-tab-btn:hover{background:#f5f5f4;color:#1c1917;}' +
    '.pc3-tab-btn.open{background:#f5f5f4;color:#147D91;}' +
    '.pc3-tab-btn .caret{font-size:9px;opacity:.6;}' +

    /* ── Popover menu ── */
    '.pc3-popover-wrap{position:relative;}' +
    '.pc3-popover{display:none;position:absolute;top:calc(100% + 6px);right:0;min-width:240px;background:#fff;border:1px solid #e7e5e4;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.04);padding:6px;z-index:100;animation:pc3-pop-in .12s ease-out;}' +
    '.pc3-popover.open{display:block;}' +
    '@keyframes pc3-pop-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}' +
    '.pc3-popover-section{padding:6px 4px;}' +
    '.pc3-popover-section + .pc3-popover-section{border-top:1px solid #f5f5f4;}' +
    '.pc3-popover-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#a8a29e;padding:4px 8px;}' +
    '.pc3-popover-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:#1c1917;width:100%;border:none;background:transparent;text-align:left;font-family:inherit;font-weight:500;}' +
    '.pc3-popover-item:hover{background:#f5f5f4;}' +
    '.pc3-popover-item .pc3-popover-icon{width:18px;height:18px;color:#78716c;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;}' +
    '.pc3-popover-item .pc3-popover-hint{margin-left:auto;font-size:11px;color:#a8a29e;}' +
    '.pc3-popover-row{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;font-size:12px;color:#44403c;}' +
    '.pc3-popover-toggle{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:#1c1917;}' +
    '.pc3-popover-toggle:hover{background:#f5f5f4;}' +
    '.pc3-popover-toggle input{accent-color:#147D91;cursor:pointer;}' +
    '.pc3-popover-select{width:100%;padding:6px 8px;border:1px solid #e7e5e4;border-radius:6px;font-size:12px;font-family:inherit;background:#fff;cursor:pointer;}' +
    '.pc3-popover-link{font-size:12px;color:#147D91;text-decoration:none;font-weight:600;padding:6px 10px;cursor:pointer;display:inline-block;}' +
    '.pc3-popover-link:hover{text-decoration:underline;}' +

    /* Keyboard shortcuts overlay */
    '.pc3-shortcuts-overlay{position:fixed;inset:0;z-index:300;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;animation:pc3-shortcut-fade .15s ease-out;}' +
    '@keyframes pc3-shortcut-fade{from{opacity:0}to{opacity:1}}' +
    '.pc3-shortcuts-card{background:#fff;border-radius:14px;box-shadow:0 30px 60px -20px rgba(0,0,0,.3);width:min(640px,92vw);max-height:80vh;overflow:auto;padding:24px 28px;font-family:inherit;}' +
    '.pc3-shortcuts-card h2{margin:0 0 4px;font-size:18px;font-weight:700;color:#0f172a;letter-spacing:-.01em;}' +
    '.pc3-shortcuts-card .pc3-shortcuts-sub{color:#78716c;font-size:13px;margin-bottom:18px;}' +
    '.pc3-shortcuts-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;}' +
    '.pc3-shortcut-row{display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid #f5f5f4;}' +
    '.pc3-shortcut-row:last-child{border-bottom:none;}' +
    '.pc3-shortcut-keys{display:flex;gap:4px;flex-shrink:0;}' +
    '.pc3-shortcut-key{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:24px;padding:0 7px;background:#fafaf9;border:1px solid #e7e5e4;border-bottom-width:2px;border-radius:5px;font-size:11px;font-weight:600;color:#1c1917;font-family:ui-monospace,Consolas,Menlo,monospace;}' +
    '.pc3-shortcut-label{flex:1;color:#44403c;font-size:13px;}' +
    '.pc3-shortcuts-card .pc3-shortcuts-foot{margin-top:18px;text-align:center;color:#a8a29e;font-size:11px;}' +

    /* Saved layouts list (in Style popover) */
    '.pc3-layouts-list{display:flex;flex-direction:column;gap:2px;}' +
    '.pc3-layouts-list .pc3-layout-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:1px solid transparent;border-radius:6px;background:transparent;cursor:pointer;font-family:inherit;text-align:left;color:inherit;}' +
    '.pc3-layouts-list .pc3-layout-row:hover{background:#f5f5f4;}' +
    '.pc3-layouts-list .pc3-layout-row .pc3-layout-name{flex:1;font-size:13px;color:#1c1917;font-weight:500;}' +
    '.pc3-layouts-list .pc3-layout-row .pc3-layout-del{opacity:0;color:#dc2626;background:transparent;border:none;cursor:pointer;padding:2px 6px;border-radius:4px;}' +
    '.pc3-layouts-list .pc3-layout-row:hover .pc3-layout-del{opacity:1;}' +
    '.pc3-layouts-list .pc3-layout-row .pc3-layout-del:hover{background:#fef2f2;}' +
    '.pc3-save-layout-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 10px;border:1px dashed #d6d3d1;border-radius:7px;background:transparent;cursor:pointer;color:#147D91;font-size:12px;font-weight:600;font-family:inherit;}' +
    '.pc3-save-layout-btn:hover{border-color:#147D91;background:#ecfeff;}' +

    /* Hover-tooltip card */
    '.pc3-celltip{position:fixed;z-index:200;pointer-events:none;background:#0f172a;color:#f8fafc;font-size:12px;line-height:1.45;padding:10px 12px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.1);max-width:280px;opacity:0;transform:translateY(2px);transition:opacity .12s,transform .12s;font-family:inherit;}' +
    '.pc3-celltip.show{opacity:1;transform:none;}' +
    '.pc3-celltip-title{font-size:13px;font-weight:700;margin-bottom:4px;color:#fff;}' +
    '.pc3-celltip-row{display:flex;gap:6px;align-items:flex-start;color:#cbd5e1;}' +
    '.pc3-celltip-row b{color:#fff;font-weight:600;}' +
    '.pc3-celltip-label{color:#94a3b8;text-transform:uppercase;font-size:10px;font-weight:600;letter-spacing:.4px;min-width:48px;}' +
    '.pc3-celltip-hint{margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.1);font-size:10px;color:#94a3b8;font-style:italic;}' +
    /* Subtle hover affordance on data cells (hover only — no click action) */
    '.pc3-tbl td[data-bunk][data-slot]{cursor:default;}' +
    '.pc3.inspect-mode .pc3-tbl td[data-bunk][data-slot]{cursor:cell;}' +
    '.pc3.inspect-mode .pc3-tbl td[data-bunk][data-slot]:hover{outline:2px solid #147D91;outline-offset:-1px;}' +

    /* Page-break preview — thin dashed lines + 'page N' label */
    '.pc3-pagebreak{position:absolute;left:0;right:0;height:0;border-top:2px dashed #f97316;pointer-events:none;z-index:5;}' +
    '.pc3-pagebreak::after{content:attr(data-page);position:absolute;right:8px;top:-10px;background:#f97316;color:#fff;font-size:10px;font-weight:700;padding:1px 8px;border-radius:99px;letter-spacing:.4px;white-space:nowrap;}' +
    '.pc3-pages-badge{font-size:10px;font-weight:600;padding:3px 9px;border-radius:99px;background:#fff7ed;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;display:inline-flex;align-items:center;gap:4px;}' +
    '.pc3-pages-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:#f97316;}' +
    /* Hide page break overlay during printing — the browser handles real page breaks */
    '@media print{.pc3-pagebreak{display:none !important;}}' +

    /* Print pack cards (empty state + popover) */
    '.pc3-packs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:18px;}' +
    '.pc3-pack-card{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px 16px;border:1px solid #e7e5e4;border-radius:12px;background:#fff;cursor:pointer;font-family:inherit;text-align:left;transition:transform .08s,border-color .15s,box-shadow .15s;color:inherit;}' +
    '.pc3-pack-card:hover{border-color:#147D91;box-shadow:0 4px 14px -4px rgba(20,125,145,.18),0 1px 3px rgba(15,23,42,.06);transform:translateY(-1px);}' +
    '.pc3-pack-card:active{transform:translateY(0);}' +
    '.pc3-pack-card.active{border-color:#147D91;background:#ecfeff;box-shadow:0 0 0 1px #147D91 inset;}' +
    '.pc3-pack-icon{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;background:#ecfeff;color:#147D91;border-radius:8px;}' +
    '.pc3-pack-name{font-size:14px;font-weight:700;color:#1c1917;line-height:1.2;}' +
    '.pc3-pack-tagline{font-size:12px;color:#78716c;line-height:1.4;}' +
    '.pc3-pack-applied{font-size:10px;font-weight:600;color:#147D91;background:#ecfeff;padding:2px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:.4px;margin-top:auto;}' +

    /* Packs popover variant: single-column compact list */
    '.pc3-packs-list{display:flex;flex-direction:column;gap:2px;}' +
    '.pc3-packs-list .pc3-pack-row{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:1px solid transparent;border-radius:8px;background:transparent;cursor:pointer;text-align:left;font-family:inherit;color:inherit;}' +
    '.pc3-packs-list .pc3-pack-row:hover{background:#f5f5f4;}' +
    '.pc3-packs-list .pc3-pack-row.active{border-color:#147D91;background:#ecfeff;}' +
    '.pc3-packs-list .pc3-pack-row-text{flex:1;min-width:0;}' +
    '.pc3-packs-list .pc3-pack-row-name{font-size:13px;font-weight:600;color:#1c1917;}' +
    '.pc3-packs-list .pc3-pack-row-tagline{font-size:11px;color:#78716c;line-height:1.3;margin-top:1px;}' +

    /* Style preset rows */
    '.pc3-preset-item{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:1px solid transparent;border-radius:8px;background:transparent;cursor:pointer;text-align:left;font-family:inherit;color:inherit;}' +
    '.pc3-preset-item:hover{background:#f5f5f4;}' +
    '.pc3-preset-item.active{border-color:#147D91;background:#ecfeff;}' +
    '.pc3-preset-swatch{display:flex;gap:0;border-radius:6px;overflow:hidden;border:1px solid #e7e5e4;flex-shrink:0;height:28px;}' +
    '.pc3-preset-swatch span{display:block;width:14px;height:100%;}' +
    '.pc3-preset-text{flex:1;min-width:0;}' +
    '.pc3-preset-name{font-size:13px;font-weight:600;color:#1c1917;}' +
    '.pc3-preset-desc{font-size:11px;color:#78716c;line-height:1.3;margin-top:1px;}' +
    '.pc3-preset-check{color:#147D91;font-weight:700;flex-shrink:0;}' +
    /* Inline header quick fields inside the Style popover */
    '.pc3-popover-field{display:flex;flex-direction:column;gap:3px;padding:5px 4px;font-size:11px;color:#44403c;}' +
    '.pc3-popover-field-lbl{font-size:10px;font-weight:600;color:#78716c;text-transform:uppercase;letter-spacing:.4px;}' +
    '.pc3-popover-field input{padding:5px 7px;border:1px solid #e7e5e4;border-radius:6px;font-family:inherit;font-size:12px;background:#fafaf9;color:#1c1917;transition:background .12s,border-color .12s;}' +
    '.pc3-popover-field input:focus{outline:none;background:#fff;border-color:#147D91;box-shadow:0 0 0 3px rgba(20,125,145,.10);}' +

    /* legacy alias kept for any stragglers */
    '.pc3-tb-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#334155;font-size:12px;font-weight:500;cursor:pointer;}' +
    '.pc3-tb-select{padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-family:inherit;background:#fff;cursor:pointer;}' +
    '.pc3-tb-label{font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.3px;}' +

    /* Hide formula bar + Excel coord rows / row numbers by default — they reappear in Inspect mode */
    '.pc3-formula{display:none !important;}' +
    '.pc3 .pc3-tbl tr.pc3-coord-row,.pc3 .pc3-tbl th.pc3-row-num{display:none;}' +
    '.pc3.inspect-mode .pc3-tbl tr.pc3-coord-row{display:table-row;}' +
    '.pc3.inspect-mode .pc3-tbl th.pc3-row-num{display:table-cell;}' +
    /* Suppress the cell-hover outline — too noisy when you're not selecting cells */
    '.pc3 .pc3-tbl td:hover{outline:none;}' +
    '.pc3.inspect-mode .pc3-tbl td:hover{outline:2px solid #147D91;outline-offset:-1px;}' +

    /* ── Workspace ── */
    '.pc3-workspace{flex:1;display:flex;min-height:0;overflow:hidden;position:relative;}' +

    /* ── Sidebar ── */
    '.pc3-sidebar{width:260px;background:#fff;border-right:1px solid #e7e5e4;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;transition:width .2s;}' +
    '.pc3-sidebar.collapsed{width:0;border-right:none;}' +
    '.pc3-sidebar-header{padding:12px 14px 8px;font-weight:700;font-size:11px;color:#1c1917;display:flex;align-items:center;justify-content:space-between;text-transform:uppercase;letter-spacing:.5px;}' +
    '.pc3-sidebar-count{font-size:10px;font-weight:600;color:#147D91;background:#ecfeff;padding:2px 8px;border-radius:99px;text-transform:none;letter-spacing:0;}' +
    '.pc3-sidebar-search{padding:0 10px 6px;}' +
    '.pc3-sidebar-search-input{width:100%;padding:6px 10px;border:1px solid #e7e5e4;border-radius:6px;font-size:12px;font-family:inherit;background:#fafaf9;color:#1c1917;transition:background .15s,border-color .15s;}' +
    '.pc3-sidebar-search-input:focus{outline:none;background:#fff;border-color:#147D91;box-shadow:0 0 0 3px rgba(20,125,145,.12);}' +
    '.pc3-sidebar-search-input::placeholder{color:#a8a29e;}' +
    '.pc3-sidebar-scroll{flex:1;overflow-y:auto;padding:0 6px 10px;}' +
    '.pc3-sidebar-group{margin-bottom:6px;}' +
    '.pc3-sidebar-group-head{display:flex;align-items:center;gap:6px;padding:4px 6px 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#a8a29e;}' +
    '.pc3-sidebar-group-name{flex:1;}' +
    '.pc3-sidebar-group-toggle{font-size:10px;font-weight:600;color:#147D91;background:transparent;border:none;cursor:pointer;text-transform:uppercase;letter-spacing:.4px;padding:2px 4px;border-radius:4px;font-family:inherit;}' +
    '.pc3-sidebar-group-toggle:hover{background:#ecfeff;}' +
    '.pc3-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:#1c1917;transition:background .12s;border:1px solid transparent;margin-bottom:2px;}' +
    '.pc3-item:hover{background:#fafaf9;}' +
    '.pc3-item.selected{background:#ecfeff;border-color:rgba(20,125,145,.15);}' +
    '.pc3-item input[type="checkbox"]{accent-color:#147D91;margin:0;cursor:pointer;width:15px;height:15px;flex-shrink:0;}' +
    '.pc3-item-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;}' +
    '.pc3-item-count{font-size:10px;color:#a8a29e;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0;}' +
    '.pc3-sidebar-empty{padding:20px 12px;text-align:center;color:#a8a29e;font-size:12px;}' +
    '.pc3-sidebar-actions{padding:6px 10px;border-top:1px solid #e7e5e4;display:flex;gap:6px;background:#fafaf9;}' +
    '.pc3-sidebar-actions button{flex:1;font-size:11px;padding:6px 8px;border:1px solid #e7e5e4;border-radius:6px;background:#fff;cursor:pointer;font-family:inherit;color:#44403c;font-weight:600;transition:background .12s,border-color .12s;}' +
    '.pc3-sidebar-actions button:hover{background:#fafaf9;border-color:#d6d3d1;}' +
    '.pc3-sidebar-actions button.primary{background:#147D91;color:#fff;border-color:#0F6E80;}' +
    '.pc3-sidebar-actions button.primary:hover{background:#0F6E80;}' +
    /* Empty-state suggestion chips */
    '.pc3-quickpick{display:flex;flex-direction:column;gap:8px;margin-top:18px;}' +
    '.pc3-quickpick-btn{display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border:1px solid #e7e5e4;border-radius:8px;background:#fff;color:#1c1917;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left;transition:background .12s,border-color .12s,transform .05s;}' +
    '.pc3-quickpick-btn:hover{background:#fafaf9;border-color:#147D91;}' +
    '.pc3-quickpick-btn:active{transform:translateY(1px);}' +
    '.pc3-quickpick-btn .pc3-quickpick-icon{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;background:#ecfeff;color:#147D91;border-radius:6px;flex-shrink:0;}' +
    '.pc3-quickpick-btn .pc3-quickpick-text{flex:1;line-height:1.3;}' +
    '.pc3-quickpick-btn .pc3-quickpick-sub{display:block;font-size:11px;font-weight:500;color:#78716c;margin-top:1px;}' +

    /* ── Grid Preview ── */
    '.pc3-grid-area{flex:1;overflow:auto;background:#f5f5f4;padding:14px 14px 70px;min-height:0;position:relative;background-image:radial-gradient(rgba(168,162,158,.18) 1px, transparent 1px);background-size:18px 18px;background-position:0 0;}' +
    '.pc3-grid-area.live-bg{background:#111827;padding:0;background-image:none;}' +
    /* Paper-like sheet card — fills available width, no artificial cap */
    '.pc3-sheet{background:#fff;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 18px -6px rgba(15,23,42,.08),0 0 0 1px rgba(15,23,42,.04);margin:0 0 14px;overflow:hidden;position:relative;width:100%;}' +
    /* Sticky sheet header at the top of each card */
    '.pc3-sheet-head{position:sticky;top:0;z-index:4;background:rgba(255,255,255,.94);backdrop-filter:saturate(140%) blur(8px);-webkit-backdrop-filter:saturate(140%) blur(8px);}' +
    /* Floating zoom dock */
    '.pc3-zoom-dock{position:fixed;right:24px;bottom:24px;display:flex;align-items:center;gap:4px;padding:6px;background:rgba(255,255,255,.96);border:1px solid #e7e5e4;border-radius:99px;box-shadow:0 4px 12px rgba(15,23,42,.08),0 1px 3px rgba(15,23,42,.06);z-index:30;backdrop-filter:saturate(140%) blur(8px);-webkit-backdrop-filter:saturate(140%) blur(8px);}' +
    '.pc3-zoom-dock button{width:30px;height:30px;border:none;background:transparent;border-radius:50%;cursor:pointer;color:#44403c;display:inline-flex;align-items:center;justify-content:center;transition:background .12s;}' +
    '.pc3-zoom-dock button:hover{background:#f5f5f4;color:#1c1917;}' +
    '.pc3-zoom-dock .pc3-zoom-dock-label{min-width:46px;text-align:center;font-size:11px;font-weight:600;color:#44403c;cursor:pointer;font-variant-numeric:tabular-nums;padding:0 6px;}' +
    '.pc3-zoom-dock .pc3-zoom-dock-label:hover{color:#147D91;}' +
    '.pc3-zoom-dock-sep{width:1px;height:18px;background:#e7e5e4;margin:0 2px;}' +
    '.pc3-zoom-glyph{font-size:18px;font-weight:600;line-height:1;color:#44403c;}' +
    /* ★ Sidebar toggle tab — vertically centered on the divider between sidebar and grid */
    /* Sidebar toggle — a small persistent "tab" handle that lives ON the divider
       between the sidebar and the grid. When sidebar is open it sits at the
       right edge of the 230px panel; when collapsed it sits at left:14px so the
       user can find it. High z-index so it never disappears behind content. */
    '.pc3-sidebar-toggle{position:absolute;top:64px;left:252px;width:18px;height:48px;border:1px solid #e7e5e4;border-left:none;background:#fff;border-radius:0 6px 6px 0;cursor:pointer;color:#147D91;display:flex;align-items:center;justify-content:center;z-index:40;box-shadow:2px 2px 8px rgba(15,23,42,.08);transition:left .2s,background .12s,box-shadow .12s;padding:0;}' +
    '.pc3-sidebar-toggle:hover{background:#ecfeff;color:#0F6E80;box-shadow:4px 4px 12px rgba(15,23,42,.14);}' +
    /* When collapsed, keep the full toggle on-screen anchored at the very left */
    '.pc3-sidebar.collapsed ~ .pc3-sidebar-toggle{left:0;border-left:1px solid #e7e5e4;border-radius:0 6px 6px 0;}' +
    '.pc3-sidebar-toggle-arrow{font-size:16px;font-weight:700;line-height:1;}' +

    /* ── Spreadsheet Table ── */
    '.pc3-tbl{border-collapse:separate;border-spacing:0;width:100%;table-layout:auto;user-select:none;}' +
    '.pc3-tbl th,.pc3-tbl td{border-right:1px solid #f1f5f9;border-bottom:1px solid #f1f5f9;padding:5px 8px;text-align:left;white-space:nowrap;position:relative;transition:background .1s;font-size:12px;}' +
    '.pc3-tbl tr:last-child td,.pc3-tbl tr:last-child th{border-bottom:none;}' +
    '.pc3-tbl th:last-child,.pc3-tbl td:last-child{border-right:none;}' +
    '.pc3-tbl th{background:#fafaf9;font-weight:600;position:sticky;z-index:2;font-size:11px;color:#44403c;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #e7e5e4;}' +
    '.pc3-tbl thead th{top:0;}' +
    '.pc3-tbl th.corner{z-index:3;left:0;top:0;background:#fafaf9;}' +
    '.pc3-tbl th.row-head{position:sticky;left:0;z-index:2;background:#fafaf9;font-weight:600;text-transform:none;letter-spacing:0;color:#1c1917;font-size:12px;}' +
    '.pc3-tbl tr:nth-child(even) td{background:#fdfdfc;}' +
    '.pc3-tbl .cell-free{color:#a8a29e;font-style:italic;}' +
    '.pc3-tbl .cell-pinned{background:#fff8e1;color:#92400e;font-weight:500;}' +
    '.pc3-tbl .cell-league{background:#eff6ff;color:#1e40af;font-weight:500;}' +
    '.pc3-tbl .cell-transition{background:#f5f3ff;color:#6d28d9;font-size:10px;font-style:italic;}' +

    /* ── Excel-style coordinate headers ── */
    '.pc3-tbl tr.pc3-coord-row th{background:#dbe2ea!important;color:#475569;font-size:10px;font-weight:700;text-align:center!important;padding:2px 6px;border:1px solid #94a3b8;height:18px;letter-spacing:.4px;top:0;z-index:4;}' +
    '.pc3-tbl tr.pc3-coord-row th.pc3-coord-corner{background:#94a3b8!important;color:transparent;left:0;z-index:5;min-width:36px;width:36px;}' +
    '.pc3-tbl th.pc3-row-num{background:#dbe2ea!important;color:#475569;font-size:10px;font-weight:700;text-align:center!important;padding:2px 4px;border:1px solid #94a3b8;width:36px;min-width:36px;position:sticky;left:0;z-index:3;}' +
    '.pc3-tbl tr:nth-child(even) th.pc3-row-num{background:#dbe2ea!important;}' +
    '.pc3-tbl td.pc3-cell-selected,.pc3-tbl th.pc3-cell-selected:not(.pc3-row-num):not(.pc3-coord-corner):not(.pc3-coord-row th){background:rgba(20,125,145,.18)!important;}' +
    '.pc3-tbl td.pc3-cell-active,.pc3-tbl th.pc3-cell-active:not(.pc3-row-num):not(.pc3-coord-corner){outline:2px solid #147D91!important;outline-offset:-2px;background:rgba(20,125,145,.28)!important;z-index:2;}' +
    '.pc3-tbl tr.pc3-coord-row th.pc3-coord-active{background:#147D91!important;color:#fff!important;}' +
    '.pc3-tbl th.pc3-row-num.pc3-coord-active{background:#147D91!important;color:#fff!important;}' +
    '.pc3-tbl td,.pc3-tbl th{cursor:cell;}' +
    '.pc3-tbl tr.pc3-coord-row th,.pc3-tbl th.pc3-row-num{cursor:default;}' +

    /* ── Sheet Header ── */
    '.pc3-sheet-head{padding:8px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #e7e5e4;}' +
    '.pc3-sheet-title{font-size:14px;font-weight:700;color:#1c1917;letter-spacing:-.005em;}' +
    '.pc3-sheet-subtitle{font-size:11px;color:#78716c;font-weight:500;}' +
    '.pc3-sheet-badge{font-size:10px;font-weight:600;padding:3px 9px;border-radius:99px;background:#ecfeff;color:#147D91;text-transform:uppercase;letter-spacing:.4px;}' +

    /* ── League Matchups ── */
    '.pc3-matchup{display:inline-block;margin:1px 4px 1px 0;padding:1px 6px;background:rgba(30,64,175,.06);border:1px solid rgba(30,64,175,.1);border-radius:3px;font-size:10px;white-space:nowrap;}' +

    /* ── Live Mode ── */
    '.pc3-live-overlay{position:absolute;inset:0;z-index:100;background:#111827;display:flex;flex-direction:column;overflow:hidden;}' +
    '.pc3-live-header{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;background:rgba(0,0,0,.3);flex-shrink:0;}' +
    '.pc3-live-title{font-size:24px;font-weight:800;color:#fff;}' +
    '.pc3-live-clock{font-size:36px;font-weight:300;color:#fbbf24;font-variant-numeric:tabular-nums;}' +
    '.pc3-live-close{padding:8px 16px;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:rgba(255,255,255,.1);color:#fff;font-size:13px;cursor:pointer;}' +
    '.pc3-live-close:hover{background:rgba(255,255,255,.2);}' +
    '.pc3-live-body{flex:1;overflow:hidden;position:relative;}' +
    '.pc3-live-page{position:absolute;inset:0;overflow:hidden;}' +
    '.pc3-live-page-inner{padding:16px 24px;}' +
    '.pc3-live-nav-btn{background:none;border:none;color:rgba(255,255,255,.55);font-size:26px;cursor:pointer;line-height:1;padding:0 4px;transition:color .15s;}' +
    '.pc3-live-nav-btn:hover{color:#fbbf24;}' +
    '.pc3-live-tbl{border-collapse:collapse;width:100%;table-layout:auto;}' +
    '.pc3-live-tbl th,.pc3-live-tbl td{border:1px solid #374151;padding:8px 12px;text-align:left;white-space:nowrap;font-size:14px;}' +
    '.pc3-live-tbl th{background:#1f2937;color:#e5e7eb;font-weight:600;position:sticky;top:0;z-index:2;}' +
    '.pc3-live-tbl th.corner{z-index:3;left:0;top:0;}' +
    '.pc3-live-tbl th.row-head{position:sticky;left:0;z-index:2;background:#1f2937;}' +
    '.pc3-live-tbl td{color:#e5e7eb;background:#111827;}' +
    '.pc3-live-tbl tr:nth-child(even) td{background:#0f172a;}' +
    '.pc3-live-tbl .cell-current{background:#164e63 !important;box-shadow:inset 0 0 0 2px #06b6d4;}' +
    '.pc3-live-tbl .cell-past{opacity:.4;}' +
    '.pc3-live-tbl .cell-pinned{background:#422006 !important;color:#fbbf24;}' +
    '.pc3-live-tbl .cell-league{background:#1e1b4b !important;color:#818cf8;}' +
    '.pc3-live-cursor-v{position:absolute;top:0;bottom:0;width:3px;background:#fbbf24;z-index:50;pointer-events:none;box-shadow:0 0 14px rgba(251,191,36,.7);transition:left .8s linear;}' +
    '.pc3-live-cursor-h{position:absolute;left:0;right:0;height:3px;background:#fbbf24;z-index:50;pointer-events:none;box-shadow:0 0 14px rgba(251,191,36,.7);transition:top .8s linear;}' +
    '.pc3-live-now-tag{position:absolute;background:#fbbf24;color:#111;font-size:11px;font-weight:800;padding:3px 8px;border-radius:4px;font-variant-numeric:tabular-nums;z-index:51;pointer-events:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);}' +
    '.pc3-live-now-tag.tag-v{top:-2px;transform:translateX(-50%);}' +
    '.pc3-live-now-tag.tag-h{left:8px;transform:translateY(-50%);}' +
    '.pc3-live-section{position:relative;}' +

    /* ── Advanced Drawer ── */
    '.pc3-drawer{position:absolute;top:0;right:0;width:300px;height:100%;background:#fff;border-left:1px solid #e2e8f0;box-shadow:-4px 0 16px rgba(0,0,0,.08);z-index:20;transform:translateX(100%);transition:transform .25s;display:flex;flex-direction:column;}' +
    '.pc3-drawer.open{transform:translateX(0);}' +
    '.pc3-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:700;}' +
    '.pc3-drawer-scroll{flex:1;overflow-y:auto;padding:8px 10px;}' +
    '.pc3-drawer details{border-bottom:1px solid #f1f5f9;}' +
    '.pc3-drawer summary{padding:7px 4px;cursor:pointer;font-size:11px;font-weight:600;color:#334155;user-select:none;list-style:none;}' +
    '.pc3-drawer summary::before{content:"\\25B8  ";color:#94a3b8;}' +
    '.pc3-drawer details[open] summary::before{content:"\\25BE  ";color:#147D91;}' +
    '.pc3-drawer details[open] summary{color:#147D91;}' +
    '.pc3-drawer summary::-webkit-details-marker{display:none;}' +
    '.pc3-drawer .dp-body{padding:4px 4px 8px;}' +
    '.pc3-drawer .dp-row{display:flex;gap:8px;margin-bottom:5px;}' +
    '.pc3-drawer .dp-field{margin-bottom:5px;}' +
    '.pc3-drawer .dp-half{flex:1;}' +
    '.pc3-drawer .dp-field label{display:block;font-size:9px;font-weight:600;color:#64748b;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px;}' +
    '.pc3-drawer .dp-field input[type="text"],.pc3-drawer .dp-field input[type="number"],.pc3-drawer .dp-field select{width:100%;padding:3px 6px;border:1px solid #cbd5e1;border-radius:4px;font-size:11px;font-family:inherit;}' +
    '.pc3-drawer .dp-field input[type="color"]{width:100%;height:26px;padding:2px;border:1px solid #cbd5e1;border-radius:4px;cursor:pointer;}' +
    '.pc3-drawer .dp-field input[type="range"]{width:100%;}' +
    '.pc3-drawer .dp-toggle{display:flex;align-items:center;gap:6px;font-size:11px;color:#475569;margin-bottom:4px;cursor:pointer;}' +
    '.pc3-drawer .dp-toggle input{accent-color:#147D91;}' +
    '.pc3-drawer .dp-color-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;}' +
    '.pc3-drawer .dp-color-pair{display:flex;align-items:center;gap:4px;font-size:10px;color:#64748b;}' +
    '.pc3-drawer .dp-color-pair span{min-width:44px;}' +
    '.pc3-drawer .dp-color-pair input[type="color"]{width:28px;height:22px;padding:1px;border:1px solid #cbd5e1;border-radius:3px;cursor:pointer;}' +
    /* Drawer preset chips + action buttons */
    '.pc3-drawer .dp-preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}' +
    '.pc3-drawer .dp-preset-btn{display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;color:#1c1917;}' +
    '.pc3-drawer .dp-preset-btn:hover{background:#f5f5f4;border-color:#cbd5e1;}' +
    '.pc3-drawer .dp-preset-btn.active{border-color:#147D91;background:#ecfeff;color:#0F6E80;}' +
    '.pc3-drawer .dp-preset-sw{display:flex;gap:0;border-radius:3px;overflow:hidden;border:1px solid #e7e5e4;flex-shrink:0;height:18px;}' +
    '.pc3-drawer .dp-preset-sw span{display:block;width:8px;height:100%;}' +
    '.pc3-drawer .dp-action-btn{width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;color:#44403c;}' +
    '.pc3-drawer .dp-action-btn:hover{background:#f5f5f4;border-color:#94a3b8;}' +

    /* ── Zoom ── */
    '.pc3-zoom{display:flex;align-items:center;gap:4px;}' +
    '.pc3-zoom input[type="range"]{width:80px;height:4px;accent-color:#147D91;}' +
    '.pc3-zoom-label{font-size:10px;color:#64748b;min-width:32px;text-align:center;}' +

    /* ── Print overrides ── */
    '@media print{.no-print,.pc3-toolbar,.pc3-formula,.pc3-sidebar,.pc3-drawer{display:none!important;}.pc3{background:#fff!important;}.pc3-grid-area{background:#fff!important;padding:0!important;overflow:visible!important;}.pc3-sheet{box-shadow:none!important;border-radius:0!important;}}' +
    /* ★ Day 22.5+ Print Center: live + print content-control classes */
    '.pc3-hide-durations .pc3-dur{display:none !important;}' +
    /* Per-bunk page break in Bunks view (each .pc3-sheet is one bunk) */
    '@media print{.pc3-pb-per-bunk .pc3-sheet{page-break-after:always;break-after:page;}.pc3-pb-per-bunk .pc3-sheet:last-child{page-break-after:auto;break-after:auto;}}' +
    /* Coverage-gap overlay: stripe Free cells in warning color so director can spot holes */
    '.pc3-highlight-gaps td.cell-free{background:repeating-linear-gradient(45deg,#FEF3C7,#FEF3C7 6px,#FDE68A 6px,#FDE68A 12px) !important;color:#92400E !important;font-weight:600 !important;}' +
    '.pc3-highlight-gaps td.cell-free::after{content:" gap";font-size:8px;opacity:.7;}' +
    /* Color-by-category: subtle left border keyed by activity type (cells already carry inline bg) */
    '.pc3-color-cat td.cell-free{border-left:3px solid #94A3B8 !important;}' +
    '.pc3-color-cat td.cell-league{border-left:3px solid #2563EB !important;}' +
    '.pc3-color-cat td.cell-pinned{border-left:3px solid #D97706 !important;}' +
    '.pc3-color-cat td.cell-general{border-left:3px solid #14B8A6 !important;}' +
    /* Quick filters — dim cells that do not match the active filter so users
       can produce focused printouts (e.g. league-only night-out plans). */
    '.pc3-filter-leagues td:not(.cell-league):not([colspan]){opacity:.12;}' +
    '.pc3-filter-specials td:not(.cell-pinned):not([colspan]){opacity:.12;}' +
    '.pc3-filter-general td:not(.cell-general):not([colspan]){opacity:.12;}' +
    '.pc3-filter-free td:not(.cell-free):not([colspan]){opacity:.12;}' +
    /* Make tables fully visible during print regardless of overflow scrolling */
    '@media print{' +
        '.pc3-sheet-table-wrap{overflow:visible !important;width:100% !important;}' +
        '.pc3-tbl{page-break-inside:auto;width:100% !important;max-width:100% !important;table-layout:fixed !important;}' +
        /* CRITICAL: cells default to nowrap on screen for readability, but on
           print this prevents the table from fitting on the page and the right
           half gets clipped. Force wrap + smaller font during print. */
        '.pc3-tbl th,.pc3-tbl td{white-space:normal !important;word-wrap:break-word !important;overflow:hidden !important;font-size:8.5pt !important;padding:3px 4px !important;}' +
        '.pc3-tbl thead{display:table-header-group;}' +
        '.pc3-tbl tr{page-break-inside:avoid;}' +
        '.pc3-sheet{width:100% !important;max-width:100% !important;box-shadow:none !important;border-radius:0 !important;}' +
    '}' +
    '</style>';
}

// =========================================================================
// MAIN UI BUILDER
// =========================================================================
function buildMainUI() {
    var t = _currentTemplate;
    var mode = isAutoMode() ? 'auto' : 'manual';
    var dateLabel = window.currentScheduleDate ? formatDisplayDate(window.currentScheduleDate) : '';
    var liveOpen = !!(_liveWindow && !_liveWindow.closed);
    return getStyles() +
    '<div class="pc3' + (_isFullscreen ? ' pc3-fullscreen' : '') + (_inspectMode ? ' inspect-mode' : '') + (_hideDurations ? ' pc3-hide-durations' : '') + (_pageBreakPerBunk ? ' pc3-pb-per-bunk' : '') + (_highlightGaps ? ' pc3-highlight-gaps' : '') + (_colorByCategory ? ' pc3-color-cat' : '') + (_quickFilter && _quickFilter !== 'all' ? ' pc3-filter-' + _quickFilter : '') + '" id="pc3-root">' +

    /* ── Hero header ── */
    '<div class="pc3-hero no-print">' +
        '<div class="pc3-hero-title-block">' +
            '<h1>' + escHtml(t.campName || 'Camp Schedule') + '</h1>' +
            '<div class="pc3-hero-meta">' +
                (dateLabel ? '<span>' + escHtml(dateLabel) + '</span><span class="pc3-hero-meta-dot"></span>' : '') +
                '<span class="pc3-hero-mode ' + mode + '">' + mode + ' builder</span>' +
            '</div>' +
        '</div>' +
        '<div class="pc3-hero-actions">' +
            '<div class="pc3-popover-wrap">' +
                '<button class="pc3-hero-btn" id="pc3-packs-btn" title="Print packs — opinionated one-click setups">' + ICO.grid + ' Packs <span style="opacity:.6;font-size:9px;">▼</span></button>' +
                '<div class="pc3-popover" id="pc3-packs-menu" style="min-width:340px;left:0;right:auto;">' +
                    '<div class="pc3-popover-section">' +
                        '<div class="pc3-popover-label">One-click setups</div>' +
                        '<div class="pc3-packs-list">' +
                            PRINT_PACKS.map(function (p) {
                                var active = _activePack === p.id;
                                return '<button class="pc3-pack-row' + (active ? ' active' : '') + '" data-pack="' + p.id + '">' +
                                    '<span class="pc3-pack-icon">' + (ICO[p.icon] || ICO.grid) + '</span>' +
                                    '<div class="pc3-pack-row-text">' +
                                        '<div class="pc3-pack-row-name">' + escHtml(p.name) + '</div>' +
                                        '<div class="pc3-pack-row-tagline">' + escHtml(p.tagline) + '</div>' +
                                    '</div>' +
                                    (active ? '<span class="pc3-popover-icon" style="color:#147D91;">' + ICO.check + '</span>' : '') +
                                '</button>';
                            }).join('') +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<button class="pc3-hero-btn' + (liveOpen ? ' live-on' : '') + '" id="pc3-live-btn" title="' + (liveOpen ? 'Live View is open' : 'Open Live View in a new window') + '">' +
                (liveOpen ? '<span class="pc3-live-dot"></span>Live · On' : ICO.monitor + ' Live View') +
            '</button>' +
            '<button class="pc3-hero-btn" id="pc3-design-btn" onclick="window._pc3ToggleAdvanced()" title="Open full design settings — colors, fonts, header, footer, watermark">' + ICO.gear + ' Design</button>' +
            '<div class="pc3-popover-wrap">' +
                '<button class="pc3-hero-btn primary" id="pc3-output-btn">' + ICO.print + ' Output <span style="opacity:.7;font-size:9px;">▼</span></button>' +
                '<div class="pc3-popover" id="pc3-output-menu" style="min-width:260px;">' +
                    '<div class="pc3-popover-section">' +
                        '<div class="pc3-popover-label">Print</div>' +
                        '<button class="pc3-popover-item" onclick="window._pc3Print()"><span class="pc3-popover-icon">' + ICO.print + '</span>Print this view</button>' +
                        '<button class="pc3-popover-item" onclick="window.printAllDivisions()"><span class="pc3-popover-icon">' + ICO.grid + '</span>Print every division</button>' +
                    '</div>' +
                    '<div class="pc3-popover-section">' +
                        '<div class="pc3-popover-label">Export</div>' +
                        '<button class="pc3-popover-item" onclick="window._pc3ExportExcel()"><span class="pc3-popover-icon">' + ICO.excel + '</span>Export to Excel</button>' +
                        '<button class="pc3-popover-item" onclick="window._pc3ExportCSV && window._pc3ExportCSV()"><span class="pc3-popover-icon">' + ICO.excel + '</span>Export to CSV</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<button class="pc3-hero-icon-btn" onclick="window._pc3ToggleFullscreen()" title="Toggle fullscreen">' + ICO.expand + '</button>' +
        '</div>' +
    '</div>' +

    /* ── Tab bar ── */
    '<div class="pc3-tabbar no-print">' +
        '<div class="pc3-tabs">' +
            '<button class="pc3-tab' + (_activeView === 'division' ? ' active' : '') + '" data-view="division">Divisions</button>' +
            '<button class="pc3-tab' + (_activeView === 'bunk' ? ' active' : '') + '" data-view="bunk">Bunks</button>' +
            '<button class="pc3-tab' + (_activeView === 'location' ? ' active' : '') + '" data-view="location">Facilities</button>' +
            '<button class="pc3-tab' + (_activeView === 'week' ? ' active' : '') + '" data-view="week" title="Mon–Sun at-a-glance">Week</button>' +
        '</div>' +
        '<div class="pc3-tab-actions">' +
            '<div class="pc3-popover-wrap">' +
                '<button class="pc3-tab-btn" id="pc3-style-btn">Style <span class="caret">▼</span></button>' +
                '<div class="pc3-popover" id="pc3-style-menu" style="min-width:280px;">' +
                    '<div class="pc3-popover-section">' +
                        '<div class="pc3-popover-label">Presets</div>' +
                        STYLE_PRESETS.map(function (p) {
                            var active = _activePreset === p.id;
                            var sw = '<div class="pc3-preset-swatch">' +
                                p.swatch.map(function (c) { return '<span style="background:' + c + ';"></span>'; }).join('') +
                            '</div>';
                            return '<button class="pc3-preset-item' + (active ? ' active' : '') + '" data-preset="' + p.id + '">' +
                                sw +
                                '<div class="pc3-preset-text">' +
                                    '<div class="pc3-preset-name">' + escHtml(p.name) + '</div>' +
                                    '<div class="pc3-preset-desc">' + escHtml(p.description) + '</div>' +
                                '</div>' +
                                (active ? '<span class="pc3-preset-check">' + (ICO.check || '✓') + '</span>' : '') +
                            '</button>';
                        }).join('') +
                    '</div>' +
                    '<div class="pc3-popover-section">' +
                        '<div class="pc3-popover-label">Header</div>' +
                        '<label class="pc3-popover-field"><span class="pc3-popover-field-lbl">Camp name</span><input type="text" id="pc3-hero-camp-name" value="' + escHtml(_currentTemplate.campName || '') + '" placeholder="Your Camp"></label>' +
                        '<label class="pc3-popover-field"><span class="pc3-popover-field-lbl">Subtitle</span><input type="text" id="pc3-hero-subtitle" value="' + escHtml(_currentTemplate.customSubtitle || '') + '" placeholder="Daily Schedule"></label>' +
                        '<label class="pc3-popover-field"><span class="pc3-popover-field-lbl">Footer</span><input type="text" id="pc3-hero-footer" value="' + escHtml(_currentTemplate.footerText || '') + '" placeholder="Generated by Campistry"></label>' +
                    '</div>' +
                    '<div class="pc3-popover-section">' +
                        '<div class="pc3-popover-label">Saved layouts</div>' +
                        '<div id="pc3-layouts-list" class="pc3-layouts-list"></div>' +
                        '<button class="pc3-save-layout-btn" id="pc3-save-layout-btn">+ Save current as layout</button>' +
                    '</div>' +
                    '<div class="pc3-popover-section">' +
                        /* Customize is a local style editor — every user can tweak how their own print output looks. Saving as a shared template stays gated separately inside the drawer. */
                        '<button class="pc3-popover-item" onclick="window._pc3ToggleAdvanced()"><span class="pc3-popover-icon">' + ICO.gear + '</span>Customize…</button>' +
                        '<button class="pc3-popover-item" onclick="window._pc3ShowShortcuts && window._pc3ShowShortcuts()"><span class="pc3-popover-icon">⌘</span>Keyboard shortcuts<span class="pc3-popover-hint">?</span></button>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-inspect-mode"' + (_inspectMode ? ' checked' : '') + '>Inspect mode<span style="margin-left:auto;font-size:11px;color:#a8a29e;">Excel-like</span></label>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="pc3-popover-wrap">' +
                '<button class="pc3-tab-btn" id="pc3-layout-btn">Layout <span class="caret">▼</span></button>' +
                '<div class="pc3-popover" id="pc3-layout-menu" style="min-width:280px;">' +
                    '<div class="pc3-popover-section">' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-transpose"' + (t.tableOrientation === 'time-top' ? ' checked' : '') + '>Time across the top<span style="margin-left:auto;font-size:11px;color:#a8a29e;">Transpose</span></label>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-combined"' + (t.layoutMode === 'all-bunks' ? ' checked' : '') + '>Combine all bunks into one sheet</label>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-hide-matchups"' + (t.hideLeagueMatchups ? ' checked' : '') + '>Hide league matchups</label>' +
                    '</div>' +
                    '<div class="pc3-popover-section">' +
                        '<div style="font-size:10px;font-weight:600;color:#a8a29e;letter-spacing:0.05em;margin-bottom:6px;text-transform:uppercase;">Time axis</div>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-activity-aligned"' + (_activityAligned ? ' checked' : '') + '>Activity-aligned columns<span style="margin-left:auto;font-size:11px;color:#a8a29e;">Recommended</span></label>' +
                        '<div class="pc3-popover-row" id="pc3-subseg-row" style="' + (_activityAligned ? 'display:none;' : '') + '"><span>Sub-segment</span>' +
                            '<select id="pc3-time-increment" class="pc3-popover-select" style="max-width:110px;">' +
                                (function () {
                                    var opts = '';
                                    for (var iv = 5; iv <= 60; iv += 5) {
                                        opts += '<option value="' + iv + '"' + (_timeIncrement === iv ? ' selected' : '') + '>' + iv + ' min</option>';
                                    }
                                    return opts;
                                })() +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                    '<div class="pc3-popover-section">' +
                        '<div style="font-size:10px;font-weight:600;color:#a8a29e;letter-spacing:0.05em;margin-bottom:6px;text-transform:uppercase;">Content</div>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-hide-durations"' + (_hideDurations ? ' checked' : '') + '>Hide activity durations (50m)</label>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-hide-locations"' + (_hideLocations ? ' checked' : '') + '>Hide locations &amp; sharing notes</label>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-highlight-gaps"' + (_highlightGaps ? ' checked' : '') + '>Highlight coverage gaps (Free cells)</label>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-color-cat"' + (_colorByCategory ? ' checked' : '') + '>Color cells by category</label>' +
                        '<div class="pc3-popover-field" style="margin-top:6px;"><span class="pc3-popover-field-lbl">Show only</span>' +
                            '<select id="pc3-quick-filter">' +
                                '<option value="all"' + (_quickFilter === 'all' ? ' selected' : '') + '>Everything</option>' +
                                '<option value="leagues"' + (_quickFilter === 'leagues' ? ' selected' : '') + '>Leagues</option>' +
                                '<option value="specials"' + (_quickFilter === 'specials' ? ' selected' : '') + '>Specials (pinned)</option>' +
                                '<option value="general"' + (_quickFilter === 'general' ? ' selected' : '') + '>General activities</option>' +
                                '<option value="free"' + (_quickFilter === 'free' ? ' selected' : '') + '>Free / gaps</option>' +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                    '<div class="pc3-popover-section">' +
                        '<div style="font-size:10px;font-weight:600;color:#a8a29e;letter-spacing:0.05em;margin-bottom:6px;text-transform:uppercase;">Print</div>' +
                        '<label class="pc3-popover-toggle"><input type="checkbox" id="pc3-page-break-bunk"' + (_pageBreakPerBunk ? ' checked' : '') + '>One bunk per page (Bunks view)</label>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            /* Hidden controls preserved for legacy JS bindings (zoom dock + cell selection) */
            '<select id="pc3-template-select" style="display:none;"><option value="default">Default Template</option></select>' +
            '<input type="range" min="50" max="200" value="' + _zoomLevel + '" id="pc3-zoom-range" style="display:none;">' +
            '<span id="pc3-zoom-label" style="display:none;">' + _zoomLevel + '%</span>' +
        '</div>' +
    '</div>' +

    /* ── Formula Bar ── */
    '<div class="pc3-formula no-print">' +
        '<span class="pc3-formula-cell" id="pc3-fx-cell">\u2014</span>' +
        '<span class="pc3-formula-val" id="pc3-fx-val">Select a cell to see details</span>' +
        '<span class="pc3-formula-mode ' + mode + '" id="pc3-fx-mode">' + mode + ' builder</span>' +
    '</div>' +

    /* ── Workspace ── */
    '<div class="pc3-workspace">' +
        /* Sidebar */
        '<div class="pc3-sidebar' + (_sidebarCollapsed ? ' collapsed' : '') + '" id="pc3-sidebar">' +
            '<div class="pc3-sidebar-header"><span id="pc3-sidebar-title">Divisions</span><span class="pc3-sidebar-count" id="pc3-sidebar-count">0 selected</span></div>' +
            '<div class="pc3-sidebar-search">' +
                '<input type="text" id="pc3-sidebar-search" class="pc3-sidebar-search-input" placeholder="Search…">' +
            '</div>' +
            '<div class="pc3-sidebar-scroll" id="pc3-sidebar-scroll"></div>' +
            '<div class="pc3-sidebar-actions"><button onclick="window._pc3SelectAll()">Select all</button><button onclick="window._pc3SelectNone()">Clear</button></div>' +
        '</div>' +
        /* ★ Day 22.5+: collapse/expand sidebar toggle — small tab on the
           border between sidebar and grid area. Lets users maximize the
           preview area when they want to focus on the schedule. */
        '<button class="pc3-sidebar-toggle no-print" id="pc3-sidebar-toggle" onclick="window._pc3ToggleSidebar()" title="' + (_sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar') + '" aria-label="Toggle sidebar">' +
            '<span class="pc3-sidebar-toggle-arrow">' + (_sidebarCollapsed ? '›' : '‹') + '</span>' +
        '</button>' +

        /* Grid Area */
        '<div class="pc3-grid-area" id="pc3-grid-area">' +
            '<div id="pc3-preview-empty" style="display:flex;align-items:center;justify-content:center;height:100%;padding:40px 28px;">' +
                '<div style="text-align:center;max-width:760px;width:100%;">' +
                    '<div style="font-size:36px;margin-bottom:10px;opacity:.35;color:#a8a29e;">' + ICO.grid + '</div>' +
                    '<p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#1c1917;letter-spacing:-.005em;">Print Packs</p>' +
                    '<p style="margin:0 0 8px;font-size:13px;color:#78716c;line-height:1.5;max-width:480px;margin-left:auto;margin-right:auto;">Pick a pack and the print center configures itself for that workflow. Style, layout, and selection — set in one click.</p>' +
                    '<div class="pc3-packs-grid">' +
                        PRINT_PACKS.map(function (p) {
                            return '<button class="pc3-pack-card" data-pack="' + p.id + '">' +
                                '<span class="pc3-pack-icon">' + (ICO[p.icon] || ICO.grid) + '</span>' +
                                '<span class="pc3-pack-name">' + escHtml(p.name) + '</span>' +
                                '<span class="pc3-pack-tagline">' + escHtml(p.tagline) + '</span>' +
                            '</button>';
                        }).join('') +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div id="pc3-preview-content" style="display:none;"></div>' +
            /* Floating zoom dock — bottom-right of preview */
            '<div class="pc3-zoom-dock no-print" id="pc3-zoom-dock">' +
                /* ★ Day 22.5+: explicit + / − glyphs alongside icons so the
                   buttons are unmistakably zoom controls at a glance */
                '<button onclick="window._pc3Zoom(-10)" title="Zoom out" aria-label="Zoom out"><span class="pc3-zoom-glyph">−</span></button>' +
                '<span class="pc3-zoom-dock-label" id="pc3-zoom-dock-label" onclick="window._pc3ZoomReset && window._pc3ZoomReset()" title="Reset to 100%">' + _zoomLevel + '%</span>' +
                '<button onclick="window._pc3Zoom(10)" title="Zoom in" aria-label="Zoom in"><span class="pc3-zoom-glyph">+</span></button>' +
                '<span class="pc3-zoom-dock-sep"></span>' +
                '<button onclick="window._pc3ToggleFullscreen()" title="Toggle fullscreen">' + ICO.expand + '</button>' +
            '</div>' +
        '</div>' +

        /* Advanced Drawer */
        '<div class="pc3-drawer' + (_advancedOpen ? ' open' : '') + '" id="pc3-drawer">' +
            '<div class="pc3-drawer-header"><span>' + ICO.gear + ' Design Settings</span><button class="pc3-hero-icon-btn" onclick="window._pc3ToggleAdvanced()" style="width:28px;height:28px;">' + ICO.x + '</button></div>' +
            '<div class="pc3-drawer-scroll" id="pc3-drawer-scroll">' + buildAdvancedSections() + '</div>' +
        '</div>' +
    '</div>' +

    '<div id="printable-area" style="display:none;"></div>' +
    '</div>';
}

// =========================================================================
// ADVANCED DESIGN PANEL
// =========================================================================
function buildAdvancedSections() {
    var t = _currentTemplate;
    var presetSwatches = STYLE_PRESETS.map(function (p) {
        var active = _activePreset === p.id;
        return '<button class="dp-preset-btn' + (active ? ' active' : '') + '" data-preset="' + p.id + '" title="' + escHtml(p.description) + '">' +
            '<span class="dp-preset-sw">' + p.swatch.map(function (c) { return '<span style="background:' + c + ';"></span>'; }).join('') + '</span>' +
            '<span class="dp-preset-nm">' + escHtml(p.name) + '</span>' +
        '</button>';
    }).join('');
    return '' +
    /* Quick-start presets + reset — single hub for style management */
    '<details open><summary>Quick start</summary><div class="dp-body">' +
        '<div style="font-size:10px;color:#64748b;margin-bottom:6px;">Pick a starting point — then customize anything below.</div>' +
        '<div class="dp-preset-grid">' + presetSwatches + '</div>' +
        '<button class="dp-action-btn" onclick="window._pc3ResetToDefault && window._pc3ResetToDefault()" style="margin-top:8px;">Reset to default</button>' +
    '</div></details>' +
    '<details open><summary>Header</summary><div class="dp-body">' +
        '<div class="dp-field"><label>Camp Name</label><input type="text" id="pc3-camp-name" value="' + escHtml(t.campName) + '" placeholder="Your Camp"></div>' +
        '<div class="dp-field"><label>Subtitle</label><input type="text" id="pc3-custom-subtitle" value="' + escHtml(t.customSubtitle) + '" placeholder="Daily Schedule"></div>' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>BG</label><input type="color" id="pc3-header-bg" value="' + t.headerBgColor + '"></div><div class="dp-field dp-half"><label>Text</label><input type="color" id="pc3-header-text" value="' + t.headerTextColor + '"></div></div>' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>Font</label><select id="pc3-header-font">' + fontOptions(t.headerFont) + '</select></div><div class="dp-field dp-half"><label>Size</label><input type="number" id="pc3-header-font-size" value="' + t.headerFontSize + '" min="12" max="48"></div></div>' +
        '<label class="dp-toggle"><input type="checkbox" id="pc3-show-header"' + (t.showHeader !== false ? ' checked' : '') + '> Show header</label>' +
        '<label class="dp-toggle"><input type="checkbox" id="pc3-show-date"' + (t.showDate ? ' checked' : '') + '> Show date</label>' +
        '<label class="dp-toggle"><input type="checkbox" id="pc3-show-div-name"' + (t.showDivisionName ? ' checked' : '') + '> Show division name</label>' +
    '</div></details>' +

    '<details><summary>Grid Styling</summary><div class="dp-body">' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>Font</label><select id="pc3-grid-font">' + fontOptions(t.gridFont) + '</select></div><div class="dp-field dp-half"><label>Size</label><input type="number" id="pc3-grid-font-size" value="' + t.gridFontSize + '" min="8" max="18"></div></div>' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>Header BG</label><input type="color" id="pc3-grid-header-bg" value="' + t.gridHeaderBgColor + '"></div><div class="dp-field dp-half"><label>Header Text</label><input type="color" id="pc3-grid-header-text" value="' + t.gridHeaderTextColor + '"></div></div>' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>Border</label><input type="color" id="pc3-grid-border-color" value="' + t.gridBorderColor + '"></div><div class="dp-field dp-half"><label>Width</label><input type="number" id="pc3-grid-border-width" value="' + t.gridBorderWidth + '" min="0" max="4"></div></div>' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>Row</label><input type="color" id="pc3-grid-row-color" value="' + t.gridRowColor + '"></div><div class="dp-field dp-half"><label>Alt Row</label><input type="color" id="pc3-grid-row-alt" value="' + t.gridRowAltColor + '"></div></div>' +
        '<div class="dp-field"><label>Cell Padding</label><input type="range" id="pc3-cell-padding" min="2" max="20" value="' + t.cellPadding + '"></div>' +
    '</div></details>' +

    '<details><summary>Activity Colors</summary><div class="dp-body"><div class="dp-color-grid">' +
        '<div class="dp-color-pair"><span>General</span><input type="color" id="pc3-general-bg" value="' + t.generalBgColor + '"><input type="color" id="pc3-general-text" value="' + t.generalTextColor + '"></div>' +
        '<div class="dp-color-pair"><span>Pinned</span><input type="color" id="pc3-pinned-bg" value="' + t.pinnedBgColor + '"><input type="color" id="pc3-pinned-text" value="' + t.pinnedTextColor + '"></div>' +
        '<div class="dp-color-pair"><span>League</span><input type="color" id="pc3-league-bg" value="' + t.leagueBgColor + '"><input type="color" id="pc3-league-text" value="' + t.leagueTextColor + '"></div>' +
        '<div class="dp-color-pair"><span>Free</span><input type="color" id="pc3-free-bg" value="' + t.freeBgColor + '"><input type="color" id="pc3-free-text" value="' + t.freeTextColor + '"></div>' +
    '</div></div></details>' +

    '<details><summary>Time Column</summary><div class="dp-body">' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>BG</label><input type="color" id="pc3-time-bg" value="' + t.timeColBgColor + '"></div><div class="dp-field dp-half"><label>Text</label><input type="color" id="pc3-time-text" value="' + t.timeColTextColor + '"></div></div>' +
        '<div class="dp-field"><label>Width (px)</label><input type="number" id="pc3-time-width" value="' + t.timeColWidth + '" min="60" max="200"></div>' +
        '<label class="dp-toggle"><input type="checkbox" id="pc3-time-bold"' + (t.timeColBold ? ' checked' : '') + '> Bold time</label>' +
    '</div></details>' +

    '<details><summary>Print Layout</summary><div class="dp-body">' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>Orientation</label><select id="pc3-orientation"><option value="landscape"' + (t.orientation === 'landscape' ? ' selected' : '') + '>Landscape</option><option value="portrait"' + (t.orientation === 'portrait' ? ' selected' : '') + '>Portrait</option></select></div><div class="dp-field dp-half"><label>Paper</label><select id="pc3-paper-size"><option value="letter"' + (t.paperSize === 'letter' ? ' selected' : '') + '>Letter</option><option value="a4"' + (t.paperSize === 'a4' ? ' selected' : '') + '>A4</option><option value="legal"' + (t.paperSize === 'legal' ? ' selected' : '') + '>Legal</option></select></div></div>' +
        '<label class="dp-toggle"><input type="checkbox" id="pc3-page-breaks"' + (t.showPageBreaks ? ' checked' : '') + '> Page breaks between items</label>' +
    '</div></details>' +

    '<details><summary>Watermark</summary><div class="dp-body">' +
        '<label class="dp-toggle"><input type="checkbox" id="pc3-watermark-enabled"' + (t.watermarkEnabled ? ' checked' : '') + '> Enable watermark</label>' +
        '<div class="dp-field"><label>Text</label><input type="text" id="pc3-watermark-text" value="' + escHtml(t.watermarkText) + '"></div>' +
        '<div class="dp-row"><div class="dp-field dp-half"><label>Color</label><input type="color" id="pc3-watermark-color" value="' + t.watermarkColor + '"></div><div class="dp-field dp-half"><label>Opacity</label><input type="range" id="pc3-watermark-opacity" min="0.01" max="0.5" step="0.01" value="' + t.watermarkOpacity + '"></div></div>' +
    '</div></details>' +

    '<details><summary>Footer</summary><div class="dp-body">' +
        '<label class="dp-toggle"><input type="checkbox" id="pc3-footer-enabled"' + (t.footerEnabled ? ' checked' : '') + '> Enable footer</label>' +
        '<div class="dp-field"><label>Text</label><input type="text" id="pc3-footer-text" value="' + escHtml(t.footerText) + '"></div>' +
    '</div></details>';
}

// =========================================================================
// READ DESIGN VALUES
// =========================================================================
function readDesignValues() {
    var t = _currentTemplate;
    var vMap = {
        'pc3-camp-name': 'campName', 'pc3-custom-subtitle': 'customSubtitle',
        'pc3-header-bg': 'headerBgColor', 'pc3-header-text': 'headerTextColor',
        'pc3-header-font': 'headerFont', 'pc3-grid-font': 'gridFont',
        'pc3-grid-header-bg': 'gridHeaderBgColor', 'pc3-grid-header-text': 'gridHeaderTextColor',
        'pc3-grid-border-color': 'gridBorderColor', 'pc3-grid-row-color': 'gridRowColor',
        'pc3-grid-row-alt': 'gridRowAltColor', 'pc3-general-bg': 'generalBgColor',
        'pc3-general-text': 'generalTextColor', 'pc3-pinned-bg': 'pinnedBgColor',
        'pc3-pinned-text': 'pinnedTextColor', 'pc3-league-bg': 'leagueBgColor',
        'pc3-league-text': 'leagueTextColor', 'pc3-free-bg': 'freeBgColor',
        'pc3-free-text': 'freeTextColor', 'pc3-time-bg': 'timeColBgColor',
        'pc3-time-text': 'timeColTextColor', 'pc3-watermark-color': 'watermarkColor',
        'pc3-orientation': 'orientation', 'pc3-paper-size': 'paperSize',
        'pc3-watermark-text': 'watermarkText', 'pc3-footer-text': 'footerText'
    };
    for (var eid in vMap) { var e = el(eid); if (e) t[vMap[eid]] = e.value; }
    var intMap = { 'pc3-header-font-size': 'headerFontSize', 'pc3-grid-font-size': 'gridFontSize', 'pc3-grid-border-width': 'gridBorderWidth', 'pc3-cell-padding': 'cellPadding', 'pc3-time-width': 'timeColWidth' };
    for (var eid2 in intMap) { var e2 = el(eid2); if (e2) t[intMap[eid2]] = parseInt(e2.value) || t[intMap[eid2]]; }
    var chkMap = { 'pc3-time-bold': 'timeColBold', 'pc3-page-breaks': 'showPageBreaks', 'pc3-watermark-enabled': 'watermarkEnabled', 'pc3-footer-enabled': 'footerEnabled', 'pc3-show-header': 'showHeader', 'pc3-show-date': 'showDate', 'pc3-show-div-name': 'showDivisionName' };
    for (var eid3 in chkMap) { var e3 = el(eid3); if (e3) t[chkMap[eid3]] = !!e3.checked; }
    t.tableOrientation = (el('pc3-transpose') && el('pc3-transpose').checked) ? 'time-top' : 'bunks-top';
    t.layoutMode = (el('pc3-combined') && el('pc3-combined').checked) ? 'all-bunks' : 'per-division';
    t.hideLeagueMatchups = !!(el('pc3-hide-matchups') && el('pc3-hide-matchups').checked);
    if (el('pc3-watermark-opacity')) t.watermarkOpacity = parseFloat(el('pc3-watermark-opacity').value) || 0.08;
}

// =========================================================================
// SIDEBAR
// =========================================================================
function populateSidebar() {
    var container = el('pc3-sidebar-scroll');
    var titleEl = el('pc3-sidebar-title');
    var searchEl = el('pc3-sidebar-search');
    if (!container) return;
    var divs = getDivisions();
    // Build a flat array of items, optionally grouped by division
    // Each item: { id, label, group?, count?, sub? }
    var items = [];
    var groups = []; // [{ name, items: [item, ...] }]

    if (_activeView === 'division') {
        if (titleEl) titleEl.textContent = 'Divisions';
        if (searchEl) searchEl.placeholder = 'Search divisions…';
        var available = getAvailableDivisions();
        // ★ Day 22.5+: honor the user-defined order from Campistry Me
        //   (parent divisions + grade order). Fall back to naturalSort if
        //   the helper is not loaded.
        available = (typeof window.getUserDivisionOrder === 'function')
            ? window.getUserDivisionOrder(available)
            : available.slice().sort(naturalSort);
        // ★ Per-day presence: drop grades not around on the selected date.
        if (typeof window.filterDivisionsByDate === 'function') available = window.filterDivisionsByDate(available);
        available.forEach(function (d) {
            var bunkCount = divs[d] && divs[d].bunks ? divs[d].bunks.length : 0;
            items.push({ id: d, label: d, count: bunkCount + ' bunks' });
        });
    } else if (_activeView === 'bunk') {
        if (titleEl) titleEl.textContent = 'Bunks';
        if (searchEl) searchEl.placeholder = 'Search bunks…';
        var available2 = getAvailableDivisions();
        available2 = (typeof window.getUserDivisionOrder === 'function')
            ? window.getUserDivisionOrder(available2)
            : available2.slice().sort(naturalSort);
        // ★ Per-day presence: drop grades not around on the selected date.
        if (typeof window.filterDivisionsByDate === 'function') available2 = window.filterDivisionsByDate(available2);
        available2.forEach(function (d) {
            var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).slice();
            if (!bunks.length) return;
            var grp = { name: d, items: [] };
            bunks.forEach(function (b) { grp.items.push({ id: b, label: b }); });
            groups.push(grp);
        });
    } else if (_activeView === 'week') {
        if (titleEl) titleEl.textContent = 'Bunks (Week)';
        if (searchEl) searchEl.placeholder = 'Search bunks…';
        var availableW = getAvailableDivisions();
        availableW = (typeof window.getUserDivisionOrder === 'function')
            ? window.getUserDivisionOrder(availableW)
            : availableW.slice().sort(naturalSort);
        availableW.forEach(function (d) {
            var bunksW = (divs[d] && divs[d].bunks ? divs[d].bunks : []).slice();
            if (!bunksW.length) return;
            var grp = { name: d, items: [] };
            bunksW.forEach(function (b) { grp.items.push({ id: b, label: b }); });
            groups.push(grp);
        });
    } else if (_activeView === 'location') {
        if (titleEl) titleEl.textContent = 'Facilities';
        if (searchEl) searchEl.placeholder = 'Search facilities…';
        var allLocs = {};
        var aa = getAssignments();
        Object.keys(aa).forEach(function (bk) {
            (aa[bk] || []).forEach(function (entry) {
                if (!entry || entry.continuation) return;
                var fn = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
                if (fn && fn !== 'Free' && fn !== 'Transition') allLocs[fn] = true;
            });
        });
        Object.keys(allLocs).sort(naturalSort).forEach(function (loc) {
            items.push({ id: loc, label: loc });
        });
    }

    function renderItem(it) {
        var checkedAttr = ' checked';
        return '<label class="pc3-item" data-search="' + escHtml(it.label.toLowerCase()) + '">' +
            '<input type="checkbox" class="pc3-item-cb" data-item="' + escHtml(it.id) + '"' + checkedAttr + '>' +
            '<span class="pc3-item-label">' + escHtml(it.label) + '</span>' +
            (it.count ? '<span class="pc3-item-count">' + escHtml(it.count) + '</span>' : '') +
        '</label>';
    }

    var html = '';
    if (groups.length) {
        groups.forEach(function (g, gi) {
            html += '<div class="pc3-sidebar-group" data-group="' + escHtml(g.name) + '">' +
                '<div class="pc3-sidebar-group-head">' +
                    '<span class="pc3-sidebar-group-name">' + escHtml(g.name) + '</span>' +
                    '<button class="pc3-sidebar-group-toggle" data-group-toggle="' + escHtml(g.name) + '" data-state="all">All</button>' +
                '</div>' +
                g.items.map(renderItem).join('') +
            '</div>';
        });
    } else if (items.length) {
        html += items.map(renderItem).join('');
    } else {
        html += '<div class="pc3-sidebar-empty">Nothing to show. Generate a schedule first.</div>';
    }
    container.innerHTML = html;
    container.querySelectorAll('.pc3-item-cb').forEach(function (cb) {
        cb.addEventListener('change', function () { updateSidebarSelectionUI(); liveRefresh(); });
    });
    container.querySelectorAll('.pc3-sidebar-group-toggle').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            var groupName = this.getAttribute('data-group-toggle');
            var groupEl = document.querySelector('.pc3-sidebar-group[data-group="' + (CSS && CSS.escape ? CSS.escape(groupName) : groupName) + '"]') ||
                          this.closest('.pc3-sidebar-group');
            if (!groupEl) return;
            var anyChecked = !!groupEl.querySelector('.pc3-item-cb:checked');
            var newState = !anyChecked; // if any are checked, uncheck all; otherwise check all
            groupEl.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = newState; });
            updateSidebarSelectionUI();
            liveRefresh();
        });
    });

    // Search-as-you-type
    if (searchEl) {
        searchEl.value = '';
        searchEl.oninput = function () {
            var q = (this.value || '').toLowerCase().trim();
            container.querySelectorAll('.pc3-item').forEach(function (it) {
                var match = !q || (it.getAttribute('data-search') || '').indexOf(q) !== -1;
                it.style.display = match ? '' : 'none';
            });
            // Hide groups whose items are all hidden
            container.querySelectorAll('.pc3-sidebar-group').forEach(function (g) {
                var visible = g.querySelectorAll('.pc3-item:not([style*="display: none"])');
                g.style.display = visible.length ? '' : 'none';
            });
        };
    }

    updateSidebarSelectionUI();
}

// Reflect selection count + per-row "selected" highlight
function updateSidebarSelectionUI() {
    var count = 0, total = 0;
    document.querySelectorAll('.pc3-item-cb').forEach(function (cb) {
        total++;
        var item = cb.closest('.pc3-item');
        if (cb.checked) {
            count++;
            if (item) item.classList.add('selected');
        } else if (item) {
            item.classList.remove('selected');
        }
    });
    var countEl = el('pc3-sidebar-count');
    if (countEl) countEl.textContent = total ? count + ' of ' + total + ' selected' : '0 selected';
}

function getSelectedItems() {
    var items = [];
    document.querySelectorAll('.pc3-item-cb:checked').forEach(function (cb) {
        items.push(cb.getAttribute('data-item'));
    });
    return items;
}

// =========================================================================
// ★★★ SPREADSHEET RENDERERS ★★★
// =========================================================================

// Excel-style coordinate strip helpers
var _sheetSeq = 0;
function pcNextSheetId() { _sheetSeq++; return 'pcsh_' + _sheetSeq; }
function pcCoordRow(numDataCols) {
    var s = '<tr class="pc3-coord-row">';
    s += '<th class="pc3-coord-corner" data-select-all="1"></th>';
    for (var i = 0; i < numDataCols; i++) {
        s += '<th data-col-select="' + i + '">' + colLetter(i) + '</th>';
    }
    s += '</tr>';
    return s;
}
function pcRowNum(r) {
    return '<th class="pc3-row-num" data-row-select="' + r + '">' + (r + 1) + '</th>';
}

// ── Division View (manual mode: slot-based) ──
function renderDivisionSheet(divName) {
    var t = _currentTemplate;
    var divs = getDivisions();
    var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).slice();
    if (!bunks.length) return '';

    var auto = isAutoMode();
    var html = '<div class="pc3-sheet">';

    // Sheet Header
    if (t.showHeader !== false || t.showDivisionName) {
        html += '<div class="pc3-sheet-head">';
        if (t.showDivisionName) html += '<span class="pc3-sheet-title">' + escHtml(divName) + '</span>';
        if (t.campName) html += '<span class="pc3-sheet-subtitle">' + escHtml(t.campName) + '</span>';
        if (t.showDate) html += '<span class="pc3-sheet-subtitle">' + formatDisplayDate(window.currentScheduleDate) + '</span>';
        html += '<span class="pc3-sheet-badge">' + (auto ? 'Auto' : 'Manual') + '</span>';
        html += '</div>';
    }

    if (auto) {
        // ★★★ AUTO MODE: Per-bunk rendering ★★★
        // Each bunk may have different time slots, so we build a unified time axis
        html += renderAutoDivisionTable(divName, bunks);
    } else {
        // ★★★ MANUAL MODE: Slot-based rendering ★★★
        var blocks = buildDivisionBlocks(divName);
        if (t.tableOrientation === 'time-top') {
            html += renderManualTimeTop(divName, bunks, blocks);
        } else {
            html += renderManualBunksTop(divName, bunks, blocks);
        }
    }

    html += '</div>';
    return html;
}

// ── AUTO MODE: Spreadsheet grid — bunks on Y, time increments on X ──
// Two-row header: top row = period sections (merged), bottom row = sub-time increments.
// Activities spanning multiple increment columns get merged cells (colspan).
function renderAutoDivisionTable(divName, bunks) {
    var inc = _timeIncrement;

    // ─── 1. Collect per-bunk activities (merge continuations) ─────
    var bunkActs = {}; // { bunk: [ { startMin, endMin, entry, slotIdx, type } ] }
    var dayStart = Infinity, dayEnd = -Infinity;

    bunks.forEach(function (bunk) {
        var slots = getPerBunkSchedule(bunk, divName);
        var acts = [];
        for (var i = 0; i < slots.length; i++) {
            var entry = getEntry(bunk, i);
            if (entry && entry.continuation && acts.length > 0) {
                acts[acts.length - 1].endMin = slots[i].endMin;
                continue;
            }
            acts.push({
                startMin: slots[i].startMin, endMin: slots[i].endMin,
                entry: entry || null, slotIdx: i,
                type: entry ? getEntryType(entry) : 'free'
            });
            if (slots[i].startMin < dayStart) dayStart = slots[i].startMin;
            if (slots[i].endMin > dayEnd) dayEnd = slots[i].endMin;
        }
        bunkActs[bunk] = acts;
    });

    if (dayStart === Infinity) dayStart = 480;
    if (dayEnd === -Infinity) dayEnd = 960;
    // ★ Do NOT snap dayStart down to the increment grid: a 12:20 day start
    //   would fabricate a 12:00 column nobody occupies (a striped "hasn't
    //   started" band for every bunk). Columns start at the true first
    //   minute; only the end is padded out to a full column.
    dayEnd = Math.ceil(dayEnd / inc) * inc;

    // ─── 2. Identify "Periods" from the bell schedule (DAW layer templates) ─────
    // The bell schedule defines layer windows — each layer has a type, startMin, endMin.
    // Variable layers (sport, special, activity, elective) = the "Periods" where bunks
    // have different activities. Pinned layers (swim, lunch, custom, etc.) are NOT periods.
    var VARIABLE_LAYER_TYPES = { 'slot': 1, 'sport': 1, 'special': 1, 'activity': 1, 'sports': 1, 'elective': 1, 'swim_elective': 1, 'smart': 1, 'split': 1, 'league': 1, 'specialty_league': 1 };
    var activityRanges = []; // [ { startMin, endMin } ]

    // ★ Day 22.5+: hasRealBellSchedule means the camp actually defined
    //   numbered Bell Schedule periods (via the Bell Schedule editor).
    //   That's the ONLY case where the period header bar should render.
    //   DAW layer templates (Sport/Special/Swim/Lunch) are scheduling
    //   intent, NOT periods — they should NOT trigger the period band.
    var hasRealBellSchedule = false;
    try {
        var _cp = window.campPeriods && window.campPeriods[divName];
        if (Array.isArray(_cp) && _cp.length > 0) {
            hasRealBellSchedule = true;
            _cp.forEach(function (p) {
                if (p && typeof p.startMin === 'number' && typeof p.endMin === 'number') {
                    activityRanges.push({ startMin: p.startMin, endMin: p.endMin, name: p.name || null });
                }
            });
        }
    } catch (_e) { /* ignore */ }
    // Method 1 (legacy): DAW layer templates — used ONLY for column-
    // grouping inference when no real Bell Schedule exists. Does NOT
    // set hasRealBellSchedule.
    var bellLayers = !hasRealBellSchedule ? getBellScheduleLayers(divName) : null;
    if (bellLayers && bellLayers.length > 0) {
        bellLayers.forEach(function (layer) {
            var lt = (layer.type || '').toLowerCase();
            if (VARIABLE_LAYER_TYPES[lt]) {
                activityRanges.push({ startMin: layer.startMin, endMin: layer.endMin, name: layer.name || layer.label || null });
            }
        });
        // Sort and merge overlapping ranges
        activityRanges.sort(function (a, b) { return a.startMin - b.startMin; });
        var mergedRanges = [];
        activityRanges.forEach(function (r) {
            var last = mergedRanges.length > 0 ? mergedRanges[mergedRanges.length - 1] : null;
            if (last && r.startMin < last.endMin) {
                last.endMin = Math.max(last.endMin, r.endMin);
            } else {
                mergedRanges.push({ startMin: r.startMin, endMin: r.endMin });
            }
        });
        activityRanges = mergedRanges;
    }

    // Method 2: Fallback — infer from _perBunkSlots slot types
    if (activityRanges.length === 0) {
        var perBunkSlotsObj = window.divisionTimes && window.divisionTimes[divName] && window.divisionTimes[divName]._perBunkSlots
            ? window.divisionTimes[divName]._perBunkSlots : null;
        if (perBunkSlotsObj && bunks.length > 0) {
            var firstSlots = perBunkSlotsObj[String(bunks[0])] || [];
            var curRange = null;
            firstSlots.forEach(function (slot) {
                var slotType = (slot.type || '').toLowerCase();
                var isVariable = slotType !== 'pinned' && slotType !== '';
                if (isVariable) {
                    if (curRange && slot.startMin < curRange.endMin) {
                        curRange.endMin = Math.max(curRange.endMin, slot.endMin);
                    } else {
                        if (curRange) activityRanges.push(curRange);
                        curRange = { startMin: slot.startMin, endMin: slot.endMin };
                    }
                } else {
                    if (curRange) { activityRanges.push(curRange); curRange = null; }
                }
            });
            if (curRange) activityRanges.push(curRange);
        }
    }

    // Method 2b: Fallback — infer from divisionTimes[divName] shared slots
    if (activityRanges.length === 0) {
        var divSlots = window.divisionTimes && window.divisionTimes[divName] ? window.divisionTimes[divName] : null;
        if (divSlots && Array.isArray(divSlots) && divSlots.length > 0) {
            var curRange2 = null;
            divSlots.forEach(function (slot) {
                var slotType2 = (slot.type || '').toLowerCase();
                var isVar2 = slotType2 !== 'pinned' && slotType2 !== '';
                if (isVar2) {
                    if (curRange2 && slot.startMin < curRange2.endMin) {
                        curRange2.endMin = Math.max(curRange2.endMin, slot.endMin);
                    } else {
                        if (curRange2) activityRanges.push(curRange2);
                        curRange2 = { startMin: slot.startMin, endMin: slot.endMin, name: slot.label || slot.event || null };
                    }
                } else {
                    if (curRange2) { activityRanges.push(curRange2); curRange2 = null; }
                }
            });
            if (curRange2) activityRanges.push(curRange2);
        }
    }

    // ★ Day 22.5+: only render the period header row when a REAL Bell
    //   Schedule was defined (Method 1). Methods 2/2b auto-derive ranges
    //   from the schedule itself, which the user already sees as
    //   activities — replicating them in a top-row band is just noise.
    var hasRealPeriods = hasRealBellSchedule;
    if (activityRanges.length === 0) {
        activityRanges.push({ startMin: dayStart, endMin: dayEnd });
    }

    try { console.log('[PrintCenter] div=' + divName + ' periods=' + activityRanges.length + ' hasReal=' + hasRealPeriods, activityRanges.map(function(r){return r.name||'?';})); } catch(e){}

    // ─── 3. Build the time-column array ─────
    // Two modes:
    //   (a) Activity-aligned (NEW default): columns are sized by activity
    //       boundaries — every unique activity start/end across all bunks
    //       becomes a column boundary. Activities never span an awkward
    //       number of "15-min subcolumns" because there are no subcolumns.
    //   (b) Fixed-increment (legacy): every _timeIncrement minutes is a
    //       column. Activities of varying durations span uneven colspans.
    var timeCols = []; // [ { startMin, endMin, label, periodIdx (-1 if not in a period) } ]
    var t, colEnd, pIdx, ri;
    if (_activityAligned) {
        // Collect unique boundaries across all bunks' activities
        var boundarySet = {};
        boundarySet[dayStart] = true;
        boundarySet[dayEnd] = true;
        Object.keys(bunkActs).forEach(function (bk) {
            (bunkActs[bk] || []).forEach(function (a) {
                if (a.startMin >= dayStart && a.startMin <= dayEnd) boundarySet[a.startMin] = true;
                if (a.endMin >= dayStart && a.endMin <= dayEnd) boundarySet[a.endMin] = true;
            });
        });
        var boundaries = Object.keys(boundarySet).map(Number).sort(function (a, b) { return a - b; });
        for (var bi = 0; bi < boundaries.length - 1; bi++) {
            t = boundaries[bi];
            colEnd = boundaries[bi + 1];
            pIdx = -1;
            for (ri = 0; ri < activityRanges.length; ri++) {
                if (t >= activityRanges[ri].startMin && t < activityRanges[ri].endMin) { pIdx = ri; break; }
            }
            timeCols.push({ startMin: t, endMin: colEnd, label: minutesToTimeLabel(t), periodIdx: pIdx });
        }
    } else {
        for (t = dayStart; t < dayEnd; t += inc) {
            colEnd = Math.min(t + inc, dayEnd);
            pIdx = -1;
            for (ri = 0; ri < activityRanges.length; ri++) {
                if (t >= activityRanges[ri].startMin && t < activityRanges[ri].endMin) { pIdx = ri; break; }
            }
            timeCols.push({ startMin: t, endMin: colEnd, label: minutesToTimeLabel(t), periodIdx: pIdx });
        }
    }
    var numCols = timeCols.length;

    // ─── 4. Render table ─────
    // Total visible data columns = 1 (bunk) + numCols (time)
    var totalDataCols = 1 + numCols;
    var sheetId = pcNextSheetId();
    var html = '<div class="pc3-sheet-table-wrap" style="overflow:auto;position:relative;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="auto" data-day-start="' + dayStart + '" data-day-end="' + dayEnd + '" style="table-layout:fixed;">';
    html += '<thead>';

    // ── HEADER ROW 1 (data row 1): Period labels (only over variable-activity columns) ──
    // ★ Day 22.5+: only render the period header row when REAL periods exist.
    if (hasRealPeriods) {
    html += '<tr>';
    html += '<th class="corner" rowspan="2" data-r="0" data-c="0" data-cell-text="Bunk" style="min-width:80px;width:80px;vertical-align:middle;">Bunk</th>';

    var ci = 0;
    while (ci < numCols) {
        var col = timeCols[ci];
        if (col.periodIdx >= 0) {
            // Count consecutive columns in this period
            var pStart = ci;
            var pId = col.periodIdx;
            while (ci < numCols && timeCols[ci].periodIdx === pId) ci++;
            var pSpan = ci - pStart;
            var periodNum = pId + 1;
            var range = activityRanges[pId];
            var periodName = range.name || ('Period ' + periodNum);
            var periodTxt = periodName + ' (' + minutesToTimeLabel(range.startMin) + '\u2013' + minutesToTimeLabel(range.endMin) + ')';
            html += '<th colspan="' + pSpan + '" data-r="0" data-c="' + (1 + pStart) + '" data-cell-text="' + escHtml(periodTxt) + '" style="text-align:center;background:#147D91;color:#fff;font-size:11px;font-weight:600;padding:6px 4px;border-bottom:none;border-right:2px solid #0e6b7e;">';
            html += escHtml(periodName);
            html += '<div style="font-size:9px;font-weight:400;opacity:.85;margin-top:2px;">' + minutesToTimeLabel(range.startMin) + ' \u2013 ' + minutesToTimeLabel(range.endMin) + '</div>';
            html += '</th>';
        } else {
            // Non-period column — just an empty top header cell
            html += '<th data-r="0" data-c="' + (1 + ci) + '" style="background:#f1f5f9;border-bottom:none;padding:2px;"></th>';
            ci++;
        }
    }
    html += '</tr>';
    }  // end if (hasRealPeriods)

    // ── HEADER ROW 2 (time-label row) — the ONLY header row when no periods ──
    html += '<tr>';
    if (!hasRealPeriods) {
        html += '<th class="corner" data-r="0" data-c="0" data-cell-text="Bunk" style="min-width:80px;width:80px;vertical-align:middle;">Bunk</th>';
    }
    var colW = _activityAligned
        ? Math.max(70, Math.min(140, 900 / Math.max(1, numCols)))
        : Math.max(36, Math.min(80, 700 / numCols));
    var hdrRowAttr = hasRealPeriods ? '1' : '0';
    timeCols.forEach(function (col, idx) {
        var bgStyle = col.periodIdx >= 0 ? '' : 'background:#f8fafc;';
        // Activity-aligned mode: show end time so each column header is self-documenting
        var labelTxt = _activityAligned
            ? (col.label + ' – ' + minutesToTimeLabel(col.endMin))
            : col.label;
        var fSize = _activityAligned ? 10 : (inc <= 10 ? 8 : 9);
        html += '<th data-r="' + hdrRowAttr + '" data-c="' + (1 + idx) + '" data-cell-text="' + escHtml(labelTxt) + '" style="min-width:' + colW + 'px;width:' + colW + 'px;font-size:' + fSize + 'px;white-space:nowrap;padding:3px 4px;text-align:center;font-weight:500;color:#64748b;' + bgStyle + '">' + labelTxt + '</th>';
    });
    html += '</tr>';
    html += '</thead><tbody>';

    // ─── 5. Bunk rows ─────
    bunks.forEach(function (bunk, bunkIdx) {
        var rowR = 2 + bunkIdx;
        html += '<tr>';
        html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(bunk) + '" style="min-width:80px;">' + escHtml(bunk) + '</th>';

        var acts = bunkActs[bunk] || [];
        var colIdx = 0;

        while (colIdx < numCols) {
            var colStart = timeCols[colIdx].startMin;
            var colEnd = timeCols[colIdx].endMin;

            // Find which bunk activity covers this time column
            var matchAct = null;
            for (var ai = 0; ai < acts.length; ai++) {
                if (acts[ai].startMin < colEnd && acts[ai].endMin > colStart) { matchAct = acts[ai]; break; }
            }

            if (matchAct) {
                // Calculate colspan: how many consecutive columns this activity spans
                var span = 1;
                var nextCol = colIdx + 1;
                while (nextCol < numCols && timeCols[nextCol].startMin < matchAct.endMin) {
                    span++;
                    nextCol++;
                }

                var type = matchAct.type;
                var actText = '', locText = '';
                if (matchAct.entry) {
                    actText = matchAct.entry._activity || matchAct.entry.sport || '';
                    locText = typeof matchAct.entry.field === 'string' ? matchAct.entry.field : (matchAct.entry.field && matchAct.entry.field.name ? matchAct.entry.field.name : '');
                    if (actText && locText && (actText === locText || locText.indexOf(actText) >= 0)) locText = '';
                    if (!actText && locText) { actText = locText; locText = ''; }
                }
                var displayText = actText || '\u2014';
                // \u2605 Day 22.5+: respect _hideLocations toggle
                if (locText && !_hideLocations) displayText += ' \u2013 ' + locText;
                if (matchAct.entry && matchAct.slotIdx != null && displayText !== '\u2014' && !_hideLocations) {
                    var _autoSh = pcFindFieldSharers(bunk, matchAct.slotIdx, divName);
                    if (_autoSh.length) {
                        var _autoNames = _autoSh.map(function(b){ return /^\d/.test(String(b)) ? 'Bunk ' + b : b; });
                        displayText += ' vs ' + _autoNames.join(', ');
                    }
                }
                var durMin = matchAct.endMin - matchAct.startMin;

                html += '<td';
                if (span > 1) html += ' colspan="' + span + '"';
                html += ' class="cell-' + type + '" data-r="' + rowR + '" data-c="' + (1 + colIdx) + '" data-cell-text="' + escHtml(displayText) + '" data-bunk="' + escHtml(bunk) + '" data-slot="' + matchAct.slotIdx + '" data-div="' + escHtml(divName) + '"';
                html += ' title="' + escHtml(displayText + ' (' + durMin + ' min)') + '"';
                var pillBg = type === 'pinned' ? '#FFF8E1' : type === 'league' ? '#EFF6FF' : type === 'free' ? '#F9FAFB' : '#EEF6FF';
                var pillTx = type === 'pinned' ? '#92400E' : type === 'league' ? '#1E40AF' : type === 'free' ? '#94A3B8' : '#1E3A5F';
                html += ' style="padding:3px;vertical-align:middle;">';
                // ★ Split-swim change: show Change → Swim → Change subdivisions
                var splitPre = matchAct.entry ? (matchAct.entry._splitPreChange || 0) : 0;
                var splitPost = matchAct.entry ? (matchAct.entry._splitPostChange || 0) : 0;
                if (splitPre > 0 || splitPost > 0) {
                    var swimMin = durMin - splitPre - splitPost;
                    html += '<div style="border-radius:5px;overflow:hidden;min-height:38px;display:flex;flex-direction:column;">';
                    if (splitPre > 0) {
                        html += '<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;text-align:center;font-size:10px;font-weight:500;border-bottom:1px solid #F59E0B;">Change</div>';
                    }
                    html += '<div style="background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;flex:1;display:flex;flex-direction:column;justify-content:center;">';
                    html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' + escHtml(actText || displayText) + '</span>';
                    html += '</div>';
                    if (splitPost > 0) {
                        html += '<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;text-align:center;font-size:10px;font-weight:500;border-top:1px solid #F59E0B;">Change</div>';
                    }
                    html += '</div></td>';
                } else {
                    html += '<div style="border-radius:5px;background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;min-height:38px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;">';
                    html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' + escHtml(actText || displayText) + '</span>';
                    // ★ Day 22.5+: duration line tagged with .pc3-dur so CSS toggle can hide it without re-render
                    if (durMin > inc) html += '<span class="pc3-dur" style="font-size:9px;opacity:.65;margin-top:1px;">' + durMin + 'm</span>';
                    html += '</div></td>';
                }

                colIdx = nextCol;
            } else {
                html += '<td class="cell-free" data-r="' + rowR + '" data-c="' + (1 + colIdx) + '" data-cell-text="\u2014" style="text-align:center;font-size:9px;">\u2014</td>';
                colIdx++;
            }
        }

        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

// ── MANUAL MODE: Bunks on top ──
function renderManualBunksTop(divName, bunks, blocks) {
    var t = _currentTemplate;
    var totalDataCols = 1 + bunks.length;
    var sheetId = pcNextSheetId();
    var firstStart = blocks.length ? blocks[0].startMin : 0;
    var lastEnd = blocks.length ? blocks[blocks.length - 1].endMin : 0;
    var html = '<div class="pc3-sheet-table-wrap" style="overflow:auto;position:relative;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="manual-bunks-top" data-day-start="' + firstStart + '" data-day-end="' + lastEnd + '">';
    html += '<thead>';
    html += pcCoordRow(totalDataCols);
    html += '<tr>';
    html += pcRowNum(0);
    html += '<th class="corner" data-r="0" data-c="0" data-cell-text="Time" style="min-width:' + t.timeColWidth + 'px;">Time</th>';
    bunks.forEach(function (b, bi) {
        html += '<th data-r="0" data-c="' + (1 + bi) + '" data-cell-text="' + escHtml(b) + '">' + escHtml(b) + '</th>';
    });
    html += '</tr></thead><tbody>';

    blocks.forEach(function (eb, blkIdx) {
        var rowR = 1 + blkIdx;
        html += '<tr data-block-start="' + eb.startMin + '" data-block-end="' + eb.endMin + '">';
        html += pcRowNum(rowR);
        html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(eb.label) + '">' + eb.label + '</th>';
        if (eb.isLeague) {
            // ★ #V2-17: escape the league event + matchup names (user-controlled) before
            //   injecting; keep the intentional <br>. The sibling paths (renderManualTimeTop
            //   L2320, live views L3654/3618/3598) already escape — this was the lone raw render.
            var leagueText = escHtml(eb.event);
            if (!_currentTemplate.hideLeagueMatchups) {
                var matchups = buildLeagueMatchups(eb, divName);
                if (matchups.length) leagueText += '<br>' + escHtml(matchups.join(', '));
            }
            html += '<td class="cell-league" data-r="' + rowR + '" data-c="1" data-cell-text="' + escHtml(eb.event) + '" colspan="' + bunks.length + '" style="text-align:center;"><strong>' + leagueText + '</strong></td>';
        } else {
            bunks.forEach(function (b, bi) {
                var si = findFirstSlotForTime(eb.startMin, divName);
                var entry = si >= 0 ? getEntry(b, si) : null;
                var type = getEntryType(entry);
                var text = entry ? formatEntry(entry) : '';
                if (text && si >= 0) {
                    var _sh = pcFindFieldSharers(b, si, divName);
                    if (_sh.length) {
                        var _names = _sh.map(function(x){ return /^\d/.test(String(x)) ? 'Bunk ' + x : x; });
                        text += ' vs ' + _names.join(', ');
                    }
                }
                if (!text && type === 'free') text = '\u2014';
                var inner = pcCellInnerHtml(text, type, {
                    preChange: entry ? (entry._splitPreChange || 0) : 0,
                    postChange: entry ? (entry._splitPostChange || 0) : 0
                });
                html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="' + (1 + bi) + '" data-cell-text="' + escHtml(text) + '" data-bunk="' + escHtml(b) + '" data-slot="' + si + '" data-div="' + escHtml(divName) + '">' + inner + '</td>';
            });
        }
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

// ── MANUAL MODE: Time on top ──
function renderManualTimeTop(divName, bunks, blocks) {
    var t = _currentTemplate;
    var totalDataCols = 1 + blocks.length;
    var sheetId = pcNextSheetId();
    var firstStart = blocks.length ? blocks[0].startMin : 0;
    var lastEnd = blocks.length ? blocks[blocks.length - 1].endMin : 0;
    var html = '<div class="pc3-sheet-table-wrap" style="overflow:auto;position:relative;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="manual-time-top" data-day-start="' + firstStart + '" data-day-end="' + lastEnd + '">';
    html += '<thead>';
    html += pcCoordRow(totalDataCols);
    html += '<tr>';
    html += pcRowNum(0);
    html += '<th class="corner" data-r="0" data-c="0" data-cell-text="Bunk">Bunk</th>';
    blocks.forEach(function (bl, bi) {
        html += '<th data-r="0" data-c="' + (1 + bi) + '" data-cell-text="' + escHtml(bl.label) + '" data-block-start="' + bl.startMin + '" data-block-end="' + bl.endMin + '" style="font-size:' + Math.max(8, t.gridFontSize - 1) + 'px;">' + bl.label + '</th>';
    });
    html += '</tr></thead><tbody>';

    bunks.forEach(function (b, bi) {
        var rowR = 1 + bi;
        html += '<tr>';
        html += pcRowNum(rowR);
        html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(b) + '">' + escHtml(b) + '</th>';
        blocks.forEach(function (eb, blkIdx) {
            var si = findFirstSlotForTime(eb.startMin, divName);
            var entry = si >= 0 ? getEntry(b, si) : null;
            var type = getEntryType(entry);
            var text = entry ? formatEntry(entry) : '';
            if (text && si >= 0 && !eb.isLeague) {
                var _sh = pcFindFieldSharers(b, si, divName);
                if (_sh.length) {
                    var _names = _sh.map(function(x){ return /^\d/.test(String(x)) ? 'Bunk ' + x : x; });
                    text += ' vs ' + _names.join(', ');
                }
            }
            if (!text && type === 'free') text = '\u2014';
            if (eb.isLeague) {
                type = 'league';
                text = eb.event;
                if (!_currentTemplate.hideLeagueMatchups) {
                    var matchups = buildLeagueMatchups(eb, divName);
                    if (matchups.length) text += ' | ' + matchups.join(', ');
                }
                html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="' + (1 + blkIdx) + '" data-cell-text="' + escHtml(text) + '" data-bunk="' + escHtml(b) + '" data-slot="' + si + '" data-div="' + escHtml(divName) + '">' + escHtml(text) + '</td>';
            } else {
                var inner = pcCellInnerHtml(text, type, {
                    preChange: entry ? (entry._splitPreChange || 0) : 0,
                    postChange: entry ? (entry._splitPostChange || 0) : 0
                });
                html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="' + (1 + blkIdx) + '" data-cell-text="' + escHtml(text) + '" data-bunk="' + escHtml(b) + '" data-slot="' + si + '" data-div="' + escHtml(divName) + '">' + inner + '</td>';
            }
        });
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

// ── Bunk View ──
// ★ Zone travel-buffer display (render-only): split a per-bunk schedule row
//   whose activity is on a zoned field into [travel-pre][activity (shrunk)]
//   [travel-post], so the printed sheet shows the travel time around a far-zone
//   field. Reads the field's zone transition via getTransitionRules; makes NO
//   change to the generated schedule. Complete no-op when no zone with a
//   transition applies → identical output for every non-zoned schedule.
function _pcExpandZoneBuffers(schedule, bunk, dn) {
    var SCU = window.SchedulerCoreUtils;
    if (!SCU || typeof SCU.getTransitionRules !== 'function') return schedule;
    function fmt(m) {
        if (SCU.fmtTime) return SCU.fmtTime(m);
        var h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ' ' + ap;
    }
    var out = [];
    schedule.forEach(function (slot) {
        var slotIdx = findFirstSlotForTime(slot.startMin, dn);
        var entry = slotIdx >= 0 ? getEntry(bunk, slotIdx) : null;
        var fld = (entry && !entry.continuation)
            ? (typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name) || entry._activity || '')
            : '';
        var trans = fld ? SCU.getTransitionRules(fld, window.activityProperties) : null;
        var pre = (trans && trans.preMin > 0) ? trans.preMin : 0;
        var post = (trans && trans.postMin > 0) ? trans.postMin : 0;
        if (entry && !entry.continuation && (pre > 0 || post > 0) && (slot.endMin - slot.startMin) > (pre + post + 4)) {
            var effS = slot.startMin + pre, effE = slot.endMin - post;
            if (pre > 0) out.push({ startMin: slot.startMin, endMin: effS, label: fmt(slot.startMin) + ' - ' + fmt(effS), _travelBuffer: true });
            out.push({ startMin: effS, endMin: effE, label: fmt(effS) + ' - ' + fmt(effE), event: slot.event, isLeague: slot.isLeague, _lookupStart: slot.startMin });
            if (post > 0) out.push({ startMin: effE, endMin: slot.endMin, label: fmt(effE) + ' - ' + fmt(slot.endMin), _travelBuffer: true });
        } else {
            out.push(slot);
        }
    });
    return out;
}

// ★ Prep lead-in (manual mode): split a special that configured prepDuration
//   into [🍳 Prep][activity], mirroring the zone travel buffer. The slot entry
//   carries _prepDuration/_prepLabel (stamped by computeManualSpecialFeatures in
//   scheduler_core_main.js). Render-only; no-op when no prep is configured.
function _pcExpandPrepBlocks(schedule, bunk, dn) {
    function fmt(m) {
        var SCU = window.SchedulerCoreUtils;
        if (SCU && SCU.fmtTime) return SCU.fmtTime(m);
        var h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ' ' + ap;
    }
    var out = [];
    schedule.forEach(function (slot) {
        if (slot._travelBuffer || slot._prepBuffer) { out.push(slot); return; }
        var lookup = slot._lookupStart != null ? slot._lookupStart : slot.startMin;
        var slotIdx = findFirstSlotForTime(lookup, dn);
        var entry = slotIdx >= 0 ? getEntry(bunk, slotIdx) : null;
        var prep = (entry && !entry.continuation && entry._prepDuration > 0) ? entry._prepDuration : 0;
        if (prep > 0 && (slot.endMin - slot.startMin) > (prep + 4)) {
            var pS = slot.startMin, pE = slot.startMin + prep;
            out.push({ startMin: pS, endMin: pE, label: fmt(pS) + ' - ' + fmt(pE), _prepBuffer: true, _prepLabel: entry._prepLabel || 'Prep', _prepLocation: entry._prepLocation || '' });
            out.push({ startMin: pE, endMin: slot.endMin, label: fmt(pE) + ' - ' + fmt(slot.endMin), event: slot.event, isLeague: slot.isLeague, _lookupStart: lookup });
        } else {
            out.push(slot);
        }
    });
    return out;
}

function renderBunkSheet(bunk) {
    var t = _currentTemplate;
    var divs = getDivisions(), dn = null;
    for (var d in divs) { if (divs[d].bunks && divs[d].bunks.indexOf(bunk) >= 0) { dn = d; break; } }
    var schedule = isAutoMode() ? getPerBunkSchedule(bunk, dn) : [];

    if (!isAutoMode()) {
        // Build from division blocks
        var blocks = dn ? buildDivisionBlocks(dn) : [];
        schedule = blocks.map(function (b) { return { startMin: b.startMin, endMin: b.endMin, label: b.label, event: b.event, isLeague: b.isLeague }; });
        // ★ Zone travel-buffer: split zoned activity rows into travel + activity + travel
        schedule = _pcExpandZoneBuffers(schedule, bunk, dn);
        // ★ Prep lead-in: split special rows that configured a prep duration
        schedule = _pcExpandPrepBlocks(schedule, bunk, dn);
    }

    var html = '<div class="pc3-sheet"><div class="pc3-sheet-head"><span class="pc3-sheet-title">' + escHtml(bunk) + '</span>';
    if (dn) html += '<span class="pc3-sheet-subtitle">' + escHtml(dn) + '</span>';
    if (t.showDate) html += '<span class="pc3-sheet-subtitle">' + formatDisplayDate(window.currentScheduleDate) + '</span>';
    html += '</div>';

    var sheetId = pcNextSheetId();
    html += '<div class="pc3-sheet-table-wrap" style="overflow:auto;position:relative;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="bunk">';
    html += '<thead>';
    html += pcCoordRow(3);
    html += '<tr>';
    html += pcRowNum(0);
    html += '<th data-r="0" data-c="0" data-cell-text="Time" style="min-width:' + t.timeColWidth + 'px;">Time</th>';
    html += '<th data-r="0" data-c="1" data-cell-text="Activity">Activity</th>';
    html += '<th data-r="0" data-c="2" data-cell-text="Location">Location</th>';
    html += '</tr></thead><tbody>';

    schedule.forEach(function (slot, idx) {
        var rowR = 1 + idx;
        // ★ Zone travel-buffer synthetic row — render directly (no entry lookup)
        if (slot._travelBuffer) {
            html += '<tr data-block-start="' + slot.startMin + '" data-block-end="' + slot.endMin + '">';
            html += pcRowNum(rowR);
            html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(slot.label) + '">' + slot.label + '</th>';
            html += '<td data-r="' + rowR + '" data-c="1" data-cell-text="Travel" style="color:#b45309;font-style:italic;background:repeating-linear-gradient(45deg,#FEF3C7,#FEF3C7 6px,#FDE68A 6px,#FDE68A 12px);">🚶 Travel</td>';
            html += '<td data-r="' + rowR + '" data-c="2" data-cell-text=""></td>';
            html += '</tr>';
            return;
        }
        // ★ Prep lead-in synthetic row (manual special prep) — render directly
        if (slot._prepBuffer) {
            var _prepTxt = '🍳 ' + (slot._prepLabel || 'Prep');
            html += '<tr data-block-start="' + slot.startMin + '" data-block-end="' + slot.endMin + '">';
            html += pcRowNum(rowR);
            html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(slot.label) + '">' + slot.label + '</th>';
            html += '<td data-r="' + rowR + '" data-c="1" data-cell-text="' + escHtml(_prepTxt) + '" style="color:#7c3aed;font-style:italic;background:repeating-linear-gradient(45deg,#EDE9FE,#EDE9FE 6px,#DDD6FE 6px,#DDD6FE 12px);">' + escHtml(_prepTxt) + '</td>';
            var _prepLoc = slot._prepLocation || '';
            html += '<td data-r="' + rowR + '" data-c="2" data-cell-text="' + escHtml(_prepLoc) + '" style="color:#7c3aed;font-style:italic;">' + escHtml(_prepLoc) + '</td>';
            html += '</tr>';
            return;
        }
        var slotIdx = isAutoMode() ? idx : findFirstSlotForTime(slot._lookupStart != null ? slot._lookupStart : slot.startMin, dn);
        var entry = slotIdx >= 0 ? getEntry(bunk, slotIdx) : null;
        var type = getEntryType(entry);
        var act = '', loc = '';
        if (entry && !entry.continuation) {
            act = entry._partLabel || entry._activity || entry.sport || ''; // ★ Day 19 multiPart label
            // ★ Custom/pinned tile with specific fields → show "Field 1, Field 2".
            if (!entry._swimElective && Array.isArray(entry._reservedFields) && entry._reservedFields.filter(Boolean).length) {
                loc = entry._reservedFields.filter(Boolean).join(', ');
            } else {
                loc = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
            }
            if (!act && loc) { act = loc; loc = ''; }
        }
        var actDisplay = act || '\u2014';
        var locDisplay = loc;
        if (entry && slotIdx >= 0 && !isAutoMode()) {
            var _sh = pcFindFieldSharers(bunk, slotIdx, dn);
            if (_sh.length) {
                var _names = _sh.map(function(x){ return /^\d/.test(String(x)) ? 'Bunk ' + x : x; });
                locDisplay = (loc ? loc + ' ' : '') + 'vs ' + _names.join(', ');
            }
        }
        var actInner = pcCellInnerHtml(actDisplay, type, {
            preChange: entry ? (entry._splitPreChange || 0) : 0,
            postChange: entry ? (entry._splitPostChange || 0) : 0
        });
        html += '<tr data-block-start="' + slot.startMin + '" data-block-end="' + slot.endMin + '">';
        html += pcRowNum(rowR);
        html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(slot.label) + '">' + slot.label + '</th>';
        html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="1" data-cell-text="' + escHtml(actDisplay) + '">' + actInner + '</td>';
        html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="2" data-cell-text="' + escHtml(locDisplay) + '">' + escHtml(locDisplay) + '</td>';
        html += '</tr>';
    });

    html += '</tbody></table></div></div>';
    return html;
}

// ── Location View ──
// ── Week At-A-Glance ──────────────────────────────────────────────────
// Rows = selected bunks, Cols = Mon-Sun (or 7-day window from currentDate).
// Each cell shows the bunk's distinct activity titles for that day.
// Designed to print on a single landscape sheet (parent fridge / staff wall).
function renderWeekSheet(selectedBunks) {
    var t = _currentTemplate;
    var keys = getWeekDateKeys(window.currentScheduleDate);
    if (!keys.length) {
        return '<div class="pc3-sheet" style="padding:24px;color:#78716c;">Pick a date first to see the week at a glance.</div>';
    }
    var divs = getDivisions();
    // Map bunk -> division so we can label/group
    var bunkToDiv = {};
    Object.keys(divs).forEach(function (d) {
        ((divs[d] && divs[d].bunks) ? divs[d].bunks : []).forEach(function (b) { bunkToDiv[b] = d; });
    });
    // Filter selection to only bunks that exist
    var bunks = (selectedBunks || []).filter(function (b) { return bunkToDiv[b]; });
    if (!bunks.length) bunks = Object.keys(bunkToDiv);

    var html = '<div class="pc3-sheet"><div class="pc3-sheet-head" style="background:' + t.headerBgColor + ';color:' + t.headerTextColor + ';padding:10px 14px;">';
    html += '<span class="pc3-sheet-title" style="font-size:' + t.headerFontSize + 'px;font-weight:700;">Week at a Glance</span>';
    html += '<span class="pc3-sheet-subtitle" style="float:right;font-size:12px;opacity:.85;">' + formatWeekDayLabel(keys[0]) + ' – ' + formatWeekDayLabel(keys[6]) + '</span>';
    html += '</div>';

    if (_weekLoading) {
        html += '<div style="padding:24px;color:#78716c;font-size:13px;">Loading week from cloud…</div>';
    }

    html += '<div class="pc3-sheet-table-wrap"><table class="pc3-tbl" style="font-size:' + t.gridFontSize + 'px;">';
    // Header row
    html += '<thead><tr>';
    html += '<th style="background:' + t.gridHeaderBgColor + ';color:' + t.gridHeaderTextColor + ';padding:6px 8px;min-width:120px;">Bunk</th>';
    keys.forEach(function (k) {
        var isToday = (k === window.currentScheduleDate);
        html += '<th style="background:' + t.gridHeaderBgColor + ';color:' + t.gridHeaderTextColor + ';padding:6px 8px;text-align:center;' + (isToday ? 'box-shadow:inset 0 -3px 0 #147D91;' : '') + '">' + formatWeekDayLabel(k) + '</th>';
    });
    html += '</tr></thead><tbody>';

    // Group rows by division for readability
    var byDiv = {};
    bunks.forEach(function (b) { var d = bunkToDiv[b] || ''; if (!byDiv[d]) byDiv[d] = []; byDiv[d].push(b); });
    var divOrder = (typeof window.getUserDivisionOrder === 'function')
        ? window.getUserDivisionOrder(Object.keys(byDiv))
        : Object.keys(byDiv);
    var rowR = 0;
    divOrder.forEach(function (d) {
        if (!byDiv[d]) return;
        // Division separator row
        html += '<tr><td colspan="' + (keys.length + 1) + '" style="background:' + t.gridRowAltColor + ';color:' + t.timeColTextColor + ';font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:4px 8px;border-top:1px solid ' + t.gridBorderColor + ';">' + escHtml(d) + '</td></tr>';
        byDiv[d].forEach(function (b) {
            var altBg = (rowR % 2 === 0) ? t.gridRowColor : t.gridRowAltColor;
            html += '<tr data-r="' + rowR + '">';
            html += '<th style="background:' + t.timeColBgColor + ';color:' + t.timeColTextColor + ';font-weight:' + (t.timeColBold ? '700' : '500') + ';padding:5px 8px;text-align:left;">' + escHtml(b) + '</th>';
            keys.forEach(function (k, ci) {
                var day = _weekData[k];
                var bg = altBg;
                if (!day) {
                    html += '<td data-r="' + rowR + '" data-c="' + (ci + 1) + '" style="background:' + bg + ';color:#a8a29e;font-style:italic;font-size:10px;padding:5px 8px;vertical-align:top;">' + (_weekLoading ? '…' : '—') + '</td>';
                    return;
                }
                var labels = summarizeBunkDay(day.scheduleAssignments || {}, b);
                if (!labels.length) {
                    html += '<td class="cell-free" data-r="' + rowR + '" data-c="' + (ci + 1) + '" style="background:' + t.freeBgColor + ';color:' + t.freeTextColor + ';text-align:center;padding:5px 8px;">—</td>';
                    return;
                }
                var inner = labels.slice(0, 8).map(function (a) { return '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;">' + escHtml(a) + '</div>'; }).join('');
                if (labels.length > 8) inner += '<div style="font-size:9px;color:#94a3b8;">+' + (labels.length - 8) + ' more</div>';
                html += '<td class="cell-general" data-r="' + rowR + '" data-c="' + (ci + 1) + '" style="background:' + bg + ';padding:4px 6px;vertical-align:top;">' + inner + '</td>';
            });
            html += '</tr>';
            rowR++;
        });
    });
    html += '</tbody></table></div></div>';
    return html;
}

function renderLocationSheet(loc) {
    var t = _currentTemplate;
    var divs = getDivisions();
    var html = '<div class="pc3-sheet"><div class="pc3-sheet-head"><span class="pc3-sheet-title">' + escHtml(loc) + '</span>';
    if (t.showDate) html += '<span class="pc3-sheet-subtitle">' + formatDisplayDate(window.currentScheduleDate) + '</span>';
    html += '</div>';

    var sheetId = pcNextSheetId();
    html += '<div class="pc3-sheet-table-wrap" style="overflow:auto;position:relative;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="location">';
    html += '<thead>';
    html += pcCoordRow(2);
    html += '<tr>';
    html += pcRowNum(0);
    html += '<th data-r="0" data-c="0" data-cell-text="Time">Time</th>';
    html += '<th data-r="0" data-c="1" data-cell-text="Bunk(s)">Bunk(s)</th>';
    html += '</tr></thead><tbody>';

    var found = scanLocationAcrossBunks(loc);

    if (found.length) {
        found.forEach(function (f, idx) {
            var rowR = 1 + idx;
            var bunkStr = f.bunks.map(escHtml).join(', ');
            html += '<tr>';
            html += pcRowNum(rowR);
            html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(f.label) + '">' + f.label + '</th>';
            html += '<td data-r="' + rowR + '" data-c="1" data-cell-text="' + escHtml(f.bunks.join(', ')) + '">' + bunkStr + '</td>';
            html += '</tr>';
        });
    } else {
        html += '<tr>' + pcRowNum(1) + '<td data-r="1" data-c="0" colspan="2" style="text-align:center;color:#94a3b8;padding:20px;">No schedule data for this location</td></tr>';
    }

    html += '</tbody></table></div></div>';
    return html;
}

/**
 * Scan all bunks across all divisions for a given location/field name.
 * Works correctly in both auto mode (per-bunk slots) and manual mode (division slots).
 * Returns sorted array of { label, bunks[] } objects.
 */
function scanLocationAcrossBunks(loc) {
    var divs = getDivisions();
    // Use a map keyed by time range label to aggregate bunks across divisions
    var byTimeLabel = {};

    var _orderedDivKeys = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(Object.keys(divs)) : Object.keys(divs).sort(naturalSort);

    if (isAutoMode()) {
        // ★★★ AUTO MODE: Each bunk has its own slot indices ★★★
        // We must iterate each bunk individually using its per-bunk slots
        _orderedDivKeys.forEach(function (dn) {
            var bunks = (divs[dn].bunks || []).slice();
            bunks.forEach(function (bk) {
                var bunkSlots = getPerBunkSchedule(bk, dn);
                bunkSlots.forEach(function (slot, si) {
                    var entry = getEntry(bk, si);
                    if (!entry || entry.continuation) return;
                    if (matchesLocation(entry, loc)) {
                        var label = slot.label;
                        if (!byTimeLabel[label]) byTimeLabel[label] = { label: label, startMin: slot.startMin, bunks: [] };
                        if (byTimeLabel[label].bunks.indexOf(bk) === -1) byTimeLabel[label].bunks.push(bk);
                    }
                });
            });
        });
    } else {
        // ★★★ MANUAL MODE: All bunks share division-level slot indices ★★★
        _orderedDivKeys.forEach(function (dn) {
            var divSlots = window.divisionTimes && window.divisionTimes[dn] ? window.divisionTimes[dn] : [];
            var bunks = (divs[dn].bunks || []).slice();
            divSlots.forEach(function (slot, si) {
                bunks.forEach(function (bk) {
                    var entry = getEntry(bk, si);
                    if (!entry || entry.continuation) return;
                    if (matchesLocation(entry, loc)) {
                        var label = minutesToTimeLabel(slot.startMin) + ' \u2013 ' + minutesToTimeLabel(slot.endMin);
                        if (!byTimeLabel[label]) byTimeLabel[label] = { label: label, startMin: slot.startMin, bunks: [] };
                        if (byTimeLabel[label].bunks.indexOf(bk) === -1) byTimeLabel[label].bunks.push(bk);
                    }
                });
            });
        });
    }

    // Sort by start time only — bunk lists within each entry already follow
    // the user-defined division/bunk iteration order from above.
    return Object.values(byTimeLabel).sort(function (a, b) { return a.startMin - b.startMin; });
}

/**
 * Check if an entry's field or activity matches a given location name.
 * Handles string fields, object fields, compound "Activity – Location" fields, and _activity.
 */
function matchesLocation(entry, loc) {
    if (!entry) return false;
    var fn = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
    if (fn === loc) return true;
    if (entry._activity && entry._activity === loc) return true;
    // Compound check: field contains the location name (e.g. "Basketball – Court 1" matches "Court 1")
    if (fn && fn.indexOf(loc) >= 0) return true;
    return false;
}

// =========================================================================
// LIVE REFRESH
// =========================================================================

// ── COMBINED AUTO TABLE: all bunks from all divisions in one grid ──
function renderCombinedAutoTable(divBunks) {
    var inc = _timeIncrement;
    var VARIABLE_LAYER_TYPES = { 'slot': 1, 'sport': 1, 'special': 1, 'activity': 1, 'sports': 1, 'elective': 1, 'swim_elective': 1, 'smart': 1, 'split': 1, 'league': 1, 'specialty_league': 1 };

    // Build unified bunkActs and day range from all bunks
    var bunkActs = {};
    var dayStart = Infinity, dayEnd = -Infinity;
    var firstDiv = divBunks.length ? divBunks[0].div : null;

    divBunks.forEach(function (item) {
        var bunk = item.bunk, divName = item.div;
        var slots = getPerBunkSchedule(bunk, divName);
        var acts = [];
        for (var i = 0; i < slots.length; i++) {
            var entry = getEntry(bunk, i);
            if (entry && entry.continuation && acts.length > 0) {
                acts[acts.length - 1].endMin = slots[i].endMin; continue;
            }
            acts.push({ startMin: slots[i].startMin, endMin: slots[i].endMin, entry: entry || null, slotIdx: i, type: entry ? getEntryType(entry) : 'free' });
            if (slots[i].startMin < dayStart) dayStart = slots[i].startMin;
            if (slots[i].endMin > dayEnd) dayEnd = slots[i].endMin;
        }
        bunkActs[bunk] = acts;
    });

    if (dayStart === Infinity) dayStart = 480;
    if (dayEnd === -Infinity) dayEnd = 960;
    // ★ Do NOT snap dayStart down to the increment grid: a 12:20 day start
    //   would fabricate a 12:00 column nobody occupies (a striped "hasn't
    //   started" band for every bunk). Columns start at the true first
    //   minute; only the end is padded out to a full column.
    dayEnd = Math.ceil(dayEnd / inc) * inc;

    // Build activity ranges
    // ★ Day 22.5+: hasRealBellSchedule reads window.campPeriods (the actual
    //   Bell Schedule editor), NOT DAW layer templates. DAW templates are
    //   scheduling intent (Sport/Special/Swim/Lunch) — not bell periods.
    var activityRanges = [];
    var hasRealBellSchedule = false;
    try {
        var _cpC = firstDiv && window.campPeriods && window.campPeriods[firstDiv];
        if (Array.isArray(_cpC) && _cpC.length > 0) {
            hasRealBellSchedule = true;
            _cpC.forEach(function (p) {
                if (p && typeof p.startMin === 'number' && typeof p.endMin === 'number') {
                    activityRanges.push({ startMin: p.startMin, endMin: p.endMin, name: p.name || null });
                }
            });
        }
    } catch (_eCp) { /* ignore */ }
    var bellLayers = (!hasRealBellSchedule && firstDiv) ? getBellScheduleLayers(firstDiv) : null;
    if (bellLayers && bellLayers.length) {
        bellLayers.forEach(function (layer) {
            var lt = (layer.type || '').toLowerCase();
            if (VARIABLE_LAYER_TYPES[lt]) activityRanges.push({ startMin: layer.startMin, endMin: layer.endMin, name: layer.name || layer.label || null });
        });
        activityRanges.sort(function (a, b) { return a.startMin - b.startMin; });
        var merged = [];
        activityRanges.forEach(function (r) {
            var last = merged.length ? merged[merged.length - 1] : null;
            if (last && r.startMin < last.endMin) { last.endMin = Math.max(last.endMin, r.endMin); }
            else merged.push({ startMin: r.startMin, endMin: r.endMin, name: r.name });
        });
        activityRanges = merged;
    }

    // Method 2: Fallback — infer from _perBunkSlots slot types (use firstDiv's first bunk)
    if (activityRanges.length === 0 && firstDiv) {
        var perBunkSlotsObj2 = window.divisionTimes && window.divisionTimes[firstDiv] && window.divisionTimes[firstDiv]._perBunkSlots
            ? window.divisionTimes[firstDiv]._perBunkSlots : null;
        var firstBunk2 = divBunks.length ? divBunks[0].bunk : null;
        if (perBunkSlotsObj2 && firstBunk2 !== null) {
            var firstSlots2 = perBunkSlotsObj2[String(firstBunk2)] || [];
            var curRangeC = null;
            firstSlots2.forEach(function (slot) {
                var slotType = (slot.type || '').toLowerCase();
                var isVariable = slotType !== 'pinned' && slotType !== '';
                if (isVariable) {
                    if (curRangeC && slot.startMin < curRangeC.endMin) {
                        curRangeC.endMin = Math.max(curRangeC.endMin, slot.endMin);
                    } else {
                        if (curRangeC) activityRanges.push(curRangeC);
                        curRangeC = { startMin: slot.startMin, endMin: slot.endMin, name: slot.label || null };
                    }
                } else {
                    if (curRangeC) { activityRanges.push(curRangeC); curRangeC = null; }
                }
            });
            if (curRangeC) activityRanges.push(curRangeC);
        }
    }

    // Method 2b: Fallback — infer from divisionTimes[firstDiv] shared slots
    if (activityRanges.length === 0 && firstDiv) {
        var divSlotsC = window.divisionTimes && window.divisionTimes[firstDiv] ? window.divisionTimes[firstDiv] : null;
        if (divSlotsC && Array.isArray(divSlotsC) && divSlotsC.length > 0) {
            var curRange2C = null;
            divSlotsC.forEach(function (slot) {
                var slotType2 = (slot.type || '').toLowerCase();
                var isVar2 = slotType2 !== 'pinned' && slotType2 !== '';
                if (isVar2) {
                    if (curRange2C && slot.startMin < curRange2C.endMin) {
                        curRange2C.endMin = Math.max(curRange2C.endMin, slot.endMin);
                    } else {
                        if (curRange2C) activityRanges.push(curRange2C);
                        curRange2C = { startMin: slot.startMin, endMin: slot.endMin, name: slot.label || slot.event || null };
                    }
                } else {
                    if (curRange2C) { activityRanges.push(curRange2C); curRange2C = null; }
                }
            });
            if (curRange2C) activityRanges.push(curRange2C);
        }
    }

    var hasRealPeriodsC = hasRealBellSchedule;
    if (!activityRanges.length) activityRanges.push({ startMin: dayStart, endMin: dayEnd, name: null });

    // Build time columns — activity-aligned by default
    var timeCols = [];
    var t, tEnd, pIdx, ri;
    if (_activityAligned) {
        var boundarySet = {};
        boundarySet[dayStart] = true; boundarySet[dayEnd] = true;
        Object.keys(bunkActs).forEach(function (bk) {
            (bunkActs[bk] || []).forEach(function (a) {
                if (a.startMin >= dayStart && a.startMin <= dayEnd) boundarySet[a.startMin] = true;
                if (a.endMin >= dayStart && a.endMin <= dayEnd) boundarySet[a.endMin] = true;
            });
        });
        var boundaries = Object.keys(boundarySet).map(Number).sort(function (a, b) { return a - b; });
        for (var bi = 0; bi < boundaries.length - 1; bi++) {
            t = boundaries[bi]; tEnd = boundaries[bi + 1]; pIdx = -1;
            for (ri = 0; ri < activityRanges.length; ri++) {
                if (t >= activityRanges[ri].startMin && t < activityRanges[ri].endMin) { pIdx = ri; break; }
            }
            timeCols.push({ startMin: t, endMin: tEnd, label: minutesToTimeLabel(t), periodIdx: pIdx });
        }
    } else {
        for (t = dayStart; t < dayEnd; t += inc) {
            pIdx = -1;
            for (ri = 0; ri < activityRanges.length; ri++) {
                if (t >= activityRanges[ri].startMin && t < activityRanges[ri].endMin) { pIdx = ri; break; }
            }
            timeCols.push({ startMin: t, endMin: Math.min(t + inc, dayEnd), label: minutesToTimeLabel(t), periodIdx: pIdx });
        }
    }
    var numCols = timeCols.length;
    var colW = _activityAligned
        ? Math.max(80, Math.min(160, 1000 / Math.max(1, numCols)))
        : Math.max(44, Math.min(90, 800 / numCols));

    var sheetId = pcNextSheetId();
    var html = '<div class="pc3-sheet-table-wrap" style="overflow:auto;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="auto" style="table-layout:fixed;border-collapse:collapse;">';
    html += '<thead>';

    // ★ Period header row — ONLY when real Bell Schedule defined
    if (hasRealPeriodsC) {
        html += '<tr>';
        html += '<th class="corner" rowspan="2" style="min-width:80px;width:80px;background:#f8fafc;border:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;vertical-align:middle;">Bunk</th>';
        var ci = 0;
        while (ci < numCols) {
            var col = timeCols[ci];
            if (col.periodIdx >= 0) {
                var pStart = ci, pId = col.periodIdx;
                while (ci < numCols && timeCols[ci].periodIdx === pId) ci++;
                var pSpan = ci - pStart;
                var range = activityRanges[pId];
                var periodName = range.name || ('Period ' + (pId + 1));
                html += '<th colspan="' + pSpan + '" style="text-align:center;background:#147D91;color:#fff;font-size:11px;font-weight:600;padding:6px 4px;border:1px solid #0e6b7e;border-bottom:none;">';
                html += escHtml(periodName);
                html += '<div style="font-size:9px;font-weight:400;opacity:.85;margin-top:2px;">' + minutesToTimeLabel(range.startMin) + ' – ' + minutesToTimeLabel(range.endMin) + '</div>';
                html += '</th>';
            } else {
                html += '<th style="background:#f1f5f9;border:1px solid #e2e8f0;border-bottom:none;padding:2px;"></th>';
                ci++;
            }
        }
        html += '</tr>';
    }

    // Time label row (the ONLY header row when no Bell Schedule)
    html += '<tr>';
    if (!hasRealPeriodsC) {
        html += '<th class="corner" style="min-width:80px;width:80px;background:#f8fafc;border:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;vertical-align:middle;">Bunk</th>';
    }
    timeCols.forEach(function (col) {
        var bg = col.periodIdx >= 0 ? '#f0f9ff' : '#f8fafc';
        var labelTxt = _activityAligned
            ? (col.label + ' – ' + minutesToTimeLabel(col.endMin))
            : col.label;
        var fSize = _activityAligned ? 10 : (inc <= 10 ? 8 : 9);
        html += '<th style="min-width:' + colW + 'px;width:' + colW + 'px;font-size:' + fSize + 'px;text-align:center;padding:3px 4px;color:#64748b;background:' + bg + ';border:1px solid #e2e8f0;font-weight:500;white-space:nowrap;">' + labelTxt + '</th>';
    });
    html += '</tr></thead><tbody>';

    // One row per bunk, with division label injected between divisions
    var lastDiv = null;
    divBunks.forEach(function (item, bunkIdx) {
        var bunk = item.bunk, divName = item.div;

        // Division separator row
        if (divName !== lastDiv) {
            lastDiv = divName;
            html += '<tr><th colspan="' + (1 + numCols) + '" style="background:#f1f5f9;padding:4px 12px;font-size:11px;font-weight:700;color:#147D91;border:1px solid #e2e8f0;border-top:2px solid #147D91;">' + escHtml(divName) + '</th></tr>';
        }

        html += '<tr>';
        html += '<th style="position:sticky;left:0;z-index:2;background:#fff;min-width:80px;padding:4px 8px;font-size:12px;font-weight:600;border:1px solid #e2e8f0;white-space:nowrap;color:#1e293b;">' + escHtml(bunk) + '</th>';

        var acts = bunkActs[bunk] || [];
        var colIdx = 0;
        while (colIdx < numCols) {
            var colStart = timeCols[colIdx].startMin;
            var colEnd2 = timeCols[colIdx].endMin;
            var matchAct = null;
            for (var ai = 0; ai < acts.length; ai++) {
                if (acts[ai].startMin < colEnd2 && acts[ai].endMin > colStart) { matchAct = acts[ai]; break; }
            }
            if (matchAct) {
                var span = 1, nextCol = colIdx + 1;
                while (nextCol < numCols && timeCols[nextCol].startMin < matchAct.endMin) { span++; nextCol++; }
                var type = matchAct.type;
                var actText = '', locText = '';
                if (matchAct.entry) {
                    actText = matchAct.entry._activity || matchAct.entry.sport || '';
                    locText = typeof matchAct.entry.field === 'string' ? matchAct.entry.field : (matchAct.entry.field && matchAct.entry.field.name ? matchAct.entry.field.name : '');
                    if (!actText && locText) { actText = locText; locText = ''; }
                    if (actText && locText && actText === locText) locText = '';
                }
                var durMin = matchAct.endMin - matchAct.startMin;
                var pillBg = type === 'pinned' ? '#FFF8E1' : type === 'league' ? '#EFF6FF' : type === 'free' ? '#F9FAFB' : '#EEF6FF';
                var pillTx = type === 'pinned' ? '#92400E' : type === 'league' ? '#1E40AF' : type === 'free' ? '#94A3B8' : '#1E3A5F';
                var displayText = actText || '—';
                html += '<td colspan="' + span + '" style="padding:3px;vertical-align:middle;border:1px solid #e2e8f0;" data-r="' + (2+bunkIdx) + '" data-c="' + (1+colIdx) + '" data-cell-text="' + escHtml(displayText) + '" data-bunk="' + escHtml(bunk) + '">';
                // ★ Split-swim change: show Change → Swim → Change subdivisions
                var splitPre2 = matchAct.entry ? (matchAct.entry._splitPreChange || 0) : 0;
                var splitPost2 = matchAct.entry ? (matchAct.entry._splitPostChange || 0) : 0;
                if (splitPre2 > 0 || splitPost2 > 0) {
                    html += '<div style="border-radius:5px;overflow:hidden;min-height:38px;display:flex;flex-direction:column;">';
                    if (splitPre2 > 0) {
                        html += '<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;text-align:center;font-size:10px;font-weight:500;border-bottom:1px solid #F59E0B;">Change</div>';
                    }
                    html += '<div style="background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;flex:1;display:flex;flex-direction:column;justify-content:center;">';
                    html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' + escHtml(displayText) + '</span>';
                    html += '</div>';
                    if (splitPost2 > 0) {
                        html += '<div style="background:#FEF3C7;color:#92400E;padding:2px 6px;text-align:center;font-size:10px;font-weight:500;border-top:1px solid #F59E0B;">Change</div>';
                    }
                    html += '</div></td>';
                } else {
                    html += '<div style="border-radius:5px;background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;min-height:38px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;">';
                    html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' + escHtml(displayText) + '</span>';
                    if (durMin > inc) html += '<span style="font-size:9px;opacity:.65;margin-top:1px;">' + durMin + 'm</span>';
                    html += '</div></td>';
                }
                colIdx = nextCol;
            } else {
                html += '<td style="padding:3px;border:1px solid #e2e8f0;background:#fafafa;" data-r="' + (2+bunkIdx) + '" data-c="' + (1+colIdx) + '" data-cell-text="—"><div style="min-height:38px;"></div></td>';
                colIdx++;
            }
        }
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

function liveRefresh() {
    var sel = getSelectedItems();
    var pc = el('pc3-preview-content'), pe = el('pc3-preview-empty');
    if (!pc) return;
    if (!sel.length) { pc.style.display = 'none'; if (pe) pe.style.display = 'flex'; return; }
    pc.style.display = 'block'; if (pe) pe.style.display = 'none';

    readDesignValues();
    var html = '';

    if (_activeView === 'division') {
        var divs = getDivisions();
        // ★ Day 22.5+: respect user-defined grade order from Campistry Me
        //   (parent divisions first, then grades in the order saved by user).
        //   sel is the list of selected division names from the sidebar.
        sel = (typeof window.getUserDivisionOrder === 'function')
            ? window.getUserDivisionOrder(sel)
            : sel.slice();
        if (_currentTemplate.layoutMode === 'all-bunks' && isAutoMode()) {
            // Combined: gather ALL bunks across all selected divisions → one unified table
            var allDivBunks = [];
            sel.forEach(function (d) {
                var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).slice();
                bunks.forEach(function (b) { allDivBunks.push({ bunk: b, div: d }); });
            });
            html += '<div class="pc3-sheet">';
            if (allDivBunks.length) html += renderCombinedAutoTable(allDivBunks);
            html += '</div>';
        } else if (_currentTemplate.layoutMode === 'all-bunks') {
            // Manual combined
            html += '<div class="pc3-sheet">';
            sel.forEach(function (d) {
                var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).slice();
                if (!bunks.length) return;
                var blocks = buildDivisionBlocks(d);
                html += renderManualBunksTop(d, bunks, blocks);
            });
            html += '</div>';
        } else {
            sel.forEach(function (d) { html += renderDivisionSheet(d); });
        }
    } else if (_activeView === 'bunk') {
        sel.forEach(function (b) { html += renderBunkSheet(b); });
    } else if (_activeView === 'location') {
        sel.forEach(function (l) { html += renderLocationSheet(l); });
    } else if (_activeView === 'week') {
        html += renderWeekSheet(sel);
    }

    pc.innerHTML = html;
    pc.style.transform = 'scale(' + (_zoomLevel / 100) + ')';
    pc.style.transformOrigin = 'top left';

    // Attach Excel-style cell selection (click + click-and-drag)
    attachSheetSelection(pc);

    // Auto-select the first data cell of the first sheet for keyboard nav
    var firstSheet = pc.querySelector('table.pc3-tbl');
    if (firstSheet) {
        var firstCell = firstSheet.querySelector('td[data-r][data-c],th[data-r][data-c]:not(.pc3-coord-corner):not(.pc3-row-num)');
        if (firstCell) {
            var fr = parseInt(firstCell.getAttribute('data-r'));
            var fc = parseInt(firstCell.getAttribute('data-c'));
            setSelection(firstSheet.id, fr, fc, fr, fc);
        }
    }

    // ★ Overlay simulated page-break lines + tag each sheet with its page count.
    //   Done after layout so we can read each sheet's actual rendered height.
    requestAnimationFrame(function () { decoratePageBreaks(pc); });

    // ★ Wire up rich hover tooltips and click-to-jump-to-DA on every data cell.
    attachCellInteractivity(pc);
}

// ─────────────────────────────────────────────────────────────────────────
// CELL INTERACTIVITY
// Hover → rich tooltip (activity, location, sharers, change times).
// Click → jump to Daily Adjustments, scrolled to the matching tile.
// ─────────────────────────────────────────────────────────────────────────
function _pcCellTipEl() {
    var t = document.getElementById('pc3-celltip');
    if (!t) {
        t = document.createElement('div');
        t.id = 'pc3-celltip';
        t.className = 'pc3-celltip';
        document.body.appendChild(t);
    }
    return t;
}

function _pcBuildCellTipHtml(bunk, slotIdx, divName) {
    var entry = window.scheduleAssignments && window.scheduleAssignments[bunk] && window.scheduleAssignments[bunk][slotIdx];
    // ★★★ CB-81: the cell's data-slot index is the PER-BUNK index in auto mode;
    // reading the time from the division-level divisionTimes[div][slotIdx] showed a
    // "When" window that doesn't match the hovered cell. Resolve from the bunk's
    // per-bunk geometry (CB-73 helper), falling back to the division array.
    var _slots81 = (window.SchedulerCoreUtils && window.SchedulerCoreUtils._resolveSlotArray)
        ? window.SchedulerCoreUtils._resolveSlotArray(bunk)
        : ((window.divisionTimes && window.divisionTimes[divName]) || []);
    var slot = _slots81[slotIdx];
    if (!entry) return '';
    var act = entry._partLabel || entry._activity || entry.sport || ''; // ★ Day 19 multiPart label
    var field = (typeof entry.field === 'string') ? entry.field
        : (entry.field && entry.field.name ? entry.field.name : '');
    var title = act || field || 'Free';
    if (act && field && act !== field) title = act;

    var rows = [];
    rows.push('<div class="pc3-celltip-title">' + escHtml(title) + '</div>');
    if (field && field !== act) rows.push('<div class="pc3-celltip-row"><span class="pc3-celltip-label">Where</span><span>' + escHtml(field) + '</span></div>');
    if (slot && slot.startMin != null) {
        rows.push('<div class="pc3-celltip-row"><span class="pc3-celltip-label">When</span><span>' + minutesToTimeLabel(slot.startMin) + ' – ' + minutesToTimeLabel(slot.endMin) + ' (' + (slot.endMin - slot.startMin) + ' min)</span></div>');
    }
    rows.push('<div class="pc3-celltip-row"><span class="pc3-celltip-label">Bunk</span><span>' + escHtml(bunk) + ' &middot; ' + escHtml(divName) + '</span></div>');

    // Sharers (sports only — same rule as the cell-label sharers)
    var sharers = (typeof pcFindFieldSharers === 'function') ? pcFindFieldSharers(bunk, slotIdx, divName) : [];
    if (sharers.length) {
        var names = sharers.map(function (b) { return /^\d/.test(String(b)) ? 'Bunk ' + b : b; });
        rows.push('<div class="pc3-celltip-row"><span class="pc3-celltip-label">With</span><span>' + escHtml(names.join(', ')) + '</span></div>');
    }
    // Change subdivision (split-swim or hybrid)
    var pre = entry._splitPreChange || entry._preChangeMin || 0;
    var post = entry._splitPostChange || entry._postChangeMin || 0;
    if (pre || post) {
        var ch = pre === post ? (pre + 'm') : (pre + 'm pre / ' + post + 'm post');
        rows.push('<div class="pc3-celltip-row"><span class="pc3-celltip-label">Change</span><span>' + ch + '</span></div>');
    }
    // Hybrid pool + electives
    if (entry._swimElective) {
        var acts = entry._electiveActivities || [];
        if (acts.length) rows.push('<div class="pc3-celltip-row"><span class="pc3-celltip-label">Electives</span><span>' + escHtml(acts.join(', ')) + '</span></div>');
    }
    // Tags
    var tag = '';
    if (entry._h2h || entry._isSpecialtyLeague || entry._allMatchups) tag = 'League';
    else if (entry._pinned) tag = 'Pinned';
    else if (entry._fromBackground) tag = 'Background';
    else if (entry._fixed) tag = 'Fixed';
    if (tag) rows.push('<div class="pc3-celltip-row"><span class="pc3-celltip-label">Type</span><span>' + tag + '</span></div>');

    return rows.join('');
}

function _pcPositionCellTip(tipEl, mouseEvent) {
    var x = mouseEvent.clientX, y = mouseEvent.clientY;
    var pad = 14;
    tipEl.style.left = (x + pad) + 'px';
    tipEl.style.top = (y + pad) + 'px';
    // After append, nudge into viewport if overflowing
    requestAnimationFrame(function () {
        var r = tipEl.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) tipEl.style.left = Math.max(8, x - r.width - pad) + 'px';
        if (r.bottom > window.innerHeight - 8) tipEl.style.top = Math.max(8, y - r.height - pad) + 'px';
    });
}

function attachCellInteractivity(pc) {
    if (!pc) return;
    var tip = _pcCellTipEl();
    var hideTimer = null;

    pc.querySelectorAll('td[data-bunk][data-slot]').forEach(function (td) {
        var bunk = td.getAttribute('data-bunk');
        var slotIdx = parseInt(td.getAttribute('data-slot'));
        var divName = td.getAttribute('data-div');
        if (!bunk || isNaN(slotIdx) || !divName) return;

        td.addEventListener('mouseenter', function (ev) {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            var html = _pcBuildCellTipHtml(bunk, slotIdx, divName);
            if (!html) return;
            tip.innerHTML = html;
            _pcPositionCellTip(tip, ev);
            tip.classList.add('show');
        });
        td.addEventListener('mousemove', function (ev) { if (tip.classList.contains('show')) _pcPositionCellTip(tip, ev); });
        td.addEventListener('mouseleave', function () {
            hideTimer = setTimeout(function () { tip.classList.remove('show'); }, 80);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────
// PAGE-BREAK PREVIEW
// Overlays a thin dashed orange line on each sheet at every paper-page
// boundary, plus a 'fits on N pages' badge in the sheet header.
// ─────────────────────────────────────────────────────────────────────────
function decoratePageBreaks(pc) {
    if (!pc) return;
    // Clean up any prior overlays + badges
    pc.querySelectorAll('.pc3-pagebreak').forEach(function (n) { n.remove(); });
    pc.querySelectorAll('.pc3-pages-badge').forEach(function (n) { n.remove(); });

    // Approximate paper sizes at 96dpi (CSS px), with ~0.5" margins.
    // Letter portrait: 8.5x11 → 816x1056 px (about 60px margin → ~936 usable height).
    var paper = (_currentTemplate && _currentTemplate.paperSize) || 'letter';
    var orient = (_currentTemplate && _currentTemplate.orientation) || 'landscape';
    var dims = { letter: { w: 816, h: 1056 }, a4: { w: 794, h: 1123 }, legal: { w: 816, h: 1344 } }[paper] || { w: 816, h: 1056 };
    var paperHeightPx = (orient === 'portrait' ? dims.h : dims.w);
    var marginPx = 60; // top + bottom
    var usable = Math.max(200, paperHeightPx - marginPx);

    pc.querySelectorAll('.pc3-sheet').forEach(function (sheet) {
        var rect = sheet.getBoundingClientRect();
        // The sheet's height is what matters for the break overlay.
        // We draw lines every `usable` px from the top of the sheet content.
        var sheetHeight = sheet.offsetHeight;
        var pages = Math.max(1, Math.ceil(sheetHeight / usable));

        // Draw dashed line + page label for each break
        for (var i = 1; i < pages; i++) {
            var line = document.createElement('div');
            line.className = 'pc3-pagebreak';
            line.style.top = (i * usable) + 'px';
            line.setAttribute('data-page', 'Page ' + (i + 1));
            sheet.appendChild(line);
        }

        // Add a "N pages" badge to the sheet header if a header exists
        var head = sheet.querySelector('.pc3-sheet-head');
        if (head) {
            var badge = document.createElement('span');
            badge.className = 'pc3-pages-badge';
            badge.textContent = pages === 1 ? '1 page' : pages + ' pages';
            head.appendChild(badge);
        }
    });
}

// =========================================================================
// \u2605\u2605\u2605 EXCEL-STYLE CELL SELECTION \u2605\u2605\u2605
// =========================================================================
function getSheet(sheetId) {
    if (!sheetId) return null;
    return document.getElementById(sheetId);
}

function setSelection(sheetId, ar, ac, fr, fc) {
    _selAnchor = { sheet: sheetId, r: ar, c: ac };
    _selFocus  = { sheet: sheetId, r: fr, c: fc };
    _activeSheet = sheetId;
    paintSelection();
    updateFormulaBar();
}

function paintSelection() {
    // Clear all selection classes across the preview
    var pc = el('pc3-preview-content');
    if (!pc) return;
    pc.querySelectorAll('.pc3-cell-selected,.pc3-cell-active,.pc3-coord-active').forEach(function (n) {
        n.classList.remove('pc3-cell-selected'); n.classList.remove('pc3-cell-active'); n.classList.remove('pc3-coord-active');
    });
    if (!_selAnchor || !_selFocus) return;
    var sheet = getSheet(_selAnchor.sheet);
    if (!sheet) return;
    var r0 = Math.min(_selAnchor.r, _selFocus.r), r1 = Math.max(_selAnchor.r, _selFocus.r);
    var c0 = Math.min(_selAnchor.c, _selFocus.c), c1 = Math.max(_selAnchor.c, _selFocus.c);

    // Highlight every cell whose top-left lies in the rectangle
    sheet.querySelectorAll('[data-r][data-c]').forEach(function (cell) {
        var rr = parseInt(cell.getAttribute('data-r'));
        var cc = parseInt(cell.getAttribute('data-c'));
        if (rr >= r0 && rr <= r1 && cc >= c0 && cc <= c1) {
            cell.classList.add('pc3-cell-selected');
        }
    });
    // Mark the focus cell (anchor) with active outline
    var focusCell = sheet.querySelector('[data-r="' + _selFocus.r + '"][data-c="' + _selFocus.c + '"]');
    if (focusCell) focusCell.classList.add('pc3-cell-active');

    // Highlight matching column letters and row numbers
    sheet.querySelectorAll('tr.pc3-coord-row th[data-col-select]').forEach(function (th) {
        var cc = parseInt(th.getAttribute('data-col-select'));
        if (cc >= c0 && cc <= c1) th.classList.add('pc3-coord-active');
    });
    sheet.querySelectorAll('th.pc3-row-num[data-row-select]').forEach(function (th) {
        var rr = parseInt(th.getAttribute('data-row-select'));
        if (rr >= r0 && rr <= r1) th.classList.add('pc3-coord-active');
    });
}

function updateFormulaBar() {
    var fxCell = el('pc3-fx-cell');
    var fxVal  = el('pc3-fx-val');
    if (!fxCell || !fxVal) return;
    if (!_selAnchor || !_selFocus) { fxCell.textContent = '\u2014'; fxVal.textContent = ''; return; }
    var ar = _selAnchor.r, ac = _selAnchor.c;
    var fr = _selFocus.r,  fc = _selFocus.c;
    var single = (ar === fr && ac === fc);
    if (single) {
        fxCell.textContent = cellId(ar, ac);
        var sheet = getSheet(_selAnchor.sheet);
        var cell = sheet ? sheet.querySelector('[data-r="' + ar + '"][data-c="' + ac + '"]') : null;
        var txt = '';
        if (cell) txt = cell.getAttribute('data-cell-text') || cell.textContent || '';
        fxVal.textContent = txt;
    } else {
        var r0 = Math.min(ar, fr), r1 = Math.max(ar, fr);
        var c0 = Math.min(ac, fc), c1 = Math.max(ac, fc);
        fxCell.textContent = cellId(r0, c0) + ':' + cellId(r1, c1);
        var rows = (r1 - r0 + 1), cols = (c1 - c0 + 1);
        fxVal.textContent = rows + 'R \u00d7 ' + cols + 'C selected';
    }
}

function attachSheetSelection(pc) {
    var dragging = false;
    pc.addEventListener('mousedown', function (e) {
        var t = e.target.closest('td[data-r],th[data-r]');
        if (!t) return;
        // Coord-row column letter / row-number / corner: range-select that row/col
        if (t.matches('tr.pc3-coord-row th[data-col-select]')) {
            var cc = parseInt(t.getAttribute('data-col-select'));
            var sheet = t.closest('table.pc3-tbl');
            if (sheet) {
                var maxR = 0;
                sheet.querySelectorAll('[data-r]').forEach(function (n) { var rr = parseInt(n.getAttribute('data-r')); if (rr > maxR) maxR = rr; });
                setSelection(sheet.id, 0, cc, maxR, cc);
            }
            e.preventDefault();
            return;
        }
        if (t.matches('th.pc3-row-num[data-row-select]')) {
            var rr2 = parseInt(t.getAttribute('data-row-select'));
            var sheet2 = t.closest('table.pc3-tbl');
            if (sheet2) {
                var maxC = 0;
                sheet2.querySelectorAll('[data-c]').forEach(function (n) { var cc2 = parseInt(n.getAttribute('data-c')); if (cc2 > maxC) maxC = cc2; });
                setSelection(sheet2.id, rr2, 0, rr2, maxC);
            }
            e.preventDefault();
            return;
        }
        if (t.matches('th.pc3-coord-corner')) {
            var sheet3 = t.closest('table.pc3-tbl');
            if (sheet3) {
                var maxR3 = 0, maxC3 = 0;
                sheet3.querySelectorAll('[data-r]').forEach(function (n) { var rr3 = parseInt(n.getAttribute('data-r')); if (rr3 > maxR3) maxR3 = rr3; });
                sheet3.querySelectorAll('[data-c]').forEach(function (n) { var cc3 = parseInt(n.getAttribute('data-c')); if (cc3 > maxC3) maxC3 = cc3; });
                setSelection(sheet3.id, 0, 0, maxR3, maxC3);
            }
            e.preventDefault();
            return;
        }
        // Regular data/header cell click
        var sheet4 = t.closest('table.pc3-tbl');
        if (!sheet4) return;
        var r = parseInt(t.getAttribute('data-r'));
        var c = parseInt(t.getAttribute('data-c'));
        if (e.shiftKey && _selAnchor && _selAnchor.sheet === sheet4.id) {
            setSelection(sheet4.id, _selAnchor.r, _selAnchor.c, r, c);
        } else {
            setSelection(sheet4.id, r, c, r, c);
        }
        dragging = true;
        e.preventDefault();
    });
    pc.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var t = e.target.closest('td[data-r],th[data-r]:not(.pc3-row-num):not(.pc3-coord-corner)');
        if (!t) return;
        var sheet = t.closest('table.pc3-tbl');
        if (!sheet || !_selAnchor || _selAnchor.sheet !== sheet.id) return;
        var r = parseInt(t.getAttribute('data-r'));
        var c = parseInt(t.getAttribute('data-c'));
        if (isNaN(r) || isNaN(c)) return;
        setSelection(sheet.id, _selAnchor.r, _selAnchor.c, r, c);
    });
    pc.addEventListener('mouseup', function () { dragging = false; });
}

function findCellAtRC(sheet, r, c) {
    if (!sheet) return null;
    return sheet.querySelector('[data-r="' + r + '"][data-c="' + c + '"]');
}

function moveSelection(dr, dc, extend) {
    if (!_selFocus) return;
    var sheet = getSheet(_selFocus.sheet);
    if (!sheet) return;
    var nr = _selFocus.r + dr;
    var nc = _selFocus.c + dc;
    // Skip past missing positions (e.g., spanned/merged cells) until a real cell exists
    var safety = 200;
    while (safety-- > 0) {
        var cell = findCellAtRC(sheet, nr, nc);
        if (cell) break;
        if (nr < 0 || nc < 0) return;
        if (dr) nr += (dr > 0 ? 1 : -1);
        else if (dc) nc += (dc > 0 ? 1 : -1);
        else return;
    }
    if (extend) {
        setSelection(sheet.id, _selAnchor.r, _selAnchor.c, nr, nc);
    } else {
        setSelection(sheet.id, nr, nc, nr, nc);
    }
    var target = findCellAtRC(sheet, nr, nc);
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function copySelectionToClipboard() {
    if (!_selAnchor || !_selFocus) return false;
    var sheet = getSheet(_selAnchor.sheet);
    if (!sheet) return false;
    var r0 = Math.min(_selAnchor.r, _selFocus.r), r1 = Math.max(_selAnchor.r, _selFocus.r);
    var c0 = Math.min(_selAnchor.c, _selFocus.c), c1 = Math.max(_selAnchor.c, _selFocus.c);
    var rows = [];
    for (var r = r0; r <= r1; r++) {
        var cols = [];
        for (var c = c0; c <= c1; c++) {
            var cell = findCellAtRC(sheet, r, c);
            var txt = '';
            if (cell) txt = (cell.getAttribute('data-cell-text') || cell.textContent || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
            cols.push(txt);
        }
        rows.push(cols.join('\t'));
    }
    var tsv = rows.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tsv).then(function () {
            if (window.showToast) window.showToast('Copied ' + (r1 - r0 + 1) + 'R \u00d7 ' + (c1 - c0 + 1) + 'C', 'success');
        });
    } else {
        // Fallback: hidden textarea
        var ta = document.createElement('textarea');
        ta.value = tsv;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
    }
    return true;
}

// =========================================================================
// ★★★ LIVE MODE ★★★
// Pop-out window for casting to a TV / display screen, with a moving
// time cursor. Uses the same flow.html with ?view=live, which strips
// the app chrome and runs the schedule fullscreen.
// =========================================================================
function openLiveWindow() {
    try {
        var dateKey = window.currentScheduleDate || '';
        var url = (location.pathname || '/flow.html') + '?view=live' + (dateKey ? '&date=' + encodeURIComponent(dateKey) : '');
        var w = window.open(url, 'pc3_live', 'width=1600,height=900,toolbar=no,location=no,menubar=no,status=no');
        if (!w) {
            alert('Pop-out blocked by the browser. Please allow popups for this site and try again.');
            return;
        }
        _liveWindow = w;
        try { w.focus(); } catch (e) {}
    } catch (e) {
        console.error('[PrintCenter] openLiveWindow failed', e);
    }
}

// Standalone live runner (called by flow.html when ?view=live is detected
// in the popped-out window). Takes over the page chrome and renders the
// schedule fullscreen with a moving time cursor.
function runLiveStandalone() {
    document.documentElement.classList.add('pc3-live-standalone');
    document.body.classList.add('pc3-live-standalone-body');

    // Strip the app shell — keep only #print
    var roots = document.querySelectorAll('body > *');
    roots.forEach(function (n) {
        if (n.id === 'print' || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
        if (n.id === 'printable-area') return;
        n.style.display = 'none';
    });

    // Force the print tab visible if the harness uses tab-content visibility
    var printTab = document.getElementById('print');
    if (printTab) {
        printTab.classList.add('active');
        printTab.style.display = 'block';
        printTab.style.position = 'fixed';
        printTab.style.inset = '0';
        printTab.style.background = '#0b1220';
        printTab.style.zIndex = '9999';
    }

    var container = document.getElementById('print-content') || (function () {
        var d = document.createElement('div'); d.id = 'print-content';
        if (printTab) printTab.appendChild(d); else document.body.appendChild(d);
        return d;
    })();

    // Inject styles (reuses pc3-live-* classes)
    container.innerHTML = getStyles() +
        '<div class="pc3-live-overlay" id="pc3-live-overlay" style="position:fixed;inset:0;">' +
        '<div class="pc3-live-header">' +
            '<div class="pc3-live-title" id="pc3-live-title">Camp Schedule</div>' +
            '<div id="pc3-live-page-ind" style="display:none;align-items:center;gap:6px;"></div>' +
            '<div class="pc3-live-clock" id="pc3-live-clock"></div>' +
            '<button class="pc3-live-close" onclick="window.close()">Close</button>' +
        '</div>' +
        '<div class="pc3-live-body" id="pc3-live-body"></div>' +
        '</div>';

    // Set the title once data is loaded (fall back to "Camp Schedule").
    // ★ Prefer the authoritative camp name — the DB camp record exposed via
    //   AccessControl.getCampName(), the same source the dashboard shows — over
    //   the stored settings copy, which goes stale on rename (it kept showing
    //   the old "Camp Awesome" test name). Then app1.campName, then the legacy
    //   top-level fields (a stale one there could shadow the real name).
    function refreshTitle() {
        try {
            var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var nm = '';
            try {
                if (window.AccessControl && typeof window.AccessControl.getCampName === 'function') {
                    var _an = window.AccessControl.getCampName();
                    if (_an && _an !== 'Your Camp' && _an !== 'Unknown Camp') nm = _an;
                }
            } catch (_) {}
            nm = nm || (g.app1 ? g.app1.campName : '') || g.campName || g.camp_name || 'Camp Schedule';
            var titleEl = document.getElementById('pc3-live-title');
            if (titleEl) titleEl.textContent = nm;
            document.title = nm + ' — Live';
        } catch (e) {}
    }

    function tickClock() {
        var clockEl = document.getElementById('pc3-live-clock');
        if (!clockEl) return;
        var now = new Date();
        var h = now.getHours() % 12 || 12;
        var m = String(now.getMinutes()).padStart(2, '0');
        var s = String(now.getSeconds()).padStart(2, '0');
        var ap = now.getHours() >= 12 ? 'PM' : 'AM';
        clockEl.textContent = h + ':' + m + ':' + s + ' ' + ap;
    }

    function tickAll() {
        refreshTitle();
        renderLiveContent();
        positionAllLiveCursors();
    }

    // Trigger normal app initialization so divisions + schedule data load.
    // (initApp1 loads global settings; initDailyAdjustments loads per-date schedule data.)
    setTimeout(function () {
        try { window.initApp1 && window.initApp1(); } catch (e) {}
        try { window.initDailyAdjustments && window.initDailyAdjustments(); } catch (e) {}
    }, 100);

    // Wait until divisions/scheduling data are populated, then start.
    function whenReady(cb) {
        var attempts = 0;
        var iv = setInterval(function () {
            attempts++;
            var hasDivs = window.divisions && Object.keys(window.divisions).length > 0;
            var hasSched = (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0)
                || (window.divisionTimes && Object.keys(window.divisionTimes).length > 0);
            if ((hasDivs && hasSched) || attempts > 80) {
                clearInterval(iv);
                cb();
            }
        }, 250);
    }

    whenReady(function () {
        tickAll();
        // Re-render content every 30s, reposition cursor every 15s, clock every 1s
        if (_liveInterval) clearInterval(_liveInterval);
        if (_liveCursorInterval) clearInterval(_liveCursorInterval);
        _liveInterval = setInterval(tickAll, 30000);
        _liveCursorInterval = setInterval(positionAllLiveCursors, 15000);
        tickClock();
        setInterval(tickClock, 1000);
    });
}

// Compute the [dayStart, dayEnd] of the activity range visible in a live
// section, and position its cursor element along the time axis.
function positionLiveCursor(sectionEl) {
    if (!sectionEl) return;
    var nowMin = getNowMinutes();
    var dayStart = parseInt(sectionEl.getAttribute('data-day-start')) || 0;
    var dayEnd   = parseInt(sectionEl.getAttribute('data-day-end'))   || 0;
    var mode     = sectionEl.getAttribute('data-cursor-mode') || 'auto';
    var cursor   = sectionEl.querySelector('.pc3-live-cursor-v,.pc3-live-cursor-h');
    var tag      = sectionEl.querySelector('.pc3-live-now-tag');
    if (!cursor || !tag) return;

    if (dayEnd <= dayStart || nowMin < dayStart || nowMin > dayEnd) {
        cursor.style.display = 'none';
        tag.style.display = 'none';
        return;
    }
    cursor.style.display = '';
    tag.style.display = '';
    var fraction = (nowMin - dayStart) / (dayEnd - dayStart);

    // Find the time-axis bounding rect to convert fraction -> px
    var table = sectionEl.querySelector('table');
    if (!table) return;
    var tableRect = table.getBoundingClientRect();
    var sectionRect = sectionEl.getBoundingClientRect();

    if (mode === 'auto') {
        // Vertical cursor: spans table height, X interpolated across time-axis cells
        var timeCells = table.querySelectorAll('thead th[data-time-start]');
        if (timeCells.length === 0) return;
        var firstCell = timeCells[0];
        var lastCell = timeCells[timeCells.length - 1];
        var fr = firstCell.getBoundingClientRect();
        var lr = lastCell.getBoundingClientRect();
        var leftEdge = fr.left - sectionRect.left;
        var rightEdge = lr.right - sectionRect.left;
        var x = leftEdge + (rightEdge - leftEdge) * fraction;
        cursor.style.left = x + 'px';
        cursor.style.top = (tableRect.top - sectionRect.top) + 'px';
        cursor.style.height = tableRect.height + 'px';
        tag.style.left = x + 'px';
        tag.style.top = (tableRect.top - sectionRect.top - 2) + 'px';
        tag.textContent = minutesToTimeLabel(nowMin);
    } else {
        // Horizontal cursor: spans table width, Y interpolated across time-block rows
        var rows = table.querySelectorAll('tbody tr[data-block-start]');
        if (rows.length === 0) return;
        var firstRow = rows[0];
        var lastRow = rows[rows.length - 1];
        var fr2 = firstRow.getBoundingClientRect();
        var lr2 = lastRow.getBoundingClientRect();
        var topEdge = fr2.top - sectionRect.top;
        var botEdge = lr2.bottom - sectionRect.top;
        var y = topEdge + (botEdge - topEdge) * fraction;
        cursor.style.top = y + 'px';
        cursor.style.left = (tableRect.left - sectionRect.left) + 'px';
        cursor.style.width = tableRect.width + 'px';
        tag.style.top = y + 'px';
        tag.style.left = (tableRect.left - sectionRect.left + 8) + 'px';
        tag.textContent = minutesToTimeLabel(nowMin);
    }
}

function positionAllLiveCursors() {
    var activePage = document.getElementById('lp-' + _livePageIndex);
    var container = activePage || document;
    container.querySelectorAll('.pc3-live-section').forEach(function (s) { positionLiveCursor(s); });
}

// —— Build HTML for a single division section (auto or manual mode) ——————————————
function buildLiveSectionHTML(divName, bunks, nowMin) {
    var html = '';
    var sectionStart = Infinity, sectionEnd = -Infinity, cursorMode = isAutoMode() ? 'auto' : 'manual';
    if (isAutoMode()) {
        bunks.forEach(function (bunk) {
            var slots = getPerBunkSchedule(bunk, divName);
            slots.forEach(function (s) {
                if (s.startMin < sectionStart) sectionStart = s.startMin;
                if (s.endMin > sectionEnd) sectionEnd = s.endMin;
            });
        });
    } else {
        var blocks0 = buildDivisionBlocks(divName);
        if (blocks0.length) { sectionStart = blocks0[0].startMin; sectionEnd = blocks0[blocks0.length - 1].endMin; }
    }
    if (sectionStart === Infinity) sectionStart = 480;
    if (sectionEnd === -Infinity) sectionEnd = 960;

    html += '<div class="pc3-live-section" data-day-start="' + sectionStart + '" data-day-end="' + sectionEnd + '" data-cursor-mode="' + cursorMode + '" style="margin-bottom:20px;position:relative;">';
    html += '<div style="font-size:18px;font-weight:700;color:#fbbf24;margin-bottom:8px;padding-left:4px;">' + escHtml(divName) + '</div>';
    html += '<div class="pc3-live-cursor-' + (cursorMode === 'auto' ? 'v' : 'h') + '"></div>';
    html += '<div class="pc3-live-now-tag tag-' + (cursorMode === 'auto' ? 'v' : 'h') + '"></div>';

    if (isAutoMode()) {
        var inc = _timeIncrement;
        var lDayStart = Infinity, lDayEnd = -Infinity;
        var lBunkActs = {};
        bunks.forEach(function (bunk) {
            var slots = getPerBunkSchedule(bunk, divName);
            var acts = [];
            for (var i = 0; i < slots.length; i++) {
                var entry = getEntry(bunk, i);
                if (entry && entry.continuation && acts.length > 0) { acts[acts.length - 1].endMin = slots[i].endMin; continue; }
                acts.push({ startMin: slots[i].startMin, endMin: slots[i].endMin, entry: entry, slotIdx: i, type: entry ? getEntryType(entry) : 'free' });
                if (slots[i].startMin < lDayStart) lDayStart = slots[i].startMin;
                if (slots[i].endMin > lDayEnd) lDayEnd = slots[i].endMin;
            }
            lBunkActs[bunk] = acts;
        });
        if (lDayStart === Infinity) lDayStart = 480;
        if (lDayEnd === -Infinity) lDayEnd = 960;
        lDayStart = Math.floor(lDayStart / inc) * inc;
        lDayEnd = Math.ceil(lDayEnd / inc) * inc;

        var lTimeCols = [];
        for (var lt = lDayStart; lt < lDayEnd; lt += inc) {
            lTimeCols.push({ startMin: lt, endMin: lt + inc, label: minutesToTimeLabel(lt) });
        }

        html += '<div style="overflow-x:hidden;"><table class="pc3-live-tbl" style="table-layout:fixed;width:100%;">';
        html += '<thead><tr><th class="corner" style="min-width:80px;">Bunk</th>';
        lTimeCols.forEach(function (tc) {
            var isCurCol = nowMin >= tc.startMin && nowMin < tc.endMin;
            html += '<th data-time-start="' + tc.startMin + '" data-time-end="' + tc.endMin + '" style="min-width:50px;font-size:9px;text-align:center;white-space:nowrap;' + (isCurCol ? 'background:#164e63;color:#67e8f9;box-shadow:inset 0 -3px 0 #fbbf24;' : '') + '">' + tc.label + '</th>';
        });
        html += '</tr></thead><tbody>';

        bunks.forEach(function (bunk) {
            html += '<tr>';
            html += '<th class="row-head">' + escHtml(bunk) + '</th>';
            var acts = lBunkActs[bunk] || [];
            var ci = 0;
            while (ci < lTimeCols.length) {
                var cStart = lTimeCols[ci].startMin;
                var cEnd = lTimeCols[ci].endMin;
                var mAct = null;
                acts.forEach(function (a) { if (a.startMin < cEnd && a.endMin > cStart) mAct = a; });

                if (mAct) {
                    var span = 1;
                    var nextCi = ci + 1;
                    while (nextCi < lTimeCols.length && lTimeCols[nextCi].startMin < mAct.endMin) { span++; nextCi++; }
                    var isCur = nowMin >= mAct.startMin && nowMin < mAct.endMin;
                    var isPast = nowMin >= mAct.endMin;
                    var isLeagueAct = !!(mAct.entry && (mAct.entry._h2h || mAct.entry._league || mAct.entry._isSpecialtyLeague || mAct.entry._allMatchups));
                    var leagueInfo = (isLeagueAct || !mAct.entry) ? pcLeagueInfoAt(divName, mAct.startMin) : null;
                    var txt;
                    if (isLeagueAct || leagueInfo) {
                        var lbl = (mAct.entry && (mAct.entry._gameLabel || mAct.entry._leagueName)) ||
                                  (leagueInfo && leagueInfo.label) || 'League Game';
                        var ms = (leagueInfo && leagueInfo.matchups) || [];
                        txt = lbl + (ms.length && !_currentTemplate.hideLeagueMatchups ? ' | ' + ms.join(', ') : '');
                    } else {
                        txt = mAct.entry ? formatEntry(mAct.entry) : '—';
                        if (mAct.entry && txt && txt !== '—' && mAct.slotIdx != null) {
                            var _liveSh = pcFindFieldSharers(bunk, mAct.slotIdx, divName);
                            if (_liveSh.length) {
                                var _liveNames = _liveSh.map(function (x) { return /^\d/.test(String(x)) ? 'Bunk ' + x : x; });
                                txt += ' vs ' + _liveNames.join(', ');
                            }
                        }
                    }
                    var cls = (isLeagueAct || leagueInfo) ? 'cell-league' : 'cell-' + mAct.type;
                    if (isCur) cls += ' cell-current';
                    if (isPast) cls += ' cell-past';
                    html += '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + ' class="' + cls + '" style="text-align:center;font-size:12px;line-height:1.35;padding:8px 6px;white-space:normal;word-break:break-word;">' + escHtml(txt) + '</td>';
                    ci = nextCi;
                } else {
                    var emptyLeague = pcLeagueInfoAt(divName, cStart);
                    var isCC = nowMin >= cStart && nowMin < cEnd;
                    if (emptyLeague) {
                        var lspan = 1;
                        var lnext = ci + 1;
                        while (lnext < lTimeCols.length) {
                            var nAct = null;
                            acts.forEach(function (a) { if (a.startMin < lTimeCols[lnext].endMin && a.endMin > lTimeCols[lnext].startMin) nAct = a; });
                            if (nAct) break;
                            var nLeague = pcLeagueInfoAt(divName, lTimeCols[lnext].startMin);
                            if (!nLeague || nLeague.label !== emptyLeague.label) break;
                            lspan++; lnext++;
                        }
                        var lTxt = emptyLeague.label + (emptyLeague.matchups.length && !_currentTemplate.hideLeagueMatchups ? ' | ' + emptyLeague.matchups.join(', ') : '');
                        var lCls = 'cell-league' + (isCC ? ' cell-current' : '');
                        html += '<td' + (lspan > 1 ? ' colspan="' + lspan + '"' : '') + ' class="' + lCls + '" style="text-align:center;font-size:12px;line-height:1.35;padding:8px 6px;white-space:normal;word-break:break-word;">' + escHtml(lTxt) + '</td>';
                        ci = lnext;
                    } else {
                        html += '<td class="cell-free' + (isCC ? ' cell-current' : '') + '" style="text-align:center;">—</td>';
                        ci++;
                    }
                }
            }
            html += '</tr>';
        });
        html += '</tbody></table></div>';

    } else {
        var timeSlots = buildDivisionBlocks(divName);
        html += '<table class="pc3-live-tbl"><thead><tr><th class="corner">Time</th>';
        bunks.forEach(function (b) { html += '<th>' + escHtml(b) + '</th>'; });
        html += '</tr></thead><tbody>';

        timeSlots.forEach(function (ts) {
            var isCurrent = nowMin >= ts.startMin && nowMin < ts.endMin;
            var isPast = nowMin >= ts.endMin;
            html += '<tr data-block-start="' + ts.startMin + '" data-block-end="' + ts.endMin + '">';
            html += '<th class="row-head' + (isCurrent ? ' cell-current' : '') + (isPast ? ' cell-past' : '') + '">' + ts.label + '</th>';

            if (ts.isLeague) {
                var leagueText = ts.event;
                if (!_currentTemplate.hideLeagueMatchups) {
                    var matchups = buildLeagueMatchups(ts, divName);
                    if (matchups.length) leagueText += ' | ' + matchups.join(', ');
                }
                var lcls = 'cell-league';
                if (isCurrent) lcls += ' cell-current';
                if (isPast) lcls += ' cell-past';
                html += '<td colspan="' + bunks.length + '" class="' + lcls + '" style="text-align:center;white-space:normal;word-break:break-word;"><strong>' + escHtml(leagueText) + '</strong></td>';
                html += '</tr>';
                return;
            }

            bunks.forEach(function (bunk) {
                var slotIdx = findFirstSlotForTime(ts.startMin, divName);
                var entry = slotIdx >= 0 ? getEntry(bunk, slotIdx) : null;
                var type = getEntryType(entry);
                var text = entry ? formatEntry(entry) : '—';
                if (entry && text !== '—' && slotIdx >= 0) {
                    var _sh = pcFindFieldSharers(bunk, slotIdx, divName);
                    if (_sh.length) {
                        var _names = _sh.map(function(x){ return /^\d/.test(String(x)) ? 'Bunk ' + x : x; });
                        text += ' vs ' + _names.join(', ');
                    }
                }
                var cls = 'cell-' + type;
                if (isCurrent) cls += ' cell-current';
                if (isPast) cls += ' cell-past';
                html += '<td class="' + cls + '">' + escHtml(text) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
    }

    html += '</div>';
    return html;
}

// —— Paginated live view renderer ————————————————————————————————————————————
function renderLiveContent() {
    var body = el('pc3-live-body');
    if (!body) return;
    var nowMin = getNowMinutes();
    var divs = getDivisions();
    var available = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(getAvailableDivisions()) : getAvailableDivisions().sort(naturalSort);
    // ★ Per-day presence: hide grades not around on the viewed date.
    if (typeof window.filterDivisionsByDate === 'function') available = window.filterDivisionsByDate(available);

    // 1. Render all section wraps into body so we can measure their heights
    var sectHtml = '';
    available.forEach(function (divName) {
        var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).slice();
        if (!bunks.length) return;
        sectHtml += '<div class="pc3-live-section-wrap">' + buildLiveSectionHTML(divName, bunks, nowMin) + '</div>';
    });
    if (!sectHtml) {
        body.innerHTML = '<div style="color:#6b7280;padding:40px;text-align:center;font-size:18px;">No schedule data available.</div>';
        return;
    }
    body.innerHTML = sectHtml;

    // Defer measure + paginate until after the browser has computed layout.
    // A double rAF guarantees the new DOM nodes have been laid out so
    // offsetHeight values are real (not 0) when we bin-pack into pages.
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {

    // 2. Measure available height and each section rendered height
    var availH = body.offsetHeight || (window.innerHeight - 80);
    var wraps = Array.prototype.slice.call(body.querySelectorAll('.pc3-live-section-wrap'));

    // 3. Greedy bin-pack: keep adding sections to the current page until they
    //    would overflow, then start a new page. A single oversized section gets
    //    its own page and is scaled down to fit.
    var pages = [];
    var cur = { nodes: [], totalH: 0 };
    wraps.forEach(function (wrap) {
        var h = wrap.offsetHeight + 20;
        if (cur.nodes.length > 0 && cur.totalH + h > availH) {
            pages.push(cur);
            cur = { nodes: [wrap], totalH: h };
        } else {
            cur.nodes.push(wrap);
            cur.totalH += h;
        }
    });
    if (cur.nodes.length) pages.push(cur);

    _numLivePages = pages.length;
    if (_livePageIndex >= _numLivePages) _livePageIndex = 0;

    // 4. Move section wrap nodes into absolutely-positioned, scale-to-fit page divs
    pages.forEach(function (page, pi) {
        var scale = page.totalH > availH ? availH / page.totalH : 1;
        scale = Math.max(0.25, Math.min(1, scale));

        var pageDiv = document.createElement('div');
        pageDiv.id = 'lp-' + pi;
        var active = pi === _livePageIndex;
        pageDiv.style.cssText = 'position:absolute;inset:0;opacity:' + (active ? 1 : 0) + ';transition:opacity .7s ease;pointer-events:' + (active ? 'auto' : 'none') + ';overflow:hidden;';

        var inner = document.createElement('div');
        inner.className = 'pc3-live-page-inner';
        inner.style.cssText = 'transform:scale(' + scale.toFixed(4) + ');transform-origin:top left;width:' + (100 / scale).toFixed(2) + '%;';

        page.nodes.forEach(function (n) { inner.appendChild(n); });
        pageDiv.appendChild(inner);
        body.appendChild(pageDiv);
    });

    // 5. Update indicator, start rotation timer (only once), position cursors
    updateLivePageIndicator();
    if (!_livePageTimer) startLivePageTimer();
    positionAllLiveCursors();

        }); // end inner rAF
    }); // end outer rAF
}

function updateLivePageIndicator() {
    var ind = document.getElementById('pc3-live-page-ind');
    if (!ind) return;
    if (_numLivePages > 1) {
        ind.style.display = 'flex';
        var dots = '';
        for (var i = 0; i < _numLivePages; i++) {
            dots += '<span style="width:10px;height:10px;border-radius:50%;display:inline-block;background:' + (i === _livePageIndex ? '#fbbf24' : 'rgba(255,255,255,.3)') + ';transition:background .3s;"></span>';
        }
        ind.innerHTML =
            '<button class="pc3-live-nav-btn" onclick="livePageNav(-1)">&#8249;</button>' +
            '<div style="display:flex;gap:7px;align-items:center;">' + dots + '</div>' +
            '<button class="pc3-live-nav-btn" onclick="livePageNav(1)">&#8250;</button>';
    } else {
        ind.style.display = 'none';
    }
}

function livePageNav(dir) {
    _livePageIndex = ((_livePageIndex + dir) % _numLivePages + _numLivePages) % _numLivePages;
    for (var i = 0; i < _numLivePages; i++) {
        var p = document.getElementById('lp-' + i);
        if (!p) continue;
        var active = i === _livePageIndex;
        p.style.opacity = active ? '1' : '0';
        p.style.pointerEvents = active ? 'auto' : 'none';
    }
    updateLivePageIndicator();
    setTimeout(positionAllLiveCursors, 100);
    startLivePageTimer();
}

function startLivePageTimer() {
    if (_livePageTimer) clearInterval(_livePageTimer);
    _livePageTimer = null;
    if (_numLivePages < 2) return;
    _livePageTimer = setInterval(function () { livePageNav(1); }, _LIVE_PAGE_MS);
}


// =========================================================================
// PRINT & EXPORT
// =========================================================================
function triggerPrint() {
    var sel = getSelectedItems();
    if (!sel.length) return alert('Select at least one item to print.');
    readDesignValues();
    var t = _currentTemplate;

    var printHtml = buildPrintHTML(sel);
    runPrint(printHtml, t);
}

// Shared print runner — hoists the print area to <body> so the print-only
// CSS can reliably isolate it. The old approach assumed #printable-area
// was a direct body child, but it lives deep inside #pc3-root → the
// `body>*:not(#printable-area)` rule hid EVERYTHING and printouts were blank.
function runPrint(printHtml, t) {
    var printArea = el('printable-area');
    if (!printArea) {
        printArea = document.createElement('div');
        printArea.id = 'printable-area';
        document.body.appendChild(printArea);
    }
    // Remember where it lived so we can put it back after print.
    var origParent = printArea.parentNode;
    var origNextSibling = printArea.nextSibling;
    if (origParent !== document.body) {
        document.body.appendChild(printArea);
    }
    printArea.innerHTML = printHtml;
    printArea.style.display = 'block';

    var style = document.createElement('style');
    style.id = 'pc3-print-style';
    style.textContent = '@page{size:' + t.paperSize + ' ' + t.orientation + ';margin:0.4in;}' +
        '@media print{' +
            'html,body{margin:0!important;padding:0!important;background:#fff!important;}' +
            'body *{visibility:hidden!important;}' +
            '#printable-area,#printable-area *{visibility:visible!important;}' +
            '#printable-area{position:absolute!important;top:0!important;left:0!important;width:100%!important;display:block!important;}' +
        '}';
    document.head.appendChild(style);

    setTimeout(function () {
        window.print();
        setTimeout(function () {
            printArea.innerHTML = '';
            printArea.style.display = 'none';
            // Put it back where it belonged so subsequent renders don't lose it.
            if (origParent && origParent !== document.body) {
                if (origNextSibling) origParent.insertBefore(printArea, origNextSibling);
                else origParent.appendChild(printArea);
            }
            var ps = document.getElementById('pc3-print-style'); if (ps) ps.remove();
        }, 500);
    }, 200);
}

function buildPrintHTML(sel) {
    var t = _currentTemplate;
    var html = '';
    sel.forEach(function (item, idx) {
        var pageBreak = (t.showPageBreaks && idx > 0) ? 'page-break-before:always;' : '';
        html += '<div style="' + pageBreak + 'margin-bottom:16px;position:relative;">';

        // Watermark
        if (t.watermarkEnabled) {
            html += '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:72px;font-weight:900;color:' + t.watermarkColor + ';opacity:' + t.watermarkOpacity + ';pointer-events:none;white-space:nowrap;z-index:1;">' + escHtml(t.watermarkText) + '</div>';
        }

        // Header
        if (t.showHeader !== false) {
            html += '<div style="background:' + t.headerBgColor + ';color:' + t.headerTextColor + ';padding:12px 16px;font-family:\'' + t.headerFont + '\',sans-serif;font-size:' + t.headerFontSize + 'px;font-weight:700;">';
            if (t.campName) html += escHtml(t.campName);
            if (t.showDate) html += '<span style="float:right;font-size:' + Math.max(11, t.headerFontSize - 8) + 'px;font-weight:400;opacity:.9;">' + formatDisplayDate(window.currentScheduleDate) + '</span>';
            if (t.showDivisionName) html += '<div style="font-size:' + Math.max(11, t.headerFontSize - 6) + 'px;font-weight:400;opacity:.85;">' + escHtml(item) + '</div>';
            html += '</div>';
        }

        // Content
        if (_activeView === 'division') { html += renderDivisionSheet(item).replace(/class="pc3-sheet-head"[^>]*>.*?<\/div>/s, ''); }
        else if (_activeView === 'bunk') { html += renderBunkSheet(item); }
        else if (_activeView === 'location') { html += renderLocationSheet(item); }
        else if (_activeView === 'week') {
            // Week view ignores per-item iteration — render the whole grid once on the first pass.
            if (idx === 0) html += renderWeekSheet(sel);
        }

        // Footer
        if (t.footerEnabled && t.footerText) {
            html += '<div style="text-align:center;padding:8px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;">' + escHtml(t.footerText) + '</div>';
        }

        html += '</div>';
    });
    return html;
}

// Load xlsx-js-style on demand so we can ship styled Excel files (bold
// headers, colored bands, freeze panes). Falls back silently to vanilla
// XLSX if the CDN is unreachable — export still works, just plain.
function loadStyledXLSX() {
    return new Promise(function (resolve) {
        if (window._xlsxStyleAttempted) return resolve();
        window._xlsxStyleAttempted = true;
        if (window.XLSX && window.XLSX._campistry_styled) return resolve();
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
        s.onload = function () { if (window.XLSX) window.XLSX._campistry_styled = true; resolve(); };
        s.onerror = function () { resolve(); };
        document.head.appendChild(s);
    });
}

// Build a workbook that LOOKS like a real schedule — column widths sized
// by content, title row merged, frozen header + time column, banded rows,
// styled headers (when xlsx-js-style is loaded).
// Replace fancy Unicode dashes/quotes that Excel-on-Windows sometimes
// misinterprets (renders as "â€"" mojibake when the locale isn't UTF-8)
// with their plain ASCII counterparts. The .xlsx XML itself is UTF-8 but
// some Excel installs still get confused; safer to ship plain dashes.
function sanitizeForExcel(s) {
    if (s == null) return '';
    return String(s)
        .replace(/[–—]/g, '-')   // – — → -
        .replace(/[‘’]/g, "'")   // ‘ ’ → '
        .replace(/[“”]/g, '"')   // “ ” → "
        .replace(/·/g, '*')           // · → *
        .replace(/…/g, '...');        // … → ...
}
function sanitizeRows(rows) {
    return rows.map(function (r) {
        return (r || []).map(function (v) { return typeof v === 'string' ? sanitizeForExcel(v) : v; });
    });
}

function buildPolishedWorkbook(sel) {
    var wb = XLSX.utils.book_new();
    var styled = !!(window.XLSX && window.XLSX._campistry_styled);
    var dateStr = window.currentScheduleDate || '';

    var STY = {
        title:    { font: { bold: true, sz: 16, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '147D91' } }, alignment: { vertical: 'center', horizontal: 'left', indent: 1 } },
        subtitle: { font: { sz: 11, color: { rgb: '475569' } }, fill: { fgColor: { rgb: 'F1F5F9' } }, alignment: { vertical: 'center', horizontal: 'left', indent: 1 } },
        header:   { font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0F6E80' } }, alignment: { vertical: 'center', horizontal: 'center', wrapText: true }, border: { bottom: { style: 'medium', color: { rgb: '0A5566' } } } },
        timeCol:  { font: { bold: true, sz: 10, color: { rgb: '1C1917' } }, fill: { fgColor: { rgb: 'FAFAF9' } }, alignment: { vertical: 'center', horizontal: 'center' } },
        cell:     { font: { sz: 10, color: { rgb: '1C1917' } }, alignment: { vertical: 'center', wrapText: true } },
        cellAlt:  { font: { sz: 10, color: { rgb: '1C1917' } }, fill: { fgColor: { rgb: 'F8FAFC' } }, alignment: { vertical: 'center', wrapText: true } },
        league:   { font: { bold: true, sz: 10, color: { rgb: '1E3A8A' } }, fill: { fgColor: { rgb: 'DBEAFE' } }, alignment: { vertical: 'center', horizontal: 'center', wrapText: true } },
        free:     { font: { sz: 10, italic: true, color: { rgb: '94A3B8' } }, alignment: { vertical: 'center', horizontal: 'center' } }
    };

    sel.forEach(function (item) {
        var rows = sanitizeRows(buildExcelRows(item));
        if (!rows.length) return;

        // Find the column-header row (where first cell is 'Time')
        var headerRowIdx = -1;
        for (var ri = 0; ri < rows.length; ri++) {
            if (rows[ri] && rows[ri][0] === 'Time') { headerRowIdx = ri; break; }
        }
        // BACKFILL empty data cells with a thin em-dash placeholder so rows
        // don't visually disappear when a bunk has no assignment for a slot
        // that another bunk does. Cosmetic only — keeps the grid scannable.
        if (headerRowIdx >= 0) {
            for (var br = headerRowIdx + 1; br < rows.length; br++) {
                var rr = rows[br];
                if (!rr || !rr.length) continue;
                // From column 1 onward (skip Time col), if cell is null/'', stamp '-'
                for (var bc = 1; bc < rr.length; bc++) {
                    if (rr[bc] == null || rr[bc] === '') rr[bc] = '-';
                }
            }
        }
        var ws = XLSX.utils.aoa_to_sheet(rows);
        var numCols = 0;
        rows.forEach(function (r) { if (r && r.length > numCols) numCols = r.length; });
        // Make sure title+subtitle rows know about the full column count
        // for merges to span correctly.
        if (numCols < 2) numCols = 2;

        // Column widths — Time col 14, every data col ~22 chars
        var cols = [];
        for (var c = 0; c < numCols; c++) cols.push({ wch: c === 0 ? 14 : 22 });
        ws['!cols'] = cols;

        // Row heights
        var rowsMeta = [];
        for (var rIdx = 0; rIdx < rows.length; rIdx++) {
            if (rIdx === 0) rowsMeta.push({ hpt: 28 });
            else if (rIdx === 1) rowsMeta.push({ hpt: 18 });
            else if (rIdx === headerRowIdx) rowsMeta.push({ hpt: 22 });
            else rowsMeta.push({ hpt: 20 });
        }
        ws['!rows'] = rowsMeta;

        // Merge title AND subtitle across all columns
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } },
            { s: { r: 1, c: 0 }, e: { r: 1, c: numCols - 1 } }
        ];

        // Freeze header + time column
        if (headerRowIdx >= 0) {
            ws['!views'] = [{ state: 'frozen', ySplit: headerRowIdx + 1, xSplit: 1 }];
        }

        // Styled cells (only takes effect with xlsx-js-style)
        if (styled) {
            var titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
            if (ws[titleAddr]) ws[titleAddr].s = STY.title;
            var subtitleAddr = XLSX.utils.encode_cell({ r: 1, c: 0 });
            if (ws[subtitleAddr]) ws[subtitleAddr].s = STY.subtitle;
            for (var rr = 2; rr < rows.length; rr++) {
                var rowVals = rows[rr] || [];
                var isHeader = (rr === headerRowIdx);
                for (var cc = 0; cc < numCols; cc++) {
                    var addr = XLSX.utils.encode_cell({ r: rr, c: cc });
                    if (!ws[addr]) {
                        ws[addr] = { t: 's', v: '' };
                        if (ws['!ref']) {
                            var range = XLSX.utils.decode_range(ws['!ref']);
                            if (cc > range.e.c) range.e.c = cc;
                            if (rr > range.e.r) range.e.r = rr;
                            ws['!ref'] = XLSX.utils.encode_range(range);
                        }
                    }
                    if (isHeader) {
                        ws[addr].s = STY.header;
                    } else if (cc === 0) {
                        ws[addr].s = STY.timeCol;
                    } else {
                        var v = (rowVals[cc] || '').toString();
                        if (!v) ws[addr].s = STY.free;
                        else if (v.indexOf(' vs ') >= 0 || v.indexOf(' | ') >= 0 || /league|game/i.test(v)) ws[addr].s = STY.league;
                        else ws[addr].s = ((rr - headerRowIdx) % 2 === 0) ? STY.cellAlt : STY.cell;
                    }
                }
            }
        }

        var name = String(item).replace(/[\\\/\?\*\[\]:]/g, '').substring(0, 31) || 'Sheet';
        try { XLSX.utils.book_append_sheet(wb, ws, name); }
        catch (e) { XLSX.utils.book_append_sheet(wb, ws, name + '_' + Math.random().toString(36).slice(2, 5)); }
    });

    wb.Props = {
        Title: 'Camp Schedule — ' + (formatDisplayDate(dateStr) || dateStr),
        Subject: 'Daily Schedule',
        Author: _currentTemplate.campName || 'Campistry',
        CreatedDate: new Date()
    };
    return wb;
}

function exportExcel() {
    var sel = getSelectedItems();
    if (!sel.length) return alert('Select at least one item to export.');
    var dateStr = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    readDesignValues();

    if (typeof XLSX === 'undefined') {
        var csv = buildCSV(sel);
        downloadFile(csv, 'schedule_' + dateStr + '.csv', 'text/csv');
        return;
    }
    loadStyledXLSX().then(function () {
        var wb = buildPolishedWorkbook(sel);
        XLSX.writeFile(wb, 'schedule_' + dateStr + '.xlsx');
    });
}

// =========================================================================
// ★★★ EXPORT DATA BUILDER — supports Auto + Manual for all views ★★★
// =========================================================================

/**
 * Extract a clean cell value for export. Handles continuations by walking
 * backwards to find the parent entry, and normalises field objects.
 */
function getExportCellText(bunk, slotIdx) {
    var entry = getEntry(bunk, slotIdx);
    if (!entry) return '';

    // If this is a continuation, walk backwards to find the owning entry
    if (entry.continuation) {
        var aa = getAssignments();
        var schedule = aa[bunk] || [];
        for (var backIdx = slotIdx - 1; backIdx >= 0; backIdx--) {
            var prev = schedule[backIdx];
            if (prev && !prev.continuation) { entry = prev; break; }
        }
        // If we still have a continuation (shouldn't happen) return empty
        if (entry.continuation) return '';
    }

    return formatEntry(entry);
}

/**
 * Extract activity and location as separate strings for bunk-view export.
 */
function getExportActivityLocation(bunk, slotIdx) {
    var entry = getEntry(bunk, slotIdx);
    if (!entry) return { activity: '', location: '' };

    // Walk back through continuations
    if (entry.continuation) {
        var aa = getAssignments();
        var schedule = aa[bunk] || [];
        for (var backIdx = slotIdx - 1; backIdx >= 0; backIdx--) {
            var prev = schedule[backIdx];
            if (prev && !prev.continuation) { entry = prev; break; }
        }
        if (entry.continuation) return { activity: '', location: '' };
    }

    var act = entry._activity || entry.sport || '';
    var label = entry._partLabel || act; // ★ Day 19: show "Baking 1/3" for multiPart specials
    var field = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');

    // If act and field are the same, don't duplicate
    if (act && field && (act === field || field.indexOf(act) >= 0)) {
        return { activity: label, location: '' };
    }
    if (act && field && act.indexOf(field) >= 0) {
        return { activity: label, location: '' };
    }
    // If there's a field but it looks like "Activity – Location", split it
    if (!act && field && field.indexOf(' \u2013 ') >= 0) {
        var parts = field.split(' \u2013 ');
        return { activity: parts[0].trim(), location: parts.slice(1).join(' \u2013 ').trim() };
    }
    return { activity: label || field, location: (act && field) ? field : '' };
}

function buildExcelRows(item) {
    var divs = getDivisions();
    var rows = [];
    var dateStr = window.currentScheduleDate || '';
    var mode = isAutoMode() ? 'Auto' : 'Manual';

    if (_activeView === 'division') {
        // ─── Division header rows ───
        var bunks = (divs[item] && divs[item].bunks ? divs[item].bunks : []).slice();
        // Title row holds ONLY the title — the merge will cover all columns.
        // Builder/date info goes on a dedicated subtitle row so nothing
        // gets visually clipped by the merge.
        rows.push([item]);
        rows.push([formatDisplayDate(dateStr) + '  ·  ' + mode + ' Builder']);
        rows.push([]); // spacer

        if (isAutoMode()) {
            // ★★★ AUTO MODE: Per-bunk schedule with unified time axis ★★★
            // Build unified time axis from all bunks' slots
            var timeSet = {};
            bunks.forEach(function (bk) {
                getPerBunkSchedule(bk, item).forEach(function (s) {
                    var key = s.startMin + '-' + s.endMin;
                    if (!timeSet[key]) timeSet[key] = { startMin: s.startMin, endMin: s.endMin, label: s.label };
                });
            });
            var timeSlots = Object.values(timeSet).sort(function (a, b) { return a.startMin - b.startMin; });

            // Header row
            rows.push(['Time'].concat(bunks));

            // Data rows
            timeSlots.forEach(function (ts) {
                // ★ Check if this time slot is a league row for this division
                // In auto mode, league entries are written per-bunk with _league flag
                var isLeagueRow = false;
                var leagueMatchups = [];
                var leagueLabel = '';

                // Sample the first bunk to detect league
                if (bunks.length > 0) {
                    var sampleSched = getPerBunkSchedule(bunks[0], item);
                    for (var si = 0; si < sampleSched.length; si++) {
                        if (sampleSched[si].startMin === ts.startMin || (sampleSched[si].startMin < ts.endMin && sampleSched[si].endMin > ts.startMin)) {
                            var sampleEntry = getEntry(bunks[0], si);
                            if (sampleEntry && (sampleEntry._league || sampleEntry._h2h)) {
                                isLeagueRow = true;
                                leagueLabel = sampleEntry._gameLabel || sampleEntry._leagueName || sampleEntry._activity || 'League Game';
                                // Try to get matchups from leagueAssignments
                                var la = window.leagueAssignments || {};
                                var divLA = la[item] || {};
                                var laSlotIdx = findFirstSlotForTime(ts.startMin, item);
                                var laEntry = (laSlotIdx >= 0 ? divLA[laSlotIdx] || divLA[String(laSlotIdx)] : null) || divLA[ts.startMin] || divLA[String(ts.startMin)];
                                if (laEntry && laEntry.matchups) {
                                    laEntry.matchups.forEach(function (m) {
                                        var desc = '';
                                        if (typeof m === 'string') desc = m;
                                        else if (m.display) desc = m.display;
                                        else if (m.teamA && m.teamB) desc = m.teamA + ' vs ' + m.teamB;
                                        if (desc) leagueMatchups.push(desc);
                                    });
                                }
                            }
                            break;
                        }
                    }
                }

                var row = [ts.label];
                if (isLeagueRow && !_currentTemplate.hideLeagueMatchups) {
                    // League row: same text in every bunk column
                    var leagueText = leagueLabel;
                    if (leagueMatchups.length) leagueText += ' | ' + leagueMatchups.join(', ');
                    bunks.forEach(function () { row.push(leagueText); });
                } else {
                    bunks.forEach(function (bk) {
                        var bunkSched = getPerBunkSchedule(bk, item);
                        // Find the slot in THIS bunk that overlaps this unified time slot
                        var foundIdx = -1;
                        for (var i = 0; i < bunkSched.length; i++) {
                            var bs = bunkSched[i];
                            // Exact match first
                            if (bs.startMin === ts.startMin && bs.endMin === ts.endMin) { foundIdx = i; break; }
                            // Overlap match: bunk slot overlaps with unified time slot
                            if (bs.startMin < ts.endMin && bs.endMin > ts.startMin) { foundIdx = i; break; }
                        }
                        var text = foundIdx >= 0 ? getExportCellText(bk, foundIdx) : '';
                        row.push(text);
                    });
                }
                rows.push(row);
            });
        } else {
            // ★★★ MANUAL MODE: Skeleton-based slot grid ★★★
            var blocks = buildDivisionBlocks(item);
            rows.push(['Time'].concat(bunks));

            blocks.forEach(function (eb) {
                var row = [eb.label];
                if (eb.isLeague) {
                    // League row: put the event name + matchups in each bunk cell
                    var matchups = buildLeagueMatchups(eb, item);
                    var leagueText = eb.event;
                    if (matchups.length && !_currentTemplate.hideLeagueMatchups) {
                        leagueText += ' | ' + matchups.join(', ');
                    }
                    bunks.forEach(function () { row.push(leagueText); });
                } else {
                    bunks.forEach(function (b) {
                        var si = findFirstSlotForTime(eb.startMin, item);
                        var text = si >= 0 ? getExportCellText(b, si) : '';
                        row.push(text);
                    });
                }
                rows.push(row);
            });
        }

    } else if (_activeView === 'bunk') {
        // ─── Bunk view ───
        var dn = null;
        for (var d in divs) { if (divs[d].bunks && divs[d].bunks.indexOf(item) >= 0) { dn = d; break; } }

        rows.push([item + (dn ? ' (' + dn + ')' : '')]);
        rows.push([formatDisplayDate(dateStr) + '  ·  ' + mode + ' Builder']);
        rows.push([]);
        rows.push(['Time', 'Activity', 'Location']);

        if (isAutoMode()) {
            // ★★★ AUTO: Per-bunk slots ★★★
            var bunkSlots = getPerBunkSchedule(item, dn);
            bunkSlots.forEach(function (slot, idx) {
                var entry = getEntry(item, idx);
                if (entry && (entry._league || entry._h2h)) {
                    // League row: show league info
                    var leagueText = entry._gameLabel || entry._leagueName || entry._activity || 'League Game';
                    if (!_currentTemplate.hideLeagueMatchups) {
                        var matchups = [];
                        // Check leagueAssignments for matchup details
                        var la = window.leagueAssignments || {};
                        var divLA = la[dn] || {};
                        var laSlotIdx2 = findFirstSlotForTime(slot.startMin, dn);
                        var laEntry = (laSlotIdx2 >= 0 ? divLA[laSlotIdx2] || divLA[String(laSlotIdx2)] : null) || divLA[slot.startMin] || divLA[String(slot.startMin)];
                        if (laEntry && laEntry.matchups) {
                            laEntry.matchups.forEach(function (m) {
                                var desc = typeof m === 'string' ? m : (m.display || ((m.teamA || '') + ' vs ' + (m.teamB || '')));
                                if (desc) matchups.push(desc);
                            });
                        }
                        // Fallback: check entry._allMatchups
                        if (!matchups.length && entry._allMatchups) {
                            entry._allMatchups.forEach(function (m) {
                                var desc = typeof m === 'string' ? m : (m.display || ((m.teamA || '') + ' vs ' + (m.teamB || '')));
                                if (desc) matchups.push(desc);
                            });
                        }
                        if (matchups.length) leagueText += ' | ' + matchups.join(', ');
                    }
                    rows.push([slot.label, leagueText, '']);
                } else {
                    var al = getExportActivityLocation(item, idx);
                    rows.push([slot.label, al.activity, al.location]);
                }
            });
        } else {
            // ★★★ MANUAL: From skeleton blocks ★★★
            var blocks2 = dn ? buildDivisionBlocks(dn) : [];
            blocks2.forEach(function (slot) {
                var si = findFirstSlotForTime(slot.startMin, dn);
                if (slot.isLeague) {
                    var matchups = buildLeagueMatchups(slot, dn);
                    var leagueText = slot.event;
                    if (matchups.length && !_currentTemplate.hideLeagueMatchups) leagueText += ' | ' + matchups.join(', ');
                    rows.push([slot.label, leagueText, '']);
                } else {
                    var al2 = si >= 0 ? getExportActivityLocation(item, si) : { activity: '', location: '' };
                    rows.push([slot.label, al2.activity, al2.location]);
                }
            });
        }

    } else if (_activeView === 'location') {
        // ─── Location view ───
        rows.push([item]);
        rows.push([formatDisplayDate(dateStr) + '  ·  ' + mode + ' Builder']);
        rows.push([]);
        rows.push(['Time', 'Bunk(s)']);

        // Uses the same auto/manual-aware scanner as the location renderer
        var locResults = scanLocationAcrossBunks(item);
        locResults.forEach(function (entry) {
            rows.push([entry.label, entry.bunks.join(', ')]);
        });

        if (rows.length <= 3) {
            rows.push(['No schedule data found for this location']);
        }
    }

    return rows;
}

// ★ #V2-18: neutralize CSV / spreadsheet formula injection. A cell whose value
//   begins with = + - @ (or a leading tab / CR) is interpreted as a FORMULA by
//   Excel / Google Sheets — even when the field is double-quoted, because the
//   app strips the quotes during CSV import and then sees the leading trigger.
//   A malicious activity / league / bunk name like =HYPERLINK("http://evil",...)
//   or =cmd|... would then execute on open. Prefix a single quote so the cell is
//   shown as literal text. (The XLSX path is unaffected — aoa_to_sheet writes
//   string-typed cells, which Excel never evaluates as formulas.)
function csvSafeCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return s;
}
function buildCSV(sel) {
    var lines = [];
    sel.forEach(function (item, idx) {
        if (idx > 0) lines.push(''); // blank separator between items
        var rows = buildExcelRows(item);
        rows.forEach(function (row) {
            lines.push(row.map(function (c) { return '"' + csvSafeCell(c).replace(/"/g, '""') + '"'; }).join(','));
        });
    });
    return lines.join('\n');
}

function downloadFile(content, name, type) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// =========================================================================
// BINDING
// =========================================================================
function bindAll() {
    // View tabs
    document.querySelectorAll('[data-view]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            _activeView = this.getAttribute('data-view');
            document.querySelectorAll('[data-view]').forEach(function (b) { b.classList.remove('active'); });
            this.classList.add('active');
            // Week view needs 7 days of cloud data — kick off async fetch
            if (_activeView === 'week') ensureWeekDataLoaded(false);
            populateSidebar();
            liveRefresh();
        });
    });

    // Popovers — Packs / Output / Style / Layout
    var popoverPairs = [
        ['pc3-packs-btn', 'pc3-packs-menu'],
        ['pc3-output-btn', 'pc3-output-menu'],
        ['pc3-style-btn', 'pc3-style-menu'],
        ['pc3-layout-btn', 'pc3-layout-menu']
    ];
    function closeAllPopovers() {
        popoverPairs.forEach(function (p) {
            var b = el(p[0]); var m = el(p[1]);
            if (b) b.classList.remove('open');
            if (m) m.classList.remove('open');
        });
        _openPopover = null;
    }
    popoverPairs.forEach(function (p) {
        var btn = el(p[0]); var menu = el(p[1]);
        if (!btn || !menu) return;
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var isOpen = menu.classList.contains('open');
            closeAllPopovers();
            if (!isOpen) {
                btn.classList.add('open');
                menu.classList.add('open');
                _openPopover = p[1];
            }
        });
        // Clicks inside the popover should not close it (unless the action handler closes manually)
        menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
        // Items that trigger app actions auto-close the popover
        menu.querySelectorAll('.pc3-popover-item').forEach(function (it) {
            it.addEventListener('click', function () { setTimeout(closeAllPopovers, 0); });
        });
    });
    document.addEventListener('click', function () { if (_openPopover) closeAllPopovers(); });

    // Inspect mode toggle (in Style popover)
    var insBox = el('pc3-inspect-mode');
    if (insBox) insBox.addEventListener('change', function () {
        _inspectMode = !!this.checked;
        var root = document.getElementById('pc3-root');
        if (root) root.classList.toggle('inspect-mode', _inspectMode);
    });

    // Style preset clicks
    document.querySelectorAll('.pc3-preset-item').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var pid = this.getAttribute('data-preset');
            window._pc3ApplyPreset && window._pc3ApplyPreset(pid);
        });
    });

    // Inline header quick controls — Camp name / Subtitle / Footer. Debounced
    // so typing doesn't re-render on every keystroke; flushes on blur too.
    function _wireHeaderField(inputId, tplKey, opts) {
        var inp = el(inputId);
        if (!inp) return;
        var t;
        var commit = function () {
            _currentTemplate[tplKey] = inp.value;
            if (opts && opts.autoEnable) _currentTemplate[opts.autoEnable] = !!inp.value;
            liveRefresh();
        };
        inp.addEventListener('input', function () { clearTimeout(t); t = setTimeout(commit, 250); });
        inp.addEventListener('blur', function () { clearTimeout(t); commit(); });
    }
    _wireHeaderField('pc3-hero-camp-name', 'campName');
    _wireHeaderField('pc3-hero-subtitle', 'customSubtitle');
    _wireHeaderField('pc3-hero-footer', 'footerText', { autoEnable: 'footerEnabled' });

    // Print pack clicks (cards in empty state + rows in popover)
    document.querySelectorAll('[data-pack]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var packId = this.getAttribute('data-pack');
            window._pc3ApplyPack && window._pc3ApplyPack(packId);
        });
    });

    // Saved layouts
    var saveBtn = el('pc3-save-layout-btn');
    if (saveBtn) saveBtn.addEventListener('click', function () { window._pc3SaveLayout(); });
    renderSavedLayoutsList();

    // Transpose / Combined / Hide Matchups
    ['pc3-transpose', 'pc3-combined', 'pc3-hide-matchups'].forEach(function (id) {
        var e = el(id);
        if (e) e.addEventListener('change', function () { readDesignValues(); liveRefresh(); });
    });

    // Time increment selector
    var incSel = el('pc3-time-increment');
    if (incSel) incSel.addEventListener('change', function () {
        _timeIncrement = parseInt(this.value) || 15;
        try { localStorage.setItem('campistry_pc3_timeIncrement', String(_timeIncrement)); } catch (e) {}
        liveRefresh();
    });

    // ★ Day 22.5+ Print Center: new layout/content/print toggles
    var aaSel = el('pc3-activity-aligned');
    if (aaSel) aaSel.addEventListener('change', function () {
        _activityAligned = this.checked;
        var subRow = el('pc3-subseg-row');
        if (subRow) subRow.style.display = _activityAligned ? 'none' : '';
        try { localStorage.setItem('campistry_pc3_activityAligned', _activityAligned ? '1' : '0'); } catch (e) {}
        liveRefresh();
    });
    var hdSel = el('pc3-hide-durations');
    if (hdSel) hdSel.addEventListener('change', function () {
        _hideDurations = this.checked;
        try { localStorage.setItem('campistry_pc3_hideDurations', _hideDurations ? '1' : '0'); } catch (e) {}
        // Class toggle is enough — no full refresh needed
        var root = document.getElementById('pc3-root');
        if (root) root.classList.toggle('pc3-hide-durations', _hideDurations);
    });
    var hlSel = el('pc3-hide-locations');
    if (hlSel) hlSel.addEventListener('change', function () {
        _hideLocations = this.checked;
        try { localStorage.setItem('campistry_pc3_hideLocations', _hideLocations ? '1' : '0'); } catch (e) {}
        liveRefresh();  // location is baked into cell text → need full re-render
    });
    var pbSel = el('pc3-page-break-bunk');
    if (pbSel) pbSel.addEventListener('change', function () {
        _pageBreakPerBunk = this.checked;
        try { localStorage.setItem('campistry_pc3_pageBreakPerBunk', _pageBreakPerBunk ? '1' : '0'); } catch (e) {}
        var root = document.getElementById('pc3-root');
        if (root) root.classList.toggle('pc3-pb-per-bunk', _pageBreakPerBunk);
    });
    var hgSel = el('pc3-highlight-gaps');
    if (hgSel) hgSel.addEventListener('change', function () {
        _highlightGaps = this.checked;
        try { localStorage.setItem('campistry_pc3_highlightGaps', _highlightGaps ? '1' : '0'); } catch (e) {}
        var root = document.getElementById('pc3-root');
        if (root) root.classList.toggle('pc3-highlight-gaps', _highlightGaps);
    });
    var ccSel = el('pc3-color-cat');
    if (ccSel) ccSel.addEventListener('change', function () {
        _colorByCategory = this.checked;
        try { localStorage.setItem('campistry_pc3_colorByCategory', _colorByCategory ? '1' : '0'); } catch (e) {}
        var root = document.getElementById('pc3-root');
        if (root) root.classList.toggle('pc3-color-cat', _colorByCategory);
    });
    var qfSel = el('pc3-quick-filter');
    if (qfSel) qfSel.addEventListener('change', function () {
        _quickFilter = this.value || 'all';
        try { localStorage.setItem('campistry_pc3_quickFilter', _quickFilter); } catch (e) {}
        var root = document.getElementById('pc3-root');
        if (root) {
            ['leagues','specials','general','free'].forEach(function (k) {
                root.classList.toggle('pc3-filter-' + k, _quickFilter === k);
            });
        }
    });

    // Template selector
    var tplSel = el('pc3-template-select');
    if (tplSel) tplSel.addEventListener('change', function () {
        loadTemplate(this.value);
        localStorage.setItem('campistry_last_print_template', this.value);
    });

    // Zoom
    var zr = el('pc3-zoom-range');
    if (zr) zr.addEventListener('input', function () {
        _zoomLevel = parseInt(this.value);
        var pc = el('pc3-preview-content');
        if (pc) { pc.style.transform = 'scale(' + (_zoomLevel / 100) + ')'; pc.style.transformOrigin = 'top left'; }
        var zl = el('pc3-zoom-label');
        if (zl) zl.textContent = _zoomLevel + '%';
    });

    // Live mode — re-render the button label after opening so the "Live · On" pill shows
    function refreshLiveBtn() {
        var b = el('pc3-live-btn');
        if (!b) return;
        var on = !!(_liveWindow && !_liveWindow.closed);
        b.classList.toggle('live-on', on);
        if (on) {
            b.innerHTML = '<span class="pc3-live-dot"></span>Live · On';
            b.title = 'Live View is open in another window';
        } else {
            b.innerHTML = ICO.monitor + ' Live View';
            b.title = 'Open Live View in a new window';
        }
    }
    var liveBtn = el('pc3-live-btn');
    if (liveBtn) liveBtn.addEventListener('click', function () {
        if (_liveWindow && !_liveWindow.closed) { try { _liveWindow.focus(); } catch (e) {} return; }
        openLiveWindow();
        setTimeout(refreshLiveBtn, 200);
    });
    setInterval(refreshLiveBtn, 2000);

    // Advanced drawer design change listeners
    var drawerScroll = el('pc3-drawer-scroll');
    if (drawerScroll) {
        drawerScroll.addEventListener('input', function () { readDesignValues(); liveRefresh(); });
        drawerScroll.addEventListener('change', function () { readDesignValues(); liveRefresh(); });
        // Delegated handler for preset chips inside the drawer
        drawerScroll.addEventListener('click', function (e) {
            var btn = e.target.closest && e.target.closest('.dp-preset-btn');
            if (!btn) return;
            e.preventDefault();
            var pid = btn.getAttribute('data-preset');
            if (pid && window._pc3ApplyPreset) {
                window._pc3ApplyPreset(pid);
                drawerScroll.querySelectorAll('.dp-preset-btn').forEach(function (b) {
                    b.classList.toggle('active', b.getAttribute('data-preset') === pid);
                });
            }
        });
    }

    // Keyboard
    document.addEventListener('keydown', function (e) {
        // Only handle these shortcuts when the print tab is the active tab
        // and the user isn't typing into a form input.
        var printTab = document.getElementById('print');
        var printActive = printTab && printTab.classList.contains('active');
        var inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable);
        if (e.ctrlKey || e.metaKey) {
            if (e.key === '=' || e.key === '+') { if (!printActive) return; e.preventDefault(); window._pc3Zoom(10); return; }
            if (e.key === '-') { if (!printActive) return; e.preventDefault(); window._pc3Zoom(-10); return; }
            if (e.key === 'p') { if (!printActive) return; e.preventDefault(); triggerPrint(); return; }
            if (e.key === 'c' || e.key === 'C') {
                if (!printActive || inField) return;
                if (copySelectionToClipboard()) e.preventDefault();
                return;
            }
            if (e.key === 'a' || e.key === 'A') {
                if (!printActive || inField || !_selAnchor) return;
                var sh = getSheet(_selAnchor.sheet);
                if (!sh) return;
                var maxR = 0, maxC = 0;
                sh.querySelectorAll('[data-r]').forEach(function (n) { var rr = parseInt(n.getAttribute('data-r')); if (rr > maxR) maxR = rr; });
                sh.querySelectorAll('[data-c]').forEach(function (n) { var cc = parseInt(n.getAttribute('data-c')); if (cc > maxC) maxC = cc; });
                setSelection(sh.id, 0, 0, maxR, maxC);
                e.preventDefault();
                return;
            }
        }
        // Single-key shortcuts (no modifier, only when print tab is active and not typing)
        if (!e.ctrlKey && !e.metaKey && !e.altKey && !inField && printActive) {
            if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); window._pc3ShowShortcuts(); return; }
            if (e.key === 'l' || e.key === 'L') { e.preventDefault(); var lb = el('pc3-live-btn'); if (lb) lb.click(); return; }
            if (e.key === 'f' || e.key === 'F') { e.preventDefault(); window._pc3ToggleFullscreen(); return; }
        }
        if (e.key === 'Escape') {
            // Close any open popover first
            if (_openPopover) {
                document.querySelectorAll('.pc3-popover.open').forEach(function (m) { m.classList.remove('open'); });
                document.querySelectorAll('.pc3-tab-btn.open, .pc3-hero-btn.open').forEach(function (b) { b.classList.remove('open'); });
                _openPopover = null;
                e.preventDefault();
                return;
            }
            if (_selAnchor) { _selAnchor = null; _selFocus = null; paintSelection(); updateFormulaBar(); }
        }
        // Arrow-key navigation across the active sheet
        if (printActive && !inField && _selFocus) {
            var dr = 0, dc = 0;
            if (e.key === 'ArrowUp') dr = -1;
            else if (e.key === 'ArrowDown') dr = 1;
            else if (e.key === 'ArrowLeft') dc = -1;
            else if (e.key === 'ArrowRight') dc = 1;
            else if (e.key === 'Home') { dc = -9999; }
            else if (e.key === 'End') { dc = 9999; }
            if (dr || dc) {
                e.preventDefault();
                if (Math.abs(dc) > 100) {
                    var sh2 = getSheet(_selFocus.sheet);
                    if (sh2) {
                        var maxC2 = 0;
                        sh2.querySelectorAll('[data-c]').forEach(function (n) { var cc2 = parseInt(n.getAttribute('data-c')); if (cc2 > maxC2) maxC2 = cc2; });
                        var nc = (dc > 0) ? maxC2 : 0;
                        if (e.shiftKey) setSelection(sh2.id, _selAnchor.r, _selAnchor.c, _selFocus.r, nc);
                        else setSelection(sh2.id, _selFocus.r, nc, _selFocus.r, nc);
                    }
                } else {
                    moveSelection(dr, dc, e.shiftKey);
                }
            }
        }
    });
}

function renderTemplateDropdown() {
    var sel = el('pc3-template-select');
    if (!sel) return;
    var cid = _currentTemplate.id || 'default';
    var h = '<option value="default"' + (cid === 'default' ? ' selected' : '') + '>Default Template</option>';
    _savedTemplates.forEach(function (tp) {
        h += '<option value="' + tp.id + '"' + (cid === tp.id ? ' selected' : '') + '>' + escHtml(tp.name) + '</option>';
    });
    sel.innerHTML = h;
}

// =========================================================================
// INIT
// =========================================================================
function initPrintCenter() {
    var container = document.getElementById('print-content');
    if (!container) return;
    console.log('[PrintCenter] v' + VERSION + ' init (' + (isAutoMode() ? 'AUTO' : 'MANUAL') + ' mode)');

    // Restore saved time increment + new Print Center 2.0 toggles
    try { var savedInc = localStorage.getItem('campistry_pc3_timeIncrement'); if (savedInc) _timeIncrement = parseInt(savedInc) || 15; } catch (e) {}
    try { var savedAA = localStorage.getItem('campistry_pc3_activityAligned'); if (savedAA !== null) _activityAligned = savedAA === '1'; } catch (e) {}
    try { var savedHD = localStorage.getItem('campistry_pc3_hideDurations'); if (savedHD !== null) _hideDurations = savedHD === '1'; } catch (e) {}
    try { var savedHL = localStorage.getItem('campistry_pc3_hideLocations'); if (savedHL !== null) _hideLocations = savedHL === '1'; } catch (e) {}
    try { var savedHG = localStorage.getItem('campistry_pc3_highlightGaps'); if (savedHG !== null) _highlightGaps = savedHG === '1'; } catch (e) {}
    try { var savedCC = localStorage.getItem('campistry_pc3_colorByCategory'); if (savedCC !== null) _colorByCategory = savedCC === '1'; } catch (e) {}
    try { var savedQF = localStorage.getItem('campistry_pc3_quickFilter'); if (savedQF) _quickFilter = savedQF; } catch (e) {}
    try { var savedPB = localStorage.getItem('campistry_pc3_pageBreakPerBunk'); if (savedPB !== null) _pageBreakPerBunk = savedPB === '1'; } catch (e) {}
    try { var savedSC = localStorage.getItem('campistry_pc3_sidebarCollapsed'); if (savedSC !== null) _sidebarCollapsed = savedSC === '1'; } catch (e) {}
    // ★ CB-101: restore the last-used print pack. It was written on apply (campistry_pc3_pack) but
    // never read back on load — every other pc3_* pref above restores, this one was missed — so the
    // Packs popover showed none active after reload. Setting _activePack marks it active (L~1370).
    try { var savedPack = localStorage.getItem('campistry_pc3_pack'); if (savedPack) _activePack = savedPack; } catch (e) {}

    // Restore last-used style preset
    try {
        var savedPreset = localStorage.getItem('campistry_pc3_preset');
        if (savedPreset) {
            var matched = STYLE_PRESETS.filter(function (p) { return p.id === savedPreset; })[0];
            if (matched) {
                _activePreset = matched.id;
                _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE, matched.overlay);
            }
        }
    } catch (e) {}

    loadTemplates();
    loadSavedLayouts();
    var lastId = localStorage.getItem('campistry_last_print_template');
    if (lastId && lastId !== 'default') {
        _savedTemplates.forEach(function (t) {
            if (t.id === lastId) _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE, JSON.parse(JSON.stringify(t)));
        });
    }
    if (!_currentTemplate.campName) {
        var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        _currentTemplate.campName = g.campName || (g.app1 ? g.app1.campName : '') || '';
    }

    container.innerHTML = buildMainUI();
    bindAll();
    populateSidebar();
    renderTemplateDropdown();
    liveRefresh();
}

// =========================================================================
// WINDOW API
// =========================================================================
window._pc3Zoom = function (delta) {
    _zoomLevel = Math.max(50, Math.min(200, _zoomLevel + delta));
    var pc = el('pc3-preview-content');
    if (pc) { pc.style.transform = 'scale(' + (_zoomLevel / 100) + ')'; pc.style.transformOrigin = 'top left'; }
    var zr = el('pc3-zoom-range'); if (zr) zr.value = _zoomLevel;
    var zl = el('pc3-zoom-label'); if (zl) zl.textContent = _zoomLevel + '%';
    var zdl = el('pc3-zoom-dock-label'); if (zdl) zdl.textContent = _zoomLevel + '%';
    var zb = el('pc3-zoom-btn');
    if (zb) {
        // Update the inline zoom % in the tab-bar button label
        zb.innerHTML = 'Zoom <span style="font-variant-numeric:tabular-nums;">' + _zoomLevel + '%</span> <span class="caret">▼</span>';
    }
};
window._pc3ZoomReset = function () {
    var delta = 100 - _zoomLevel;
    if (delta !== 0) window._pc3Zoom(delta);
};
// ─────────────────────────────────────────────────────────────────────────
// SAVED LAYOUTS
// ─────────────────────────────────────────────────────────────────────────
function renderSavedLayoutsList() {
    var list = el('pc3-layouts-list');
    if (!list) return;
    if (!_savedLayouts.length) {
        list.innerHTML = '<div class="pc3-popover-row" style="color:#a8a29e;font-style:italic;font-size:12px;">No saved layouts yet.</div>';
        return;
    }
    list.innerHTML = _savedLayouts.map(function (lt) {
        return '<button class="pc3-layout-row" data-layout="' + escHtml(lt.id) + '">' +
            '<span class="pc3-layout-name">' + escHtml(lt.name) + '</span>' +
            '<button class="pc3-layout-del" data-layout-del="' + escHtml(lt.id) + '" title="Delete">' + ICO.trash + '</button>' +
        '</button>';
    }).join('');
    list.querySelectorAll('[data-layout]').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            if (ev.target.closest('[data-layout-del]')) return;
            window._pc3ApplyLayout(this.getAttribute('data-layout'));
        });
    });
    list.querySelectorAll('[data-layout-del]').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation(); ev.preventDefault();
            var id = this.getAttribute('data-layout-del');
            _savedLayouts = _savedLayouts.filter(function (l) { return l.id !== id; });
            persistSavedLayouts();
            renderSavedLayoutsList();
        });
    });
}

window._pc3SaveLayout = function () {
    var name = (window.prompt && window.prompt('Name this layout:')) || '';
    name = name.trim();
    if (!name) return;
    var id = 'lt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    var t = _currentTemplate;
    var entry = {
        id: id,
        name: name,
        preset: _activePreset,
        view: _activeView,
        layout: {
            tableOrientation: t.tableOrientation,
            layoutMode: t.layoutMode,
            hideLeagueMatchups: !!t.hideLeagueMatchups,
            orientation: t.orientation,
            paperSize: t.paperSize
        },
        timeIncrement: _timeIncrement,
        inspectMode: !!_inspectMode
    };
    _savedLayouts.push(entry);
    persistSavedLayouts();
    renderSavedLayoutsList();
    if (window.showToast) window.showToast('Layout “' + name + '” saved.', 'info');
};

window._pc3ApplyLayout = function (id) {
    var lt = _savedLayouts.filter(function (l) { return l.id === id; })[0];
    if (!lt) return;
    if (lt.preset) window._pc3ApplyPreset(lt.preset);
    if (lt.layout) {
        Object.keys(lt.layout).forEach(function (k) { _currentTemplate[k] = lt.layout[k]; });
    }
    if (lt.view && lt.view !== _activeView) {
        _activeView = lt.view;
        document.querySelectorAll('[data-view]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-view') === lt.view);
        });
        populateSidebar();
    }
    if (lt.timeIncrement) {
        _timeIncrement = lt.timeIncrement;
        var inc = el('pc3-time-increment'); if (inc) inc.value = lt.timeIncrement;
    }
    _inspectMode = !!lt.inspectMode;
    var insBox = el('pc3-inspect-mode'); if (insBox) insBox.checked = _inspectMode;
    var root = el('pc3-root'); if (root) root.classList.toggle('inspect-mode', _inspectMode);
    // Sync layout popover
    var tr = el('pc3-transpose'); if (tr) tr.checked = (_currentTemplate.tableOrientation === 'time-top');
    var cb = el('pc3-combined'); if (cb) cb.checked = (_currentTemplate.layoutMode === 'all-bunks');
    var hm = el('pc3-hide-matchups'); if (hm) hm.checked = !!_currentTemplate.hideLeagueMatchups;
    liveRefresh();
};

// ─────────────────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS OVERLAY
// ─────────────────────────────────────────────────────────────────────────
var _shortcutsOpen = false;
window._pc3ShowShortcuts = function () {
    if (_shortcutsOpen) return;
    var ov = document.createElement('div');
    ov.className = 'pc3-shortcuts-overlay';
    ov.id = 'pc3-shortcuts-overlay';
    var isMac = /mac/i.test(navigator.platform || '');
    var mod = isMac ? '⌘' : 'Ctrl';
    var rows = [
        { keys: [mod, 'P'], label: 'Print this view' },
        { keys: [mod, '+'], label: 'Zoom in' },
        { keys: [mod, '-'], label: 'Zoom out' },
        { keys: ['F'], label: 'Toggle fullscreen' },
        { keys: ['L'], label: 'Open Live View' },
        { keys: ['?'], label: 'Show this help' },
        { keys: ['Esc'], label: 'Close menus / overlays' },
        { keys: [mod, 'C'], label: 'Copy selected cells (Inspect mode)' }
    ];
    ov.innerHTML = '<div class="pc3-shortcuts-card" id="pc3-shortcuts-card">' +
        '<h2>Keyboard shortcuts</h2>' +
        '<div class="pc3-shortcuts-sub">Click anywhere outside to close.</div>' +
        '<div class="pc3-shortcuts-grid">' +
            rows.map(function (r) {
                return '<div class="pc3-shortcut-row">' +
                    '<div class="pc3-shortcut-keys">' + r.keys.map(function (k) { return '<span class="pc3-shortcut-key">' + escHtml(k) + '</span>'; }).join('') + '</div>' +
                    '<span class="pc3-shortcut-label">' + escHtml(r.label) + '</span>' +
                '</div>';
            }).join('') +
        '</div>' +
        '<div class="pc3-shortcuts-foot">Press <strong>?</strong> any time to bring this back.</div>' +
    '</div>';
    document.body.appendChild(ov);
    _shortcutsOpen = true;
    function close() { ov.remove(); _shortcutsOpen = false; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
};

window._pc3OpenInDA = function (bunk, slotIdx, divName) {
    // Best-effort: switch to the Daily Adjustments tab and surface a hint.
    try {
        // The app uses tab buttons with onclick="showTab('daily')" — try a few common patterns.
        var daTab = document.querySelector('[data-tab="daily"], [onclick*="showTab(\'daily\')"], #tab-daily, button[data-target="daily"]');
        if (daTab && typeof daTab.click === 'function') daTab.click();
        else if (typeof window.showTab === 'function') window.showTab('daily');
    } catch (e) { console.warn('[PrintCenter] could not switch tab', e); }

    // Scroll to the bunk row in DA after the tab is visible.
    setTimeout(function () {
        try {
            // Try to scroll the bunk's row into view (DA renders rows with data-bunk).
            var bunkRow = document.querySelector('#daily [data-bunk="' + (window.CSS && CSS.escape ? CSS.escape(bunk) : bunk) + '"]') ||
                          document.querySelector('[data-bunk="' + bunk + '"][data-slot]');
            if (bunkRow && bunkRow.scrollIntoView) bunkRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Brief flash
            if (bunkRow) {
                bunkRow.style.transition = 'box-shadow .3s';
                bunkRow.style.boxShadow = '0 0 0 3px rgba(20,125,145,.45)';
                setTimeout(function () { bunkRow.style.boxShadow = ''; }, 1400);
            }
            if (window.showToast) window.showToast('Jumped to ' + bunk + ' (' + divName + ')', 'info');
        } catch (e) { console.warn('[PrintCenter] DA jump scroll failed', e); }
    }, 200);
};

window._pc3ApplyPack = function (packId) {
    var pack = PRINT_PACKS.filter(function (p) { return p.id === packId; })[0];
    if (!pack) return;
    _activePack = pack.id;
    // 1. Apply preset (color scheme)
    if (pack.preset) window._pc3ApplyPreset(pack.preset);
    // 2. Apply layout flags
    if (pack.layout) {
        Object.keys(pack.layout).forEach(function (k) { _currentTemplate[k] = pack.layout[k]; });
        // Sync pack-controlled state vars that live outside _currentTemplate.
        if (Object.prototype.hasOwnProperty.call(pack.layout, 'pageBreakPerBunk')) {
            _pageBreakPerBunk = !!pack.layout.pageBreakPerBunk;
            try { localStorage.setItem('campistry_pc3_pageBreakPerBunk', _pageBreakPerBunk ? '1' : '0'); } catch (e) {}
            var rootPB = document.getElementById('pc3-root');
            if (rootPB) rootPB.classList.toggle('pc3-pb-per-bunk', _pageBreakPerBunk);
            var pbCb = el('pc3-page-break-bunk'); if (pbCb) pbCb.checked = _pageBreakPerBunk;
        }
    }
    // 3. Switch view
    if (pack.view && pack.view !== _activeView) {
        _activeView = pack.view;
        document.querySelectorAll('[data-view]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-view') === pack.view);
        });
        if (_activeView === 'week') ensureWeekDataLoaded(false);
        populateSidebar();
    }
    // 4. Apply selection
    if (pack.selection === 'all') {
        document.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = true; });
    } else if (pack.selection === 'none') {
        document.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = false; });
    }
    updateSidebarSelectionUI && updateSidebarSelectionUI();
    // 5. Sync layout popover checkboxes (so the user sees what changed)
    var tr = el('pc3-transpose'); if (tr) tr.checked = (_currentTemplate.tableOrientation === 'time-top');
    var cb = el('pc3-combined'); if (cb) cb.checked = (_currentTemplate.layoutMode === 'all-bunks');
    var hm = el('pc3-hide-matchups'); if (hm) hm.checked = !!_currentTemplate.hideLeagueMatchups;
    // 6. Reflect active state in popover and pack cards
    document.querySelectorAll('[data-pack]').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-pack') === packId);
    });
    try { localStorage.setItem('campistry_pc3_pack', packId); } catch (e) {}
    liveRefresh();
    // 7. Optional after-apply (e.g. open Live View for Office TV pack)
    if (typeof pack.afterApply === 'function') {
        try { pack.afterApply(); } catch (e) { console.warn('[PrintCenter] pack.afterApply failed', e); }
    }
};

window._pc3ApplyPreset = function (presetId) {
    var preset = STYLE_PRESETS.filter(function (p) { return p.id === presetId; })[0];
    if (!preset) return;
    _activePreset = preset.id;
    // Apply overlay on top of the existing template (preserves campName, watermark, etc.)
    var keep = {
        campName: _currentTemplate.campName,
        campLogo: _currentTemplate.campLogo,
        customSubtitle: _currentTemplate.customSubtitle,
        showHeader: _currentTemplate.showHeader,
        showDate: _currentTemplate.showDate,
        showDivisionName: _currentTemplate.showDivisionName,
        watermarkEnabled: _currentTemplate.watermarkEnabled,
        watermarkText: _currentTemplate.watermarkText,
        watermarkColor: _currentTemplate.watermarkColor,
        watermarkOpacity: _currentTemplate.watermarkOpacity,
        footerEnabled: _currentTemplate.footerEnabled,
        footerText: _currentTemplate.footerText,
        tableOrientation: _currentTemplate.tableOrientation,
        layoutMode: _currentTemplate.layoutMode,
        hideLeagueMatchups: _currentTemplate.hideLeagueMatchups,
        orientation: _currentTemplate.orientation,
        paperSize: _currentTemplate.paperSize
    };
    _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE, preset.overlay, keep);
    try { localStorage.setItem('campistry_pc3_preset', presetId); } catch (e) {}
    // Refresh the popover swatch active state (Style popover)
    document.querySelectorAll('.pc3-preset-item').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-preset') === presetId);
    });
    // CRITICAL: re-render the Design drawer form fields so they show the
    // preset's actual values. Without this, subsequent edits read stale form
    // state and silently revert the preset on the next input event.
    var drawerScroll = el('pc3-drawer-scroll');
    if (drawerScroll) drawerScroll.innerHTML = buildAdvancedSections();
    liveRefresh();
};

window._pc3ExportCSV = function () {
    try {
        var sel = (typeof getSelectedItems === 'function') ? getSelectedItems() : [];
        if (!sel || !sel.length) { alert('Select at least one item to export.'); return; }
        var csv = buildCSV(sel);
        var stamp = (window.currentScheduleDate || new Date().toISOString().slice(0, 10));
        downloadFile(csv, 'schedule-' + stamp + '.csv', 'text/csv;charset=utf-8;');
    } catch (e) { console.error('[PrintCenter] CSV export failed', e); alert('CSV export failed: ' + e.message); }
};
window._pc3ToggleFullscreen = function () {
    _isFullscreen = !_isFullscreen;
    var root = el('pc3-root');
    if (root) root.classList.toggle('pc3-fullscreen', _isFullscreen);
};
window._pc3ToggleSidebar = function () {
    _sidebarCollapsed = !_sidebarCollapsed;
    var sb = el('pc3-sidebar');
    if (sb) sb.classList.toggle('collapsed', _sidebarCollapsed);
    var tog = el('pc3-sidebar-toggle');
    if (tog) {
        tog.title = _sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar';
        var arrow = tog.querySelector('.pc3-sidebar-toggle-arrow');
        if (arrow) arrow.textContent = _sidebarCollapsed ? '›' : '‹';
    }
    try { localStorage.setItem('campistry_pc3_sidebarCollapsed', _sidebarCollapsed ? '1' : '0'); } catch (e) {}
};
window._pc3ToggleAdvanced = function () {
    _advancedOpen = !_advancedOpen;
    var drawer = el('pc3-drawer');
    if (drawer) drawer.classList.toggle('open', _advancedOpen);
};
window._pc3SelectAll = function () {
    document.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = true; });
    updateSidebarSelectionUI();
    liveRefresh();
};
window._pc3SelectNone = function () {
    document.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = false; });
    updateSidebarSelectionUI();
    liveRefresh();
};
window._pc3Quickpick = function (kind) {
    // Switch view, then auto-select all + refresh
    var targetView = kind === 'all-bunks' ? 'bunk' :
                     kind === 'all-locations' ? 'location' :
                     'division';
    if (_activeView !== targetView) {
        _activeView = targetView;
        // Re-render the tab "active" state
        document.querySelectorAll('[data-view]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-view') === targetView);
        });
        populateSidebar();
    }
    // Sidebar's checkboxes default to checked already, just refresh preview
    updateSidebarSelectionUI();
    liveRefresh();
};
window._pc3Print = triggerPrint;

// Week-stack print: pull all 7 days, swap the in-memory globals for each
// day in turn, build the same print HTML the user would see for that day,
// concatenate with page breaks, then restore globals and print.
// This lets us reuse the entire single-day rendering pipeline without
// duplicating any logic. Async (cloud fetch) — shows an alert if nothing
// to print, and is best-effort if any individual day fails to load.
window._pc3PrintWeekStack = function () {
    var keys = getWeekDateKeys(window.currentScheduleDate);
    if (!keys.length) { alert('Pick a date first.'); return; }
    // Force a fresh fetch so user always gets latest cloud state.
    ensureWeekDataLoaded(true);
    // Wait until _weekLoading clears, then build & print.
    var maxWait = 100; // 10s @ 100ms
    var iv = setInterval(function () {
        if (!_weekLoading || --maxWait <= 0) {
            clearInterval(iv);
            doWeekStackPrint(keys);
        }
    }, 100);
};
function doWeekStackPrint(keys) {
    var sel = getSelectedItems();
    if (!sel.length) { alert('Select at least one division/bunk to print.'); return; }
    var t = _currentTemplate;
    readDesignValues();
    var origSched = window.scheduleAssignments;
    var origLeagues = window.leagueAssignments;
    var origDate = window.currentScheduleDate;
    var combinedHtml = '';
    try {
        keys.forEach(function (k, dayIdx) {
            var day = _weekData[k];
            // Even if no data, render an empty "no schedule" page so the week is complete
            window.scheduleAssignments = (day && day.scheduleAssignments) || {};
            window.leagueAssignments = (day && day.leagueAssignments) || {};
            window.currentScheduleDate = k;
            var dayHtml = buildPrintHTML(sel);
            // Force a page break before each day after the first
            if (dayIdx > 0) {
                combinedHtml += '<div style="page-break-before:always;"></div>';
            }
            combinedHtml += '<div data-week-day="' + k + '">' + dayHtml + '</div>';
        });
    } finally {
        window.scheduleAssignments = origSched;
        window.leagueAssignments = origLeagues;
        window.currentScheduleDate = origDate;
    }

    runPrint(combinedHtml, t);
}
window._pc3ExportExcel = exportExcel;
window._pc3OpenLive = openLiveWindow;
window._pc3RunLiveStandalone = runLiveStandalone;
// The live-view pagination arrows use inline onclick="livePageNav(±1)", which
// resolves against the (popup) window's GLOBAL scope. livePageNav is defined
// inside this file's IIFE, so without this export the arrows silently no-op.
window.livePageNav = livePageNav;
window._pc3SaveTemplate = function () {
    if (!canEditTemplates()) return;
    var nm = prompt('Template name:', 'My Template');
    if (!nm) return;
    readDesignValues();
    var tp = saveCurrentAsTemplate(nm);
    if (tp) {
        _currentTemplate.id = tp.id;
        renderTemplateDropdown();
        localStorage.setItem('campistry_last_print_template', tp.id);
        if (window.showToast) window.showToast('Template saved!', 'success');
    }
};
window._pc3ResetToDefault = function () {
    _currentTemplate = Object.assign({}, DEFAULT_TEMPLATE);
    initPrintCenter();
};

// Backward compatibility
window.initPrintCenter = initPrintCenter;
window.printAllDivisions = function () {
    _activeView = 'division'; populateSidebar(); window._pc3SelectAll(); readDesignValues(); triggerPrint();
};
window.exportAllDivisionsToExcel = function () {
    _activeView = 'division'; populateSidebar(); window._pc3SelectAll(); readDesignValues(); exportExcel();
};

})();
