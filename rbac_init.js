// ============================================================================
// rbac_init.js — Master RBAC Initialization
// ============================================================================
// Initializes all RBAC modules in the correct order:
// 1. access_control.js  — core permissions
// 2. subdivision_schedule_manager.js  — multi-scheduler state
// 3. rbac_visual_restrictions.js  — UI restrictions
// Dispatches 'rbac-system-ready' and 'campistry-rbac-ready' when done.
// ============================================================================

(function() {
    'use strict';

    console.log("🚀 RBAC Init v1.4 (SESSION CACHE) starting...");

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initializeRBAC() {
        try {
            // Step 1: Wait for and initialize AccessControl
            // (reads sessionStorage cache — should be near-instant)
            await initializeAccessControl();
            
            // Step 2: Initialize SubdivisionScheduleManager
            await initializeSubdivisionManager();
            
            // Step 3: Initialize Visual Restrictions
            await initializeVisualRestrictions();
            
            // Step 4: Apply initial restrictions
            applyInitialRestrictions();
            
            // Step 5: Logic-gate destructive action handlers
            installDestructiveActionGuards();
            
            // Build event detail once
            const eventDetail = {
                role: window.AccessControl?.getCurrentRole(),
                editableDivisions: window.AccessControl?.getEditableDivisions(),
                isOwner: window.AccessControl?.isOwner(),
                isAdmin: window.AccessControl?.isAdmin(),
                isScheduler: window.AccessControl?.isScheduler?.(),
                isViewer: window.AccessControl?.isViewer()
            };
            
            // Dispatch ready event (original)
            window.dispatchEvent(new CustomEvent('rbac-system-ready', {
                detail: eventDetail
            }));
            
            // Also dispatch campistry-rbac-ready — cloud_storage_bridge.js listens for this event
            window.dispatchEvent(new CustomEvent('campistry-rbac-ready', {
                detail: eventDetail
            }));
            
        } catch (error) {
            console.error("🚀 RBAC initialization error:", error);
            // Always dispatch the ready events even after a partial failure so that
            // ScheduleSync.initAfterRBAC() and PermissionsGuard don't hang forever
            // waiting for events that will never come.
            const fallbackDetail = {
                role: window.AccessControl?.getCurrentRole() || 'viewer',
                editableDivisions: window.AccessControl?.getEditableDivisions() || [],
                isOwner: window.AccessControl?.isOwner?.() || false,
                isAdmin: window.AccessControl?.isAdmin?.() || false,
                isScheduler: window.AccessControl?.isScheduler?.() || false,
                isViewer: true,
                initError: error.message
            };
            window.dispatchEvent(new CustomEvent('rbac-system-ready', { detail: fallbackDetail }));
            window.dispatchEvent(new CustomEvent('campistry-rbac-ready', { detail: fallbackDetail }));
        }
    }

   async function initializeAccessControl() {
        // Wait for AccessControl AND Supabase to be defined
        let attempts = 0;
        while ((!window.AccessControl || !window.supabase?.auth) && attempts < 100) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        if (!window.AccessControl) {
            console.error("🚀 AccessControl module not found");
            return;
        }

        // Initialize AccessControl
        await window.AccessControl.initialize();
        
    }

    async function initializeSubdivisionManager() {
        // Wait for SubdivisionScheduleManager
        let attempts = 0;
        while (!window.SubdivisionScheduleManager && attempts < 50) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        if (!window.SubdivisionScheduleManager) {
            console.warn("🚀 SubdivisionScheduleManager not found - skipping");
            return;
        }

        await window.SubdivisionScheduleManager.initialize();
        
    }

    async function initializeVisualRestrictions() {
        // Wait for VisualRestrictions/EditRestrictions
        let attempts = 0;
        while (!window.VisualRestrictions && !window.EditRestrictions && attempts < 50) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        const restrictionsModule = window.VisualRestrictions || window.EditRestrictions;
        
        if (!restrictionsModule) {
            console.warn("🚀 VisualRestrictions module not found - skipping");
            return;
        }

        await restrictionsModule.initialize();
        
    }

    // =========================================================================
    // APPLY INITIAL RESTRICTIONS
    // =========================================================================

    function applyInitialRestrictions() {
        const role = window.AccessControl?.getCurrentRole();
        
        // Apply restrictions based on role
        if (role === 'viewer') {
            applyViewerRestrictions();
        } else if (role === 'scheduler') {
            applySchedulerRestrictions();
        } else if (role === 'admin') {
            applyAdminRestrictions();
        }
        // Owner has no restrictions
        
        // Render access banner
        window.AccessControl?.renderAccessBanner();
    }

    function applyViewerRestrictions() {
        // Viewer input/button disabling is handled by rbac_visual_restrictions.js
        // (applyToActionButtons + applyToSetupPanel + tab-level handlers) which runs
        // on initial load AND on every MutationObserver tick for dynamic content.
        // A one-shot querySelector blast here would miss dynamically rendered elements.
        // Only handle the static structural elements that are guaranteed to exist at boot.
        const editButtons = document.querySelectorAll('[data-action="edit"], [data-action="delete"], [data-action="generate"]');
        editButtons.forEach(btn => {
            btn.dataset.rbacDisabled = 'true';
            btn.style.display = 'none';
        });
    }

    function applySchedulerRestrictions() {
        // Schedulers can edit their assigned divisions only
        // This is handled by EditRestrictions/VisualRestrictions modules
        
        // Hide owner-only elements
        const ownerElements = document.querySelectorAll('[data-owner-only], .owner-only');
        ownerElements.forEach(el => {
            el.style.display = 'none';
        });
        
        // Hide admin-only elements
        const adminElements = document.querySelectorAll('[data-admin-only], .admin-only');
        adminElements.forEach(el => {
            el.style.display = 'none';
        });
    }

    function applyAdminRestrictions() {
        // Admins can do everything except:
        // 1. Invite users
        // 2. Delete all camp data
        
        const eraseAllBtn = document.getElementById('eraseAllBtn');
        if (eraseAllBtn) {
            eraseAllBtn.disabled = true;
            eraseAllBtn.classList.add('rbac-btn-disabled');
            eraseAllBtn.title = 'Only the camp owner can erase all data';
        }
    }

    // =========================================================================
    // ★★★ V-004 FIX: LOGIC-GATE DESTRUCTIVE ACTIONS ★★★
    // Buttons hidden via CSS can be re-enabled in DevTools.
    // These capture-phase listeners re-verify permissions at execution time.
    // =========================================================================

    function installDestructiveActionGuards() {
        // Guard: Erase All Camp Data (owner-only)
        const eraseAllBtn = document.getElementById('eraseAllBtn');
        if (eraseAllBtn) {
            eraseAllBtn.addEventListener('click', (e) => {
                if (!window.AccessControl?.canEraseAllCampData()) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    window.AccessControl?.showPermissionDenied('erase all camp data');
                    console.warn('🛡️ Blocked: eraseAllBtn clicked without owner permission');
                }
            }, true); // capture phase — fires before existing handlers
        }

        // Guard: Erase Schedule Data (owner/admin)
        const eraseDataBtn = document.getElementById('eraseDataBtn') || document.getElementById('clearScheduleBtn');
        if (eraseDataBtn) {
            eraseDataBtn.addEventListener('click', (e) => {
                if (!window.AccessControl?.canEraseData()) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    window.AccessControl?.showPermissionDenied('erase schedule data');
                    console.warn('🛡️ Blocked: eraseDataBtn clicked without permission');
                }
            }, true);
        }

        // Guard: Invite Users (owner-only)
        const inviteBtn = document.getElementById('inviteUserBtn') || document.getElementById('inviteBtn');
        if (inviteBtn) {
            inviteBtn.addEventListener('click', (e) => {
                if (!window.AccessControl?.canInviteUsers()) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    window.AccessControl?.showPermissionDenied('invite users');
                    console.warn('🛡️ Blocked: inviteBtn clicked without owner permission');
                }
            }, true);
        }

        // Guard: Delete Camp Data (owner-only)
        const deleteCampBtn = document.getElementById('deleteCampBtn') || document.getElementById('deleteCampDataBtn');
        if (deleteCampBtn) {
            deleteCampBtn.addEventListener('click', (e) => {
                if (!window.AccessControl?.canDeleteCampData()) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    window.AccessControl?.showPermissionDenied('delete camp data');
                    console.warn('🛡️ Blocked: deleteCampBtn clicked without owner permission');
                }
            }, true);
        }

    }

    // =========================================================================
    // TAB CHANGE HANDLER
    // =========================================================================

    function setupTabChangeHandler() {
        function _patchShowTab() {
            const originalShowTab = window.showTab;
            if (typeof originalShowTab !== 'function') return false;
            // Don't double-patch
            if (originalShowTab._rbacPatched) return true;

            window.showTab = function(tabId) {
                const result = originalShowTab.apply(this, arguments);
                setTimeout(() => {
                    if (window.VisualRestrictions?.refresh) {
                        window.VisualRestrictions.refresh();
                    } else if (window.EditRestrictions?.refresh) {
                        window.EditRestrictions.refresh();
                    }
                    installDestructiveActionGuards();
                }, 100);
                return result;
            };
            window.showTab._rbacPatched = true;
            return true;
        }

        // Try immediately — works if showTab already defined
        if (!_patchShowTab()) {
            // showTab not ready yet — poll briefly until it appears
            let attempts = 0;
            const poll = setInterval(() => {
                if (_patchShowTab() || attempts++ > 30) clearInterval(poll);
            }, 100);
        }
    }

    // =========================================================================
    // AUTO-INITIALIZE
    // =========================================================================

    function autoInit() {
        // Wait for auth to be confirmed before initializing RBAC
        if (window.__CAMPISTRY_BOOTED__) {
            initializeRBAC();
            setupTabChangeHandler();
        } else {
            // Listen for boot event
            const checkBoot = setInterval(() => {
                if (window.__CAMPISTRY_BOOTED__) {
                    clearInterval(checkBoot);
                    initializeRBAC();
                    setupTabChangeHandler();
                }
            }, 100);
            
            // Timeout after 30 seconds
            setTimeout(() => clearInterval(checkBoot), 30000);
        }
    }

    // Start initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        // Small delay to ensure all modules are loaded
        setTimeout(autoInit, 200);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.RBACInit = {
        initialize: () => {
            initializeRBAC();
            setupTabChangeHandler();
        },
        applyRestrictions: applyInitialRestrictions,
        installDestructiveActionGuards,
        refresh: () => {
            applyInitialRestrictions();
            installDestructiveActionGuards();
            setupTabChangeHandler();
            window.VisualRestrictions?.refresh?.();
        }
    };

    console.log("🚀 RBAC Init v1.4 loaded");

})();
