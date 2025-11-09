// -------------------- scheduler_logic_fillers.js --------------------
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
//
// UPDATED:
// - Removed findBestLeagueMatchup (now handled in logic_core).
// - Added local canBlockFit helper.
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
    // FIX: Default limit is 1 (or 2 for sharable), not a number from props.
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
 * Finds the best-available special activity for a block.
 */
window.findBestSpecial = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    const specials = allActivities.filter(a => a.type === 'special');
    // TODO: Use yesterdayHistory to pick a "fresh" one
    for (const pick of specials.sort(() => 0.5 - Math.random())) {
        if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    return null;
}

/**
 * Finds the best-available general activity (H2H or regular) for a block.
 */
window.findBestGeneralActivity = function(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    
    // TODO: 1. Attempt H2H
    
    // 2. Attempt "fresh" general activity
    const fields = allActivities.filter(a => a.type === 'field');
    for (const pick of fields.sort(() => 0.5 - Math.random())) {
         if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    // Failsafe
    return fields[0] || { field: "Free", sport: null };
}

// Expose helper for core logic (so logic_core can use it for its own league pass)
window.findBestGeneralActivity.canBlockFit = canBlockFit;

})();
