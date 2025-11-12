// =================================================================
// scheduler_logic_fillers.js
//
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
//
// UPDATED:
// - `canBlockFit` has been updated to be IDENTICAL to the new
//   `canBlockFit` in `scheduler_logic_core.js`. It now enforces
//   the `limitUsage` (Allowed Bunks/Divisions) rules.
// - **SMART SCHEDULER:**
//   - All `findBest...` functions now accept `rotationHistory`.
//   - Instead of picking randomly, they now get the bunk's
//     history and sort all available activities by the
//     least recently used, ensuring "fresh" picks.
// =================================================================

(function() {
'use strict';

// Helper function (needed by finders)
function fieldLabel(f) {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}

// --- START OF NEW TIME LOGIC ---
/**
 * NEW: Checks if a field is available for a specific time slot,
 * respecting the new timeRules array.
 */
function isTimeAvailable(slotIndex, fieldProps) {
    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    
    const slot = window.unifiedTimes[slotIndex];
    const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    // Use INCREMENT_MINS to avoid 2:59:59 issues
    const slotEndMin = slotStartMin + (window.INCREMENT_MINS || 30); 
    
    const rules = fieldProps.timeRules || [];
    
    // 1. If no rules, field is available (respecting master toggle).
    if (rules.length === 0) {
        return fieldProps.available; // `available` is the master toggle from app1
    }
    
    // 2. Check if master toggle is off.
    if (!fieldProps.available) {
        return false;
    }

    // 3. Determine default state based on rules
    // If *any* "Available" rule exists, the default becomes "Unavailable"
    const hasAvailableRules = rules.some(r => r.type === 'Available');
    let isAvailable = !hasAvailableRules;

    // 4. Check "Available" rules first
    for (const rule of rules) {
        if (rule.type === 'Available') {
            // Slot must be *fully contained* within an available block
            if (slotStartMin >= rule.startMin && slotEndMin <= rule.endMin) {
                isAvailable = true;
                break; // Found a matching "Available" rule
            }
        }
    }

    // 5. Check "Unavailable" rules (they override "Available" rules)
    for (const rule of rules) {
        if (rule.type === 'Unavailable') {
            // Slot just needs to *overlap* with an unavailable block
            // Overlap check: (StartA < EndB) and (EndA > StartB)
            if (slotStartMin < rule.endMin && slotEndMin > rule.startMin) {
                isAvailable = false;
                break; // Found a conflicting "Unavailable" rule
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
    if (!fieldName) return false; // Can't fit a null field
    
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
        // "Specific" rules are on
        if (!limitRules.divisions[block.divName]) {
            // This entire division is NOT in the allowed list
            return false;
        }
        
        const allowedBunks = limitRules.divisions[block.divName];
        if (allowedBunks.length > 0) {
            // Specific bunks are listed
            if (!block.bunk) {
                // This block doesn't have a bunk property.
                // This shouldn't happen for general fillers,
                // but if it does, we'll fail closed.
                console.warn(`canBlockFit in filler.js missing block.bunk for ${fieldName}`);
                return false; 
            } else if (!allowedBunks.includes(block.bunk)) {
                // This is a specific bunk, and it's NOT in the list
                return false;
            }
        }
        // If we are here, it's either:
        // 1. The division is in the list, and the allowedBunks array is empty (meaning "all bunks")
        // 2. The division is in the list, and this specific bunk is in the allowedBunks array
    }
    // --- END OF NEW CHECK ---

    // Check 3 & 4: Usage per slot & Time-based availability
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) { return false; } // Invalid block
        
        // Check 3: Usage limit
        const used = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        if (used >= limit) return false;
        
        // Check 4: NEW: Time-based availability
        if (!isTimeAvailable(slotIndex, props)) {
            return false; // This slot is blocked by an override
        }
    }
    return true;
}
// --- END OF UPDATED FUNCTION ---

/**
 * --- NEW: Smart Scheduler Helper ---
 * Sorts a list of possible activities based on the bunk's history.
 * @param {array} possiblePicks - List of { field, sport, _activity } objects.
 * @param {object} bunkHistory - The history object for this specific bunk.
 * @returns {array} The sorted list of picks, from "freshest" to "stalest".
 */
function sortPicksByFreshness(possiblePicks, bunkHistory = {}) {
    return possiblePicks.sort((a, b) => {
        // Use the _activity name (e.g., "Basketball", "Canteen") for history tracking
        const lastA = bunkHistory[a._activity] || 0; // 0 = never played
        const lastB = bunkHistory[b._activity] || 0;
        
        if (lastA !== lastB) {
            return lastA - lastB; // Sorts by oldest (smallest timestamp) first
        }
        
        // If they are equally fresh (or stale), add some randomness
        return 0.5 - Math.random();
    });
}


/**
 * Finds the best-available special activity (special-only).
 * Called by "Special Activity" tile.
 * --- UPDATED for Smart Scheduler ---
 */
window.findBestSpecial = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory) {
    const specials = allActivities
        .filter(a => a.type === 'special')
        .map(a => ({
            field: a.field, // e.g., "Canteen"
            sport: null,
            _activity: a.field // History is tracked by the field name
        }));

    const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};

    // 1. Find all specials that *can* fit this slot
    const availablePicks = specials.filter(pick => 
        canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)
    );
    
    // 2. Sort them by freshness
    const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory);

    // 3. Return the "freshest" one
    return sortedPicks[0] || null; // Fails if no special is available
}

/**
 * NEW: Finds the best-available sport activity (sports-only).
 * Called by "Sports" tile.
 * --- UPDATED for Smart Scheduler ---
 */
window.findBestSportActivity = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory) {
    const sports = allActivities
        .filter(a => a.type === 'field')
        .map(a => ({
            field: a.field, // e.g., "Main Court"
            sport: a.sport, // e.g., "Basketball"
            _activity: a.sport // History is tracked by the sport name
        }));
        
    const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};

    // 1. Find all sports that *can* fit this slot
    const availablePicks = sports.filter(pick => 
        canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)
    );
    
    // 2. Sort them by freshness
    const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory);
    
    // 3. Return the "freshest" one
    return sortedPicks[0] || null; // Fails if no sport is available
}


/**
 * Finds the best-available general activity (hybrid: sports OR special).
 * Called by "Activity" tile.
 * --- UPDATED for Smart Scheduler ---
 */
window.findBestGeneralActivity = function(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory) {
    
    // TODO: 1. Attempt H2H (This is not implemented yet)
    
    // 2. Attempt "fresh" general OR special activity
    // Map all activities to the common format { field, sport, _activity }
    const allPossiblePicks = allActivities.map(a => ({
        field: a.field,
        sport: a.sport,
        _activity: a.sport || a.field // Use sport name, or field name (for specials)
    }));
    
    const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};
    
    // 1. Find all activities that *can* fit this slot
    const availablePicks = allPossiblePicks.filter(pick => 
        canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)
    );

    // 2. Sort them by freshness
    const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory);

    // 3. Return the "freshest" one
    if (sortedPicks[0]) {
        return sortedPicks[0];
    }
    
    // Failsafe
    return { field: "Free", sport: null };
}

// Expose helper for core logic (so logic_core can use it for its own league pass)
window.findBestGeneralActivity.canBlockFit = canBlockFit;

})();
