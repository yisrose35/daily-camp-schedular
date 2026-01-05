// ============================================================================
// rbac_init.js — Master RBAC Initialization v1.0
// ============================================================================
// Initializes all RBAC modules in the correct order and handles dependencies
// 
// Load order:
// 1. access_control.js (core permissions)
// 2. subdivision_schedule_manager.js (multi-scheduler state)
// 3. scheduler_subdivision_integration.js (scheduler hooks)
// 4. rbac_visual_restrictions.js (UI restrictions)
// ============================================================================

(function() {
    'use strict';

    console.log("🚀 RBAC Init v1.0 starting...");

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initializeRBAC() {
        console.log("🚀 Initializing RBAC system...");

        try {
            // Step 1: Wait for and initialize AccessControl
            await initializeAccessControl();
            
            // Step 2: Initialize SubdivisionScheduleManager
            await initializeSubdivisionManager();
            
            // Step 3: Initialize Visual Restrictions
            await initializeVisualRestrictions();
            
            // Step 4: Apply initial restrictions
            applyInitialRestrictions();
            
            console.log("🚀 RBAC system fully initialized");
            
            // Dispatch ready event
            window.dispatchEvent(new CustomEvent('rbac-system-ready', {
                detail: {
                    role: window.AccessControl?.getCurrentRole(),
                    editableDivisions: window.AccessControl?.getEditableDivisions(),
                    isOwner: window.AccessControl?.isOwner(),
                    isAdmin: window.AccessControl?.isAdmin(),
                    isScheduler: window.AccessControl?.isScheduler?.(),
                    isViewer: window.AccessControl?.isViewer()
                }
            }));
            
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
        
        // Disable all edit buttons except Print Center and Camper Locator
        const editButtons = document.querySelectorAll(
            '#addDivisionBtn, #addBunkBtn, #generate-btn, #clear-btn, ' +
            '#eraseTodayBtn, #eraseAllSchedulesBtn, #eraseHistoryBtn, #eraseAllBtn, ' +
            '[data-action="edit"], [data-action="delete"], [data-action="add"]'
        );
        
        editButtons.forEach(btn => {
            btn.disabled = true;
            btn.classList.add('rbac-btn-disabled');
            btn.title = 'View only mode';
        });
        
        // Disable all inputs except search fields
        const inputs = document.querySelectorAll(
            'input:not([type="search"]):not(.camper-search):not(.print-search), ' +
            'select, textarea'
        );
        
        inputs.forEach(input => {
            if (!input.closest('#camper-locator') && !input.closest('#print')) {
                input.disabled = true;
                input.classList.add('rbac-input-disabled');
            }
        });
    }

    function applySchedulerRestrictions() {
        console.log("🚀 Applying scheduler restrictions...");
        
        const editableDivisions = window.AccessControl?.getEditableDivisions() || [];
        
        // Disable camp-wide data erasure
        const eraseButtons = document.querySelectorAll(
            '#eraseAllSchedulesBtn, #eraseHistoryBtn, #eraseAllBtn'
        );
        
        eraseButtons.forEach(btn => {
            btn.disabled = true;
            btn.classList.add('rbac-btn-disabled');
            btn.title = 'Only owners can erase camp-wide data';
        });
        
        // Disable add division (scheduler can only manage their assigned divisions)
        const addDivisionBtn = document.getElementById('addDivisionBtn');
        const divisionInput = document.getElementById('divisionInput');
        
        if (addDivisionBtn) {
            addDivisionBtn.disabled = true;
            addDivisionBtn.title = 'Only owner/admin can add divisions';
        }
        
        if (divisionInput) {
            divisionInput.disabled = true;
            divisionInput.placeholder = 'Contact owner to add divisions';
        }
        
        // If no divisions assigned, disable generate
        if (editableDivisions.length === 0) {
            const generateBtns = document.querySelectorAll('#generate-btn, [data-action="generate"]');
            generateBtns.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('rbac-btn-disabled');
                btn.title = 'No divisions assigned - contact owner';
            });
        }
    }

    function applyAdminRestrictions() {
        console.log("🚀 Applying admin restrictions...");
        
        // Admin can do almost everything except:
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
        refresh: () => {
            applyInitialRestrictions();
            window.VisualRestrictions?.refresh?.();
        }
    };

    console.log("🚀 RBAC Init loaded");

})();
