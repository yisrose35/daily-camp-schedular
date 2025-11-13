// =================================================================
// scheduler_logic_core.js
//
// ... (previous changelog) ...
//
// --- YOUR NEWEST FIX (Sharable Logic) ---
// - **FIXED (Hard Rule):** `markFieldUsage` now stores an
//   object `{ count, divisions: [] }` in `fieldUsageBySlot`.
// - **FIXED (Hard Rule):** `canBlockFit` is updated. It now
//   checks `fieldUsageBySlot` and blocks sharing if the
//   bunk's division is not in the `divisions` array.
// - **NEW (Soft Rule):** The "Pass 4" optimizer loop now
//   sorts blocks by time, then division, then bunk. This
//   ensures Bunk 1 runs before Bunk 2, allowing the
//   "neighbor push" logic to work.
// - **NEW (Soft Rule):** `divisions` object is now passed
//   to all `findBest...` functions.
//
// --- YOUR LATEST FIX (No Repeats Per Day) ---
// - **NEW (Hard Rule):** "Pass 4" now creates a temporary
//   `activitiesUsedTodayByBunk = {}` object.
// - **FIXED:** Before calling `findBest...`, the optimizer
//   now pre-filters the `allActivities` list, removing any
//   activity that the bunk has already been assigned today.
// - **FIXED:** When a `pick` is made, its `_activity` name
//   is added to the `activitiesUsedTodayByBunk` set.
//   This *guarantees* an activity cannot be picked twice.
// =================================================================

(function() {
'use strict';

// ===== CONFIG =====
const INCREMENT_MINS = 30; 
window.INCREMENT_MINS = INCREMENT_MINS;

// ===== Helpers =====
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  } else {
    return null; // REQUIRE am/pm
  }
  
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
  if (mer) {
    if (hh === 12) hh = mer === "am" ? 0 : 12; 
    else if (mer === "pm") hh += 12; 
  }
  return hh * 60 + mm;
}
function fieldLabel(f) {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}
function fmtTime(d) {
    if (!d) return "";
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}


/**
 * Main entry point, called by the "Run Optimizer" button
 * --- UPDATED: Pass 4 now tracks "used today" ---
 */
