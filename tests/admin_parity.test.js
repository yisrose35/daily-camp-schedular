const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ─── an admin is an owner, except where it must not be ───────────────────────
//
// The capability layer (campistry_capabilities.js) and the section gate
// (campistry_access_sections.js) have always treated admin as owner. What had
// not kept up were the scattered `role === 'owner'` checks in the page code,
// and each one quietly removed something an office admin is there to do —
// most visibly the whole Team & Access tab, so an admin could not add a
// counselor or fix a permission.
//
// This pins the decision down in both directions: the list of things that stay
// the owner's alone is short, deliberate, and everything else includes admin.

// The owner's alone, with the reason. Adding to this list should be an
// argument, not an accident.
const OWNER_ONLY = [
    // Irreversible destruction of the camp's entire history.
    { file: 'calendar.js', match: /erase all camp data/i },
    // Decides which bank account the camp's money is paid into.
    { file: 'dashboard.js', match: /Only the camp owner can connect Stripe/ },
];

function ownerGates(file) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    const out = [];
    src.forEach((ln, i) => {
        if (!/['"]owner['"]/.test(ln)) return;
        if (!/===|!==|==/.test(ln)) return;
        const near = [src[i - 1] || '', ln, src[i + 1] || ''].join('\n');
        if (/admin/.test(near)) return;                     // admin is included
        out.push({ line: i + 1, text: ln.trim() });
    });
    return out;
}

test('the page code lets an admin do what an admin is for', () => {
    for (const file of ['dashboard.js', 'rbac_integration.js']) {
        const gates = ownerGates(file);
        assert.deepStrictEqual(gates.map(g => `${file}:${g.line}  ${g.text}`), [],
            'these still shut an admin out — include admin, or add them to OWNER_ONLY with a reason');
    }
});

test('the short list of owner-only powers is still owner-only', () => {
    // The other direction: widening admin must never quietly hand over the
    // two things that genuinely belong to whoever owns the camp.
    for (const { file, match } of OWNER_ONLY) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.match(src, match, file + ' lost its owner-only guard');
    }
    const cal = fs.readFileSync(path.join(ROOT, 'calendar.js'), 'utf8');
    const erase = cal.slice(cal.indexOf('erase all camp data') - 400, cal.indexOf('erase all camp data') + 200);
    assert.match(erase, /role !== 'owner'/);
    assert.ok(!/admin/.test(erase), 'erasing the camp must not accept an admin');
});

test('the capability layer already agreed, and still does', () => {
    const caps = fs.readFileSync(path.join(ROOT, 'campistry_capabilities.js'), 'utf8');
    assert.match(caps, /access\.role === 'owner' \|\| access\.role === 'admin'/);
    // Entitlements still sit above the bypass: what the camp BOUGHT is not a
    // permission, and it has to hold for an owner too.
    const resolve = caps.slice(caps.indexOf('C.resolve = function'));
    const entAt = resolve.indexOf('if (!C.entitled(cap, access.entitlements)) return');
    const bypassAt = resolve.indexOf("access.role === 'owner' || access.role === 'admin'");
    assert.ok(entAt > 0 && entAt < bypassAt,
        'the entitlement check must stay above the owner/admin bypass');
});
