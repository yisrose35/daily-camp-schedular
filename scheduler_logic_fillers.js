// -------------------- scheduler_logic_fillers.js --------------------
// Post-passes: forced H2H, doubling, specials fallback.
//
// REFACTORED FOR "SCHEDULE PERIODS"
// - All filler functions now accept `divisionSpanLens` map.
// - All filler functions now use helpers to find the dynamic span for
//   the current slot, and only fill from the *start* of a sub-activity block.
// - Copied helper functions from core logic.
// -----------------------------------------------------------------

// ===== NEW: Copied Helpers from core logic =====
// (These are required for the fillers to be period-aware)

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

function getPeriodForSlot(slotIndex) {
    const periods = window.schedulePeriods || [];
    const unifiedTimes = window.unifiedTimes || [];
    
    if (!unifiedTimes[slotIndex]) return null;

    const slotStartMin = unifiedTimes[slotIndex].start.getHours() * 60 + unifiedTimes[slotIndex].start.getMinutes();

    for (const period of periods) {
        const periodStartMin = parseTimeToMinutes(period.start);
        const periodEndMin = parseTimeToMinutes(period.end);
        if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
            return period;
        }
    }
    return null;
}

function findRowsForRange(startStr, endStr) {
    if (!Array.isArray(window.unifiedTimes) || window.unifiedTimes.length === 0) return [];
    const startMin = parseTimeToMinutes(startStr), endMin = parseTimeToMinutes(endStr);
    if (startMin == null || endMin == null || endMin <= startMin) return [];
    
    const inside = [];
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const r = window.unifiedTimes[i];
        const rs = r.start.getHours() * 60 + r.start.getMinutes();
        const re = r.end.getHours() * 60 + r.end.getMinutes();
        if (rs >= startMin && re <= endMin) inside.push(i);
    }
    if (inside.length === 0) {
        const overlap = [];
        for (let i = 0; i < window.unifiedTimes.length; i++) {
            const r = window.unifiedTimes[i], rs = r.start.getHours() * 60 + r.start.getMinutes(), re = r.end.getHours() * 60 + r.end.getMinutes();
            if (Math.max(rs, startMin) < Math.min(re, endMin)) overlap.push(i);
        }
        return overlap;
    }
    return inside;
}


