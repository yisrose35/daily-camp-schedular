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

var VERSION = '3.1';   // bumped to force a fresh print_center.js bundle (stale-cache bust) — also confirms the getSkeleton-delegate fix is loaded

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
    tableOrientation: 'time-top', layoutMode: 'per-division',
    orientation: 'landscape', paperSize: 'letter',
    showPageBreaks: true,
    // Default print layout = the "Shared Timeline" look: one shared time axis
    // per division, time across the top and bunks down the side, each division
    // page-broken onto its own page. Other packs (e.g. Full Master) flip off.
    sharedTimeline: true,
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

// ─────────────────────────────────────────────────────────────────────────
// USER PACKS — print a pack tailored to a specific person/role.
// Unlike PRINT_PACKS (which always include the whole camp), a user pack can be
// SCOPED so each recipient gets only their slice of the schedule:
//   • scope 'all'              → every division / every bunk (the master copy)
//   • scope 'division'         → one chosen division (division view)
//   • scope 'division-bunks'   → bunks of one chosen division, or all bunks
// Pick a pack (and a division where relevant), it configures the print center,
// then hit Print.
// ─────────────────────────────────────────────────────────────────────────
var USER_PACKS = [
    {
        id: 'full-master',
        name: 'Full Master',
        tagline: 'Every division and bunk on one master grid.',
        icon: 'grid',
        scope: 'all',
        preset: 'classic',
        view: 'division',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'all-bunks', hideLeagueMatchups: false, orientation: 'landscape', pageBreakPerBunk: false, showPageBreaks: false }
    },
    {
        id: 'division-head',
        name: 'Division Head',
        tagline: 'One labeled packet per division — page-broken to hand out.',
        icon: 'user',
        scope: 'all',
        preset: 'classic',
        view: 'division',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'landscape', pageBreakPerBunk: false, showPageBreaks: true }
    },
    {
        id: 'shared-timeline',
        name: 'Shared Timeline',
        tagline: 'One shared time axis on top, bunks down the side — each division on its own page.',
        icon: 'grid',
        scope: 'all',
        preset: 'classic',
        view: 'division',
        layout: { tableOrientation: 'time-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'landscape', pageBreakPerBunk: false, showPageBreaks: true, sharedTimeline: true }
    },
    {
        id: 'head-counselor',
        name: 'Head Counselor',
        tagline: 'Per-bunk sheets, big type — one slip per bunk.',
        icon: 'user',
        scope: 'division-bunks',
        preset: 'bold',
        view: 'bunk',
        layout: { tableOrientation: 'time-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'portrait', pageBreakPerBunk: true }
    },
    {
        id: 'specialist',
        name: 'Specialist / Facility',
        tagline: "Who's on each field, court, and room all day.",
        icon: 'mapPin',
        scope: 'all',
        preset: 'classic',
        view: 'location',
        layout: { tableOrientation: 'bunks-top', layoutMode: 'per-division', hideLeagueMatchups: false, orientation: 'landscape', pageBreakPerBunk: false }
    }
];

// Divisions in the user-facing order, filtered to those present on the date —
// mirrors how populateSidebar orders the sidebar so the pack dropdown matches.
function getOrderedPackDivisions() {
    var avail = getAvailableDivisions();
    avail = (typeof window.getUserDivisionOrder === 'function')
        ? window.getUserDivisionOrder(avail)
        : avail.slice().sort(naturalSort);
    if (typeof window.filterDivisionsByDate === 'function') avail = window.filterDivisionsByDate(avail);
    return avail;
}

// Build the "Packs" popover content from USER_PACKS. Division-scoped packs get
// a division dropdown (Head Counselor also offers "All divisions").
function buildUserPacksMenu() {
    var divOpts = getOrderedPackDivisions().map(function (d) {
        return '<option value="' + escHtml(d) + '">' + escHtml(d) + '</option>';
    }).join('');
    var html = '<div class="pcx-menu-label">Print a pack for…</div>';
    USER_PACKS.forEach(function (p) {
        var icon = ICO[p.icon] || ICO.user;
        var control;
        if (p.scope === 'division') {
            control = '<select class="pcx-up-sel" data-userpack="' + p.id + '">' +
                '<option value="">Choose…</option>' + divOpts + '</select>';
        } else if (p.scope === 'division-bunks') {
            control = '<select class="pcx-up-sel" data-userpack="' + p.id + '">' +
                '<option value="">All divisions</option>' + divOpts + '</select>';
        } else {
            control = '<button class="pcx-up-go" data-userpack="' + p.id + '">Apply</button>';
        }
        html += '<div class="pcx-up-card">' +
            '<div class="pcx-up-head">' +
                '<span class="pcx-up-icon">' + icon + '</span>' +
                '<span class="pcx-up-name">' + escHtml(p.name) + '</span>' +
            '</div>' +
            '<div class="pcx-up-tag">' + escHtml(p.tagline) + '</div>' +
            control +
        '</div>';
    });
    return html;
}

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
// ── Live View screen themes ──────────────────────────────────────────────
// The fullscreen kiosk (Live View) has its OWN palette, independent of the
// print-sheet template above — a TV/projector in a bright dining hall needs
// different colors than a printed handout. Each theme is just a map of CSS
// custom properties applied to the live overlay root (see _pcApplyLiveTheme).
// "midnight" reproduces the original hardcoded dark look exactly, so existing
// screens are unchanged until a camp picks something else.
var LIVE_THEMES = [
    {
        id: 'midnight', name: 'Midnight',
        description: 'Bright text on near-black — best for TVs in dim rooms (the classic look).',
        swatch: ['#0b1220', '#fbbf24', '#0e7490'],
        vars: {
            '--lv-bg': '#0b1220', '--lv-header-bg': '#060a16', '--lv-header-border': '#1e293b',
            '--lv-title': '#ffffff', '--lv-date': '#fcd34d', '--lv-clock': '#e2e8f0',
            '--lv-close-border': 'rgba(255,255,255,.22)', '--lv-close-bg': 'rgba(255,255,255,.10)',
            '--lv-close-text': '#ffffff', '--lv-close-bg-hover': 'rgba(255,255,255,.2)',
            '--lv-loading': '#94a3b8', '--lv-nav': 'rgba(255,255,255,.6)', '--lv-nav-hover': '#fbbf24',
            '--lv-accent': '#fbbf24', '--lv-divrange': '#8aa0bd', '--lv-cell-border': '#2b3a55',
            '--lv-th-bg': '#16233e', '--lv-th-text': '#f8fafc', '--lv-rowhead-text': '#aab8cc',
            '--lv-cell-bg': '#1c2a46', '--lv-cell-bg-alt': '#16223a', '--lv-cell-text': '#f1f5f9',
            '--lv-free-bg': '#131f33', '--lv-free-text': '#42536c',
            '--lv-current-bg': '#0e7490', '--lv-current-ring': '#22d3ee',
            '--lv-current-glow': 'rgba(34,211,238,.35)', '--lv-current-text': '#ffffff',
            '--lv-pinned-bg': '#3a2206', '--lv-pinned-text': '#fcd34d',
            '--lv-league-bg': '#262150', '--lv-league-text': '#c4b5fd',
            '--lv-curcol-bg': '#0e7490', '--lv-curcol-text': '#a5f3fc', '--lv-curcol-underline': '#fbbf24',
            '--lv-banner-border': 'rgba(251,191,36,.35)',
            '--lv-uni-grade-bg': '#0e1830', '--lv-uni-grade-text': '#fcd34d',
            '--lv-uni-bunk-bg': '#0b1326', '--lv-uni-bunk-text': '#cbd5e1', '--lv-fit-on-text': '#1f2937',
            '--lv-dot-idle': 'rgba(255,255,255,.3)'
        }
    },
    {
        id: 'daylight', name: 'Daylight',
        description: 'Dark text on white — best for bright rooms, windows, and projectors.',
        swatch: ['#ffffff', '#0e7490', '#f1f5f9'],
        vars: {
            '--lv-bg': '#f1f5f9', '--lv-header-bg': '#ffffff', '--lv-header-border': '#e2e8f0',
            '--lv-title': '#0f172a', '--lv-date': '#b45309', '--lv-clock': '#334155',
            '--lv-close-border': 'rgba(15,23,42,.18)', '--lv-close-bg': 'rgba(15,23,42,.05)',
            '--lv-close-text': '#0f172a', '--lv-close-bg-hover': 'rgba(15,23,42,.12)',
            '--lv-loading': '#64748b', '--lv-nav': 'rgba(15,23,42,.45)', '--lv-nav-hover': '#0e7490',
            '--lv-accent': '#0f6e80', '--lv-divrange': '#64748b', '--lv-cell-border': '#cbd5e1',
            '--lv-th-bg': '#e2e8f0', '--lv-th-text': '#0f172a', '--lv-rowhead-text': '#475569',
            '--lv-cell-bg': '#ffffff', '--lv-cell-bg-alt': '#f8fafc', '--lv-cell-text': '#1e293b',
            '--lv-free-bg': '#f1f5f9', '--lv-free-text': '#94a3b8',
            '--lv-current-bg': '#cffafe', '--lv-current-ring': '#0e7490',
            '--lv-current-glow': 'rgba(14,116,144,.25)', '--lv-current-text': '#0c4a6e',
            '--lv-pinned-bg': '#fef3c7', '--lv-pinned-text': '#92400e',
            '--lv-league-bg': '#ede9fe', '--lv-league-text': '#5b21b6',
            '--lv-curcol-bg': '#cffafe', '--lv-curcol-text': '#0c4a6e', '--lv-curcol-underline': '#0e7490',
            '--lv-banner-border': 'rgba(14,116,144,.3)',
            '--lv-uni-grade-bg': '#e2e8f0', '--lv-uni-grade-text': '#0f172a',
            '--lv-uni-bunk-bg': '#f1f5f9', '--lv-uni-bunk-text': '#475569', '--lv-fit-on-text': '#ffffff',
            '--lv-dot-idle': 'rgba(15,23,42,.2)'
        }
    },
    {
        id: 'teal', name: 'Camp Teal',
        description: 'On-brand teal header over a soft cyan board — friendly and easy on the eyes.',
        swatch: ['#147D91', '#ecfeff', '#fbbf24'],
        vars: {
            '--lv-bg': '#ecfeff', '--lv-header-bg': '#147D91', '--lv-header-border': '#0F5F6E',
            '--lv-title': '#ffffff', '--lv-date': '#fde68a', '--lv-clock': '#ecfeff',
            '--lv-close-border': 'rgba(255,255,255,.3)', '--lv-close-bg': 'rgba(255,255,255,.14)',
            '--lv-close-text': '#ffffff', '--lv-close-bg-hover': 'rgba(255,255,255,.26)',
            '--lv-loading': '#0f6e80', '--lv-nav': 'rgba(15,95,110,.5)', '--lv-nav-hover': '#0F5F6E',
            '--lv-accent': '#0F5F6E', '--lv-divrange': '#5b8a93', '--lv-cell-border': '#b6e3ea',
            '--lv-th-bg': '#cdeef3', '--lv-th-text': '#0F5F6E', '--lv-rowhead-text': '#0f6e80',
            '--lv-cell-bg': '#ffffff', '--lv-cell-bg-alt': '#f3fcfd', '--lv-cell-text': '#134e57',
            '--lv-free-bg': '#ecfeff', '--lv-free-text': '#93b8bf',
            '--lv-current-bg': '#147D91', '--lv-current-ring': '#fbbf24',
            '--lv-current-glow': 'rgba(20,125,145,.3)', '--lv-current-text': '#ffffff',
            '--lv-pinned-bg': '#fff4d6', '--lv-pinned-text': '#92560e',
            '--lv-league-bg': '#e9e5ff', '--lv-league-text': '#5b21b6',
            '--lv-curcol-bg': '#147D91', '--lv-curcol-text': '#ecfeff', '--lv-curcol-underline': '#fbbf24',
            '--lv-banner-border': 'rgba(15,95,110,.3)',
            '--lv-uni-grade-bg': '#cdeef3', '--lv-uni-grade-text': '#0F5F6E',
            '--lv-uni-bunk-bg': '#e3f6f9', '--lv-uni-bunk-text': '#0f6e80', '--lv-fit-on-text': '#ffffff',
            '--lv-dot-idle': 'rgba(15,95,110,.25)'
        }
    },
    {
        id: 'contrast', name: 'High Contrast',
        description: 'Pure black on white with bold weights — maximum legibility from across a field.',
        swatch: ['#000000', '#ffffff', '#ffeb00'],
        vars: {
            '--lv-bg': '#ffffff', '--lv-header-bg': '#000000', '--lv-header-border': '#000000',
            '--lv-title': '#ffffff', '--lv-date': '#ffd400', '--lv-clock': '#ffffff',
            '--lv-close-border': 'rgba(255,255,255,.5)', '--lv-close-bg': 'rgba(255,255,255,.15)',
            '--lv-close-text': '#ffffff', '--lv-close-bg-hover': 'rgba(255,255,255,.3)',
            '--lv-loading': '#000000', '--lv-nav': '#000000', '--lv-nav-hover': '#0e7490',
            '--lv-accent': '#000000', '--lv-divrange': '#333333', '--lv-cell-border': '#000000',
            '--lv-th-bg': '#000000', '--lv-th-text': '#ffffff', '--lv-rowhead-text': '#ffffff',
            '--lv-cell-bg': '#ffffff', '--lv-cell-bg-alt': '#f2f2f2', '--lv-cell-text': '#000000',
            '--lv-free-bg': '#ffffff', '--lv-free-text': '#999999',
            '--lv-current-bg': '#ffeb00', '--lv-current-ring': '#000000',
            '--lv-current-glow': 'rgba(0,0,0,.3)', '--lv-current-text': '#000000',
            '--lv-pinned-bg': '#ffe08a', '--lv-pinned-text': '#000000',
            '--lv-league-bg': '#d9d2ff', '--lv-league-text': '#000000',
            '--lv-curcol-bg': '#000000', '--lv-curcol-text': '#ffeb00', '--lv-curcol-underline': '#ffeb00',
            '--lv-banner-border': '#000000',
            '--lv-uni-grade-bg': '#000000', '--lv-uni-grade-text': '#ffffff',
            '--lv-uni-bunk-bg': '#222222', '--lv-uni-bunk-text': '#ffffff', '--lv-fit-on-text': '#ffffff',
            '--lv-dot-idle': 'rgba(0,0,0,.25)'
        }
    }
];
var _LIVE_THEME_KEY = 'pc3LiveTheme';

// Resolve the camp's chosen live theme (defaults to Midnight = original look).
function _pcGetLiveThemeId() {
    try {
        var id = localStorage.getItem(_LIVE_THEME_KEY);
        if (id && LIVE_THEMES.some(function (t) { return t.id === id; })) return id;
    } catch (e) {}
    return 'midnight';
}
function _pcGetLiveTheme(id) {
    id = id || _pcGetLiveThemeId();
    for (var i = 0; i < LIVE_THEMES.length; i++) { if (LIVE_THEMES[i].id === id) return LIVE_THEMES[i]; }
    return LIVE_THEMES[0];
}
// Apply a theme's CSS variables to the live overlay root + page background.
// Safe to call in either window; no-op if the overlay isn't present.
function _pcApplyLiveTheme(id) {
    var theme = _pcGetLiveTheme(id);
    var overlay = document.getElementById('pc3-live-overlay');
    if (overlay) {
        Object.keys(theme.vars).forEach(function (k) { overlay.style.setProperty(k, theme.vars[k]); });
    }
    // The standalone kiosk paints #print as the backdrop behind the overlay.
    var printTab = document.getElementById('print');
    if (printTab && document.documentElement.classList.contains('pc3-live-standalone')) {
        printTab.style.background = theme.vars['--lv-bg'];
    }
    return theme;
}

var _previewHtml = '';
var _cloudSyncTimeout = null;
var _liveInterval = null;
var _liveCursorInterval = null;
var _liveWindow = null;
var _livePageIndex = 0;
var _numLivePages = 1;
var _livePageTimer = null;
var _livePrevPageCount = -1; // page count when the rotation timer was last (re)started
var _liveRenderSig = ''; // signature of the last live render — skip rebuilds when nothing visible changed
var _liveRenderToken = 0; // bumped each render; a deferred (rAF) pass aborts if a newer render superseded it
var _LIVE_PAGE_MS = 20000; // ms between page rotations
// "One division per page" — each page shows one division (all its grades and
// their bunks), rotating through divisions. A division that doesn't fit on one
// page spills onto additional pages. Persisted so the kiosk remembers the
// operator's choice across reloads.
var _liveOneDivPerPage = (function () {
    try { return localStorage.getItem('pc3_live_one_div_per_page') === '1'; } catch (e) { return false; }
})();
// "Whole camp on one screen" — shrink EVERY division onto a single, non-rotating
// page no matter how small it gets (no readability floor, no fallback). Mutually
// exclusive with one-division-per-page.
var _liveWholeCamp = (function () {
    try { return localStorage.getItem('pc3_live_whole_camp') === '1'; } catch (e) { return false; }
})();
// "Shared timeline" — render one time axis down the Y-axis per division with all
// the division's bunks as columns (grouped by grade), instead of a separate
// per-grade grid. Much denser. Independent of the page-fit toggles above.
var _liveSharedTimeline = (function () {
    try { return localStorage.getItem('pc3_live_shared_timeline') === '1'; } catch (e) { return false; }
})();
// "Custom pages" — the operator assigns each bunk to a specific page number, so
// pages contain exactly the bunks they choose (overrides auto-pagination).
var _liveCustomPages = (function () {
    try { return localStorage.getItem('pc3_live_custom_pages') === '1'; } catch (e) { return false; }
})();
var _liveCustomPageMap = (function () {
    try { return JSON.parse(localStorage.getItem('pc3_live_custom_page_map') || '{}') || {}; } catch (e) { return {}; }
})();
function _cpBunkKey(divName, bunk) { return divName + ' ' + bunk; }
var _timeIncrement = 15; // minutes: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60
// ★ Day 22.5+ Print Center reinvention — activity-aligned columns, per-bunk page breaks,
//   content toggles. These are persisted via localStorage so the user's setup survives
//   page reloads. Defaults bias toward "looks good on paper out-of-the-box".
var _activityAligned = true;   // true → columns sized by activity duration (default); false → uniform fixed increments
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
    // ★ Use the EXACT skeleton the unified view uses, so the print center and unified can
    //   never disagree. Unified's getSkeleton reads the per-date board (campDailyData_v1
    //   [date], which survives the pre-generation wipe that nukes campManualSkeleton_<date>)
    //   and treats it as authoritative; the volatile window.manualSkeleton holds the Master
    //   Scheduler day-of-week TEMPLATE. Delegating means print draws exactly the day's board.
    try {
        if (window.UnifiedScheduleSystem && typeof window.UnifiedScheduleSystem.getSkeleton === 'function') {
            var _u = window.UnifiedScheduleSystem.getSkeleton(window.currentScheduleDate);
            if (Array.isArray(_u)) return _u;
        }
    } catch (e) { }
    // Fallback when the unified system isn't loaded: per-date board first, then legacy chain.
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
    // Trips are off-site events, not a shared field — never annotate "vs Bunk X".
    if (myEntry._isTrip || myEntry._trip || (myEntry.type || '').toLowerCase() === 'trip') return [];
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

// Resolve the location/field to DISPLAY. Sports keep it in `field`; specials
// keep it in `_specialLocation` / `_customField` (and `field` may hold the
// special's NAME, not its room). Prefer the real special location so e.g.
// Baking shows its "Baking Shop".
// Look up a special's CONFIGURED room by activity name. Manual mode stores
// field = the special's NAME (not its room); the room lives in the special
// config, resolved via getLocationForActivity (scheduler_core_main.js). Cached
// per name since the specials list is stable within a print session.
var _pcSpecialLocCache = {};
function pcConfiguredSpecialLocation(act) {
    if (!act) return '';
    var key = String(act).toLowerCase().trim();
    if (Object.prototype.hasOwnProperty.call(_pcSpecialLocCache, key)) return _pcSpecialLocCache[key];
    var loc = '';
    try {
        // ★ This camp duplicates specials cap + lowercase, and the lowercase dup
        //   often has a BLANK location. getLocationForActivity is first-match-wins,
        //   so it can return '' for the dup even though a sibling entry carries the
        //   room. Scan all specials case-insensitively for the FIRST one that
        //   actually has a location before falling back.
        var specials = (typeof window.getGlobalSpecialActivities === 'function' && window.getGlobalSpecialActivities())
            || (window.loadGlobalSettings && window.loadGlobalSettings().app1 && window.loadGlobalSettings().app1.specialActivities)
            || [];
        for (var i = 0; i < specials.length; i++) {
            var s = specials[i];
            if (s && s.name && String(s.name).toLowerCase().trim() === key && s.location) { loc = s.location; break; }
        }
        if (!loc && typeof window.getLocationForActivity === 'function') {
            var l = window.getLocationForActivity(act);
            if (l && typeof l === 'string') loc = l;
        }
    } catch (e) { /* ignore */ }
    _pcSpecialLocCache[key] = loc;
    return loc;
}

// ★ Canonical display name. The schedule can store a non-canonical variant of an
//   activity/facility name — most commonly the all-lowercase duplicate this camp
//   keeps alongside the proper-cased special (e.g. "arts & crafts" vs the
//   configured "Arts & Crafts"). Map a stored name back to the configured casing
//   by a case-insensitive lookup across specials, facilities and fields,
//   preferring a variant that carries capitals over an all-lowercase duplicate.
//   Returns the name unchanged when there is no config match (sports, custom
//   tiles, etc.) — a complete no-op for correctly-cased entries.
var _pcCanonNameMap = null;
function pcCanonicalActivityName(name) {
    if (!name) return name;
    if (!_pcCanonNameMap) {
        _pcCanonNameMap = {};
        try {
            var g = (window.loadGlobalSettings && window.loadGlobalSettings()) || {};
            var names = [];
            var specials = (typeof window.getGlobalSpecialActivities === 'function' && window.getGlobalSpecialActivities())
                || (g.app1 && g.app1.specialActivities) || [];
            specials.forEach(function (s) { if (s && s.name) names.push(s.name); });
            var facs = (typeof window.getFacilities === 'function' && window.getFacilities()) || [];
            facs.forEach(function (f) { var nm = (typeof f === 'string') ? f : (f && f.name); if (nm) names.push(nm); });
            var fields = (g.app1 && g.app1.fields) || [];
            fields.forEach(function (f) { var nm = (typeof f === 'string') ? f : (f && f.name); if (nm) names.push(nm); });
            names.forEach(function (nm) {
                var k = String(nm).toLowerCase().trim();
                if (!k) return;
                var cur = _pcCanonNameMap[k];
                // First writer wins, but a capitalized variant always beats an
                // all-lowercase duplicate of the same name.
                if (!cur || (cur === cur.toLowerCase() && nm !== nm.toLowerCase())) _pcCanonNameMap[k] = nm;
            });
        } catch (e) { /* ignore */ }
    }
    return _pcCanonNameMap[String(name).toLowerCase().trim()] || name;
}

function pcResolveLocation(entry) {
    if (!entry) return '';
    var act = entry._activity || entry.sport || '';
    var loc = entry._specialLocation || entry._customField || entry._location || '';
    // ★ Custom/pinned tile with specific fields → list every reserved field
    //   ("Field 1, Field 2"), matching the unified grid (renderBunkCell). Skip
    //   swim+elective entries, which carry _reservedFields for a different
    //   purpose and already have their own dedicated label path.
    if (!loc && !entry._swimElective && Array.isArray(entry._reservedFields) && entry._reservedFields.length) {
        var _rf = entry._reservedFields.filter(Boolean);
        if (_rf.length) loc = _rf.join(', ');
    }
    if (!loc) {
        var f = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
        if (f && f !== 'Free') loc = f;
    }
    // No real location, or it just echoes the activity name (manual specials):
    // fall back to the special's configured room.
    if ((!loc || loc === act) && act) {
        var cfg = pcConfiguredSpecialLocation(act);
        if (cfg) loc = cfg;
    }
    if (!loc || loc === 'Free') return '';
    return loc;
}
// A special's location lives in _specialLocation/_customField or the special
// config. For those we always show "Activity - Location" (even when the room
// name contains the activity, e.g. Baking → Baking Shop); sports keep the
// substring dedup.
function pcHasSpecialLoc(entry) {
    if (!entry) return false;
    if (entry._specialLocation || entry._customField || entry._location) return true;
    var act = entry._activity || entry.sport || '';
    return !!(act && pcConfiguredSpecialLocation(act));
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
    // Display-name ALIAS = the EXACT cell text the user typed; show it verbatim with
    // no location appended (e.g. "Lake", never "Lake \u2013 VR").
    if (entry._displayName) return entry._displayName;
    var parts = [];
    var act = pcCanonicalActivityName(entry._activity || entry.sport || '');
    var label = entry._partLabel || act; // \u2605 Day 19: show "Baking 1/3" for multiPart specials
    var field = pcResolveLocation(entry);
    // Always show "Activity \u2013 Location" (activity name first), for sports AND
    // specials. Location is dropped only when it's empty or identical to the name
    // (pcResolveLocation already returns '' when there's no meaningful room).
    if (act && field && act.toLowerCase() !== field.toLowerCase()) {
        parts.push(label); parts.push(field);
    } else if (field) { parts.push(entry._partLabel ? label : field); }
    else if (act) { parts.push(label); }
    return parts.join(' \u2013 ');
}

// Live-view entry text: same as formatEntry, but an elective / large pinned
// reservation that lists several fields is broken onto separate lines (one
// field per line) so it's readable on screen. Cells use white-space:pre-line.
// Kept separate from formatEntry so the print/Excel paths are unaffected.
function pcLiveEntryText(entry) {
    if (entry && entry._swimElective) {
        var poolLc = (entry._swimLocation || '').toLowerCase().trim();
        var acts = (entry._electiveActivities && entry._electiveActivities.length)
            ? entry._electiveActivities
            : (entry._reservedFields || entry.reservedFields || []);
        var filtered = acts.filter(function (a) { return (a || '').toLowerCase().trim() !== poolLc; });
        return ['Swim'].concat(filtered).join('\n');
    }
    return formatEntry(entry);
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
    var pillBg = '#ffffff';
    var pillTx = type === 'free' ? '#bbbbbb' : '#000000';
    if (preMin > 0 || postMin > 0) {
        var html = '<div style="overflow:hidden;display:flex;flex-direction:column;">';
        if (preMin > 0) {
            html += '<div style="background:#fce4d6;color:#833c00;padding:2px 6px;text-align:center;font-size:10px;font-weight:400;border-bottom:1px solid #c6c6c6;">Change ' + preMin + 'm</div>';
        }
        html += '<div style="background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;text-align:center;flex:1;">';
        html += '<span style="font-size:11px;font-weight:500;">' + escHtml(text) + '</span>';
        html += '</div>';
        if (postMin > 0) {
            html += '<div style="background:#fce4d6;color:#833c00;padding:2px 6px;text-align:center;font-size:10px;font-weight:400;border-top:1px solid #c6c6c6;">Change ' + postMin + 'm</div>';
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
                if (m.sport) s += ' - ' + (m.sport.charAt(0).toUpperCase() + m.sport.slice(1));
                if (m.field) s += ' - ' + m.field;
                matchups.push(s);
            }
        }
    });
    return { label: label, matchups: matchups };
}

