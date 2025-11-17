// ============================================================================
// scheduler_logic_core.js
//
// FULL REBUILD — "SUPERCOMPUTER / QUANTUM-ISH" LEAGUE SCHEDULER
// ... (previous changelogs) ...
//
// --- BUG FIX (USER REQUEST): DISMISSAL TILE NOT SHOWING ---
// - **REMOVED:** Old logic that read `globalStartTime` and `globalEndTime`
//   from `app1.js` (which no longer exist).
// - **REPLACED:** The "PASS 1" time grid builder now intelligently
//   scans all division times AND all pinned events (from the
//   `manualSkeleton`) to find the *true* earliest and latest
//   times for the day.
// - This ensures that 30-minute slots are created for late
//   events like "Dismissal" that occur after 4:00 PM.
// ============================================================================

(function() {
'use strict';

// ===== CONFIG =====
const INCREMENT_MINS = 30;
window.INCREMENT_MINS = INCREMENT_MINS;

// ===== BASIC HELPERS =====
function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith("am") || s.endsWith("pm")) {
        mer = s.endsWith("am") ? "am" : "pm";
        s = s.replace(/am|pm/g, "").trim();
    } else {
        // require am/pm to avoid ambiguity
        return null;
    }
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
    let h = d.getHours();
    let m = d.getMinutes().toString().padStart(2, "0");
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
}

// ======================================================
// LEAGUE ROUND STATE (IN-CORE ROUND-ROBIN ENGINE)
// ======================================================

// Global-ish state for this file (per day), but saved to daily data
let coreLeagueRoundState = (window.coreLeagueRoundState || {});

// Load round state from today's daily data (if present)
(function initCoreLeagueRoundState() {
    try {
        const daily = window.loadCurrentDailyData?.() || {};
        if (daily && daily.coreLeagueRoundState && typeof daily.coreLeagueRoundState === "object") {
            coreLeagueRoundState = daily.coreLeagueRoundState;
        }
    } catch (e) {
        console.error("Failed to load core league round state:", e);
        coreLeagueRoundState = {};
    }
    window.coreLeagueRoundState = coreLeagueRoundState;
})();

// Save round state back into today's daily data
function saveCoreLeagueRoundState() {
    try {
        window.saveCurrentDailyData?.("coreLeagueRoundState", coreLeagueRoundState);
    } catch (e) {
        console.error("Failed to save core league round state:", e);
    }
}

// Full round-robin (ALL rounds) using circle method + BYE
function coreFullRoundRobin(teamList) {
    if (!teamList || teamList.length < 2) return [];

    const teams = teamList.map(String);
    const t = [...teams];

    if (t.length % 2 !== 0) {
        t.push("BYE");
    }

    const n = t.length;
    const fixed = t[0];
    let rotating = t.slice(1);
    const rounds = [];

    for (let r = 0; r < n - 1; r++) {
        const pairings = [];

        // fixed team matches first rotating slot
        pairings.push([fixed, rotating[0]]);

        // pair remaining
        for (let i = 1; i < n / 2; i++) {
            const a = rotating[i];
            const b = rotating[rotating.length - i];
            pairings.push([a, b]);
        }

        // remove BYE pairs
        const clean = pairings.filter(([a, b]) => a !== "BYE" && b !== "BYE");
        rounds.push(clean);

        // rotate
        rotating.unshift(rotating.pop());
    }

    return rounds;
}

/**
 * Get the NEXT round of matchups for a league, guaranteed to advance.
 * - Each call moves to the next round.
 * - After the last round, wraps back to round 1.
 * - If teams set changes, round index resets.
 */
function coreGetNextLeagueRound(leagueName, teams) {
    const key = String(leagueName || "");
    if (!key || !teams || teams.length < 2) return [];

    const teamKey = teams.map(String).sort().join("|"); // identity of the team set
    const rounds = coreFullRoundRobin(teams);
    if (rounds.length === 0) return [];

    let state = coreLeagueRoundState[key] || { idx: 0, teamKey };

    // If team set changed, reset the round index
    if (state.teamKey !== teamKey) {
        state = { idx: 0, teamKey };
    }

    const idx = state.idx % rounds.length;
    const matchups = rounds[idx];

    // advance pointer
    state.idx = (idx + 1) % rounds.length;
    coreLeagueRoundState[key] = state;

    // We don't strictly need to save every call, but it's safe:
    saveCoreLeagueRoundState();

    return matchups;
}

// ====== LEAGUE "QUANTUM-ISH" SPORT OPTIMIZER ======
/**
 * assignSportsMultiRound
 * ----------------------
 * Decides WHICH SPORT each matchup should play, trying to:
 * - Avoid repeating a sport for a team until it has seen all sports
 * - Keep global sport usage balanced
 * - Keep per-team distribution balanced
 * - Respect "recentness" from leagueHistory (softly)
 *
 * Returns:
 * {
 * assignments: [ { sport }, ... ]   // same length/order as matchups
 * updatedTeamCounts: { team: { sport: count } }
 * }
 */
