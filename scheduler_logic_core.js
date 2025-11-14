// =================================================================
// scheduler_logic_core.js
//
// ... (previous changelogs) ...
//
// --- NEW FEATURE (Bunk-Specific Overrides) ---
// - **NEW: Pass 1.5** has been added.
// - This new pass runs immediately after the time grid is
//   created (Pass 1) and before the skeleton's pinned
//   events are placed (Pass 2).
// - It loads the `bunkActivityOverrides` array from the
//   current day's data.
// - It iterates through this list and places each activity
//   directly onto the `window.scheduleAssignments` grid for
//   the specified bunk.
// - **CRITICAL:** It correctly sets `_fixed: true` and
//   `_activity: override.activity` on the new entry. This
//   ensures it fully integrates with the "smart scheduler"
//   (preventing same-day repeats) and updates the
//   "freshness" history (Pass 5).
//
// --- FIX (League Scheduling Logic) ---
// - **REWRITTEN: Pass 3** no longer assumes Bunk Names
//   are the same as Team Names.
// - It now generates matchups (e.g., "Team A vs Team B")
//   and assigns them to pairs of available bunks
//   (e.g., Bunk "19" and Bunk "20") in sequential order.
// - This fixes the bug where 2nd and 3rd grade leagues
//   were not scheduling games.
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
rotationHistory,
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

// =================================================================
// ===== NEW: PASS 1.5: Place Bunk-Specific Pinned Activities =====
// =================================================================
try {
    const dailyData = window.loadCurrentDailyData?.() || {};
    const bunkOverrides = dailyData.bunkActivityOverrides || [];

    bunkOverrides.forEach(override => {
        const startMin = parseTimeToMinutes(override.startTime);
        const endMin = parseTimeToMinutes(override.endTime);
        const slots = findSlotsForRange(startMin, endMin);
        const bunk = override.bunk;

        // Ensure bunk exists in schedule and slots were found
        if (window.scheduleAssignments[bunk] && slots.length > 0) {
            slots.forEach((slotIndex, idx) => {
                // Only place if the slot is currently empty
                if (!window.scheduleAssignments[bunk][slotIndex]) {
                    window.scheduleAssignments[bunk][slotIndex] = {
                        field: { name: override.activity },
                        sport: null,
                        continuation: (idx > 0),
                        _fixed: true, // Mark as "fixed" so no other pass overwrites it
                        _h2h: false,
                        vs: null,
                        _activity: override.activity // CRITICAL: This integrates with smart scheduler
                    };
                }
            });
        }
    });
} catch (e) {
    console.error("Error placing bunk-specific overrides:", e);
}
// =================================================================
// ===== END: PASS 1.5 =====
// =================================================================


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
// Check if slot is NOT already filled by Pass 1.5
if (!window.scheduleAssignments[bunk][slotIndex]) {
window.scheduleAssignments[bunk][slotIndex] = { field: { name: item.event }, sport: null, continuation: (idx > 0), _fixed: true };
}
});
});
} else if (item.type === 'split') {
// ... (rest of Pass 2 logic unchanged) ...
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
// --- THIS SECTION IS REWRITTEN ---
const leagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'League Game');
const specialtyLeagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'Specialty League');
const remainingBlocks = schedulableSlotBlocks.filter(b => b.event !== 'League Game' && b.event !== 'Specialty League');

const leagueGroups = {};
leagueBlocks.forEach(block => {
const leagueEntry = Object.entries(masterLeagues).find(([name, l]) =>
l.enabled &&
!disabledLeagues.includes(name) &&
l.divisions.includes(block.divName)
);
if (!leagueEntry) return;
const divLeagueName = leagueEntry[0];
const divLeague = leagueEntry[1];
const key = `${divLeagueName}-${block.startTime}`;
if (!leagueGroups[key]) {
leagueGroups[key] = {
divLeagueName: divLeagueName,
divLeague: divLeague,
startTime: block.startTime,
slots: block.slots,
bunks: new Set()
};
}
leagueGroups[key].bunks.add(block.bunk);
});


const timestamp = Date.now();
const sortedLeagueGroups = Object.values(leagueGroups).sort((a, b) => a.startTime - b.startTime);

