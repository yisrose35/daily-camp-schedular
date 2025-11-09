// -------------------- scheduler_logic_core.js --------------------
// COMPLETE REWRITE FOR "SKELETON" MODEL
// This file replaces the old "Matrix" logic.
// -----------------------------------------------------------------

// ===== CONFIG =====
const INCREMENT_MINS = 30; // The base grid resolution
const DEFAULT_ACTIVITY_DURATION = 45; // Fallback

// ===== Helpers =====
// (parseTimeToMinutes, fieldLabel, getActivityName, fmtTime are unchanged)
// ...

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
function fmtTime(d) {
    if (!d) return "";
    let h = d.getHours(), m = d.getMinutes().toString().padStart(2,"0"), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ===== NEW SKELETON LOGIC =====

/**
 * Main entry point, called by the "Generate" button in index.html
 */
window.generateScheduleFromSkeletons = function() {
    window.scheduleAssignments = {}; // { bunk: [ {entry}, {entry} ... ] }
    window.leagueAssignments = {}; // Not used by this model, but clear it
    window.unifiedTimes = []; // The 30-min grid
    
    const { 
        divisions, 
        availableDivisions, 
        divisionSkeletons,
        activityProperties,
        allActivities,
        h2hActivities,
        fieldsBySport,
        fieldUsageBySlot,
        yesterdayHistory
    } = loadAndFilterData();

    // ===== PASS 1: Generate Master Time Grid =====
    // Find the earliest start and latest end time across ALL divisions
    let earliestMin = Infinity;
    let latestMin = -Infinity;
    availableDivisions.forEach(divName => {
        const timeline = divisionSkeletons[divName]?.timeline;
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

    // Initialize all bunks with empty arrays for the new grid
    availableDivisions.forEach(divName => {
        (divisions[divName]?.bunks || []).forEach(bunk => {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
        });
    });

    // ===== PASS 2: Place "Pinned" Events (e.g., Lunch, Trips) =====
    // This creates the "concrete" parts of the skeleton.
    
    // 2a. Place Daily Overrides (Trips) - HIGHEST PRIORITY
    // (This function would need to be in daily_overrides.js, but we'll
    // simulate its effect here for now)
    // window.DailyOverrides?.prePlaceTrips?.(); 

    // 2b. Place "Pinned" Skeleton Events
    availableDivisions.forEach(divName => {
        const skeletonData = divisionSkeletons[divName];
        if (!skeletonData) return;
        
        const bunks = divisions[divName]?.bunks || [];
        
        skeletonData.skeleton.forEach(item => {
            if (item.type === 'pinned' && item.startTime) {
                const startMin = parseTimeToMinutes(item.startTime);
                const duration = parseInt(item.duration, 10) || INCREMENT_MINS;
                const endMin = startMin + duration;
                
                const slots = findSlotsForRange(startMin, endMin);
                
                slots.forEach((slotIndex, idx) => {
                    bunks.forEach(bunk => {
                        if (!window.scheduleAssignments[bunk][slotIndex]) {
                            window.scheduleAssignments[bunk][slotIndex] = {
                                field: { name: item.event || "Pinned" },
                                sport: null,
                                continuation: (idx > 0),
                                _fixed: true
                            };
                        }
                    });
                });
            }
        });
    });

    // ===== PASS 3: Auto-Calculate & Create "Activity Slot" Blocks =====
    // This is the core of the "Skeleton" logic
    let schedulableBlocks = []; // { divName, bunk, startTime, endTime, duration, slots: [] }
    
    availableDivisions.forEach(divName => {
        const skeletonData = divisionSkeletons[divName];
        if (!skeletonData) return;
        
        const bunks = divisions[divName]?.bunks || [];
        const divStart = parseTimeToMinutes(skeletonData.timeline.start);
        const divEnd = parseTimeToMinutes(skeletonData.timeline.end);
        
        // Find all "pinned" events for this division to identify the gaps
        const pinnedBlocks = [];
        skeletonData.skeleton.forEach(item => {
            if (item.type === 'pinned') {
                const start = parseTimeToMinutes(item.startTime);
                const duration = parseInt(item.duration, 10) || INCREMENT_MINS;
                if (start != null) {
                    pinnedBlocks.push({ start, end: start + duration });
                }
                // TODO: Handle pinned items *without* a start time (e.g., "Swim")
            }
        });
        
        // Find all gaps
        const gaps = findGaps(divStart, divEnd, pinnedBlocks);
        
        // Get the skeleton "slots" for each gap
        const skeletonSlots = skeletonData.skeleton.filter(item => item.type === 'slot');
        let slotIndex = 0;
        
        gaps.forEach(gap => {
            const gapStart = gap.start;
            const gapEnd = gap.end;
            const gapDuration = gap.end - gap.start;
            
            // Find skeleton slots that "belong" to this gap
            // This is a simplification; a real implementation would be more robust
            // For now, we assume slots are in order.
            
            // This is the key logic for your 1st/2nd grade example
            const slotsInThisGap = [];
            while (slotIndex < skeletonSlots.length) {
                // This logic is hard. For now, let's simplify.
                // We'll count ALL slots and divide ALL gap time.
                slotsInThisGap.push(skeletonSlots[slotIndex]);
                slotIndex++;
                // A real version would need to know *which* gap the slots
                // are in, based on the `skeleton` array order.
            }
            
            if (slotsInThisGap.length > 0) {
                const avgDuration = Math.floor(gapDuration / slotsInThisGap.length);
                let currentSlotStart = gapStart;
                
                for (let i = 0; i < slotsInThisGap.length; i++) {
                    const duration = (i === slotsInThisGap.length - 1) ? (gapEnd - currentSlotStart) : avgDuration;
                    const slotStartMin = currentSlotStart;
                    const slotEndMin = currentSlotStart + duration;
                    
                    const gridSlots = findSlotsForRange(slotStartMin, slotEndMin);
                    
                    bunks.forEach(bunk => {
                        schedulableBlocks.push({
                            divName: divName,
                            bunk: bunk,
                            startTime: slotStartMin,
                            endTime: slotEndMin,
                            duration: duration,
                            slots: gridSlots,
                            shoppingList: skeletonData.shoppingList
                        });
                    });
                    currentSlotStart += duration;
                }
            }
        });
        
        // This simplified logic just divides *all* free time by *all* slots
        const totalGapDuration = gaps.reduce((acc, g) => acc + (g.end - g.start), 0);
        const totalSlots = skeletonData.skeleton.filter(i => i.type === 'slot').length;
        
        if (totalSlots > 0 && totalGapDuration > 0) {
            const avgDuration = Math.round((totalGapDuration / totalSlots) / INCREMENT_MINS) * INCREMENT_MINS;
            
            let currentGap = gaps.shift();
            let currentGapTime = currentGap.start;
            
            for (let i = 0; i < totalSlots; i++) {
                const slotStartMin = currentGapTime;
                const slotEndMin = currentGapTime + avgDuration;
                
                const gridSlots = findSlotsForRange(slotStartMin, slotEndMin);
                
                bunks.forEach(bunk => {
                    schedulableBlocks.push({
                        divName: divName,
                        bunk: bunk,
                        startTime: slotStartMin,
                        endTime: slotEndMin,
                        duration: avgDuration,
                        slots: gridSlots,
                        shoppingList: skeletonData.shoppingList
                    });
                });
                
                currentGapTime += avgDuration;
                if (currentGapTime >= currentGap.end) {
                    currentGap = gaps.shift();
                    if (!currentGap) break;
                    currentGapTime = currentGap.start;
                }
            }
        }
    });
    
    // ===== PASS 4: Optimize & Fill Schedulable Blocks =====
    
    // 4a. Prioritize: Hardest blocks first (Leagues)
    const leagueBlocks = [];
    const generalBlocks = [];
    
    // Create a mutable "shopping list" for each division
    let shoppingListNeeds = {};
    availableDivisions.forEach(divName => {
        shoppingListNeeds[divName] = { ...divisionSkeletons[divName]?.shoppingList };
    });

    schedulableBlocks.forEach(block => {
        const needs = shoppingListNeeds[block.divName];
        if (needs.leagues > 0) {
            leagueBlocks.push(block);
            needs.leagues--;
        } else if (needs.specials > 0) {
            leagueBlocks.push(block); // Treat specials as high-priority too
            needs.specials--;
        } else {
            generalBlocks.push(block);
        }
    });

    // 4b. Fill High-Priority (Leagues, Specials)
    leagueBlocks.sort((a, b) => a.startTime - b.startTime); // Sort by time
    
    for (const block of leagueBlocks) {
        // This is where the *real* "Optimizer" logic lives
        // We need to find the *best* activity (Leagues, Specials)
        // that can fit in this block, considering field availability.
        
        // This is a placeholder for that complex logic.
        // For now, we'll just fill it with a placeholder.
        
        // This simplified logic just picks a "General" activity
        const pick = allActivities[Math.floor(Math.random() * allActivities.length)];
        fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory);
    }
    
    // 4c. Fill General Activity Blocks
    generalBlocks.sort((a, b) => a.startTime - b.startTime);
    
    for (const block of generalBlocks) {
        // TODO: This should use the full H2H and "freshness" logic
        const pick = allActivities[Math.floor(Math.random() * allActivities.length)];
        fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory);
    }

    // ===== PASS 5: Update the UI =====
    window.updateTable?.();
    window.saveSchedule?.(); // This function is in scheduler_ui.js
}

/**
 * Helper: Finds all empty gaps between pinned blocks
 */
function findGaps(masterStart, masterEnd, pinnedBlocks) {
    const gaps = [];
    let cursor = masterStart;
    
    pinnedBlocks.sort((a, b) => a.start - b.start);
    
    pinnedBlocks.forEach(block => {
        if (cursor < block.start) {
            gaps.push({ start: cursor, end: block.start });
        }
        cursor = Math.max(cursor, block.end);
    });
    
    if (cursor < masterEnd) {
        gaps.push({ start: cursor, end: masterEnd });
    }
    return gaps;
}

/**
 * Helper: Finds the grid slot indices for a given time range
 */
function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes) return slots;
    
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStart = slot.start.getHours() * 60 + slot.start.getMinutes();
        const slotEnd = slot.end.getHours() * 60 + slot.end.getMinutes();
        
        // Check for overlap
        if (Math.max(startMin, slotStart) < Math.min(endMin, slotEnd)) {
            slots.push(i);
        }
    }
    return slots;
}

