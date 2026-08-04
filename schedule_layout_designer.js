/**
 * schedule_layout_designer.js — the UI for building a camp's schedule layout
 * ==========================================================================
 *
 * Camps don't all read a day the same way. Some want time running down the
 * side with grades across the top (what Campistry has always drawn); plenty of
 * others read bunks down the left with time across the top, and many run a
 * bell schedule where the day is a list of named periods rather than a clock.
 *
 * This is where they say so. The designer edits a layout from
 * schedule_layout_model.js and shows a live preview built from the same
 * geometry adapter the real grids use — so what's previewed here is literally
 * how Daily Adjustments, the Master Schedule Builder and the printout will
 * draw the day, not an artist's impression of it.
 *
 * Opens with window.ScheduleLayoutDesigner.open().
 */
(function () {
  'use strict';

  var SL = null;               // resolved lazily — load order independent
  function model() { return SL || (SL = window.ScheduleLayout); }

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Working copy being edited; committed only on Save.
  var draft = null;
  var overlay = null;

  // =========================================================================
  // STYLES
  // =========================================================================

  var CSS = `
  .sld-overlay { position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:10050; display:flex; align-items:center; justify-content:center; padding:24px; }
  .sld-modal { background:#fff; border-radius:14px; width:min(1180px,100%); height:min(760px,100%); display:flex; flex-direction:column; overflow:hidden; box-shadow:0 24px 64px rgba(0,0,0,0.3); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .sld-head { display:flex; align-items:center; gap:12px; padding:16px 20px; border-bottom:1px solid #e2e8f0; flex-shrink:0; }
  .sld-head h2 { margin:0; font-size:17px; font-weight:700; color:#0f172a; }
  .sld-head p { margin:2px 0 0; font-size:12px; color:#64748b; }
  /* minmax(0,1fr), not 1fr: a bare 1fr track takes its content's min-content
     width as a floor, so a wide time-across preview would push the track past
     the modal and paint over the form instead of scrolling inside its pane. */
  .sld-body { flex:1; display:grid; grid-template-columns:390px minmax(0,1fr); min-height:0; }
  .sld-form { overflow-y:auto; padding:18px 20px; border-right:1px solid #e2e8f0; background:#fafbfc; min-width:0; }
  .sld-preview-pane { display:flex; flex-direction:column; min-width:0; min-height:0; background:#fff; overflow:hidden; }
  .sld-preview-head { padding:10px 16px; border-bottom:1px solid #e2e8f0; font-size:12px; color:#64748b; display:flex; align-items:center; gap:8px; flex-shrink:0; }
  .sld-preview { flex:1; overflow:auto; padding:14px; background:#fafbfc; min-width:0; min-height:0; }
  .sld-foot { display:flex; align-items:center; gap:10px; padding:14px 20px; border-top:1px solid #e2e8f0; flex-shrink:0; }

  .sld-field { margin-bottom:16px; }
  .sld-field > label { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:#64748b; margin-bottom:6px; }
  .sld-hint { font-size:11px; color:#94a3b8; margin-top:5px; line-height:1.45; }
  .sld-input, .sld-select { width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:7px; font-size:13px; box-sizing:border-box; background:#fff; color:#0f172a; }
  .sld-input:focus, .sld-select:focus { outline:2px solid #3b82f6; outline-offset:-1px; border-color:#3b82f6; }

  .sld-cards { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .sld-card { border:2px solid #e2e8f0; border-radius:9px; padding:10px; cursor:pointer; background:#fff; text-align:left; transition:border-color .12s, background .12s; }
  .sld-card:hover { border-color:#93c5fd; }
  .sld-card.on { border-color:#2563eb; background:#eff6ff; }
  .sld-card b { display:block; font-size:12px; color:#0f172a; margin-bottom:3px; }
  .sld-card span { font-size:10.5px; color:#64748b; line-height:1.35; display:block; }
  .sld-card svg { display:block; margin-bottom:6px; }

  .sld-tier { border:1px solid #e2e8f0; border-radius:9px; background:#fff; margin-bottom:8px; overflow:hidden; }
  .sld-tier-head { display:flex; align-items:center; gap:8px; padding:8px 10px; background:#f8fafc; border-bottom:1px solid #e2e8f0; }
  .sld-tier-head strong { font-size:12px; color:#0f172a; flex:1; }
  .sld-tier-body { padding:10px; }
  .sld-row { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
  .sld-row input { flex:1; min-width:0; padding:6px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px; box-sizing:border-box; }
  .sld-row input.sld-time { flex:0 0 84px; }
  .sld-periods { max-height:220px; overflow-y:auto; }

  .sld-btn { padding:8px 14px; border-radius:7px; font-size:12.5px; font-weight:600; cursor:pointer; border:1px solid transparent; display:inline-flex; align-items:center; gap:6px; }
  .sld-btn-primary { background:#2563eb; color:#fff; }
  .sld-btn-primary:hover { background:#1d4ed8; }
  .sld-btn-ghost { background:#fff; color:#334155; border-color:#cbd5e1; }
  .sld-btn-ghost:hover { background:#f8fafc; }
  .sld-btn-danger { background:#fff; color:#b91c1c; border-color:#fecaca; }
  .sld-btn-danger:hover { background:#fef2f2; }
  .sld-btn-mini { padding:4px 8px; font-size:11px; border-radius:5px; }
  .sld-btn:disabled { opacity:0.45; cursor:not-allowed; }
  .sld-spacer { flex:1; }

  .sld-range { width:100%; }
  .sld-rangeval { font-size:11px; color:#64748b; float:right; font-weight:600; }
  .sld-note { background:#eff6ff; border:1px solid #bfdbfe; color:#1e40af; border-radius:8px; padding:9px 11px; font-size:11.5px; line-height:1.5; margin-bottom:16px; }
  .sld-warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:8px; padding:9px 11px; font-size:11.5px; line-height:1.5; margin-top:8px; }

  /* --- preview grid: same geometry contract as the real grids ------------ */
  .sldp-grid { display:grid; column-gap:4px; font-size:11px; }
  .sldp-head { padding:6px 8px; font-weight:700; font-size:11px; color:#fff; text-align:center; border-radius:5px 5px 0 0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .sldp-head-t { background:#f1f5f9; color:#64748b; font-weight:600; }
  .sldp-ruler { position:relative; display:flex; background:#f8fafc; }
  .sldp-tier { position:relative; flex:1 0 auto; }
  .sldp-tier + .sldp-tier { border-left:1px solid #e2e8f0; }
  .sldp-tick { position:absolute; box-sizing:border-box; font-size:9.5px; color:#64748b; overflow:hidden; left:0; width:100%; padding:2px 4px; border-top:1px dashed #e2e8f0; white-space:nowrap; }
  .sldp-tier[data-kind="periods"] .sldp-tick { left:2px; right:2px; width:auto; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; background:#eef2ff; border:1px solid #c7d2fe; border-radius:4px; color:#3730a3; font-weight:700; border-top:none; }
  .sldp-tick i { font-style:normal; font-size:8px; font-weight:500; opacity:.75; }
  .sldp-cell { position:relative; background:#fff; border-bottom:1px solid #f1f5f9; }
  .sldp-ev { position:absolute; box-sizing:border-box; border-radius:5px; padding:3px 6px; overflow:hidden; font-size:10px; font-weight:600; line-height:1.2; }

  .sldp-h .sldp-ruler { flex-direction:column; }
  .sldp-h .sldp-tier { flex:0 0 auto; }
  .sldp-h .sldp-tier + .sldp-tier { border-left:none; border-top:1px solid #e2e8f0; }
  .sldp-h .sldp-tier[data-kind="uniform"] { height:20px; }
  .sldp-h .sldp-tier[data-kind="periods"] { height:30px; }
  .sldp-h .sldp-tier[data-kind="uniform"] .sldp-tick { left:auto; width:auto; top:0; height:100%; border-top:none; border-left:1px dashed #e2e8f0; padding:3px 2px; font-size:8.5px; text-align:center; }
  .sldp-h .sldp-tier[data-kind="periods"] .sldp-tick { top:2px; bottom:2px; height:auto; left:auto; right:auto; }
  .sldp-h .sldp-head { text-align:left; border-radius:0; display:flex; flex-direction:column; justify-content:center; }
  `;

  function ensureStyles() {
    if (document.getElementById('sld-styles')) return;
    var el = document.createElement('style');
    el.id = 'sld-styles';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  // =========================================================================
  // PREVIEW — built from the SAME geometry adapter the real grids use, so
  // this is a true preview rather than a mock-up.
  // =========================================================================

  var SAMPLE = [
    { div: 0, label: 'Davening', start: 540, end: 585, bg: '#d1d5db', fg: '#374151' },
    { div: 0, label: 'Activity', start: 600, end: 660, bg: '#93c5fd', fg: '#1e3a5f' },
    { div: 0, label: 'Lunch', start: 720, end: 780, bg: '#fca5a5', fg: '#7f1d1d' },
    { div: 1, label: 'Sports', start: 600, end: 660, bg: '#86efac', fg: '#14532d' },
    { div: 1, label: 'Lunch', start: 720, end: 780, bg: '#fca5a5', fg: '#7f1d1d' },
    { div: 1, label: 'Swim', start: 840, end: 900, bg: '#67e8f9', fg: '#155e75' },
    { div: 2, label: 'Special', start: 660, end: 720, bg: '#c4b5fd', fg: '#4c1d95' },
    { div: 2, label: 'Lunch', start: 780, end: 840, bg: '#fca5a5', fg: '#7f1d1d' }
  ];

  /** Real camp structure when there is one, otherwise a representative stand-in. */
  function previewDivisions() {
    var real = window.divisions || {};
    var names = Object.keys(real);
    if (names.length >= 2) {
      return names.slice(0, 4).map(function (n) {
        return { name: n, color: real[n].color || '#475569', bunks: (real[n].bunks || []).slice(0, 4) };
      });
    }
    return [
      { name: 'Juniors', color: '#2563eb', bunks: ['J1', 'J2', 'J3'] },
      { name: 'Seniors', color: '#059669', bunks: ['S1', 'S2'] },
      { name: 'Teens', color: '#d97706', bunks: ['T1', 'T2'] }
    ];
  }

  function renderPreview() {
    var host = overlay.querySelector('#sld-preview');
    var M = model();
    if (!M) { host.innerHTML = '<p style="color:#b91c1c;">Layout model unavailable.</p>'; return; }

    var layout = M.normalize(draft);
    var divs = previewDivisions();
    var divMap = {};
    divs.forEach(function (d) { divMap[d.name] = { color: d.color, bunks: d.bunks }; });
    var order = divs.map(function (d) { return d.name; });

    var startMin = 540, endMin = 960;
    var lanes = M.lanesFor(layout, divMap, order);
    var geo = M.geometry(layout, { startMin: startMin, endMin: endMin }, { laneCount: lanes.length, laneGap: 4 });
    var isH = geo.horizontal;
    var tiers = geo.rulerTiers();

    var gutter = isH ? 118 : (62 * Math.max(tiers.length, 1));
    var html = '<div class="sldp-grid' + (isH ? ' sldp-h' : '') + '" style="' +
      (isH ? 'grid-template-columns:' + gutter + 'px max-content;column-gap:0;'
           : 'grid-template-columns:' + gutter + 'px repeat(' + lanes.length + ',1fr);') + '">';

    html += '<div class="sldp-head sldp-head-t">Time</div>';

    var laneHead = function (lane) {
      return '<div class="sldp-head" style="background:' + esc(lane.color) + ';' + (isH ? 'height:' + geo.laneSize + 'px;padding:4px 8px;' : '') + '">' +
        esc(lane.label) + (lane.bunk ? '<span style="font-size:8.5px;opacity:.75;">' + esc(lane.division) + '</span>' : '') + '</div>';
    };
    if (!isH) lanes.forEach(function (l) { html += laneHead(l); });

    // ruler
    html += '<div class="sldp-ruler" style="' + (isH ? 'width:' + geo.timeSpanPx + 'px;' : 'height:' + geo.timeSpanPx + 'px;') + '">';
    tiers.forEach(function (tier) {
      html += '<div class="sldp-tier" data-kind="' + tier.kind + '">';
      tier.ticks.forEach(function (tk) {
        var body = tier.kind === 'periods'
          ? esc(tk.label) + '<i>' + esc(tk.rangeLabel) + '</i>'
          : esc(geo.tickLabel(tk));
        html += '<div class="sldp-tick" style="' + geo.tickStyle(tk) + '">' + body + '</div>';
      });
      html += '</div>';
    });
    html += '</div>';

    // lanes + sample tiles
    lanes.forEach(function (lane) {
      if (isH) html += laneHead(lane);
      html += '<div class="sldp-cell" style="' + geo.laneExtentStyle() + '">';
      if (lane.groupStart) {
        var di = order.indexOf(lane.division);
        var range = M.laneRangeForDivision(lanes, lane.division) || { first: 0, last: 0 };
        var spanLanes = range.last - range.first + 1;
        SAMPLE.filter(function (s) { return s.div === di; }).forEach(function (s) {
          html += '<div class="sldp-ev" style="' + geo.tileStyle(s.start, s.end, { lanes: spanLanes, minSizePx: 16 }) +
            'background:' + s.bg + ';color:' + s.fg + ';">' + esc(s.label) + '</div>';
        });
      }
      html += '</div>';
    });

    html += '</div>';
    host.innerHTML = html;

    var summary = overlay.querySelector('#sld-summary');
    if (summary) {
      summary.textContent = (isH ? 'Time runs across the top' : 'Time runs down the side') +
        ' · ' + lanes.length + ' ' + (layout.entityAxis === 'bunk' ? 'bunk' : 'grade') + ' ' + (isH ? 'rows' : 'columns') +
        ' · ' + tiers.length + ' ruler ' + (tiers.length === 1 ? 'row' : 'rows');
    }
  }

  // =========================================================================
  // FORM
  // =========================================================================

  var ICON_V = '<svg width="34" height="24" viewBox="0 0 34 24" fill="none"><rect x=".5" y=".5" width="33" height="23" rx="2" stroke="#94a3b8"/><rect x="1" y="1" width="7" height="22" fill="#e2e8f0"/><line x1="8" y1="7" x2="34" y2="7" stroke="#cbd5e1"/><line x1="8" y1="13" x2="34" y2="13" stroke="#cbd5e1"/><line x1="8" y1="19" x2="34" y2="19" stroke="#cbd5e1"/><line x1="17" y1="1" x2="17" y2="23" stroke="#cbd5e1"/><line x1="25" y1="1" x2="25" y2="23" stroke="#cbd5e1"/></svg>';
  var ICON_H = '<svg width="34" height="24" viewBox="0 0 34 24" fill="none"><rect x=".5" y=".5" width="33" height="23" rx="2" stroke="#94a3b8"/><rect x="1" y="1" width="33" height="6" fill="#e2e8f0"/><line x1="1" y1="13" x2="34" y2="13" stroke="#cbd5e1"/><line x1="1" y1="19" x2="34" y2="19" stroke="#cbd5e1"/><line x1="10" y1="1" x2="10" y2="23" stroke="#cbd5e1"/><line x1="19" y1="1" x2="19" y2="23" stroke="#cbd5e1"/><line x1="27" y1="1" x2="27" y2="23" stroke="#cbd5e1"/></svg>';

  function formHtml() {
    var M = model();
    var saved = M.all();
    var isH = draft.orientation === 'horizontal';

    var h = '';

    h += '<div class="sld-field"><label>Layout</label>' +
      '<select class="sld-select" id="sld-pick">' +
      saved.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (l.id === draft.id ? ' selected' : '') + '>' + esc(l.name) + (l.builtIn ? ' (built in)' : '') + '</option>';
      }).join('') +
      '</select>' +
      '<div style="display:flex;gap:6px;margin-top:7px;flex-wrap:wrap;">' +
      '<button class="sld-btn sld-btn-ghost sld-btn-mini" id="sld-new">+ New</button>' +
      '<button class="sld-btn sld-btn-ghost sld-btn-mini" id="sld-dup">Duplicate</button>' +
      '<button class="sld-btn sld-btn-ghost sld-btn-mini" id="sld-import">⬆ Import a spreadsheet</button>' +
      '<button class="sld-btn sld-btn-danger sld-btn-mini" id="sld-del"' + (draft.builtIn ? ' disabled' : '') + '>Delete</button>' +
      '</div></div>';

    if (draft.builtIn) {
      h += '<div class="sld-note">This is the built-in layout, so it can\'t be edited directly. Any change you make here starts a copy of it — the original stays put.</div>';
    }

    h += '<div class="sld-field"><label>Name</label>' +
      '<input class="sld-input" id="sld-name" value="' + esc(draft.name) + '" placeholder="e.g. Our summer template"></div>';

    h += '<div class="sld-field"><label>Which way does the day run?</label><div class="sld-cards">' +
      '<button class="sld-card' + (!isH ? ' on' : '') + '" data-orient="vertical">' + ICON_V +
        '<b>Time down the side</b><span>Grades or bunks across the top. Campistry\'s classic view.</span></button>' +
      '<button class="sld-card' + (isH ? ' on' : '') + '" data-orient="horizontal">' + ICON_H +
        '<b>Time across the top</b><span>Grades or bunks down the left, the way many printed camp templates read.</span></button>' +
      '</div></div>';

    h += '<div class="sld-field"><label>What goes on the other side?</label><div class="sld-cards">' +
      '<button class="sld-card' + (draft.entityAxis === 'division' ? ' on' : '') + '" data-axis="division">' +
        '<b>One per grade</b><span>A single lane per grade — the whole grade\'s schedule at a glance.</span></button>' +
      '<button class="sld-card' + (draft.entityAxis === 'bunk' ? ' on' : '') + '" data-axis="bunk">' +
        '<b>One per bunk</b><span>Every bunk gets its own lane, grouped under its grade.</span></button>' +
      '</div>' +
      (draft.entityAxis === 'bunk'
        ? '<div class="sld-warn">Activities are still scheduled per grade, so a grade\'s block stretches across all of its bunks\' lanes. Per-bunk changes stay in Bunk Overrides.</div>'
        : '') +
      '</div>';

    h += '<div class="sld-field"><label>Time ruler <span class="sld-rangeval">' + draft.rulers.length + ' row' + (draft.rulers.length === 1 ? '' : 's') + '</span></label>' +
      '<div class="sld-hint" style="margin-top:0;margin-bottom:8px;">Stack as many rows as you read your day in — an hourly row over a 15-minute row, or your own named periods over either.</div>' +
      '<div id="sld-tiers">' + draft.rulers.map(tierHtml).join('') + '</div>' +
      '<div style="display:flex;gap:6px;">' +
      '<button class="sld-btn sld-btn-ghost sld-btn-mini" id="sld-add-uniform">+ Even increments</button>' +
      '<button class="sld-btn sld-btn-ghost sld-btn-mini" id="sld-add-periods">+ Named periods</button>' +
      '</div></div>';

    var zoomLabel = isH ? 'Width per hour' : 'Height per hour';
    h += '<div class="sld-field"><label>' + zoomLabel + '<span class="sld-rangeval" id="sld-zoomval">' + Math.round(draft.pxPerMinute * 60) + 'px</span></label>' +
      '<input class="sld-range" type="range" id="sld-zoom" min="36" max="360" step="6" value="' + Math.round(draft.pxPerMinute * 60) + '">' +
      '<div class="sld-hint">More room per hour makes short activities readable; less fits the whole day on screen.</div></div>';

    if (isH) {
      h += '<div class="sld-field"><label>Row height<span class="sld-rangeval" id="sld-laneval">' + draft.laneSize + 'px</span></label>' +
        '<input class="sld-range" type="range" id="sld-lane" min="32" max="180" step="2" value="' + draft.laneSize + '"></div>';
    }

    var bells = model().hasBells(model().normalize(draft));
    h += '<div class="sld-field"><label>Snapping</label>';
    if (bells) {
      h += '<label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#334155;font-weight:500;">' +
        '<input type="checkbox" id="sld-bells" ' + (draft.snapToBells ? 'checked' : '') + ' style="margin-top:2px;">' +
        '<span>Snap activities onto my period boundaries<div class="sld-hint" style="margin-top:2px;">Dragging an activity lands it exactly on a bell instead of somewhere in between.</div></span></label>';
    }
    h += '<div style="margin-top:8px;"><select class="sld-select" id="sld-snap">' +
      [1, 5, 10, 15, 20, 30].map(function (n) {
        return '<option value="' + n + '"' + (draft.snapMins === n ? ' selected' : '') + '>Otherwise snap to ' + n + ' minute' + (n === 1 ? '' : 's') + '</option>';
      }).join('') + '</select></div></div>';

    return h;
  }

  function tierHtml(tier, i) {
    var isUniform = tier.kind === 'uniform';
    var h = '<div class="sld-tier" data-i="' + i + '">';
    h += '<div class="sld-tier-head"><strong>' + (isUniform ? 'Every ' + tier.increment + ' minutes' : 'Named periods (' + tier.slots.length + ')') + '</strong>' +
      '<button class="sld-btn sld-btn-ghost sld-btn-mini sld-tier-up" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="sld-btn sld-btn-ghost sld-btn-mini sld-tier-dn" title="Move down">↓</button>' +
      '<button class="sld-btn sld-btn-danger sld-btn-mini sld-tier-rm" title="Remove this row">✕</button></div>';
    h += '<div class="sld-tier-body">';

    if (isUniform) {
      h += '<div class="sld-row"><select class="sld-select sld-inc">' +
        [5, 10, 15, 20, 30, 45, 60, 90, 120].map(function (n) {
          return '<option value="' + n + '"' + (tier.increment === n ? ' selected' : '') + '>' + n + ' minutes</option>';
        }).join('') + '</select></div>';
      h += '<label style="display:flex;gap:6px;align-items:center;font-size:11.5px;color:#475569;">' +
        '<input type="checkbox" class="sld-align" ' + (tier.align !== false ? 'checked' : '') + '>' +
        'Start on the round hour rather than on the first activity</label>';
    } else {
      h += '<div class="sld-periods">';
      tier.slots.forEach(function (s, j) {
        h += '<div class="sld-row" data-j="' + j + '">' +
          '<input class="sld-time sld-p-start" value="' + esc(model().fmtTime(s.start)) + '" placeholder="9:00am">' +
          '<input class="sld-time sld-p-end" value="' + esc(model().fmtTime(s.end)) + '" placeholder="10:00am">' +
          '<input class="sld-p-label" value="' + esc(s.label) + '" placeholder="Period name">' +
          '<button class="sld-btn sld-btn-danger sld-btn-mini sld-p-rm">✕</button></div>';
      });
      h += '</div>';
      h += '<div style="display:flex;gap:6px;margin-top:4px;">' +
        '<button class="sld-btn sld-btn-ghost sld-btn-mini sld-p-add">+ Period</button>' +
        '<button class="sld-btn sld-btn-ghost sld-btn-mini sld-p-fill">Fill the day evenly…</button></div>';
      h += '<div class="sld-hint">Times accept "9:00am", "2:30pm" or "14:30". Gaps between periods are fine — they just render as blank ruler.</div>';
    }
    h += '</div></div>';
    return h;
  }

  // =========================================================================
  // WIRING
  // =========================================================================

  function refresh() {
    overlay.querySelector('#sld-form').innerHTML = formHtml();
    bindForm();
    renderPreview();
  }

  /** Any edit to the built-in layout silently forks it into a custom copy. */
  function forkIfBuiltIn() {
    if (!draft.builtIn) return;
    draft = model().normalize(draft);
    draft.builtIn = false;
    draft.id = model().uid();
    draft.name = 'My layout';
  }

  function bindForm() {
    var M = model();
    var $ = function (sel) { return overlay.querySelector(sel); };
    var $$ = function (sel) { return Array.prototype.slice.call(overlay.querySelectorAll(sel)); };

    $('#sld-pick').onchange = function () { draft = M.normalize(M.byId(this.value)); refresh(); };
    $('#sld-new').onclick = function () { draft = M.blank('My layout'); refresh(); };
    $('#sld-dup').onclick = function () {
      var copy = M.normalize(draft);
      copy.id = M.uid(); copy.builtIn = false; copy.name = draft.name + ' (copy)';
      draft = copy; refresh();
    };
    $('#sld-del').onclick = function () {
      if (draft.builtIn) return;
      if (!window.confirm('Delete the layout "' + draft.name + '"? Any grid using it falls back to the built-in one.')) return;
      M.remove(draft.id);
      draft = M.normalize(M.active());
      refresh();
    };
    $('#sld-import').onclick = function () {
      if (!window.ScheduleLayoutImport) { window.alert('The spreadsheet importer failed to load. Reload the page and try again.'); return; }
      window.ScheduleLayoutImport.pickAndParse().then(function (result) {
        if (!result) return;                                  // cancelled
        if (result.error) { window.alert(result.error); return; }
        draft = M.normalize(result.layout);
        draft.builtIn = false;
        refresh();
        var msg = result.notes && result.notes.length
          ? 'Imported "' + result.fileName + '".\n\n' + result.notes.join('\n')
          : 'Imported "' + result.fileName + '".';
        window.alert(msg + '\n\nCheck the preview, adjust anything that looks off, then Save.');
      });
    };

    $('#sld-name').oninput = function () { forkIfBuiltIn(); draft.name = this.value; };

    $$('[data-orient]').forEach(function (b) {
      b.onclick = function () { forkIfBuiltIn(); draft.orientation = b.dataset.orient; refresh(); };
    });
    $$('[data-axis]').forEach(function (b) {
      b.onclick = function () { forkIfBuiltIn(); draft.entityAxis = b.dataset.axis; refresh(); };
    });

    $('#sld-zoom').oninput = function () {
      forkIfBuiltIn();
      draft.pxPerMinute = Number(this.value) / 60;
      $('#sld-zoomval').textContent = this.value + 'px';
      renderPreview();
    };
    var laneEl = $('#sld-lane');
    if (laneEl) laneEl.oninput = function () {
      forkIfBuiltIn();
      draft.laneSize = Number(this.value);
      $('#sld-laneval').textContent = this.value + 'px';
      renderPreview();
    };
    var bellsEl = $('#sld-bells');
    if (bellsEl) bellsEl.onchange = function () { forkIfBuiltIn(); draft.snapToBells = this.checked; };
    $('#sld-snap').onchange = function () { forkIfBuiltIn(); draft.snapMins = Number(this.value); };

    $('#sld-add-uniform').onclick = function () {
      forkIfBuiltIn();
      draft.rulers.push({ id: M.uid('tier'), kind: 'uniform', increment: 15, label: '', align: true });
      refresh();
    };
    $('#sld-add-periods').onclick = function () {
      forkIfBuiltIn();
      draft.rulers.push({ id: M.uid('tier'), kind: 'periods', label: 'Periods', slots: defaultPeriods() });
      refresh();
    };

    // --- per-tier controls -------------------------------------------------
    $$('.sld-tier').forEach(function (el) {
      var i = Number(el.dataset.i);
      var tier = draft.rulers[i];
      if (!tier) return;

      el.querySelector('.sld-tier-rm').onclick = function () {
        forkIfBuiltIn();
        if (draft.rulers.length === 1) { window.alert('A layout needs at least one ruler row.'); return; }
        draft.rulers.splice(i, 1); refresh();
      };
      el.querySelector('.sld-tier-up').onclick = function () {
        forkIfBuiltIn();
        if (i === 0) return;
        draft.rulers.splice(i - 1, 0, draft.rulers.splice(i, 1)[0]); refresh();
      };
      el.querySelector('.sld-tier-dn').onclick = function () {
        forkIfBuiltIn();
        if (i >= draft.rulers.length - 1) return;
        draft.rulers.splice(i + 1, 0, draft.rulers.splice(i, 1)[0]); refresh();
      };

      var inc = el.querySelector('.sld-inc');
      if (inc) inc.onchange = function () { forkIfBuiltIn(); tier.increment = Number(this.value); refresh(); };
      var align = el.querySelector('.sld-align');
      if (align) align.onchange = function () { forkIfBuiltIn(); tier.align = this.checked; renderPreview(); };

      el.querySelectorAll('.sld-row[data-j]').forEach(function (row) {
        var j = Number(row.dataset.j);
        var commit = function () {
          forkIfBuiltIn();
          var a = M.parseTime(row.querySelector('.sld-p-start').value);
          var b = M.parseTime(row.querySelector('.sld-p-end').value);
          var label = row.querySelector('.sld-p-label').value;
          if (a == null || b == null || b <= a) { renderPreview(); return; }   // keep the old value
          tier.slots[j] = { start: a, end: b, label: label || tier.slots[j].label };
          renderPreview();
        };
        row.querySelectorAll('input').forEach(function (inp) { inp.onchange = commit; });
        row.querySelector('.sld-p-rm').onclick = function () {
          forkIfBuiltIn(); tier.slots.splice(j, 1); refresh();
        };
      });

      var add = el.querySelector('.sld-p-add');
      if (add) add.onclick = function () {
        forkIfBuiltIn();
        var last = tier.slots[tier.slots.length - 1];
        var s = last ? last.end : 540;
        tier.slots.push({ start: s, end: s + 60, label: 'Period ' + (tier.slots.length + 1) });
        refresh();
      };
      var fill = el.querySelector('.sld-p-fill');
      if (fill) fill.onclick = function () {
        var from = window.prompt('Start the first period at:', M.fmtTime(tier.slots.length ? tier.slots[0].start : 540));
        if (from == null) return;
        var to = window.prompt('End the last period at:', M.fmtTime(tier.slots.length ? tier.slots[tier.slots.length - 1].end : 960));
        if (to == null) return;
        var len = window.prompt('How many minutes is each period?', '60');
        if (len == null) return;
        var a = M.parseTime(from), b = M.parseTime(to), n = parseInt(len, 10);
        if (a == null || b == null || !(n > 0) || b <= a) { window.alert('Those times don\'t make a usable day — check them and try again.'); return; }
        forkIfBuiltIn();
        var slots = [], k = 1;
        for (var t = a; t + n <= b; t += n) slots.push({ start: t, end: t + n, label: 'Period ' + (k++) });
        if (!slots.length) { window.alert('That period length is longer than the day you gave.'); return; }
        tier.slots = slots;
        refresh();
      };
    });
  }

  function defaultPeriods() {
    var slots = [];
    for (var t = 540, i = 1; t < 960; t += 60) slots.push({ start: t, end: t + 60, label: 'Period ' + (i++) });
    return slots;
  }

  // =========================================================================
  // OPEN / CLOSE
  // =========================================================================

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function commit(makeActive) {
    var M = model();
    var saved = M.save(draft);
    if (makeActive) M.setActive(saved.id);
    close();
    // Repaint whatever grid is on screen with the new shape.
    if (typeof window.refreshSkeletonConflicts === 'function') window.refreshSkeletonConflicts();
    if (window.MasterScheduleBuilder && typeof window.MasterScheduleBuilder.renderGrid === 'function') {
      try { window.MasterScheduleBuilder.renderGrid(); } catch (e) {}
    }
  }

  function open() {
    var M = model();
    if (!M) { window.alert('Schedule layouts failed to load. Reload the page and try again.'); return; }
    ensureStyles();
    draft = M.normalize(M.active());

    overlay = document.createElement('div');
    overlay.className = 'sld-overlay';
    overlay.innerHTML =
      '<div class="sld-modal" role="dialog" aria-label="Schedule layout">' +
        '<div class="sld-head"><div style="flex:1;">' +
          '<h2>Schedule layout</h2>' +
          '<p>Set up the grid the way your camp already reads its day. This is how Daily Adjustments, the builder and your printouts will look.</p>' +
        '</div>' +
        '<button class="sld-btn sld-btn-ghost" id="sld-x">Close</button></div>' +
        '<div class="sld-body">' +
          '<div class="sld-form" id="sld-form"></div>' +
          '<div class="sld-preview-pane">' +
            '<div class="sld-preview-head"><strong>Preview</strong><span id="sld-summary"></span></div>' +
            '<div class="sld-preview" id="sld-preview"></div>' +
          '</div>' +
        '</div>' +
        '<div class="sld-foot">' +
          '<span style="font-size:11.5px;color:#94a3b8;">Layouts are saved to your camp, so everyone signed in sees the same shape.</span>' +
          '<span class="sld-spacer"></span>' +
          '<button class="sld-btn sld-btn-ghost" id="sld-cancel">Cancel</button>' +
          '<button class="sld-btn sld-btn-ghost" id="sld-save">Save</button>' +
          '<button class="sld-btn sld-btn-primary" id="sld-use">Save &amp; use this layout</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#sld-x').onclick = close;
    overlay.querySelector('#sld-cancel').onclick = close;
    overlay.querySelector('#sld-save').onclick = function () { commit(false); };
    overlay.querySelector('#sld-use').onclick = function () { commit(true); };
    document.addEventListener('keydown', onKey);

    refresh();
  }

  window.ScheduleLayoutDesigner = { open: open, close: close };
})();
