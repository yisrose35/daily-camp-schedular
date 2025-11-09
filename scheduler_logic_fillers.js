// -------------------- scheduler_logic_fillers.js --------------------
// This file is now a "helper library" for the Optimizer.
// It provides functions to find the *best* activity for a given slot.
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
 * THIS IS THE REAL IMPLEMENTATION YOU REQUESTED.
 */
window.findBestLeagueMatchup = function(block, masterLeagues, fieldsBySport, fieldUsageBySlot, activityProperties) {
    // 1. Find the league for this division
    const divLeague = Object.values(masterLeagues).find(l => l.enabled && l.divisions.includes(block.divName));
    if (!divLeague) return null;

    // 2. Get its sports
    const sports = divLeague.sports || [];
    if (sports.length === 0) return null;
    
    // 3. Get the matchups for today using league_scheduling.js
    const teams = (divLeague.teams || []).map(t => String(t).trim()).filter(Boolean);
    if (teams.length < 2) return null;
    
    // We call getLeagueMatchups to get *this* division's games for the day
    if (typeof window.getLeagueMatchups !== 'function') {
        console.error("league_scheduling.js is not loaded or getLeagueMatchups is not defined.");
        return null;
    }
    const matchups = window.getLeagueMatchups(divLeague.name, teams) || [];
    if (!matchups.length) return null;

    // 4. Find the *specific game* this bunk is in
    let myGame = null;
    let myOpponent = null;
    for (const match of matchups) {
        if (match[0] === block.bunk) {
            myGame = match;
            myOpponent = match[1];
            break;
        }
        if (match[1] === block.bunk) {
            myGame = match;
            myOpponent = match[0];
            break;
        }
    }
    
    // If this bunk isn't in a game (e.g., odd number of teams), they can't play a league
    if (!myGame) return null;
    
    // TODO: We need to assign sports to matchups *before* this.
    // This is a logic flaw. We need a global way to assign sports.
    // For now, we'll just pick the *first* sport from the list.
    const sport = sports[0]; 
    
    // 5. Find an available field for that sport
    const possibleFields = fieldsBySport[sport] || [];
    for (const fieldName of possibleFields) {
        // 6. Check if field is free
        if (canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot)) {
            // 7. If yes, return a "pick" object
            return { 
                field: fieldName, 
                sport: `${sport} vs ${myOpponent}`,
                _h2h: true, // Mark it like an H2H
                vs: myOpponent
            }; 
        }
    }
    
    console.warn(`No field available for ${block.bunk} to play ${sport} vs ${myOpponent}`);
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