window.runSkeletonOptimizer = function(manualSkeleton) {
    window.scheduleAssignments = {}; 
    window.leagueAssignments = {}; 
    window.unifiedTimes = []; 
    
    if (!manualSkeleton || manualSkeleton.length === 0) {
        return false; 
    }
    
    const { 
        divisions, 
        availableDivisions,
        activityProperties, 
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        masterSpecialtyLeagues,
        yesterdayHistory,
        rotationHistory, // NEW: Smart Scheduler History
        disabledLeagues,
        disabledSpecialtyLeagues
    } = loadAndFilterData();
    
    let fieldUsageBySlot = {}; 
    
    // ===== PASS 1: Generate Master Time Grid =====
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    // --- REMOVED globalStartTime/EndTime ---
    
    let earliestMin = null;
    let latestMin = null;

    // --- NEW: Use division times to find range ---
    Object.values(divisions).forEach(div => {
        const startMin = parseTimeToMinutes(div.startTime);
        const endMin = parseTimeToMinutes(div.endTime);
        
        if (startMin !== null && (earliestMin === null || startMin < earliestMin)) {
            earliestMin = startMin;
        }
        if (endMin !== null && (latestMin === null || endMin > latestMin)) {
            latestMin = endMin;
        }
    });

    if (earliestMin == null) earliestMin = 540; 
    if (latestMin == null) latestMin = 960; 
    if (latestMin <= earliestMin) latestMin = earliestMin + 60; 

    const baseDate = new Date(1970, 0, 1, 0, 0, 0); 
    let currentMin = earliestMin;
    while (currentMin < latestMin) {
        const nextMin = currentMin + INCREMENT_MINS;
        const startDate = new Date(baseDate.getTime() + currentMin * 60000);
        const endDate = new Date(baseDate.getTime() + nextMin * 60000);
        window.unifiedTimes.push({ 
            start: startDate, 
            end: endDate, 
            label: `${fmtTime(startDate)} - ${fmtTime(endDate)}`
        });
        currentMin = nextMin;
    }
    if (window.unifiedTimes.length === 0) {
        window.updateTable?.();
        return false;
    }
    availableDivisions.forEach(divName => {
        (divisions[divName]?.bunks || []).forEach(bunk => {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
        });
    });

    // ===== PASS 2: Place all "Pinned" Events from the Skeleton =====
    const schedulableSlotBlocks = []; 
    manualSkeleton.forEach(item => {
        const allBunks = divisions[item.division]?.bunks || [];
        if (!allBunks || allBunks.length === 0) return;
        const startMin = parseTimeToMinutes(item.startTime);
        const endMin = parseTimeToMinutes(item.endTime);
        const allSlots = findSlotsForRange(startMin, endMin);
        if (allSlots.length === 0) return;

        if (item.type === 'pinned') {
            allBunks.forEach(bunk => {
                allSlots.forEach((slotIndex, idx) => {
                    if (!window.scheduleAssignments[bunk][slotIndex]) {
                        window.scheduleAssignments[bunk][slotIndex] = { field: { name: item.event }, sport: null, continuation: (idx > 0), _fixed: true };
                    }
                });
            });
        } else if (item.type === 'split') {
            if (!item.subEvents || item.subEvents.length < 2) return; 
            const event1 = item.subEvents[0]; 
            const event2 = item.subEvents[1]; 
            const splitIndex = Math.ceil(allBunks.length / 2);
            const bunksHalf1 = allBunks.slice(0, splitIndex);
            const bunksHalf2 = allBunks.slice(splitIndex);
            const slotSplitIndex = Math.ceil(allSlots.length / 2);
            const slotsHalf1 = allSlots.slice(0, slotSplitIndex);
            const slotsHalf2 = allSlots.slice(slotSplitIndex);
            const groups = [
                { bunks: bunksHalf1, slots: slotsHalf1, eventDef: event1 },
                { bunks: bunksHalf2, slots: slotsHalf1, eventDef: event2 },
                { bunks: bunksHalf1, slots: slotsHalf2, eventDef: event2 },
                { bunks: bunksHalf2, slots: slotsHalf2, eventDef: event1 }
            ];
            groups.forEach(group => {
                if (group.slots.length === 0) return; 
                group.bunks.forEach(bunk => {
                    if (group.eventDef.type === 'pinned') {
                        group.slots.forEach((slotIndex, idx) => {
                             if (!window.scheduleAssignments[bunk][slotIndex]) {
                                window.scheduleAssignments[bunk][slotIndex] = { field: { name: group.eventDef.event }, sport: null, continuation: (idx > 0), _fixed: true };
                            }
                        });
                    } else if (group.eventDef.type === 'slot') {
                        schedulableSlotBlocks.push({ divName: item.division, bunk: bunk, event: group.eventDef.event, startTime: startMin, endTime: endMin, slots: group.slots });
                    }
                });
            });
        } else if (item.type === 'slot') {
            allBunks.forEach(bunk => {
                schedulableSlotBlocks.push({ divName: item.division, bunk: bunk, event: item.event, startTime: startMin, endTime: endMin, slots: allSlots });
            });
        }
    });

    // ===== PASS 3: NEW "League Pass" (With Smart Shuffle) =====
    const leagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'League Game');
    const specialtyLeagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'Specialty League');
    const remainingBlocks = schedulableSlotBlocks.filter(b => b.event !== 'League Game' && b.event !== 'Specialty League');
    
    const leagueGroups = {};
    leagueBlocks.forEach(block => {
        const key = `${block.divName}-${block.startTime}`;
        if (!leagueGroups[key]) {
            leagueGroups[key] = { divName: block.divName, startTime: block.startTime, slots: block.slots, bunks: new Set() };
        }
        leagueGroups[key].bunks.add(block.bunk);
    });

    Object.values(leagueGroups).forEach(group => {
        
        const leagueEntry = Object.entries(masterLeagues).find(([name, l]) => 
            l.enabled && 
            !disabledLeagues.includes(name) && 
            l.divisions.includes(group.divName)
        );
        
        if (!leagueEntry) return;
        
        const divLeagueName = leagueEntry[0];
        const divLeague = leagueEntry[1];
        const leagueTeams = (divLeague.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (leagueTeams.length === 0) return;
        
        // Filter league sports by what's available today in fieldsBySport
        const availableLeagueSports = (divLeague.sports || []).filter(s => fieldsBySport[s]);
        
        // --- NEW: SMART SHUFFLE FOR LEAGUE SPORT ---
        let sport;
        const leagueHistory = rotationHistory.leagues[divLeagueName] || {};
        
        if (availableLeagueSports.length > 0) {
            // Find the least recently used sport
            // Sorts by timestamp (oldest first). Undefined (never played) comes first.
            sport = availableLeagueSports.sort((a, b) => {
                const lastA = leagueHistory[a] || 0; // 0 = never played
                const lastB = leagueHistory[b] || 0;
                return lastA - lastB; 
            })[0]; 
        } else {
            sport = "League"; // Fallback
        }
        // --- END SMART SHUFFLE ---
        
        let matchups = [];
        if (typeof window.getLeagueMatchups === 'function') {
            matchups = window.getLeagueMatchups(divLeagueName, leagueTeams) || [];
        } else {
            matchups = pairRoundRobin(leagueTeams);
        }
        const allBunksInGroup = Array.from(group.bunks);
        const scheduledGames = []; 
        const blockBase = { slots: group.slots, divName: group.divName };

        for (const [teamA, teamB] of matchups) {
            if (teamA === "BYE" || teamB === "BYE") continue;

            const possibleFields = fieldsBySport[sport] || [];
            let fieldName = null;
            
            for (const f of possibleFields) {
                // --- **THE FIX**: Use new `canLeagueGameFit` ---
                if (canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                    fieldName = f; break;
                }
            }
            if (!fieldName && sport !== "League") { // Don't search all fields if it's a generic "League" game
                for (const f of window.allSchedulableNames) {
                     // --- **THE FIX**: Use new `canLeagueGameFit` ---
                    if (canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                        fieldName = f; break;
                    }
                }
            }
            
            const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;
            let pick;
            if (fieldName) {
                // NEW: We add `_activity` property to help track history later
                pick = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport }; 
                markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
            } else {
                pick = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
            }
            scheduledGames.push(pick);
        }
        
        allBunksInGroup.forEach((bunk, bunkIndex) => {
            let pickToAssign;
            if (scheduledGames.length > 0) pickToAssign = scheduledGames[bunkIndex % scheduledGames.length];
            else pickToAssign = { field: "Leagues", sport: null, _h2h: true, _activity: "League" };
            fillBlock({ ...blockBase, bunk: bunk }, pickToAssign, fieldUsageBySlot, yesterdayHistory, true);
        });
    });

    // ===== PASS 3.5: NEW "Specialty League Pass" =====
    const specialtyLeagueGroups = {};
    specialtyLeagueBlocks.forEach(block => {
        const key = `${block.divName}-${block.startTime}`;
        if (!specialtyLeagueGroups[key]) {
            specialtyLeagueGroups[key] = { divName: block.divName, startTime: block.startTime, slots: block.slots, bunks: new Set() };
        }
        specialtyLeagueGroups[key].bunks.add(block.bunk);
    });

    Object.values(specialtyLeagueGroups).forEach(group => {
        
        const leagueEntry = Object.values(masterSpecialtyLeagues).find(l => 
            l.enabled && 
            !disabledSpecialtyLeagues.includes(l.name) && 
            l.divisions.includes(group.divName)
        );
        
        if (!leagueEntry) return; 

        const sport = leagueEntry.sport;
        if (!sport || !fieldsBySport[sport]) return; 
        
        const leagueFields = leagueEntry.fields || [];
        const leagueTeams = (leagueEntry.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (leagueFields.length === 0 || leagueTeams.length < 2) return;
        
        let matchups = [];
        if (typeof window.getLeagueMatchups === 'function') {
            matchups = window.getLeagueMatchups(leagueEntry.name, leagueTeams) || [];
        } else {
            matchups = pairRoundRobin(leagueTeams); 
        }
        const allBunksInGroup = Array.from(group.bunks);
        const scheduledGames = []; 
        const blockBase = { slots: group.slots, divName: group.divName };
        const gamesPerField = Math.ceil(matchups.length / leagueFields.length);

        for (let i = 0; i < matchups.length; i++) {
            const [teamA, teamB] = matchups[i];
            if (teamA === "BYE" || teamB === "BYE") continue;
            const fieldIndex = Math.floor(i / gamesPerField);
            const fieldName = leagueFields[fieldIndex % leagueFields.length];
            const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;
            let pick;
            
            // --- **THE FIX**: Use new `canLeagueGameFit` ---
            if (fieldName && canLeagueGameFit(blockBase, fieldName, fieldUsageBySlot, activityProperties)) {
                pick = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
                markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
            } else {
                pick = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
            }
            scheduledGames.push(pick);
        }
        allBunksInGroup.forEach((bunk, bunkIndex) => {
            let pickToAssign;
            if (scheduledGames.length > 0) pickToAssign = scheduledGames[bunkIndex % scheduledGames.length];
            else pickToAssign = { field: "Specialty League", sport: null, _h2h: true, _activity: sport };
            fillBlock({ ...blockBase, bunk: bunk }, pickToAssign, fieldUsageBySlot, yesterdayHistory,.js
// =================================================================
// scheduler_logic_core.js
//
// ... (previous changelog) ...
//
// --- YOUR NEWEST FIX (Sharable Logic) ---
// - **FIXED (Hard Rule):** `markFieldUsage` now stores an
//   object `{ count, divisions: [] }` in `fieldUsageBySlot`.
// - **FIXED (Hard Rule):** `canBlockFit` is updated. It now
//   checks `fieldUsageBySlot` and blocks sharing if the
//   bunk's division is not in the `divisions` array.
// - **NEW (Soft Rule):** The "Pass 4" optimizer loop now
//   sorts blocks by time, then division, then bunk. This
//   ensures Bunk 1 runs before Bunk 2, allowing the
//   "neighbor push" logic to work.
// - **NEW (Soft Rule):** `divisions` object is now passed
//   to all `findBest...` functions.
//
// --- YOUR LATEST FIX (No Repeats Per Day) ---
// - **NEW (Hard Rule):** "Pass 4" now creates a temporary
//   `activitiesUsedTodayByBunk = {}` object.
// - **FIXED:** Before calling `findBest...`, the optimizer
//   now pre-filters the `allActivities` list, removing any
//   activity that the bunk has already been assigned today.
// - **FIXED:** When a `pick` is made, its `_activity` name
//   is added to the `activitiesUsedTodayByBunk` set.
//   This *guarantees* an activity cannot be picked twice.
// =================================================================

(function() {
'use strict';

// ===== CONFIG =====
const INCREMENT_MINS = 30; 
window.INCREMENT_MINS = INCREMENT_MINS;

// ===== Helpers =====
function parseTimeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase();
  let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) {
    mer = s.endsWith("am") ? "am" : "pm";
    s = s.replace(/am|pm/g, "").trim();
  } else {
    return null; // REQUIRE am/pm
  }
  
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
  if (mer) {
    if (hh === 12) hh = mer === "am" ? 0 : 12; 
    else if (mer === "pm") hh += 12; 
  }
  return hh * 60 + mm;
}
function fieldLabel(f) {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && typeof f.name === "string") return f.name;
    return "";
}
function fmtTime(d) {
    if (!d) return "";
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}


/**
 * Main entry point, called by the "Run Optimizer" button
 * --- UPDATED: Pass 4 now tracks "used today" ---
 */
window.runSkeletonOptimizer = function(manualSkeleton) {
    window.scheduleAssignments = {}; 
    window.leagueAssignments = {}; 
    window.unifiedTimes = []; 
    
    if (!manualSkeleton || manualSkeleton.length === 0) {
        return false; 
    }
    
    const { 
        divisions, 
        availableDivisions,
        activityProperties, 
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        masterSpecialtyLeagues,
        yesterdayHistory,
        rotationHistory, // NEW: Smart Scheduler History
        disabledLeagues,
        disabledSpecialtyLeagues
    } = loadAndFilterData();
    
    let fieldUsageBySlot = {}; 
    
    // ===== PASS 1: Generate Master Time Grid =====
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    // --- REMOVED globalStartTime/EndTime ---
    
    let earliestMin = null;
    let latestMin = null;

    // --- NEW: Use division times to find range ---
    Object.values(divisions).forEach(div => {
        const startMin = parseTimeToMinutes(div.startTime);
        const endMin = parseTimeToMinutes(div.endTime);
        
        if (startMin !== null && (earliestMin === null || startMin < earliestMin)) {
            earliestMin = startMin;
        }
        if (endMin !== null && (latestMin === null || endMin > latestMin)) {
            latestMin = endMin;
        }
    });

    if (earliestMin == null) earliestMin = 540; 
    if (latestMin == null) latestMin = 960; 
    if (latestMin <= earliestMin) latestMin = earliestMin + 60; 

    const baseDate = new Date(1970, 0, 1, 0, 0, 0); 
    let currentMin = earliestMin;
    while (currentMin < latestMin) {
        const nextMin = currentMin + INCREMENT_MINS;
        const startDate = new Date(baseDate.getTime() + currentMin * 60000);
        const endDate = new Date(baseDate.getTime() + nextMin * 60000);
        window.unifiedTimes.push({ 
            start: startDate, 
            end: endDate, 
            label: `${fmtTime(startDate)} - ${fmtTime(endDate)}`
        });
        currentMin = nextMin;
    }
    if (window.unifiedTimes.length === 0) {
        window.updateTable?.();
        return false;
    }
    availableDivisions.forEach(divName => {
        (divisions[divName]?.bunks || []).forEach(bunk => {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
        });
    });

    // ===== PASS 2: Place all "Pinned" Events from the Skeleton =====
    const schedulableSlotBlocks = []; 
    manualSkeleton.forEach(item => {
        const allBunks = divisions[item.division]?.bunks || [];
        if (!allBunks || allBunks.length === 0) return;
        const startMin = parseTimeToMinutes(item.startTime);
        const endMin = parseTimeToMinutes(item.endTime);
        const allSlots = findSlotsForRange(startMin, endMin);
        if (allSlots.length === 0) return;

        if (item.type === 'pinned') {
            allBunks.forEach(bunk => {
                allSlots.forEach((slotIndex, idx) => {
                    if (!window.scheduleAssignments[bunk][slotIndex]) {
                        window.scheduleAssignments[bunk][slotIndex] = { field: { name: item.event }, sport: null, continuation: (idx > 0), _fixed: true };
                    }
                });
            });
        } else if (item.type === 'split') {
            if (!item.subEvents || item.subEvents.length < 2) return; 
            const event1 = item.subEvents[0]; 
            const event2 = item.subEvents[1]; 
            const splitIndex = Math.ceil(allBunks.length / 2);
            const bunksHalf1 = allBunks.slice(0, splitIndex);
            const bunksHalf2 = allBunks.slice(splitIndex);
            const slotSplitIndex = Math.ceil(allSlots.length / 2);
            const slotsHalf1 = allSlots.slice(0, slotSplitIndex);
            const slotsHalf2 = allSlots.slice(slotSplitIndex);
            const groups = [
                { bunks: bunksHalf1, slots: slotsHalf1, eventDef: event1 },
                { bunks: bunksHalf2, slots: slotsHalf1, eventDef: event2 },
                { bunks: bunksHalf1, slots: slotsHalf2, eventDef: event2 },
                { bunks: bunksHalf2, slots: slotsHalf2, eventDef: event1 }
            ];
            groups.forEach(group => {
                if (group.slots.length === 0) return; 
                group.bunks.forEach(bunk => {
                    if (group.eventDef.type === 'pinned') {
                        group.slots.forEach((slotIndex, idx) => {
                             if (!window.scheduleAssignments[bunk][slotIndex]) {
                                window.scheduleAssignments[bunk][slotIndex] = { field: { name: group.eventDef.event }, sport: null, continuation: (idx > 0), _fixed: true };
                            }
                        });
                    } else if (group.eventDef.type === 'slot') {
                        schedulableSlotBlocks.push({ divName: item.division, bunk: bunk, event: group.eventDef.event, startTime: startMin, endTime: endMin, slots: group.slots });
                    }
                });
            });
        } else if (item.type === 'slot') {
            allBunks.forEach(bunk => {
                schedulableSlotBlocks.push({ divName: item.division, bunk: bunk, event: item.event, startTime: startMin, endTime: endMin, slots: allSlots });
            });
        }
    });

    // ===== PASS 3: NEW "League Pass" (With Smart Shuffle) =====
    const leagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'League Game');
    const specialtyLeagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'Specialty League');
    const remainingBlocks = schedulableSlotBlocks.filter(b => b.event !== 'League Game' && b.event !== 'Specialty League');
    
    const leagueGroups = {};
    leagueBlocks.forEach(block => {
        const key = `${block.divName}-${block.startTime}`;
        if (!leagueGroups[key]) {
            leagueGroups[key] = { divName: block.divName, startTime: block.startTime, slots: block.slots, bunks: new Set() };
        }
        leagueGroups[key].bunks.add(block.bunk);
    });

    Object.values(leagueGroups).forEach(group => {
        
        const leagueEntry = Object.entries(masterLeagues).find(([name, l]) => 
            l.enabled && 
            !disabledLeagues.includes(name) && 
            l.divisions.includes(group.divName)
        );
        
        if (!leagueEntry) return;
        
        const divLeagueName = leagueEntry[0];
        const divLeague = leagueEntry[1];
        const leagueTeams = (divLeague.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (leagueTeams.length === 0) return;
        
        // Filter league sports by what's available today in fieldsBySport
        const availableLeagueSports = (divLeague.sports || []).filter(s => fieldsBySport[s]);
        
        // --- NEW: SMART SHUFFLE FOR LEAGUE SPORT ---
        let sport;
        const leagueHistory = rotationHistory.leagues[divLeagueName] || {};
        
        if (availableLeagueSports.length > 0) {
            // Find the least recently used sport
            // Sorts by timestamp (oldest first). Undefined (never played) comes first.
            sport = availableLeagueSports.sort((a, b) => {
                const lastA = leagueHistory[a] || 0; // 0 = never played
                const lastB = leagueHistory[b] || 0;
                return lastA - lastB; 
            })[0]; 
        } else {
            sport = "League"; // Fallback
        }
        // --- END SMART SHUFFLE ---
        
        let matchups = [];
        if (typeof window.getLeagueMatchups === 'function') {
            matchups = window.getLeagueMatchups(divLeagueName, leagueTeams) || [];
        } else {
            matchups = pairRoundRobin(leagueTeams);
        }
        const allBunksInGroup = Array.from(group.bunks);
        const scheduledGames = []; 
        const blockBase = { slots: group.slots, divName: group.divName };

        for (const [teamA, teamB] of matchups) {
            if (teamA === "BYE" || teamB === "BYE") continue;

            const possibleFields = fieldsBySport[sport] || [];
            let fieldName = null;
            
            for (const f of possibleFields) {
                // --- **THE FIX**: Use new `canLeagueGameFit` ---
                if (canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                    fieldName = f; break;
                }
            }
            if (!fieldName && sport !== "League") { // Don't search all fields if it's a generic "League" game
                for (const f of window.allSchedulableNames) {
                     // --- **THE FIX**: Use new `canLeagueGameFit` ---
                    if (canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                        fieldName = f; break;
                    }
                }
            }
            
            const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;
            let pick;
            if (fieldName) {
                // NEW: We add `_activity` property to help track history later
                pick = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport }; 
                markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
            } else {
                pick = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
            }
            scheduledGames.push(pick);
        }
        
        allBunksInGroup.forEach((bunk, bunkIndex) => {
            let pickToAssign;
            if (scheduledGames.length > 0) pickToAssign = scheduledGames[bunkIndex % scheduledGames.length];
            else pickToAssign = { field: "Leagues", sport: null, _h2h: true, _activity: "League" };
            fillBlock({ ...blockBase, bunk: bunk }, pickToAssign, fieldUsageBySlot, yesterdayHistory, true);
        });
    });

    // ===== PASS 3.5: NEW "Specialty League Pass" =====
    const specialtyLeagueGroups = {};
    specialtyLeagueBlocks.forEach(block => {
        const key = `${block.divName}-${block.startTime}`;
        if (!specialtyLeagueGroups[key]) {
            specialtyLeagueGroups[key] = { divName: block.divName, startTime: block.startTime, slots: block.slots, bunks: new Set() };
        }
        specialtyLeagueGroups[key].bunks.add(block.bunk);
    });

    Object.values(specialtyLeagueGroups).forEach(group => {
        
        const leagueEntry = Object.values(masterSpecialtyLeagues).find(l => 
            l.enabled && 
            !disabledSpecialtyLeagues.includes(l.name) && 
            l.divisions.includes(group.divName)
        );
        
        if (!leagueEntry) return; 

        const sport = leagueEntry.sport;
        if (!sport || !fieldsBySport[sport]) return; 
        
        const leagueFields = leagueEntry.fields || [];
        const leagueTeams = (leagueEntry.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (leagueFields.length === 0 || leagueTeams.length < 2) return;
        
        let matchups = [];
        if (typeof window.getLeagueMatchups === 'function') {
            matchups = window.getLeagueMatchups(leagueEntry.name, leagueTeams) || [];
        } else {
            matchups = pairRoundRobin(leagueTeams); 
        }
        const allBunksInGroup = Array.from(group.bunks);
        const scheduledGames = []; 
        const blockBase = { slots: group.slots, divName: group.divName };
        const gamesPerField = Math.ceil(matchups.length / leagueFields.length);

        for (let i = 0; i < matchups.length; i++) {
            const [teamA, teamB] = matchups[i];
            if (teamA === "BYE" || teamB === "BYE") continue;
            const fieldIndex = Math.floor(i / gamesPerField);
            const fieldName = leagueFields[fieldIndex % leagueFields.length];
            const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;
            let pick;
            
            // --- **THE FIX**: Use new `canLeagueGameFit` ---
            if (fieldName && canLeagueGameFit(blockBase, fieldName, fieldUsageBySlot, activityProperties)) {
                pick = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
                markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
            } else {
                pick = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
            }
            scheduledGames.push(pick);
        }
        allBunksInGroup.forEach((bunk, bunkIndex) => {
            let pickToAssign;
            if (scheduledGames.length > 0) pickToAssign = scheduledGames[bunkIndex % scheduledGames.length];
            else pickToAssign = { field: "Specialty League", sport: null, _h2h: true, _activity: sport };
            fillBlock({ ...blockBase, bunk: bunk }, pickToAssign, fieldUsageBySlot, yesterdayHistory, true);
        });
    });


    // ===== PASS 4: Fill remaining Schedulable Slots (With Smart Shuffle) =====
    
    // --- **THIS IS THE FIX (Part 1)** ---
    // Helper object to track activities used *today*
    const activitiesUsedTodayByBunk = {};
    // --- End Part 1 ---
    
    // --- NEW: Sort by time, then div, then bunk ---
    remainingBlocks.sort((a, b) => {
        if (a.startTime !== b.startTime) {
            return a.startTime - b.startTime;
        }
        if (a.divName !== b.divName) {
            return a.divName.localeCompare(b.divName);
        }
        // Bunks need to be sorted "1", "2", ... "10" not "1", "10", "2"
        const numA = parseInt(a.bunk.match(/\d+/) || 0);
        const numB = parseInt(b.bunk.match(/\d+/) || 0);
        if (numA !== numB) {
            return numA - numB;
        }
        return a.bunk.localeCompare(b.bunk);
    });

    for (const block of remainingBlocks) {
        if (block.slots.length === 0 || window.scheduleAssignments[block.bunk][block.slots[0]]) {
            continue;
        }
        
        // --- **THIS IS THE FIX (Part 2)** ---
        const bunk = block.bunk;
        // Ensure the "used today" set exists for this bunk
        activitiesUsedTodayByBunk[bunk] = activitiesUsedTodayByBunk[bunk] || new Set();
        const usedToday = activitiesUsedTodayByBunk[bunk];

        // 1. Filter the master list to exclude activities already used by this bunk
        const availableActivitiesForThisSlot = allActivities.filter(a => {
            const activityName = a.sport || a.field; // This is the `_activity` logic
            return !usedToday.has(activityName);
        });
        // --- **END FIX (Part 2)** ---

        let pick = null;
        // NEW: Pass the *new pre-filtered list* to the findBest functions
        if (block.event === 'Special Activity') {
            pick = window.findBestSpecial?.(block, availableActivitiesForThisSlot, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions);
        } else if (block.event === 'Sports Slot') {
            pick = window.findBestSportActivity?.(block, availableActivitiesForThisSlot, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions);
        } else if (block.event === 'Swim') {
            pick = { field: "Swim", sport: null, _activity: "Swim" }; 
        }
        if (!pick) {
            pick = window.findBestGeneralActivity?.(block, availableActivitiesForThisSlot, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions);
        }
        
        if (pick) {
            // --- **THIS IS THE FIX (Part 3)** ---
            // 2. Add the picked activity to the "used today" set
            if (pick._activity) {
                activitiesUsedTodayByBunk[bunk].add(pick._activity);
            }
            // --- **END FIX (Part 3)** ---
            fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, false);
        } else {
            fillBlock(block, { field: "Free", sport: null }, fieldUsageBySlot, yesterdayHistory, false);
        }
    }
    
    // ===== PASS 5: NEW: Update Rotation History =====
    try {
        const historyToSave = window.loadRotationHistory();
        const timestamp = Date.now();

        availableDivisions.forEach(divName => {
            (divisions[divName]?.bunks || []).forEach(bunk => {
                const schedule = window.scheduleAssignments[bunk] || [];
                let lastActivity = null; // Prevent double-counting a 2-slot activity
                
                for (const entry of schedule) {
                    if (entry && entry._activity && entry._activity !== lastActivity) {
                        const activityName = entry._activity;
                        lastActivity = activityName;
                        
                        // 1. Update bunk history (for "freshness" check in fillers)
                        historyToSave.bunks[bunk] = historyToSave.bunks[bunk] || {};
                        historyToSave.bunks[bunk][activityName] = timestamp;
                        
                        // 2. If it's a league, update league history (for "fairness" check in Pass 3)
                        if (entry._h2h) {
                            const leagueEntry = Object.entries(masterLeagues).find(([name, l]) => 
                                l.enabled && l.divisions.includes(divName)
                            );
                            if (leagueEntry) {
                                const leagueName = leagueEntry[0];
                                historyToSave.leagues[leagueName] = historyToSave.leagues[leagueName] || {};
                                historyToSave.leagues[leagueName][activityName] = timestamp;
                            }
                        }
                    } else if (entry && !entry.continuation) {
                        lastActivity = null; // Reset for new block
                    }
                }
            });
        });
        
        window.saveRotationHistory(historyToSave);
        console.log("Smart Scheduler: Rotation history updated.");

    } catch (e) {
        console.error("Smart Scheduler: Failed to update rotation history.", e);
    }
    
    // ===== PASS 6: Save unifiedTimes and Update the UI =====
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes); 
    window.updateTable?.();
    window.saveSchedule?.(); 
    return true; 
}

// --- Helper functions for Pass 3 & 4 ---
function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes) return slots;
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStart = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        if (slotStart >= startMin && slotStart < endMin) {
            slots.push(i);
        }
    }
    return slots;
}
/**
 * --- UPDATED: THIS IS THE FIX (Hard Rule) ---
 * Now stores usage as `{ count, divisions: [] }`.
 */