for (const group of sortedLeagueGroups) {
const divLeagueName = group.divLeagueName;
const divLeague = group.divLeague;
const leagueTeams = (divLeague.teams || []).map(t => String(t).trim()).filter(Boolean);
if (leagueTeams.length === 0) continue;

const availableLeagueSports = (divLeague.sports || []).filter(s => fieldsBySport[s]);
const leagueHistory = rotationHistory.leagues[divLeagueName] || {};
let matchups = [];
if (typeof window.getLeagueMatchups === 'function') {
matchups = window.getLeagueMatchups(divLeagueName, leagueTeams) || [];
} else {
matchups = pairRoundRobin(leagueTeams);
}

// Get all bunks for this group and sort them consistently
const allBunksInGroup = Array.from(group.bunks).sort();
let bunkIndex = 0; // Pointer for assigning bunks in pairs

let firstDivName = null;
if (allBunksInGroup.length > 0) {
const firstBunk = allBunksInGroup[0];
firstDivName = Object.keys(divisions).find(div => divisions[div].bunks.includes(firstBunk));
}
if (!firstDivName) continue;
const blockBase = { slots: group.slots, divName: firstDivName };

// Loop through each matchup
for (const [teamA, teamB] of matchups) {
if (teamA === "BYE" || teamB === "BYE") continue;

// Check if we have at least two bunks left to assign
if (bunkIndex + 1 >= allBunksInGroup.length) {
break; // Not enough bunks left for this matchup
}

// Get the next two bunks from the sorted list
const bunkA = allBunksInGroup[bunkIndex];
const bunkB = allBunksInGroup[bunkIndex + 1];
bunkIndex += 2; // Move the pointer for the next game

// Find the best field/sport for this matchup
const sortedSports = [...availableLeagueSports].sort((a, b) => {
const lastA = leagueHistory[a] || 0;
const lastB = leagueHistory[b] || 0;
return lastA - lastB;
});

let assigned = false;
let pickToAssign = null;

for (const sport of sortedSports) {
const possibleFields = fieldsBySport[sport] || [];
let fieldName = null;
for (const f of possibleFields) {
if (canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
fieldName = f;
break;
}
}
if (fieldName) {
const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;
pickToAssign = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
leagueHistory[sport] = timestamp;
assigned = true;
break;
}
}
if (!assigned) {
const fullMatchupLabel = `${teamA} vs ${teamB} (No Field)`;
pickToAssign = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null, _activity: "League" };
}

// Assign the game to both bunks
const bunkADiv = Object.keys(divisions).find(div => divisions[div].bunks.includes(bunkA));
const bunkBDiv = Object.keys(divisions).find(div => divisions[div].bunks.includes(bunkB));

if (bunkADiv) {
fillBlock({ slots: group.slots, bunk: bunkA, divName: bunkADiv }, pickToAssign, fieldUsageBySlot, yesterdayHistory, true);
}
if (bunkBDiv) {
fillBlock({ slots: group.slots, bunk: bunkB, divName: bunkBDiv }, pickToAssign, fieldUsageBySlot, yesterdayHistory, true);
}
}

// Assign "No Game" to any remaining bunks
while (bunkIndex < allBunksInGroup.length) {
const leftoverBunk = allBunksInGroup[bunkIndex];
const bunkDivName = Object.keys(divisions).find(div => divisions[div].bunks.includes(leftoverBunk));
if (bunkDivName) {
fillBlock({ slots: group.slots, bunk: leftoverBunk, divName: bunkDivName }, { field: "No Game", sport: null, _h2h: true, _activity: "League" }, fieldUsageBySlot, yesterdayHistory, true);
}
bunkIndex++;
}
}
// --- END OF REWRITTEN SECTION ---


// ===== PASS 3.5: NEW "Specialty League Pass" =====
const specialtyLeagueGroups = {};
specialtyLeagueBlocks.forEach(block => {
let key = `${block.divName}-${block.startTime}`; // Use let or const
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
const bunkToGameMap = {};
const blockBase = { slots: group.slots, divName: group.divName };
const gamesPerField = Math.ceil(matchups.length / leagueFields.length);

for (let i = 0; i < matchups.length; i++) {
const [teamA, teamB] = matchups[i];
if (teamA === "BYE" || teamB === "BYE") continue;

const fieldIndex = Math.floor(i / gamesPerField);
const fieldName = leagueFields[fieldIndex % leagueFields.length];
const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;
let pick;

if (fieldName && canLeagueGameFit(blockBase, fieldName, fieldUsageBySlot, activityProperties)) {
pick = { field: fieldName, sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
} else {
pick = { field: "No Field", sport: fullMatchupLabel, _h2h: true, vs: null, _activity: sport };
}
bunkToGameMap[teamA] = pick;
bunkToGameMap[teamB] = pick;
}

allBunksInGroup.forEach((bunk, bunkIndex) => {
const pickToAssign = bunkToGameMap[bunk];
if (pickToAssign) {
fillBlock({ ...blockBase, bunk: bunk }, pickToAssign, fieldUsageBySlot, yesterdayHistory, true);
} else {
fillBlock({ ...blockBase, bunk: bunk }, { field: "No Game", sport: null, _h2h: true, _activity: sport }, fieldUsageBySlot, yesterdayHistory, true);
}
});
});


// ===== PASS 4: Fill remaining Schedulable Slots (With Smart Shuffle) =====
remainingBlocks.sort((a, b) => a.startTime - b.startTime);

for (const block of remainingBlocks) {
// Check if slot is already filled by Pass 1.5
if (block.slots.length === 0 || window.scheduleAssignments[block.bunk][block.slots[0]]) {
continue;
}
let pick = null;

if (block.event === 'Special Activity') {
pick = window.findBestSpecial?.(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions);
} else if (block.event === 'Sports Slot') {
pick = window.findBestSportActivity?.(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions);
} else if (block.event === 'Swim') {
pick = { field: "Swim", sport: null, _activity: "Swim" };
}
if (!pick) {
pick = window.findBestGeneralActivity?.(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions);
}

if (pick) {
fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, false);
} else {
fillBlock(block, { field: "Free", sport: null }, fieldUsageBySlot, yesterdayHistory, false);
}
}

