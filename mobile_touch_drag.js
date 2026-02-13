// =================================================================
// mobile_touch_drag.js v2.0
// =================================================================
// UNIVERSAL MOBILE TOUCH DRAG-AND-DROP for Campistry Schedulers
//
// v2.0 CHANGES:
// - Fixed DA palette tile drop (ensure ondrop fires correctly)
// - Added touch-based RESIZE for tiles (both MS and DA)
// - Added touch-based DRAG-TO-REPOSITION for existing tiles (both MS and DA)
// - Better ghost positioning and cell detection
//
// FEATURES:
//   MODE A — "Tap to Select, Tap to Place" (palette tiles)
//   MODE B — "Long-press Drag" from palette (300ms hold)
//   MODE C — "Touch Drag to Reposition" existing tiles on grid
//   MODE D — "Touch Resize" via resize handles on tiles
//
// LOAD ORDER: After master_schedule_builder.js and daily_adjustments.js
// =================================================================
(function() {
'use strict';

// =================================================================
// STATE
// =================================================================
let selectedMSTile = null;
let selectedDATile = null;
let isDragging = false;
let dragGhost = null;
let dragTileData = null;
let dragSourceModule = null;
let longPressTimer = null;
const LONG_PRESS_MS = 300;

// Resize state
let isResizing = false;
let resizeState = null;

// Reposition state  
let isRepositioning = false;
let repositionState = null;

// Constants (must match both MS and DA)
const PIXELS_PER_MINUTE = 2;
const SNAP_MINS = 5;

// =================================================================
// INITIALIZATION
// =================================================================
const observer = new MutationObserver(() => {
  setupMasterSchedulerTouch();
  setupDailyAdjustmentsTouch();
});

function init() {
  const targets = [
    document.getElementById('master-scheduler-content'),
    document.getElementById('daily-adjustments-content')
  ].filter(Boolean);

  targets.forEach(t => {
    observer.observe(t, { childList: true, subtree: true });
  });

  setupMasterSchedulerTouch();
  setupDailyAdjustmentsTouch();
  ensureGhost();
  ensureStyles();

  // Global cleanup handlers
  document.addEventListener('touchcancel', cleanupAll);
}

function ensureGhost() {
  if (document.getElementById('mobile-drag-ghost')) return;
  dragGhost = document.createElement('div');
  dragGhost.id = 'mobile-drag-ghost';
  dragGhost.style.cssText = `
    position: fixed; z-index: 100000; pointer-events: none;
    padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 600;
    background: #fff; border: 2px solid #3b82f6;
    box-shadow: 0 8px 24px rgba(59,130,246,0.35);
    display: none; max-width: 160px; text-align: center;
    transform: translate(-50%, -120%);
  `;
  document.body.appendChild(dragGhost);
}

function ensureStyles() {
  if (document.getElementById('mobile-touch-styles')) return;
  const style = document.createElement('style');
  style.id = 'mobile-touch-styles';
  style.textContent = `
    .mobile-selected {
      outline: 3px solid #3b82f6 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 12px rgba(59,130,246,0.4) !important;
    }
    .mobile-drop-target {
      background: rgba(59,130,246,0.06) !important;
    }
    .mobile-selection-bar {
      position: sticky; top: 0; z-index: 100;
      background: #eff6ff; border: 1px solid #93c5fd;
      border-radius: 8px; padding: 8px 12px;
      margin: 6px 0; display: none;
      font-size: 12px; color: #1e40af;
      text-align: center;
    }
    .mobile-selection-bar .bar-clear {
      margin-left: 8px; background: #3b82f6; color: #fff;
      border: none; border-radius: 4px; padding: 3px 8px;
      font-size: 11px; cursor: pointer;
    }
    /* Touch-friendly resize handles */
    @media (pointer: coarse) {
      .resize-handle, .da-resize-handle {
        height: 16px !important;
        opacity: 0.7 !important;
        background: rgba(59,130,246,0.3) !important;
      }
      .resize-handle-top, .da-resize-top { top: -4px !important; }
      .resize-handle-bottom, .da-resize-bottom { bottom: -4px !important; }
      .grid-event, .da-event {
        touch-action: none;
      }
    }
    /* Reposition feedback */
    .mobile-repositioning {
      opacity: 0.5 !important;
      outline: 2px dashed #3b82f6 !important;
    }
    /* Resize tooltip for mobile */
    #mobile-resize-tooltip {
      position: fixed; padding: 6px 10px; background: #111827; color: #fff;
      border-radius: 6px; font-size: 11px; font-weight: 600;
      pointer-events: none; z-index: 100001; display: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); text-align: center;
    }
  `;
  document.head.appendChild(style);
}

// =================================================================
// DETECT TOUCH DEVICE
// =================================================================
function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

// =================================================================
// MASTER SCHEDULER — TOUCH SETUP
// =================================================================
function setupMasterSchedulerTouch() {
  if (!isTouchDevice()) return;

  const palette = document.querySelector('#master-scheduler-content .ms-palette') ||
                  document.querySelector('.ms-palette');
  const gridWrapper = document.querySelector('#master-scheduler-content .ms-grid-wrapper') ||
                      document.querySelector('.ms-grid-wrapper');
  if (!palette || !gridWrapper) return;

  if (palette.dataset.mobileTouchBound === '1') return;
  palette.dataset.mobileTouchBound = '1';

  injectSelectionBar(palette, 'ms');

  palette.querySelectorAll('.ms-tile').forEach(el => {
    el.removeEventListener('touchstart', el._msTouchStart);
    el.removeEventListener('touchend', el._msTouchEnd);

    el._msTouchStart = (e) => handlePaletteTouchStart(e, el, 'ms');
    el._msTouchEnd = (e) => handlePaletteTouchEnd(e, el, 'ms');
    el.addEventListener('touchstart', el._msTouchStart, { passive: false });
    el.addEventListener('touchend', el._msTouchEnd, { passive: false });
  });

  bindGridCellsForTap(gridWrapper, 'ms', '.grid-cell');
  
  // v2.0: Bind resize + reposition for existing grid tiles
  bindGridTilesTouch(gridWrapper, 'ms');
}

// =================================================================
// DAILY ADJUSTMENTS — TOUCH SETUP
// =================================================================
function setupDailyAdjustmentsTouch() {
  if (!isTouchDevice()) return;

  const palette = document.getElementById('da-palette');
  const gridWrapper = document.querySelector('.da-grid-wrapper') ||
                      document.getElementById('da-skeleton-grid')?.parentElement;
  if (!palette || !gridWrapper) return;

  if (palette.dataset.mobileTouchBound === '1') return;
  palette.dataset.mobileTouchBound = '1';

  injectSelectionBar(palette, 'da');

  palette.querySelectorAll('.da-tile').forEach(el => {
    el.removeEventListener('touchstart', el._daTouchStart);
    el.removeEventListener('touchend', el._daTouchEnd);

    el._daTouchStart = (e) => handlePaletteTouchStart(e, el, 'da');
    el._daTouchEnd = (e) => handlePaletteTouchEnd(e, el, 'da');
    el.addEventListener('touchstart', el._daTouchStart, { passive: false });
    el.addEventListener('touchend', el._daTouchEnd, { passive: false });
  });

  bindGridCellsForTap(gridWrapper, 'da', '.da-grid-cell');
  
  // v2.0: Bind resize + reposition for existing grid tiles
  bindGridTilesTouch(gridWrapper, 'da');
}

// =================================================================
// SELECTION BAR
// =================================================================
function injectSelectionBar(palette, module) {
  const barId = `${module}-mobile-selection-bar`;
  if (document.getElementById(barId)) return;

  const bar = document.createElement('div');
  bar.id = barId;
  bar.className = 'mobile-selection-bar';
  bar.innerHTML = `<span class="bar-text"></span><button class="bar-clear" onclick="window.MobileTouchDrag.clearSelection('${module}')">✕</button>`;
  palette.parentElement.insertBefore(bar, palette);
}

// =================================================================
// PALETTE TOUCH HANDLERS
// =================================================================
let touchStartPos = { x: 0, y: 0 };
let touchStartTime = 0;
let touchedEl = null;

function handlePaletteTouchStart(e, el, module) {
  if (isResizing || isRepositioning) return;
  
  const touch = e.touches[0];
  touchStartPos = { x: touch.clientX, y: touch.clientY };
  touchStartTime = Date.now();
  touchedEl = el;

  storeTileDataOnElement(el, module);

  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    if (touchedEl === el) {
      startDrag(el, module);
    }
  }, LONG_PRESS_MS);

  document.addEventListener('touchmove', onDragTouchMove, { passive: false });
}

