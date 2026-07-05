// =============================================================================
// campistry_link_export.js — Campistry Link spreadsheet export v1.0
//
// Turns form responses (or any tabular data) into downloadable spreadsheets,
// Google-Forms style:
//   • CSV  — opens in Google Sheets, Excel, Numbers (UTF-8 BOM for Excel)
//   • XLSX — a real Excel workbook, generated with zero dependencies
//            (minimal OOXML package in a stored ZIP, hand-rolled CRC-32)
//
// API (window.LinkExport):
//   toCSV(headers, rows)                       → csv string
//   downloadCSV(filename, headers, rows)       → triggers browser download
//   makeXLSX(sheetName, headers, rows)         → Uint8Array (.xlsx bytes)
//   downloadXLSX(filename, sheetName, headers, rows)
//
// rows: array of arrays; cells may be string/number/null/undefined.
// Also exported for Node (unit tests): module.exports = LinkExport.
// =============================================================================
(function() {
    'use strict';

    var LinkExport = {};

    // ─── CSV ──────────────────────────────────────────────────────────────────
    function _csvCell(v) {
        if (v == null) return '';
        var s = String(v);
        if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    LinkExport.toCSV = function(headers, rows) {
        var lines = [];
        if (headers && headers.length) lines.push(headers.map(_csvCell).join(','));
        (rows || []).forEach(function(r) { lines.push((r || []).map(_csvCell).join(',')); });
        return lines.join('\r\n');
    };

    // ─── XLSX ─────────────────────────────────────────────────────────────────
    // A .xlsx file is a ZIP of XML parts. We generate the five required parts
    // with inline strings (no sharedStrings table) and pack them with the ZIP
    // "stored" method (no compression), which needs only a CRC-32.

    var _CRC_TABLE = (function() {
        var t = new Int32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c;
        }
        return t;
    })();

    function _crc32(bytes) {
        var c = -1;
        for (var i = 0; i < bytes.length; i++) c = (c >>> 8) ^ _CRC_TABLE[(c ^ bytes[i]) & 0xFF];
        return (c ^ -1) >>> 0;
    }

    function _utf8(str) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
        // Node < 11 fallback
        return new Uint8Array(Buffer.from(str, 'utf8'));
    }

    function _xmlEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            // strip control chars that are illegal in XML 1.0
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    }

    /** Column index (0-based) → A1-style letters */
    function _colRef(i) {
        var s = '';
        i = i + 1;
        while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
        return s;
    }

    function _sheetXML(headers, rows) {
        var all = [];
        if (headers && headers.length) all.push({ cells: headers, header: true });
        (rows || []).forEach(function(r) { all.push({ cells: r || [] }); });

        var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
        all.forEach(function(row, ri) {
            xml += '<row r="' + (ri + 1) + '">';
            row.cells.forEach(function(v, ci) {
                if (v == null || v === '') return;
                var ref = _colRef(ci) + (ri + 1);
                if (typeof v === 'number' && isFinite(v)) {
                    xml += '<c r="' + ref + '"><v>' + v + '</v></c>';
                } else {
                    xml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + _xmlEsc(v) + '</t></is></c>';
                }
            });
            xml += '</row>';
        });
        xml += '</sheetData></worksheet>';
        return xml;
    }

    function _num(view, offset, value, bytes) {
        for (var i = 0; i < bytes; i++) view[offset + i] = (value >>> (8 * i)) & 0xFF;
    }

    /** Build a stored (uncompressed) ZIP from [{name, data:Uint8Array}] */
    function _zip(files) {
        // Fixed DOS timestamp (2026-01-01 00:00) — deterministic output
        var dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

        var localParts = [], centralParts = [], offset = 0;
        files.forEach(function(f) {
            var nameBytes = _utf8(f.name);
            var crc = _crc32(f.data);
            var local = new Uint8Array(30 + nameBytes.length);
            _num(local, 0, 0x04034b50, 4);        // local file header signature
            _num(local, 4, 20, 2);                // version needed
            _num(local, 6, 0x0800, 2);            // flags: UTF-8 names
            _num(local, 8, 0, 2);                 // method: stored
            _num(local, 10, dosTime, 2);
            _num(local, 12, dosDate, 2);
            _num(local, 14, crc, 4);
            _num(local, 18, f.data.length, 4);    // compressed size
            _num(local, 22, f.data.length, 4);    // uncompressed size
            _num(local, 26, nameBytes.length, 2);
            _num(local, 28, 0, 2);                // extra length
            local.set(nameBytes, 30);
            localParts.push(local, f.data);

            var central = new Uint8Array(46 + nameBytes.length);
            _num(central, 0, 0x02014b50, 4);      // central directory signature
            _num(central, 4, 20, 2);              // version made by
            _num(central, 6, 20, 2);              // version needed
            _num(central, 8, 0x0800, 2);          // flags
            _num(central, 10, 0, 2);              // method
            _num(central, 12, dosTime, 2);
            _num(central, 14, dosDate, 2);
            _num(central, 16, crc, 4);
            _num(central, 20, f.data.length, 4);
            _num(central, 24, f.data.length, 4);
            _num(central, 28, nameBytes.length, 2);
            // extra/comment/disk/attrs all zero (30..41)
            _num(central, 42, offset, 4);         // local header offset
            central.set(nameBytes, 46);
            centralParts.push(central);

            offset += local.length + f.data.length;
        });

        var centralSize = centralParts.reduce(function(s, p) { return s + p.length; }, 0);
        var eocd = new Uint8Array(22);
        _num(eocd, 0, 0x06054b50, 4);             // end of central directory
        _num(eocd, 8, files.length, 2);
        _num(eocd, 10, files.length, 2);
        _num(eocd, 12, centralSize, 4);
        _num(eocd, 16, offset, 4);                // central directory offset

        var total = offset + centralSize + eocd.length;
        var out = new Uint8Array(total);
        var pos = 0;
        localParts.concat(centralParts, [eocd]).forEach(function(p) { out.set(p, pos); pos += p.length; });
        return out;
    }

    LinkExport.makeXLSX = function(sheetName, headers, rows) {
        var name = _xmlEsc((sheetName || 'Responses').slice(0, 31));
        var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
            '</Types>';
        var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '</Relationships>';
        var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            '<sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
        var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
            '</Relationships>';

        return _zip([
            { name: '[Content_Types].xml',        data: _utf8(contentTypes) },
            { name: '_rels/.rels',                data: _utf8(rootRels) },
            { name: 'xl/workbook.xml',            data: _utf8(workbook) },
            { name: 'xl/_rels/workbook.xml.rels', data: _utf8(workbookRels) },
            { name: 'xl/worksheets/sheet1.xml',   data: _utf8(_sheetXML(headers, rows)) }
        ]);
    };

    // ─── Browser downloads ────────────────────────────────────────────────────
    function _downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    }

    LinkExport.downloadCSV = function(filename, headers, rows) {
        var csv = LinkExport.toCSV(headers, rows);
        _downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }), filename);
    };

    LinkExport.downloadXLSX = function(filename, sheetName, headers, rows) {
        var bytes = LinkExport.makeXLSX(sheetName, headers, rows);
        _downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
    };

    // Internals exposed for unit tests
    LinkExport._crc32 = _crc32;
    LinkExport._sheetXML = _sheetXML;
    LinkExport._colRef = _colRef;
    LinkExport._zip = _zip;

    if (typeof window !== 'undefined') window.LinkExport = LinkExport;
    if (typeof module !== 'undefined' && module.exports) module.exports = LinkExport;
})();
