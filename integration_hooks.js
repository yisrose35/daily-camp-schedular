// =============================================================================
// integration_hooks.js v5.0 — CAMPISTRY SCHEDULER INTEGRATION
// =============================================================================
//
// This file connects the new Supabase system to your existing scheduler.
//
// HOW TO USE:
// 1. Include all 4 supabase_*.js files in your HTML
// 2. Include this file AFTER them
// 3. Your existing scheduler will automatically use the new system
//
// REPLACES: The integration code scattered across your existing files
//
// =============================================================================

(function() {
    'use strict';

    console.log('🔗 Campistry Integration Hooks v5.0 loading...');

    // =========================================================================
    // WAIT FOR ALL SYSTEMS TO BE READY
    // =========================================================================

    async function waitForSystems() {
        // Wait for CampistryDB
        if (window.CampistryDB?.ready) {
            await window.CampistryDB.ready;
        }

        // Wait a bit for other modules
        await new Promise(r => setTimeout(r, 200));

        console.log('🔗 All systems ready, installing hooks...');
        installHooks();
    }

    // =========================================================================
    // HOOK: AUTO-SUBSCRIBE ON DATE CHANGE
    // =========================================================================

    function hookDatePicker() {
        // Find date picker element
        const datePicker = document.getElementById('schedule-date-input');
        if (!datePicker) {
            console.log('🔗 Date picker not found, will retry...');
            setTimeout(hookDatePicker, 1000);
            return;
        }

        // Store original handler if any
        const originalOnChange = datePicker.onchange;

        datePicker.addEventListener('change', async (e) => {
            const dateKey = e.target.value;
            if (!dateKey) return;

            console.log('🔗 Date changed to:', dateKey);

            // Update global
            window.currentScheduleDate = dateKey;

            // Subscribe to realtime for this date
            if (window.ScheduleSync?.subscribe) {
                await window.ScheduleSync.subscribe(dateKey);
            }

            // Load schedule for this date
            if (window.ScheduleDB?.loadSchedule) {
                const result = await window.ScheduleDB.loadSchedule(dateKey);
                
                if (result?.success && result.data) {
                    // Update globals
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                    
                    if (result.data.unifiedTimes?.length > 0) {
                        window.unifiedTimes = result.data.unifiedTimes;
                    }

                    // Trigger UI refresh
                    if (window.updateTable) {
                        window.updateTable();
                    }

                    console.log('🔗 Loaded schedule for', dateKey, {
                        bunks: Object.keys(window.scheduleAssignments).length,
                        source: result.source
                    });
                }
            }
        });

        console.log('🔗 Date picker hook installed');
    }

    // =========================================================================
    // HOOK: AUTO-SAVE ON SCHEDULE CHANGES
    // =========================================================================

    function hookScheduleSave() {
        // Intercept saveCurrentDailyData if it exists
        if (window.saveCurrentDailyData) {
            const originalSave = window.saveCurrentDailyData;

            window.saveCurrentDailyData = function(dateKey) {
                // Call original for local storage
                originalSave.call(this, dateKey);

                // Queue cloud save
                const data = {
                    scheduleAssignments: window.scheduleAssignments || {},
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    isRainyDay: window.isRainyDay || false
                };

                if (window.ScheduleSync?.queueSave) {
                    window.ScheduleSync.queueSave(dateKey, data);
                }
            };

            console.log('🔗 Save hook installed (saveCurrentDailyData)');
        }

        // Also hook saveScheduleAssignments if it exists
        if (window.saveScheduleAssignments) {
            const originalSaveAssign = window.saveScheduleAssignments;

            window.saveScheduleAssignments = function(dateKey, assignments) {
                // Call original
                originalSaveAssign.call(this, dateKey, assignments);

                // Queue cloud save
                const data = {
                    scheduleAssignments: assignments || window.scheduleAssignments || {},
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes || [],
                    isRainyDay: window.isRainyDay || false
                };

                if (window.ScheduleSync?.queueSave) {
                    window.ScheduleSync.queueSave(dateKey, data);
                }
            };

            console.log('🔗 Save hook installed (saveScheduleAssignments)');
        }
    }

    // =========================================================================
    // HOOK: AUTO-SAVE AFTER GENERATION
    // =========================================================================

    function hookGeneration() {
        // Listen for generation complete event
        window.addEventListener('campistry-generation-complete', (e) => {
            const dateKey = e.detail?.dateKey || window.currentScheduleDate;
            if (!dateKey) return;

            console.log('🔗 Generation complete for', dateKey, '- triggering save');

            const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                isRainyDay: window.isRainyDay || false
            };

            if (window.ScheduleSync?.queueSave) {
                window.ScheduleSync.queueSave(dateKey, data);
            }
        });

        // Also intercept generateSchedule if it exists
        if (window.generateSchedule) {
            const originalGenerate = window.generateSchedule;

            window.generateSchedule = async function(dateKey, ...args) {
                // Call original
                const result = await originalGenerate.call(this, dateKey, ...args);

                // Dispatch event for our hook
                window.dispatchEvent(new CustomEvent('campistry-generation-complete', {
                    detail: { dateKey }
                }));

                return result;
            };

            console.log('🔗 Generation hook installed');
        }
    }

    // =========================================================================
    // HOOK: HANDLE REMOTE CHANGES
    // =========================================================================

    function hookRemoteChanges() {
        if (!window.ScheduleSync?.onRemoteChange) {
            console.log('🔗 ScheduleSync not ready for remote hooks');
            return;
        }

        window.ScheduleSync.onRemoteChange((change) => {
            console.log('🔗 Remote change received:', change.type, 'from', change.scheduler);

            // Reload and merge
            if (window.ScheduleDB?.loadSchedule && change.dateKey) {
                window.ScheduleDB.loadSchedule(change.dateKey).then(result => {
                    if (result?.success && result.data) {
                        // Merge with existing data (preserve our local changes)
                        const myAssignments = window.PermissionsDB?.filterToMyDivisions?.(window.scheduleAssignments) || {};
                        
                        // Remote data for bunks we don't own
                        const remoteAssignments = result.data.scheduleAssignments || {};
                        
                        // Merge: our bunks + remote bunks
                        window.scheduleAssignments = {
                            ...remoteAssignments,
                            ...myAssignments
                        };

                        window.leagueAssignments = result.data.leagueAssignments || window.leagueAssignments;

                        // Refresh UI
                        if (window.updateTable) {
                            window.updateTable();
                        }

                        console.log('🔗 Merged remote changes');
                    }
                });
            }
        });

        console.log('🔗 Remote change hook installed');
    }

    // =========================================================================
    // HOOK: BLOCKED CELL RENDERING
    // =========================================================================

    function hookBlockedCells() {
        // Intercept updateTable to add blocked cell styling
        if (window.updateTable) {
            const originalUpdate = window.updateTable;

            window.updateTable = function(...args) {
                // Call original
                originalUpdate.apply(this, args);

                // Add blocked cell styling
                applyBlockedCellStyles();
            };

            console.log('🔗 Blocked cell hook installed');
        }
    }

    function applyBlockedCellStyles() {
        if (!window.PermissionsDB?.hasFullAccess || window.PermissionsDB.hasFullAccess()) {
            return; // Owners see everything editable
        }

        const editableBunks = new Set(window.PermissionsDB?.getEditableBunks?.() || []);

        // Find all schedule cells
        document.querySelectorAll('[data-bunk-id]').forEach(cell => {
            const bunkId = cell.dataset.bunkId;
            
            if (!editableBunks.has(String(bunkId))) {
                cell.classList.add('blocked-by-other');
                cell.style.pointerEvents = 'none';
                cell.title = 'Managed by another scheduler';
            } else {
                cell.classList.remove('blocked-by-other');
                cell.style.pointerEvents = '';
                cell.title = '';
            }
        });
    }

    // Add styles for blocked cells
    function addBlockedCellStyles() {
        if (document.getElementById('campistry-blocked-styles')) return;

        const style = document.createElement('style');
        style.id = 'campistry-blocked-styles';
        style.textContent = `
            .blocked-by-other {
                position: relative !important;
                background: repeating-linear-gradient(
                    45deg,
                    rgba(239, 68, 68, 0.05),
                    rgba(239, 68, 68, 0.05) 5px,
                    rgba(239, 68, 68, 0.1) 5px,
                    rgba(239, 68, 68, 0.1) 10px
                ) !important;
                opacity: 0.7;
            }
            
            .blocked-by-other::after {
                content: '🔒';
                position: absolute;
                top: 2px;
                right: 4px;
                font-size: 10px;
                opacity: 0.5;
            }
        `;
        document.head.appendChild(style);
    }

    // =========================================================================
    // HOOK: ERASE FUNCTIONS
    // =========================================================================

    function hookEraseFunctions() {
        // Hook eraseToday / eraseTodaysSchedule
        if (window.eraseTodaysSchedule) {
            const originalErase = window.eraseTodaysSchedule;

            window.eraseTodaysSchedule = async function(dateKey) {
                dateKey = dateKey || window.currentScheduleDate;
                
                if (!dateKey) {
                    alert('No date selected');
                    return;
                }

                // Check permissions
                const hasFullAccess = window.PermissionsDB?.hasFullAccess?.() || false;
                
                if (hasFullAccess) {
                    // Owners can delete all
                    if (!confirm(`Delete ALL schedules for ${dateKey}?\n\nThis will delete data from all schedulers.`)) {
                        return;
                    }
                    await window.ScheduleDB?.deleteSchedule?.(dateKey);
                } else {
                    // Schedulers only delete their own
                    if (!confirm(`Delete YOUR schedule for ${dateKey}?\n\nOther schedulers' data will be preserved.`)) {
                        return;
                    }
                    await window.ScheduleDB?.deleteMyScheduleOnly?.(dateKey);
                }

                // Clear local state
                window.scheduleAssignments = {};
                window.leagueAssignments = {};

                // Reload merged data
                const result = await window.ScheduleDB?.loadSchedule?.(dateKey);
                if (result?.success && result.data) {
                    window.scheduleAssignments = result.data.scheduleAssignments || {};
                    window.leagueAssignments = result.data.leagueAssignments || {};
                }

                // Refresh UI
                if (window.updateTable) {
                    window.updateTable();
                }

                console.log('🔗 Erase complete for', dateKey);
            };

            console.log('🔗 Erase hook installed');
        }
    }

    // =========================================================================
    // INSTALL ALL HOOKS
    // =========================================================================

    function installHooks() {
        addBlockedCellStyles();
        hookDatePicker();
        hookScheduleSave();
        hookGeneration();
        hookRemoteChanges();
        hookBlockedCells();
        hookEraseFunctions();

        // Expose helper functions globally
        window.scheduleCloudSync = function() {
            const dateKey = window.currentScheduleDate;
            if (!dateKey) return;

            const data = {
                scheduleAssignments: window.scheduleAssignments || {},
                leagueAssignments: window.leagueAssignments || {},
                unifiedTimes: window.unifiedTimes || [],
                isRainyDay: window.isRainyDay || false
            };

            if (window.ScheduleSync?.queueSave) {
                window.ScheduleSync.queueSave(dateKey, data);
            }
        };

        window.forceCloudSync = async function() {
            return await window.ScheduleSync?.forceSync?.();
        };

        console.log('🔗 All hooks installed!');

        // Dispatch ready event
        window.dispatchEvent(new CustomEvent('campistry-integration-ready'));

        // Auto-subscribe to current date if one is set
        const currentDate = window.currentScheduleDate || document.getElementById('schedule-date-input')?.value;
        if (currentDate && window.ScheduleSync?.subscribe) {
            console.log('🔗 Auto-subscribing to current date:', currentDate);
            window.ScheduleSync.subscribe(currentDate);
        }
    }

    // =========================================================================
    // BACKWARD COMPATIBILITY LAYER
    // =========================================================================

    // Expose functions that old code might be calling
    window.saveGlobalSettings = async function(key, data) {
        // For daily_schedules, route to new system
        if (key === 'daily_schedules') {
            const dateKey = Object.keys(data)[0];
            if (dateKey && data[dateKey]) {
                return await window.ScheduleDB?.saveSchedule?.(dateKey, data[dateKey]);
            }
        }
        
        // For other settings, use camp_state
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        
        if (!client || !campId) return false;

        try {
            const { data: current } = await client
                .from('camp_state')
                .select('*')
                .eq('camp_id', campId)
                .single();

            const newState = { ...(current?.state || {}), [key]: data };

            await client
                .from('camp_state')
                .upsert({
                    camp_id: campId,
                    state: newState,
                    updated_at: new Date().toISOString()
                });

            return true;
        } catch (e) {
            console.error('saveGlobalSettings error:', e);
            return false;
        }
    };

    window.loadGlobalSettings = async function(key) {
        const client = window.CampistryDB?.getClient?.();
        const campId = window.CampistryDB?.getCampId?.();
        
        if (!client || !campId) {
            // Fallback to localStorage
            const raw = localStorage.getItem('campGlobalSettings_v1');
            if (raw) {
                const data = JSON.parse(raw);
                return key ? data[key] : data;
            }
            return key ? {} : {};
        }

        try {
            const { data } = await client
                .from('camp_state')
                .select('*')
                .eq('camp_id', campId)
                .single();

            if (key) {
                return data?.state?.[key] || data?.[key] || {};
            }
            return data?.state || data || {};
        } catch (e) {
            console.error('loadGlobalSettings error:', e);
            return key ? {} : {};
        }
    };

    // =========================================================================
    // START
    // =========================================================================

    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForSystems);
    } else {
        setTimeout(waitForSystems, 300);
    }

})();
