/* =========================================================================
 * helper_mode.js — Campistry "Helper Mode"
 * =========================================================================
 * A third builder mode alongside Manual and Auto. The user builds the
 * schedule THEMSELVES — no solver runs. In the skeleton editor they place a
 * single blank "Activity Block" tile per grade (declaring an activity window).
 * Pressing Generate opens this Excel-style spreadsheet where they fill in what
 * each BUNK is actually doing, with real-time (inline, non-blocking) validation
 * for double-bookings, field-off (daily adjustments), and out-of-config field
 * use. Cells are written into the standard window.scheduleAssignments shape and
 * saved to the same daily_schedules cloud table, so Print / Calendar / Analytics
 * all work with Helper schedules for free.
 *
 * Cell input offers three modes:
 *   1. Free text        — type anything.
 *   2. Activity         — pick Sport or Special from the camp's config, + field.
 *   3. League           — pick league (by grade) → matchup → sport → field.
 * ========================================================================= */
(function () {
  'use strict';

  var HELPER = 'helper';

  // Debounced autosave + validation issue map keyed by `${bunk}|${slotIdx}`.
  var _saveTimer = null;
  var _issues = {};        // key -> { level:'error'|'warn', msg }
  var _stylesInjected = false;
  var _viewMode = 'grade'; // 'grade' (per-division tables) | 'all' (shared timeline)

  // ---------------------------------------------------------------------
  // Mode + small utilities
  // ---------------------------------------------------------------------
  function currentMode() {
    return (window.getCampBuilderMode && window.getCampBuilderMode()) || window._daBuilderMode || 'manual';
  }
  function isActive() { return currentMode() === HELPER; }

  function currentDateKey() {
    return window.currentScheduleDate ||
           (document.getElementById('calendar-date-picker') || {}).value ||
           new Date().toISOString().split('T')[0];
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseTimeToMinutes(t) {
    if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.parseTimeToMinutes) {
      var v = window.SchedulerCoreUtils.parseTimeToMinutes(t);
      if (v != null) return v;
    }
    if (typeof t === 'number') return t;
    if (!t) return null;
    var s = String(t).trim().toLowerCase();
    var m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
    if (!m) { m = s.match(/^(\d{1,2})\s*(am|pm)$/); if (m) m = [m[0], m[1], '00', m[2]]; }
    if (!m) return null;
    var h = parseInt(m[1], 10), min = parseInt(m[2], 10), ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }

  function minutesToLabel(min) {
    if (min == null) return '';
    var h = Math.floor(min / 60), m = min % 60;
    var ap = h >= 12 ? 'pm' : 'am';
    var hh = h % 12; if (hh === 0) hh = 12;
    return hh + ':' + (m < 10 ? '0' + m : m) + ap;
  }

  function normField(f) {
    return String(f == null ? '' : f).trim().toLowerCase();
  }

  // ---------------------------------------------------------------------
  // Config accessors (camp structure / activities / fields / leagues)
  // ---------------------------------------------------------------------
  function getDivisions() {
    return window.divisions || (window.getDivisions && window.getDivisions()) ||
           (window.loadGlobalSettings && window.loadGlobalSettings().app1 && window.loadGlobalSettings().app1.divisions) || {};
  }
  function getSports() {
    try { return (window.getAllGlobalSports && window.getAllGlobalSports()) || []; } catch (e) { return []; }
  }
  function getSpecials() {
    try {
      var arr = (window.getGlobalSpecialActivities && window.getGlobalSpecialActivities()) || [];
      return arr.map(function (s) { return (s && s.name) || s; }).filter(Boolean);
    } catch (e) { return []; }
  }
  function getFieldConfigs() {
    var g = (window.loadGlobalSettings && window.loadGlobalSettings()) || {};
    return ((g.app1 && g.app1.fields) || g.fields || []).filter(function (f) { return f && f.name; });
  }
  function getFieldNames() { return getFieldConfigs().map(function (f) { return f.name; }); }
  function getFieldConfig(name) {
    var n = normField(name);
    return getFieldConfigs().find(function (f) { return normField(f.name) === n; }) || null;
  }
  function getLeaguesForDivision(divName) {
    var lb = window.leaguesByName || window.masterLeagues || {};
    return Object.keys(lb).map(function (k) { return lb[k]; }).filter(function (l) {
      return l && Array.isArray(l.divisions) && l.divisions.indexOf(divName) !== -1;
    });
  }
  // Configured "general activities" (facilities registry) — named activities
  // pre-bound to a facility, e.g. { name:'Photography', facility:'Art Room' }.
  function getGeneralActivities() {
    try { return (window.getGeneralActivityPaletteItems && window.getGeneralActivityPaletteItems()) || []; }
    catch (e) { return []; }
  }

  // When the user leaves the field blank for a sport/special/general activity,
  // let the program pick an OPEN field for that activity at this time window
  // (respects access, capacity, conflicts). Returns a field name or null.
  function autoAssignField(activity, bunk, divName, block) {
    if (!activity) return null;
    try {
      var slots = (window.SchedulerCoreUtils && window.SchedulerCoreUtils.findSlotsForRange)
        ? (window.SchedulerCoreUtils.findSlotsForRange(block.startMin, block.endMin, divName, bunk) || [])
        : [];
      if (typeof window.findFieldsForActivity === 'function') {
        var res = window.findFieldsForActivity(activity, slots, divName, bunk, block.startMin, block.endMin);
        if (res && res.open && res.open.length) return res.open[0].name;
      }
    } catch (e) { console.error('[Helper] autoAssignField failed', e); }
    return null;
  }

  function divisionOrder() {
    var divs = getDivisions();
    var names = Object.keys(divs);
    if (typeof window.getUserDivisionOrder === 'function') {
      try { names = window.getUserDivisionOrder(names); } catch (e) {}
    }
    return names;
  }

  function getDivisionForBunk(bunk) {
    if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getDivisionForBunk) {
      var d = window.SchedulerCoreUtils.getDivisionForBunk(bunk);
      if (d) return d;
    }
    var divs = getDivisions();
    for (var dn in divs) {
      if ((divs[dn].bunks || []).indexOf(bunk) !== -1) return dn;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Skeleton -> divisionTimes / unifiedTimes / scheduleAssignments
  // ---------------------------------------------------------------------
  function getDaySkeleton(dateKey) {
    var dk = dateKey || currentDateKey();
    // Prefer the canonical getter if the unified system exposes it.
    if (window.UnifiedScheduleSystem && typeof window.UnifiedScheduleSystem.getSkeleton === 'function') {
      try {
        var s = window.UnifiedScheduleSystem.getSkeleton(dk);
        if (Array.isArray(s) && s.length) return s;
      } catch (e) {}
    }
    // Fallbacks — the authoritative per-date board, then window mirrors.
    try {
      var raw = localStorage.getItem('campManualSkeleton_' + dk);
      if (raw) { var p = JSON.parse(raw); if (Array.isArray(p) && p.length) return p; }
    } catch (e) {}
    if (Array.isArray(window.dailyOverrideSkeleton) && window.dailyOverrideSkeleton.length) return window.dailyOverrideSkeleton;
    if (Array.isArray(window.manualSkeleton) && window.manualSkeleton.length) return window.manualSkeleton;
    if (Array.isArray(window.skeleton) && window.skeleton.length) return window.skeleton;
    return [];
  }

  // Build (or refresh) window.divisionTimes, window.unifiedTimes and ensure
  // window.scheduleAssignments has a slot array per bunk. NON-DESTRUCTIVE:
  // existing filled cells are always preserved.
  function buildStructure(dateKey) {
    var skeleton = getDaySkeleton(dateKey);
    var divs = getDivisions();

    var divisionTimes = {};
    if (window.DivisionTimesSystem && window.DivisionTimesSystem.buildFromSkeleton) {
      try { divisionTimes = window.DivisionTimesSystem.buildFromSkeleton(skeleton, divs) || {}; }
      catch (e) { console.error('[Helper] buildFromSkeleton failed', e); divisionTimes = {}; }
    }
    // Fallback: group skeleton tiles by division directly.
    if (!divisionTimes || !Object.keys(divisionTimes).length) {
      divisionTimes = {};
      skeleton.forEach(function (b) {
        if (!b || !b.division) return;
        var sm = parseTimeToMinutes(b.startTime), em = parseTimeToMinutes(b.endTime);
        if (sm == null || em == null || em <= sm) return;
        (divisionTimes[b.division] = divisionTimes[b.division] || []).push({
          startMin: sm, endMin: em, event: b.event || 'Activity', type: 'slot'
        });
      });
      Object.keys(divisionTimes).forEach(function (d) {
        divisionTimes[d].sort(function (a, b) { return a.startMin - b.startMin; });
        divisionTimes[d].forEach(function (s, i) { s.slotIndex = i; });
      });
    } else {
      Object.keys(divisionTimes).forEach(function (d) {
        divisionTimes[d].forEach(function (s, i) { if (s.slotIndex == null) s.slotIndex = i; });
      });
    }
    window.divisionTimes = divisionTimes;

    // Union of all distinct windows -> unifiedTimes (flat master axis).
    var seen = {}, uni = [];
    Object.keys(divisionTimes).forEach(function (d) {
      divisionTimes[d].forEach(function (s) {
        var k = s.startMin + '-' + s.endMin;
        if (!seen[k]) { seen[k] = true; uni.push({ startMin: s.startMin, endMin: s.endMin, event: s.event || 'Activity', type: 'slot' }); }
      });
    });
    uni.sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin; });
    window.unifiedTimes = uni;

    // Ensure a slot array per bunk (preserve existing entries).
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    Object.keys(divs).forEach(function (dn) {
      var slotCount = (divisionTimes[dn] || []).length;
      (divs[dn].bunks || []).forEach(function (bunk) {
        var arr = window.scheduleAssignments[bunk];
        if (!Array.isArray(arr)) { window.scheduleAssignments[bunk] = new Array(slotCount).fill(null); return; }
        if (arr.length < slotCount) { for (var i = arr.length; i < slotCount; i++) arr[i] = arr[i] || null; }
      });
    });

    window._scheduleAssignmentsDate = dateKey || currentDateKey();
    return { divisionTimes: divisionTimes, skeleton: skeleton };
  }

  // ---------------------------------------------------------------------
  // Validation — inline, non-blocking. Three checks:
  //   (a) double-booking (same field, overlapping time, over capacity)
  //   (b) field turned off for the day (daily adjustments / rainy)
  //   (c) field used by a grade outside its configuration (sharing scope /
  //       bunk-only access restriction)
  // ---------------------------------------------------------------------
  function overlaps(a1, a2, b1, b2) { return a1 < b2 && b1 < a2; }

  function fieldCapacity(fieldName) {
    if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.getFieldCapacity) {
      try {
        var c = window.SchedulerCoreUtils.getFieldCapacity(fieldName);
        if (typeof c === 'number' && c > 0) return c;
      } catch (e) {}
    }
    var cfg = getFieldConfig(fieldName);
    var sw = cfg && cfg.sharableWith;
    if (sw) {
      if (sw.type === 'all') return sw.capacity || 999;
      if (sw.type === 'same_division' || sw.type === 'custom') return sw.capacity || 2;
      if (sw.type === 'not_sharable') return 1;
    }
    return 1;
  }

  function isFieldOff(fieldName) {
    var n = normField(fieldName);
    if (!n) return false;
    var dis = window.currentDisabledFields || [];
    if (dis.some(function (f) { return normField(f) === n; })) return true;
    // Per-date overrides (campResourceOverrides_<date>) if loaded helper.
    try {
      if (typeof window.loadCurrentDailyData === 'function') {
        var dd = window.loadCurrentDailyData() || {};
        if ((dd.disabledFields || []).some(function (f) { return normField(f) === n; })) return true;
      }
    } catch (e) {}
    // Master availability flag on the field config.
    var cfg = getFieldConfig(fieldName);
    if (cfg && cfg.available === false) return true;
    return false;
  }

  // Returns a reason string if the (bunk/division) is NOT allowed to use this
  // field per configuration, else null.
  function accessViolation(bunk, divName, fieldName, activity) {
    if (!fieldName) return null;
    // Bunk-only access restriction (per-date allow-list).
    try {
      if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.isBunkRestrictedFromTarget) {
        if (window.SchedulerCoreUtils.isBunkRestrictedFromTarget(bunk, activity, fieldName, divName)) {
          return 'This bunk is not on the access list for ' + fieldName + ' today.';
        }
      }
    } catch (e) {}
    // Field sharing scope: an explicit division allow-list that excludes us.
    var cfg = getFieldConfig(fieldName);
    var sw = cfg && cfg.sharableWith;
    if (sw && Array.isArray(sw.divisions) && sw.divisions.length &&
        (sw.type === 'custom' || sw.type === 'cross_division')) {
      if (sw.divisions.indexOf(divName) === -1) {
        return divName + ' is not configured to use ' + fieldName + '.';
      }
    }
    return null;
  }

  function entryLocation(entry) {
    if (!entry) return null;
    if (entry._location) return entry._location;
    // Derive from "Location – Activity" composite when no explicit _location.
    if (typeof entry.field === 'string' && entry.field.indexOf(' – ') !== -1) {
      return entry.field.split(' – ')[0].trim();
    }
    return null;
  }

  // Recompute all issues for the current in-memory schedule.
  function validateAll() {
    _issues = {};
    var sa = window.scheduleAssignments || {};
    var divs = getDivisions();

    // Flat list of placed cells with resolved field + time.
    var placed = [];
    Object.keys(divs).forEach(function (dn) {
      var slots = (window.divisionTimes && window.divisionTimes[dn]) || [];
      (divs[dn].bunks || []).forEach(function (bunk) {
        var arr = sa[bunk] || [];
        slots.forEach(function (slot, idx) {
          var e = arr[idx];
          if (!e || e._activity === 'Free' || (!e._activity && !e._displayName && !e.sport)) return;
          placed.push({
            bunk: bunk, div: dn, idx: idx,
            start: e._startMin != null ? e._startMin : slot.startMin,
            end: e._endMin != null ? e._endMin : slot.endMin,
            loc: entryLocation(e),
            activity: e._activity || e.sport || '',
            entry: e
          });
        });
      });
    });

    function addIssue(bunk, idx, level, msg) {
      var k = bunk + '|' + idx;
      var cur = _issues[k];
      // errors win over warnings; concatenate messages.
      if (!cur) { _issues[k] = { level: level, msg: msg }; }
      else {
        cur.msg = cur.msg + '\n' + msg;
        if (level === 'error') cur.level = 'error';
      }
    }

    // (b) field off + (c) access — per cell.
    placed.forEach(function (p) {
      if (p.loc && isFieldOff(p.loc)) {
        addIssue(p.bunk, p.idx, 'error', p.loc + ' is turned OFF today (Daily Adjustments).');
      }
      if (p.loc) {
        var av = accessViolation(p.bunk, p.div, p.loc, p.activity);
        if (av) addIssue(p.bunk, p.idx, 'error', av);
      }
    });

    // (a) double-booking — group by normalized field, find over-capacity overlaps.
    var byField = {};
    placed.forEach(function (p) {
      if (!p.loc) return;
      (byField[normField(p.loc)] = byField[normField(p.loc)] || []).push(p);
    });
    Object.keys(byField).forEach(function (fk) {
      var list = byField[fk];
      if (list.length < 2) return;
      var cap = fieldCapacity(list[0].loc);
      list.forEach(function (p) {
        // Count how many OTHER cells overlap p in time on the same field.
        var concurrent = 1;
        var partners = [];
        list.forEach(function (q) {
          if (q === p) return;
          if (overlaps(p.start, p.end, q.start, q.end)) { concurrent++; partners.push(q); }
        });
        if (concurrent > cap) {
          var names = partners.map(function (q) { return q.bunk; });
          addIssue(p.bunk, p.idx, 'error',
            'Double-booked on ' + p.loc + ' (' + minutesToLabel(p.start) + '–' + minutesToLabel(p.end) +
            ') with ' + names.join(', ') + '. Capacity ' + cap + '.');
        }
      });
    });

    return _issues;
  }

  function issueFor(bunk, idx) { return _issues[bunk + '|' + idx] || null; }

  function issueCount() {
    return Object.keys(_issues).length;
  }

  // ---------------------------------------------------------------------
  // Write a cell + persist
  // ---------------------------------------------------------------------
  function clearCell(bunk, idx) {
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
    window.scheduleAssignments[bunk][idx] = null;
    afterWrite();
  }

  function stampEntry(entry, block) {
    entry._startMin = block.startMin;
    entry._endMin = block.endMin;
    entry.continuation = false;
    entry._fixed = true;
    entry._postEdit = true;
    entry._helper = true;
    entry._editedAt = Date.now();
    return entry;
  }

  function writeCell(bunk, idx, block, entry) {
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
    window.scheduleAssignments[bunk][idx] = stampEntry(entry, block);
    afterWrite();
  }

  function getGradeBunks(divName) {
    var d = getDivisions()[divName];
    return (d && d.bunks) || [];
  }

  // Apply an activity to MANY bunks at once (whole grade or a chosen subset).
  // buildEntry(fieldName) returns the entry for a given resolved field; when a
  // bunk needs an auto-assigned field it's resolved per-bunk & sequentially so
  // the bunks spread across different open fields instead of colliding.
  function writeCellsMulti(targets, idx, block, buildEntry, opts) {
    opts = opts || {};
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    targets.forEach(function (tb) {
      var field = opts.explicitField || null;
      if (!field && opts.autoField && opts.activity) {
        field = autoAssignField(opts.activity, tb, opts.divName, block);
      }
      var entry = buildEntry(field, !opts.explicitField && !!field);
      if (!window.scheduleAssignments[tb]) window.scheduleAssignments[tb] = [];
      window.scheduleAssignments[tb][idx] = stampEntry(entry, block);
    });
    afterWrite();
  }

  // Circle-method round-robin. Returns array of rounds; each round is an array
  // of [teamA, teamB] pairs. Odd team counts get a BYE (dropped from pairs).
  function roundRobinRounds(teams) {
    var t = (teams || []).filter(Boolean).slice();
    if (t.length < 2) return [];
    if (t.length % 2 === 1) t.push('__BYE__');
    var n = t.length, rounds = [];
    var arr = t.slice();
    for (var r = 0; r < n - 1; r++) {
      var pairs = [];
      for (var i = 0; i < n / 2; i++) {
        var a = arr[i], b = arr[n - 1 - i];
        if (a !== '__BYE__' && b !== '__BYE__') pairs.push([a, b]);
      }
      rounds.push(pairs);
      arr.splice(1, 0, arr.pop()); // rotate, keeping the first element fixed
    }
    return rounds;
  }

  // Write a whole-grade league period: the authoritative division entry PLUS a
  // _league marker mirrored into every bunk (matches the auto/print model).
  function writeLeagueSlot(divName, idx, block, leagueName, matchups, gameLabel) {
    if (!window.leagueAssignments) window.leagueAssignments = {};
    if (!window.leagueAssignments[divName]) window.leagueAssignments[divName] = {};
    var teamSet = {};
    var mus = matchups.map(function (m) {
      teamSet[m.teamA] = 1; teamSet[m.teamB] = 1;
      return {
        teamA: m.teamA, teamB: m.teamB, sport: m.sport || null, field: m.field || null,
        display: m.teamA + ' vs ' + m.teamB + (m.sport ? ' (' + m.sport + ')' : '') + (m.field ? ' @ ' + m.field : '')
      };
    });
    window.leagueAssignments[divName][idx] = {
      matchups: mus,
      gameLabel: gameLabel || 'League Game',
      sport: (mus[0] && mus[0].sport) || null,
      leagueName: leagueName,
      teams: Object.keys(teamSet),
      _startMin: block.startMin, _endMin: block.endMin
    };
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    getGradeBunks(divName).forEach(function (bunk) {
      if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
      window.scheduleAssignments[bunk][idx] = stampEntry({
        field: 'League Game', sport: window.leagueAssignments[divName][idx].sport || null,
        _activity: 'League Game', _league: true, _leagueName: leagueName,
        _gameLabel: gameLabel || 'League Game', matchups: mus
      }, block);
    });
    afterWrite();
  }

  function clearLeagueSlot(divName, idx) {
    if (window.leagueAssignments && window.leagueAssignments[divName]) {
      delete window.leagueAssignments[divName][idx];
    }
    getGradeBunks(divName).forEach(function (bunk) {
      var e = (window.scheduleAssignments[bunk] || [])[idx];
      if (e && e._league) window.scheduleAssignments[bunk][idx] = null;
    });
    afterWrite();
  }

  function afterWrite() {
    window._scheduleAssignmentsDate = currentDateKey();
    validateAll();
    renderGrid();
    scheduleSave();
  }

  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    setStatus('Saving…', '#b45309');
    _saveTimer = setTimeout(function () { save(); }, 1000);
  }

  async function save() {
    var dateKey = currentDateKey();
    try {
      if (!window.ScheduleDB || !window.ScheduleDB.saveSchedule) {
        setStatus('Save unavailable (cloud not loaded)', '#b91c1c'); return;
      }
      var data = {
        scheduleAssignments: window.scheduleAssignments || {},
        leagueAssignments: window.leagueAssignments || {},
        unifiedTimes: window.unifiedTimes || [],
        divisionTimes: window.divisionTimes || {},
        manualSkeleton: getDaySkeleton(dateKey),
        _belongsToDate: dateKey,
        _helperMode: true
      };
      // allowEmpty: a partially-filled Helper grid must be savable even when most
      //   cells are still blank (the wipe guard would otherwise block it).
      // skipFilter: Helper Mode is owner-driven manual entry — save all bunks the
      //   user filled, same as the post-edit bypass path.
      var res = await window.ScheduleDB.saveSchedule(dateKey, data, { skipFilter: true, allowEmpty: true, immediate: true });
      if (res && (res.success || res.target)) setStatus('Saved ✓', '#15803d');
      else setStatus('Save failed', '#b91c1c');
    } catch (e) {
      console.error('[Helper] save failed', e);
      setStatus('Save failed', '#b91c1c');
    }
  }

  function setStatus(text, color) {
    var el = document.getElementById('helper-save-status');
    if (el) { el.textContent = text; el.style.color = color || '#475569'; }
  }

  // ---------------------------------------------------------------------
  // Rendering — the Excel-style spreadsheet
  // ---------------------------------------------------------------------
  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    var css = document.createElement('style');
    css.id = 'helper-mode-styles';
    css.textContent = [
      '.helper-wrap{padding:12px 8px;font-family:inherit;}',
      '.helper-topbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 4px 14px;}',
      '.helper-title{font-weight:800;font-size:1.05rem;color:#0f172a;display:flex;align-items:center;gap:8px;}',
      '.helper-badge{background:#dbeafe;color:#1e40af;border-radius:999px;padding:2px 10px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}',
      '.helper-issues-pill{font-size:.8rem;font-weight:700;padding:4px 12px;border-radius:999px;}',
      '.helper-issues-ok{background:#dcfce7;color:#166534;}',
      '.helper-issues-bad{background:#fee2e2;color:#991b1b;}',
      '#helper-save-status{font-size:.8rem;font-weight:600;margin-left:auto;}',
      // legend
      '.helper-legend{display:flex;flex-wrap:wrap;gap:14px;margin:0 4px 16px;padding:9px 14px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;}',
      '.helper-lg{display:flex;align-items:center;gap:6px;font-size:.74rem;font-weight:700;color:#475569;}',
      '.helper-lg::before{content:"";width:12px;height:12px;border-radius:4px;display:inline-block;}',
      '.helper-lg.lg-sport::before{background:#22c55e;}',
      '.helper-lg.lg-special::before{background:#a855f7;}',
      '.helper-lg.lg-general::before{background:#f59e0b;}',
      '.helper-lg.lg-league::before{background:#6366f1;}',
      '.helper-lg.lg-note::before{background:#64748b;}',
      // view toggle + all-bunks timeline
      '.helper-viewtoggle{display:flex;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;}',
      '.helper-viewbtn{padding:6px 14px;border:none;background:#fff;font-size:.78rem;font-weight:700;color:#64748b;cursor:pointer;}',
      '.helper-viewbtn.on{background:#2563eb;color:#fff;}',
      '.helper-div-row{background:#e0e7ff;color:#3730a3;font-weight:800;font-size:.8rem;padding:7px 14px;text-transform:uppercase;letter-spacing:.03em;}',
      '.helper-div-row span{position:sticky;left:14px;}',
      '.helper-oos{background:repeating-linear-gradient(45deg,#fafbfc,#fafbfc 6px,#f1f5f9 6px,#f1f5f9 12px);cursor:default;}',
      '.helper-oos:hover{background:repeating-linear-gradient(45deg,#fafbfc,#fafbfc 6px,#f1f5f9 6px,#f1f5f9 12px);}',
      // division cards
      '.helper-div{margin:0 4px 22px;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.06);}',
      '.helper-div-head{background:linear-gradient(90deg,#eef2ff,#f8fafc);padding:12px 16px;border-bottom:1px solid #e2e8f0;display:flex;align-items:baseline;gap:10px;}',
      '.hdh-name{font-weight:800;font-size:1.02rem;color:#0f172a;}',
      '.hdh-meta{font-size:.74rem;color:#64748b;font-weight:600;}',
      '.helper-scroll{overflow:auto;max-height:72vh;}',
      '.helper-table{border-collapse:separate;border-spacing:0;width:100%;min-width:520px;}',
      '.helper-table th,.helper-table td{border-right:1px solid #eef2f6;border-bottom:1px solid #eef2f6;text-align:left;vertical-align:top;padding:0;}',
      '.helper-table thead th{background:#f8fafc;padding:8px 12px;white-space:nowrap;position:sticky;top:0;z-index:3;border-bottom:2px solid #e2e8f0;}',
      '.th-range{font-weight:800;font-size:.82rem;color:#1e293b;}',
      '.th-dur{font-size:.66rem;color:#94a3b8;font-weight:600;margin-top:1px;}',
      '.helper-table thead th.helper-corner{position:sticky;left:0;top:0;z-index:6;background:#eef2ff;font-weight:800;color:#334155;font-size:.74rem;text-transform:uppercase;letter-spacing:.03em;}',
      '.helper-bunk-cell{position:sticky;left:0;z-index:2;background:#f8fafc;font-weight:800;font-size:.9rem;color:#1e293b;padding:10px 14px;white-space:nowrap;border-right:2px solid #e2e8f0;}',
      '.helper-cell{min-width:152px;height:58px;position:relative;cursor:pointer;transition:background .12s;}',
      '.helper-cell:hover{background:#f0f7ff;}',
      '.helper-cell-inner{padding:6px;min-height:46px;}',
      // filled-cell cards, color-coded by type
      '.hc-card{border-radius:9px;padding:7px 9px;border-left:4px solid #94a3b8;background:#f8fafc;min-height:34px;box-sizing:border-box;}',
      '.hc-act{font-weight:700;font-size:.86rem;color:#0f172a;line-height:1.2;}',
      '.hc-sub{font-size:.7rem;color:#64748b;margin-top:2px;font-weight:600;}',
      '.hc-auto{color:#0d9488;font-weight:700;}',
      '.hc-sport{background:#f0fdf4;border-left-color:#22c55e;}',
      '.hc-sport .hc-act{color:#166534;}',
      '.hc-special{background:#faf5ff;border-left-color:#a855f7;}',
      '.hc-special .hc-act{color:#6b21a8;}',
      '.hc-general{background:#fffbeb;border-left-color:#f59e0b;}',
      '.hc-general .hc-act{color:#92400e;}',
      '.hc-note{background:#f8fafc;border-left-color:#64748b;}',
      '.hc-league{background:#eef2ff;border-left-color:#6366f1;}',
      '.hc-empty{display:flex;align-items:center;justify-content:center;min-height:44px;color:#cbd5e1;font-size:1.4rem;font-weight:300;}',
      '.helper-cell:hover .hc-empty{color:#60a5fa;}',
      '.helper-cell.helper-err{box-shadow:inset 0 0 0 2px #ef4444;}',
      '.helper-cell.helper-warn{box-shadow:inset 0 0 0 2px #f59e0b;}',
      '.helper-flag{position:absolute;top:3px;right:5px;font-size:.72rem;}',
      '.helper-auto-field{font-size:.62rem;color:#0d9488;font-weight:600;}',
      '.helper-empty-note{padding:40px;text-align:center;color:#64748b;line-height:1.6;}',
      // modal
      '.helper-modal-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.helper-modal{background:#fff;border-radius:14px;max-width:460px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);}',
      '.helper-modal.helper-modal-wide{max-width:1060px;}',
      '.helper-modal-cols{display:flex;gap:20px;padding:18px 22px;flex-wrap:wrap;align-items:flex-start;}',
      '.helper-modal-cols .helper-modal-body{padding:0;}',
      '.helper-modal-left{flex:1 1 380px;min-width:340px;}',
      '.helper-modal-right{flex:1 1 360px;min-width:300px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;max-height:60vh;overflow:auto;}',
      '.helper-field-hint{font-size:.72rem;color:#94a3b8;margin-top:4px;}',
      '.helper-report-title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#475569;padding:10px 14px 4px;}',
      '.helper-modal-head{padding:16px 20px;border-bottom:1px solid #e2e8f0;font-weight:700;color:#0f172a;}',
      '.helper-modal-sub{font-size:.8rem;color:#64748b;font-weight:500;margin-top:2px;}',
      '.helper-modal-body{padding:16px 20px;}',
      '.helper-seg{display:flex;gap:6px;margin-bottom:16px;}',
      '.helper-seg button{flex:1;padding:9px 6px;border:1px solid #cbd5e1;background:#f8fafc;border-radius:8px;font-weight:600;font-size:.82rem;color:#475569;cursor:pointer;}',
      '.helper-seg button.active{background:#2563eb;border-color:#2563eb;color:#fff;}',
      '.helper-field{margin-bottom:12px;}',
      '.helper-field label{display:block;font-size:.75rem;font-weight:600;color:#475569;margin-bottom:4px;}',
      '.helper-field select,.helper-field input,.helper-field textarea{width:100%;padding:11px 13px;border:1px solid #cbd5e1;border-radius:8px;font-size:.95rem;font-family:inherit;box-sizing:border-box;}',
      '.helper-field textarea{min-height:130px;resize:vertical;}',
      '.helper-modal-foot{display:flex;gap:8px;padding:14px 20px;border-top:1px solid #e2e8f0;}',
      '.helper-btn{padding:9px 16px;border-radius:8px;font-weight:600;font-size:.84rem;cursor:pointer;border:1px solid transparent;}',
      '.helper-btn-save{background:#2563eb;color:#fff;}',
      '.helper-btn-cancel{background:#f1f5f9;color:#475569;border-color:#cbd5e1;}',
      '.helper-btn-clear{background:#fff;color:#b91c1c;border-color:#fecaca;margin-right:auto;}',
      // multi-bunk scope (tap-to-toggle chips)
      '.helper-scope-count{font-size:.72rem;color:#94a3b8;font-weight:600;}',
      '.helper-scope-quick{display:flex;gap:8px;margin:2px 0 8px;}',
      '.helper-scope-qbtn{padding:6px 12px;border:1px solid #cbd5e1;background:#f8fafc;border-radius:8px;font-size:.8rem;font-weight:600;color:#475569;cursor:pointer;}',
      '.helper-scope-qbtn:hover{background:#eef2ff;border-color:#c7d2fe;}',
      '.helper-scope-chips{display:flex;flex-wrap:wrap;gap:6px;}',
      '.helper-chip{padding:6px 13px;border:1px solid #cbd5e1;background:#fff;border-radius:999px;font-size:.82rem;font-weight:600;color:#475569;cursor:pointer;transition:all .12s;}',
      '.helper-chip:hover{border-color:#93c5fd;}',
      '.helper-chip.on{background:#2563eb;border-color:#2563eb;color:#fff;}',
      // league banner in the grid
      '.helper-league-cell{background:#eef2ff;vertical-align:top;cursor:pointer;}',
      '.helper-league-cell:hover{background:#e0e7ff;}',
      '.helper-league-head{font-size:.7rem;font-weight:800;color:#3730a3;text-transform:uppercase;letter-spacing:.03em;padding:6px 10px 2px;}',
      '.helper-mu-list{padding:2px 10px 8px;display:flex;flex-direction:column;gap:3px;}',
      '.helper-mu{font-size:.82rem;color:#1e1b4b;font-weight:600;}',
      '.helper-mu-meta{font-size:.68rem;color:#6366f1;font-weight:500;}',
      // league editor
      '.helper-league-body{padding:16px 22px;max-height:64vh;overflow:auto;}',
      '.helper-lg-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;}',
      '.helper-lg-toolbar select{padding:7px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:.84rem;}',
      '.helper-lg-allsport{font-size:.78rem;color:#475569;font-weight:600;display:flex;align-items:center;gap:6px;}',
      '.helper-mu-head{display:grid;grid-template-columns:1fr 24px 1fr 1fr 1.2fr 28px;gap:8px;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:#94a3b8;padding:0 2px 6px;}',
      '.helper-mu-row{display:grid;grid-template-columns:1fr 24px 1fr 1fr 1.2fr 28px;gap:8px;align-items:center;margin-bottom:8px;}',
      '.helper-mu-row select{padding:8px 9px;border:1px solid #cbd5e1;border-radius:8px;font-size:.86rem;width:100%;box-sizing:border-box;}',
      '.helper-mu-row .mu-vs{text-align:center;font-weight:700;color:#64748b;font-size:.8rem;}',
      '.helper-mu-row .mu-del{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:7px;height:34px;cursor:pointer;font-size:1rem;line-height:1;}'
    ].join('');
    document.head.appendChild(css);
  }

  function labelForEntry(entry) {
    if (!entry) return '';
    if (window.SchedulerCoreUtils && window.SchedulerCoreUtils.formatEntry) {
      try { var f = window.SchedulerCoreUtils.formatEntry(entry); if (f) return f; } catch (e) {}
    }
    return entry._displayName || entry._activity || entry.field || '';
  }

  function cellTypeClass(entry) {
    if (entry._h2h || entry._league) return 'hc-league';
    if (entry._general) return 'hc-general';
    if (entry._special) return 'hc-special';
    if (entry._customText) return 'hc-note';
    if (entry.sport) return 'hc-sport';
    return 'hc-note';
  }

  // A filled cell renders as a color-coded card: activity name on top, field
  // (with a pin) underneath — easy for a head counselor to scan down a column.
  function cellCardHtml(entry) {
    var act = entry._displayName || entry._activity || entry.sport || labelForEntry(entry);
    var loc = entryLocation(entry);
    var sub = '';
    if (loc) sub = '<div class="hc-sub">📍 ' + esc(loc) + (entry._autoField ? ' <span class="hc-auto">· auto</span>' : '') + '</div>';
    else if (entry._customText) sub = '';
    return '<div class="hc-card ' + cellTypeClass(entry) + '"><div class="hc-act">' + esc(act) + '</div>' + sub + '</div>';
  }

  // A single bunk×slot <td> (shared by both views). League cells render as a
  // compact card that reopens the whole-grade builder.
  function bunkCellTd(bunk, dn, slotIdx) {
    var arr = (window.scheduleAssignments && window.scheduleAssignments[bunk]) || [];
    var entry = arr[slotIdx];
    var iss = issueFor(bunk, slotIdx);
    var cls = 'helper-cell';
    if (iss) cls += iss.level === 'error' ? ' helper-err' : ' helper-warn';
    var inner, isLeague = false;
    if (entry && entry._league) {
      isLeague = true;
      inner = '<div class="hc-card hc-league"><div class="hc-act">🏆 ' + esc(entry._leagueName || 'League') + '</div>' +
        (entry._gameLabel ? '<div class="hc-sub">' + esc(entry._gameLabel) + '</div>' : '') + '</div>';
    } else if (entry && entry._activity !== 'Free' && (entry._activity || entry._displayName || entry.sport)) {
      inner = cellCardHtml(entry);
    } else {
      inner = '<div class="hc-empty">+</div>';
    }
    var flag = iss ? '<span class="helper-flag">' + (iss.level === 'error' ? '🔴' : '⚠️') + '</span>' : '';
    return '<td class="' + cls + '" data-bunk="' + esc(bunk) + '" data-div="' + esc(dn) + '" data-idx="' + slotIdx + '"' +
      (isLeague ? ' data-league="1"' : '') + (iss ? ' title="' + esc(iss.msg) + '"' : '') + '>' +
      flag + '<div class="helper-cell-inner">' + inner + '</div></td>';
  }

  function wireCells(container) {
    container.querySelectorAll('.helper-cell').forEach(function (td) {
      td.addEventListener('click', function () {
        var dn = td.getAttribute('data-div');
        var idx = parseInt(td.getAttribute('data-idx'), 10);
        var block = (window.divisionTimes[dn] || [])[idx];
        if (!block) return;
        if (td.getAttribute('data-league') === '1') { openLeagueEditor(dn, idx, block); return; }
        openCellEditor(td.getAttribute('data-bunk'), dn, idx, block);
      });
    });
  }

  function wireToggle(container) {
    container.querySelectorAll('.helper-viewbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-view');
        if (v && v !== _viewMode) { _viewMode = v; renderGrid(container); }
      });
    });
  }

  function viewToggleHtml() {
    return '<div class="helper-viewtoggle">' +
      '<button class="helper-viewbtn' + (_viewMode === 'grade' ? ' on' : '') + '" data-view="grade">By Grade</button>' +
      '<button class="helper-viewbtn' + (_viewMode === 'all' ? ' on' : '') + '" data-view="all">All Bunks</button>' +
      '</div>';
  }

  // Shared-timeline view: every bunk (grouped by grade) on ONE unified time axis
  // so you can scan a column and see what the whole camp is doing at that time.
  function renderAllBunks(container, html) {
    var divs = getDivisions();
    var order = divisionOrder();
    var divTimes = window.divisionTimes || {};
    var uni = window.unifiedTimes || [];
    if (!uni.length) {
      container.innerHTML = html + '<div class="helper-empty-note">No periods yet.</div></div>';
      wireToggle(container);
      return;
    }
    // Map each unified column to the division slot that overlaps it most (or -1).
    function colMap(dn) {
      var slots = divTimes[dn] || [];
      return uni.map(function (u) {
        var best = -1, bo = 0;
        slots.forEach(function (s, i) {
          var ov = Math.min(s.endMin, u.endMin) - Math.max(s.startMin, u.startMin);
          if (ov > bo) { bo = ov; best = i; }
        });
        return best;
      });
    }
    html += '<div class="helper-div"><div class="helper-scroll"><table class="helper-table"><thead><tr>' +
      '<th class="helper-corner">Bunk</th>';
    uni.forEach(function (u) {
      var dur = u.endMin - u.startMin;
      html += '<th class="helper-time-h"><div class="th-range">' + esc(minutesToLabel(u.startMin) + '–' + minutesToLabel(u.endMin)) + '</div>' +
        (dur ? '<div class="th-dur">' + dur + ' min</div>' : '') + '</th>';
    });
    html += '</tr></thead><tbody>';
    order.forEach(function (dn) {
      var bunks = (divs[dn] && divs[dn].bunks) || [];
      if (!bunks.length || !(divTimes[dn] || []).length) return;
      html += '<tr><td class="helper-div-row" colspan="' + (uni.length + 1) + '"><span>' + esc(dn) + '</span></td></tr>';
      var cm = colMap(dn);
      bunks.forEach(function (bunk) {
        html += '<tr><td class="helper-bunk-cell">' + esc(bunk) + '</td>';
        uni.forEach(function (u, ci) {
          var si = cm[ci];
          if (si < 0) { html += '<td class="helper-cell helper-oos"><div class="helper-cell-inner"></div></td>'; return; }
          html += bunkCellTd(bunk, dn, si);
        });
        html += '</tr>';
      });
    });
    html += '</tbody></table></div></div></div>';
    container.innerHTML = html;
    wireCells(container);
    wireToggle(container);
  }

  function renderGrid(container) {
    if (!isActive()) return;
    container = container || document.getElementById('scheduleTable');
    if (!container) return;
    injectStyles();

    var dateKey = currentDateKey();
    buildStructure(dateKey);
    validateAll();

    var divs = getDivisions();
    var order = divisionOrder();
    var divTimes = window.divisionTimes || {};

    var hasAny = order.some(function (dn) { return (divTimes[dn] || []).length && (divs[dn].bunks || []).length; });

    var html = '<div class="helper-wrap">';
    html += '<div class="helper-topbar">';
    html += '<div class="helper-title"><span class="helper-badge">Helper</span> Fill-in Spreadsheet</div>';
    html += viewToggleHtml();
    var ic = issueCount();
    html += ic > 0
      ? '<span class="helper-issues-pill helper-issues-bad">⚠ ' + ic + ' issue' + (ic === 1 ? '' : 's') + '</span>'
      : '<span class="helper-issues-pill helper-issues-ok">✓ No conflicts</span>';
    html += '<span id="helper-save-status">All changes saved</span>';
    html += '</div>';

    if (!hasAny) {
      html += '<div class="helper-empty-note">No activity blocks yet.<br>' +
        'Go to the <strong>schedule builder</strong>, drag <strong>Activity Block</strong> tiles onto each grade to mark the activity windows, then press <strong>Generate</strong>.</div>';
      html += '</div>';
      container.innerHTML = html;
      wireToggle(container);
      return;
    }

    // Color legend so counselors learn the code at a glance.
    html += '<div class="helper-legend">' +
      '<span class="helper-lg lg-sport">Sport</span>' +
      '<span class="helper-lg lg-special">Special</span>' +
      '<span class="helper-lg lg-general">General</span>' +
      '<span class="helper-lg lg-league">League</span>' +
      '<span class="helper-lg lg-note">Note</span>' +
      '</div>';

    // Shared-timeline view (all bunks on one axis).
    if (_viewMode === 'all') { renderAllBunks(container, html); return; }

    order.forEach(function (dn) {
      var slots = divTimes[dn] || [];
      var bunks = (divs[dn] && divs[dn].bunks) || [];
      if (!slots.length || !bunks.length) return;

      html += '<div class="helper-div">';
      html += '<div class="helper-div-head"><span class="hdh-name">' + esc(dn) + '</span>' +
        '<span class="hdh-meta">' + bunks.length + ' bunk' + (bunks.length === 1 ? '' : 's') +
        ' · ' + slots.length + ' period' + (slots.length === 1 ? '' : 's') + '</span></div>';
      html += '<div class="helper-scroll"><table class="helper-table"><thead><tr><th class="helper-corner">Bunk</th>';
      slots.forEach(function (s) {
        var dur = (s.endMin != null && s.startMin != null) ? (s.endMin - s.startMin) : 0;
        html += '<th class="helper-time-h"><div class="th-range">' + esc(minutesToLabel(s.startMin) + '–' + minutesToLabel(s.endMin)) + '</div>' +
          (dur ? '<div class="th-dur">' + dur + ' min</div>' : '') + '</th>';
      });
      html += '</tr></thead><tbody>';

      // Detect league columns — a league fills the WHOLE grade at that time, so
      // it renders as one banner spanning every bunk row (not per-bunk cells).
      var leagueCols = {};
      slots.forEach(function (s, c) {
        var la = window.leagueAssignments && window.leagueAssignments[dn] && window.leagueAssignments[dn][c];
        if (la && la.matchups && la.matchups.length) { leagueCols[c] = la; return; }
        var mk = null;
        bunks.some(function (b) { var e = (window.scheduleAssignments[b] || [])[c]; if (e && e._league === true) { mk = e; return true; } return false; });
        if (mk) leagueCols[c] = { matchups: mk.matchups || [], gameLabel: mk._gameLabel || 'League', leagueName: mk._leagueName };
      });

      bunks.forEach(function (bunk, rowIdx) {
        html += '<tr><td class="helper-bunk-cell">' + esc(bunk) + '</td>';
        var arr = (window.scheduleAssignments && window.scheduleAssignments[bunk]) || [];
        slots.forEach(function (s, idx) {
          if (leagueCols[idx]) {
            // Only the first bunk row emits the spanning banner; others skip.
            if (rowIdx === 0) {
              html += '<td class="helper-cell helper-league-cell" rowspan="' + bunks.length +
                '" data-league="1" data-div="' + esc(dn) + '" data-idx="' + idx + '">' +
                leagueBannerHtml(leagueCols[idx]) + '</td>';
            }
            return;
          }
          var entry = arr[idx];
          var iss = issueFor(bunk, idx);
          var cls = 'helper-cell';
          if (iss) cls += iss.level === 'error' ? ' helper-err' : ' helper-warn';
          var inner;
          if (entry && entry._activity !== 'Free' && (entry._activity || entry._displayName || entry.sport)) {
            inner = cellCardHtml(entry);
          } else {
            inner = '<div class="hc-empty">+</div>';
          }
          var flag = iss ? '<span class="helper-flag">' + (iss.level === 'error' ? '🔴' : '⚠️') + '</span>' : '';
          html += '<td class="' + cls + '" data-bunk="' + esc(bunk) + '" data-div="' + esc(dn) +
            '" data-idx="' + idx + '"' + (iss ? ' title="' + esc(iss.msg) + '"' : '') + '>' +
            flag + '<div class="helper-cell-inner">' + inner + '</div></td>';
        });
        html += '</tr>';
      });

      html += '</tbody></table></div></div>';
    });

    html += '</div>';
    container.innerHTML = html;
    wireCells(container);
    wireToggle(container);
  }

  function leagueBannerHtml(la) {
    var head = '<div class="helper-league-head">🏆 ' + esc(la.leagueName || 'League') +
      (la.gameLabel ? ' · ' + esc(la.gameLabel) : '') + '</div>';
    var rows = (la.matchups || []).map(function (m) {
      var teams = (m.teamA || m.team1 || '?') + ' vs ' + (m.teamB || m.team2 || '?');
      var meta = [];
      if (m.sport) meta.push(esc(m.sport));
      if (m.field) meta.push(esc(m.field));
      return '<div class="helper-mu">' + esc(teams) +
        (meta.length ? ' <span class="helper-mu-meta">' + meta.join(' · ') + '</span>' : '') + '</div>';
    }).join('') || '<div class="helper-mu helper-cell-empty">Tap to set up matchups</div>';
    return head + '<div class="helper-mu-list">' + rows + '</div>';
  }

  // ---------------------------------------------------------------------
  // Cell editor modal — 3 input modes
  // ---------------------------------------------------------------------
  function openCellEditor(bunk, divName, idx, block) {
    injectStyles();
    var existing = (window.scheduleAssignments[bunk] || [])[idx] || null;

    var ov = document.createElement('div');
    ov.className = 'helper-modal-ov';
    ov.innerHTML =
      '<div class="helper-modal helper-modal-wide">' +
        '<div class="helper-modal-head">' + esc(bunk) +
          '<div class="helper-modal-sub">' + esc(divName) + ' · ' +
            esc(minutesToLabel(block.startMin) + '–' + minutesToLabel(block.endMin)) + '</div>' +
        '</div>' +
        '<div class="helper-modal-cols">' +
          '<div class="helper-modal-left">' +
            '<div class="helper-seg">' +
              '<button data-mode="text">Free Text</button>' +
              '<button data-mode="activity">Activity</button>' +
              '<button data-mode="league">League</button>' +
            '</div>' +
            '<div class="helper-field helper-scope-wrap" id="hm-scope-wrap">' +
              '<label>Apply to <span class="helper-scope-count" id="hm-scope-count"></span></label>' +
              '<div class="helper-scope-quick">' +
                '<button type="button" class="helper-scope-qbtn" id="hm-scope-one">This bunk</button>' +
                '<button type="button" class="helper-scope-qbtn" id="hm-scope-all">Whole grade</button>' +
              '</div>' +
              '<div class="helper-scope-chips" id="hm-scope-chips"></div>' +
            '</div>' +
            '<div class="helper-modal-body" id="helper-modal-body"></div>' +
          '</div>' +
          '<div class="helper-modal-right">' +
            '<div class="helper-report-title">This bunk — history, usage &amp; what\'s open now</div>' +
            '<div id="helper-report-mount"></div>' +
          '</div>' +
        '</div>' +
        '<div class="helper-modal-foot">' +
          '<button class="helper-btn helper-btn-clear" id="helper-clear">Clear</button>' +
          '<button class="helper-btn helper-btn-cancel" id="helper-cancel">Cancel</button>' +
          '<button class="helper-btn helper-btn-save" id="helper-save">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var body = ov.querySelector('#helper-modal-body');
    var segBtns = ov.querySelectorAll('.helper-seg > button');
    var state = { mode: 'activity' };

    // Legacy single-matchup / league entry → jump straight to the grade builder.
    if (existing && (existing._h2h || existing._league)) {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      openLeagueEditor(divName, idx, block);
      return;
    }
    // Seed initial mode from the existing entry.
    if (existing) {
      if (existing._customText) state.mode = 'text';
      else state.mode = 'activity';
    }

    // --- Multi-bunk scope (non-league modes) ---------------------------
    // Tap bunk chips to toggle; one-tap "This bunk" / "Whole grade" shortcuts.
    var gradeBunks = getGradeBunks(divName);
    var selectedBunks = {}; selectedBunks[bunk] = true;
    var scopeChips = ov.querySelector('#hm-scope-chips');
    function selectedCount() { return gradeBunks.filter(function (b) { return selectedBunks[b]; }).length; }
    function updateScopeCount() {
      var n = selectedCount();
      var el = ov.querySelector('#hm-scope-count');
      if (el) el.textContent = '· ' + n + ' bunk' + (n === 1 ? '' : 's');
    }
    function renderChips() {
      if (!scopeChips) return;
      scopeChips.innerHTML = gradeBunks.map(function (b) {
        return '<button type="button" class="helper-chip' + (selectedBunks[b] ? ' on' : '') + '" data-bunk="' + esc(b) + '">' + esc(b) + '</button>';
      }).join('');
      scopeChips.querySelectorAll('.helper-chip').forEach(function (ch) {
        ch.addEventListener('click', function () {
          var b = ch.getAttribute('data-bunk');
          selectedBunks[b] = !selectedBunks[b];
          if (selectedCount() === 0) selectedBunks[b] = true; // never allow zero
          renderChips();
        });
      });
      updateScopeCount();
    }
    var oneBtn = ov.querySelector('#hm-scope-one');
    if (oneBtn) oneBtn.addEventListener('click', function () { selectedBunks = {}; selectedBunks[bunk] = true; renderChips(); });
    var allBtn = ov.querySelector('#hm-scope-all');
    if (allBtn) allBtn.addEventListener('click', function () { selectedBunks = {}; gradeBunks.forEach(function (b) { selectedBunks[b] = true; }); renderChips(); });
    function scopeTargets() {
      var t = gradeBunks.filter(function (b) { return selectedBunks[b]; });
      return t.length ? t : [bunk];
    }
    function updateScopeVisibility() {
      var w = ov.querySelector('#hm-scope-wrap');
      if (w) w.style.display = (state.mode === 'league') ? 'none' : 'block';
    }
    renderChips();

    // --- Contextual report (reuses the manual post-edit panel) ---------
    // The activity picker carries id="post-edit-activity" so the panel's own
    // clickable suggestions + async cloud-count hydrate target it for free.
    function reportSelected() {
      if (state.mode === 'league') { var sp = body.querySelector('#hm-lsport'); return sp ? sp.value : ''; }
      if (state.mode === 'activity') { var a = body.querySelector('#post-edit-activity'); return a ? a.value : ''; }
      return '';
    }
    function mountReport() {
      var mount = ov.querySelector('#helper-report-mount');
      if (!mount) return;
      if (window.PostEditReport && typeof window.PostEditReport.panelHtml === 'function') {
        try { mount.innerHTML = window.PostEditReport.panelHtml(bunk, divName, block.startMin, block.endMin, reportSelected(), null); return; }
        catch (e) { console.error('[Helper] report panel failed', e); }
      }
      mount.innerHTML = '<div style="padding:14px;color:#94a3b8;font-size:.82rem;">History &amp; availability are unavailable right now.</div>';
    }
    function refreshReport() {
      var el = ov.querySelector('#post-edit-report-body');
      if (!el) { mountReport(); return; }
      if (window.PostEditReport && typeof window.PostEditReport.bodyHtml === 'function') {
        try { el.innerHTML = window.PostEditReport.bodyHtml(bunk, divName, block.startMin, block.endMin, reportSelected(), null); }
        catch (e) { /* keep last */ }
      }
    }

    function fieldOptions(selected) {
      var opts = '<option value="">— No field —</option>';
      getFieldNames().forEach(function (f) {
        opts += '<option value="' + esc(f) + '"' + (normField(f) === normField(selected) ? ' selected' : '') + '>' + esc(f) + '</option>';
      });
      return opts;
    }

    function renderBody() {
      segBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-mode') === state.mode); });

      if (state.mode === 'text') {
        var txt = existing && existing._customText ? (existing._displayName || existing._activity || '') : '';
        body.innerHTML =
          '<div class="helper-field"><label>Text</label>' +
          '<textarea id="hm-text" placeholder="Type anything (e.g. Trip to lake, Rest hour)…">' + esc(txt) + '</textarea></div>';
      } else if (state.mode === 'activity') {
        var isGeneral = existing && existing._general;
        var isSpecial = existing && existing._special && !isGeneral;
        var curAct = existing ? (existing._activity || existing.sport || '') : '';
        var curField = existing ? entryLocation(existing) : '';
        body.innerHTML =
          '<div class="helper-seg" id="hm-actkind">' +
            '<button data-kind="sport" class="' + (!isSpecial && !isGeneral ? 'active' : '') + '">Sport</button>' +
            '<button data-kind="special" class="' + (isSpecial ? 'active' : '') + '">Special</button>' +
            '<button data-kind="general" class="' + (isGeneral ? 'active' : '') + '">General</button>' +
          '</div>' +
          '<div class="helper-field"><label id="hm-act-label">Activity</label>' +
          '<select id="post-edit-activity"></select></div>' +
          '<div class="helper-field"><label>Field / Location</label>' +
          '<select id="hm-field">' + fieldOptions(curField) + '</select>' +
          '<div class="helper-field-hint">Leave empty and the program will assign an open field for you.</div></div>';

        var kind = isGeneral ? 'general' : (isSpecial ? 'special' : 'sport');
        function fillActs() {
          var sel = body.querySelector('#post-edit-activity');
          body.querySelector('#hm-act-label').textContent =
            kind === 'special' ? 'Special activity' : kind === 'general' ? 'General activity' : 'Sport';
          var opts = '<option value="">— Choose —</option>';
          if (kind === 'general') {
            var gas = getGeneralActivities();
            if (!gas.length) opts += '<option value="" disabled>(no general activities configured)</option>';
            gas.forEach(function (g) {
              opts += '<option value="' + esc(g.name) + '"' + (g.name === curAct ? ' selected' : '') + '>' +
                esc(g.name) + (g.facility ? ' — ' + esc(g.facility) : '') + '</option>';
            });
          } else {
            var list = kind === 'special' ? getSpecials() : getSports();
            list.forEach(function (a) {
              opts += '<option value="' + esc(a) + '"' + (a === curAct ? ' selected' : '') + '>' + esc(a) + '</option>';
            });
          }
          sel.innerHTML = opts;
        }
        // A general activity is pre-bound to a facility — default the field to it.
        function applyGeneralFacility(val) {
          if (kind !== 'general' || !val) return;
          var ga = getGeneralActivities().find(function (g) { return g.name === val; });
          var fsel = body.querySelector('#hm-field');
          if (ga && ga.facility && fsel) {
            if (!Array.prototype.some.call(fsel.options, function (o) { return normField(o.value) === normField(ga.facility); })) {
              var o = document.createElement('option'); o.value = ga.facility; o.textContent = ga.facility; fsel.appendChild(o);
            }
            fsel.value = ga.facility;
          }
        }
        fillActs();
        var actSel = body.querySelector('#post-edit-activity');
        function syncKindUI() {
          body.querySelectorAll('#hm-actkind button').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-kind') === kind); });
        }
        // A suggestion click (or manual pick) may land a special while the Sport
        // tab is active (or vice-versa) — auto-switch the tab to match so the
        // value stays visible, then refresh the report.
        actSel.addEventListener('change', function () {
          var val = actSel.value;
          curAct = val;
          if (val && kind !== 'general') {
            var isSp = getSpecials().some(function (s) { return s === val; });
            var isSpo = getSports().some(function (s) { return s === val; });
            if (isSp && kind !== 'special') { kind = 'special'; syncKindUI(); fillActs(); actSel = body.querySelector('#post-edit-activity'); }
            else if (isSpo && !isSp && kind !== 'sport') { kind = 'sport'; syncKindUI(); fillActs(); actSel = body.querySelector('#post-edit-activity'); }
          }
          applyGeneralFacility(val);
          refreshReport();
        });
        applyGeneralFacility(curAct);
        body.querySelectorAll('#hm-actkind button').forEach(function (b) {
          b.addEventListener('click', function () {
            kind = b.getAttribute('data-kind');
            syncKindUI();
            curAct = '';
            fillActs();
            refreshReport();
          });
        });
        state._getKind = function () { return kind; };
      } else if (state.mode === 'league') {
        // Leagues fill the whole grade — hand off to the dedicated builder.
        body.innerHTML = '<div class="helper-empty-note" style="padding:18px;">League games fill the ' +
          '<strong>whole grade</strong> at this time. Set up every matchup at once.' +
          '<div style="margin-top:14px;"><button class="helper-btn helper-btn-save" id="hm-open-league">Set up matchups →</button></div></div>';
        var ob = body.querySelector('#hm-open-league');
        if (ob) ob.addEventListener('click', function () { if (ov.parentNode) ov.parentNode.removeChild(ov); openLeagueEditor(divName, idx, block); });
      }
    }

    segBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var m = b.getAttribute('data-mode');
        if (m === 'league') { if (ov.parentNode) ov.parentNode.removeChild(ov); openLeagueEditor(divName, idx, block); return; }
        state.mode = m; renderBody(); updateScopeVisibility(); refreshReport();
      });
    });
    renderBody();
    updateScopeVisibility();
    mountReport();

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#helper-cancel').addEventListener('click', close);
    ov.querySelector('#helper-clear').addEventListener('click', function () {
      // Clear applies to the same scope the user picked.
      var tgts = scopeTargets();
      tgts.forEach(function (tb) { if (window.scheduleAssignments[tb]) window.scheduleAssignments[tb][idx] = null; });
      afterWrite();
      close();
    });

    ov.querySelector('#helper-save').addEventListener('click', function () {
      var targets = scopeTargets();
      if (state.mode === 'text') {
        var t = ((body.querySelector('#hm-text') || {}).value || '').trim();
        if (!t) { ov.querySelector('#helper-clear').click(); return; }
        writeCellsMulti(targets, idx, block, function () {
          return { _activity: t, _displayName: t, _customText: true, sport: null, field: t, _location: null };
        }, {});
        close(); return;
      }
      if (state.mode === 'activity') {
        var act = (body.querySelector('#post-edit-activity') || {}).value || '';
        if (!act) { close(); return; }
        var explicit = (body.querySelector('#hm-field') || {}).value || '';
        var kind = state._getKind ? state._getKind() : 'sport';
        if (kind === 'sport' && getSpecials().some(function (s) { return s === act; })) kind = 'special';
        if (kind === 'general' && !explicit) {
          var _ga = getGeneralActivities().find(function (g) { return g.name === act; });
          if (_ga && _ga.facility) explicit = _ga.facility;
        }
        var isSport = kind === 'sport', isSpecial = kind === 'special', isGeneral = kind === 'general';
        writeCellsMulti(targets, idx, block, function (field, wasAuto) {
          return {
            _activity: act,
            sport: isSport ? act : null,
            _special: isSpecial,
            _general: isGeneral,
            field: field ? (field + ' – ' + act) : act,
            _location: field || null,
            _autoField: !!wasAuto
          };
        }, { explicitField: explicit || null, autoField: !explicit, activity: act, divName: divName });
        close(); return;
      }
      close();
    });
  }

  function fieldSelectHtml(selected) {
    var opts = '<option value="">— Auto —</option>';
    getFieldNames().forEach(function (f) {
      opts += '<option value="' + esc(f) + '"' + (normField(f) === normField(selected) ? ' selected' : '') + '>' + esc(f) + '</option>';
    });
    return opts;
  }

  // ---------------------------------------------------------------------
  // League matchup builder — sets up ALL matchups for a grade at once
  // (10 teams → 5 matchups) and fills the whole grade's league period.
  // ---------------------------------------------------------------------
  function openLeagueEditor(divName, idx, block) {
    injectStyles();
    var leagues = getLeaguesForDivision(divName);
    if (!leagues.length) {
      alert('No league is assigned to ' + divName + '. Add this grade to a league in the Leagues page first.');
      return;
    }
    var existingLA = (window.leagueAssignments && window.leagueAssignments[divName] && window.leagueAssignments[divName][idx]) || null;
    var st = { leagueName: (existingLA && existingLA.leagueName) || leagues[0].name, round: 0, matchups: [] };

    function curLeague() { return leagues.find(function (l) { return l.name === st.leagueName; }) || leagues[0]; }
    function leagueTeams() { return (curLeague().teams || []).slice(); }
    function leagueSports() { var l = curLeague(); return (l.sports && l.sports.length) ? l.sports : getSports(); }
    function defaultSport() { var s = leagueSports(); return s[0] || ''; }
    function roundsForLeague() { return roundRobinRounds(leagueTeams()); }

    function autoPair() {
      var rounds = roundsForLeague();
      var rd = rounds.length ? rounds[st.round % rounds.length] : [];
      var ds = defaultSport();
      st.matchups = rd.map(function (p) { return { teamA: p[0], teamB: p[1], sport: ds, field: '' }; });
    }

    if (existingLA && existingLA.matchups && existingLA.matchups.length) {
      st.matchups = existingLA.matchups.map(function (m) {
        return { teamA: m.teamA || m.team1 || '', teamB: m.teamB || m.team2 || '', sport: m.sport || defaultSport(), field: m.field || '' };
      });
    } else {
      autoPair();
    }

    var ov = document.createElement('div');
    ov.className = 'helper-modal-ov';
    ov.innerHTML =
      '<div class="helper-modal helper-modal-wide">' +
        '<div class="helper-modal-head">🏆 League Games' +
          '<div class="helper-modal-sub">' + esc(divName) + ' · ' +
            esc(minutesToLabel(block.startMin) + '–' + minutesToLabel(block.endMin)) +
            ' · fills the whole grade</div>' +
        '</div>' +
        '<div class="helper-league-body" id="hm-league-body"></div>' +
        '<div class="helper-modal-foot">' +
          '<button class="helper-btn helper-btn-clear" id="hm-league-clear">Remove league</button>' +
          '<button class="helper-btn helper-btn-cancel" id="hm-league-cancel">Cancel</button>' +
          '<button class="helper-btn helper-btn-save" id="hm-league-save">Save all matchups</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    var lbody = ov.querySelector('#hm-league-body');

    function syncFromDom() {
      var rows = lbody.querySelectorAll('.helper-mu-row');
      st.matchups = Array.prototype.map.call(rows, function (r) {
        return {
          teamA: r.querySelector('.mu-a').value,
          teamB: r.querySelector('.mu-b').value,
          sport: r.querySelector('.mu-sport').value,
          field: r.querySelector('.mu-field').value
        };
      });
    }

    function teamOpts(sel) {
      return '<option value="">—</option>' + leagueTeams().map(function (t) {
        return '<option value="' + esc(t) + '"' + (t === sel ? ' selected' : '') + '>' + esc(t) + '</option>';
      }).join('');
    }
    function sportOpts(sel) {
      return leagueSports().map(function (s) {
        return '<option value="' + esc(s) + '"' + (s === sel ? ' selected' : '') + '>' + esc(s) + '</option>';
      }).join('') || '<option value="">(none)</option>';
    }

    function render() {
      var rounds = roundsForLeague();
      var leagueSel = leagues.length > 1
        ? '<div class="helper-field"><label>League</label><select id="hm-lg-name">' +
            leagues.map(function (l) { return '<option value="' + esc(l.name) + '"' + (l.name === st.leagueName ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') +
          '</select></div>'
        : '';
      var roundSel = rounds.length > 1
        ? '<select id="hm-lg-round">' + rounds.map(function (r, i) { return '<option value="' + i + '"' + (i === st.round ? ' selected' : '') + '>Round ' + (i + 1) + '</option>'; }).join('') + '</select>'
        : '';
      var rows = st.matchups.map(function (m, i) {
        return '<div class="helper-mu-row" data-i="' + i + '">' +
          '<select class="mu-a">' + teamOpts(m.teamA) + '</select>' +
          '<span class="mu-vs">vs</span>' +
          '<select class="mu-b">' + teamOpts(m.teamB) + '</select>' +
          '<select class="mu-sport">' + sportOpts(m.sport) + '</select>' +
          '<select class="mu-field">' + fieldSelectHtml(m.field) + '</select>' +
          '<button class="mu-del" title="Remove">×</button>' +
        '</div>';
      }).join('');
      lbody.innerHTML =
        leagueSel +
        '<div class="helper-lg-toolbar">' +
          '<button class="helper-btn helper-btn-cancel" id="hm-lg-autopair">↻ Auto-pair round-robin</button>' +
          roundSel +
          '<span style="flex:1"></span>' +
          '<label class="helper-lg-allsport">Sport for all: <select id="hm-lg-allsport"><option value="">—</option>' + sportOpts('') + '</select></label>' +
        '</div>' +
        '<div class="helper-mu-head"><span>Team A</span><span></span><span>Team B</span><span>Sport</span><span>Field (empty = auto)</span><span></span></div>' +
        '<div id="hm-mu-rows">' + rows + '</div>' +
        '<button class="helper-btn helper-btn-cancel" id="hm-lg-add" style="margin-top:10px;">+ Add matchup</button>' +
        '<div class="helper-field-hint" style="margin-top:8px;">' + st.matchups.length + ' matchup' + (st.matchups.length === 1 ? '' : 's') +
          ' · ' + leagueTeams().length + ' teams. Empty field = the program assigns an open one.</div>';
      wire();
    }

    function wire() {
      var lgName = lbody.querySelector('#hm-lg-name');
      if (lgName) lgName.addEventListener('change', function () { st.leagueName = lgName.value; st.round = 0; autoPair(); render(); });
      var rnd = lbody.querySelector('#hm-lg-round');
      if (rnd) rnd.addEventListener('change', function () { st.round = parseInt(rnd.value, 10) || 0; autoPair(); render(); });
      var ap = lbody.querySelector('#hm-lg-autopair');
      if (ap) ap.addEventListener('click', function () { autoPair(); render(); });
      var add = lbody.querySelector('#hm-lg-add');
      if (add) add.addEventListener('click', function () { syncFromDom(); st.matchups.push({ teamA: '', teamB: '', sport: defaultSport(), field: '' }); render(); });
      var allSport = lbody.querySelector('#hm-lg-allsport');
      if (allSport) allSport.addEventListener('change', function () {
        if (!allSport.value) return;
        syncFromDom(); st.matchups.forEach(function (m) { m.sport = allSport.value; }); render();
      });
      lbody.querySelectorAll('.mu-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var row = btn.closest('.helper-mu-row'); var i = parseInt(row.getAttribute('data-i'), 10);
          syncFromDom(); st.matchups.splice(i, 1); render();
        });
      });
    }

    // Auto-assign a distinct open field to any matchup left blank.
    function assignFields(matchups) {
      var used = {};
      matchups.forEach(function (m) { if (m.field) used[normField(m.field)] = 1; });
      var slots = (window.SchedulerCoreUtils && window.SchedulerCoreUtils.findSlotsForRange)
        ? (window.SchedulerCoreUtils.findSlotsForRange(block.startMin, block.endMin, divName, null) || []) : [];
      matchups.forEach(function (m) {
        if (m.field || !m.sport) return;
        var res = (typeof window.findFieldsForActivity === 'function')
          ? window.findFieldsForActivity(m.sport, slots, divName, null, block.startMin, block.endMin) : null;
        var open = (res && res.open) ? res.open : [];
        for (var i = 0; i < open.length; i++) {
          if (!used[normField(open[i].name)]) { m.field = open[i].name; used[normField(open[i].name)] = 1; break; }
        }
      });
    }

    render();

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#hm-league-cancel').addEventListener('click', close);
    ov.querySelector('#hm-league-clear').addEventListener('click', function () { clearLeagueSlot(divName, idx); close(); });
    ov.querySelector('#hm-league-save').addEventListener('click', function () {
      syncFromDom();
      var valid = st.matchups.filter(function (m) { return m.teamA && m.teamB && m.teamA !== m.teamB; });
      if (!valid.length) { alert('Add at least one matchup (two different teams).'); return; }
      assignFields(valid);
      writeLeagueSlot(divName, idx, block, st.leagueName, valid, 'League Game');
      close();
    });
  }

  // ---------------------------------------------------------------------
  // Public entry — "Generate" in Helper Mode
  // ---------------------------------------------------------------------
  async function openSpreadsheet() {
    if (!isActive()) return;
    // Make sure any saved data for the date is in memory, then rebuild + paint.
    var dateKey = currentDateKey();
    try { if (typeof window.loadScheduleForDate === 'function' && !window._postEditInProgress) window.loadScheduleForDate(dateKey); } catch (e) {}
    buildStructure(dateKey);
    // ★ The fill sheet renders into #scheduleTable, which lives on the "schedule"
    //   tab. The user presses Generate from the "daily-adjustments" tab, so switch
    //   to the schedule tab (showTab calls updateTable → our render guard).
    window._scheduleNeedsRender = true;
    try { if (typeof window.showTab === 'function') window.showTab('schedule'); } catch (e) {}
    // Paint directly too, in case showTab isn't present or didn't render.
    renderGrid(document.getElementById('scheduleTable'));
    // No baseline save here — an empty grid would just hit the wipe guard.
    // The daily_schedules row is written on the first real cell edit (writeCell).
  }

  // Manual ⇄ Helper interop: both modes share window.scheduleAssignments and the
  // daily_schedules cloud table. On every mode switch, load whatever the OTHER
  // mode already saved for this date and repaint, so each reads the other's work.
  window.addEventListener('campistry-builder-mode-changed', function () {
    _issues = {};
    var dateKey = currentDateKey();
    try { if (typeof window.loadScheduleForDate === 'function' && !window._postEditInProgress) window.loadScheduleForDate(dateKey); } catch (e) {}
    if (isActive()) {
      // Entering Helper — render the shared schedule into the Helper grid.
      try { renderGrid(document.getElementById('scheduleTable')); } catch (e) {}
    } else {
      // Leaving Helper — let the unified renderer repaint the shared schedule.
      try { if (typeof window.updateTable === 'function') window.updateTable(); } catch (e) {}
    }
  });

  window.HelperMode = {
    isActive: isActive,
    openSpreadsheet: openSpreadsheet,
    renderGrid: renderGrid,
    validateAll: validateAll,
    save: save,
    _buildStructure: buildStructure,
    _autoAssignField: autoAssignField,
    _getGeneralActivities: getGeneralActivities,
    _roundRobinRounds: roundRobinRounds,
    _writeCellsMulti: writeCellsMulti,
    _writeLeagueSlot: writeLeagueSlot,
    setView: function (v) { if (v === 'grade' || v === 'all') { _viewMode = v; try { renderGrid(); } catch (e) {} } },
    getView: function () { return _viewMode; }
  };

  console.log('[HelperMode] loaded');
})();
