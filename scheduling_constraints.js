(function() {
'use strict';
console.log("[CONSTRAINTS] Scheduling Constraints v1.0 loading...");

function loadConstraints() { const s = window.loadGlobalSettings?.() || {}; return s.schedulingConstraints || { sequenceRules: [] }; }
function saveConstraints(data) { window.saveGlobalSettings?.('schedulingConstraints', data); }

window.getSequenceRules = function() { return loadConstraints().sequenceRules || []; };
window.saveSequenceRules = function(rules) { const d = loadConstraints(); d.sequenceRules = rules; saveConstraints(d); };

window.isLocationInCooldown = function(locationName, slotIndex, bunk, divName) {
    if (!locationName || slotIndex == null || slotIndex <= 0) return false;
    const assignments = window.scheduleAssignments?.[bunk];
    if (!assignments) return false;
    const defaults = window.getPinnedTileDefaults?.() || {};
    for (const [tileName, rawVal] of Object.entries(defaults)) {
        const loc = typeof rawVal === 'string' ? rawVal : rawVal?.location;
        const cooldownSlots = typeof rawVal === 'object' ? (rawVal.cooldownSlots || 0) : 0;
        if (loc !== locationName || cooldownSlots <= 0) continue;
        for (let offset = 1; offset <= cooldownSlots; offset++) {
            const checkIdx = slotIndex - offset;
            if (checkIdx < 0) continue;
            const prev = assignments[checkIdx];
            if (!prev) continue;
            const prevAct = (prev._activity || prev.field || '').toLowerCase();
            if (prevAct.includes(tileName.toLowerCase())) {
                return { blocked: true, reason: locationName + ' is in cooldown — ' + tileName + ' just used it (' + cooldownSlots + '-slot cooldown)', blockedBy: tileName };
            }
        }
    }
    return false;
};

window.checkSequenceViolation = function(bunk, activityName, slotIndex, divName) {
    const rules = window.getSequenceRules();
    if (rules.length === 0) return null;
    const assignments = window.scheduleAssignments?.[bunk];
    if (!assignments) return null;
    const actLower = (activityName || '').toLowerCase().trim();
    // Check previous slot
    if (slotIndex > 0) {
        const prev = assignments[slotIndex - 1];
        if (prev && !prev.continuation) {
            const prevAct = (prev._activity || prev.field || '').toLowerCase().trim();
            if (prevAct && prevAct !== 'free') {
                for (const rule of rules) {
                    const a = rule.activityA.toLowerCase().trim(), b = rule.activityB.toLowerCase().trim(), dir = rule.direction || 'a_before_b';
                    if ((dir === 'a_before_b' || dir === 'either') && prevAct === a && actLower === b) return { violated: true, reason: '"' + activityName + '" cannot come right after "' + (prev._activity || prev.field) + '"', rule };
                    if ((dir === 'b_before_a' || dir === 'either') && prevAct === b && actLower === a) return { violated: true, reason: '"' + activityName + '" cannot come right after "' + (prev._activity || prev.field) + '"', rule };
                }
            }
        }
    }
    // Check next slot
    if (assignments && slotIndex < assignments.length - 1) {
        const next = assignments[slotIndex + 1];
        if (next && !next.continuation) {
            const nextAct = (next._activity || next.field || '').toLowerCase().trim();
            if (nextAct && nextAct !== 'free') {
                for (const rule of rules) {
                    const a = rule.activityA.toLowerCase().trim(), b = rule.activityB.toLowerCase().trim(), dir = rule.direction || 'a_before_b';
                    if ((dir === 'a_before_b' || dir === 'either') && actLower === a && nextAct === b) return { violated: true, reason: '"' + activityName + '" cannot come right before "' + (next._activity || next.field) + '"', rule };
                    if ((dir === 'b_before_a' || dir === 'either') && actLower === b && nextAct === a) return { violated: true, reason: '"' + activityName + '" cannot come right before "' + (next._activity || next.field) + '"', rule };
                }
            }
        }
    }
    return null;
};

window.getSequenceConstraintPenalty = function(bunk, activityName, slotIndex, divName) { const v = window.checkSequenceViolation(bunk, activityName, slotIndex, divName); return v?.violated ? 50000 : 0; };
window.getLocationCooldownPenalty = function(locationName, slotIndex, bunk, divName) { const r = window.isLocationInCooldown(locationName, slotIndex, bunk, divName); return r?.blocked ? 50000 : 0; };

console.log("[CONSTRAINTS] Module loaded.");
})();
