// =============================================================================
// schedule_autoloader.js — Ensures Daily Schedules Load on Page Navigation
// =============================================================================
//
// FIXES: "No daily schedule structure found for this date" after generation
//
// PROBLEM: The schedule is saved to `daily_schedules` table but not auto-loaded
//          when navigating to view it. The date picker hook only fires on CHANGE,
//          not on initial page load.
//
// SOLUTION: This file auto-loads the schedule for the current date on:
//           1. Page load (if a date is already set)
//           2. Tab navigation (Scheduler tab, Daily Adjustments, etc.)
//           3. Cloud hydration completion
//
// INCLUDE: After integration_hooks.js and supabase_schedules.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('📅 Schedule Auto-Loader v1.0 loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    const CONFIG = {
        DEBUG: true,
        RETRY_DELAY_MS: 500,
        MAX_RETRIES: 10,
        LOCAL_STORAGE_KEY: 'campDailyData_v1'
    };

    // =========================================================================
    // STATE
    // =========================================================================

    let _isLoading = false;
    let _lastLoadedDate = null;
    let _retryCount = 0;

    // =========================================================================
    // LOGGING
    // =========================================================================

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('📅 [AutoLoader]', ...args);
        }
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    function getCurrentDateKey() {
        // Try multiple sources for the current date
        return window.currentScheduleDate || 
               document.getElementById('schedule-date-input')?.value ||
               document.getElementById('datepicker')?.value ||
               new Date().toISOString().split('T')[0];
    }

    function isSchedulerTabActive() {
        // Check if we're on the Scheduler or Daily Adjustments tab
        const schedulerTab = document.getElementById('scheduler-tab');
        const dailyTab = document.getElementById('daily-adjustments-tab');
        const viewTab = document.getElementById('view-schedule-tab');
        
        return (schedulerTab && schedulerTab.classList.contains('active')) ||
               (dailyTab && dailyTab.classList.contains('active')) ||
               (viewTab && viewTab.classList.contains('active')) ||
               document.querySelector('.schedule-grid') !== null ||
               document.querySelector('#schedule-table') !== null;
    }

    // =========================================================================
    // LOAD FROM LOCALSTORAGE (IMMEDIATE)
    // =========================================================================

    function loadFromLocalStorage(dateKey) {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            if (!raw) return null;
            
            const allData = JSON.parse(raw);
            return allData[dateKey] || null;
        } catch (e) {
            log('Failed to load from localStorage:', e);
            return null;
        }
    }

    function hydrateWindowFromLocal(dateKey) {
        const data = loadFromLocalStorage(dateKey);
        
        if (!data) {
            log('No local data for', dateKey);
            return false;
        }

        log('Hydrating from localStorage for', dateKey);

        // Hydrate window globals
        if (data.scheduleAssignments && Object.keys(data.scheduleAssignments).length > 0) {
            window.scheduleAssignments = data.scheduleAssignments;
            log('  ✓ scheduleAssignments:', Object.keys(data.scheduleAssignments).length, 'bunks');
        }

        if (data.leagueAssignments) {
            window.leagueAssignments = data.leagueAssignments;
            log('  ✓ leagueAssignments');
        }

        if (data.unifiedTimes && Array.isArray(data.unifiedTimes) && data.unifiedTimes.length > 0) {
            // Normalize unifiedTimes
            window.unifiedTimes = data.unifiedTimes.map(t => {
                const startDate = t.start instanceof Date ? t.start : new Date(t.start);
                const endDate = t.end instanceof Date ? t.end : new Date(t.end);
                return {
                    start: startDate,
                    end: endDate,
                    startMin: t.startMin ?? (startDate.getHours() * 60 + startDate.getMinutes()),
                    endMin: t.endMin ?? (endDate.getHours() * 60 + endDate.getMinutes()),
                    label: t.label || ''
                };
            });
            log('  ✓ unifiedTimes:', window.unifiedTimes.length, 'slots');
        }

        return true;
    }

    // =========================================================================
    // LOAD FROM CLOUD (ASYNC)
    // =========================================================================

    async function loadFromCloud(dateKey) {
        if (!window.ScheduleDB?.loadSchedule) {
            log('ScheduleDB not available');
            return null;
        }

        try {
            log('Loading from cloud for', dateKey);
            const result = await window.ScheduleDB.loadSchedule(dateKey);
            
            if (result?.success && result.data) {
                log('Cloud load successful:', {
                    source: result.source,
                    bunks: Object.keys(result.data.scheduleAssignments || {}).length,
                    slots: result.data.unifiedTimes?.length || 0
                });
                return result.data;
            }
            
            log('No cloud data for', dateKey);
            return null;
        } catch (e) {
            log('Cloud load failed:', e);
            return null;
        }
    }

    async function hydrateWindowFromCloud(dateKey) {
        const data = await loadFromCloud(dateKey);
        
        if (!data) {
            return false;
        }

        // Hydrate window globals
        if (data.scheduleAssignments && Object.keys(data.scheduleAssignments).length > 0) {
            window.scheduleAssignments = data.scheduleAssignments;
        }

        if (data.leagueAssignments) {
            window.leagueAssignments = data.leagueAssignments;
        }

        if (data.unifiedTimes && data.unifiedTimes.length > 0) {
            window.unifiedTimes = data.unifiedTimes;
        }

        // Also save to localStorage for future local loads
        try {
            const allData = JSON.parse(localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY) || '{}');
            allData[dateKey] = data;
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(allData));
        } catch (e) {
            // Ignore localStorage errors
        }

        return true;
    }

    // =========================================================================
    // MAIN LOAD FUNCTION
    // =========================================================================

    async function loadScheduleForDate(dateKey, forceCloud = false) {
        if (_isLoading) {
            log('Already loading, skipping');
            return;
        }

        if (!dateKey) {
            log('No date key provided');
            return;
        }

        if (dateKey === _lastLoadedDate && !forceCloud) {
            log('Already loaded', dateKey);
            return;
        }

        _isLoading = true;

        try {
            log('Loading schedule for', dateKey);

            // Step 1: Try localStorage first (fast)
            let loaded = hydrateWindowFromLocal(dateKey);

            // Step 2: If no local data or forced, try cloud
            if (!loaded || forceCloud) {
                loaded = await hydrateWindowFromCloud(dateKey);
            }

            // Step 3: Refresh UI
            if (loaded) {
                _lastLoadedDate = dateKey;
                
                // Trigger table update
                if (window.updateTable) {
                    log('Triggering table update');
                    window.updateTable();
                }

                // Dispatch event for other modules
                window.dispatchEvent(new CustomEvent('campistry-schedule-loaded', {
                    detail: { dateKey }
                }));

                console.log('📅 Schedule loaded for', dateKey, {
                    bunks: Object.keys(window.scheduleAssignments || {}).length,
                    slots: (window.unifiedTimes || []).length
                });
            } else {
                log('No schedule data found for', dateKey);
            }

        } finally {
            _isLoading = false;
        }
    }

    // =========================================================================
    // AUTO-LOAD TRIGGERS
    // =========================================================================

    function tryAutoLoad() {
        const dateKey = getCurrentDateKey();
        
        if (!dateKey) {
            log('No current date set');
            return;
        }

        // Check if we already have data
        const hasData = window.scheduleAssignments && 
                       Object.keys(window.scheduleAssignments).length > 0;

        if (hasData && _lastLoadedDate === dateKey) {
            log('Data already present for', dateKey);
            return;
        }

        loadScheduleForDate(dateKey);
    }

    function scheduleRetry() {
        if (_retryCount >= CONFIG.MAX_RETRIES) {
            log('Max retries reached');
            return;
        }

        _retryCount++;
        setTimeout(tryAutoLoad, CONFIG.RETRY_DELAY_MS);
    }

    // =========================================================================
    // EVENT LISTENERS
    // =========================================================================

    // On cloud hydration complete
    window.addEventListener('campistry-cloud-hydrated', () => {
        log('Cloud hydrated, checking for schedule data...');
        setTimeout(tryAutoLoad, 100);
    });

    // On integration ready
    window.addEventListener('campistry-integration-ready', () => {
        log('Integration ready, checking for schedule data...');
        setTimeout(tryAutoLoad, 100);
    });

    // On RBAC ready
    window.addEventListener('campistry-rbac-ready', () => {
        log('RBAC ready, checking for schedule data...');
        setTimeout(tryAutoLoad, 200);
    });

    // On tab change (if using tab navigation)
    document.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab], .tab-button, .nav-tab');
        if (tab) {
            setTimeout(() => {
                if (isSchedulerTabActive()) {
                    log('Scheduler tab activated');
                    tryAutoLoad();
                }
            }, 100);
        }
    });

    // Watch for date changes
    const observeDateInput = () => {
        const dateInput = document.getElementById('schedule-date-input') ||
                         document.getElementById('datepicker');
        
        if (dateInput) {
            // Initial load
            if (dateInput.value) {
                window.currentScheduleDate = dateInput.value;
                tryAutoLoad();
            }

            // Watch for changes
            dateInput.addEventListener('change', (e) => {
                const newDate = e.target.value;
                if (newDate && newDate !== _lastLoadedDate) {
                    window.currentScheduleDate = newDate;
                    loadScheduleForDate(newDate, true); // Force cloud for date changes
                }
            });

            log('Watching date input');
            return true;
        }
        return false;
    };

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initialize() {
        log('Initializing...');

        // Try to find and watch date input
        if (!observeDateInput()) {
            // Retry a few times
            let attempts = 0;
            const tryObserve = setInterval(() => {
                if (observeDateInput() || attempts++ > 10) {
                    clearInterval(tryObserve);
                }
            }, 500);
        }

        // Initial load attempt
        setTimeout(tryAutoLoad, 300);

        // Fallback: periodic check for first 10 seconds
        let checkCount = 0;
        const periodicCheck = setInterval(() => {
            if (checkCount++ > 20) {
                clearInterval(periodicCheck);
                return;
            }

            const hasData = window.scheduleAssignments && 
                           Object.keys(window.scheduleAssignments).length > 0;
            
            if (!hasData) {
                tryAutoLoad();
            } else {
                clearInterval(periodicCheck);
            }
        }, 500);
    }

    // =========================================================================
    // EXPOSE GLOBAL API
    // =========================================================================

    window.ScheduleAutoLoader = {
        load: loadScheduleForDate,
        reload: () => loadScheduleForDate(getCurrentDateKey(), true),
        getStatus: () => ({
            lastLoadedDate: _lastLoadedDate,
            isLoading: _isLoading,
            currentDate: getCurrentDateKey(),
            hasBunks: Object.keys(window.scheduleAssignments || {}).length,
            hasSlots: (window.unifiedTimes || []).length
        })
    };

    // =========================================================================
    // START
    // =========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        setTimeout(initialize, 100);
    }

    console.log('📅 Schedule Auto-Loader v1.0 ready');
    console.log('   Use ScheduleAutoLoader.reload() to force reload');
    console.log('   Use ScheduleAutoLoader.getStatus() to check state');

})();
