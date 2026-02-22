// =================================================================
// auto_schedule_planner.js (v2.0 - LAYER-BASED AUTO BUILDER)
// =================================================================
// Horizontal timeline grid where users define scheduling layers
// per grade. Layers = time window + activity type + quantity rule.
//
// v2.0 CHANGES:
//  - WHITE theme (no dark mode)
//  - Timeline range = earliest grade start → latest grade end
//  - Unused grade time shaded grey (diagonal hatch)
//  - Time labels visible on band + on drag ghost
//  - Duration indicator on every band ("40m")
//  - PIN / EXACT button: locks layer to exact time window
//  - Wired to AutoSkeletonBuilder (not AutoScheduleSolver)
//
// LAYER → BUILDER FIELD MAP:
//   layer.pinExact   → pinExact   (builder Phase 1 check)
//   layer.periodMin  → periodMin  (builder Phase 4 slot duration)
//   layer.quantity   → quantity   (builder Phase 4 count)
//   layer.startMin   → startMin
//   layer.endMin     → endMin
//   layer.type       → type
//   layer.event      → event
//
// Integration: Lives inside Master Schedule Builder as Auto mode tab.
//              Outputs layer templates that AutoSkeletonBuilder
//              converts into standard skeletons.
// =================================================================

(function() {
'use strict';

// =================================================================
// MODULE STATE
// =================================================================
let layerContainer = null;
let layers = [];
let selectedLayerId = null;
let currentTemplate = null;
let hasChanges = false;

// Grid config
const HOUR_WIDTH = 120;     // pixels per hour
const MIN_WIDTH = HOUR_WIDTH / 60;
const SNAP_MINUTES = 5;

// Drag state
let dragState = null;

// =================================================================
// LAYER COLORS (matches master builder palette)
// =================================================================
const LAYER_COLORS = {
  sport:            { bg: 'rgba(134,239,172,0.55)', border: '#22c55e', text: '#14532d' },
  sports:           { bg: 'rgba(134,239,172,0.55)', border: '#22c55e', text: '#14532d' },
  special:          { bg: 'rgba(196,181,253,0.55)', border: '#8b5cf6', text: '#3b1f6b' },
  activity:         { bg: 'rgba(147,197,253,0.55)', border: '#3b82f6', text: '#1e3a5f' },
  lunch:            { bg: 'rgba(253,186,116,0.70)', border: '#f97316', text: '#7c2d12' },
  swim:             { bg: 'rgba(103,232,249,0.55)', border: '#06b6d4', text: '#164e63' },
  snack:            { bg: 'rgba(253,230,138,0.65)', border: '#eab308', text: '#78350f' },
  snacks:           { bg: 'rgba(253,230,138,0.65)', border: '#eab308', text: '#78350f' },
  dismissal:        { bg: 'rgba(249,168,212,0.55)', border: '#ec4899', text: '#831843' },
  league:           { bg: 'rgba(252,165,165,0.55)', border: '#ef4444', text: '#7f1d1d' },
  specialty_league: { bg: 'rgba(253,164,175,0.55)', border: '#f43f5e', text: '#881337' },
  elective:         { bg: 'rgba(240,171,252,0.55)', border: '#d946ef', text: '#701a75' },
  split:            { bg: 'rgba(253,186,116,0.55)', border: '#f97316', text: '#7c2d12' },
  custom:           { bg: 'rgba(209,213,219,0.55)', border: '#6b7280', text: '#374151' }
};

// Palette tile definitions
const PALETTE_TILES = [
  { type: 'sports',    name: 'Sport',             defaultDuration: 40, defaultOp: '\u2265', defaultQty: 1, fixed: false },
  { type: 'special',   name: 'Special Activity',  defaultDuration: 40, defaultOp: '\u2265', defaultQty: 1, fixed: false },
  { type: 'activity',  name: 'Activity',          defaultDuration: 40, defaultOp: '\u2265', defaultQty: 1, fixed: false },
  { type: 'lunch',     name: 'Lunch',             defaultDuration: 30, defaultOp: '=',      defaultQty: 1, fixed: true },
  { type: 'swim',      name: 'Swim',              defaultDuration: 40, defaultOp: '=',      defaultQty: 1, fixed: true },
  { type: 'snacks',    name: 'Snack',             defaultDuration: 15, defaultOp: '=',      defaultQty: 1, fixed: true },
  { type: 'dismissal', name: 'Dismissal',         defaultDuration: 15, defaultOp: '=',      defaultQty: 1, fixed: true },
  { type: 'league',    name: 'League Game',        defaultDuration: 50, defaultOp: '\u2264', defaultQty: 1, fixed: false },
  { type: 'elective',  name: 'Elective',          defaultDuration: 40, defaultOp: '\u2265', defaultQty: 1, fixed: false },
  { type: 'split',     name: 'Split Activity',    defaultDuration: 40, defaultOp: '\u2265', defaultQty: 1, fixed: false },
  { type: 'custom',    name: 'Custom',            defaultDuration: 30, defaultOp: '=',      defaultQty: 1, fixed: false }
];

// =================================================================
// HELPERS
// =================================================================
function fmtTime(min) {
  if (min == null) return '';
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ap;
}

function fmtShort(min) {
  if (min == null) return '';
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return m === 0 ? h + ap : h + ':' + String(m).padStart(2, '0') + ap;
}

function parseTime(str) {
  if (str == null) return null;
  if (typeof str === 'number') return str;
  let s = String(str).toLowerCase().trim();
  if (!s) return null;
  const isPM = s.includes('pm'), isAM = s.includes('am');
  s = s.replace(/am|pm/g, '').trim();
  const parts = s.split(':');
  let h = parseInt(parts[0], 10);
  if (isNaN(h)) return null;
  const m = parseInt(parts[1], 10) || 0;
  if (isPM && h !== 12) h += 12;
  if (isAM && h === 12) h = 0;
  return h * 60 + m;
}

function snap(v) { return Math.round(v / SNAP_MINUTES) * SNAP_MINUTES; }
function uid() { return 'layer_' + Math.random().toString(36).slice(2, 9); }
function getColor(type) { return LAYER_COLORS[type] || LAYER_COLORS.custom; }

// =================================================================
// GRADE + TIME BOUNDS
// =================================================================
function getGrades() {
  const divisions = window.divisions || {};
  return Object.keys(divisions).sort((a, b) => {
    const numA = parseInt(a), numB = parseInt(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(a).localeCompare(String(b));
  });
}

function getGradeTime(grade) {
  const div = (window.divisions || {})[grade];
  if (!div) return { start: 540, end: 960 };
  const s = parseTime(div.startTime);
  const e = parseTime(div.endTime);
  return { start: s != null ? s : 540, end: e != null ? e : 960 };
}

/** Global day bounds = earliest grade start to latest grade end */
function getDayBounds() {
  const grades = getGrades();
  if (grades.length === 0) return { dayStart: 540, dayEnd: 960 };
  let earliest = Infinity, latest = -Infinity;
  grades.forEach(g => {
    const t = getGradeTime(g);
    if (t.start < earliest) earliest = t.start;
    if (t.end > latest) latest = t.end;
  });
  layers.forEach(l => {
    if (l.startMin < earliest) earliest = l.startMin;
    if (l.endMin > latest) latest = l.endMin;
  });
  return {
    dayStart: earliest === Infinity ? 540 : earliest,
    dayEnd: latest === -Infinity ? 960 : latest
  };
}

function minToX(min, dayStart) { return (min - dayStart) * MIN_WIDTH; }
function xToMin(x, dayStart) { return snap(x / MIN_WIDTH + dayStart); }

// =================================================================
// INIT / DESTROY
// =================================================================
function init(containerEl) {
  layerContainer = containerEl;
  if (!layerContainer) return;
  loadDraftLayers();
  render();
  setupGlobalListeners();
  console.log('[AutoPlanner] v2.0 init \u2014', layers.length, 'layers');
}

function destroy() {
  layerContainer = null; layers = []; selectedLayerId = null; dragState = null;
}

// =================================================================
// PERSISTENCE
// =================================================================
function saveDraftLayers() {
  try {
    localStorage.setItem('auto-layers-draft', JSON.stringify(layers));
    if (currentTemplate) localStorage.setItem('auto-layers-template-name', currentTemplate);
  } catch(e) { console.error('[AutoPlanner] Save error:', e); }
}

function loadDraftLayers() {
  try {
    const raw = localStorage.getItem('auto-layers-draft');
    if (raw) layers = JSON.parse(raw);
    currentTemplate = localStorage.getItem('auto-layers-template-name') || null;
  } catch(e) { layers = []; }
}

function saveTemplate(name) {
  const saved = JSON.parse(localStorage.getItem('auto-layer-templates') || '{}');
  saved[name] = JSON.parse(JSON.stringify(layers));
  localStorage.setItem('auto-layer-templates', JSON.stringify(saved));
  currentTemplate = name; hasChanges = false; saveDraftLayers();
}

function loadTemplate(name) {
  const saved = JSON.parse(localStorage.getItem('auto-layer-templates') || '{}');
  if (saved[name]) {
    layers = JSON.parse(JSON.stringify(saved[name]));
    currentTemplate = name; hasChanges = false; saveDraftLayers(); render();
  }
}

function deleteTemplate(name) {
  const saved = JSON.parse(localStorage.getItem('auto-layer-templates') || '{}');
  delete saved[name];
  localStorage.setItem('auto-layer-templates', JSON.stringify(saved));
  if (currentTemplate === name) currentTemplate = null;
}

function getTemplateNames() {
  return Object.keys(JSON.parse(localStorage.getItem('auto-layer-templates') || '{}'));
}

function getLayerAssignments() {
  return JSON.parse(localStorage.getItem('auto-layer-assignments') || '{}');
}

function saveLayerAssignments(a) {
  localStorage.setItem('auto-layer-assignments', JSON.stringify(a));
}

// =================================================================
// RENDER (MAIN)
// =================================================================
function render() {
  if (!layerContainer) return;
  const grades = getGrades();
  const { dayStart, dayEnd } = getDayBounds();
  const totalWidth = (dayEnd - dayStart) * MIN_WIDTH;

  if (grades.length === 0) {
    layerContainer.innerHTML = '<div class="al-container" style="padding:40px;text-align:center;color:#6b7280;"><p>No grades/divisions configured.</p><p style="font-size:0.9rem;">Go to Setup to create divisions first.</p></div>';
    return;
  }

  let html = '<div class="al-container">';
  html += renderToolbar();
  html += '<div class="al-body">';
  html += renderPalette();
  html += '<div class="al-timeline-area">';
  html += '<div class="al-timeline-scroll" style="width:' + (totalWidth + 90) + 'px;">';
  html += renderTimeHeader(dayStart, dayEnd);
  grades.forEach(g => { html += renderGradeRow(g, dayStart, dayEnd, totalWidth); });
  html += '</div></div></div></div>';

  layerContainer.innerHTML = html;
  setupPaletteDrag();
  setupDropZones(dayStart);
  setupBandEvents(dayStart);
  setupToolbarEvents();
}

// =================================================================
// RENDER: TOOLBAR
// =================================================================
function renderToolbar() {
  const tpl = getTemplateNames();
  const opts = tpl.map(n => '<option value="' + n + '"' + (n === currentTemplate ? ' selected' : '') + '>' + n + '</option>').join('');
  const statusText = currentTemplate ? (hasChanges ? currentTemplate + ' (modified)' : currentTemplate) : (layers.length > 0 ? 'Unsaved layers' : 'No layers');
  const statusColor = hasChanges ? '#f59e0b' : (currentTemplate ? '#10b981' : '#94a3b8');

  return '<div class="al-toolbar">' +
    '<div class="al-toolbar-group"><span style="font-size:11px;font-weight:600;color:' + statusColor + ';">\u25CF ' + statusText + '</span></div>' +
    '<div class="al-toolbar-sep"></div>' +
    '<div class="al-toolbar-group"><select id="al-load-select" class="al-select"><option value="">Load Template\u2026</option>' + opts + '</select>' +
    '<button id="al-load-btn" class="al-btn al-btn-ghost al-btn-sm">Load</button></div>' +
    '<div class="al-toolbar-group"><button id="al-save-btn" class="al-btn al-btn-primary al-btn-sm">\uD83D\uDCBE Save</button>' +
    '<button id="al-save-as-btn" class="al-btn al-btn-ghost al-btn-sm">Save As\u2026</button></div>' +
    '<div class="al-toolbar-sep"></div>' +
    '<div class="al-toolbar-group"><button id="al-copy-grade-btn" class="al-btn al-btn-ghost al-btn-sm">\uD83D\uDCCB Copy Grade</button>' +
    '<button id="al-clear-btn" class="al-btn al-btn-danger al-btn-sm">\uD83D\uDDD1 Clear All</button></div>' +
    '<div class="al-toolbar-sep"></div>' +
    '<div class="al-toolbar-group"><button id="al-preview-btn" class="al-btn al-btn-success al-btn-sm">\uD83D\uDC41 Preview</button>' +
    '<button id="al-generate-btn" class="al-btn al-btn-primary">\u26A1 Generate Schedule</button></div>' +
    '</div>';
}

// =================================================================
// RENDER: PALETTE
// =================================================================
function renderPalette() {
  var html = '<div class="al-palette"><div class="al-palette-title">Layer Types</div>';
  PALETTE_TILES.forEach(function(tile) {
    html += '<div class="al-tile al-tile-' + tile.type + '" draggable="true" data-tile=\'' + JSON.stringify(tile).replace(/'/g, '&#39;') + '\'>' + tile.name + '</div>';
  });
  html += '</div>';
  return html;
}

// =================================================================
// RENDER: TIME HEADER
// =================================================================
function renderTimeHeader(dayStart, dayEnd) {
  var html = '<div class="al-time-header" style="width:' + ((dayEnd - dayStart) * MIN_WIDTH + 90) + 'px;">';
  for (var m = dayStart; m <= dayEnd; m += 30) {
    var left = 90 + (m - dayStart) * MIN_WIDTH;
    var isHour = m % 60 === 0;
    html += '<div class="al-time-mark" style="left:' + left + 'px;' + (isHour ? 'font-weight:600;color:#334155;' : '') + '">' + fmtShort(m) + '</div>';
  }
  html += '</div>';
  return html;
}

// =================================================================
// RENDER: GRADE ROW (grey unused zones)
// =================================================================
function renderGradeRow(grade, dayStart, dayEnd, totalWidth) {
  var gradeTime = getGradeTime(grade);
  var gradeLayers = layers.filter(function(l) { return l.grade === grade; });
  var stacking = calcStacking(gradeLayers);
  var rowHeight = Math.max(48, stacking.maxStack * 28 + 12);

  var html = '<div class="al-grade-row" style="height:' + rowHeight + 'px;">';
  html += '<div class="al-grade-label">' + grade + '</div>';
  html += '<div class="al-grade-timeline" data-grade="' + grade + '" style="width:' + totalWidth + 'px;height:' + rowHeight + 'px;">';

  // Grid lines
  for (var m = dayStart; m <= dayEnd; m += 30) {
    var left = (m - dayStart) * MIN_WIDTH;
    html += '<div class="al-grid-line' + (m % 60 === 0 ? ' al-grid-line-hour' : '') + '" style="left:' + left + 'px;"></div>';
  }

  // Grey unused zones
  if (gradeTime.start > dayStart) {
    html += '<div class="al-unused-zone" style="left:0;width:' + ((gradeTime.start - dayStart) * MIN_WIDTH) + 'px;"></div>';
  }
  if (gradeTime.end < dayEnd) {
    var zLeft = (gradeTime.end - dayStart) * MIN_WIDTH;
    html += '<div class="al-unused-zone" style="left:' + zLeft + 'px;width:' + ((dayEnd - gradeTime.end) * MIN_WIDTH) + 'px;"></div>';
  }

  // Bands
  gradeLayers.forEach(function(layer) {
    html += renderBand(layer, dayStart, stacking.map[layer.id], stacking.maxStack);
  });

  html += '</div></div>';
  return html;
}

// =================================================================
// STACKING
// =================================================================
function calcStacking(gradeLayers) {
  if (gradeLayers.length === 0) return { maxStack: 1, map: {} };
  if (gradeLayers.length === 1) return { maxStack: 1, map: { [gradeLayers[0].id]: 'solo' } };
  var sorted = gradeLayers.slice().sort(function(a, b) { return a.startMin - b.startMin; });
  var map = {}, tracks = [];
  sorted.forEach(function(layer) {
    var placed = false;
    for (var i = 0; i < tracks.length; i++) {
      if (layer.startMin >= tracks[i]) { tracks[i] = layer.endMin; map[layer.id] = i; placed = true; break; }
    }
    if (!placed) { map[layer.id] = tracks.length; tracks.push(layer.endMin); }
  });
  return { maxStack: Math.max(tracks.length, 1), map: map };
}

// =================================================================
// RENDER: BAND
// =================================================================
function renderBand(layer, dayStart, stackIdx, maxStack) {
  var color = getColor(layer.type);
  var left = (layer.startMin - dayStart) * MIN_WIDTH;
  var width = (layer.endMin - layer.startMin) * MIN_WIDTH;
  var isPinned = layer.pinExact === true;
  var isSelected = layer.id === selectedLayerId;
  var topCss, heightCss;
  if (stackIdx === 'solo') { topCss = '4px'; heightCss = 'calc(100% - 8px)'; }
  else { var pct = 100 / maxStack; topCss = (stackIdx * pct) + '%'; heightCss = 'calc(' + pct + '% - 4px)'; }
  var borderStyle = isPinned ? 'solid' : 'dashed';
  var selClass = isSelected ? ' al-band-selected' : '';
  var durText = layer.periodMin ? layer.periodMin + 'm' : '';
  var timeText = fmtShort(layer.startMin) + '\u2013' + fmtShort(layer.endMin);
  var badge = (layer.operator || '\u2265') + (layer.quantity || 1);
  var pinHtml = isPinned ? '<span class="al-band-pin">\uD83D\uDCCC</span>' : '';

  return '<div class="al-band' + selClass + '" data-layer-id="' + layer.id + '" style="left:' + left + 'px;width:' + width + 'px;top:' + topCss + ';height:' + heightCss + ';background:' + color.bg + ';border:2px ' + borderStyle + ' ' + color.border + ';color:' + color.text + ';">' +
    '<div class="al-band-resize al-band-resize-left"></div>' +
    pinHtml +
    '<span class="al-band-label">' + (layer.event || layer.type) + '</span>' +
    '<span class="al-band-dur">' + durText + '</span>' +
    '<span class="al-band-badge">' + badge + '</span>' +
    '<span class="al-band-time">' + timeText + '</span>' +
    '<div class="al-band-resize al-band-resize-right"></div>' +
    '</div>';
}

// =================================================================
// PALETTE DRAG
// =================================================================
function setupPaletteDrag() {
  document.querySelectorAll('.al-tile').forEach(function(tile) {
    tile.ondragstart = function(e) {
      e.dataTransfer.setData('application/layer-tile', tile.dataset.tile);
      e.dataTransfer.effectAllowed = 'copy';
    };
  });
}

// =================================================================
// DROP ZONES
// =================================================================
function setupDropZones(dayStart) {
  document.querySelectorAll('.al-grade-timeline').forEach(function(timeline) {
    timeline.ondragover = function(e) {
      if (e.dataTransfer.types.includes('application/layer-tile')) { e.preventDefault(); timeline.classList.add('al-drop-hover'); }
    };
    timeline.ondragleave = function() { timeline.classList.remove('al-drop-hover'); };
    timeline.ondrop = function(e) {
      e.preventDefault(); timeline.classList.remove('al-drop-hover');
      var data = e.dataTransfer.getData('application/layer-tile');
      if (!data) return;
      var tile = JSON.parse(data);
      var grade = timeline.dataset.grade;
      var rect = timeline.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var dropMin = xToMin(x, dayStart);
      var gradeTime = getGradeTime(grade);

      var startMin, endMin;
      if (tile.fixed) {
        // Fixed types: window = exactly the duration, placed at drop point
        startMin = snap(dropMin);
        endMin = snap(startMin + (tile.defaultDuration || 30));
        if (endMin > gradeTime.end) { startMin = gradeTime.end - (tile.defaultDuration || 30); endMin = gradeTime.end; }
      } else {
        // Flexible types: wider window around drop
        var halfSpan = Math.max((tile.defaultDuration || 40) + 30, 60) / 2;
        startMin = snap(Math.max(gradeTime.start, dropMin - halfSpan));
        endMin = snap(Math.min(gradeTime.end, dropMin + halfSpan));
        if (endMin - startMin < (tile.defaultDuration || 30)) endMin = Math.min(gradeTime.end, startMin + (tile.defaultDuration || 30) + 30);
      }

      layers.push({
        id: uid(), type: tile.type, event: tile.name,
        startMin: startMin, endMin: endMin,
        periodMin: tile.defaultDuration,
        operator: tile.defaultOp || '\u2265',
        quantity: tile.defaultQty || 1,
        grade: grade,
        pinExact: tile.fixed || false
      });
      hasChanges = true; selectedLayerId = layers[layers.length - 1].id;
      saveDraftLayers(); render();
    };
  });
}

// =================================================================
// BAND EVENTS
// =================================================================
function setupBandEvents(dayStart) {
  document.querySelectorAll('.al-band').forEach(function(band) {
    var layerId = band.dataset.layerId;

    band.onclick = function(e) {
      if (e.target.classList.contains('al-band-resize')) return;
      e.stopPropagation(); selectedLayerId = layerId; refreshSelection();
    };

    band.ondblclick = function(e) {
      e.stopPropagation(); selectedLayerId = layerId; openPopover(layerId, band);
    };

    band.querySelectorAll('.al-band-resize').forEach(function(handle) {
      handle.onmousedown = function(e) {
        e.preventDefault(); e.stopPropagation();
        var layer = layers.find(function(l) { return l.id === layerId; });
        if (!layer) return;
        var timeline = band.closest('.al-grade-timeline');
        var rect = timeline.getBoundingClientRect();
        dragState = {
          type: handle.classList.contains('al-band-resize-left') ? 'resize-left' : 'resize-right',
          layerId: layerId, origStartMin: layer.startMin, origEndMin: layer.endMin,
          timelineLeft: rect.left, dayStart: dayStart
        };
        selectedLayerId = layerId; showDragGhost(layer);
      };
    });

    band.onmousedown = function(e) {
      if (e.target.classList.contains('al-band-resize')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      var layer = layers.find(function(l) { return l.id === layerId; });
      if (!layer) return;
      var timeline = band.closest('.al-grade-timeline');
      var rect = timeline.getBoundingClientRect();
      dragState = {
        type: 'move', layerId: layerId,
        origStartMin: layer.startMin, origEndMin: layer.endMin,
        timelineLeft: rect.left, offsetX: e.clientX - band.getBoundingClientRect().left, dayStart: dayStart
      };
      selectedLayerId = layerId; showDragGhost(layer);
    };
  });

  document.querySelectorAll('.al-grade-timeline').forEach(function(tl) {
    tl.onclick = function(e) {
      if (e.target === tl) { selectedLayerId = null; closePopover(); refreshSelection(); }
    };
  });
}

// =================================================================
// DRAG GHOST
// =================================================================
var ghostEl = null;

function showDragGhost(layer) {
  removeDragGhost();
  ghostEl = document.createElement('div');
  ghostEl.className = 'al-drag-ghost';
  ghostEl.innerHTML = '<div>' + (layer.event || layer.type) + '</div><div class="al-drag-ghost-time" id="al-ghost-time">' + fmtTime(layer.startMin) + ' \u2013 ' + fmtTime(layer.endMin) + '</div>';
  document.body.appendChild(ghostEl);
}

function updateDragGhost(x, y, layer) {
  if (!ghostEl) return;
  ghostEl.style.left = (x + 15) + 'px';
  ghostEl.style.top = (y - 10) + 'px';
  var t = ghostEl.querySelector('#al-ghost-time');
  if (t && layer) t.textContent = fmtTime(layer.startMin) + ' \u2013 ' + fmtTime(layer.endMin);
}

function removeDragGhost() { if (ghostEl) { ghostEl.remove(); ghostEl = null; } }

// =================================================================
// GLOBAL MOUSE + KEYBOARD
// =================================================================
function setupGlobalListeners() {
  if (window._alGlobalBound) return;
  window._alGlobalBound = true;

  document.addEventListener('mousemove', function(e) {
    if (!dragState) return;
    var layer = layers.find(function(l) { return l.id === dragState.layerId; });
    if (!layer) { dragState = null; removeDragGhost(); return; }
    var bounds = getDayBounds();
    var gradeTime = getGradeTime(layer.grade);
    var x = e.clientX - dragState.timelineLeft;
    var min = xToMin(x, bounds.dayStart);

    if (dragState.type === 'resize-left') {
      layer.startMin = Math.max(gradeTime.start, Math.min(min, layer.endMin - SNAP_MINUTES));
    } else if (dragState.type === 'resize-right') {
      layer.endMin = Math.min(gradeTime.end, Math.max(min, layer.startMin + SNAP_MINUTES));
    } else if (dragState.type === 'move') {
      var dur = dragState.origEndMin - dragState.origStartMin;
      var ns = snap(min - dragState.offsetX / MIN_WIDTH);
      ns = Math.max(gradeTime.start, Math.min(ns, gradeTime.end - dur));
      layer.startMin = ns; layer.endMin = ns + dur;
    }

    // Live update band DOM
    var band = document.querySelector('.al-band[data-layer-id="' + layer.id + '"]');
    if (band) {
      band.style.left = (layer.startMin - bounds.dayStart) * MIN_WIDTH + 'px';
      band.style.width = (layer.endMin - layer.startMin) * MIN_WIDTH + 'px';
      var ts = band.querySelector('.al-band-time');
      if (ts) ts.textContent = fmtShort(layer.startMin) + '\u2013' + fmtShort(layer.endMin);
    }
    updateDragGhost(e.clientX, e.clientY, layer);
  });

  document.addEventListener('mouseup', function() {
    if (dragState) { hasChanges = true; saveDraftLayers(); dragState = null; removeDragGhost(); render(); }
  });

  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLayerId) { e.preventDefault(); deleteLayer(selectedLayerId); }
    if (e.key === 'Escape') { selectedLayerId = null; closePopover(); refreshSelection(); }
  });
}

function refreshSelection() {
  document.querySelectorAll('.al-band').forEach(function(b) {
    b.classList.toggle('al-band-selected', b.dataset.layerId === selectedLayerId);
  });
}

function deleteLayer(id) {
  layers = layers.filter(function(l) { return l.id !== id; });
  if (selectedLayerId === id) selectedLayerId = null;
  hasChanges = true; saveDraftLayers(); closePopover(); render();
}

// =================================================================
// POPOVER EDITOR
// =================================================================
var popoverEl = null;

function openPopover(layerId, bandEl) {
  closePopover();
  var layer = layers.find(function(l) { return l.id === layerId; });
  if (!layer) return;
  var rect = bandEl.getBoundingClientRect();
  var color = getColor(layer.type);
  var isPinned = layer.pinExact === true;

  var overlay = document.createElement('div');
  overlay.className = 'al-popover-overlay';
  overlay.onclick = function() { closePopover(); };
  document.body.appendChild(overlay);

  popoverEl = document.createElement('div');
  popoverEl.className = 'al-popover';
  var top = rect.bottom + 8, left = rect.left;
  if (top + 370 > window.innerHeight) top = rect.top - 370;
  if (left + 340 > window.innerWidth) left = window.innerWidth - 360;
  popoverEl.style.top = Math.max(10, top) + 'px';
  popoverEl.style.left = Math.max(10, left) + 'px';

  popoverEl.innerHTML =
    '<div class="al-popover-title"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:' + color.border + ';"></span> ' + (layer.event || layer.type) + '</div>' +
    '<div class="al-popover-row"><label>Window</label><input type="text" class="al-pop-input" id="al-pop-start" value="' + fmtTime(layer.startMin) + '" placeholder="Start"><span style="color:#94a3b8;"> \u2192 </span><input type="text" class="al-pop-input" id="al-pop-end" value="' + fmtTime(layer.endMin) + '" placeholder="End"></div>' +
    '<div class="al-popover-row"><label>Duration</label><input type="number" class="al-pop-input al-pop-dur" id="al-pop-dur" value="' + (layer.periodMin || '') + '" min="5" step="5" placeholder="min"><span style="font-size:10px;color:#94a3b8;">minutes needed</span></div>' +
    '<div class="al-popover-row"><label>Quantity</label><div class="al-pop-ops">' +
    '<button class="al-pop-op' + (layer.operator === '\u2265' ? ' active' : '') + '" data-op="\u2265">\u2265</button>' +
    '<button class="al-pop-op' + (layer.operator === '\u2264' ? ' active' : '') + '" data-op="\u2264">\u2264</button>' +
    '<button class="al-pop-op' + (layer.operator === '=' ? ' active' : '') + '" data-op="=">=</button>' +
    '</div><input type="number" class="al-pop-input al-pop-qty" id="al-pop-qty" value="' + (layer.quantity || 1) + '" min="1" max="10"></div>' +
    '<div class="al-popover-row"><label>Pin Time</label><button class="al-pin-toggle' + (isPinned ? ' active' : '') + '" id="al-pop-pin"><span class="al-pin-icon">\uD83D\uDCCC</span><span id="al-pin-label">' + (isPinned ? 'Exact Time' : 'Flexible') + '</span></button></div>' +
    (isPinned ? '<div style="font-size:10px;color:#92400e;background:#fffbeb;border-radius:6px;padding:6px 10px;margin:0 0 8px 78px;">\u26A0\uFE0F Must occur at exactly <b>' + fmtTime(layer.startMin) + '\u2013' + fmtTime(layer.endMin) + '</b></div>' : '') +
    '<div class="al-popover-actions"><button class="al-btn al-btn-danger al-btn-sm" id="al-pop-delete">\uD83D\uDDD1 Delete</button><button class="al-btn al-btn-primary al-btn-sm" id="al-pop-done">\u2713 Done</button></div>';

  document.body.appendChild(popoverEl);

  // Operator buttons
  popoverEl.querySelectorAll('.al-pop-op').forEach(function(btn) {
    btn.onclick = function() {
      popoverEl.querySelectorAll('.al-pop-op').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
    };
  });

  // Pin toggle
  popoverEl.querySelector('#al-pop-pin').onclick = function() {
    this.classList.toggle('active');
    this.querySelector('#al-pin-label').textContent = this.classList.contains('active') ? 'Exact Time' : 'Flexible';
  };

  popoverEl.querySelector('#al-pop-delete').onclick = function() { deleteLayer(layerId); };

  popoverEl.querySelector('#al-pop-done').onclick = function() {
    var sVal = parseTime(popoverEl.querySelector('#al-pop-start').value);
    var eVal = parseTime(popoverEl.querySelector('#al-pop-end').value);
    var dVal = parseInt(popoverEl.querySelector('#al-pop-dur').value) || null;
    var qVal = parseInt(popoverEl.querySelector('#al-pop-qty').value) || 1;
    var activeOp = popoverEl.querySelector('.al-pop-op.active');
    var opVal = activeOp ? activeOp.dataset.op : '\u2265';
    var pinned = popoverEl.querySelector('#al-pop-pin').classList.contains('active');

    if (sVal != null) layer.startMin = snap(sVal);
    if (eVal != null) layer.endMin = snap(eVal);
    if (dVal) layer.periodMin = dVal;
    layer.quantity = qVal; layer.operator = opVal; layer.pinExact = pinned;
    hasChanges = true; saveDraftLayers(); closePopover(); render();
  };
}

function closePopover() {
  document.querySelectorAll('.al-popover-overlay').forEach(function(o) { o.remove(); });
  if (popoverEl) { popoverEl.remove(); popoverEl = null; }
}

// =================================================================
// TOOLBAR EVENTS
// =================================================================
function setupToolbarEvents() {
  var $ = function(id) { return document.getElementById(id); };

  var loadBtn = $('al-load-btn');
  if (loadBtn) loadBtn.onclick = function() { var sel = $('al-load-select'); if (sel && sel.value) loadTemplate(sel.value); };

  var saveBtn = $('al-save-btn');
  if (saveBtn) saveBtn.onclick = function() {
    if (currentTemplate) { saveTemplate(currentTemplate); notify('Template saved!', 'success'); render(); }
    else promptSaveAs();
  };

  var saveAsBtn = $('al-save-as-btn');
  if (saveAsBtn) saveAsBtn.onclick = promptSaveAs;

  var copyBtn = $('al-copy-grade-btn');
  if (copyBtn) copyBtn.onclick = openCopyGradeModal;

  var clearBtn = $('al-clear-btn');
  if (clearBtn) clearBtn.onclick = function() {
    if (layers.length === 0) return;
    if (!confirm('Clear all layers?')) return;
    layers = []; selectedLayerId = null; hasChanges = true; saveDraftLayers(); render();
  };

  // ── PREVIEW via AutoSkeletonBuilder ──
  var previewBtn = $('al-preview-btn');
  if (previewBtn) previewBtn.onclick = function() {
    if (!window.AutoSkeletonBuilder) { notify('AutoSkeletonBuilder not loaded', 'error'); return; }
    var result = window.AutoSkeletonBuilder.buildAll(layers);
    console.log('[AutoPlanner] Preview:', result);
    notify('Preview: ' + (result.skeleton ? result.skeleton.length : 0) + ' blocks, ' + (result.warnings ? result.warnings.length : 0) + ' warnings', 'info');
  };

  // ── GENERATE via AutoSkeletonBuilder → pipeline ──
  var genBtn = $('al-generate-btn');
  if (genBtn) genBtn.onclick = function() {
    if (!window.AutoSkeletonBuilder) { notify('AutoSkeletonBuilder not loaded', 'error'); return; }
    var result = window.AutoSkeletonBuilder.buildAll(layers);
    if (!result.skeleton || result.skeleton.length === 0) { notify('No skeleton generated \u2014 check layers', 'error'); return; }

    // Push skeleton into existing pipeline
    if (window.saveCurrentDailyData) window.saveCurrentDailyData('manualSkeleton', result.skeleton);
    if (window.MasterSchedulerInternal) {
      if (window.MasterSchedulerInternal.setSkeleton) window.MasterSchedulerInternal.setSkeleton(result.skeleton);
      if (window.MasterSchedulerInternal.markUnsavedChanges) window.MasterSchedulerInternal.markUnsavedChanges();
      if (window.MasterSchedulerInternal.saveDraftToLocalStorage) window.MasterSchedulerInternal.saveDraftToLocalStorage();
      if (window.MasterSchedulerInternal.renderGrid) window.MasterSchedulerInternal.renderGrid();
    }

    // Run optimizer
    if (typeof window.runSkeletonOptimizer === 'function') {
      window.runSkeletonOptimizer(result.skeleton);
      notify('Schedule generated! \u26A1', 'success');
    } else {
      notify('Skeleton built \u2014 optimizer not available', 'info');
    }

    if (result.warnings && result.warnings.length > 0) console.warn('[AutoPlanner] Warnings:', result.warnings);
  };
}

// =================================================================
// COPY GRADE MODAL
// =================================================================
function openCopyGradeModal() {
  var grades = getGrades();
  if (grades.length < 2) { notify('Need \u22652 grades to copy', 'info'); return; }

  var sourceGrade = null;
  if (selectedLayerId) { var l = layers.find(function(x) { return x.id === selectedLayerId; }); if (l) sourceGrade = l.grade; }
  if (!sourceGrade) sourceGrade = grades.find(function(g) { return layers.some(function(l) { return l.grade === g; }); }) || grades[0];

  var overlay = document.createElement('div');
  overlay.className = 'al-modal-overlay';
  overlay.onclick = function() { overlay.remove(); };

  var modal = document.createElement('div');
  modal.className = 'al-copy-modal';
  modal.onclick = function(e) { e.stopPropagation(); };

  var html = '<div style="font-size:14px;font-weight:600;margin-bottom:12px;">Copy Layers from ' + sourceGrade + '</div>' +
    '<div style="font-size:11px;color:#64748b;margin-bottom:12px;">Select target grades:</div>';
  grades.filter(function(g) { return g !== sourceGrade; }).forEach(function(g) {
    var has = layers.some(function(l) { return l.grade === g; });
    html += '<div class="al-copy-grade-row"><label><input type="checkbox" value="' + g + '" checked> ' + g +
      (has ? ' <span style="color:#f59e0b;font-size:10px;">(will replace)</span>' : '') + '</label></div>';
  });
  html += '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">' +
    '<button class="al-btn al-btn-ghost al-btn-sm" id="al-copy-cancel">Cancel</button>' +
    '<button class="al-btn al-btn-primary al-btn-sm" id="al-copy-confirm">Copy</button></div>';

  modal.innerHTML = html;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelector('#al-copy-cancel').onclick = function() { overlay.remove(); };
  modal.querySelector('#al-copy-confirm').onclick = function() {
    var checked = Array.from(modal.querySelectorAll('input:checked')).map(function(cb) { return cb.value; });
    var source = layers.filter(function(l) { return l.grade === sourceGrade; });
    checked.forEach(function(target) {
      layers = layers.filter(function(l) { return l.grade !== target; });
      var tt = getGradeTime(target);
      source.forEach(function(sl) {
        var copy = JSON.parse(JSON.stringify(sl));
        copy.id = uid(); copy.grade = target;
        copy.startMin = Math.max(tt.start, sl.startMin);
        copy.endMin = Math.min(tt.end, sl.endMin);
        layers.push(copy);
      });
    });
    hasChanges = true; saveDraftLayers(); overlay.remove(); render();
    notify('Copied to ' + checked.length + ' grade(s)', 'success');
  };
}

function promptSaveAs() {
  var name = prompt('Template name:', currentTemplate || 'Regular Day');
  if (!name) return;
  saveTemplate(name.trim());
  notify('Saved as "' + name.trim() + '"', 'success');
  render();
}

function notify(msg, type) {
  document.querySelectorAll('.al-notification').forEach(function(n) { n.remove(); });
  var n = document.createElement('div');
  n.className = 'al-notification al-notification-' + (type || 'info');
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(function() { n.remove(); }, 3000);
}

// =================================================================
// PUBLIC API
// =================================================================
window.AutoSchedulePlanner = {
  init: init, destroy: destroy, render: render,
  getLayers: function() { return layers.slice(); },
  setLayers: function(nl) { layers = nl; hasChanges = true; saveDraftLayers(); render(); },
  getTemplateNames: getTemplateNames, loadTemplate: loadTemplate, saveTemplate: saveTemplate, deleteTemplate: deleteTemplate,
  getLayerAssignments: getLayerAssignments, saveLayerAssignments: saveLayerAssignments,
  PALETTE_TILES: PALETTE_TILES, LAYER_COLORS: LAYER_COLORS
};

console.log('[AutoSchedulePlanner] v2.0 loaded');
})();
