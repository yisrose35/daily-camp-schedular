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
