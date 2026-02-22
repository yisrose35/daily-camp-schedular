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
//  - Band shows pin icon 📌 when pinned
//
// Integration: Lives inside Master Schedule Builder as Auto mode tab.
//              Outputs layer templates that the auto_schedule_solver
//              converts into standard skeletons for Daily Adjustments.
// =================================================================

(function() {
'use strict';

// =================================================================
// MODULE STATE
// =================================================================
let layerContainer = null;
let layers = [];            // current working layers
let selectedLayerId = null;
let currentTemplate = null;
let hasChanges = false;

// Grid config
const HOUR_WIDTH = 120;     // pixels per hour
const MIN_WIDTH = HOUR_WIDTH / 60;  // pixels per minute
const SNAP_MINUTES = 5;     // snap to 5-min increments

// Drag state
let dragState = null;

// =================================================================
// LAYER COLORS (matches master builder palette)
// =================================================================
const LAYER_COLORS = {
  sport:      { bg: 'rgba(134,239,172,0.55)', border: '#22c55e', text: '#14532d' },
  special:    { bg: 'rgba(196,181,253,0.55)', border: '#8b5cf6', text: '#3b1f6b' },
  activity:   { bg: 'rgba(147,197,253,0.55)', border: '#3b82f6', text: '#1e3a5f' },
  lunch:      { bg: 'rgba(253,186,116,0.70)', border: '#f97316', text: '#7c2d12' },
  swim:       { bg: 'rgba(103,232,249,0.55)', border: '#06b6d4', text: '#164e63' },
  snack:      { bg: 'rgba(253,230,138,0.65)', border: '#eab308', text: '#78350f' },
  dismissal:  { bg: 'rgba(249,168,212,0.55)', border: '#ec4899', text: '#831843' },
  league:     { bg: 'rgba(252,165,165,0.55)', border: '#ef4444', text: '#7f1d1d' },
  custom:     { bg: 'rgba(209,213,219,0.55)', border: '#6b7280', text: '#374151' }
};

// Palette tile definitions
const PALETTE_TILES = [
  { type: 'sport',     name: 'Sport',           defaultDuration: 40, defaultOp: '≥', defaultQty: 1 },
  { type: 'special',   name: 'Special Activity', defaultDuration: 40, defaultOp: '≥', defaultQty: 1 },
  { type: 'activity',  name: 'Activity',         defaultDuration: 40, defaultOp: '≥', defaultQty: 1 },
  { type: 'lunch',     name: 'Lunch',            defaultDuration: 30, defaultOp: '=', defaultQty: 1 },
  { type: 'swim',      name: 'Swim',             defaultDuration: 40, defaultOp: '=', defaultQty: 1 },
  { type: 'snack',     name: 'Snack',            defaultDuration: 15, defaultOp: '=', defaultQty: 1 },
  { type: 'dismissal', name: 'Dismissal',        defaultDuration: 15, defaultOp: '=', defaultQty: 1 },
  { type: 'league',    name: 'League Game',       defaultDuration: 50, defaultOp: '≤', defaultQty: 1 },
  { type: 'custom',    name: 'Custom',           defaultDuration: 30, defaultOp: '≥', defaultQty: 1 }
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

function fmtTimeShort(min) {
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

function getColor(type) {
  return LAYER_COLORS[type] || LAYER_COLORS.custom;
}

// =================================================================
// GET GRADES + TIME BOUNDS
// =================================================================
function getGrades() {
  const divisions = window.divisions || {};
  const grades = Object.keys(divisions).sort((a, b) => {
    const numA = parseInt(a), numB = parseInt(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(a).localeCompare(String(b));
  });
  return grades;
}

function getGradeTime(gradeName) {
  const div = (window.divisions || {})[gradeName];
  if (!div) return { start: 540, end: 960 };
  const s = parseTime(div.startTime);
  const e = parseTime(div.endTime);
  return {
    start: s != null ? s : 540,
    end: e != null ? e : 960
  };
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

  // Also check if any layers extend beyond
  layers.forEach(l => {
    if (l.startMin < earliest) earliest = l.startMin;
    if (l.endMin > latest) latest = l.endMin;
  });

  return {
    dayStart: earliest === Infinity ? 540 : earliest,
    dayEnd: latest === -Infinity ? 960 : latest
  };
}

function minToX(min, dayStart) {
  return (min - dayStart) * MIN_WIDTH;
}

function xToMin(x, dayStart) {
  return snap(x / MIN_WIDTH + dayStart);
}

// =================================================================
// INITIALIZATION
// =================================================================
function init(containerEl) {
  layerContainer = containerEl;
  if (!layerContainer) return;

  // Load draft layers
  loadDraftLayers();

  // Initial render
  render();

  // Global mouse/keyboard listeners
  setupGlobalListeners();

  console.log('[AutoPlanner] Initialized with', layers.length, 'layers');
}

function destroy() {
  layerContainer = null;
  layers = [];
  selectedLayerId = null;
  dragState = null;
}

// =================================================================
// PERSISTENCE
// =================================================================
function saveDraftLayers() {
  try {
    localStorage.setItem('auto-layers-draft', JSON.stringify(layers));
    if (currentTemplate) {
      localStorage.setItem('auto-layers-template-name', currentTemplate);
    }
  } catch(e) { console.error('[AutoPlanner] Save error:', e); }
}

function loadDraftLayers() {
  try {
    const raw = localStorage.getItem('auto-layers-draft');
    if (raw) {
      layers = JSON.parse(raw);
    }
    currentTemplate = localStorage.getItem('auto-layers-template-name') || null;
  } catch(e) { layers = []; }
}

function saveTemplate(name) {
  const saved = JSON.parse(localStorage.getItem('auto-layer-templates') || '{}');
  saved[name] = JSON.parse(JSON.stringify(layers));
  localStorage.setItem('auto-layer-templates', JSON.stringify(saved));
  currentTemplate = name;
  hasChanges = false;
  saveDraftLayers();
}

function loadTemplate(name) {
  const saved = JSON.parse(localStorage.getItem('auto-layer-templates') || '{}');
  if (saved[name]) {
    layers = JSON.parse(JSON.stringify(saved[name]));
    currentTemplate = name;
    hasChanges = false;
    saveDraftLayers();
    render();
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

// =================================================================
// TEMPLATE ASSIGNMENTS (which template for which day)
// =================================================================
function getLayerAssignments() {
  return JSON.parse(localStorage.getItem('auto-layer-assignments') || '{}');
}

function saveLayerAssignments(assignments) {
  localStorage.setItem('auto-layer-assignments', JSON.stringify(assignments));
}

// =================================================================
// RENDER
// =================================================================
function render() {
  if (!layerContainer) return;

  const grades = getGrades();
  const { dayStart, dayEnd } = getDayBounds();
  const totalMinutes = dayEnd - dayStart;
  const totalWidth = totalMinutes * MIN_WIDTH;

  if (grades.length === 0) {
    layerContainer.innerHTML = `
      <div class="al-container" style="padding:40px;text-align:center;color:#6b7280;">
        <p>No grades/divisions configured.</p>
        <p style="font-size:0.9rem;">Go to Setup to create divisions first.</p>
      </div>`;
    return;
  }

  // Build HTML
  let html = `<div class="al-container">`;

  // ── Toolbar ──
  html += renderToolbar();

  // ── Body: Palette + Timeline ──
  html += `<div class="al-body">`;

  // Palette
  html += renderPalette();

  // Timeline area
  html += `<div class="al-timeline-area">`;
  html += `<div class="al-timeline-scroll" style="width:${totalWidth + 90}px;">`;

  // Time header
  html += renderTimeHeader(dayStart, dayEnd);

  // Grade rows
  grades.forEach(grade => {
    html += renderGradeRow(grade, dayStart, dayEnd, totalWidth);
  });

  html += `</div></div>`; // close scroll + area
  html += `</div>`; // close body
  html += `</div>`; // close container

  layerContainer.innerHTML = html;

  // Bind events
  setupPaletteDrag();
  setupDropZones(dayStart);
  setupBandEvents(dayStart);
  setupToolbarEvents();
}

// =================================================================
// RENDER: TOOLBAR
// =================================================================
function renderToolbar() {
  const templateNames = getTemplateNames();
  const loadOptions = templateNames.map(n =>
    `<option value="${n}" ${n === currentTemplate ? 'selected' : ''}>${n}</option>`
  ).join('');

  const statusText = currentTemplate
    ? (hasChanges ? `${currentTemplate} (modified)` : currentTemplate)
    : (layers.length > 0 ? 'Unsaved layers' : 'No layers');

  const statusColor = hasChanges ? '#f59e0b' : (currentTemplate ? '#10b981' : '#94a3b8');

  return `
    <div class="al-toolbar">
      <div class="al-toolbar-group">
        <span style="font-size:11px;font-weight:600;color:${statusColor};">● ${statusText}</span>
      </div>
      <div class="al-toolbar-sep"></div>
      <div class="al-toolbar-group">
        <select id="al-load-select" class="al-select">
          <option value="">Load Template…</option>
          ${loadOptions}
        </select>
        <button id="al-load-btn" class="al-btn al-btn-ghost al-btn-sm">Load</button>
      </div>
      <div class="al-toolbar-group">
        <button id="al-save-btn" class="al-btn al-btn-primary al-btn-sm">💾 Save</button>
        <button id="al-save-as-btn" class="al-btn al-btn-ghost al-btn-sm">Save As…</button>
      </div>
      <div class="al-toolbar-sep"></div>
      <div class="al-toolbar-group">
        <button id="al-copy-grade-btn" class="al-btn al-btn-ghost al-btn-sm">📋 Copy Grade</button>
        <button id="al-clear-btn" class="al-btn al-btn-danger al-btn-sm">🗑 Clear All</button>
      </div>
      <div class="al-toolbar-sep"></div>
      <div class="al-toolbar-group">
        <button id="al-preview-btn" class="al-btn al-btn-success al-btn-sm">👁 Preview Skeleton</button>
        <button id="al-generate-btn" class="al-btn al-btn-primary">⚡ Generate Schedule</button>
      </div>
    </div>`;
}

// =================================================================
// RENDER: PALETTE
// =================================================================
function renderPalette() {
  let html = `<div class="al-palette">`;
  html += `<div class="al-palette-title">Layer Types</div>`;

  PALETTE_TILES.forEach(tile => {
    html += `
      <div class="al-tile al-tile-${tile.type}" draggable="true" data-tile='${JSON.stringify(tile)}'>
        ${tile.name}
      </div>`;
  });

  html += `</div>`;
  return html;
}

// =================================================================
// RENDER: TIME HEADER
// =================================================================
function renderTimeHeader(dayStart, dayEnd) {
  let html = `<div class="al-time-header" style="width:${(dayEnd - dayStart) * MIN_WIDTH + 90}px;">`;

  // Marks every 30 min
  for (let m = dayStart; m <= dayEnd; m += 30) {
    const left = 90 + (m - dayStart) * MIN_WIDTH;
    const isHour = m % 60 === 0;
    html += `<div class="al-time-mark" style="left:${left}px;${isHour ? 'font-weight:600;color:#334155;' : ''}">${fmtTimeShort(m)}</div>`;
  }

  html += `</div>`;
  return html;
}

// =================================================================
// RENDER: GRADE ROW
// =================================================================
function renderGradeRow(grade, dayStart, dayEnd, totalWidth) {
  const gradeTime = getGradeTime(grade);
  const gradeLayers = layers.filter(l => l.grade === grade);

  // Calculate stacking for overlapping bands
  const stacking = calculateStacking(gradeLayers);
  const rowHeight = Math.max(48, stacking.maxStack * 28 + 12);

  let html = `<div class="al-grade-row" style="height:${rowHeight}px;">`;

  // Grade label
  html += `<div class="al-grade-label">${grade}</div>`;

  // Timeline cell
  html += `<div class="al-grade-timeline" data-grade="${grade}" style="width:${totalWidth}px;height:${rowHeight}px;">`;

  // Grid lines every 30 min
  for (let m = dayStart; m <= dayEnd; m += 30) {
    const left = (m - dayStart) * MIN_WIDTH;
    const isHour = m % 60 === 0;
    html += `<div class="al-grid-line ${isHour ? 'al-grid-line-hour' : ''}" style="left:${left}px;"></div>`;
  }

  // Grey unused zones (before grade start, after grade end)
  if (gradeTime.start > dayStart) {
    const w = (gradeTime.start - dayStart) * MIN_WIDTH;
    html += `<div class="al-unused-zone" style="left:0;width:${w}px;"></div>`;
  }
  if (gradeTime.end < dayEnd) {
    const left = (gradeTime.end - dayStart) * MIN_WIDTH;
    const w = (dayEnd - gradeTime.end) * MIN_WIDTH;
    html += `<div class="al-unused-zone" style="left:${left}px;width:${w}px;"></div>`;
  }

  // Render bands
  gradeLayers.forEach(layer => {
    html += renderBand(layer, dayStart, stacking.assignments[layer.id], stacking.maxStack);
  });

  html += `</div>`; // close timeline
  html += `</div>`; // close row
  return html;
}

// =================================================================
// STACKING: Calculate vertical positions for overlapping bands
// =================================================================
function calculateStacking(gradeLayers) {
  if (gradeLayers.length === 0) return { maxStack: 1, assignments: {} };
  if (gradeLayers.length === 1) return { maxStack: 1, assignments: { [gradeLayers[0].id]: 'solo' } };

  // Sort by start time
  const sorted = [...gradeLayers].sort((a, b) => a.startMin - b.startMin);
  const assignments = {};
  const tracks = []; // each track = endMin of last band in that track

  sorted.forEach(layer => {
    // Find first track that doesn't overlap
    let placed = false;
    for (let i = 0; i < tracks.length; i++) {
      if (layer.startMin >= tracks[i]) {
        tracks[i] = layer.endMin;
        assignments[layer.id] = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      assignments[layer.id] = tracks.length;
      tracks.push(layer.endMin);
    }
  });

  return { maxStack: Math.max(tracks.length, 1), assignments };
}

// =================================================================
// RENDER: INDIVIDUAL BAND
// =================================================================
function renderBand(layer, dayStart, stackIndex, maxStack) {
  const color = getColor(layer.type);
  const left = (layer.startMin - dayStart) * MIN_WIDTH;
  const width = (layer.endMin - layer.startMin) * MIN_WIDTH;
  const isPinned = layer.pinned === true;
  const isSelected = layer.id === selectedLayerId;

  // Vertical position based on stacking
  let topPx, heightPx;
  if (stackIndex === 'solo') {
    topPx = 4;
    heightPx = 'calc(100% - 8px)';
  } else {
    const trackHeight = (100 / maxStack);
    topPx = `${stackIndex * trackHeight}%`;
    heightPx = `calc(${trackHeight}% - 4px)`;
  }

  const borderStyle = isPinned ? 'solid' : 'dashed';
  const selectedClass = isSelected ? 'al-band-selected' : '';

  // Duration text
  const durText = layer.durationMin ? `${layer.durationMin}m` : '';

  // Time text
  const timeText = `${fmtTimeShort(layer.startMin)}–${fmtTimeShort(layer.endMin)}`;

  // Badge
  const badge = `${layer.operator || '≥'}${layer.quantity || 1}`;

  // Pin icon
  const pinHtml = isPinned ? '<span class="al-band-pin">📌</span>' : '';

  return `
    <div class="al-band ${selectedClass}"
         data-layer-id="${layer.id}"
         style="left:${left}px; width:${width}px; top:${typeof topPx === 'number' ? topPx + 'px' : topPx}; height:${heightPx};
                background:${color.bg}; border:2px ${borderStyle} ${color.border}; color:${color.text};">
      <div class="al-band-resize al-band-resize-left"></div>
      ${pinHtml}
      <span class="al-band-label">${layer.event || layer.type}</span>
      <span class="al-band-dur">${durText}</span>
      <span class="al-band-badge">${badge}</span>
      <span class="al-band-time">${timeText}</span>
      <div class="al-band-resize al-band-resize-right"></div>
    </div>`;
}

// =================================================================
// PALETTE DRAG
// =================================================================
function setupPaletteDrag() {
  document.querySelectorAll('.al-tile').forEach(tile => {
    tile.ondragstart = (e) => {
      const data = tile.dataset.tile;
      e.dataTransfer.setData('application/layer-tile', data);
      e.dataTransfer.effectAllowed = 'copy';
    };
  });
}

// =================================================================
// DROP ZONES
// =================================================================
function setupDropZones(dayStart) {
  document.querySelectorAll('.al-grade-timeline').forEach(timeline => {
    timeline.ondragover = (e) => {
      if (e.dataTransfer.types.includes('application/layer-tile')) {
        e.preventDefault();
        timeline.classList.add('al-drop-hover');
      }
    };
    timeline.ondragleave = () => timeline.classList.remove('al-drop-hover');

    timeline.ondrop = (e) => {
      e.preventDefault();
      timeline.classList.remove('al-drop-hover');

      const data = e.dataTransfer.getData('application/layer-tile');
      if (!data) return;

      const tile = JSON.parse(data);
      const grade = timeline.dataset.grade;
      const rect = timeline.getBoundingClientRect();
      const x = e.clientX - rect.left;

      const dropMin = xToMin(x, dayStart);
      const gradeTime = getGradeTime(grade);

      // Default window: center on drop, defaultDuration wide but add buffer
      const halfSpan = Math.max((tile.defaultDuration || 40) + 30, 60) / 2;
      let startMin = snap(Math.max(gradeTime.start, dropMin - halfSpan));
      let endMin = snap(Math.min(gradeTime.end, dropMin + halfSpan));

      // Ensure minimum width
      if (endMin - startMin < tile.defaultDuration) {
        endMin = Math.min(gradeTime.end, startMin + tile.defaultDuration + 30);
      }

      const newLayer = {
        id: uid(),
        type: tile.type,
        event: tile.name,
        startMin,
        endMin,
        durationMin: tile.defaultDuration,
        operator: tile.defaultOp,
        quantity: tile.defaultQty,
        grade,
        pinned: false
      };

      layers.push(newLayer);
      hasChanges = true;
      selectedLayerId = newLayer.id;
      saveDraftLayers();
      render();
    };
  });
}

// =================================================================
// BAND EVENTS (click, dblclick, resize, move)
// =================================================================
function setupBandEvents(dayStart) {
  document.querySelectorAll('.al-band').forEach(band => {
    const layerId = band.dataset.layerId;

    // Click to select
    band.onclick = (e) => {
      if (e.target.classList.contains('al-band-resize')) return;
      e.stopPropagation();
      selectedLayerId = layerId;
      refreshSelection();
    };

    // Double-click to edit
    band.ondblclick = (e) => {
      e.stopPropagation();
      selectedLayerId = layerId;
      openPopover(layerId, band);
    };

    // Resize handles
    band.querySelectorAll('.al-band-resize').forEach(handle => {
      handle.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const layer = layers.find(l => l.id === layerId);
        if (!layer) return;

        const timeline = band.closest('.al-grade-timeline');
        const rect = timeline.getBoundingClientRect();
        const isLeft = handle.classList.contains('al-band-resize-left');

        dragState = {
          type: isLeft ? 'resize-left' : 'resize-right',
          layerId,
          origStartMin: layer.startMin,
          origEndMin: layer.endMin,
          timelineLeft: rect.left,
          dayStart
        };

        selectedLayerId = layerId;
        showDragGhost(layer);
      };
    });

    // Move (drag the band body)
    band.onmousedown = (e) => {
      if (e.target.classList.contains('al-band-resize')) return;
      if (e.button !== 0) return;
      e.preventDefault();

      const layer = layers.find(l => l.id === layerId);
      if (!layer) return;

      const timeline = band.closest('.al-grade-timeline');
      const rect = timeline.getBoundingClientRect();
      const offsetX = e.clientX - band.getBoundingClientRect().left;

      dragState = {
        type: 'move',
        layerId,
        origStartMin: layer.startMin,
        origEndMin: layer.endMin,
        timelineLeft: rect.left,
        offsetX,
        dayStart
      };

      selectedLayerId = layerId;
      showDragGhost(layer);
    };
  });

  // Click on empty timeline to deselect
  document.querySelectorAll('.al-grade-timeline').forEach(tl => {
    tl.onclick = (e) => {
      if (e.target === tl) {
        selectedLayerId = null;
        closePopover();
        refreshSelection();
      }
    };
  });
}

// =================================================================
// DRAG GHOST (shows time while dragging)
// =================================================================
let ghostEl = null;

function showDragGhost(layer) {
  removeDragGhost();
  ghostEl = document.createElement('div');
  ghostEl.className = 'al-drag-ghost';
  ghostEl.innerHTML = `
    <div>${layer.event || layer.type}</div>
    <div class="al-drag-ghost-time" id="al-ghost-time">${fmtTime(layer.startMin)} – ${fmtTime(layer.endMin)}</div>
  `;
  document.body.appendChild(ghostEl);
}

function updateDragGhost(x, y, layer) {
  if (!ghostEl) return;
  ghostEl.style.left = (x + 15) + 'px';
  ghostEl.style.top = (y - 10) + 'px';
  const timeEl = ghostEl.querySelector('#al-ghost-time');
  if (timeEl && layer) {
    timeEl.textContent = `${fmtTime(layer.startMin)} – ${fmtTime(layer.endMin)}`;
  }
}

function removeDragGhost() {
  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }
}

// =================================================================
// GLOBAL MOUSE + KEYBOARD LISTENERS
// =================================================================
function setupGlobalListeners() {
  if (window._alGlobalBound) return;
  window._alGlobalBound = true;

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const layer = layers.find(l => l.id === dragState.layerId);
    if (!layer) { dragState = null; removeDragGhost(); return; }

    const { dayStart } = getDayBounds();
    const gradeTime = getGradeTime(layer.grade);
    const x = e.clientX - dragState.timelineLeft;
    const min = xToMin(x, dayStart);

    if (dragState.type === 'resize-left') {
      layer.startMin = Math.max(gradeTime.start, Math.min(min, layer.endMin - SNAP_MINUTES));
    } else if (dragState.type === 'resize-right') {
      layer.endMin = Math.min(gradeTime.end, Math.max(min, layer.startMin + SNAP_MINUTES));
    } else if (dragState.type === 'move') {
      const duration = dragState.origEndMin - dragState.origStartMin;
      const offsetMin = dragState.offsetX / MIN_WIDTH;
      let newStart = snap(min - offsetMin);
      newStart = Math.max(gradeTime.start, Math.min(newStart, gradeTime.end - duration));
      layer.startMin = newStart;
      layer.endMin = newStart + duration;
    }

    // Update band position live (without full re-render)
    const band = document.querySelector(`.al-band[data-layer-id="${layer.id}"]`);
    if (band) {
      const left = (layer.startMin - dayStart) * MIN_WIDTH;
      const width = (layer.endMin - layer.startMin) * MIN_WIDTH;
      band.style.left = left + 'px';
      band.style.width = width + 'px';

      // Update time label on the band itself
      const timeSpan = band.querySelector('.al-band-time');
      if (timeSpan) {
        timeSpan.textContent = `${fmtTimeShort(layer.startMin)}–${fmtTimeShort(layer.endMin)}`;
      }
    }

    // Update ghost
    updateDragGhost(e.clientX, e.clientY, layer);
  });

  document.addEventListener('mouseup', () => {
    if (dragState) {
      hasChanges = true;
      saveDraftLayers();
      dragState = null;
      removeDragGhost();
      render();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLayerId) {
      e.preventDefault();
      deleteLayer(selectedLayerId);
    }
    if (e.key === 'Escape') {
      selectedLayerId = null;
      closePopover();
      refreshSelection();
    }
  });
}

// =================================================================
// SELECTION
// =================================================================
function refreshSelection() {
  document.querySelectorAll('.al-band').forEach(b => {
    b.classList.toggle('al-band-selected', b.dataset.layerId === selectedLayerId);
  });
}

// =================================================================
// DELETE LAYER
// =================================================================
function deleteLayer(id) {
  layers = layers.filter(l => l.id !== id);
  if (selectedLayerId === id) selectedLayerId = null;
  hasChanges = true;
  saveDraftLayers();
  closePopover();
  render();
}

// =================================================================
// POPOVER EDITOR
// =================================================================
let popoverEl = null;

function openPopover(layerId, bandEl) {
  closePopover();

  const layer = layers.find(l => l.id === layerId);
  if (!layer) return;

  const rect = bandEl.getBoundingClientRect();
  const color = getColor(layer.type);

  // Create overlay to catch outside clicks
  const overlay = document.createElement('div');
  overlay.className = 'al-popover-overlay';
  overlay.onclick = () => closePopover();
  document.body.appendChild(overlay);

  popoverEl = document.createElement('div');
  popoverEl.className = 'al-popover';

  // Position
  let top = rect.bottom + 8;
  let left = rect.left;
  if (top + 350 > window.innerHeight) top = rect.top - 350;
  if (left + 340 > window.innerWidth) left = window.innerWidth - 360;
  popoverEl.style.top = Math.max(10, top) + 'px';
  popoverEl.style.left = Math.max(10, left) + 'px';

  popoverEl.innerHTML = `
    <div class="al-popover-title">
      <span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${color.border};"></span>
      ${layer.event || layer.type}
    </div>

    <div class="al-popover-row">
      <label>Window</label>
      <input type="text" class="al-pop-input" id="al-pop-start" value="${fmtTime(layer.startMin)}" placeholder="Start">
      <span style="color:#94a3b8;">→</span>
      <input type="text" class="al-pop-input" id="al-pop-end" value="${fmtTime(layer.endMin)}" placeholder="End">
    </div>

    <div class="al-popover-row">
      <label>Duration</label>
      <input type="number" class="al-pop-input al-pop-dur" id="al-pop-dur" value="${layer.durationMin || ''}" min="5" step="5" placeholder="min">
      <span style="font-size:10px;color:#94a3b8;">minutes needed</span>
    </div>

    <div class="al-popover-row">
      <label>Quantity</label>
      <div class="al-pop-ops">
        <button class="al-pop-op ${layer.operator === '≥' ? 'active' : ''}" data-op="≥">≥</button>
        <button class="al-pop-op ${layer.operator === '≤' ? 'active' : ''}" data-op="≤">≤</button>
        <button class="al-pop-op ${layer.operator === '=' ? 'active' : ''}" data-op="=">=</button>
      </div>
      <input type="number" class="al-pop-input al-pop-qty" id="al-pop-qty" value="${layer.quantity || 1}" min="1" max="10">
    </div>

    <div class="al-popover-row">
      <label>Pin Time</label>
      <button class="al-pin-toggle ${layer.pinned ? 'active' : ''}" id="al-pop-pin">
        <span class="al-pin-icon">📌</span>
        <span id="al-pin-label">${layer.pinned ? 'Pinned (Exact)' : 'Flexible'}</span>
      </button>
    </div>
    ${layer.pinned ? `
    <div style="padding:4px 0 0 78px;font-size:10px;color:#92400e;background:#fffbeb;border-radius:4px;padding:6px 8px;margin-bottom:4px;">
      ⚠️ This layer MUST occur at exactly ${fmtTime(layer.startMin)}–${fmtTime(layer.endMin)} for this grade.
    </div>` : ''}

    <div class="al-popover-actions">
      <button class="al-btn al-btn-danger al-btn-sm" id="al-pop-delete">🗑 Delete</button>
      <button class="al-btn al-btn-primary al-btn-sm" id="al-pop-done">✓ Done</button>
    </div>
  `;

  document.body.appendChild(popoverEl);

  // Bind popover events
  // Operator buttons
  popoverEl.querySelectorAll('.al-pop-op').forEach(btn => {
    btn.onclick = () => {
      popoverEl.querySelectorAll('.al-pop-op').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Pin toggle
  const pinBtn = popoverEl.querySelector('#al-pop-pin');
  pinBtn.onclick = () => {
    pinBtn.classList.toggle('active');
    const label = pinBtn.querySelector('#al-pin-label');
    label.textContent = pinBtn.classList.contains('active') ? 'Pinned (Exact)' : 'Flexible';
  };

  // Delete
  popoverEl.querySelector('#al-pop-delete').onclick = () => {
    deleteLayer(layerId);
  };

  // Done — save changes
  popoverEl.querySelector('#al-pop-done').onclick = () => {
    const startVal = parseTime(popoverEl.querySelector('#al-pop-start').value);
    const endVal = parseTime(popoverEl.querySelector('#al-pop-end').value);
    const durVal = parseInt(popoverEl.querySelector('#al-pop-dur').value) || null;
    const qtyVal = parseInt(popoverEl.querySelector('#al-pop-qty').value) || 1;
    const activeOp = popoverEl.querySelector('.al-pop-op.active');
    const opVal = activeOp ? activeOp.dataset.op : '≥';
    const isPinned = popoverEl.querySelector('#al-pop-pin').classList.contains('active');

    if (startVal != null) layer.startMin = snap(startVal);
    if (endVal != null) layer.endMin = snap(endVal);
    if (durVal) layer.durationMin = durVal;
    layer.quantity = qtyVal;
    layer.operator = opVal;
    layer.pinned = isPinned;

    hasChanges = true;
    saveDraftLayers();
    closePopover();
    render();
  };
}

function closePopover() {
  document.querySelectorAll('.al-popover-overlay').forEach(o => o.remove());
  if (popoverEl) {
    popoverEl.remove();
    popoverEl = null;
  }
}

// =================================================================
// TOOLBAR EVENTS
// =================================================================
function setupToolbarEvents() {
  // Load
  const loadBtn = document.getElementById('al-load-btn');
  if (loadBtn) {
    loadBtn.onclick = () => {
      const sel = document.getElementById('al-load-select');
      if (sel && sel.value) loadTemplate(sel.value);
    };
  }

  // Save
  const saveBtn = document.getElementById('al-save-btn');
  if (saveBtn) {
    saveBtn.onclick = () => {
      if (currentTemplate) {
        saveTemplate(currentTemplate);
        showNotification('Template saved!', 'success');
        render();
      } else {
        promptSaveAs();
      }
    };
  }

  // Save As
  const saveAsBtn = document.getElementById('al-save-as-btn');
  if (saveAsBtn) {
    saveAsBtn.onclick = promptSaveAs;
  }

  // Copy Grade
  const copyBtn = document.getElementById('al-copy-grade-btn');
  if (copyBtn) {
    copyBtn.onclick = openCopyGradeModal;
  }

  // Clear
  const clearBtn = document.getElementById('al-clear-btn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (layers.length === 0) return;
      if (!confirm('Clear all layers?')) return;
      layers = [];
      selectedLayerId = null;
      hasChanges = true;
      saveDraftLayers();
      render();
    };
  }

  // Preview
  const previewBtn = document.getElementById('al-preview-btn');
  if (previewBtn) {
    previewBtn.onclick = () => {
      if (window.AutoScheduleSolver) {
        const result = window.AutoScheduleSolver.generateSkeleton(buildSolverRequirements());
        console.log('[AutoPlanner] Preview skeleton:', result);
        showNotification(`Preview: ${result.skeleton?.length || 0} blocks, ${result.warnings?.length || 0} warnings`, 'info');
      } else {
        showNotification('Solver not loaded', 'error');
      }
    };
  }

  // Generate
  const genBtn = document.getElementById('al-generate-btn');
  if (genBtn) {
    genBtn.onclick = () => {
      if (window.AutoScheduleSolver) {
        const requirements = buildSolverRequirements();
        const result = window.AutoScheduleSolver.generateAndRun(requirements);
        if (result.success) {
          showNotification('Schedule generated! ⚡', 'success');
        } else {
          showNotification('Generation failed: ' + (result.warnings?.[0] || 'Unknown error'), 'error');
        }
      } else {
        showNotification('Solver not loaded', 'error');
      }
    };
  }
}

// =================================================================
// BUILD SOLVER REQUIREMENTS FROM LAYERS
// =================================================================
function buildSolverRequirements() {
  const grades = getGrades();
  const requirements = {};

  grades.forEach(grade => {
    const gradeLayers = layers.filter(l => l.grade === grade);
    const gradeTime = getGradeTime(grade);

    requirements[grade] = {
      dayStart: gradeTime.start,
      dayEnd: gradeTime.end,
      items: gradeLayers.map(l => ({
        name: l.event || l.type,
        kind: l.type,
        duration: l.durationMin || 40,
        windowStart: l.startMin,
        windowEnd: l.endMin,
        fixed: l.pinned === true,
        operator: l.operator || '≥',
        quantity: l.quantity || 1
      }))
    };
  });

  return requirements;
}

// =================================================================
// COPY GRADE MODAL
// =================================================================
function openCopyGradeModal() {
  const grades = getGrades();
  if (grades.length < 2) {
    showNotification('Need at least 2 grades to copy', 'info');
    return;
  }

  // Find source (the selected layer's grade, or first grade with layers)
  let sourceGrade = null;
  if (selectedLayerId) {
    const l = layers.find(x => x.id === selectedLayerId);
    if (l) sourceGrade = l.grade;
  }
  if (!sourceGrade) {
    sourceGrade = grades.find(g => layers.some(l => l.grade === g)) || grades[0];
  }

  const overlay = document.createElement('div');
  overlay.className = 'al-modal-overlay';
  overlay.onclick = () => overlay.remove();

  const modal = document.createElement('div');
  modal.className = 'al-copy-modal';
  modal.onclick = (e) => e.stopPropagation();

  let modalHtml = `
    <div style="font-size:14px;font-weight:600;margin-bottom:12px;">Copy Layers from ${sourceGrade}</div>
    <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Select grades to copy to:</div>
  `;

  grades.filter(g => g !== sourceGrade).forEach(g => {
    const hasLayers = layers.some(l => l.grade === g);
    modalHtml += `
      <div class="al-copy-grade-row">
        <label>
          <input type="checkbox" value="${g}" checked>
          ${g} ${hasLayers ? '<span style="color:#f59e0b;font-size:10px;">(has layers — will replace)</span>' : ''}
        </label>
      </div>`;
  });

  modalHtml += `
    <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
      <button class="al-btn al-btn-ghost al-btn-sm" id="al-copy-cancel">Cancel</button>
      <button class="al-btn al-btn-primary al-btn-sm" id="al-copy-confirm">Copy</button>
    </div>`;

  modal.innerHTML = modalHtml;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelector('#al-copy-cancel').onclick = () => overlay.remove();
  modal.querySelector('#al-copy-confirm').onclick = () => {
    const checked = [...modal.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
    const sourceLayers = layers.filter(l => l.grade === sourceGrade);

    checked.forEach(targetGrade => {
      // Remove existing layers for target
      layers = layers.filter(l => l.grade !== targetGrade);

      // Copy source layers with new IDs and adjusted times
      const targetTime = getGradeTime(targetGrade);
      sourceLayers.forEach(sl => {
        layers.push({
          ...JSON.parse(JSON.stringify(sl)),
          id: uid(),
          grade: targetGrade,
          // Clamp to target grade's time bounds
          startMin: Math.max(targetTime.start, sl.startMin),
          endMin: Math.min(targetTime.end, sl.endMin)
        });
      });
    });

    hasChanges = true;
    saveDraftLayers();
    overlay.remove();
    render();
    showNotification(`Copied to ${checked.length} grade(s)`, 'success');
  };
}

// =================================================================
// SAVE AS PROMPT
// =================================================================
function promptSaveAs() {
  const name = prompt('Template name:', currentTemplate || 'Regular Day');
  if (!name) return;
  saveTemplate(name.trim());
  showNotification(`Saved as "${name.trim()}"`, 'success');
  render();
}

// =================================================================
// NOTIFICATIONS
// =================================================================
function showNotification(msg, type) {
  const existing = document.querySelectorAll('.al-notification');
  existing.forEach(n => n.remove());

  const n = document.createElement('div');
  n.className = `al-notification al-notification-${type || 'info'}`;
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3000);
}

// =================================================================
// PUBLIC API
// =================================================================
window.AutoSchedulePlanner = {
  init,
  destroy,
  render,
  getLayers: () => [...layers],
  setLayers: (newLayers) => { layers = newLayers; hasChanges = true; saveDraftLayers(); render(); },
  getTemplateNames,
  loadTemplate,
  saveTemplate,
  deleteTemplate,
  getLayerAssignments,
  saveLayerAssignments,
  buildSolverRequirements,
  PALETTE_TILES,
  LAYER_COLORS
};

})();
