// =================================================================
// mobile_touch_drag.js v1.0
// =================================================================
// UNIVERSAL MOBILE TOUCH DRAG-AND-DROP for Campistry Schedulers
//
// PROBLEM: HTML5 drag-and-drop does NOT work on mobile browsers.
// The existing touchstart/touchend handlers in master_schedule_builder.js
// and daily_adjustments.js are broken because:
//   1. No touchmove tracking = no visual feedback during drag
//   2. No preventDefault on touchmove = page scrolls instead of dragging
//   3. The "drag from palette to grid" gesture doesn't work when
//      layout is stacked (palette above grid) on mobile
//   4. Daily Adjustments uses a 2-step approach (touch tile, then
//      separately touch cell) that's unintuitive and broken
//
// SOLUTION: Two complementary interaction modes:
//   MODE A — "Tap to Select, Tap to Place":
//      1. Tap a tile in the palette → it becomes "selected" (highlighted)
//      2. Tap a cell in the grid → tile is placed there
//      3. Tap the selected tile again or tap empty space → deselect
//
//   MODE B — "Touch Drag" (for users who try to drag):
//      1. Long-press a palette tile (300ms) → enters drag mode
//      2. Move finger → ghost follows finger over the grid
//      3. Lift finger → drop on the grid cell under the finger
//
// LOAD ORDER: After master_schedule_builder.js and daily_adjustments.js
// =================================================================
(function() {
'use strict';

// =================================================================
// STATE
// =================================================================
let selectedMSTile = null;     // Currently selected tile for Master Scheduler
let selectedDATile = null;     // Currently selected tile for Daily Adjustments
let isDragging = false;
let dragGhost = null;
let dragTileData = null;
let dragSourceModule = null;   // 'ms' or 'da'
let longPressTimer = null;
const LONG_PRESS_MS = 300;

// =================================================================
// INITIALIZATION — hooks into both modules after they render
// =================================================================

// Observe DOM for when palettes and grids are rendered/re-rendered
const observer = new MutationObserver(() => {
  setupMasterSchedulerTouch();
  setupDailyAdjustmentsTouch();
});

function init() {
  // Start observing
  const targets = [
    document.getElementById('master-scheduler-content'),
    document.getElementById('daily-adjustments-content')
  ].filter(Boolean);

  targets.forEach(t => {
    observer.observe(t, { childList: true, subtree: true });
  });

  // Also run once now
  setupMasterSchedulerTouch();
  setupDailyAdjustmentsTouch();

  // Create the drag ghost element
  ensureGhost();

  // Global touch-cancel cleanup
  document.addEventListener('touchcancel', cleanupDrag);
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

  // Avoid double-binding
  if (palette.dataset.mobileTouchBound === '1') return;
  palette.dataset.mobileTouchBound = '1';

  // Inject the "selected tile" indicator bar
  injectSelectionBar(palette, 'ms');

  // --- Bind palette tiles ---
  palette.querySelectorAll('.ms-tile').forEach(el => {
    // Remove existing inline touch handlers to prevent conflicts
    el.removeEventListener('touchstart', el._msTouchStart);
    el.removeEventListener('touchend', el._msTouchEnd);

    let tileType = null;
    // Find tile data: try to parse from the existing dataset or match by text
    try {
      if (el.dataset.tileData) {
        tileType = JSON.parse(el.dataset.tileData);
      }
    } catch(e) {}

    // Attach new handlers
    el._msTouchStart = (e) => handlePaletteTouchStart(e, el, 'ms');
    el._msTouchEnd = (e) => handlePaletteTouchEnd(e, el, 'ms');
    el.addEventListener('touchstart', el._msTouchStart, { passive: false });
    el.addEventListener('touchend', el._msTouchEnd, { passive: false });
  });

  // --- Bind grid cells for tap-to-place ---
  bindGridCellsForTap(gridWrapper, 'ms', '.grid-cell');
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
}

// =================================================================
// SELECTION BAR (shows which tile is selected)
// =================================================================
function injectSelectionBar(palette, module) {
  const barId = `${module}-mobile-selection-bar`;
  if (document.getElementById(barId)) return;

  const bar = document.createElement('div');
  bar.id = barId;
  bar.style.cssText = `
    display: none; padding: 8px 12px; margin: 6px;
    background: #dbeafe; border: 2px solid #3b82f6;
    border-radius: 8px; font-size: 12px; font-weight: 600;
    color: #1d4ed8; text-align: center;
    animation: mobileSelectPulse 1.5s ease-in-out infinite;
  `;
  bar.innerHTML = '<span class="bar-text">Tap a grid cell to place</span> <button class="bar-cancel" style="margin-left:8px;background:#3b82f6;color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer;">Cancel</button>';

  // Insert before the palette tiles
  palette.parentElement.insertBefore(bar, palette);

  // Cancel button
  bar.querySelector('.bar-cancel').addEventListener('click', () => {
    clearSelection(module);
  });
  bar.querySelector('.bar-cancel').addEventListener('touchend', (e) => {
    e.stopPropagation();
    clearSelection(module);
  });

  // Inject pulse animation if not already present
  if (!document.getElementById('mobile-touch-drag-styles')) {
    const style = document.createElement('style');
    style.id = 'mobile-touch-drag-styles';
    style.textContent = `
      @keyframes mobileSelectPulse {
        0%, 100% { border-color: #3b82f6; background: #dbeafe; }
        50% { border-color: #60a5fa; background: #bfdbfe; }
      }
      .ms-tile.mobile-selected,
      .da-tile.mobile-selected {
        outline: 3px solid #3b82f6 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 12px rgba(59,130,246,0.5) !important;
        transform: scale(1.05) !important;
      }
      .grid-cell.mobile-drop-target,
      .da-grid-cell.mobile-drop-target {
        background: rgba(59,130,246,0.12) !important;
        box-shadow: inset 0 0 0 2px rgba(59,130,246,0.3) !important;
      }
      #mobile-drag-ghost {
        transition: none !important;
      }
    `;
    document.head.appendChild(style);
  }
}

// =================================================================
// PALETTE TOUCH HANDLERS
// =================================================================
let touchStartPos = { x: 0, y: 0 };
let touchStartTime = 0;
let touchedEl = null;

function handlePaletteTouchStart(e, el, module) {
  const touch = e.touches[0];
  touchStartPos = { x: touch.clientX, y: touch.clientY };
  touchStartTime = Date.now();
  touchedEl = el;

  // Store tile data on the element
  storeTileDataOnElement(el, module);

  // Start long-press timer for drag mode
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    // Entered drag mode
    if (touchedEl === el) {
      startDrag(el, module);
    }
  }, LONG_PRESS_MS);

  // Attach move and end handlers to document for drag tracking
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

  // If we're in drag mode, handle drop
  if (isDragging) {
    handleDrop(touch, module);
    return;
  }

  // If it was a quick tap with minimal movement → toggle selection
  if (dist < 15 && elapsed < 500) {
    e.preventDefault(); // Prevent ghost click
    toggleTileSelection(el, module);
  }

  touchedEl = null;
}