function assignSportsMultiRound(
    matchups,
    availableLeagueSports,
    existingTeamCounts,
    leagueHistory,
    lastSportByTeamBase // NEW: map { teamName -> last sport played }
) {
    const sports = availableLeagueSports.slice();
    const baseTeamCounts = existingTeamCounts || {};
    const baseLastSports = lastSportByTeamBase || {};

    // collect all teams
    const allTeams = new Set();
    matchups.forEach(([a, b]) => {
        if (!a || !b) return;
        allTeams.add(String(a));
        allTeams.add(String(b));
    });

    // working per-team counts (mutated in DFS)
    const workCounts = {};
    allTeams.forEach(t => {
        workCounts[t] = {};
        const src = baseTeamCounts[t] || {};
        for (const key in src) {
            if (Object.prototype.hasOwnProperty.call(src, key)) {
                workCounts[t][key] = src[key];
            }
        }
    });

    // NEW: working "last sport" per team, seeded from saved data
    const workLastSport = {};
    allTeams.forEach(t => {
        workLastSport[t] = baseLastSports[t] || null;
    });

    // global totals per sport
    const sportTotals = {};
    sports.forEach(s => { sportTotals[s] = 0; });
    for (const team in workCounts) {
        if (!Object.prototype.hasOwnProperty.call(workCounts, team)) continue;
        const counts = workCounts[team];
        for (const s in counts) {
            if (Object.prototype.hasOwnProperty.call(counts, s)) {
                sportTotals[s] = (sportTotals[s] || 0) + counts[s];
            }
        }
    }

    let bestPlan = null;
    let bestScore = Infinity;
    let bestCounts = null;
    let bestLastSports = null;
    let nodesVisited = 0;
    const MAX_NODES = 30000; // safety

    function teamDistinctSports(team) {
        return Object.keys(workCounts[team] || {}).length;
    }

    function teamTotalGames(team) {
        const counts = workCounts[team] || {};
        let total = 0;
        for (const s in counts) {
            if (Object.prototype.hasOwnProperty.call(counts, s)) {
                total += counts[s];
            }
        }
        return total;
    }

    function teamImbalance(team) {
        if (sports.length === 0) return 0;
        const counts = workCounts[team] || {};
        let min = Infinity;
        let max = -Infinity;
        sports.forEach(s => {
            const v = counts[s] || 0;
            if (v < min) min = v;
            if (v > max) max = v;
        });
        return max - min;
    }

    function globalImbalance() {
        if (sports.length === 0) return 0;
        let min = Infinity;
        let max = -Infinity;
        sports.forEach(s => {
            const v = sportTotals[s] || 0;
            if (v < min) min = v;
            if (v > max) max = v;
        });
        return max - min;
    }

    function dfs(idx, plan, currentCost) {
        if (currentCost >= bestScore) return;
        if (nodesVisited > MAX_NODES) return;

        if (idx === matchups.length) {
            const totalCost = currentCost + globalImbalance() * 4;
            if (totalCost < bestScore) {
                bestScore = totalCost;
                bestPlan = plan.slice();
                bestCounts = JSON.parse(JSON.stringify(workCounts));
                bestLastSports = JSON.parse(JSON.stringify(workLastSport));
            }
            return;
        }

        nodesVisited++;

        const [rawA, rawB] = matchups[idx];
        const teamA = String(rawA);
        const teamB = String(rawB);

        // Order sports by "promise"
        const orderedSports = sports.slice().sort((s1, s2) => {
            const c1 = (workCounts[teamA][s1] || 0) + (workCounts[teamB][s1] || 0);
            const c2 = (workCounts[teamA][s2] || 0) + (workCounts[teamB][s2] || 0);
            if (c1 !== c2) return c1 - c2;

            const h1 = leagueHistory[s1] || 0;
            const h2 = leagueHistory[s2] || 0;
            return h1 - h2;
        });

        const beforeGlobalImb = globalImbalance();
        const beforeTeamImbA = teamImbalance(teamA);
        const beforeTeamImbB = teamImbalance(teamB);
        const beforeLastA = workLastSport[teamA] || null;
        const beforeLastB = workLastSport[teamB] || null;

        for (const sport of orderedSports) {
            const prevA = workCounts[teamA][sport] || 0;
            const prevB = workCounts[teamB][sport] || 0;

            let delta = 0;

            const distinctBeforeA = teamDistinctSports(teamA);
            const distinctBeforeB = teamDistinctSports(teamB);

            const totalGamesA = teamTotalGames(teamA);
            const totalGamesB = teamTotalGames(teamB);

            const idealCoverageA = Math.min(sports.length, Math.ceil(totalGamesA / Math.max(1, sports.length)));
            const idealCoverageB = Math.min(sports.length, Math.ceil(totalGamesB / Math.max(1, sports.length)));

            // Per-team repeat penalties (ever played this sport)
            if (prevA > 0) {
                delta += 5;
                if (distinctBeforeA < sports.length) delta += 15;
                if (distinctBeforeA < idealCoverageA) delta += 6;
            }
            if (prevB > 0) {
                delta += 5;
                if (distinctBeforeB < sports.length) delta += 15;
                if (distinctBeforeB < idealCoverageB) delta += 6;
            }

            // 🔥 NEW: consecutive-repeat penalty
            if (beforeLastA === sport) {
                delta += 40; // very strong: "don’t play same sport twice in a row"
            }
            if (beforeLastB === sport) {
                delta += 40;
            }

            // Apply
            workCounts[teamA][sport] = prevA + 1;
            workCounts[teamB][sport] = prevB + 1;
            sportTotals[sport] = (sportTotals[sport] || 0) + 2;

            // Update last-sport state for this branch
            workLastSport[teamA] = sport;
            workLastSport[teamB] = sport;

            // Global imbalance delta
            const afterGlobalImb = globalImbalance();
            if (afterGlobalImb > beforeGlobalImb) {
                delta += (afterGlobalImb - beforeGlobalImb) * 4;
            }

            // Per-team imbalance delta
            const afterTeamImbA = teamImbalance(teamA);
            const afterTeamImbB = teamImbalance(teamB);
            if (afterTeamImbA > beforeTeamImbA) {
                delta += (afterTeamImbA - beforeTeamImbA) * 3;
            }
            if (afterTeamImbB > beforeTeamImbB) {
                delta += (afterTeamImbB - beforeTeamImbB) * 3;
            }

            // Recency bias (soft)
            const lastUsed = leagueHistory[sport] || 0;
            if (lastUsed > 0) {
                delta += (Date.now() - lastUsed) * 0.00000003;
            }

            const newCost = currentCost + delta;

            if (newCost < bestScore) {
                plan.push({ sport });
                dfs(idx + 1, plan, newCost);
                plan.pop();
            }

            // revert counts + last-sport
            workCounts[teamA][sport] = prevA;
            workCounts[teamB][sport] = prevB;
            sportTotals[sport] = (sportTotals[sport] || 0) - 2;
            if (prevA === 0) delete workCounts[teamA][sport];
            if (prevB === 0) delete workCounts[teamB][sport];

            workLastSport[teamA] = beforeLastA;
            workLastSport[teamB] = beforeLastB;
        }
    }

    dfs(0, [], 0);

    if (!bestPlan) {
        const fallback = matchups.map((_, i) => ({
            sport: sports[i % sports.length]
        }));
        return {
            assignments: fallback,
            updatedTeamCounts: baseTeamCounts,
            updatedLastSports: baseLastSports
        };
    }

    return {
        assignments: bestPlan,
        updatedTeamCounts: bestCounts || baseTeamCounts,
        updatedLastSports: bestLastSports || baseLastSports
    };
}