function handlePaletteTouchEnd(e, el, module) {
  const touch = e.changedTouches[0];
  const dx = touch.clientX - touchStartPos.x;
  const dy = touch.clientY - touchStartPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const elapsed = Date.now() - touchStartTime;

  clearTimeout(longPressTimer);
  document.removeEventListener('touchmove', onDragTouchMove);

  if (isDragging) {
    handleDrop(touch, module);
    return;
  }

  if (dist < 15 && elapsed < 500) {
    e.preventDefault();
    toggleTileSelection(el, module);
  }

  touchedEl = null;
}

// =================================================================
// TAP-TO-SELECT LOGIC
// =================================================================
function toggleTileSelection(el, module) {
  const currentSel = module === 'ms' ? selectedMSTile : selectedDATile;

  if (currentSel && currentSel.element === el) {
    clearSelection(module);
    return;
  }

  clearSelection(module);

  const tileData = getTileData(el, module);
  if (!tileData) return;

  const selection = { element: el, tileData: tileData };
  if (module === 'ms') selectedMSTile = selection;
  else selectedDATile = selection;

  el.classList.add('mobile-selected');

  const bar = document.getElementById(`${module}-mobile-selection-bar`);
  if (bar) {
    bar.querySelector('.bar-text').textContent = `"${tileData.name || tileData.type}" selected — tap a grid cell to place`;
    bar.style.display = 'block';
  }

  const cellClass = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellClass).forEach(cell => {
    cell.classList.add('mobile-drop-target');
  });
}

