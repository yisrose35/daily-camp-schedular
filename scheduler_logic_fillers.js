
// =================================================================
// scheduler_logic_fillers.js
//
// UPDATED:
// - Removed local 'canBlockFit' to prevent logic duplication.
// - Now strictly uses window.SchedulerCoreUtils.canBlockFit.
// - Uses SchedulerCoreUtils.fieldLabel for consistency.
// - ADDED: Max Usage Limit check in findBestSpecial/General
// =================================================================

(function() {
'use strict';

// Delegate to the central Utilities for field name resolution
function fieldLabel(f) { 
    return window.SchedulerCoreUtils ? window.SchedulerCoreUtils.fieldLabel(f) : (f && f.name ? f.name : f); 
}

function calculatePreferenceScore(fieldProps, divName) {
    if (!fieldProps?.preferences?.enabled) return 0;
    const index = (fieldProps.preferences.list || []).indexOf(divName);
    return index !== -1 ? 1000 - (index * 100) : -50;
}

function sortPicksByFreshness(possiblePicks, bunkHistory = {}, divName, activityProperties) {
    return possiblePicks.sort((a, b) => {
        const propsA = activityProperties[fieldLabel(a.field)];
        const propsB = activityProperties[fieldLabel(b.field)];
        const scoreA = calculatePreferenceScore(propsA, divName);
        const scoreB = calculatePreferenceScore(propsB, divName);
        if (scoreA !== scoreB) return scoreB - scoreA;
        
        const lastA = bunkHistory[a._activity] || 0; 
        const lastB = bunkHistory[b._activity] || 0;
        if (lastA !== lastB) return lastA - lastB; 
        return 0.5 - Math.random();
    });
}

// --- HELPER: Check Usage Limit (Safety Net for Generator) ---
function isOverUsageLimit(activityName, bunk, activityProperties, historicalCounts, activitiesDoneToday) {
    const props = activityProperties[activityName];
    // maxUsage comes from Utils.loadAndFilterData
    const max = props?.maxUsage || 0;
    
    // 0 means unlimited
    if (max === 0) return false; 

    // SAFETY FIX: Handle undefined historicalCounts gracefully
    const safeHistory = historicalCounts || {};
    const pastCount = safeHistory[bunk]?.[activityName] || 0;
    
    // If they already hit the limit in past days
    if (pastCount >= max) return true;

    // If they are at limit-1, and they already did it today, they can't do it again
    if (activitiesDoneToday.has(activityName) && (pastCount + 1 > max)) return true;

    return false;
}

window.findBestSpecial = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions, historicalCounts) {
    const specials = allActivities.filter(a => a.type === 'special').map(a => ({ field: a.field, sport: null, _activity: a.field }));
    const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};
    const activitiesDoneToday = getGeneralActivitiesDoneToday(block.bunk);

    const availablePicks = specials.filter(pick => {
        const name = pick._activity;
        
        // 1. Check standard constraints (time, sharing, field availability) using CORE UTILS
        if (!window.SchedulerCoreUtils.canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot, name)) return false;
        
        // 2. Check Max Usage Limit (The Safety Net)
        if (isOverUsageLimit(name, block.bunk, activityProperties, historicalCounts, activitiesDoneToday)) return false;

        // 3. Check if done today
        if (activitiesDoneToday.has(name)) return false;

        return true;
    });
    
    const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory, block.divName, activityProperties);
    return sortedPicks[0] || null;
}

window.findBestSportActivity = function(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions, historicalCounts) {
    const sports = allActivities.filter(a => a.type === 'field').map(a => ({ field: a.field, sport: a.sport, _activity: a.sport }));
    const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};
    const activitiesDoneToday = getGeneralActivitiesDoneToday(block.bunk);

    const availablePicks = sports.filter(pick => 
        window.SchedulerCoreUtils.canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot, pick._activity) &&
        !activitiesDoneToday.has(pick._activity)
    );
    
    const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory, block.divName, activityProperties);
    return sortedPicks[0] || null;
}

window.findBestGeneralActivity = function(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties, rotationHistory, divisions, historicalCounts) {
    const allPossiblePicks = allActivities.map(a => ({ field: a.field, sport: a.sport, _activity: a.sport || a.field }));
    const bunkHistory = rotationHistory?.bunks?.[block.bunk] || {};
    const activitiesDoneToday = getGeneralActivitiesDoneToday(block.bunk);

    const availablePicks = allPossiblePicks.filter(pick => {
        const name = pick._activity;
        // Core validation
        if (!window.SchedulerCoreUtils.canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot, name)) return false;
        
        // Check limits for specials here too if general picks a special
        if (pick.field && !pick.sport) { 
             if (isOverUsageLimit(name, block.bunk, activityProperties, historicalCounts, activitiesDoneToday)) return false;
        }

        return !activitiesDoneToday.has(name);
    });

    const sortedPicks = sortPicksByFreshness(availablePicks, bunkHistory, block.divName, activityProperties);
    return sortedPicks[0] || { field: "Free", sport: null, _activity: "Free" };
}

function getGeneralActivitiesDoneToday(bunkName) {
    const activities = new Set();
    const schedule = window.scheduleAssignments[bunkName] || [];
    for (const entry of schedule) {
        if (entry && entry._activity && !entry._h2h) activities.add(entry._activity);
    }
    return activities;
}

})();
