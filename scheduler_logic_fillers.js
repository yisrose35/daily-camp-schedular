
// -------------------- scheduler_logic_fillers.js --------------------
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
//
// UPDATED:
// - `canBlockFit` has been updated to be IDENTICAL to the new
//   `canBlockFit` in `scheduler_logic_core.js`. It now enforces
//   the `limitUsage` (Allowed Bunks/Divisions) rules.
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