// =================================================================
// TAP-TO-SELECT LOGIC
// =================================================================
function toggleTileSelection(el, module) {
  const currentSel = module === 'ms' ? selectedMSTile : selectedDATile;

  // If tapping the already-selected tile, deselect
  if (currentSel && currentSel.element === el) {
    clearSelection(module);
    return;
  }

  // Clear previous selection
  clearSelection(module);

  // Get tile data
  const tileData = getTileData(el, module);
  if (!tileData) return;

  // Set new selection
  const selection = { element: el, tileData: tileData };
  if (module === 'ms') selectedMSTile = selection;
  else selectedDATile = selection;

  // Visual feedback
  el.classList.add('mobile-selected');

  // Show selection bar
  const bar = document.getElementById(`${module}-mobile-selection-bar`);
  if (bar) {
    bar.querySelector('.bar-text').textContent = `"${tileData.name || tileData.type}" selected — tap a grid cell to place`;
    bar.style.display = 'block';
  }

  // Add drop-target hints to grid cells
  const cellClass = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellClass).forEach(cell => {
    cell.classList.add('mobile-drop-target');
  });
}

function clearSelection(module) {
  // Remove visual
  const prevSel = module === 'ms' ? selectedMSTile : selectedDATile;
  if (prevSel) {
    prevSel.element.classList.remove('mobile-selected');
  }

  if (module === 'ms') selectedMSTile = null;
  else selectedDATile = null;

  // Hide bar
  const bar = document.getElementById(`${module}-mobile-selection-bar`);
  if (bar) bar.style.display = 'none';

  // Remove drop-target hints
  const cellClass = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellClass).forEach(cell => {
    cell.classList.remove('mobile-drop-target');
  });
}

