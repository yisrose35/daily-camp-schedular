/* swim_debug.js — single-command diagnostic for swim+change placement.
 *
 * After Auto Build runs, open browser console and type:
 *
 *     swimDebug()
 *
 * That's the only command. It prints config, periods, a table of every
 * placed swim/change block, and a JSON report between BEGIN/END markers.
 * The report is also copied to the clipboard. Paste it back to the
 * assistant.
 */
(function () {
  'use strict';

  function hh(m) {
    if (m == null || isNaN(m)) return '—';
    var h = Math.floor(m / 60), mn = m % 60;
    return h + ':' + (mn < 10 ? '0' : '') + mn;
  }

  function getDivisions() {
    return window._divisions
      || window.divisions
      || (window.globalSettings && window.globalSettings.app1 && window.globalSettings.app1.divisions)
      || (window.g && window.g.app1 && window.g.app1.divisions)
      || {};
  }
  function getLayersByGrade() {
    if (window._layersByGrade) return window._layersByGrade;
    var g = window.g || window.globalSettings || {};
    var saved = (g.app1 && g.app1.autoLayerTemplates)
      ? (g.app1.autoLayerTemplates['_current'] || g.app1.autoLayerTemplates['_default'])
      : null;
    return saved || {};
  }
  function getPeriods() { return window.campPeriods || {}; }
  function getTimelines() { return window._bunkTimelines || window._autoBuildTimelines || {}; }

  function gradeOf(bunk) {
    var divs = getDivisions();
    for (var gname in divs) {
      var info = divs[gname];
      var bunks = (info && info.bunks) || (Array.isArray(info) ? info : []);
      if (bunks && bunks.indexOf && bunks.indexOf(bunk) >= 0) return gname;
    }
    return null;
  }

  function periodsForGrade(grade) {
    var cp = getPeriods();
    var arr = cp[grade];
    if (!Array.isArray(arr)) return [];
    return arr.slice()
      .map(function (p, i) {
        return { idx: i + 1, start: p.startMin, end: p.endMin, name: p.name || ('P' + (i + 1)) };
      })
      .filter(function (p) { return typeof p.start === 'number' && typeof p.end === 'number'; })
      .sort(function (a, b) { return a.start - b.start; });
  }

  function findPeriod(grade, t) {
    var ps = periodsForGrade(grade);
    for (var i = 0; i < ps.length; i++) {
      if (t >= ps[i].start && t < ps[i].end) return ps[i].idx;
    }
    for (var j = 0; j < ps.length; j++) {
      if (t === ps[j].end) return ps[j].idx;
    }
    return null;
  }
  function crossesPeriod(grade, start, end) {
    var ps = periodsForGrade(grade);
    for (var i = 0; i < ps.length; i++) {
      if (start >= ps[i].start && end <= ps[i].end) return false;
    }
    return ps.length > 0;
  }

  function swimLayerForGrade(grade) {
    var lbg = getLayersByGrade();
    var arr = lbg[grade] || lbg['_all'] || [];
    for (var i = 0; i < arr.length; i++) {
      var L = arr[i];
      if (!L) continue;
      if (String(L.type || L.activity || '').toLowerCase() === 'swim') return L;
    }
    return null;
  }

  function classify(b) {
    var t = String(b.type || b.activity || '').toLowerCase();
    if (t === 'swim') return 'swim';
    if (t === 'pre-change' || t === 'prechange') return 'pre';
    if (t === 'post-change' || t === 'postchange') return 'post';
    if (t === 'change' || t === 'changing') return 'change';
    return null;
  }

  function rowsFor(bunk, blocks) {
    var grade = gradeOf(bunk);
    var swimL = swimLayerForGrade(grade) || {};
    var sorted = (blocks || []).slice().sort(function (a, b) {
      return (a.startMin || 0) - (b.startMin || 0);
    });

    var rows = [];
    for (var i = 0; i < sorted.length; i++) {
      var b = sorted[i];
      var k = classify(b);
      if (!k) continue;

      var s = b.startMin, e = b.endMin;
      var dur = (typeof s === 'number' && typeof e === 'number') ? (e - s) : null;
      var prev = sorted[i - 1], next = sorted[i + 1];
      var gapBefore = (prev && typeof prev.endMin === 'number' && typeof s === 'number') ? (s - prev.endMin) : null;
      var gapAfter = (next && typeof next.startMin === 'number' && typeof e === 'number') ? (next.startMin - e) : null;

      rows.push({
        bunk: bunk,
        grade: grade,
        kind: k,
        startMin: s,
        endMin: e,
        start: hh(s),
        end: hh(e),
        dur: dur,
        period: findPeriod(grade, s),
        crosses: (typeof s === 'number' && typeof e === 'number') ? crossesPeriod(grade, s, e) : null,
        gapBefore: gapBefore,
        gapAfter: gapAfter,
        configPre: swimL.preChangeMin || 0,
        configSwim: swimL.periodMin || swimL.dMax || swimL.dMin || 40,
        configPost: swimL.postChangeMin || 0,
        flags: {
          merged: !!b._mergedIntoSwim,
          attached: !!b._changeAttached,
          swimActualStart: b._swimActualStart,
          swimActualEnd: b._swimActualEnd,
          mode: swimL.mode || swimL.placement || null
        }
      });
    }
    return rows;
  }

  function allRows() {
    var tl = getTimelines();
    var out = [];
    Object.keys(tl).forEach(function (bunk) {
      var rows = rowsFor(bunk, tl[bunk]);
      if (rows.length) out = out.concat(rows);
    });
    return out;
  }

  function run() {
    var tl = getTimelines();
    if (!tl || !Object.keys(tl).length) {
      console.warn('swimDebug: no timelines on window. Run an auto build first.');
      return null;
    }

    var divs = getDivisions();
    var grades = Object.keys(divs);

    // 1) config per grade
    var configByGrade = {};
    var configRows = [];
    grades.forEach(function (g) {
      var L = swimLayerForGrade(g);
      if (!L) return;
      var entry = {
        mode: L.mode || L.placement || null,
        preChangeMin: L.preChangeMin || 0,
        periodMin: L.periodMin || L.dMax || L.dMin || 40,
        postChangeMin: L.postChangeMin || 0,
        dMin: L.dMin || null,
        dMax: L.dMax || null,
        startMin: L.startMin,
        endMin: L.endMin
      };
      configByGrade[g] = entry;
      configRows.push(Object.assign({ grade: g }, entry));
    });

    // 2) periods per grade
    var periodsByGrade = {};
    grades.forEach(function (g) { periodsByGrade[g] = periodsForGrade(g); });

    // 3) blocks
    var rows = allRows();
    var byBunk = {};
    rows.forEach(function (r) {
      if (!byBunk[r.bunk]) byBunk[r.bunk] = { grade: r.grade, blocks: [] };
      byBunk[r.bunk].blocks.push({
        kind: r.kind,
        start: r.start,
        end: r.end,
        startMin: r.startMin,
        endMin: r.endMin,
        dur: r.dur,
        period: r.period,
        crosses: r.crosses,
        gapBefore: r.gapBefore,
        gapAfter: r.gapAfter,
        flags: r.flags
      });
    });

    // 4) print human view
    console.log('=== swimDebug ===');
    console.log('Layer source:', window._layersByGrade ? '_layersByGrade (live)' :
      'fallback (autoLayerTemplates)');
    console.log('Config (pre / swim / post per grade):');
    if (configRows.length) console.table(configRows);
    else console.warn('  (no swim layer found — swim is probably not configured for any grade)');

    console.log('Periods per grade:');
    Object.keys(periodsByGrade).forEach(function (g) {
      var pl = periodsByGrade[g];
      if (!pl.length) {
        console.log('  ' + g + ': (no periods configured — check Bell Schedule)');
      } else {
        console.log('  ' + g + ': ' + pl.map(function (p) {
          return p.name + ' ' + hh(p.start) + '–' + hh(p.end) + ' (' + (p.end - p.start) + 'm)';
        }).join('  '));
      }
    });

    console.log('Placed swim/change blocks:');
    if (!rows.length) {
      console.warn('  (none — auto build placed no swim or change blocks)');
    } else {
      console.table(rows.map(function (r) {
        return {
          bunk: r.bunk,
          grade: r.grade,
          kind: r.kind,
          start: r.start,
          end: r.end,
          dur: r.dur,
          period: r.period == null ? '—' : r.period,
          crosses: r.crosses ? 'YES' : '',
          gapBefore: r.gapBefore == null ? '' : r.gapBefore + 'm',
          gapAfter: r.gapAfter == null ? '' : r.gapAfter + 'm',
          cfg: r.configPre + '/' + r.configSwim + '/' + r.configPost,
          mode: r.flags.mode || ''
        };
      }));
    }

    // 5) JSON report for copy/paste
    var summary = {
      totalSwim: rows.filter(function (r) { return r.kind === 'swim'; }).length,
      swim40min: rows.filter(function (r) { return r.kind === 'swim' && r.dur === 40; }).length,
      swimOver40: rows.filter(function (r) { return r.kind === 'swim' && r.dur > 40; }).length,
      swimUnder40: rows.filter(function (r) { return r.kind === 'swim' && r.dur != null && r.dur < 40; }).length,
      swimCrossingPeriods: rows.filter(function (r) { return r.kind === 'swim' && r.crosses; }).length,
      preChangeBlocks: rows.filter(function (r) { return r.kind === 'pre'; }).length,
      postChangeBlocks: rows.filter(function (r) { return r.kind === 'post'; }).length
    };
    var report = {
      generatedAt: new Date().toISOString(),
      configByGrade: configByGrade,
      periodsByGrade: periodsByGrade,
      bunks: byBunk,
      summary: summary
    };
    var json = JSON.stringify(report, null, 2);
    console.log('---BEGIN-SWIM-REPORT---');
    console.log(json);
    console.log('---END-SWIM-REPORT---');
    console.log('Copy everything between the BEGIN/END markers and paste it to the assistant.');
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(function () {
          console.log('(report also copied to clipboard)');
        }, function () {});
      }
    } catch (e) {}
    return report;
  }

  window.swimDebug = run;
  console.log('[swim_debug] loaded — type swimDebug() in the console after an auto build.');
})();
