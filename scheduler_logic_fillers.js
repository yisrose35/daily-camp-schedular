// =================================================================
// scheduler_logic_fillers.js
//
// ... (previous changelog) ...
//
// --- YOUR NEWEST FIX (Sharable Logic) ---
// - **FIXED (Hard Rule):** `canBlockFit` is updated. It now
//   checks *which division* is using a sharable field and
//   blocks bunks from *other* divisions from sharing.
// - **NEW (Soft Rule):** Added `getNeighborBunk` helper.
// - **NEW (Soft Rule):** All `findBest...` functions now
//   implement a "neighbor boost." They check if their
//   paired bunk (1&2, 3&4) is on a sharable field and
//   will "strongly push" to join them.
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
    
    // --- FIX: Use parseTimeToMinutes for rule times ---
    const rules = (fieldProps.timeRules || []).map(r => ({
        type: r.type,
        startMin: parseTimeToMinutes(r.start),
        endMin: parseTimeToMinutes(r.end)
    })).filter(r => r.startMin !== null && r.endMin !== null);
    
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
 * --- UPDATED: THIS IS THE FIX (Hard Rule) ---
 * Now checks *which* division is using a sharable field.
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

    // Check 2: Bunk/Division Limit (from limitUsage)
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

    // Check 3 & 4: Usage per slot & Time-based availability
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) { return false; } // Invalid block
        
        // --- NEW SHARING LOGIC (Check 3) ---
        const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
        
        if (usage.count >= limit) {
            return false; // Already full
        }
        
        if (usage.count > 0) {
            // It's being used. Check if it's by a *different* division.
            if (!usage.divisions.includes(block.divName)) {
                return false; // Can't share across divisions
            }
        }
        // --- END NEW SHARING LOGIC ---
        
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
 * --- NEW: Neighbor Bunk Helper ---
 * Finds the "paired" bunk for sharing.
 * e.g., Bunk 1 (index 0) pairs with Bunk 2 (index 1)
 * e.g., Bunk 3 (index 2) pairs with Bunk 4 (index 3)
 */
function getNeighborBunk(myBunk, allBunksInDivision) {
    if (!myBunk || !allBunksInDivision) return null;
    
    // Sort bunks to ensure "1" comes before "2", etc.
    const sortedBunks = [...allBunksInDivision].sort();
    
    const myIndex = sortedBunks.indexOf(myBunk);
    if (myIndex === -1) return null;
    
    if (myIndex % 2 === 0) {
        // I am Bunk 1 (index 0), neighbor is Bunk 2 (index 1)
        return sortedBunks[myIndex + 1] || null;
    } else {
        // I am Bunk 2 (index 1), neighbor is Bunk 1 (index 0)
        return sortedBunks[myIndex - 1] || null;
    }
}


/**
 * Finds the best-available special activity (special-only).
 * --- UPDATED for Neighbor Boost ---
 */
window.findBestSpecial = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions) {
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

    // --- NEW: Neighbor Boost Logic (Soft Rule) ---
    const myBunk = block.bunk;
    const neighborBunk = getNeighborBunk(myBunk, divisions[block.divName]?.bunks);
    
    if (neighborBunk && window.scheduleAssignments[neighborBunk]) {
        // Check the first slot of the block
        const neighborEntry = window.scheduleAssignments[neighborBunk][block.slots[0]];
        
        if (neighborEntry && !neighborEntry.continuation && neighborEntry.field) {
            const neighborField = fieldLabel(neighborEntry.field);
            const neighborProps = activityProperties[neighborField];
            
            // Check if neighbor is on a sharable field
            if (neighborProps && neighborProps.sharable) {
                // Find this activity in our sorted list
                const neighborPickIndex = sortedPicks.findIndex(pick => fieldLabel(pick.field) === neighborField);
                
                if (neighborPickIndex > 0) {
                    // It exists, and it's not already #1. Move it to the front.
                    const [boostedPick] = sortedPicks.splice(neighborPickIndex, 1);
                    sortedPicks.unshift(boostedPick);
                }
            }
        }
    }
    // --- END Neighbor Boost Logic ---

    // 3. Return the "freshest" (or boosted) one
    return sortedPicks[0] || null; // Fails if no special is available
}

/**
 * NEW: Finds the best-available sport activity (sports-only).
 * --- UPDATED for Neighbor Boost ---
 */
window.findBestSportActivity = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions) {
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
    
    // --- NEW: Neighbor Boost Logic (Soft Rule) ---
    const myBunk = block.bunk;
    const neighborBunk = getNeighborBunk(myBunk, divisions[block.divName]?.bunks);
    
    if (neighborBunk && window.scheduleAssignments[neighborBunk]) {
        const neighborEntry = window.scheduleAssignments[neighborBunk][block.slots[0]];
        
        if (neighborEntry && !neighborEntry.continuation && neighborEntry.field) {
            const neighborField = fieldLabel(neighborEntry.field);
            const neighborProps = activityProperties[neighborField];
            
            if (neighborProps && neighborProps.sharable) {
                const neighborPickIndex = sortedPicks.findIndex(pick => fieldLabel(pick.field) === neighborField);
                
                if (neighborPickIndex > 0) {
                    const [boostedPick] = sortedPicks.splice(neighborPickIndex, 1);
                    sortedPicks.unshift(boostedPick);
                }
            }
        }
    }
    // --- END Neighbor Boost Logic ---

    // 3. Return the "freshest" (or boosted) one
    return sortedPicks[0] || null; // Fails if no sport is available
}


/**
 * Finds the best-available general activity (hybrid: sports OR special).
 * --- UPDATED for Neighbor Boost ---
 */
window.findBestGeneralActivity = function(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions) {
    
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

    // --- NEW: Neighbor Boost Logic (Soft Rule) ---
    const myBunk = block.bunk;
    const neighborBunk = getNeighborBunk(myBunk, divisions[block.divName]?.bunks);
    
    if (neighborBunk && window.scheduleAssignments[neighborBunk]) {
        const neighborEntry = window.scheduleAssignments[neighborBunk][block.slots[0]];
        
        if (neighborEntry && !neighborEntry.continuation && neighborEntry.field) {
            const neighborField = fieldLabel(neighborEntry.field);
            const neighborProps = activityProperties[neighborField];
            
            if (neighborProps && neighborProps.sharable) {
                const neighborPickIndex = sortedPicks.findIndex(pick => fieldLabel(pick.field) === neighborField);
                
                if (neighborPickIndex > 0) {
                    const [boostedPick] = sortedPicks.splice(neighborPickIndex, 1);
                    sortedPicks.unshift(boostedPick);
                }
            }
        }
    }
    // --- END Neighbor Boost Logic ---

    // 3. Return the "freshest" (or boosted) one
    if (sortedPicks[0]) {
        return sortedPicks[0];
    }
    
    // Failsafe
    return { field: "Free", sport: null };
}

// Expose helper for core logic (so logic_core can use it for its own league pass)
window.findBestGeneralActivity.canBlockFit = canBlockFit;

// --- Copied from app1.js, needed for isTimeAvailable ---
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  }
  
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;

  if (mer) {
      if (hh === 12) hh = mer === "am" ? 0 : 12; // 12am -> 0, 12pm -> 12
      else if (mer === "pm") hh += 12; // 1pm -> 13
  } else {
      return null; // AM/PM is required
  }

  return hh * 60 + mm;
}

})();
