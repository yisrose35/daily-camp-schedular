
// ============================================================================
// scheduler_core_utils.js
// PART 1 of 3: THE FOUNDATION
//
// Role:
// - Data Loading
// - Constraint Logic (canBlockFit)
// - FIX: Refined "Lookback" logic to check specific end times.
//        (Fixes 2:15 vs 2:20 gap while catching 2:30 vs 2:20 overlap)
// - FIX: Removed syntax error (extra brace at end of file)
// - FIX: Added missing parseTimeRule helper function
// ============================================================================

(function() {
    'use strict';

    // ===== CONFIG =====
    const INCREMENT_MINS = 30;
    window.INCREMENT_MINS = INCREMENT_MINS;

    const Utils = {};

    // =================================================================
    // 1. BASIC HELPERS
    // =================================================================
    Utils.parseTimeToMinutes = function(str) {
        if (str == null) return null;
        if (typeof str === "number") return str;
        if (typeof str !== "string") return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith("am") || s.endsWith("pm")) {
            mer = s.endsWith("am") ? "am" : "pm";
            s = s.replace(/am|pm/g, "").trim();
        } else return null;
        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
        if (mer) {
            if (hh === 12) hh = (mer === "am") ? 0 : 12;
            else if (mer === "pm") hh += 12;
        }
        return hh * 60 + mm;
    };

    Utils.fieldLabel = function(f) {
        if (typeof f === "string") return f;
        if (f && typeof f === "object" && typeof f.name === "string") return f.name;
        return "";
    };

    Utils.fmtTime = function(d) {
        if (!d) return "";
        if (typeof d === 'string') d = new Date(d);
        let h = d.getHours();
        let m = d.getMinutes().toString().padStart(2, "0");
        const ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${m} ${ap}`;
    };

    Utils.minutesToDate = function(mins) {
        const d = new Date(1970, 0, 1, 0, 0, 0);
        d.setMinutes(mins);
        return d;
    };

    // --- REVERTED: Standard Start-Time Logic ---
    // This ensures contiguous blocks (9:45-10:30) don't double-book the 9:30 slot.
    Utils.findSlotsForRange = function(startMin, endMin) {
        const slots = [];
        if (!window.unifiedTimes || startMin == null || endMin == null) return slots;
        for (let i = 0; i < window.unifiedTimes.length; i++) {
            const slot = window.unifiedTimes[i];
            const d = new Date(slot.start);
            const slotStart = d.getHours() * 60 + d.getMinutes();
            // Start Time Logic: Activity must START in the slot (or be exactly the slot)
            // But we treat it as [inclusive, exclusive)
            if (slotStart >= startMin && slotStart < endMin) {
                slots.push(i);
            }
        }
        return slots;
    };

    Utils.getBlockTimeRange = function(block) {
        let blockStartMin = (typeof block.startTime === "number") ? block.startTime : null;
        let blockEndMin = (typeof block.endTime === "number") ? block.endTime : null;
        if ((blockStartMin == null || blockEndMin == null) &&
            window.unifiedTimes &&
            Array.isArray(block.slots) &&
            block.slots.length > 0) {
            const minIndex = Math.min(...block.slots);
            const maxIndex = Math.max(...block.slots);
            const firstSlot = window.unifiedTimes[minIndex];
            const lastSlot = window.unifiedTimes[maxIndex];
            if (firstSlot && lastSlot) {
                const firstStart = new Date(firstSlot.start);
                const lastStart = new Date(lastSlot.start);
                blockStartMin = firstStart.getHours() * 60 + firstStart.getMinutes();
                blockEndMin = lastStart.getHours() * 60 +
                              lastStart.getMinutes() +
                              INCREMENT_MINS;
            }
        }
        return { blockStartMin, blockEndMin };
    };

    // =================================================================
    // 2. CONSTRAINT LOGIC
    // =================================================================
    Utils.isTimeAvailable = function(slotIndex, fieldProps) {
        if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
        const slot = window.unifiedTimes[slotIndex];
        const slotStartMin = new Date(slot.start).getHours() * 60 +
                             new Date(slot.start).getMinutes();
        const slotEndMin = slotStartMin + INCREMENT_MINS;
        const rules = (fieldProps.timeRules || []).map(r => {
            if (typeof r.startMin === "number" && typeof r.endMin === "number") return r;
            return {
                ...r,
                startMin: Utils.parseTimeToMinutes(r.start),
                endMin: Utils.parseTimeToMinutes(r.end)
            };
        });

        if (rules.length === 0) return fieldProps.available;
        if (!fieldProps.available) return false;

        const hasAvailableRules = rules.some(r => r.type === 'Available');
        let isAvailable = !hasAvailableRules;

        for (const rule of rules) {
            if (rule.type === 'Available') {
                if (rule.startMin == null || rule.endMin == null) continue;
                if (slotStartMin >= rule.startMin && slotEndMin <= rule.endMin) {
                    isAvailable = true;
                    break;
                }
            }
        }
        for (const rule of rules) {
            if (rule.type === 'Unavailable') {
                if (rule.startMin == null || rule.endMin == null) continue;
                if (slotStartMin < rule.endMin && slotEndMin > rule.startMin) {
                    isAvailable = false;
                    break;
                }
            }
        }
        return isAvailable;
    };

    // Main capacity check (UPDATED with Granular Lookback)
    Utils.canBlockFit = function(block, fieldName, activityProperties, fieldUsageBySlot, proposedActivity) {
        if (!fieldName) return false;
        const props = activityProperties[fieldName];
        if (!props) return true;

        let limit = 1;
        if (props.sharableWith) {
            if (props.sharableWith.capacity) limit = parseInt(props.sharableWith.capacity);
            else if (props.sharable || props.sharableWith.type === 'all' || props.sharableWith.type === 'custom') limit = 2;
        } else if (props.sharable) {
            limit = 2;
        }

        const bunkMetaData = window.SchedulerCoreUtils._bunkMetaData || {};
        const sportMetaData = window.SchedulerCoreUtils._sportMetaData || {};
        const maxHeadcount = sportMetaData[proposedActivity]?.maxCapacity || Infinity;
        const mySize = bunkMetaData[block.bunk]?.size || 0;

        // Preferences checks
        if (props.preferences && props.preferences.enabled && props.preferences.exclusive && !props.preferences.list.includes(block.divName)) return false;
        if (props && Array.isArray(props.allowedDivisions) && props.allowedDivisions.length > 0 && !props.allowedDivisions.includes(block.divName)) return false;
        const limitRules = props.limitUsage;
        if (limitRules && limitRules.enabled) {
            if (!limitRules.divisions[block.divName]) return false;
            const allowedBunks = limitRules.divisions[block.divName];
            if (allowedBunks.length > 0 && block.bunk && !allowedBunks.includes(block.bunk)) return false;
        }

        const { blockStartMin, blockEndMin } = Utils.getBlockTimeRange(block);
        const rules = (props.timeRules || []).map(r => {
            if (typeof r.startMin === "number" && typeof r.endMin === "number") return r;
            return { ...r, startMin: Utils.parseTimeToMinutes(r.start), endMin: Utils.parseTimeToMinutes(r.end) };
        });

        // Time Rules
        if (rules.length > 0) {
            if (!props.available) return false;
            const hasAvailableRules = rules.some(r => r.type === 'Available');
            if (blockStartMin != null && blockEndMin != null) {
                if (hasAvailableRules) {
                    let insideAvailable = false;
                    for (const rule of rules) {
                        if (rule.type !== 'Available' || rule.startMin == null || rule.endMin == null) continue;
                        if (blockStartMin >= rule.startMin && blockEndMin <= rule.endMin) {
                            insideAvailable = true;
                            break;
                        }
                    }
                    if (!insideAvailable) return false;
                }
                for (const rule of rules) {
                    if (rule.type !== 'Unavailable' || rule.startMin == null || rule.endMin == null) continue;
                    if (blockStartMin < rule.endMin && blockEndMin > rule.startMin) return false;
                }
            }
        } else {
            if (!props.available) return false;
        }

        // --- NEW: PRE-SLOT LOOKBACK (Refined for exact time checks) ---
        // If the activity starts BEFORE the assigned visual slot (e.g. 2:20 start for 2:30 slot),
        // we check the previous slot (2:00-2:30).
        if (blockStartMin != null && block.slots && block.slots.length > 0) {
            const firstSlotIndex = block.slots[0];
            if (firstSlotIndex > 0) {
                const firstSlotStart = new Date(window.unifiedTimes[firstSlotIndex].start).getHours() * 60 + 
                                       new Date(window.unifiedTimes[firstSlotIndex].start).getMinutes();
                
                // If Activity (2:20) starts BEFORE Slot (2:30), it "bleeds" into the previous slot
                if (blockStartMin < firstSlotStart) {
                    const prevSlotIndex = firstSlotIndex - 1;
                    const prevUsage = fieldUsageBySlot[prevSlotIndex]?.[fieldName];
                    
                    if (prevUsage && prevUsage.count > 0) {
                        // Check if the actual activities in previous slot END after our start time
                        let overlappingCount = 0;
                        const assignments = window.scheduleAssignments || {};
                        
                        // prevUsage.bunks is { "BunkName": "ActivityName" }
                        Object.keys(prevUsage.bunks).forEach(bunkName => {
                            const entry = assignments[bunkName]?.[prevSlotIndex];
                            if (entry) {
                                // Default to slot boundary if _endTime is missing
                                const entEnd = entry._endTime ?? firstSlotStart; 
                                
                                // Scenario 1: A ends 2:15. B starts 2:20. (2:15 > 2:20 is False). No Overlap.
                                // Scenario 2: A ends 2:30. B starts 2:20. (2:30 > 2:20 is True). Overlap!
                                if (entEnd > blockStartMin) {
                                    overlappingCount++;
                                }
                            } else {
                                // Fallback: Assume full slot usage if we can't find entry
                                overlappingCount++;
                            }
                        });

                        if (overlappingCount >= limit) {
                            return false; // Conflict found
                        }
                    }
                }
            }
        }

        // Standard Slot Usage Check
        for (const slotIndex of block.slots || []) {
            if (slotIndex === undefined) return false;
            const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [], bunks: {} };
            
            if (usage.count >= limit) return false;
            
            if (maxHeadcount !== Infinity) {
                let currentHeadcount = 0;
                Object.keys(usage.bunks).forEach(bName => {
                    currentHeadcount += (bunkMetaData[bName]?.size || 0);
                });
                if (currentHeadcount + mySize > maxHeadcount) return false;
            }

            if (usage.count > 0) {
                let existingActivity = null;
                for (const bunkName in usage.bunks) {
                    if (usage.bunks[bunkName]) {
                        existingActivity = usage.bunks[bunkName];
                        break;
                    }
                }
                if (existingActivity && proposedActivity && existingActivity !== proposedActivity) return false;
            }
            if (!Utils.isTimeAvailable(slotIndex, props)) return false;
        }
        return true;
    };

    // League Check (Apply same Lookback fix)
    Utils.canLeagueGameFit = function(block, fieldName, fieldUsageBySlot, activityProperties) {
        if (!fieldName) return false;
        const props = activityProperties[fieldName];
        if (!props) return false;
        const limit = 1;

        if (props.preferences && props.preferences.enabled && props.preferences.exclusive && !props.preferences.list.includes(block.divName)) return false;
        if (props && Array.isArray(props.allowedDivisions) && props.allowedDivisions.length > 0 && !props.allowedDivisions.includes(block.divName)) return false;

        const limitRules = props.limitUsage;
        if (limitRules && limitRules.enabled) {
            if (!limitRules.divisions[block.divName]) return false;
        }

        if (!props.available) return false;

        // --- NEW: LEAGUE PRE-SLOT LOOKBACK (Refined) ---
        const { blockStartMin } = Utils.getBlockTimeRange(block);
        if (blockStartMin != null && block.slots && block.slots.length > 0) {
            const firstSlotIndex = block.slots[0];
            if (firstSlotIndex > 0) {
                const firstSlotStart = new Date(window.unifiedTimes[firstSlotIndex].start).getHours() * 60 + 
                                       new Date(window.unifiedTimes[firstSlotIndex].start).getMinutes();
                if (blockStartMin < firstSlotStart) {
                    const prevSlotIndex = firstSlotIndex - 1;
                    const prevUsage = fieldUsageBySlot[prevSlotIndex]?.[fieldName];
                    
                    if (prevUsage && prevUsage.count > 0) {
                        let overlappingCount = 0;
                        const assignments = window.scheduleAssignments || {};
                        Object.keys(prevUsage.bunks).forEach(bunkName => {
                            const entry = assignments[bunkName]?.[prevSlotIndex];
                            if (entry) {
                                const entEnd = entry._endTime ?? firstSlotStart;
                                if (entEnd > blockStartMin) overlappingCount++;
                            } else {
                                overlappingCount++;
                            }
                        });
                        if (overlappingCount >= limit) return false;
                    }
                }
            }
        }

        for (const slotIndex of block.slots || []) {
            if (slotIndex === undefined) return false;
            const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
            if (usage.count >= limit) return false;
        }
        return true;
    };

    // =================================================================
    // 3. DATA LOADER (Unchanged)
    // =================================================================
    
    // --- Helper for Time Rules ---
    function parseTimeRule(rule) {
        if (!rule) return null;
        if (typeof rule.startMin === "number" && typeof rule.endMin === "number") return rule;
        return {
            ...rule,
            startMin: Utils.parseTimeToMinutes(rule.start),
            endMin: Utils.parseTimeToMinutes(rule.end)
        };
    }

    Utils.loadAndFilterData = function() {
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};
        const masterFields = app1Data.fields || [];
        const masterDivisions = app1Data.divisions || {};
        const masterSpecials = app1Data.specialActivities || [];
        const masterLeagues = globalSettings.leaguesByName || {};
        const masterSpecialtyLeagues = globalSettings.specialtyLeagues || {};
        
        const bunkMetaData = app1Data.bunkMetaData || {};
        const sportMetaData = app1Data.sportMetaData || {};
        Utils._bunkMetaData = bunkMetaData;
        Utils._sportMetaData = sportMetaData;

        const dailyData = window.loadCurrentDailyData?.() || {};
        const dailyFieldAvailability = dailyData.dailyFieldAvailability || {};
        const dailyOverrides = dailyData.overrides || {};
        const disabledLeagues = dailyOverrides.leagues || [];
        const disabledSpecialtyLeagues = dailyData.disabledSpecialtyLeagues || [];
        const dailyDisabledSportsByField = dailyData.dailyDisabledSportsByField || {};
        const disabledFields = dailyOverrides.disabledFields || [];
        const disabledSpecials = dailyOverrides.disabledSpecials || [];

        const rotationHistoryRaw = window.loadRotationHistory?.() || {};
        const rotationHistory = {
            bunks: rotationHistoryRaw.bunks || {},
            leagues: rotationHistoryRaw.leagues || {},
            leagueTeamSports: rotationHistoryRaw.leagueTeamSports || {},
            leagueTeamLastSport: rotationHistoryRaw.leagueTeamLastSport || {}
        };

        const historicalCounts = {};
        const lastUsedDates = {}; 
        
        const specialActivityNames = [];
        const specialNamesSet = new Set();
        const specialRules = {};

        try {
            masterSpecials.forEach(s => {
                 specialActivityNames.push(s.name);
                 specialNamesSet.add(s.name);
                 specialRules[s.name] = { 
                     frequencyWeeks: s.frequencyWeeks || 0,
                     limit: s.maxUsage || 0 
                 };
            });

            const rawHistory = {}; 
            const allDaily = window.loadAllDailyData?.() || {};
            const manualOffsets = globalSettings.manualUsageOffsets || {};

            Object.entries(allDaily).forEach(([dateStr, dayData]) => {
                const sched = dayData.scheduleAssignments || {};
                Object.keys(sched).forEach(b => {
                    if (!rawHistory[b]) rawHistory[b] = {};
                    (sched[b] || []).forEach(e => {
                        if (e && e._activity && !e.continuation) {
                            if (!rawHistory[b][e._activity]) rawHistory[b][e._activity] = [];
                            rawHistory[b][e._activity].push(dateStr);
                        }
                    });
                });
            });

            const todayStr = window.currentScheduleDate; 
            const todayDate = new Date(todayStr);

            Object.keys(rawHistory).forEach(b => {
                if (!historicalCounts[b]) historicalCounts[b] = {};
                if (!lastUsedDates[b]) lastUsedDates[b] = {};
                
                Object.keys(rawHistory[b]).forEach(act => {
                    const dates = rawHistory[b][act].sort(); 
                    if (dates.length > 0) {
                        lastUsedDates[b][act] = dates[dates.length - 1];
                    }

                    const rule = specialRules[act];
                    if (!rule || !rule.frequencyWeeks || rule.frequencyWeeks === 0) {
                        historicalCounts[b][act] = dates.length;
                    } else {
                        const windowDays = rule.frequencyWeeks * 7;
                        let windowStart = null;
                        let windowCount = 0;

                        for (const dStr of dates) {
                            const d = new Date(dStr);
                            if (!windowStart) {
                                windowStart = d;
                                windowCount = 1;
                            } else {
                                const diffTime = Math.abs(d - windowStart);
                                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                                if (diffDays <= windowDays) {
                                    windowCount++;
                                } else {
                                    windowStart = d;
                                    windowCount = 1;
                                }
                            }
                        }

                        if (windowStart) {
                            const diffTime = Math.abs(todayDate - windowStart);
                            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                            if (diffDays <= windowDays) {
                                historicalCounts[b][act] = windowCount;
                            } else {
                                historicalCounts[b][act] = 0;
                            }
                        } else {
                            historicalCounts[b][act] = 0;
                        }
                    }
                    if (specialNamesSet.has(act)) {
                         historicalCounts[b]['_totalSpecials'] = 
                             (historicalCounts[b]['_totalSpecials'] || 0) + 1;
                    }
                });
            });

            Object.keys(manualOffsets).forEach(b => {
                if (!historicalCounts[b]) historicalCounts[b] = {};
                Object.keys(manualOffsets[b]).forEach(act => {
                    const offset = manualOffsets[b][act] || 0;
                    const current = historicalCounts[b][act] || 0;
                    historicalCounts[b][act] = Math.max(0, current + offset);
                });
            });

        } catch (e) {
            console.error("Error calculating historical counts:", e);
        }

        const overrides = {
            bunks: dailyOverrides.bunks || [],
            leagues: disabledLeagues
        };

        const availableDivisions = (app1Data.availableDivisions || []).filter(
            divName => !overrides.bunks.includes(divName)
        );

        const divisions = {};
        for (const divName of availableDivisions) {
            if (!masterDivisions[divName]) continue;
            divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
            divisions[divName].bunks =
                (divisions[divName].bunks || [])
                    .filter(bunkName => !overrides.bunks.includes(bunkName));
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

            let allowedDivisions = null;
            if (Array.isArray(f.allowedDivisions) && f.allowedDivisions.length > 0) {
                allowedDivisions = f.allowedDivisions.slice();
            } else if (f.divisionAvailability && f.divisionAvailability.mode === 'specific' && Array.isArray(f.divisionAvailability.divisions) && f.divisionAvailability.divisions.length > 0) {
                allowedDivisions = f.divisionAvailability.divisions.slice();
            } else if (Array.isArray(f.sharableWith?.divisions) && f.sharableWith.divisions.length > 0) {
                allowedDivisions = f.sharableWith.divisions.slice();
            }

            const safeLimitUsage = (f.limitUsage && f.limitUsage.enabled) 
                ? { enabled: true, divisions: f.limitUsage.divisions || {} }
                : { enabled: false, divisions: {} };

            let capacity = 1;
            if (f.sharableWith) {
                if (f.sharableWith.capacity) capacity = parseInt(f.sharableWith.capacity);
                else if (f.sharableWith.type === 'all' || f.sharableWith.type === 'custom') capacity = 2;
            } else if (f.sharable) {
                capacity = 2;
            }
            if(!f.sharableWith) f.sharableWith = { capacity: capacity };
            else f.sharableWith.capacity = capacity;

            activityProperties[f.name] = {
                available: isMasterAvailable,
                sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
                sharableWith: f.sharableWith,
                maxUsage: f.maxUsage || 0, 
                allowedDivisions,
                limitUsage: safeLimitUsage,
                preferences: f.preferences || { enabled: false, exclusive: false, list: [] },
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
            ...availFields.flatMap(f => (f.activities || []).map(act => ({
                type: "field", field: f.name, sport: act
            }))).filter(a =>
                !a.field || !a.sport || !dailyDisabledSportsByField[a.field]?.includes(a.sport)
            ),
            ...availSpecials.map(sa => ({
                type: "special", field: sa.name, sport: null
            }))
        ];

        const h2hActivities = allActivities.filter(a => a.type === "field" && a.sport);

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
            masterSpecials,
            yesterdayHistory,
            rotationHistory,
            disabledLeagues,
            disabledSpecialtyLeagues,
            historicalCounts,
            lastUsedDates, 
            specialActivityNames,
            disabledFields,
            disabledSpecials,
            dailyFieldAvailability,
            dailyDisabledSportsByField,
            masterFields,
            bunkMetaData, 
            sportMetaData
        };
    };

    // Expose
    window.SchedulerCoreUtils = Utils;

})();
