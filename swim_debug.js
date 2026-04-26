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

  function mm(t) {
    if (t == null) return null;
    if (typeof t === 'number') return t;
    var s = String(t).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }
  function hh(m) {
    if (m == null || isNaN(m)) return '—';
    var h = Math.floor(m / 60), mn = m % 60;
    return h + ':' + (mn < 10 ? '0' : '') + mn;
  }

  function getDivisions() {
    return window.divisions
      || (window.globalSettings && window.globalSettings.app1 && window.globalSettings.app1.divisions)
      || (window.g && window.g.app1 && window.g.app1.divisions)
      || {};
  }
  function getActiveLayers() {
    var g = window.g || window.globalSettings || {};
    return (g.app1 && (g.app1.dawLayers || g.app1.layers)) || window.dawLayers || [];
  }
  function getPeriods() {
    return window.campPeriods || (window.g && window.g.app1 && window.g.app1.campPeriods) || {};
  }
  function getTimelines() {
    return window._bunkTimelines || window._autoBuildTimelines || {};
  }
  function gradeOf(bunk) {
    var divs = getDivisions();
    for (var gname in divs) {
      var info = divs[gname];
      var bunks = (info && info.bunks) || (Array.isArray(info) ? info : []);
      if (bunks && bunks.indexOf && bunks.indexOf(bunk) >= 0) return gname;
      if (bunks && bunks.includes && bunks.includes(bunk)) return gname;
    }
    return null;
  }

  function periodsForGrade(grade) {
    var cp = getPeriods();
    var p = cp[grade] || cp.default || cp;
    if (!Array.isArray(p)) {
      if (p && Array.isArray(p.periods)) p = p.periods;
      else return [];
    }
    return p.map(function (pp, i) {
      return {
        idx: i + 1,
        start: mm(pp.start || pp.startTime || pp[0]),
        end: mm(pp.end || pp.endTime || pp[1])
      };
    }).filter(function (x) { return x.start != null && x.end != null; });
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
    return true;
  }

  function layerForGrade(grade, type) {
    var layers = getActiveLayers();
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (!L) continue;
      var t = String(L.type || L.activity || L.name || '').toLowerCase();
      if (t !== type.toLowerCase()) continue;
      var grades = L.grades || L.appliesTo || L.applicableGrades || [];
      if (!Array.isArray(grades) || grades.length === 0 || grades.indexOf(grade) >= 0) {
        return L;
      }
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
    var swimL = layerForGrade(grade, 'swim') || {};
    var sorted = (blocks || []).slice().sort(function (a, b) { return mm(a.start) - mm(b.start); });

    var rows = [];
    for (var i = 0; i < sorted.length; i++) {
      var b = sorted[i];
      var k = classify(b);
      if (!k) continue;

      var s = mm(b.start), e = mm(b.end);
      var dur = e - s;
      var prev = sorted[i - 1], next = sorted[i + 1];
      var gapBefore = prev ? (s - mm(prev.end)) : null;
      var gapAfter = next ? (mm(next.start) - e) : null;

      rows.push({
        bunk: bunk,
        grade: grade,
        kind: k,
        start: hh(s),
        end: hh(e),
        dur: dur,
        period: findPeriod(grade, s),
        crosses: crossesPeriod(grade, s, e),
        gapBefore: gapBefore,
        gapAfter: gapAfter,
        configPre: swimL.preChangeMin || 0,
        configSwim: swimL.periodMin || swimL.dMax || swimL.dMin || 40,
        configPost: swimL.postChangeMin || 0,
        flags: {
          merged: !!b._mergedIntoSwim,
          attached: !!b._changeAttached,
          swimActualStart: b._swimActualStart,
          swimActualEnd: b._swimActualEnd
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
      var L = layerForGrade(g, 'swim');
      if (!L) return;
      var entry = {
        mode: L.mode || L.placement || null,
        preChangeMin: L.preChangeMin || 0,
        periodMin: L.periodMin || L.dMax || L.dMin || 40,
        postChangeMin: L.postChangeMin || 0,
        dMin: L.dMin || null,
        dMax: L.dMax || null
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
        dur: r.dur,
        period: r.period,
        crosses: r.crosses,
        gapBefore: r.gapBefore,
        gapAfter: r.gapAfter
      });
    });

    // 4) print human view
    console.log('=== swimDebug ===');
    console.log('Config (pre / swim / post per grade):');
    console.table(configRows);
    console.log('Periods per grade:');
    Object.keys(periodsByGrade).forEach(function (g) {
      var line = periodsByGrade[g].map(function (p) {
        return 'P' + p.idx + ' ' + hh(p.start) + '–' + hh(p.end) + ' (' + (p.end - p.start) + 'm)';
      }).join('  ');
      console.log('  ' + g + ': ' + line);
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
          cfg: r.configPre + '/' + r.configSwim + '/' + r.configPost
        };
      }));
    }

    // 5) JSON report for copy/paste
    var report = {
      generatedAt: new Date().toISOString(),
      configByGrade: configByGrade,
      periodsByGrade: periodsByGrade,
      bunks: byBunk,
      summary: {
        totalSwim: rows.filter(function (r) { return r.kind === 'swim'; }).length,
        swim40min: rows.filter(function (r) { return r.kind === 'swim' && r.dur === 40; }).length,
        swimOver40: rows.filter(function (r) { return r.kind === 'swim' && r.dur > 40; }).length,
        swimCrossingPeriods: rows.filter(function (r) { return r.kind === 'swim' && r.crosses; }).length,
        preChangeBlocks: rows.filter(function (r) { return r.kind === 'pre'; }).length,
        postChangeBlocks: rows.filter(function (r) { return r.kind === 'post'; }).length
      }
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