// Returns matchup lines for a manual league block, formatted as
// "Football - Football Field 1 - Team 1 vs Team 2". When `bunk` is given and the
// teams are bunk-like, returns only that bunk's game; otherwise all games.
function buildLeagueMatchups(eventBlock, divName, bunk) {
    var raw = [];
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
    allSlotEntries.sort(function (a, b) { return a.dist - b.dist; });

    var slotSport = '', slotField = '';
    if (allSlotEntries.length > 0 && allSlotEntries[0].data) {
        var best = allSlotEntries[0].data;
        if (best.matchups) raw = best.matchups;
        slotSport = (best.sport || '').toString().trim();
        slotField = (best.field || '').toString().trim();
    }
    if (!raw.length) {
        var llm = window.lastLeagueMatchups;
        if (llm && llm[divName] && llm[divName].matchups) raw = llm[divName].matchups;
    }

    var parsed = (raw || []).map(pcParseMatchup).filter(function (p) { return p.a && p.b; });
    // Backfill sport/field from the slot record when the matchup lacks them.
    parsed.forEach(function (p) {
        if (!p.sport && slotSport) p.sport = slotSport;
        if (!p.field && slotField) p.field = slotField;
    });

    if (bunk != null) {
        var bn = String(bunk).replace(/^bunk\s*/i, '').trim();
        var mine = parsed.filter(function (p) {
            return String(p.a).replace(/^bunk\s*/i, '').trim() === bn ||
                   String(p.b).replace(/^bunk\s*/i, '').trim() === bn;
        });
        if (mine.length) parsed = mine;
    }

    return parsed.map(pcFormatMatchupLine);
}

// Parse one matchup (object or string) into { a, b, sport, field }.
// Handles "1 vs 2 @ Football Field 1 (football)", "Bunk 1 vs Bunk 2 – Football", etc.
function pcParseMatchup(m) {
    if (m && typeof m === 'object') {
        var oa = String(m.teamA || m.team1 || '').trim();
        var ob = String(m.teamB || m.team2 || '').trim();
        if ((!oa || !ob) && (m.display || m.matchup)) {
            // No structured teams — parse the human string, but keep any
            // structured sport/field the object already carries.
            var p = pcParseMatchup(String(m.display || m.matchup));
            if (m.sport) p.sport = String(m.sport).trim();
            if (m.field) p.field = String(m.field).trim();
            return p;
        }
        return {
            a: oa,
            b: ob,
            sport: (m.sport || '').toString().trim(),
            field: (m.field || '').toString().trim()
        };
    }
    var s = String(m == null ? '' : m).trim();
    var sport = '', field = '';
    var pm = s.match(/\(([^)]+)\)\s*$/);            // "(football)" at the end
    if (pm) { sport = pm[1].trim(); s = s.slice(0, pm.index).trim(); }
    var am = s.match(/@\s*(.+)$/);                   // "@ Football Field 1"
    if (am) { field = am[1].trim(); s = s.slice(0, am.index).trim(); }
    var vm = s.split(/\s+vs\.?\s+/i);
    var a = (vm[0] || '').trim();
    var b = (vm[1] || '').trim();
    var dm = b.match(/\s+[–-]\s+(.+)$/);        // trailing " – Football" on team B
    if (dm && !sport) { sport = dm[1].trim(); b = b.slice(0, dm.index).trim(); }
    return { a: a, b: b, sport: sport, field: field };
}

// Format one parsed matchup as "Team 1 vs Team 2 - Football - Football Field 1"
// (teams first, then sport, then field — easiest to scan on the live screen).
// League teams are separate entities from bunks, so numeric labels get a
// "Team " prefix (NOT "Bunk ").
function pcFormatMatchupLine(p) {
    var sport = p.sport ? (p.sport.charAt(0).toUpperCase() + p.sport.slice(1)) : '';
    var a = /^\d+$/.test(String(p.a).trim()) ? 'Team ' + p.a : p.a;
    var b = /^\d+$/.test(String(p.b).trim()) ? 'Team ' + p.b : p.b;
    return [a + ' vs ' + b, sport, p.field].filter(Boolean).join(' - ');
}

// Build a league/specialty-league cell for the live view: the game/league label
// on the first line, then each matchup on its OWN line — far easier to read than
// one long comma-separated run. Cells must use white-space:pre-line to honor the
// newlines.
function pcLeagueCellText(label, matchups) {
    if (!matchups || !matchups.length) return label || '';
    var lines = matchups.slice();
    if (label) lines.unshift(label);
    return lines.join('\n');
}

// Pull the raw leagueAssignments slot record for a division/time (sport, field, matchups).
function pcLeagueSlotRecord(divName, startMin) {
    if (divName == null || startMin == null) return null;
    var la = window.leagueAssignments || {};
    var divLA = la[divName] || {};
    var sIdx = findFirstSlotForTime(startMin, divName);
    var keys = [sIdx, String(sIdx), startMin, String(startMin)];
    for (var i = 0; i < keys.length; i++) { if (keys[i] != null && divLA[keys[i]]) return divLA[keys[i]]; }
    if (sIdx >= 0) { for (var off = 1; off <= 2; off++) { if (divLA[sIdx + off]) return divLA[sIdx + off]; if (divLA[sIdx - off]) return divLA[sIdx - off]; } }
    return null;
}

