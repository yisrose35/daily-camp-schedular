// =================================================================
// auto_skeleton_builder.js v2.0
// =================================================================
// Takes layers from the DAW planner and produces a FLAT skeleton
// array compatible with the existing pipeline.
//
// Per-bunk slot sizing: a 40min Special slot becomes 2×20 for
// Bunk 1 (Art+Cooking) but stays 1×40 for Bunk 2 (Archery).
// Items with _bunk field only expand to that bunk in Step 3.
//
// PHASES:
//   1. Pinned walls (Lunch, Swim, Dismissal, Custom)
//   2. League blocks (full buyout)
//   3. Open windows (gaps between walls)
//   4. Period distribution (typed slots into windows)
//   5. Per-bunk sizing (split based on activity durations)
//   6. Output flat skeleton
// =================================================================

(function() {
  'use strict';

  // ---------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------
  function toTime(min) {
    if (min == null) return '';
    const h = Math.floor(min / 60), m = min % 60;
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ampm;
  }

  function toMin(str) {
    if (typeof str === 'number') return str;
    if (!str || typeof str !== 'string') return null;
    const match = str.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const p = match[3].toLowerCase();
    if (p === 'pm' && h !== 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
    return h * 60 + m;
  }

  function uid() { return 'auto_' + Math.random().toString(36).slice(2, 9); }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

  // ---------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------
  function getSettings() {
    const g = window.loadGlobalSettings?.() || {};
    return g.app1 || {};
  }

  function getSpecials(grade) {
    return (getSettings().specialActivities || [])
      .filter(s => {
        if (s.available === false || s.rainyDayOnly || s.rainyDayExclusive) return false;
        if (s.limitUsage?.enabled) {
          const divs = Object.keys(s.limitUsage.divisions || {});
          if (divs.length > 0 && !divs.includes(grade)) return false;
        }
        return true;
      })
      .map(s => ({
        name: s.name,
        duration: (s.duration > 0) ? s.duration : null,
        location: s.location || null,
        capacity: s.sharableWith?.capacity || 2,
        sharing: s.sharableWith?.type || 'not_sharable',
        fullGrade: s.fullGrade === true
      }));
  }

  function getSports(grade) {
    const results = [];
    (getSettings().fields || []).forEach(f => {
      if (f.available === false) return;
      if (f.limitUsage?.enabled) {
        const divs = Object.keys(f.limitUsage?.divisions || {});
        if (divs.length > 0 && !divs.includes(grade)) return;
      }
      (f.activities || []).forEach(sport => {
        results.push({
          name: sport,
          field: f.name,
          duration: (f.duration > 0) ? f.duration : null,
          capacity: f.sharableWith?.capacity || 1,
          sharing: f.sharableWith?.type || 'not_sharable'
        });
      });
    });
    return results;
  }

  function getDivisions() {
    return window.divisions || getSettings().divisions || {};
  }

  function getHistory() {
    return window.loadRotationHistory?.() || {};
  }

  // ---------------------------------------------------------------
  // ROTATION SCORING
  // ---------------------------------------------------------------
  /** Days since bunk last did activity. 999 = never. 0 = today. */
  function daysSince(bunk, activity, history) {
    const dates = Object.keys(history).sort().reverse();
    for (let i = 0; i < dates.length; i++) {
      if ((history[dates[i]]?.[bunk] || []).includes(activity)) return i;
    }
    return 999;
  }

  /** Activities already hinted in this bunk's skeleton so far. */
  function usedHints(items) {
    const s = new Set();
    items.forEach(i => { if (i._hintActivity) s.add(i._hintActivity); });
    return s;
  }

  // ---------------------------------------------------------------
  // FIELD TRACKER (time-based capacity)
  // ---------------------------------------------------------------
  class FieldTracker {
    constructor() { this.m = {}; }
    use(field, s, e, bunk) {
      if (!field) return;
      if (!this.m[field]) this.m[field] = [];
      const r = this.m[field].find(x => x.s < e && x.e > s);
      if (r) r.bunks.add(bunk);
      else this.m[field].push({ s, e, bunks: new Set([bunk]) });
    }
    ok(field, s, e, cap) {
      if (!field || !this.m[field]) return true;
      for (const r of this.m[field]) {
        if (r.s < e && r.e > s && r.bunks.size >= cap) return false;
      }
      return true;
    }
  }

  // ---------------------------------------------------------------
  // PHASE 1: PINNED WALLS
  // ---------------------------------------------------------------
  const FIXED_TYPES = ['swim', 'lunch', 'snacks', 'dismissal', 'custom'];

  function buildWalls(layers, grade) {
    return layers
      .filter(l => l.pinExact || FIXED_TYPES.includes(l.type))
      .map(l => ({
        id: uid(), type: 'pinned',
        event: l.event || cap(l.type),
        division: grade,
        startTime: toTime(l.startMin), endTime: toTime(l.endMin),
        startMin: l.startMin, endMin: l.endMin,
        _autoGenerated: true
      }))
      .sort((a, b) => a.startMin - b.startMin);
  }

  // ---------------------------------------------------------------
  // PHASE 2: LEAGUE BLOCKS
  // ---------------------------------------------------------------
  function buildLeagues(layers, walls, grade) {
    const blocks = [];
    layers.forEach(l => {
      if (l.type !== 'league' && l.type !== 'specialty_league') return;
      if (l.pinExact) return;
      const dur = l.periodMin || 50;
      const spot = findGap(l.startMin, l.endMin, dur, walls);
      if (!spot) return;
      const b = {
        id: uid(), type: l.type,
        event: l.type === 'league' ? 'League Game' : 'Specialty League',
        division: grade,
        startTime: toTime(spot.s), endTime: toTime(spot.e),
        startMin: spot.s, endMin: spot.e,
        _autoGenerated: true
      };
      blocks.push(b);
      walls.push(b);
      walls.sort((a, b) => a.startMin - b.startMin);
    });
    return blocks;
  }

  function findGap(ws, we, dur, walls) {
    for (let s = ws; s + dur <= we; s += 5) {
      const e = s + dur;
      if (!walls.some(w => w.startMin < e && w.endMin > s)) return { s, e };
    }
    return null;
  }

  // ---------------------------------------------------------------
  // PHASE 3: OPEN WINDOWS
  // ---------------------------------------------------------------
  function findWindows(dayStart, dayEnd, walls) {
    const sorted = [...walls].sort((a, b) => a.startMin - b.startMin);
    const wins = [];
    let cursor = dayStart;
    sorted.forEach(w => {
      if (w.startMin > cursor) wins.push({ s: cursor, e: w.startMin });
      cursor = Math.max(cursor, w.endMin);
    });
    if (cursor < dayEnd) wins.push({ s: cursor, e: dayEnd });
    return wins;
  }

  // ---------------------------------------------------------------
  // PHASE 4: DISTRIBUTE PERIODS
  // ---------------------------------------------------------------
  function evtName(type) {
    switch (type) {
      case 'sports': return 'Sports Slot';
      case 'special': return 'Special Activity';
      case 'elective': return 'Elective';
      case 'split': return 'Split Activity';
      default: return 'General Activity Slot';
    }
  }

  function distributePeriods(layers, windows, walls, grade) {
    // Build list of periods to place
    const needs = [];
    layers.forEach(l => {
      if (FIXED_TYPES.includes(l.type) || l.pinExact) return;
      if (l.type === 'league' || l.type === 'specialty_league') return;
      const qty = l.quantity || 1;
      const dur = l.periodMin || 40;
      for (let i = 0; i < qty; i++) {
        needs.push({
          layerType: l.type, event: evtName(l.type),
          dur, winS: l.startMin, winE: l.endMin, placed: false
        });
      }
    });
    needs.sort((a, b) => b.dur - a.dur); // largest first

    const placed = [];
    const occ = walls.map(w => ({ s: w.startMin, e: w.endMin }));

    needs.forEach(n => {
      for (const win of windows) {
        const effS = Math.max(win.s, n.winS);
        const effE = Math.min(win.e, n.winE);
        const spot = findGapInOcc(effS, effE, n.dur, occ);
        if (spot) {
          placed.push({
            startMin: spot.s, endMin: spot.e,
            type: 'slot', event: n.event,
            layerType: n.layerType,
            division: grade, _autoGenerated: true
          });
          occ.push({ s: spot.s, e: spot.e });
          occ.sort((a, b) => a.s - b.s);
          n.placed = true;
          break;
        }
      }
      if (!n.placed) console.warn(`[AutoSkeleton] Cannot place ${n.event} (${n.dur}min)`);
    });

    // Fill gaps with General Activity
    fillGaps(placed, windows, occ, grade);

    placed.sort((a, b) => a.startMin - b.startMin);
    return placed;
  }

  function findGapInOcc(s, e, dur, occ) {
    for (let x = s; x + dur <= e; x += 5) {
      const y = x + dur;
      if (!occ.some(o => o.s < y && o.e > x)) return { s: x, e: y };
    }
    return null;
  }

  function fillGaps(placed, windows, occ, grade) {
    occ.sort((a, b) => a.s - b.s);
    windows.forEach(win => {
      let cursor = win.s;
      for (const o of occ) {
        if (o.s >= win.e) break;
        if (o.e <= cursor) continue;
        if (o.s > cursor) {
          const gap = o.s - cursor;
          if (gap >= 10) {
            placed.push({
              startMin: cursor, endMin: o.s,
              type: 'slot', event: 'General Activity Slot',
              layerType: 'activity', division: grade, _autoGenerated: true
            });
          }
        }
        cursor = Math.max(cursor, o.e);
      }
      if (cursor < win.e && (win.e - cursor) >= 10) {
        placed.push({
          startMin: cursor, endMin: win.e,
          type: 'slot', event: 'General Activity Slot',
          layerType: 'activity', division: grade, _autoGenerated: true
        });
      }
    });
  }

  // ---------------------------------------------------------------
  // PHASE 5: PER-BUNK SIZING
  // ---------------------------------------------------------------
  /**
   * For each bunk × each slot, decide whether to keep whole or split
   * based on activity durations and rotation history.
   *
   * Items with _bunk field → Step 3 expands only to that bunk.
   * Items without _bunk → Step 3 expands to ALL bunks.
   */
  function perBunkSizing(sharedSlots, walls, bunks, grade) {
    const history = getHistory();
    const specials = getSpecials(grade);
    const sports = getSports(grade);
    const tracker = new FieldTracker();
    const skeleton = [];

    // Add walls (shared, no _bunk)
    walls.forEach(w => {
      skeleton.push({
        id: uid(), type: w.type || 'pinned',
        event: w.event, division: grade,
        startTime: toTime(w.startMin), endTime: toTime(w.endMin),
        _autoGenerated: true
      });
    });

    // Per-bunk items tracker (to accumulate hints per bunk)
    const bunkItems = {};
    bunks.forEach(b => { bunkItems[b] = []; });

    // Process each schedulable slot
    sharedSlots.forEach((slot, idx) => {
      if (slot.type !== 'slot') return;

      const dur = slot.endMin - slot.startMin;
      const lType = slot.layerType || 'activity';
      // Alternate order for fairness
      const order = idx % 2 === 0 ? [...bunks] : [...bunks].reverse();

      const sizings = []; // { bunk, parts: [{ s, e, hint, field }] }
      let firstParts = null;
      let allSame = true;

      order.forEach(bunk => {
        const done = usedHints(bunkItems[bunk]);

        // Rank candidates
        const cands = rankCandidates(lType, dur, bunk, grade, done, history, specials, sports, tracker, slot.startMin, slot.endMin);

        // Size the slot
        const parts = sizeSlot(cands, dur, slot.startMin, slot.endMin);

        if (!firstParts) firstParts = parts;
        else if (parts.length !== firstParts.length || parts.some((p, i) => p.dur !== firstParts[i].dur)) {
          allSame = false;
        }

        sizings.push({ bunk, parts });

        // Track field usage + remember hints for this bunk
        parts.forEach(p => {
          if (p.field) tracker.use(p.field, p.s, p.e, bunk);
          if (p.hint) bunkItems[bunk].push({ _hintActivity: p.hint });
        });
      });

      if (allSame && firstParts) {
        // All bunks same sizing → shared skeleton items
        firstParts.forEach(p => {
          skeleton.push({
            id: uid(), type: 'slot', event: slot.event,
            division: grade,
            startTime: toTime(p.s), endTime: toTime(p.e),
            _autoGenerated: true, _slotType: lType,
            _hintActivity: p.hint || null
          });
        });
      } else {
        // Per-bunk skeleton items
        sizings.forEach(({ bunk, parts }) => {
          parts.forEach(p => {
            skeleton.push({
              id: uid(), type: 'slot', event: slot.event,
              division: grade,
              startTime: toTime(p.s), endTime: toTime(p.e),
              _bunk: bunk,
              _autoGenerated: true, _slotType: lType,
              _hintActivity: p.hint || null
            });
          });
        });
      }
    });

    skeleton.sort((a, b) => (toMin(a.startTime) || 0) - (toMin(b.startTime) || 0));
    return skeleton;
  }

  function rankCandidates(layerType, maxDur, bunk, grade, done, history, specials, sports, tracker, sS, sE) {
    const cands = [];
    const wantSpecials = ['special', 'activity'].includes(layerType);
    const wantSports = ['sports', 'activity'].includes(layerType);

    if (wantSpecials) {
      specials.forEach(sp => {
        if (done.has(sp.name)) return;
        if (sp.duration && sp.duration > maxDur) return;
        if (sp.location && !tracker.ok(sp.location, sS, sE, sp.capacity)) return;
        cands.push({
          name: sp.name, type: 'special', dur: sp.duration,
          field: sp.location, cap: sp.capacity,
          score: daysSince(bunk, sp.name, history)
        });
      });
    }
    if (wantSports) {
      const byName = new Map();
      sports.forEach(sp => {
        if (done.has(sp.name)) return;
        if (sp.duration && sp.duration > maxDur) return;
        if (!tracker.ok(sp.field, sS, sE, sp.capacity)) return;
        const sc = daysSince(bunk, sp.name, history);
        const ex = byName.get(sp.name);
        if (!ex || sc > ex.score) {
          byName.set(sp.name, {
            name: sp.name, type: 'sport', dur: sp.duration,
            field: sp.field, cap: sp.capacity, score: sc
          });
        }
      });
      byName.forEach(v => cands.push(v));
    }

    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  function sizeSlot(cands, slotDur, slotS, slotE) {
    if (cands.length === 0) {
      return [{ s: slotS, e: slotE, dur: slotDur, hint: null, field: null }];
    }

    const result = [];
    let cursor = slotS;
    const used = new Set();

    for (const c of cands) {
      if (cursor >= slotE) break;
      if (used.has(c.name)) continue;
      const remaining = slotE - cursor;
      if (remaining < 5) break;

      const actDur = c.dur || remaining; // no duration = fill rest
      if (actDur > remaining) continue;

      result.push({ s: cursor, e: cursor + actDur, dur: actDur, hint: c.name, field: c.field });
      used.add(c.name);
      cursor += actDur;
    }

    // Handle remaining time
    if (cursor < slotE) {
      const rem = slotE - cursor;
      if (rem >= 10 && result.length > 0) {
        result.push({ s: cursor, e: slotE, dur: rem, hint: null, field: null });
      } else if (result.length > 0) {
        // Tiny gap → extend last
        result[result.length - 1].e = slotE;
        result[result.length - 1].dur = slotE - result[result.length - 1].s;
      } else {
        result.push({ s: slotS, e: slotE, dur: slotDur, hint: null, field: null });
      }
    }

    return result;
  }

  // ---------------------------------------------------------------
  // MAIN
  // ---------------------------------------------------------------
  function buildFromLayers(layers, grade) {
    const L = '[AutoSkeleton]';
    console.log(`${L} ══════════════════════════════════════`);
    console.log(`${L} Building for ${grade}, ${layers.length} layers`);

    const divs = getDivisions();
    const gd = divs[grade];
    if (!gd) return { skeleton: [], sharedSlots: [], walls: [], warnings: [`Grade not found: ${grade}`] };

    const bunks = gd.bunks || [];
    const ds = toMin(gd.startTime) || 540;
    const de = toMin(gd.endTime) || 960;
    console.log(`${L} ${bunks.length} bunks, ${toTime(ds)}-${toTime(de)}`);

    const walls = buildWalls(layers, grade);
    console.log(`${L} Phase 1: ${walls.length} walls`);

    const leagues = buildLeagues(layers, walls, grade);
    console.log(`${L} Phase 2: ${leagues.length} leagues`);

    const windows = findWindows(ds, de, walls);
    console.log(`${L} Phase 3: ${windows.length} windows (${windows.reduce((t, w) => t + w.e - w.s, 0)}min)`);

    const slots = distributePeriods(layers, windows, walls, grade);
    console.log(`${L} Phase 4: ${slots.length} period slots`);
    slots.forEach(s => console.log(`  ${toTime(s.startMin)}-${toTime(s.endMin)} ${s.event} (${s.endMin - s.startMin}min)`));

    const skeleton = perBunkSizing(slots, walls, bunks, grade);
    const bunkSpecific = skeleton.filter(s => s._bunk).length;
    console.log(`${L} Phase 5: ${skeleton.length} items (${bunkSpecific} bunk-specific)`);

    if (bunks.length > 0) {
      const b = bunks[0];
      console.log(`${L} Sample (${b}):`);
      skeleton.filter(s => !s._bunk || s._bunk === b).forEach(s => {
        const h = s._hintActivity ? ` → ${s._hintActivity}` : '';
        const bk = s._bunk ? ` [bunk-specific]` : '';
        console.log(`  ${s.startTime}-${s.endTime} ${s.event}${h}${bk}`);
      });
    }

    return {
      skeleton,
      sharedSlots: [...walls, ...leagues, ...slots].sort((a, b) => a.startMin - b.startMin),
      walls,
      warnings: []
    };
  }

  function buildAll(allLayers) {
    const grades = [...new Set(allLayers.map(l => l.grade))];
    const combined = [], warnings = [], shared = {};
    grades.forEach(g => {
      const r = buildFromLayers(allLayers.filter(l => l.grade === g), g);
      combined.push(...r.skeleton);
      warnings.push(...r.warnings);
      shared[g] = r.sharedSlots;
    });
    return { skeleton: combined, sharedByGrade: shared, warnings };
  }

  // ---------------------------------------------------------------
  // EXPORTS
  // ---------------------------------------------------------------
  window.AutoSkeletonBuilder = {
    buildFromLayers,
    buildAll,
    _test: { buildWalls, buildLeagues, findWindows, distributePeriods, perBunkSizing, rankCandidates, sizeSlot, daysSince, FieldTracker }
  };

  console.log('[AutoSkeletonBuilder] v2.0 loaded');
})();
