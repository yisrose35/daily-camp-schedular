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

test('an admin can reach the forms and the messages', () => {
    // The two things reported as missing. Both resolve to full access for an
    // admin already — the capability layer has always said so — but nothing
    // held it there, and it is exactly the kind of thing a later `role ===
    // "owner"` shortcut takes away without anyone noticing.
    //
    // me.enrollment is where the POST-ACCEPTANCE FORM lives: the Customize
    // Forms menu is drawn behind _pplCanEdit('me.enrollment'), and the builder
    // itself has no gate of its own.
    global.window = {};
    delete require.cache[require.resolve(path.join(ROOT, 'campistry_capabilities.js'))];
    require(path.join(ROOT, 'campistry_capabilities.js'));
    const C = global.window.CampistryCapabilities;
    assert.ok(C, 'the capability registry must load');

    const MUST_HAVE = ['me.enrollment', 'link.messages', 'live.activity', 'me.campers', 'me.billing'];
    for (const key of MUST_HAVE) {
        assert.strictEqual(C.resolve(key, { role: 'admin', entitlements: {} }), 'edit',
            'an admin must keep full access to ' + key);
    }

    // The post-acceptance builder really is behind that one capability and
    // nothing stricter, so the assertion above is worth something.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /var editReg=_pplCanEdit\('me\.enrollment'\);/);
    const menu = me.slice(me.indexOf("var editReg=_pplCanEdit('me.enrollment');"),
                          me.indexOf("var editReg=_pplCanEdit('me.enrollment');") + 1400);
    assert.match(menu, /openPostAcceptFormConfig\(\)/,
        'the Post-Acceptance Form entry must sit behind editReg, not an owner check');
    const opener = me.slice(me.indexOf('function openFormBuilder(kind){'),
                            me.indexOf('function openFormBuilder(kind){') + 900);
    assert.ok(!/'owner'/.test(opener), 'the form builder must not gate on owner');

    // And a camp that did not buy the app still cannot reach it, admin or not.
    assert.strictEqual(C.resolve('me.enrollment', { role: 'admin', entitlements: { link: '*' } }), 'none',
        'entitlements still outrank the admin bypass');
});