// --- Pass 2.5 (REFACTORED) ---
window.fillRemainingWithForcedH2HPlus = function (
    availableDivisions, divisions, divisionSpanLens, // <-- spanLen replaced
    h2hActivities, fieldUsageBySlot,
    activityProperties, h2hHistory, h2hGameCount,
    generalActivityHistory
) {
    const unifiedTimes = window.unifiedTimes || [];
    const leaguePreferredFields = new Set();
    const global = window.loadGlobalSettings?.() || {};
    const leaguesByName = global.leaguesByName || {};
    Object.values(leaguesByName).forEach(L => {
        (L.sports || []).forEach(sp => {
            const fields = (window._lastFieldsBySportCache || {})[sp] || [];
            fields.forEach(f => leaguePreferredFields.add(f));
        });
    });

    for (const div of (availableDivisions || [])) {
        const bunks = divisions[div]?.bunks || [];
        const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;

        for (let s = 0; s < unifiedTimes.length; s++) {
            if (window.leagueAssignments?.[div]?.[s]) continue;
            if (!isActive(s)) continue;
            
            // --- NEW DYNAMIC SPAN ---
            const period = getPeriodForSlot(s);
            if (!period) continue;
            const spanLen = divisionSpanLens[div]?.[period.id] || 1;
            const periodStartSlot = findRowsForRange(period.start, period.end)[0];
            if ((s - periodStartSlot) % spanLen !== 0) {
                continue; // Not the start of a block
            }
            // --- END NEW DYNAMIC SPAN ---

            const eligible = bunks.filter(b => isActive(s) && ((h2hGameCount[b] || 0) < 2));
            if (eligible.length < 1) continue;
            
            let changed = true; let tries = 0;
            while (changed && tries++ < 20) {
                changed = false;
                const empties = eligible.filter(b => !window.scheduleAssignments[b][s]);
                
                // 1) empty-empty
                for (let i = 0; i < empties.length; i++) {
                    const a = empties[i]; if (window.scheduleAssignments[a][s]) continue;
                    for (let j = i + 1; j < empties.length; j++) {
                        const b = empties[j]; if (window.scheduleAssignments[b][s]) continue;
                        if ((h2hHistory[a]?.[b] || 0) >= 1) continue;
                        if (placeH2HPairPlus(a, b, div, s, spanLen)) { // Pass dynamic span
                            changed = true; break; 
                        }
                    }
                }
                
                // 2) recruit partner (prefer sharable, else any general)
                const singles = eligible.filter(b => !window.scheduleAssignments[b][s]);
                for (const a of singles) {
                    for (const cand of bunks) {
                        if (cand === a) continue;
                        if ((h2hGameCount[cand] || 0) >= 2) continue;
                        if ((h2hHistory[a]?.[cand] || 0) >= 1) continue;
                        const e2 = window.scheduleAssignments[cand]?.[s];
                        if (!e2 || e2._h2h || e2._fixed || e2.continuation) continue;
                        const f2 = fieldLabel(e2.field);
                        const props = activityProperties[f2];
                        const usage = (fieldUsageBySlot[s]?.[f2] || 0);
                        let recruited = false;
                        if (props && props.sharable && usage < 2) {
                            if (placeH2HPairPlus(a, cand, div, s, spanLen, /*evict*/true)) { // Pass dynamic span
                                changed = true; recruited = true; break; 
                            }
                        }
                        if (!recruited) {
                            if (placeH2HPairPlus(a, cand, div, s, spanLen, /*evict*/true)) { // Pass dynamic span
                                changed = true; break; 
                            }
                        }
                    }
                }
            }
            if (tries > 0) s += (spanLen - 1); // Skip slots
        }
    }

    // Helper for this function (must accept spanLen)
    function placeH2HPairPlus(a, b, div, s, spanLen, evict=false) {
        const sortedPicks = (h2hActivities || []).slice().sort((p1, p2) => {
            const f1 = fieldLabel(p1.field), f2 = fieldLabel(p2.field);
            const s1 = leaguePreferredFields.has(f1) ? 1 : 0;
            const s2 = leaguePreferredFields.has(f2) ? 1 : 0;
            return s1 - s2; // prefer non-league fields
        });
        
        for (const pick of sortedPicks) {
            const fName = fieldLabel(pick.field);
            let fitsBoth = true;
            for (let k = 0; k < spanLen; k++) {
                const slot = s + k;
                if (slot >= (window.unifiedTimes || []).length) { fitsBoth = false; break; }
                if (window.scheduleAssignments[a][slot] || window.scheduleAssignments[b][slot]) { fitsBoth = false; break; }
                if (window.leagueAssignments?.[div]?.[slot]) { fitsBoth = false; break; }
                if ((fieldUsageBySlot[slot]?.[fName] || 0) > 0) { fitsBoth = false; break; }
            }
            if (!fitsBoth) continue;
            
            if (evict) {
                // Evict opponent's activity for the *full span*
                for (let k = 0; k < spanLen; k++) {
                    const slot = s + k; 
                    const prev = window.scheduleAssignments[b][slot];
                    if (prev && !prev._fixed && !prev._h2h) {
                        const pf = fieldLabel(prev.field);
                        window.scheduleAssignments[b][slot] = undefined;
                        if (pf) { fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][pf] = Math.max(0, (fieldUsageBySlot[slot][pf] || 1) - 1); }
                    }
                }
            }
            
            for (let k = 0; k < spanLen; k++) {
                const slot = s + k; const cont = k > 0;
                window.scheduleAssignments[a][slot] = { field: fName, sport: pick.sport, continuation: cont, _h2h: true, vs: b };
                window.scheduleAssignments[b][slot] = { field: fName, sport: pick.sport, continuation: cont, _h2h: true, vs: a };
                fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][fName] = 2;
            }
            h2hHistory[a] = h2hHistory[a] || {}; h2hHistory[b] = h2hHistory[b] || {};
            h2hHistory[a][b] = (h2hHistory[a][b] || 0) + 1; h2hHistory[b][a] = (h2hHistory[b][a] || 0) + 1;
            h2hGameCount[a] = (h2hGameCount[a] || 0) + 1; h2hGameCount[b] = (h2hGameCount[b] || 0) + 1;
            return true;
        }
        return false;
    }
};

