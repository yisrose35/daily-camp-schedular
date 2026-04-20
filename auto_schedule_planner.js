// =================================================================
// auto_schedule_planner.js (v5.0 - PREMIUM DAW UI)
// =================================================================
// v5.0 CHANGES:
//  - Complete premium UI/UX redesign
//  - Dark sidebar with categorized layer palette
//  - Gradient band pills with shadows and glow selection
//  - Centered modal popover with backdrop blur
//  - Status bar replacing cluttered toolbar
//  - Sticky time header, alternating grade rows
//  - Full --al-* CSS design system
//
// v4.0 CHANGES:
//  - bunksPerDay + timesPerWeek on ALL layer types (not just swim)
//  - Improved popover with clear section headers and help text
//  - "Rotation" section shows bunks/day + times/week for every layer
//  - Better field labels: "Time Window", "Block Duration", etc.
//
// LAYER → ENGINE FIELD MAP:
//   layer.pinExact    → pinned
//   layer.periodMin   → duration
//   layer.quantity    → quantity
//   layer.operator    → quantity.op (>=, <=, =)
//   layer.startMin    → startMin
//   layer.endMin      → endMin
//   layer.type        → type
//   layer.event       → event
//   layer.grade       → grade/division
//   layer.bunksPerDay → max bunks doing this activity per day
//   layer.timesPerWeek→ target times each bunk gets this per week
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
const HOUR_WIDTH = 120;
const MIN_WIDTH = HOUR_WIDTH / 60;
const SNAP_MINUTES = 5;

// Drag state
let dragState = null;

// =================================================================
// LAYER COLORS — rich gradients for premium band pills
// =================================================================
const LAYER_COLORS = {
  sport:            { gradient: 'linear-gradient(135deg,#bbf7d0,#4ade80)', border: '#16a34a', text: '#14532d', dot: '#22c55e' },
  sports:           { gradient: 'linear-gradient(135deg,#bbf7d0,#4ade80)', border: '#16a34a', text: '#14532d', dot: '#22c55e' },
  special:          { gradient: 'linear-gradient(135deg,#ddd6fe,#a78bfa)', border: '#7c3aed', text: '#3b0764', dot: '#8b5cf6' },
  activity:         { gradient: 'linear-gradient(135deg,#bfdbfe,#60a5fa)', border: '#2563eb', text: '#1e3a5f', dot: '#3b82f6' },
  lunch:            { gradient: 'linear-gradient(135deg,#fed7aa,#fb923c)', border: '#ea580c', text: '#7c2d12', dot: '#f97316' },
  swim:             { gradient: 'linear-gradient(135deg,#a5f3fc,#22d3ee)', border: '#0891b2', text: '#164e63', dot: '#06b6d4' },
  snack:            { gradient: 'linear-gradient(135deg,#fef08a,#fcd34d)', border: '#d97706', text: '#78350f', dot: '#eab308' },
  snacks:           { gradient: 'linear-gradient(135deg,#fef08a,#fcd34d)', border: '#d97706', text: '#78350f', dot: '#eab308' },
  dismissal:        { gradient: 'linear-gradient(135deg,#fbcfe8,#f472b6)', border: '#db2777', text: '#831843', dot: '#ec4899' },
  league:           { gradient: 'linear-gradient(135deg,#fecaca,#f87171)', border: '#dc2626', text: '#7f1d1d', dot: '#ef4444' },
  specialty_league: { gradient: 'linear-gradient(135deg,#fecdd3,#fb7185)', border: '#e11d48', text: '#881337', dot: '#f43f5e' },
  elective:         { gradient: 'linear-gradient(135deg,#f5d0fe,#e879f9)', border: '#c026d3', text: '#701a75', dot: '#d946ef' },
  split:            { gradient: 'linear-gradient(135deg,#fed7aa,#fb923c)', border: '#ea580c', text: '#7c2d12', dot: '#f97316' },
  custom:           { gradient: 'linear-gradient(135deg,#e2e8f0,#94a3b8)', border: '#475569', text: '#1e293b', dot: '#64748b' }
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
  { type: 'league',    name: 'League Game',       defaultDuration: 50, defaultOp: '\u2264', defaultQty: 1, fixed: false },
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
// IMPORT SKELETON FROM MASTER BUILDER
// =================================================================
function importSkeletonFromMasterBuilder() {
  var g = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
  var app1 = g.app1 || {};
  var assignments = app1.skeletonAssignments || {};
  var skeletons = app1.savedSkeletons || {};

  var dateStr = window.currentScheduleDate || '';
  var parts = dateStr.split('-').map(Number);
  if (!parts[0]) return false;
  var dow = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
  var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var tmplName = assignments[dayNames[dow]] || assignments['Default'];
  if (!tmplName || !skeletons[tmplName]) return false;

  var skeleton = skeletons[tmplName];
  if (!skeleton || skeleton.length === 0) return false;
  console.log('[AutoPlanner] Importing skeleton "' + tmplName + '" (' + skeleton.length + ' blocks)');

  var dailyData = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
  var dailySkeleton = dailyData.manualSkeleton;
  if (dailySkeleton && dailySkeleton.length > 0) {
    skeleton = dailySkeleton;
    console.log('[AutoPlanner] Using daily override skeleton (' + skeleton.length + ' blocks)');
  }

  var typeMap = {
    'slot': 'activity', 'sports': 'sports', 'sport': 'sports',
    'special': 'special', 'pinned': 'custom', 'league': 'league',
    'specialty_league': 'specialty_league', 'smart': 'activity',
    'split': 'split', 'elective': 'elective'
  };

  var eventTypeMap = {
    'general activity slot': 'activity', 'sports slot': 'sports',
    'special activity': 'special', 'league game': 'league',
    'specialty league': 'specialty_league', 'swim': 'swim',
    'lunch': 'lunch', 'snacks': 'snack', 'snack': 'snack', 'dismissal': 'dismissal'
  };

  layers = [];
  skeleton.forEach(function(block) {
    if (!block || !block.startTime || !block.endTime || !block.division) return;
    var startMin = parseTime(block.startTime);
    var endMin = parseTime(block.endTime);
    if (startMin == null || endMin == null || endMin <= startMin) return;

    var layerType = 'activity';
    var eventName = block.event || '';
    var blockType = block.type || '';
    var lowerEvent = eventName.toLowerCase().trim();
    if (eventTypeMap[lowerEvent]) layerType = eventTypeMap[lowerEvent];
    else if (typeMap[blockType]) layerType = typeMap[blockType];

    var isPinned = blockType === 'pinned' || ['swim','lunch','snack','snacks','dismissal'].indexOf(layerType) >= 0;
    var duration = endMin - startMin;

    layers.push({
      id: uid(), type: layerType, event: eventName || layerType,
      startMin: startMin, endMin: endMin, periodMin: duration,
      operator: isPinned ? '=' : '\u2265', quantity: 1,
      grade: block.division, pinExact: isPinned,
      timesPerWeek: null, weeklyOp: '\u2265', bunksPerDay: null,
      _importedFrom: tmplName
    });
  });

  if (layers.length > 0) {
    currentTemplate = tmplName + ' (imported)';
    hasChanges = false; saveDraftLayers(); return true;
  }
  return false;
}

// =================================================================
// INIT / DESTROY
// =================================================================
function init(containerEl) {
  layerContainer = containerEl;
  if (!layerContainer) return;
  loadDraftLayers();
  if (layers.length === 0) {
    console.log('[AutoPlanner] No layers loaded \u2014 add layers or use Import to convert from a manual skeleton template');
  }
  render();
  setupGlobalListeners();
  console.log('[AutoPlanner] v5.0 init \u2014', layers.length, 'layers');
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
    layerContainer.innerHTML = '<div class="al-container"><div class="al-empty-state"><div class="al-empty-icon">&#9680;</div><p>No grades configured</p><p class="al-empty-sub">Go to Setup to create divisions first.</p></div></div>';
    return;
  }

  let html = '<div class="al-container">';
  html += renderStatusBar();
  html += '<div class="al-body">';
  html += renderPalette();
  html += '<div class="al-timeline-area">';
  html += '<div class="al-timeline-scroll" style="width:' + (totalWidth + 90) + 'px;">';
  html += renderTimeHeader(dayStart, dayEnd);
  grades.forEach((g, i) => { html += renderGradeRow(g, dayStart, dayEnd, totalWidth, i); });
  html += '</div></div></div></div>';

  layerContainer.innerHTML = html;
  setupPaletteDrag();
  setupDropZones(dayStart);
  setupBandEvents(dayStart);
  setupToolbarEvents();
}

