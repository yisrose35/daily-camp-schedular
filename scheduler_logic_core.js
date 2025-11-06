// -------------------- scheduler_logic_fillers.js --------------------
// Post-passes: forced H2H, doubling, specials fallback, and the final
// no-placeholders failsafe that guarantees every *fillable* cell is filled.

// --- Aggressive Pass 2.5 (enhanced): recruit partners + multiple passes ---
window.fillRemainingWithForcedH2HPlus = function (
  availableDivisions, divisions, spanLen, h2hActivities, fieldUsageBySlot,
  activityProperties, h2hHistory, h2hGameCount
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
            const b = empties[j]; if (window.scheduleAssignments[b][s]) continue; if ((h2hHistory[a]?.[b] || 0) >= 1) continue;
            if (placeH2HPairPlus(a, b, div, s, spanLen)) { changed = true; break; }
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
              if (placeH2HPairPlus(a, cand, div, s, spanLen, /*evict*/true)) { changed = true; recruited = true; break; }
            }
            if (!recruited) {
              if (placeH2HPairPlus(a, cand, div, s, spanLen, /*evict*/true)) { changed = true; break; }
            }
          }
        }
      }
    }
  };

  function placeH2HPairPlus(a, b, div, s, spanLen, evict=false) {
    const todayActivityUsed = window.todayActivityUsed || {};
    const sortedPicks = (h2hActivities || []).slice().sort((p1, p2) => {
      const f1 = fieldLabel(p1.field), f2 = fieldLabel(p2.field);
      const s1 = leaguePreferredFields.has(f1) ? 1 : 0;
      const s2 = leaguePreferredFields.has(f2) ? 1 : 0;
      return s1 - s2; // prefer non-league fields
    });
    for (const pick of sortedPicks) {
      const sportName = getActivityName(pick);
      if (todayActivityUsed[a]?.has(sportName) || todayActivityUsed[b]?.has(sportName)) continue;

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
        const e2 = window.scheduleAssignments[b][s];
        if (e2 && !e2._fixed && !e2._h2h) {
          for (let k = 0; k < spanLen; k++) {
            const slot = s + k; const prev = window.scheduleAssignments[b][slot];
            if (prev && !prev._fixed && !prev._h2h) {
              const pf = fieldLabel(prev.field);
              window.scheduleAssignments[b][slot] = undefined;
              if (pf) { fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][pf] = Math.max(0, (fieldUsageBySlot[slot][pf] || 1) - 1); }
            }
          }
        }
      }
      for (let k = 0; k < spanLen; k++) {
        const slot = s + k; const cont = k > 0;
        window.scheduleAssignments[a][slot] = { field: fName, sport: sportName, continuation: cont, _h2h: true, vs: b };
        window.scheduleAssignments[b][slot] = { field: fName, sport: sportName, continuation: cont, _h2h: true, vs: a };
        fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][fName] = 2;
      }
      h2hHistory[a] = h2hHistory[a] || {}; h2hHistory[b] = h2hHistory[b] || {};
      h2hHistory[a][b] = (h2hHistory[a][b] || 0) + 1; h2hHistory[b][a] = (h2hHistory[b][a] || 0) + 1;
      h2hGameCount[a] = (h2hGameCount[a] || 0) + 1; h2hGameCount[b] = (h2hGameCount[b] || 0) + 1;

      todayActivityUsed[a].add(sportName);
      todayActivityUsed[b].add(sportName);
      return true;
    }
    return false;
  }
};