// Build a rich league label for a bunk's game: "Football - Football Field 1 - Team 1 vs Team 2".
// Returns { sport, field, matchup, full }. Picks the matchup involving `bunk` when the
// teams are bunk-like; otherwise lists all matchups for the game.
function pcLeagueLabel(entry, bunk, divName, startMin) {
    entry = entry || {};
    var sport = (entry._leagueSport || entry.sport || '').toString().trim();
    var field = typeof entry.field === 'string' ? entry.field
              : (entry.field && entry.field.name ? entry.field.name : '');
    var raw = entry._matchups || entry.matchups || entry._allMatchups || [];
    var rec = pcLeagueSlotRecord(divName, startMin);
    if ((!raw || !raw.length) && rec && rec.matchups) raw = rec.matchups;
    // Sport/field fallback from the league slot record (entry often lacks them).
    if (!sport && rec && rec.sport) sport = String(rec.sport).trim();
    if (!field && rec && rec.field) field = String(rec.field).trim();
    var parsed = (raw || []).map(pcParseMatchup).filter(function (p) { return p.a && p.b; });

    var mine = null;
    if (bunk != null) {
        var bn = String(bunk).replace(/^bunk\s*/i, '').trim();
        mine = parsed.filter(function (p) {
            var na = String(p.a).replace(/^bunk\s*/i, '').trim();
            var nb = String(p.b).replace(/^bunk\s*/i, '').trim();
            return na === bn || nb === bn;
        });
    }
    var chosen = (mine && mine.length) ? mine : parsed;

    var fmtPair = function (p) {
        // League teams are separate entities from bunks → "Team " prefix.
        var a = /^\d+$/.test(String(p.a).trim()) ? 'Team ' + p.a : p.a;
        var b = /^\d+$/.test(String(p.b).trim()) ? 'Team ' + p.b : p.b;
        return a + ' vs ' + b;
    };
    var matchStrs = chosen.map(fmtPair);

    if (chosen.length === 1) {
        if (chosen[0].sport) sport = chosen[0].sport;
        if (chosen[0].field) field = chosen[0].field;
    }
    if (sport) sport = sport.charAt(0).toUpperCase() + sport.slice(1);

    var parts = [];
    if (sport) parts.push(sport);
    if (field && field !== sport) parts.push(field);
    if (matchStrs.length) parts.push(matchStrs.join(', '));
    if (!parts.length) parts.push(entry._gameLabel || entry._leagueName || 'League Game');

    return {
        sport: sport,
        field: (field && field !== sport) ? field : '',
        matchup: matchStrs.join(', '),
        full: parts.join(' - ')
    };
}


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
    '.pc3-sheet{background:#fff;border-radius:0;box-shadow:0 1px 4px rgba(0,0,0,.12);border:1px solid #b0b0b0;margin:0 0 20px;overflow:hidden;position:relative;width:100%;}' +
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

    /* ── Schedule Table — Excel look ── */
    '.pc3-tbl{border-collapse:collapse;border-spacing:0;width:100%;table-layout:auto;user-select:none;font-family:Calibri,"Segoe UI",Arial,sans-serif;}' +
    '.pc3-tbl th,.pc3-tbl td{border:1px solid #c6c6c6;padding:5px 9px;text-align:center;white-space:nowrap;position:relative;font-size:13px;color:#000;line-height:1.25;}' +
    /* Column headers (period / bunk names) — Excel gray header bar */
    '.pc3-tbl th{background:#f2f2f2;color:#1f1f1f;font-weight:600;position:sticky;z-index:2;font-size:12px;text-transform:none;letter-spacing:0;border-color:#b0b0b0;}' +
    '.pc3-tbl thead th{top:0;}' +
    '.pc3-tbl th.corner{z-index:3;left:0;top:0;background:#e6e6e6;}' +
    /* Row header column (time / bunk) — Excel gray, like the row-number gutter */
    '.pc3-tbl th.row-head{position:sticky;left:0;z-index:2;background:#f2f2f2;color:#1f1f1f;font-weight:600;text-transform:none;letter-spacing:0;font-size:12px;text-align:left;font-variant-numeric:tabular-nums;border-color:#b0b0b0;}' +
    /* Data cells — plain white, black text */
    '.pc3-tbl td{font-weight:400;color:#000;background:#fff;}' +
    /* Empty slots */
    '.pc3-tbl .cell-free{color:#bdbdbd;font-weight:400;}' +
    /* Standard Excel fill colors for categories */
    '.pc3-tbl .cell-pinned{background:#fff2cc;color:#000;}' +
    '.pc3-tbl .cell-league{background:#ddebf7;color:#000;}' +
    '.pc3-tbl .cell-transition{background:#f2f2f2;color:#000;font-size:11px;font-weight:400;font-style:italic;}' +
    /* Black-and-white override for the print sheets — applied only while
       rasterizing the preview to a JPEG / image-print (white cells, black
       borders, black text, like an Excel printout). */
    '.pc3-bw, .pc3-bw .pc3-sheet, .pc3-bw .pc3-sheet-head{background:#fff !important;}' +
    '.pc3-bw .pc3-sheet-head{border-bottom:1px solid #000 !important;}' +
    '.pc3-bw .pc3-sheet-title, .pc3-bw .pc3-sheet-subtitle, .pc3-bw .pc3-sheet-badge{color:#000 !important;background:#fff !important;}' +
    '.pc3-bw .pc3-tbl th, .pc3-bw .pc3-tbl td{background:#fff !important;color:#000 !important;border:1px solid #000 !important;box-shadow:none !important;}' +
    '.pc3-bw .pc3-tbl .cell-free{color:#000 !important;}' +

    /* ── Excel-style coordinate headers (A B C / 1 2 3) ── */
    '.pc3-tbl tr.pc3-coord-row th{background:#e6e6e6!important;color:#5f6368;font-size:10px;font-weight:600;text-align:center!important;padding:2px 6px;border:1px solid #b0b0b0;height:18px;letter-spacing:.4px;top:0;z-index:4;}' +
    '.pc3-tbl tr.pc3-coord-row th.pc3-coord-corner{background:#d4d4d4!important;color:transparent;left:0;z-index:5;min-width:36px;width:36px;}' +
    '.pc3-tbl th.pc3-row-num{background:#e6e6e6!important;color:#5f6368;font-size:10px;font-weight:600;text-align:center!important;padding:2px 4px;border:1px solid #b0b0b0;width:36px;min-width:36px;position:sticky;left:0;z-index:3;}' +
    '.pc3-tbl tr:nth-child(even) th.pc3-row-num{background:#e6e6e6!important;}' +
    /* Excel green selection */
    '.pc3-tbl td.pc3-cell-selected,.pc3-tbl th.pc3-cell-selected:not(.pc3-row-num):not(.pc3-coord-corner):not(.pc3-coord-row th){background:rgba(16,124,65,.12)!important;}' +
    '.pc3-tbl td.pc3-cell-active,.pc3-tbl th.pc3-cell-active:not(.pc3-row-num):not(.pc3-coord-corner){outline:2px solid #107c41!important;outline-offset:-2px;background:rgba(16,124,65,.18)!important;z-index:2;}' +
    '.pc3-tbl tr.pc3-coord-row th.pc3-coord-active{background:#107c41!important;color:#fff!important;}' +
    '.pc3-tbl th.pc3-row-num.pc3-coord-active{background:#107c41!important;color:#fff!important;}' +
    '.pc3-tbl td,.pc3-tbl th{cursor:cell;}' +
    '.pc3-tbl tr.pc3-coord-row th,.pc3-tbl th.pc3-row-num{cursor:default;}' +

    /* ── Auto TIMELINE (brick model): each bunk = one track, cards sized to duration ── */
    '.pc3-tl{font-family:"Segoe UI",Calibri,Helvetica,Arial,sans-serif;background:#fff;width:100%;user-select:none;-webkit-font-smoothing:antialiased;}' +
    '.pc3-tl-row{display:flex;align-items:stretch;}' +
    '.pc3-tl-row:not(:last-child){border-bottom:1px solid #f1f4f7;}' +
    '.pc3-tl-bodyrow.pc3-tl-alt .pc3-tl-track{background:#fcfdfe;}' +
    '.pc3-tl-bodyrow:hover .pc3-tl-track{background:#f5f9ff;}' +
    '.pc3-tl-headrow{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid #e6eaee;box-shadow:0 1px 0 rgba(15,23,42,.03);}' +
    '.pc3-tl-periodrow{background:linear-gradient(#fafbfc,#f4f6f8);border-bottom:1px solid #eaeef2;}' +
    '.pc3-tl-corner,.pc3-tl-bunk{width:132px;min-width:132px;flex-shrink:0;display:flex;align-items:center;padding:6px 14px;font-size:13px;color:#1e293b;border-right:1px solid #e2e8f0;background:#f8fafc;position:sticky;left:0;z-index:2;box-sizing:border-box;letter-spacing:.01em;}' +
    '.pc3-tl-corner{font-weight:700;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}' +
    '.pc3-tl-bunk{font-weight:600;}' +
    '.pc3-tl-bodyrow.pc3-tl-alt .pc3-tl-bunk{background:#f4f7fa;}' +
    '.pc3-tl-track{position:relative;flex:1;min-width:0;height:54px;transition:background .12s;}' +
    '.pc3-tl-headrow .pc3-tl-track{height:32px;}' +
    '.pc3-tl-periodrow .pc3-tl-track{height:28px;}' +
    '.pc3-tl-tick{position:absolute;top:0;bottom:0;border-left:1px solid #eef1f4;}' +
    '.pc3-tl-tick.major{border-left-color:#e2e6ea;}' +
    '.pc3-tl-tick span{position:absolute;top:9px;left:5px;font-size:10px;font-weight:500;color:#9aa5b1;white-space:nowrap;letter-spacing:.01em;}' +
    '.pc3-tl-tick.major span{color:#64748b;font-weight:600;}' +
    '.pc3-tl-vline{position:absolute;top:0;bottom:0;border-left:1px solid #f4f6f9;}' +
    '.pc3-tl-period{position:absolute;top:4px;bottom:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#475569;background:#eef2f6;border:1px solid #dde3ea;border-radius:6px;overflow:hidden;white-space:nowrap;padding:0 8px;box-sizing:border-box;letter-spacing:.02em;}' +
    '.pc3-tl-block{position:absolute;top:5px;bottom:5px;border:1px solid #e3e8ee;border-left:3px solid #cbd5e1;border-radius:8px;background:#fff;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.06),0 1px 1px rgba(15,23,42,.04);display:flex;box-sizing:border-box;transition:box-shadow .12s,transform .12s;}' +
    '.pc3-tl-block:hover{box-shadow:0 4px 10px rgba(15,23,42,.12);transform:translateY(-1px);z-index:3;}' +
    '.pc3-tl-block-in{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;padding:4px 10px;}' +
    '.pc3-tl-name{font-size:12.5px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25;}' +
    '.pc3-tl-sub{font-size:10.5px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}' +
    '.pc3-tl-dur{font-size:9px;font-weight:500;color:#aab4c0;margin-top:2px;letter-spacing:.03em;}' +
    '.pc3-tl-chg{flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#fff4ec;color:#b45309;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;min-width:16px;border-right:1px solid #f3e3d4;}' +
    '@media print{.pc3-tl-block{box-shadow:none;}.pc3-tl-headrow{box-shadow:none;}.pc3-tl-bodyrow:hover .pc3-tl-track{background:transparent;}}' +

    /* ── Sheet Header — Excel sheet-tab feel ── */
    '.pc3-sheet-head{padding:10px 14px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #c6c6c6;background:#f7f7f7;}' +
    '.pc3-sheet-title{font-family:Calibri,"Segoe UI",Arial,sans-serif;font-size:16px;font-weight:700;color:#1f1f1f;letter-spacing:0;}' +
    '.pc3-sheet-subtitle{font-size:12px;color:#5f6368;font-weight:500;}' +
    '.pc3-sheet-badge{font-size:10px;font-weight:700;padding:3px 9px;border-radius:3px;background:#107c41;color:#fff;text-transform:uppercase;letter-spacing:.5px;margin-left:auto;}' +

    /* ── League Matchups ── */
    '.pc3-matchup{display:inline-block;margin:1px 4px 1px 0;padding:1px 7px;background:#ddebf7;border:1px solid #9bc2e6;border-radius:2px;font-size:10px;white-space:nowrap;color:#1f3864;}' +

    /* ── Live Mode ── kiosk theme (TV / big-screen friendly). Colors are driven
       by --lv-* custom properties so a camp can re-skin the screen via the Live
       theme picker; the defaults below are the original "Midnight" palette, so
       an un-themed overlay looks identical to before. See LIVE_THEMES. */
    '.pc3-live-overlay{' +
        '--lv-bg:#0b1220;--lv-header-bg:#060a16;--lv-header-border:#1e293b;' +
        '--lv-title:#ffffff;--lv-date:#fcd34d;--lv-clock:#e2e8f0;' +
        '--lv-close-border:rgba(255,255,255,.22);--lv-close-bg:rgba(255,255,255,.10);--lv-close-text:#ffffff;--lv-close-bg-hover:rgba(255,255,255,.2);' +
        '--lv-loading:#94a3b8;--lv-nav:rgba(255,255,255,.6);--lv-nav-hover:#fbbf24;' +
        '--lv-accent:#fbbf24;--lv-divrange:#8aa0bd;--lv-cell-border:#2b3a55;' +
        '--lv-th-bg:#16233e;--lv-th-text:#f8fafc;--lv-rowhead-text:#aab8cc;' +
        '--lv-cell-bg:#1c2a46;--lv-cell-bg-alt:#16223a;--lv-cell-text:#f1f5f9;' +
        '--lv-free-bg:#131f33;--lv-free-text:#42536c;' +
        '--lv-current-bg:#0e7490;--lv-current-ring:#22d3ee;--lv-current-glow:rgba(34,211,238,.35);--lv-current-text:#ffffff;' +
        '--lv-pinned-bg:#3a2206;--lv-pinned-text:#fcd34d;--lv-league-bg:#262150;--lv-league-text:#c4b5fd;' +
        '--lv-curcol-bg:#0e7490;--lv-curcol-text:#a5f3fc;--lv-curcol-underline:#fbbf24;--lv-dot-idle:rgba(255,255,255,.3);' +
        '--lv-banner-border:rgba(251,191,36,.35);--lv-uni-grade-bg:#0e1830;--lv-uni-grade-text:#fcd34d;--lv-uni-bunk-bg:#0b1326;--lv-uni-bunk-text:#cbd5e1;--lv-fit-on-text:#1f2937;' +
        'position:absolute;inset:0;z-index:100;background:var(--lv-bg);display:flex;flex-direction:column;overflow:hidden;font-family:"DM Sans",system-ui,sans-serif;}' +
    '.pc3-live-header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 30px;background:var(--lv-header-bg);border-bottom:1px solid var(--lv-header-border);flex-shrink:0;}' +
    '.pc3-live-headleft{display:flex;align-items:baseline;gap:14px;min-width:0;}' +
    '.pc3-live-title{font-family:"Fraunces",Georgia,serif;font-size:30px;font-weight:700;color:var(--lv-title);letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '.pc3-live-date{font-size:16px;font-weight:600;color:var(--lv-date);white-space:nowrap;}' +
    '.pc3-live-headright{display:flex;align-items:center;gap:18px;flex-shrink:0;}' +
    '.pc3-live-clock{font-size:34px;font-weight:300;color:var(--lv-clock);font-variant-numeric:tabular-nums;letter-spacing:.5px;}' +
    '.pc3-live-close{padding:8px 16px;border:1px solid var(--lv-close-border);border-radius:9px;background:var(--lv-close-bg);color:var(--lv-close-text);font-size:13px;font-weight:600;cursor:pointer;}' +
    '.pc3-live-close:hover{background:var(--lv-close-bg-hover);}' +
    '.pc3-live-divbanner{font-size:26px;font-weight:800;color:var(--lv-accent);letter-spacing:.5px;padding:2px 4px 10px;margin-bottom:4px;border-bottom:2px solid var(--lv-banner-border);}' +
    '.pc3-live-unified th.pc3-uni-grade{font-size:.85em;font-weight:800;text-align:center;background:var(--lv-uni-grade-bg);color:var(--lv-uni-grade-text);border-bottom:1px solid var(--lv-header-border);white-space:nowrap;padding:5px 4px;}' +
    '.pc3-live-unified th.pc3-uni-bunk{font-size:.72em;font-weight:700;text-align:center;background:var(--lv-uni-bunk-bg);color:var(--lv-uni-bunk-text);white-space:nowrap;padding:4px 3px;}' +
    '.pc3-live-unified th.row-head{white-space:nowrap;font-variant-numeric:tabular-nums;}' +
    '#pc3-cp-modal{position:fixed;inset:0;background:rgba(2,6,16,.72);z-index:100000;display:flex;align-items:center;justify-content:center;}' +
    '#pc3-cp-modal .pc3-cp-panel{background:#0b1326;border:1px solid #1e293b;border-radius:14px;width:min(560px,92vw);max-height:86vh;display:flex;flex-direction:column;color:#e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,.5);}' +
    '#pc3-cp-modal .pc3-cp-title{font-size:20px;font-weight:800;padding:18px 22px 4px;}' +
    '#pc3-cp-modal .pc3-cp-sub{font-size:13px;color:#94a3b8;padding:0 22px 12px;}' +
    '#pc3-cp-modal .pc3-cp-list{overflow:auto;padding:0 22px;flex:1;}' +
    '#pc3-cp-modal .pc3-cp-grade{font-size:13px;font-weight:800;color:#fcd34d;margin:14px 0 6px;letter-spacing:.3px;}' +
    '#pc3-cp-modal .pc3-cp-row{display:flex;align-items:center;gap:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05);}' +
    '#pc3-cp-modal .pc3-cp-bunk{flex:1;font-size:14px;}' +
    '#pc3-cp-modal .pc3-cp-input{width:90px;background:#0e1830;border:1px solid #334155;border-radius:7px;color:#fff;padding:6px 8px;font-size:14px;text-align:center;}' +
    '#pc3-cp-modal .pc3-cp-empty{padding:24px 22px;color:#94a3b8;}' +
    '#pc3-cp-modal .pc3-cp-foot{display:flex;align-items:center;gap:10px;padding:14px 22px;border-top:1px solid #1e293b;}' +
    '#pc3-cp-modal .pc3-cp-btn{padding:9px 18px;border:1px solid rgba(255,255,255,.22);border-radius:9px;background:rgba(255,255,255,.10);color:#fff;font-size:14px;font-weight:600;cursor:pointer;}' +
    '#pc3-cp-modal .pc3-cp-btn:hover{background:rgba(255,255,255,.2);}' +
    '#pc3-cp-modal .pc3-cp-apply{background:#fbbf24;border-color:#fbbf24;color:#1f2937;}' +
    '.pc3-live-fit{padding:8px 16px;border:1px solid var(--lv-close-border);border-radius:9px;background:var(--lv-close-bg);color:var(--lv-close-text);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s,color .15s;}' +
    '.pc3-live-fit:hover{background:var(--lv-close-bg-hover);}' +
    '.pc3-live-fit.on{background:var(--lv-accent);border-color:var(--lv-accent);color:var(--lv-fit-on-text);}' +
    '.pc3-live-loading{color:var(--lv-loading);padding:70px;text-align:center;font-size:22px;font-weight:600;}' +
    '.pc3-live-body{flex:1;overflow:hidden;position:relative;}' +
    '.pc3-live-page{position:absolute;inset:0;overflow:hidden;}' +
    '.pc3-live-page-inner{padding:18px 28px;}' +
    '.pc3-live-nav-btn{background:none;border:none;color:var(--lv-nav);font-size:26px;cursor:pointer;line-height:1;padding:0 4px;transition:color .15s;}' +
    '.pc3-live-nav-btn:hover{color:var(--lv-nav-hover);}' +
    '.pc3-live-section{margin-bottom:22px;}' +
    '.pc3-live-divhead{display:flex;align-items:baseline;gap:12px;margin-bottom:10px;padding-left:2px;}' +
    '.pc3-live-divname{font-family:"Fraunces",Georgia,serif;font-size:24px;font-weight:700;color:var(--lv-accent);letter-spacing:.2px;}' +
    '.pc3-live-divrange{font-size:14px;font-weight:600;color:var(--lv-divrange);font-variant-numeric:tabular-nums;}' +
    '.pc3-live-tbl{border-collapse:collapse;width:100%;table-layout:fixed;font-size:20px;}' +
    '.pc3-live-tbl th,.pc3-live-tbl td{border:1px solid var(--lv-cell-border);padding:7px 8px;text-align:center;vertical-align:middle;white-space:pre-line;word-break:break-word;font-size:1em;}' +
    '.pc3-live-tbl th{background:var(--lv-th-bg);color:var(--lv-th-text);font-weight:700;}' +
    '.pc3-live-tbl th.corner{width:155px;min-width:155px;max-width:155px;}' +
    '.pc3-live-tbl th.row-head{color:var(--lv-rowhead-text);font-weight:700;text-align:left;width:155px;min-width:155px;max-width:155px;white-space:pre-line;word-break:break-word;overflow:hidden;background:var(--lv-th-bg);font-variant-numeric:tabular-nums;}' +
    '.pc3-live-tbl th.lv-curcol{background:var(--lv-curcol-bg);color:var(--lv-curcol-text);box-shadow:inset 0 -3px 0 var(--lv-curcol-underline);}' +
    '.pc3-live-tbl td{color:var(--lv-cell-text);background:var(--lv-cell-bg);font-weight:700;}' +
    '.pc3-live-tbl tr:nth-child(even) td{background:var(--lv-cell-bg-alt);}' +
    '.pc3-live-tbl .cell-free{color:var(--lv-free-text) !important;font-style:normal;background:var(--lv-free-bg) !important;font-weight:400;}' +
    '.pc3-live-tbl .cell-current{background:var(--lv-current-bg) !important;box-shadow:inset 0 0 0 3px var(--lv-current-ring),0 0 18px var(--lv-current-glow);color:var(--lv-current-text) !important;font-weight:800 !important;}' +
    '.pc3-live-tbl .cell-past{opacity:.42;}' +
    '.pc3-live-tbl .cell-pinned{background:var(--lv-pinned-bg) !important;color:var(--lv-pinned-text) !important;font-weight:700;}' +
    '.pc3-live-tbl .cell-league{background:var(--lv-league-bg) !important;color:var(--lv-league-text) !important;font-weight:700;}' +
    /* Black-and-white override — applied only while capturing the live view for
       Print / Download so the output looks like an Excel printout (white cells,
       black borders, black text). The on-screen kiosk stays dark. */
    '.pc3-live-bw, .pc3-live-bw .pc3-live-page, .pc3-live-bw .pc3-live-page-inner, .pc3-live-bw .pc3-live-section{background:#fff !important;}' +
    '.pc3-live-bw .pc3-live-divname, .pc3-live-bw .pc3-live-divrange{color:#000 !important;}' +
    '.pc3-live-bw .pc3-live-tbl th, .pc3-live-bw .pc3-live-tbl td{background:#fff !important;color:#000 !important;border:1px solid #000 !important;font-weight:600 !important;box-shadow:none !important;opacity:1 !important;}' +
    '.pc3-live-bw .pc3-live-tbl tr:nth-child(even) td{background:#fff !important;}' +
    '.pc3-live-bw .pc3-live-unified th.pc3-uni-grade, .pc3-live-bw .pc3-live-unified th.pc3-uni-bunk{background:#fff !important;color:#000 !important;border:1px solid #000 !important;}' +

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
    /* Timeline parity: dim non-matching activity cards under the same filters */
    '.pc3-filter-leagues .pc3-tl-block:not(.cell-league){opacity:.12;}' +
    '.pc3-filter-specials .pc3-tl-block:not(.cell-pinned){opacity:.12;}' +
    '.pc3-filter-general .pc3-tl-block:not(.cell-general){opacity:.12;}' +
    '.pc3-filter-free .pc3-tl-block{opacity:.12;}' +
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

    // Fresh, minimal chrome — one top bar + one control rail + the preview canvas.
    // Reuses the proven sheet/table/live renderers and the .pc3-item list styling
    // from getStyles(); everything below is new and self-contained (pcx-* classes).
    var chrome = '<style id="pcx-styles">' +
        '#pc3-root.pc3{background:#f4f4f4;font-family:"DM Sans",system-ui,sans-serif;}' +
        /* TOP BAR — branded deep-teal */
        '.pcx-bar{display:flex;align-items:center;gap:16px;padding:16px 24px;background:linear-gradient(180deg,#147D91,#0F5F6E);flex-shrink:0;box-shadow:0 6px 20px -12px rgba(15,95,110,.65);}' +
        '.pcx-brand{flex:1;min-width:0;}' +
        '.pcx-title{font-family:"Fraunces",Georgia,serif;font-size:27px;font-weight:700;letter-spacing:-.01em;color:#fff;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.pcx-sub{font-size:12.5px;color:rgba(255,255,255,.8);margin-top:3px;font-weight:500;text-transform:capitalize;letter-spacing:.2px;}' +
        '.pcx-actions{display:flex;align-items:center;gap:9px;flex-shrink:0;}' +
        '.pcx-btn{display:inline-flex;align-items:center;gap:7px;height:42px;padding:0 18px;border:1px solid rgba(255,255,255,.3);border-radius:12px;background:rgba(255,255,255,.13);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:background .14s,border-color .14s,transform .04s;}' +
        '.pcx-btn:hover{background:rgba(255,255,255,.24);border-color:rgba(255,255,255,.5);}' +
        '.pcx-btn:active{transform:translateY(1px);}' +
        '.pcx-btn svg{width:16px;height:16px;}' +
        '.pcx-primary{background:#F59E0B;border-color:#F59E0B;color:#3a2606;box-shadow:0 3px 14px -3px rgba(245,158,11,.6);}' +
        '.pcx-primary:hover{background:#ea920a;border-color:#ea920a;color:#3a2606;}' +
        '#pc3-live-btn.live-on{background:#dc2626;border-color:#dc2626;color:#fff;}' +
        '#pc3-live-btn.live-on:hover{background:#be1c1c;}' +
        '#pc3-live-btn .pc3-live-dot{width:8px;height:8px;border-radius:50%;background:#fff;animation:pcx-pulse 1.6s infinite;}' +
        '@keyframes pcx-pulse{0%,100%{opacity:1}50%{opacity:.45}}' +
        '.pcx-iconbtn{width:42px;height:42px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.3);border-radius:12px;background:rgba(255,255,255,.13);color:#fff;cursor:pointer;}' +
        '.pcx-iconbtn:hover{background:rgba(255,255,255,.24);}' +
        '.pcx-menuwrap{position:relative;}' +
        '.pcx-menu{display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:222px;background:#fff;border:1px solid #e7e3da;border-radius:14px;box-shadow:0 18px 44px rgba(15,23,42,.2);padding:7px;z-index:120;}' +
        '.pcx-menu.open{display:block;}' +
        '.pcx-menu button{display:flex;align-items:center;gap:11px;width:100%;padding:11px 12px;border:none;background:transparent;border-radius:10px;font-family:inherit;font-size:13.5px;font-weight:500;color:#23252a;cursor:pointer;text-align:left;}' +
        '.pcx-menu button:hover{background:#f4f1ea;}' +
        '.pcx-menu button svg{width:17px;height:17px;color:#0F5F6E;}' +
        '.pcx-menu .pcx-menu-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#b3ab9c;padding:7px 11px 3px;}' +
        /* User Packs popover — a tailored pack per role/recipient.
           Each pack is a stacked card (icon+name, tagline, full-width control)
           so it stays readable at any width, including narrow/mobile. */
        '#pc3-userpacks-menu{width:300px;max-width:calc(100vw - 24px);max-height:min(560px,80vh);overflow-y:auto;}' +
        '.pcx-up-card{display:flex;flex-direction:column;gap:7px;width:100%;padding:11px 12px;border-radius:11px;border:1px solid transparent;box-sizing:border-box;}' +
        '.pcx-up-card + .pcx-up-card{margin-top:2px;}' +
        '.pcx-up-card:hover{background:#faf8f3;border-color:#ece6da;}' +
        '.pcx-up-head{display:flex;align-items:center;gap:10px;}' +
        '.pcx-up-icon{width:30px;height:30px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;background:#e3f3f6;color:#0F5F6E;border-radius:8px;}' +
        '.pcx-up-icon svg{width:17px;height:17px;}' +
        '.pcx-up-name{font-size:14px;font-weight:700;color:#23252a;line-height:1.25;}' +
        '.pcx-up-tag{font-size:11.5px;color:#8a8170;line-height:1.4;}' +
        '.pcx-up-go{width:100%;padding:9px 12px;border:1px solid #0F5F6E;background:#0F5F6E;color:#fff;border-radius:9px;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;text-align:center;}' +
        '.pcx-up-go:hover{background:#0c4e5a;}' +
        '.pcx-up-sel{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #d9d3c7;border-radius:9px;font-family:inherit;font-size:12.5px;font-weight:600;color:#23252a;background:#fff;cursor:pointer;}' +
        '.pcx-up-sel:focus{outline:none;border-color:#0F5F6E;box-shadow:0 0 0 3px rgba(20,125,145,.12);}' +
        '.pcx-body{flex:1;display:flex;min-height:0;overflow:hidden;}' +
        /* RAIL — warm cream */
        '.pcx-rail{width:290px;flex-shrink:0;background:#faf8f3;border-right:1px solid #e7e2d6;display:flex;flex-direction:column;overflow-y:auto;}' +
        '.pcx-section{padding:17px 18px;border-bottom:1px solid #efe9dd;}' +
        '.pcx-grow{flex:1 0 auto;min-height:0;display:flex;flex-direction:column;}' +
        '.pcx-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#a79f8e;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;}' +
        '.pcx-count{font-size:10px;font-weight:700;color:#0F5F6E;background:#dff1f4;padding:2px 9px;border-radius:99px;text-transform:none;letter-spacing:0;}' +
        '.pcx-seg{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
        '.pcx-seg button{height:46px;border:1px solid #e2dccf;border-radius:13px;background:#fff;font-family:inherit;font-size:13.5px;font-weight:600;color:#5b5446;cursor:pointer;transition:all .14s;}' +
        '.pcx-seg button:hover{border-color:#147D91;color:#0F5F6E;}' +
        '.pcx-seg button.active{background:#147D91;border-color:#147D91;color:#fff;box-shadow:0 4px 12px -4px rgba(20,125,145,.65);}' +
        '.pcx-search{width:100%;height:38px;padding:0 13px;border:1px solid #e2dccf;border-radius:12px;font-size:13px;font-family:inherit;background:#fff;color:#23252a;margin-bottom:9px;}' +
        '.pcx-search:focus{outline:none;border-color:#147D91;box-shadow:0 0 0 3px rgba(20,125,145,.14);}' +
        '.pcx-search::placeholder{color:#b3ab9c;}' +
        '.pcx-list{flex:1;min-height:260px;overflow-y:auto;margin:0 -6px;padding:0 6px;}' +
        '.pcx-rowbtns{display:flex;gap:8px;margin-top:11px;}' +
        '.pcx-rowbtns button{flex:1;height:36px;border:1px solid #e2dccf;border-radius:11px;background:#fff;font-family:inherit;font-size:12px;font-weight:600;color:#5b5446;cursor:pointer;}' +
        '.pcx-rowbtns button:hover{border-color:#147D91;color:#0F5F6E;}' +
        '.pcx-opt{display:flex;align-items:center;gap:11px;padding:8px 2px;font-size:13.5px;color:#3a382f;cursor:pointer;font-weight:500;}' +
        '.pcx-opt input{width:17px;height:17px;accent-color:#147D91;cursor:pointer;}' +
        '.pcx-paper{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px;}' +
        '.pcx-paper select{width:100%;height:36px;padding:0 9px;border:1px solid #e2dccf;border-radius:11px;font-size:12.5px;font-family:inherit;background:#fff;color:#23252a;cursor:pointer;}' +
        /* CANVAS — warm stone; paper sheets float */
        '.pcx-canvas{flex:1;overflow:auto;background:#e8e8e8;padding:24px 24px 90px;position:relative;min-height:0;}' +
        '.pcx-empty{display:flex;align-items:center;justify-content:center;height:100%;text-align:center;color:#9a917f;}' +
        /* sidebar items — more breathing room for the cream rail */
        '#pc3-sidebar .pc3-sidebar-scroll{padding:0 10px 14px;}' +
        '#pc3-sidebar .pc3-sidebar-group{margin-bottom:10px;}' +
        '#pc3-sidebar .pc3-sidebar-group-head{padding:8px 6px 4px;font-size:10.5px;}' +
        '#pc3-sidebar .pc3-item{padding:11px 14px;border-radius:10px;color:#3a382f;font-size:13.5px;gap:12px;margin-bottom:4px;}' +
        '#pc3-sidebar .pc3-item:hover{background:#f1ece1;}' +
        '#pc3-sidebar .pc3-item.selected{background:#dff1f4;border-color:rgba(20,125,145,.25);}' +
        '#pc3-sidebar .pc3-item input[type="checkbox"]{width:16px;height:16px;}' +
        '#pc3-sidebar .pc3-item-label{font-size:13.5px;font-weight:600;}' +
        '#pc3-sidebar .pc3-item-count{font-size:11px;background:rgba(0,0,0,.06);color:#6b6254;padding:2px 7px;border-radius:20px;font-weight:700;}' +
        '#pc3-sidebar .pc3-item.selected .pc3-item-count{background:rgba(20,125,145,.12);color:#0f6678;}' +
        /* ── Focus mode: hide all chrome, just the grid ── */
        '.pc3-focus-exit{display:none;position:fixed;top:16px;right:16px;z-index:60;align-items:center;gap:7px;padding:8px 14px;border:1px solid #000;border-radius:0;background:#000;color:#fff;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);}' +
        '.pc3-focus-exit:hover{background:#222;}' +
        '.pc3.pc3-focus .pcx-bar,.pc3.pc3-focus .pcx-rail,.pc3.pc3-focus .pc3-zoom-dock,.pc3.pc3-focus .pc3-sidebar-toggle{display:none!important;}' +
        '.pc3.pc3-focus .pcx-canvas{padding:0;background:#fff;}' +
        '.pc3.pc3-focus .pc3-focus-exit{display:inline-flex;}' +
        /* Live screen theme chips */
        '.pcx-live-theme-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
        '.pcx-live-theme-btn{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #e2dccf;border-radius:11px;background:#fff;cursor:pointer;font-family:inherit;text-align:left;transition:all .14s;}' +
        '.pcx-live-theme-btn:hover{border-color:#147D91;}' +
        '.pcx-live-theme-btn.active{border-color:#147D91;background:#dff1f4;box-shadow:0 0 0 1px #147D91;}' +
        '.pcx-live-sw{display:flex;height:22px;border-radius:6px;overflow:hidden;border:1px solid #e7e5e4;}' +
        '.pcx-live-sw span{flex:1;height:100%;}' +
        '.pcx-live-theme-nm{font-size:12px;font-weight:600;color:#3a382f;}' +
    '</style>';

    return getStyles() + chrome +
    '<div class="pc3" id="pc3-root">' +

    /* -- Top bar: brand on the left, the actions on the right -- */
    '<div class="pcx-bar no-print">' +
        '<div class="pcx-brand">' +
            '<div class="pcx-title">' + escHtml(t.campName || 'Camp Schedule') + '</div>' +
            '<div class="pcx-sub">' + (dateLabel ? escHtml(dateLabel) + ' · ' : '') + mode + ' builder</div>' +
        '</div>' +
        '<div class="pcx-actions">' +
            '<button class="pcx-btn' + (liveOpen ? ' live-on' : '') + '" id="pc3-live-btn" title="Open Live View on a screen">' +
                (liveOpen ? '<span class="pc3-live-dot"></span>Live · On' : ICO.monitor + ' Live View') +
            '</button>' +
            '<div class="pcx-menuwrap">' +
                '<button class="pcx-btn" id="pc3-userpacks-btn">' + ICO.user + ' Packs <span style="opacity:.6;font-size:9px;">▼</span></button>' +
                '<div class="pcx-menu" id="pc3-userpacks-menu">' + buildUserPacksMenu() + '</div>' +
            '</div>' +
            '<div class="pcx-menuwrap">' +
                '<button class="pcx-btn" id="pc3-output-btn">' + ICO.download + ' Download <span style="opacity:.6;font-size:9px;">▼</span></button>' +
                '<div class="pcx-menu" id="pc3-output-menu">' +
                    '<div class="pcx-menu-label">Download</div>' +
                    '<button onclick="window._pc3ExportExcel();this.closest(\'.pcx-menu\').classList.remove(\'open\');">' + ICO.excel + 'Excel (.xlsx)</button>' +
                    '<div class="pcx-menu-label">Print</div>' +
                    '<button onclick="window.printAllDivisions();this.closest(\'.pcx-menu\').classList.remove(\'open\');">' + ICO.grid + 'Print every division</button>' +
                '</div>' +
            '</div>' +
            '<button class="pcx-btn pcx-primary" onclick="window._pc3Print()">' + ICO.print + ' Print</button>' +
            '<button class="pcx-iconbtn" onclick="window._pc3ToggleFocus()" title="Focus mode — just the schedule">' + ICO.expand + '</button>' +
        '</div>' +
    '</div>' +

    /* -- Body: control rail + preview canvas -- */
    '<div class="pcx-body">' +
        '<aside class="pcx-rail no-print" id="pc3-sidebar">' +
            /* View */
            '<div class="pcx-section">' +
                '<div class="pcx-label">View</div>' +
                '<div class="pcx-seg">' +
                    '<button data-view="division"' + (_activeView === 'division' ? ' class="active"' : '') + '>Divisions</button>' +
                    '<button data-view="bunk"' + (_activeView === 'bunk' ? ' class="active"' : '') + '>Bunks</button>' +
                    '<button data-view="location"' + (_activeView === 'location' ? ' class="active"' : '') + '>Facilities</button>' +
                    '<button data-view="week"' + (_activeView === 'week' ? ' class="active"' : '') + '>Week</button>' +
                '</div>' +
            '</div>' +
            /* Items to include */
            '<div class="pcx-section pcx-grow">' +
                '<div class="pcx-label"><span id="pc3-sidebar-title">Divisions</span><span class="pcx-count" id="pc3-sidebar-count">0 selected</span></div>' +
                '<input type="text" id="pc3-sidebar-search" class="pcx-search" placeholder="Search...">' +
                '<div class="pcx-list" id="pc3-sidebar-scroll"></div>' +
                '<div class="pcx-rowbtns"><button onclick="window._pc3SelectAll()">Select all</button><button onclick="window._pc3SelectNone()">Clear</button></div>' +
            '</div>' +
            /* Options */
            '<div class="pcx-section">' +
                '<div class="pcx-label">Options</div>' +
                '<label class="pcx-opt"><input type="checkbox" id="pc3-show-date"' + (t.showDate !== false ? ' checked' : '') + '>Show date</label>' +
                '<label class="pcx-opt"><input type="checkbox" id="pc3-combined"' + (t.layoutMode === 'all-bunks' ? ' checked' : '') + '>Combine all bunks</label>' +
                '<label class="pcx-opt"><input type="checkbox" id="pc3-hide-matchups"' + (t.hideLeagueMatchups ? ' checked' : '') + '>Hide league matchups</label>' +
                '<div class="pcx-paper" style="margin-top:8px;">' +
                    '<label class="pcx-label" style="margin:0 0 4px;display:block;">Time increment</label>' +
                    '<select id="pc3-time-increment">' +
                        [10, 15, 20, 25, 30, 40, 45, 60].map(function (n) {
                            return '<option value="' + n + '"' + (_timeIncrement === n ? ' selected' : '') + '>' + n + ' min</option>';
                        }).join('') +
                    '</select>' +
                '</div>' +
                '<div class="pcx-paper">' +
                    '<select id="pc3-orientation"><option value="landscape"' + (t.orientation === 'landscape' ? ' selected' : '') + '>Landscape</option><option value="portrait"' + (t.orientation === 'portrait' ? ' selected' : '') + '>Portrait</option></select>' +
                    '<select id="pc3-paper-size"><option value="letter"' + (t.paperSize === 'letter' ? ' selected' : '') + '>Letter</option><option value="a4"' + (t.paperSize === 'a4' ? ' selected' : '') + '>A4</option><option value="legal"' + (t.paperSize === 'legal' ? ' selected' : '') + '>Legal</option></select>' +
                '</div>' +
            '</div>' +
            /* Live screen theme — the kiosk/TV display palette */
            '<div class="pcx-section">' +
                '<div class="pcx-label">Live screen theme</div>' +
                '<div style="font-size:11px;color:#9a917f;margin:-6px 0 10px;line-height:1.4;">Colors for the fullscreen Live View on a TV or projector.</div>' +
                '<div class="pcx-live-theme-grid" id="pc3-live-theme-grid">' +
                    LIVE_THEMES.map(function (th) {
                        var active = _pcGetLiveThemeId() === th.id;
                        return '<button type="button" class="pcx-live-theme-btn' + (active ? ' active' : '') + '" data-live-theme="' + th.id + '" title="' + escHtml(th.description) + '">' +
                            '<span class="pcx-live-sw">' + th.swatch.map(function (c) { return '<span style="background:' + c + ';"></span>'; }).join('') + '</span>' +
                            '<span class="pcx-live-theme-nm">' + escHtml(th.name) + '</span>' +
                        '</button>';
                    }).join('') +
                '</div>' +
            '</div>' +
        '</aside>' +

        /* Preview canvas */
        '<main class="pcx-canvas" id="pc3-grid-area">' +
            '<div id="pc3-preview-empty" class="pcx-empty">' +
                '<div style="max-width:340px;">' +
                    '<div style="font-size:30px;margin-bottom:12px;opacity:.3;">' + ICO.grid + '</div>' +
                    '<div style="font-size:16px;font-weight:700;color:#3a3a34;margin-bottom:5px;">Pick what to print</div>' +
                    '<div style="font-size:13px;line-height:1.5;">Choose a view and check the items on the left. Your printout previews here.</div>' +
                '</div>' +
            '</div>' +
            '<div id="pc3-preview-content" style="display:none;"></div>' +
            '<div class="pc3-zoom-dock no-print" id="pc3-zoom-dock">' +
                '<button onclick="window._pc3Zoom(-10)" title="Zoom out"><span class="pc3-zoom-glyph">−</span></button>' +
                '<span class="pc3-zoom-dock-label" id="pc3-zoom-dock-label" onclick="window._pc3ZoomReset && window._pc3ZoomReset()" title="Reset to 100%">' + _zoomLevel + '%</span>' +
                '<button onclick="window._pc3Zoom(10)" title="Zoom in"><span class="pc3-zoom-glyph">+</span></button>' +
            '</div>' +
        '</main>' +
    '</div>' +

    /* Exit-focus pill — only visible while in focus mode */
    '<button class="pc3-focus-exit no-print" id="pc3-focus-exit" onclick="window._pc3ToggleFocus()" title="Exit focus (Esc)">' + ICO.expand + ' Exit focus</button>' +

    /* Hidden legacy controls (zoom + template state) */
    '<select id="pc3-template-select" style="display:none;"><option value="default">Default Template</option></select>' +
    '<input type="range" min="50" max="200" value="' + _zoomLevel + '" id="pc3-zoom-range" style="display:none;">' +
    '<span id="pc3-zoom-label" style="display:none;">' + _zoomLevel + '%</span>' +
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
    // Only let the transpose control drive orientation when it actually exists
    // in the DOM — otherwise keep the template/default (it would otherwise force
    // 'bunks-top' every refresh and override the time-top default).
    var _transposeEl = el('pc3-transpose');
    if (_transposeEl) t.tableOrientation = _transposeEl.checked ? 'time-top' : 'bunks-top';
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
        // Shared-timeline pack → one vertical time axis with bunks as columns
        // (mirrors the Live "Shared timeline" view). Otherwise the default
        // horizontal per-bunk timeline (each bunk a row).
        if (t.sharedTimeline) {
            html += renderSharedTimelineTable([{ divName: divName, bunks: bunks }]);
        } else {
            // Each bunk may have different time slots, so we build a unified time axis
            html += renderAutoDivisionTable(divName, bunks);
        }
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