function clearSelection(module) {
  const prevSel = module === 'ms' ? selectedMSTile : selectedDATile;
  if (prevSel) {
    prevSel.element.classList.remove('mobile-selected');
  }

  if (module === 'ms') selectedMSTile = null;
  else selectedDATile = null;

  const bar = document.getElementById(`${module}-mobile-selection-bar`);
  if (bar) bar.style.display = 'none';

  const cellClass = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellClass).forEach(cell => {
    cell.classList.remove('mobile-drop-target');
  });
}

// =================================================================
// GRID CELL TAP-TO-PLACE BINDING
// =================================================================
function bindGridCellsForTap(wrapper, module, cellSelector) {
  if (wrapper.dataset.mobileTapBound === '1') return;
  wrapper.dataset.mobileTapBound = '1';

  wrapper.addEventListener('touchend', (e) => {
    if (isDragging || isResizing || isRepositioning) return;

    const selection = module === 'ms' ? selectedMSTile : selectedDATile;
    if (!selection) return;

    const touch = e.changedTouches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const cell = el?.closest(cellSelector);
    if (!cell) return;

    e.preventDefault();
    e.stopPropagation();

    executeDrop(cell, selection.tileData, touch, module);
    clearSelection(module);
  }, { passive: false });
}

// =================================================================
// LONG-PRESS DRAG LOGIC (palette tiles)
// =================================================================
function startDrag(el, module) {
  isDragging = true;
  dragSourceModule = module;
  dragTileData = getTileData(el, module);

  if (!dragTileData) {
    isDragging = false;
    return;
  }

  if (navigator.vibrate) navigator.vibrate(30);

  el.style.opacity = '0.5';

  ensureGhost();
  dragGhost = document.getElementById('mobile-drag-ghost');
  dragGhost.textContent = dragTileData.name || dragTileData.type;
  dragGhost.style.background = extractBgColor(el) || '#fff';
  dragGhost.style.color = extractTextColor(el) || '#000';
  dragGhost.style.display = 'block';

  const pos = touchStartPos;
  dragGhost.style.left = pos.x + 'px';
  dragGhost.style.top = pos.y + 'px';
}

function onDragTouchMove(e) {
  if (!isDragging) {
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPos.x;
    const dy = touch.clientY - touchStartPos.y;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      clearTimeout(longPressTimer);
      document.removeEventListener('touchmove', onDragTouchMove);
    }
    return;
  }

  e.preventDefault();

  const touch = e.touches[0];

  if (dragGhost) {
    dragGhost.style.left = touch.clientX + 'px';
    dragGhost.style.top = touch.clientY + 'px';
  }

  const cellSelector = dragSourceModule === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellSelector).forEach(c => c.style.background = '');

  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const cell = el?.closest(cellSelector);
  if (cell) {
    cell.style.background = 'rgba(59,130,246,0.15)';
  }
}

function handleDrop(touch, module) {
  isDragging = false;
  document.removeEventListener('touchmove', onDragTouchMove);

  if (dragGhost) dragGhost.style.display = 'none';
  if (touchedEl) touchedEl.style.opacity = '1';

  const cellSelector = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellSelector).forEach(c => c.style.background = '');

  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const cell = el?.closest(cellSelector);

  if (cell && dragTileData) {
    executeDrop(cell, dragTileData, touch, module);
  }

  cleanupDrag();
}

