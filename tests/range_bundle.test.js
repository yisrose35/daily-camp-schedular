// =============================================================================
// range_bundle.test.js — migrations/APPLY_255_290.sql is the one file the owner
// pastes instead of 36. It is generated; this fails while it is out of date
// with the migrations it carries (a fix to 288 that never reached the bundle
// would never reach the database).
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('APPLY_255_290.sql matches the migrations it carries', (t) => {
    const r = spawnSync('python3', [path.join(__dirname, '..', 'scripts', 'build-range-bundle.py'), '--check', '255', '290'], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') return t.skip('python3 is not installed');
    assert.strictEqual(r.status, 0, (r.stderr || '') + (r.stdout || ''));
});

// Pasted from Windows, the SQL Editor sends CR LF line endings: a migration that
// patched a function by matching its text with a plain line break found
// nothing ("267: _merge_family_from_page does not look the way this file
// expects"). Every function text read in 255-290 is taken without CRs.
test('every migration in 255-290 reads a function\'s text without Windows line endings', () => {
    const fs = require('node:fs');
    const dir = path.join(__dirname, '..', 'migrations');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter(n => /^(25[5-9]|2[6-8]\d|290)_.*\.sql$/.test(n))) {
        const s = fs.readFileSync(path.join(dir, f), 'utf8');
        const all = (s.match(/(?<![\w.])pg_get_functiondef\(/g) || []).length;
        const wrapped = (s.match(/replace\(pg_get_functiondef\(/g) || []).length;
        if (all !== wrapped) bad.push(`${f}: ${all - wrapped} of ${all}`);
    }
    assert.deepStrictEqual(bad, [], 'pg_get_functiondef not wrapped in replace(…, chr(13), \'\')');
});