// Returns absolutely-positioned vertical tick lines at each _timeIncrement boundary that
// falls inside an activity cell. The parent div must have position:relative.
//
// Bricks-in-a-mold: each bunk's activities are different "bricks", but they all sit in
// the SAME time mold. Columns are uniform PIXEL width (not time-proportional), so a line
// must be positioned in column-space, not raw-time-space — that way the same clock minute
// lands at the same x for every bunk, and the sub-period lines stack into one mold.
function pcInnerDividers(timeCols, colIdx, span) {
    var inc = _timeIncrement;
    if (!inc || span < 1) return '';
    var startMin = timeCols[colIdx].startMin;
    var endMin = timeCols[colIdx + span - 1].endMin;
    if (endMin - startMin <= inc) return '';
    var first = (Math.floor(startMin / inc) + 1) * inc;
    if (first >= endMin) return '';
    var lines = '';
    for (var m = first; m < endMin; m += inc) {
        // Locate the sub-column (within this cell's span) that contains minute m,
        // then express m as a fraction of the uniform column width.
        var jLocal = -1, frac = 0;
        for (var k = 0; k < span; k++) {
            var c = timeCols[colIdx + k];
            if (m >= c.startMin && m < c.endMin) {
                jLocal = k;
                frac = (m - c.startMin) / (c.endMin - c.startMin);
                break;
            }
            if (m === c.startMin) { jLocal = k; frac = 0; break; }
        }
        if (jLocal < 0) continue;
        var pct = ((jLocal + frac) / span * 100).toFixed(2);
        lines += '<div style="position:absolute;top:0;bottom:0;left:' + pct + '%;width:1px;background:rgba(198,198,198,0.9);pointer-events:none;"></div>';
    }
    return lines;
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

    // ─── 3. Time-proportional TIMELINE layout (brick model) ─────
    // Each bunk row is an independent track. Activities are cards sized to
    // their true duration on a SHARED time axis, so equal durations read as
    // equal widths and every row keeps its own break pattern (bricks in one
    // mold). Free time is left as a blank gap between cards.
    var totalMin = Math.max(1, dayEnd - dayStart);
    function pctL(min) { return ((min - dayStart) / totalMin) * 100; }
    function pctW(min) { return (min / totalMin) * 100; }
    // Subtle left-edge accent per activity type — keeps cards clean white while
    // letting a head counselor scan swim vs sports vs league at a glance.
    var TL_ACCENT = {
        swim: '#0ea5e9', sport: '#16a34a', sports: '#16a34a', league: '#8b5cf6',
        specialty_league: '#8b5cf6', special: '#f59e0b', pinned: '#f59e0b',
        elective: '#6366f1', swim_elective: '#06b6d4', activity: '#0d9488',
        transition: '#cbd5e1', free: '#e2e8f0'
    };

    var sheetId = pcNextSheetId();
    var minW = Math.max(720, Math.round(totalMin * 4));
    var html = '<div class="pc3-sheet-table-wrap" style="overflow:auto;position:relative;">';
    html += '<div class="pc3-tl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="auto-timeline" data-day-start="' + dayStart + '" data-day-end="' + dayEnd + '" style="min-width:' + minW + 'px;">';

    var gridStart = Math.ceil(dayStart / inc) * inc;

    // ── Period band (only when a REAL Bell Schedule defines numbered periods) ──
    if (hasRealPeriods) {
        html += '<div class="pc3-tl-row pc3-tl-periodrow">';
        html += '<div class="pc3-tl-corner"></div>';
        html += '<div class="pc3-tl-track">';
        activityRanges.forEach(function (r, ri) {
            var pname = r.name || ('Period ' + (ri + 1));
            html += '<div class="pc3-tl-period" style="left:' + pctL(r.startMin).toFixed(2) + '%;width:calc(' + pctW(r.endMin - r.startMin).toFixed(2) + '% - 2px);">' + escHtml(pname) + '</div>';
        });
        html += '</div></div>';
    }

    // ── Header row: corner + time ruler ──
    html += '<div class="pc3-tl-row pc3-tl-headrow">';
    html += '<div class="pc3-tl-corner">Bunk</div>';
    html += '<div class="pc3-tl-track pc3-tl-ruler">';
    // Clean ruler: one label roughly every 30 min (or per increment if coarser),
    // hour marks emphasized. Avoids a label at every fine sub-period.
    var labelStep = inc >= 30 ? inc : 30;
    for (var tm = gridStart; tm <= dayEnd; tm += labelStep) {
        var isMajor = tm % 60 === 0;
        html += '<div class="pc3-tl-tick' + (isMajor ? ' major' : '') + '" style="left:' + pctL(tm).toFixed(2) + '%;"><span>' + escHtml(minutesToTimeLabel(tm)) + '</span></div>';
    }
    html += '</div></div>';

    // ── Bunk rows ──
    bunks.forEach(function (bunk, bunkIdx) {
        html += '<div class="pc3-tl-row pc3-tl-bodyrow' + (bunkIdx % 2 ? ' pc3-tl-alt' : '') + '">';
        html += '<div class="pc3-tl-bunk">' + escHtml(bunk) + '</div>';
        html += '<div class="pc3-tl-track">';

        // Faint hour guides only — keeps the track clean (no dense sub-period grid)
        for (var gm = Math.ceil(dayStart / 60) * 60; gm < dayEnd; gm += 60) {
            html += '<div class="pc3-tl-vline" style="left:' + pctL(gm).toFixed(2) + '%;"></div>';
        }

        (bunkActs[bunk] || []).forEach(function (a) {
            if (a.type === 'free' || !a.entry) return; // blank gap
            var dur = a.endMin - a.startMin;
            if (dur < 1) return;

            var actText = a.entry._displayName || pcCanonicalActivityName(a.entry._activity || a.entry.sport || '');
            var locText = pcResolveLocation(a.entry);
            if (actText && locText && actText.toLowerCase() === locText.toLowerCase()) locText = '';
            if (!actText && locText) { actText = locText; locText = ''; }
            // Display-name alias = exact label: drop the location sub-line.
            if (a.entry._displayName) locText = '';
            var nameTxt = actText || '—';

            var sharers = '';
            if (a.slotIdx != null && !_hideLocations) {
                var sh = pcFindFieldSharers(bunk, a.slotIdx, divName);
                if (sh.length) sharers = ' – vs ' + sh.map(function (b) { return /^\d/.test(String(b)) ? 'Bunk ' + b : b; }).join(', ');
            }
            var subTxt = (!_hideLocations && locText) ? locText : '';

            // League game: show "Football - Bunk 1 vs 2" with the field on the
            // sub-line, instead of the generic "League Game" activity name.
            if (a.type === 'league') {
                var lg = pcLeagueLabel(a.entry, bunk, divName, a.startMin);
                nameTxt = [lg.sport, lg.matchup].filter(Boolean).join(' - ') || (a.entry._gameLabel || 'League Game');
                subTxt = (!_hideLocations && lg.field) ? lg.field : '';
                sharers = '';
            }

            var exportTxt = nameTxt + (subTxt ? ' – ' + subTxt : '') + sharers;

            var splitPre = a.entry._splitPreChange || 0;
            var splitPost = a.entry._splitPostChange || 0;

            var accent = TL_ACCENT[a.type] || '#cbd5e1';
            html += '<div class="pc3-tl-block cell-' + a.type + '" style="left:' + pctL(a.startMin).toFixed(2) + '%;width:calc(' + pctW(dur).toFixed(2) + '% - 4px);border-left-color:' + accent + ';" title="' + escHtml(exportTxt + ' (' + dur + ' min)') + '" data-bunk="' + escHtml(bunk) + '" data-slot="' + a.slotIdx + '" data-div="' + escHtml(divName) + '" data-cell-text="' + escHtml(exportTxt) + '">';
            if (splitPre > 0) html += '<div class="pc3-tl-chg" style="width:' + (splitPre / dur * 100).toFixed(2) + '%;">Chg</div>';
            html += '<div class="pc3-tl-block-in">';
            // Location lives on the sub-line; attach the "vs Bunk X" sharers there so
            // it reads "Court 1 – vs Bunk 2". With no location, sharers ride the name.
            html += '<span class="pc3-tl-name">' + escHtml(subTxt ? nameTxt : (nameTxt + sharers)) + '</span>';
            if (subTxt) html += '<span class="pc3-tl-sub">' + escHtml(subTxt + sharers) + '</span>';
            if (dur > inc) html += '<span class="pc3-tl-dur pc3-dur">' + dur + 'm</span>';
            html += '</div>';
            if (splitPost > 0) html += '<div class="pc3-tl-chg" style="width:' + (splitPost / dur * 100).toFixed(2) + '%;">Chg</div>';
            html += '</div>';
        });

        html += '</div></div>';
    });

    html += '</div></div>';
    return html;
}

// Group a list of selected division/grade names by parent division, mirroring
// the Live "Shared timeline" grouping (buildSectionHtmlsForGroups). Returns an
// ordered array of { label, grades:[{divName,bunks}] } — one entry per parent
// division (grades with no parent stand alone). Order follows the input order.
function packDivisionGroups(sel) {
    var divs = getDivisions();
    var order = [], byk = {};
    sel.forEach(function (gradeName) {
        var bunks = (divs[gradeName] && divs[gradeName].bunks ? divs[gradeName].bunks : []).slice();
        if (!bunks.length) return;
        var rp = (typeof window.getParentDivision === 'function' && window.getParentDivision(gradeName)) || null;
        var key = rp || (' grade:' + gradeName);
        if (!byk[key]) { byk[key] = { label: rp || gradeName, grades: [] }; order.push(key); }
        byk[key].grades.push({ divName: gradeName, bunks: bunks });
    });
    return order.map(function (k) { return byk[k]; });
}

// ── Shared timeline table (one vertical time axis, bunks across the top) ──
// Print analogue of the Live "Shared timeline" view. Accepts one or more grades
// (grouped under a parent division) and renders ONE table: a unified time axis
// down the left, every bunk as a column (grouped by grade in a two-row header
// when more than one grade is present), with identical adjacent tiles merged
// (same activity across bunks AND across time → one cell). Works for auto and
// manual modes; styled with the light .pc3-tbl / cell-* print classes.
function renderSharedTimelineTable(grades) {
    var t = _currentTemplate;
    var auto = isAutoMode();

    var cols = [];
    grades.forEach(function (g) {
        (g.bunks || []).forEach(function (b) { cols.push({ bunk: b, grade: g.divName, segs: [] }); });
    });
    if (!cols.length) return '';

    // Per-bunk segments + collect every time boundary.
    var boundSet = {};
    cols.forEach(function (c) {
        var segs = [];
        if (auto) {
            var slots = getPerBunkSchedule(c.bunk, c.grade);
            for (var i = 0; i < slots.length; i++) {
                var entry = getEntry(c.bunk, i);
                if (entry && entry.continuation && segs.length > 0) { segs[segs.length - 1].endMin = slots[i].endMin; continue; }
                segs.push({ startMin: slots[i].startMin, endMin: slots[i].endMin, entry: entry, slotIdx: i, type: entry ? getEntryType(entry) : 'free' });
            }
        } else {
            var blocks = buildDivisionBlocks(c.grade);
            blocks.forEach(function (bl) {
                var si = findFirstSlotForTime(bl.startMin, c.grade);
                var entry = si >= 0 ? getEntry(c.bunk, si) : null;
                segs.push({ startMin: bl.startMin, endMin: bl.endMin, entry: entry, slotIdx: si, type: entry ? getEntryType(entry) : 'free', isLeague: bl.isLeague, event: bl.event });
            });
        }
        c.segs = segs;
        segs.forEach(function (s) { boundSet[s.startMin] = 1; boundSet[s.endMin] = 1; });
    });

    var bounds = Object.keys(boundSet).map(Number).sort(function (a, b) { return a - b; });
    if (bounds.length < 2) return '';
    var rows = [];
    for (var bi = 0; bi < bounds.length - 1; bi++) rows.push({ startMin: bounds[bi], endMin: bounds[bi + 1] });

    // Map each column (bunk) to the segment covering each row (null = gap).
    cols.forEach(function (c) {
        c.rowSeg = rows.map(function (r) {
            var found = null;
            c.segs.forEach(function (s) { if (s.startMin <= r.startMin && s.endMin >= r.endMin) found = s; });
            return found;
        });
    });

    function cellInfo(c, seg, r) {
        var txt, cls;
        if (!seg) {
            var lg0 = pcLeagueInfoAt(c.grade, r.startMin);
            if (lg0) { txt = lg0.label + (lg0.matchups.length && !t.hideLeagueMatchups ? ' │ ' + lg0.matchups.join(', ') : ''); cls = 'cell-league'; }
            else { txt = '—'; cls = 'cell-free'; }
        } else if (!auto && seg.isLeague) {
            txt = seg.event || 'League Game';
            if (!t.hideLeagueMatchups) { var mm = buildLeagueMatchups(seg, c.grade); if (mm.length) txt += ' │ ' + mm.join(', '); }
            cls = 'cell-league';
        } else {
            var isLeagueAct = !!(seg.entry && (seg.entry._h2h || seg.entry._league || seg.entry._isSpecialtyLeague || seg.entry._allMatchups));
            var leagueInfo = (isLeagueAct || !seg.entry) ? pcLeagueInfoAt(c.grade, seg.startMin) : null;
            if (isLeagueAct || leagueInfo) {
                var lbl = (seg.entry && (seg.entry._gameLabel || seg.entry._leagueName)) || (leagueInfo && leagueInfo.label) || 'League Game';
                var ms = (leagueInfo && leagueInfo.matchups) || [];
                txt = lbl + (ms.length && !t.hideLeagueMatchups ? ' │ ' + ms.join(', ') : '');
                cls = 'cell-league';
            } else {
                txt = seg.entry ? formatEntry(seg.entry) : '—';
                cls = 'cell-' + seg.type;
            }
        }
        return { txt: txt, cls: cls };
    }

    var sheetId = pcNextSheetId();
    var gradeCols = grades.filter(function (g) { return g.bunks && g.bunks.length; });
    var multiGrade = gradeCols.length > 1;
    // Orientation: 'time-top' → time across the top (columns), bunks down the
    // side (rows). 'bunks-top' → bunks across the top, time down the side.
    var timeTop = (t.tableOrientation === 'time-top');

    // Build a descriptor grid [timeRow][bunkCol], then merge identical neighbors.
    var nR = rows.length, nC = cols.length;
    var grid = [];
    for (var gr = 0; gr < nR; gr++) {
        grid[gr] = [];
        for (var gc = 0; gc < nC; gc++) {
            var seg = cols[gc].rowSeg[gr];
            var info = cellInfo(cols[gc], seg, rows[gr]);
            var s = seg ? seg.startMin : rows[gr].startMin;
            var e = seg ? seg.endMin : rows[gr].endMin;
            grid[gr][gc] = { text: info.txt, cls: info.cls, key: info.txt + '|' + info.cls + '|' + s + '|' + e };
        }
    }
    // Drop time rows where EVERY bunk is empty (a gap between periods where
    // nothing is happening) — no point wasting a full row on blank space.
    (function () {
        var keep = [];
        for (var ri = 0; ri < nR; ri++) {
            var allFree = true;
            for (var ci = 0; ci < nC; ci++) { if (grid[ri][ci].cls !== 'cell-free') { allFree = false; break; } }
            if (!allFree) keep.push(ri);
        }
        if (keep.length !== nR) {
            rows = keep.map(function (i) { return rows[i]; });
            grid = keep.map(function (i) { return grid[i]; });
            nR = rows.length;
        }
    })();
    if (!nR) return '';
    var done = {};
    var kk = function (a, b) { return a + ':' + b; };

    var html = '<div class="pc3-sheet-table-wrap" style="overflow:auto;position:relative;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="shared-timeline" data-orient="' + (timeTop ? 'time-top' : 'bunks-top') + '" data-day-start="' + bounds[0] + '" data-day-end="' + bounds[bounds.length - 1] + '">';

    if (!timeTop) {
        // ── Bunks across the top, time down the side ──
        html += '<thead>';
        if (multiGrade) {
            html += '<tr><th class="corner" rowspan="2" style="min-width:' + t.timeColWidth + 'px;">Time</th>';
            gradeCols.forEach(function (g) { html += '<th colspan="' + g.bunks.length + '">' + escHtml(g.divName) + '</th>'; });
            html += '</tr><tr>';
            cols.forEach(function (c) { html += '<th>' + escHtml(c.bunk) + '</th>'; });
            html += '</tr>';
        } else {
            html += '<tr><th class="corner" style="min-width:' + t.timeColWidth + 'px;">Time</th>';
            cols.forEach(function (c) { html += '<th>' + escHtml(c.bunk) + '</th>'; });
            html += '</tr>';
        }
        html += '</thead><tbody>';
        rows.forEach(function (r, ri) {
            html += '<tr data-block-start="' + r.startMin + '" data-block-end="' + r.endMin + '">';
            html += '<th class="row-head">' + escHtml(minutesToTimeLabel(r.startMin)) + '</th>';
            for (var ci = 0; ci < nC; ci++) {
                if (done[kk(ri, ci)]) continue;
                var cell = grid[ri][ci];
                var colspan = 1;
                while (ci + colspan < nC && !done[kk(ri, ci + colspan)] && grid[ri][ci + colspan].key === cell.key) colspan++;
                var rowspan = 1;
                extend: while (ri + rowspan < nR) {
                    for (var cc = ci; cc < ci + colspan; cc++) {
                        if (done[kk(ri + rowspan, cc)] || grid[ri + rowspan][cc].key !== cell.key) break extend;
                    }
                    rowspan++;
                }
                for (var rr = ri; rr < ri + rowspan; rr++) for (var c2 = ci; c2 < ci + colspan; c2++) done[kk(rr, c2)] = 1;
                html += '<td class="' + cell.cls + '"' + (colspan > 1 ? ' colspan="' + colspan + '"' : '') + (rowspan > 1 ? ' rowspan="' + rowspan + '"' : '') +
                    ' data-cell-text="' + escHtml(cell.text) + '" style="text-align:center;">' + escHtml(cell.text) + '</td>';
            }
            html += '</tr>';
        });
        html += '</tbody>';
    } else {
        // ── Time across the top, bunks down the side (transposed) ──
        // Merge across time = colspan; merge across bunks = rowspan.
        html += '<thead><tr>';
        html += '<th class="corner"' + (multiGrade ? ' colspan="2"' : '') + ' style="min-width:' + t.timeColWidth + 'px;">Bunk</th>';
        rows.forEach(function (r) { html += '<th class="row-head">' + escHtml(minutesToTimeLabel(r.startMin)) + '</th>'; });
        html += '</tr></thead><tbody>';
        cols.forEach(function (c, bi) {
            html += '<tr>';
            // Grade label column (once per grade, spanning its bunks).
            if (multiGrade && (bi === 0 || cols[bi - 1].grade !== c.grade)) {
                var gspan = 0;
                for (var gi = bi; gi < nC && cols[gi].grade === c.grade; gi++) gspan++;
                html += '<th class="pc3-uni-grade"' + (gspan > 1 ? ' rowspan="' + gspan + '"' : '') + '>' + escHtml(c.grade) + '</th>';
            }
            html += '<th>' + escHtml(c.bunk) + '</th>';
            for (var ti = 0; ti < nR; ti++) {
                if (done[kk(bi, ti)]) continue;
                var cellT = grid[ti][bi];
                var colspanT = 1;
                while (ti + colspanT < nR && !done[kk(bi, ti + colspanT)] && grid[ti + colspanT][bi].key === cellT.key) colspanT++;
                var rowspanT = 1;
                extendT: while (bi + rowspanT < nC) {
                    for (var tt = ti; tt < ti + colspanT; tt++) {
                        if (done[kk(bi + rowspanT, tt)] || grid[tt][bi + rowspanT].key !== cellT.key) break extendT;
                    }
                    rowspanT++;
                }
                for (var rr2 = bi; rr2 < bi + rowspanT; rr2++) for (var c3 = ti; c3 < ti + colspanT; c3++) done[kk(rr2, c3)] = 1;
                html += '<td class="' + cellT.cls + '"' + (colspanT > 1 ? ' colspan="' + colspanT + '"' : '') + (rowspanT > 1 ? ' rowspan="' + rowspanT + '"' : '') +
                    ' data-cell-text="' + escHtml(cellT.text) + '" style="text-align:center;">' + escHtml(cellT.text) + '</td>';
            }
            html += '</tr>';
        });
        html += '</tbody>';
    }
    html += '</table></div>';
    return html;
}