// =================================================================
// GRID CELL TAP-TO-PLACE BINDING
// =================================================================
function bindGridCellsForTap(wrapper, module, cellSelector) {
  // Use event delegation on the wrapper
  if (wrapper.dataset.mobileTapBound === '1') return;
  wrapper.dataset.mobileTapBound = '1';

  wrapper.addEventListener('touchend', (e) => {
    if (isDragging) return; // Don't interfere with drag drops

    const selection = module === 'ms' ? selectedMSTile : selectedDATile;
    if (!selection) return; // No tile selected, let normal handling proceed

    const touch = e.changedTouches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const cell = el?.closest(cellSelector);
    if (!cell) return;

    e.preventDefault();
    e.stopPropagation();

    // Execute the drop
    executeDrop(cell, selection.tileData, touch, module);

    // Clear selection after placing
    clearSelection(module);
  }, { passive: false });

  // Also re-observe: when grid re-renders, the wrapper might get new cells
  // We use delegation so no need to re-bind individual cells
}

// =================================================================
// LONG-PRESS DRAG LOGIC
// =================================================================
function startDrag(el, module) {
  isDragging = true;
  dragSourceModule = module;
  dragTileData = getTileData(el, module);

  if (!dragTileData) {
    isDragging = false;
    return;
  }

  // Haptic feedback if available
  if (navigator.vibrate) navigator.vibrate(30);

  // Visual: dim the tile
  el.style.opacity = '0.5';

  // Show ghost
  ensureGhost();
  dragGhost = document.getElementById('mobile-drag-ghost');
  dragGhost.textContent = dragTileData.name || dragTileData.type;
  dragGhost.style.background = extractBgColor(el) || '#fff';
  dragGhost.style.color = extractTextColor(el) || '#000';
  dragGhost.style.display = 'block';

  // Position ghost at current touch
  const pos = touchStartPos;
  dragGhost.style.left = pos.x + 'px';
  dragGhost.style.top = pos.y + 'px';
}

function onDragTouchMove(e) {
  if (!isDragging) {
    // Check if we've moved enough to cancel the long-press
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPos.x;
    const dy = touch.clientY - touchStartPos.y;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      clearTimeout(longPressTimer);
      // If moving a lot in the palette, let the scroll happen
      document.removeEventListener('touchmove', onDragTouchMove);
    }
    return;
  }

  e.preventDefault(); // Prevent scroll while dragging

  const touch = e.touches[0];

  // Move ghost
  if (dragGhost) {
    dragGhost.style.left = touch.clientX + 'px';
    dragGhost.style.top = touch.clientY + 'px';
  }

  // Highlight cell under finger
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

  // Hide ghost
  if (dragGhost) dragGhost.style.display = 'none';

  // Reset tile opacity
  if (touchedEl) touchedEl.style.opacity = '1';

  // Clear cell highlights
  const cellSelector = module === 'ms' ? '.grid-cell' : '.da-grid-cell';
  document.querySelectorAll(cellSelector).forEach(c => c.style.background = '');

  // Find target cell
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
  // Build a fake drop event that matches what the existing handlers expect
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

  // For Master Scheduler, use cell.ondrop
  if (module === 'ms' && cell.ondrop) {
    cell.ondrop(fakeEvent);
    return;
  }

  // For Daily Adjustments, use cell.ondrop
  if (module === 'da' && cell.ondrop) {
    cell.ondrop(fakeEvent);
    return;
  }

  // Fallback: try dispatching through the drop event listener
  // (DA uses addEventListener('drop',...) in addDragToRepositionListeners)
  try {
    const dropEvt = new Event('drop', { bubbles: true });
    dropEvt.preventDefault = function() {};
    dropEvt.dataTransfer = fakeEvent.dataTransfer;
    dropEvt.clientX = touch.clientX;
    dropEvt.clientY = touch.clientY;
    cell.dispatchEvent(dropEvt);
  } catch(err) {
    console.warn('[MobileTouchDrag] Fallback dispatch failed:', err);
  }
}

