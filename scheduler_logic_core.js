
// -------------------- scheduler_logic_core.js --------------------
// COMPLETE REWRITE FOR "SKELETON" MODEL
// -----------------------------------------------------------------

// ===== CONFIG =====
const INCREMENT_MINS = 30; // The base grid resolution
const DEFAULT_ACTIVITY_DURATION = 45; // Fallback

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
    console.log("Starting Skeleton Schedule Generation...");
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
        masterLeagues,
        yesterdayHistory
    } = loadAndFilterData();
    
    // This is the global "state" of the scheduler
    let fieldUsageBySlot = {}; // { 0: { "Court 1": 1, "Court 2": 2}, 1: ... }
    
    // ===== PASS 1: Generate Master Time Grid =====
    let earliestMin = Infinity;
    let latestMin = -Infinity;
    availableDivisions.forEach(divName => {
        const timeline = divisionSkeletons[divName]?.timeline;
        if (timeline) {
            earliestMin = Math.min(earliestMin, parseTimeToMinutes(timeline.start) || 540); // 540 = 9:00 AM
            latestMin = Math.max(latestMin, parseTimeToMinutes(timeline.end) || 960); // 960 = 4:00 PM
        }
    });

    // Failsafe if no divisions are set
    if (earliestMin === Infinity) earliestMin = 540;
    if (latestMin === -Infinity) latestMin = 960;

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

    // ===== START OF FIX for 'start' error =====
    if (window.unifiedTimes.length === 0) {
        console.warn("No time slots generated. Check division Start/End times.");
        updateTable(); // Show an empty table
        return;
    }
    console.log(`Generated ${window.unifiedTimes.length} time slots from ${fmtTime(window.unifiedTimes[0].start)} to ${fmtTime(window.unifiedTimes[window.unifiedTimes.length-1].end)}`);
    // ===== END OF FIX =====

    // Initialize all bunks with empty arrays for the new grid
    availableDivisions.forEach(divName => {
        (divisions[divName]?.bunks || []).forEach(bunk => {
            window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
        });
    });

    // ===== PASS 2: Place "Pinned" Events (e.g., Lunch, Trips) =====
    
    // 2a. Place Daily Overrides (Trips) - HIGHEST PRIORITY
    // TODO: Implement window.DailyOverrides.prePlaceTrips()
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
    console.log("Pass 2: Placed all 'Pinned' events.");

    // ===== PASS 3: Auto-Calculate & Create "Activity Slot" Blocks =====
    
    let allSchedulableBlocks = []; // { divName, bunk, startTime, endTime, duration, slots: [], type: 'slot' }
    
    availableDivisions.forEach(divName => {
        const skeletonData = divisionSkeletons[divName];
        if (!skeletonData) return;
        
        const bunks = divisions[divName]?.bunks || [];
        const divStart = parseTimeToMinutes(skeletonData.timeline.start);
        const divEnd = parseTimeToMinutes(skeletonData.timeline.end);

        // Get this division's skeleton
        const skeleton = skeletonData.skeleton || [];
        
        // Find all "pinned" events to identify gaps
        const pinnedBlocks = [];
        // Add "Trips" here from overrides
        // ...
        
        // Add "pinned" skeleton events
        skeleton.forEach(item => {
            if (item.type === 'pinned' && item.startTime) {
                const start = parseTimeToMinutes(item.startTime);
                const duration = parseInt(item.duration, 10) || INCREMENT_MINS;
                if (start != null) {
                    pinnedBlocks.push({ start, end: start + duration, item });
                }
            }
        });
        
        // Add "un-pinned" fixed events (like Swim) - more complex, skip for now

        // Sort pinned blocks to find gaps
        pinnedBlocks.sort((a, b) => a.start - b.start);

        let gapGroups = []; // { gap: {start, end}, slots: [] }
        let currentGapSlots = [];
        let lastPinnedEnd = divStart;

        skeleton.forEach(item => {
            if (item.type === 'slot') {
                currentGapSlots.push(item);
            } else if (item.type === 'pinned' && item.startTime) {
                const pinnedStart = parseTimeToMinutes(item.startTime);
                if (pinnedStart == null) return;
                
                // We found a pin, so process the gap before it
                gapGroups.push({
                    gap: { start: lastPinnedEnd, end: pinnedStart },
                    slots: currentGapSlots
                });
                // Reset for the next gap
                currentGapSlots = [];
                lastPinnedEnd = pinnedStart + (parseInt(item.duration, 10) || INCREMENT_MINS);
            }
        });
        
        // Add any remaining slots after the last pin
        gapGroups.push({
            gap: { start: lastPinnedEnd, end: divEnd },
            slots: currentGapSlots
        });

        // Now, process these gap groups to create schedulable blocks
        // THIS IS THE FIX for your 1st/2nd Grade problem
        gapGroups.forEach(group => {
            const gapStart = group.gap.start;
            const gapEnd = group.gap.end;
            const gapDuration = gapEnd - gapStart;
            const numSlots = group.slots.length;
            
            if (numSlots === 0 || gapDuration <= 0) return;

            // Calculate duration, rounding to the nearest INCREMENT
            // Fix: ensure avgDuration is at least one INCREMENT_MINS
            let avgDuration = Math.max(INCREMENT_MINS, Math.round((gapDuration / numSlots) / INCREMENT_MINS) * INCREMENT_MINS);
            if (avgDuration === 0) return;

            let currentSlotStart = gapStart;

            for (let i = 0; i < numSlots; i++) {
                // Ensure the last slot fills the remaining time
                let duration = (i === numSlots - 1) ? (gapEnd - currentSlotStart) : avgDuration;
                // Ensure duration is positive
                if (duration <= 0) continue;

                const slotStartMin = currentSlotStart;
                const slotEndMin = currentSlotStart + duration;
                
                const gridSlots = findSlotsForRange(slotStartMin, slotEndMin);
                
                bunks.forEach(bunk => {
                    allSchedulableBlocks.push({
                        divName: divName,
                        bunk: bunk,
                        startTime: slotStartMin,
                        endTime: slotEndMin,
                        duration: duration,
                        slots: gridSlots,
                        shoppingList: skeletonData.shoppingList,
                        type: 'slot' // Mark as a generic slot
                    });
                });
                currentSlotStart += duration;
            }
        });
    });
    console.log(`Pass 3: Created ${allSchedulableBlocks.length} schedulable blocks from skeletons.`);

    // ===== PASS 4: Optimize & Fill Schedulable Blocks =====
    
    // Create a mutable "shopping list" for each division
    let shoppingListNeeds = {};
    availableDivisions.forEach(divName => {
        const list = divisionSkeletons[divName]?.shoppingList || {};
        shoppingListNeeds[divName] = {
            leagues: parseInt(list.leagues, 10) || 0,
            specials: parseInt(list.specials, 10) || 0
        };
    });

    // Sort all blocks by start time to process the day chronologically
    allSchedulableBlocks.sort((a, b) => a.startTime - b.startTime);

    for (const block of allSchedulableBlocks) {
        // Skip if this block has already been filled (e.g., by H2H)
        if (window.scheduleAssignments[block.bunk][block.slots[0]]) continue;
        
        const needs = shoppingListNeeds[block.divName];
        let filled = false;

        // --- 4a. Try to fill with high-priority "Leagues" ---
        if (needs.leagues > 0) {
            const league = findAvailableLeague(block, masterLeagues, fieldsBySport, fieldUsageBySlot, activityProperties);
            if (league) {
                fillBlock(block, league, fieldUsageBySlot, yesterdayHistory);
                needs.leagues--;
                filled = true;
            }
        }
        
        // --- 4b. Try to fill with "Specials" ---
        if (!filled && needs.specials > 0) {
            const special = findAvailableSpecial(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties);
            if (special) {
                fillBlock(block, special, fieldUsageBySlot, yesterdayHistory);
                needs.specials--;
                filled = true;
            }
        }

        // --- 4c. Fill with "General Activity" ---
        if (!filled) {
            const pick = findAvailableGeneral(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties);
            if (pick) {
                fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory);
                filled = true;
            } else {
                // Failsafe: just put "Free"
                fillBlock(block, { field: "Free", sport: null }, fieldUsageBySlot, yesterdayHistory);
            }
        }
    }
    console.log("Pass 4: Optimized and filled all schedulable blocks.");
    
    // ===== PASS 5: Save unifiedTimes and Update the UI =====
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes); // Save the generated grid!
    window.updateTable?.();
    window.saveSchedule?.(); // This function is in scheduler_ui.js
    console.log("Schedule Generation Complete.");
}