// --- Pass 3 (REFACTORED) ---
window.fillRemainingWithDoublingAggressive = function (
    availableDivisions, divisions, divisionSpanLens, // <-- spanLen replaced
    fieldUsageBySlot, activityProperties,
    generalActivityHistory
) {
    const unifiedTimes = window.unifiedTimes || [];
    let changed = true; let safety = 0;
    while (changed && safety++ < 6) {
        changed = false;
        for (const div of (availableDivisions || [])) {
            const bunks = divisions[div]?.bunks || [];
            const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;
            
            for (let s = 0; s < unifiedTimes.length; s++) {
                if (window.leagueAssignments?.[div]?.[s]) continue;
                if (!isActive(s)) continue;

                // --- NEW DYNAMIC SPAN ---
                const period = getPeriodForSlot(s);
                if (!period) continue;
                const spanLen = divisionSpanLens[div]?.[period.id] || 1;
                const periodStartSlot = findRowsForRange(period.start, period.end)[0];
                if ((s - periodStartSlot) % spanLen !== 0) {
                    continue; // Not the start of a block
                }
                // --- END NEW DYNAMIC SPAN ---
                
                const sharableOpen = {};
                for (const b of bunks) {
                    const e = window.scheduleAssignments[b]?.[s];
                    if (!e || e._h2h || e._fixed || e.continuation) continue;
                    const f = fieldLabel(e.field);
                    const props = activityProperties[f];
                    if (!props || !props.sharable) continue;
                    const usage = (fieldUsageBySlot[s]?.[f] || 0);
                    if (usage < 2 && props.allowedDivisions.includes(div)) { sharableOpen[f] = e; }
                }
                if (Object.keys(sharableOpen).length === 0) continue;
                
                for (const b of bunks) {
                    if (window.scheduleAssignments[b][s]) continue;
                    
                    let seated = false;
                    for (const [f, exemplar] of Object.entries(sharableOpen)) {
                        let fits = true;
                        for (let k = 0; k < spanLen; k++) { // Check for full span
                            const slot = s + k; if (slot >= unifiedTimes.length) { fits = false; break; }
                            const usage = (fieldUsageBySlot[slot]?.[f] || 0); 
                            const props = activityProperties[f];
                            if (!props || !props.sharable || usage >= 2 || !props.allowedDivisions.includes(div)) { fits = false; break; }
                            if (window.scheduleAssignments[b][slot] || window.leagueAssignments?.[div]?.[slot]) { fits = false; break; }
                        }
                        if (!fits) continue;
                        
                        for (let k = 0; k < spanLen; k++) { // Assign for full span
                            const slot = s + k; 
                            window.scheduleAssignments[b][slot] = { field: f, sport: exemplar.sport, continuation: k > 0 }; 
                            fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; 
                            fieldUsageBySlot[slot][f] = (fieldUsageBySlot[slot][f] || 0) + 1; 
                        }
                        generalActivityHistory[b].add(getActivityName(exemplar));
                        changed = true; seated = true; break;
                    }
                    if (seated) {
                        s += (spanLen - 1); // Skip
                    }
                }
            }
        }
    }
};

// --- Final fallback (REFACTORED) ---
window.fillRemainingWithFallbackSpecials = function (
    availableDivisions, divisions, divisionSpanLens, // <-- spanLen replaced
    allActivities, fieldUsageBySlot, activityProperties,
    generalActivityHistory
) {
    const unifiedTimes = window.unifiedTimes || [];
    const candidates = Object.entries(activityProperties)
        .filter(([name, props]) => props && props.sharable)
        .map(([name, props]) => ({ name, props }));
        
    if (candidates.length === 0) return;
    
    for (const div of (availableDivisions || [])) {
        const bunks = divisions[div]?.bunks || [];
        const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;
        
        for (let s = 0; s < unifiedTimes.length; s++) {
            if (window.leagueAssignments?.[div]?.[s]) continue;
            
            // --- NEW DYNAMIC SPAN ---
            const period = getPeriodForSlot(s);
            if (!period) continue;
            const spanLen = divisionSpanLens[div]?.[period.id] || 1;
            const periodStartSlot = findRowsForRange(period.start, period.end)[0];
            if ((s - periodStartSlot) % spanLen !== 0) {
                continue; // Not the start of a block
            }
            // --- END NEW DYNAMIC SPAN ---
            
            const empties = bunks.filter(b => !window.scheduleAssignments[b][s] && isActive(s));
            if (empties.length === 0) continue;
            
            for (const b of empties) {
                let seated = false;
                for (const { name, props } of candidates) {
                    if (!props.allowedDivisions.includes(div)) continue;
                    
                    let fits = true;
                    for (let k = 0; k < spanLen; k++) { // Check for full span
                        const slot = s + k; 
                        if (slot >= unifiedTimes.length) { fits = false; break; }
                        if (window.scheduleAssignments[b][slot]) { fits = false; break; }
                        if (window.leagueAssignments?.[div]?.[slot]) { fits = false; break; }
                        const usage = (fieldUsageBySlot[slot]?.[name] || 0); 
                        if (usage >= 2) { fits = false; break; }
                    }
                    if (!fits) continue;
                    
                    for (let k = 0; k < spanLen; k++) { // Assign for full span
                        const slot = s + k; 
                        window.scheduleAssignments[b][slot] = { field: name, continuation: k > 0 }; 
                        fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; 
                        fieldUsageBySlot[slot][name] = (fieldUsageBySlot[slot][name] || 0) + 1; 
                    }
                    seated = true; 
                    break;
                }
                if (seated) {
                    s += (spanLen - 1); // Skip
                }
            }
        }
    }
};
