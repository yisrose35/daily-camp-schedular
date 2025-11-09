// -------------------- scheduler_logic_fillers.js --------------------
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
//
// UPDATED:
// - Fixed "fieldUsageBySlot is not defined" error by passing it
//   to all helper functions.
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
    
    let canFit = true;
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) { canFit = false; break; }
        const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        const props = activityProperties[fieldName];
        
        if (usage > 0) {
            // Check for sharable properties
            if (!props || !props.sharable || usage >= 2) {
                canFit = false; break;
            }
            // TODO: Add division/bunk limit checks
        }
    }
    return canFit;
}

/**
 * Finds the best-available league for a block.
 * This is now handled by the "League Pass" in logic_core.
 * This function can be a simple placeholder or removed.
 */
window.findBestLeagueMatchup = function(block, masterLeagues, fieldsBySport, fieldUsageBySlot, activityProperties) {
    // This logic is now in scheduler_logic_core.js's "Pass 3"
    console.warn("findBestLeagueMatchup is being called, but this logic is now in logic_core Pass 3.");
    return null;
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

// Expose helper for core logic
// This allows logic_core to call canBlockFit
window.findBestGeneralActivity.canBlockFit = canBlockFit;

})();
