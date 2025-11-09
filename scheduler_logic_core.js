// -------------------- scheduler_logic_core.js --------------------
// This file is now the "OPTIMIZER"
// It reads the "manualSkeleton" built by the user and
// fills in the "slot" types.
//
// UPDATED:
// - Added a dedicated "League Pass" (Pass 3) to handle
//   league matchups *before* other activities.
// - This pass correctly pairs teams and places them on fields/time slots.
// - Fixed "fieldUsageBySlot is not defined" error.
// - Removed dependency on window.findBestGeneralActivity.canBlockFit by adding a local canBlockFit.
// -----------------------------------------------------------------

(function() {
'use strict';

// ===== CONFIG =====
const INCREMENT_MINS = 30; // The base grid resolution

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
    console.log("Starting Skeleton Optimizer...");
    window.scheduleAssignments = {}; // { bunk: [ {entry}, {entry} ... ] }
    window.leagueAssignments = {}; // Clear this
    window.unifiedTimes = []; // The 30-min grid
    
    if (!manualSkeleton || manualSkeleton.length === 0) {
        console.warn("Optimizer: No skeleton to run.");
    }
    
    const { 
        divisions, 
        availableDivisions,
        activityProperties,
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        yesterdayHistory
    } = loadAndFilterData();
    
    let fieldUsageBySlot = {}; // { 0: { "Court 1": 1, "Court 2": 2}, 1: ... }
    
    // ===== PASS 1: Generate Master Time Grid =====
    let earliestMin = 540; // 9:00 AM
    let latestMin = 960; // 4:00 PM
    availableDivisions.forEach(divName => {
        const timeline = divisions[divName]?.timeline;
        if (timeline) {
            earliestMin = Math.min(earliestMin, parseTimeToMinutes(timeline.start) || 540);
            latestMin = Math.max(latestMin, parseTimeToMinutes(timeline.end) || 960);
        }
    });

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
        console.warn("No time slots generated. Check division Start/End times.");
        window.updateTable?.();
        return false;
    }
    console.log(`Generated ${window.unifiedTimes.length} time slots.`);

    // Initialize all bunks with empty arrays for the new grid
    availableDivisions.forEach(divName => {
        (divisions[divName]?.bunks || []).forEach(bunk => {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
        });
    });

    // ===== PASS 2: Place all "Pinned" Events from the Skeleton =====
    const schedulableSlotBlocks = []; // The "slots" we need to fill
    
    manualSkeleton.forEach(item => {
        const bunks = divisions[item.division]?.bunks || [];
        if (!bunks) {
            console.warn(`Division "${item.division}" in skeleton not found in setup.`);
            return;
        }
        const startMin = parseTimeToMinutes(item.startTime);
        const endMin = parseTimeToMinutes(item.endTime);
        const slots = findSlotsForRange(startMin, endMin);

        if (item.type === 'pinned') {
            // This is a "Pinned" event like Lunch or Snacks.
            slots.forEach((slotIndex, idx) => {
                bunks.forEach(bunk => {
                    if (!window.scheduleAssignments[bunk][slotIndex]) {
                        window.scheduleAssignments[bunk][slotIndex] = {
                            field: { name: item.event },
                            sport: null,
                            continuation: (idx > 0),
                            _fixed: true
                        };
                    }
                });
            });
        } else if (item.type === 'slot') {
            // This is a "Schedulable Slot"
            bunks.forEach(bunk => {
                schedulableSlotBlocks.push({
                    divName: item.division,
                    bunk: bunk,
                    event: item.event, // e.g., "General Activity Slot", "League Game"
                    startTime: startMin,
                    endTime: endMin,
                    slots: slots
                });
            });
        }
    });
    console.log(`Pass 2: Placed all 'Pinned' events. Ready to fill ${schedulableSlotBlocks.length} bunk-slots.`);

    // ===== PASS 3: NEW "League Pass" (ACTUAL FIELD/TIME PLACEMENT) =====
    // Strategy:
    // 1) Group league blocks by division+start (so we schedule simultaneous league waves).
    // 2) For each group, pair bunks into matchups (use window.getLeagueMatchups if present; else round-robin).
    // 3) For each matchup, find an available field (by sport) that can fit in all its slots.
    // 4) Place both sides (A and B) onto the same field/time cells. Update fieldUsageBySlot.

    const leagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'League Game');
    const remainingBlocks = schedulableSlotBlocks.filter(b => b.event !== 'League Game');
    
    // Group league blocks by division and group time window (use startTime as the grouping key)
    const leagueGroups = {};
    leagueBlocks.forEach(block => {
        const key = `${block.divName}-${block.startTime}`;
        if (!leagueGroups[key]) {
            leagueGroups[key] = {
                divName: block.divName,
                startTime: block.startTime,
                slots: block.slots,
                bunks: new Set()
            };
        }
        leagueGroups[key].bunks.add(block.bunk);
    });

    Object.values(leagueGroups).forEach(group => {
        const bunksSet = Array.from(group.bunks);
        if (bunksSet.length < 2) return; // nothing to schedule

        // Find the league for this division (enabled + includes division)
        const divLeague = Object.values(masterLeagues).find(l => l.enabled && l.divisions.includes(group.divName));
        if (!divLeague) return;

        // Sports rotation (e.g., Basketball, Hockey, etc.)
        const sports = Array.isArray(divLeague.sports) && divLeague.sports.length ? divLeague.sports : ["League"];

        // Today's matchups:
        // If window.getLeagueMatchups is provided, use it; else create fair pairs within this group.
        // Expect matchups as array of [teamA, teamB] strings.
        let matchups = [];
        const teams = (divLeague.teams || []).map(t => String(t).trim()).filter(Boolean);

        if (typeof window.getLeagueMatchups === 'function') {
            // Use global matchups, then filter to pairs where both teams are in this time group
            const allMatchups = window.getLeagueMatchups(divLeague.name, teams) || [];
            const groupSet = new Set(bunksSet.map(String));
            matchups = allMatchups.filter(([a,b]) => groupSet.has(String(a)) && groupSet.has(String(b)));
        } else {
            // No global matcher: build a simple in-group round-robin for the wave
            matchups = pairRoundRobin(bunksSet); // returns [[A,B], [C,D], ...]
        }

        // Remove any duplicates and ensure teams are available (not yet placed in this wave)
        const scheduledTeams = new Set();
        let gameIndex = 0;

        for (const [A, B] of matchups) {
            if (scheduledTeams.has(A) || scheduledTeams.has(B)) continue; // already paired this wave

            // Pick sport rotating through list
            const sport = sports[gameIndex % sports.length];
            gameIndex++;

            // Allowed fields for this sport
            const possibleFields = fieldsBySport[sport] || [];

            // Find a field that can fit across all slots of this block for both teams
            let fieldName = null;
            for (const f of possibleFields) {
                if (canBlockFit({ slots: group.slots, divName: group.divName }, f, activityProperties, fieldUsageBySlot)) {
                    fieldName = f;
                    break;
                }
            }
            if (!fieldName) {
                // Try any general field (fallback)
                for (const f of window.allSchedulableNames) {
                    if (canBlockFit({ slots: group.slots, divName: group.divName }, f, activityProperties, fieldUsageBySlot)) {
                        fieldName = f;
                        break;
                    }
                }
            }
            if (!fieldName) {
                console.warn(`No field available for ${group.divName} league game: ${A} vs ${B}`);
                continue;
            }

            // Place both sides
            const blockBase = { slots: group.slots, divName: group.divName };
            const pickA = { field: fieldName, sport: `${sport} vs ${B}`, _h2h: true, vs: B };
            const pickB = { field: fieldName, sport: `${sport} vs ${A}`, _h2h: true, vs: A };

            fillBlock({ ...blockBase, bunk: A }, pickA, fieldUsageBySlot, yesterdayHistory);
            fillBlock({ ...blockBase, bunk: B }, pickB, fieldUsageBySlot, yesterdayHistory);

            scheduledTeams.add(A);
            scheduledTeams.add(B);
        }
    });
    console.log("Pass 3: Placed all 'League Game' events with concrete fields & times.");

    // ===== PASS 4: Fill remaining Schedulable Slots =====
    
    // Sort all blocks by start time to process the day chronologically
    remainingBlocks.sort((a, b) => a.startTime - b.startTime);

    for (const block of remainingBlocks) {
        // Skip if this block has already been filled (e.g., by a League H2H)
        if (block.slots.length === 0 || window.scheduleAssignments[block.bunk][block.slots[0]]) continue;
        
        let pick = null;

        // --- 4a. Check the *type* of slot ---
        if (block.event === 'Special Activity') {
            pick = window.findBestSpecial?.(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties);
        } else if (block.event === 'Swim') {
            pick = { field: "Swim", sport: null }; // Simple pick
        }
        
        // --- 4b. Fill with "General Activity" ---
        if (!pick) {
            // Default to General Activity
            pick = window.findBestGeneralActivity?.(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties);
        }

        // --- 4c. Place the chosen activity ---
        if (pick) {
            fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory);
        } else {
            // Failsafe: just put "Free"
            fillBlock(block, { field: "Free", sport: null }, fieldUsageBySlot, yesterdayHistory);
        }
    }
    console.log("Pass 4: Optimized and filled all remaining slots.");
    
    // ===== PASS 5: Save unifiedTimes and Update the UI =====
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes); // Save the generated grid!
    window.updateTable?.();
    window.saveSchedule?.(); // This function is in scheduler_ui.js
    console.log("Schedule Generation Complete.");
    return true; // Success
}

