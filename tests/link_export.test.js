// node --test tests/link_export.test.js
// Validates the Campistry Link spreadsheet export helper:
//   • CSV quoting/escaping rules
//   • XLSX package structure (ZIP headers, CRC-32, EOCD) and sheet XML content
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const LinkExport = require('../campistry_link_export.js');

test('CSV: plain cells join with commas and CRLF', () => {
    const csv = LinkExport.toCSV(['A', 'B'], [['1', '2'], ['3', '4']]);
    assert.strictEqual(csv, 'A,B\r\n1,2\r\n3,4');
});

test('CSV: quotes, commas, and newlines are escaped', () => {
    const csv = LinkExport.toCSV(['Q'], [['He said "hi", twice\nnew line']]);
    assert.strictEqual(csv, 'Q\r\n"He said ""hi"", twice\nnew line"');
});

test('CSV: null/undefined become empty cells', () => {
    const csv = LinkExport.toCSV(['A', 'B', 'C'], [[null, undefined, 'x']]);
    assert.strictEqual(csv.split('\r\n')[1], ',,x');
});

test('colRef: A1-style column letters', () => {
    assert.strictEqual(LinkExport._colRef(0), 'A');
    assert.strictEqual(LinkExport._colRef(25), 'Z');
    assert.strictEqual(LinkExport._colRef(26), 'AA');
    assert.strictEqual(LinkExport._colRef(27), 'AB');
    assert.strictEqual(LinkExport._colRef(701), 'ZZ');
    assert.strictEqual(LinkExport._colRef(702), 'AAA');
});

test('sheet XML: strings are inline, numbers are numeric, XML is escaped', () => {
    const xml = LinkExport._sheetXML(['Name', 'Count'], [['<Eli & "Co">', 7]]);
    assert.ok(xml.includes('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>'));
    assert.ok(xml.includes('<c r="B2"><v>7</v></c>'));
    assert.ok(xml.includes('&lt;Eli &amp; &quot;Co&quot;&gt;'));
    assert.ok(!xml.includes('<Eli'));
});

// ─── XLSX / ZIP structure ────────────────────────────────────────────────────

function readU32(buf, off) { return buf.readUInt32LE(off); }
function readU16(buf, off) { return buf.readUInt16LE(off); }

/** Minimal stored-ZIP reader: returns { name: Buffer } */
function unzipStored(bytes) {
    const buf = Buffer.from(bytes);
    // Find EOCD (no comment → last 22 bytes)
    const eocdOff = buf.length - 22;
    assert.strictEqual(readU32(buf, eocdOff), 0x06054b50, 'EOCD signature');
    const count = readU16(buf, eocdOff + 10);
    const cdOff = readU32(buf, eocdOff + 16);

    const files = {};
    let p = cdOff;
    for (let i = 0; i < count; i++) {
        assert.strictEqual(readU32(buf, p), 0x02014b50, 'central dir signature');
        const method = readU16(buf, p + 10);
        const crc = readU32(buf, p + 16);
        const csize = readU32(buf, p + 20);
        const nameLen = readU16(buf, p + 28);
        const extraLen = readU16(buf, p + 30);
        const commentLen = readU16(buf, p + 32);
        const localOff = readU32(buf, p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        assert.strictEqual(method, 0, name + ': stored method');

        // Local header
        assert.strictEqual(readU32(buf, localOff), 0x04034b50, name + ': local signature');
        const lNameLen = readU16(buf, localOff + 26);
        const lExtraLen = readU16(buf, localOff + 28);
        const dataOff = localOff + 30 + lNameLen + lExtraLen;
        const data = buf.slice(dataOff, dataOff + csize);
        assert.strictEqual(zlib.crc32 ? zlib.crc32(data) >>> 0 : crc, crc, name + ': CRC-32 matches');
        files[name] = data;
        p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}

test('XLSX: package contains the five OOXML parts with valid ZIP records', () => {
    const bytes = LinkExport.makeXLSX('Responses', ['Camper', 'Answer'], [['Eli Miller', 'Yes']]);
    const files = unzipStored(bytes);
    const names = Object.keys(files).sort();
    assert.deepStrictEqual(names, [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml'
    ].sort());

    const wb = files['xl/workbook.xml'].toString('utf8');
    assert.ok(wb.includes('<sheet name="Responses" sheetId="1"'));

    const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.ok(sheet.includes('Eli Miller'));
    assert.ok(sheet.includes('<row r="2">'));
});

test('XLSX: sheet name is truncated to 31 chars and escaped', () => {
    const longName = 'A very long & <unsafe> sheet name well over the limit';
    const files = unzipStored(LinkExport.makeXLSX(longName, ['x'], []));
    const wb = files['xl/workbook.xml'].toString('utf8');
    const m = wb.match(/<sheet name="([^"]*)"/);
    assert.ok(m, 'sheet name present');
    assert.ok(!m[1].includes('<'));
    // 31 source chars, before XML escaping
    assert.strictEqual(longName.slice(0, 31), 'A very long & <unsafe> sheet na');
    assert.ok(m[1].startsWith('A very long &amp; &lt;unsafe'));
});

test('XLSX: empty rows and sparse cells do not break the package', () => {
    const bytes = LinkExport.makeXLSX('S', ['A', 'B', 'C'], [[null, 'mid', ''], [], ['end']]);
    const files = unzipStored(bytes);
    const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.ok(sheet.includes('<c r="B2"'), 'sparse cell keeps its column ref');
    assert.ok(sheet.includes('<row r="3">'), 'empty row still emitted');
    assert.ok(sheet.includes('<c r="A4"'));
});