// ===== PASS 5: NEW: Update Rotation History =====
try {
const historyToSave = rotationHistory;
availableDivisions.forEach(divName => {
(divisions[divName]?.bunks || []).forEach(bunk => {
const schedule = window.scheduleAssignments[bunk] || [];
let lastActivity = null;

for (const entry of schedule) {
if (entry && entry._activity && entry._activity !== lastActivity) {
const activityName = entry._activity;
lastActivity = activityName;

historyToSave.bunks[bunk] = historyToSave.bunks[bunk] || {};
historyToSave.bunks[bunk][activityName] = timestamp;

if (entry._h2h && entry._activity !== "League" && entry._activity !== "No Game") {
const leagueEntry = Object.entries(masterLeagues).find(([name, l]) =>
l.enabled && l.divisions.includes(divName)
);
if (leagueEntry) {
const leagueName = leagueEntry[0];
historyToSave.leagues[leagueName] = historyToSave.leagues[leagueName] || {};
historyToSave.leagues[leagueName][entry._activity] = timestamp;
}
}
} else if (entry && !entry.continuation) {
lastActivity = null;
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
function markFieldUsage(block, fieldName, fieldUsageBySlot) {
if (!fieldName || fieldName === "No Field" || !window.allSchedulableNames.includes(fieldName)) {
return;
}
for (const slotIndex of block.slots) {
if (slotIndex === undefined) continue;
fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
const usage = fieldUsageBySlot[slotIndex][fieldName] || { count: 0, divisions: [] };
usage.count++;
if (!usage.divisions.includes(block.divName)) {
usage.divisions.push(block.divName);
}
fieldUsageBySlot[slotIndex][fieldName] = usage;
}
}

// ... (isTimeAvailable, canBlockFit, canLeagueGameFit, fillBlock, pairRoundRobin, loadAndFilterData helpers are unchanged) ...
// (Omitting them here for brevity, but they are assumed to be present from the previous file content)

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

function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = (props && props.sharable) ? 2 : 1;
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;
    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
        if (!limitRules.divisions[block.divName]) {
            return false;
        }
        const allowedBunks = limitRules.divisions[block.divName];
        if (allowedBunks.length > 0) {
            if (!block.bunk) {
            } else if (!allowedBunks.includes(block.bunk)) {
                return false;
            }
        }
    }
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) return false;
        const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
        if (usage.count >= limit) return false;
        if (!isTimeAvailable(slotIndex, props)) {
            return false;
        }
    }
    return true;
}

function canLeagueGameFit(block, fieldName, fieldUsageBySlot, activityProperties) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = 1; // League games are NEVER sharable
    if (props && props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;
    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
        if (!limitRules.divisions[block.divName]) {
            return false;
        }
    }
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) return false;
        const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
        if (usage.count >= limit) return false;
        if (!isTimeAvailable(slotIndex, props)) {
            return false;
        }
    }
    return true;
}

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
                _activity: pick._activity || null
            };
            if (!isLeagueFill && fieldName && window.allSchedulableNames.includes(fieldName)) {
                fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
                const usage = fieldUsageBySlot[slotIndex][fieldName] || { count: 0, divisions: [] };
                usage.count++;
                if (!usage.divisions.includes(block.divName)) {
                    usage.divisions.push(block.divName);
                }
                fieldUsageBySlot[slotIndex][fieldName] = usage;
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
        rotationHistory,
        disabledLeagues,
        disabledSpecialtyLeagues
    };
}
})();