// Wrap renderSharedTimelineTable in a titled print sheet (parent label header),
// matching renderDivisionSheet's structure so the preview groups read cleanly.
function renderSharedTimelineSheet(parentLabel, grades) {
    var t = _currentTemplate;
    var table = renderSharedTimelineTable(grades);
    if (!table) return '';
    var html = '<div class="pc3-sheet">';
    if (t.showHeader !== false || t.showDivisionName) {
        html += '<div class="pc3-sheet-head">';
        if (t.showDivisionName) html += '<span class="pc3-sheet-title">' + escHtml(parentLabel) + '</span>';
        if (t.campName) html += '<span class="pc3-sheet-subtitle">' + escHtml(t.campName) + '</span>';
        if (t.showDate) html += '<span class="pc3-sheet-subtitle">' + formatDisplayDate(window.currentScheduleDate) + '</span>';
        html += '<span class="pc3-sheet-badge">' + (isAutoMode() ? 'Auto' : 'Manual') + '</span>';
        html += '</div>';
    }
    html += table + '</div>';
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
                        text += ' – vs ' + _names.join(', ');
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
                text = eb.event || 'League Game';
                if (!_currentTemplate.hideLeagueMatchups) {
                    var matchups = buildLeagueMatchups(eb, divName, b);
                    if (matchups.length) text = matchups.join(', ');
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
        // ★ Prefer the slot's own travel annotation (Away/off-campus tiles stamp
        //   _travelPre/_travelPost) over the zone transition default.
        var _entPre = (entry && !entry.continuation) ? (parseInt(entry._travelPre) || 0) : 0;
        var _entPost = (entry && !entry.continuation) ? (parseInt(entry._travelPost) || 0) : 0;
        var pre = _entPre > 0 ? _entPre : ((trans && trans.preMin > 0) ? trans.preMin : 0);
        var post = _entPost > 0 ? _entPost : ((trans && trans.postMin > 0) ? trans.postMin : 0);
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
            html += '<td data-r="' + rowR + '" data-c="1" data-cell-text="Travel" style="color:#1f1f1f;font-style:italic;background:#e2efda;">🚶 Travel</td>';
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
            html += '<td data-r="' + rowR + '" data-c="1" data-cell-text="' + escHtml(_prepTxt) + '" style="color:#1f1f1f;font-style:italic;background:#e2efda;">' + escHtml(_prepTxt) + '</td>';
            var _prepLoc = slot._prepLocation || '';
            html += '<td data-r="' + rowR + '" data-c="2" data-cell-text="' + escHtml(_prepLoc) + '" style="color:#1f1f1f;font-style:italic;">' + escHtml(_prepLoc) + '</td>';
            html += '</tr>';
            return;
        }
        var slotIdx = isAutoMode() ? idx : findFirstSlotForTime(slot._lookupStart != null ? slot._lookupStart : slot.startMin, dn);
        var entry = slotIdx >= 0 ? getEntry(bunk, slotIdx) : null;
        var type = getEntryType(entry);
        var act = '', loc = '';
        if (entry && !entry.continuation) {
            act = entry._partLabel || pcCanonicalActivityName(entry._activity || entry.sport || ''); // ★ Day 19 multiPart label
            loc = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
            if (!act && loc) { act = loc; loc = ''; }
            // Display-name alias = exact label: show it verbatim, no location column.
            if (entry._displayName) { act = entry._displayName; loc = ''; }
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
    if (!entry || !loc) return false;
    var lc = String(loc).toLowerCase().trim();
    var fn = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
    var fnLc = String(fn).toLowerCase().trim();
    if (fnLc && fnLc === lc) return true;
    var actLc = String(entry._activity || '').toLowerCase().trim();
    if (actLc && actLc === lc) return true;
    // ★ Name-only specials store field = the special's NAME, not its room. Resolve
    //   the configured room so the special shows up under its facility (e.g. a
    //   lowercase-dup "arts & crafts" → "Arts & Crafts Shack"). Also makes the
    //   whole match case-insensitive, so a facility/activity stored in a different
    //   casing than the selected location still lands in the report.
    var resolved = (typeof pcResolveLocation === 'function') ? String(pcResolveLocation(entry) || '').toLowerCase().trim() : '';
    if (resolved && resolved === lc) return true;
    // Compound check: field contains the location name (e.g. "Basketball – Court 1" matches "Court 1")
    if (fnLc && fnLc.indexOf(lc) >= 0) return true;
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
        html += '<th class="corner" rowspan="2" style="min-width:80px;width:80px;background:#e6e6e6;border:1px solid #b0b0b0;font-size:12px;font-weight:600;color:#1f1f1f;text-align:center;vertical-align:middle;">Bunk</th>';
        var ci = 0;
        while (ci < numCols) {
            var col = timeCols[ci];
            if (col.periodIdx >= 0) {
                var pStart = ci, pId = col.periodIdx;
                while (ci < numCols && timeCols[ci].periodIdx === pId) ci++;
                var pSpan = ci - pStart;
                var range = activityRanges[pId];
                var periodName = range.name || ('Period ' + (pId + 1));
                html += '<th colspan="' + pSpan + '" style="text-align:center;background:#e6e6e6;color:#1f1f1f;font-size:12px;font-weight:700;padding:5px 4px;border:1px solid #b0b0b0;border-bottom:none;">';
                html += escHtml(periodName);
                html += '<div style="font-size:9px;font-weight:400;opacity:.85;margin-top:2px;">' + minutesToTimeLabel(range.startMin) + ' – ' + minutesToTimeLabel(range.endMin) + '</div>';
                html += '</th>';
            } else {
                html += '<th style="background:#f2f2f2;border:1px solid #b0b0b0;border-bottom:none;padding:2px;"></th>';
                ci++;
            }
        }
        html += '</tr>';
    }

    // Reusable time-ruler row — shown once in the header.
    function rulerRowHtml(withLeadCell) {
        var s = '<tr>';
        if (withLeadCell) {
            s += '<th style="position:sticky;left:0;z-index:2;min-width:80px;width:80px;background:#e6e6e6;border:1px solid #b0b0b0;font-size:12px;font-weight:600;color:#1f1f1f;text-align:center;vertical-align:middle;">Bunk</th>';
        }
        var fSize = _activityAligned ? 10 : (inc <= 10 ? 8 : 9);
        timeCols.forEach(function (col) {
            var labelTxt = _activityAligned
                ? (col.label + ' – ' + minutesToTimeLabel(col.endMin))
                : col.label;
            s += '<th style="min-width:' + colW + 'px;width:' + colW + 'px;font-size:' + fSize + 'px;text-align:center;padding:4px 4px;color:#1f1f1f;background:#f2f2f2;border:1px solid #b0b0b0;font-weight:600;white-space:nowrap;">' + labelTxt + '</th>';
        });
        return s + '</tr>';
    }

    // Time label row (the ONLY header row when no Bell Schedule)
    html += rulerRowHtml(!hasRealPeriodsC);
    html += '</thead><tbody>';

    // One row per bunk, with division label injected between divisions
    var lastDiv = null;
    divBunks.forEach(function (item, bunkIdx) {
        var bunk = item.bunk, divName = item.div;

        // Division separator row
        if (divName !== lastDiv) {
            lastDiv = divName;
            html += '<tr><th colspan="' + (1 + numCols) + '" style="background:#d9e1f2;padding:5px 12px;font-size:12px;font-weight:700;color:#1f3864;border:1px solid #b0b0b0;text-transform:none;letter-spacing:0;">' + escHtml(divName) + '</th></tr>';
        }

        html += '<tr>';
        html += '<th style="position:sticky;left:0;z-index:2;background:#f2f2f2;min-width:80px;padding:4px 8px;font-size:12px;font-weight:600;border:1px solid #b0b0b0;white-space:nowrap;color:#1f1f1f;">' + escHtml(bunk) + '</th>';

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
                var pillBg = '#ffffff';
                var pillTx = type === 'free' ? '#bbbbbb' : '#000000';
                var displayText = actText || '—';
                html += '<td colspan="' + span + '" style="padding:3px;vertical-align:middle;border:1px solid #c6c6c6;" data-r="' + (2+bunkIdx) + '" data-c="' + (1+colIdx) + '" data-cell-text="' + escHtml(displayText) + '" data-bunk="' + escHtml(bunk) + '">';
                // ★ Split-swim change: show Change → Swim → Change subdivisions
                var splitPre2 = matchAct.entry ? (matchAct.entry._splitPreChange || 0) : 0;
                var splitPost2 = matchAct.entry ? (matchAct.entry._splitPostChange || 0) : 0;
                if (splitPre2 > 0 || splitPost2 > 0) {
                    html += '<div style="overflow:hidden;min-height:38px;display:flex;flex-direction:column;">';
                    if (splitPre2 > 0) {
                        html += '<div style="background:#fce4d6;color:#833c00;padding:2px 6px;text-align:center;font-size:10px;font-weight:400;border-bottom:1px solid #c6c6c6;">Change</div>';
                    }
                    html += '<div style="background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;flex:1;display:flex;flex-direction:column;justify-content:center;">';
                    html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' + escHtml(displayText) + '</span>';
                    html += '</div>';
                    if (splitPost2 > 0) {
                        html += '<div style="background:#fce4d6;color:#833c00;padding:2px 6px;text-align:center;font-size:10px;font-weight:400;border-top:1px solid #c6c6c6;">Change</div>';
                    }
                    html += '</div></td>';
                } else {
                    html += '<div style="background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;min-height:38px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;position:relative;">';
                    html += pcInnerDividers(timeCols, colIdx, span);
                    html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;position:relative;">' + escHtml(displayText) + '</span>';
                    if (durMin > inc) html += '<span style="font-size:9px;opacity:.65;margin-top:1px;position:relative;">' + durMin + 'm</span>';
                    html += '</div></td>';
                }
                colIdx = nextCol;
            } else {
                html += '<td style="padding:3px;border:1px solid #c6c6c6;background:#fff;" data-r="' + (2+bunkIdx) + '" data-c="' + (1+colIdx) + '" data-cell-text="—"><div style="min-height:38px;"></div></td>';
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
        if (_currentTemplate.sharedTimeline) {
            // Shared Timeline: group selected grades by parent division and
            // render one unified table per division (bunks as columns).
            packDivisionGroups(sel).forEach(function (g) { html += renderSharedTimelineSheet(g.label, g.grades); });
        } else if (_currentTemplate.layoutMode === 'all-bunks' && isAutoMode()) {
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
            // Manual combined — each division gets its own clean, titled card
            // (was all stacked into one card with repeated headers and no labels).
            sel.forEach(function (d) {
                var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).slice();
                if (!bunks.length) return;
                var blocks = buildDivisionBlocks(d);
                html += '<div class="pc3-sheet"><div class="pc3-sheet-head">' +
                    '<span class="pc3-sheet-title">' + escHtml(d) + '</span>' +
                    (_currentTemplate.showDate ? '<span class="pc3-sheet-subtitle">' + formatDisplayDate(window.currentScheduleDate) + '</span>' : '') +
                    '<span class="pc3-sheet-badge">' + (isAutoMode() ? 'Auto' : 'Manual') + '</span>' +
                '</div>' + renderManualBunksTop(d, bunks, blocks) + '</div>';
            });
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
    var act = entry._displayName || entry._partLabel || entry._activity || entry.sport || ''; // ★ Day 19 multiPart label + post-edit display alias
    // Display-name alias = exact label: don't reveal the underlying room in the tip.
    var field = entry._displayName ? '' : ((typeof entry.field === 'string') ? entry.field
        : (entry.field && entry.field.name ? entry.field.name : ''));
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

    pc.querySelectorAll('td[data-bunk][data-slot], .pc3-tl-block[data-bunk][data-slot]').forEach(function (td) {
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

    // This kiosk window is dedicated to ONE day. Capture it from the URL up
    // front. flow.html also set window.currentScheduleDate, but calendar.js's
    // initCalendar() clobbers it back to "today" during boot — which is exactly
    // why the Live View kept showing the wrong day. enforceDate() re-asserts it.
    var _desiredDate = '';
    try { _desiredDate = new URLSearchParams(window.location.search).get('date') || ''; } catch (e) {}
    if (!_desiredDate) _desiredDate = window.currentScheduleDate || '';
    if (_desiredDate) window.currentScheduleDate = _desiredDate;

    function enforceDate() {
        if (!_desiredDate) return false;
        if (window.currentScheduleDate !== _desiredDate) {
            window.currentScheduleDate = _desiredDate;
            try { if (window.loadScheduleForDate) window.loadScheduleForDate(_desiredDate); } catch (e) {}
            _liveRenderSig = '';
            return true;
        }
        return false;
    }

    // Strip the app shell — keep only #print
    var roots = document.querySelectorAll('body > *');
    roots.forEach(function (n) {
        if (n.id === 'print' || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
        if (n.id === 'printable-area') return;
        n.style.display = 'none';
    });

    var printTab = document.getElementById('print');
    if (printTab) {
        printTab.classList.add('active');
        printTab.style.display = 'block';
        printTab.style.position = 'fixed';
        printTab.style.inset = '0';
        printTab.style.background = _pcGetLiveTheme().vars['--lv-bg'];
        printTab.style.zIndex = '9999';
    }

    var container = document.getElementById('print-content') || (function () {
        var d = document.createElement('div'); d.id = 'print-content';
        if (printTab) printTab.appendChild(d); else document.body.appendChild(d);
        return d;
    })();

    container.innerHTML = getStyles() +
        '<div class="pc3-live-overlay" id="pc3-live-overlay" style="position:fixed;inset:0;">' +
        '<div class="pc3-live-header">' +
            '<div class="pc3-live-headleft">' +
                '<div class="pc3-live-date" id="pc3-live-date"></div>' +
            '</div>' +
            '<div id="pc3-live-page-ind" style="display:none;align-items:center;gap:8px;"></div>' +
            '<div class="pc3-live-headright">' +
                '<div class="pc3-live-clock" id="pc3-live-clock"></div>' +
                '<button class="pc3-live-fit' + (_liveOneDivPerPage ? ' on' : '') + '" id="pc3-live-perdiv-btn" title="Show one division per page, rotating through them" onclick="toggleLivePerDiv()">One division per page</button>' +
                '<button class="pc3-live-fit' + (_liveWholeCamp ? ' on' : '') + '" id="pc3-live-wholecamp-btn" title="Shrink the entire camp onto one screen, no matter how small" onclick="toggleLiveWholeCamp()">Whole camp on one screen</button>' +
                '<button class="pc3-live-fit' + (_liveSharedTimeline ? ' on' : '') + '" id="pc3-live-shared-btn" title="One shared time axis per division with bunks as columns (denser)" onclick="toggleLiveSharedTimeline()">Shared timeline</button>' +
                '<button class="pc3-live-fit' + (_liveCustomPages ? ' on' : '') + '" id="pc3-live-custompages-btn" title="Choose which bunks appear on each page" onclick="openLiveBunkPageConfig()">Bunks per page…</button>' +
                '<button class="pc3-live-close" id="pc3-live-print-btn" title="Print the live view — one division per page" onclick="window._pc3LivePrint&&window._pc3LivePrint()">Print</button>' +
                '<button class="pc3-live-close" id="pc3-live-jpeg-btn" title="Download the schedule in color — one division per page (PDF)" onclick="window._pc3LiveDownloadJpeg&&window._pc3LiveDownloadJpeg()">Download</button>' +
                '<button class="pc3-live-close" onclick="window.close()">Close</button>' +
            '</div>' +
        '</div>' +
        '<div class="pc3-live-body" id="pc3-live-body"></div>' +
        '</div>';

    // Paint the camp's chosen kiosk palette onto the freshly-built overlay.
    try { _pcApplyLiveTheme(); } catch (e) {}

    // Camp name for the Live header. The settings copies (app1.campName /
    // campName / camp_name in localStorage) only get refreshed on an explicit
    // rename in the dashboard, so in a freshly-popped Live window they can hold
    // a stale name (this is why the kiosk kept showing the old "Camp Awesome").
    // The authoritative source is the `camps` table — fetch it directly, once,
    // and cache the result. Until that returns we use AccessControl's DB-backed
    // name, and only fall back to the settings copies as a last resort.
    var _liveCampNameDB = null;   // resolved name from the camps table
    var _liveCampNameFetching = false;

    function fetchLiveCampNameFromDB() {
        if (_liveCampNameDB !== null || _liveCampNameFetching) return;
        if (!window.supabase) return;
        _liveCampNameFetching = true;
        try {
            var campId = '';
            try {
                if (window.AccessControl && typeof window.AccessControl.getCampId === 'function') {
                    campId = window.AccessControl.getCampId() || '';
                }
            } catch (_) {}
            var q = window.supabase.from('camps').select('name');
            // camps.owner is the camp id used everywhere else in the app.
            q = campId ? q.eq('owner', campId).maybeSingle()
                       : q.limit(1).maybeSingle();
            Promise.resolve(q).then(function (res) {
                _liveCampNameFetching = false;
                var name = res && res.data && res.data.name;
                if (name) {
                    _liveCampNameDB = name;
                    try { refreshTitle(); } catch (_) {}
                }
            }).catch(function () { _liveCampNameFetching = false; });
        } catch (e) { _liveCampNameFetching = false; }
    }

    function refreshTitle() {
        try {
            fetchLiveCampNameFromDB();
            var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var nm = _liveCampNameDB || '';
            if (!nm) {
                try {
                    if (window.AccessControl && typeof window.AccessControl.getCampName === 'function') {
                        var _an = window.AccessControl.getCampName();
                        if (_an && _an !== 'Your Camp' && _an !== 'Unknown Camp') nm = _an;
                    }
                } catch (_) {}
            }
            nm = nm || (g.app1 ? g.app1.campName : '') || g.campName || g.camp_name || 'Camp Schedule';
            var titleEl = document.getElementById('pc3-live-title');
            if (titleEl) titleEl.textContent = nm;
            var dateEl = document.getElementById('pc3-live-date');
            if (dateEl) dateEl.textContent = formatDisplayDate(window.currentScheduleDate) || '';
            document.title = nm + ' Live';
        } catch (e) {}
    }

    function tickClock() {
        var clockEl = document.getElementById('pc3-live-clock');
        if (!clockEl) return;
        var now = new Date();
        var h = now.getHours() % 12 || 12;
        var m = String(now.getMinutes()).padStart(2, '0');
        var ap = now.getHours() >= 12 ? 'PM' : 'AM';
        clockEl.textContent = h + ':' + m + ' ' + ap;
    }

    function tickAll() {
        enforceDate();
        refreshTitle();
        renderLiveContent();
    }

    var liveBodyEl = document.getElementById('pc3-live-body');
    if (liveBodyEl) liveBodyEl.innerHTML = '<div class="pc3-live-loading">Loading schedule&hellip;</div>';

    // Cloud-fresh tracking — the popup re-runs the full app boot (integration
    // hooks), which fires these once Supabase has delivered the day's schedule.
    var _cloudFresh = false;
    var _liveBooted = false;
    function _markCloudFresh() {
        _cloudFresh = true;
        if (_liveBooted) { _liveRenderSig = ''; try { tickAll(); } catch (e) {} }
    }
    window.addEventListener('campistry-cloud-hydrated', _markCloudFresh);
    window.addEventListener('campistry-schedule-refreshed', _markCloudFresh);

    // Boot the app so divisions + schedule load. Re-assert the date around the
    // daily-adjustments load so it reads the requested day, not "today".
    setTimeout(function () {
        try { window.initApp1 && window.initApp1(); } catch (e) {}
        enforceDate();
        try { window.initDailyAdjustments && window.initDailyAdjustments(); } catch (e) {}
        enforceDate();
    }, 100);

    function whenReady(cb) {
        var attempts = 0;
        var iv = setInterval(function () {
            attempts++;
            enforceDate();
            var hasDivs = window.divisions && Object.keys(window.divisions).length > 0;
            var hasSched = (window.scheduleAssignments && Object.keys(window.scheduleAssignments).length > 0)
                || (window.divisionTimes && Object.keys(window.divisionTimes).length > 0);
            var dateOk = !_desiredDate || window.currentScheduleDate === _desiredDate;
            var freshEnough = _cloudFresh || attempts > 28; // ~7s grace for the cloud
            if ((hasDivs && hasSched && dateOk && freshEnough) || attempts > 80) {
                clearInterval(iv);
                cb();
            }
        }, 250);
    }

    whenReady(function () {
        _liveBooted = true;
        tickAll();
        // Cheap 5s tick (renderLiveContent is signature-gated) keeps the "now"
        // highlight punctual and lets the view fill in as soon as data lands.
        if (_liveInterval) clearInterval(_liveInterval);
        _liveInterval = setInterval(tickAll, 5000);
        tickClock();
        setInterval(tickClock, 1000);
    });
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

    // Show the full day span beside the division name so the real end time is
    // explicit — the column grid labels only show each slot's START, so the last
    // header reading "3:30" made the day look like it stopped there.
    var dayRange = minutesToTimeLabel(sectionStart) + ' – ' + minutesToTimeLabel(sectionEnd);
    html += '<div class="pc3-live-section">';
    html += '<div class="pc3-live-divhead">' +
        '<span class="pc3-live-divname">' + escHtml(divName) + '</span>' +
        '<span class="pc3-live-divrange">' + dayRange + '</span>' +
    '</div>';

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
        html += '<thead><tr><th class="corner">Bunk</th>';
        lTimeCols.forEach(function (tc) {
            var isCurCol = nowMin >= tc.startMin && nowMin < tc.endMin;
            html += '<th' + (isCurCol ? ' class="lv-curcol"' : '') + ' data-time-start="' + tc.startMin + '" data-time-end="' + tc.endMin + '" style="font-size:12px;text-align:center;white-space:nowrap;">' + tc.label + '</th>';
        });
        html += '</tr></thead><tbody>';

        // —— Whole-division merge ————————————————————————————————————————
        // When EVERY bunk is doing the exact same thing for the same span
        // (all at Swim, all in one league game, etc.) collapse the repeated
        // per-bunk cells into a single cell that spans all bunk rows, so the
        // activity is shown once instead of N identical times.
        function lActIsLeague(a) {
            return !!(a && a.entry && (a.entry._h2h || a.entry._league || a.entry._isSpecialtyLeague || a.entry._allMatchups));
        }
        function lActText(a) {
            if (!a) return '—';
            var isLg = lActIsLeague(a);
            var lInfo = (isLg || !a.entry) ? pcLeagueInfoAt(divName, a.startMin) : null;
            if (isLg || lInfo) {
                var lbl = (a.entry && (a.entry._gameLabel || a.entry._leagueName)) ||
                          (lInfo && lInfo.label) || 'League Game';
                var ms = (lInfo && lInfo.matchups) || [];
                return lbl + (ms.length && !_currentTemplate.hideLeagueMatchups ? ' | ' + ms.join(', ') : '');
            }
            return a.entry ? formatEntry(a.entry) : '—';
        }
        // colSpan of an activity (number of grid columns it covers).
        function lColSpanAt(startColIdx, endMin) {
            var span = 1, n = startColIdx + 1;
            while (n < lTimeCols.length && lTimeCols[n].startMin < endMin) { span++; n++; }
            return span;
        }
        // segByStartCol[colIdx] = {colSpan,text,isLeague,type,startMin,endMin} for
        // a column that BEGINS a fully-shared block; mergedCols marks every column
        // covered by such a block so non-first rows can skip it.
        var segByStartCol = {}, mergedCols = {};
        if (bunks.length > 1) {
            var firstBunkActs = lBunkActs[bunks[0]] || [];
            firstBunkActs.forEach(function (a0) {
                var txt0 = lActText(a0);
                if (!txt0 || txt0 === '—') return;
                var allShare = bunks.every(function (bk) {
                    var acts = lBunkActs[bk] || [];
                    return acts.some(function (a) {
                        return a.startMin === a0.startMin && a.endMin === a0.endMin && lActText(a) === txt0;
                    });
                });
                if (!allShare) return;
                // locate the starting column for this block
                var sc = -1;
                for (var c = 0; c < lTimeCols.length; c++) {
                    if (a0.startMin < lTimeCols[c].endMin && a0.endMin > lTimeCols[c].startMin) { sc = c; break; }
                }
                if (sc < 0) return;
                var span = lColSpanAt(sc, a0.endMin);
                segByStartCol[sc] = {
                    colSpan: span, text: txt0, isLeague: lActIsLeague(a0),
                    type: a0.type, startMin: a0.startMin, endMin: a0.endMin
                };
                for (var k = 0; k < span; k++) mergedCols[sc + k] = true;
            });
        }
        // Division-wide league periods carried as empty-league columns (no
        // per-bunk entry) are identical for every bunk too — collapse them.
        if (bunks.length > 1) {
            var hasActAt = function (colIdx) {
                return bunks.some(function (bk) {
                    var acts = lBunkActs[bk] || [];
                    return acts.some(function (a) { return a.startMin < lTimeCols[colIdx].endMin && a.endMin > lTimeCols[colIdx].startMin; });
                });
            };
            var lc = 0;
            while (lc < lTimeCols.length) {
                if (mergedCols[lc] || hasActAt(lc)) { lc++; continue; }
                var lg = pcLeagueInfoAt(divName, lTimeCols[lc].startMin);
                if (!lg) { lc++; continue; }
                var lspan = 1, ln = lc + 1;
                while (ln < lTimeCols.length && !mergedCols[ln] && !hasActAt(ln)) {
                    var lg2 = pcLeagueInfoAt(divName, lTimeCols[ln].startMin);
                    if (!lg2 || lg2.label !== lg.label) break;
                    lspan++; ln++;
                }
                var lText = lg.label + (lg.matchups.length && !_currentTemplate.hideLeagueMatchups ? ' | ' + lg.matchups.join(', ') : '');
                segByStartCol[lc] = {
                    colSpan: lspan, text: lText, isLeague: true, type: 'league',
                    startMin: lTimeCols[lc].startMin, endMin: lTimeCols[lc + lspan - 1].endMin
                };
                for (var lk = 0; lk < lspan; lk++) mergedCols[lc + lk] = true;
                lc = ln;
            }
        }

        bunks.forEach(function (bunk, bunkIdx) {
            html += '<tr>';
            html += '<th class="row-head">' + escHtml(bunk) + '</th>';
            var acts = lBunkActs[bunk] || [];
            var ci = 0;
            while (ci < lTimeCols.length) {
                var cStart = lTimeCols[ci].startMin;
                var cEnd = lTimeCols[ci].endMin;

                // Shared block: render once (first row, spanning all rows) then skip.
                if (mergedCols[ci]) {
                    var seg = segByStartCol[ci];
                    if (seg) {
                        if (bunkIdx === 0) {
                            var sCur = nowMin >= seg.startMin && nowMin < seg.endMin;
                            var sPast = nowMin >= seg.endMin;
                            var sCls = (seg.isLeague ? 'cell-league' : 'cell-' + seg.type) + ' cell-merged';
                            if (sCur) sCls += ' cell-current';
                            if (sPast) sCls += ' cell-past';
                            html += '<td colspan="' + seg.colSpan + '" rowspan="' + bunks.length + '" class="' + sCls + '" style="text-align:center;vertical-align:middle;font-size:1em;line-height:1.15;padding:6px 6px;white-space:pre-line;word-break:break-word;">' + escHtml(seg.text) + '</td>';
                        }
                        ci += seg.colSpan;
                    } else {
                        ci++; // covered by a rowspan from row 0 — emit nothing
                    }
                    continue;
                }

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
                        txt = pcLeagueCellText(lbl, _currentTemplate.hideLeagueMatchups ? [] : ms);
                    } else {
                        txt = mAct.entry ? pcLiveEntryText(mAct.entry) : '—';
                        if (mAct.entry && txt && txt !== '—' && mAct.slotIdx != null) {
                            var _liveSh = pcFindFieldSharers(bunk, mAct.slotIdx, divName);
                            if (_liveSh.length) {
                                var _liveNames = _liveSh.map(function (x) { return /^\d/.test(String(x)) ? 'Bunk ' + x : x; });
                                txt += ' – vs ' + _liveNames.join(', ');
                            }
                        }
                    }
                    var cls = (isLeagueAct || leagueInfo) ? 'cell-league' : 'cell-' + mAct.type;
                    if (isCur) cls += ' cell-current';
                    if (isPast) cls += ' cell-past';
                    html += '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + ' class="' + cls + '" style="text-align:center;font-size:1em;line-height:1.15;padding:6px 6px;white-space:pre-line;word-break:break-word;">' + escHtml(txt) + '</td>';
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
                        var lTxt = pcLeagueCellText(emptyLeague.label, _currentTemplate.hideLeagueMatchups ? [] : emptyLeague.matchups);
                        var lCls = 'cell-league' + (isCC ? ' cell-current' : '');
                        html += '<td' + (lspan > 1 ? ' colspan="' + lspan + '"' : '') + ' class="' + lCls + '" style="text-align:center;font-size:1em;line-height:1.15;padding:6px 6px;white-space:pre-line;word-break:break-word;">' + escHtml(lTxt) + '</td>';
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
                var leagueText = pcLeagueCellText(ts.event, _currentTemplate.hideLeagueMatchups ? [] : buildLeagueMatchups(ts, divName));
                var lcls = 'cell-league';
                if (isCurrent) lcls += ' cell-current';
                if (isPast) lcls += ' cell-past';
                html += '<td colspan="' + bunks.length + '" class="' + lcls + '" style="text-align:center;white-space:pre-line;word-break:break-word;"><strong>' + escHtml(leagueText) + '</strong></td>';
                html += '</tr>';
                return;
            }

            var mSlotIdx = findFirstSlotForTime(ts.startMin, divName);
            var perBunk = bunks.map(function (bunk) {
                var entry = mSlotIdx >= 0 ? getEntry(bunk, mSlotIdx) : null;
                return { entry: entry, type: getEntryType(entry), text: entry ? pcLiveEntryText(entry) : '—' };
            });

            // When every bunk is doing the exact same thing this period, show it
            // once across the whole row instead of repeating it per bunk.
            var allSame = bunks.length > 1 && perBunk.every(function (p) {
                return p.text !== '—' && p.text === perBunk[0].text && p.type === perBunk[0].type;
            });

            if (allSame) {
                var mCls = 'cell-' + perBunk[0].type + ' cell-merged';
                if (isCurrent) mCls += ' cell-current';
                if (isPast) mCls += ' cell-past';
                html += '<td colspan="' + bunks.length + '" class="' + mCls + '" style="text-align:center;white-space:pre-line;word-break:break-word;">' + escHtml(perBunk[0].text) + '</td>';
            } else {
                perBunk.forEach(function (p, bi) {
                    var bunk = bunks[bi];
                    var text = p.text;
                    if (p.entry && text !== '—' && mSlotIdx >= 0) {
                        var _sh = pcFindFieldSharers(bunk, mSlotIdx, divName);
                        if (_sh.length) {
                            var _names = _sh.map(function (x) { return /^\d/.test(String(x)) ? 'Bunk ' + x : x; });
                            text += ' – vs ' + _names.join(', ');
                        }
                    }
                    var cls = 'cell-' + p.type;
                    if (isCurrent) cls += ' cell-current';
                    if (isPast) cls += ' cell-past';
                    html += '<td class="' + cls + '">' + escHtml(text) + '</td>';
                });
            }
            html += '</tr>';
        });
        html += '</tbody></table>';
    }

    html += '</div>';
    return html;
}

// —— Build ONE shared-timeline section for a whole division ————————————————————
// Instead of a separate grid per grade (each repeating its own time axis across
// the top), this renders a single table with ONE time axis running DOWN the
// Y-axis and every bunk in the division as a column (grouped by grade in the
// header). Far denser — fits much more on a page. `grades` is an array of
// { divName: <grade name>, bunks: [...] }.
function buildLiveUnifiedSectionHTML(parentLabel, grades, nowMin) {
    var auto = isAutoMode();

    // Flatten to columns (bunk + which grade it belongs to) and build each
    // bunk's activity segments, collecting every time boundary as we go.
    var cols = [];
    grades.forEach(function (g) {
        (g.bunks || []).forEach(function (b) { cols.push({ bunk: b, grade: g.divName, segs: [] }); });
    });
    if (!cols.length) return '';

    var boundSet = {};
    cols.forEach(function (c) {
        var segs = [];
        if (auto) {
            var slots = getPerBunkSchedule(c.bunk, c.grade);
            for (var i = 0; i < slots.length; i++) {
                var entry = getEntry(c.bunk, i);
                if (entry && entry.continuation && segs.length > 0) { segs[segs.length - 1].endMin = slots[i].endMin; continue; }
                segs.push({ startMin: slots[i].startMin, endMin: slots[i].endMin, entry: entry, slotIdx: i, type: entry ? getEntryType(entry) : 'free' });
            }
        } else {
            var blocks = buildDivisionBlocks(c.grade);
            blocks.forEach(function (bl) {
                var si = findFirstSlotForTime(bl.startMin, c.grade);
                var entry = si >= 0 ? getEntry(c.bunk, si) : null;
                segs.push({ startMin: bl.startMin, endMin: bl.endMin, entry: entry, slotIdx: si, type: entry ? getEntryType(entry) : 'free', isLeague: bl.isLeague, event: bl.event });
            });
        }
        c.segs = segs;
        segs.forEach(function (s) { boundSet[s.startMin] = 1; boundSet[s.endMin] = 1; });
    });

    var bounds = Object.keys(boundSet).map(Number).sort(function (a, b) { return a - b; });
    if (bounds.length < 2) return '';
    var rows = [];
    for (var bi = 0; bi < bounds.length - 1; bi++) rows.push({ startMin: bounds[bi], endMin: bounds[bi + 1] });

    // Map each column to the segment covering each row (null = gap).
    cols.forEach(function (c) {
        c.rowSeg = rows.map(function (r) {
            var found = null;
            c.segs.forEach(function (s) { if (s.startMin <= r.startMin && s.endMin >= r.endMin) found = s; });
            return found;
        });
    });

    // Text + css class for a cell (segment may be null → gap/league).
    function cellInfo(c, seg, r) {
        var txt, cls;
        if (!seg) {
            var lg0 = pcLeagueInfoAt(c.grade, r.startMin);
            if (lg0) { txt = pcLeagueCellText(lg0.label, lg0.matchups); cls = 'cell-league'; }
            else { txt = '—'; cls = 'cell-free'; }
        } else if (!auto && seg.isLeague) {
            txt = pcLeagueCellText(seg.event || 'League Game', _currentTemplate.hideLeagueMatchups ? [] : buildLeagueMatchups(seg, c.grade));
            cls = 'cell-league';
        } else {
            var isLeagueAct = !!(seg.entry && (seg.entry._h2h || seg.entry._league || seg.entry._isSpecialtyLeague || seg.entry._allMatchups));
            var leagueInfo = (isLeagueAct || !seg.entry) ? pcLeagueInfoAt(c.grade, seg.startMin) : null;
            if (isLeagueAct || leagueInfo) {
                var lbl = (seg.entry && (seg.entry._gameLabel || seg.entry._leagueName)) || (leagueInfo && leagueInfo.label) || 'League Game';
                var ms = (leagueInfo && leagueInfo.matchups) || [];
                txt = pcLeagueCellText(lbl, ms);
                cls = 'cell-league';
            } else {
                txt = seg.entry ? pcLiveEntryText(seg.entry) : '—';
                cls = 'cell-' + seg.type;
            }
        }
        return { txt: txt, cls: cls };
    }

    var dayRange = minutesToTimeLabel(bounds[0]) + ' – ' + minutesToTimeLabel(bounds[bounds.length - 1]);
    var html = '<div class="pc3-live-section">';
    html += '<div class="pc3-live-divhead">' +
        '<span class="pc3-live-divname">' + escHtml(parentLabel) + '</span>' +
        '<span class="pc3-live-divrange">' + dayRange + '</span>' +
    '</div>';
    html += '<table class="pc3-live-tbl pc3-live-unified" style="table-layout:fixed;width:100%;">';
    // Header: row 1 = grade groups, row 2 = bunk names.
    html += '<thead><tr><th class="corner" rowspan="2">Time</th>';
    grades.forEach(function (g) { if (g.bunks && g.bunks.length) html += '<th colspan="' + g.bunks.length + '" class="pc3-uni-grade">' + escHtml(g.divName) + '</th>'; });
    html += '</tr><tr>';
    cols.forEach(function (c) { html += '<th class="pc3-uni-bunk">' + escHtml(c.bunk) + '</th>'; });
    html += '</tr></thead><tbody>';

    // Build a descriptor for every cell, then merge identical adjacent tiles
    // into rectangles (same activity across bunks AND across time → one cell).
    // Highlight (current/past) is derived from the tile's own time span so a
    // merged tile lights up correctly regardless of which row "now" lands on.
    var nR = rows.length, nC = cols.length;
    var grid = [];
    for (var gr = 0; gr < nR; gr++) {
        grid[gr] = [];
        for (var gc = 0; gc < nC; gc++) {
            var gseg = cols[gc].rowSeg[gr];
            var ginfo = cellInfo(cols[gc], gseg, rows[gr]);
            var gs = gseg ? gseg.startMin : rows[gr].startMin;
            var ge = gseg ? gseg.endMin : rows[gr].endMin;
            grid[gr][gc] = { text: ginfo.txt, cls: ginfo.cls, s: gs, e: ge, key: ginfo.txt + '|' + ginfo.cls + '|' + gs + '|' + ge };
        }
    }
    // Drop time rows where EVERY bunk is empty (a between-period gap) so blank
    // space doesn't waste a full row.
    (function () {
        var keep = [];
        for (var ri = 0; ri < nR; ri++) {
            var allFree = true;
            for (var ci = 0; ci < nC; ci++) { if (grid[ri][ci].cls !== 'cell-free') { allFree = false; break; } }
            if (!allFree) keep.push(ri);
        }
        if (keep.length !== nR) {
            rows = keep.map(function (i) { return rows[i]; });
            grid = keep.map(function (i) { return grid[i]; });
            nR = rows.length;
        }
    })();
    if (!nR) return '';
    var done = {};
    var kk = function (a, b) { return a + ':' + b; };
    rows.forEach(function (r, ri) {
        var rowCur = nowMin >= r.startMin && nowMin < r.endMin;
        var rowPast = nowMin >= r.endMin;
        html += '<tr>';
        html += '<th class="row-head' + (rowCur ? ' cell-current' : '') + (rowPast ? ' cell-past' : '') + '">' + minutesToTimeLabel(r.startMin) + '</th>';
        for (var ci = 0; ci < nC; ci++) {
            if (done[kk(ri, ci)]) continue;
            var cell = grid[ri][ci];
            // Extend right across bunks with the same tile.
            var colspan = 1;
            while (ci + colspan < nC && !done[kk(ri, ci + colspan)] && grid[ri][ci + colspan].key === cell.key) colspan++;
            // Extend down across time while the whole column-range still matches.
            var rowspan = 1;
            extend: while (ri + rowspan < nR) {
                for (var cc = ci; cc < ci + colspan; cc++) {
                    if (done[kk(ri + rowspan, cc)] || grid[ri + rowspan][cc].key !== cell.key) break extend;
                }
                rowspan++;
            }
            for (var rr = ri; rr < ri + rowspan; rr++) for (var c2 = ci; c2 < ci + colspan; c2++) done[kk(rr, c2)] = 1;
            var isCur = nowMin >= cell.s && nowMin < cell.e;
            var isPast = nowMin >= cell.e;
            var cls = cell.cls + (isCur ? ' cell-current' : '') + (isPast ? ' cell-past' : '');
            html += '<td' + (colspan > 1 ? ' colspan="' + colspan + '"' : '') + (rowspan > 1 ? ' rowspan="' + rowspan + '"' : '') +
                ' class="' + cls + '" style="text-align:center;font-size:1em;line-height:1.15;padding:6px 6px;white-space:pre-line;word-break:break-word;">' + escHtml(cell.text) + '</td>';
        }
        html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
}

// Build section HTML for a set of {divName(grade), bunks} groups, honoring the
// shared-timeline toggle (one unified table per division vs one grid per grade).
// Returns an array of HTML strings (one per rendered section).
function buildSectionHtmlsForGroups(groups, nowMin) {
    var out = [];
    if (_liveSharedTimeline) {
        var order = [], byk = {};
        groups.forEach(function (g) {
            var rp = (typeof window.getParentDivision === 'function' && window.getParentDivision(g.divName)) || null;
            var key = rp || (' grade:' + g.divName);
            if (!byk[key]) { byk[key] = { label: rp || g.divName, grades: [] }; order.push(key); }
            byk[key].grades.push(g);
        });
        order.forEach(function (key) { out.push(buildLiveUnifiedSectionHTML(byk[key].label, byk[key].grades, nowMin)); });
    } else {
        groups.forEach(function (g) { out.push(buildLiveSectionHTML(g.divName, g.bunks, nowMin)); });
    }
    return out;
}

// blind 30-second timer. This is what kills the periodic flash/lag on a kiosk.
function _liveContentSignature(nowMin) {
    var divs = getDivisions();
    var available = (typeof window.getUserDivisionOrder === 'function')
        ? window.getUserDivisionOrder(getAvailableDivisions())
        : getAvailableDivisions().sort(naturalSort);
    // ★ Per-day presence: keep the signature in sync with renderLiveContent.
    if (typeof window.filterDivisionsByDate === 'function') available = window.filterDivisionsByDate(available);
    var inc = _timeIncrement || 15;
    // tphase changes every increment → keeps the header "current column" highlight live.
    var parts = [
        window.currentScheduleDate || '', String(inc), isAutoMode() ? 'A' : 'M',
        _currentTemplate.hideLeagueMatchups ? '1' : '0',
        'T' + Math.floor(nowMin / inc)
    ];
    available.forEach(function (divName) {
        var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).slice();
        if (!bunks.length) return;
        parts.push('§' + divName + '#' + bunks.join(','));
        if (isAutoMode()) {
            bunks.forEach(function (bunk) {
                var slots = getPerBunkSchedule(bunk, divName);
                for (var i = 0; i < slots.length; i++) {
                    var s = slots[i], e = getEntry(bunk, i);
                    var label = e ? (e._displayName || e._partLabel || e._activity || e.sport || (e.continuation ? '~' : '')) : '';
                    // start/end relative to now → flips exactly when a cell turns current/past
                    parts.push(s.startMin + '-' + s.endMin + ':' + label +
                        (nowMin >= s.startMin ? 's' : '') + (nowMin >= s.endMin ? 'e' : ''));
                }
            });
        } else {
            var blocks = buildDivisionBlocks(divName);
            blocks.forEach(function (b) {
                parts.push(b.startMin + '-' + b.endMin + ':' + (b.event || '') + (b.isLeague ? 'L' : '') +
                    (nowMin >= b.startMin ? 's' : '') + (nowMin >= b.endMin ? 'e' : ''));
                bunks.forEach(function (bunk) {
                    var si = findFirstSlotForTime(b.startMin, divName);
                    var e = si >= 0 ? getEntry(bunk, si) : null;
                    parts.push(e ? (e._activity || e.sport || '') : '');
                });
            });
        }
    });
    return parts.join('|');
}

// —— Paginated live view renderer ————————————————————————————————————————————
// Size each table's font fully dynamically to MAXIMIZE pixel usage. For each
// table we grow the font as large as possible until EITHER a single word would
// overflow its cell (no mid-word breaks) OR the table fills its vertical band
// (its share of the screen) — whichever comes first. So a few-bunk table (wide
// columns, few rows) gets big text that fills its band, while a many-bunk table
// (narrow columns) gets just enough to keep words whole, and the row-fill then
// tops off any band it couldn't fill with font alone. No magic constants beyond
// a sane floor/ceiling; everything else is measured from the real content and
// the real screen size. Cells are em-based, so one table font-size scales every
// cell + the bunk/grade/time headers. `availH` is the unscaled target height.
function pcLiveFitFont(nodes, availH) {
    if (!nodes || !nodes.length) return;
    var meas = document.createElement('span');
    meas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;white-space:nowrap;font-weight:700;visibility:hidden;';
    document.body.appendChild(meas);
    var cache = {};
    function wordPerPx(word, family) {
        var k = family + '|' + word;
        if (cache[k] != null) return cache[k];
        meas.style.fontFamily = family; meas.style.fontSize = '100px'; meas.textContent = word;
        var v = meas.offsetWidth / 100; // width per 1px of font size
        cache[k] = v; return v;
    }
    try {
        // 1. Per table: word-break ceiling (largest font keeping every word in
        //    its cell) + natural size (to share out the screen height).
        var items = [], sumNat = 0;
        nodes.forEach(function (n) {
            var tbl = n.querySelector('.pc3-live-tbl');
            if (!tbl) return;
            var fam = getComputedStyle(tbl).fontFamily;
            var cells = tbl.querySelectorAll('tbody td');
            var cap = 120;
            for (var i = 0; i < cells.length; i++) {
                var cell = cells[i];
                var usable = cell.clientWidth - 18;
                if (usable < 8) continue;
                var words = (cell.textContent || '').trim().split(/\s+/);
                var widest = 0;
                for (var w = 0; w < words.length; w++) {
                    if (!words[w] || words[w] === '—') continue;
                    var pp = wordPerPx(words[w], fam);
                    if (pp > widest) widest = pp;
                }
                if (widest > 0) { var mf = usable / widest; if (mf < cap) cap = mf; }
            }
            cap = Math.max(13, Math.min(120, Math.floor(cap)));
            var head = n.querySelector('.pc3-live-divhead');
            var nat = n.offsetHeight;
            sumNat += nat;
            items.push({ tbl: tbl, cap: cap, node: n, nat: nat, headH: head ? head.offsetHeight : 0 });
        });
        if (!items.length) return;
        // 2. Each table fills its own band (share of the height). Binary-search
        //    the largest font (<= word cap) whose section fits the band. The
        //    band is the node's FULL target (it already includes the divhead,
        //    since `nat` is the whole section-wrap height) — do not add headH
        //    again or the page overflows and the bottom rows get clipped. The
        //    -10 is a small safety margin so we never cut off.
        var contentSpace = availH - 36 - items.length * 22 - 10;
        items.forEach(function (it) {
            var band = Math.max(50, Math.round(contentSpace * (it.nat / (sumNat || 1))));
            var lo = 13, hi = it.cap, best = 13;
            for (var k = 0; k < 13; k++) {
                var mid = (lo + hi) / 2;
                it.tbl.style.fontSize = mid + 'px';
                if (it.node.offsetHeight <= band) { best = mid; lo = mid; } else { hi = mid; }
            }
            it.tbl.style.fontSize = Math.floor(best) + 'px';
        });
    } finally {
        document.body.removeChild(meas);
    }
}

// Fill leftover vertical space: when the page content is shorter than the
// screen, set each table's HEIGHT to its proportional share of the available
// space. The browser distributes that height across the table's rows (the
// reliable way — setting row heights fights tall wrapped rows; flex on a table
// doesn't grow rows). Tables are already width:100%, so this fills both axes.
// Called while the section nodes are laid out (offsetHeight readable).
function pcLiveFillTables(nodes, availH) {
    if (!nodes || !nodes.length) return;
    var overhead = 36; // page-inner top+bottom padding
    var tables = [], totalTableNat = 0;
    nodes.forEach(function (n) {
        var head = n.querySelector('.pc3-live-divhead');
        overhead += (head ? head.offsetHeight : 0) + 22; // divhead + section gap
        var tbl = n.querySelector('.pc3-live-tbl');
        if (tbl) { tables.push(tbl); totalTableNat += tbl.offsetHeight || 1; }
    });
    var tableSpace = availH - overhead - 18; // safety buffer so we never clip the bottom row
    if (totalTableNat <= 0 || tableSpace <= totalTableNat + 8) return; // no real spare room
    tables.forEach(function (tbl) {
        var share = Math.floor(tableSpace * ((tbl.offsetHeight || 1) / totalTableNat));
        if (share > tbl.offsetHeight) tbl.style.height = share + 'px';
    });
}

function renderLiveContent() {
    var body = el('pc3-live-body');
    if (!body) return;
    var nowMin = getNowMinutes();
    var divs = getDivisions();
    var available = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(getAvailableDivisions()) : getAvailableDivisions().sort(naturalSort);
    // ★ Per-day presence: hide grades not around on the viewed date.
    if (typeof window.filterDivisionsByDate === 'function') available = window.filterDivisionsByDate(available);

    // Skip the (expensive) rebuild when nothing the viewer can see has changed.
    // The page-rotation timer drives "showing different parts of the schedule"
    // on its own via livePageNav() without touching the DOM here, so a no-op
    // tick costs only this signature walk — no flash, no jank.
    var sig = _liveContentSignature(nowMin);
    var hasPages = !!body.querySelector('[id^="lp-"]');
    if (sig === _liveRenderSig && hasPages) {
        return;
    }
    _liveRenderSig = sig;

    // 1. Render all section wraps into body so we can measure their heights.
    //    `sectionParents[i]` is the top-level division (Juniors/Seniors) that
    //    grade-section i belongs to — used by "one division per page" to group
    //    all grades of a division onto a single page. In this data model the
    //    scheduling unit is the GRADE; its parent division lives in
    //    divisions[grade].parentDivision (falls back to the grade itself).
    var sectHtml = '';
    var sectionParents = [];
    var sectionPage = [];   // custom-pages: which user page each section belongs to
    var customActive = _liveCustomPages && _liveCustomPageMap && Object.keys(_liveCustomPageMap).length > 0;
    if (customActive) {
        // Build pages straight from the operator's bunk→page assignment. Bunks
        // with no assignment fall into a trailing page so none are lost.
        var pageOrder = [], seenP = {}, hasUnassigned = false;
        available.forEach(function (divName) {
            var allB = (divs[divName] && divs[divName].bunks) ? divs[divName].bunks : [];
            allB.forEach(function (b) {
                var pg = _liveCustomPageMap[_cpBunkKey(divName, b)];
                if (pg == null || pg === '') { hasUnassigned = true; return; }
                pg = String(pg);
                if (!seenP[pg]) { seenP[pg] = 1; pageOrder.push(pg); }
            });
        });
        pageOrder.sort(function (a, b) { return (parseFloat(a) || 0) - (parseFloat(b) || 0); });
        var pageDefs = pageOrder.map(function (pg) {
            var groups = [];
            available.forEach(function (divName) {
                var allB = (divs[divName] && divs[divName].bunks) ? divs[divName].bunks : [];
                var sel = allB.filter(function (b) { return String(_liveCustomPageMap[_cpBunkKey(divName, b)]) === pg; });
                if (sel.length) groups.push({ divName: divName, bunks: sel });
            });
            return groups;
        });
        if (hasUnassigned) {
            var ug = [];
            available.forEach(function (divName) {
                var allB = (divs[divName] && divs[divName].bunks) ? divs[divName].bunks : [];
                var sel = allB.filter(function (b) { var pg = _liveCustomPageMap[_cpBunkKey(divName, b)]; return pg == null || pg === ''; });
                if (sel.length) ug.push({ divName: divName, bunks: sel });
            });
            if (ug.length) pageDefs.push(ug);
        }
        pageDefs.forEach(function (groups, pIdx) {
            buildSectionHtmlsForGroups(groups, nowMin).forEach(function (h) {
                if (!h) return;
                sectionParents.push({ key: 'cp' + pIdx, label: '', real: false });
                sectionPage.push(pIdx);
                sectHtml += '<div class="pc3-live-section-wrap">' + h + '</div>';
            });
        });
    }
    if (!customActive && _liveSharedTimeline) {
        // One shared-timeline section per DIVISION — group its grades so they
        // share a single time axis with all their bunks as columns.
        var stOrder = [], stByKey = {};
        available.forEach(function (divName) {
            var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).slice();
            if (!bunks.length) return;
            var rp = (typeof window.getParentDivision === 'function' && window.getParentDivision(divName)) ||
                     (divs[divName] && divs[divName].parentDivision) || null;
            var key = rp || (' grade:' + divName);
            if (!stByKey[key]) { stByKey[key] = { label: rp || divName, real: !!rp, grades: [] }; stOrder.push(key); }
            stByKey[key].grades.push({ divName: divName, bunks: bunks });
        });
        stOrder.forEach(function (key) {
            var grp = stByKey[key];
            var secHtml = buildLiveUnifiedSectionHTML(grp.label, grp.grades, nowMin);
            if (!secHtml) return;
            sectionParents.push({ key: key, label: grp.label, real: grp.real });
            sectHtml += '<div class="pc3-live-section-wrap">' + secHtml + '</div>';
        });
    }
    if (!customActive && !_liveSharedTimeline) available.forEach(function (divName) {
        var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).slice();
        if (!bunks.length) return;
        var realParent = (typeof window.getParentDivision === 'function' && window.getParentDivision(divName)) ||
                         (divs[divName] && divs[divName].parentDivision) || null;
        // key groups grades onto pages; real divisions share a key, while grades
        // without a parent each get a unique key (so they stay one-per-page).
        sectionParents.push({
            key: realParent || (' grade:' + divName),
            label: realParent || divName,
            real: !!realParent
        });
        sectHtml += '<div class="pc3-live-section-wrap">' + buildLiveSectionHTML(divName, bunks, nowMin) + '</div>';
    });
    if (!sectHtml) {
        body.style.visibility = '';
        body.innerHTML = '<div class="pc3-live-loading">No schedule for this day yet.</div>';
        _liveRenderSig = ''; // force a real render once data arrives
        return;
    }
    // Hide while we measure + bin-pack so the viewer never sees the brief
    // "all sections stacked" flash before pagination collapses them.
    body.style.visibility = 'hidden';
    body.innerHTML = sectHtml;

    // Guard against overlapping renders (rapid hydration/refresh events fire
    // renderLiveContent several times in a row). Each render replaces the DOM
    // and defers its measure/fit to a rAF; without this token a STALE rAF would
    // run on the NEWER DOM — re-measuring already-fitted nodes and shrinking the
    // text, and rebuilding pages out from under the nav arrows. Only the latest
    // render's deferred pass is allowed to proceed.
    var myToken = ++_liveRenderToken;

    // Defer measure + paginate until after the browser has computed layout.
    // A double rAF guarantees the new DOM nodes have been laid out so
    // offsetHeight values are real (not 0) when we bin-pack into pages.
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
        if (myToken !== _liveRenderToken) return; // superseded by a newer render
        try {

    // 2. Measure available height and each section rendered height
    var availH = body.offsetHeight || (window.innerHeight - 80);
    var wraps = Array.prototype.slice.call(body.querySelectorAll('.pc3-live-section-wrap'));

    // 2b. "Whole camp on one screen": put EVERY division on a single,
    //     non-rotating page and shrink it uniformly until it fits — no matter
    //     how small. Unlike the old "fit to screen", there is no readability
    //     floor and no fallback to rotation: the whole camp is always visible.
    if (_liveWholeCamp && !customActive) {
        var wcTotalH = 36; // .pc3-live-page-inner vertical padding (18 top + 18 bottom)
        wraps.forEach(function (wrap) { wcTotalH += wrap.offsetHeight + 20; });
        var wcScale = wcTotalH > availH ? availH / wcTotalH : 1;
        wcScale = Math.min(1, wcScale); // only ever shrink, never enlarge

        _numLivePages = 1;
        _livePageIndex = 0;

        var wcPage = document.createElement('div');
        wcPage.id = 'lp-0';
        wcPage.style.cssText = 'position:absolute;inset:0;opacity:1;pointer-events:auto;overflow:hidden;';

        var wcInner = document.createElement('div');
        wcInner.className = 'pc3-live-page-inner';
        wcInner.style.cssText = 'transform:scale(' + wcScale.toFixed(4) + ');transform-origin:top center;width:100%;';

        wraps.forEach(function (n) { wcInner.appendChild(n); });
        wcPage.appendChild(wcInner);
        body.appendChild(wcPage);
        // Grow fonts to fill (per table), then fill any leftover vertical space
        // so the whole camp uses the full screen (done after placement).
        pcLiveFitFont(wraps, Math.round(availH / Math.max(wcScale, 0.05)));
        if (wcScale >= 1) pcLiveFillTables(wraps, availH);

        updateLivePageIndicator();
        if (_numLivePages !== _livePrevPageCount) {
            _livePrevPageCount = _numLivePages;
            startLivePageTimer(); // single page → stops rotation
        }
        body.style.visibility = '';
        return; // whole-camp fit done — skip pagination
    }

    // 3. Decide how sections map to pages.
    var pages = [];
    if (customActive) {
        // Custom pages — one page per user-assigned page number (sectionPage).
        var byPg = {};
        wraps.forEach(function (wrap, i) {
            var p = sectionPage[i];
            if (p == null) p = 0;
            if (!byPg[p]) { byPg[p] = { nodes: [], totalH: 0 }; pages.push(byPg[p]); }
            byPg[p].nodes.push(wrap);
            byPg[p].totalH += wrap.offsetHeight + 20;
        });
    } else if (_liveOneDivPerPage) {
        // One division per page — a page NEVER mixes two divisions. ALL of a
        // division's grades and bunks go on its single page, which is then
        // shrunk (in step 4) as far as needed to fit, no matter how small — no
        // spilling onto extra pages. Pages rotate division by division.
        var byKey = {};
        wraps.forEach(function (wrap, i) {
            var meta = sectionParents[i] || { key: '#' + i, label: '', real: false };
            if (!byKey[meta.key]) {
                byKey[meta.key] = { nodes: [], totalH: meta.real ? 54 : 0, parent: meta.label, realParent: meta.real };
                pages.push(byKey[meta.key]);
            }
            byKey[meta.key].nodes.push(wrap);
            byKey[meta.key].totalH += wrap.offsetHeight + 20;
        });
    } else {
        // Greedy bin-pack: keep adding sections to the current page until they
        // would overflow, then start a new page. A single oversized section gets
        // its own page and is scaled down to fit.
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
    }

    _numLivePages = pages.length;
    if (_livePageIndex >= _numLivePages) _livePageIndex = 0;

    // 4. Move section wrap nodes into absolutely-positioned, fit-to-screen pages.
    pages.forEach(function (page, pi) {
        var scale = page.totalH > availH ? availH / page.totalH : 1;
        scale = (_liveOneDivPerPage || customActive) ? Math.min(1, scale) : Math.max(0.25, Math.min(1, scale));
        if (!(scale > 0)) scale = 1;

        var pageDiv = document.createElement('div');
        pageDiv.id = 'lp-' + pi;
        var active = pi === _livePageIndex;
        pageDiv.style.cssText = 'position:absolute;inset:0;opacity:' + (active ? 1 : 0) + ';transition:opacity .7s ease;pointer-events:' + (active ? 'auto' : 'none') + ';overflow:hidden;';

        var inner = document.createElement('div');
        inner.className = 'pc3-live-page-inner';
        inner.style.cssText = 'transform:scale(' + scale.toFixed(4) + ');transform-origin:top left;width:' + (100 / scale).toFixed(2) + '%;';

        // In one-division-per-page mode, label the page with the division name
        // (only for real divisions — a lone grade with no parent already shows
        // its own header).
        if (_liveOneDivPerPage && !_liveSharedTimeline && page.realParent && page.parent) {
            var banner = document.createElement('div');
            banner.className = 'pc3-live-divbanner';
            banner.textContent = page.parent;
            inner.appendChild(banner);
        }
        page.nodes.forEach(function (n) { inner.appendChild(n); });
        pageDiv.appendChild(inner);
        body.appendChild(pageDiv);
        // Now the content is placed (and reflowed at the possibly-widened width
        // from the scale trick). First size each table's font to its columns
        // (big text where bunks are few), then grow the rows to fill the unscaled
        // target so that after the transform scales it, it fills the screen
        // exactly — both when the page fits (scale 1) and when it was shrunk.
        pcLiveFitFont(page.nodes, Math.round(availH / scale));
        pcLiveFillTables(page.nodes, Math.round(availH / scale));
    });

    // 5. Update indicator + (re)start rotation only when the page COUNT changed,
    //    so the 5s content refresh never disturbs the 20s rotation cadence.
    updateLivePageIndicator();
    if (_numLivePages !== _livePrevPageCount) {
        _livePrevPageCount = _numLivePages;
        startLivePageTimer();
    }
        } catch (e) {
            console.error('[LiveView] render failed', e);
        } finally {
            body.style.visibility = ''; // ALWAYS reveal — never strand the screen on hidden
        }
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
            dots += '<span style="width:10px;height:10px;border-radius:50%;display:inline-block;background:' + (i === _livePageIndex ? 'var(--lv-accent,#fbbf24)' : 'var(--lv-dot-idle,rgba(255,255,255,.3))') + ';transition:background .3s;"></span>';
        }
        ind.innerHTML =
            '<button class="pc3-live-nav-btn" onclick="livePageNav(-1)">&#8249;</button>' +
            '<div style="display:flex;gap:7px;align-items:center;">' + dots + '</div>' +
            '<button class="pc3-live-nav-btn" onclick="livePageNav(1)">&#8250;</button>';
    } else {
        ind.style.display = 'none';
    }
}

