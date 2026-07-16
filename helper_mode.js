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

  function writeCell(bunk, idx, block, entry) {
    if (!window.scheduleAssignments) window.scheduleAssignments = {};
    if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
    entry._startMin = block.startMin;
    entry._endMin = block.endMin;
    entry.continuation = false;
    entry._fixed = true;
    entry._postEdit = true;
    entry._helper = true;
    entry._editedAt = Date.now();
    window.scheduleAssignments[bunk][idx] = entry;
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
      '.helper-div{margin:0 4px 26px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff;}',
      '.helper-div-head{background:#f1f5f9;padding:8px 14px;font-weight:700;color:#0f172a;border-bottom:1px solid #e2e8f0;}',
      '.helper-scroll{overflow-x:auto;}',
      '.helper-table{border-collapse:collapse;width:100%;min-width:520px;}',
      '.helper-table th,.helper-table td{border:1px solid #e5e7eb;padding:0;text-align:left;vertical-align:top;}',
      '.helper-table thead th{background:#f8fafc;font-size:.72rem;color:#475569;padding:7px 10px;white-space:nowrap;position:sticky;top:0;}',
      '.helper-bunk-cell{background:#f8fafc;font-weight:700;font-size:.82rem;color:#334155;padding:8px 12px;white-space:nowrap;}',
      '.helper-cell{min-width:130px;height:46px;position:relative;cursor:pointer;transition:background .12s;}',
      '.helper-cell:hover{background:#eff6ff;}',
      '.helper-cell-inner{padding:6px 9px;font-size:.8rem;color:#0f172a;line-height:1.25;min-height:34px;}',
      '.helper-cell-empty{color:#94a3b8;font-style:italic;}',
      '.helper-cell.helper-err{background:#fef2f2;box-shadow:inset 0 0 0 2px #ef4444;}',
      '.helper-cell.helper-warn{background:#fffbeb;box-shadow:inset 0 0 0 2px #f59e0b;}',
      '.helper-flag{position:absolute;top:2px;right:4px;font-size:.7rem;}',
      '.helper-tag{display:inline-block;font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:5px;margin-bottom:2px;text-transform:uppercase;letter-spacing:.03em;}',
      '.helper-tag-sport{background:#dcfce7;color:#166534;}',
      '.helper-tag-special{background:#ede9fe;color:#5b21b6;}',
      '.helper-tag-league{background:#e0e7ff;color:#3730a3;}',
      '.helper-tag-text{background:#f1f5f9;color:#475569;}',
      '.helper-empty-note{padding:40px;text-align:center;color:#64748b;}',
      // modal
      '.helper-modal-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.helper-modal{background:#fff;border-radius:14px;max-width:460px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);}',
      '.helper-modal.helper-modal-wide{max-width:900px;}',
      '.helper-modal-cols{display:flex;gap:18px;padding:16px 20px;flex-wrap:wrap;align-items:flex-start;}',
      '.helper-modal-cols .helper-modal-body{padding:0;}',
      '.helper-modal-left{flex:1 1 300px;min-width:270px;}',
      '.helper-modal-right{flex:1 1 340px;min-width:270px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;max-height:56vh;overflow:auto;}',
      '.helper-report-title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#475569;padding:10px 14px 4px;}',
      '.helper-modal-head{padding:16px 20px;border-bottom:1px solid #e2e8f0;font-weight:700;color:#0f172a;}',
      '.helper-modal-sub{font-size:.8rem;color:#64748b;font-weight:500;margin-top:2px;}',
      '.helper-modal-body{padding:16px 20px;}',
      '.helper-seg{display:flex;gap:6px;margin-bottom:16px;}',
      '.helper-seg button{flex:1;padding:9px 6px;border:1px solid #cbd5e1;background:#f8fafc;border-radius:8px;font-weight:600;font-size:.82rem;color:#475569;cursor:pointer;}',
      '.helper-seg button.active{background:#2563eb;border-color:#2563eb;color:#fff;}',
      '.helper-field{margin-bottom:12px;}',
      '.helper-field label{display:block;font-size:.75rem;font-weight:600;color:#475569;margin-bottom:4px;}',
      '.helper-field select,.helper-field input,.helper-field textarea{width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:.86rem;font-family:inherit;box-sizing:border-box;}',
      '.helper-field textarea{min-height:70px;resize:vertical;}',
      '.helper-modal-foot{display:flex;gap:8px;padding:14px 20px;border-top:1px solid #e2e8f0;}',
      '.helper-btn{padding:9px 16px;border-radius:8px;font-weight:600;font-size:.84rem;cursor:pointer;border:1px solid transparent;}',
      '.helper-btn-save{background:#2563eb;color:#fff;}',
      '.helper-btn-cancel{background:#f1f5f9;color:#475569;border-color:#cbd5e1;}',
      '.helper-btn-clear{background:#fff;color:#b91c1c;border-color:#fecaca;margin-right:auto;}'
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

  function tagForEntry(entry) {
    if (!entry) return '';
    if (entry._h2h || entry._league) return '<span class="helper-tag helper-tag-league">League</span>';
    if (entry._special) return '<span class="helper-tag helper-tag-special">Special</span>';
    if (entry._customText) return '<span class="helper-tag helper-tag-text">Note</span>';
    if (entry.sport) return '<span class="helper-tag helper-tag-sport">Sport</span>';
    return '';
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
      return;
    }

    order.forEach(function (dn) {
      var slots = divTimes[dn] || [];
      var bunks = (divs[dn] && divs[dn].bunks) || [];
      if (!slots.length || !bunks.length) return;

      html += '<div class="helper-div">';
      html += '<div class="helper-div-head">' + esc(dn) + '</div>';
      html += '<div class="helper-scroll"><table class="helper-table"><thead><tr><th>Bunk</th>';
      slots.forEach(function (s) {
        html += '<th>' + esc(minutesToLabel(s.startMin) + '–' + minutesToLabel(s.endMin)) + '</th>';
      });
      html += '</tr></thead><tbody>';

      bunks.forEach(function (bunk) {
        html += '<tr><td class="helper-bunk-cell">' + esc(bunk) + '</td>';
        var arr = (window.scheduleAssignments && window.scheduleAssignments[bunk]) || [];
        slots.forEach(function (s, idx) {
          var entry = arr[idx];
          var iss = issueFor(bunk, idx);
          var cls = 'helper-cell';
          if (iss) cls += iss.level === 'error' ? ' helper-err' : ' helper-warn';
          var inner;
          if (entry && entry._activity !== 'Free' && (entry._activity || entry._displayName || entry.sport)) {
            inner = tagForEntry(entry) + '<div>' + esc(labelForEntry(entry)) + '</div>';
          } else {
            inner = '<span class="helper-cell-empty">+ add</span>';
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

    // Wire cell clicks.
    container.querySelectorAll('.helper-cell').forEach(function (td) {
      td.addEventListener('click', function () {
        var bunk = td.getAttribute('data-bunk');
        var dn = td.getAttribute('data-div');
        var idx = parseInt(td.getAttribute('data-idx'), 10);
        var block = (window.divisionTimes[dn] || [])[idx];
        if (block) openCellEditor(bunk, dn, idx, block);
      });
    });
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

    // Seed initial mode from the existing entry.
    if (existing) {
      if (existing._h2h || existing._league) state.mode = 'league';
      else if (existing._customText) state.mode = 'text';
      else state.mode = 'activity';
    }

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
        var isSpecial = existing && existing._special;
        var curAct = existing ? (existing._activity || existing.sport || '') : '';
        var curField = existing ? entryLocation(existing) : '';
        body.innerHTML =
          '<div class="helper-seg" id="hm-actkind">' +
            '<button data-kind="sport" class="' + (!isSpecial ? 'active' : '') + '">Sport</button>' +
            '<button data-kind="special" class="' + (isSpecial ? 'active' : '') + '">Special</button>' +
          '</div>' +
          '<div class="helper-field"><label id="hm-act-label">Activity</label>' +
          '<select id="post-edit-activity"></select></div>' +
          '<div class="helper-field"><label>Field / Location</label>' +
          '<select id="hm-field">' + fieldOptions(curField) + '</select></div>';

        var kind = isSpecial ? 'special' : 'sport';
        function fillActs() {
          var sel = body.querySelector('#post-edit-activity');
          var list = kind === 'special' ? getSpecials() : getSports();
          body.querySelector('#hm-act-label').textContent = kind === 'special' ? 'Special activity' : 'Sport';
          sel.innerHTML = '<option value="">— Choose —</option>' + list.map(function (a) {
            return '<option value="' + esc(a) + '"' + (a === curAct ? ' selected' : '') + '>' + esc(a) + '</option>';
          }).join('');
        }
        fillActs();
        var actSel = body.querySelector('#post-edit-activity');
        // A suggestion click (or manual pick) may land a special while the
        // Sport tab is active (or vice-versa) — auto-switch the tab to match
        // so the value stays visible, then refresh the report.
        actSel.addEventListener('change', function () {
          var val = actSel.value;
          curAct = val;
          if (val) {
            var isSp = getSpecials().some(function (s) { return s === val; });
            var isSpo = getSports().some(function (s) { return s === val; });
            if (isSp && kind !== 'special') { kind = 'special'; syncKindUI(); fillActs(); actSel = body.querySelector('#post-edit-activity'); }
            else if (isSpo && !isSp && kind !== 'sport') { kind = 'sport'; syncKindUI(); fillActs(); actSel = body.querySelector('#post-edit-activity'); }
          }
          refreshReport();
        });
        function syncKindUI() {
          body.querySelectorAll('#hm-actkind button').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-kind') === kind); });
        }
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
        var leagues = getLeaguesForDivision(divName);
        if (!leagues.length) {
          body.innerHTML = '<div class="helper-empty-note" style="padding:20px;">No league is assigned to <strong>' +
            esc(divName) + '</strong>. Configure one in the Leagues page first.</div>';
          return;
        }
        var curLeague = existing && existing._league ? existing._league : (leagues[0].name || '');
        var leagueSel = leagues.length > 1
          ? '<div class="helper-field"><label>League</label><select id="hm-league">' +
              leagues.map(function (l) { return '<option value="' + esc(l.name) + '"' + (l.name === curLeague ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') +
            '</select></div>'
          : '<input type="hidden" id="hm-league" value="' + esc(curLeague) + '">';
        body.innerHTML = leagueSel +
          '<div class="helper-field"><label>Matchup</label>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
              '<select id="hm-teamA" style="flex:1"></select>' +
              '<span style="font-weight:700;color:#64748b;">vs</span>' +
              '<select id="hm-teamB" style="flex:1"></select>' +
            '</div></div>' +
          '<div class="helper-field"><label>Sport</label><select id="hm-lsport"></select></div>' +
          '<div class="helper-field"><label>Field / Location</label><select id="hm-lfield">' + fieldOptions(existing ? entryLocation(existing) : '') + '</select></div>';

        function leagueByName(n) { return leagues.find(function (l) { return l.name === n; }) || leagues[0]; }
        function fillTeamsAndSports() {
          var lg = leagueByName((body.querySelector('#hm-league') || {}).value || curLeague);
          var teams = (lg.teams || []);
          var sports = (lg.sports && lg.sports.length) ? lg.sports : getSports();
          var a = body.querySelector('#hm-teamA'), b = body.querySelector('#hm-teamB'), sp = body.querySelector('#hm-lsport');
          var curA = '', curB = '', curSp = '';
          if (existing && existing._h2h && existing._activity) {
            var mm = String(existing._activity).split(' vs ');
            curA = (mm[0] || '').trim(); curB = (mm[1] || '').trim();
            curSp = existing.sport || '';
          }
          a.innerHTML = teams.map(function (t) { return '<option' + (t === curA ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('');
          b.innerHTML = teams.map(function (t) { return '<option' + (t === curB ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('');
          sp.innerHTML = sports.map(function (s) { return '<option' + (s === curSp ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') || '<option value="">(none)</option>';
          if (sp) sp.addEventListener('change', refreshReport);
        }
        fillTeamsAndSports();
        var lsel = body.querySelector('#hm-league');
        if (lsel && lsel.tagName === 'SELECT') lsel.addEventListener('change', function () { fillTeamsAndSports(); refreshReport(); });
      }
    }

    segBtns.forEach(function (b) {
      b.addEventListener('click', function () { state.mode = b.getAttribute('data-mode'); renderBody(); refreshReport(); });
    });
    renderBody();
    mountReport();

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#helper-cancel').addEventListener('click', close);
    ov.querySelector('#helper-clear').addEventListener('click', function () { clearCell(bunk, idx); close(); });

    ov.querySelector('#helper-save').addEventListener('click', function () {
      var entry = null;
      if (state.mode === 'text') {
        var t = (body.querySelector('#hm-text') || {}).value || '';
        t = t.trim();
        if (!t) { clearCell(bunk, idx); close(); return; }
        entry = { _activity: t, _displayName: t, _customText: true, sport: null, field: t, _location: null };
      } else if (state.mode === 'activity') {
        var act = (body.querySelector('#post-edit-activity') || {}).value || '';
        if (!act) { close(); return; }
        var fld = (body.querySelector('#hm-field') || {}).value || '';
        var kind = state._getKind ? state._getKind() : 'sport';
        // If the tab says sport but the value is a configured special, trust the value.
        if (kind === 'sport' && getSpecials().some(function (s) { return s === act; })) kind = 'special';
        entry = {
          _activity: act,
          sport: kind === 'sport' ? act : null,
          _special: kind === 'special',
          field: fld ? (fld + ' – ' + act) : act,
          _location: fld || null
        };
      } else if (state.mode === 'league') {
        var A = (body.querySelector('#hm-teamA') || {}).value || '';
        var B = (body.querySelector('#hm-teamB') || {}).value || '';
        if (!A || !B) { close(); return; }
        if (A === B) { alert('Pick two different teams for the matchup.'); return; }
        var lname = (body.querySelector('#hm-league') || {}).value || '';
        var lsport = (body.querySelector('#hm-lsport') || {}).value || '';
        var lfield = (body.querySelector('#hm-lfield') || {}).value || '';
        var mu = A + ' vs ' + B;
        entry = {
          _activity: mu, _h2h: true, _league: lname, sport: lsport || null,
          field: lfield ? (lfield + ' – ' + (lsport || 'League')) : (lsport || 'League'),
          _location: lfield || null,
          _displayName: mu + (lsport ? ' (' + lsport + ')' : '')
        };
      }
      if (entry) writeCell(bunk, idx, block, entry);
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
    // Reveal the schedule output tab if a switcher exists.
    try { if (typeof window.showScheduleTab === 'function') window.showScheduleTab(); } catch (e) {}
    buildStructure(dateKey);
    renderGrid(document.getElementById('scheduleTable'));
    // Persist a baseline so the row exists in daily_schedules.
    save();
  }

  // Clear the active grid when leaving Helper Mode so the normal renderer resumes.
  window.addEventListener('campistry-builder-mode-changed', function () {
    _issues = {};
    if (!isActive()) {
      // Let the unified system repaint normally on the next render tick.
      try { if (typeof window.updateTable === 'function') window.updateTable(); } catch (e) {}
    }
  });

  window.HelperMode = {
    isActive: isActive,
    openSpreadsheet: openSpreadsheet,
    renderGrid: renderGrid,
    validateAll: validateAll,
    save: save,
    _buildStructure: buildStructure
  };

  console.log('[HelperMode] loaded');
})();
