
// =============================================================================
// scheduler_ui_blocking.js — Visual Blocking & Drag-Drop Prevention
// VERSION: v1.0.0
// =============================================================================
//
// PURPOSE:
// Provides visual feedback for blocked resources and prevents drag-drop onto
// slots that other schedulers have already claimed.
//
// CRITICAL REQUIREMENT A (continued):
// - Add "blocked" visual styling to unavailable slots
// - Intercept drag-drop events to prevent invalid moves
// - Show tooltips explaining why slots are blocked
//
// =============================================================================

(function() {
    'use strict';

    console.log("🚫 Scheduler UI Blocking v1.0.0 loading...");

    // =========================================================================
    // CSS INJECTION
    // =========================================================================
    
    const BLOCKING_STYLES = `
        /* ============================================= */
        /* BLOCKED SLOT STYLING                         */
        /* ============================================= */
        
        .cell.blocked-by-other,
        .schedule-cell.blocked-by-other {
            position: relative;
            background: repeating-linear-gradient(
                45deg,
                rgba(239, 68, 68, 0.08),
                rgba(239, 68, 68, 0.08) 5px,
                rgba(239, 68, 68, 0.15) 5px,
                rgba(239, 68, 68, 0.15) 10px
            ) !important;
            cursor: not-allowed !important;
            pointer-events: auto !important; /* Allow hover for tooltip */
        }
        
        .cell.blocked-by-other::before,
        .schedule-cell.blocked-by-other::before {
            content: '🔒';
            position: absolute;
            top: 2px;
            right: 4px;
            font-size: 10px;
            opacity: 0.7;
            z-index: 5;
        }
        
        .cell.blocked-by-other::after,
        .schedule-cell.blocked-by-other::after {
            content: attr(data-blocked-reason);
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            background: #1e293b;
            color: white;
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 11px;
            white-space: nowrap;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
            z-index: 1000;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        
        .cell.blocked-by-other:hover::after,
        .schedule-cell.blocked-by-other:hover::after {
            opacity: 1;
            visibility: visible;
        }
        
        /* Partially available (some capacity left) */
        .cell.partially-blocked,
        .schedule-cell.partially-blocked {
            background: linear-gradient(
                135deg,
                rgba(251, 191, 36, 0.15) 0%,
                transparent 50%
            ) !important;
        }
        
        .cell.partially-blocked::before,
        .schedule-cell.partially-blocked::before {
            content: '⚠️';
            position: absolute;
            top: 2px;
            right: 4px;
            font-size: 10px;
            opacity: 0.7;
        }
        
        /* ============================================= */
        /* BLOCKED ROW (entire bunk row locked)         */
        /* ============================================= */
        
        .bunk-row.locked-by-other-scheduler {
            opacity: 0.65;
            position: relative;
        }
        
        .bunk-row.locked-by-other-scheduler .bunk-label::after {
            content: ' 🔒';
            font-size: 10px;
            margin-left: 4px;
        }
        
        .bunk-row.locked-by-other-scheduler .cell {
            pointer-events: none;
            cursor: not-allowed;
        }
        
        /* ============================================= */
        /* DRAG FEEDBACK                                */
        /* ============================================= */
        
        .cell.drag-invalid {
            outline: 2px dashed #ef4444 !important;
            outline-offset: -2px;
            animation: shake 0.3s ease-in-out;
        }
        
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-3px); }
            75% { transform: translateX(3px); }
        }
        
        .cell.drag-valid {
            outline: 2px solid #22c55e !important;
            outline-offset: -2px;
        }
        
        /* ============================================= */
        /* BLOCKED ACTIVITY IN PALETTE                  */
        /* ============================================= */
        
        .activity-option.field-blocked {
            opacity: 0.5;
            cursor: not-allowed;
            position: relative;
        }
        
        .activity-option.field-blocked::after {
            content: 'Used by other scheduler';
            position: absolute;
            bottom: 100%;
            left: 0;
            background: #1e293b;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 10px;
            opacity: 0;
            visibility: hidden;
            transition: all 0.2s;
            white-space: nowrap;
        }
        
        .activity-option.field-blocked:hover::after {
            opacity: 1;
            visibility: visible;
        }
        
        /* ============================================= */
        /* BLOCKED RESOURCES LEGEND                     */
        /* ============================================= */
        
        .blocked-legend {
            background: #fef3c7;
            border: 1px solid #fcd34d;
            border-radius: 8px;
            padding: 12px 16px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 16px;
            font-size: 13px;
        }
        
        .blocked-legend-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .blocked-legend-icon {
            width: 20px;
            height: 20px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
        }
        
        .blocked-legend-icon.full {
            background: repeating-linear-gradient(
                45deg,
                rgba(239, 68, 68, 0.2),
                rgba(239, 68, 68, 0.2) 3px,
                rgba(239, 68, 68, 0.35) 3px,
                rgba(239, 68, 68, 0.35) 6px
            );
        }
        
        .blocked-legend-icon.partial {
            background: linear-gradient(135deg, rgba(251, 191, 36, 0.3), transparent);
        }
    `;
    
    function injectStyles() {
        if (document.getElementById('scheduler-blocking-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'scheduler-blocking-styles';
        style.textContent = BLOCKING_STYLES;
        document.head.appendChild(style);
        
        console.log('🚫 Blocking styles injected');
    }

    // =========================================================================
    // VISUAL UPDATES
    // =========================================================================
    
    /**
     * Apply blocked styling to schedule grid cells
     * Called after the grid is rendered and we have blocked resources data
     */
    function applyBlockedStylingToGrid() {
        const blockedMap = window._cloudBlockedResources;
        if (!blockedMap || !blockedMap.bySlotField) {
            console.log('🚫 No blocked resources to display');
            return;
        }
        
        console.log('🚫 Applying blocked styling to grid...');
        
        // Get all schedule cells
        const cells = document.querySelectorAll('.cell[data-slot], .schedule-cell[data-slot]');
        let blockedCount = 0;
        let partialCount = 0;
        
        cells.forEach(cell => {
            const slotIndex = parseInt(cell.dataset.slot || cell.dataset.slotIndex);
            const fieldName = cell.dataset.field || cell.dataset.activity;
            
            if (isNaN(slotIndex)) return;
            
            // Check if this specific field is blocked at this slot
            const slotData = blockedMap.bySlotField[slotIndex];
            if (!slotData) return;
            
            // If cell has a specific field, check just that field
            if (fieldName && slotData[fieldName]) {
                const info = slotData[fieldName];
                
                if (info.isBlocked) {
                    cell.classList.add('blocked-by-other');
                    cell.classList.remove('partially-blocked');
                    cell.dataset.blockedReason = `🔒 Claimed by ${info.claimedBy.join(', ')}`;
                    blockedCount++;
                } else if (info.count > 0) {
                    cell.classList.add('partially-blocked');
                    cell.classList.remove('blocked-by-other');
                    cell.dataset.blockedReason = `⚠️ ${info.maxCapacity - info.count} spots left`;
                    partialCount++;
                }
            }
        });
        
        console.log(`🚫 Applied blocking: ${blockedCount} blocked, ${partialCount} partial`);
    }
    
    /**
     * Mark activity options in the palette as blocked if they're fully claimed
     * at the currently selected time slot
     */
    function updateActivityPaletteBlocking(currentSlotIndex) {
        const blockedMap = window._cloudBlockedResources;
        if (!blockedMap || !blockedMap.bySlotField) return;
        
        const slotData = blockedMap.bySlotField[currentSlotIndex];
        if (!slotData) return;
        
        // Get all activity options
        const options = document.querySelectorAll('.activity-option, .field-option, [data-activity-name]');
        
        options.forEach(option => {
            const fieldName = option.dataset.activityName || 
                             option.dataset.field || 
                             option.textContent?.trim();
            
            if (!fieldName) return;
            
            const fieldInfo = slotData[fieldName];
            
            if (fieldInfo?.isBlocked) {
                option.classList.add('field-blocked');
                option.setAttribute('draggable', 'false');
            } else {
                option.classList.remove('field-blocked');
                option.setAttribute('draggable', 'true');
            }
        });
    }
    
    /**
     * Create and display the blocked resources legend
     */
    function createBlockedLegend(containerSelector = '.app-content') {
        const blockedMap = window._cloudBlockedResources;
        if (!blockedMap?.stats) return;
        
        const container = document.querySelector(containerSelector);
        if (!container) return;
        
        // Remove existing legend
        const existing = container.querySelector('.blocked-legend');
        if (existing) existing.remove();
        
        // Only show if there are blocked resources
        if (blockedMap.stats.totalBlockedSlots === 0) return;
        
        const legend = document.createElement('div');
        legend.className = 'blocked-legend';
        legend.innerHTML = `
            <span style="font-weight: 600;">⚠️ Some slots are claimed by other schedulers:</span>
            <div class="blocked-legend-item">
                <div class="blocked-legend-icon full">🔒</div>
                <span>Fully blocked (${blockedMap.stats.totalBlockedSlots} slots)</span>
            </div>
            <div class="blocked-legend-item">
                <div class="blocked-legend-icon partial">⚠️</div>
                <span>Partially available</span>
            </div>
        `;
        
        // Insert at top of container
        container.insertBefore(legend, container.firstChild);
    }

    // =========================================================================
    // DRAG-DROP INTERCEPTION
    // =========================================================================
    
    let _originalDragHandlers = {};
    
    /**
     * Intercept drag-drop handlers to add blocking validation
     */
    function interceptDragDropHandlers() {
        console.log('🚫 Intercepting drag-drop handlers...');
        
        // Store and wrap the original handlers
        
        // Method 1: Intercept ondragover on cells
        document.addEventListener('dragover', handleDragOver, true);
        document.addEventListener('drop', handleDrop, true);
        document.addEventListener('dragenter', handleDragEnter, true);
        document.addEventListener('dragleave', handleDragLeave, true);
        
        console.log('🚫 Drag-drop interception active');
    }
    
    function handleDragEnter(e) {
        const cell = e.target.closest('.cell, .schedule-cell');
        if (!cell) return;
        
        const slotIndex = parseInt(cell.dataset.slot || cell.dataset.slotIndex);
        const draggedField = getDraggedFieldName(e);
        
        if (isNaN(slotIndex) || !draggedField) return;
        
        const availability = checkAvailability(draggedField, slotIndex);
        
        if (!availability.available) {
            cell.classList.add('drag-invalid');
            cell.classList.remove('drag-valid');
        } else {
            cell.classList.add('drag-valid');
            cell.classList.remove('drag-invalid');
        }
    }
    
    function handleDragLeave(e) {
        const cell = e.target.closest('.cell, .schedule-cell');
        if (cell) {
            cell.classList.remove('drag-invalid', 'drag-valid');
        }
    }
    
    function handleDragOver(e) {
        const cell = e.target.closest('.cell, .schedule-cell');
        if (!cell) return;
        
        const slotIndex = parseInt(cell.dataset.slot || cell.dataset.slotIndex);
        const draggedField = getDraggedFieldName(e);
        
        if (isNaN(slotIndex) || !draggedField) return;
        
        const availability = checkAvailability(draggedField, slotIndex);
        
        if (!availability.available) {
            // Prevent drop on blocked cells
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none';
            return false;
        }
    }
    
    function handleDrop(e) {
        const cell = e.target.closest('.cell, .schedule-cell');
        if (!cell) return;
        
        cell.classList.remove('drag-invalid', 'drag-valid');
        
        const slotIndex = parseInt(cell.dataset.slot || cell.dataset.slotIndex);
        const draggedField = getDraggedFieldName(e);
        
        if (isNaN(slotIndex) || !draggedField) return;
        
        const availability = checkAvailability(draggedField, slotIndex);
        
        if (!availability.available) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            showBlockedToast(draggedField, availability.reason);
            return false;
        }
    }
    
    /**
     * Get the field name being dragged
     */
    function getDraggedFieldName(e) {
        // Try dataTransfer
        try {
            const data = e.dataTransfer?.getData('text/plain') || 
                        e.dataTransfer?.getData('application/json');
            if (data) {
                const parsed = JSON.parse(data);
                return parsed.field || parsed.activity || parsed.name;
            }
        } catch (err) {}
        
        // Try global drag state
        if (window._currentDragActivity) {
            return window._currentDragActivity.name || window._currentDragActivity.field;
        }
        
        if (window.currentDragData) {
            return window.currentDragData.field || window.currentDragData.activity;
        }
        
        return null;
    }
    
    /**
     * Check availability using the cloud fetch module
     */
    function checkAvailability(fieldName, slotIndex) {
        if (window.SchedulerCloudFetch?.isResourceAvailable) {
            const blockedMap = window._cloudBlockedResources;
            return window.SchedulerCloudFetch.isResourceAvailable(fieldName, slotIndex, blockedMap);
        }
        
        // Fallback: check GlobalFieldLocks
        if (window.GlobalFieldLocks?.isFieldLockedAtSlot) {
            const isLocked = window.GlobalFieldLocks.isFieldLockedAtSlot(fieldName, slotIndex);
            return {
                available: !isLocked,
                reason: isLocked ? 'Field is locked' : null
            };
        }
        
        return { available: true };
    }
    
    /**
     * Show toast notification when drop is blocked
     */
    function showBlockedToast(fieldName, reason) {
        const message = `🚫 Cannot place "${fieldName}": ${reason || 'Already claimed by another scheduler'}`;
        
        if (window.showToast) {
            window.showToast(message, 'error');
        } else {
            // Fallback toast
            let toast = document.getElementById('blocking-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'blocking-toast';
                toast.style.cssText = `
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    padding: 12px 20px;
                    background: #ef4444;
                    color: white;
                    border-radius: 8px;
                    font-size: 14px;
                    z-index: 10000;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                    transition: opacity 0.3s;
                `;
                document.body.appendChild(toast);
            }
            
            toast.textContent = message;
            toast.style.opacity = '1';
            
            setTimeout(() => {
                toast.style.opacity = '0';
            }, 3000);
        }
    }

    // =========================================================================
    // CELL CLICK INTERCEPTION
    // =========================================================================
    
    /**
     * Intercept cell clicks to prevent selection of blocked cells
     */
    function interceptCellClicks() {
        document.addEventListener('click', (e) => {
            const cell = e.target.closest('.cell.blocked-by-other, .schedule-cell.blocked-by-other');
            if (!cell) return;
            
            // Allow right-click for context menu
            if (e.button !== 0) return;
            
            // Check if this is an attempt to edit
            const isEditAction = e.target.closest('.edit-btn, .select-btn, [data-action="edit"]');
            if (!isEditAction && !cell.classList.contains('selected')) {
                // Allow viewing but prevent editing actions
                return;
            }
            
            e.preventDefault();
            e.stopPropagation();
            
            const reason = cell.dataset.blockedReason || 'This slot is claimed by another scheduler';
            showBlockedToast('this slot', reason);
            
        }, true);
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    
    /**
     * Initialize blocking UI after cloud data is loaded
     */
    function initialize() {
        console.log('🚫 Initializing UI blocking...');
        
        // Inject styles
        injectStyles();
        
        // Set up drag-drop interception
        interceptDragDropHandlers();
        
        // Set up click interception
        interceptCellClicks();
        
        // Apply initial blocking if data exists
        if (window._cloudBlockedResources) {
            applyBlockedStylingToGrid();
            createBlockedLegend();
        }
        
        console.log('🚫 UI blocking initialized');
    }
    
    /**
     * Refresh blocking display (call after grid re-render)
     */
    function refresh() {
        applyBlockedStylingToGrid();
        createBlockedLegend();
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================
    
    // Listen for blocked resources ready
    window.addEventListener('campistry-blocked-resources-ready', (e) => {
        console.log('🚫 Blocked resources ready, updating UI...');
        applyBlockedStylingToGrid();
        createBlockedLegend();
    });
    
    // Listen for schedule grid updates
    window.addEventListener('campistry-daily-data-updated', () => {
        setTimeout(refresh, 100);
    });
    
    // Listen for tab changes to master scheduler
    const origShowTab = window.showTab;
    if (origShowTab) {
        window.showTab = function(tabId) {
            origShowTab.call(this, tabId);
            
            if (tabId === 'master-scheduler' || tabId === 'schedule') {
                setTimeout(refresh, 200);
            }
        };
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    
    window.SchedulerUIBlocking = {
        initialize,
        refresh,
        applyBlockedStylingToGrid,
        updateActivityPaletteBlocking,
        createBlockedLegend,
        checkAvailability,
        showBlockedToast
    };
    
    // Auto-initialize
    if (document.readyState === 'complete') {
        setTimeout(initialize, 100);
    } else {
        window.addEventListener('load', () => setTimeout(initialize, 100));
    }
    
    console.log("🚫 Scheduler UI Blocking v1.0.0 loaded");

})();