// =================================================================
// UTILITY: Extract tile data from element
// =================================================================
function storeTileDataOnElement(el, module) {
  // The existing code stores tile data in el.dataset.tileData during touchstart
  // We also need to handle cases where it's not there yet
  if (el.dataset.tileData) return; // Already set

  // For MS: find by matching tile name from TILES array
  if (module === 'ms' && window.TILES) {
    const tileName = el.textContent.trim();
    const found = window.TILES.find(t => t.name === tileName);
    if (found) el.dataset.tileData = JSON.stringify(found);
  }

  // For DA: same approach
  if (module === 'da') {
    // DA tiles also exist in its own TILES array
    // The palette render already sets dataset.tileData during touchstart
    // via the existing handler. But in case it didn't fire, try to find it.
    const tileName = el.textContent.trim();
    // Try matching from the palette's rendered tiles
    // (TILES is typically inside the DA IIFE, but the touchstart handler
    //  should have set dataset.tileData already)
  }
}

function getTileData(el, module) {
  if (el.dataset.tileData) {
    try { return JSON.parse(el.dataset.tileData); } catch(e) {}
  }

  // Fallback: try to reconstruct from the text
  const tileName = el.textContent.trim();

  // Master Scheduler has a global-ish TILES reference
  // Try to find it via the rendered grid's existing logic
  if (module === 'ms') {
    // MS tiles: Activity Slot, Sports Slot, Special Activity, Smart Tile, etc.
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
    if (type) {
      return { type: type, name: tileName };
    }
  }

  // DA uses same tile types
  if (module === 'da') {
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
    if (type) {
      return { type: type, name: tileName };
    }
  }

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
// BOOT
// =================================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // Small delay to let MS and DA render first
  setTimeout(init, 500);
}

// Re-init when tabs switch (grids get re-rendered)
const origShowTab = window.showTab;
if (typeof origShowTab === 'function') {
  window.showTab = function(id) {
    origShowTab(id);
    // Small delay to let the tab render
    setTimeout(() => {
      if (id === 'master-scheduler') {
        const palette = document.querySelector('.ms-palette');
        if (palette) palette.dataset.mobileTouchBound = '0';
        const wrapper = document.querySelector('.ms-grid-wrapper');
        if (wrapper) wrapper.dataset.mobileTapBound = '0';
        setupMasterSchedulerTouch();
      }
      if (id === 'daily-adjustments') {
        const palette = document.getElementById('da-palette');
        if (palette) palette.dataset.mobileTouchBound = '0';
        const wrapper = document.querySelector('.da-grid-wrapper');
        if (wrapper) wrapper.dataset.mobileTapBound = '0';
        setupDailyAdjustmentsTouch();
      }
    }, 300);
  };
}

// Expose for manual re-init if needed
window.MobileTouchDrag = {
  init: init,
  setupMS: setupMasterSchedulerTouch,
  setupDA: setupDailyAdjustmentsTouch,
  clearSelection: clearSelection
};

})();