function markFieldUsage(block, fieldName, fieldUsageBySlot) {
    if (!fieldName || fieldName === "No Field" || !window.allSchedulableNames.includes(fieldName)) {
        return;
    }
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) continue;
        
        fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
        
        // --- NEW SHARING LOGIC ---
        const currentUsage = fieldUsageBySlot[slotIndex][fieldName] || { count: 0, divisions: [] };
        currentUsage.count++;
        // Add this bunk's division to the list of users
        if (!currentUsage.divisions.includes(block.divName)) {
            currentUsage.divisions.push(block.divName);
        }
        fieldUsageBySlot[slotIndex][fieldName] = currentUsage;
        // --- END NEW SHARING LOGIC ---
    }
}


// --- START OF NEW TIME LOGIC ---
function isTimeAvailable(slotIndex, fieldProps) {
    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    
    const slot = window.unifiedTimes[slotIndex];
    const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotEndMin = slotStartMin + INCREMENT_MINS; 
    
    // --- FIX: Use parseTimeToMinutes for rule times ---
    const rules = (fieldProps.timeRules || []).map(r => ({
        type: r.type,
        startMin: parseTimeToMinutes(r.start),
        endMin: parseTimeToMinutes(r.end)
    })).filter(r => r.startMin !== null && r.endMin !== null);
    
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
            // Overlap check: (StartA < EndB) and (EndA > StartB)
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
 * --- UPDATED: THIS IS THE FIX (Hard Rule) ---
 * Now checks *which* division is using a sharable field.
 */
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
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
                // League pass logic (as before)
            } else if (!allowedBunks.includes(block.bunk)) {
                return false;
            }
        }
    }

    // Check 3 & 4: Usage per slot & Time-based availability
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) return false; 
        
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
        
        // Check 4: Time-based availability
        if (!isTimeAvailable(slotIndex, props)) {
            return false; 
        }
    }
    return true;
}

