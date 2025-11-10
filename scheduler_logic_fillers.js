// -------------------- scheduler_logic_fillers.js --------------------
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
//
// UPDATED:
// - *** CRITICAL FIX (Daily Overrides) ***
//   - Added `isTimeAvailable` (NEW) which implements the new,
//     correct availability logic (e.g., "Available 11-2").
//   - `canBlockFit` now calls `isTimeAvailable` for every slot.
// -----------------------------------------------------------------

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
 * Checks if a given field is available for all slots in a block.
 * UPDATED: This function now checks time-based availability.
 */
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false; // Can't fit a null field
    
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`Fillers: No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = (props && props.sharable) ? 2 : 1;

    // Check 1: Division allowance
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;

    // Check 2: Usage per slot
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) { return false; } // Invalid block
        
        // Check 2a: Usage limit
        const used = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        if (used >= limit) return false;
        
        // Check 2b: NEW: Time-based availability
        if (!isTimeAvailable(slotIndex, props)) {
            return false; // This slot is blocked by an override
        }
    }
    return true;
}
// --- END OF UPDATED FUNCTION ---

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