// ── Live view → Print / Download as JPEG ─────────────────────────────────
// Rasterize the live pages (exactly what's on screen — one division per page)
// and either print them or save them as JPEGs. html2canvas is loaded on demand.
function _pc3LoadH2C() {
    return new Promise(function (resolve) {
        if (window.html2canvas) return resolve(window.html2canvas);
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
        s.onload = function () { resolve(window.html2canvas || null); };
        s.onerror = function () { resolve(null); };
        document.head.appendChild(s);
    });
}
// Capture every live page to a canvas, in order. cb(canvasesOrNull).
function _pc3CaptureLivePages(cb, bw) {
    var body = el('pc3-live-body');
    if (!body) { cb(null); return; }
    var pages = Array.prototype.slice.call(body.querySelectorAll('[id^="lp-"]'));
    if (!pages.length) { cb(null); return; }
    if (window.showToast) window.showToast('Rendering image…', 'info');
    _pc3LoadH2C().then(function (h2c) {
        if (!h2c) { if (window.showToast) window.showToast('Could not load the image library (offline?)', 'error'); cb(null); return; }
        if (_livePageTimer) { clearInterval(_livePageTimer); _livePageTimer = null; } // pause rotation
        // Optional black-and-white (Excel-style) for print. JPEG keeps the actual
        // colored schedule. The bw class must sit on each captured element —
        // html2canvas clones only the page subtree, so a class on an ancestor is
        // lost there and the dark cell rules win.
        if (bw) { body.classList.add('pc3-live-bw'); pages.forEach(function (p) { p.classList.add('pc3-live-bw'); }); }
        var bg = bw ? '#ffffff' : _pcGetLiveTheme().vars['--lv-bg'];
        var saved = pages.map(function (p) { return { p: p, o: p.style.opacity, pe: p.style.pointerEvents }; });
        var canvases = [], i = 0;
        function finish() {
            if (bw) { body.classList.remove('pc3-live-bw'); pages.forEach(function (p) { p.classList.remove('pc3-live-bw'); }); }
            saved.forEach(function (s) { s.p.style.opacity = s.o; s.p.style.pointerEvents = s.pe; });
            startLivePageTimer();
            cb(canvases.length ? canvases : null);
        }
        function next() {
            if (i >= pages.length) return finish();
            pages.forEach(function (p, idx) { p.style.opacity = idx === i ? '1' : '0'; p.style.pointerEvents = 'none'; });
            requestAnimationFrame(function () { requestAnimationFrame(function () {
                h2c(pages[i], { backgroundColor: bg, scale: 2, logging: false, useCORS: true })
                    .then(function (canvas) { canvases.push(canvas); i++; next(); })
                    .catch(function () { i++; next(); });
            }); });
        }
        next();
    });
}
// Load jsPDF on demand (CDN, same source as html2canvas).
function _pc3LoadJsPDF() {
    return new Promise(function (resolve) {
        var get = function () { return (window.jspdf && window.jspdf.jsPDF) || window.jsPDF || null; };
        if (get()) return resolve(get());
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
        s.onload = function () { resolve(get()); };
        s.onerror = function () { resolve(null); };
        document.head.appendChild(s);
    });
}
// Download — one division per page. Forces "one division per page" layout,
// captures each page in color, and builds a single multi-page PDF (a single
// JPEG can't hold multiple pages; a PDF gives one division per page in one file).
window._pc3LiveDownloadJpeg = function () {
    var prevPerDiv = _liveOneDivPerPage;
    var perdivBtn = document.getElementById('pc3-live-perdiv-btn');
    if (!prevPerDiv) {
        _liveOneDivPerPage = true; _liveWholeCamp = false;
        if (perdivBtn) perdivBtn.classList.add('on');
        _liveRenderSig = '';
        try { renderLiveContent(); } catch (e) {}
    }
    setTimeout(function () {
        _pc3CaptureLivePages(function (canvases) {
            if (!prevPerDiv) { // restore the prior layout
                _liveOneDivPerPage = false;
                if (perdivBtn) perdivBtn.classList.remove('on');
                _liveRenderSig = '';
                try { renderLiveContent(); } catch (e) {}
            }
            if (!canvases) return;
            _pc3LoadJsPDF().then(function (jsPDF) {
                var dateStr = String(window.currentScheduleDate || 'schedule').replace(/[^0-9A-Za-z\-]/g, '');
                if (!jsPDF) { if (window.showToast) window.showToast('Could not load the PDF library (offline?)', 'error'); return; }
                var pdf = null;
                canvases.forEach(function (c, idx) {
                    var w = c.width, h = c.height, orient = w >= h ? 'l' : 'p';
                    if (idx === 0) pdf = new jsPDF({ orientation: orient, unit: 'px', format: [w, h] });
                    else pdf.addPage([w, h], orient);
                    pdf.addImage(c.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, w, h);
                });
                pdf.save('schedule-' + dateStr + '.pdf');
                if (window.showToast) window.showToast('Saved schedule — ' + canvases.length + ' division' + (canvases.length > 1 ? 's, one per page' : ''), 'success');
            });
        }, false); // color
    }, prevPerDiv ? 60 : 560); // wait for the re-render when we had to switch modes
};
window._pc3LivePrint = function () {
    _pc3CaptureLivePages(function (canvases) {
        if (!canvases) return;
        var imgs = canvases.map(function (canvas) {
            return '<img src="' + canvas.toDataURL('image/jpeg', 0.95) + '" style="display:block;width:100%;height:auto;page-break-after:always;">';
        }).join('');
        runPrint('<div style="background:#fff;">' + imgs + '</div>', _currentTemplate);
    }, true); // Print = black & white (Excel-style)
};

