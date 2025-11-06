// -------------------- scheduler_logic_fillers.js --------------------
// Post-passes: forced H2H, doubling, and specials fallback.
// Depends on helpers from scheduler_logic_core.js.

// --- Aggressive Pass 2.5 (enhanced): recruit partners + multiple passes ---
function fillRemainingWithForcedH2HPlus(availableDivisions, divisions, spanLen, h2hActivities, fieldUsageBySlot, activityProperties, h2hHistory, h2hGameCount) {
  const unifiedTimes = window.unifiedTimes || [];
  const leaguePreferredFields = new Set();
  const global = window.loadGlobalSettings?.() || {};
  const leaguesByName = global.leaguesByName || {};
  Object.values(leaguesByName).forEach(L => { (L.sports || []).forEach(sp => { const fields = (window._lastFieldsBySportCache || {})[sp] || []; fields.forEach(f => leaguePreferredFields.add(f)); }); });

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
  }

  function placeH2HPairPlus(a, b, div, s, spanLen, evict=false) {
    const todayActivityUsed = window.todayActivityUsed || {};
    const sortedPicks = (h2hActivities || []).slice().sort((p1, p2) => {
      const f1 = fieldLabel(p1.field), f2 = fieldLabel(p2.field);
      const s1 = leaguePreferredFields.has(f1) ? 1 : 0;
      const s2 = leaguePreferredFields.has(f2) ? 1 : 0;
      return s1 - s2; // prefer non-league fields
    });
    for (const pick of sortedPicks) {
      const fName = fieldLabel(pick.field);
      const actName = getActivityName(pick); // sport
      // Per-day uniqueness for both
      if (todayActivityUsed[a]?.has(actName) || todayActivityUsed[b]?.has(actName)) continue;

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
        window.scheduleAssignments[a][slot] = { field: fName, sport: pick.sport, continuation: cont, _h2h: true, vs: b };
        window.scheduleAssignments[b][slot] = { field: fName, sport: pick.sport, continuation: cont, _h2h: true, vs: a };
        fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {}; fieldUsageBySlot[slot][fName] = 2;
      }
      h2hHistory[a] = h2hHistory[a] || {}; h2hHistory[b] = h2hHistory[b] || {};
      h2hHistory[a][b] = (h2hHistory[a][b] || 0) + 1; h2hHistory[b][a] = (h2hHistory[b][a] || 0) + 1;
      h2hGameCount[a] = (h2hGameCount[a] || 0) + 1; h2hGameCount[b] = (h2hGameCount[b] || 0) + 1;

      // Mark as used today
      todayActivityUsed[a].add(actName);
      todayActivityUsed[b].add(actName);

      return true;
    }
    return false;
  }
}

// --- Aggressive Pass 3: iterate doubling until saturation ---
function fillRemainingWithDoublingAggressive(availableDivisions, divisions, spanLen, fieldUsageBySlot, activityProperties) {
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
            const actName = exemplar.sport ? exemplar.sport : f;
            // Per-day uniqueness
            if (window.todayActivityUsed?.[b]?.has(actName)) continue;

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
            // Mark used
            window.todayActivityUsed[b].add(actName);

            changed = true; seated = true; break;
          }
          if (!seated) { /* try next bunk */ }
        }
      }
    }
  }
}

// Final fallback filler: seat empties onto safe sharable specials within grade
function fillRemainingWithFallbackSpecials(availableDivisions, divisions, spanLen, fieldUsageBySlot, activityProperties) {
  const unifiedTimes = window.unifiedTimes || [];
  const candidates = Object.entries(activityProperties).filter(([name, props]) => props && props.sharable).map(([name, props]) => ({ name, props }));
  if (candidates.length === 0) return;
  for (const div of (availableDivisions || [])) {
    const bunks = divisions[div]?.bunks || [];
    const isActive = (s) => window.divisionActiveRows?.[div]?.has(s) ?? true;
    for (let s = 0; s < unifiedTimes.length; s++) {
      if (window.leagueAssignments?.[div]?.[s]) continue;
      const empties = bunks.filter(b => !window.scheduleAssignments[b][s] && isActive(s));
      if (empties.length === 0) continue;
      for (const b of empties) {
        let seated = false;
        for (const { name, props } of candidates) {
          if (!props.allowedDivisions.includes(div)) continue;

          // Per-day uniqueness (special by name)
          if (window.todayActivityUsed?.[b]?.has(name)) continue;

          let fits = true;
          for (let k = 0; k < spanLen; k++) {
            const slot = s + k; if (slot >= unifiedTimes.length) { fits = false; break; }
            if (window.scheduleAssignments[b][slot]) { fits = false; break; }
            if (window.leagueAssignments?.[div]?.[slot]) { fits = false; break; }
            const usage = (fieldUsageBySlot[slot]?.[name] || 0); if (usage >= 2) { fits = false; break; }
          }
          if (!fits) continue;
          for (let k = 0; k < spanLen; k++) {
            const slot = s + k;
            window.scheduleAssignments[b][slot] = { field: name, continuation: k > 0 };
            fieldUsageBySlot[slot] = fieldUsageBySlot[slot] || {};
            fieldUsageBySlot[slot][name] = (fieldUsageBySlot[slot][name] || 0) + 1;
          }
          // Mark used
          window.todayActivityUsed[b].add(name);

          seated = true; break;
        }
        if (!seated) { /* nothing else to do */ }
      }
    }
  }
}
