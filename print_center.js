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
var _previewHtml = '';
var _cloudSyncTimeout = null;
var _liveInterval = null;
var _liveCursorInterval = null;
var _liveWindow = null;
var _timeIncrement = 15; // minutes: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60
var CLOUD_SYNC_DEBOUNCE = 2000;

// Excel-style cell selection state
var _selAnchor = null;   // {sheet, r, c}
var _selFocus  = null;   // {sheet, r, c}
var _activeSheet = null; // table element id of currently focused sheet

// =========================================================================
// UTILITY HELPERS
// =========================================================================
function el(id) { return document.getElementById(id); }
function escHtml(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function parseTimeToMinutes(t) {
    if (t === null || t === undefined) return null;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getHours() * 60 + t.getMinutes();
    var s = String(t).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!m) return null;
    var h = parseInt(m[1]), mm = parseInt(m[2]);
    if (m[3]) { var ap = m[3].toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
    return h * 60 + mm;
}
function minutesToTimeLabel(mins) {
    if (mins === null || mins === undefined) return '';
    var h24 = Math.floor(mins / 60), m = mins % 60;
    var ap = h24 >= 12 ? 'PM' : 'AM';
    var h12 = h24 % 12 || 12;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
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

function formatEntry(entry) {
    if (!entry) return '';
    if (entry.continuation) return '';
    if (entry._isTransition) return entry.sport || 'Transition';
    var parts = [];
    var act = entry._activity || entry.sport || '';
    var field = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
    if (act && field && act !== field && field.indexOf(act) === -1 && act.indexOf(field) === -1) {
        parts.push(act); parts.push(field);
    } else if (field) { parts.push(field); }
    else if (act) { parts.push(act); }
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
    var divBunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).sort(naturalSort);
    var lc = 0, sc2 = 0;
    var blocks = [];
    var la = window.leagueAssignments || {};
    var divKey = divName;

    sorted.forEach(function (bl) {
        var evName = bl.item.event || bl.item.type || '';
        var isLeagueBlock = (bl.item.type === 'league' || bl.item.type === 'specialty_league' || evName === 'League Game' || evName === 'Specialty League' || evName.toLowerCase().indexOf('league') >= 0);
        var ev = evName;
        if (isLeagueBlock) {
            var isSpecialty = (bl.item.type === 'specialty_league' || evName === 'Specialty League');
            var divLA = la[divKey] || {};
            var si_la = bl.startMin;
            var foundLabel = null;
            var trySlots = [si_la];
            for (var off = 1; off <= 2; off++) { trySlots.push(si_la + off, si_la - off); }
            for (var ts = 0; ts < trySlots.length && !foundLabel; ts++) {
                var sd = divLA[trySlots[ts]];
                if (sd && sd.gameLabel) foundLabel = sd.gameLabel;
            }
            if (foundLabel) { ev = foundLabel; }
            else { if (isSpecialty) { sc2++; ev = 'Specialty League ' + sc2; } else { lc++; ev = 'League Game ' + lc; } }
        }
        blocks.push({
            label: minutesToTimeLabel(bl.startMin) + ' \u2013 ' + minutesToTimeLabel(bl.endMin),
            startMin: bl.startMin, endMin: bl.endMin,
            event: ev, type: bl.item.type, isLeague: isLeagueBlock
        });
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
function buildLeagueMatchups(eventBlock, divName) {
    var matchups = [];
    var la = window.leagueAssignments || {};
    var divLA = la[divName] || {};

    // Strategy 1: Exact startMin match
    var allSlotEntries = [];
    Object.keys(divLA).forEach(function (k) {
        var slotData = divLA[k];
        if (!slotData) return;
        var sk = parseInt(k);
        if (Math.abs(sk - eventBlock.startMin) <= 2) {
            allSlotEntries.push({ key: k, data: slotData });
        }
    });

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
function deleteTemplate(tid) { _savedTemplates = _savedTemplates.filter(function (t) { return t.id !== tid; }); saveTemplates(); return true; }
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
    /* ── Container ── */
    '.pc3{font-family:"DM Sans",system-ui,sans-serif;font-size:13px;color:#1E293B;display:flex;flex-direction:column;height:100%;min-height:0;background:#f5f5f4;position:relative;}' +
    '.pc3.pc3-fullscreen{position:fixed;inset:0;z-index:9999;background:#f5f5f4;}' +

    /* ── Toolbar ── */
    '.pc3-topbar{display:flex;align-items:center;gap:10px;padding:0 14px;height:50px;background:#fff;border-bottom:1px solid #e5e5e5;flex-shrink:0;}' +
    '.pc3-topbar-name{font-size:14px;font-weight:500;color:#1a1a1a;}' +
    '.pc3-topbar-date{font-size:12px;color:#666;padding:2px 9px;background:#f5f5f4;border-radius:6px;}' +
    '.pc3-topbar-sep{width:0.5px;height:18px;background:#e5e5e5;flex-shrink:0;}' +
    '.pc3-topbar-space{flex:1;}' +
    '.pc3-toolbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#fff;border-bottom:1px solid #e2e8f0;flex-shrink:0;flex-wrap:wrap;min-height:36px;}' +
    '.pc3-toolbar-group{display:flex;align-items:center;gap:4px;}' +
    '.pc3-toolbar-sep{width:1px;height:20px;background:#e2e8f0;margin:0 4px;}' +
    '.pc3-tb-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#334155;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:all .15s;}' +
    '.pc3-tb-btn:hover{background:#f8fafc;border-color:#cbd5e1;box-shadow:0 1px 2px rgba(0,0,0,.04);}' +
    '.pc3-tb-btn.active{background:#147D91;color:#fff;border-color:#147D91;}' +
    '.pc3-tb-btn.primary{background:#147D91;color:#fff;border-color:#0F6E80;}' +
    '.pc3-tb-btn.primary:hover{background:#0F6E80;}' +
    '.pc3-tb-btn.danger{color:#dc2626;border-color:#fecaca;}' +
    '.pc3-tb-btn.danger:hover{background:#fef2f2;}' +
    '.pc3-tb-btn.live{background:#dc2626;color:#fff;border-color:#dc2626;animation:pc3-pulse 2s infinite;}' +
    '@keyframes pc3-pulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.4)}50%{box-shadow:0 0 0 6px rgba(220,38,38,0)}}' +
    '.pc3-tb-select{padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-family:inherit;background:#fff;cursor:pointer;}' +
    '.pc3-tb-label{font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.3px;}' +

    /* ── Formula Bar ── */
    '.pc3-formula{display:flex;align-items:center;gap:8px;padding:3px 10px;background:#fafbfc;border-bottom:1px solid #e2e8f0;flex-shrink:0;font-size:12px;min-height:26px;}' +
    '.pc3-formula-cell{font-weight:700;color:#147D91;min-width:80px;font-size:11px;}' +
    '.pc3-formula-val{flex:1;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '.pc3-formula-mode{margin-left:auto;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:4px;}' +
    '.pc3-formula-mode.auto{background:#dbeafe;color:#1e40af;}' +
    '.pc3-formula-mode.manual{background:#f0fdf4;color:#166534;}' +

    /* ── Workspace ── */
    '.pc3-workspace{flex:1;display:flex;min-height:0;overflow:hidden;position:relative;}' +

    /* ── Sidebar ── */
    '.pc3-sidebar{width:220px;background:#fff;border-right:1px solid #e2e8f0;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;transition:width .2s;}' +
    '.pc3-sidebar.collapsed{width:0;border-right:none;}' +
    '.pc3-sidebar-header{padding:8px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;font-size:12px;color:#475569;display:flex;align-items:center;justify-content:space-between;}' +
    '.pc3-sidebar-scroll{flex:1;overflow-y:auto;padding:6px 8px;}' +
    '.pc3-sidebar-group{margin-bottom:10px;}' +
    '.pc3-sidebar-group-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin-bottom:4px;padding:0 4px;}' +
    '.pc3-item{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px;transition:background .1s;}' +
    '.pc3-item:hover{background:#f1f5f9;}' +
    '.pc3-item.selected{background:#e0f2fe;color:#0369a1;}' +
    '.pc3-item input[type="checkbox"]{accent-color:#147D91;margin:0;cursor:pointer;}' +
    '.pc3-item-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.pc3-item-count{font-size:10px;color:#94a3b8;font-weight:600;}' +
    '.pc3-sidebar-actions{padding:6px 8px;border-top:1px solid #e2e8f0;display:flex;gap:4px;}' +
    '.pc3-sidebar-actions button{flex:1;font-size:10px;padding:3px 6px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;cursor:pointer;font-family:inherit;color:#475569;}' +
    '.pc3-sidebar-actions button:hover{background:#f1f5f9;}' +

    /* ── Grid Preview ── */
    '.pc3-grid-area{flex:1;overflow:auto;background:#e8ecf0;padding:16px;min-height:0;}' +
    '.pc3-grid-area.live-bg{background:#111827;padding:0;}' +
    '.pc3-sheet{background:#fff;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04);margin-bottom:16px;overflow:auto;position:relative;}' +

    /* ── Spreadsheet Table ── */
    '.pc3-tbl{border-collapse:collapse;width:100%;table-layout:auto;user-select:none;}' +
    '.pc3-tbl th,.pc3-tbl td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left;white-space:nowrap;position:relative;transition:background .1s;}' +
    '.pc3-tbl th{background:#f1f5f9;font-weight:600;position:sticky;z-index:2;font-size:11px;color:#475569;}' +
    '.pc3-tbl thead th{top:0;}' +
    '.pc3-tbl th.corner{z-index:3;left:0;top:0;background:#e8ecf0;}' +
    '.pc3-tbl th.row-head{position:sticky;left:0;z-index:2;background:#f8fafc;font-weight:600;}' +
    '.pc3-tbl td:hover{outline:2px solid #147D91;outline-offset:-1px;z-index:1;}' +
    '.pc3-tbl tr:nth-child(even) td{background:#fafbfd;}' +
    '.pc3-tbl .cell-free{color:#94a3b8;font-style:italic;}' +
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
    '.pc3-sheet-head{padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #e2e8f0;}' +
    '.pc3-sheet-title{font-size:15px;font-weight:700;color:#1e293b;}' +
    '.pc3-sheet-subtitle{font-size:11px;color:#94a3b8;}' +
    '.pc3-sheet-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:#f0fdf4;color:#166534;}' +

    /* ── League Matchups ── */
    '.pc3-matchup{display:inline-block;margin:1px 4px 1px 0;padding:1px 6px;background:rgba(30,64,175,.06);border:1px solid rgba(30,64,175,.1);border-radius:3px;font-size:10px;white-space:nowrap;}' +

    /* ── Live Mode ── */
    '.pc3-live-overlay{position:absolute;inset:0;z-index:100;background:#111827;display:flex;flex-direction:column;overflow:hidden;}' +
    '.pc3-live-header{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;background:rgba(0,0,0,.3);flex-shrink:0;}' +
    '.pc3-live-title{font-size:24px;font-weight:800;color:#fff;}' +
    '.pc3-live-clock{font-size:36px;font-weight:300;color:#fbbf24;font-variant-numeric:tabular-nums;}' +
    '.pc3-live-close{padding:8px 16px;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:rgba(255,255,255,.1);color:#fff;font-size:13px;cursor:pointer;}' +
    '.pc3-live-close:hover{background:rgba(255,255,255,.2);}' +
    '.pc3-live-body{flex:1;overflow:auto;padding:16px 24px;}' +
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

    /* ── Zoom ── */
    '.pc3-zoom{display:flex;align-items:center;gap:4px;}' +
    '.pc3-zoom input[type="range"]{width:80px;height:4px;accent-color:#147D91;}' +
    '.pc3-zoom-label{font-size:10px;color:#64748b;min-width:32px;text-align:center;}' +

    /* ── Print overrides ── */
    '@media print{.no-print,.pc3-toolbar,.pc3-formula,.pc3-sidebar,.pc3-drawer{display:none!important;}.pc3{background:#fff!important;}.pc3-grid-area{background:#fff!important;padding:0!important;overflow:visible!important;}.pc3-sheet{box-shadow:none!important;border-radius:0!important;}}' +
    '</style>';
}

// =========================================================================
// MAIN UI BUILDER
// =========================================================================
function buildMainUI() {
    var t = _currentTemplate;
    var mode = isAutoMode() ? 'auto' : 'manual';
    return getStyles() +
    '<div class="pc3' + (_isFullscreen ? ' pc3-fullscreen' : '') + '" id="pc3-root">' +

    /* ── Toolbar ── */
    '<div class="pc3-topbar no-print">' +
        '<span class="pc3-topbar-name">' + (t.campName || 'Camp Schedule') + '</span>' +
        '<div class="pc3-topbar-sep"></div>' +
        '<span class="pc3-topbar-date">' + (window.currentScheduleDate ? formatDisplayDate(window.currentScheduleDate) : '') + '</span>' +
        '<div class="pc3-topbar-space"></div>' +
        '<button class="pc3-tb-btn" id="pc3-live-btn" title="Open Live View in a new window">' + ICO.monitor + ' Live View</button>' +
        (canEditTemplates() ? '<button class="pc3-tb-btn" onclick="window._pc3ToggleAdvanced()" title="Design settings">' + ICO.gear + '</button>' : '') +
        '<button class="pc3-tb-btn" onclick="window._pc3ExportExcel()">' + ICO.excel + ' Excel</button>' +
        '<button class="pc3-tb-btn primary" onclick="window._pc3Print()">' + ICO.print + ' Print</button>' +
    '</div>' +

    '<div class="pc3-toolbar no-print">' +
        '<div class="pc3-toolbar-group">' +
            '<span class="pc3-tb-label">View</span>' +
            '<button class="pc3-tb-btn' + (_activeView === 'division' ? ' active' : '') + '" data-view="division">' + ICO.grid + ' Divisions</button>' +
            '<button class="pc3-tb-btn' + (_activeView === 'bunk' ? ' active' : '') + '" data-view="bunk">' + ICO.user + ' Bunks</button>' +
            '<button class="pc3-tb-btn' + (_activeView === 'location' ? ' active' : '') + '" data-view="location">' + ICO.mapPin + ' Locations</button>' +
        '</div>' +
        '<div class="pc3-toolbar-sep"></div>' +
        '<div class="pc3-toolbar-group">' +
            '<label class="pc3-tb-btn" style="cursor:pointer;"><input type="checkbox" id="pc3-transpose" style="accent-color:#147D91;margin-right:4px;"' + (t.tableOrientation === 'time-top' ? ' checked' : '') + '>Transpose</label>' +
            '<label class="pc3-tb-btn" style="cursor:pointer;"><input type="checkbox" id="pc3-combined" style="accent-color:#147D91;margin-right:4px;"' + (t.layoutMode === 'all-bunks' ? ' checked' : '') + '>Combined</label>' +
            '<label class="pc3-tb-btn" style="cursor:pointer;"><input type="checkbox" id="pc3-hide-matchups" style="accent-color:#147D91;margin-right:4px;"' + (t.hideLeagueMatchups ? ' checked' : '') + '>Hide Matchups</label>' +
        '</div>' +
        /* Time increment selector — visible in all modes but most relevant for auto */
        '<div class="pc3-toolbar-sep"></div>' +
        '<div class="pc3-toolbar-group">' +
            '<span class="pc3-tb-label">Sub-segment</span>' +
            '<select id="pc3-time-increment" class="pc3-tb-select" title="Sub-segment increment within each period">' +
                (function () {
                    var opts = '';
                    for (var iv = 5; iv <= 60; iv += 5) {
                        opts += '<option value="' + iv + '"' + (_timeIncrement === iv ? ' selected' : '') + '>' + iv + ' min</option>';
                    }
                    return opts;
                })() +
            '</select>' +
        '</div>' +
        '<div class="pc3-toolbar-sep"></div>' +
        '<div class="pc3-toolbar-group">' +
            '<select id="pc3-template-select" class="pc3-tb-select"><option value="default">Default Template</option></select>' +
            (canEditTemplates() ? '<button class="pc3-tb-btn" onclick="window._pc3SaveTemplate()" title="Save as template">' + ICO.save + '</button>' : '') +
        '</div>' +
        '<div style="flex:1;"></div>' +
        '<div class="pc3-toolbar-group">' +
            '<div class="pc3-zoom">' +
                '<span class="pc3-tb-label" style="margin-right:2px;">Zoom</span>' +
                '<button class="pc3-tb-btn" onclick="window._pc3Zoom(-10)">' + ICO.zoomOut + '</button>' +
                '<input type="range" min="50" max="200" value="' + _zoomLevel + '" id="pc3-zoom-range">' +
                '<button class="pc3-tb-btn" onclick="window._pc3Zoom(10)">' + ICO.zoomIn + '</button>' +
                '<span class="pc3-zoom-label" id="pc3-zoom-label">' + _zoomLevel + '%</span>' +
            '</div>' +
            '<button class="pc3-tb-btn" onclick="window._pc3ToggleFullscreen()">' + ICO.expand + '</button>' +
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
        '<div class="pc3-sidebar" id="pc3-sidebar">' +
            '<div class="pc3-sidebar-header"><span id="pc3-sidebar-title">Divisions</span></div>' +
            '<div class="pc3-sidebar-scroll" id="pc3-sidebar-scroll"></div>' +
            '<div class="pc3-sidebar-actions"><button onclick="window._pc3SelectAll()">Select All</button><button onclick="window._pc3SelectNone()">Clear</button></div>' +
        '</div>' +

        /* Grid Area */
        '<div class="pc3-grid-area" id="pc3-grid-area">' +
            '<div id="pc3-preview-empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;">' +
                '<div style="text-align:center;">' +
                    '<div style="font-size:32px;margin-bottom:6px;opacity:.4;">' + ICO.grid + '</div>' +
                    '<p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#64748b;">Select items from the sidebar</p>' +
                    '<p style="margin:0;font-size:12px;">Your schedule will render as a spreadsheet</p>' +
                '</div>' +
            '</div>' +
            '<div id="pc3-preview-content" style="display:none;"></div>' +
        '</div>' +

        /* Advanced Drawer */
        '<div class="pc3-drawer' + (_advancedOpen ? ' open' : '') + '" id="pc3-drawer">' +
            '<div class="pc3-drawer-header"><span>' + ICO.gear + ' Design Settings</span><button class="pc3-tb-btn" onclick="window._pc3ToggleAdvanced()" style="padding:2px 6px;">' + ICO.x + '</button></div>' +
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
    return '' +
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
    if (!container) return;
    var html = '';
    var divs = getDivisions();

    if (_activeView === 'division') {
        if (titleEl) titleEl.textContent = 'Divisions';
        var available = getAvailableDivisions();
        available.sort(naturalSort);
        available.forEach(function (d) {
            var bunkCount = divs[d] && divs[d].bunks ? divs[d].bunks.length : 0;
            html += '<div class="pc3-item"><input type="checkbox" class="pc3-item-cb" data-item="' + escHtml(d) + '" checked><span class="pc3-item-label">' + escHtml(d) + '</span><span class="pc3-item-count">' + bunkCount + ' bunks</span></div>';
        });
    } else if (_activeView === 'bunk') {
        if (titleEl) titleEl.textContent = 'Bunks';
        var available2 = getAvailableDivisions();
        available2.sort(naturalSort);
        available2.forEach(function (d) {
            var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).sort(naturalSort);
            if (!bunks.length) return;
            html += '<div class="pc3-sidebar-group"><div class="pc3-sidebar-group-title">' + escHtml(d) + '</div>';
            bunks.forEach(function (b) {
                html += '<div class="pc3-item"><input type="checkbox" class="pc3-item-cb" data-item="' + escHtml(b) + '" checked><span class="pc3-item-label">' + escHtml(b) + '</span></div>';
            });
            html += '</div>';
        });
    } else if (_activeView === 'location') {
        if (titleEl) titleEl.textContent = 'Locations';
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
            html += '<div class="pc3-item"><input type="checkbox" class="pc3-item-cb" data-item="' + escHtml(loc) + '" checked><span class="pc3-item-label">' + escHtml(loc) + '</span></div>';
        });
    }
    container.innerHTML = html;
    container.querySelectorAll('.pc3-item-cb').forEach(function (cb) {
        cb.addEventListener('change', function () { liveRefresh(); });
    });
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
    var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).sort(naturalSort);
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
    dayStart = Math.floor(dayStart / inc) * inc;
    dayEnd = Math.ceil(dayEnd / inc) * inc;

    // ─── 2. Identify "Periods" from the bell schedule (DAW layer templates) ─────
    // The bell schedule defines layer windows — each layer has a type, startMin, endMin.
    // Variable layers (sport, special, activity, elective) = the "Periods" where bunks
    // have different activities. Pinned layers (swim, lunch, custom, etc.) are NOT periods.
    var VARIABLE_LAYER_TYPES = { 'slot': 1, 'sport': 1, 'special': 1, 'activity': 1, 'sports': 1, 'elective': 1 };
    var activityRanges = []; // [ { startMin, endMin } ]

    // Method 1: Read from DAW layer templates (bell schedule) — authoritative
    var bellLayers = getBellScheduleLayers(divName);
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
                var isVariable = VARIABLE_LAYER_TYPES[(slot.type || '').toLowerCase()] === 1;
                if (isVariable) {
                    if (curRange && slot.startMin <= curRange.endMin) {
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

    // If still nothing, treat entire day as one period
    if (activityRanges.length === 0) {
        activityRanges.push({ startMin: dayStart, endMin: dayEnd });
    }

    // ─── 3. Build the full time-column array covering dayStart → dayEnd ─────
    // Every increment gets a column. We also tag each column with which period it belongs to.
    var timeCols = []; // [ { startMin, endMin, label, periodIdx (-1 if not in a period) } ]
    for (var t = dayStart; t < dayEnd; t += inc) {
        var colEnd = Math.min(t + inc, dayEnd);
        var pIdx = -1;
        for (var ri = 0; ri < activityRanges.length; ri++) {
            // Column is in this period if it overlaps
            if (t >= activityRanges[ri].startMin && t < activityRanges[ri].endMin) { pIdx = ri; break; }
        }
        timeCols.push({ startMin: t, endMin: colEnd, label: minutesToTimeLabel(t), periodIdx: pIdx });
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

    // ── HEADER ROW 2 (data row 2): Sub-time increment labels ──
    html += '<tr>';
    var colW = Math.max(36, Math.min(80, 700 / numCols));
    timeCols.forEach(function (col, idx) {
        var bgStyle = col.periodIdx >= 0 ? '' : 'background:#f8fafc;';
        html += '<th data-r="1" data-c="' + (1 + idx) + '" data-cell-text="' + escHtml(col.label) + '" style="min-width:' + colW + 'px;width:' + colW + 'px;font-size:' + (inc <= 10 ? 8 : 9) + 'px;white-space:nowrap;padding:2px;text-align:center;font-weight:500;color:#64748b;' + bgStyle + '">' + col.label + '</th>';
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
                if (locText) displayText += ' \u2013 ' + locText;
                var durMin = matchAct.endMin - matchAct.startMin;

                html += '<td';
                if (span > 1) html += ' colspan="' + span + '"';
                html += ' class="cell-' + type + '" data-r="' + rowR + '" data-c="' + (1 + colIdx) + '" data-cell-text="' + escHtml(displayText) + '" data-bunk="' + escHtml(bunk) + '" data-slot="' + matchAct.slotIdx + '" data-div="' + escHtml(divName) + '"';
                html += ' title="' + escHtml(displayText + ' (' + durMin + ' min)') + '"';
                var pillBg = type === 'pinned' ? '#FFF8E1' : type === 'league' ? '#EFF6FF' : type === 'free' ? '#F9FAFB' : '#EEF6FF';
                var pillTx = type === 'pinned' ? '#92400E' : type === 'league' ? '#1E40AF' : type === 'free' ? '#94A3B8' : '#1E3A5F';
                html += ' style="padding:3px;vertical-align:middle;">';
                html += '<div style="border-radius:5px;background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;min-height:38px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;">';
                html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' + escHtml(actText || displayText) + '</span>';
                if (durMin > inc) html += '<span style="font-size:9px;opacity:.65;margin-top:1px;">' + durMin + 'm</span>';
                html += '</div></td>';

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
        if (eb.isLeague && !_currentTemplate.hideLeagueMatchups) {
            var matchups = buildLeagueMatchups(eb, divName);
            var mHtml = '<strong>' + escHtml(eb.event) + '</strong>';
            if (matchups.length) { mHtml += '<div>'; matchups.forEach(function (mu) { mHtml += '<span class="pc3-matchup">' + escHtml(mu) + '</span>'; }); mHtml += '</div>'; }
            html += '<td class="cell-league" data-r="' + rowR + '" data-c="1" data-cell-text="' + escHtml(eb.event) + '" colspan="' + bunks.length + '" style="text-align:center;">' + mHtml + '</td>';
        } else {
            bunks.forEach(function (b, bi) {
                var si = findFirstSlotForTime(eb.startMin, divName);
                var entry = si >= 0 ? getEntry(b, si) : null;
                var type = getEntryType(entry);
                var text = entry ? formatEntry(entry) : '';
                if (!text && type === 'free') text = '\u2014';
                if (eb.isLeague && _currentTemplate.hideLeagueMatchups) { text = eb.event; type = 'league'; }
                html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="' + (1 + bi) + '" data-cell-text="' + escHtml(text) + '" data-bunk="' + escHtml(b) + '" data-slot="' + si + '" data-div="' + escHtml(divName) + '">' + escHtml(text) + '</td>';
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
            if (!text && type === 'free') text = '\u2014';
            if (eb.isLeague) { text = eb.event; type = 'league'; }
            html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="' + (1 + blkIdx) + '" data-cell-text="' + escHtml(text) + '" data-bunk="' + escHtml(b) + '" data-slot="' + si + '" data-div="' + escHtml(divName) + '">' + escHtml(text) + '</td>';
        });
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

// ── Bunk View ──
function renderBunkSheet(bunk) {
    var t = _currentTemplate;
    var divs = getDivisions(), dn = null;
    for (var d in divs) { if (divs[d].bunks && divs[d].bunks.indexOf(bunk) >= 0) { dn = d; break; } }
    var schedule = isAutoMode() ? getPerBunkSchedule(bunk, dn) : [];

    if (!isAutoMode()) {
        // Build from division blocks
        var blocks = dn ? buildDivisionBlocks(dn) : [];
        schedule = blocks.map(function (b) { return { startMin: b.startMin, endMin: b.endMin, label: b.label, event: b.event, isLeague: b.isLeague }; });
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
        var slotIdx = isAutoMode() ? idx : findFirstSlotForTime(slot.startMin, dn);
        var entry = slotIdx >= 0 ? getEntry(bunk, slotIdx) : null;
        var type = getEntryType(entry);
        var act = '', loc = '';
        if (entry && !entry.continuation) {
            act = entry._activity || entry.sport || '';
            loc = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');
            if (!act && loc) { act = loc; loc = ''; }
        }
        var actDisplay = act || '\u2014';
        html += '<tr data-block-start="' + slot.startMin + '" data-block-end="' + slot.endMin + '">';
        html += pcRowNum(rowR);
        html += '<th class="row-head" data-r="' + rowR + '" data-c="0" data-cell-text="' + escHtml(slot.label) + '">' + slot.label + '</th>';
        html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="1" data-cell-text="' + escHtml(actDisplay) + '">' + escHtml(actDisplay) + '</td>';
        html += '<td class="cell-' + type + '" data-r="' + rowR + '" data-c="2" data-cell-text="' + escHtml(loc) + '">' + escHtml(loc) + '</td>';
        html += '</tr>';
    });

    html += '</tbody></table></div></div>';
    return html;
}

// ── Location View ──
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

    if (isAutoMode()) {
        // ★★★ AUTO MODE: Each bunk has its own slot indices ★★★
        // We must iterate each bunk individually using its per-bunk slots
        Object.keys(divs).sort(naturalSort).forEach(function (dn) {
            var bunks = (divs[dn].bunks || []).sort(naturalSort);
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
        Object.keys(divs).sort(naturalSort).forEach(function (dn) {
            var divSlots = window.divisionTimes && window.divisionTimes[dn] ? window.divisionTimes[dn] : [];
            var bunks = (divs[dn].bunks || []).sort(naturalSort);
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

    // Sort by start time and sort bunk lists within each entry
    return Object.values(byTimeLabel)
        .sort(function (a, b) { return a.startMin - b.startMin; })
        .map(function (entry) {
            entry.bunks.sort(naturalSort);
            return entry;
        });
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
    var VARIABLE_LAYER_TYPES = { 'slot': 1, 'sport': 1, 'special': 1, 'activity': 1, 'sports': 1, 'elective': 1 };

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
    dayStart = Math.floor(dayStart / inc) * inc;
    dayEnd = Math.ceil(dayEnd / inc) * inc;

    // Build activity ranges from bell schedule (use first div)
    var activityRanges = [];
    var bellLayers = firstDiv ? getBellScheduleLayers(firstDiv) : null;
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
    if (!activityRanges.length) activityRanges.push({ startMin: dayStart, endMin: dayEnd, name: null });

    // Build time columns
    var timeCols = [];
    for (var t = dayStart; t < dayEnd; t += inc) {
        var pIdx = -1;
        for (var ri = 0; ri < activityRanges.length; ri++) {
            if (t >= activityRanges[ri].startMin && t < activityRanges[ri].endMin) { pIdx = ri; break; }
        }
        timeCols.push({ startMin: t, endMin: Math.min(t + inc, dayEnd), label: minutesToTimeLabel(t), periodIdx: pIdx });
    }
    var numCols = timeCols.length;
    var colW = Math.max(44, Math.min(90, 800 / numCols));

    var sheetId = pcNextSheetId();
    var html = '<div class="pc3-sheet-table-wrap" style="overflow:auto;">';
    html += '<table class="pc3-tbl" id="' + sheetId + '" data-sheet-id="' + sheetId + '" data-grid-mode="auto" style="table-layout:fixed;border-collapse:collapse;">';
    html += '<thead>';

    // Period header row
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

    // Sub-segment time label row
    html += '<tr>';
    timeCols.forEach(function (col) {
        var bg = col.periodIdx >= 0 ? '#f0f9ff' : '#f8fafc';
        html += '<th style="min-width:' + colW + 'px;width:' + colW + 'px;font-size:' + (inc <= 10 ? 8 : 9) + 'px;text-align:center;padding:2px;color:#64748b;background:' + bg + ';border:1px solid #e2e8f0;font-weight:500;">' + col.label + '</th>';
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
                html += '<div style="border-radius:5px;background:' + pillBg + ';color:' + pillTx + ';padding:3px 6px;min-height:38px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;">';
                html += '<span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">' + escHtml(displayText) + '</span>';
                if (durMin > inc) html += '<span style="font-size:9px;opacity:.65;margin-top:1px;">' + durMin + 'm</span>';
                html += '</div></td>';
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
        if (_currentTemplate.layoutMode === 'all-bunks' && isAutoMode()) {
            // Combined: gather ALL bunks across all selected divisions → one unified table
            var allDivBunks = [];
            var divs = getDivisions();
            sel.forEach(function (d) {
                var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).sort(naturalSort);
                bunks.forEach(function (b) { allDivBunks.push({ bunk: b, div: d }); });
            });
            html += '<div class="pc3-sheet">';
            if (allDivBunks.length) html += renderCombinedAutoTable(allDivBunks);
            html += '</div>';
        } else if (_currentTemplate.layoutMode === 'all-bunks') {
            // Manual combined
            html += '<div class="pc3-sheet">';
            sel.forEach(function (d) {
                var bunks = (divs[d] && divs[d].bunks ? divs[d].bunks : []).sort(naturalSort);
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
            '<div class="pc3-live-clock" id="pc3-live-clock"></div>' +
            '<button class="pc3-live-close" onclick="window.close()">Close</button>' +
        '</div>' +
        '<div class="pc3-live-body" id="pc3-live-body"></div>' +
        '</div>';

    // Set the title once data is loaded (fall back to "Camp Schedule")
    function refreshTitle() {
        try {
            var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
            var nm = g.campName || (g.app1 ? g.app1.campName : '') || 'Camp Schedule';
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
    document.querySelectorAll('.pc3-live-section').forEach(function (s) { positionLiveCursor(s); });
}

function renderLiveContent() {
    var body = el('pc3-live-body');
    if (!body) return;
    var nowMin = getNowMinutes();
    var divs = getDivisions();
    var available = getAvailableDivisions().sort(naturalSort);
    var html = '';

    available.forEach(function (divName) {
        var bunks = (divs[divName] && divs[divName].bunks ? divs[divName].bunks : []).sort(naturalSort);
        if (!bunks.length) return;

        // Compute section dayStart/dayEnd for cursor placement
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

        html += '<div class="pc3-live-section" data-day-start="' + sectionStart + '" data-day-end="' + sectionEnd + '" data-cursor-mode="' + cursorMode + '" style="margin-bottom:24px;position:relative;">';
        html += '<div style="font-size:18px;font-weight:700;color:#fbbf24;margin-bottom:8px;padding-left:4px;">' + escHtml(divName) + '</div>';
        // Cursor + time tag (positioned by JS)
        html += '<div class="pc3-live-cursor-' + (cursorMode === 'auto' ? 'v' : 'h') + '"></div>';
        html += '<div class="pc3-live-now-tag tag-' + (cursorMode === 'auto' ? 'v' : 'h') + '"></div>';

        if (isAutoMode()) {
            // ★★★ AUTO LIVE: Spreadsheet grid with current-time column highlighted ★★★
            var inc = _timeIncrement;
            var lDayStart = Infinity, lDayEnd = -Infinity;
            var lBunkActs = {};
            bunks.forEach(function (bunk) {
                var slots = getPerBunkSchedule(bunk, divName);
                var acts = [];
                for (var i = 0; i < slots.length; i++) {
                    var entry = getEntry(bunk, i);
                    if (entry && entry.continuation && acts.length > 0) { acts[acts.length - 1].endMin = slots[i].endMin; continue; }
                    acts.push({ startMin: slots[i].startMin, endMin: slots[i].endMin, entry: entry, type: entry ? getEntryType(entry) : 'free' });
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

            html += '<div style="overflow-x:auto;"><table class="pc3-live-tbl" style="table-layout:fixed;">';
            // Header
            html += '<thead><tr><th class="corner" style="min-width:80px;">Bunk</th>';
            lTimeCols.forEach(function (tc) {
                var isCurCol = nowMin >= tc.startMin && nowMin < tc.endMin;
                html += '<th data-time-start="' + tc.startMin + '" data-time-end="' + tc.endMin + '" style="min-width:50px;font-size:9px;text-align:center;white-space:nowrap;' + (isCurCol ? 'background:#164e63;color:#67e8f9;box-shadow:inset 0 -3px 0 #fbbf24;' : '') + '">' + tc.label + '</th>';
            });
            html += '</tr></thead><tbody>';

            // Bunk rows
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
                        var txt = mAct.entry ? (mAct.entry._activity || mAct.entry.sport || formatEntry(mAct.entry)) : '\u2014';
                        var cls = 'cell-' + mAct.type;
                        if (isCur) cls += ' cell-current';
                        if (isPast) cls += ' cell-past';
                        html += '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + ' class="' + cls + '" style="text-align:center;font-size:11px;">' + escHtml(txt) + '</td>';
                        ci = nextCi;
                    } else {
                        var isCC = nowMin >= cStart && nowMin < cEnd;
                        html += '<td class="cell-free' + (isCC ? ' cell-current' : '') + '" style="text-align:center;">\u2014</td>';
                        ci++;
                    }
                }
                html += '</tr>';
            });

            html += '</tbody></table></div>';

        } else {
            // ★★★ MANUAL LIVE: Table view (existing) ★★★
            var timeSlots = buildDivisionBlocks(divName);
            html += '<table class="pc3-live-tbl"><thead><tr><th class="corner">Time</th>';
            bunks.forEach(function (b) { html += '<th>' + escHtml(b) + '</th>'; });
            html += '</tr></thead><tbody>';

            timeSlots.forEach(function (ts) {
                var isCurrent = nowMin >= ts.startMin && nowMin < ts.endMin;
                var isPast = nowMin >= ts.endMin;
                html += '<tr data-block-start="' + ts.startMin + '" data-block-end="' + ts.endMin + '">';
                html += '<th class="row-head' + (isCurrent ? ' cell-current' : '') + (isPast ? ' cell-past' : '') + '">' + ts.label + '</th>';
                bunks.forEach(function (bunk) {
                    var slotIdx = findFirstSlotForTime(ts.startMin, divName);
                    var entry = slotIdx >= 0 ? getEntry(bunk, slotIdx) : null;
                    var type = getEntryType(entry);
                    var text = entry ? formatEntry(entry) : '\u2014';
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
    });

    body.innerHTML = html;
}

// =========================================================================
// PRINT & EXPORT
// =========================================================================
function triggerPrint() {
    var sel = getSelectedItems();
    if (!sel.length) return alert('Select at least one item to print.');
    readDesignValues();
    var t = _currentTemplate;

    // Build print HTML with inline styles for printer
    var printHtml = buildPrintHTML(sel);
    var printArea = el('printable-area');
    if (printArea) { printArea.innerHTML = printHtml; printArea.style.display = 'block'; }

    var style = document.createElement('style');
    style.id = 'pc3-print-style';
    style.textContent = '@page{size:' + t.paperSize + ' ' + t.orientation + ';margin:0.4in;}' +
        '@media print{body>*:not(#printable-area){display:none!important;}#printable-area{display:block!important;}}';
    document.head.appendChild(style);

    setTimeout(function () {
        window.print();
        setTimeout(function () {
            if (printArea) { printArea.innerHTML = ''; printArea.style.display = 'none'; }
            var ps = document.getElementById('pc3-print-style');
            if (ps) ps.remove();
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

        // Footer
        if (t.footerEnabled && t.footerText) {
            html += '<div style="text-align:center;padding:8px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;">' + escHtml(t.footerText) + '</div>';
        }

        html += '</div>';
    });
    return html;
}

function exportExcel() {
    var sel = getSelectedItems();
    if (!sel.length) return alert('Select at least one item to export.');
    var dateStr = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    readDesignValues();

    // Use SheetJS if available
    if (typeof XLSX === 'undefined') {
        var csv = buildCSV(sel);
        downloadFile(csv, 'schedule_' + dateStr + '.csv', 'text/csv');
        return;
    }
    var wb = XLSX.utils.book_new();
    sel.forEach(function (item) {
        var rows = buildExcelRows(item);
        // Sheet name max 31 chars, no special chars
        var name = String(item).replace(/[\\\/\?\*\[\]:]/g, '').substring(0, 31) || 'Sheet';
        try { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name); }
        catch (e) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name + '_' + Math.random().toString(36).slice(2,5)); }
    });
    XLSX.writeFile(wb, 'schedule_' + dateStr + '.xlsx');
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
    var field = typeof entry.field === 'string' ? entry.field : (entry.field && entry.field.name ? entry.field.name : '');

    // If act and field are the same, don't duplicate
    if (act && field && (act === field || field.indexOf(act) >= 0)) {
        return { activity: field, location: '' };
    }
    if (act && field && act.indexOf(field) >= 0) {
        return { activity: act, location: '' };
    }
    // If there's a field but it looks like "Activity – Location", split it
    if (!act && field && field.indexOf(' \u2013 ') >= 0) {
        var parts = field.split(' \u2013 ');
        return { activity: parts[0].trim(), location: parts.slice(1).join(' \u2013 ').trim() };
    }
    return { activity: act || field, location: (act && field) ? field : '' };
}

function buildExcelRows(item) {
    var divs = getDivisions();
    var rows = [];
    var dateStr = window.currentScheduleDate || '';
    var mode = isAutoMode() ? 'Auto' : 'Manual';

    if (_activeView === 'division') {
        // ─── Division header rows ───
        var bunks = (divs[item] && divs[item].bunks ? divs[item].bunks : []).sort(naturalSort);
        rows.push([item + ' — ' + formatDisplayDate(dateStr), '', '', '', mode + ' Builder']);
        rows.push([]); // blank row

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
                                var laEntry = divLA[ts.startMin] || divLA[String(ts.startMin)];
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

        rows.push([item + (dn ? ' (' + dn + ')' : '') + ' — ' + formatDisplayDate(dateStr), '', '', mode + ' Builder']);
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
                        var laEntry = divLA[slot.startMin] || divLA[String(slot.startMin)];
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
        rows.push([item + ' — ' + formatDisplayDate(dateStr), '', mode + ' Builder']);
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

function buildCSV(sel) {
    var lines = [];
    sel.forEach(function (item, idx) {
        if (idx > 0) lines.push(''); // blank separator between items
        var rows = buildExcelRows(item);
        rows.forEach(function (row) {
            lines.push(row.map(function (c) { return '"' + String(c || '').replace(/"/g, '""') + '"'; }).join(','));
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
            populateSidebar();
            liveRefresh();
        });
    });

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

    // Live mode
    var liveBtn = el('pc3-live-btn');
    if (liveBtn) liveBtn.addEventListener('click', openLiveWindow);

    // Advanced drawer design change listeners
    var drawerScroll = el('pc3-drawer-scroll');
    if (drawerScroll) {
        drawerScroll.addEventListener('input', function () { readDesignValues(); liveRefresh(); });
        drawerScroll.addEventListener('change', function () { readDesignValues(); liveRefresh(); });
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
        if (e.key === 'Escape') {
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

    // Restore saved time increment
    try { var savedInc = localStorage.getItem('campistry_pc3_timeIncrement'); if (savedInc) _timeIncrement = parseInt(savedInc) || 15; } catch (e) {}

    loadTemplates();
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
};
window._pc3ToggleFullscreen = function () {
    _isFullscreen = !_isFullscreen;
    var root = el('pc3-root');
    if (root) root.classList.toggle('pc3-fullscreen', _isFullscreen);
};
window._pc3ToggleAdvanced = function () {
    _advancedOpen = !_advancedOpen;
    var drawer = el('pc3-drawer');
    if (drawer) drawer.classList.toggle('open', _advancedOpen);
};
window._pc3SelectAll = function () {
    document.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = true; });
    liveRefresh();
};
window._pc3SelectNone = function () {
    document.querySelectorAll('.pc3-item-cb').forEach(function (cb) { cb.checked = false; });
    liveRefresh();
};
window._pc3Print = triggerPrint;
window._pc3ExportExcel = exportExcel;
window._pc3OpenLive = openLiveWindow;
window._pc3RunLiveStandalone = runLiveStandalone;
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