// --- Helper functions for Pass 3 & 4 ---

function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes) return slots;
    
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStart = slot.start.getHours() * 60 + slot.start.getMinutes();
        const slotEnd = slot.end.getHours() * 60 + slot.end.getMinutes();
        
        // A slot is "in" if its start time is in the range
        // (This logic ensures we get 12:00, 12:30 for a 12:00-1:00 block)
        if (slotStart >= startMin && slotStart < endMin) {
            slots.push(i);
        }
    }
    return slots;
}

function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory) {
    const fieldName = fieldLabel(pick.field);
    const sport = pick.sport;
    
    // In a real implementation, collision check would happen *before* calling fillBlock
    // For now, we just place it.
    
    block.slots.forEach((slotIndex, idx) => {
        // Failsafe: check if slotIndex is valid
        if (slotIndex === undefined || slotIndex >= window.unifiedTimes.length) {
             console.error("Invalid slotIndex in fillBlock", slotIndex, block);
             return;
        }
        
        // Check if bunk array exists
        if (!window.scheduleAssignments[block.bunk]) {
            console.error("Missing schedule array for bunk", block.bunk);
            return;
        }

        if (!window.scheduleAssignments[block.bunk][slotIndex]) {
            window.scheduleAssignments[block.bunk][slotIndex] = {
                field: fieldName,
                sport: sport,
                continuation: (idx > 0),
                _fixed: false,
                _h2h: pick._h2h || false, // Add H2H flag if needed
                vs: pick.vs || null
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

// --- Optimizer "Finder" functions ---

// ===== START OF FIX: Passing fieldUsageBySlot =====
function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    let canFit = true;
    for (const slotIndex of block.slots) {
        const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || 0;
        const props = activityProperties[fieldName];
        
        if (usage > 0) {
            if (!props || !props.sharable || usage >= 2) {
                canFit = false; break;
            }
            // TODO: Add division/bunk limit checks
        }
    }
    return canFit;
}

function findAvailableLeague(block, masterLeagues, fieldsBySport, fieldUsageBySlot, activityProperties) {
    // 1. Find the league for this division
    const divLeague = Object.values(masterLeagues).find(l => l.enabled && l.divisions.includes(block.divName));
    if (!divLeague) return null;

    // 2. Get its sports
    const sports = divLeague.sports || [];
    if (sports.length === 0) return null;
    
    // 3. Find available fields for those sports
    for (const sport of sports) {
        const possibleFields = fieldsBySport[sport] || [];
        for (const fieldName of possibleFields) {
            // 4. Check if field is free
            if (canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot)) {
                // 5. If yes, return a "pick" object
                return { field: fieldName, sport: sport }; 
            }
        }
    }
    return null; // No available league fields
}

function findAvailableSpecial(block, allActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    const specials = allActivities.filter(a => a.type === 'special');
    // TODO: Use yesterdayHistory to pick a "fresh" one
    for (const pick of specials.sort(() => 0.5 - Math.random())) {
        if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    return null;
}

function findAvailableGeneral(block, allActivities, h2hActivities, fieldUsageBySlot, yesterdayHistory, activityProperties) {
    // This is where the H2H, "freshness" check, etc., would go.
    
    // TODO: 1. Attempt H2H
    
    // 2. Attempt "fresh" general activity
    const fields = allActivities.filter(a => a.type === 'field');
    for (const pick of fields.sort(() => 0.5 - Math.random())) {
         if (canBlockFit(block, fieldLabel(pick.field), activityProperties, fieldUsageBySlot)) {
            return pick;
        }
    }
    // Failsafe
    return fields[0] || { field: "Free", sport: null };
}
// ===== END OF FIX =====


function loadAndFilterData() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const masterFields = app1Data.fields || [];
    const masterDivisions = app1Data.divisions || {};
    const masterAvailableDivs = app1Data.availableDivisions || [];
    const masterSpecials = app1Data.specialActivities || [];
    const masterSkeletons = app1Data.divisionSkeletons || {};
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
        divisionSkeletons,
        activityProperties,
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        yesterdayHistory
    };
}
