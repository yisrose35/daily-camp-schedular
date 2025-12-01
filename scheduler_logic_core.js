
// ============================================================================
// scheduler_logic_core.js
//
// UPDATED:
// - Calculates and saves "Game Number" (e.g. Game 6) for League blocks.
// - Pass 2.5: Now passes 'yesterdayHistory' to SmartLogicAdapter.generateAssignments.
//   This enables the "Anti-Streak" logic (Yesterday Penalty).
// - Usage Fix: Pinned/Split/Smart items registers usage to prevent double-booking.
// - Rotation Fix: Real-time historical count updates during generation.
// - FAIRNESS UPDATE: Pass 4 now sorts by 'Total Historical Specials' (Ascending) 
//   to ensure bunks with fewer specials get priority pick.
// - BUG FIX: Moved helper functions to top of scope to prevent ReferenceErrors.
// - LEAGUE FIX: Randomizes matchups per slot to prevent same-team replays.
// - GAME NUMBER FIX: Now correctly increments game numbers (e.g., Game 1, Game 2)
//   even if multiple games happen on the same day, and supports infinite game numbers.
// ============================================================================

(function() {
    'use strict';

    // ===== CONFIG =====
    const INCREMENT_MINS = 30;
    window.INCREMENT_MINS = INCREMENT_MINS;

    const GENERATED_EVENTS = [
        'General Activity Slot',
        'Sports Slot',
        'Special Activity',
        'Swim',
        'League Game',
        'Specialty League'
    ];

    // ===== BASIC HELPERS =====
    function parseTimeToMinutes(str) {
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
    }

    function fieldLabel(f) {
        if (typeof f === "string") return f;
        if (f && typeof f === "object" && typeof f.name === "string") return f.name;
        return "";
    }

    function fmtTime(d) {
        if (!d) return "";
        if (typeof d === 'string') d = new Date(d);
        let h = d.getHours();
        let m = d.getMinutes().toString().padStart(2, "0");
        const ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${m} ${ap}`;
    }

    function minutesToDate(mins) {
        const d = new Date(1970, 0, 1, 0, 0, 0);
        d.setMinutes(mins);
        return d;
    }

    // =====================================================================
    // MAIN ENTRY POINT
    // =====================================================================
    window.runSkeletonOptimizer = function(manualSkeleton, externalOverrides) {
        window.scheduleAssignments = {};
        window.leagueAssignments = {};
        window.unifiedTimes = [];
        const dailyLeagueSportsUsage = {}; 

        // =====================================================================
        // HELPER FUNCTIONS (MOVED TO TOP FOR SCOPE SAFETY)
        // =====================================================================

        // --- League Helpers ---
        function shuffleArray(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
        }

        function pairRoundRobin(teams) {
            if (teams.length < 2) return [];
            const t = teams.slice();
            if (t.length % 2 !== 0) t.push("BYE");
            const pairs = [];
            const half = t.length / 2;
            const top = t.slice(0, half);
            const bottom = t.slice(half).reverse();
            for (let i = 0; i < half; i++) {
                pairs.push([top[i], bottom[i]]);
            }
            return pairs;
        }

        function coreGetNextLeagueRound(leagueName, teams) {
            // Shuffle teams to randomize matchups so different slots get different pairings
            const shuffled = teams.slice();
            shuffleArray(shuffled);
            return pairRoundRobin(shuffled);
        }

        function assignSportsMultiRound(matchups, sports, teamCounts, history, lastSport) {
            const assignments = [];
            matchups.forEach((pair, i) => {
                if (!pair || pair.includes("BYE")) {
                    assignments.push({ sport: null });
                    return;
                }
                const s = sports[i % sports.length];
                assignments.push({ sport: s });
            });
            return {
                assignments,
                updatedTeamCounts: teamCounts || {},
                updatedLastSports: lastSport || {}
            };
        }

        function findSlotsForRange(startMin, endMin) {
            const slots = [];
            if (!window.unifiedTimes || startMin == null || endMin == null) return slots;
            for (let i = 0; i < window.unifiedTimes.length; i++) {
                const slot = window.unifiedTimes[i];
                const d = new Date(slot.start);
                const slotStart = d.getHours() * 60 + d.getMinutes();
                if (slotStart >= startMin && slotStart < endMin) slots.push(i);
            }
            return slots;
        }

        function markFieldUsage(block, fieldName, fieldUsageBySlot) {
            if (!fieldName ||
                fieldName === "No Field" ||
                !window.allSchedulableNames ||
                !window.allSchedulableNames.includes(fieldName)) {
                return;
            }
            for (const slotIndex of block.slots || []) {
                if (slotIndex === undefined) continue;
                fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
                const usage = fieldUsageBySlot[slotIndex][fieldName] ||
                    { count: 0, divisions: [], bunks: {} };
                usage.count++;
                if (!usage.divisions.includes(block.divName))
                    usage.divisions.push(block.divName);
                const blockActivity =
                    block._activity ||
                    block.sport ||
                    (block.event === 'League Game' ? 'League' : block.event);
                if (block.bunk && blockActivity) {
                    usage.bunks[block.bunk] = blockActivity;
                }
                fieldUsageBySlot[slotIndex][fieldName] = usage;
            }
        }

        function isTimeAvailable(slotIndex, fieldProps) {
            if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
            const slot = window.unifiedTimes[slotIndex];
            const slotStartMin = new Date(slot.start).getHours() * 60 +
                                 new Date(slot.start).getMinutes();
            const slotEndMin = slotStartMin + INCREMENT_MINS;
            const rules = (fieldProps.timeRules || []).map(r => {
                if (typeof r.startMin === "number" && typeof r.endMin === "number") return r;
                return {
                    ...r,
                    startMin: parseTimeToMinutes(r.start),
                    endMin: parseTimeToMinutes(r.end)
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
        }

        function getBlockTimeRange(block) {
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
        }

        function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot, proposedActivity) {
            if (!fieldName) return false;
            const props = activityProperties[fieldName];

            // If no props, treat as virtual/unconstrained
            if (!props) return true;

            const limit = (props && props.sharable) ? 2 : 1;

            if (props.preferences &&
                props.preferences.enabled &&
                props.preferences.exclusive &&
                !props.preferences.list.includes(block.divName)) {
                return false;
            }

            if (props &&
                Array.isArray(props.allowedDivisions) &&
                props.allowedDivisions.length > 0 &&
                !props.allowedDivisions.includes(block.divName)) {
                return false;
            }

            const limitRules = props.limitUsage;
            if (limitRules && limitRules.enabled) {
                if (!limitRules.divisions[block.divName]) return false;
                const allowedBunks = limitRules.divisions[block.divName];
                if (allowedBunks.length > 0 &&
                    block.bunk &&
                    !allowedBunks.includes(block.bunk)) {
                    return false;
                }
            }

            const { blockStartMin, blockEndMin } = getBlockTimeRange(block);
            const rules = (props.timeRules || []).map(r => {
                if (typeof r.startMin === "number" && typeof r.endMin === "number") return r;
                return {
                    ...r,
                    startMin: parseTimeToMinutes(r.start),
                    endMin: parseTimeToMinutes(r.end)
                };
            });

            if (rules.length > 0) {
                if (!props.available) return false;
                const hasAvailableRules = rules.some(r => r.type === 'Available');
                if (blockStartMin != null && blockEndMin != null) {
                    if (hasAvailableRules) {
                        let insideAvailable = false;
                        for (const rule of rules) {
                            if (rule.type !== 'Available' ||
                                rule.startMin == null ||
                                rule.endMin == null) continue;
                            if (blockStartMin >= rule.startMin &&
                                blockEndMin <= rule.endMin) {
                                insideAvailable = true;
                                break;
                            }
                        }
                        if (!insideAvailable) return false;
                    }
                    for (const rule of rules) {
                        if (rule.type !== 'Unavailable' ||
                            rule.startMin == null ||
                            rule.endMin == null) continue;
                        if (blockStartMin < rule.endMin &&
                            blockEndMin > rule.startMin) {
                            return false;
                        }
                    }
                }
                for (const slotIndex of block.slots || []) {
                    if (slotIndex === undefined) return false;
                    const usage = fieldUsageBySlot[slotIndex]?.[fieldName] ||
                        { count: 0, divisions: [], bunks: {} };
                    if (usage.count >= limit) return false;
                    if (usage.count > 0) {
                        if (!usage.divisions.includes(block.divName)) return false;
                        let existingActivity = null;
                        for (const bunkName in usage.bunks) {
                            if (usage.bunks[bunkName]) {
                                existingActivity = usage.bunks[bunkName];
                                break;
                            }
                        }
                        if (existingActivity &&
                            proposedActivity &&
                            existingActivity !== proposedActivity) {
                            return false;
                        }
                    }
                    if (!isTimeAvailable(slotIndex, props)) return false;
                }
            } else {
                if (!props.available) return false;
                for (const slotIndex of block.slots || []) {
                    if (slotIndex === undefined) return false;
                    const usage = fieldUsageBySlot[slotIndex]?.[fieldName] ||
                        { count: 0, divisions: [], bunks: {} };
                    if (usage.count >= limit) return false;
                    if (usage.count > 0) {
                        let existingActivity = null;
                        for (const bunkName in usage.bunks) {
                            if (usage.bunks[bunkName]) {
                                existingActivity = usage.bunks[bunkName];
                                break;
                            }
                        }
                        if (existingActivity &&
                            proposedActivity &&
                            existingActivity !== proposedActivity) {
                            return false;
                        }
                    }
                }
            }
            return true;
        }

        function canLeagueGameFit(block, fieldName, fieldUsageBySlot, activityProperties) {
            if (!fieldName) return false;
            const props = activityProperties[fieldName];
            if (!props) return false;
            const limit = 1;

            if (props.preferences &&
                props.preferences.enabled &&
                props.preferences.exclusive &&
                !props.preferences.list.includes(block.divName)) {
                return false;
            }
            if (props &&
                Array.isArray(props.allowedDivisions) &&
                props.allowedDivisions.length > 0 &&
                !props.allowedDivisions.includes(block.divName)) {
                return false;
            }

            const limitRules = props.limitUsage;
            if (limitRules && limitRules.enabled) {
                if (!limitRules.divisions[block.divName]) return false;
            }

            const { blockStartMin, blockEndMin } = getBlockTimeRange(block);
            const rules = (props.timeRules || []).map(r => {
                if (typeof r.startMin === "number" && typeof r.endMin === "number") return r;
                return {
                    ...r,
                    startMin: parseTimeToMinutes(r.start),
                    endMin: parseTimeToMinutes(r.end)
                };
            });

            if (rules.length > 0) {
                if (!props.available) return false;
                const hasAvailableRules = rules.some(r => r.type === 'Available');
                if (blockStartMin != null && blockEndMin != null) {
                    if (hasAvailableRules) {
                        let insideAvailable = false;
                        for (const rule of rules) {
                            if (rule.type !== 'Available' ||
                                rule.startMin == null ||
                                rule.endMin == null) continue;
                            if (blockStartMin >= rule.startMin &&
                                blockEndMin <= rule.endMin) {
                                insideAvailable = true;
                                break;
                            }
                        }
                        if (!insideAvailable) return false;
                    }
                    for (const rule of rules) {
                        if (rule.type !== 'Unavailable' ||
                            rule.startMin == null ||
                            rule.endMin == null) continue;
                        if (blockStartMin < rule.endMin &&
                            blockEndMin > rule.startMin) {
                            return false;
                        }
                    }
                }
                for (const slotIndex of block.slots || []) {
                    if (slotIndex === undefined) return false;
                    const usage = fieldUsageBySlot[slotIndex]?.[fieldName] ||
                        { count: 0, divisions: [] };
                    if (usage.count >= limit) return false;
                    if (!isTimeAvailable(slotIndex, props)) return false;
                }
            } else {
                if (!props.available) return false;
                for (const slotIndex of block.slots || []) {
                    if (slotIndex === undefined) return false;
                    const usage = fieldUsageBySlot[slotIndex]?.[fieldName] ||
                        { count: 0, divisions: [] };
                    if (usage.count >= limit) return false;
                }
            }
            return true;
        }

        function isPickValidForBlock(block, pick, activityProperties, fieldUsageBySlot) {
            if (!pick) return false;
            const fname = fieldLabel(pick.field);
            if (!fname) return true;
            if (!window.allSchedulableNames ||
                !window.allSchedulableNames.includes(fname)) {
                return true;
            }
            return canBlockFit(block, fname, activityProperties, fieldUsageBySlot, pick._activity);
        }

        function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, isLeagueFill = false) {
            const fieldName = fieldLabel(pick.field);
            const sport = pick.sport;
            (block.slots || []).forEach((slotIndex, idx) => {
                if (slotIndex === undefined ||
                    slotIndex >= (window.unifiedTimes || []).length) return;
                if (!window.scheduleAssignments[block.bunk]) return;
                if (!window.scheduleAssignments[block.bunk][slotIndex]) {
                    window.scheduleAssignments[block.bunk][slotIndex] = {
                        field: fieldName,
                        sport: sport,
                        continuation: (idx > 0),
                        _fixed: !!pick._fixed,
                        _h2h: !!pick._h2h,
                        _activity: pick._activity || null,
                        _allMatchups: pick._allMatchups || null,
                        _gameLabel: pick._gameLabel || null // <-- Save the Game Number (e.g. "Game 6")
                    };
                    if (!isLeagueFill &&
                        fieldName &&
                        window.allSchedulableNames &&
                        window.allSchedulableNames.includes(fieldName)) {
                        fieldUsageBySlot[slotIndex] =
                            fieldUsageBySlot[slotIndex] || {};
                        const usage = fieldUsageBySlot[slotIndex][fieldName] ||
                            { count: 0, divisions: [], bunks: {} };
                        usage.count++;
                        if (!usage.divisions.includes(block.divName))
                            usage.divisions.push(block.divName);
                        if (block.bunk && pick._activity)
                            usage.bunks[block.bunk] = pick._activity;
                        fieldUsageBySlot[slotIndex][fieldName] = usage;
                    }
                }
            });
        }

        function loadAndFilterData() {
            const globalSettings = window.loadGlobalSettings?.() || {};
            const app1Data = globalSettings.app1 || {};
            const masterFields = app1Data.fields || [];
            const masterDivisions = app1Data.divisions || {};
            const masterSpecials = app1Data.specialActivities || [];
            const masterLeagues = globalSettings.leaguesByName || {};
            const masterSpecialtyLeagues = globalSettings.specialtyLeagues || {};

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
            window.debugHistoricalCounts = historicalCounts;

            const specialActivityNames = [];
            const specialNamesSet = new Set(); // For faster lookup

            try {
                // Populate Special Names
                masterSpecials.forEach(s => {
                     specialActivityNames.push(s.name);
                     specialNamesSet.add(s.name);
                });

                const allDaily = window.loadAllDailyData?.() || {};
                const manualOffsets = globalSettings.manualUsageOffsets || {};

                // 1. Tally History from Previous Days
                Object.values(allDaily).forEach(day => {
                    const sched = day.scheduleAssignments || {};
                    Object.keys(sched).forEach(b => {
                        if (!historicalCounts[b]) historicalCounts[b] = {};
                        (sched[b] || []).forEach(e => {
                            if (e && e._activity && !e.continuation) {
                                // Standard Activity Count
                                historicalCounts[b][e._activity] =
                                    (historicalCounts[b][e._activity] || 0) + 1;
                                
                                // SPECIAL ACTIVITY CATEGORY COUNT (For cross-day fairness)
                                if (specialNamesSet.has(e._activity)) {
                                    historicalCounts[b]['_totalSpecials'] = 
                                        (historicalCounts[b]['_totalSpecials'] || 0) + 1;
                                }
                            }
                        });
                    });
                });

                // 2. Add Manual Offsets
                Object.keys(manualOffsets).forEach(b => {
                    if (!historicalCounts[b]) historicalCounts[b] = {};
                    Object.keys(manualOffsets[b]).forEach(act => {
                        const offset = manualOffsets[b][act] || 0;
                        const current = historicalCounts[b][act] || 0;
                        historicalCounts[b][act] = Math.max(0, current + offset);
                        
                        // If offsetting a special, offset the total too
                        if (specialNamesSet.has(act)) {
                             const curTotal = historicalCounts[b]['_totalSpecials'] || 0;
                             historicalCounts[b]['_totalSpecials'] = Math.max(0, curTotal + offset);
                        }
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

            function parseTimeRule(rule) {
                if (!rule || !rule.type) return null;
                if (typeof rule.startMin === "number" &&
                    typeof rule.endMin === "number") {
                    return {
                        type: rule.type,
                        startMin: rule.startMin,
                        endMin: rule.endMin
                    };
                }
                const startMin = parseTimeToMinutes(rule.start);
                const endMin = parseTimeToMinutes(rule.end);
                if (startMin == null || endMin == null) return null;
                return {
                    type: rule.type,
                    startMin,
                    endMin,
                    start: rule.start,
                    end: rule.end
                };
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
                } else if (f.divisionAvailability &&
                           f.divisionAvailability.mode === 'specific' &&
                           Array.isArray(f.divisionAvailability.divisions) &&
                           f.divisionAvailability.divisions.length > 0) {
                    allowedDivisions = f.divisionAvailability.divisions.slice();
                } else if (Array.isArray(f.sharableWith?.divisions) &&
                           f.sharableWith.divisions.length > 0) {
                    allowedDivisions = f.sharableWith.divisions.slice();
                }

                // sanitize limitUsage to always have a divisions object
                const safeLimitUsage = (f.limitUsage && f.limitUsage.enabled) 
                    ? { enabled: true, divisions: f.limitUsage.divisions || {} }
                    : { enabled: false, divisions: {} };

                activityProperties[f.name] = {
                    available: isMasterAvailable,
                    sharable: f.sharableWith?.type === 'all' ||
                              f.sharableWith?.type === 'custom',
                    sharableWith: f.sharableWith,
                    allowedDivisions,
                    limitUsage: safeLimitUsage,
                    preferences: f.preferences ||
                        { enabled: false, exclusive: false, list: [] },
                    timeRules: finalRules
                };

                if (isMasterAvailable) {
                    availableActivityNames.push(f.name);
                }
            });

            window.allSchedulableNames = availableActivityNames;

            const availFields = masterFields.filter(f =>
                availableActivityNames.includes(f.name)
            );
            const availSpecials = masterSpecials.filter(s =>
                availableActivityNames.includes(s.name)
            );

            const fieldsBySport = {};
            availFields.forEach(f => {
                if (Array.isArray(f.activities)) {
                    f.activities.forEach(sport => {
                        const isDisabledToday =
                            dailyDisabledSportsByField[f.name]?.includes(sport);
                        if (!isDisabledToday) {
                            fieldsBySport[sport] = fieldsBySport[sport] || [];
                            fieldsBySport[sport].push(f.name);
                        }
                    });
                }
            });

            const allActivities = [
                ...availFields
                    .flatMap(f => (f.activities || [])
                        .map(act => ({
                            type: "field",
                            field: f.name,
                            sport: act
                        })))
                    .filter(a =>
                        !a.field ||
                        !a.sport ||
                        !dailyDisabledSportsByField[a.field]?.includes(a.sport)
                    ),
                ...availSpecials.map(sa => ({
                    type: "special",
                    field: sa.name,
                    sport: null
                }))
            ];

            const h2hActivities = allActivities.filter(
                a => a.type === "field" && a.sport
            );

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
                masterSpecials, // Added so adapter can access full special defs
                yesterdayHistory,
                rotationHistory,
                disabledLeagues,
                disabledSpecialtyLeagues,
                historicalCounts,
                specialActivityNames,
                disabledFields,
                disabledSpecials,
                dailyFieldAvailability,
                dailyDisabledSportsByField,
                masterFields 
            };
        }

        if (!manualSkeleton || manualSkeleton.length === 0) return false;

        const {
            divisions,
            availableDivisions,
            activityProperties,
            allActivities,
            h2hActivities,
            fieldsBySport,
            masterLeagues,
            masterSpecialtyLeagues,
            masterSpecials, // Added for Adapter
            yesterdayHistory,
            rotationHistory,
            disabledLeagues,
            disabledSpecialtyLeagues,
            historicalCounts,
            specialActivityNames,
            disabledFields,
            disabledSpecials,
            dailyFieldAvailability,
            dailyDisabledSportsByField,
            masterFields 
        } = loadAndFilterData();

        let fieldUsageBySlot = {};
        window.fieldUsageBySlot = fieldUsageBySlot;
        window.activityProperties = activityProperties;

        // Internal Helper to register usage immediately (Fix for Invisible Pinned Items)
        function registerSingleSlotUsage(slotIndex, fieldName, divName, bunkName, activityName) {
            if (!fieldName || !window.allSchedulableNames || !window.allSchedulableNames.includes(fieldName)) return;
            
            fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
            const usage = fieldUsageBySlot[slotIndex][fieldName] || { count: 0, divisions: [], bunks: {} };
            
            // Check capacity (though for pinned items we usually force it)
            const props = activityProperties[fieldName];
            const sharableCap = props?.sharableWith?.capacity ?? (props?.sharableWith?.type === "all" ? 2 : props?.sharable ? 2 : 1);

            if (usage.count < sharableCap) {
                usage.count++;
                if (bunkName) usage.bunks[bunkName] = activityName || fieldName;
                if (divName && !usage.divisions.includes(divName)) {
                    usage.divisions.push(divName);
                }
                fieldUsageBySlot[slotIndex][fieldName] = usage;
            }
        }

        // =================================================================
        // PASS 1: TIME GRID
        // =================================================================
        let timePoints = new Set();
        timePoints.add(540); // 9:00
        timePoints.add(960); // 16:00
        manualSkeleton.forEach(item => {
            const s = parseTimeToMinutes(item.startTime);
            const e = parseTimeToMinutes(item.endTime);
            if (s !== null) timePoints.add(s);
            if (e !== null) timePoints.add(e);
        });
        const sortedPoints = Array.from(timePoints).sort((a, b) => a - b);
        window.unifiedTimes = [];
        for (let i = 0; i < sortedPoints.length - 1; i++) {
            const start = sortedPoints[i];
            const end = sortedPoints[i + 1];
            if (end - start >= 5) {
                window.unifiedTimes.push({
                    start: minutesToDate(start),
                    end: minutesToDate(end),
                    label: `${fmtTime(minutesToDate(start))} - ${fmtTime(minutesToDate(end))}`
                });
            }
        }
        if (window.unifiedTimes.length === 0) {
            window.updateTable?.();
            return false;
        }

        availableDivisions.forEach(divName => {
            (divisions[divName]?.bunks || []).forEach(bunk => {
                window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
            });
        });

        // =================================================================
        // PASS 1.5 — Bunk-Specific Pinned Overrides
        // =================================================================
        try {
            const dailyData = window.loadCurrentDailyData?.() || {};
            const bunkOverrides = dailyData.bunkActivityOverrides || [];
            
            bunkOverrides.forEach(override => {
                const startMin = parseTimeToMinutes(override.startTime);
                const endMin = parseTimeToMinutes(override.endTime);
                const slots = findSlotsForRange(startMin, endMin);
                const bunk = override.bunk;
                // Find division for this bunk for usage tracking
                const divName = Object.keys(divisions).find(d => divisions[d].bunks.includes(bunk));

                if (window.scheduleAssignments[bunk] && slots.length > 0) {
                    slots.forEach((slotIndex, idx) => {
                        if (!window.scheduleAssignments[bunk][slotIndex]) {
                            window.scheduleAssignments[bunk][slotIndex] = {
                                field: { name: override.activity },
                                sport: null,
                                continuation: (idx > 0),
                                _fixed: true,
                                _h2h: false,
                                vs: null,
                                _activity: override.activity,
                                _endTime: endMin
                            };
                            // Usage Fix
                            registerSingleSlotUsage(slotIndex, override.activity, divName, bunk, override.activity);
                        }
                    });
                }
            });
        } catch (e) {
            console.error("Error placing bunk-specific overrides:", e);
        }

        // Normalizers
        function normalizeGA(name) {
            if (!name) return null;
            const s = String(name).toLowerCase().replace(/\s+/g, '');
            const keys = ["generalactivity", "activity", "activyty", "activty", "activityslot", "genactivity", "genact", "ga"];
            if (keys.some(k => s.includes(k))) return "General Activity Slot";
            return null;
        }
        function normalizeLeague(name) {
            if (!name) return null;
            const s = String(name).toLowerCase().replace(/\s+/g, '');
            const keys = ["leaguegame", "leaguegameslot", "leagame", "lg", "lgame"];
            if (keys.some(k => s.includes(k))) return "League Game";
            return null;
        }
        function normalizeSpecialtyLeague(name) {
            if (!name) return null;
            const s = String(name).toLowerCase().replace(/\s+/g, '');
            const keys = ["specialtyleague", "specialityleague", "specleague", "specialleague", "sleauge"];
            if (keys.some(k => s.includes(k))) return "Specialty League";
            return null;
        }

        // =================================================================
        // PASS 2 — Pinned / Split / Slot Blocks
        // =================================================================
        // Note: We intentionally skip 'smart' tiles here; they are handled in Pass 2.5
        const schedulableSlotBlocks = [];

        manualSkeleton.forEach(item => {
            const allBunks = divisions[item.division]?.bunks || [];
            if (!allBunks || allBunks.length === 0) return;

            const startMin = parseTimeToMinutes(item.startTime);
            const endMin = parseTimeToMinutes(item.endTime);
            const allSlots = findSlotsForRange(startMin, endMin);
            if (allSlots.length === 0) return;

            const normGA = normalizeGA(item.event);
            const normLeague = normalizeLeague(item.event);
            const normSpecLg = normalizeSpecialtyLeague(item.event);
            const finalEventName = normGA || normSpecLg || normLeague || item.event;
            const isGeneratedEvent =
                GENERATED_EVENTS.includes(finalEventName) ||
                normGA === "General Activity Slot" ||
                normLeague === "League Game" ||
                normSpecLg === "Specialty League";

            // ----- PINNED OR NON-GENERATED EVENTS -----
            if ((item.type === 'pinned' || !isGeneratedEvent) && item.type !== 'smart') {
                const isDisabledField = Array.isArray(disabledFields) && disabledFields.includes(item.event);
                const isDisabledSpecial = Array.isArray(disabledSpecials) && disabledSpecials.includes(item.event);
                if (isDisabledField || isDisabledSpecial) return;

                allBunks.forEach(bunk => {
                    allSlots.forEach((slotIndex, idx) => {
                        if (!window.scheduleAssignments[bunk][slotIndex]) {
                            window.scheduleAssignments[bunk][slotIndex] = {
                                field: { name: item.event },
                                sport: null,
                                continuation: (idx > 0),
                                _fixed: true,
                                _h2h: false,
                                vs: null,
                                _activity: item.event,
                                _endTime: endMin
                            };
                            // Usage Fix
                            registerSingleSlotUsage(slotIndex, item.event, item.division, bunk, item.event);
                        }
                    });
                });
            }
            else if (item.type === 'split') {
                if (!item.subEvents || item.subEvents.length < 2) return;
                const swimLabel = "Swim";
                const rawGAEvent = item.subEvents[1].event;
                const gaLabel = normalizeGA(rawGAEvent) || "General Activity Slot";

                const mid = Math.ceil(allBunks.length / 2);
                const bunksTop = allBunks.slice(0, mid);
                const bunksBottom = allBunks.slice(mid);
                const slotMid = Math.ceil(allSlots.length / 2);
                const slotsFirst = allSlots.slice(0, slotMid);
                const slotsSecond = allSlots.slice(slotMid);

                function pinSwim(bunks, slots) {
                    bunks.forEach(bunk => {
                        slots.forEach((slotIndex, idx) => {
                            window.scheduleAssignments[bunk][slotIndex] = {
                                field: { name: swimLabel },
                                sport: null,
                                continuation: (idx > 0),
                                _fixed: true,
                                _h2h: false,
                                vs: null,
                                _activity: swimLabel
                            };
                            // Usage Fix
                            registerSingleSlotUsage(slotIndex, swimLabel, item.division, bunk, swimLabel);
                        });
                    });
                }
                function pushGA(bunks, slots) {
                    bunks.forEach(bunk => {
                        schedulableSlotBlocks.push({
                            divName: item.division,
                            bunk: bunk,
                            event: gaLabel,
                            startTime: startMin,
                            endTime: endMin,
                            slots
                        });
                    });
                }

                pinSwim(bunksTop, slotsFirst);
                pushGA(bunksBottom, slotsFirst);
                pushGA(bunksTop, slotsSecond);
                pinSwim(bunksBottom, slotsSecond);
            }
            // SMART TILES are intentionally ignored here -> Pass 2.5
            else if (item.type === 'slot' && isGeneratedEvent) {
                let normalizedEvent = null;
                if (normalizeSpecialtyLeague(item.event)) normalizedEvent = "Specialty League";
                else if (normalizeLeague(item.event)) normalizedEvent = "League Game";
                else if (normalizeGA(item.event)) normalizedEvent = "General Activity Slot";
                else normalizedEvent = item.event;

                allBunks.forEach(bunk => {
                    schedulableSlotBlocks.push({
                        divName: item.division,
                        bunk: bunk,
                        event: normalizedEvent,
                        startTime: startMin,
                        endTime: endMin,
                        slots: allSlots
                    });
                });
            }
        });

        // =================================================================
        // PASS 2.5 — SMART TILES (Corrected for Special Generation)
        // =================================================================

        let smartJobs = [];
        if (window.SmartLogicAdapter && typeof window.SmartLogicAdapter.preprocessSmartTiles === 'function') {
            smartJobs = window.SmartLogicAdapter.preprocessSmartTiles(manualSkeleton, externalOverrides, masterSpecials);
        }

        // 3) Run Adapter for each Smart Tile job
        smartJobs.forEach(job => {

            const bunks = window.divisions[job.division]?.bunks || [];
            if (!bunks.length) return;

            const adapterResult = SmartLogicAdapter.generateAssignments(
                bunks,
                job,
                historicalCounts,
                specialActivityNames,
                activityProperties,   // static limits
                masterFields,         // capacity from fields
                dailyFieldAvailability,
                yesterdayHistory      // <--- NEW: Passed to adapter for Yesterday Penalty
            );

            const { block1Assignments, block2Assignments } = adapterResult;
            if (!block1Assignments || !block2Assignments) return;

            // -----------------------------
            // Helper to push a generator slot
            // -----------------------------
            function pushGenerated(bunk, event, startMin, endMin) {
                const slots = findSlotsForRange(startMin, endMin);
                schedulableSlotBlocks.push({
                    divName: job.division,
                    bunk,
                    event,
                    startTime: startMin,
                    endTime: endMin,
                    slots,
                    fromSmartTile: true // <--- FLAG: Mark as from Smart Tile
                });
            }

            // -----------------------------
            // BLOCK A
            // -----------------------------
            const slotsA = findSlotsForRange(job.blockA.startMin, job.blockA.endMin);

            Object.entries(block1Assignments).forEach(([bunk, act]) => {

                // SPORTS → generator
                if (act.toLowerCase().includes("sport")) {
                    pushGenerated(bunk, "Sports Slot", job.blockA.startMin, job.blockA.endMin);
                    return;
                }

                // SPECIAL → **MUST BE A GENERATOR**
                if (act.toLowerCase().includes("special")) {
                    pushGenerated(bunk, "Special Activity Slot", job.blockA.startMin, job.blockA.endMin);
                    return;
                }

                // GENERAL ACTIVITY → generator
                if (act.toLowerCase().includes("general activity")) {
                    pushGenerated(bunk, "General Activity Slot", job.blockA.startMin, job.blockA.endMin);
                    return;
                }

                // FIXED / NAMED (swim, lunch, archery, etc)
                slotsA.forEach((slotIndex, idx) => {
                    if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
                    if (!window.scheduleAssignments[bunk][slotIndex]) {
                        window.scheduleAssignments[bunk][slotIndex] = {
                            field: { name: act },
                            sport: null,
                            continuation: (idx > 0),
                            _fixed: true,
                            _h2h: false,
                            vs: null,
                            _activity: act,
                            _endTime: job.blockA.endMin
                        };
                        // Usage Fix
                        registerSingleSlotUsage(slotIndex, act, job.division, bunk, act);
                    }
                });
            });

            // -----------------------------
            // BLOCK B
            // -----------------------------
            if (job.blockB) {
                const slotsB = findSlotsForRange(job.blockB.startMin, job.blockB.endMin);

                Object.entries(block2Assignments).forEach(([bunk, act]) => {

                    // SPORTS → generator
                    if (act.toLowerCase().includes("sport")) {
                        pushGenerated(bunk, "Sports Slot", job.blockB.startMin, job.blockB.endMin);
                        return;
                    }

                    // SPECIAL → generator
                    if (act.toLowerCase().includes("special")) {
                        pushGenerated(bunk, "Special Activity Slot", job.blockB.startMin, job.blockB.endMin);
                        return;
                    }

                    // GENERAL ACTIVITY → generator
                    if (act.toLowerCase().includes("general activity")) {
                        pushGenerated(bunk, "General Activity Slot", job.blockB.startMin, job.blockB.endMin);
                        return;
                    }

                    // FIXED / NAMED
                    slotsB.forEach((slotIndex, idx) => {
                        if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
                        if (!window.scheduleAssignments[bunk][slotIndex]) {
                            window.scheduleAssignments[bunk][slotIndex] = {
                                field: { name: act },
                                sport: null,
                                continuation: (idx > 0),
                                _fixed: true,
                                _h2h: false,
                                vs: null,
                                _activity: act,
                                _endTime: job.blockB.endMin
                            };
                            // Usage Fix
                            registerSingleSlotUsage(slotIndex, act, job.division, bunk, act);
                        }
                    });
                });
            }
        });

        // =================================================================
        // PASS 3 — SPECIALTY LEAGUES
        // =================================================================
        const leagueBlocks = schedulableSlotBlocks.filter(
            b => b.event === 'League Game' && !b.processed
        );
        const specialtyLeagueBlocks = schedulableSlotBlocks.filter(
            b => b.event === 'Specialty League' && !b.processed
        );

        // Blocks still to be scheduled by the core generator
        const remainingBlocks = schedulableSlotBlocks.filter(b =>
            b.event !== 'League Game' &&
            b.event !== 'Specialty League' &&
            !b.processed // ignore anything pinned/handled by Smart Tiles (e.g. Swim)
        );

        const specialtyLeagueGroups = {};
        specialtyLeagueBlocks.forEach(block => {
            const key = `${block.divName}-${block.startTime}`;
            if (!specialtyLeagueGroups[key]) {
                specialtyLeagueGroups[key] = {
                    divName: block.divName,
                    startTime: block.startTime,
                    endTime: block.endTime,
                    slots: block.slots,
                    bunks: new Set()
                };
            }
            specialtyLeagueGroups[key].bunks.add(block.bunk);
        });

        Object.values(specialtyLeagueGroups).forEach(group => {
            const leagueEntry = Object.values(masterSpecialtyLeagues).find(
                l => l.enabled &&
                     !disabledSpecialtyLeagues.includes(l.name) &&
                     l.divisions.includes(group.divName)
            );
            if (!leagueEntry) return;

            const allBunksInGroup = Array.from(group.bunks);
            const blockBase = {
                slots: group.slots,
                divName: group.divName,
                startTime: group.startTime,
                endTime: group.endTime
            };
            const leagueName = leagueEntry.name;
            const leagueHistory = rotationHistory.leagues[leagueName] || {};
            rotationHistory.leagues[leagueName] = leagueHistory;
            const sport = leagueEntry.sport;
            if (!sport) return;

            const bestSport = sport;
            const allMatchupLabels = [];
            const picksByTeam = {};

            // --- CALCULATE GAME NUMBER ---
            const leagueTeams = (leagueEntry.teams || [])
                .map(t => String(t).trim())
                .filter(Boolean);
            
            // getLeagueMatchups increments state internally.
            let matchups = [];
            if (typeof window.getLeagueMatchups === 'function') {
                matchups = window.getLeagueMatchups(leagueEntry.name, leagueTeams) || [];
            } else {
                matchups = pairRoundRobin(leagueTeams);
            }

            // GET GAME NUMBER (using absolute counter from global state)
            let gameNumber = 1;
            if (typeof window.getLeagueCurrentRound === 'function') {
                 gameNumber = window.getLeagueCurrentRound(leagueEntry.name);
            } else if (window.leagueRoundState && window.leagueRoundState[leagueEntry.name]) {
                 gameNumber = window.leagueRoundState[leagueEntry.name].currentRound || 1;
            }
            const gameLabel = `Game ${gameNumber}`;

            if (bestSport) {
                const leagueFields = leagueEntry.fields || [];
                if (leagueFields.length !== 0 && leagueTeams.length >= 2) {
                    
                    const gamesPerField = Math.ceil(matchups.length / leagueFields.length);
                    const slotCount = group.slots.length || 1;
                    const usedFieldsInThisBlock = Array.from(
                        { length: slotCount },
                        () => new Set()
                    );

                    for (let i = 0; i < matchups.length; i++) {
                        const [teamA, teamB] = matchups[i];
                        if (teamA === "BYE" || teamB === "BYE") continue;

                        const fieldIndex = Math.floor(i / gamesPerField);
                        const fieldName = leagueFields[fieldIndex % leagueFields.length];
                        const baseLabel = `${teamA} vs ${teamB} (${bestSport})`;

                        let isFieldAvailable = true;
                        const slotIndex = group.slots[i % slotCount];

                        if (fieldUsageBySlot[slotIndex]?.[fieldName]?.count >= 1)
                            isFieldAvailable = false;
                        if (usedFieldsInThisBlock[i % slotCount].has(fieldName))
                            isFieldAvailable = false;

                        const props = activityProperties[fieldName];
                        if (props) {
                            if (!isTimeAvailable(slotIndex, props))
                                isFieldAvailable = false;
                            if (props.preferences?.enabled &&
                                props.preferences.exclusive &&
                                !props.preferences.list.includes(group.divName))
                                isFieldAvailable = false;
                            if (props.limitUsage?.enabled &&
                                !props.limitUsage.divisions[group.divName])
                                isFieldAvailable = false;
                        }

                        let pick;
                        if (fieldName && isFieldAvailable) {
                            pick = {
                                field: fieldName,
                                sport: baseLabel,
                                _h2h: true,
                                vs: null,
                                _activity: bestSport
                            };
                            markFieldUsage(
                                { ...blockBase, _activity: bestSport, bunk: 'league' },
                                fieldName,
                                fieldUsageBySlot
                            );
                            usedFieldsInThisBlock[i % slotCount].add(fieldName);
                            allMatchupLabels.push(`${baseLabel} @ ${fieldName}`);
                        } else {
                            pick = {
                                field: "No Field",
                                sport: baseLabel,
                                _h2h: true,
                                vs: null,
                                _activity: bestSport
                            };
                            allMatchupLabels.push(`${baseLabel} (No Field)`);
                        }
                        picksByTeam[teamA] = pick;
                        picksByTeam[teamB] = pick;
                    }
                }
            }

            const noGamePick = {
                field: "No Game",
                sport: null,
                _h2h: true,
                _activity: bestSport || "Specialty League",
                _allMatchups: allMatchupLabels
            };

            allBunksInGroup.forEach(bunk => {
                const pickToAssign = picksByTeam[bunk] || noGamePick;
                pickToAssign._allMatchups = allMatchupLabels;
                pickToAssign._gameLabel = gameLabel; // <-- SAVE GAME NUMBER
                fillBlock(
                    { ...blockBase, bunk },
                    pickToAssign,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    true
                );
            });
        });

        // =================================================================
        // PASS 3.5 — REGULAR LEAGUES
        // =================================================================
        const leagueGroups = {};
        leagueBlocks.forEach(block => {
            const leagueEntry = Object.entries(masterLeagues).find(
                ([name, l]) =>
                    l.enabled &&
                    !disabledLeagues.includes(name) &&
                    l.divisions.includes(block.divName)
            );
            if (!leagueEntry) return;

            const leagueName = leagueEntry[0];
            const key = `${leagueName}-${block.startTime}`;
            if (!leagueGroups[key]) {
                leagueGroups[key] = {
                    leagueName,
                    league: leagueEntry[1],
                    startTime: block.startTime,
                    endTime: block.endTime,
                    slots: block.slots,
                    bunks: new Set()
                };
            }
            leagueGroups[key].bunks.add(block.bunk);
        });

        const sortedLeagueGroups = Object.values(leagueGroups)
            .sort((a, b) => a.startTime - b.startTime);

        sortedLeagueGroups.forEach(group => {
            const { leagueName, league, slots } = group;
            const leagueTeams = (league.teams || [])
                .map(t => String(t).trim())
                .filter(Boolean);
            if (leagueTeams.length < 2) return;

            const allBunksInGroup = Array.from(group.bunks).sort();
            if (allBunksInGroup.length === 0) return;

            let baseDivName = null;
            const firstBunk = allBunksInGroup[0];
            baseDivName = Object.keys(divisions).find(div =>
                (divisions[div].bunks || []).includes(firstBunk)
            );
            if (!baseDivName) return;

            const blockBase = { slots, divName: baseDivName, endTime: group.endTime };
            const sports = (league.sports || []).filter(s => fieldsBySport[s]);
            if (sports.length === 0) return;

            const usedToday = dailyLeagueSportsUsage[leagueName] || new Set();
            let optimizerSports = sports.filter(s => !usedToday.has(s));
            if (optimizerSports.length === 0) optimizerSports = sports;

            const leagueHistory = rotationHistory.leagues[leagueName] || {};
            rotationHistory.leagues[leagueName] = leagueHistory;

            const leagueTeamCounts = rotationHistory.leagueTeamSports[leagueName] || {};
            rotationHistory.leagueTeamSports[leagueName] = leagueTeamCounts;

            rotationHistory.leagueTeamLastSport = rotationHistory.leagueTeamLastSport || {};
            const leagueTeamLastSport = rotationHistory.leagueTeamLastSport[leagueName] || {};
            rotationHistory.leagueTeamLastSport[leagueName] = leagueTeamLastSport;

            // --- GENERATE MATCHUPS (This call increments the Global Season State) ---
            let standardMatchups = [];
            if (typeof window.getLeagueMatchups === "function") {
                standardMatchups = window.getLeagueMatchups(leagueName, leagueTeams) || [];
            } else {
                standardMatchups = coreGetNextLeagueRound(leagueName, leagueTeams) || [];
            }

            // --- GET GAME NUMBER (Reads back the new state) ---
            let gameNumber = 1;
            if (typeof window.getLeagueCurrentRound === 'function') {
                 gameNumber = window.getLeagueCurrentRound(leagueName);
            } else if (window.leagueRoundState && window.leagueRoundState[leagueName]) {
                 // Fallback
                 gameNumber = window.leagueRoundState[leagueName].currentRound || 1;
            }
            const gameLabel = `Game ${gameNumber}`;

            const slotCount = slots.length || 1;

            const evaluateMatchups = (candidateMatchups) => {
                const nonBye = candidateMatchups.filter(
                    p => p && p[0] !== "BYE" && p[1] !== "BYE"
                );
                const { assignments } = assignSportsMultiRound(
                    nonBye, optimizerSports, leagueTeamCounts, leagueHistory, leagueTeamLastSport
                );
                const simUsedFields = Array.from({ length: slotCount }, () => new Set());
                let successCount = 0;
                const results = [];

                nonBye.forEach((pair, idx) => {
                    const [teamA, teamB] = pair;
                    const preferredSport =
                        assignments[idx]?.sport ||
                        optimizerSports[idx % optimizerSports.length];

                    const candidateSports = [
                        preferredSport,
                        ...sports.filter(s => s !== preferredSport && !usedToday.has(s)),
                        ...sports.filter(s => s !== preferredSport && usedToday.has(s))
                    ];

                    let foundField = null;
                    let foundSport = preferredSport;
                    const slotIdx = idx % slotCount;

                    for (const s of candidateSports) {
                        const possibleFields = fieldsBySport[s] || [];
                        let found = null;
                        for (const f of possibleFields) {
                            if (!simUsedFields[slotIdx].has(f) &&
                                (fieldUsageBySlot[slots[slotIdx]]?.[f]?.count || 0) === 0 &&
                                canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                                found = f;
                                break;
                            }
                        }
                        if (found) {
                            foundField = found;
                            foundSport = s;
                            simUsedFields[slotIdx].add(found);
                            break;
                        }
                    }

                    if (foundField) successCount++;
                    results.push({
                        pair,
                        sport: foundSport,
                        field: foundField,
                        assignments: assignments[idx]
                    });
                });

                return { successCount, results, matchups: candidateMatchups, assignments };
            };

            let bestResult = evaluateMatchups(standardMatchups);
            const nonByeCount = standardMatchups.filter(
                p => p && p[0] !== "BYE" && p[1] !== "BYE"
            ).length;

            if (bestResult.successCount < nonByeCount) {
                const teamListCopy = [...leagueTeams];
                for (let i = 0; i < 50; i++) {
                    shuffleArray(teamListCopy);
                    const shuffledMatchups = pairRoundRobin(teamListCopy);
                    const res = evaluateMatchups(shuffledMatchups);
                    if (res.successCount > bestResult.successCount) {
                        bestResult = res;
                        if (res.successCount === nonByeCount) break;
                    }
                }
            }

            const { assignments } = bestResult;
            const winningMatchups = bestResult.matchups.filter(
                p => p && p[0] !== "BYE" && p[1] !== "BYE"
            );
            const finalOpt = assignSportsMultiRound(
                winningMatchups,
                optimizerSports,
                leagueTeamCounts,
                leagueHistory,
                leagueTeamLastSport
            );
            rotationHistory.leagueTeamSports[leagueName] = finalOpt.updatedTeamCounts;
            rotationHistory.leagueTeamLastSport[leagueName] = finalOpt.updatedLastSports;

            const allMatchupLabels = [];
            const usedForAssignments = [];
            const usedFieldsPerSlot = Array.from({ length: slotCount }, () => new Set());

            winningMatchups.forEach((pair, idx) => {
                const [teamA, teamB] = pair;
                const preferredSport =
                    finalOpt.assignments[idx]?.sport ||
                    optimizerSports[idx % optimizerSports.length];

                const candidateSports = [
                    preferredSport,
                    ...sports.filter(s => s !== preferredSport && !usedToday.has(s)),
                    ...sports.filter(s => s !== preferredSport && usedToday.has(s))
                ];

                let finalSport = preferredSport;
                let finalField = null;
                const slotIdx = idx % slotCount;

                for (const s of candidateSports) {
                    const possibleFields = fieldsBySport[s] || [];
                    let found = null;
                    for (const f of possibleFields) {
                        if (!usedFieldsPerSlot[slotIdx].has(f) &&
                            canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                            found = f;
                            break;
                        }
                    }
                    if (!found && possibleFields.length > 0) {
                        const f = possibleFields[
                            usedFieldsPerSlot[slotIdx].size % possibleFields.length
                        ];
                        if (canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                            found = f;
                        }
                    }
                    if (found) {
                        finalSport = s;
                        finalField = found;
                        usedFieldsPerSlot[slotIdx].add(found);
                        break;
                    }
                }

                let label = finalField
                    ? `${teamA} vs ${teamB} (${finalSport}) @ ${finalField}`
                    : `${teamA} vs ${teamB} (No Field)`;

                if (finalField) {
                    markFieldUsage(
                        { ...blockBase, _activity: finalSport, bunk: 'league' },
                        finalField,
                        fieldUsageBySlot
                    );
                    if (!dailyLeagueSportsUsage[leagueName])
                        dailyLeagueSportsUsage[leagueName] = new Set();
                    dailyLeagueSportsUsage[leagueName].add(finalSport);
                }

                leagueHistory[finalSport] = Date.now();
                usedForAssignments.push({
                    label,
                    sport: finalSport,
                    field: finalField || "No Field",
                    teamA,
                    teamB
                });
                allMatchupLabels.push(label);
            });

            bestResult.matchups.forEach(pair => {
                if (!pair) return;
                const [teamA, teamB] = pair;
                if (teamA === "BYE" || teamB === "BYE") {
                    allMatchupLabels.push(`${teamA} vs ${teamB} (BYE)`);
                }
            });

            const noGamePick = {
                field: "No Game",
                sport: null,
                _h2h: true,
                _activity: "League",
                _allMatchups: allMatchupLabels
            };

            let bunkPtr = 0;
            usedForAssignments.forEach(game => {
                if (bunkPtr + 1 >= allBunksInGroup.length) return;

                const bunkA = allBunksInGroup[bunkPtr];
                const bunkB = allBunksInGroup[bunkPtr + 1];
                bunkPtr += 2;

                const pick = {
                    field: game.field,
                    sport: game.label,
                    _h2h: true,
                    vs: null,
                    _activity: game.sport,
                    _allMatchups: allMatchupLabels,
                    _gameLabel: gameLabel // <-- SAVE GAME NUMBER
                };

                const bunkADiv = Object.keys(divisions).find(div =>
                    (divisions[div].bunks || []).includes(bunkA)
                ) || baseDivName;
                const bunkBDiv = Object.keys(divisions).find(div =>
                    (divisions[div].bunks || []).includes(bunkB)
                ) || baseDivName;

                fillBlock(
                    {
                        slots,
                        bunk: bunkA,
                        divName: bunkADiv,
                        startTime: group.startTime,
                        endTime: group.endTime + INCREMENT_MINS * slots.length
                    },
                    pick,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    true
                );
                fillBlock(
                    {
                        slots,
                        bunk: bunkB,
                        divName: bunkBDiv,
                        startTime: group.startTime,
                        endTime: group.endTime + INCREMENT_MINS * slots.length
                    },
                    pick,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    true
                );
            });

            while (bunkPtr < allBunksInGroup.length) {
                const leftoverBunk = allBunksInGroup[bunkPtr++];
                const bunkDivName = Object.keys(divisions).find(div =>
                    (divisions[div].bunks || []).includes(leftoverBunk)
                ) || baseDivName;

                const leftoverPick = {
                    ...noGamePick,
                    _gameLabel: gameLabel
                };

                fillBlock(
                    {
                        slots,
                        bunk: leftoverBunk,
                        divName: bunkDivName,
                        startTime: group.startTime,
                        endTime: group.endTime + INCREMENT_MINS * slots.length
                    },
                    leftoverPick,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    true
                );
            }
        });

        // =================================================================
        // PASS 4 — Remaining Schedulable Slots (The Core Generator)
        // =================================================================
        
        // SORTING PRIORITY:
        // 1. Time (Earlier first)
        // 2. Smart Tile (Prioritize smart blocks)
        // 3. FAIRNESS: Bunks with fewer 'Total Historical Specials' go first.
        remainingBlocks.sort((a, b) => {
            // 1. Time
            if (a.startTime !== b.startTime) return a.startTime - b.startTime;
            
            // 2. Smart Tile Priority
            if (a.fromSmartTile && !b.fromSmartTile) return -1;
            if (!a.fromSmartTile && b.fromSmartTile) return 1;

            // 3. Fairness Rotation (Specials) - Ascending order (lowest count first)
            // We use the '_totalSpecials' count calculated in loadAndFilterData
            const countA = historicalCounts[a.bunk]?.['_totalSpecials'] || 0;
            const countB = historicalCounts[b.bunk]?.['_totalSpecials'] || 0;
            return countA - countB; 
        });

        for (const block of remainingBlocks) {
            if (!block.slots || block.slots.length === 0) continue;
            if (!window.scheduleAssignments[block.bunk]) continue;
            if (window.scheduleAssignments[block.bunk][block.slots[0]]) continue;

            let pick = null;

            // Smart tiles converted to 'Sports Slot' or 'Special Activity' land here.
            if (block.event === 'League Game' || block.event === 'Specialty League') {
                pick = { field: "Unassigned League", sport: null, _activity: "Free" };
            } else if (block.event === 'Special Activity' || block.event === 'Special Activity Slot') {
                pick = window.findBestSpecial?.(
                    block,
                    allActivities,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    activityProperties,
                    rotationHistory,
                    divisions,
                    historicalCounts
                );
            } else if (block.event === 'Sports Slot' || block.event === 'Sports') {
                pick = window.findBestSportActivity?.(
                    block,
                    allActivities,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    activityProperties,
                    rotationHistory,
                    divisions,
                    historicalCounts
                );
            }

            // Fallback to General Activity if no pick yet
            if (!pick) {
                pick = window.findBestGeneralActivity?.(
                    block,
                    allActivities,
                    h2hActivities,
                    fieldUsageBySlot,
                    yesterdayHistory,
                    activityProperties,
                    rotationHistory,
                    divisions,
                    historicalCounts
                );
            }

            if (pick && !isPickValidForBlock(block, pick, activityProperties, fieldUsageBySlot)) {
                pick = null;
            }

            if (pick) {
                fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, false);
                
                // --- TIGHTENING ROTATION: Update history REAL-TIME ---
                // This ensures if a bunk gets "Archery" in Slot 1, it won't get "Archery" again in Slot 3.
                if (pick._activity && block.bunk) {
                    if (!historicalCounts[block.bunk]) historicalCounts[block.bunk] = {};
                    historicalCounts[block.bunk][pick._activity] = (historicalCounts[block.bunk][pick._activity] || 0) + 1;
                    
                    // If they just got a special, increment their total special count too for fairness in next slots
                    const isSpecial = masterSpecials.some(s => s.name === pick._activity);
                    if (isSpecial) {
                         historicalCounts[block.bunk]['_totalSpecials'] = (historicalCounts[block.bunk]['_totalSpecials'] || 0) + 1;
                    }
                }
            } else {
                fillBlock(
                    block,
                    { field: "Free", sport: null, _activity: "Free" },
                    fieldUsageBySlot,
                    yesterdayHistory,
                    false
                );
            }
        }

        // =================================================================
        // PASS 5 — Update Rotation History
        // =================================================================
        try {
            const historyToSave = rotationHistory;
            const timestamp = Date.now();

            availableDivisions.forEach(divName => {
                (divisions[divName]?.bunks || []).forEach(bunk => {
                    const schedule = window.scheduleAssignments[bunk] || [];
                    let lastActivity = null;
                    for (const entry of schedule) {
                        if (entry && entry._activity && entry._activity !== lastActivity) {
                            const activityName = entry._activity;
                            lastActivity = activityName;
                            historyToSave.bunks[bunk] = historyToSave.bunks[bunk] || {};
                            historyToSave.bunks[bunk][activityName] = timestamp;

                            if (entry._h2h &&
                                activityName !== "League" &&
                                activityName !== "No Game") {
                                const leagueEntry = Object.entries(masterLeagues).find(
                                    ([name, l]) =>
                                        l.enabled &&
                                        l.divisions &&
                                        l.divisions.includes(divName)
                                );
                                if (leagueEntry) {
                                    const lgName = leagueEntry[0];
                                    historyToSave.leagues[lgName] =
                                        historyToSave.leagues[lgName] || {};
                                    historyToSave.leagues[lgName][activityName] = timestamp;
                                }
                            }
                        } else if (entry && !entry.continuation) {
                            lastActivity = null;
                        }
                    }
                });
            });

            window.saveRotationHistory?.(historyToSave);
            console.log("Smart Scheduler: Rotation history updated.");
        } catch (e) {
            console.error("Smart Scheduler: Failed to update rotation history.", e);
        }

        window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
        window.updateTable?.();
        window.saveSchedule?.();
        return true;
    }; // <--- CLOSED MAIN FUNCTION HERE

    // END IIFE
})();