// =================================================================
// RENDER: STATUS BAR (premium top bar)
// =================================================================
function renderStatusBar() {
  const tpl = getTemplateNames();
  const opts = tpl.map(n => '<option value="' + n + '"' + (n === currentTemplate ? ' selected' : '') + '>' + n + '</option>').join('');

  const statusDot = hasChanges ? '#f59e0b' : (currentTemplate ? '#22c55e' : '#475569');
  const statusLabel = hasChanges
    ? (currentTemplate ? currentTemplate + ' \u2014 unsaved' : 'Unsaved')
    : (currentTemplate ? currentTemplate : 'No template');

  return '<div class="al-statusbar">' +
    '<div class="al-statusbar-left">' +
      '<span class="al-status-dot" style="background:' + statusDot + ';box-shadow:0 0 6px ' + statusDot + ';"></span>' +
      '<span class="al-statusbar-name">' + statusLabel + '</span>' +
    '</div>' +
    '<div class="al-statusbar-center">' +
      '<select id="al-load-select" class="al-status-select"><option value="">Load template\u2026</option>' + opts + '</select>' +
      '<button id="al-load-btn" class="al-sb-btn al-sb-btn-ghost">Load</button>' +
      '<div class="al-sb-div"></div>' +
      '<button id="al-save-btn" class="al-sb-btn al-sb-btn-accent">Save</button>' +
      '<button id="al-save-as-btn" class="al-sb-btn al-sb-btn-ghost">Save As\u2026</button>' +
    '</div>' +
    '<div class="al-statusbar-right">' +
      '<button id="al-copy-grade-btn" class="al-sb-btn al-sb-btn-ghost">Copy Grade</button>' +
      '<button id="al-import-skeleton-btn" class="al-sb-btn al-sb-btn-ghost">Import</button>' +
      '<button id="al-clear-btn" class="al-sb-btn al-sb-btn-danger">Clear</button>' +
      '<div class="al-sb-div"></div>' +
      '<button id="al-preview-btn" class="al-sb-btn al-sb-btn-ghost">Preview</button>' +
      '<button id="al-generate-btn" class="al-sb-btn al-sb-btn-generate">\u26A1 Generate</button>' +
      '<button id="al-fullscreen-btn" class="al-sb-btn al-sb-btn-ghost al-fullscreen-btn" title="Fullscreen">\u26F6</button>' +
    '</div>' +
    '</div>';
}

