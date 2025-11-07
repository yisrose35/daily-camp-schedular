// -------------------- scheduler_logic_core.js --------------------
// REFACTORED FOR "MATRIX" (Per-Division Period Times)
// - Generates a 30-minute grid based on the "earliest" and "latest"
//   time found across ALL divisions' custom period settings.
// - divisionActiveRows mask is built from each division's *specific*
//   start/end times for each period.
// - spanLen is now dynamic per-division, per-period.
// -----------------------------------------------------------------

// ===== CONFIG =====
const INCREMENT_MINS = 30;
const LEAGUE_DURATION_MINS = 30; 

// ===== Helpers =====
// (Omitting parseTimeToMinutes, fieldLabel, getActivityName, fmtTime for brevity)
// ...

// ===== NEW: Period/Time Generation Helpers (Matrix Logic) =====

function generateUnifiedTimesAndMasks() {
    const periods = window.schedulePeriods || [];
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];
    
    if (periods.length === 0) {
        console.warn("No Schedule Period Names found.");
        window.unifiedTimes = [];
        window.divisionActiveRows = {};
        return;
    }

    // 1. Find the full time range of the day
    let earliestMin = Infinity;
    let latestMin = -Infinity;
    
    availableDivisions.forEach(divName => {
        const rules = divisions[divName]?.periodRules || {};
        for (const periodId in rules) {
            const rule = rules[periodId];
            const start = parseTimeToMinutes(rule.start);
            const end = parseTimeToMinutes(rule.end);
            if (start != null) earliestMin = Math.min(earliestMin, start);
            if (end != null) latestMin = Math.max(latestMin, end);
        }
    });

    if (earliestMin === Infinity) {
        console.warn("No period times set for any division.");
        window.unifiedTimes = [];
        window.divisionActiveRows = {};
        return;
    }

    // 2. Generate unifiedTimes grid
    window.unifiedTimes = [];
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
    
    // 3. Generate divisionActiveRows (the "mask")
    window.divisionActiveRows = {};
    availableDivisions.forEach(divName => {
        const activeRows = new Set();
        const div = divisions[divName];
        if (!div) return;
        const rules = div.periodRules || {};

        for (const periodId in rules) {
            const rule = rules[periodId];
            const periodStartMin = parseTimeToMinutes(rule.start);
            const periodEndMin = parseTimeToMinutes(rule.end);
            if (periodStartMin == null || periodEndMin == null) continue;

            window.unifiedTimes.forEach((timeSlot, index) => {
                const slotStartMin = timeSlot.start.getHours() * 60 + timeSlot.start.getMinutes();
                if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
                    activeRows.add(index);
                }
            });
        }
        window.divisionActiveRows[divName] = activeRows;
    });
}

function buildSpanLenMaps() {
    const divisionSpanLens = {};
    const periods = window.schedulePeriods || [];
    const divisions = window.divisions || {};
    const availableDivisions = window.availableDivisions || [];
    const unifiedTimes = window.unifiedTimes || [];
    
    if (unifiedTimes.length === 0) return { divisionSpanLens };

    availableDivisions.forEach(divName => {
        const div = divisions[divName];
        if (!div) return;

        divisionSpanLens[divName] = {}; // { periodId: spanLen }
        const rules = div.periodRules || {};

        for (const periodId in rules) {
            const rule = rules[periodId];
            const startMin = parseTimeToMinutes(rule.start);
            const endMin = parseTimeToMinutes(rule.end);
            const numActivities = parseInt(rule.rule, 10) || 1;
            
            if (startMin == null || endMin == null) continue;

            const totalDuration = endMin - startMin;
            const totalSlots = Math.floor(totalDuration / INCREMENT_MINS);
            
            const spanLen = Math.max(1, Math.floor(totalSlots / numActivities));
            
            divisionSpanLens[divName][periodId] = spanLen;
        }
    });

    return { divisionSpanLens };
}

