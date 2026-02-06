// ============================================================================
// rbac_init.js — Master RBAC Initialization v1.4 (SESSION CACHE)
// ============================================================================
// Initializes all RBAC modules in the correct order and handles dependencies
// 
// v1.4: Removed loading screen manipulation — AccessControl now reads from
//        sessionStorage cache (written by dashboard.js), making init near-instant.
//        No more white screen gap between auth and RBAC.
// v1.2 SECURITY PATCHES:
//   - V-001 FIX: Hide app shell during init to prevent flash of unauthorized content
//   - V-004 FIX: Logic-gate destructive actions at handler level (not just CSS)
//
// v1.1 FIX: Added 'campistry-rbac-ready' event dispatch for cloud_storage_bridge
//           Previously only dispatched 'rbac-system-ready' which cloud bridge
//           doesn't listen for, causing schedule merge to never complete.
//
// Load order:
// 1. access_control.js (core permissions)
// 2. subdivision_schedule_manager.js (multi-scheduler state)
// 3. scheduler_subdivision_integration.js (scheduler hooks)
// 4. rbac_visual_restrictions.js (UI restrictions)
// ============================================================================

(function() {
    'use strict';

    console.log("🚀 RBAC Init v1.4 (SESSION CACHE) starting...");

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initializeRBAC() {
        console.log("🚀 Initializing RBAC system...");

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
            
            console.log("🚀 RBAC system fully initialized");
            
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
            
            // ★★★ v1.1 FIX: Also dispatch campistry-rbac-ready ★★★
            // cloud_storage_bridge.js listens for this event to re-merge
            // with correct permissions after conservative initial merge
            window.dispatchEvent(new CustomEvent('campistry-rbac-ready', {
                detail: eventDetail
            }));
            
            console.log("🚀 Dispatched both rbac-system-ready and campistry-rbac-ready events");
            
        } catch (error) {
            console.error("🚀 RBAC initialization error:", error);
        }
    }

    async function initializeAccessControl() {
        // Wait for AccessControl to be defined
        let attempts = 0;
        while (!window.AccessControl && attempts < 100) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        if (!window.AccessControl) {
            console.error("🚀 AccessControl module not found");
            return;
        }

        // Initialize AccessControl
        await window.AccessControl.initialize();
        
        console.log("🚀 AccessControl initialized:", {
            role: window.AccessControl.getCurrentRole(),
            isInitialized: window.AccessControl.isInitialized
        });
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
        
        console.log("🚀 SubdivisionScheduleManager initialized:", {
            isInitialized: window.SubdivisionScheduleManager.isInitialized
        });
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
        
        console.log("🚀 VisualRestrictions initialized");
    }

    // =========================================================================
    // APPLY INITIAL RESTRICTIONS
    // =========================================================================

    function applyInitialRestrictions() {
        const role = window.AccessControl?.getCurrentRole();
        
        console.log("🚀 Applying restrictions for role:", role);
        
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
        console.log("🚀 Applying viewer restrictions...");
        
        // Viewers can only view, not edit
        // Hide all edit buttons
        const editButtons = document.querySelectorAll('[data-action="edit"], [data-action="delete"], [data-action="generate"]');
        editButtons.forEach(btn => {
            btn.style.display = 'none';
        });
        
        // Disable all inputs
        const inputs = document.querySelectorAll('input:not([type="search"]), select, textarea');
        inputs.forEach(input => {
            if (!input.closest('.search-container') && !input.closest('.filter-container')) {
                input.disabled = true;
            }
        });
    }

    function applySchedulerRestrictions() {
        console.log("🚀 Applying scheduler restrictions...");
        
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
        console.log("🚀 Applying admin restrictions...");
        
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
        console.log("🚀 Installing destructive action guards...");

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

        console.log("🚀 Destructive action guards installed");
    }

    // =========================================================================
    // TAB CHANGE HANDLER
    // =========================================================================

    function setupTabChangeHandler() {
        // Re-apply restrictions when tab changes
        const originalShowTab = window.showTab;
        
        if (typeof originalShowTab === 'function') {
            window.showTab = function(tabId) {
                const result = originalShowTab.apply(this, arguments);
                
                // Reapply restrictions after tab content loads
                setTimeout(() => {
                    if (window.VisualRestrictions?.refresh) {
                        window.VisualRestrictions.refresh();
                    } else if (window.EditRestrictions?.refresh) {
                        window.EditRestrictions.refresh();
                    }
                    // Re-install guards for newly rendered buttons
                    installDestructiveActionGuards();
                }, 100);
                
                return result;
            };
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
        initialize: initializeRBAC,
        applyRestrictions: applyInitialRestrictions,
        installDestructiveActionGuards,
        refresh: () => {
            applyInitialRestrictions();
            installDestructiveActionGuards();
            window.VisualRestrictions?.refresh?.();
        }
    };

    console.log("🚀 RBAC Init v1.4 loaded");

})();
