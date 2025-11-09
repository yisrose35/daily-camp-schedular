// -------------------- scheduler_logic_fillers.js --------------------
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
// -----------------------------------------------------------------

(function() {
'use strict';

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
 */
window.findBestLeagueMatchup = function(block, masterLeagues, fieldsBySport, fieldUsageBySlot, activityProperties) {
    // 1. Find the league for this division
    const divLeague = Object.values(masterLeagues).find(l => l.enabled && l.divisions.includes(block.divName));
    if (!divLeague) return null;

    // 2. Get its sports
    const sports = divLeague.sports || [];
    if (sports.length === 0) return null;
    
    // 3. Find available fields for those sports
    for (const sport of sports) {
        const possibleFields = fieldsBySport[sport] || [];
        for (const fieldName of possibleFields) {
            // 4. Check if field is free
            if (canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot)) {
                // 5. If yes, return a "pick" object
                // TODO: Add real matchup logic
                return { field: fieldName, sport: `League: ${sport}` }; 
            }
        }
    }
    return null; // No available league fields
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

})();
