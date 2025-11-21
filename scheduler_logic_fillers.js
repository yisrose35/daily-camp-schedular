
// =================================================================
// scheduler_logic_fillers.js
//
// UPDATED:
// - Added `calculatePreferenceScore` helper.
// - Updated sorting logic to prioritize Preference > Freshness.
// =================================================================

(function() {
'use strict';

function fieldLabel(f) {
if (typeof f === "string") return f;
if (f && typeof f === "object" && typeof f.name === "string") return f.name;
return "";
}

// --- NEW: Preference Scorer ---
function calculatePreferenceScore(fieldProps, divName) {
if (!fieldProps || !fieldProps.preferences || !fieldProps.preferences.enabled) {
return 0; // No preferences active
}

const list = fieldProps.preferences.list || [];
const index = list.indexOf(divName);

if (index !== -1) {
// On the list!
// #1 gets 1000, #2 gets 900, etc.
return 1000 - (index * 100);
} else {
// Not on the list.
// If Exclusive, canBlockFit would have blocked it already.
// So if we are here, it's non-exclusive but "preferred" for someone else.
// Apply penalty so we avoid it if possible.
return -50;
}
}
// ------------------------------

function sortPicksByFreshness(possiblePicks, bunkHistory = {}, divName, activityProperties) {
return possiblePicks.sort((a, b) => {
// 1. Preference Score
const propsA = activityProperties[fieldLabel(a.field)];
const propsB = activityProperties[fieldLabel(b.field)];
const scoreA = calculatePreferenceScore(propsA, divName);
const scoreB = calculatePreferenceScore(propsB, divName);

if (scoreA !== scoreB) {
return scoreB - scoreA; // Higher score first
}

// 2. Freshness (Existing logic)
const lastA = bunkHistory[a._activity] || 0;
const lastB = bunkHistory[b._activity] || 0;
if (lastA !== lastB) {
return lastA - lastB;
}

return 0.5 - Math.random();
});
}

// ... (Wrappers for findBest...)

window.findBestSpecial = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions) {
const specials = allActivities.filter(a => a.type === 'special').map(a => ({ field: a.field, sport: null, _activity: a.field }));
const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};
const activitiesDoneToday = getGeneralActivitiesDoneToday(block.bunk);

const availablePicks = specials.filter(pick =>
canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot, pick._activity) &&
!activitiesDoneToday.has(pick._activity)
);

// Updated Sorter Call
const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory, block.divName, activityProperties);
return sortedPicks[0] || null;
}

window.findBestSportActivity = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions) {
const sports = allActivities.filter(a => a.type === 'field').map(a => ({ field: a.field, sport: a.sport, _activity: a.sport }));
const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};
const activitiesDoneToday = getGeneralActivitiesDoneToday(block.bunk);

const availablePicks = sports.filter(pick =>
canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot, pick._activity) &&
!activitiesDoneToday.has(pick._activity)
);

const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory, block.divName, activityProperties);
return sortedPicks[0] || null;
}

window.findBestGeneralActivity = function(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions) {
const allPossiblePicks = allActivities.map(a => ({ field: a.field, sport: a.sport, _activity: a.sport || a.field }));
const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};
const activitiesDoneToday = getGeneralActivitiesDoneToday(block.bunk);

const availablePicks = allPossiblePicks.filter(pick =>
canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot, pick._activity) &&
!activitiesDoneToday.has(pick._activity)
);

const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory, block.divName, activityProperties);
return sortedPicks[0] || { field: "Free", sport: null, _activity: "Free" };
}

// Helpers
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot, proposedActivity) {
// This is just a reference helper for the fill logic, the real logic is in core.
// But we need to expose it for `findBest...` to use if it's running standalone (rare).
// Actually, the `canBlockFit` used here should be the global one or passed in.
// For now, we rely on `window.findBestGeneralActivity.canBlockFit` being assigned in core?
// No, `scheduler_logic_fillers.js` usually defines these.
// I'll link the global one in core or copy it.
// Better: The fillers module imports logic or duplicates it.
// Given the previous architecture, `canBlockFit` is needed here.
// I will paste the updated `canBlockFit` here too to be safe.

const props = activityProperties[fieldName];
if (!props) return false;

// Preference Check
if (props.preferences && props.preferences.enabled && props.preferences.exclusive) {
if (!props.preferences.list.includes(block.divName)) return false;
}

// ... (Standard logic) ...
// For brevity in this response, assume standard logic matches core.
// BUT, `canBlockFit` in fillers MUST match core.
// In the file set provided, `scheduler_logic_fillers.js` had its OWN `canBlockFit`.
// So I must update it here.

// Standard Logic Recopy:
const limit = (props.sharable) ? 2 : 1;
if (props.allowedDivisions && props.allowedDivisions.length && !props.allowedDivisions.includes(block.divName)) return false;
const limitRules = props.limitUsage;
if (limitRules && limitRules.enabled) {
if (!limitRules.divisions[block.divName]) return false;
const allowedBunks = limitRules.divisions[block.divName];
if (allowedBunks.length > 0 && block.bunk && !allowedBunks.includes(block.bunk)) return false;
}

for (const slotIndex of block.slots) {
if (slotIndex === undefined) return false;
const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [], bunks: {} };
if (usage.count >= limit) return false;
if (usage.count > 0) {
if (!usage.divisions.includes(block.divName)) return false;
let existingActivity = null;
for (const bunkName in usage.bunks) { if (usage.bunks[bunkName]) { existingActivity = usage.bunks[bunkName]; break; } }
if (existingActivity && proposedActivity && existingActivity !== proposedActivity) return false;
}
if (!isTimeAvailable(slotIndex, props)) return false;
}
return true;
}

function getGeneralActivitiesDoneToday(bunkName) {
const activities = new Set();
const schedule = window.scheduleAssignments[bunkName] || [];
for (const entry of schedule) {
if (entry && entry._activity && !entry._h2h) activities.add(entry._activity);
}
return activities;
}

// ... (Time helpers) ...
function parseTimeToMinutes(str) { /* ... same ... */
if (!str || typeof str !== "string") return null;
let s = str.trim().toLowerCase();
let mer = null;
if (s.endsWith("am") || s.endsWith("pm")) { mer = s.endsWith("am") ? "am" : "pm"; s = s.replace(/am|pm/g, "").trim(); }
const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
if (!m) return null;
let hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
if (mer) { if (hh === 12) hh = mer === "am" ? 0 : 12; else if (mer === "pm") hh += 12; } else return null;
return hh * 60 + mm;
}

function isTimeAvailable(slotIndex, fieldProps) {
const INCREMENT_MINS = 30;
if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
const slot = window.unifiedTimes[slotIndex];
const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
const slotEndMin = slotStartMin + INCREMENT_MINS;
const rules = (fieldProps.timeRules || []).map(r => {
if (typeof r.startMin === "number") return r;
return { type: r.type, startMin: parseTimeToMinutes(r.start), endMin: parseTimeToMinutes(r.end) };
});
if (rules.length === 0) return fieldProps.available;
if (!fieldProps.available) return false;
const hasAvailableRules = rules.some(r => r.type === 'Available');
let isAvailable = !hasAvailableRules;
for (const rule of rules) {
if (rule.type === 'Available') { if (slotStartMin >= rule.startMin && slotEndMin <= rule.endMin) { isAvailable = true; break; } }
}
for (const rule of rules) {
if (rule.type === 'Unavailable') { if (slotStartMin < rule.endMin && slotEndMin > rule.startMin) { isAvailable = false; break; } }
}
return isAvailable;
}

window.findBestGeneralActivity.canBlockFit = canBlockFit;

})();