// Simple round-robin for specialty fallback
function pairRoundRobin(teamList) {
    const arr = teamList.map(String);
    if (arr.length < 2) return [];
    if (arr.length % 2 === 1) arr.push("BYE");
    const n = arr.length;
    const half = n / 2;
    const pairs = [];
    for (let i = 0; i < half; i++) {
        const A = arr[i];
        const B = arr[n - 1 - i];
        if (A !== "BYE" && B !== "BYE") pairs.push([A, B]);
    }
    return pairs;
}

// =====================================================================
// MAIN ENTRY POINT
// =====================================================================
window.runSkeletonOptimizer = function(manualSkeleton) {
    window.scheduleAssignments = {};
    window.leagueAssignments = {};
    window.unifiedTimes = [];

    if (!manualSkeleton || manualSkeleton.length === 0) {
        return false;
    }

    const {
        divisions,
        availableDivisions,
        activityProperties,
        allActivities,
        h2hActivities,
        fieldsBySport,
        masterLeagues,
        masterSpecialtyLeagues,
        yesterdayHistory,
        rotationHistory,
        disabledLeagues,
        disabledSpecialtyLeagues
    } = loadAndFilterData();

    let fieldUsageBySlot = {};
    window.fieldUsageBySlot = fieldUsageBySlot;
    window.activityProperties = activityProperties;

    const timestamp = Date.now();

    // =================================================================
    // PASS 1 — Build unified time grid
    // --- START OF FIX (Replaces old globalStart/globalEnd logic) ---
    // =================================================================

    let earliestMin = null;
    let latestMin = null;

    // Find the earliest start and latest end time from all divisions
    Object.values(divisions).forEach(div => {
        const s = parseTimeToMinutes(div.startTime);
        const e = parseTimeToMinutes(div.endTime);
        if (s !== null && (earliestMin === null || s < earliestMin)) earliestMin = s;
        if (e !== null && (latestMin === null || e > latestMin)) latestMin = e;
    });

    if (earliestMin === null) earliestMin = 540; // 9:00 AM fallback
    if (latestMin === null) latestMin = 960; // 4:00 PM fallback

    // Now, check the manual skeleton for any pinned events (like Dismissal)
    // that go *later* than the latest division's end time.
    const latestPinnedEnd = Math.max(
        -Infinity,
        ...manualSkeleton
          .filter(ev => ev && ev.type === 'pinned')
          .map(ev => parseTimeToMinutes(ev.endTime) ?? -Infinity)
    );

    if (Number.isFinite(latestPinnedEnd)) {
        latestMin = Math.max(latestMin, latestPinnedEnd);
    }

    if (latestMin <= earliestMin) latestMin = earliestMin + 60; // Failsafe
    
    // --- END OF FIX ---

    const baseDate = new Date(1970, 0, 1, 0, 0, 0);
    let currentMin = earliestMin;
    while (currentMin < latestMin) {
        const nextMin = currentMin + INCREMENT_MINS;
        const startDate = new Date(baseDate.getTime() + currentMin * 60000);
        const endDate   = new Date(baseDate.getTime() + nextMin   * 60000);
        window.unifiedTimes.push({
            start: startDate,
            end:   endDate,
            label: `${fmtTime(startDate)} - ${fmtTime(endDate)}`
        });
        currentMin = nextMin;
    }
    if (window.unifiedTimes.length === 0) {
        window.updateTable?.();
        return false;
    }

    // Create empty schedule arrays per bunk
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
            const endMin   = parseTimeToMinutes(override.endTime);
            const slots    = findSlotsForRange(startMin, endMin);
            const bunk     = override.bunk;

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
                            _activity: override.activity
                        };
                    }
                });
            }
        });
    } catch (e) {
        console.error("Error placing bunk-specific overrides:", e);
    }

  // =================================================================
// PASS 2 — Pinned / Split / Slot Skeleton Blocks
// =================================================================
const schedulableSlotBlocks = [];

// Events that REQUIRE generation (slot-type dynamic blocks)
const GENERATED_EVENTS = new Set([
    "activity",
    "activities",
    "general activity",
    "general activity slot",
    "sports",
    "sport",
    "sports slot",
    "special activity",
    "league game",
    "specialty league",
    "speciality league",
    "swim" // keep swim as generated so the Swim logic in Pass 4 still runs
]);


function isGeneratedEventName(name) {
    if (!name) return false;
    const n = String(name).trim().toLowerCase();
    return GENERATED_EVENTS.has(n);
}

