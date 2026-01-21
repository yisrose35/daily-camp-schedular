// =============================================================================
// POST-GENERATION EDIT SYSTEM v3.0 - INTEGRATED SMART REGENERATION
// =============================================================================
// 
// FEATURES:
// - Modal UI for editing cells post-generation
// - Activity name and location/field selection
// - Optional time change (hidden by default, shown on request)
// - Scans current schedule for field conflicts
// - SMART REGENERATION using full scheduler-core pipeline:
//   * GlobalFieldLocks integration
//   * Full candidate building (sports + specials)
//   * Rotation penalty scoring (recency, frequency, variety)
//   * Capacity and preference awareness
//   * fillBlock integration
// - BYPASS MODE: When scheduler bypasses RBAC, they become admin-like
//   and can modify ANY bunk with full regeneration privileges
//
// INTEGRATION: Add this file AFTER scheduler_core_main.js, total_solver_engine.js
//
// =============================================================================

(function() {
    'use strict';

    console.log('📝 Post-Generation Edit System v3.0 (INTEGRATED SMART REGEN) loading...');

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const MODAL_ID = 'post-edit-modal';
    const OVERLAY_ID = 'post-edit-overlay';
    const DEBUG = true;
    const TRANSITION_TYPE = window.TRANSITION_TYPE || "Transition/Buffer";

    // =========================================================================
    // ROTATION CONFIGURATION (from scheduler_logic_fillers)
    // =========================================================================
    
    const ROTATION_CONFIG = {
        // Hard rules
        SAME_DAY_PENALTY: Infinity,            // NEVER allow same activity twice in one day

        // Recency penalties (days ago)
        YESTERDAY_PENALTY: 5000,               // Did it yesterday
        TWO_DAYS_AGO_PENALTY: 3000,            // Did it 2 days ago
        THREE_DAYS_AGO_PENALTY: 2000,          // Did it 3 days ago
        FOUR_TO_SEVEN_DAYS_PENALTY: 800,       // Did it 4-7 days ago
        WEEK_PLUS_PENALTY: 200,                // Did it more than a week ago

        // Frequency penalties
        HIGH_FREQUENCY_PENALTY: 1500,          // Done this much more than others
        ABOVE_AVERAGE_PENALTY: 500,            // Done this more than average

        // Variety bonuses (negative = good)
        NEVER_DONE_BONUS: -1500,               // NEVER done this activity before
        UNDER_UTILIZED_BONUS: -800,            // Done less than average

        // Sharing bonus
        ADJACENT_BUNK_BONUS: -100,             // Adjacent bunk doing same activity
        NEARBY_BUNK_BONUS: -30                 // Nearby bunk (within 3) doing same
    };

    // =========================================================================
    // DEBUG LOGGING
    // =========================================================================

    function debugLog(...args) {
        if (DEBUG) console.log('[PostEdit]', ...args);
    }

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================

    function parseTimeToMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        
        let s = str.trim().toLowerCase();
        let meridiem = null;
        
        if (s.endsWith('am') || s.endsWith('pm')) {
            meridiem = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        }
        
        const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
        if (match24) {
            let h = parseInt(match24[1], 10);
            const m = parseInt(match24[2], 10);
            
            if (meridiem) {
                if (h === 12) h = (meridiem === 'am' ? 0 : 12);
                else if (meridiem === 'pm' && h < 12) h += 12;
            }
            
            return h * 60 + m;
        }
        
        return null;
    }

    function minutesToTimeString(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // REMOVED: minutesToTimeLabel (use window.SchedulerCoreUtils.minutesToTimeLabel)
    // REMOVED: fieldLabel (use window.SchedulerCoreUtils.fieldLabel)
    // REMOVED: findSlotsForRange (use window.SchedulerCoreUtils.findSlotsForRange)
    // REMOVED: getSlotTimeRange (use window.SchedulerCoreUtils.getSlotTimeRange)
    // REMOVED: getDivisionForBunk (use window.SchedulerCoreUtils.getDivisionForBunk)
    // REMOVED: getActivityProperties (use window.SchedulerCoreUtils.getActivityProperties)
    // REMOVED: buildFieldUsageBySlot (use window.SchedulerCoreUtils.buildFieldUsageBySlot)
    // REMOVED: isFieldAvailable (use window.SchedulerCoreUtils.isFieldAvailable)

    // =========================================================================
    // GET ALL LOCATIONS (for dropdown)
    // =========================================================================

    function getAllLocations() {
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const locations = [];
        
        (app1.fields || []).forEach(f => {
            if (f.name && f.available !== false) {
                locations.push({
                    name: f.name,
                    type: 'field',
                    capacity: f.sharableWith?.capacity || 1
                });
            }
        });
        
        (app1.specialActivities || []).forEach(s => {
            if (s.name) {
                locations.push({
                    name: s.name,
                    type: 'special',
                    capacity: s.sharableWith?.capacity || 1
                });
            }
        });
        
        return locations;
    }

    // =========================================================================
    // EDITABLE BUNKS (RBAC)
    // =========================================================================

    function getEditableBunks() {
        const editableBunks = new Set();
        
        const editableDivisions = window.AccessControl?.getEditableDivisions?.() || [];
        const divisions = window.divisions || {};
        
        for (const divName of editableDivisions) {
            const divInfo = divisions[divName];
            if (divInfo?.bunks) {
                divInfo.bunks.forEach(b => editableBunks.add(String(b)));
            }
        }
        
        // If no RBAC or owner, all bunks are editable
        if (editableBunks.size === 0) {
            const role = window.AccessControl?.getCurrentRole?.();
            if (!window.AccessControl || role === 'owner' || role === 'admin') {
                Object.keys(window.scheduleAssignments || {}).forEach(b => editableBunks.add(b));
            }
        }
        
        return editableBunks;
    }

    /**
     * Check if user can edit a specific bunk
     */
    function canEditBunk(bunkName) {
        const role = window.AccessControl?.getCurrentRole?.();
        if (role === 'owner' || role === 'admin') return true;
        
        const editableBunks = getEditableBunks();
        return editableBunks.has(bunkName);
    }

    // =========================================================================
    // CONFLICT DETECTION
    // =========================================================================

    function checkLocationConflict(locationName, slots, excludeBunk) {
        const assignments = window.scheduleAssignments || {};
        // UPDATED: Use SchedulerCoreUtils
        const activityProperties = window.SchedulerCoreUtils.getActivityProperties();
        const locationInfo = activityProperties[locationName] || {};
        
        let maxCapacity = 1;
        if (locationInfo.sharableWith?.capacity) {
            maxCapacity = parseInt(locationInfo.sharableWith.capacity) || 1;
        } else if (locationInfo.sharable) {
            maxCapacity = 2;
        }
        
        const editableBunks = getEditableBunks();
        const conflicts = [];
        const usageBySlot = {};
        
        for (const slotIdx of slots) {
            usageBySlot[slotIdx] = [];
            
            for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
                if (bunkName === excludeBunk) continue;
                
                const entry = bunkSlots?.[slotIdx];
                if (!entry) continue;
                
                const entryField = typeof entry.field === 'object' ? entry.field?.name : entry.field;
                const entryActivity = entry._activity || entryField;
                const entryLocation = entry._location || entryField;
                
                // Check if this entry uses the same location
                const matchesLocation = 
                    entryField?.toLowerCase() === locationName.toLowerCase() ||
                    entryLocation?.toLowerCase() === locationName.toLowerCase() ||
                    entryActivity?.toLowerCase() === locationName.toLowerCase();
                
                if (matchesLocation) {
                    usageBySlot[slotIdx].push({
                        bunk: bunkName,
                        activity: entryActivity || entryField,
                        field: entryField,
                        canEdit: editableBunks.has(bunkName)
                    });
                }
            }
        }
        
        // Check GlobalFieldLocks
        let globalLock = null;
        if (window.GlobalFieldLocks) {
            // UPDATED: Use SchedulerCoreUtils
            const divName = window.SchedulerCoreUtils.getDivisionForBunk(excludeBunk);
            const lockInfo = window.GlobalFieldLocks.isFieldLocked(locationName, slots, divName);
            if (lockInfo) {
                globalLock = lockInfo;
            }
        }
        
        let hasConflict = !!globalLock;
        let currentUsage = 0;
        
        for (const slotIdx of slots) {
            const slotUsage = usageBySlot[slotIdx] || [];
            currentUsage = Math.max(currentUsage, slotUsage.length);
            
            if (slotUsage.length >= maxCapacity) {
                hasConflict = true;
                slotUsage.forEach(u => {
                    if (!conflicts.find(c => c.bunk === u.bunk && c.slot === slotIdx)) {
                        conflicts.push({ ...u, slot: slotIdx });
                    }
                });
            }
        }
        
        const editableConflicts = conflicts.filter(c => c.canEdit);
        const nonEditableConflicts = conflicts.filter(c => !c.canEdit);
        
        return {
            hasConflict,
            conflicts,
            editableConflicts,
            nonEditableConflicts,
            globalLock,
            canShare: maxCapacity > 1 && currentUsage < maxCapacity,
            currentUsage,
            maxCapacity
        };
    }

    // =========================================================================
    // ROTATION SCORING (from total_solver_engine)
    // =========================================================================

    function getActivitiesDoneToday(bunk, beforeSlot) {
        const done = new Set();
        const bunkData = window.scheduleAssignments?.[bunk];
        if (!bunkData) return done;

        for (let i = 0; i < beforeSlot; i++) {
            const entry = bunkData[i];
            if (entry) {
                // UPDATED: Use SchedulerCoreUtils
                const actName = entry._activity || entry.sport || window.SchedulerCoreUtils.fieldLabel(entry.field);
                if (actName && actName.toLowerCase() !== 'free' && !actName.toLowerCase().includes('transition')) {
                    done.add(actName.toLowerCase().trim());
                }
            }
        }
        return done;
    }

    function getActivityCount(bunk, activityName) {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const historicalCounts = globalSettings.historicalCounts || {};
        return historicalCounts[bunk]?.[activityName] || 0;
    }

    function getDaysSinceActivity(bunk, activityName) {
        const rotationHistory = window.loadRotationHistory?.() || {};
        const bunkHistory = rotationHistory.bunks?.[bunk] || {};
        const lastDone = bunkHistory[activityName];
        
        if (!lastDone) return null;
        
        const now = Date.now();
        const daysSince = Math.floor((now - lastDone) / (24 * 60 * 60 * 1000));
        return daysSince;
    }

    function calculateRotationPenalty(bunk, activityName, slots) {
        if (!activityName || activityName === 'Free') return 0;

        const firstSlot = slots[0];
        const doneToday = getActivitiesDoneToday(bunk, firstSlot);
        const actLower = activityName.toLowerCase().trim();

        // HARD BLOCK: Already done today
        if (doneToday.has(actLower)) {
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        }

        // Recency penalty
        const daysSince = getDaysSinceActivity(bunk, activityName);
        let recencyPenalty = 0;

        if (daysSince === null) {
            recencyPenalty = ROTATION_CONFIG.NEVER_DONE_BONUS;
        } else if (daysSince === 0) {
            return ROTATION_CONFIG.SAME_DAY_PENALTY;
        } else if (daysSince === 1) {
            recencyPenalty = ROTATION_CONFIG.YESTERDAY_PENALTY;
        } else if (daysSince === 2) {
            recencyPenalty = ROTATION_CONFIG.TWO_DAYS_AGO_PENALTY;
        } else if (daysSince === 3) {
            recencyPenalty = ROTATION_CONFIG.THREE_DAYS_AGO_PENALTY;
        } else if (daysSince <= 7) {
            recencyPenalty = ROTATION_CONFIG.FOUR_TO_SEVEN_DAYS_PENALTY;
        } else {
            recencyPenalty = ROTATION_CONFIG.WEEK_PLUS_PENALTY;
        }

        // Frequency penalty
        const count = getActivityCount(bunk, activityName);
        let frequencyPenalty = 0;
        if (count > 5) {
            frequencyPenalty = ROTATION_CONFIG.HIGH_FREQUENCY_PENALTY;
        } else if (count > 3) {
            frequencyPenalty = ROTATION_CONFIG.ABOVE_AVERAGE_PENALTY;
        } else if (count === 0) {
            frequencyPenalty = ROTATION_CONFIG.UNDER_UTILIZED_BONUS;
        }

        return recencyPenalty + frequencyPenalty;
    }

    // =========================================================================
    // BUILD CANDIDATE OPTIONS (from total_solver_engine)
    // =========================================================================

    function buildCandidateOptions(slots, activityProperties, disabledFields = []) {
        const options = [];
        const seenKeys = new Set();
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};

        // From fields (sports) - using fieldsBySport
        const fieldsBySport = settings.fieldsBySport || {};
        for (const [sport, sportFields] of Object.entries(fieldsBySport)) {
            (sportFields || []).forEach(fieldName => {
                if (disabledFields.includes(fieldName)) return;

                if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots)) {
                    return;
                }

                const key = `${fieldName}|${sport}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: fieldName,
                        sport: sport,
                        activityName: sport,
                        type: 'sport'
                    });
                }
            });
        }

        // From special activities
        const specials = app1.specialActivities || [];
        for (const special of specials) {
            if (!special.name) continue;
            if (disabledFields.includes(special.name)) continue;

            if (window.GlobalFieldLocks?.isFieldLocked(special.name, slots)) {
                continue;
            }

            const key = `special|${special.name}`;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                options.push({
                    field: special.name,
                    sport: null,
                    activityName: special.name,
                    type: 'special'
                });
            }
        }

        // Also add fields directly if they support general activities
        const fields = app1.fields || [];
        for (const field of fields) {
            if (!field.name || field.available === false) continue;
            if (disabledFields.includes(field.name)) continue;

            if (window.GlobalFieldLocks?.isFieldLocked(field.name, slots)) {
                continue;
            }

            // Add field as a generic option if it has activities
            (field.activities || []).forEach(activity => {
                const key = `${field.name}|${activity}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    options.push({
                        field: field.name,
                        sport: activity,
                        activityName: activity,
                        type: 'sport'
                    });
                }
            });
        }

        return options;
    }

    // =========================================================================
    // CALCULATE FULL PENALTY COST
    // =========================================================================

    function calculatePenaltyCost(bunk, slots, pick, fieldUsageBySlot, activityProperties) {
        let penalty = 0;
        const activityName = pick.activityName || pick._activity || pick.sport;
        const fieldName = pick.field;
        // UPDATED: Use SchedulerCoreUtils
        const divName = window.SchedulerCoreUtils.getDivisionForBunk(bunk);

        // Rotation penalty (PRIMARY FACTOR)
        const rotationPenalty = calculateRotationPenalty(bunk, activityName, slots);
        if (rotationPenalty === Infinity) {
            return Infinity;
        }
        penalty += rotationPenalty;

        // Division preference bonus
        const props = activityProperties[fieldName] || {};
        if (props.preferences?.enabled && props.preferences?.list) {
            const prefList = props.preferences.list;
            const idx = prefList.indexOf(divName);
            if (idx !== -1) {
                penalty -= (50 - idx * 5);
            } else if (props.preferences.exclusive) {
                return Infinity;
            } else {
                penalty += 500;
            }
        }

        // Sharing bonus (adjacent bunks doing same activity)
        const myNum = parseInt((bunk.match(/\d+/) || [])[0]) || 0;
        
        for (const slotIdx of slots) {
            const slotUsage = fieldUsageBySlot[slotIdx]?.[fieldName];
            if (slotUsage && slotUsage.bunks) {
                for (const otherBunk of Object.keys(slotUsage.bunks)) {
                    if (otherBunk === bunk) continue;
                    const otherNum = parseInt((otherBunk.match(/\d+/) || [])[0]) || 0;
                    const distance = Math.abs(myNum - otherNum);
                    if (distance === 1) {
                        penalty += ROTATION_CONFIG.ADJACENT_BUNK_BONUS;
                    } else if (distance <= 3) {
                        penalty += ROTATION_CONFIG.NEARBY_BUNK_BONUS;
                    }
                }
            }
        }

        // Usage limit check
        const maxUsage = props.maxUsage || 0;
        if (maxUsage > 0) {
            const hist = getActivityCount(bunk, activityName);
            if (hist >= maxUsage) {
                return Infinity;
            }
            if (hist >= maxUsage - 1) {
                penalty += 2000;
            }
        }

        return penalty;
    }

    // =========================================================================
    // FIND BEST ACTIVITY FOR BUNK (Mini-solver)
    // =========================================================================

    function findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, avoidFields = []) {
        const disabledFields = window.currentDisabledFields || [];
        const avoidSet = new Set(avoidFields.map(f => f.toLowerCase()));

        // Build candidate options
        const candidates = buildCandidateOptions(slots, activityProperties, disabledFields);
        
        debugLog(`Finding best activity for ${bunk} at slots ${slots.join(',')}`);
        debugLog(`  ${candidates.length} candidates available, avoiding: ${avoidFields.join(', ')}`);

        const scoredPicks = [];

        for (const cand of candidates) {
            const fieldName = cand.field;
            const activityName = cand.activityName;

            // Skip avoided fields
            if (avoidSet.has(fieldName.toLowerCase()) || avoidSet.has(activityName?.toLowerCase())) {
                continue;
            }

            // Check field availability
            // UPDATED: Use SchedulerCoreUtils
            if (!window.SchedulerCoreUtils.isFieldAvailable(fieldName, slots, bunk, fieldUsageBySlot, activityProperties)) {
                continue;
            }

            // Calculate penalty cost
            const cost = calculatePenaltyCost(bunk, slots, cand, fieldUsageBySlot, activityProperties);

            if (cost < Infinity) {
                scoredPicks.push({
                    field: fieldName,
                    sport: cand.sport,
                    activityName: activityName,
                    type: cand.type,
                    cost: cost
                });
            }
        }

        // Sort by cost (lower is better)
        scoredPicks.sort((a, b) => a.cost - b.cost);

        debugLog(`  ${scoredPicks.length} valid picks after filtering`);
        if (scoredPicks.length > 0) {
            debugLog(`  Best pick: ${scoredPicks[0].activityName} on ${scoredPicks[0].field} (cost: ${scoredPicks[0].cost})`);
        }

        return scoredPicks.length > 0 ? scoredPicks[0] : null;
    }

    // =========================================================================
    // APPLY PICK TO BUNK (uses fillBlock when available)
    // =========================================================================

    function applyPickToBunk(bunk, slots, pick, fieldUsageBySlot, activityProperties) {
        // UPDATED: Use SchedulerCoreUtils
        const divName = window.SchedulerCoreUtils.getDivisionForBunk(bunk);
        
        // Get time range
        // UPDATED: Use SchedulerCoreUtils
        const firstSlotTime = window.SchedulerCoreUtils.getSlotTimeRange(slots[0]);
        const lastSlotTime = window.SchedulerCoreUtils.getSlotTimeRange(slots[slots.length - 1]);
        
        const block = {
            divName: divName,
            bunk: bunk,
            startTime: firstSlotTime.startMin,
            endTime: lastSlotTime.endMin,
            slots: slots
        };

        const pickData = {
            field: pick.field,
            sport: pick.sport,
            _fixed: true,
            _activity: pick.activityName,
            _smartRegenerated: true,
            _regeneratedAt: Date.now()
        };

        // ★★★ FIX: ALWAYS update window.scheduleAssignments directly ★★★
        // fillBlock may update its own internal structures, but unified_schedule_system
        // reads from window.scheduleAssignments, so we MUST update it here
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
        }

        slots.forEach((slotIdx, i) => {
            window.scheduleAssignments[bunk][slotIdx] = {
                ...pickData,
                continuation: i > 0
            };
        });
        
        debugLog(`  ✅ Updated window.scheduleAssignments[${bunk}] slots ${slots.join(',')}`);

        // Also call fillBlock if available (for any side effects it may have)
        if (typeof window.fillBlock === 'function') {
            debugLog(`  Also calling fillBlock for ${bunk}`);
            try {
                window.fillBlock(block, pickData, fieldUsageBySlot, window.yesterdayHistory || {}, false, activityProperties);
            } catch (e) {
                console.warn(`[PostEdit] fillBlock error for ${bunk}:`, e);
            }
        }

        // Register field usage
        const fieldName = pick.field;
        for (const slotIdx of slots) {
            if (!fieldUsageBySlot[slotIdx]) {
                fieldUsageBySlot[slotIdx] = {};
            }
            if (!fieldUsageBySlot[slotIdx][fieldName]) {
                fieldUsageBySlot[slotIdx][fieldName] = {
                    count: 0,
                    bunks: {},
                    divisions: []
                };
            }
            const usage = fieldUsageBySlot[slotIdx][fieldName];
            usage.count++;
            usage.bunks[bunk] = pick.activityName;
            if (divName && !usage.divisions.includes(divName)) {
                usage.divisions.push(divName);
            }
        }

        debugLog(`  ✅ Applied ${pick.activityName} on ${pick.field} to ${bunk}`);
    }

    // Continues in Part 2...