// --- Helper functions for Pass 3 & 4 ---

function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes) return slots;
    
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStart = slot.start.getHours() * 60 + slot.start.getMinutes();
        
        // A slot is "in" if its start time is in the range
        if (slotStart >= startMin && slotStart < endMin) {
            slots.push(i);
        }
    }
    return slots;
}

/**
 * Check whether a block (set of slots) can be placed on a field, respecting:
 * - Field usage limits per slot (limitUsage)
 * - Allowed divisions for that field/special
 */
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    const props = activityProperties[fieldName];
    const allowedDivs = props?.allowedDivisions || [];
    // FIX: Default limit is 1 (or 2 for sharable), not a number from props.
    // This logic needs to be more robust, but for now:
    const limit = (props && props.sharable) ? 2 : 1;

    // Division allowance
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;

    // Usage per slot
    for (const slotIndex of block.slots) {
        const used = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        if (used >= limit) return false;
    }
    return true;
}

function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory) {
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
            
            if (fieldName && window.allSchedulableNames.includes(fieldName)) {
                fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
                fieldUsageBySlot[slotIndex][fieldName] = (fieldUsageBySlot[slotIndex][fieldName] || 0) + 1;
            }
        }
    });
}

/**
 * Simple pairing for an in-wave round-robin:
 * If odd, last team BYE. Returns array of [A,B] pairs without duplicates.
 */
