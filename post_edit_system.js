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

    function minutesToTimeLabel(mins) {
        if (mins === null || mins === undefined) return '';
        const h24 = Math.floor(mins / 60);
        const m = mins % 60;
        const ap = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
    }

    function fieldLabel(f) {
        if (window.SchedulerCoreUtils?.fieldLabel) {
            return window.SchedulerCoreUtils.fieldLabel(f);
        }
        if (typeof f === "string") return f;
        if (f && typeof f === "object" && typeof f.name === "string") return f.name;
        return "";
    }

    function findSlotsForRange(startMin, endMin, unifiedTimes) {
        const slots = [];
        if (!unifiedTimes || startMin == null || endMin == null) return slots;
        
        for (let i = 0; i < unifiedTimes.length; i++) {
            const slot = unifiedTimes[i];
            const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
            if (slotStart >= startMin && slotStart < endMin) slots.push(i);
        }
        return slots;
    }

    function getSlotTimeRange(slotIdx) {
        const unifiedTimes = window.unifiedTimes || [];
        const slot = unifiedTimes[slotIdx];
        if (!slot) return { startMin: null, endMin: null };
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        return {
            startMin: start.getHours() * 60 + start.getMinutes(),
            endMin: end.getHours() * 60 + end.getMinutes()
        };
    }

    function getDivisionForBunk(bunkName) {
        const divisions = window.divisions || {};
        for (const [divName, divData] of Object.entries(divisions)) {
            if (divData.bunks && divData.bunks.includes(bunkName)) {
                return divName;
            }
        }
        return null;
    }

    // =========================================================================
    // ACTIVITY PROPERTIES
    // =========================================================================

    function getActivityProperties() {
        if (window.activityProperties && Object.keys(window.activityProperties).length > 0) {
            return window.activityProperties;
        }
        
        const settings = window.loadGlobalSettings?.() || {};
        const app1 = settings.app1 || {};
        const props = {};
        
        (app1.fields || []).forEach(f => {
            if (f.name) {
                props[f.name] = {
                    ...f,
                    type: 'field',
                    capacity: f.sharableWith?.capacity || (f.sharableWith?.type === 'all' ? 2 : 1)
                };
            }
        });
        
        (app1.specialActivities || []).forEach(s => {
            if (s.name) {
                props[s.name] = {
                    ...s,
                    type: 'special',
                    capacity: s.sharableWith?.capacity || 1
                };
            }
        });
        
        return props;
    }

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
    // FIELD USAGE TRACKING
    // =========================================================================

    function buildFieldUsageBySlot(excludeBunks = []) {
        const fieldUsageBySlot = {};
        const assignments = window.scheduleAssignments || {};
        const excludeSet = new Set(excludeBunks);

        for (const [bunkName, bunkSlots] of Object.entries(assignments)) {
            if (excludeSet.has(bunkName)) continue;
            if (!bunkSlots || !Array.isArray(bunkSlots)) continue;

            for (let slotIdx = 0; slotIdx < bunkSlots.length; slotIdx++) {
                const entry = bunkSlots[slotIdx];
                if (!entry || !entry.field) continue;
                if (entry._isTransition || entry.field === TRANSITION_TYPE) continue;

                const fName = fieldLabel(entry.field);
                if (!fName || fName === 'Free') continue;

                if (!fieldUsageBySlot[slotIdx]) {
                    fieldUsageBySlot[slotIdx] = {};
                }

                if (!fieldUsageBySlot[slotIdx][fName]) {
                    fieldUsageBySlot[slotIdx][fName] = {
                        count: 0,
                        bunks: {},
                        divisions: []
                    };
                }

                const usage = fieldUsageBySlot[slotIdx][fName];
                usage.count++;
                usage.bunks[bunkName] = entry._activity || fName;

                const divName = getDivisionForBunk(bunkName);
                if (divName && !usage.divisions.includes(divName)) {
                    usage.divisions.push(divName);
                }
            }
        }

        return fieldUsageBySlot;
    }

    // =========================================================================
    // CONFLICT DETECTION
    // =========================================================================

    function checkLocationConflict(locationName, slots, excludeBunk) {
        const assignments = window.scheduleAssignments || {};
        const activityProperties = getActivityProperties();
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
            const divName = getDivisionForBunk(excludeBunk);
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
                const actName = entry._activity || entry.sport || fieldLabel(entry.field);
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
    // FIELD AVAILABILITY CHECK
    // =========================================================================

    function isFieldAvailable(fieldName, slots, excludeBunk, fieldUsageBySlot, activityProperties) {
        const divName = getDivisionForBunk(excludeBunk);
        
        // Check GlobalFieldLocks
        if (window.GlobalFieldLocks?.isFieldLocked(fieldName, slots, divName)) {
            return false;
        }

        // Check disabled fields
        const disabledFields = window.currentDisabledFields || [];
        if (disabledFields.includes(fieldName)) {
            return false;
        }

        // Check capacity
        const props = activityProperties[fieldName] || {};
        let maxCapacity = 1;
        if (props.sharableWith?.capacity) {
            maxCapacity = parseInt(props.sharableWith.capacity) || 1;
        } else if (props.sharable) {
            maxCapacity = 2;
        }

        for (const slotIdx of slots) {
            const slotUsage = fieldUsageBySlot[slotIdx]?.[fieldName];
            if (slotUsage && slotUsage.count >= maxCapacity) {
                return false;
            }
        }

        return true;
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
        const divName = getDivisionForBunk(bunk);

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
            if (!isFieldAvailable(fieldName, slots, bunk, fieldUsageBySlot, activityProperties)) {
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
        const divName = getDivisionForBunk(bunk);
        
        // Get time range
        const firstSlotTime = getSlotTimeRange(slots[0]);
        const lastSlotTime = getSlotTimeRange(slots[slots.length - 1]);
        
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

    // =========================================================================
    // SMART REGENERATION FOR CONFLICTS
    // =========================================================================

    /**
     * Smart regeneration using full scheduler-core logic.
     * When bypassMode is true, the scheduler acts as admin/owner.
     */
    function smartRegenerateConflicts(pinnedBunk, pinnedSlots, pinnedField, pinnedActivity, conflicts, bypassMode = false) {
        console.log('\n' + '='.repeat(60));
        console.log('[SmartRegen] ★★★ SMART REGENERATION STARTED ★★★');
        if (bypassMode) {
            console.log('[SmartRegen] 🔓 BYPASS MODE ACTIVE - Operating with ADMIN privileges');
        }
        console.log('='.repeat(60));
        
        debugLog('Pinned:', { bunk: pinnedBunk, slots: pinnedSlots, field: pinnedField, activity: pinnedActivity });
        debugLog('Conflicts:', conflicts.length);

        const activityProperties = getActivityProperties();
        const results = {
            success: true,
            reassigned: [],
            failed: [],
            pinnedLock: null,
            bypassMode: bypassMode
        };

        // =====================================================================
        // STEP 1: Lock the pinned field in GlobalFieldLocks
        // =====================================================================
        
        if (window.GlobalFieldLocks) {
            const pinnedDivName = getDivisionForBunk(pinnedBunk);
            window.GlobalFieldLocks.lockField(pinnedField, pinnedSlots, {
                lockedBy: 'smart_regen_pinned',
                division: pinnedDivName,
                activity: pinnedActivity,
                bunk: pinnedBunk
            });
            results.pinnedLock = { field: pinnedField, slots: pinnedSlots };
            debugLog('Step 1: Locked pinned field in GlobalFieldLocks');
        }

        // =====================================================================
        // STEP 2: Group conflicts by bunk
        // =====================================================================
        
        const conflictsByBunk = {};
        for (const conflict of conflicts) {
            if (!conflictsByBunk[conflict.bunk]) {
                conflictsByBunk[conflict.bunk] = new Set();
            }
            conflictsByBunk[conflict.bunk].add(conflict.slot);
        }

        debugLog(`Step 2: ${Object.keys(conflictsByBunk).length} bunks need reassignment`);

        // =====================================================================
        // STEP 3: Build fieldUsageBySlot EXCLUDING conflicting bunks
        // =====================================================================
        
        const bunksToReassign = Object.keys(conflictsByBunk);
        const fieldUsageBySlot = buildFieldUsageBySlot(bunksToReassign);
        
        // Add the pinned bunk's usage
        for (const slotIdx of pinnedSlots) {
            if (!fieldUsageBySlot[slotIdx]) {
                fieldUsageBySlot[slotIdx] = {};
            }
            if (!fieldUsageBySlot[slotIdx][pinnedField]) {
                fieldUsageBySlot[slotIdx][pinnedField] = {
                    count: 0,
                    bunks: {},
                    divisions: []
                };
            }
            const usage = fieldUsageBySlot[slotIdx][pinnedField];
            usage.count++;
            usage.bunks[pinnedBunk] = pinnedActivity;
        }

        debugLog('Step 3: Built fieldUsageBySlot');

        // =====================================================================
        // STEP 4: Sort and process bunks
        // =====================================================================
        
        bunksToReassign.sort((a, b) => {
            const numA = parseInt((a.match(/\d+/) || [])[0]) || 0;
            const numB = parseInt((b.match(/\d+/) || [])[0]) || 0;
            return numA - numB;
        });

        debugLog('Step 4: Processing bunks in order:', bunksToReassign.join(', '));

        for (const bunk of bunksToReassign) {
            const slotSet = conflictsByBunk[bunk];
            const slots = [...slotSet].sort((a, b) => a - b);
            
            debugLog(`\nProcessing ${bunk} for slots: ${slots.join(', ')}`);

            // Get original activity
            const originalEntry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            const originalActivity = originalEntry?._activity || originalEntry?.sport || fieldLabel(originalEntry?.field);
            
            debugLog(`  Original activity: ${originalActivity || 'none'}`);

            // Find best pick
            const bestPick = findBestActivityForBunk(
                bunk, 
                slots, 
                fieldUsageBySlot, 
                activityProperties, 
                [pinnedField]
            );

            if (bestPick) {
                applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProperties);
                
                results.reassigned.push({
                    bunk: bunk,
                    slots: slots,
                    from: originalActivity || 'unknown',
                    to: bestPick.activityName,
                    field: bestPick.field,
                    cost: bestPick.cost
                });

                if (window.showToast) {
                    window.showToast(`↪️ ${bunk}: ${originalActivity} → ${bestPick.activityName}`, 'info');
                }
            } else {
                // No valid pick found - mark as Free
                debugLog(`  ⚠️ No valid pick found for ${bunk}, marking as Free`);
                
                if (!window.scheduleAssignments[bunk]) {
                    window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
                }

                slots.forEach((slotIdx, i) => {
                    window.scheduleAssignments[bunk][slotIdx] = {
                        field: 'Free',
                        sport: null,
                        continuation: i > 0,
                        _fixed: false,
                        _activity: 'Free',
                        _smartRegenFailed: true,
                        _originalActivity: originalActivity,
                        _failedAt: Date.now()
                    };
                });

                results.failed.push({
                    bunk: bunk,
                    slots: slots,
                    originalActivity: originalActivity,
                    reason: 'No valid alternative found'
                });

                results.success = false;

                if (window.showToast) {
                    window.showToast(`⚠️ ${bunk}: No alternative found`, 'warning');
                }
            }
        }

        // =====================================================================
        // STEP 5: Summary
        // =====================================================================
        
        console.log('\n' + '='.repeat(60));
        console.log('[SmartRegen] ★★★ REGENERATION COMPLETE ★★★');
        console.log(`  Reassigned: ${results.reassigned.length} bunks`);
        console.log(`  Failed: ${results.failed.length} bunks`);
        if (bypassMode) {
            console.log('  Mode: BYPASS (admin privileges)');
        }
        console.log('='.repeat(60) + '\n');

        // ★★★ VERIFICATION: Log what's actually in window.scheduleAssignments ★★★
        console.log('[SmartRegen] VERIFICATION - checking window.scheduleAssignments:');
        for (const r of results.reassigned) {
            const bunkData = window.scheduleAssignments?.[r.bunk];
            if (bunkData) {
                const firstSlot = r.slots[0];
                const entry = bunkData[firstSlot];
                console.log(`  Bunk ${r.bunk} slot ${firstSlot}: ${entry?._activity || entry?.field || 'MISSING'}`);
            } else {
                console.log(`  Bunk ${r.bunk}: NO DATA IN scheduleAssignments!`);
            }
        }

        return results;
    }

    // =========================================================================
    // SIMPLIFIED smartReassignBunkActivity (drop-in replacement)
    // =========================================================================

    function smartReassignBunkActivity(bunk, slots, avoidLocation) {
        debugLog(`smartReassignBunkActivity called for ${bunk}`);
        
        const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        if (!entry) {
            console.warn(`[PostEdit] No existing entry for ${bunk} at slot ${slots[0]}`);
            return { success: false };
        }

        const originalActivity = entry._activity || entry.sport || fieldLabel(entry.field);
        const activityProperties = getActivityProperties();
        const fieldUsageBySlot = buildFieldUsageBySlot([bunk]);

        const bestPick = findBestActivityForBunk(
            bunk,
            slots,
            fieldUsageBySlot,
            activityProperties,
            [avoidLocation]
        );

        if (bestPick) {
            applyPickToBunk(bunk, slots, bestPick, fieldUsageBySlot, activityProperties);

            if (window.showToast) {
                window.showToast(`↪️ ${bunk}: Moved to ${bestPick.activityName}`, 'info');
            }

            return {
                success: true,
                field: bestPick.field,
                activity: bestPick.activityName,
                cost: bestPick.cost
            };
        } else {
            // Fallback to Free
            console.warn(`[PostEdit] ⚠️ No alternative found for ${bunk}, marking as Free`);

            if (!window.scheduleAssignments[bunk]) {
                window.scheduleAssignments[bunk] = new Array(window.unifiedTimes?.length || 50);
            }

            slots.forEach((slotIdx, i) => {
                window.scheduleAssignments[bunk][slotIdx] = {
                    field: 'Free',
                    sport: null,
                    continuation: i > 0,
                    _fixed: false,
                    _activity: 'Free',
                    _noAlternative: true,
                    _originalActivity: originalActivity,
                    _originalField: avoidLocation
                };
            });

            if (window.showToast) {
                window.showToast(`⚠️ ${bunk}: No alternative found`, 'warning');
            }

            return { success: false, reason: 'No valid alternative found' };
        }
    }

    // =========================================================================
    // APPLY DIRECT EDIT
    // =========================================================================

    function applyDirectEdit(bunk, slots, activity, location, isClear) {
        const unifiedTimes = window.unifiedTimes || [];
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        }

        const fieldValue = location ? `${location} – ${activity}` : activity;

        slots.forEach((idx, i) => {
            window.scheduleAssignments[bunk][idx] = {
                field: isClear ? 'Free' : fieldValue,
                sport: isClear ? null : activity,
                continuation: i > 0,
                _fixed: !isClear,
                _activity: isClear ? 'Free' : activity,
                _location: location,
                _postEdit: true,
                _editedAt: Date.now()
            };
            debugLog(`Set bunk ${bunk} slot ${idx}:`, window.scheduleAssignments[bunk][idx]);
        });
        
        // Register location usage
        if (location && !isClear && window.registerLocationUsage) {
            const divName = getDivisionForBunk(bunk);
            slots.forEach(idx => {
                window.registerLocationUsage(idx, location, activity, divName);
            });
        }
    }

    // =========================================================================
    // RESOLVE CONFLICTS AND APPLY
    // =========================================================================

    async function resolveConflictsAndApply(bunk, slots, activity, location, editData) {
        const editableConflicts = editData.editableConflicts || [];
        const nonEditableConflicts = editData.nonEditableConflicts || [];
        const resolutionChoice = editData.resolutionChoice || 'notify';
        
        console.log('[PostEdit] Resolving conflicts...', {
            editable: editableConflicts.length,
            nonEditable: nonEditableConflicts.length,
            resolution: resolutionChoice
        });
        
        // Step 1: Apply the pinned edit
        applyDirectEdit(bunk, slots, activity, location, false);
        
        // Step 2: Lock this field in GlobalFieldLocks
        if (window.GlobalFieldLocks) {
            const divName = getDivisionForBunk(bunk);
            window.GlobalFieldLocks.lockField(location, slots, {
                lockedBy: 'post_edit_pinned',
                division: divName,
                activity: activity
            });
        }
        
        // Step 3: Determine conflicts to resolve
        let conflictsToResolve = [...editableConflicts];
        const bypassMode = resolutionChoice === 'bypass';
        
        if (bypassMode && nonEditableConflicts.length > 0) {
            // ★★★ BYPASS MODE: Scheduler becomes ADMIN-like ★★★
            console.log('[PostEdit] 🔓 BYPASS MODE - Acting as ADMIN/OWNER');
            console.log('[PostEdit] Including non-editable bunks:', nonEditableConflicts.map(c => c.bunk));
            conflictsToResolve = [...conflictsToResolve, ...nonEditableConflicts];
        }
        
        // Step 4: Use smart regeneration
        if (conflictsToResolve.length > 0) {
            const result = smartRegenerateConflicts(
                bunk,
                slots,
                location,
                activity,
                conflictsToResolve,
                bypassMode
            );

            // Step 5: Handle bypass mode saves
            if (bypassMode) {
                console.log('[PostEdit] 🔓 Bypass mode - saving ALL modified bunks to cloud');
                const modifiedBunks = [
                    ...result.reassigned.map(r => r.bunk),
                    ...result.failed.map(f => f.bunk)
                ];
                
                // ★★★ FIX: Set protection flag BEFORE bypass save to prevent any listeners from overwriting ★★★
                window._postEditInProgress = true;
                window._postEditTimestamp = Date.now();
                
                // ★★★ FIX: Await the bypass save to prevent race conditions ★★★
                await bypassSaveAllBunks(modifiedBunks);
                
                // Notify other schedulers (fire and forget - don't need to await)
                if (nonEditableConflicts.length > 0) {
                    const affectedBunks = [...new Set(nonEditableConflicts.map(c => c.bunk))];
                    sendSchedulerNotification(affectedBunks, location, activity, 'bypassed');
                    
                    if (window.showToast) {
                        window.showToast(`🔓 Bypassed permissions - reassigned ${affectedBunks.length} bunk(s)`, 'info');
                    }
                }
            } else if (nonEditableConflicts.length > 0) {
                // NOTIFY mode: Create double-booking and notify
                const affectedBunks = [...new Set(nonEditableConflicts.map(c => c.bunk))];
                console.warn(`[PostEdit] 📧 Double-booking created: ${affectedBunks.join(', ')}`);
                
                sendSchedulerNotification(affectedBunks, location, activity, 'conflict');
                
                if (window.showToast) {
                    window.showToast(`📧 Notification sent about ${affectedBunks.length} conflict(s)`, 'warning');
                }
            }
        }
    }

    // =========================================================================
    // BYPASS SAVE - Save ALL modified bunks (admin-level access)
    // =========================================================================

    async function bypassSaveAllBunks(modifiedBunks) {
        console.log('[PostEdit] 🔓 BYPASS SAVE for bunks:', modifiedBunks);
        
        // ★★★ FIX: Use consistent date key with all fallbacks ★★★
        const dateKey = window.currentScheduleDate || 
                       window.currentDate || 
                       document.getElementById('datePicker')?.value ||
                       new Date().toISOString().split('T')[0];
        
        console.log(`[PostEdit] 📅 Bypass save using date key: ${dateKey}`);
        
        // ★★★ FIX: Save to localStorage IMMEDIATELY before cloud save ★★★
        // This ensures the data is available when updateTable() calls loadScheduleForDate()
        try {
            // Format 1: scheduleAssignments_${date}
            localStorage.setItem(`scheduleAssignments_${dateKey}`, JSON.stringify(window.scheduleAssignments));
            
            // Format 2: campDailyData_v1 (nested)
            const allDailyData = JSON.parse(localStorage.getItem('campDailyData_v1') || '{}');
            if (!allDailyData[dateKey]) {
                allDailyData[dateKey] = {};
            }
            allDailyData[dateKey].scheduleAssignments = window.scheduleAssignments;
            allDailyData[dateKey].leagueAssignments = window.leagueAssignments || {};
            allDailyData[dateKey].unifiedTimes = window.unifiedTimes || [];
            allDailyData[dateKey]._bypassSaveAt = Date.now();
            localStorage.setItem('campDailyData_v1', JSON.stringify(allDailyData));
            
            console.log(`[PostEdit] ✅ Bypass: saved to localStorage before cloud save`);
        } catch (e) {
            console.error('[PostEdit] Bypass localStorage save error:', e);
        }
        
        // ★★★ FIX: Use ScheduleDB.saveSchedule with skipFilter instead of raw upsert ★★★
        // This properly handles the (camp_id, date_key, scheduler_id) constraint
        if (window.ScheduleDB?.saveSchedule) {
            try {
                const result = await window.ScheduleDB.saveSchedule(dateKey, {
                    scheduleAssignments: window.scheduleAssignments,
                    leagueAssignments: window.leagueAssignments || {},
                    unifiedTimes: window.unifiedTimes,
                    _bypassSaveAt: Date.now(),
                    _modifiedBunks: modifiedBunks
                }, { 
                    skipFilter: true,  // ★★★ This bypasses RBAC filtering - saves ALL bunks
                    immediate: true    // Don't debounce - save immediately
                });
                
                if (result?.success) {
                    console.log('[PostEdit] ✅ Bypass save successful via ScheduleDB');
                } else {
                    console.error('[PostEdit] Bypass save error:', result?.error);
                }
                return result;
            } catch (e) {
                console.error('[PostEdit] Bypass save exception:', e);
            }
        }
        
        // Fallback: trigger standard save flow (will respect RBAC, but better than nothing)
        console.log('[PostEdit] 🔓 Fallback: triggering standard save');
        window.saveSchedule?.();
        window.updateTable?.();
    }

    // =========================================================================
    // SCHEDULER NOTIFICATION
    // =========================================================================

    async function sendSchedulerNotification(affectedBunks, location, activity, notificationType) {
        console.log(`[PostEdit] 📧 Sending ${notificationType} notification for bunks:`, affectedBunks);
        
        const supabase = window.CampistryDB?.getClient?.() || window.supabase;
        if (!supabase) {
            console.warn('[PostEdit] Supabase not available for notifications');
            return;
        }
        
        const campId = window.CampistryDB?.getCampId?.() || localStorage.getItem('currentCampId');
        const userId = window.CampistryDB?.getUserId?.() || null;
        const dateKey = window.currentDate || new Date().toISOString().split('T')[0];
        
        if (!campId) return;
        
        try {
            // Find which schedulers own these bunks
            const affectedDivisions = new Set();
            const divisions = window.divisions || {};
            
            for (const bunk of affectedBunks) {
                for (const [divName, divData] of Object.entries(divisions)) {
                    if (divData.bunks?.includes(bunk)) {
                        affectedDivisions.add(divName);
                    }
                }
            }
            
            // Get schedulers for these divisions
            const { data: schedulers } = await supabase
                .from('camp_users')
                .select('user_id, divisions')
                .eq('camp_id', campId)
                .neq('user_id', userId);
            
            if (!schedulers) return;
            
            // Find schedulers whose divisions include the affected ones
            const notifyUsers = [];
            for (const scheduler of schedulers) {
                const theirDivisions = scheduler.divisions || [];
                if (theirDivisions.some(d => affectedDivisions.has(d))) {
                    notifyUsers.push(scheduler.user_id);
                }
            }
            
            if (notifyUsers.length === 0) return;
            
            // Create notifications
            const notifications = notifyUsers.map(targetUserId => ({
                camp_id: campId,
                user_id: targetUserId,
                type: notificationType === 'bypassed' ? 'schedule_bypassed' : 'schedule_conflict',
                title: notificationType === 'bypassed' 
                    ? '🔓 Your schedule was modified' 
                    : '⚠️ Schedule conflict detected',
                message: notificationType === 'bypassed'
                    ? `Another scheduler reassigned bunks (${affectedBunks.join(', ')}) for ${location} - ${activity} on ${dateKey}`
                    : `Conflict at ${location} for ${activity} on ${dateKey}. Affected bunks: ${affectedBunks.join(', ')}`,
                metadata: {
                    dateKey,
                    bunks: affectedBunks,
                    location,
                    activity,
                    initiatedBy: userId
                },
                read: false,
                created_at: new Date().toISOString()
            }));
            
            const { error } = await supabase
                .from('notifications')
                .insert(notifications);
            
            if (error) {
                console.error('[PostEdit] Notification insert error:', error);
            } else {
                console.log(`[PostEdit] ✅ Sent ${notificationType} notifications to ${notifyUsers.length} user(s)`);
            }
            
        } catch (e) {
            console.error('[PostEdit] Notification error:', e);
        }
    }

    // =========================================================================
    // APPLY EDIT (Main entry point)
    // =========================================================================

    async function applyEdit(bunk, editData) {
        const { activity, location, startMin, endMin, hasConflict, resolutionChoice } = editData;
        const unifiedTimes = window.unifiedTimes || [];
        
        const isClear = activity.toUpperCase() === 'CLEAR' || activity.toUpperCase() === 'FREE' || activity === '';
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        
        if (slots.length === 0) {
            console.error('[PostEdit] ❌ No slots found for time range:', startMin, '-', endMin);
            alert('Error: Could not find time slots for the specified range.');
            return;
        }
        
        console.log(`[PostEdit] Applying edit for ${bunk}:`, { 
            activity, location, startMin, endMin, slots, hasConflict, resolutionChoice, isClear
        });
        
        if (!window.scheduleAssignments) {
            window.scheduleAssignments = {};
        }
        if (!window.scheduleAssignments[bunk]) {
            window.scheduleAssignments[bunk] = new Array(unifiedTimes.length);
        }
        
        // ★★★ FIX: Await conflict resolution to prevent race conditions ★★★
        if (hasConflict) {
            await resolveConflictsAndApply(bunk, slots, activity, location, editData);
        } else {
            applyDirectEdit(bunk, slots, activity, location, isClear);
        }
        
        // Debug
        console.log(`[PostEdit] ✅ After edit, bunk ${bunk} slot ${slots[0]}:`, window.scheduleAssignments[bunk][slots[0]]);
        
        // ★★★ FIX: Use consistent date key - same as bypassSaveAllBunks and unified_schedule_system ★★★
        const currentDate = window.currentScheduleDate || 
                           window.currentDate || 
                           document.getElementById('datePicker')?.value ||
                           new Date().toISOString().split('T')[0];
        
        console.log(`[PostEdit] 📅 Using date key: ${currentDate}`);
        
        const storageKey = `scheduleAssignments_${currentDate}`;
        try {
            localStorage.setItem(storageKey, JSON.stringify(window.scheduleAssignments));
            console.log(`[PostEdit] ✅ Saved to localStorage: ${storageKey}`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to localStorage:', e);
        }
        
        // ★★★ FIX: Save to BOTH storage formats for compatibility ★★★
        // Format 1: campDailyData_v1_${date} (per-date key)
        const unifiedKeyWithDate = `campDailyData_v1_${currentDate}`;
        try {
            const dailyData = JSON.parse(localStorage.getItem(unifiedKeyWithDate) || '{}');
            dailyData.scheduleAssignments = window.scheduleAssignments;
            dailyData._postEditAt = Date.now();
            localStorage.setItem(unifiedKeyWithDate, JSON.stringify(dailyData));
            console.log(`[PostEdit] ✅ Saved to: ${unifiedKeyWithDate}`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to unified storage (per-date):', e);
        }
        
        // Format 2: campDailyData_v1 with nested date keys (what loadScheduleForDate expects)
        const unifiedKeyNested = 'campDailyData_v1';
        try {
            const allDailyData = JSON.parse(localStorage.getItem(unifiedKeyNested) || '{}');
            if (!allDailyData[currentDate]) {
                allDailyData[currentDate] = {};
            }
            allDailyData[currentDate].scheduleAssignments = window.scheduleAssignments;
            allDailyData[currentDate].leagueAssignments = window.leagueAssignments || {};
            allDailyData[currentDate].unifiedTimes = window.unifiedTimes || [];
            allDailyData[currentDate]._postEditAt = Date.now();
            localStorage.setItem(unifiedKeyNested, JSON.stringify(allDailyData));
            console.log(`[PostEdit] ✅ Saved to: ${unifiedKeyNested}[${currentDate}]`);
        } catch (e) {
            console.error('[PostEdit] Failed to save to unified storage (nested):', e);
        }
        
        // Protection flag - prevent cloud hydration from overwriting
        // Note: This flag is also set earlier in resolveConflictsAndApply for bypass mode
        window._postEditInProgress = true;
        window._postEditTimestamp = Date.now();
        
        // Clear the flag after a longer timeout to allow for all async operations
        // The patchLoadScheduleForDate will skip loading while this flag is true
        setTimeout(() => {
            window._postEditInProgress = false;
            console.log('[PostEdit] 🔓 Post-edit protection flag cleared');
        }, 8000); // 8 seconds to be safe
        
        // ★★★ FIX: Don't dispatch campistry-daily-data-updated - it triggers a reload ★★★
        // Our in-memory window.scheduleAssignments is already correct
        // Just dispatch a notification event and render directly
        console.log('[PostEdit] 🔄 Triggering UI refresh...');
        
        // ★★★ VERIFICATION: Check window.scheduleAssignments before render ★★★
        console.log('[PostEdit] VERIFICATION before render:');
        console.log(`  Total bunks in scheduleAssignments: ${Object.keys(window.scheduleAssignments || {}).length}`);
        // Log the bunk we just edited
        const editedEntry = window.scheduleAssignments?.[bunk]?.[slots[0]];
        console.log(`  Edited bunk ${bunk} slot ${slots[0]}: ${editedEntry?._activity || editedEntry?.field || 'MISSING'}`);
        
        // Dispatch post-edit event for any listeners (informational only)
        document.dispatchEvent(new CustomEvent('campistry-post-edit-complete', {
            detail: { bunk, slots, activity, location, date: currentDate }
        }));
        
        // Cloud save (fire and forget - don't await to keep UI responsive)
        window.saveSchedule?.();
        
        // ★★★ FIX: Render immediately from current memory state ★★★
        // Don't dispatch campistry-daily-data-updated as it triggers loadScheduleForDate()
        // which would re-read from storage and might get stale data
        console.log('[PostEdit] 🔄 Calling updateTable() immediately');
        if (typeof window.updateTable === 'function') {
            window.updateTable();
        }
        
        // Second render after a small delay to catch any async updates
        setTimeout(() => {
            console.log('[PostEdit] 🔄 Second render pass');
            if (typeof window.updateTable === 'function') {
                window.updateTable();
            }
        }, 200);
    }

    // =========================================================================
    // MODAL UI
    // =========================================================================

    function createModal() {
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.2s ease;
        `;
        
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            min-width: 400px;
            max-width: 500px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-height: 90vh;
            overflow-y: auto;
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });
        
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
        
        return modal;
    }

    function closeModal() {
        document.getElementById(OVERLAY_ID)?.remove();
    }

    function showEditModal(bunk, startMin, endMin, currentValue, onSave) {
        const modal = createModal();
        const locations = getAllLocations();
        const unifiedTimes = window.unifiedTimes || [];
        
        let currentActivity = currentValue || '';
        let currentField = '';
        let resolutionChoice = 'notify';
        
        const slots = findSlotsForRange(startMin, endMin, unifiedTimes);
        if (slots.length > 0) {
            const entry = window.scheduleAssignments?.[bunk]?.[slots[0]];
            if (entry) {
                currentField = typeof entry.field === 'object' ? entry.field?.name : (entry.field || '');
                currentActivity = entry._activity || currentField || currentValue;
            }
        }
        
        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="margin: 0; font-size: 1.25rem; color: #1f2937;">Edit Schedule Cell</h2>
                <button id="post-edit-close" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #9ca3af; line-height: 1;">&times;</button>
            </div>
            
            <div style="background: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px;">
                <div style="font-weight: 600; color: #374151;">${bunk}</div>
                <div style="font-size: 0.875rem; color: #6b7280;" id="post-edit-time-display">
                    ${minutesToTimeLabel(startMin)} - ${minutesToTimeLabel(endMin)}
                </div>
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 16px;">
                <!-- Activity Name -->
                <div>
                    <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                        Activity Name
                    </label>
                    <input type="text" id="post-edit-activity" 
                        value="${currentActivity}"
                        placeholder="e.g., Impromptu Carnival, Basketball"
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box;">
                    <div style="font-size: 0.75rem; color: #9ca3af; margin-top: 4px;">
                        Enter CLEAR or FREE to empty this slot
                    </div>
                </div>
                
                <!-- Location/Field -->
                <div>
                    <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px;">
                        Location / Field
                    </label>
                    <select id="post-edit-location" 
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; box-sizing: border-box; background: white;">
                        <option value="">-- No specific location --</option>
                        <optgroup label="Fields">
                            ${locations.filter(l => l.type === 'field').map(l => 
                                `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}${l.capacity > 1 ? ` (capacity: ${l.capacity})` : ''}</option>`
                            ).join('')}
                        </optgroup>
                        <optgroup label="Special Activities">
                            ${locations.filter(l => l.type === 'special').map(l => 
                                `<option value="${l.name}" ${l.name === currentField ? 'selected' : ''}>${l.name}</option>`
                            ).join('')}
                        </optgroup>
                    </select>
                </div>
                
                <!-- Change Time Toggle -->
                <div>
                    <button type="button" id="post-edit-time-toggle" style="
                        background: none;
                        border: none;
                        color: #2563eb;
                        font-size: 0.875rem;
                        cursor: pointer;
                        padding: 0;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    ">
                        <span id="post-edit-time-arrow">▶</span> Change time
                    </button>
                    
                    <div id="post-edit-time-section" style="display: none; margin-top: 12px;">
                        <div style="display: flex; gap: 12px;">
                            <div style="flex: 1;">
                                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">
                                    Start Time
                                </label>
                                <input type="time" id="post-edit-start" 
                                    value="${minutesToTimeString(startMin)}"
                                    style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;">
                            </div>
                            <div style="flex: 1;">
                                <label style="display: block; font-weight: 500; color: #374151; margin-bottom: 6px; font-size: 0.875rem;">
                                    End Time
                                </label>
                                <input type="time" id="post-edit-end" 
                                    value="${minutesToTimeString(endMin)}"
                                    style="width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box;">
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Conflict Warning Area -->
                <div id="post-edit-conflict" style="display: none;"></div>
                
                <!-- Buttons -->
                <div style="display: flex; gap: 12px; margin-top: 8px;">
                    <button id="post-edit-cancel" style="
                        flex: 1;
                        padding: 12px;
                        border: 1px solid #d1d5db;
                        border-radius: 8px;
                        background: white;
                        color: #374151;
                        font-size: 1rem;
                        cursor: pointer;
                        font-weight: 500;
                    ">Cancel</button>
                    <button id="post-edit-save" style="
                        flex: 1;
                        padding: 12px;
                        border: none;
                        border-radius: 8px;
                        background: #2563eb;
                        color: white;
                        font-size: 1rem;
                        cursor: pointer;
                        font-weight: 500;
                    ">Save Changes</button>
                </div>
            </div>
        `;
        
        // State
        let useOriginalTime = true;
        const originalStartMin = startMin;
        const originalEndMin = endMin;
        
        // Event handlers
        document.getElementById('post-edit-close').onclick = closeModal;
        document.getElementById('post-edit-cancel').onclick = closeModal;
        
        // Time toggle
        const timeToggle = document.getElementById('post-edit-time-toggle');
        const timeSection = document.getElementById('post-edit-time-section');
        const timeArrow = document.getElementById('post-edit-time-arrow');
        const timeDisplay = document.getElementById('post-edit-time-display');
        
        timeToggle.onclick = () => {
            const isHidden = timeSection.style.display === 'none';
            timeSection.style.display = isHidden ? 'block' : 'none';
            timeArrow.textContent = isHidden ? '▼' : '▶';
            useOriginalTime = !isHidden;
        };
        
        // Conflict checking
        const locationSelect = document.getElementById('post-edit-location');
        const conflictArea = document.getElementById('post-edit-conflict');
        const startInput = document.getElementById('post-edit-start');
        const endInput = document.getElementById('post-edit-end');
        
        function getEffectiveTimes() {
            if (useOriginalTime) {
                return { startMin: originalStartMin, endMin: originalEndMin };
            }
            return {
                startMin: parseTimeToMinutes(startInput.value) || originalStartMin,
                endMin: parseTimeToMinutes(endInput.value) || originalEndMin
            };
        }
        
        function updateTimeDisplay() {
            const times = getEffectiveTimes();
            timeDisplay.textContent = `${minutesToTimeLabel(times.startMin)} - ${minutesToTimeLabel(times.endMin)}`;
        }
        
        function checkAndShowConflicts() {
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!location) {
                conflictArea.style.display = 'none';
                return null;
            }
            
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = checkLocationConflict(location, targetSlots, bunk);
            
            if (conflictCheck.hasConflict) {
                const editableBunks = [...new Set(conflictCheck.editableConflicts.map(c => c.bunk))];
                const nonEditableBunks = [...new Set(conflictCheck.nonEditableConflicts.map(c => c.bunk))];
                
                conflictArea.style.display = 'block';
                
                let html = `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 1.25rem;">⚠️</span>
                        <strong style="color: #92400e;">Location Conflict Detected</strong>
                    </div>
                    <p style="margin: 0 0 8px 0; color: #78350f; font-size: 0.875rem;">
                        <strong>${location}</strong> is already in use:
                    </p>`;
                
                if (editableBunks.length > 0) {
                    html += `<div style="margin-bottom: 8px; padding: 8px; background: #d1fae5; border-radius: 6px;">
                        <div style="font-size: 0.8rem; color: #065f46;">
                            <strong>✓ Can auto-reassign:</strong> ${editableBunks.join(', ')}
                        </div>
                    </div>`;
                }
                
                if (nonEditableBunks.length > 0) {
                    html += `<div style="margin-bottom: 8px; padding: 8px; background: #fee2e2; border-radius: 6px;">
                        <div style="font-size: 0.8rem; color: #991b1b;">
                            <strong>✗ Other scheduler's bunks:</strong> ${nonEditableBunks.join(', ')}
                        </div>
                    </div>
                    
                    <div style="margin-top: 12px;">
                        <div style="font-weight: 500; color: #374151; margin-bottom: 8px; font-size: 0.875rem;">
                            How to handle their bunks?
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="notify" checked style="margin-top: 2px;">
                                <div>
                                    <div style="font-weight: 500; color: #374151;">📧 Notify other scheduler</div>
                                    <div style="font-size: 0.75rem; color: #6b7280;">Create double-booking & send them a warning</div>
                                </div>
                            </label>
                            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 8px; background: white; border-radius: 6px; border: 2px solid #d1d5db;">
                                <input type="radio" name="conflict-resolution" value="bypass" style="margin-top: 2px;">
                                <div>
                                    <div style="font-weight: 500; color: #374151;">🔓 Bypass & reassign (Admin mode)</div>
                                    <div style="font-size: 0.75rem; color: #6b7280;">Override permissions and use smart regeneration</div>
                                </div>
                            </label>
                        </div>
                    </div>`;
                }
                
                html += `</div>`;
                conflictArea.innerHTML = html;
                
                // Bind radio buttons
                const radioButtons = conflictArea.querySelectorAll('input[name="conflict-resolution"]');
                radioButtons.forEach(radio => {
                    radio.addEventListener('change', (e) => {
                        resolutionChoice = e.target.value;
                    });
                });
                
                return conflictCheck;
            } else {
                conflictArea.style.display = 'none';
                return null;
            }
        }
        
        locationSelect.addEventListener('change', checkAndShowConflicts);
        startInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        endInput.addEventListener('change', () => { updateTimeDisplay(); checkAndShowConflicts(); });
        
        checkAndShowConflicts();
        
        // Save handler
        document.getElementById('post-edit-save').onclick = () => {
            const activity = document.getElementById('post-edit-activity').value.trim();
            const location = locationSelect.value;
            const times = getEffectiveTimes();
            
            if (!activity) {
                alert('Please enter an activity name.');
                return;
            }
            
            if (times.endMin <= times.startMin) {
                alert('End time must be after start time.');
                return;
            }
            
            const targetSlots = findSlotsForRange(times.startMin, times.endMin, unifiedTimes);
            const conflictCheck = location ? checkLocationConflict(location, targetSlots, bunk) : null;
            
            if (conflictCheck?.hasConflict) {
                onSave({
                    activity,
                    location,
                    startMin: times.startMin,
                    endMin: times.endMin,
                    hasConflict: true,
                    conflicts: conflictCheck.conflicts,
                    editableConflicts: conflictCheck.editableConflicts || [],
                    nonEditableConflicts: conflictCheck.nonEditableConflicts || [],
                    resolutionChoice: resolutionChoice
                });
            } else {
                onSave({
                    activity,
                    location,
                    startMin: times.startMin,
                    endMin: times.endMin,
                    hasConflict: false,
                    conflicts: []
                });
            }
            
            closeModal();
        };
        
        document.getElementById('post-edit-activity').focus();
        document.getElementById('post-edit-activity').select();
    }

    // =========================================================================
    // ENHANCED EDIT CELL (Main entry point)
    // =========================================================================

    function enhancedEditCell(bunk, startMin, endMin, current) {
        debugLog(`enhancedEditCell called: ${bunk}, ${startMin}-${endMin}, "${current}"`);
        
        // RBAC check
        if (!canEditBunk(bunk)) {
            alert('You do not have permission to edit this schedule.\n\n(You can only edit your assigned divisions.)');
            return;
        }
        
        showEditModal(bunk, startMin, endMin, current, (editData) => {
            applyEdit(bunk, editData);
        });
    }

    // =========================================================================
    // CLICK INTERCEPTOR
    // =========================================================================

    function setupClickInterceptor() {
        const overrideWindowEditCell = () => {
            if (window.editCell && window.editCell !== enhancedEditCell && !window.editCell._isEnhanced) {
                debugLog('Overriding window.editCell');
                window._originalEditCell = window.editCell;
                window.editCell = enhancedEditCell;
                window.editCell._isEnhanced = true;
            }
        };
        
        overrideWindowEditCell();
        setTimeout(overrideWindowEditCell, 500);
        setTimeout(overrideWindowEditCell, 1500);
        setTimeout(overrideWindowEditCell, 3000);
        
        // Capture phase click listener
        document.addEventListener('click', (e) => {
            const td = e.target.closest('td');
            if (!td) return;
            
            const table = td.closest('#scheduleTable, .schedule-table, [data-schedule]');
            if (!table) return;
            
            const onclickStr = td.getAttribute('onclick') || (td.onclick ? td.onclick.toString() : '');
            const isClickable = td.style.cursor === 'pointer' || getComputedStyle(td).cursor === 'pointer';
            
            if (!isClickable && !onclickStr.includes('editCell')) return;
            
            let bunk, startMin, endMin, currentText;
            
            const match = onclickStr.match(/editCell\s*\(\s*["']?([^"',]+)["']?\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*["']?([^"']*)["']?\s*\)/);
            
            if (match) {
                bunk = match[1];
                startMin = parseInt(match[2], 10);
                endMin = parseInt(match[3], 10);
                currentText = match[4] || '';
                
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                td.onclick = null;
                td.removeAttribute('onclick');
                
                enhancedEditCell(bunk, startMin, endMin, currentText);
            }
        }, true);
        
        // Observer for dynamic content
        const observer = new MutationObserver((mutations) => {
            overrideWindowEditCell();
        });
        
        const scheduleContainer = document.getElementById('scheduleTable') || document.getElementById('unified-schedule');
        if (scheduleContainer) {
            observer.observe(scheduleContainer, { childList: true, subtree: true });
        }
        
        debugLog('Click interceptor installed');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    function initPostEditSystem() {
        window.editCell = enhancedEditCell;
        setupClickInterceptor();
        
        if (!document.getElementById('post-edit-styles')) {
            const style = document.createElement('style');
            style.id = 'post-edit-styles';
            style.textContent = `
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                
                #${MODAL_ID} input:focus,
                #${MODAL_ID} select:focus {
                    outline: none;
                    border-color: #2563eb;
                    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
                }
                
                #${MODAL_ID} button:hover {
                    opacity: 0.9;
                }
                
                #${MODAL_ID} button:active {
                    transform: scale(0.98);
                }
            `;
            document.head.appendChild(style);
        }
        
        console.log('📝 Post-Generation Edit System v3.0 initialized');
        console.log('   - INTEGRATED Smart Regeneration');
        console.log('   - Full rotation penalty scoring');
        console.log('   - GlobalFieldLocks integration');
        console.log('   - Candidate building (sports + specials)');
        console.log('   - BYPASS mode with admin-level access');
        console.log('   - Scheduler notifications');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    window.initPostEditSystem = initPostEditSystem;
    window.enhancedEditCell = enhancedEditCell;
    window.checkLocationConflict = checkLocationConflict;
    window.getAllLocations = getAllLocations;
    window.getEditableBunks = getEditableBunks;
    window.sendSchedulerNotification = sendSchedulerNotification;
    window.bypassSaveAllBunks = bypassSaveAllBunks;
    window.smartReassignBunkActivity = smartReassignBunkActivity;
    window.smartRegenerateConflicts = smartRegenerateConflicts;
    window.findBestActivityForBunk = findBestActivityForBunk;
    window.buildFieldUsageBySlot = buildFieldUsageBySlot;
    window.buildCandidateOptions = buildCandidateOptions;
    window.calculateRotationPenalty = calculateRotationPenalty;
    window.isFieldAvailable = isFieldAvailable;
    window.getActivityProperties = getActivityProperties;
    window.applyPickToBunk = applyPickToBunk;
    
    // SmartRegenSystem namespace for compatibility
    window.SmartRegenSystem = {
        smartRegenerateConflicts,
        smartReassignBunkActivity,
        findBestActivityForBunk,
        buildFieldUsageBySlot,
        buildCandidateOptions,
        calculateRotationPenalty,
        isFieldAvailable,
        getActivityProperties,
        applyPickToBunk,
        ROTATION_CONFIG
    };
    
    // Debug utility
    window.debugSmartRegen = function(bunk, slotIdx) {
        const slots = [slotIdx];
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        
        console.log('\n=== SMART REGEN DEBUG ===');
        console.log('Bunk:', bunk);
        console.log('Slot:', slotIdx);
        console.log('Current entry:', entry);
        
        const activityProperties = getActivityProperties();
        const fieldUsageBySlot = buildFieldUsageBySlot([bunk]);
        
        console.log('\nField Usage (excluding this bunk):');
        console.log(fieldUsageBySlot[slotIdx] || {});
        
        console.log('\nCandidate Options:');
        const candidates = buildCandidateOptions(slots, activityProperties, []);
        candidates.slice(0, 10).forEach(c => {
            const available = isFieldAvailable(c.field, slots, bunk, fieldUsageBySlot, activityProperties);
            const penalty = calculateRotationPenalty(bunk, c.activityName, slots);
            console.log(`  ${c.activityName} @ ${c.field}: available=${available}, penalty=${penalty === Infinity ? 'BLOCKED' : penalty}`);
        });
        
        console.log('\nBest Pick:');
        const best = findBestActivityForBunk(bunk, slots, fieldUsageBySlot, activityProperties, []);
        console.log(best || 'None found');
        
        return best;
    };

    // =========================================================================
    // ★★★ CRITICAL PATCH: Make loadScheduleForDate respect _postEditInProgress ★★★
    // =========================================================================
    // 
    // Problem: When we update window.scheduleAssignments in memory and call updateTable(),
    // renderStaggeredView() calls loadScheduleForDate() which OVERWRITES our changes.
    // 
    // Solution: Patch loadScheduleForDate to skip loading when _postEditInProgress is true.
    // 
    // =========================================================================

    function patchLoadScheduleForDate() {
        if (window._loadScheduleForDatePatched) return;
        
        const original = window.loadScheduleForDate;
        if (!original) {
            console.warn('[PostEdit] loadScheduleForDate not found, will retry...');
            setTimeout(patchLoadScheduleForDate, 500);
            return;
        }

        window.loadScheduleForDate = function(dateKey) {
            // ★★★ Skip loading if post-edit is in progress ★★★
            if (window._postEditInProgress) {
                console.log('[PostEdit] 🛡️ Skipping loadScheduleForDate - post-edit in progress');
                console.log('[PostEdit]   Current scheduleAssignments bunks:', Object.keys(window.scheduleAssignments || {}).length);
                return; // Don't overwrite our in-memory changes
            }
            
            // Call original
            return original.call(this, dateKey);
        };

        window._loadScheduleForDatePatched = true;
        console.log('[PostEdit] ✅ Patched loadScheduleForDate to respect _postEditInProgress flag');
    }

    // Patch immediately and also after delays (in case unified_schedule_system loads later)
    patchLoadScheduleForDate();
    setTimeout(patchLoadScheduleForDate, 100);
    setTimeout(patchLoadScheduleForDate, 500);
    setTimeout(patchLoadScheduleForDate, 1500);

    // Auto-initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPostEditSystem);
    } else {
        setTimeout(initPostEditSystem, 100);
    }

})();