function getPeriodForSlot(slotIndex, divisionName) {
    const periods = window.schedulePeriods || [];
    const unifiedTimes = window.unifiedTimes || [];
    const div = window.divisions?.[divisionName];
    
    if (!unifiedTimes[slotIndex] || !div) return null;

    const slotStartMin = unifiedTimes[slotIndex].start.getHours() * 60 + unifiedTimes[slotIndex].start.getMinutes();
    const rules = div.periodRules || {};

    for (const periodId in rules) {
        const rule = rules[periodId];
        const periodStartMin = parseTimeToMinutes(rule.start);
        const periodEndMin = parseTimeToMinutes(rule.end);
        
        if (slotStartMin >= periodStartMin && slotStartMin < periodEndMin) {
            // Find the original period name
            const period = periods.find(p => p.id === periodId);
            return period;
        }
    }
    return null;
}

// ===== Fixed Activities =====
// (Unchanged - this system is now external and just places blocks)
// ... (loadActiveFixedActivities, findRowsForRange, etc.)

// ====== CORE ASSIGN (HEAVILY REFACTORED) ======
// ...
function assignFieldsToBunks() {
    // ... (Step 1 & 2: Load/Filter Data - Unchanged) ...
    // (Omitting for brevity)

    // ===== 3. NEW: GENERATE TIME GRID & RULES =====
    generateUnifiedTimesAndMasks();
    
    if (!window.unifiedTimes || window.unifiedTimes.length === 0) {
        console.warn("Cannot assign fields: No unified times were generated.");
        updateTable();
        return;
    }
    
    const { divisionSpanLens } = buildSpanLenMaps();
    const leagueSpanLen = Math.max(1, Math.ceil(LEAGUE_DURATION_MINS / INCREMENT_MINS));

    // ... (Step 4: Init Grids, Histories, Fixed - Unchanged) ...
    // (Omitting for brevity)

    // ===== 5. LEAGUES FIRST (Unchanged) =====
    // (Omitting for brevity)

    // =============================================================
    // ===== 6. SCHEDULE GENERAL/H2H (NEW DYNAMIC SPAN LOGIC) =====
    // =============================================================
    for (const div of availableDivisions) {
        const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? false;
        const allBunksInDiv = divisions[div]?.bunks || [];

        for (const bunk of allBunksInDiv) {
            for (let s = 0; s < window.unifiedTimes.length; s++) {
                if (scheduleAssignments[bunk][s]) continue;
                if (window.leagueAssignments?.[div]?.[s]) continue;
                if (!isActive(s)) continue;

                // ----- NEW DYNAMIC SPAN LOGIC -----
                const period = getPeriodForSlot(s, div); // Pass division!
                if (!period) continue; 
                
                const spanLen = divisionSpanLens[div]?.[period.id] || 1;
                const rule = divisions[div].periodRules[period.id];
                if (!rule) continue;

                const periodStartSlot = findRowsForRange(rule.start, rule.end)[0];
                if (periodStartSlot === -1) continue;
                
                if ((s - periodStartSlot) % spanLen !== 0) {
                    continue; // Not the start of a block
                }
                // ----- END NEW DYNAMIC SPAN LOGIC -----

                let assignedSpan = 0;
                // ... (Rest of logic: H2H_PROB, tryH2H, tryGeneralActivity...)
                // (This logic is unchanged, it just receives the new dynamic spanLen)
                // ...
                
                if (assignedSpan > 0) { 
                    s += (assignedSpan - 1); 
                }
            }
        }
    }

    // ===== 7. CALL FILLER PASSES =====
    // (Pass the new spanLen map)
    window.fillRemainingWithForcedH2HPlus?.(availableDivisions, divisions, divisionSpanLens, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount, generalActivityHistory);
    window.fillRemainingWithDoublingAggressive?.(availableDivisions, divisions, divisionSpanLens, fieldUsageBySlot, activityProperties, generalActivityHistory);
    window.fillRemainingWithFallbackSpecials?.(availableDivisions, divisions, divisionSpanLens, allActivities, fieldUsageBySlot, activityProperties, generalActivityHistory);
    
    updateTable();
    saveSchedule();
}
window.assignFieldsToBunks = assignFieldsToBunks;

// ===== Helpers for General/H2H placement =====
// (Unchanged - canActivityFit, assignActivity, etc. are just passed spanLen)
// ...
