/* swim_debug.js — diagnostic console for swim+change placement
 *
 * After Auto Build runs, open browser console and use:
 *   swimDebug.help()         — list commands
 *   swimDebug.dump()         — pretty-printed table of every bunk's swim/change
 *   swimDebug.report()       — single JSON blob to copy/paste back to assistant
 *   swimDebug.config()       — pre/swim/post settings per grade (from active layers)
 *   swimDebug.periods()      — current bell-schedule period boundaries
 *   swimDebug.bunk('A1')     — deep dive on one bunk
 *   swimDebug.expected({...})— record what user EXPECTED, included in report()
 *   swimDebug.clearExpected()— wipe expectations
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
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function range(b) {
    if (!b) return '—';
    return hh(mm(b.start)) + '–' + hh(mm(b.end)) + ' (' + (mm(b.end) - mm(b.start)) + 'm)';
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
    }).filter(function (p) { return p.start != null && p.end != null; });
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

  var _expected = {};

  var swimDebug = {
    help: function () {
      var lines = [
        'swimDebug commands:',
        '  swimDebug.dump()       — table of every swim/change block',
        '  swimDebug.report()     — JSON blob (copy this and paste to assistant)',
        '  swimDebug.config()     — layer settings (pre/swim/post) per grade',
        '  swimDebug.periods()    — period boundaries per grade',
        '  swimDebug.bunk("A1")   — deep dive on one bunk',
        '  swimDebug.expected({bunk:"A1", pre:"11:20-11:30", swim:"11:30-12:10", post:"12:15-12:25"})',
        '  swimDebug.clearExpected()',
        '',
        'Workflow:',
        '  1. Run an auto build.',
        '  2. swimDebug.dump()  — see what was placed.',
        '  3. swimDebug.expected({...}) for any bunks you want to flag.',
        '  4. swimDebug.report()  — copy the printed JSON.',
        '  5. Paste it back to the assistant.'
      ];
      console.log(lines.join('\n'));
      return lines.join('\n');
    },

    dump: function () {
      var rows = allRows();
      if (!rows.length) {
        console.warn('swimDebug.dump: no swim/change blocks found in window._bunkTimelines. Run an auto build first.');
        return [];
      }
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
      return rows;
    },

    config: function () {
      var layers = getActiveLayers();
      var divs = getDivisions();
      var grades = Object.keys(divs);
      var out = [];
      grades.forEach(function (g) {
        var L = layerForGrade(g, 'swim');
        if (!L) return;
        out.push({
          grade: g,
          mode: L.mode || L.placement || '?',
          preChangeMin: L.preChangeMin || 0,
          periodMin: L.periodMin || L.dMax || L.dMin || 40,
          postChangeMin: L.postChangeMin || 0,
          dMin: L.dMin,
          dMax: L.dMax
        });
      });
      console.table(out);
      return out;
    },

    periods: function () {
      var divs = getDivisions();
      var grades = Object.keys(divs);
      var out = {};
      grades.forEach(function (g) {
        out[g] = periodsForGrade(g).map(function (p) {
          return 'P' + p.idx + ' ' + hh(p.start) + '–' + hh(p.end) + ' (' + (p.end - p.start) + 'm)';
        });
      });
      console.log('Periods per grade:');
      Object.keys(out).forEach(function (g) {
        console.log('  ' + g + ':\n    ' + out[g].join('\n    '));
      });
      return out;
    },

    bunk: function (name) {
      var tl = getTimelines();
      if (!tl[name]) {
        console.warn('No timeline for bunk', name, '. Available:', Object.keys(tl));
        return null;
      }
      var blocks = tl[name].slice().sort(function (a, b) { return mm(a.start) - mm(b.start); });
      console.log('Bunk', name, 'grade=', gradeOf(name));
      console.log('Periods:', periodsForGrade(gradeOf(name)).map(function (p) {
        return 'P' + p.idx + ' ' + hh(p.start) + '–' + hh(p.end);
      }).join('  '));
      console.table(blocks.map(function (b) {
        return {
          type: b.type || b.activity,
          start: hh(mm(b.start)),
          end: hh(mm(b.end)),
          dur: mm(b.end) - mm(b.start),
          period: findPeriod(gradeOf(name), mm(b.start)),
          merged: !!b._mergedIntoSwim,
          attached: !!b._changeAttached
        };
      }));
      return blocks;
    },

    expected: function (obj) {
      if (!obj || !obj.bunk) {
        console.warn('Usage: swimDebug.expected({bunk:"A1", pre:"11:20-11:30", swim:"11:30-12:10", post:"12:15-12:25"})');
        return;
      }
      _expected[obj.bunk] = {
        pre: obj.pre || null,
        swim: obj.swim || null,
        post: obj.post || null,
        notes: obj.notes || null
      };
      console.log('Recorded expectation for', obj.bunk, _expected[obj.bunk]);
      return _expected[obj.bunk];
    },

    clearExpected: function () { _expected = {}; console.log('Expectations cleared.'); },

    report: function () {
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

      var divs = getDivisions();
      var configByGrade = {};
      Object.keys(divs).forEach(function (g) {
        var L = layerForGrade(g, 'swim');
        if (L) {
          configByGrade[g] = {
            mode: L.mode || L.placement || null,
            preChangeMin: L.preChangeMin || 0,
            periodMin: L.periodMin || L.dMax || L.dMin || 40,
            postChangeMin: L.postChangeMin || 0,
            dMin: L.dMin || null,
            dMax: L.dMax || null
          };
        }
      });

      var periodsByGrade = {};
      Object.keys(divs).forEach(function (g) {
        periodsByGrade[g] = periodsForGrade(g);
      });

      var report = {
        generatedAt: new Date().toISOString(),
        configByGrade: configByGrade,
        periodsByGrade: periodsByGrade,
        bunks: byBunk,
        expected: _expected,
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
      console.log('=== swimDebug.report ===');
      console.log('Copy everything between the markers below and paste it to the assistant:');
      console.log('---BEGIN-SWIM-REPORT---');
      console.log(json);
      console.log('---END-SWIM-REPORT---');
      try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json).then(function () {
            console.log('(report also copied to clipboard)');
          }, function () {});
        }
      } catch (e) {}
      return report;
    }
  };

  window.swimDebug = swimDebug;
  console.log('[swim_debug] loaded — run swimDebug.help() for commands.');
})();