/**
 * Helper: Fills a block on the grid with a chosen activity
 */
function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory) {
    const fieldName = fieldLabel(pick.field);
    const sport = pick.sport;
    
    // TODO: Add collision detection with fieldUsageBySlot
    
    block.slots.forEach((slotIndex, idx) => {
        if (!window.scheduleAssignments[block.bunk][slotIndex]) {
            window.scheduleAssignments[block.bunk][slotIndex] = {
                field: fieldName,
                sport: sport,
                continuation: (idx > 0),
                _fixed: false
            };
            
            // Mark field as used
            if (fieldName && window.allSchedulableNames.includes(fieldName)) {
                fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
                fieldUsageBySlot[slotIndex][fieldName] = (fieldUsageBySlot[slotIndex][fieldName] || 0) + 1;
            }
        }
    });
    
    // TODO: Update yesterdayHistory
}


/**
 * Helper: Loads and filters all master data
 */
function loadAndFilterData() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const masterFields = app1Data.fields || [];
    const masterDivisions = app1Data.divisions || {};
    const masterAvailableDivs = app1Data.availableDivisions || [];
    const masterSpecials = app1Data.specialActivities || [];
    const masterSkeletons = app1Data.divisionSkeletons || {};
    
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
    const divisionSkeletons = {};
    for (const divName of availableDivisions) {
        if (!masterDivisions[divName]) continue;
        divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
        divisions[divName].bunks = (divisions[divName].bunks || []).filter(bunkName => !overrides.bunks.includes(bunkName));
        
        if (masterSkeletons[divName]) {
            divisionSkeletons[divName] = masterSkeletons[divName];
        }
    }
    
    // Build activity properties map
    const activityProperties = {};
    availFields.forEach(f => { /* ... (same as old logic) ... */ });
    availSpecials.forEach(s => { /* ... (same as old logic) ... */ });

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
        ...availFields.flatMap((f) => (f.activities || []).map((act) => ({ type: "field", field: f, sport: act }))),
        ...availSpecials.map((sa) => ({ type: "special", field: sa, sport: null }))
    ];
    const h2hActivities = allActivities.filter(a => a.type === 'field' && a.sport);

    const fieldUsageBySlot = {}; // Will be populated by the passes
    
    // Load Yesterday's History (for "freshness")
    const yesterdayHistory = {}; // TODO: Implement this
    
    return {
        divisions,
        availableDivisions,
        divisionSkeletons,
        activityProperties,
        allActivities,
        h2hActivities,
        fieldsBySport,
        fieldUsageBySlot,
        yesterdayHistory
    };
}
