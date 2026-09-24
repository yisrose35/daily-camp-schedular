// =============================================================================
// bundle_guard.test.js — TED-087. APPLY_BUNDLE.sql carries older versions of
// plan_due, settle_shop_order and record_autopay_charge; run on a database that
// has migration 262 or later it would undo them. Its FIRST statement must be
// the guard that stops the file there (pgtest 270 runs the guard itself).
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const B = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'APPLY_BUNDLE.sql'), 'utf8');

test('the retired bundle\'s first statement is the guard', () => {
    const body = B.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').trim();
    assert.ok(body.startsWith('DO $bundle_guard$'), 'something runs before the guard: ' + body.slice(0, 80));
    assert.match(body, /hold_autopay_charge\(uuid,text,text,jsonb\)/);
    assert.match(body, /RAISE EXCEPTION 'APPLY_BUNDLE\.sql is retired/);
});

test('the bundle no longer promises it is safe to re-run', () => {
    assert.ok(!/SAFE TO RE-RUN as often as/.test(B));
    assert.match(B, /RETIRED for any database that has migration 262 or later/);
});
