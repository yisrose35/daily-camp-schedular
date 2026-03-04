(function() {
'use strict';
console.log("[CONSTRAINTS] Scheduling Constraints v2.0 loading...");

var GROUP_ALL_SPORTS = '__ALL_SPORTS__';
var GROUP_ALL_SPECIALS = '__ALL_SPECIALS__';

function loadConstraints() { var s = window.loadGlobalSettings?.() || {}; return s.schedulingConstraints || { sequenceRules: [] }; }
function saveConstraints(data) { window.saveGlobalSettings?.('schedulingConstraints', data); }

window.getSequenceRules = function() { return loadConstraints().sequenceRules || []; };
window.saveSequenceRules = function(rules) { var d = loadConstraints(); d.sequenceRules = rules; saveConstraints(d); };

// =========================================================================
// HELPERS: resolve group/array rule values to check against an activity
// =========================================================================

function getSportsSet() {
    var sports = new Set();
    if (window.getAllGlobalSports) {
        window.getAllGlobalSports().forEach(function(s) { sports.add(s.toLowerCase().trim()); });
    } else {
        var settings = window.loadGlobalSettings?.() || {};
        var fields = (settings.app1 && settings.app1.fields) ? settings.app1.fields : [];
        fields.forEach(function(f) { (f.activities || []).forEach(function(a) { sports.add(a.toLowerCase().trim()); }); });
    }
    return sports;
}

function getSpecialsSet() {
    var specials = new Set();
    var settings = window.loadGlobalSettings?.() || {};
    var list = (settings.app1 && settings.app1.specialActivities) ? settings.app1.specialActivities : [];
    list.forEach(function(s) { if (s.name) specials.add(s.name.toLowerCase().trim()); });
    return specials;
}

// Check if activityName matches a rule value (string, array, or group)
function matchesRuleValue(ruleVal, activityNameLower) {
    if (!ruleVal || !activityNameLower) return false;

    // Group: all sports
    if (ruleVal === GROUP_ALL_SPORTS) {
        return getSportsSet().has(activityNameLower);
    }
    // Group: all specials
    if (ruleVal === GROUP_ALL_SPECIALS) {
        return getSpecialsSet().has(activityNameLower);
    }
    // Array of specific activities
    if (Array.isArray(ruleVal)) {
        return ruleVal.some(function(v) { return v.toLowerCase().trim() === activityNameLower; });
    }
    // Single string
    return ruleVal.toLowerCase().trim() === activityNameLower;
}

// =========================================================================
// TIME HELPERS: get slot start/end minutes from divisionTimes
// =========================================================================

function getSlotTimeRange(slotIndex, divName) {
    var divTimes = window.divisionTimes;
    if (!divTimes) return null;
    var slots = divTimes[divName];
    if (!slots || !slots[slotIndex]) return null;
    var slot = slots[slotIndex];
    var Utils = window.SchedulerCoreUtils;
    var startMin = null, endMin = null;
    if (slot.startMin != null) startMin = slot.startMin;
    else if (Utils && Utils.parseTimeToMinutes && (slot.startTime || slot.start)) startMin = Utils.parseTimeToMinutes(slot.startTime || slot.start);
    if (slot.endMin != null) endMin = slot.endMin;
    else if (Utils && Utils.parseTimeToMinutes && (slot.endTime || slot.end)) endMin = Utils.parseTimeToMinutes(slot.endTime || slot.end);
    if (startMin == null || endMin == null) return null;
    return { startMin: startMin, endMin: endMin };
}

// =========================================================================
// LOCATION COOLDOWN — now uses cooldownMinutes (falls back to cooldownSlots)
// =========================================================================

window.isLocationInCooldown = function(locationName, slotIndex, bunk, divName) {
    if (!locationName || slotIndex == null || slotIndex <= 0) return false;
    var assignments = window.scheduleAssignments?.[bunk];
    if (!assignments) return false;
    var defaults = window.getPinnedTileDefaults?.() || {};

    // Get current slot start time
    var currentTime = getSlotTimeRange(slotIndex, divName);

    for (var tileName in defaults) {
        if (!defaults.hasOwnProperty(tileName)) continue;
        var rawVal = defaults[tileName];
        var loc = typeof rawVal === 'string' ? rawVal : (rawVal ? rawVal.location : null);
        var cooldownMinutes = (typeof rawVal === 'object' && rawVal) ? (rawVal.cooldownMinutes || 0) : 0;
        // Fallback: convert old cooldownSlots to approximate minutes (30 per slot)
        if (cooldownMinutes <= 0 && typeof rawVal === 'object' && rawVal && rawVal.cooldownSlots > 0) {
            cooldownMinutes = rawVal.cooldownSlots * 30;
        }
        if (loc !== locationName || cooldownMinutes <= 0) continue;

        // Scan previous slots to find if this pinned tile recently ended
        for (var checkIdx = slotIndex - 1; checkIdx >= 0; checkIdx--) {
            var prev = assignments[checkIdx];
            if (!prev) continue;
            var prevAct = (prev._activity || prev.field || '').toLowerCase();
            if (prevAct.indexOf(tileName.toLowerCase()) === -1) continue;

            // Found the pinned tile — check time gap
            if (currentTime) {
                var prevTime = getSlotTimeRange(checkIdx, divName);
                if (prevTime) {
                    var gapFromEnd = currentTime.startMin - prevTime.endMin;
                    if (gapFromEnd < cooldownMinutes) {
                        return {
                            blocked: true,
                            reason: locationName + ' is in cooldown — ' + tileName + ' ended ' + gapFromEnd + ' min ago (' + cooldownMinutes + ' min cooldown)',
                            blockedBy: tileName
                        };
                    }
                    // If gap is large enough, this tile is fine
                    break;
                }
            }

            // Fallback: slot-based check if no time data
            var slotGap = slotIndex - checkIdx;
            var approxMinutes = slotGap * 30;
            if (approxMinutes < cooldownMinutes) {
                return {
                    blocked: true,
                    reason: locationName + ' is in cooldown — ' + tileName + ' just used it (' + cooldownMinutes + ' min cooldown)',
                    blockedBy: tileName
                };
            }
            break;
        }
    }
    return false;
};

// =========================================================================
// SEQUENCE VIOLATION — time-based gap with group/array support
// =========================================================================

window.checkSequenceViolation = function(bunk, activityName, slotIndex, divName) {
    var rules = window.getSequenceRules();
    if (rules.length === 0) return null;
    var assignments = window.scheduleAssignments?.[bunk];
    if (!assignments) return null;
    var actLower = (activityName || '').toLowerCase().trim();
    if (!actLower || actLower === 'free') return null;

    var currentTime = getSlotTimeRange(slotIndex, divName);

    for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        var gapMinutes = rule.gapMinutes || 30;
        var dir = rule.direction || 'after'; // default to 'after' for legacy rules

        // Legacy support: convert old directions
        if (dir === 'a_before_b') dir = 'after';
        if (dir === 'b_before_a') dir = 'before';
        if (dir === 'either') dir = 'both';

        var aVal = rule.activityA;
        var bVal = rule.activityB;

        // Determine if current activity matches A side, B side, or both
        var matchesA = matchesRuleValue(aVal, actLower);
        var matchesB = matchesRuleValue(bVal, actLower);
        if (!matchesA && !matchesB) continue;

        // Check backwards (previous slots)
        if (dir === 'after' || dir === 'both') {
            for (var pi = slotIndex - 1; pi >= 0; pi--) {
                var prev = assignments[pi];
                if (!prev || prev.continuation) continue;
                var prevAct = (prev._activity || prev.field || '').toLowerCase().trim();
                if (!prevAct || prevAct === 'free') continue;

                // Check time gap
                var tooFar = false;
                if (currentTime) {
                    var prevTime = getSlotTimeRange(pi, divName);
                    if (prevTime) {
                        var gap = currentTime.startMin - prevTime.endMin;
                        if (gap >= gapMinutes) { tooFar = true; }
                    }
                }
                if (tooFar) break;

                // Slot-based fallback
                if (!currentTime) {
                    var slotDiff = slotIndex - pi;
                    if (slotDiff * 30 >= gapMinutes) break;
                }

                // Check match: if current is A and prev is B, or current is B and prev is A
                if (matchesA && matchesRuleValue(bVal, prevAct)) {
                    return {
                        violated: true,
                        reason: '"' + activityName + '" cannot be within ' + gapMinutes + ' min after "' + (prev._activity || prev.field) + '"',
                        rule: rule
                    };
                }
                if (matchesB && matchesRuleValue(aVal, prevAct)) {
                    return {
                        violated: true,
                        reason: '"' + activityName + '" cannot be within ' + gapMinutes + ' min after "' + (prev._activity || prev.field) + '"',
                        rule: rule
                    };
                }
            }
        }

        // Check forwards (next slots)
        if (dir === 'before' || dir === 'both') {
            for (var ni = slotIndex + 1; ni < assignments.length; ni++) {
                var next = assignments[ni];
                if (!next || next.continuation) continue;
                var nextAct = (next._activity || next.field || '').toLowerCase().trim();
                if (!nextAct || nextAct === 'free') continue;

                var tooFarFwd = false;
                if (currentTime) {
                    var nextTime = getSlotTimeRange(ni, divName);
                    if (nextTime) {
                        var gapFwd = nextTime.startMin - currentTime.endMin;
                        if (gapFwd >= gapMinutes) { tooFarFwd = true; }
                    }
                }
                if (tooFarFwd) break;

                if (!currentTime) {
                    var slotDiffFwd = ni - slotIndex;
                    if (slotDiffFwd * 30 >= gapMinutes) break;
                }

                if (matchesA && matchesRuleValue(bVal, nextAct)) {
                    return {
                        violated: true,
                        reason: '"' + activityName + '" cannot be within ' + gapMinutes + ' min before "' + (next._activity || next.field) + '"',
                        rule: rule
                    };
                }
                if (matchesB && matchesRuleValue(aVal, nextAct)) {
                    return {
                        violated: true,
                        reason: '"' + activityName + '" cannot be within ' + gapMinutes + ' min before "' + (next._activity || next.field) + '"',
                        rule: rule
                    };
                }
            }
        }
    }

    return null;
};

// =========================================================================
// PENALTY FUNCTIONS (unchanged API)
// =========================================================================

window.getSequenceConstraintPenalty = function(bunk, activityName, slotIndex, divName) {
    var v = window.checkSequenceViolation(bunk, activityName, slotIndex, divName);
    return v && v.violated ? 50000 : 0;
};

window.getLocationCooldownPenalty = function(locationName, slotIndex, bunk, divName) {
    var r = window.isLocationInCooldown(locationName, slotIndex, bunk, divName);
    return r && r.blocked ? 50000 : 0;
};

console.log("[CONSTRAINTS] v2.0 Module loaded.");
})();