// ── Print center → Download / Print the preview as a black-and-white image ──
// Rasterizes each preview division-sheet (one division per page) to a B&W JPEG
// so the regular print UI can export an Excel-style image. Reuses html2canvas.
function _pc3CapturePreviewSheets(cb) {
    var pc = el('pc3-preview-content');
    var sheets = pc ? Array.prototype.slice.call(pc.querySelectorAll('.pc3-sheet')) : [];
    if (!sheets.length) { if (window.showToast) window.showToast('Nothing to export — generate a schedule first.', 'error'); cb(null); return; }
    if (window.showToast) window.showToast('Rendering image…', 'info');
    _pc3LoadH2C().then(function (h2c) {
        if (!h2c) { if (window.showToast) window.showToast('Could not load the image library (offline?)', 'error'); cb(null); return; }
        var prevTransform = pc.style.transform; // capture at 100% (ignore zoom)
        pc.style.transform = 'none';
        // The bw class must be on each CAPTURED sheet (html2canvas clones only
        // that subtree; a class on the parent is lost in the clone).
        sheets.forEach(function (s) { s.classList.add('pc3-bw'); });
        var canvases = [], i = 0;
        function finish() {
            sheets.forEach(function (s) { s.classList.remove('pc3-bw'); });
            pc.style.transform = prevTransform;
            cb(canvases.length ? canvases : null);
        }
        function next() {
            if (i >= sheets.length) return finish();
            requestAnimationFrame(function () { requestAnimationFrame(function () {
                h2c(sheets[i], { backgroundColor: '#ffffff', scale: 2, logging: false, useCORS: true })
                    .then(function (c) { canvases.push(c); i++; next(); })
                    .catch(function () { i++; next(); });
            }); });
        }
        next();
    });
}
window._pc3DownloadImage = function () {
    _pc3CapturePreviewSheets(function (canvases) {
        if (!canvases) return;
        var dateStr = String(window.currentScheduleDate || 'schedule').replace(/[^0-9A-Za-z\-]/g, '');
        canvases.forEach(function (canvas, idx) {
            var a = document.createElement('a');
            a.href = canvas.toDataURL('image/jpeg', 0.95);
            a.download = 'schedule-' + dateStr + (canvases.length > 1 ? '-' + (idx + 1) : '') + '.jpg';
            document.body.appendChild(a); a.click(); a.remove();
        });
        if (window.showToast) window.showToast('Saved ' + canvases.length + ' image' + (canvases.length > 1 ? 's' : ''), 'success');
    });
};
window._pc3PrintImage = function () {
    _pc3CapturePreviewSheets(function (canvases) {
        if (!canvases) return;
        var imgs = canvases.map(function (canvas) {
            return '<img src="' + canvas.toDataURL('image/jpeg', 0.95) + '" style="display:block;width:100%;height:auto;page-break-after:always;">';
        }).join('');
        runPrint('<div style="background:#fff;">' + imgs + '</div>', _currentTemplate);
    });
};

function livePageNav(dir) {
    if (_numLivePages < 1) return;
    _livePageIndex = ((_livePageIndex + dir) % _numLivePages + _numLivePages) % _numLivePages;
    for (var i = 0; i < _numLivePages; i++) {
        var p = document.getElementById('lp-' + i);
        if (!p) continue;
        var active = i === _livePageIndex;
        p.style.opacity = active ? '1' : '0';
        p.style.pointerEvents = active ? 'auto' : 'none';
    }
    updateLivePageIndicator();
    startLivePageTimer();
}

function startLivePageTimer() {
    if (_livePageTimer) clearInterval(_livePageTimer);
    _livePageTimer = null;
    if (_numLivePages < 2) return;
    _livePageTimer = setInterval(function () { livePageNav(1); }, _LIVE_PAGE_MS);
}

// Flip "One division per page" on/off. Each page then shows a single division
// (all its grades and bunks, spilling onto extra pages if needed) and the
// rotation cycles division by division.
function toggleLivePerDiv() {
    _liveOneDivPerPage = !_liveOneDivPerPage;
    try { localStorage.setItem('pc3_live_one_div_per_page', _liveOneDivPerPage ? '1' : '0'); } catch (e) {}
    // Per-division and whole-camp are opposite layouts — turning one on turns
    // the other off.
    if (_liveOneDivPerPage && _liveWholeCamp) {
        _liveWholeCamp = false;
        try { localStorage.setItem('pc3_live_whole_camp', '0'); } catch (e) {}
        var wcb = document.getElementById('pc3-live-wholecamp-btn');
        if (wcb) wcb.classList.remove('on');
    }
    var btn = document.getElementById('pc3-live-perdiv-btn');
    if (btn) btn.classList.toggle('on', _liveOneDivPerPage);
    _livePageIndex = 0;
    _livePrevPageCount = -1; // force the rotation timer to be re-evaluated for the new layout
    _liveRenderSig = '';     // force a real rebuild on the next render
    try { renderLiveContent(); } catch (e) {}
}

// Flip "Whole camp on one screen" on/off — shrink the entire camp onto a single
// non-rotating page. Mutually exclusive with one-division-per-page.
function toggleLiveWholeCamp() {
    _liveWholeCamp = !_liveWholeCamp;
    try { localStorage.setItem('pc3_live_whole_camp', _liveWholeCamp ? '1' : '0'); } catch (e) {}
    if (_liveWholeCamp && _liveOneDivPerPage) {
        _liveOneDivPerPage = false;
        try { localStorage.setItem('pc3_live_one_div_per_page', '0'); } catch (e) {}
        var pdb = document.getElementById('pc3-live-perdiv-btn');
        if (pdb) pdb.classList.remove('on');
    }
    var btn = document.getElementById('pc3-live-wholecamp-btn');
    if (btn) btn.classList.toggle('on', _liveWholeCamp);
    _livePageIndex = 0;
    _livePrevPageCount = -1; // force the rotation timer to be re-evaluated for the new layout
    _liveRenderSig = '';     // force a real rebuild on the next render
    try { renderLiveContent(); } catch (e) {}
}

// Flip "Shared timeline" on/off — one time axis per division, bunks as columns.
// Independent of the page-fit toggles, so it just changes how sections render.
function toggleLiveSharedTimeline() {
    _liveSharedTimeline = !_liveSharedTimeline;
    try { localStorage.setItem('pc3_live_shared_timeline', _liveSharedTimeline ? '1' : '0'); } catch (e) {}
    var btn = document.getElementById('pc3-live-shared-btn');
    if (btn) btn.classList.toggle('on', _liveSharedTimeline);
    _livePageIndex = 0;
    _livePrevPageCount = -1; // force the rotation timer to be re-evaluated for the new layout
    _liveRenderSig = '';     // force a real rebuild on the next render
    try { renderLiveContent(); } catch (e) {}
}