function cleanupDrag() {
  isDragging = false;
  clearTimeout(longPressTimer);
  document.removeEventListener('touchmove', onDragTouchMove);
  if (dragGhost) dragGhost.style.display = 'none';
  if (touchedEl) touchedEl.style.opacity = '1';
  dragTileData = null;
  dragSourceModule = null;
  touchedEl = null;
}

// =================================================================
// EXECUTE DROP — calls the existing ondrop handlers
// =================================================================
function executeDrop(cell, tileData, touch, module) {
  const fakeEvent = {
    preventDefault: function() {},
    stopPropagation: function() {},
    clientX: touch.clientX,
    clientY: touch.clientY,
    dataTransfer: {
      types: ['application/json'],
      getData: function(format) {
        if (format === 'application/json') return JSON.stringify(tileData);
        return '';
      }
    }
  };

  // For Master Scheduler
  if (module === 'ms' && cell.ondrop) {
    cell.ondrop(fakeEvent);
    return;
  }

  // For Daily Adjustments — try ondrop first (set by addDropListeners)
  if (module === 'da') {
    if (cell.ondrop) {
      cell.ondrop(fakeEvent);
      return;
    }
    // Fallback: dispatch a synthetic drop event for addEventListener-based handlers
    try {
      const dropEvt = new Event('drop', { bubbles: true, cancelable: true });
      dropEvt.preventDefault = function() {};
      // Can't set dataTransfer on native Event, so we patch it
      Object.defineProperty(dropEvt, 'dataTransfer', { value: fakeEvent.dataTransfer });
      Object.defineProperty(dropEvt, 'clientX', { value: touch.clientX });
      Object.defineProperty(dropEvt, 'clientY', { value: touch.clientY });
      cell.dispatchEvent(dropEvt);
    } catch(err) {
      console.warn('[MobileTouchDrag] DA fallback dispatch failed:', err);
    }
    return;
  }
}

// =================================================================
// v2.0: TOUCH RESIZE + REPOSITION FOR EXISTING GRID TILES
// =================================================================
function bindGridTilesTouch(wrapper, module) {
  // Use a flag on the wrapper to track that we've set up delegation
  const flagKey = `mobileTileTouchBound_${module}`;
  if (wrapper.dataset[flagKey] === '1') return;
  wrapper.dataset[flagKey] = '1';

  const tileSelector = module === 'ms' ? '.grid-event' : '.da-event';
  const handleTopClass = module === 'ms' ? 'resize-handle-top' : 'da-resize-top';
  const handleBottomClass = module === 'ms' ? 'resize-handle-bottom' : 'da-resize-bottom';
  const handleClass = module === 'ms' ? 'resize-handle' : 'da-resize-handle';

  // We use event delegation on the wrapper for touchstart
  wrapper.addEventListener('touchstart', (e) => {
    if (isDragging) return;
    
    const touch = e.touches[0];
    const target = e.target;
    
    // --- RESIZE: Check if touch is on a resize handle ---
    if (target.classList.contains(handleClass) || 
        target.classList.contains(handleTopClass) || 
        target.classList.contains(handleBottomClass)) {
      e.preventDefault();
      e.stopPropagation();
      startTouchResize(target, touch, module, wrapper);
      return;
    }
    
    // --- REPOSITION: Check if touch is on a tile (but not a handle) ---
    const tile = target.closest(tileSelector);
    if (tile && tile.dataset.id) {
      // Start a long-press timer for repositioning
      const startX = touch.clientX;
      const startY = touch.clientY;
      const tileId = tile.dataset.id;
      
      const repoTimer = setTimeout(() => {
        // Only start if finger hasn't moved much
        if (!isResizing && !isDragging && !isRepositioning) {
          startTouchReposition(tile, tileId, { x: startX, y: startY }, module, wrapper);
        }
      }, LONG_PRESS_MS);
      
      // Store timer so we can cancel it
      tile._repoTimer = repoTimer;
      tile._repoStartPos = { x: startX, y: startY };
    }
  }, { passive: false });

  // Global touchmove for resize and reposition
  wrapper.addEventListener('touchmove', (e) => {
    if (isResizing) {
      e.preventDefault();
      onTouchResizeMove(e.touches[0], module, wrapper);
      return;
    }
    if (isRepositioning) {
      e.preventDefault();
      onTouchRepositionMove(e.touches[0], module, wrapper);
      return;
    }
    
    // Check if we should cancel a pending reposition long-press
    const touch = e.touches[0];
    const tileSelector2 = module === 'ms' ? '.grid-event' : '.da-event';
    const tiles = wrapper.querySelectorAll(tileSelector2);
    tiles.forEach(tile => {
      if (tile._repoTimer && tile._repoStartPos) {
        const dx = touch.clientX - tile._repoStartPos.x;
        const dy = touch.clientY - tile._repoStartPos.y;
        if (Math.sqrt(dx*dx + dy*dy) > 10) {
          clearTimeout(tile._repoTimer);
          tile._repoTimer = null;
        }
      }
    });
  }, { passive: false });

  wrapper.addEventListener('touchend', (e) => {
    // Cancel any pending reposition timers
    const tileSelector2 = module === 'ms' ? '.grid-event' : '.da-event';
    wrapper.querySelectorAll(tileSelector2).forEach(tile => {
      if (tile._repoTimer) {
        clearTimeout(tile._repoTimer);
        tile._repoTimer = null;
      }
    });
    
    if (isResizing) {
      e.preventDefault();
      finishTouchResize(module, wrapper);
      return;
    }
    if (isRepositioning) {
      e.preventDefault();
      finishTouchReposition(e.changedTouches[0], module, wrapper);
      return;
    }
  }, { passive: false });

  wrapper.addEventListener('touchcancel', () => {
    if (isResizing) cancelTouchResize(module);
    if (isRepositioning) cancelTouchReposition(module);
  });
}

