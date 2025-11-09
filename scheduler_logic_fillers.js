// -------------------- scheduler_logic_fillers.js --------------------
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
//
// UPDATED:
// - Added `findBestSportActivity` (for 'Sports Slot') which
//   *only* searches 'field' (sports) activities.
// - `findBestSpecial` (for 'Special Activity') now *only*
//   searches 'special' activities.
// - `findBestGeneralActivity` (for 'General Activity Slot')
//   is the hybrid function that searches *both* fields and specials.
// -----------------------------------------------------------------

(function() {
'use strict';

// Helper function (needed by finders)
function fieldLabel(f) {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}

/**
 * Checks if a given field is available for all slots in a block.
 */
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false; // Can't fit a null field
    
    const props = activityProperties[fieldName];
    const limit = (props && props.sharable) ? 2 : 1;

    // Division allowance
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;

    // Usage per slot
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) { return false; } // Invalid block
        const used = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        if (used >= limit) return false;
    }
    return true;
}

/**
 * Finds the best-available special activity (special-only).
 * Called by "Special Activity" tile.
 */
window.findBestSpecial = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    const specials = allActivities.filter(a => a.type === 'special');
    
    // TODO: Use yesterdayHistory to pick a "fresh" one
    for (const pick of specials.sort(() => 0.5 - Math.random())) {
        if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    return null; // Fails if no special is available
}

/**
 * NEW: Finds the best-available sport activity (sports-only).
 * Called by "Sports" tile.
 */
window.findBestSportActivity = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    const sports = allActivities.filter(a => a.type === 'field');
    
    // TODO: Use yesterdayHistory to pick a "fresh" one
    for (const pick of sports.sort(() => 0.5 - Math.random())) {
        if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    return null; // Fails if no sport is available
}


/**
 * Finds the best-available general activity (hybrid: sports OR special).
 * Called by "Activity" tile.
 */
window.findBestGeneralActivity = function(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    
    // TODO: 1. Attempt H2H (This is not implemented yet)
    
    // 2. Attempt "fresh" general OR special activity
    // No filter needed, `allActivities` contains both types
    for (const pick of allActivities.sort(() => 0.5 - Math.random())) {
         if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    
    // Failsafe
    return { field: "Free", sport: null };
}

// Expose helper for core logic (so logic_core can use it for its own league pass)
window.findBestGeneralActivity.canBlockFit = canBlockFit;

})();
