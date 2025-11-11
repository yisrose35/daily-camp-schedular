// -------------------- scheduler_logic_fillers.js --------------------
//
// UPDATED (Phase 2a - Activity Rotation):
// - **NEW FUNCTION:** `getActivityFreshnessScores(bunk, history, activities)`
//   This function calculates a "freshness" score for all activities
//   based on the last 7 days of history.
// - **CRITICAL LOGIC:** This new function *ignores* league games
//   (where `_h2h: true`) and pinned events (like "Lunch"),
//   so only regular activities count towards the rotation.
// - `findBestSpecial`, `findBestSportActivity`, and
//   `findBestGeneralActivity` are all updated:
//   - They now call `window.loadScheduleHistory(7)`.
//   - They get the freshness scores.
//   - They **sort by score** (lowest is best/freshest) instead
//     of shuffling randomly.
// -----------------------------------------------------------------

(function() {
'use strict';

// Helper function (needed by finders)
function fieldLabel(f) {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}

// --- NEW: Scoring constants ---
const SCORE_1_DAY_AGO = 100;
const SCORE_2_DAYS_AGO = 50;
const SCORE_3_DAYS_AGO = 25;
const SCORE_DEFAULT = 5;

/**
 * --- NEW: ACTIVITY ROTATION SCORING ENGINE ---
 * Calculates a "freshness" score for all activities for a specific bunk.
 * Lower score is better (fresher).
 * @param {string} bunk The bunk name to check history for.
 * @param {Object} history The history object from `loadScheduleHistory`.
 * @param {Array} activities The list of activities to score.
 * @returns {Object} A map of { activityName: score }
 */
function getActivityFreshnessScores(bunk, history, activities) {
    const scores = {};
    const activityNames = activities.map(a => fieldLabel(a.field));
    activityNames.forEach(name => scores[name] = 0);

    if (!bunk || !history) return scores;

    const historyDays = Object.keys(history).sort().reverse(); // Sorts from most recent (yesterday) to oldest
    
    for (let i = 0; i < historyDays.length; i++) {
        const day = historyDays[i];
        const daySchedule = history[day][bunk] || [];
        
        let scoreToAdd = SCORE_DEFAULT;
        if (i === 0) scoreToAdd = SCORE_1_DAY_AGO;      // Yesterday
        else if (i === 1) scoreToAdd = SCORE_2_DAYS_AGO; // 2 days ago
        else if (i === 2) scoreToAdd = SCORE_3_DAYS_AGO; // 3 days ago
        
        const activitiesDoneThisDay = new Set();
        
        daySchedule.forEach(entry => {
            if (!entry) return;
            
            // --- YOUR CRITICAL RULE ---
            // Ignore league games and pinned events
            if (entry._h2h || entry._fixed) {
                return;
            }
            
            const name = fieldLabel(entry.field);
            if (scores.hasOwnProperty(name) && !activitiesDoneThisDay.has(name)) {
                scores[name] += scoreToAdd;
                activitiesDoneThisDay.add(name);
            }
        });
    }
    return scores;
}


// --- START OF NEW TIME LOGIC ---
function isTimeAvailable(slotIndex, fieldProps) {
    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    
    const slot = window.unifiedTimes[slotIndex];
    const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotEndMin = slotStartMin + (window.INCREMENT_MINS || 30); 
    
    const rules = fieldProps.timeRules || [];
    
    if (rules.length === 0) {
        return fieldProps.available;
    }
    
    if (!fieldProps.available) {
        return false;
    }

    const hasAvailableRules = rules.some(r => r.type === 'Available');
    let isAvailable = !hasAvailableRules;

    for (const rule of rules) {
        if (rule.type === 'Available') {
            if (slotStartMin >= rule.startMin && slotEndMin <= rule.endMin) {
                isAvailable = true;
                break;
            }
        }
    }

    for (const rule of rules) {
        if (rule.type === 'Unavailable') {
            if (slotStartMin < rule.endMin && slotEndMin > rule.startMin) {
                isAvailable = false;
                break;
            }
        }
    }
    
    return isAvailable;
}
// --- END OF NEW TIME LOGIC ---


/**
 * UPDATED: This function now checks time-based availability
 * AND the new bunk/division limits.
 */
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false; 
    
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`Fillers: No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = (props && props.sharable) ? 2 : 1;

    // Check 1: Division allowance (from Sharing)
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;

    // --- NEW: Check 2: Bunk/Division Limit (from limitUsage) ---
    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
        if (!limitRules.divisions[block.divName]) {
            return false;
        }
        
        const allowedBunks = limitRules.divisions[block.divName];
        if (allowedBunks.length > 0) {
            if (!block.bunk) {
                console.warn(`canBlockFit in filler.js missing block.bunk for ${fieldName}`);
                return false; 
            } else if (!allowedBunks.includes(block.bunk)) {
                return false;
            }
        }
    }
    // --- END OF NEW CHECK ---

    // Check 3 & 4: Usage per slot & Time-based availability
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) { return false; } 
        
        // Check 3: Usage limit
        const used = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        if (used >= limit) return false;
        
        // Check 4: Time-based availability
        if (!isTimeAvailable(slotIndex, props)) {
            return false;
        }
    }
    return true;
}
// --- END OF UPDATED FUNCTION ---

/**
 * --- UPDATED: Now uses freshness scores ---
 * Finds the best-available special activity (special-only).
 * Called by "Special Activity" tile.
 */
window.findBestSpecial = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    const specials = allActivities.filter(a => a.type === 'special');
    
    // --- NEW: Activity Rotation ---
    const history = window.loadScheduleHistory?.(7) || {};
    const scores = getActivityFreshnessScores(block.bunk, history, specials);
    specials.sort((a, b) => scores[fieldLabel(a.field)] - scores[fieldLabel(b.field)]);
    // --- END: Activity Rotation ---
    
    for (const pick of specials) {
        if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    return null; // Fails if no special is available
}

/**
 * --- UPDATED: Now uses freshness scores ---
 * Finds the best-available sport activity (sports-only).
 * Called by "Sports" tile.
 */
window.findBestSportActivity = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    const sports = allActivities.filter(a => a.type === 'field');
    
    // --- NEW: Activity Rotation ---
    const history = window.loadScheduleHistory?.(7) || {};
    const scores = getActivityFreshnessScores(block.bunk, history, sports);
    sports.sort((a, b) => scores[fieldLabel(a.field)] - scores[fieldLabel(b.field)]);
    // --- END: Activity Rotation ---
    
    for (const pick of sports) {
        if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    return null; // Fails if no sport is available
}


/**
 * --- UPDATED: Now uses freshness scores ---
 * Finds the best-available general activity (hybrid: sports OR special).
 * Called by "Activity" tile.
 */
window.findBestGeneralActivity = function(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    
    // TODO: 1. Attempt H2H (This is not implemented yet)
    
    // 2. Attempt "fresh" general OR special activity
    
    // --- NEW: Activity Rotation ---
    const history = window.loadScheduleHistory?.(7) || {};
    // Score *all* activities (specials and sports)
    const scores = getActivityFreshnessScores(block.bunk, history, allActivities);
    allActivities.sort((a, b) => scores[fieldLabel(a.field)] - scores[fieldLabel(b.field)]);
    // --- END: Activity Rotation ---
    
    for (const pick of allActivities) {
         if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    
    // Failsafe
    return { field: "Free", sport: null };
}

// Expose helper for core logic
window.findBestGeneralActivity.canBlockFit = canBlockFit;

})();