// --- Aggressive Pass 3: iterate doubling until saturation ---
window.fillRemainingWithDoublingAggressive = function (
  availableDivisions, divisions, spanLen, fieldUsageBySlot, activityProperties
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
          if (window.scheduleAssignments[b][s]) continue; if (!isActive(s)) continue;
          let seated = false;
          for (const [f, exemplar] of Object.entries(sharableOpen)) {
            let fits = true;
            for (let k = 0; k < spanLen; k++) {
              const slot = s + k; if (slot >= unifiedTimes.length) { fits = false; break; }
              const usage = (fieldUsageBySlot[slot]?.[f] || 0); const props = activityProperties[f];
              if (!props || !props.sharable || usage >= 2 || !props.allowedDivisions.includes(div)) { fits = false; break; }
              if (window.scheduleAssignments[b][slot] || window.leagueAssignments?.[div]?.[slot]) { fits = false; break; }
            }
            if (!fits) continue;
            for (let k = 0; k < spanLen; k++) {
              const slot = s + k;
              window.scheduleAssignments[b][slot] = { field: f, sport: exemplar.sport, continuation: k > 0 };
              fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
              fieldUsageBySlot[slot][f] = (fieldUsageBySlot[slot][f] || 0) + 1;
            }
            seated = true; break;
          }
        }
      }
    }
  }
};