// =================================================================
// TOUCH RESIZE
// =================================================================
function startTouchResize(handle, touch, module, wrapper) {
  const tileSelector = module === 'ms' ? '.grid-event' : '.da-event';
  const tile = handle.closest(tileSelector);
  if (!tile || !tile.dataset.id) return;

  const handleTopClass = module === 'ms' ? 'resize-handle-top' : 'da-resize-top';
  const direction = handle.classList.contains(handleTopClass) ? 'top' : 'bottom';

  const grid = module === 'ms' 
    ? document.getElementById('scheduler-grid') 
    : document.getElementById('da-skeleton-grid');
  const earliestMin = parseInt(grid?.dataset.earliestMin, 10) || 540;

  isResizing = true;
  resizeState = {
    tileEl: tile,
    tileId: tile.dataset.id,
    direction: direction,
    startY: touch.clientY,
    startTop: parseInt(tile.style.top, 10),
    startHeight: tile.offsetHeight,
    earliestMin: earliestMin,
    module: module
  };

  tile.classList.add('mobile-repositioning');
  if (navigator.vibrate) navigator.vibrate(20);
  
  // Create tooltip
  let tooltip = document.getElementById('mobile-resize-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'mobile-resize-tooltip';
    document.body.appendChild(tooltip);
  }
}

