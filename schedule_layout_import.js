/**
 * schedule_layout_import.js — read a camp's existing template into a layout
 * =========================================================================
 *
 * Most camps already have their day written down somewhere: an Excel sheet or
 * a CSV that gets printed and taped to the office wall. Rather than asking
 * them to rebuild it by hand, this reads that file and works out the shape:
 *
 *   • which way time runs (a time-dense ROW means time runs across the top;
 *     a time-dense COLUMN means it runs down the side)
 *   • how many time rows there are — a camp that writes "11:00–12:00" on one
 *     row and "11:00 / 11:15 / 11:30" on the row beneath it gets BOTH, as two
 *     ruler tiers, because that's how they read it
 *   • whether the other axis lists grades or bunks, matched against the camp's
 *     actual structure where possible
 *
 * Inference is a starting point, not a verdict: the result always lands in the
 * Layout Designer's preview with notes on what was detected, so a wrong guess
 * is a two-click fix rather than a corrupted layout.
 *
 * XLSX is read directly — a .xlsx is a ZIP of XML, and the browser already has
 * an inflater (DecompressionStream) and an XML parser (DOMParser). That avoids
 * vendoring a spreadsheet library into a project with no build step.
 */
(function () {
  'use strict';

  function M() { return window.ScheduleLayout; }

  // =========================================================================
  // FILE READING
  // =========================================================================

  /** Prompt for a file, parse it, and resolve a draft layout. */
  function pickAndParse() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      input.style.display = 'none';
      document.body.appendChild(input);

      // A cancelled file dialog fires no event in most browsers, so the promise
      // is left pending until the element is cleaned up on the next open.
      input.onchange = function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(null); return; }
        parseFile(file).then(resolve).catch(function (err) {
          resolve({ error: 'Could not read that file: ' + (err && err.message ? err.message : err) });
        });
      };
      input.click();
    });
  }

  function parseFile(file) {
    var name = (file.name || '').toLowerCase();
    if (/\.xlsx$/.test(name)) {
      return file.arrayBuffer().then(readXlsx).then(function (grid) {
        return buildFromGrid(grid, file.name);
      });
    }
    return file.text().then(function (text) {
      return buildFromGrid(readDelimited(text), file.name);
    });
  }

  // --- CSV / TSV ------------------------------------------------------------

  /** Split delimited text into a grid, honouring quoted fields and newlines. */
  function readDelimited(text) {
    text = String(text).replace(/^﻿/, '');
    // Pick whichever delimiter appears more often outside quotes.
    var tabs = (text.match(/\t/g) || []).length;
    var commas = (text.match(/,/g) || []).length;
    var D = tabs > commas ? '\t' : ',';

    var rows = [], row = [], cell = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQ = false;
        } else cell += c;
        continue;
      }
      if (c === '"') { inQ = true; continue; }
      if (c === D) { row.push(cell); cell = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows.map(function (r) { return r.map(function (v) { return String(v == null ? '' : v).trim(); }); });
  }

  // --- XLSX ----------------------------------------------------------------

  function readXlsx(buffer) {
    var files = unzip(new Uint8Array(buffer));
    var sheetName = Object.keys(files).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); })
      .sort()[0];
    if (!sheetName) throw new Error('no worksheet found inside the workbook');

    return Promise.all([
      inflateEntry(files[sheetName]),
      files['xl/sharedStrings.xml'] ? inflateEntry(files['xl/sharedStrings.xml']) : Promise.resolve('')
    ]).then(function (parts) {
      var shared = parseSharedStrings(parts[1]);
      return parseSheet(parts[0], shared);
    });
  }

  /** Minimal ZIP central-directory reader: name -> {method, bytes}. */
  function unzip(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of central directory: scan back from the tail for its signature.
    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a valid .xlsx (no zip directory)');

    var count = dv.getUint16(eocd + 10, true);
    var dirOffset = dv.getUint32(eocd + 16, true);
    var out = {}, p = dirOffset;

    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

      // The local header repeats the name and carries its OWN extra-field
      // length, which often differs from the directory's — read it there.
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;

      out[name] = { method: method, bytes: bytes.subarray(dataStart, dataStart + compSize) };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function inflateEntry(entry) {
    if (!entry) return Promise.resolve('');
    if (entry.method === 0) return Promise.resolve(new TextDecoder().decode(entry.bytes));
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('this browser cannot unzip .xlsx files — save the sheet as CSV and import that instead'));
    }
    var stream = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.prototype.map.call(doc.getElementsByTagName('si'), function (si) {
      return Array.prototype.map.call(si.getElementsByTagName('t'), function (t) { return t.textContent; }).join('');
    });
  }

  function colToIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return 0;
    var n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }

  function parseSheet(xml, shared) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var rows = [];
    Array.prototype.forEach.call(doc.getElementsByTagName('row'), function (rowEl) {
      var rIdx = parseInt(rowEl.getAttribute('r'), 10);
      var out = [];
      Array.prototype.forEach.call(rowEl.getElementsByTagName('c'), function (c) {
        var ci = colToIndex(c.getAttribute('r'));
        var type = c.getAttribute('t');
        var val = '';
        if (type === 's') {
          var vEl = c.getElementsByTagName('v')[0];
          val = vEl ? (shared[parseInt(vEl.textContent, 10)] || '') : '';
        } else if (type === 'inlineStr') {
          val = Array.prototype.map.call(c.getElementsByTagName('t'), function (t) { return t.textContent; }).join('');
        } else {
          var v = c.getElementsByTagName('v')[0];
          val = v ? v.textContent : '';
          // Excel stores a clock time as a fraction of a day. Anything strictly
          // inside (0,1) in a sheet like this is a time, not a quantity.
          var num = parseFloat(val);
          if (val !== '' && isFinite(num) && num > 0 && num < 1) {
            val = M().fmtTime(Math.round(num * 1440));
          }
        }
        out[ci] = String(val == null ? '' : val).trim();
      });
      for (var k = 0; k < out.length; k++) if (out[k] == null) out[k] = '';
      rows[rIdx - 1] = out;
    });
    for (var r = 0; r < rows.length; r++) if (!rows[r]) rows[r] = [];
    // Square it off so column scans don't fall off short rows.
    var width = rows.reduce(function (w, r2) { return Math.max(w, r2.length); }, 0);
    return rows.map(function (r3) {
      var copy = r3.slice();
      while (copy.length < width) copy.push('');
      return copy;
    });
  }

  // =========================================================================
  // TIME RECOGNITION
  // =========================================================================

  var RANGE_RE = /^\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*(?:-|–|—|to|until|thru)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*$/i;
  var SINGLE_RE = /^\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*$/i;

  function normMeridiem(s) {
    return String(s).toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  }

  /**
   * Parse one clock token. Camp days sit roughly between 7am and 10pm, so a
   * bare "1:00" means the afternoon — reading it as 1am would put half the day
   * before breakfast.
   */
  function parseClock(tok, hint) {
    if (tok == null) return null;
    var s = normMeridiem(tok);
    if (!s) return null;
    var hasMeridiem = /[ap]m$/.test(s);
    var mins = M().parseTime(s);
    if (mins == null) return null;
    if (!hasMeridiem) {
      var h = Math.floor(mins / 60);
      if (h >= 1 && h <= 6) mins += 12 * 60;                       // 1:00–6:00 → afternoon
      else if (h === 12) { /* noon, leave it */ }
      else if (h === 0) mins += 12 * 60;
      if (hint != null && mins < hint && mins + 12 * 60 <= 23 * 60) {
        // Keep a row of times moving forward through the day.
        if (hint - mins > 60) mins += 12 * 60;
      }
    }
    return mins;
  }

  /** {start, end} for a range cell, {start} for a single time, null otherwise. */
  function readTimeCell(text, hint) {
    if (!text) return null;
    var m = RANGE_RE.exec(text);
    if (m) {
      var a = parseClock(m[1], hint);
      var b = parseClock(m[2], a != null ? a : hint);
      if (a != null && b != null && b > a) return { start: a, end: b };
      if (a != null && b != null && b <= a) return { start: a, end: b + 12 * 60 > a ? b + 12 * 60 : a + 60 };
      return null;
    }
    if (SINGLE_RE.test(text)) {
      var t = parseClock(text, hint);
      if (t != null) return { start: t };
    }
    return null;
  }

  /** Every time cell in a line, with its position. */
  function scanLine(cells) {
    var hits = [], hint = null;
    for (var i = 0; i < cells.length; i++) {
      var t = readTimeCell(cells[i], hint);
      if (t) { hits.push({ i: i, t: t, raw: cells[i] }); hint = t.end != null ? t.end : t.start; }
    }
    return hits;
  }

  // =========================================================================
  // INFERENCE
  // =========================================================================

  function column(grid, c) { return grid.map(function (r) { return r[c] || ''; }); }

  function buildFromGrid(grid, fileName) {
    var Mo = M();
    if (!Mo) return { error: 'Schedule layouts failed to load.' };
    grid = (grid || []).filter(function (r) { return r && r.some(function (c) { return String(c || '').trim() !== ''; }); });
    if (!grid.length) return { error: 'That file looks empty.' };

    var width = grid.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
    var notes = [];

    // Which rows / columns are dense with times?
    var rowHits = grid.map(function (r) { return scanLine(r); });
    var colHits = [];
    for (var c = 0; c < width; c++) colHits.push(scanLine(column(grid, c)));

    var bestRows = rowHits.map(function (h, i) { return { i: i, n: h.length, hits: h }; })
      .filter(function (x) { return x.n >= 3; }).sort(function (a, b) { return b.n - a.n; });
    var bestCols = colHits.map(function (h, i) { return { i: i, n: h.length, hits: h }; })
      .filter(function (x) { return x.n >= 3; }).sort(function (a, b) { return b.n - a.n; });

    var topRow = bestRows[0] ? bestRows[0].n : 0;
    var topCol = bestCols[0] ? bestCols[0].n : 0;
    if (!topRow && !topCol) {
      return { error: 'No times were found in that file. Make sure the sheet has a row or a column of times like "9:00am" or "11:00-12:00", then try again.' };
    }

    var horizontal = topRow >= topCol;
    notes.push(horizontal
      ? 'Found times running ACROSS a row, so time is set to run across the top.'
      : 'Found times running DOWN a column, so time is set to run down the side.');

    // Every line at least half as time-dense as the best becomes its own ruler
    // tier — that's how a camp writing hours on one row and quarter-hours on
    // the next keeps both.
    var lines = (horizontal ? bestRows : bestCols).filter(function (x) { return x.n >= Math.max(3, topRow && horizontal ? topRow / 2 : topCol / 2); });
    lines = lines.slice(0, 3).sort(function (a, b) { return a.i - b.i; });

    var timeLineIdx = lines.map(function (l) { return l.i; });
    var rulers = lines.map(function (line) { return tierFromHits(line.hits, grid, line.i, horizontal, notes); })
      .filter(Boolean);

    if (!rulers.length) return { error: 'The times in that file could not be turned into a usable schedule.' };

    // Coarsest tier first, so the ruler reads big-to-small like the sheet does.
    rulers.sort(function (a, b) { return spanOf(b) - spanOf(a); });

    // --- the other axis: grades or bunks? ---------------------------------
    var labels = otherAxisLabels(grid, horizontal, timeLineIdx);
    var axis = classifyAxis(labels, notes);

    var layout = Mo.normalize({
      id: Mo.uid(),
      name: fileName ? fileName.replace(/\.[^.]+$/, '') : 'Imported layout',
      builtIn: false,
      orientation: horizontal ? 'horizontal' : 'vertical',
      entityAxis: axis,
      rulers: rulers,
      pxPerMinute: horizontal ? 2.0 : 2.5,
      laneSize: axis === 'bunk' ? 54 : 84
    });

    return { layout: layout, fileName: fileName, notes: notes };
  }

  function spanOf(tier) {
    if (tier.kind === 'uniform') return tier.increment;
    var total = 0;
    tier.slots.forEach(function (s) { total += (s.end - s.start); });
    return tier.slots.length ? total / tier.slots.length : 0;
  }

  /**
   * Turn one line of time cells into a ruler tier. Evenly-spaced bare times
   * become a uniform tier; anything else (explicit ranges, uneven periods)
   * becomes a named-period tier, labelled from the neighbouring line when one
   * carries names like "Period 1".
   */
  function tierFromHits(hits, grid, lineIdx, horizontal, notes) {
    var Mo = M();
    var slots = [];

    var allRanges = hits.every(function (h) { return h.t.end != null; });
    if (allRanges) {
      hits.forEach(function (h) { slots.push({ start: h.t.start, end: h.t.end, label: '' }); });
    } else {
      // Bare times mark boundaries: each one runs until the next.
      var pts = hits.map(function (h) { return h.t.start; });
      for (var i = 0; i < pts.length - 1; i++) {
        if (pts[i + 1] > pts[i]) slots.push({ start: pts[i], end: pts[i + 1], label: '' });
      }
      if (slots.length && pts.length >= 2) {
        var lastLen = slots[slots.length - 1].end - slots[slots.length - 1].start;
        slots.push({ start: pts[pts.length - 1], end: pts[pts.length - 1] + lastLen, label: '' });
      }
    }
    if (!slots.length) return null;

    // Perfectly even and unnamed? That's an increment ruler, not a bell schedule.
    var lens = slots.map(function (s) { return s.end - s.start; });
    var even = lens.every(function (l) { return l === lens[0]; });
    var contiguous = slots.every(function (s, i) { return i === 0 || s.start === slots[i - 1].end; });

    var labels = labelsBeside(grid, lineIdx, hits, horizontal);
    var named = labels.some(function (l) { return l; });

    if (even && contiguous && !named) {
      notes.push('One time line is evenly spaced every ' + lens[0] + ' minutes — set up as an even-increment row.');
      return { id: Mo.uid('tier'), kind: 'uniform', increment: lens[0], label: '', align: true };
    }

    slots.forEach(function (s, i) { s.label = labels[i] || ('Period ' + (i + 1)); });
    notes.push('One time line has ' + slots.length + ' periods' + (named ? ' with names from the sheet' : '') + ' — set up as a named-period row.');
    return { id: Mo.uid('tier'), kind: 'periods', label: 'Periods', slots: slots };
  }

  /** Names sitting immediately before/after the time line, e.g. "Period 1". */
  function labelsBeside(grid, lineIdx, hits, horizontal) {
    var candidates = [lineIdx - 1, lineIdx + 1];
    for (var k = 0; k < candidates.length; k++) {
      var idx = candidates[k];
      if (idx < 0) continue;
      var line = horizontal ? (grid[idx] || []) : column(grid, idx);
      if (!line.length) continue;
      var vals = hits.map(function (h) { return String(line[h.i] || '').trim(); });
      var filled = vals.filter(function (v) { return v && !readTimeCell(v); });
      // Only trust it if most of the slots actually got a name.
      if (filled.length >= Math.ceil(hits.length * 0.6)) {
        return vals.map(function (v) { return readTimeCell(v) ? '' : v; });
      }
    }
    return hits.map(function () { return ''; });
  }

  /** Header labels on the non-time axis, skipping the time lines themselves. */
  function otherAxisLabels(grid, horizontal, timeLineIdx) {
    var skip = {};
    timeLineIdx.forEach(function (i) { skip[i] = true; });
    var out = [];
    if (horizontal) {
      // Time runs across, so the entities are the ROWS.
      for (var r = 0; r < grid.length; r++) {
        if (skip[r]) continue;
        var first = (grid[r] || []).find(function (v) { return String(v || '').trim(); });
        if (first && !readTimeCell(first)) out.push(String(first).trim());
      }
    } else {
      var width = grid.reduce(function (w, rr) { return Math.max(w, rr.length); }, 0);
      for (var c = 0; c < width; c++) {
        if (skip[c]) continue;
        var col = column(grid, c).find(function (v) { return String(v || '').trim(); });
        if (col && !readTimeCell(col)) out.push(String(col).trim());
      }
    }
    return out;
  }

  /** Match the sheet's labels against the camp's real grades and bunks. */
  function classifyAxis(labels, notes) {
    var divisions = window.divisions || {};
    var divNames = Object.keys(divisions);
    if (!divNames.length || !labels.length) {
      notes.push('Could not tell whether those rows are grades or bunks — set to grades; switch it above if that is wrong.');
      return 'division';
    }
    var norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
    var divSet = {}, bunkSet = {};
    divNames.forEach(function (d) {
      divSet[norm(d)] = true;
      (divisions[d].bunks || []).forEach(function (b) { bunkSet[norm(b)] = true; });
    });

    var divHits = 0, bunkHits = 0;
    labels.forEach(function (l) {
      var n = norm(l);
      if (divSet[n]) divHits++;
      if (bunkSet[n]) bunkHits++;
    });

    if (bunkHits > divHits && bunkHits >= 2) {
      notes.push('Matched ' + bunkHits + ' of those labels to your bunks, so each bunk gets its own lane.');
      return 'bunk';
    }
    if (divHits >= 1) {
      notes.push('Matched ' + divHits + ' of those labels to your grades, so each grade gets its own lane.');
      return 'division';
    }
    notes.push('None of those labels matched your camp structure — set to grades; switch it above if that is wrong.');
    return 'division';
  }

  window.ScheduleLayoutImport = {
    pickAndParse: pickAndParse,
    // exposed for tests
    _readDelimited: readDelimited,
    _buildFromGrid: buildFromGrid,
    _readTimeCell: readTimeCell,
    _unzip: unzip
  };
})();
