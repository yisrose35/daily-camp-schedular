// =====================================================================
// scheduler_logic_core.js
// FULL REBUILD — League First + Mirroring + Smart Sports + Pinned
// =====================================================================

(function () {
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
      return null; // require am/pm
    }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;
    if (mer) {
      if (hh === 12) hh = mer === "am" ? 0 : 12;
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
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
  }

  // ===== ROUND-ROBIN PAIRINGS (ONE ROUND) =====
  function pairRoundRobin(teamList) {
    const arr = teamList.map(String);
    if (arr.length < 2) return [];
    if (arr.length % 2 === 1) arr.push("BYE");
    const n = arr.length;
    const half = n / 2;
    const result = [];
    for (let i = 0; i < half; i++) {
      const A = arr[i];
      const B = arr[n - 1 - i];
      if (A !== "BYE" && B !== "BYE") {
        result.push([A, B]);
      }
    }
    return result;
  }

  // ===== PICK LEAST RECENT SPORT (Smart sports rotation) =====
  function pickLeastRecentSport(sports, leagueHistory) {
    if (!sports || sports.length === 0) return null;
    if (!leagueHistory) leagueHistory = {};
    let bestSport = null;
    let bestStamp = null; // older timestamp = better

    for (const s of sports) {
      const stamp = leagueHistory[s];
      if (stamp == null) {
        // never used before ⇒ instant best
        if (bestSport === null) {
          bestSport = s;
          bestStamp = -1;
        }
      } else if (bestStamp == null || stamp < bestStamp) {
        bestSport = s;
        bestStamp = stamp;
      }
    }
    return bestSport || sports[0];
  }

  // ===== TIME GRID =====
  function buildUnifiedTimeGrid() {
    window.unifiedTimes = [];
    const globalSettings = window.loadGlobalSettings?.() || {};
    const app1Data = globalSettings.app1 || {};
    let start = parseTimeToMinutes(app1Data.globalStartTime || "9:00 AM");
    let end = parseTimeToMinutes(app1Data.globalEndTime || "4:00 PM");
    if (start == null) start = 540;
    if (end == null) end = 960;
    if (end <= start) end = start + 60;

    const base = new Date(1970, 0, 1, 0, 0, 0);
    let cur = start;
    while (cur < end) {
      const nxt = cur + INCREMENT_MINS;
      const s = new Date(base.getTime() + cur * 60000);
      const e = new Date(base.getTime() + nxt * 60000);
      window.unifiedTimes.push({
        start: s,
        end: e,
        label: `${fmtTime(s)} - ${fmtTime(e)}`
      });
      cur = nxt;
    }
  }

  function findSlotsForRange(startMin, endMin) {
    const slots = [];
    if (!window.unifiedTimes || startMin == null || endMin == null) return slots;
    for (let i = 0; i < window.unifiedTimes.length; i++) {
      const slot = window.unifiedTimes[i];
      const d = new Date(slot.start);
      const slotStart = d.getHours() * 60 + d.getMinutes();
      if (slotStart >= startMin && slotStart < endMin) {
        slots.push(i);
      }
    }
    return slots;
  }

  // ===== FIELD AVAILABILITY + LIMITS =====
  function isTimeAvailable(slotIndex, fieldProps) {
    if (!window.unifiedTimes || !window.unifiedTimes[slotIndex]) return false;

    const slot = window.unifiedTimes[slotIndex];
    const baseMin = new Date(slot.start).getHours() * 60 + new Date(slot.start).getMinutes();
    const slotStartMin = baseMin;
    const slotEndMin = baseMin + INCREMENT_MINS;

    const rules = fieldProps.timeRules || [];
    if (!fieldProps.available) return false;
    if (rules.length === 0) return fieldProps.available;

    const hasAvail = rules.some(r => r.type === "Available");
    let isAvail = !hasAvail;

    for (const r of rules) {
      if (r.type === "Available") {
        if (slotStartMin >= r.startMin && slotEndMin <= r.endMin) {
          isAvail = true;
          break;
        }
      }
    }
    for (const r of rules) {
      if (r.type === "Unavailable") {
        if (slotStartMin < r.endMin && slotEndMin > r.startMin) {
          isAvail = false;
          break;
        }
      }
    }
    return isAvail;
  }

  function canBlockFit(block, fieldName, activityProperties, fieldUsageBySlot) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) return false;

    // sharable fields: limit 2, else 1
    const limit = props.sharable ? 2 : 1;

    // allowed divisions rule
    if (props.allowedDivisions && props.allowedDivisions.length &&
      !props.allowedDivisions.includes(block.divName)) {
      return false;
    }

    // limitUsage rules (per-division/bunk allow/deny)
    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
      if (!limitRules.divisions[block.divName]) {
        return false;
      }
      const allowedBunks = limitRules.divisions[block.divName];
      if (allowedBunks.length > 0 && block.bunk && !allowedBunks.includes(block.bunk)) {
        return false;
      }
    }

    for (const slotIndex of block.slots) {
      if (slotIndex == null) return false;
      const usage = (fieldUsageBySlot[slotIndex] || {})[fieldName] || { count: 0 };
      if (usage.count >= limit) return false;
      if (!isTimeAvailable(slotIndex, props)) return false;
    }
    return true;
  }

  function canLeagueGameFit(block, fieldName, fieldUsageBySlot, activityProperties) {
    if (!fieldName) return false;
    const props = activityProperties[fieldName];
    if (!props) return false;

    // League games: NEVER sharable
    const limit = 1;

    if (props.allowedDivisions && props.allowedDivisions.length &&
      !props.allowedDivisions.includes(block.divName)) {
      return false;
    }

    const limitRules = props.limitUsage;
    if (limitRules && limitRules.enabled) {
      if (!limitRules.divisions[block.divName]) {
        return false;
      }
    }

    for (const slotIndex of block.slots) {
      if (slotIndex == null) return false;
      const usage = (fieldUsageBySlot[slotIndex] || {})[fieldName] || { count: 0 };
      if (usage.count >= limit) return false;
      if (!isTimeAvailable(slotIndex, props)) return false;
    }
    return true;
  }

  function markFieldUsage(block, fieldName, fieldUsageBySlot) {
    if (!fieldName || fieldName === "No Field" || !window.allSchedulableNames.includes(fieldName)) return;
    for (const slotIndex of block.slots) {
      if (slotIndex == null) continue;
      fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
      const entry = fieldUsageBySlot[slotIndex][fieldName] || { count: 0, divisions: [] };
      entry.count++;
      if (!entry.divisions.includes(block.divName)) {
        entry.divisions.push(block.divName);
      }
      fieldUsageBySlot[slotIndex][fieldName] = entry;
    }
  }

  function fillBlock(block, pick, fieldUsageBySlot, isLeagueFill) {
    const fName = fieldLabel(pick.field);
    const sport = pick.sport;
    block.slots.forEach((slotIndex, idx) => {
      if (slotIndex == null || !window.unifiedTimes[slotIndex]) return;
      if (!window.scheduleAssignments[block.bunk]) return;
      if (!window.scheduleAssignments[block.bunk][slotIndex]) {
        window.scheduleAssignments[block.bunk][slotIndex] = {
          field: fName,
          sport: sport,
          continuation: idx > 0,
          _fixed: false,
          _h2h: !!pick._h2h,
          vs: pick.vs || null,
          _activity: pick._activity || null,
          _allMatchups: pick._allMatchups || null
        };

        if (!isLeagueFill && fName && window.allSchedulableNames.includes(fName)) {
          fieldUsageBySlot[slotIndex] = fieldUsageBySlot[slotIndex] || {};
          const entry = fieldUsageBySlot[slotIndex][fName] || { count: 0, divisions: [] };
          entry.count++;
          if (!entry.divisions.includes(block.divName)) {
            entry.divisions.push(block.divName);
          }
          fieldUsageBySlot[slotIndex][fName] = entry;
        }
      }
    });
  }

  // ===== MASTER DATA LOAD + FILTER =====
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

    const rotationHistory = window.loadRotationHistory?.() || { bunks: {}, leagues: {} };

    const overrides = {
      bunks: dailyOverrides.bunks || [],
      leagues: disabledLeagues
    };

    const availableDivisions = masterAvailableDivs.filter(divName => !overrides.bunks.includes(divName));
    const divisions = {};
    for (const divName of availableDivisions) {
      if (!masterDivisions[divName]) continue;
      divisions[divName] = JSON.parse(JSON.stringify(masterDivisions[divName]));
      divisions[divName].bunks = (divisions[divName].bunks || []).filter(
        bunkName => !overrides.bunks.includes(bunkName)
      );
    }

    function parseTimeRule(rule) {
      const startMin = parseTimeToMinutes(rule.start);
      const endMin = parseTimeToMinutes(rule.end);
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
      activityProperties[f.name] = {
        available: isMasterAvailable,
        sharable: f.sharableWith?.type === "all" || f.sharableWith?.type === "custom",
        allowedDivisions:
          (f.sharableWith?.divisions?.length > 0 ? f.sharableWith.divisions : availableDivisions),
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

    // sport -> fields that can host it
    const fieldsBySport = {};
    availFields.forEach(f => {
      if (Array.isArray(f.activities)) {
        f.activities.forEach(sport => {
          const disabledToday = dailyDisabledSportsByField[f.name]?.includes(sport);
          if (!disabledToday) {
            fieldsBySport[sport] = fieldsBySport[sport] || [];
            fieldsBySport[sport].push(f.name);
          }
        });
      }
    });

    const allActivities = [
      ...availFields
        .flatMap(f =>
          (f.activities || []).map(act => ({ type: "field", field: f.name, sport: act }))
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

  // ===== MAIN OPTIMIZER ENTRY =====
  window.runSkeletonOptimizer = function (manualSkeleton) {
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

    // Build unified time grid
    buildUnifiedTimeGrid();
    if (!window.unifiedTimes || window.unifiedTimes.length === 0) {
      window.updateTable?.();
      return false;
    }

    // Initialize empty schedule for each bunk
    availableDivisions.forEach(divName => {
      (divisions[divName]?.bunks || []).forEach(bunk => {
        window.scheduleAssignments[bunk] = new Array(window.unifiedTimes.length);
      });
    });

    // ===== PASS 1.5: BUNK-SPECIFIC OVERRIDES =====
    try {
      const dailyData = window.loadCurrentDailyData?.() || {};
      const bunkOverrides = dailyData.bunkActivityOverrides || [];

      bunkOverrides.forEach(override => {
        const startMin = parseTimeToMinutes(override.startTime);
        const endMin = parseTimeToMinutes(override.endTime);
        const slots = findSlotsForRange(startMin, endMin);
        const bunk = override.bunk;
        if (!window.scheduleAssignments[bunk] || slots.length === 0) return;

        slots.forEach((slotIndex, idx) => {
          if (!window.scheduleAssignments[bunk][slotIndex]) {
            window.scheduleAssignments[bunk][slotIndex] = {
              field: { name: override.activity },
              sport: null,
              continuation: idx > 0,
              _fixed: true,
              _h2h: false,
              vs: null,
              _activity: override.activity
            };
          }
        });
      });
    } catch (e) {
      console.error("Error placing bunk-specific overrides:", e);
    }

    // ===== PASS 2: Build schedulable slot blocks from manualSkeleton =====
    const schedulableSlotBlocks = [];

    manualSkeleton.forEach(item => {
      const allBunks = divisions[item.division]?.bunks || [];
      if (!allBunks || allBunks.length === 0) return;

      const startMin = parseTimeToMinutes(item.startTime);
      const endMin = parseTimeToMinutes(item.endTime);
      const allSlots = findSlotsForRange(startMin, endMin);
      if (allSlots.length === 0) return;

      if (item.type === "pinned") {
        // same event for all bunks
        allBunks.forEach(bunk => {
          allSlots.forEach((slotIndex, idx) => {
            if (!window.scheduleAssignments[bunk][slotIndex]) {
              window.scheduleAssignments[bunk][slotIndex] = {
                field: { name: item.event },
                sport: null,
                continuation: idx > 0,
                _fixed: true
              };
            }
          });
        });
      } else if (item.type === "split") {
        if (!item.subEvents || item.subEvents.length < 2) return;
        const event1 = item.subEvents[0];
        const event2 = item.subEvents[1];

        const splitIndex = Math.ceil(allBunks.length / 2);
        const bunksHalf1 = allBunks.slice(0, splitIndex);
        const bunksHalf2 = allBunks.slice(splitIndex);

        const slotSplitIndex = Math.ceil(allSlots.length / 2);
        const slotsHalf1 = allSlots.slice(0, slotSplitIndex);
        const slotsHalf2 = allSlots.slice(slotSplitIndex);

        const groups = [
          { bunks: bunksHalf1, slots: slotsHalf1, eventDef: event1 },
          { bunks: bunksHalf2, slots: slotsHalf1, eventDef: event2 },
          { bunks: bunksHalf1, slots: slotsHalf2, eventDef: event2 },
          { bunks: bunksHalf2, slots: slotsHalf2, eventDef: event1 }
        ];

        groups.forEach(group => {
          if (group.slots.length === 0) return;
          group.bunks.forEach(bunk => {
            if (group.eventDef.type === "pinned") {
              group.slots.forEach((slotIndex, idx) => {
                if (!window.scheduleAssignments[bunk][slotIndex]) {
                  window.scheduleAssignments[bunk][slotIndex] = {
                    field: { name: group.eventDef.event },
                    sport: null,
                    continuation: idx > 0,
                    _fixed: true
                  };
                }
              });
            } else if (group.eventDef.type === "slot") {
              schedulableSlotBlocks.push({
                divName: item.division,
                bunk,
                event: group.eventDef.event,
                startTime: startMin,
                endTime: endMin,
                slots: group.slots
              });
            }
          });
        });
      } else if (item.type === "slot") {
        allBunks.forEach(bunk => {
          schedulableSlotBlocks.push({
            divName: item.division,
            bunk,
            event: item.event,
            startTime: startMin,
            endTime: endMin,
            slots: allSlots
          });
        });
      }
    });

    // ===== PASS 3: LEAGUE PASS (with mirroring, 1 round only) =====
    const leagueBlocks = schedulableSlotBlocks.filter(b => b.event === "League Game");
    const specialtyLeagueBlocks = schedulableSlotBlocks.filter(b => b.event === "Specialty League");
    const remainingBlocks = schedulableSlotBlocks.filter(
      b => b.event !== "League Game" && b.event !== "Specialty League"
    );

    // Group league blocks by leagueName + startTime
    const leagueGroups = {};
    leagueBlocks.forEach(block => {
      const leagueEntry = Object.entries(masterLeagues).find(([name, l]) =>
        l.enabled &&
        !disabledLeagues.includes(name) &&
        Array.isArray(l.divisions) &&
        l.divisions.includes(block.divName)
      );
      if (!leagueEntry) return;

      const leagueName = leagueEntry[0];
      const league = leagueEntry[1];
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

    const sortedLeagueGroups = Object.values(leagueGroups).sort(
      (a, b) => a.startTime - b.startTime
    );
    const timestamp = Date.now();

    for (const group of sortedLeagueGroups) {
      const { leagueName, league, slots, bunks } = group;

      const leagueTeams = (league.teams || []).map(t => String(t).trim()).filter(Boolean);
      if (leagueTeams.length < 2) continue;

      const allBunksInGroup = Array.from(bunks).sort();

      // Find base division for this group
      let baseDivName = null;
      if (allBunksInGroup.length > 0) {
        const firstBunk = allBunksInGroup[0];
        baseDivName = Object.keys(divisions).find(div =>
          (divisions[div].bunks || []).includes(firstBunk)
        );
      }
      if (!baseDivName) continue;

      const blockBase = { slots, divName: baseDivName };

      // sports allowed for this league that have fields
      const sports = (league.sports || []).filter(s => fieldsBySport[s] && fieldsBySport[s].length > 0);
      if (sports.length === 0) continue;

      const leagueHistory = rotationHistory.leagues[leagueName] || {};
      const chosenSport = pickLeastRecentSport(sports, leagueHistory);
      if (!chosenSport) continue;

      const leagueFields = fieldsBySport[chosenSport] || [];
      if (leagueFields.length === 0) continue;

      // === ONE ROUND of matchups ===
      let matchups = [];
      if (typeof window.getLeagueMatchups === "function") {
        // uses league_scheduling.js state (round advancing)
        matchups = window.getLeagueMatchups(leagueName, leagueTeams) || [];
      } else {
        // fallback: first round only, no persistent state
        matchups = pairRoundRobin(leagueTeams);
      }
      if (matchups.length === 0) continue;

      const allMatchupLabels = [];
      const picksByTeam = {};
      const fieldUsageLocal = leagueFields.slice(); // just for rotation indexing

      const gamesPerField = Math.ceil(matchups.length / leagueFields.length);

      // ===================================
      // --- START OF CORRECTED CODE (Pass 3) ---
      // ===================================
      for (let i = 0; i < matchups.length; i++) {
        const [teamA, teamB] = matchups[i];
        if (teamA === "BYE" || teamB === "BYE") continue;

        const fieldIndex = Math.floor(i / gamesPerField);
        const candidateField = leagueFields[fieldIndex % leagueFields.length];
        let chosenFieldName = candidateField;
        
        if (!canLeagueGameFit(blockBase, chosenFieldName, fieldUsageBySlot, activityProperties)) {
          // look for any field that can fit
          let alt = null;
          for (const f of leagueFields) {
            if (canLeagueGameFit(blockBase, f, fieldUsageBySlot, activityProperties)) {
              alt = f;
              break;
            }
          }
          // --- THIS IS THE FIX ---
          // It will be null if no alternate field is found.
          chosenFieldName = alt; 
          // --- END OF FIX ---
        }

        // --- NEW: Only proceed if a field was found ---
        if (chosenFieldName) { 
            const matchupLabel = `${teamA} vs ${teamB} (${chosenSport}) @ ${chosenFieldName}`;
            allMatchupLabels.push(matchupLabel);

            const pick = {
              field: chosenFieldName,
              sport: matchupLabel,
              _h2h: true,
              vs: null,
              _activity: chosenSport
            };

            if (chosenFieldName && chosenFieldName !== "No Field") { // This check is safe
              markFieldUsage(blockBase, chosenFieldName, fieldUsageBySlot);
            }

            picksByTeam[teamA] = pick;
            picksByTeam[teamB] = pick;
        } else {
            // No field available for this game.
            // We do NOT create a pick, so this game is skipped.
        }
      }
      // ===================================
      // --- END OF CORRECTED CODE (Pass 3) ---
      // ===================================

      // Distribute these picks to bunks (mirroring across divisions)
      const noGamePick = {
        field: "No Game",
        sport: null,
        _h2h: true,
        _activity: chosenSport,
        _allMatchups: allMatchupLabels
      };

      allBunksInGroup.forEach(bunk => {
        const bunkDivName = Object.keys(divisions).find(div =>
          (divisions[div].bunks || []).includes(bunk)
        ) || baseDivName;

        // Team name = bunk number (your convention); if no matching team, noGame
        const teamPick = picksByTeam[bunk] || noGamePick;
        teamPick._allMatchups = allMatchupLabels;

        fillBlock(
          { slots, bunk, divName: bunkDivName },
          teamPick,
          fieldUsageBySlot,
          true
        );
      });

      // Update league history for chosenSport
      rotationHistory.leagues[leagueName] = rotationHistory.leagues[leagueName] || {};
      rotationHistory.leagues[leagueName][chosenSport] = timestamp;
    }
    // ===== PASS 3.5: SPECIALTY LEAGUE PASS (unchanged mirroring) =====
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
        Array.isArray(l.divisions) &&
        l.divisions.includes(group.divName)
      );
      if (!leagueEntry) return;

      const allBunksInGroup = Array.from(group.bunks);
      const blockBase = { slots: group.slots, divName: group.divName };
      const divLeagueName = leagueEntry.name;
      const leagueHistory = rotationHistory.leagues[divLeagueName] || {};
      const sport = leagueEntry.sport;
      if (!sport || !fieldsBySport[sport]) return;

      // only 1 sport for specialty league, but keep function call for future
      const bestSport = sport;

      const allMatchupLabels = [];
      const picksToAssign = {};

      if (bestSport == null) {
        // nothing scheduled today
      } else {
        const leagueFields = leagueEntry.fields || [];
        const leagueTeams = (leagueEntry.teams || []).map(t => String(t).trim()).filter(Boolean);
        if (leagueFields.length === 0 || leagueTeams.length < 2) return;

        let matchups = [];
        if (typeof window.getLeagueMatchups === "function") {
          matchups = window.getLeagueMatchups(leagueEntry.name, leagueTeams) || [];
        } else {
          matchups = pairRoundRobin(leagueTeams);
        }

        const gamesPerField = Math.ceil(matchups.length / leagueFields.length);

        // ===================================
        // --- START OF CORRECTED CODE (Pass 3.5) ---
        // ===================================
        for (let i = 0; i < matchups.length; i++) {
          const [teamA, teamB] = matchups[i];
          if (teamA === "BYE" || teamB === "BYE") continue;

          const fieldIndex = Math.floor(i / gamesPerField);
          const fieldName = leagueFields[fieldIndex % leagueFields.length];
          const fullMatchupLabel = `${teamA} vs ${teamB} (${sport})`;

          let pick = null;
          let labelWithField = null;

          if (fieldName && canLeagueGameFit(blockBase, fieldName, fieldUsageBySlot, activityProperties)) {
            labelWithField = `${fullMatchupLabel} @ ${fieldName}`;
            pick = {
              field: fieldName,
              sport: fullMatchupLabel,
              _h2h: true,
              vs: null,
              _activity: sport
            };
            markFieldUsage(blockBase, fieldName, fieldUsageBySlot);

            // --- THIS IS THE FIX ---
            // These lines are moved *inside* the 'if' block.
            allMatchupLabels.push(labelWithField);
            picksToAssign[teamA] = pick;
            picksToAssign[teamB] = pick;
            // --- END OF FIX ---

          } else {
            // The 'else' block that assigned "No Field" is
            // now removed. If no field is found, 'pick'
            // remains null and nothing is assigned.
          }
        }
        // ===================================
        // --- END OF CORRECTED CODE (Pass 3.5) ---
        // ===================================
      }

      const noGamePick = {
        field: "No Game",
        sport: null,
        _h2h: true,
        _activity: sport,
        _allMatchups: allMatchupLabels
      };

      allBunksInGroup.forEach(bunk => {
        const pickToAssign = picksToAssign[bunk] || noGamePick;
        pickToAssign._allMatchups = allMatchupLabels;

        fillBlock(
          { ...blockBase, bunk },
          pickToAssign,
          fieldUsageBySlot,
          true
        );
      });
    });
    // ===== PASS 4: FILL REMAINING SCHEDULABLE SLOTS =====
    remainingBlocks.sort((a, b) => a.startTime - b.startTime);

    for (const block of remainingBlocks) {
      if (block.slots.length === 0 ||
        window.scheduleAssignments[block.bunk][block.slots[0]]) {
        continue;
      }
      let pick = null;

      if (block.event === "Special Activity") {
        pick = window.findBestSpecial?.(
          block,
          allActivities,
          fieldUsageBySlot,
          yesterdayHistory,
          activityProperties,
          rotationHistory,
          divisions
        );
      } else if (block.event === "Sports Slot") {
        pick = window.findBestSportActivity?.(
          block,
          allActivities,
          fieldUsageBySlot,
          yesterdayHistory,
          activityProperties,
          rotationHistory,
          divisions
        );
      } else if (block.event === "Swim") {
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
        fillBlock(block, pick, fieldUsageBySlot, false);
      } else {
        fillBlock(block, { field: "Free", sport: null }, fieldUsageBySlot, false);
      }
    }

    // ===== PASS 5: UPDATE ROTATION HISTORY =====
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

              if (entry._h2h && activityName !== "League" && activityName !== "No Game") {
                const leagueEntry = Object.entries(masterLeagues).find(([name, l]) =>
                  l.enabled && Array.isArray(l.divisions) && l.divisions.includes(divName)
                );
                if (leagueEntry) {
                  const lName = leagueEntry[0];
                  historyToSave.leagues[lName] = historyToSave.leagues[lName] || {};
                  historyToSave.leagues[lName][activityName] = timestamp;
                }
              }
            } else if (entry && !entry.continuation) {
              lastActivity = null;
            }
          }
        });
      });

      window.saveRotationHistory?.(historyToSave);
    } catch (e) {
      console.error("Smart Scheduler: Failed to update rotation history.", e);
    }

    // ===== PASS 6: SAVE + RENDER =====
    window.saveCurrentDailyData?.("unifiedTimes", window.unifiedTimes);
    window.updateTable?.();
    window.saveSchedule?.();
    return true;
  };

})(); // end IIFE