// =================================================================
// RENDER: PALETTE (dark sidebar)
// =================================================================
function renderPalette() {
  const anchored = PALETTE_TILES.filter(t => t.fixed);
  const flexible = PALETTE_TILES.filter(t => !t.fixed);

  let html = '<div class="al-palette">';
  html += '<div class="al-palette-brand">Layers</div>';

  anchored.forEach(tile => {
    const c = getColor(tile.type);
    html += '<div class="al-tile al-tile-' + tile.type + '" draggable="true" data-tile=\'' + JSON.stringify(tile).replace(/'/g, '&#39;') + '\'>' +
      '<span class="al-tile-dot" style="background:' + c.dot + ';"></span>' +
      '<span class="al-tile-name">' + tile.name + '</span>' +
      '<span class="al-tile-badge">PIN</span>' +
      '</div>';
  });

  flexible.forEach(tile => {
    const c = getColor(tile.type);
    html += '<div class="al-tile al-tile-' + tile.type + '" draggable="true" data-tile=\'' + JSON.stringify(tile).replace(/'/g, '&#39;') + '\'>' +
      '<span class="al-tile-dot" style="background:' + c.dot + ';"></span>' +
      '<span class="al-tile-name">' + tile.name + '</span>' +
      '</div>';
  });

  html += '<div class="al-palette-footer"><div class="al-palette-hint">Drag a layer onto a grade row to place it.<br>Double-click a band to edit.</div></div>';
  html += '</div>';
  return html;
}

// =================================================================
// RENDER: TIME HEADER
// =================================================================
function renderTimeHeader(dayStart, dayEnd) {
  var html = '<div class="al-time-header" style="width:' + ((dayEnd - dayStart) * MIN_WIDTH + 90) + 'px;">';
  html += '<div class="al-time-header-gutter"></div>';
  html += '<div class="al-time-header-track">';
  for (var m = dayStart; m <= dayEnd; m += 30) {
    var left = (m - dayStart) * MIN_WIDTH;
    var isHour = m % 60 === 0;
    html += '<div class="al-time-mark' + (isHour ? ' al-time-mark-hour' : '') + '" style="left:' + left + 'px;">' + fmtShort(m) + '</div>';
  }
  html += '</div></div>';
  return html;
}

// =================================================================
// RENDER: GRADE ROW
// =================================================================
function renderGradeRow(grade, dayStart, dayEnd, totalWidth, rowIndex) {
  var gradeTime = getGradeTime(grade);
  var gradeLayers = layers.filter(function(l) { return l.grade === grade; });
  var stacking = calcStacking(gradeLayers);
  var rowHeight = Math.max(56, stacking.maxStack * 40 + 12);
  var isEven = rowIndex % 2 === 0;

  var html = '<div class="al-grade-row' + (isEven ? '' : ' al-grade-row-alt') + '" style="height:' + rowHeight + 'px;">';
  html += '<div class="al-grade-label"><span class="al-grade-tag">' + grade + '</span></div>';
  html += '<div class="al-grade-timeline" data-grade="' + grade + '" style="width:' + totalWidth + 'px;height:' + rowHeight + 'px;">';

  // Grid lines
  for (var m = dayStart; m <= dayEnd; m += 30) {
    var left = (m - dayStart) * MIN_WIDTH;
    html += '<div class="al-grid-line' + (m % 60 === 0 ? ' al-grid-line-hour' : '') + '" style="left:' + left + 'px;"></div>';
  }

  // Unused zone — before grade starts
  if (gradeTime.start > dayStart) {
    html += '<div class="al-unused-zone" style="left:0;width:' + ((gradeTime.start - dayStart) * MIN_WIDTH) + 'px;"></div>';
  }
  // Unused zone — after grade ends
  if (gradeTime.end < dayEnd) {
    var zLeft = (gradeTime.end - dayStart) * MIN_WIDTH;
    html += '<div class="al-unused-zone" style="left:' + zLeft + 'px;width:' + ((dayEnd - gradeTime.end) * MIN_WIDTH) + 'px;"></div>';
  }

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
// RENDER: BAND (gradient pill)
// =================================================================
function renderBand(layer, dayStart, stackIdx, maxStack) {
  var color = getColor(layer.type);
  var left = (layer.startMin - dayStart) * MIN_WIDTH;
  var width = (layer.endMin - layer.startMin) * MIN_WIDTH;
  var isPinned = layer.pinExact === true;
  var isSelected = layer.id === selectedLayerId;

  var topCss, heightCss;
  if (stackIdx === 'solo') {
    topCss = '8px'; heightCss = 'calc(100% - 16px)';
  } else {
    var pct = 100 / maxStack;
    topCss = 'calc(' + (stackIdx * pct) + '% + 6px)';
    heightCss = 'calc(' + pct + '% - 12px)';
  }

  var selClass = isSelected ? ' al-band-selected' : '';
  var pinClass = isPinned ? ' al-band-pinned' : ' al-band-flex';

  // Duration label
  var durText = layer.periodMin ? layer.periodMin + 'm' : '';
  if (layer.type === 'swim' && (layer.preChangeMin || layer.postChangeMin)) {
    var pre  = layer.preChangeMin  || 0;
    var post = layer.postChangeMin || 0;
    var swimOnly = layer.periodMin || ((layer.endMin - layer.startMin) - pre - post);
    durText = pre + '+' + swimOnly + '+' + post + 'm';
  }

  var timeText = fmtShort(layer.startMin) + '\u2013' + fmtShort(layer.endMin);
  var badge = (layer.operator || '\u2265') + (layer.quantity || 1);
  var pinMarkup = isPinned ? '<span class="al-band-pin">&#128205;</span>' : '';

  var weeklyBadgeHtml = (layer.timesPerWeek != null)
    ? '<span class="al-band-chip al-band-chip-week">' + (layer.weeklyOp || '\u2265') + layer.timesPerWeek + '/wk</span>'
    : '';
  var bpdBadgeHtml = (layer.bunksPerDay != null)
    ? '<span class="al-band-chip al-band-chip-bpd">' + layer.bunksPerDay + '/day</span>'
    : '';

  return '<div class="al-band' + selClass + pinClass + '" data-layer-id="' + layer.id + '" style="' +
    'left:' + left + 'px;width:' + width + 'px;top:' + topCss + ';height:' + heightCss + ';' +
    'background:' + color.gradient + ';' +
    '--al-band-border:' + color.border + ';' +
    'color:' + color.text + ';">' +
    '<div class="al-band-resize al-band-resize-left"></div>' +
    pinMarkup +
    '<span class="al-band-label">' + (layer.event || layer.type) + '</span>' +
    '<span class="al-band-dur">' + durText + '</span>' +
    '<span class="al-band-badge">' + badge + '</span>' +
    weeklyBadgeHtml +
    bpdBadgeHtml +
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
      tile.classList.add('al-tile-dragging');
    };
    tile.ondragend = function() { tile.classList.remove('al-tile-dragging'); };
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
        startMin = snap(dropMin);
        endMin = snap(startMin + (tile.defaultDuration || 30));
        if (endMin > gradeTime.end) { startMin = gradeTime.end - (tile.defaultDuration || 30); endMin = gradeTime.end; }
      } else {
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
        pinExact: tile.fixed || false,
        timesPerWeek: null,
        weeklyOp: '\u2265',
        bunksPerDay: null
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
  var c = getColor(layer.type);
  ghostEl.style.background = c.gradient;
  ghostEl.style.color = c.text;
  ghostEl.innerHTML = '<div class="al-ghost-name">' + (layer.event || layer.type) + '</div>' +
    '<div class="al-ghost-time" id="al-ghost-time">' + fmtTime(layer.startMin) + ' \u2013 ' + fmtTime(layer.endMin) + '</div>';
  document.body.appendChild(ghostEl);
}

function updateDragGhost(x, y, layer) {
  if (!ghostEl) return;
  ghostEl.style.left = (x + 16) + 'px';
  ghostEl.style.top = (y - 12) + 'px';
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
// POPOVER EDITOR — v5.0 centered modal with dark header
// =================================================================
var popoverEl = null;

function openPopover(layerId, bandEl) {
  closePopover();
  var layer = layers.find(function(l) { return l.id === layerId; });
  if (!layer) return;
  var color = getColor(layer.type);
  var isPinned = layer.pinExact === true;

  // Backdrop overlay
  var overlay = document.createElement('div');
  overlay.className = 'al-popover-overlay';
  overlay.onclick = function() { closePopover(); };
  document.body.appendChild(overlay);

  popoverEl = document.createElement('div');
  popoverEl.className = 'al-popover';

  // ── Build popover HTML ──
  var html = '';

  // Dark header
  html += '<div class="al-pop-header" style="--pop-accent:' + color.border + ';background:' + color.border + '12;border-bottom:2px solid ' + color.border + '22;">' +
    '<span class="al-pop-header-dot" style="background:' + color.dot + ';"></span>' +
    '<div class="al-pop-header-info">' +
      '<div class="al-pop-header-name">' + (layer.event || layer.type) + '</div>' +
      '<div class="al-pop-header-type">' + layer.type.replace(/_/g, ' ') + ' \u00B7 ' + fmtTime(layer.startMin) + '\u2013' + fmtTime(layer.endMin) + '</div>' +
    '</div>' +
    '<button class="al-pop-close" id="al-pop-close-btn">\u00D7</button>' +
    '</div>';

  html += '<div class="al-pop-body">';

  // ── Section 1: Scheduling ──
  html += '<div class="al-pop-section-label">Scheduling</div>';

  html += '<div class="al-pop-field">' +
    '<label class="al-pop-label">Time Window</label>' +
    '<div class="al-pop-row">' +
      '<input type="text" class="al-pop-input" id="al-pop-start" value="' + fmtTime(layer.startMin) + '" placeholder="Start">' +
      '<span class="al-pop-arrow">\u2192</span>' +
      '<input type="text" class="al-pop-input" id="al-pop-end" value="' + fmtTime(layer.endMin) + '" placeholder="End">' +
    '</div>' +
    '<div class="al-pop-hint">Earliest and latest this can be placed in the day</div>' +
    '</div>';

  html += '<div class="al-pop-field">' +
    '<label class="al-pop-label">Block Duration</label>' +
    '<div class="al-pop-row">' +
      '<input type="number" class="al-pop-input al-pop-input-sm" id="al-pop-dur" value="' + (layer.periodMin || '') + '" min="5" step="5" placeholder="min">' +
      '<span class="al-pop-unit">minutes</span>' +
    '</div>' +
    '<div class="al-pop-hint">How long each block lasts</div>' +
    '</div>';

  html += '<div class="al-pop-field">' +
    '<label class="al-pop-label">Blocks Per Day</label>' +
    '<div class="al-pop-row">' +
      '<div class="al-pop-ops" id="al-pop-ops-daily">' +
        '<button class="al-pop-op' + (layer.operator === '\u2265' ? ' active' : '') + '" data-op="\u2265">\u2265</button>' +
        '<button class="al-pop-op' + (layer.operator === '\u2264' ? ' active' : '') + '" data-op="\u2264">\u2264</button>' +
        '<button class="al-pop-op' + (layer.operator === '=' ? ' active' : '') + '" data-op="=">=</button>' +
      '</div>' +
      '<input type="number" class="al-pop-input al-pop-input-sm" id="al-pop-qty" value="' + (layer.quantity || 1) + '" min="1" max="10">' +
    '</div>' +
    '<div class="al-pop-hint">\u2265 at least \u00B7 \u2264 at most \u00B7 = exactly this many per day</div>' +
    '</div>';

  html += '<div class="al-pop-field">' +
    '<label class="al-pop-label">Pin Time</label>' +
    '<div class="al-pop-row">' +
      '<button class="al-pin-toggle' + (isPinned ? ' active' : '') + '" id="al-pop-pin">' +
        '<span class="al-pin-icon">&#128205;</span>' +
        '<span id="al-pin-label">' + (isPinned ? 'Pinned \u2014 Exact Time' : 'Flexible \u2014 Scheduler Places') + '</span>' +
      '</button>' +
    '</div>' +
    (isPinned ? '<div class="al-pop-hint al-pop-hint-warn">Locked to exactly <b>' + fmtTime(layer.startMin) + '\u2013' + fmtTime(layer.endMin) + '</b></div>' : '') +
    '</div>';

  // ── Section 2: Rotation ──
  html += '<div class="al-pop-divider"></div>';
  html += '<div class="al-pop-section-label">Rotation <span class="al-pop-section-sub">optional \u2014 leave blank for no limits</span></div>';

  html += '<div class="al-pop-field">' +
    '<label class="al-pop-label">Bunks / Day</label>' +
    '<div class="al-pop-row">' +
      '<input type="number" class="al-pop-input al-pop-input-sm" id="al-pop-bpd"' +
      ' value="' + (layer.bunksPerDay != null ? layer.bunksPerDay : '') + '"' +
      ' min="1" max="99" placeholder="All">' +
      '<span class="al-pop-unit">bunks</span>' +
    '</div>' +
    '<div class="al-pop-hint">Max bunks per day. The rest get it on a rotating basis.</div>' +
    '</div>';

  html += '<div class="al-pop-field">' +
    '<label class="al-pop-label">Times / Week</label>' +
    '<div class="al-pop-row">' +
      '<div class="al-pop-ops" id="al-pop-ops-weekly">' +
        '<button class="al-pop-op' + ((layer.weeklyOp || '\u2265') === '\u2265' ? ' active' : '') + '" data-wop="\u2265">\u2265</button>' +
        '<button class="al-pop-op' + ((layer.weeklyOp) === '\u2264' ? ' active' : '') + '" data-wop="\u2264">\u2264</button>' +
        '<button class="al-pop-op' + ((layer.weeklyOp) === '=' ? ' active' : '') + '" data-wop="=">=</button>' +
      '</div>' +
      '<input type="number" class="al-pop-input al-pop-input-sm" id="al-pop-week-qty"' +
      ' value="' + (layer.timesPerWeek != null ? layer.timesPerWeek : '') + '"' +
      ' min="1" max="7" placeholder="Any">' +
      '<span class="al-pop-unit">days</span>' +
    '</div>' +
    '<div class="al-pop-hint">How many days per week each bunk should get this.</div>' +
    '</div>';

  // ── Section 3: Grade Mode (swim / lunch / snacks only) ──
  var isGradeModetype = ['swim', 'lunch', 'snack', 'snacks'].indexOf(layer.type) >= 0;
  if (isGradeModetype) {
    var isFullGrade = layer.fullGrade === true;
    html += '<div class="al-pop-divider"></div>';
    html += '<div class="al-pop-section-label">Grade Mode</div>';
    html += '<div class="al-pop-field">' +
      '<label class="al-pop-label">Scheduling</label>' +
      '<div class="al-pop-row">' +
        '<div class="al-pop-toggle-group">' +
          '<button class="al-pop-toggle' + (!isFullGrade ? ' active' : '') + '" data-gmode="stagger">Staggered</button>' +
          '<button class="al-pop-toggle' + (isFullGrade ? ' active' : '') + '" data-gmode="fullgrade">Full Grade</button>' +
        '</div>' +
      '</div>' +
      '<div class="al-pop-hint"><b>Full Grade:</b> all bunks at once (like a league). <b>Staggered:</b> spread across window.</div>' +
      '</div>';
  }

  // ── Section 4: Change Time (swim only) ──
  if (layer.type === 'swim') {
    html += '<div class="al-pop-divider"></div>';
    html += '<div class="al-pop-section-label">Change Time</div>';
    html += '<div class="al-pop-field">' +
      '<label class="al-pop-label">Pre-Change</label>' +
      '<div class="al-pop-row">' +
        '<input type="number" class="al-pop-input al-pop-input-sm" id="al-pop-pre-change"' +
        ' value="' + (layer.preChangeMin != null ? layer.preChangeMin : '') + '"' +
        ' min="0" max="60" step="5" placeholder="0">' +
        '<span class="al-pop-unit">minutes</span>' +
      '</div>' +
      '</div>';
    html += '<div class="al-pop-field">' +
      '<label class="al-pop-label">Post-Change</label>' +
      '<div class="al-pop-row">' +
        '<input type="number" class="al-pop-input al-pop-input-sm" id="al-pop-post-change"' +
        ' value="' + (layer.postChangeMin != null ? layer.postChangeMin : '') + '"' +
        ' min="0" max="60" step="5" placeholder="0">' +
        '<span class="al-pop-unit">minutes</span>' +
      '</div>' +
      '<div class="al-pop-hint">Total block = pre + swim + post. E.g. 5 + 45 + 10 = <b>60 min</b>. Set band width to cover all.</div>' +
      '</div>';
  }

  html += '</div>'; // al-pop-body

  // ── Actions ──
  html += '<div class="al-pop-actions">' +
    '<button class="al-pop-action-btn al-pop-action-delete" id="al-pop-delete">Delete Layer</button>' +
    '<button class="al-pop-action-btn al-pop-action-done" id="al-pop-done">\u2713 Apply</button>' +
    '</div>';

  popoverEl.innerHTML = html;
  document.body.appendChild(popoverEl);

  // Animate in
  requestAnimationFrame(function() { popoverEl.classList.add('al-popover-visible'); });

  // ── Wire up buttons ──

  popoverEl.querySelector('#al-pop-close-btn').onclick = function() { closePopover(); };

  // Daily quantity operator buttons
  popoverEl.querySelectorAll('.al-pop-op[data-op]').forEach(function(btn) {
    btn.onclick = function() {
      popoverEl.querySelectorAll('.al-pop-op[data-op]').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
    };
  });

  // Weekly operator buttons
  popoverEl.querySelectorAll('.al-pop-op[data-wop]').forEach(function(btn) {
    btn.onclick = function() {
      popoverEl.querySelectorAll('.al-pop-op[data-wop]').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
    };
  });

  // Grade Mode toggle
  popoverEl.querySelectorAll('.al-pop-toggle[data-gmode]').forEach(function(btn) {
    btn.onclick = function() {
      popoverEl.querySelectorAll('.al-pop-toggle[data-gmode]').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
    };
  });

  // Pin toggle
  var pinBtn = popoverEl.querySelector('#al-pop-pin');
  if (pinBtn) pinBtn.onclick = function() {
    this.classList.toggle('active');
    this.querySelector('#al-pin-label').textContent = this.classList.contains('active')
      ? 'Pinned \u2014 Exact Time' : 'Flexible \u2014 Scheduler Places';
  };

  // Delete
  popoverEl.querySelector('#al-pop-delete').onclick = function() { deleteLayer(layerId); };

  // Done — save all values
  popoverEl.querySelector('#al-pop-done').onclick = function() {
    var sVal = parseTime(popoverEl.querySelector('#al-pop-start').value);
    var eVal = parseTime(popoverEl.querySelector('#al-pop-end').value);
    var dVal = parseInt(popoverEl.querySelector('#al-pop-dur').value) || null;
    var qVal = parseInt(popoverEl.querySelector('#al-pop-qty').value) || 1;
    var activeOp = popoverEl.querySelector('.al-pop-op[data-op].active');
    var opVal = activeOp ? activeOp.dataset.op : '\u2265';
    var pinned = popoverEl.querySelector('#al-pop-pin').classList.contains('active');

    // Weekly recurrence
    var activeWop = popoverEl.querySelector('.al-pop-op[data-wop].active');
    var wopVal = activeWop ? activeWop.dataset.wop : '\u2265';
    var weekQtyRaw = popoverEl.querySelector('#al-pop-week-qty') ? popoverEl.querySelector('#al-pop-week-qty').value.trim() : '';
    var weekQtyVal = weekQtyRaw !== '' ? Math.max(1, Math.min(7, parseInt(weekQtyRaw) || 1)) : null;

    // Bunks per day
    var bpdRaw = popoverEl.querySelector('#al-pop-bpd') ? popoverEl.querySelector('#al-pop-bpd').value.trim() : '';
    var bpdVal = bpdRaw !== '' ? Math.max(1, parseInt(bpdRaw) || 1) : null;

    if (sVal != null) layer.startMin = snap(sVal);
    if (eVal != null) layer.endMin = snap(eVal);
    if (dVal) layer.periodMin = dVal;
    layer.quantity = qVal;
    layer.operator = opVal;
    layer.pinExact = pinned;
    layer.timesPerWeek = weekQtyVal;
    layer.weeklyOp = weekQtyVal != null ? wopVal : '\u2265';
    layer.bunksPerDay = bpdVal;

    // Grade Mode
    var activeGmode = popoverEl.querySelector('.al-pop-toggle[data-gmode].active');
    if (activeGmode) {
      layer.fullGrade = activeGmode.dataset.gmode === 'fullgrade';
    }

    // Change Time (swim only)
    if (layer.type === 'swim') {
      var preEl  = popoverEl.querySelector('#al-pop-pre-change');
      var postEl = popoverEl.querySelector('#al-pop-post-change');
      layer.preChangeMin  = preEl  && preEl.value.trim()  !== '' ? Math.max(0, parseInt(preEl.value)  || 0) : null;
      layer.postChangeMin = postEl && postEl.value.trim() !== '' ? Math.max(0, parseInt(postEl.value) || 0) : null;
    }

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

  var importBtn = $('al-import-skeleton-btn');
  if (importBtn) importBtn.onclick = function() {
    if (layers.length > 0 && !confirm('This will replace current layers with the Master Builder skeleton for today. Continue?')) return;
    layers = [];
    var imported = importSkeletonFromMasterBuilder();
    if (imported) { notify('Imported ' + layers.length + ' layers from template', 'success'); render(); }
    else { notify('No template assigned for today', 'error'); render(); }
  };

  var previewBtn = $('al-preview-btn');
  if (previewBtn) previewBtn.onclick = function() {
    if (!window.AutoBuildEngine) { notify('AutoBuildEngine not loaded', 'error'); return; }
    var dateStr = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    var result = window.AutoBuildEngine.build({ layers: layers, dateStr: dateStr });
    console.log('[AutoPlanner] Preview:', result);
    var msg = 'Preview: ' + result.skeleton.length + ' skeleton blocks, ' + result.bunkOverrides.length + ' bunk overrides';
    if (result.warnings.length > 0) msg += ', ' + result.warnings.length + ' warnings';
    notify(msg, 'info');
  };

  var fsBtn = $('al-fullscreen-btn');
  if (fsBtn) fsBtn.onclick = function() {
    var container = document.querySelector('.al-container');
    if (!document.fullscreenElement) {
      (container || document.documentElement).requestFullscreen().catch(function() {});
      fsBtn.textContent = '\u2715';
      fsBtn.title = 'Exit Fullscreen';
    } else {
      document.exitFullscreen();
      fsBtn.textContent = '\u26F6';
      fsBtn.title = 'Fullscreen';
    }
  };
  document.addEventListener('fullscreenchange', function() {
    var btn = document.getElementById('al-fullscreen-btn');
    if (btn) { btn.textContent = document.fullscreenElement ? '\u2715' : '\u26F6'; btn.title = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen'; }
  }, { once: false });

  var genBtn = $('al-generate-btn');
  if (genBtn) genBtn.onclick = function() {
    if (!window.AutoBuildEngine) { notify('AutoBuildEngine not loaded', 'error'); return; }
    var dateStr = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    var result = window.AutoBuildEngine.build({ layers: layers, dateStr: dateStr });
    if (!result.skeleton || result.skeleton.length === 0) { notify('No skeleton generated \u2014 check layers', 'error'); return; }

    window._autoGeneratedSchedule = true;
    window._autoBuildTimelines = result.bunkTimelines;

    if (window.saveCurrentDailyData) {
      window.saveCurrentDailyData('autoSkeleton', result.skeleton);
      if (result.bunkOverrides && result.bunkOverrides.length > 0) {
        window.saveCurrentDailyData('bunkActivityOverrides', result.bunkOverrides);
      }
      window.saveCurrentDailyData('_autoGenerated', true);
      window.saveCurrentDailyData('_autoBuildTimelines', result.bunkTimelines);
    }

    if (window.DivisionTimesSystem?.buildFromSkeleton) {
      var divisions = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
      window.divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(result.skeleton, divisions);
      console.log('[AutoPlanner] Built divisionTimes for', Object.keys(window.divisionTimes).length, 'divisions');
    }

    if (result.bunkOverrides && result.bunkOverrides.length > 0) {
      window._autoBunkOverrides = result.bunkOverrides;
      console.log('[AutoPlanner] Stored', result.bunkOverrides.length, 'bunk overrides');
    }

    window.manualSkeleton = result.skeleton;
    window.skeleton = result.skeleton;

    if (typeof window.runSkeletonOptimizer === 'function') {
      window.runSkeletonOptimizer(result.skeleton);
      notify('Schedule generated! \u26A1', 'success');
    } else if (typeof window.generateSchedule === 'function') {
      window.generateSchedule({ skeleton: result.skeleton, bunkOverrides: result.bunkOverrides });
      notify('Schedule generated! \u26A1', 'success');
    } else {
      notify('Skeleton built \u2014 run Generate in the scheduler to solve', 'info');
    }

    if (window.saveCurrentDailyData) {
      window.saveCurrentDailyData('divisionTimes', window.DivisionTimesSystem?.serialize?.(window.divisionTimes) || window.divisionTimes);
    }

    if (typeof window.updateTable === 'function') {
      setTimeout(function() { window.updateTable(); }, 200);
    }
    if (result.warnings.length > 0) {
      console.warn('[AutoPlanner] Warnings:', result.warnings);
      notify('Generated with ' + result.warnings.length + ' warning(s)', 'info');
    }
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

  var html = '<div class="al-modal-header">Copy Layers from Grade ' + sourceGrade + '</div>' +
    '<div class="al-modal-sub">Select target grades to copy to:</div>';
  grades.filter(function(g) { return g !== sourceGrade; }).forEach(function(g) {
    var has = layers.some(function(l) { return l.grade === g; });
    html += '<div class="al-modal-check-row"><label><input type="checkbox" value="' + g + '" checked> Grade ' + g +
      (has ? ' <span class="al-modal-warn">(replaces existing)</span>' : '') + '</label></div>';
  });
  html += '<div class="al-modal-actions">' +
    '<button class="al-pop-action-btn al-pop-action-delete" id="al-copy-cancel">Cancel</button>' +
    '<button class="al-pop-action-btn al-pop-action-done" id="al-copy-confirm">Copy Layers</button></div>';

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
  setTimeout(function() { n.style.opacity = '0'; }, 2600);
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

console.log('[AutoSchedulePlanner] v5.0 loaded \u2014 premium DAW UI');

// =================================================================
// CSS DESIGN SYSTEM INJECTION
// =================================================================
(function() {
  if (document.getElementById('al-v5-styles')) return;
  var s = document.createElement('style');
  s.id = 'al-v5-styles';
  s.textContent = `
/* ============================================================
   AUTO SCHEDULE PLANNER v5.0 — Light & Airy Design System
   ============================================================ */

/* ── Layout ── */
.al-container {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 78px);
  min-height: 500px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: #1e293b;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.05);
}

.al-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ── Status Bar ── */
.al-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  height: 44px;
  background: #fff;
  border-bottom: 1px solid #eef0f3;
  flex-shrink: 0;
  user-select: none;
}

.al-statusbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 140px;
}

.al-statusbar-center {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: center;
}

.al-statusbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 140px;
  justify-content: flex-end;
}

.al-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background 0.3s, box-shadow 0.3s;
}

.al-statusbar-name {
  font-size: 12px;
  font-weight: 600;
  color: #1e293b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.al-status-select {
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  background: #f9fafb;
  color: #374151;
  font-size: 12px;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}
.al-status-select:hover { border-color: #cbd5e1; }

.al-sb-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: none;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.al-sb-btn-ghost {
  background: #f9fafb;
  color: #475569;
  border: 1px solid #e2e8f0;
}
.al-sb-btn-ghost:hover { background: #f1f5f9; color: #1e293b; border-color: #cbd5e1; }

.al-sb-btn-accent {
  background: #6366f1;
  color: #fff;
}
.al-sb-btn-accent:hover { background: #4f46e5; }

.al-sb-btn-danger {
  background: #fef2f2;
  color: #dc2626;
  border: 1px solid #fecaca;
}
.al-sb-btn-danger:hover { background: #fee2e2; }

.al-sb-btn-generate {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(99,102,241,0.25);
}
.al-sb-btn-generate:hover {
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  box-shadow: 0 2px 12px rgba(99,102,241,0.4);
  transform: translateY(-1px);
}

.al-sb-div {
  width: 1px;
  height: 16px;
  background: #e2e8f0;
  margin: 0 2px;
}

/* ── Sidebar Palette ── */
.al-palette {
  width: 172px;
  min-width: 172px;
  background: #fff;
  border-right: 1px solid #eef0f3;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 0 8px;
  flex-shrink: 0;
}

.al-palette-brand {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #94a3b8;
  padding: 0 12px 8px;
}

.al-palette-section-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
  padding: 0 12px 5px;
}

.al-tile {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: grab;
  transition: background 0.12s;
  user-select: none;
}
.al-tile:hover { background: #f8fafc; }
.al-tile:active { cursor: grabbing; }
.al-tile.al-tile-dragging { opacity: 0.4; }

.al-tile-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.al-tile-name {
  font-size: 12px;
  font-weight: 500;
  color: #374151;
  flex: 1;
  transition: color 0.12s;
}
.al-tile:hover .al-tile-name { color: #111827; }

.al-tile-badge {
  font-size: 9px;
  font-weight: 700;
  color: #94a3b8;
  background: #f1f5f9;
  border-radius: 3px;
  padding: 1px 4px;
}

.al-palette-footer {
  margin-top: auto;
  padding: 10px 12px;
  border-top: 1px solid #eef0f3;
}

.al-palette-hint {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.5;
}

/* ── Timeline Area ── */
.al-timeline-area {
  flex: 1;
  overflow: auto;
  background: #fafbfc;
  position: relative;
}

.al-timeline-scroll {
  min-width: 100%;
}

/* ── Time Header ── */
.al-time-header {
  display: flex;
  align-items: stretch;
  height: 30px;
  background: #fff;
  border-bottom: 1px solid #eef0f3;
  position: sticky;
  top: 0;
  z-index: 10;
  box-shadow: 0 1px 0 #eef0f3;
}

.al-time-header-gutter {
  width: 90px;
  min-width: 90px;
  border-right: 1px solid #eef0f3;
  background: #fff;
}

.al-time-header-track {
  position: relative;
  flex: 1;
}

.al-time-mark {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 10px;
  font-weight: 500;
  color: #94a3b8;
  white-space: nowrap;
  pointer-events: none;
}

.al-time-mark-hour {
  font-weight: 700;
  color: #475569;
}

/* ── Grade Rows ── */
.al-grade-row {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid #f0f2f5;
  background: #fff;
  min-height: 56px;
}
.al-grade-row:hover { background: #fdfeff; }
.al-grade-row-alt { background: #fafbfc; }
.al-grade-row-alt:hover { background: #f6f8fa; }

.al-grade-label {
  width: 90px;
  min-width: 90px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #eef0f3;
  padding: 4px;
  background: inherit;
}

.al-grade-tag {
  background: #f1f5f9;
  color: #334155;
  font-size: 11px;
  font-weight: 700;
  border-radius: 6px;
  padding: 3px 10px;
  letter-spacing: 0.02em;
}

.al-grade-timeline {
  position: relative;
  cursor: crosshair;
  flex: 1;
  overflow: hidden;
}

.al-grade-timeline.al-drop-hover {
  background: rgba(99,102,241,0.04);
  outline: 2px dashed #a5b4fc;
  outline-offset: -2px;
}

/* ── Grid Lines ── */
.al-grid-line {
  position: absolute;
  top: 0; bottom: 0;
  width: 1px;
  background: rgba(0,0,0,0.04);
  pointer-events: none;
}
.al-grid-line-hour {
  background: rgba(0,0,0,0.08);
}

/* ── Unused Zones ── */
.al-unused-zone {
  position: absolute;
  top: 0; bottom: 0;
  background: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 5px,
    rgba(0,0,0,0.02) 5px,
    rgba(0,0,0,0.02) 10px
  );
  pointer-events: none;
  z-index: 0;
}

/* ── Band Pills ── */
.al-band {
  position: absolute;
  border-radius: 8px;
  cursor: grab;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 22px 0 8px;
  overflow: hidden;
  z-index: 2;
  box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.05) inset;
  transition: box-shadow 0.15s, transform 0.1s;
  user-select: none;
  border: none;
}
.al-band:hover {
  box-shadow: 0 3px 10px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06) inset;
  transform: translateY(-1px);
  z-index: 3;
}
.al-band:active { cursor: grabbing; }

.al-band-pinned {
  box-shadow: 0 1px 2px rgba(0,0,0,0.08), inset 3px 0 0 rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05) inset;
}

.al-band-selected {
  z-index: 4;
  box-shadow:
    0 0 0 2px #fff,
    0 0 0 4px var(--al-band-border, #6366f1),
    0 4px 12px rgba(0,0,0,0.1) !important;
  transform: translateY(-2px) !important;
}

.al-band-label {
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.al-band-dur {
  font-size: 10px;
  font-weight: 600;
  opacity: 0.75;
  white-space: nowrap;
  flex-shrink: 0;
}

.al-band-badge {
  font-size: 10px;
  font-weight: 700;
  background: rgba(0,0,0,0.12);
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
  flex-shrink: 0;
}

.al-band-chip {
  font-size: 9px;
  font-weight: 600;
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
  flex-shrink: 0;
  background: rgba(0,0,0,0.1);
}

.al-band-time {
  font-size: 9px;
  opacity: 0.7;
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: auto;
}

.al-band-pin {
  font-size: 10px;
  flex-shrink: 0;
}

/* Resize handles */
.al-band-resize {
  position: absolute;
  top: 0; bottom: 0;
  width: 8px;
  cursor: ew-resize;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
}
.al-band:hover .al-band-resize { opacity: 1; }
.al-band-resize-left { left: 0; border-radius: 8px 0 0 8px; }
.al-band-resize-right { right: 0; border-radius: 0 8px 8px 0; }
.al-band-resize::after {
  content: '';
  display: block;
  width: 3px;
  height: 14px;
  background: rgba(0,0,0,0.3);
  border-radius: 2px;
}

/* ── Drag Ghost ── */
.al-drag-ghost {
  position: fixed;
  pointer-events: none;
  z-index: 9999;
  padding: 7px 12px;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  min-width: 120px;
}
.al-ghost-name {
  font-size: 12px;
  font-weight: 700;
}
.al-ghost-time {
  font-size: 11px;
  opacity: 0.75;
  margin-top: 2px;
}

/* ── Popover Modal ── */
.al-popover-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15,23,42,0.3);
  backdrop-filter: blur(3px);
  z-index: 9990;
  animation: al-fade-in 0.15s ease;
}

@keyframes al-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.al-popover {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -44%) scale(0.97);
  width: 400px;
  max-height: 90vh;
  overflow-y: auto;
  z-index: 9991;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06);
  opacity: 0;
  transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s ease;
  display: flex;
  flex-direction: column;
}

.al-popover.al-popover-visible {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}

.al-pop-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 14px 14px 0 0;
  color: #1e293b;
  flex-shrink: 0;
}

.al-pop-header-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.al-pop-header-info { flex: 1; min-width: 0; }

.al-pop-header-name {
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.al-pop-header-type {
  font-size: 11px;
  color: #64748b;
  margin-top: 1px;
  text-transform: capitalize;
}

.al-pop-close {
  background: rgba(0,0,0,0.06);
  border: none;
  color: #64748b;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s;
}
.al-pop-close:hover { background: rgba(0,0,0,0.1); color: #1e293b; }

.al-pop-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  overflow-y: auto;
}

.al-pop-section-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #94a3b8;
  margin: 8px 0 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid #f1f5f9;
  display: flex;
  align-items: center;
  gap: 6px;
}

.al-pop-section-sub {
  font-weight: 400;
  font-size: 10px;
  letter-spacing: 0;
  text-transform: none;
  color: #cbd5e1;
}

.al-pop-field {
  margin-bottom: 10px;
}

.al-pop-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #475569;
  margin-bottom: 5px;
}

.al-pop-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.al-pop-input {
  height: 32px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1.5px solid #e2e8f0;
  background: #f9fafb;
  font-size: 12px;
  color: #1e293b;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  flex: 1;
}
.al-pop-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
  background: #fff;
}

.al-pop-input-sm {
  flex: none;
  width: 80px;
}

.al-pop-arrow { color: #cbd5e1; font-size: 14px; flex-shrink: 0; }

.al-pop-unit {
  font-size: 11px;
  color: #94a3b8;
  flex-shrink: 0;
}

.al-pop-ops {
  display: flex;
  border: 1.5px solid #e2e8f0;
  border-radius: 7px;
  overflow: hidden;
  flex-shrink: 0;
}

.al-pop-op {
  padding: 0 10px;
  height: 32px;
  border: none;
  background: #f9fafb;
  color: #64748b;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  border-right: 1px solid #e2e8f0;
}
.al-pop-op:last-child { border-right: none; }
.al-pop-op:hover { background: #f1f5f9; }
.al-pop-op.active { background: #6366f1; color: #fff; }

.al-pop-toggle-group {
  display: flex;
  border: 1.5px solid #e2e8f0;
  border-radius: 7px;
  overflow: hidden;
}

.al-pop-toggle {
  padding: 0 14px;
  height: 32px;
  border: none;
  background: #f9fafb;
  color: #64748b;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s;
  border-right: 1px solid #e2e8f0;
}
.al-pop-toggle:last-child { border-right: none; }
.al-pop-toggle:hover { background: #f1f5f9; }
.al-pop-toggle.active { background: #6366f1; color: #fff; font-weight: 600; }

.al-pin-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 7px;
  border: 1.5px solid #e2e8f0;
  background: #f9fafb;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.al-pin-toggle:hover { border-color: #cbd5e1; }
.al-pin-toggle.active { background: #fffbeb; border-color: #fcd34d; color: #92400e; }

.al-pop-divider {
  height: 1px;
  background: #f1f5f9;
  margin: 8px 0;
}

.al-pop-hint {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.5;
  margin-top: 4px;
}
.al-pop-hint b { color: #64748b; }

.al-pop-hint-warn {
  background: #fffbeb;
  color: #92400e;
  border-radius: 6px;
  padding: 4px 8px;
}
.al-pop-hint-warn b { color: #78350f; }

.al-pop-actions {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #f1f5f9;
  background: #fafbfc;
  border-radius: 0 0 14px 14px;
  flex-shrink: 0;
}

.al-pop-action-btn {
  height: 34px;
  padding: 0 16px;
  border-radius: 8px;
  border: none;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  flex: 1;
}

.al-pop-action-delete {
  background: #fef2f2;
  color: #dc2626;
  border: 1.5px solid #fecaca;
}
.al-pop-action-delete:hover { background: #fee2e2; }

.al-pop-action-done {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  box-shadow: 0 2px 8px rgba(99,102,241,0.25);
}
.al-pop-action-done:hover {
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  box-shadow: 0 4px 12px rgba(99,102,241,0.35);
  transform: translateY(-1px);
}

/* ── Copy Modal ── */
.al-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15,23,42,0.3);
  backdrop-filter: blur(3px);
  z-index: 9995;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: al-fade-in 0.15s ease;
}

.al-copy-modal {
  background: #fff;
  border-radius: 14px;
  padding: 20px;
  min-width: 280px;
  max-width: 380px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.05);
  animation: al-slide-up 0.2s cubic-bezier(0.34,1.56,0.64,1);
}

@keyframes al-slide-up {
  from { transform: translateY(12px) scale(0.97); opacity: 0; }
  to   { transform: translateY(0) scale(1); opacity: 1; }
}

.al-modal-header { font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 6px; }
.al-modal-sub { font-size: 11px; color: #64748b; margin-bottom: 14px; }

.al-modal-check-row {
  padding: 6px 0;
  font-size: 12px;
  color: #334155;
  border-bottom: 1px solid #f8fafc;
}
.al-modal-check-row input { margin-right: 6px; }

.al-modal-warn {
  color: #d97706;
  font-size: 10px;
  font-weight: 600;
}

.al-modal-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

/* ── Notifications ── */
.al-notification {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 10000;
  padding: 10px 16px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 4px 16px rgba(0,0,0,0.1);
  animation: al-notif-in 0.25s cubic-bezier(0.34,1.56,0.64,1);
  transition: opacity 0.4s;
}

@keyframes al-notif-in {
  from { transform: translateY(12px) scale(0.96); opacity: 0; }
  to   { transform: translateY(0) scale(1); opacity: 1; }
}

.al-notification-success { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
.al-notification-error   { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
.al-notification-info    { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
.al-notification-warning { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }

/* ── Empty State ── */
.al-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 300px;
  color: #94a3b8;
  gap: 8px;
}
.al-empty-icon { font-size: 36px; opacity: 0.3; }
.al-empty-state p { font-size: 14px; font-weight: 600; margin: 0; }
.al-empty-sub { font-size: 12px; color: #cbd5e1; }

/* ── Fullscreen ── */
.al-fullscreen-btn { font-size: 16px; padding: 0 8px; min-width: 32px; justify-content: center; }
.al-container:fullscreen { border-radius: 0; height: 100vh !important; }
.al-container:-webkit-full-screen { border-radius: 0; height: 100vh !important; }

/* ── Mobile ── */
@media (max-width: 640px) {
  .al-statusbar { flex-wrap: wrap; height: auto; padding: 6px 10px; gap: 6px; }
  .al-statusbar-left { min-width: 0; flex: 1; }
  .al-statusbar-center { flex: 1 1 100%; order: 3; justify-content: flex-start; gap: 4px; flex-wrap: wrap; }
  .al-statusbar-right { flex: 0 0 auto; gap: 4px; }
  .al-sb-btn-generate { order: -1; }
  .al-palette { display: none; }
  .al-grade-label { width: 60px; min-width: 60px; }
}
`;
  document.head.appendChild(s);
})();

})();