/**
 * --- **NEW FUNCTION** ---
 * This is a copy of `canBlockFit` but hard-codes the
 * limit to 1, and only checks for *cross-division* sharing.
 */
function canLeagueGameFit(block, fieldName, fieldUsageBySlot, activityProperties) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
        return false;
    }
    // --- THIS IS THE FIX ---
    const limit = 1; // League games are NEVER sharable
    // --- END FIX ---

    // Check 1: Division allowance (from Sharing)
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;

    // Check 2: Bunk/Division Limit (from limitUsage)
    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
        if (!limitRules.divisions[block.divName]) {
            return false;
        }
        // Note: We don't check for specific bunks here,
        // as league games apply to the whole division.
    }

    // Check 3 & 4: Usage per slot & Time-based availability
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) return false; 
        
        // --- NEW SHARING LOGIC (Check 3) ---
        // We only check for usage. A league game can't be
        // placed on a field already in use by anyone.
        const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
        
        if (usage.count >= limit) {
            return false; // Already full
        }
        // --- END NEW SHARING LOGIC ---
        
        // Check 4: Time-based availability
        if (!isTimeAvailable(slotIndex, props)) {
            return false; 
        }
    }
    return true;
}
// --- END OF UPDATED FUNCTION ---


function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, isLeagueFill = false) {
    const fieldName = fieldLabel(pick.field);
    const sport = pick.sport;
    
    block.slots.forEach((slotIndex, idx) => {
        if (slotIndex === undefined || slotIndex >= window.unifiedTimes.length) return;
        if (!window.scheduleAssignments[block.bunk]) return;

        if (!window.scheduleAssignments[block.bunk][slotIndex]) {
            window.scheduleAssignments[block.bunk][slotIndex] = {
                field: fieldName,
                sport: sport,
                continuation: (idx > 0),
                _fixed: false,
                _h2h: pick._h2h || false,
                vs: pick.vs || null,
                _activity: pick._activity || null // NEW: Save the base activity name for history
            };
            
            // --- UPDATED: Use new markFieldUsage ---
            if (!isLeagueFill) {
                 markFieldUsage(block, fieldName, fieldUsageBySlot);
            }
        }
    });
}
function pairRoundRobin(teamList) {
    const arr = teamList.map(String);
    if (arr.length < 2) return [];
    if (arr.length % 2 === 1) arr.push("BYE");
    const n = arr.length;
    const half = n / 2;
    const firstRoundPairs = [];
    for (let i = 0; i < half; i++) {
        const A = arr[i], B = arr[n - 1 - i];
        if (A !== "BYE" && B !== "BYE") firstRoundPairs.push([A, B]);
    }
    return firstRoundPairs;
}