function pairRoundRobin(teamList) {
    const arr = teamList.map(String);
    if (arr.length < 2) return [];
    if (arr.length % 2 === 1) arr.push("BYE");

    const n = arr.length;
    const half = n / 2;
    const rounds = [];

    // One round is enough for a single wave; but to remain stable, use first round
    const firstRoundPairs = [];
    for (let i = 0; i < half; i++) {
        const A = arr[i], B = arr[n - 1 - i];
        if (A !== "BYE" && B !== "BYE") firstRoundPairs.push([A, B]);
    }
    return firstRoundPairs;
}

function loadAndFilterData() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const masterFields = app1Data.fields || [];
    const masterDivisions = app1Data.divisions || {};
    const masterAvailableDivs = app1Data.availableDivisions || [];
    const masterSpecials = app1Data.specialActivities || [];
    const masterLeagues = globalSettings.leaguesByName || {};
    
    const dailyData = window.loadCurrentDailyData?.() || {};
    const loadedOverrides = dailyData.overrides || {};
    const overrides = {
        fields: loadedOverrides.fields || [],
        bunks: loadedOverrides.bunks || [],
        leagues: loadedOverrides.leagues || []
    };

    // Filter all data based on overrides
    const availFields = masterFields.filter(f => f.available && !overrides.fields.includes(f.name));
    const availSpecials = masterSpecials.filter(s => s.available && !overrides.fields.includes(s.name));
    const availableDivisions = masterAvailableDivs.filter(divName => !overrides.bunks.includes(divName));

    const divisions = {};
    for (const divName of availableDivisions) {
        if (!masterDivisions[divName]) continue;
        divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
        divisions[divName].bunks = (divisions[divName].bunks || []).filter(bunkName => !overrides.bunks.includes(bunkName));
    }
    
    // Build activity properties map
    const activityProperties = {};
    availFields.forEach(f => {
         activityProperties[f.name] = {
            sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
            allowedDivisions: (f.sharableWith?.divisions?.length > 0) ? f.sharableWith.divisions : availableDivisions,
            limitUsage: f.limitUsage
        };
    });
    availSpecials.forEach(s => {
         activityProperties[s.name] = {
            sharable: s.sharableWith?.type === 'all' || s.sharableWith?.type === 'custom',
            allowedDivisions: (s.sharableWith?.divisions?.length > 0) ? s.sharableWith.divisions : availableDivisions,
            limitUsage: s.limitUsage
        };
    });

    // Build field-sport inventory
    const fieldsBySport = {};
    const allFieldNames = [];
    availFields.forEach(f => {
        allFieldNames.push(f.name);
        if (Array.isArray(f.activities)) {
            f.activities.forEach(sport => {
                fieldsBySport[sport] = fieldsBySport[sport] || [];
                fieldsBySport[sport].push(f.name);
            });
        }
    });
    window.allSchedulableNames = allFieldNames.concat(availSpecials.map(s => s.name));

    const allActivities = [
        ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f.name, sport: act }))),
        ...availSpecials.map((sa) => ({ type: "special", field: sa.name, sport: null }))
    ];
    const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);
    
    // Load Yesterday's History (for "freshness")
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
        yesterdayHistory
    };
}

})();
