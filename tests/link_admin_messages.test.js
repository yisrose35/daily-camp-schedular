// =============================================================================
// link_admin_messages.test.js — the Parents page speaks plainly when the
// database says no (261 made invitations office-only):
//   - "invite all" says WHY an invitation failed, not just "N failed";
//   - approving a join request never shows the raw code "not_camp_office";
//   - staff outside the office see "—", not a "No invite" that may be false.
// The real functions are cut from campistry_link_admin.html and run here.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'campistry_link_admin.html'), 'utf8');

function cut(name) {
    const start = HTML.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' is missing from campistry_link_admin.html');
    let i = HTML.indexOf('{', start), depth = 0;
    for (; i < HTML.length; i++) {
        if (HTML[i] === '{') depth++;
        else if (HTML[i] === '}' && --depth === 0) break;
    }
    return HTML.slice(start, i + 1);
}

function load() {
    const ctx = { _pgOfficeOnly: false };
    vm.createContext(ctx);
    vm.runInContext(cut('_pgReason') + '\n' + cut('_pgStatusBadge') + '\nthis._pgReason=_pgReason;this._pgStatusBadge=_pgStatusBadge;', ctx);
    return ctx;
}

test('a refusal from the database reads as plain words, never the raw code', () => {
    const c = load();
    const r = c._pgReason({ data: { success: false, error: 'not_camp_office' }, error: null });
    assert.doesNotMatch(r, /not_camp_office/);
    assert.match(r, /camp office/);
    assert.match(c._pgReason({ data: { error: 'not_authenticated' } }), /signed out/);
    assert.match(c._pgReason({ error: { message: 'Failed to fetch' } }), /connection/);
    assert.match(c._pgReason({ error: { message: 'This page is reloading: a camper was erased' } }), /reloading/);
});

test('join-request approval and "invite all" use those words', () => {
    assert.match(HTML, /toast\('Could not resolve the request: ' \+ _pgReason\(res\)\)/);
    assert.doesNotMatch(HTML, /Could not resolve: ' \+ \(\(res\.data && res\.data\.error\)/);
    const bulk = cut('bulkInviteAll');
    assert.match(bulk, /reasons\[why\]/, '"invite all" does not collect why each invitation failed');
    assert.match(bulk, /failed: ' \+ esc\(Object\.keys\(reasons\)/, '"invite all" does not show the reasons');
});

test('staff outside the office see "—", not "No invite"', () => {
    const c = load();
    const counters = { invited: 0, claimed: 0 };
    assert.match(c._pgStatusBadge(null, counters), /No invite/);
    c._pgOfficeOnly = true;
    const b = c._pgStatusBadge(null, counters);
    assert.doesNotMatch(b, /No invite/);
    assert.match(b, /—/);
    assert.match(HTML, /_pgOfficeOnly = !!\(res && res\.data && res\.data\.error === 'not_camp_office'\)/);
});