function onTouchResizeMove(touch, module, wrapper) {
  if (!resizeState) return;

  const { tileEl, direction, startY, startTop, startHeight } = resizeState;
  const deltaY = touch.clientY - startY;

  let newTop = startTop, newHeight = startHeight;

  if (direction === 'bottom') {
    newHeight = Math.max(SNAP_MINS * PIXELS_PER_MINUTE, startHeight + deltaY);
    newHeight = Math.round(newHeight / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
  } else {
    const maxDelta = startHeight - (SNAP_MINS * PIXELS_PER_MINUTE);
    const constrainedDelta = Math.min(deltaY, maxDelta);
    const snappedDelta = Math.round(constrainedDelta / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
    newTop = startTop + snappedDelta;
    newHeight = startHeight - snappedDelta;
  }

  tileEl.style.top = newTop + 'px';
  tileEl.style.height = newHeight + 'px';

  // Update tooltip
  const { earliestMin } = resizeState;
  const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
  const newEndMin = newStartMin + (newHeight / PIXELS_PER_MINUTE);
  const duration = newEndMin - newStartMin;
  const durationStr = duration < 60 ? `${duration}m` : `${Math.floor(duration/60)}h${duration%60 > 0 ? duration%60+'m' : ''}`;

  const tooltip = document.getElementById('mobile-resize-tooltip');
  if (tooltip) {
    tooltip.innerHTML = `${minutesToTime(newStartMin)} – ${minutesToTime(newEndMin)} (${durationStr})`;
    tooltip.style.display = 'block';
    tooltip.style.left = (touch.clientX + 15) + 'px';
    tooltip.style.top = (touch.clientY - 50) + 'px';
  }
}

function finishTouchResize(module, wrapper) {
  if (!resizeState) { isResizing = false; return; }

  const { tileEl, tileId, earliestMin } = resizeState;
  
  const newTop = parseInt(tileEl.style.top, 10);
  const newHeightPx = parseInt(tileEl.style.height, 10);
  const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
  const newEndMin = newStartMin + (newHeightPx / PIXELS_PER_MINUTE);

  if (module === 'ms') {
    // Master Scheduler: update dailySkeleton (it's a local var in the IIFE, 
    // but the grid re-render reads from it, so we use the exposed functions)
    // MS doesn't expose dailySkeleton directly, so we fire a custom event
    const event = findSkeletonEvent(tileId, module);
    if (event) {
      const div = window.divisions?.[event.division] || {};
      const divStartMin = parseTimeToMinutes(div.startTime) || 540;
      const divEndMin = parseTimeToMinutes(div.endTime) || 960;
      
      event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
      event.endTime = minutesToTime(Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS));

      // Trigger save and re-render through the module's methods
      if (window.MasterSchedulerInternal?.markUnsavedChanges) window.MasterSchedulerInternal.markUnsavedChanges();
      if (window.MasterSchedulerInternal?.saveDraftToLocalStorage) window.MasterSchedulerInternal.saveDraftToLocalStorage();
      if (window.MasterSchedulerInternal?.renderGrid) window.MasterSchedulerInternal.renderGrid();
      else {
        // Dispatch event for MS to handle
        window.dispatchEvent(new CustomEvent('mobile-resize-complete', { 
          detail: { id: tileId, startTime: event.startTime, endTime: event.endTime, module: 'ms' }
        }));
      }
    }
  } else {
    // Daily Adjustments: update dailyOverrideSkeleton via exposed methods
    const event = findSkeletonEvent(tileId, module);
    if (event) {
      const div = window.divisions?.[event.division] || {};
      const divStartMin = parseTimeToMinutes(div.startTime) || 540;
      const divEndMin = parseTimeToMinutes(div.endTime) || 960;
      
      if (event.isNightActivity) {
        event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
        event.endTime = minutesToTime(Math.round(newEndMin / SNAP_MINS) * SNAP_MINS);
      } else {
        event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
        event.endTime = minutesToTime(Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS));
      }

      // DA exposes saveDailySkeleton and renderGrid via window.DailyAdjustmentsInternal or as globals
      if (window.DailyAdjustmentsInternal?.saveDailySkeleton) window.DailyAdjustmentsInternal.saveDailySkeleton();
      if (window.DailyAdjustmentsInternal?.renderGrid) window.DailyAdjustmentsInternal.renderGrid();
      else {
        window.dispatchEvent(new CustomEvent('mobile-resize-complete', { 
          detail: { id: tileId, startTime: event.startTime, endTime: event.endTime, module: 'da' }
        }));
      }
    }
  }

  tileEl.classList.remove('mobile-repositioning');
  const tooltip = document.getElementById('mobile-resize-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  
  isResizing = false;
  resizeState = null;
}

function cancelTouchResize(module) {
  if (resizeState) {
    const { tileEl, startTop, startHeight } = resizeState;
    tileEl.style.top = startTop + 'px';
    tileEl.style.height = startHeight + 'px';
    tileEl.classList.remove('mobile-repositioning');
  }
  const tooltip = document.getElementById('mobile-resize-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  isResizing = false;
  resizeState = null;
}

// =================================================================
// TOUCH REPOSITION (drag existing tiles to new position)
// =================================================================
function startTouchReposition(tile, tileId, startPos, module, wrapper) {
  const event = findSkeletonEvent(tileId, module);
  if (!event) return;

  const grid = module === 'ms' 
    ? document.getElementById('scheduler-grid') 
    : document.getElementById('da-skeleton-grid');
  const earliestMin = parseInt(grid?.dataset.earliestMin, 10) || 540;
  
  const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);

  isRepositioning = true;
  repositionState = {
    tileEl: tile,
    tileId: tileId,
    event: event,
    startPos: startPos,
    duration: duration,
    earliestMin: earliestMin,
    module: module,
    originalDivision: event.division,
    originalStartTime: event.startTime,
    originalEndTime: event.endTime
  };

  tile.classList.add('mobile-repositioning');
  if (navigator.vibrate) navigator.vibrate(30);

  // Show ghost
  ensureGhost();
  dragGhost = document.getElementById('mobile-drag-ghost');
  dragGhost.textContent = event.event || event.type || 'Block';
  dragGhost.style.background = extractBgColor(tile) || '#fff';
  dragGhost.style.color = extractTextColor(tile) || '#000';
  dragGhost.style.display = 'block';
  dragGhost.style.left = startPos.x + 'px';
  dragGhost.style.top = startPos.y + 'px';
}

function onTouchRepositionMove(touch, module, wrapper) {
  if (!repositionState) return;

  // Move ghost
  if (dragGhost) {
    dragGhost.style.left = touch.clientX + 'px';
    dragGhost.style.top = touch.clientY + 'px';
  }

  // Highlight cell under finger
  const cellSelector = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellSelector).forEach(c => c.style.background = '');

  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const cell = el?.closest(cellSelector);
  if (cell) {
    cell.style.background = 'rgba(59,130,246,0.15)';
    
    // Show preview of where it would land
    const preview = cell.querySelector('.drop-preview, .da-drop-preview');
    if (preview && repositionState) {
      const rect = cell.getBoundingClientRect();
      const y = touch.clientY - rect.top;
      const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
      const cellStartMin = parseInt(cell.dataset.startMin, 10);
      const previewStartTime = minutesToTime(cellStartMin + snapMin);
      const previewEndTime = minutesToTime(cellStartMin + snapMin + repositionState.duration);

      preview.style.display = 'block';
      preview.style.top = (snapMin * PIXELS_PER_MINUTE) + 'px';
      preview.style.height = (repositionState.duration * PIXELS_PER_MINUTE) + 'px';
      preview.innerHTML = `<div style="text-align:center;padding:4px;color:#3b82f6;font-weight:600;font-size:11px;">${previewStartTime} - ${previewEndTime}</div>`;
    }
  }
}

