/**
 * schedule_layout_model.js — Schedule Layout model + orientation-aware geometry
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Every schedule grid in Campistry used to hardcode one shape: a 70px time
 * column on the left, one column per grade across the top, tiles positioned by
 * `(startMin - earliestMin) * PIXELS_PER_MINUTE`, and a fixed 30-minute ruler.
 * Plenty of camps don't think about their day that way — they read bunks down
 * the left with time running across the top, and many run a bell schedule with
 * a coarse period row over a finer 15- or 20-minute row.
 *
 * This module owns the "what shape is the grid" answer so the grids don't have
 * to. A camp saves one or more named LAYOUTS; a layout answers three questions:
 *
 *   1. orientation — does time run DOWN the side ('vertical', today's look) or
 *      ACROSS the top ('horizontal')?
 *   2. entityAxis  — is the other axis one lane per grade, or one per bunk?
 *   3. rulers      — what time tiers label the time axis? Any number of tiers,
 *      each either a uniform increment (60/30/20/15…) or an explicit list of
 *      named periods (a bell schedule).
 *
 * `ScheduleLayout.geometry(layout, range)` then hands back an adapter that does
 * all min↔px math in AXIS-RELATIVE terms. Callers ask for "the style for this
 * time span" or "how many minutes did the pointer move along the time axis"
 * and never touch top/left/width/height themselves. That's what makes the
 * transposed grid fully editable rather than a read-only view: the same drag,
 * resize and drop handlers work in both orientations because none of them know
 * which orientation they're in.
 *
 * TIME STAYS LINEAR. A multi-tier ruler describes the same linear minute axis
 * at several granularities — it does not give each period equal visual width.
 * That keeps every existing overlap/conflict calculation valid.
 *
 * Loads standalone in the browser (window.ScheduleLayout) and under node for
 * tests (module.exports).
 */