manualSkeleton.forEach(item => {
    const allBunks = divisions[item.division]?.bunks || [];
    if (!allBunks || allBunks.length === 0) return;

    const startMin = parseTimeToMinutes(item.startTime);
    const endMin   = parseTimeToMinutes(item.endTime);
    const allSlots = findSlotsForRange(startMin, endMin);
    if (allSlots.length === 0) return;

    const rawEvent = item.event || "";
    const normalizedEvent = rawEvent.trim().toLowerCase();

    const isDismissal =
        normalizedEvent === "dismissal";

    const isSnack =
        normalizedEvent === "snack" ||
        normalizedEvent === "snacks" ||
        normalizedEvent.includes("snack");

    const isGenerated = isGeneratedEventName(rawEvent);

    // ============================================================
    // 1) ANYTHING EXPLICITLY "PINNED"  -> fixed tile (no generation)
    // ============================================================
    if (item.type === "pinned") {
        const label = rawEvent || "Pinned";

        allBunks.forEach(bunk => {
            allSlots.forEach((slotIndex, idx) => {
                window.scheduleAssignments[bunk][slotIndex] = {
                    field: { name: label },
                    sport: null,
                    continuation: (idx > 0),
                    _fixed: true,
                    _h2h: false,
                    vs: null,
                    _activity: label,
                    _isDismissal: isDismissal,
                    _isSnack: isSnack,
                    _isCustomTile: !isGenerated
                };
            });
        });
        return;
    }

    // ============================================================
    // 2) SLOT that is *NOT* one of:
    //    Activity / Sports / Special Activity / League Game /
    //    Specialty League / Swim  -> PIN TILE (fixed)
    // ============================================================
    if (item.type === "slot" && !isGenerated) {
        const label =
            rawEvent ||
            (isDismissal ? "Dismissal" :
             isSnack     ? "Snacks"    :
                           "Pinned");

        allBunks.forEach(bunk => {
            allSlots.forEach((slotIndex, idx) => {
                window.scheduleAssignments[bunk][slotIndex] = {
                    field: { name: label },
                    sport: null,
                    continuation: (idx > 0),
                    _fixed: true,
                    _h2h: false,
                    vs: null,
                    _activity: label,
                    _isDismissal: isDismissal,
                    _isSnack: isSnack,
                    _isCustomTile: true
                };
            });
        });
        return;
    }

    // ============================================================
    // 3) SPLIT BLOCKS
    //    Each subEvent can be either generated or pinned.
    // ============================================================
    if (item.type === "split") {
        if (!item.subEvents || item.subEvents.length < 2) return;
        const [event1, event2] = item.subEvents;

        const splitIndex = Math.ceil(allBunks.length / 2);
        const bunks1 = allBunks.slice(0, splitIndex);
        const bunks2 = allBunks.slice(splitIndex);

        const slotSplitIndex = Math.ceil(allSlots.length / 2);
        const slots1 = allSlots.slice(0, slotSplitIndex);
        const slots2 = allSlots.slice(slotSplitIndex);

        function handleSplitGroup(bunks, slots, subEvent) {
            const subName = subEvent.event || "";
            const subNorm = subName.trim().toLowerCase();
            const subIsGenerated = isGeneratedEventName(subName);

            // Dismissal / Snacks / non-generated names in splits are also pins
            const subIsDismissal = subNorm === "dismissal";
            const subIsSnack =
                subNorm === "snack" ||
                subNorm === "snacks" ||
                subNorm.includes("snack");

            const isPinnedSub =
                subEvent.type === "pinned" || !subIsGenerated || subIsDismissal || subIsSnack;

            if (isPinnedSub) {
                const label =
                    subName ||
                    (subIsDismissal ? "Dismissal" :
                     subIsSnack     ? "Snacks"    :
                                      "Pinned");

                bunks.forEach(bunk => {
                    slots.forEach((slotIndex, idx) => {
                        window.scheduleAssignments[bunk][slotIndex] = {
                            field: { name: label },
                            sport: null,
                            continuation: (idx > 0),
                            _fixed: true,
                            _h2h: false,
                            vs: null,
                            _activity: label,
                            _isDismissal: subIsDismissal,
                            _isSnack: subIsSnack,
                            _isCustomTile: !subIsGenerated
                        };
                    });
                });
            } else {
                // Generated split (e.g., half sports / half activity)
                bunks.forEach(bunk => {
                    schedulableSlotBlocks.push({
                        divName:   item.division,
                        bunk,
                        event:     subEvent.event,
                        startTime: startMin,
                        endTime:   endMin,
                        slots
                    });
                });
            }
        }

        // top-left
        handleSplitGroup(bunks1, slots1, event1);
        // top-right
        handleSplitGroup(bunks2, slots1, event2);
        // bottom-left
        handleSplitGroup(bunks1, slots2, event2);
        // bottom-right
        handleSplitGroup(bunks2, slots2, event1);

        return;
    }

    // ============================================================
    // 4) GENERATED SLOT TYPES:
    //    Activity / Sports / Special Activity / League Game /
    //    Specialty League / Swim
    // ============================================================
    if (item.type === "slot" && isGenerated) {
        allBunks.forEach(bunk => {
            schedulableSlotBlocks.push({
                divName:   item.division,
                bunk,
                event:     rawEvent,
                startTime: startMin,
                endTime:   endMin,
                slots:     allSlots
            });
        });
        return;
    }

    // If we somehow get here, do nothing.
});


    // =================================================================
    // PASS 3 — LEAGUE PASS (Quantum-ish sports + mirroring)
    // =================================================================
    const leagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'League Game');
    const specialtyLeagueBlocks = schedulableSlotBlocks.filter(b => b.event === 'Specialty League');
    const remainingBlocks = schedulableSlotBlocks.filter(
        b => b.event !== 'League Game' && b.event !== 'Specialty League'
    );

    const leagueGroups = {};
    leagueBlocks.forEach(block => {
        const leagueEntry = Object.entries(masterLeagues).find(([name, l]) =>
            l.enabled &&
            !disabledLeagues.includes(name) &&
            l.divisions.includes(block.divName)
        );
        if (!leagueEntry) return;

        const leagueName = leagueEntry[0];
        const league     = leagueEntry[1];
        const key = `${leagueName}-${block.startTime}`;

        if (!leagueGroups[key]) {
            leagueGroups[key] = {
                leagueName,
                league,
                startTime: block.startTime,
                slots: block.slots,
                bunks: new Set()
            };
        }
        leagueGroups[key].bunks.add(block.bunk);
    });

    const sortedLeagueGroups = Object.values(leagueGroups).sort((a, b) => a.startTime - b.startTime);

    sortedLeagueGroups.forEach(group => {
        const { leagueName, league, slots } = group;

        const leagueTeams = (league.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (leagueTeams.length < 2) return;

        const allBunksInGroup = Array.from(group.bunks).sort();
        if (allBunksInGroup.length === 0) return;

        // determine a base division for field rules
        let baseDivName = null;
        {
            const firstBunk = allBunksInGroup[0];
            baseDivName = Object.keys(divisions).find(div =>
                (divisions[div].bunks || []).includes(firstBunk)
            );
        }
        if (!baseDivName) return;

        const blockBase = { slots, divName: baseDivName };

        const sports = (league.sports || []).filter(s => fieldsBySport[s]);
        if (sports.length === 0) return;

        const leagueHistory = rotationHistory.leagues[leagueName] || {};
rotationHistory.leagues[leagueName] = leagueHistory;

// Per-team *totals* by sport
const leagueTeamCounts = rotationHistory.leagueTeamSports[leagueName] || {};
rotationHistory.leagueTeamSports[leagueName] = leagueTeamCounts;

// NEW: per-team last sport (for consecutive-repeat penalty)
const leagueTeamLastSport = rotationHistory.leagueTeamLastSport?.[leagueName] || {};
rotationHistory.leagueTeamLastSport = rotationHistory.leagueTeamLastSport || {};
rotationHistory.leagueTeamLastSport[leagueName] = leagueTeamLastSport;


        // Get round-robin matchups from league_scheduling.js if available,
        // otherwise fall back to our own full round-robin engine.
        let rawMatchups = [];
        if (typeof window.getLeagueMatchups === "function") {
            rawMatchups = window.getLeagueMatchups(leagueName, leagueTeams) || [];
        } else {
            rawMatchups = coreGetNextLeagueRound(leagueName, leagueTeams) || [];
        }

        // filter out BYE pairs for sport assignment
        const nonByeMatchups = rawMatchups.filter(p => p && p[0] !== "BYE" && p[1] !== "BYE");

        // Quantum-ish sport assignment
        const {
    assignments,
    updatedTeamCounts,
    updatedLastSports
} = assignSportsMultiRound(
    nonByeMatchups,
    sports,
    leagueTeamCounts,
    leagueHistory,
    leagueTeamLastSport
);

rotationHistory.leagueTeamSports[leagueName] = updatedTeamCounts;
rotationHistory.leagueTeamLastSport[leagueName] = updatedLastSports;


        // Build full schedule of (matchup + sport + field / No Field)
        const allMatchupLabels = [];
        const usedForAssignments = []; // same length as nonByeMatchups

        const slotCount = slots.length || 1;
        const usedFieldsPerSlot = Array.from({ length: slotCount }, () => new Set());

        nonByeMatchups.forEach((pair, idx) => {
            const [teamA, teamB] = pair;
            const chosenSport = assignments[idx]?.sport || sports[idx % sports.length];

            // try to find a field for this sport
            const possibleFields = fieldsBySport[chosenSport] || [];
            let slotIdx = idx % slotCount;
            let chosenField = null;

            for (const f of possibleFields) {
                if (!usedFieldsPerSlot[slotIdx].has(f) &&
                    canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
                    chosenField = f;
                    usedFieldsPerSlot[slotIdx].add(f);
                    break;
                }
            }

            if (!chosenField && possibleFields.length > 0) {
                const f = possibleFields[usedFieldsPerSlot[slotIdx].size % possibleFields.length];
                chosenField = f;
                usedFieldsPerSlot[slotIdx].add(f);
            }

            let label;
            if (chosenField) {
                label = `${teamA} vs ${teamB} (${chosenSport}) @ ${chosenField}`;
                markFieldUsage(blockBase, chosenField, fieldUsageBySlot);
            } else {
                label = `${teamA} vs ${teamB} (${chosenSport}) (No Field)`;
            }

            leagueHistory[chosenSport] = timestamp;

            usedForAssignments.push({
                label,
                sport: chosenSport,
                field: chosenField || "No Field",
                teamA,
                teamB
            });

            allMatchupLabels.push(label);
        });

        // If any original rawMatchups had BYE, we still want them on the board:
        rawMatchups.forEach(pair => {
            if (!pair) return;
            const [teamA, teamB] = pair;
            if (teamA === "BYE" || teamB === "BYE") {
                const label = `${teamA} vs ${teamB} (BYE)`;
                allMatchupLabels.push(label);
            }
        });

        // Assign games to bunks (mirroring logic)
        const noGamePick = {
            field: "No Game",
            sport: null,
            _h2h: true,
            _activity: "League",
            _allMatchups: allMatchupLabels
        };

        let bunkPtr = 0;

        usedForAssignments.forEach(game => {
            if (bunkPtr + 1 >= allBunksInGroup.length) {
                // no bunk pair left; still on scoreboard via _allMatchups
                return;
            }

            const bunkA = allBunksInGroup[bunkPtr];
            const bunkB = allBunksInGroup[bunkPtr + 1];
            bunkPtr += 2;

            const pick = {
                field: game.field,
                sport: game.label,
                _h2h: true,
                vs: null,
                _activity: game.sport,
                _allMatchups: allMatchupLabels
            };

            const bunkADiv = Object.keys(divisions).find(div =>
                (divisions[div].bunks || []).includes(bunkA)
            ) || baseDivName;
            const bunkBDiv = Object.keys(divisions).find(div =>
                (divisions[div].bunks || []).includes(bunkB)
            ) || baseDivName;

            fillBlock(
                { slots, bunk: bunkA, divName: bunkADiv },
                pick,
                fieldUsageBySlot,
                yesterdayHistory,
                true
            );
            fillBlock(
                { slots, bunk: bunkB, divName: bunkBDiv },
                pick,
                fieldUsageBySlot,
                yesterdayHistory,
                true
            );
        });

        // leftover bunks get "No Game" but same _allMatchups
        while (bunkPtr < allBunksInGroup.length) {
            const leftoverBunk = allBunksInGroup[bunkPtr++];
            const bunkDivName = Object.keys(divisions).find(div =>
                (divisions[div].bunks || []).includes(leftoverBunk)
            ) || baseDivName;

            fillBlock(
                { slots, bunk: leftoverBunk, divName: bunkDivName },
                noGamePick,
                fieldUsageBySlot,
                yesterdayHistory,
                true
            );
        }
    });

    // =================================================================
    // PASS 3.5 — SPECIALTY LEAGUES (mirroring)
    // =================================================================
    const specialtyLeagueGroups = {};
    specialtyLeagueBlocks.forEach(block => {
        const key = `${block.divName}-${block.startTime}`;
        if (!specialtyLeagueGroups[key]) {
            specialtyLeagueGroups[key] = {
                divName: block.divName,
                startTime: block.startTime,
                slots: block.slots,
                bunks: new Set()
            };
        }
        specialtyLeagueGroups[key].bunks.add(block.bunk);
    });

    Object.values(specialtyLeagueGroups).forEach(group => {
        const leagueEntry = Object.values(masterSpecialtyLeagues).find(l =>
            l.enabled &&
            !disabledSpecialtyLeagues.includes(l.name) &&
            l.divisions.includes(group.divName)
        );
        if (!leagueEntry) return;

        const allBunksInGroup = Array.from(group.bunks);
        const blockBase = { slots: group.slots, divName: group.divName };

        const leagueName = leagueEntry.name;
        const leagueHistory = rotationHistory.leagues[leagueName] || {};
        rotationHistory.leagues[leagueName] = leagueHistory;

        const sport = leagueEntry.sport;
        if (!sport || !fieldsBySport[sport]) return;

        // For specialty we just check if the sport is usable (per your old flow)
        const bestSport = window.findBestSportForBunks
            ? window.findBestSportForBunks(allBunksInGroup, [sport], leagueHistory)
            : sport;

        const allMatchupLabels = [];
        const picksByTeam = {};

        if (bestSport) {
            const leagueFields = leagueEntry.fields || [];
            const leagueTeams = (leagueEntry.teams || []).map(t => String(t).trim()).filter(Boolean);
            if (leagueFields.length === 0 || leagueTeams.length < 2) return;

            let matchups = [];
            if (typeof window.getLeagueMatchups === 'function') {
                matchups = window.getLeagueMatchups(leagueEntry.name, leagueTeams) || [];
            } else {
                matchups = pairRoundRobin(leagueTeams);
            }

            const gamesPerField = Math.ceil(matchups.length / leagueFields.length);

            for (let i = 0; i < matchups.length; i++) {
                const [teamA, teamB] = matchups[i];
                if (teamA === "BYE" || teamB === "BYE") continue;

                const fieldIndex = Math.floor(i / gamesPerField);
                const fieldName = leagueFields[fieldIndex % leagueFields.length];
                const baseLabel = `${teamA} vs ${teamB} (${sport})`;

                let pick, fullLabel;
                if (fieldName && canLeagueGameFit(blockBase, fieldName, fieldUsageBySlot, activityProperties)) {
                    fullLabel = `${baseLabel} @ ${fieldName}`;
                    pick = {
                        field: fieldName,
                        sport: baseLabel,
                        _h2h: true,
                        vs: null,
                        _activity: sport
                    };
                    markFieldUsage(blockBase, fieldName, fieldUsageBySlot);
                } else {
                    fullLabel = `${baseLabel} (No Field)`;
                    pick = {
                        field: "No Field",
                        sport: baseLabel,
                        _h2h: true,
                        vs: null,
                        _activity: sport
                    };
                }

                allMatchupLabels.push(fullLabel);
                picksByTeam[teamA] = pick;
                picksByTeam[teamB] = pick;
            }
        }

        const noGamePick = {
            field: "No Game",
            sport: null,
            _h2h: true,
            _activity: sport,
            _allMatchups: allMatchupLabels
        };

        allBunksInGroup.forEach(bunk => {
            const pickToAssign = picksByTeam[bunk] || noGamePick;
            pickToAssign._allMatchups = allMatchupLabels;
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
    // PASS 4 — Remaining Schedulable Slots (Smart Activities)
    // =================================================================
    remainingBlocks.sort((a, b) => a.startTime - b.startTime);

    for (const block of remainingBlocks) {
        if (block.slots.length === 0) continue;
        if (!window.scheduleAssignments[block.bunk]) continue;
        if (window.scheduleAssignments[block.bunk][block.slots[0]]) continue; // already filled by earlier passes

        let pick = null;

        if (block.event === 'Special Activity') {
            pick = window.findBestSpecial?.(
                block,
                allActivities,
                fieldUsageBySlot,
                yesterdayHistory,
                activityProperties,
                rotationHistory,
                divisions
            );
        } else if (block.event === 'Sports Slot') {
            pick = window.findBestSportActivity?.(
                block,
                allActivities,
                fieldUsageBySlot,
                yesterdayHistory,
                activityProperties,
                rotationHistory,
                divisions
            );
        } else if (block.event === 'Swim') {
            pick = { field: "Swim", sport: null, _activity: "Swim" };
        }

        if (!pick) {
            pick = window.findBestGeneralActivity?.(
                block,
                allActivities,
                h2hActivities,
                fieldUsageBySlot,
                yesterdayHistory,
                activityProperties,
                rotationHistory,
                divisions
            );
        }

        if (pick) {
            fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, false);
        } else {
            fillBlock(block, { field: "Free", sport: null }, fieldUsageBySlot, yesterdayHistory, false);
        }
    }

    // =================================================================
    // PASS 5 — Update Rotation History
    // =================================================================
    try {
        const historyToSave = rotationHistory;

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

                        if (entry._h2h && entry._activity !== "League" && entry._activity !== "No Game") {
                            const leagueEntry = Object.entries(masterLeagues).find(([name, l]) =>
                                l.enabled && l.divisions.includes(divName)
                            );
                            if (leagueEntry) {
                                const lgName = leagueEntry[0];
                                historyToSave.leagues[lgName] = historyToSave.leagues[lgName] || {};
                                historyToSave.leagues[lgName][entry._activity] = timestamp;
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

    // =================================================================
    // PASS 6 — Persist unifiedTimes + update UI
    // =================================================================
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
    window.updateTable?.();
    window.saveSchedule?.();

    return true;
};

// =====================================================================
// HELPER FUNCTIONS USED BY PASSES
// =====================================================================
function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes) return slots;
    for (let i = 0; i < window.unifiedTimes.length; i++) {
        const slot = window.unifiedTimes[i];
        const slotStart = new Date(slot.start).getHours() * 60 +
                          new Date(slot.start).getMinutes();
        if (slotStart >= startMin && slotStart < endMin) {
            slots.push(i);
        }
    }
    return slots;
}

function markFieldUsage(block, fieldName, fieldUsageBySlot) {
    if (!fieldName || fieldName === "No Field" || !window.allSchedulableNames.includes(fieldName)) {
        return;
    }
    for (const slotIndex of block.slots) {
        if (slotIndex === undefined) continue;
        fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
        const usage = fieldUsageBySlot[slotIndex][fieldName] || { count: 0, divisions: [] };
        usage.count++;
        if (!usage.divisions.includes(block.divName)) {
            usage.divisions.push(block.divName);
        }
        fieldUsageBySlot[slotIndex][fieldName] = usage;
    }
}

function isTimeAvailable(slotIndex, fieldProps) {
    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;
    const slot = window.unifiedTimes[slotIndex];
    const slotStartMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotEndMin   = slotStartMin + INCREMENT_MINS;

    const rules = fieldProps.timeRules || [];
    if (rules.length === 0) {
        return fieldProps.available;
    }
    if (!fieldProps.available) {
        return false;
    }

    const hasAvailableRules = rules.some(r => r.type === 'Available');
    let isAvailable = !hasAvailableRules;

    for (const rule of rules) {
        if (rule.type === 'Available') {
            if (slotStartMin >= rule.startMin && slotEndMin <= rule.endMin) {
                isAvailable = true;
                break;
            }
        }
    }
    for (const rule of rules) {
        if (rule.type === 'Unavailable') {
            if (slotStartMin < rule.endMin && slotEndMin > rule.startMin) {
                isAvailable = false;
                break;
            }
        }
    }
    return isAvailable;
}
// Compute the true start/end minutes for a block, even if slots are misaligned
function getBlockTimeRange(block) {
    let blockStartMin = (typeof block.startTime === "number") ? block.startTime : null;
    let blockEndMin   = (typeof block.endTime === "number") ? block.endTime   : null;

    // Fallback: infer from slots if start/end mins were not attached
    if ((blockStartMin == null || blockEndMin == null) &&
        window.unifiedTimes && Array.isArray(block.slots) && block.slots.length > 0) {

        const minIndex = Math.min(...block.slots);
        const maxIndex = Math.max(...block.slots);

        const firstSlot = window.unifiedTimes[minIndex];
        const lastSlot  = window.unifiedTimes[maxIndex];

        const firstStart = new Date(firstSlot.start);
        const lastStart  = new Date(lastSlot.start);

        blockStartMin = firstStart.getHours() * 60 + firstStart.getMinutes();
        blockEndMin   = lastStart.getHours() * 60 + lastStart.getMinutes() + INCREMENT_MINS;
    }

    return { blockStartMin, blockEndMin };
}

function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = (props && props.sharable) ? 2 : 1;

    // ===== DIVISION FILTER (respects explicit division list only) =====
    if (
        props &&
        Array.isArray(props.allowedDivisions) &&
        props.allowedDivisions.length > 0 &&
        !props.allowedDivisions.includes(block.divName)
    ) {
        return false;
    }

    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
        if (!limitRules.divisions[block.divName]) {
            // division not allowed at all
            return false;
        }
        const allowedBunks = limitRules.divisions[block.divName];
        if (allowedBunks.length > 0) {
            if (block.bunk && !allowedBunks.includes(block.bunk)) {
                return false;
            }
        }
    }

    // ===== NEW: block-level time-window check =====
    const { blockStartMin, blockEndMin } = getBlockTimeRange(block);
    const rules = props.timeRules || [];

    if (rules.length > 0) {
        // If any time rules exist, the field must be globally "available"
        if (!props.available) return false;

        // 1) If the BLOCK overlaps ANY "Unavailable" window -> forbidden
        if (blockStartMin != null && blockEndMin != null) {
            for (const rule of rules) {
                if (rule.type === 'Unavailable') {
                    if (
                        blockStartMin < rule.endMin &&
                        blockEndMin   > rule.startMin
                    ) {
                        // Any overlap with an Unavailable period disqualifies this field
                        return false;
                    }
                }
            }
        }

        // 2) Per-slot checks (usage/sharing + finer availability)
        for (const slotIndex of block.slots || []) {
            if (slotIndex === undefined) return false;
            const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
            if (usage.count >= limit) return false;
            if (!isTimeAvailable(slotIndex, props)) return false;
        }
    } else {
        // No time rules at all -> rely on global "available" flag and limit
        if (!props.available) return false;
        for (const slotIndex of block.slots || []) {
            if (slotIndex === undefined) return false;
            const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
            if (usage.count >= limit) return false;
        }
    }

    return true;
}

function canLeagueGameFit(block, fieldName, fieldUsageBySlot, activityProperties) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) {
        console.warn(`No properties found for field: ${fieldName}`);
        return false;
    }
    const limit = 1; // league games never sharable

    // ===== DIVISION FILTER (respects explicit division list only) =====
    if (
        props &&
        Array.isArray(props.allowedDivisions) &&
        props.allowedDivisions.length > 0 &&
        !props.allowedDivisions.includes(block.divName)
    ) {
        return false;
    }

    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
        if (!limitRules.divisions[block.divName]) {
            return false;
        }
        // (we usually don't do per-bunk filtering for leagues)
    }

    // ===== NEW: block-level time-window check for leagues too =====
    const { blockStartMin, blockEndMin } = getBlockTimeRange(block);
    const rules = props.timeRules || [];

    if (rules.length > 0) {
        if (!props.available) return false;

        // Block cannot overlap any Unavailable rule
        if (blockStartMin != null && blockEndMin != null) {
            for (const rule of rules) {
                if (rule.type === 'Unavailable') {
                    if (
                        blockStartMin < rule.endMin &&
                        blockEndMin   > rule.startMin
                    ) {
                        return false;
                    }
                }
            }
        }

        for (const slotIndex of block.slots || []) {
            if (slotIndex === undefined) return false;
            const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
            if (usage.count >= limit) return false;
            if (!isTimeAvailable(slotIndex, props)) return false;
        }
    } else {
        if (!props.available) return false;
        for (const slotIndex of block.slots || []) {
            if (slotIndex === undefined) return false;
            const usage = fieldUsageBySlot[slotIndex]?.[fieldName] || { count: 0, divisions: [] };
            if (usage.count >= limit) return false;
        }
    }

    return true;
}

