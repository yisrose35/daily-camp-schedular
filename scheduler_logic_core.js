// -------------------- scheduler_logic_core.js --------------------
// This file is now the "OPTIMIZER"
//
// UPDATED:
// - **CRITICAL FIX (League Overrides)**:
//   - `loadAndFilterData` now loads `disabledLeagues` and
//     `disabledSpecialtyLeagues` from the daily data.
//   - (Pass 3) `runSkeletonOptimizer` now checks the
//     `disabledLeagues` list before scheduling a regular league.
//   - (Pass 3.5) `runSkeletonOptimizer` now checks the
//     `disabledSpecialtyLeagues` list before scheduling a
//     specialty league.
// - (Previous time-rule fixes remain)
// -----------------------------------------------------------------

(function() {
'use strict';

// ===== CONFIG =====
const INCREMENT_MINS = 30; // The base grid resolution
window.INCREMENT_MINS = INCREMENT_MINS; // Expose for filler.js

// ===== Helpers =====
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
 */
window.runSkeletonOptimizer = function(manualSkeleton) {
    window.scheduleAssignments = {}; 
    window.leagueAssignments = {}; 
    window.unifiedTimes = []; 
    
    if (!manualSkeleton || manualSkeleton.length === 0) {
        return false; 
    }
    
    // --- UPDATED: Load new disabledLeague lists ---
    const { 
        divisions, 
        availableDivisions,
        activityProperties, // This now contains resolved time rules
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        masterSpecialtyLeagues,
        yesterdayHistory,
        disabledLeagues, // <-- NEW
        disabledSpecialtyLeagues // <-- NEW
    } = loadAndFilterData();
    
    let fieldUsageBySlot = {}; 
    
    // ===== PASS 1: Generate Master Time Grid =====
    let earliestMin = 1440; 
    let latestMin = 0;
    manualSkeleton.forEach(item => {
        const start = parseTimeToMinutes(item.startTime);
        const end = parseTimeToMinutes(item.endTime);
        if (start != null && start < earliestMin) earliestMin = start;
        if (end != null && end > latestMin) latestMin = end;
    });
    if (earliestMin === 1440 || latestMin === 0) {
        earliestMin = 540; latestMin = 960; 
    }
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

    // ===== PASS 3: NEW "League Pass" (REWRITTEN) =====
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
        
        // --- UPDATED: Check disabledLeagues list ---
        const leagueEntry = Object.entries(masterLeagues).find(([name, l]) => 
            l.enabled && 
            !disabledLeagues.includes(name) && // <-- THIS CHECK IS NEW
            l.divisions.includes(group.divName)
        );
        
        if (!leagueEntry) return;
        
        const divLeagueName = leagueEntry[0];
        const divLeague = leagueEntry[1];
        const leagueTeams = (divLeague.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (leagueTeams.length === 0) return;
        const sports = Array.isArray(divLeague.sports) && divLeague.sports.length ? divLeague.sports : ["League"];
        let matchups = [];
        if (typeof window.getLeagueMatchups === 'function') {
            matchups = window.getLeagueMatchups(divLeagueName, leagueTeams) || [];
        } else {
            matchups = pairRoundRobin(leagueTeams);
        }
        const allBunksInGroup = Array.from(group.bunks);
        const scheduledGames = []; 
        let gameIndex = 0;
        const blockBase = { slots: group.slots, divName: group.divName };

        for (const [teamA, teamB] of matchups) {
            if (teamA === "BYE" || teamB === "BYE") continue;
            const sport = sports[gameIndex % sports.length];
            gameIndex++;
            const possibleFields = fieldsBySport[sport] || [];
            let fieldName = null;
            
            for (const f of possibleFields) {
                if (canBlockFit(blockBase, f, activityProperties, fieldUsageBySlot)) {
                    fieldName = f; break;
                }
            }
            if (!fieldName) {
                for (const f of window.allSchedulableNames) {
                    if (canBlockFit(blockBase, f, activityProperties, fieldUsageBySlot)) {
                        fieldName = f; break;
                    }
                }
            }
            
            const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;
            let pick;
            if (fieldName) {
                pick = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null };
                markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
            } else {
                pick = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null };
            }
            scheduledGames.push(pick);
        }
        
        allBunksInGroup.forEach((bunk, bunkIndex) => {
            let pickToAssign;
            if (scheduledGames.length > 0) pickToAssign = scheduledGames[bunkIndex % scheduledGames.length];
            else pickToAssign = { field: "Leagues", sport: null, _h2h: true };
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
        
        // --- UPDATED: Check disabledSpecialtyLeagues list ---
        const leagueEntry = Object.values(masterSpecialtyLeagues).find(l => 
            l.enabled && 
            !disabledSpecialtyLeagues.includes(l.name) && // <-- THIS CHECK IS NEW
            l.divisions.includes(group.divName)
        );
        
        if (!leagueEntry) return; 

        const sport = leagueEntry.sport;
        const leagueFields = leagueEntry.fields || [];
        const leagueTeams = (leagueEntry.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (!sport || leagueFields.length === 0 || leagueTeams.length < 2) return;
        let matchups = [];
        if (typeof window.getLeagueMatchups === 'function') {
            matchups = window.getLeagueMatchups(leagueEntry.name, leagueTeams) || [];
        } else {
            matchups = pairRoundRobin(leagueTeams); // Failsafe
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
            if (fieldName) {
                pick = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null };
                markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
            } else {
                pick = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null };
            }
            scheduledGames.push(pick);
        }
        allBunksInGroup.forEach((bunk, bunkIndex) => {
            let pickToAssign;
            if (scheduledGames.length > 0) pickToAssign = scheduledGames[bunkIndex % scheduledGames.length];
            else pickToAssign = { field: "Specialty League", sport: null, _h2h: true };
            fillBlock({ ...blockBase, bunk: bunk }, pickToAssign, fieldUsageBySlot, yesterdayHistory, true);
        });
    });


    // ===== PASS 4: Fill remaining Schedulable Slots =====
    remainingBlocks.sort((a, b) => a.startTime - b.startTime);

    for (const block of remainingBlocks) {
        if (block.slots.length === 0 || window.scheduleAssignments[block.bunk][block.slots[0]]) {
            continue;
        }
        let pick = null;
        if (block.event === 'Special Activity') {
            pick = window.findBestSpecial?.(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties);
        } else if (block.event === 'Sports Slot') {
            pick = window.findBestSportActivity?.(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties);
        } else if (block.event === 'Swim') {
            pick = { field: "Swim", sport: null }; 
        }
        if (!pick) {
            pick = window.findBestGeneralActivity?.(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties);
        }
        if (pick) {
            fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, false);
        } else {
            fillBlock(block, { field: "Free", sport: null }, fieldUsageBySlot, yesterdayHistory, false);
        }
    }
    
    // ===== PASS 5: Save unifiedTimes and Update the UI =====
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
function markFieldUsage(block, fieldName, fieldUsageBySlot) {
    if (!fieldName || fieldName === "No Field" || !window.allSchedulableNames.includes(fieldName)) {
        return;
    }
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) continue;
        fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
        fieldUsageBySlot[slotIndex][fieldName] = (fieldUsageBySlot[slotIndex][fieldName] || 0) + 1;
    }
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
    const slotEndMin = slotStartMin + INCREMENT_MINS; 
    
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
 * UPDATED: This function now checks time-based availability.
 */
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = (props && props.sharable) ? 2 : 1;

    // Check 1: Division allowance
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;

    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) return false; 
        
        // Check 2: Usage per slot
        const used = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        if (used >= limit) return false;
        
        // Check 3: NEW: Time-based availability
        if (!isTimeAvailable(slotIndex, props)) {
            return false; // This slot is blocked by an override
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
                vs: pick.vs || null
            };
            
            if (!isLeagueFill && fieldName && window.allSchedulableNames.includes(fieldName)) {
                fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
                fieldUsageBySlot[slotIndex][fieldName] = (fieldUsageBySlot[slotIndex][fieldName] || 0) + 1;
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
 * UPDATED: This function is rewritten to process new `timeRules`
 * and load the new `disabled...` league lists.
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
    
    // --- NEW: Load daily availability rules ---
    const dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
    
    // --- NEW: Load daily disabled leagues ---
    const loadedOverrides = dailyData.overrides || {};
    const disabledLeagues = loadedOverrides.leagues || [];
    const disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
    
    const overrides = {
        bunks: loadedOverrides.bunks || [],
        leagues: disabledLeagues // Pass this along
    };

    const availableDivisions = masterAvailableDivs.filter(divName => !overrides.bunks.includes(divName));

    const divisions = {};
    for (const divName of availableDivisions) {
        if (!masterDivisions[divName]) continue;
        divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
        divisions[divName].bunks = (divisions[divName].bunks || []).filter(bunkName => !overrides.bunks.includes(bunkName));
    }
    
    // --- NEW: Helper to parse rule strings into minutes ---
    function parseTimeRule(rule) {
        const startMin = parseTimeToMinutes(rule.start);
        const endMin = parseTimeToMinutes(rule.end);
        if (startMin == null || endMin == null) return null;
        return {
            type: rule.type,
            startMin: startMin,
            endMin: endMin
        };
    }
    
    // --- NEW: Build final, resolved properties for all activities ---
    const activityProperties = {};
    const allMasterActivities = masterFields.concat(masterSpecials);
    const availableActivityNames = [];

    allMasterActivities.forEach(f => {
        let finalRules;
        
        // Check for a daily override. If it exists, use it.
        const dailyRules = dailyFieldAvailability[f.name];
        
        if (dailyRules && dailyRules.length > 0) {
            // A daily override exists! Use it.
            finalRules = dailyRules.map(parseTimeRule).filter(Boolean);
        } else {
            // No daily override. Use the global rules.
            finalRules = (f.timeRules || []).map(parseTimeRule).filter(Boolean);
        }

        // The master "available" toggle from app1.js
        const isMasterAvailable = f.available !== false; 

        activityProperties[f.name] = {
            available: isMasterAvailable, // The master toggle
            sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
            allowedDivisions: (f.sharableWith?.divisions?.length > 0) ? f.sharableWith.divisions : availableDivisions,
            limitUsage: f.limitUsage,
            timeRules: finalRules // The parsed list of {type, startMin, endMin}
        };

        // Determine if this field is available *at all* today
        if (isMasterAvailable) {
            availableActivityNames.push(f.name);
        }
    });

    window.allSchedulableNames = availableActivityNames;
    const availFields = masterFields.filter(f => availableActivityNames.includes(f.name));
    const availSpecials = masterSpecials.filter(s => availableActivityNames.includes(s.name));
    // --- END OF NEW PROPERTY BUILDER ---

    const fieldsBySport = {};
    availFields.forEach(f => {
        if (Array.isArray(f.activities)) {
            f.activities.forEach(sport => {
                fieldsBySport[sport] = fieldsBySport[sport] || [];
                fieldsBySport[sport].push(f.name);
            });
        }
    });

    const allActivities = [
        ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f.name, sport: act }))),
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
        activityProperties, // This is now the resolved, final list
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        masterSpecialtyLeagues,
        yesterdayHistory,
        disabledLeagues, // <-- NEW
        disabledSpecialtyLeagues // <-- NEW
    };
}
// --- END OF UPDATED FUNCTION ---

})();