(function () {
  'use strict';

  // =========================================================================
  // TIME HELPERS — self-contained so the model is testable without the app.
  // Format matches CampUtils.minutesToTime ("2:30pm") and its parser.
  // =========================================================================

  function parseTime(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim().toLowerCase();
    if (!s) return null;
    // "2:30pm" / "2:30 pm" / "14:30" / "2pm" / "1430"
    var m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) {
      m = s.match(/^(\d{1,2})(\d{2})$/);          // bare "1430"
      if (!m) return null;
      var hh = parseInt(m[1], 10), mm2 = parseInt(m[2], 10);
      if (hh > 23 || mm2 > 59) return null;
      return hh * 60 + mm2;
    }
    var h = parseInt(m[1], 10);
    var mm = m[2] ? parseInt(m[2], 10) : 0;
    var ap = m[3];
    if (mm > 59) return null;
    if (ap) {
      if (h < 1 || h > 12) return null;
      h = h % 12;
      if (ap === 'pm') h += 12;
    } else if (h > 23) return null;
    return h * 60 + mm;
  }

  function fmtTime(mins) {
    if (mins == null || isNaN(mins)) return '';
    var t = Math.round(mins);
    var h = Math.floor(t / 60), m = ((t % 60) + 60) % 60;
    var ap = h >= 12 && h < 24 ? 'pm' : (h >= 24 ? 'am' : 'am');
    h = h % 24;
    var h12 = h % 12 || 12;
    return h12 + ':' + String(m).padStart(2, '0') + (h >= 12 ? 'pm' : 'am');
  }

  /** "11:00am – 12:00pm" style range label, used on ruler ticks. */
  function fmtRange(a, b) { return fmtTime(a) + '–' + fmtTime(b); }

  function uid(prefix) {
    return (prefix || 'lay') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // =========================================================================
  // LAYOUT SCHEMA
  // =========================================================================

  var ORIENTATIONS = ['vertical', 'horizontal'];
  var ENTITY_AXES = ['division', 'bunk'];
  var TIER_KINDS = ['uniform', 'periods'];

  var DEFAULT_PX_PER_MIN = 2.5;     // matches daily_adjustments' PIXELS_PER_MINUTE
  var DEFAULT_SNAP_MINS = 5;        // matches daily_adjustments' SNAP_MINS
  var DEFAULT_LANE_SIZE = 96;       // px per lane row in horizontal mode
  var DEFAULT_TIME_HEADER = 70;     // px of the time gutter in vertical mode
  var DEFAULT_LANE_HEADER = 132;    // px of the lane gutter in horizontal mode

  /** The built-in layout — byte-for-byte the grid Campistry has always drawn. */
  function builtInDefault() {
    return {
      id: 'builtin_classic',
      name: 'Classic (time down the side)',
      builtIn: true,
      orientation: 'vertical',
      entityAxis: 'division',
      pxPerMinute: DEFAULT_PX_PER_MIN,
      laneSize: DEFAULT_LANE_SIZE,
      snapMins: DEFAULT_SNAP_MINS,
      snapToBells: true,
      rulers: [
        // align:false reproduces the historical `for (m = earliest; ...)` ruler,
        // which starts on the day's first minute rather than a round boundary.
        { id: 'tier_classic', kind: 'uniform', increment: 30, label: '', align: false }
      ]
    };
  }

  /**
   * Normalize anything claiming to be a layout into a valid one. Unknown values
   * fall back to the classic defaults rather than throwing — a corrupt layout in
   * cloud state must never be able to blank out a camp's schedule grid.
   */
  function normalize(raw) {
    var base = builtInDefault();
    if (!raw || typeof raw !== 'object') return base;

    var out = {
      id: String(raw.id || uid()),
      name: String(raw.name || 'Untitled layout'),
      builtIn: !!raw.builtIn,
      orientation: ORIENTATIONS.indexOf(raw.orientation) !== -1 ? raw.orientation : base.orientation,
      entityAxis: ENTITY_AXES.indexOf(raw.entityAxis) !== -1 ? raw.entityAxis : base.entityAxis,
      pxPerMinute: Number(raw.pxPerMinute) > 0 ? clamp(Number(raw.pxPerMinute), 0.4, 12) : base.pxPerMinute,
      laneSize: Number(raw.laneSize) > 0 ? clamp(Number(raw.laneSize), 32, 400) : base.laneSize,
      snapMins: Number(raw.snapMins) > 0 ? clamp(Math.round(Number(raw.snapMins)), 1, 60) : base.snapMins,
      snapToBells: raw.snapToBells !== false,
      rulers: []
    };

    var rulers = Array.isArray(raw.rulers) ? raw.rulers : [];
    rulers.forEach(function (t) { var n = normalizeTier(t); if (n) out.rulers.push(n); });
    if (out.rulers.length === 0) out.rulers = base.rulers;

    // A day window may be pinned on the layout; null means "derive from the
    // camp's division start/end times", which is what the grids did before.
    var ds = parseTime(raw.dayStart), de = parseTime(raw.dayEnd);
    out.dayStart = (ds != null) ? ds : null;
    out.dayEnd = (de != null && (ds == null || de > ds)) ? de : null;

    return out;
  }

  function normalizeTier(t) {
    if (!t || typeof t !== 'object') return null;
    var kind = TIER_KINDS.indexOf(t.kind) !== -1 ? t.kind : 'uniform';
    var tier = {
      id: String(t.id || uid('tier')),
      kind: kind,
      label: t.label == null ? '' : String(t.label)
    };
    if (kind === 'uniform') {
      var inc = Math.round(Number(t.increment));
      tier.increment = (inc > 0 && inc <= 24 * 60) ? inc : 30;
      // New tiers align to round boundaries; the classic tier opts out.
      tier.align = t.align !== false;
      return tier;
    }
    // periods
    var slots = [];
    (Array.isArray(t.slots) ? t.slots : []).forEach(function (s, i) {
      if (!s) return;
      var a = parseTime(s.start), b = parseTime(s.end);
      if (a == null || b == null || b <= a) return;
      slots.push({
        start: a,
        end: b,
        label: s.label == null || s.label === '' ? ('Period ' + (i + 1)) : String(s.label)
      });
    });
    slots.sort(function (x, y) { return x.start - y.start; });
    tier.slots = slots;
    // A periods tier with no usable slots is meaningless — drop the tier so a
    // half-finished bell schedule can't render an empty ruler band.
    if (slots.length === 0) return null;
    return tier;
  }

  /** Finest uniform increment across all tiers; used for default tile length. */
  function finestIncrement(layout) {
    var best = null;
    (layout.rulers || []).forEach(function (t) {
      if (t.kind === 'uniform' && (best == null || t.increment < best)) best = t.increment;
    });
    return best == null ? 30 : best;
  }

  /** Every period boundary (starts and ends) across all bell-schedule tiers. */
  function bellBoundaries(layout) {
    var set = [];
    (layout.rulers || []).forEach(function (t) {
      if (t.kind !== 'periods') return;
      t.slots.forEach(function (s) { set.push(s.start); set.push(s.end); });
    });
    set.sort(function (a, b) { return a - b; });
    return set.filter(function (v, i) { return i === 0 || v !== set[i - 1]; });
  }

  function hasBells(layout) {
    return (layout.rulers || []).some(function (t) { return t.kind === 'periods'; });
  }

  /**
   * Snap a minute value the way this layout wants. Bell-schedule camps expect
   * tiles to land on bells, so period boundaries win when present; otherwise we
   * fall back to the layout's snap grid (5 minutes by default, as before).
   */
  function snap(layout, min) {
    if (min == null || isNaN(min)) return min;
    if (layout.snapToBells && hasBells(layout)) {
      var bounds = bellBoundaries(layout);
      var best = null, bestD = Infinity;
      for (var i = 0; i < bounds.length; i++) {
        var d = Math.abs(bounds[i] - min);
        if (d < bestD) { bestD = d; best = bounds[i]; }
      }
      if (best != null) return best;
    }
    var s = layout.snapMins || DEFAULT_SNAP_MINS;
    return Math.round(min / s) * s;
  }

  /**
   * How long a freshly-dropped tile should be at this point in the day. Inside
   * a bell period that's the period's own length, so dropping a tile into
   * "Period 3" fills Period 3 exactly. Otherwise it's the finest ruler tier.
   */
  function defaultDurationAt(layout, min) {
    var found = null;
    (layout.rulers || []).forEach(function (t) {
      if (t.kind !== 'periods') return;
      t.slots.forEach(function (s) {
        if (min >= s.start && min < s.end && (found == null || (s.end - s.start) < found)) {
          found = s.end - s.start;
        }
      });
    });
    return found != null ? found : finestIncrement(layout);
  }

  // =========================================================================
  // GEOMETRY ADAPTER
  // -------------------------------------------------------------------------
  // Everything the grids need to draw and manipulate tiles without knowing
  // which way round the axes are. "time axis" = the axis minutes run along;
  // "lane axis" = the axis grades/bunks run along.
  // =========================================================================

  /**
   * @param {object} layout   a normalized layout (raw is normalized for you)
   * @param {object} range    {startMin, endMin} — the day window being drawn
   * @param {object} [opts]   {laneCount, laneGap} for lane-span math
   */
  function geometry(layout, range, opts) {
    var L = normalize(layout);
    opts = opts || {};

    var startMin = (range && range.startMin != null) ? range.startMin : 540;
    var endMin = (range && range.endMin != null) ? range.endMin : 960;
    if (!(endMin > startMin)) endMin = startMin + 60;

    var horizontal = L.orientation === 'horizontal';
    var ppm = L.pxPerMinute;
    var laneGap = opts.laneGap != null ? opts.laneGap : 4;
    var laneCount = opts.laneCount || 1;

    var timeSpanPx = (endMin - startMin) * ppm;

    // --- core axis math -----------------------------------------------------
    function timePx(min) { return (min - startMin) * ppm; }
    function minAt(px) { return startMin + (px / ppm); }
    function durPx(mins) { return mins * ppm; }

    /**
     * CSS for a tile covering [a, b) across `lanes` consecutive lanes starting
     * at lane offset `laneOffset` (0 = the lane it's rendered in).
     *
     * In VERTICAL mode this reproduces the historical output exactly — top and
     * height inline, lane width left to the `.da-event` stylesheet default
     * (width:94%; left:3%) unless the tile spans multiple lanes. Preserving
     * that byte-for-byte is deliberate: the classic layout must not shift by a
     * pixel when this module took over its math.
     */
    function tileStyle(a, b, cfg) {
      cfg = cfg || {};
      var lanes = cfg.lanes || 1;
      var laneOffset = cfg.laneOffset || 0;
      var minSizePx = cfg.minSizePx != null ? cfg.minSizePx : 0;

      var pos = timePx(a);
      var size = Math.max(durPx(b - a) - 2, minSizePx);

      if (!horizontal) {
        var css = 'top:' + pos + 'px;height:' + size + 'px;';
        if (lanes > 1) {
          css += 'width:calc(' + (lanes * 100) + '% + ' + ((lanes - 1) * laneGap) + 'px - 6%);';
        }
        if (laneOffset) {
          css += 'left:calc(' + (laneOffset * 100) + '% + ' + (laneOffset * laneGap) + 'px + 3%);';
        }
        return css;
      }

      // Horizontal: minutes run left→right, lanes stack top→bottom.
      var laneExtent = lanes * L.laneSize + (lanes - 1) * laneGap;
      var top = laneOffset * (L.laneSize + laneGap);
      return 'left:' + pos + 'px;width:' + size + 'px;' +
             'top:' + (top + 2) + 'px;height:' + Math.max(laneExtent - 4, 18) + 'px;';
    }

    /** A full-lane band covering [a, b) — used for out-of-hours hatching. */
    function bandStyle(a, b) {
      var pos = timePx(a), size = durPx(b - a);
      return horizontal
        ? 'left:' + pos + 'px;width:' + size + 'px;top:0;height:100%;'
        : 'top:' + pos + 'px;height:' + size + 'px;left:0;width:100%;';
    }

    /** A hairline across the whole lane at `min` — used for weather cut lines. */
    function lineStyle(min, borderCss) {
      var pos = timePx(min);
      return horizontal
        ? 'position:absolute;top:0;bottom:0;left:' + pos + 'px;border-left:' + borderCss + ';'
        : 'position:absolute;left:0;right:0;top:' + pos + 'px;border-top:' + borderCss + ';';
    }

    /** The size a lane strip must be along the TIME axis. */
    function laneExtentStyle() {
      return horizontal
        ? 'width:' + timeSpanPx + 'px;height:' + L.laneSize + 'px;'
        : 'height:' + timeSpanPx + 'px;';
    }

    // --- pointer math -------------------------------------------------------
    // Handlers ask "where along the time axis" instead of reading clientY.

    function pointerTimePx(evt, rect) {
      return horizontal ? (evt.clientX - rect.left) : (evt.clientY - rect.top);
    }
    function pointerLanePx(evt, rect) {
      return horizontal ? (evt.clientY - rect.top) : (evt.clientX - rect.left);
    }
    /** Minutes at the pointer, measured from the grid's start. */
    function pointerMinuteOffset(evt, rect) {
      return pointerTimePx(evt, rect) / ppm;
    }
    /** Pixel delta along each axis between two pointer positions. */
    function deltaTimePx(evt, origin) {
      return horizontal ? (evt.clientX - origin.x) : (evt.clientY - origin.y);
    }
    function deltaLanePx(evt, origin) {
      return horizontal ? (evt.clientY - origin.y) : (evt.clientX - origin.x);
    }
    /** Size of one lane along the lane axis, including the gap. */
    function laneStride(cellEl) {
      if (horizontal) return L.laneSize + laneGap;
      return (cellEl && cellEl.offsetWidth ? cellEl.offsetWidth : 0) + laneGap;
    }

    // --- the tile's own leading/trailing edges along the time axis -----------
    // Vertical: top/bottom handles. Horizontal: left/right handles. The
    // handler asks for these names so it never says "top" out loud.
    var startEdgeProp = horizontal ? 'left' : 'top';
    var sizeProp = horizontal ? 'width' : 'height';

    // --- ruler tiers --------------------------------------------------------

    /**
     * Ticks for every tier, clipped to the drawn window. Each tick carries its
     * own position AND extent, so a tier renders as a row of labelled bands
     * (bell schedule) or as a row of boundary marks (uniform).
     */
    function rulerTiers() {
      return (L.rulers || []).map(function (t) {
        var ticks = [];
        if (t.kind === 'uniform') {
          var inc = t.increment;
          var first = t.align ? Math.ceil(startMin / inc) * inc : startMin;
          // An aligned tier still needs a leading partial band so the first
          // sliver of the day isn't unlabelled.
          if (t.align && first > startMin) {
            ticks.push(mkTick(startMin, Math.min(first, endMin), t));
          }
          for (var m = first; m < endMin; m += inc) {
            ticks.push(mkTick(m, Math.min(m + inc, endMin), t));
          }
        } else {
          t.slots.forEach(function (s) {
            if (s.end <= startMin || s.start >= endMin) return;
            ticks.push(mkTick(Math.max(s.start, startMin), Math.min(s.end, endMin), t, s.label));
          });
        }
        return {
          id: t.id,
          kind: t.kind,
          label: t.label,
          ticks: ticks
        };
      });
    }

    function mkTick(a, b, tier, label) {
      return {
        startMin: a,
        endMin: b,
        label: label != null ? label : fmtTime(a),
        timeLabel: fmtTime(a),
        // Meridiem-less form for tight tiers — a 15-minute band at a normal
        // zoom is far too narrow for "10:15am" and would clip mid-word.
        shortLabel: fmtTime(a).replace(/(am|pm)$/, ''),
        rangeLabel: fmtRange(a, b),
        pos: timePx(a),
        size: durPx(b - a)
      };
    }

    /**
     * The most informative label that actually FITS this tick. Space along the
     * time axis is what varies (a tick's other dimension is the tier's own
     * thickness), so both orientations key off `tick.size`.
     */
    function tickLabel(tick) {
      // Horizontal ticks are limited by their width; vertical ones by height,
      // where a single line of 11px text needs far less room.
      var full = horizontal ? 46 : 14;
      var short = horizontal ? 27 : 10;
      if (tick.size >= full) return tick.timeLabel;
      if (tick.size >= short) return tick.shortLabel;
      return '';
    }

    /** CSS placing a ruler tick along the time axis inside its tier strip. */
    function tickStyle(tick) {
      return horizontal
        ? 'left:' + tick.pos + 'px;width:' + tick.size + 'px;'
        : 'top:' + tick.pos + 'px;height:' + tick.size + 'px;';
    }

    return {
      layout: L,
      horizontal: horizontal,
      startMin: startMin,
      endMin: endMin,
      pxPerMinute: ppm,
      laneSize: L.laneSize,
      laneGap: laneGap,
      laneCount: laneCount,
      timeSpanPx: timeSpanPx,
      timeHeaderPx: horizontal ? DEFAULT_LANE_HEADER : DEFAULT_TIME_HEADER,

      timePx: timePx,
      minAt: minAt,
      durPx: durPx,
      tileStyle: tileStyle,
      bandStyle: bandStyle,
      lineStyle: lineStyle,
      laneExtentStyle: laneExtentStyle,

      pointerTimePx: pointerTimePx,
      pointerLanePx: pointerLanePx,
      pointerMinuteOffset: pointerMinuteOffset,
      deltaTimePx: deltaTimePx,
      deltaLanePx: deltaLanePx,
      laneStride: laneStride,
      startEdgeProp: startEdgeProp,
      sizeProp: sizeProp,

      rulerTiers: rulerTiers,
      tickStyle: tickStyle,
      tickLabel: tickLabel,

      snap: function (min) { return snap(L, min); },
      defaultDurationAt: function (min) { return defaultDurationAt(L, min); },
      snapMins: L.snapMins
    };
  }

  // =========================================================================
  // LANES — how the entity axis expands for a given camp structure
  // =========================================================================

  /**
   * Turn the camp's divisions into the lanes this layout wants.
   *
   * division mode → one lane per division (today's columns).
   * bunk mode     → one lane per bunk, grouped under its division. A tile still
   *                 belongs to a DIVISION, so it paints across all that
   *                 division's lanes; per-bunk overrides can then be drawn in a
   *                 single lane. That keeps the underlying skeleton data model
   *                 untouched while giving bunk-first camps the view they read.
   */
  function lanesFor(layout, divisions, order) {
    var L = normalize(layout);
    var names = Array.isArray(order) && order.length ? order : Object.keys(divisions || {});
    var lanes = [];
    names.forEach(function (divName) {
      var div = (divisions || {})[divName] || {};
      if (L.entityAxis === 'bunk') {
        var bunks = Array.isArray(div.bunks) ? div.bunks : [];
        if (bunks.length === 0) {
          // A division with no bunks still needs a lane, or its tiles vanish.
          lanes.push({ key: divName, label: divName, division: divName, bunk: null, color: div.color || '#475569', groupStart: true, groupSize: 1 });
          return;
        }
        bunks.forEach(function (b, i) {
          lanes.push({
            key: divName + ' ' + b,
            label: b,
            division: divName,
            bunk: b,
            color: div.color || '#475569',
            groupStart: i === 0,
            groupSize: bunks.length
          });
        });
      } else {
        lanes.push({ key: divName, label: divName, division: divName, bunk: null, color: div.color || '#475569', groupStart: true, groupSize: 1 });
      }
    });
    return lanes;
  }

  /** Index range [first, last] of the lanes belonging to `divName`. */
  function laneRangeForDivision(lanes, divName) {
    var first = -1, last = -1;
    for (var i = 0; i < lanes.length; i++) {
      if (lanes[i].division === divName) { if (first === -1) first = i; last = i; }
    }
    return first === -1 ? null : { first: first, last: last, count: last - first + 1 };
  }

  // =========================================================================
  // PERSISTENCE — layouts live in globalSettings.app1, same as the rest of the
  // camp's display preferences, so they ride the existing cloud sync.
  // =========================================================================

  var SETTINGS_KEY = 'scheduleLayouts';
  var ACTIVE_KEY = 'activeScheduleLayoutId';

  function _app1() {
    var g = (typeof window !== 'undefined' && window.loadGlobalSettings) ? (window.loadGlobalSettings() || {}) : {};
    return g.app1 || {};
  }

  /** All saved layouts, always with the built-in classic layout first. */
  function all() {
    var stored = _app1()[SETTINGS_KEY];
    var list = Array.isArray(stored) ? stored.map(normalize) : [];
    // Never let a stored copy shadow the built-in — it's the safety net.
    list = list.filter(function (l) { return l.id !== 'builtin_classic'; });
    return [builtInDefault()].concat(list);
  }

  function byId(id) {
    var found = all().filter(function (l) { return l.id === id; })[0];
    return found || builtInDefault();
  }

  function activeId() {
    var id = _app1()[ACTIVE_KEY];
    return id ? String(id) : 'builtin_classic';
  }

  /** The layout the grids should draw right now. */
  function active() { return byId(activeId()); }

  function _persist(list, newActiveId) {
    if (typeof window === 'undefined' || !window.loadGlobalSettings) return false;
    var g = window.loadGlobalSettings() || {};
    if (!g.app1) g.app1 = {};
    // The built-in is regenerated on read; storing it would freeze a stale copy.
    g.app1[SETTINGS_KEY] = list.filter(function (l) { return !l.builtIn; }).map(normalize);
    if (newActiveId !== undefined) g.app1[ACTIVE_KEY] = newActiveId;
    window.saveGlobalSettings && window.saveGlobalSettings('app1', g.app1);
    window.forceSyncToCloud && window.forceSyncToCloud();
    _emit();
    return true;
  }

  function save(layout) {
    var norm = normalize(layout);
    norm.builtIn = false;                       // an edited copy is always custom
    var list = all().filter(function (l) { return !l.builtIn; });
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === norm.id) { idx = i; break; }
    if (idx === -1) list.push(norm); else list[idx] = norm;
    _persist(list);
    return norm;
  }

  function remove(id) {
    if (id === 'builtin_classic') return false;
    var list = all().filter(function (l) { return !l.builtIn && l.id !== id; });
    _persist(list, activeId() === id ? 'builtin_classic' : undefined);
    return true;
  }

  function setActive(id) {
    var list = all().filter(function (l) { return !l.builtIn; });
    _persist(list, String(id || 'builtin_classic'));
    return active();
  }

  function duplicate(id, newName) {
    var src = byId(id);
    var copy = normalize(src);
    copy.id = uid();
    copy.builtIn = false;
    copy.name = newName || (src.name + ' (copy)');
    return save(copy);
  }

  /** A blank custom layout seeded from the classic one, ready for the Designer. */
  function blank(name) {
    var l = builtInDefault();
    l.id = uid();
    l.builtIn = false;
    l.name = name || 'My layout';
    // A fresh custom layout aligns its ruler; only the classic tier opts out.
    l.rulers = [{ id: uid('tier'), kind: 'uniform', increment: 60, label: '', align: true }];
    return l;
  }

  // --- change notification: grids re-render when the active layout changes ---
  var _listeners = [];
  function onChange(fn) { if (typeof fn === 'function') _listeners.push(fn); }
  function _emit() {
    _listeners.forEach(function (fn) { try { fn(active()); } catch (e) { /* a bad listener must not break saving */ } });
    if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
      try { window.dispatchEvent(new CustomEvent('campistry:layout-changed', { detail: active() })); } catch (e) {}
    }
  }

  // =========================================================================

  var API = {
    // model
    builtInDefault: builtInDefault,
    normalize: normalize,
    normalizeTier: normalizeTier,
    blank: blank,
    geometry: geometry,
    lanesFor: lanesFor,
    laneRangeForDivision: laneRangeForDivision,
    snap: snap,
    defaultDurationAt: defaultDurationAt,
    finestIncrement: finestIncrement,
    bellBoundaries: bellBoundaries,
    hasBells: hasBells,
    // persistence
    all: all,
    byId: byId,
    active: active,
    activeId: activeId,
    save: save,
    remove: remove,
    setActive: setActive,
    duplicate: duplicate,
    onChange: onChange,
    // helpers shared with the designer/importer
    parseTime: parseTime,
    fmtTime: fmtTime,
    fmtRange: fmtRange,
    uid: uid,
    ORIENTATIONS: ORIENTATIONS,
    ENTITY_AXES: ENTITY_AXES
  };

  if (typeof window !== 'undefined' && !window.ScheduleLayout) window.ScheduleLayout = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