function finishTouchReposition(touch, module, wrapper) {
  if (!repositionState) { isRepositioning = false; return; }

  const cellSelector = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  
  // Clear all highlights and previews
  document.querySelectorAll(cellSelector).forEach(c => {
    c.style.background = '';
    const preview = c.querySelector('.drop-preview, .da-drop-preview');
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
  });

  // Find target cell
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const cell = el?.closest(cellSelector);

  if (cell) {
    const { event, duration } = repositionState;
    const divName = cell.dataset.div;
    const cellStartMin = parseInt(cell.dataset.startMin, 10);
    const rect = cell.getBoundingClientRect();
    const y = touch.clientY - rect.top;
    const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;

    event.division = divName;
    event.startTime = minutesToTime(cellStartMin + snapMin);
    event.endTime = minutesToTime(cellStartMin + snapMin + duration);

    if (module === 'ms') {
      if (window.MasterSchedulerInternal?.markUnsavedChanges) window.MasterSchedulerInternal.markUnsavedChanges();
      if (window.MasterSchedulerInternal?.saveDraftToLocalStorage) window.MasterSchedulerInternal.saveDraftToLocalStorage();
      if (window.MasterSchedulerInternal?.renderGrid) window.MasterSchedulerInternal.renderGrid();
      else {
        window.dispatchEvent(new CustomEvent('mobile-reposition-complete', { 
          detail: { id: repositionState.tileId, division: divName, startTime: event.startTime, endTime: event.endTime, module: 'ms' }
        }));
      }
    } else {
      // DA: also bump overlapping tiles
      if (window.DailyAdjustmentsInternal?.bumpOverlappingTiles) {
        window.DailyAdjustmentsInternal.bumpOverlappingTiles(event, divName);
      }
      if (window.DailyAdjustmentsInternal?.saveDailySkeleton) window.DailyAdjustmentsInternal.saveDailySkeleton();
      if (window.DailyAdjustmentsInternal?.renderGrid) window.DailyAdjustmentsInternal.renderGrid();
      else {
        window.dispatchEvent(new CustomEvent('mobile-reposition-complete', { 
          detail: { id: repositionState.tileId, division: divName, startTime: event.startTime, endTime: event.endTime, module: 'da' }
        }));
      }
    }
  }

  // Cleanup
  repositionState.tileEl.classList.remove('mobile-repositioning');
  if (dragGhost) dragGhost.style.display = 'none';
  isRepositioning = false;
  repositionState = null;
}

function cancelTouchReposition(module) {
  if (repositionState) {
    const { event, originalDivision, originalStartTime, originalEndTime, tileEl } = repositionState;
    event.division = originalDivision;
    event.startTime = originalStartTime;
    event.endTime = originalEndTime;
    tileEl.classList.remove('mobile-repositioning');
  }
  if (dragGhost) dragGhost.style.display = 'none';
  
  const cellSelector = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellSelector).forEach(c => {
    c.style.background = '';
    const preview = c.querySelector('.drop-preview, .da-drop-preview');
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
  });
  
  isRepositioning = false;
  repositionState = null;
}