// Open the "Bunks per page" config — a modal where the operator types a page
// number next to each bunk. Bunks sharing a number share a page; blanks fall to
// a trailing page. Applying turns on custom-pages mode.
function openLiveBunkPageConfig() {
    var existing = document.getElementById('pc3-cp-modal');
    if (existing) existing.remove();

    var divs = getDivisions();
    var available = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(getAvailableDivisions()) : getAvailableDivisions().sort(naturalSort);
    if (typeof window.filterDivisionsByDate === 'function') available = window.filterDivisionsByDate(available);

    var rowsHtml = '';
    var idx = 0;
    available.forEach(function (divName) {
        var bunks = (divs[divName] && divs[divName].bunks) ? divs[divName].bunks : [];
        if (!bunks.length) return;
        var parent = (typeof window.getParentDivision === 'function' && window.getParentDivision(divName)) || null;
        var head = parent ? (escHtml(parent) + ' › ' + escHtml(divName)) : escHtml(divName);
        rowsHtml += '<div class="pc3-cp-grade">' + head + '</div>';
        bunks.forEach(function (b) {
            var key = _cpBunkKey(divName, b);
            var val = _liveCustomPageMap[key];
            rowsHtml += '<label class="pc3-cp-row">' +
                '<span class="pc3-cp-bunk">' + escHtml(b) + '</span>' +
                '<input type="number" min="1" step="1" class="pc3-cp-input" data-div="' + escHtml(divName) + '" data-bunk="' + escHtml(b) + '" value="' + (val != null && val !== '' ? escHtml(String(val)) : '') + '" placeholder="page #">' +
                '</label>';
            idx++;
        });
    });
    if (!idx) rowsHtml = '<div class="pc3-cp-empty">No bunks to configure for this day.</div>';

    var overlay = document.createElement('div');
    overlay.id = 'pc3-cp-modal';
    overlay.innerHTML =
        '<div class="pc3-cp-panel">' +
            '<div class="pc3-cp-title">Bunks per page</div>' +
            '<div class="pc3-cp-sub">Type a page number for each bunk. Bunks with the same number share a page; blanks go on a final page.</div>' +
            '<div class="pc3-cp-list">' + rowsHtml + '</div>' +
            '<div class="pc3-cp-foot">' +
                '<button class="pc3-cp-btn pc3-cp-off">Turn off</button>' +
                '<span style="flex:1;"></span>' +
                '<button class="pc3-cp-btn pc3-cp-cancel">Cancel</button>' +
                '<button class="pc3-cp-btn pc3-cp-apply">Apply</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(overlay);

    var close = function () { overlay.remove(); };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.pc3-cp-cancel').addEventListener('click', close);
    overlay.querySelector('.pc3-cp-off').addEventListener('click', function () {
        _liveCustomPages = false;
        try { localStorage.setItem('pc3_live_custom_pages', '0'); } catch (e) {}
        var b = document.getElementById('pc3-live-custompages-btn');
        if (b) b.classList.remove('on');
        close();
        _livePageIndex = 0; _livePrevPageCount = -1; _liveRenderSig = '';
        try { renderLiveContent(); } catch (e) {}
    });
    overlay.querySelector('.pc3-cp-apply').addEventListener('click', function () {
        var map = {};
        overlay.querySelectorAll('.pc3-cp-input').forEach(function (inp) {
            var v = (inp.value || '').trim();
            if (v === '') return;
            map[_cpBunkKey(inp.getAttribute('data-div'), inp.getAttribute('data-bunk'))] = v;
        });
        _liveCustomPageMap = map;
        _liveCustomPages = true;
        try {
            localStorage.setItem('pc3_live_custom_page_map', JSON.stringify(map));
            localStorage.setItem('pc3_live_custom_pages', '1');
        } catch (e) {}
        var b = document.getElementById('pc3-live-custompages-btn');
        if (b) b.classList.add('on');
        close();
        _livePageIndex = 0; _livePrevPageCount = -1; _liveRenderSig = '';
        try { renderLiveContent(); } catch (e) {}
    });
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

    // Build the list of page units. Division + Shared Timeline groups grades by
    // parent division (one unified table per division, each on its own page);
    // week renders once; everything else is one unit per selected item.
    var stripHead = function (s) { return s.replace(/<div class="pc3-sheet-head"[^>]*>[\s\S]*?<\/div>/, ''); };
    var units;
    if (_activeView === 'division' && t.sharedTimeline) {
        units = packDivisionGroups(sel).map(function (g) {
            return { label: g.label, content: stripHead(renderSharedTimelineSheet(g.label, g.grades)) };
        });
    } else if (_activeView === 'week') {
        units = [{ label: '', content: renderWeekSheet(sel) }];
    } else {
        units = sel.map(function (item) {
            var content = _activeView === 'division' ? stripHead(renderDivisionSheet(item))
                : _activeView === 'bunk' ? renderBunkSheet(item)
                : _activeView === 'location' ? renderLocationSheet(item) : '';
            return { label: item, content: content };
        });
    }

    // One division per page: in shared-timeline division view, always break
    // between divisions (don't depend on the "Page breaks" checkbox, which
    // readDesignValues can flip off) — that's the whole point of the layout.
    var forceDivBreak = (_activeView === 'division' && t.sharedTimeline);
    units.forEach(function (u, idx) {
        var pageBreak = ((t.showPageBreaks || forceDivBreak) && idx > 0) ? 'page-break-before:always;' : '';
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
            if (t.showDivisionName && u.label) html += '<div style="font-size:' + Math.max(11, t.headerFontSize - 6) + 'px;font-weight:400;opacity:.85;">' + escHtml(u.label) + '</div>';
            html += '</div>';
        }

        html += u.content;

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
        .replace(/·/g, '-')           // · → -  (plain separator; '*' read like a stray footnote)
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

    // Week view is a single combined sheet; every other view is one sheet per
    // selected item. Building a uniform spec list keeps the styling pass below
    // identical for both and lets week-view export actually produce a file
    // (buildExcelRows has no 'week' branch → used to yield a 0-sheet workbook
    // and XLSX.writeFile would throw).
    // "Combine all bunks" (division view) → ONE sheet with every bunk across
    // all selected grades as columns and a unified time axis down the rows.
    var combinedAllBunks = (_activeView === 'division' && _currentTemplate.layoutMode === 'all-bunks');
    try { console.log('[PrintCenter] Excel export → view=' + _activeView + ' layoutMode=' + _currentTemplate.layoutMode + ' combinedAllBunks=' + combinedAllBunks + ' sel=' + JSON.stringify(sel)); } catch (e) {}
    var sheetSpecs;
    if (_activeView === 'week') {
        sheetSpecs = [{ name: 'Week', rows: buildWeekExcelRows(sel) }];
    } else if (combinedAllBunks) {
        // "Combine all bunks" = the WHOLE camp, split across sheet tabs (bunks on
        // top, time on Y), regardless of which divisions are selected.
        var allCampDivs = Object.keys(getDivisions());
        var combinedSpecs = buildCombinedSheetSpecs(allCampDivs);
        sheetSpecs = (combinedSpecs && combinedSpecs.length)
            ? combinedSpecs
            : sel.map(function (item) { return { name: String(item), rows: buildExcelRows(item) }; });
    } else {
        sheetSpecs = sel.map(function (item) { return { name: String(item), rows: buildExcelRows(item) }; });
    }

    sheetSpecs.forEach(function (spec) {
        var srcRows = spec.rows || [];
        // Metadata for the increment grid (attached by buildExcelRows).
        var extraMerges = srcRows._merges || null;
        var headerRowsSet = srcRows._headerRows || null;
        var freezeRowOverride = srcRows._freezeRow;         // ySplit
        var freezeColOverride = srcRows._freezeCol;         // xSplit
        var vertIncrement = !!srcRows._vertIncrement;       // time-on-Y increment layout
        var rows = sanitizeRows(srcRows);
        if (!rows.length) return;

        // Find the column-header row (first cell is the axis label).
        // Division/bunk/location grids lead with 'Time'; the week grid leads
        // with 'Bunk'. Detecting either keeps freeze-panes + header styling.
        var headerRowIdx = -1;
        if (headerRowsSet && headerRowsSet.length) {
            headerRowIdx = headerRowsSet[headerRowsSet.length - 1]; // last header row (increment labels)
        } else {
            for (var ri = 0; ri < rows.length; ri++) {
                if (rows[ri] && (rows[ri][0] === 'Time' || rows[ri][0] === 'Bunk')) { headerRowIdx = ri; break; }
            }
        }
        var isHeaderRow = function (idx) {
            return headerRowsSet ? headerRowsSet.indexOf(idx) >= 0 : (idx === headerRowIdx);
        };
        // NOTE: deliberately NO empty-cell backfill. A blank slot in the
        // schedule must export as a blank cell — stamping a '-' placeholder
        // injected characters the schedule never had (camps reported the
        // export wasn't "true" to the grid).
        var ws = XLSX.utils.aoa_to_sheet(rows);
        var numCols = 0;
        rows.forEach(function (r) { if (r && r.length > numCols) numCols = r.length; });
        // Make sure title+subtitle rows know about the full column count
        // for merges to span correctly.
        if (numCols < 2) numCols = 2;

        // Column widths — size each column to its widest cell so names
        // (incl. non-Latin/Hebrew) are never clipped. Clamp to a sane range.
        // Vertical increment layout: keep the "Time" column (col 1) compact;
        // auto-size the Period column (0) and every bunk column.
        var cols = [];
        for (var c = 0; c < numCols; c++) {
            if (vertIncrement && c === 1) { cols.push({ wch: 9 }); continue; }
            var maxLen = 0;
            for (var rw = 0; rw < rows.length; rw++) {
                if (rw <= 1) continue; // skip merged title/subtitle rows
                var cellv = rows[rw] && rows[rw][c] != null ? String(rows[rw][c]) : '';
                if (cellv.length > maxLen) maxLen = cellv.length;
            }
            // +2 padding; min 12 so short bunk names still read, max 40 to avoid runaway.
            cols.push({ wch: Math.max(12, Math.min(40, maxLen + 2)) });
        }
        ws['!cols'] = cols;

        // Row heights
        var rowsMeta = [];
        for (var rIdx = 0; rIdx < rows.length; rIdx++) {
            if (rIdx === 0) rowsMeta.push({ hpt: 28 });
            else if (rIdx === 1) rowsMeta.push({ hpt: 18 });
            else if (isHeaderRow(rIdx)) rowsMeta.push({ hpt: 22 });
            else rowsMeta.push({ hpt: 20 });
        }
        ws['!rows'] = rowsMeta;

        // Merge title AND subtitle across all columns, plus any period/activity
        // merges from the increment two-tier grid.
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } },
            { s: { r: 1, c: 0 }, e: { r: 1, c: numCols - 1 } }
        ];
        if (extraMerges && extraMerges.length) ws['!merges'] = ws['!merges'].concat(extraMerges);

        // Freeze header(s) + the left time/label column(s)
        var ySplit = (freezeRowOverride != null) ? freezeRowOverride : (headerRowIdx >= 0 ? headerRowIdx + 1 : -1);
        var xSplit = (freezeColOverride != null) ? freezeColOverride : 1;
        if (ySplit >= 0) {
            ws['!views'] = [{ state: 'frozen', ySplit: ySplit, xSplit: xSplit }];
        }

        // Styled cells (only takes effect with xlsx-js-style)
        if (styled) {
            var titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
            if (ws[titleAddr]) ws[titleAddr].s = STY.title;
            var subtitleAddr = XLSX.utils.encode_cell({ r: 1, c: 0 });
            if (ws[subtitleAddr]) ws[subtitleAddr].s = STY.subtitle;
            for (var rr = 2; rr < rows.length; rr++) {
                var rowVals = rows[rr] || [];
                var isHeader = isHeaderRow(rr);
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
                    } else if (cc === 0 || (vertIncrement && cc === 1)) {
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

        var name = String(spec.name).replace(/[\\\/\?\*\[\]:]/g, '').substring(0, 31) || 'Sheet';
        try { XLSX.utils.book_append_sheet(wb, ws, name); }
        catch (e) { XLSX.utils.book_append_sheet(wb, ws, name + '_' + Math.random().toString(36).slice(2, 5)); }
    });

    // Guard: never hand XLSX.writeFile an empty workbook (it throws). Happens
    // when the selection has no schedule data for the active view.
    if (!wb.SheetNames.length) {
        var wsEmpty = XLSX.utils.aoa_to_sheet([['No schedule data to export for this selection.']]);
        XLSX.utils.book_append_sheet(wb, wsEmpty, 'Schedule');
    }

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

    // ALWAYS load SheetJS first — the Print Center page doesn't include it
    // statically, so checking `typeof XLSX` before loading would never produce
    // an .xlsx. No CSV fallback: if SheetJS can't load, tell the user.
    loadStyledXLSX().then(function () {
        if (typeof XLSX === 'undefined') {
            alert('Could not load the Excel library (network blocked). Please check your connection and try again.');
            return;
        }
        try {
            var wb = buildPolishedWorkbook(sel);
            XLSX.writeFile(wb, 'schedule_' + dateStr + '.xlsx');
        } catch (e) {
            try { console.error('[PrintCenter] Excel export failed:', e); } catch (_e) {}
            alert('Excel export failed: ' + (e && e.message ? e.message : e));
        }
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

    // Display-name alias = exact label: export it verbatim, no location column.
    if (entry._displayName) return { activity: entry._displayName, location: '' };
    var act = entry._activity || entry.sport || '';
    var label = entry._partLabel || act; // ★ Day 19: show "Baking 1/3" for multiPart specials
    var field = pcResolveLocation(entry);

    // If act and field are identical, don't duplicate. Otherwise always keep both
    // the activity name and the location (separate export columns), for sports AND
    // specials (e.g. Basketball → Court 1, Baking → Baking Shop).
    if (act && field && act.toLowerCase() === field.toLowerCase()) {
        return { activity: label, location: '' };
    }
    // If there's a field but it looks like "Activity – Location", split it
    if (!act && field && field.indexOf(' \u2013 ') >= 0) {
        var parts = field.split(' \u2013 ');
        return { activity: parts[0].trim(), location: parts.slice(1).join(' \u2013 ').trim() };
    }
    return { activity: label || field, location: (act && field) ? field : '' };
}

// Combined 7-day grid for the Week view: Bunk × weekday, grouped by division.
// Mirrors renderWeekSheet so the export matches what the user sees on screen.
function buildWeekExcelRows(sel) {
    var rows = [];
    var keys = getWeekDateKeys(window.currentScheduleDate);
    if (!keys.length) return rows;

    var divs = getDivisions();
    var bunkToDiv = {};
    Object.keys(divs).forEach(function (d) {
        ((divs[d] && divs[d].bunks) ? divs[d].bunks : []).forEach(function (b) { bunkToDiv[b] = d; });
    });
    var bunks = (sel || []).filter(function (b) { return bunkToDiv[b]; });
    if (!bunks.length) bunks = Object.keys(bunkToDiv);

    rows.push(['Week at a Glance']);
    rows.push([formatWeekDayLabel(keys[0]) + ' - ' + formatWeekDayLabel(keys[keys.length - 1])]);
    rows.push([]); // spacer
    rows.push(['Bunk'].concat(keys.map(function (k) { return formatWeekDayLabel(k); })));

    var byDiv = {};
    bunks.forEach(function (b) { var d = bunkToDiv[b] || ''; if (!byDiv[d]) byDiv[d] = []; byDiv[d].push(b); });
    var divOrder = (typeof window.getUserDivisionOrder === 'function')
        ? window.getUserDivisionOrder(Object.keys(byDiv))
        : Object.keys(byDiv);

    divOrder.forEach(function (d) {
        if (!byDiv[d]) return;
        rows.push([d]); // division separator row
        byDiv[d].forEach(function (b) {
            var row = [b];
            keys.forEach(function (k) {
                var day = _weekData[k];
                if (!day) { row.push(''); return; }
                var labels = summarizeBunkDay(day.scheduleAssignments || {}, b);
                row.push(labels.join(', '));
            });
            rows.push(row);
        });
    });
    return rows;
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

        // Build the schedule in time-row orientation, then transpose so the
        // sheet matches the website: time across the top (X), bunks down (Y).
        var grid = [];
        var slotMeta = []; // aligned 1:1 with grid data rows — { startMin, endMin, label }
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
            grid.push(['Time'].concat(bunks));

            // Data rows
            timeSlots.forEach(function (ts) {
                // Per-bunk: each bunk's own cell. League games show
                // "Football - Football Field 1 - Bunk 1 vs 2" (the matchup for
                // THAT bunk); everything else uses the normal cell text.
                var row = [ts.label];
                bunks.forEach(function (bk) {
                    var bunkSched = getPerBunkSchedule(bk, item);
                    var foundIdx = -1;
                    for (var i = 0; i < bunkSched.length; i++) {
                        var bs = bunkSched[i];
                        if (bs.startMin === ts.startMin && bs.endMin === ts.endMin) { foundIdx = i; break; }
                        if (bs.startMin < ts.endMin && bs.endMin > ts.startMin) { foundIdx = i; break; }
                    }
                    var text = '';
                    if (foundIdx >= 0) {
                        var e = getEntry(bk, foundIdx);
                        if (e && (e._league || e._h2h)) {
                            var lg = pcLeagueLabel(e, bk, item, ts.startMin);
                            text = _currentTemplate.hideLeagueMatchups
                                ? ([lg.sport, lg.field].filter(Boolean).join(' - ') || (e._gameLabel || 'League Game'))
                                : lg.full;
                        } else {
                            text = getExportCellText(bk, foundIdx);
                        }
                    }
                    row.push(text);
                });
                grid.push(row);
                slotMeta.push({ startMin: ts.startMin, endMin: ts.endMin, label: ts.label });
            });
        } else {
            // ★★★ MANUAL MODE: Skeleton-based slot grid ★★★
            var blocks = buildDivisionBlocks(item);
            grid.push(['Time'].concat(bunks));

            blocks.forEach(function (eb) {
                var row = [eb.label];
                if (eb.isLeague) {
                    // Each bunk shows its own matchup: "Football - Field 1 - Bunk 1 vs 2".
                    bunks.forEach(function (b) {
                        if (_currentTemplate.hideLeagueMatchups) { row.push(eb.event || 'League Game'); return; }
                        var ml = buildLeagueMatchups(eb, item, b);
                        row.push(ml.length ? ml.join(', ') : (eb.event || 'League Game'));
                    });
                } else {
                    bunks.forEach(function (b) {
                        var si = findFirstSlotForTime(eb.startMin, item);
                        var text = si >= 0 ? getExportCellText(b, si) : '';
                        row.push(text);
                    });
                }
                grid.push(row);
                slotMeta.push({ startMin: eb.startMin, endMin: eb.endMin, label: eb.label });
            });
        }

        // ─── Layout: bunks across the top (X), time down the rows (Y) ───
        // When increments are on, each period is split into increment ROWS:
        // a "Period" column (the range, merged down its rows) + a "Time" column
        // (the increment ticks) on the left, then one column per bunk with each
        // activity merged down the increment rows it spans. Periods anchor to
        // their own start time (12:20 → 12:20, 12:30…). Falls back to one row
        // per period when nothing is longer than a single increment.
        var incOn = _timeIncrement > 0 &&
                    slotMeta.some(function (s) { return (s.endMin - s.startMin) > _timeIncrement; });
        if (grid.length > 1 && incOn) {
            var inc = _timeIncrement;
            var incLabel = function (min) {
                var h = Math.floor(min / 60), m = min % 60;
                var h12 = ((h + 11) % 12) + 1;
                return h12 + ':' + (m < 10 ? '0' + m : m);
            };
            var merges = [];
            var headerRowIdx = rows.length;
            rows.push(['Period', 'Time'].concat(bunks));

            slotMeta.forEach(function (sm, si2) {
                var times = [];
                for (var t = sm.startMin; t < sm.endMin; t += inc) times.push(t);
                if (!times.length) times.push(sm.startMin);
                var rowStart = rows.length;
                times.forEach(function (tk, k) {
                    var line = [k === 0 ? sm.label : '', incLabel(tk)];
                    bunks.forEach(function (bk, bi) {
                        line.push(k === 0 ? (grid[si2 + 1][bi + 1] || '') : '');
                    });
                    rows.push(line);
                });
                var rowEnd = rows.length - 1;
                if (times.length > 1) {
                    // Period label merged down its increment rows.
                    merges.push({ s: { r: rowStart, c: 0 }, e: { r: rowEnd, c: 0 } });
                    // Each bunk's activity merged down its increment rows.
                    bunks.forEach(function (bk, bi) {
                        merges.push({ s: { r: rowStart, c: 2 + bi }, e: { r: rowEnd, c: 2 + bi } });
                    });
                }
            });

            rows._merges = merges;
            rows._headerRows = [headerRowIdx];
            rows._freezeRow = headerRowIdx + 1;
            rows._freezeCol = 2;
            rows._vertIncrement = true;
        } else if (grid.length > 1) {
            // Simple: bunks across the top, one row per period (Time | Bunk1 | …).
            grid.forEach(function (r) { rows.push(r); });
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
                    // League row: Activity = "Football - Bunk 1 vs 2", Location = field.
                    var lg = pcLeagueLabel(entry, item, dn, slot.startMin);
                    var actCol = _currentTemplate.hideLeagueMatchups
                        ? (lg.sport || entry._gameLabel || 'League Game')
                        : ([lg.sport, lg.matchup].filter(Boolean).join(' - ') || (entry._gameLabel || 'League Game'));
                    rows.push([slot.label, actCol, lg.field || '']);
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
                    // Activity = "Football - Field 1 - Bunk 1 vs 2" (this bunk's game).
                    var ml = _currentTemplate.hideLeagueMatchups ? [] : buildLeagueMatchups(slot, dn, item);
                    var leagueText = ml.length ? ml.join(', ') : (slot.event || 'League Game');
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

// Per-bunk activity list as { startMin, endMin, value } for either builder mode.
// Used by the combined all-bunks export, which needs a uniform time axis.
function pcBunkActivityList(bunk, div) {
    var out = [];
    if (isAutoMode()) {
        var slots = getPerBunkSchedule(bunk, div);
        for (var i = 0; i < slots.length; i++) {
            var entry = getEntry(bunk, i);
            if (entry && entry.continuation && out.length) { out[out.length - 1].endMin = slots[i].endMin; continue; }
            var val = '';
            if (entry && (entry._league || entry._h2h)) {
                var lg = pcLeagueLabel(entry, bunk, div, slots[i].startMin);
                val = _currentTemplate.hideLeagueMatchups
                    ? ([lg.sport, lg.field].filter(Boolean).join(' - ') || (entry._gameLabel || 'League Game'))
                    : lg.full;
            } else {
                val = entry ? formatEntry(entry) : '';
            }
            out.push({ startMin: slots[i].startMin, endMin: slots[i].endMin, value: val });
        }
    } else {
        var blocks = buildDivisionBlocks(div);
        blocks.forEach(function (eb) {
            var val = '';
            if (eb.isLeague) {
                var ml = _currentTemplate.hideLeagueMatchups ? [] : buildLeagueMatchups(eb, div, bunk);
                val = ml.length ? ml.join(', ') : (eb.event || 'League Game');
            } else {
                var si = findFirstSlotForTime(eb.startMin, div);
                val = si >= 0 ? getExportCellText(bunk, si) : '';
            }
            out.push({ startMin: eb.startMin, endMin: eb.endMin, value: val });
        });
    }
    return out;
}

// Combined ALL-BUNKS export. Every bunk in the camp is a column with a UNIFIED
// time axis down the rows (built from every activity boundary plus the increment
// ticks, so grades on different clocks all line up). Because the whole camp is
// a lot of columns, the result is split across multiple sheet tabs — each tab
// holds a chunk of bunks (kept grade-aligned where possible) with bunks on top
// and time on Y. Returns an array of { name, rows } sheet specs.
function buildCombinedSheetSpecs(divNames) {
    var dateStr = window.currentScheduleDate || '';
    var mode = isAutoMode() ? 'Auto' : 'Manual';
    var inc = _timeIncrement > 0 ? _timeIncrement : 15;
    var divs = getDivisions();

    var orderedDivs = (typeof window.getUserDivisionOrder === 'function')
        ? window.getUserDivisionOrder(divNames) : divNames.slice();
    orderedDivs = (orderedDivs || []).filter(function (d) { return divs[d] && divs[d].bunks && divs[d].bunks.length; });
    if (!orderedDivs.length) orderedDivs = (divNames || []).filter(function (d) { return divs[d] && divs[d].bunks && divs[d].bunks.length; });

    // Grade blocks (each keeps its bunks together).
    var gradeBlocks = [];
    orderedDivs.forEach(function (d) {
        var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).slice();
        if (!bunks.length) return;
        gradeBlocks.push({ div: d, cols: bunks.map(function (b) { return { bunk: b, div: d }; }) });
    });
    if (!gradeBlocks.length) return [];

    // Per-bunk activity lists + global time span.
    var listMap = {};
    var globalStart = Infinity, globalEnd = -Infinity;
    gradeBlocks.forEach(function (gb) {
        gb.cols.forEach(function (c) {
            var l = pcBunkActivityList(c.bunk, c.div);
            listMap[c.div + '|' + c.bunk] = l;
            l.forEach(function (a) {
                if (a.startMin < globalStart) globalStart = a.startMin;
                if (a.endMin > globalEnd) globalEnd = a.endMin;
            });
        });
    });
    if (globalStart === Infinity) return [];

    // Unified row axis = increment ticks ∪ every activity edge.
    var bset = {};
    bset[globalStart] = true; bset[globalEnd] = true;
    for (var t = Math.ceil(globalStart / inc) * inc; t < globalEnd; t += inc) bset[t] = true;
    gradeBlocks.forEach(function (gb) { gb.cols.forEach(function (c) {
        listMap[c.div + '|' + c.bunk].forEach(function (a) {
            if (a.startMin >= globalStart && a.startMin <= globalEnd) bset[a.startMin] = true;
            if (a.endMin >= globalStart && a.endMin <= globalEnd) bset[a.endMin] = true;
        });
    }); });
    var bounds = Object.keys(bset).map(Number).sort(function (a, b) { return a - b; });
    var rowDefs = [];
    for (var bi = 0; bi < bounds.length - 1; bi++) rowDefs.push({ start: bounds[bi], end: bounds[bi + 1] });

    var incLabel = function (min) {
        var h = Math.floor(min / 60), m = min % 60;
        var h12 = ((h + 11) % 12) + 1;
        return h12 + ':' + (m < 10 ? '0' + m : m);
    };

    // Every bunk in the camp on ONE sheet, in a single long row across the top
    // (col B = first bunk, col C = second, … to the last bunk).
    var chunks = [gradeBlocks];

    var specs = [];
    chunks.forEach(function (chunkBlocks, ci) {
        var colDefs = [];
        chunkBlocks.forEach(function (gb) { gb.cols.forEach(function (c) { colDefs.push(c); }); });

        var rows = [];
        var suffix = chunks.length > 1 ? ' (' + (ci + 1) + ' of ' + chunks.length + ')' : '';
        rows.push(['All Bunks' + suffix]);
        rows.push([formatDisplayDate(dateStr) + '  ·  ' + mode + ' Builder']);
        rows.push([]);
        var divHeaderRow = rows.length;
        var bunkHeaderRow = divHeaderRow + 1;
        var firstDataRow = bunkHeaderRow + 1;

        var merges = [];
        var divRow = new Array(1 + colDefs.length).fill('');
        var cursor = 1;
        chunkBlocks.forEach(function (gb) {
            var startCol = cursor, endCol = cursor + gb.cols.length - 1;
            divRow[startCol] = gb.div;
            if (endCol > startCol) merges.push({ s: { r: divHeaderRow, c: startCol }, e: { r: divHeaderRow, c: endCol } });
            cursor = endCol + 1;
        });
        rows.push(divRow);
        rows.push(['Time'].concat(colDefs.map(function (c) { return c.bunk; })));
        merges.push({ s: { r: divHeaderRow, c: 0 }, e: { r: bunkHeaderRow, c: 0 } });

        rowDefs.forEach(function (rd) {
            var line = [incLabel(rd.start)];
            colDefs.forEach(function () { line.push(''); });
            rows.push(line);
        });

        colDefs.forEach(function (c, cidx) {
            var col = 1 + cidx;
            var list = listMap[c.div + '|' + c.bunk] || [];
            var runStart = -1, runKey = null, runValue = '';
            for (var ri = 0; ri <= rowDefs.length; ri++) {
                var act = null;
                if (ri < rowDefs.length) {
                    var rs = rowDefs[ri].start;
                    for (var ai = 0; ai < list.length; ai++) {
                        if (list[ai].startMin <= rs && list[ai].endMin > rs) { act = list[ai]; break; }
                    }
                }
                var key = act ? (act.startMin + '-' + act.endMin) : null;
                if (key !== runKey) {
                    if (runStart >= 0 && runValue) {
                        var rStart = firstDataRow + runStart;
                        var rEnd = firstDataRow + ri - 1;
                        rows[rStart][col] = runValue;
                        if (rEnd > rStart) merges.push({ s: { r: rStart, c: col }, e: { r: rEnd, c: col } });
                    }
                    runStart = ri; runKey = key; runValue = act ? act.value : '';
                }
            }
        });

        rows._merges = merges;
        rows._headerRows = [divHeaderRow, bunkHeaderRow];
        rows._freezeRow = firstDataRow;
        rows._freezeCol = 1;
        specs.push({ name: chunks.length > 1 ? ('Bunks ' + (ci + 1)) : 'All Bunks', rows: rows });
    });
    return specs;
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
    // Mirror the Excel sheet structure: one block per item, the combined
    // whole-camp grid, or the week grid. Unicode is normalised the same way as
    // the .xlsx path so the CSV is just as "crisp" (no en-dashes / mojibake).
    var combinedAllBunks = (_activeView === 'division' && _currentTemplate.layoutMode === 'all-bunks');
    var specs;
    if (_activeView === 'week') {
        specs = [{ rows: buildWeekExcelRows(sel) }];
    } else if (combinedAllBunks) {
        var cs = buildCombinedSheetSpecs(Object.keys(getDivisions()));
        specs = (cs && cs.length) ? cs : sel.map(function (item) { return { rows: buildExcelRows(item) }; });
    } else {
        specs = sel.map(function (item) { return { rows: buildExcelRows(item) }; });
    }
    specs.forEach(function (spec, idx) {
        if (idx > 0) lines.push(''); // blank separator between blocks
        (spec.rows || []).forEach(function (row) {
            lines.push(row.map(function (c) {
                var v = (typeof c === 'string') ? sanitizeForExcel(c) : c;
                return '"' + csvSafeCell(v).replace(/"/g, '""') + '"';
            }).join(','));
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

    // Live screen theme chips — persist the choice and, if a kiosk window is
    // already open, re-skin it instantly (localStorage is shared, so a fresh
    // Live View picks it up on boot regardless).
    document.querySelectorAll('[data-live-theme]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var id = this.getAttribute('data-live-theme');
            try { localStorage.setItem(_LIVE_THEME_KEY, id); } catch (e) {}
            document.querySelectorAll('[data-live-theme]').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-live-theme') === id);
            });
            try {
                if (_liveWindow && !_liveWindow.closed && _liveWindow._pcApplyLiveTheme) _liveWindow._pcApplyLiveTheme(id);
            } catch (e) {}
        });
    });

    // Popovers — Packs / Output / Style / Layout
    var popoverPairs = [
        ['pc3-packs-btn', 'pc3-packs-menu'],
        ['pc3-userpacks-btn', 'pc3-userpacks-menu'],
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

    // User pack apply — "Apply" buttons (whole-camp packs) and division
    // dropdowns (division-scoped packs). Either configures the print center and
    // closes the Packs popover so the operator can hit Print.
    document.querySelectorAll('.pcx-up-go').forEach(function (btn) {
        btn.addEventListener('click', function () {
            window._pc3ApplyUserPack && window._pc3ApplyUserPack(this.getAttribute('data-userpack'), null);
            setTimeout(closeAllPopovers, 0);
        });
    });
    document.querySelectorAll('.pcx-up-sel').forEach(function (sel) {
        sel.addEventListener('change', function () {
            window._pc3ApplyUserPack && window._pc3ApplyUserPack(this.getAttribute('data-userpack'), this.value || null);
            setTimeout(closeAllPopovers, 0);
        });
    });

    // Saved layouts
    var saveBtn = el('pc3-save-layout-btn');
    if (saveBtn) saveBtn.addEventListener('click', function () { window._pc3SaveLayout(); });
    renderSavedLayoutsList();

    // Rail options — every toggle/select re-reads design values and re-renders.
    ['pc3-show-date', 'pc3-combined', 'pc3-hide-matchups', 'pc3-orientation', 'pc3-paper-size', 'pc3-transpose'].forEach(function (id) {
        var e = el(id);
        if (e) e.addEventListener('change', function () { readDesignValues(); liveRefresh(); });
    });

    // Legacy Style menu (if present) — harmless no-op in the new shell.
    var styleMenu = el('pc3-style-menu');
    if (styleMenu) styleMenu.addEventListener('change', function () { readDesignValues(); liveRefresh(); });

    // Time increment selector
    var incSel = el('pc3-time-increment');
    if (incSel) incSel.addEventListener('change', function () {
        _timeIncrement = parseInt(this.value) || 15;
        _activityAligned = false; // increment only matters with uniform columns
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
            if (e.key === 'f' || e.key === 'F') { e.preventDefault(); window._pc3ToggleFocus(); return; }
        }
        if (e.key === 'Escape') {
            // Exit focus mode first if it's on
            if (_focusMode) { window._pc3ToggleFocus(); e.preventDefault(); return; }
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
    // Columns are activity-aligned by default (each activity sized to its real
    // duration); the increment picker switches to uniform fixed columns on demand.
    // Restore the saved choice so increment mode (and its Excel layout) persists.
    _activityAligned = true;
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

// Apply a role/recipient pack, optionally scoped to a single division.
// divisionName: a division to scope to, or null for the pack's default
// ('all' packs ignore it; division packs fall back to all when null).
window._pc3ApplyUserPack = function (packId, divisionName) {
    var pack = USER_PACKS.filter(function (p) { return p.id === packId; })[0];
    if (!pack) return;
    // 1. Preset (color scheme)
    if (pack.preset) window._pc3ApplyPreset(pack.preset);
    // 2. Layout flags. Clear opt-in flags first so they never leak between
    //    packs (only the Shared Timeline pack turns sharedTimeline back on).
    _currentTemplate.sharedTimeline = false;
    if (pack.layout) {
        Object.keys(pack.layout).forEach(function (k) { _currentTemplate[k] = pack.layout[k]; });
        if (Object.prototype.hasOwnProperty.call(pack.layout, 'pageBreakPerBunk')) {
            _pageBreakPerBunk = !!pack.layout.pageBreakPerBunk;
            try { localStorage.setItem('campistry_pc3_pageBreakPerBunk', _pageBreakPerBunk ? '1' : '0'); } catch (e) {}
            var rootPB = document.getElementById('pc3-root');
            if (rootPB) rootPB.classList.toggle('pc3-pb-per-bunk', _pageBreakPerBunk);
            var pbCb = el('pc3-page-break-bunk'); if (pbCb) pbCb.checked = _pageBreakPerBunk;
        }
    }
    // 3. Switch view (rebuilds the sidebar items for that view)
    if (pack.view && pack.view !== _activeView) {
        _activeView = pack.view;
        document.querySelectorAll('[data-view]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-view') === pack.view);
        });
        if (_activeView === 'week') ensureWeekDataLoaded(false);
    }
    // Always repopulate so the checkbox set matches the (possibly unchanged) view.
    populateSidebar();
    // 4. Scoped selection
    var allCbs = document.querySelectorAll('.pc3-item-cb');
    if (pack.scope === 'division' && divisionName) {
        // Division view: check only the chosen division's item.
        allCbs.forEach(function (cb) { cb.checked = (cb.getAttribute('data-item') === divisionName); });
    } else if (pack.scope === 'division-bunks' && divisionName) {
        // Bunk view: check only the bunks grouped under the chosen division.
        var esc = (window.CSS && CSS.escape) ? CSS.escape(divisionName) : divisionName;
        var grp = document.querySelector('.pc3-sidebar-group[data-group="' + esc + '"]');
        allCbs.forEach(function (cb) { cb.checked = false; });
        if (grp) grp.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = true; });
    } else {
        // 'all', or a division pack with no division chosen → everything.
        allCbs.forEach(function (cb) { cb.checked = true; });
    }
    updateSidebarSelectionUI && updateSidebarSelectionUI();
    // 5. Sync the Options checkboxes so the UI reflects the pack
    var cbCombined = el('pc3-combined'); if (cbCombined) cbCombined.checked = (_currentTemplate.layoutMode === 'all-bunks');
    var hm = el('pc3-hide-matchups'); if (hm) hm.checked = !!_currentTemplate.hideLeagueMatchups;
    var orient = el('pc3-orientation'); if (orient) orient.value = _currentTemplate.orientation || 'landscape';
    liveRefresh();
    if (window.showToast) {
        var label = pack.name + (divisionName ? ' · ' + divisionName : '');
        window.showToast(label + ' pack ready — hit Print', 'info');
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
        sharedTimeline: _currentTemplate.sharedTimeline,
        showPageBreaks: _currentTemplate.showPageBreaks,
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
window._pc3ToggleFullscreen = function () {
    _isFullscreen = !_isFullscreen;
    var root = el('pc3-root');
    if (root) root.classList.toggle('pc3-fullscreen', _isFullscreen);
};
var _focusMode = false;
window._pc3ToggleFocus = function () {
    _focusMode = !_focusMode;
    var root = el('pc3-root');
    if (root) root.classList.toggle('pc3-focus', _focusMode);
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
// Exposed so the (popup) Live View can be re-skinned from its own boot AND so
// the opener can push a theme change into an already-open kiosk window.
window._pcApplyLiveTheme = _pcApplyLiveTheme;
// "One division per page" toggle uses inline onclick="toggleLivePerDiv()",
// which resolves against the popup window's global scope — export it like
// livePageNav so the button isn't a silent no-op.
window.toggleLivePerDiv = toggleLivePerDiv;
// "Whole camp on one screen" toggle — exported for the popup's inline onclick.
window.toggleLiveWholeCamp = toggleLiveWholeCamp;
// "Shared timeline" toggle — exported for the popup's inline onclick.
window.toggleLiveSharedTimeline = toggleLiveSharedTimeline;
// "Bunks per page" config — exported for the popup's inline onclick.
window.openLiveBunkPageConfig = openLiveBunkPageConfig;
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
