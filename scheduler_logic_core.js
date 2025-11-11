// =================================================================
// scheduler_logic_core.js
//
// UPDATED:
// - **CRITICAL BUG FIX 1 (The "No Field" bug):**
//   - `canBlockFit` was checking both `allowedDivisions` (from
//     sharing) and `limitUsage.divisions`. This was conflicting
//     and causing no fields to be found.
//   - I have **removed** the redundant `allowedDivisions` check.
//     The `limitUsage` ("Allowed Divisions/Bunks") is now the
//     single source of truth for this, as intended.
// - **CRITICAL BUG FIX 2 (The "Free" Slots bug):**
//   - `findSlotsForRange` was only checking if a slot *started*
//     within a block. This failed for short blocks like "Snacks".
//   - It is now fixed to find all slots that *overlap* with the
//     block, which will correctly find slots for "Snacks",
//     "Dismissal", and "Leagues".
// =================================================================

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
        disabledLeagues,
        disabledSpecialtyLeagues
    } = loadAndFilterData();
    
    let fieldUsageBySlot = {}; 
    
    // ===== PASS 1: Generate Master Time Grid =====
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const globalStart = app1Data.globalStartTime || "9:00 AM";
    const globalEnd = app1Data.globalEndTime || "4:00 PM";
    
    let earliestMin = parseTimeToMinutes(globalStart);
    let latestMin = parseTimeToMinutes(globalEnd);

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
        const allSlots = findSlotsForRange(startMin, endMin); // <-- This now works
        
        if (allSlots.length === 0) {
            console.warn(`No slots found for ${item.event} (${item.startTime} - ${item.endTime})`);
        }

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

    // (Reverting to non-rotation logic as requested)
    // let leagueSportRotationIndex = window.currentDailyData?.leagueSportRotationIndex || {};

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
        
        const availableLeagueSports = (divLeague.sports || []).filter(s => fieldsBySport[s]);
        const sports = availableLeagueSports.length > 0 ? availableLeagueSports : ["League"];
        
        let matchups = [];
        if (typeof window.getLeagueMatchups === 'function') {
            matchups = window.getLeagueMatchups(divLeagueName, leagueTeams) || [];
        } else {
            matchups = pairRoundRobin(leagueTeams);
        }
        const allBunksInGroup = Array.from(group.bunks);
        const scheduledGames = []; 
        
        let gameIndex = 0; // (Reverted to simple index)
        
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
            if (!fieldName && sport !== "League") { 
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
        
        // (Reverted: no longer saves sport index)
        
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
            
            if (fieldName && canBlockFit(blockBase, fieldName, activityProperties, fieldUsageBySlot)) {
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
    
    // (Reverted: no longer saves sport index)
    
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes); 
    window.updateTable?.();
    window.saveSchedule?.(); 
    return true; 
}

// --- Helper functions for Pass 3 & 4 ---

// --- CRITICAL BUG FIX (The "Free" Slots bug) ---
/**
 * Finds all slot indices that OVERLAP with a given time range.
 * @param {number} startMin The start of the block (in minutes).
 * @param {number} endMin The end of the block (in minutes).
 */
function findSlotsForRange(startMin, endMin) {
    const slots = [];
    // Failsafe for invalid skeleton blocks
    if (startMin == null || endMin == null || !window.unifiedTimes) return slots;
    
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
        const slotEndMin = slotStartMin + INCREMENT_MINS;
        
        // Overlap check: (Block Start < Slot End) and (Block End > Slot Start)
        if (startMin < slotEndMin && endMin > slotStartMin) {
            slots.push(i);
        }
    }
    return slots;
}
// --- END BUG FIX ---

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
function isTimeAvailable(slotIndex, fieldProps) {
    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    
    const slot = window.unifiedTimes[slotIndex];
    const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotEndMin = slotStartMin + INCREMENT_MINS; 
    
    const rules = fieldProps.timeRules || [];
    
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
 * UPDATED: This function now checks time-based availability
 * AND the new bunk/division limits.
 */
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = (props && props.sharable) ? 2 : 1;

    // --- CRITICAL BUG FIX (The "No Field" bug) ---
    // The `allowedDivisions` check (from "Sharing") was conflicting
    // with the `limitUsage` check (from "Allowed Divisions/Bunks").
    // The `limitUsage` check is the correct one to use.
    
    // Check 1: Bunk/Division Limit (from limitUsage)
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
                // This is a league pass (no bunk). We'll allow it.
            } else if (!allowedBunks.includes(block.bunk)) {
                // This is a specific bunk, and it's NOT in the list
                return false;
            }
        }
    }
    // --- END BUG FIX ---

    // Check 2 & 3: Usage per slot & Time-based availability
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) return false; 
        
        // Check 2: Usage per slot
        const used = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        if (used >= limit) return false;
        
        // Check 3: Time-based availability
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
    
    const dailyOverrides = dailyData.overrides || {};
    const disabledLeagues = dailyOverrides.leagues || [];
    const disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
    const dailyDisabledSportsByField = dailyData.dailyDisabledSportsByField || {};
    const disabledFields = dailyOverrides.disabledFields || []; 
    const disabledSpecials = dailyOverrides.disabledSpecials || []; 
    
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
    
    const activityProperties = {};
    const allMasterActivities = [
        ...masterFields.filter(f => !disabledFields.includes(f.name)),
        ...masterSpecials.filter(s => !disabledSpecials.includes(s.name))
    ];
    
    const availableActivityNames = [];

    allMasterActivities.forEach(f => {
        let finalRules;
        const dailyRules = dailyFieldAvailability[f.name];
        
        if (dailyRules && dailyRules.length > 0) {
            finalRules = dailyRules.map(parseTimeRule).filter(Boolean);
        } else {
            finalRules = (f.timeRules || []).map(parseTimeRule).filter(Boolean);
        }

        const isMasterAvailable = f.available !== false; 

        activityProperties[f.name] = {
            available: isMasterAvailable,
            sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
            // This 'allowedDivisions' is from the "Sharing" section, which is a legacy
            // check. The main check is now `limitUsage`.
            allowedDivisions: (f.sharableWith?.divisions?.length > 0) ? f.sharableWith.divisions : availableDivisions,
            limitUsage: f.limitUsage || { enabled: false, divisions: {} },
            timeRules: finalRules
        };

        if (isMasterAvailable) {
            availableActivityNames.push(f.name);
        }
    });

    window.allSchedulableNames = availableActivityNames;
    const availFields = masterFields.filter(f => availableActivityNames.includes(f.name));
    const availSpecials = masterSpecials.filter(s => availableActivityNames.includes(s.name));
    
    const fieldsBySport = {};
    availFields.forEach(f => {
        if (Array.isArray(f.activities)) {
            f.activities.forEach(sport => {
                const isDisabledToday = dailyDisabledSportsByField[f.name]?.includes(sport);
                
                if (!isDisabledToday) {
                    fieldsBySport[sport] = fieldsBySport[sport] || [];
                    fieldsBySport[sport].push(f.name);
                }
            });
        }
    });

    const allActivities = [
        ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f.name, sport: act })))
            .filter(a => !a.sport || !dailyDisabledSportsByField[a.field]?.includes(a.sport)),
        ...availSpecials.map((sa) => ({ type: "special", field: sa.name, sport: null }))
    ];
    
    const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);
    
    // (Reverted: No longer loads 7-day history)
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
        disabledLeagues,
        disabledSpecialtyLeagues
    };
}
// --- END OF UPDATED FUNCTION ---

})();