// =================================================================
// FIND SKELETON EVENT BY ID
// =================================================================
function findSkeletonEvent(tileId, module) {
  if (module === 'ms') {
    // Master Scheduler stores skeleton in a local var, but we can try to find it
    // through the exposed internal reference or window globals
    if (window.MasterSchedulerInternal?.dailySkeleton) {
      return window.MasterSchedulerInternal.dailySkeleton.find(ev => ev.id === tileId);
    }
    // Try window._msDailySkeleton as a fallback
    if (window._msDailySkeleton) {
      return window._msDailySkeleton.find(ev => ev.id === tileId);
    }
    return null;
  }
  
  if (module === 'da') {
    // DA stores in dailyOverrideSkeleton
    if (window.DailyAdjustmentsInternal?.dailyOverrideSkeleton) {
      return window.DailyAdjustmentsInternal.dailyOverrideSkeleton.find(ev => ev.id === tileId);
    }
    if (window._daDailyOverrideSkeleton) {
      return window._daDailyOverrideSkeleton.find(ev => ev.id === tileId);
    }
    return null;
  }
  
  return null;
}

// =================================================================
// UTILITY: Time parsing (matches both MS and DA)
// =================================================================
function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  let s = t.toLowerCase().trim();
  let mer = null;
  if (s.includes('am') || s.includes('pm')) {
    mer = s.includes('am') ? 'am' : 'pm';
    s = s.replace(/am|pm/g, '').trim();
  }
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (isNaN(hh) || isNaN(mm)) return null;
  if (mer) {
    if (hh === 12) hh = mer === 'am' ? 0 : 12;
    else if (mer === 'pm') hh += 12;
  }
  return hh * 60 + mm;
}

function minutesToTime(min) {
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m.toString().padStart(2, '0') + ap;
}

// =================================================================
// UTILITY: Extract tile data from element
// =================================================================
function storeTileDataOnElement(el, module) {
  if (el.dataset.tileData) return;

  if (module === 'ms' && window.TILES) {
    const tileName = el.textContent.trim();
    const found = window.TILES.find(t => t.name === tileName);
    if (found) el.dataset.tileData = JSON.stringify(found);
  }
}

function getTileData(el, module) {
  if (el.dataset.tileData) {
    try { return JSON.parse(el.dataset.tileData); } catch(e) {}
  }

  const tileName = el.textContent.trim();
  const typeMap = {
    'Activity Slot': 'activity',
    'Sports Slot': 'sports',
    'Special Activity': 'special',
    'Smart Tile': 'smart',
    'Split Tile': 'split',
    'Elective Block': 'elective',
    'League Game': 'league',
    'Specialty League': 'specialty_league',
    'Swim / Pool': 'swim',
    'Lunch': 'lunch',
    'Snacks': 'snacks',
    'Dismissal': 'dismissal',
    'Custom Block': 'custom'
  };
  const type = typeMap[tileName];
  if (type) return { type: type, name: tileName };
  return null;
}

function extractBgColor(el) {
  const style = el.style.cssText || '';
  const match = style.match(/background\s*:\s*([^;]+)/);
  if (match) return match[1].trim();
  return window.getComputedStyle(el).backgroundColor;
}

function extractTextColor(el) {
  const style = el.style.cssText || '';
  const match = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
  if (match) return match[1].trim();
  return window.getComputedStyle(el).color;
}

// =================================================================
// CLEANUP ALL
// =================================================================
function cleanupAll() {
  cleanupDrag();
  if (isResizing) cancelTouchResize(resizeState?.module || 'ms');
  if (isRepositioning) cancelTouchReposition(repositionState?.module || 'ms');
}

// =================================================================
// BOOT
// =================================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 500);
}

// Re-init when tabs switch
const origShowTab = window.showTab;
if (typeof origShowTab === 'function') {
  window.showTab = function(id) {
    origShowTab(id);
    setTimeout(() => {
      if (id === 'master-scheduler') {
        const palette = document.querySelector('.ms-palette');
        if (palette) palette.dataset.mobileTouchBound = '0';
        const wrapper = document.querySelector('.ms-grid-wrapper');
        if (wrapper) {
          wrapper.dataset.mobileTapBound = '0';
          wrapper.dataset.mobileTileTouchBound_ms = '0';
        }
        setupMasterSchedulerTouch();
      }
      if (id === 'daily-adjustments') {
        const palette = document.getElementById('da-palette');
        if (palette) palette.dataset.mobileTouchBound = '0';
        const wrapper = document.querySelector('.da-grid-wrapper');
        if (wrapper) {
          wrapper.dataset.mobileTapBound = '0';
          wrapper.dataset.mobileTileTouchBound_da = '0';
        }
        setupDailyAdjustmentsTouch();
      }
    }, 300);
  };
}

// Expose for manual re-init
window.MobileTouchDrag = {
  init: init,
  setupMS: setupMasterSchedulerTouch,
  setupDA: setupDailyAdjustmentsTouch,
  clearSelection: clearSelection
};

})();