// --- START OF UPDATED FUNCTION ---
/**
 * UPDATED: This function now loads and filters by
 * the new `dailyDisabledSportsByField`, `disabledFields`,
 * and `disabledSpecials` lists.
 * NEW: Also loads `rotationHistory`.
 */
function loadAndFilterData() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    
    const masterFields = app1Data.fields || [];
    const masterDivisions = app1Data.divisions || {};
    const masterAvailableDivs = app1Data.availableDivisions || [];
    const masterSpecials = app1Data.specialActivities || [];
    
    const masterLeagues = globalSettings.leaguesByName || {};
    const masterSpecialtyLeagues = globalSettings.specialtyLeagues || {};
    
    const dailyData = window.loadCurrentDailyData?.() || {};
    
    const dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
    
    // --- UPDATED: Load new daily overrides ---
    const dailyOverrides = dailyData.overrides || {};
    const disabledLeagues = dailyOverrides.leagues || [];
    const disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
    const dailyDisabledSportsByField = dailyData.dailyDisabledSportsByField || {};
    const disabledFields = dailyOverrides.disabledFields || []; 
    const disabledSpecials = dailyOverrides.disabledSpecials || []; 
    
    // --- NEW: Load Smart Scheduler History ---
    const rotationHistory = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };
    
    const overrides = {
        bunks: dailyOverrides.bunks || [],
        leagues: disabledLeagues,
    };

    const availableDivisions = masterAvailableDivs.filter(divName => !overrides.bunks.includes(divName));

    const divisions = {};
    for (const divName of availableDivisions) {
        if (!masterDivisions[divName]) continue;
        divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
        divisions[divName].bunks = (divisions[divName].bunks || []).filter(bunkName => !overrides.bunks.includes(bunkName));
    }
    
    // --- Renamed helper, was parseTimeRule ---
    function parseRule(rule) {
        // We no longer parse time to minutes here.
        // The isTimeAvailable function will do it.
        return {
            type: rule.type,
            start: rule.start,
            end: rule.end
        };
    }
    
    const activityProperties = {};
    // --- NEW: Filter master lists by daily overrides FIRST ---
    const allMasterActivities = [
        ...masterFields.filter(f => !disabledFields.includes(f.name)),
        ...masterSpecials.filter(s => !disabledSpecials.includes(s.name))
    ];
    
    const availableActivityNames = [];

    allMasterActivities.forEach(f => {
        let finalRules;
        const dailyRules = dailyFieldAvailability[f.name];
        
        if (dailyRules && dailyRules.length > 0) {
            finalRules = dailyRules.map(parseRule).filter(Boolean);
        } else {
            finalRules = (f.timeRules || []).map(parseRule).filter(Boolean);
        }

        const isMasterAvailable = f.available !== false; 

        activityProperties[f.name] = {
            available: isMasterAvailable,
            sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
            // --- This logic was the bug. It's now fixed. ---
            // If divisions are specified, use them.
            // Otherwise, allowedDivisions is an empty array.
            // `canBlockFit` will *not* use this to block.
            // The *new* logic in `canBlockFit` handles cross-division sharing.
            allowedDivisions: (f.sharableWith?.divisions?.length > 0) ? f.sharableWith.divisions : [],
            limitUsage: f.limitUsage || { enabled: false, divisions: {} },
            timeRules: finalRules // Pass the raw rules {type, start, end}
        };

        if (isMasterAvailable) {
            availableActivityNames.push(f.name);
        }
    });

    window.allSchedulableNames = availableActivityNames;
    // Filter availFields/Specials by the *already filtered* activity names
    const availFields = masterFields.filter(f => availableActivityNames.includes(f.name));
    const availSpecials = masterSpecials.filter(s => availableActivityNames.includes(s.name));
    
    // --- NEW: Filter available sports based on daily overrides ---
    const fieldsBySport = {};
    availFields.forEach(f => {
        if (Array.isArray(f.activities)) {
            f.activities.forEach(sport => {
                // NEW CHECK: See if this sport is disabled on this field *for today*
                const isDisabledToday = dailyDisabledSportsByField[f.name]?.includes(sport);
                
                if (!isDisabledToday) {
                    fieldsBySport[sport] = fieldsBySport[sport] || [];
                    fieldsBySport[sport].push(f.name);
                }
            });
        }
    });

    // Filter allActivities
    const allActivities = [
        ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f.name, sport: act })))
            // NEW CHECK: Filter out sports that are disabled for this field today
            .filter(a => !a.sport || !dailyDisabledSportsByField[a.field]?.includes(a.sport)),
        ...availSpecials.map((sa) => ({ type: "special", field: sa.name, sport: null }))
    ];
    
    const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);
    
    const yesterdayData = window.loadPreviousDailyData?.() || {};
    const yesterdayHistory = {
        schedule: yesterdayData.scheduleAssignments || {},
        leagues: yesterdayData.leagueAssignments || {}
    };
    
    return {
        divisions,
        availableDivisions,
        activityProperties,
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        masterSpecialtyLeagues,
        yesterdayHistory,
        rotationHistory, // NEW: Smart Scheduler
        disabledLeagues,
        disabledSpecialtyLeagues
    };
}
// --- END OF UPDATED FUNCTION ---

})();
