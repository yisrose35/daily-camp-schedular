// ============================================================================
// rbac_visual_restrictions.js — Visual Editing Restrictions v2.1
// ============================================================================
// Adds visual indicators and blocks editing for divisions user can't access
// 
// ROLE BEHAVIOR:
// - OWNER: Full access, no restrictions
// - ADMIN: Full access, no restrictions  
// - SCHEDULER: Editable divisions normal, others greyed out (view-only)
// - VIEWER: Everything greyed out except Print Center & Camper Locator
//
// EXCEPTIONS (always accessible):
// - Daily Schedule View (view for all)
// - Print Center (full for all — but design panel Owner/Admin only)
// - Camper Locator (full for all)
//
// v2.1 CHANGES:
// - ★ NEW: applyPrintCenterRestrictions() — hides design panel + save
//          buttons for Scheduler/Viewer roles
// - ★ NEW: Print tab triggers restrictions on tab switch via observer
// ============================================================================

(function() {
    'use strict';

    console.log("🚫 Visual Restrictions v2.1 loading...");

    // =========================================================================
    // STATE
    // =========================================================================

    let _initialized = false;
    let _editableDivisions = [];
    let _currentRole = null;
    let _observer = null;

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_initialized) return;

        // Wait for AccessControl
        let attempts = 0;
        while (!window.AccessControl && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!window.AccessControl) {
            console.warn("🚫 AccessControl not available, skipping restrictions");
            return;
        }

        // Wait for AccessControl to be initialized
        while (!window.AccessControl.isInitialized && attempts < 100) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        // Listen for access control loaded
        window.addEventListener('campistry-access-loaded', (e) => {
            _editableDivisions = e.detail.editableDivisions || [];
            _currentRole = e.detail.role;
            console.log("🚫 Access loaded event:", { role: _currentRole, editable: _editableDivisions });
            applyRestrictions();
        });

        // Get current state
        _editableDivisions = window.AccessControl.getEditableDivisions() || [];
        _currentRole = window.AccessControl.getCurrentRole();
        
        _initialized = true;
        
        // Apply initial restrictions
        applyRestrictions();
        
        // Set up mutation observer to handle dynamic content
        setupObserver();

        console.log("🚫 Visual Restrictions v2.1 initialized:", {
            role: _currentRole,
            editableDivisions: _editableDivisions
        });
    }

    // =========================================================================
    // APPLY RESTRICTIONS
    // =========================================================================

    function applyRestrictions() {
        if (!_initialized) return;

        console.log("🚫 Applying restrictions for role:", _currentRole);

        // Inject styles
        injectStyles();

        // Apply to division-related UI elements
        applyToDivisionCards();
        applyToDivisionButtons();
        applyToScheduleGrid();
        applyToActionButtons();
        applyToSetupPanel();
        applyToFieldsTab();
        applyToDailyAdjustments();
        applyToMasterScheduler();
        
        // ★ v2.1: Apply print center restrictions if that tab is visible
        applyPrintCenterRestrictions();
        
        // Show access banner
        window.AccessControl?.renderAccessBanner();
    }

    // =========================================================================
    // CHECK PERMISSIONS
    // =========================================================================

    function canEditDivision(divisionName) {
        if (!divisionName) return false;
        if (_currentRole === 'owner' || _currentRole === 'admin') return true;
        if (_currentRole === 'viewer') return false;
        return _editableDivisions.includes(divisionName);
    }

    function canViewOnly() {
        return _currentRole === 'viewer';
    }

    function isSchedulerWithLimitedAccess() {
        return _currentRole === 'scheduler' && _editableDivisions.length > 0;
    }

    // ★ v2.1: Check if user can edit print templates
    function canEditPrintTemplates() {
        return _currentRole === 'owner' || _currentRole === 'admin';
    }

    // =========================================================================
    // ★ v2.1: APPLY TO PRINT CENTER
    // =========================================================================
    // Controls who sees the design panel, template save/update/delete buttons.
    // ALL roles can still preview, print, and export — but only Owner/Admin
    // can modify the visual design and save templates.
    // =========================================================================

    function applyPrintCenterRestrictions() {
        const printTab = document.getElementById('print');
        if (!printTab) return;

        // Only apply if print tab has content (Print Center has been initialized)
        const pcContainer = printTab.querySelector('.pc-container');
        if (!pcContainer) return;

        const canDesign = canEditPrintTemplates();

        console.log(`🚫 Print Center restrictions: role=${_currentRole}, canDesign=${canDesign}`);

        // 1. Design panel toggle button in topbar
        const designToggleBtn = pcContainer.querySelector('[onclick*="_pcToggleDesignPanel"]');
        if (designToggleBtn) {
            designToggleBtn.style.display = canDesign ? '' : 'none';
        }

        // 2. Design panel itself — hide entirely for non-editors
        const designPanel = document.getElementById('pc-design-panel');
        if (designPanel) {
            if (!canDesign) {
                designPanel.classList.remove('open');
                designPanel.style.display = 'none';
            } else {
                designPanel.style.display = '';
                // Don't force open — respect user's toggle preference
            }
        }

        // 3. Template save/update/delete buttons (inside design panel)
        const saveAsBtn = pcContainer.querySelector('[onclick*="_pcSaveAsTemplate"]');
        const updateBtn = document.getElementById('pc-btn-update-tpl');
        const deleteBtn = document.getElementById('pc-btn-delete-tpl');
        const resetBtn = pcContainer.querySelector('[onclick*="_pcResetToDefault"]');

        if (saveAsBtn) saveAsBtn.style.display = canDesign ? '' : 'none';
        if (updateBtn) updateBtn.style.display = canDesign ? updateBtn.style.display : 'none';
        if (deleteBtn) deleteBtn.style.display = canDesign ? deleteBtn.style.display : 'none';
        if (resetBtn) resetBtn.style.display = canDesign ? '' : 'none';

        // 4. For non-editors, add a subtle info banner if not already present
        if (!canDesign && !pcContainer.querySelector('.pc-rbac-info-banner')) {
            const banner = document.createElement('div');
            banner.className = 'pc-rbac-info-banner';
            banner.style.cssText = `
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 16px;
                background: linear-gradient(135deg, #DBEAFE, #BFDBFE);
                border: 1px solid #3B82F6;
                border-radius: 8px;
                margin-bottom: 12px;
                font-size: 0.85rem;
                color: #1E40AF;
            `;
            banner.innerHTML = `
                <span style="font-size: 1.1rem;">🎨</span>
                <div>
                    <strong>Template design is managed by your camp owner.</strong>
                    <span style="opacity: 0.85;"> You can preview, print, and export using existing templates.</span>
                </div>
            `;
            // Insert after topbar, before controls
            const topbar = pcContainer.querySelector('.pc-topbar');
            if (topbar && topbar.nextSibling) {
                topbar.parentNode.insertBefore(banner, topbar.nextSibling);
            }
        }

        // 5. If user IS an editor, remove the info banner if it exists
        if (canDesign) {
            pcContainer.querySelector('.pc-rbac-info-banner')?.remove();
        }
    }

    // =========================================================================
    // APPLY TO DIVISION CARDS
    // =========================================================================

    function applyToDivisionCards() {
        const divisionCards = document.querySelectorAll('[data-division], .division-card, .division-row');
        
        divisionCards.forEach(card => {
            const divisionName = card.dataset.division || 
                                card.querySelector('.division-name')?.textContent?.trim() ||
                                card.querySelector('[data-division-name]')?.dataset.divisionName;
            
            if (!divisionName) return;
            
            const canEdit = canEditDivision(divisionName);
            
            if (!canEdit) {
                card.classList.add('rbac-view-only');
                card.classList.remove('rbac-editable');
                
                // Add visual overlay if not present
                if (!card.querySelector('.rbac-overlay')) {
                    const overlay = createViewOnlyOverlay(divisionName);
                    card.style.position = 'relative';
                    card.appendChild(overlay);
                }
                
                // Disable interactive elements
                disableInteractiveElements(card);
            } else {
                card.classList.remove('rbac-view-only');
                card.classList.add('rbac-editable');
                card.querySelector('.rbac-overlay')?.remove();
                enableInteractiveElements(card);
            }
        });
    }

    // =========================================================================
    // APPLY TO DIVISION BUTTONS (Setup Tab)
    // =========================================================================

    function applyToDivisionButtons() {
        const divisionButtons = document.querySelectorAll('#divisionButtons button, .division-btn');
        
        divisionButtons.forEach(btn => {
            const divisionName = btn.textContent?.trim()?.replace('✕', '')?.trim() ||
                                btn.dataset.division;
            
            if (!divisionName) return;
            
            const canEdit = canEditDivision(divisionName);
            
            if (!canEdit) {
                btn.classList.add('rbac-division-restricted');
                btn.title = `View only - ${divisionName} is managed by another scheduler`;
            } else {
                btn.classList.remove('rbac-division-restricted');
                btn.title = '';
            }
        });
    }

    // =========================================================================
    // APPLY TO SCHEDULE GRID
    // =========================================================================

    function applyToScheduleGrid() {
        const scheduleCells = document.querySelectorAll('.schedule-cell, .time-slot, .activity-block, .bunk-row');
        
        scheduleCells.forEach(cell => {
            const divisionName = getDivisionFromElement(cell);
            if (!divisionName) return;
            
            const canEdit = canEditDivision(divisionName);
            
            if (!canEdit) {
                cell.classList.add('rbac-cell-restricted');
                cell.draggable = false;
                cell.style.cursor = 'default';
                
                if (!cell.title) {
                    const subdivision = window.AccessControl?.getSubdivisionForDivision(divisionName);
                    cell.title = subdivision 
                        ? `View only - Managed by ${subdivision.name}` 
                        : 'View only - You do not have edit access';
                }
            } else {
                cell.classList.remove('rbac-cell-restricted');
                cell.style.cursor = '';
                cell.title = '';
            }
        });
    }

    // =========================================================================
    // APPLY TO ACTION BUTTONS
    // =========================================================================

    function applyToActionButtons() {
        // Viewer restrictions (most buttons disabled)
        if (_currentRole === 'viewer') {
            const generateBtns = document.querySelectorAll('#generate-btn, [data-action="generate"], .generate-button');
            generateBtns.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('rbac-btn-disabled');
                btn.title = 'Viewers cannot generate schedules';
            });
            
            const clearBtns = document.querySelectorAll('#clear-btn, [data-action="clear"]');
            clearBtns.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('rbac-btn-disabled');
                btn.title = 'Viewers cannot clear schedules';
            });
            
            const eraseBtns = document.querySelectorAll('#eraseTodayBtn, #eraseAllSchedulesBtn, #eraseHistoryBtn, #eraseAllBtn');
            eraseBtns.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('rbac-btn-disabled');
                btn.title = 'Viewers cannot erase data';
            });
            
            const addBtns = document.querySelectorAll('#addDivisionBtn, #addBunkBtn, .add-btn');
            addBtns.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('rbac-btn-disabled');
            });

            return;
        }
        
        // Admin restrictions
        if (_currentRole === 'admin') {
            const eraseAllBtn = document.getElementById('eraseAllBtn');
            if (eraseAllBtn) {
                eraseAllBtn.disabled = true;
                eraseAllBtn.classList.add('rbac-btn-disabled');
                eraseAllBtn.title = 'Only the camp owner can erase all data';
            }
            return;
        }
        
        // Scheduler restrictions
        if (_currentRole === 'scheduler') {
            if (_editableDivisions.length === 0) {
                const generateBtns = document.querySelectorAll('#generate-btn, [data-action="generate"]');
                generateBtns.forEach(btn => {
                    btn.disabled = true;
                    btn.classList.add('rbac-btn-disabled');
                    btn.title = 'No divisions assigned - contact owner';
                });
            }
            
            const eraseAllBtns = document.querySelectorAll('#eraseAllSchedulesBtn, #eraseHistoryBtn, #eraseAllBtn');
            eraseAllBtns.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('rbac-btn-disabled');
                btn.title = 'Only owners can erase camp-wide data';
            });
        }
    }

    // =========================================================================
    // APPLY TO SETUP PANEL
    // =========================================================================

    function applyToSetupPanel() {
        const setupPanel = document.getElementById('setup');
        if (!setupPanel) return;

        if (_currentRole === 'viewer') {
            setupPanel.querySelectorAll('input, button, select').forEach(el => {
                if (!el.closest('.rbac-always-enabled')) {
                    el.disabled = true;
                    el.classList.add('rbac-input-disabled');
                }
            });
            return;
        }

        if (_currentRole === 'scheduler') {
            const divisionInput = document.getElementById('divisionInput');
            const addDivisionBtn = document.getElementById('addDivisionBtn');
            
            if (divisionInput) {
                divisionInput.disabled = true;
                divisionInput.placeholder = 'Contact owner to add divisions';
            }
            if (addDivisionBtn) {
                addDivisionBtn.disabled = true;
                addDivisionBtn.title = 'Only owner/admin can add divisions';
            }
        }
    }

    // =========================================================================
    // APPLY TO FIELDS TAB
    // =========================================================================

    function applyToFieldsTab() {
        const fieldsTab = document.getElementById('fields');
        if (!fieldsTab) return;

        if (_currentRole === 'viewer') {
            fieldsTab.querySelectorAll('input, button, select').forEach(el => {
                el.disabled = true;
                el.classList.add('rbac-input-disabled');
            });
            
            if (!fieldsTab.querySelector('.rbac-tab-banner')) {
                const banner = createTabBanner('View Only', 'You can view field settings but cannot make changes.');
                fieldsTab.insertBefore(banner, fieldsTab.firstChild);
            }
            return;
        }

        if (_currentRole === 'scheduler') {
            const addFieldBtns = fieldsTab.querySelectorAll('[data-action="add-field"], .add-field-btn');
            addFieldBtns.forEach(btn => {
                btn.disabled = true;
                btn.title = 'Only owner/admin can add fields';
            });
            
            const deleteFieldBtns = fieldsTab.querySelectorAll('[data-action="delete-field"], .delete-field-btn');
            deleteFieldBtns.forEach(btn => {
                btn.disabled = true;
                btn.title = 'Only owner/admin can delete fields';
            });
            
            if (!fieldsTab.querySelector('.rbac-tab-banner')) {
                const banner = createTabBanner(
                    'Limited Access', 
                    `You can edit field availability for your divisions (${_editableDivisions.join(', ')}). Field creation/deletion requires owner/admin.`
                );
                banner.style.background = 'linear-gradient(135deg, #DBEAFE, #BFDBFE)';
                banner.style.borderColor = '#3B82F6';
                fieldsTab.insertBefore(banner, fieldsTab.firstChild);
            }
        }
    }

    // =========================================================================
    // APPLY TO DAILY ADJUSTMENTS
    // =========================================================================

    function applyToDailyAdjustments() {
        const dailyTab = document.getElementById('daily-adjustments');
        if (!dailyTab) return;

        if (_currentRole === 'viewer') {
            dailyTab.querySelectorAll('input, button, select, .editable').forEach(el => {
                el.disabled = true;
                el.classList.add('rbac-input-disabled');
            });
            
            if (!dailyTab.querySelector('.rbac-tab-banner')) {
                const banner = createTabBanner('View Only', 'You can view daily adjustments but cannot make changes.');
                dailyTab.insertBefore(banner, dailyTab.firstChild);
            }
            return;
        }

        if (_currentRole === 'scheduler') {
            dailyTab.querySelectorAll('[data-division], .division-row, .division-section').forEach(row => {
                const divName = row.dataset.division || row.querySelector('.division-name')?.textContent?.trim();
                if (divName && !canEditDivision(divName)) {
                    row.classList.add('rbac-row-restricted');
                    row.querySelectorAll('input, button, select').forEach(el => {
                        el.disabled = true;
                    });
                }
            });
        }
    }

    // =========================================================================
    // APPLY TO MASTER SCHEDULER
    // =========================================================================

    function applyToMasterScheduler() {
        const masterTab = document.getElementById('master-scheduler');
        if (!masterTab) return;

        if (_currentRole === 'viewer') {
            masterTab.querySelectorAll('input, button, select').forEach(el => {
                if (!el.closest('.rbac-always-enabled')) {
                    el.disabled = true;
                    el.classList.add('rbac-input-disabled');
                }
            });
            return;
        }

        if (_currentRole === 'scheduler') {
            masterTab.querySelectorAll('[data-division], .division-column, .division-section').forEach(section => {
                const divName = section.dataset.division || section.querySelector('.division-header')?.textContent?.trim();
                if (divName && !canEditDivision(divName)) {
                    section.classList.add('rbac-section-restricted');
                    section.querySelectorAll('input, button, select, .draggable').forEach(el => {
                        el.disabled = true;
                        el.draggable = false;
                    });
                }
            });
        }
    }

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    function getDivisionFromElement(element) {
        if (element.dataset.division) return element.dataset.division;
        if (element.dataset.divisionName) return element.dataset.divisionName;
        
        let parent = element.parentElement;
        let depth = 0;
        while (parent && depth < 10) {
            if (parent.dataset.division) return parent.dataset.division;
            if (parent.dataset.divisionName) return parent.dataset.divisionName;
            if (parent.classList.contains('division-section')) {
                const header = parent.querySelector('.division-name, .division-header');
                if (header) return header.textContent?.trim();
            }
            parent = parent.parentElement;
            depth++;
        }
        
        return null;
    }

    function createViewOnlyOverlay(divisionName) {
        const subdivision = window.AccessControl?.getSubdivisionForDivision(divisionName);
        
        const overlay = document.createElement('div');
        overlay.className = 'rbac-overlay';
        overlay.innerHTML = `
            <div class="rbac-badge">
                <span class="rbac-badge-icon">👁️</span>
                <span class="rbac-badge-text">View Only</span>
            </div>
            ${subdivision ? `<div class="rbac-info">Managed by ${subdivision.name}</div>` : ''}
        `;
        
        return overlay;
    }

    function createTabBanner(title, message) {
        const banner = document.createElement('div');
        banner.className = 'rbac-tab-banner';
        banner.innerHTML = `
            <span style="font-size: 1.2rem;">👁️</span>
            <div>
                <strong>${title}</strong>
                <div style="font-size: 0.85rem; opacity: 0.9;">${message}</div>
            </div>
        `;
        return banner;
    }

    function disableInteractiveElements(container) {
        container.querySelectorAll('button, input, select, .editable, [draggable="true"]').forEach(el => {
            if (!el.classList.contains('rbac-always-enabled')) {
                el.disabled = true;
                el.style.pointerEvents = 'none';
                if (el.draggable) el.draggable = false;
            }
        });
    }

    function enableInteractiveElements(container) {
        container.querySelectorAll('button, input, select, .editable').forEach(el => {
            el.disabled = false;
            el.style.pointerEvents = '';
        });
    }

    // =========================================================================
    // MUTATION OBSERVER
    // =========================================================================

    function setupObserver() {
        if (_observer) return;

        _observer = new MutationObserver((mutations) => {
            let shouldReapply = false;
            let printTabChanged = false;
            
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            // Standard division/schedule content
                            if (node.matches?.('[data-division], .division-card, .schedule-cell, .activity-block, .bunk-row')) {
                                shouldReapply = true;
                                break;
                            }
                            if (node.querySelector?.('[data-division], .division-card, .schedule-cell')) {
                                shouldReapply = true;
                                break;
                            }
                            // ★ v2.1: Detect print center content being added
                            if (node.matches?.('.pc-container') || node.querySelector?.('.pc-container')) {
                                printTabChanged = true;
                                shouldReapply = true;
                                break;
                            }
                        }
                    }
                }
                
                // ★ v2.1: Also watch for class changes (tab switching adds .active)
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    const target = mutation.target;
                    if (target.id === 'print' && target.classList.contains('active')) {
                        printTabChanged = true;
                        shouldReapply = true;
                    }
                }
                
                if (shouldReapply) break;
            }
            
            if (shouldReapply) {
                clearTimeout(_observer._debounceTimer);
                _observer._debounceTimer = setTimeout(() => {
                    if (printTabChanged) {
                        applyPrintCenterRestrictions();
                    } else {
                        applyRestrictions();
                    }
                }, 100);
            }
        });

        _observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });
    }

    // =========================================================================
    // EVENT INTERCEPTORS
    // =========================================================================

    function setupEditInterceptors() {
        // Intercept drag start
        document.addEventListener('dragstart', (e) => {
            const divisionName = getDivisionFromElement(e.target);
            if (divisionName && !canEditDivision(divisionName)) {
                e.preventDefault();
                showAccessDeniedToast(divisionName);
            }
        }, true);

        // Intercept click on edit/delete buttons
        document.addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-action="edit"], [data-action="delete"], .edit-btn, .delete-btn');
            if (!editBtn) return;
            
            const divisionName = getDivisionFromElement(editBtn);
            if (divisionName && !canEditDivision(divisionName)) {
                e.preventDefault();
                e.stopPropagation();
                showAccessDeniedToast(divisionName);
            }
        }, true);
    }

    function showAccessDeniedToast(divisionName) {
        const subdivision = window.AccessControl?.getSubdivisionForDivision(divisionName);
        const message = subdivision 
            ? `"${divisionName}" is managed by ${subdivision.name}`
            : `You don't have permission to edit "${divisionName}"`;
        
        window.AccessControl?.showPermissionDenied?.(message) || alert(message);
    }

    // =========================================================================
    // CSS STYLES
    // =========================================================================

    function injectStyles() {
        if (document.getElementById('rbac-visual-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'rbac-visual-styles';
        styles.textContent = `
            /* View-only overlay */
            .rbac-overlay {
                position: absolute;
                top: 8px;
                right: 8px;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 4px;
                z-index: 10;
                pointer-events: none;
            }
            
            .rbac-badge {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                background: rgba(100, 116, 139, 0.9);
                color: white;
                border-radius: 999px;
                font-size: 0.75rem;
                font-weight: 600;
                backdrop-filter: blur(4px);
            }
            
            .rbac-info {
                font-size: 0.7rem;
                color: #64748b;
                background: white;
                padding: 2px 8px;
                border-radius: 4px;
            }
            
            /* View-only elements */
            .rbac-view-only {
                position: relative;
                opacity: 0.7;
            }
            
            .rbac-view-only::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(248, 250, 252, 0.5);
                pointer-events: none;
                z-index: 5;
                border-radius: inherit;
            }
            
            /* Restricted division buttons */
            .rbac-division-restricted {
                opacity: 0.6 !important;
                background: #f1f5f9 !important;
                border-color: #e2e8f0 !important;
                cursor: default !important;
                position: relative;
            }
            
            .rbac-division-restricted::after {
                content: '👁️';
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 0.7rem;
            }
            
            /* Restricted cells */
            .rbac-cell-restricted {
                opacity: 0.7;
                background-image: repeating-linear-gradient(
                    -45deg,
                    transparent,
                    transparent 10px,
                    rgba(100, 116, 139, 0.05) 10px,
                    rgba(100, 116, 139, 0.05) 20px
                ) !important;
                pointer-events: none;
            }
            
            /* Restricted rows/sections */
            .rbac-row-restricted,
            .rbac-section-restricted {
                opacity: 0.6;
                position: relative;
                pointer-events: none;
            }
            
            .rbac-row-restricted::after,
            .rbac-section-restricted::after {
                content: '🔒 View Only';
                position: absolute;
                right: 8px;
                top: 8px;
                font-size: 0.7rem;
                color: #64748b;
                background: #f1f5f9;
                padding: 2px 8px;
                border-radius: 4px;
            }
            
            /* Disabled buttons */
            .rbac-btn-disabled {
                opacity: 0.5 !important;
                cursor: not-allowed !important;
                pointer-events: none !important;
            }
            
            /* Disabled inputs */
            .rbac-input-disabled {
                opacity: 0.6 !important;
                cursor: not-allowed !important;
                background: #f1f5f9 !important;
            }
            
            /* Tab banner */
            .rbac-tab-banner {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 16px;
                background: linear-gradient(135deg, #FEF3C7, #FDE68A);
                border: 1px solid #F59E0B;
                border-radius: 8px;
                margin-bottom: 16px;
                font-size: 0.9rem;
                color: #92400E;
            }
            
            /* Access denied toast */
            .rbac-access-denied-toast {
                position: fixed;
                bottom: 24px;
                left: 50%;
                transform: translateX(-50%) translateY(100px);
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 12px 20px;
                background: #1E293B;
                color: white;
                border-radius: 10px;
                font-size: 0.9rem;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
                z-index: 10001;
                opacity: 0;
                transition: all 0.3s ease;
            }
            
            .rbac-access-denied-toast.show {
                transform: translateX(-50%) translateY(0);
                opacity: 1;
            }
            
            /* Always enabled (Print, Camper Locator) */
            .rbac-always-enabled {
                opacity: 1 !important;
                pointer-events: auto !important;
                cursor: pointer !important;
            }
        `;
        document.head.appendChild(styles);
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    function refresh() {
        _editableDivisions = window.AccessControl?.getEditableDivisions() || [];
        _currentRole = window.AccessControl?.getCurrentRole();
        applyRestrictions();
    }

    function isElementEditable(element) {
        const divisionName = getDivisionFromElement(element);
        if (!divisionName) return true;
        return canEditDivision(divisionName);
    }

    function guardedAction(divisionName, action) {
        if (!canEditDivision(divisionName)) {
            showAccessDeniedToast(divisionName);
            return false;
        }
        return action();
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const VisualRestrictions = {
        initialize,
        refresh,
        applyRestrictions,
        canEditDivision,
        canEditPrintTemplates,           // ★ v2.1
        applyPrintCenterRestrictions,    // ★ v2.1
        isElementEditable,
        guardedAction,
        showAccessDeniedToast,
        injectStyles
    };

    window.VisualRestrictions = VisualRestrictions;
    // Also expose as EditRestrictions for backwards compatibility
    window.EditRestrictions = VisualRestrictions;

    // Inject styles immediately
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectStyles();
            setupEditInterceptors();
        });
    } else {
        injectStyles();
        setupEditInterceptors();
    }

    console.log("🚫 Visual Restrictions v2.1 loaded");

})();