// Final fallback filler with multi-pass: fill every *fillable* cell.
// It keeps iterating (bounded) because earlier evictions can create new gaps.
window.fillAbsolutelyAllCellsNoPlaceholders = function (
  availableDivisions, divisions, spanLen, h2hActivities, fieldUsageBySlot,
  activityProperties, h2hHistory, h2hGameCount
) {
  const unifiedTimes = window.unifiedTimes || [];
  const allActivities = window._allActivitiesCache || [];
  const todayActivityUsed = window.todayActivityUsed || {};
  const fieldsBySport = window._lastFieldsBySportCache || {};

  // Count empties helper (inside active windows, non-league slots)
  function countEmpties() {
    let c = 0;
    for (const div of (availableDivisions || [])) {
      const bunks = divisions[div]?.bunks || [];
      const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;
      for (let s = 0; s < unifiedTimes.length; s++) {
        if (!isActive(s)) continue;
        if (window.leagueAssignments?.[div]?.[s]) continue;
        for (const b of bunks) if (!window.scheduleAssignments[b][s]) c++;
      }
    }
    return c;
  }

  // Helper: evict general (same-division, non-fixed/non-H2H) occupying a field range
  function evictOnFieldRange(div, s, span, fieldName) {
    const end = Math.min(s + span, unifiedTimes.length);
    for (let slot = s; slot < end; slot++) {
      if ((fieldUsageBySlot[slot]?.[fieldName] || 0) === 0) continue; // already free
      let evicted = false;
      const bunksHere = divisions[div]?.bunks || [];
      for (const b of bunksHere) {
        const e = window.scheduleAssignments[b]?.[slot];
        if (!e || e._fixed || e._h2h) continue;
        if (fieldLabel(e.field) !== fieldName) continue;

        // Walk to the start of that occupant's span and clear its continuation range
        let k = slot;
        while (k > 0 && window.scheduleAssignments[b][k-1] && window.scheduleAssignments[b][k-1].continuation) k--;
        while (k < unifiedTimes.length && window.scheduleAssignments[b][k] && (k === slot || window.scheduleAssignments[b][k].continuation)) {
          const prev = window.scheduleAssignments[b][k];
          const pf = fieldLabel(prev.field);
          window.scheduleAssignments[b][k] = undefined;
          if (pf) {
            fieldUsageBySlot[k] = fieldUsageBySlot[k] || {};
            fieldUsageBySlot[k][pf] = Math.max(0, (fieldUsageBySlot[k][pf] || 1) - 1);
          }
          k++;
        }
        evicted = true;
        break;
      }
      if (!evicted) return false; // couldn't free this slot on the field
    }
    return true;
  }

  function placeH2HWithPossibleEviction(a, b, div, s, span, sportName) {
    const fields = fieldsBySport[sportName] || [];
    for (const fName of fields) {
      if (todayActivityUsed[a]?.has(sportName) || todayActivityUsed[b]?.has(sportName)) continue;

      let free = true;
      for (let k = 0; k < span; k++) {
        const slot = s + k;
        if (slot >= unifiedTimes.length) { free = false; break; }
        if (window.leagueAssignments?.[div]?.[slot]) { free = false; break; }
        if (window.scheduleAssignments[a][slot] || window.scheduleAssignments[b][slot]) { free = false; break; }
        if ((fieldUsageBySlot[slot]?.[fName] || 0) > 0) { free = false; break; }
      }
      if (!free) {
        if (!evictOnFieldRange(div, s, span, fName)) continue;
        // re-check conflicts after eviction
        free = true;
        for (let k = 0; k < span; k++) {
          const slot = s + k;
          if (slot >= unifiedTimes.length) { free = false; break; }
          if (window.leagueAssignments?.[div]?.[slot]) { free = false; break; }
          if (window.scheduleAssignments[a][slot] || window.scheduleAssignments[b][slot]) { free = false; break; }
          if ((fieldUsageBySlot[slot]?.[fName] || 0) > 0) { free = false; break; }
        }
      }
      if (!free) continue;

      for (let k = 0; k < span; k++) {
        const slot = s + k; const cont = k > 0;
        window.scheduleAssignments[a][slot] = { field: fName, sport: sportName, continuation: cont, _h2h: true, vs: b };
        window.scheduleAssignments[b][slot] = { field: fName, sport: sportName, continuation: cont, _h2h: true, vs: a };
        fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
        fieldUsageBySlot[slot][fName] = 2; // exclusive lock
      }
      h2hHistory[a] = h2hHistory[a] || {}; h2hHistory[b] = h2hHistory[b] || {};
      h2hHistory[a][b] = (h2hHistory[a][b] || 0) + 1; h2hHistory[b][a] = (h2hHistory[b][a] || 0) + 1;
      h2hGameCount[a] = (h2hGameCount[a] || 0) + 1; h2hGameCount[b] = (h2hGameCount[b] || 0) + 1;

      todayActivityUsed[a].add(sportName);
      todayActivityUsed[b].add(sportName);
      return true;
    }
    return false;
  }

  function placeSoloGeneralWithEviction(a, div, s, span) {
    // Prefer specials first (often easier to place), then field sports
    const candidates = [
      ...allActivities.filter(x => !x.sport),         // specials
      ...allActivities.filter(x => !!x.sport)         // sports
    ];

    for (const pick of candidates) {
      const actName = getActivityName(pick);
      if (todayActivityUsed[a]?.has(actName)) continue;

      const fName = fieldLabel(pick.field);
      const props = activityProperties[fName];
      if (props && props.allowedDivisions && !props.allowedDivisions.includes(div)) continue;

      // check free span
      let free = true, maxSpan = 0;
      for (let k = 0; k < span; k++) {
        const slot = s + k;
        if (slot >= unifiedTimes.length) break;
        if (window.leagueAssignments?.[div]?.[slot]) { free = false; break; }
        if (window.scheduleAssignments[a][slot]) { free = false; break; }
        if ((fieldUsageBySlot[slot]?.[fName] || 0) > 0) { free = false; break; }
        maxSpan++;
      }
      if (!free || maxSpan === 0) {
        if (!evictOnFieldRange(div, s, span, fName)) continue;
        // re-check quickly
        free = true; maxSpan = 0;
        for (let k = 0; k < span; k++) {
          const slot = s + k;
          if (slot >= unifiedTimes.length) break;
          if (window.leagueAssignments?.[div]?.[slot]) { free = false; break; }
          if (window.scheduleAssignments[a][slot]) { free = false; break; }
          if ((fieldUsageBySlot[slot]?.[fName] || 0) > 0) { free = false; break; }
          maxSpan++;
        }
        if (!free || maxSpan === 0) continue;
      }

      for (let k = 0; k < maxSpan; k++) {
        const slot = s + k;
        window.scheduleAssignments[a][slot] = { field: fName, sport: pick.sport || null, continuation: k > 0 };
        fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
        fieldUsageBySlot[slot][fName] = (fieldUsageBySlot[slot][fName] || 0) + 1;
      }
      todayActivityUsed[a].add(actName);
      return true;
    }
    return false;
  }

  // === MULTI-PASS LOOP: iterate until no fillable empties (bounded) ===
  let passes = 0;
  let previousEmpties = Infinity;
  while (passes++ < 6) {
    let changedAny = false;

    for (const div of (availableDivisions || [])) {
      const bunks = divisions[div]?.bunks || [];
      const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;

      for (let s = 0; s < unifiedTimes.length; s++) {
        if (!isActive(s)) continue;
        if (window.leagueAssignments?.[div]?.[s]) continue;

        // Gather empties for this slot
        let empties = bunks.filter(b => !window.scheduleAssignments[b][s]);
        if (empties.length === 0) continue;

        // STEP 1: try to pair empties into H2H (with eviction if needed)
        empties.sort(() => 0.5 - Math.random());
        const usedInPair = new Set();
        for (let i = 0; i < empties.length; i++) {
          const a = empties[i]; if (usedInPair.has(a)) continue;
          let paired = false;
          for (let j = i + 1; j < empties.length; j++) {
            const b = empties[j]; if (usedInPair.has(b)) continue;
            if ((h2hHistory[a]?.[b] || 0) >= 1) continue;
            if ((h2hGameCount[a] || 0) >= 2 || (h2hGameCount[b] || 0) >= 2) continue;

            const candidateSports = (h2hActivities || [])
              .map(p => getActivityName(p))
              .filter((sp, idx, arr) => sp && arr.indexOf(sp) === idx)
              .filter(sp => !todayActivityUsed[a]?.has(sp) && !todayActivityUsed[b]?.has(sp));

            let placed = false;
            for (const sp of candidateSports) {
              if (placeH2HWithPossibleEviction(a, b, div, s, spanLen, sp)) { placed = true; break; }
            }
            if (placed) { usedInPair.add(a); usedInPair.add(b); paired = true; changedAny = true; break; }
          }
        }

        // refresh empties after H2H pairing
        empties = bunks.filter(b => !window.scheduleAssignments[b][s]);
        if (empties.length === 0) continue;

        // STEP 2: join existing sharables
        const sharableOpen = {};
        for (const b of bunks) {
          const e = window.scheduleAssignments[b]?.[s];
          if (!e || e._h2h || e._fixed || e.continuation) continue;
          const f = fieldLabel(e.field);
          const props = activityProperties[f];
          if (!props || !props.sharable || !props.allowedDivisions.includes(div)) continue;
          const usage = (fieldUsageBySlot[s]?.[f] || 0);
          if (usage < 2) sharableOpen[f] = e;
        }

        for (const b of empties.slice()) {
          let sat = false;
          for (const [f, exemplar] of Object.entries(sharableOpen)) {
            const actName = exemplar.sport ? exemplar.sport : f;
            if (todayActivityUsed[b]?.has(actName)) continue;

            let fits = true; let maxSpan = 0;
            for (let k = 0; k < spanLen; k++) {
              const slot = s + k; if (slot >= unifiedTimes.length) break;
              if (window.scheduleAssignments[b][slot] || window.leagueAssignments?.[div]?.[slot]) { fits = false; break; }
              const usage = (fieldUsageBySlot[slot]?.[f] || 0);
              const props = activityProperties[f];
              if (!props || !props.sharable || usage >= 2 || !props.allowedDivisions.includes(div)) { fits = false; break; }
              maxSpan++;
            }
            if (!fits || maxSpan === 0) continue;

            for (let k = 0; k < maxSpan; k++) {
              const slot = s + k;
              window.scheduleAssignments[b][slot] = { field: f, sport: exemplar.sport || null, continuation: k > 0 };
              fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
              fieldUsageBySlot[slot][f] = (fieldUsageBySlot[slot][f] || 0) + 1;
            }
            todayActivityUsed[b].add(actName);
            changedAny = true;
            // remove from empties
            empties = empties.filter(x => x !== b);
            break;
          }
        }
        if (empties.length === 0) continue;

        // STEP 3: start solo general (with same-division eviction if needed)
        for (const b of empties.slice()) {
          const placed = placeSoloGeneralWithEviction(b, div, s, spanLen);
          if (placed) { changedAny = true; empties = empties.filter(x => x !== b); }
        }
      }
    }

    const current = countEmpties();
    if (!changedAny || current >= previousEmpties) break; // stabilized
    previousEmpties = current;
  }
};
