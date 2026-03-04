// ============================================================================
// edit_restrictions.js — Visual Editing Restrictions v1.1
// ============================================================================
// Adds visual indicators and blocks editing for divisions user can't access
// Everyone sees everything, but only editable divisions allow interaction
//
// v1.1 OWNER-SAFETY FIX:
// - ★★★ canEditDivision() now has owner/admin bypass (was missing in v1.0!)
// - ★★★ _isOwnerOrAdmin() checks AccessControl live + localStorage fallback
// - ★★★ All interceptors and applyTo*() bail out for owner/admin
// - ★★★ This was the root cause of owners seeing "permission denied"
// ============================================================================

(function() {
    'use strict';

    console.log("🚫 Edit Restrictions v1.1 loading...");

    // =========================================================================
    // STATE
    // =========================================================================

    let _initialized = false;
    let _editableDivisions = [];
    let _currentRole = null;

    // =========================================================================
    // ★★★ v1.1: OWNER/ADMIN LIVE CHECK ★★★
    // Checks 3 sources so owners are NEVER blocked, even during init races.
    // =========================================================================

    function _isOwnerOrAdmin() {
        if (_currentRole === 'owner' || _currentRole === 'admin') return true;
        const acRole = window.AccessControl?.getCurrentRole?.();
        if (acRole === 'owner' || acRole === 'admin') return true;
        const lsRole = localStorage.getItem('campistry_role');
        if (lsRole === 'owner' || lsRole === 'admin') return true;
        return false;
    }

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

        // Listen for access control loaded
        window.addEventListener('campistry-access-loaded', (e) => {
            _editableDivisions = e.detail.editableDivisions || [];
            _currentRole = e.detail.role;
            applyRestrictions();
        });

        // Initialize access control if not already done
        await window.AccessControl.initialize();
        
        _editableDivisions = window.AccessControl.getEditableDivisions();
        _currentRole = window.AccessControl.getCurrentRole();
        
        _initialized = true;
        
        // Apply initial restrictions
        applyRestrictions();
        
        // Set up mutation observer to handle dynamic content
        setupObserver();

        console.log("🚫 Edit Restrictions initialized:", {
            role: _currentRole,
            editableDivisions: _editableDivisions
        });
    }

    // =========================================================================
    // APPLY RESTRICTIONS
    // =========================================================================

    function applyRestrictions() {
        if (!_initialized) return;

        // ★★★ v1.1: Owner/Admin never gets restrictions ★★★
        if (_isOwnerOrAdmin()) return;

        // Apply to division cards
        applyToDivisionCards();
        
        // Apply to schedule grid
        applyToScheduleGrid();
        
        // Apply to sidebar items
        applyToSidebarItems();
        
        // Apply to action buttons
        applyToActionButtons();
        
        // Show access banner
        window.AccessControl?.renderAccessBanner();
    }

    /**
     * Apply restrictions to division cards in the overview
     */
    function applyToDivisionCards() {
        // ★★★ v1.1: Owner/Admin bypass ★★★
        if (_isOwnerOrAdmin()) return;

        const divisionCards = document.querySelectorAll('[data-division], .division-card, .division-row');
        
        divisionCards.forEach(card => {
            const divisionName = card.dataset.division || card.querySelector('.division-name')?.textContent?.trim();
            if (!divisionName) return;
            
            const canEdit = canEditDivision(divisionName);
            
            if (!canEdit) {
                card.classList.add('view-only');
                
                // Add overlay if not already present
                if (!card.querySelector('.view-only-overlay')) {
                    const overlay = createViewOnlyOverlay(divisionName);
                    card.style.position = 'relative';
                    card.appendChild(overlay);
                }
                
                // Disable interactive elements
                card.querySelectorAll('button, input, select, .editable').forEach(el => {
                    if (!el.classList.contains('view-only-allowed')) {
                        el.disabled = true;
                        el.style.pointerEvents = 'none';
                    }
                });
            } else {
                card.classList.remove('view-only');
                card.querySelector('.view-only-overlay')?.remove();
                
                // Re-enable interactive elements
                card.querySelectorAll('button, input, select, .editable').forEach(el => {
                    el.disabled = false;
                    el.style.pointerEvents = '';
                });
            }
        });
    }

    /**
     * Apply restrictions to schedule grid cells
     */
    function applyToScheduleGrid() {
        // ★★★ v1.1: Owner/Admin bypass ★★★
        if (_isOwnerOrAdmin()) return;

        const scheduleCells = document.querySelectorAll('.schedule-cell, .time-slot, .activity-block');
        
        scheduleCells.forEach(cell => {
            const divisionName = getDivisionFromElement(cell);
            if (!divisionName) return;
            
            const canEdit = canEditDivision(divisionName);
            
            if (!canEdit) {
                cell.classList.add('view-only-cell');
                cell.draggable = false;
                cell.style.cursor = 'default';
                
                if (!cell.title) {
                    const subdivision = window.AccessControl?.getSubdivisionForDivision(divisionName);
                    cell.title = subdivision 
                        ? `Managed by ${subdivision.name}` 
                        : 'You do not have edit access';
                }
            } else {
                cell.classList.remove('view-only-cell');
                cell.style.cursor = '';
                cell.title = '';
            }
        });
    }

    /**
     * Apply restrictions to sidebar division list
     */
    function applyToSidebarItems() {
        // ★★★ v1.1: Owner/Admin bypass ★★★
        if (_isOwnerOrAdmin()) return;

        const sidebarItems = document.querySelectorAll('.sidebar-division, .division-list-item');
        
        sidebarItems.forEach(item => {
            const divisionName = item.dataset.division || item.textContent?.trim();
            if (!divisionName) return;
            
            const canEdit = canEditDivision(divisionName);
            
            if (!canEdit) {
                item.classList.add('view-only-sidebar-item');
                
                if (!item.querySelector('.lock-icon')) {
                    const lockIcon = document.createElement('span');
                    lockIcon.className = 'lock-icon';
                    lockIcon.innerHTML = '🔒';
                    lockIcon.title = 'View only';
                    item.appendChild(lockIcon);
                }
            } else {
                item.classList.remove('view-only-sidebar-item');
                item.querySelector('.lock-icon')?.remove();
            }
        });
    }

    /**
     * Apply restrictions to action buttons (Generate, Clear, etc.)
     */
    function applyToActionButtons() {
        // ★★★ v1.1: Owner/Admin bypass ★★★
        if (_isOwnerOrAdmin()) return;

        const generateBtn = document.getElementById('generate-btn') || 
                           document.querySelector('[data-action="generate"]') ||
                           document.querySelector('.generate-button');
        
        if (generateBtn && _currentRole === 'viewer') {
            generateBtn.disabled = true;
            generateBtn.title = 'You do not have permission to generate schedules';
            generateBtn.classList.add('btn-disabled');
        }
        
        const clearBtn = document.getElementById('clear-btn') || 
                        document.querySelector('[data-action="clear"]');
        
        if (clearBtn && _currentRole === 'viewer') {
            clearBtn.disabled = true;
            clearBtn.title = 'You do not have permission to clear schedules';
        }
    }

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    /**
     * Check if user can edit a division
     * ★★★ v1.1 FIX: Added owner/admin bypass — this was the root cause! ★★★
     */
    function canEditDivision(divisionName) {
        if (!divisionName) return false;
        // ★★★ v1.1: Owner/Admin can ALWAYS edit every division ★★★
        if (_isOwnerOrAdmin()) return true;
        if (_currentRole === 'viewer') return false;
        return _editableDivisions.includes(divisionName);
    }

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
        overlay.className = 'view-only-overlay';
        overlay.innerHTML = `
            <div class="view-only-badge">
                <span class="view-only-icon">👁️</span>
                <span class="view-only-text">View Only</span>
            </div>
            ${subdivision ? `
                <div class="view-only-info">Managed by ${subdivision.name}</div>
            ` : ''}
        `;
        
        return overlay;
    }

    // =========================================================================
    // MUTATION OBSERVER
    // =========================================================================

    let _observer = null;

    function setupObserver() {
        if (_observer) return;

        _observer = new MutationObserver((mutations) => {
            // ★★★ v1.1: Skip for owner/admin ★★★
            if (_isOwnerOrAdmin()) return;

            let shouldReapply = false;
            
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if (node.matches?.('[data-division], .division-card, .schedule-cell, .activity-block')) {
                                shouldReapply = true;
                                break;
                            }
                            if (node.querySelector?.('[data-division], .division-card, .schedule-cell')) {
                                shouldReapply = true;
                                break;
                            }
                        }
                    }
                }
                if (shouldReapply) break;
            }
            
            if (shouldReapply) {
                clearTimeout(_observer._debounceTimer);
                _observer._debounceTimer = setTimeout(() => {
                    applyRestrictions();
                }, 100);
            }
        });

        _observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // =========================================================================
    // EVENT HANDLERS
    // ★★★ v1.1: Every handler checks _isOwnerOrAdmin() FIRST ★★★
    // =========================================================================

    function setupEditInterceptors() {
        document.addEventListener('dragstart', (e) => {
            // ★★★ v1.1: Owner/Admin is NEVER blocked ★★★
            if (_isOwnerOrAdmin()) return;

            const divisionName = getDivisionFromElement(e.target);
            if (divisionName && !canEditDivision(divisionName)) {
                e.preventDefault();
                showAccessDeniedToast(divisionName);
            }
        }, true);

        document.addEventListener('click', (e) => {
            // ★★★ v1.1: Owner/Admin is NEVER blocked ★★★
            if (_isOwnerOrAdmin()) return;

            const editBtn = e.target.closest('[data-action="edit"], .edit-btn, .delete-btn');
            if (!editBtn) return;
            
            const divisionName = getDivisionFromElement(editBtn);
            if (divisionName && !canEditDivision(divisionName)) {
                e.preventDefault();
                e.stopPropagation();
                showAccessDeniedToast(divisionName);
            }
        }, true);

        document.addEventListener('contextmenu', (e) => {
            // ★★★ v1.1: Owner/Admin is NEVER blocked ★★★
            if (_isOwnerOrAdmin()) return;

            const divisionName = getDivisionFromElement(e.target);
            if (divisionName && !canEditDivision(divisionName)) {
                // Allow context menu but show restricted state
            }
        }, true);
    }

    function showAccessDeniedToast(divisionName) {
        const subdivision = window.AccessControl?.getSubdivisionForDivision(divisionName);
        const message = subdivision 
            ? `"${divisionName}" is managed by ${subdivision.name}`
            : `You don't have permission to edit "${divisionName}"`;
        
        const toast = document.createElement('div');
        toast.className = 'access-denied-toast';
        toast.innerHTML = `
            <span style="font-size: 1.2rem;">🔒</span>
            <span>${message}</span>
        `;
        
        document.body.appendChild(toast);
        
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // =========================================================================
    // CSS STYLES
    // =========================================================================

    function injectStyles() {
        if (document.getElementById('edit-restrictions-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'edit-restrictions-styles';
        styles.textContent = `
            .view-only-overlay {
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
            
            .view-only-badge {
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
            
            .view-only-info {
                font-size: 0.7rem;
                color: var(--slate-500);
                background: white;
                padding: 2px 8px;
                border-radius: 4px;
            }
            
            .view-only {
                position: relative;
            }
            
            .view-only::before {
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
            
            .view-only-cell {
                opacity: 0.85;
                background-image: repeating-linear-gradient(
                    -45deg,
                    transparent,
                    transparent 10px,
                    rgba(100, 116, 139, 0.03) 10px,
                    rgba(100, 116, 139, 0.03) 20px
                ) !important;
            }
            
            .view-only-cell:hover {
                cursor: not-allowed !important;
            }
            
            .view-only-sidebar-item {
                opacity: 0.7;
            }
            
            .lock-icon {
                font-size: 0.7rem;
                margin-left: 6px;
                opacity: 0.6;
            }
            
            .btn-disabled {
                opacity: 0.5;
                cursor: not-allowed !important;
            }
            
            .access-denied-toast {
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
            
            .access-denied-toast.show {
                transform: translateX(-50%) translateY(0);
                opacity: 1;
            }
            
            #access-control-banner {
                animation: slideDown 0.3s ease-out;
            }
            
            @keyframes slideDown {
                from {
                    transform: translateY(-10px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
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
        // ★★★ v1.1: Owner/Admin always editable ★★★
        if (_isOwnerOrAdmin()) return true;
        const divisionName = getDivisionFromElement(element);
        if (!divisionName) return true;
        return canEditDivision(divisionName);
    }

    function guardedAction(divisionName, action) {
        // ★★★ v1.1: Owner/Admin always passes guard ★★★
        if (_isOwnerOrAdmin()) return action();
        if (!canEditDivision(divisionName)) {
            showAccessDeniedToast(divisionName);
            return false;
        }
        return action();
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const EditRestrictions = {
        initialize,
        refresh,
        applyRestrictions,
        canEditDivision,
        isElementEditable,
        guardedAction,
        showAccessDeniedToast,
        injectStyles
    };

    window.EditRestrictions = EditRestrictions;

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

    console.log("🚫 Edit Restrictions v1.1 loaded");

})();