function fillBlock(block, pick, fieldUsageBySlot, yesterdayHistory, isLeagueFill = false) {
    const fieldName = fieldLabel(pick.field);
    const sport     = pick.sport;

    block.slots.forEach((slotIndex, idx) => {
        if (slotIndex === undefined || slotIndex >= window.unifiedTimes.length) return;
        if (!window.scheduleAssignments[block.bunk]) return;
        if (!window.scheduleAssignments[block.bunk][slotIndex]) {
            window.scheduleAssignments[block.bunk][slotIndex] = {
                field: fieldName,
                sport: sport,
                continuation: (idx > 0),
                _fixed: false,
                _h2h: pick._h2h || false,
                vs: pick.vs || null,
                _activity: pick._activity || null,
                _allMatchups: pick._allMatchups || null
            };

            if (!isLeagueFill && fieldName && window.allSchedulableNames.includes(fieldName)) {
                fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
                const usage = fieldUsageBySlot[slotIndex][fieldName] || { count: 0, divisions: [] };
                usage.count++;
                if (!usage.divisions.includes(block.divName)) {
                    usage.divisions.push(block.divName);
                }
                fieldUsageBySlot[slotIndex][fieldName] = usage;
            }
        }
    });
}

// =====================================================================
// DATA LOADER / FILTER
// =====================================================================
function loadAndFilterData() {
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    const masterFields = app1Data.fields || [];
    const masterDivisions = app1Data.divisions || {};
    const masterAvailableDivs = app1Data.availableDivisions || [];
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
        leagueTeamSports: rotationHistoryRaw.leagueTeamSports || {}
    };

    const overrides = {
        bunks: dailyOverrides.bunks || [],
        leagues: disabledLeagues
    };

    const availableDivisions = masterAvailableDivs.filter(
        divName => !overrides.bunks.includes(divName)
    );

    const divisions = {};
    for (const divName of availableDivisions) {
        if (!masterDivisions[divName]) continue;
        divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
        divisions[divName].bunks = (divisions[divName].bunks || []).filter(
            bunkName => !overrides.bunks.includes(bunkName)
        );
    }

        function parseTimeRule(rule) {
        if (!rule || !rule.type) return null;

        // Case 1: UI already stored numeric minute values (most likely for daily overrides)
        if (typeof rule.startMin === "number" && typeof rule.endMin === "number") {
            return {
                type: rule.type,
                startMin: rule.startMin,
                endMin: rule.endMin
            };
        }

        // Case 2: Legacy / master config using "start" / "end" time strings like "1:20 PM"
        const startMin = parseTimeToMinutes(rule.start);
        const endMin   = parseTimeToMinutes(rule.end);
        if (startMin == null || endMin == null) return null;

        return {
            type: rule.type,
            startMin,
            endMin
        };
    }


    // 2) Otherwise, try to parse "start" / "end" strings like "1:20 PM"
    const startMin = parseTimeToMinutes(rule.start);
    const endMin   = parseTimeToMinutes(rule.end);

    if (startMin == null || endMin == null) return null;

    return {
        type: rule.type,
        startMin,
        endMin
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

        // 🔧 FIXED LOGIC FOR allowedDivisions:
        // - If a custom list exists, use it EXACTLY.
        // - If not, leave it null (no extra division restriction).
        const hasCustomDivList =
            Array.isArray(f.sharableWith?.divisions) &&
            f.sharableWith.divisions.length > 0;

        activityProperties[f.name] = {
            available: isMasterAvailable,
            sharable:
                f.sharableWith?.type === 'all' ||
                f.sharableWith?.type === 'custom',
            allowedDivisions: hasCustomDivList
                ? f.sharableWith.divisions.slice()
                : null,
            limitUsage: f.limitUsage || { enabled: false, divisions: {} },
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
        ...availFields
            .flatMap(f =>
                (f.activities || []).map(act => ({
                    type: "field",
                    field: f.name,
                    sport: act
                }))
            )
            .filter(a => !a.sport || !dailyDisabledSportsByField[a.field]?.includes(a.sport)),
        ...availSpecials.map(sa => ({ type: "special", field: sa.name, sport: null }))
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
        yesterdayHistory,
        rotationHistory,
        disabledLeagues,
        disabledSpecialtyLeagues
    };
}

})();
