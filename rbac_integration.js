// ============================================================================
// rbac_integration.js — Integrates RBAC into Existing Scheduler
// ============================================================================
// Hooks into existing scheduler code to:
// - Replace Generate button with division selector
// - Pass existing locks to scheduler core
// - Save locks after generation
// - Apply edit restrictions
// ============================================================================

(function() {
    'use strict';

    console.log("🔗 RBAC Integration v1.0 loading...");

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        console.log("🔗 Initializing RBAC integration...");

        // Wait for all required modules
        await waitForModules([
            'AccessControl',
            'DivisionSelector', 
            'EditRestrictions'
        ]);

        // Initialize access control first
        await window.AccessControl.initialize();

        // Initialize division selector with today's date
        const today = new Date().toISOString().split('T')[0];
        await window.DivisionSelector.initialize(today);

        // Initialize edit restrictions
        await window.EditRestrictions.initialize();

        // Hook into Generate button
        hookGenerateButton();

        // Hook into date changes
        hookDateChanges();

        // Hook into scheduler core
        hookSchedulerCore();

        console.log("🔗 RBAC Integration complete");
    }

    async function waitForModules(modules) {
        const maxWait = 10000;
        const start = Date.now();

        for (const module of modules) {
            while (!window[module] && (Date.now() - start) < maxWait) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (!window[module]) {
                console.warn(`🔗 Module ${module} not found after ${maxWait}ms`);
            }
        }
    }

    // =========================================================================
    // GENERATE BUTTON HOOK
    // =========================================================================

    function hookGenerateButton() {
        // Find all possible generate buttons
        const selectors = [
            '#generate-btn',
            '#generateBtn', 
            '[data-action="generate"]',
            '.generate-button',
            'button[onclick*="generate"]'
        ];

        let generateBtn = null;
        for (const selector of selectors) {
            generateBtn = document.querySelector(selector);
            if (generateBtn) break;
        }

        if (!generateBtn) {
            console.log("🔗 Generate button not found, will retry on DOM changes");
            setupButtonObserver();
            return;
        }

        // Store original handler
        const originalOnClick = generateBtn.onclick;
        const originalHandler = generateBtn.getAttribute('onclick');

        // Replace click handler
        generateBtn.onclick = null;
        generateBtn.removeAttribute('onclick');
        
        generateBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Check if user can generate anything
            if (!window.AccessControl.canEditAnything()) {
                window.EditRestrictions.showAccessDeniedToast('any division');
                return;
            }

            // Show division selector
            window.DivisionSelector.renderDivisionSelector(
                // On confirm
                async (selection) => {
                    console.log("🔗 Generation requested:", selection);
                    await handleGeneration(selection, originalOnClick, originalHandler);
                },
                // On cancel
                () => {
                    console.log("🔗 Generation cancelled");
                }
            );
        });

        console.log("🔗 Generate button hooked");
    }

    function setupButtonObserver() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    const btn = document.querySelector('#generate-btn, [data-action="generate"]');
                    if (btn && !btn._rbacHooked) {
                        btn._rbacHooked = true;
                        hookGenerateButton();
                        observer.disconnect();
                        break;
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // =========================================================================
    // GENERATION HANDLER
    // =========================================================================

    async function handleGeneration(selection, originalOnClick, originalHandler) {
        // ★★★ SECURITY: Re-verify role from DB before generation ★★★
        if (window.AccessControl?.verifyBeforeWrite) {
            const allowed = await window.AccessControl.verifyBeforeWrite('generate schedule');
            if (!allowed) {
                console.warn("🔗 Generation BLOCKED by verifyBeforeWrite");
                if (typeof window.showToast === 'function') {
                    window.showToast('You don\'t have permission to generate schedules', 'error');
                }
                return;
            }
        }

        const { divisions, clearExisting, existingLocks, previouslyGenerated } = selection;

        console.log("🔗 Starting generation for:", divisions);

        // Set global state for scheduler to read
        window._rbacGenerationConfig = {
            divisionsToGenerate: divisions,
            existingLocks: existingLocks,
            previouslyGenerated: previouslyGenerated,
            clearExisting: clearExisting
        };

        // Store divisions filter globally (for scheduler_core_main to read)
        window.selectedDivisionsForGeneration = divisions;
        window.existingFieldLocks = existingLocks;

        try {
            // Call original generation logic
            if (typeof window.generateSchedule === 'function') {
                await window.generateSchedule();
            } else if (typeof window.handleGenerate === 'function') {
                await window.handleGenerate();
            } else if (originalOnClick) {
                await originalOnClick();
            } else if (originalHandler) {
                eval(originalHandler);
            } else {
                console.error("🔗 No generation function found!");
                return;
            }

            // After generation, save the new locks
            await saveGenerationLocks(divisions);

            console.log("🔗 Generation complete");

        } catch (e) {
            console.error("🔗 Generation error:", e);
        } finally {
            // Clean up
            delete window._rbacGenerationConfig;
            delete window.selectedDivisionsForGeneration;
        }
    }

    async function saveGenerationLocks(generatedDivisions) {
        // Collect field locks from GlobalFieldLocks
        if (!window.GlobalFieldLocks) {
            console.warn("🔗 GlobalFieldLocks not found");
            return;
        }

        const locks = {};
        
        // Convert GlobalFieldLocks to serializable format
        for (const [key, value] of Object.entries(window.GlobalFieldLocks)) {
            if (value && typeof value === 'object') {
                locks[key] = Array.isArray(value) ? value : Object.keys(value);
            } else {
                locks[key] = value;
            }
        }

        // Save to database
        await window.DivisionSelector.saveLocks(locks, generatedDivisions);
    }

    // =========================================================================
    // DATE CHANGE HOOK
    // =========================================================================

    function hookDateChanges() {
        // Listen for date picker changes
        const dateInputs = document.querySelectorAll('input[type="date"], #schedule-date, #dateInput');
        
        dateInputs.forEach(input => {
            input.addEventListener('change', async (e) => {
                const newDate = e.target.value;
                if (newDate) {
                    console.log("🔗 Date changed to:", newDate);
                    await window.DivisionSelector.initialize(newDate);
                    window.EditRestrictions.refresh();
                }
            });
        });

        // Also hook into any custom date navigation
        if (typeof window.navigateToDate === 'function') {
            const original = window.navigateToDate;
            window.navigateToDate = async function(date) {
                const result = original.apply(this, arguments);
                await window.DivisionSelector.initialize(date);
                window.EditRestrictions.refresh();
                return result;
            };
        }
    }

    // =========================================================================
    // SCHEDULER CORE HOOKS
    // =========================================================================

    function hookSchedulerCore() {
        // Hook into division iteration in scheduler
        if (typeof window.getActiveDivisions === 'function') {
            const original = window.getActiveDivisions;
            window.getActiveDivisions = function() {
                const allDivisions = original.apply(this, arguments);
                
                // Filter by selected divisions if generation is in progress
                if (window.selectedDivisionsForGeneration) {
                    return allDivisions.filter(d => 
                        window.selectedDivisionsForGeneration.includes(d.name || d)
                    );
                }
                
                return allDivisions;
            };
        }

        // Hook into field availability checking
        if (typeof window.isFieldAvailable === 'function') {
            const original = window.isFieldAvailable;
            window.isFieldAvailable = function(field, timeSlot) {
                // First check existing locks
                if (window.existingFieldLocks) {
                    const fieldKey = typeof field === 'string' ? field : field.name;
                    const locks = window.existingFieldLocks[fieldKey];
                    if (locks && locks.includes(timeSlot)) {
                        return false; // Field is locked by previous generation
                    }
                }
                
                return original.apply(this, arguments);
            };
        }

        // Hook into activity assignment to respect locks
        hookActivityAssignment();
    }

    function hookActivityAssignment() {
        // If there's a function that assigns activities to fields
        const assignFunctions = [
            'assignActivityToField',
            'scheduleActivity',
            'placeActivity'
        ];

        for (const funcName of assignFunctions) {
            if (typeof window[funcName] === 'function') {
                const original = window[funcName];
                window[funcName] = function(activity, field, timeSlot) {
                    // Check if field is locked
                    if (window.existingFieldLocks) {
                        const fieldKey = typeof field === 'string' ? field : field.name;
                        const locks = window.existingFieldLocks[fieldKey];
                        if (locks && locks.includes(timeSlot)) {
                            console.log(`🔗 Field ${fieldKey} is locked at ${timeSlot}, skipping`);
                            return false;
                        }
                    }
                    
                    return original.apply(this, arguments);
                };
            }
        }
    }

    // =========================================================================
    // DASHBOARD INTEGRATION
    // =========================================================================

    function renderDashboardSections() {
        // Find or create containers for team and subdivisions
        const dashboard = document.getElementById('dashboard-content') || 
                         document.querySelector('.dashboard-grid') ||
                         document.querySelector('main');
        
        if (!dashboard) {
            console.log("🔗 Dashboard container not found");
            return;
        }

        // Only show team management for owners
        if (window.AccessControl?.getCurrentRole() === 'owner') {
            // Create subdivisions card
            let subdivisionsCard = document.getElementById('subdivisions-card');
            if (!subdivisionsCard) {
                subdivisionsCard = document.createElement('div');
                subdivisionsCard.id = 'subdivisions-card';
                subdivisionsCard.className = 'dashboard-card';
                dashboard.appendChild(subdivisionsCard);
            }
            
            // Create team card
            let teamCard = document.getElementById('team-card');
            if (!teamCard) {
                teamCard = document.createElement('div');
                teamCard.id = 'team-card';
                teamCard.className = 'dashboard-card';
                dashboard.appendChild(teamCard);
            }

            // Render UI if TeamSubdivisionsUI is available
            if (window.TeamSubdivisionsUI) {
                window.TeamSubdivisionsUI.initialize().then(() => {
                    window.TeamSubdivisionsUI.renderSubdivisionsCard(subdivisionsCard);
                    window.TeamSubdivisionsUI.renderTeamCard(teamCard);
                });
            }
        }
    }

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================

    /**
     * Check if current user can perform an action on a division
     */
    function canEditDivision(divisionName) {
        return window.AccessControl?.canEditDivision(divisionName) ?? true;
    }

    /**
     * Get role-based UI configuration
     */
    function getUIConfig() {
        const role = window.AccessControl?.getCurrentRole() || 'viewer';
        
        return {
            showGenerateButton: role !== 'viewer',
            showClearButton: role !== 'viewer',
            showEditButtons: role !== 'viewer',
            showTeamSection: role === 'owner',
            showSubdivisionsSection: role === 'owner' || role === 'admin',
            canDragDrop: role !== 'viewer',
            canInlineEdit: role !== 'viewer'
        };
    }

    /**
     * Apply UI config to page elements
     */
    function applyUIConfig() {
        const config = getUIConfig();

        // Hide/show generate button
        const generateBtn = document.querySelector('#generate-btn, [data-action="generate"]');
        if (generateBtn && !config.showGenerateButton) {
            generateBtn.style.display = 'none';
        }

        // Hide/show clear button  
        const clearBtn = document.querySelector('#clear-btn, [data-action="clear"]');
        if (clearBtn && !config.showClearButton) {
            clearBtn.style.display = 'none';
        }

        // Disable drag-drop if needed
        if (!config.canDragDrop) {
            document.querySelectorAll('[draggable="true"]').forEach(el => {
                el.draggable = false;
            });
        }
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const RBACIntegration = {
        initialize,
        canEditDivision,
        getUIConfig,
        applyUIConfig,
        renderDashboardSections,
        saveGenerationLocks
    };

    window.RBACIntegration = RBACIntegration;

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initialize, 500);
        });
    } else {
        setTimeout(initialize, 500);
    }

    console.log("🔗 RBAC Integration loaded");

})();
