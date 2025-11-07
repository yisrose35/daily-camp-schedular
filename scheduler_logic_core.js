// -------------------- scheduler_logic_core.js --------------------
// REFACTORED FOR "MATRIX" (Per-Division Period Times)
// ...
// -----------------------------------------------------------------

// ===== CONFIG =====
const INCREMENT_MINS = 30;
const LEAGUE_DURATION_MINS = 30; 

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
function getActivityName(pick) {
    if (pick.sport) return pick.sport; // e.g., "Basketball"
    return fieldLabel(pick.field); // e.g., "Gameroom"
}

// ----- FIX: ADDED fmtTime HELPER -----
function fmtTime(d) {
    if (!d) return "";
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ===== NEW: Period/Time Generation Helpers (Matrix Logic) =====

function generateUnifiedTimesAndMasks() {
    // ... (rest of the function is unchanged)
    // ... (omitted for brevity)
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
            label: `${fmtTime(startDate)} - ${fmtTime(endDate)}` // This line needs fmtTime
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
    // ... (rest of the function is unchanged)
    // ... (omitted for brevity)
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
    // ... (rest of the function is unchanged)
    // ... (omitted for brevity)
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

// ... (Rest of file: loadActiveFixedActivities, prePlaceFixedActivities, leaguesSnapshot, etc.)
// ... (CORE ASSIGN: assignFieldsToBunks)
// ... (Helpers: tryGeneralActivity, tryH2H, canActivityFit, assignActivity)
// (All this logic remains the same as the previous file)
