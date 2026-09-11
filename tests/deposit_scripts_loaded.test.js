// node --test tests/deposit_scripts_loaded.test.js
//
// A module that exists, is tested, is bundled into the edge function — and has
// no <script> tag on the page that needs it.
//
// That is exactly how campistry_deposit_template.js shipped: 84 tests green,
// the engine inlined into deposit-inbox correctly, and the Bank Layouts screen
// answering "The template engine did not load." Nothing in the test suite could
// see it, because every test requires the module directly.
//
// The second half is just as quiet. campistry_me.html cache-busts each script
// with ?v=<date>. Change a module and leave the version alone and the browser
// serves yesterday's copy indefinitely — the code is right, deployed, and not
// running.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'campistry_me.html');

// Every module the deposits feature needs in the browser.
const REQUIRED = [
    'campistry_deposit_parser.js',
    'campistry_deposit_match.js',
    'campistry_deposit_template.js',
    'campistry_deposits_ui.js'
];

function tags(html) {
    const out = {};
    const re = /<script src="([^"?]+)(?:\?v=([^"]*))?"><\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) out[m[1]] = m[2] || '';
    return out;
}

test('every deposit module the browser needs has a script tag', () => {
    const found = tags(fs.readFileSync(PAGE, 'utf8'));
    const missing = REQUIRED.filter(f => !(f in found));
    assert.deepStrictEqual(missing, [],
        'missing from campistry_me.html: ' + missing.join(', '));
});

test('the UI loads after the modules it reads off window', () => {
    // The UI resolves window.CampistryDepositTemplate lazily, so order is not
    // strictly required today — but a later top-level read would break silently
    // and only in a browser, which no other test here can catch.
    const html = fs.readFileSync(PAGE, 'utf8');
    const order = REQUIRED.map(f => html.indexOf('src="' + f));
    const ui = order[order.length - 1];
    order.slice(0, -1).forEach((pos, i) => {
        assert.ok(pos >= 0 && pos < ui, REQUIRED[i] + ' must load before the UI');
    });
});

test('a module changed today is not still served on an older cache-bust', () => {
    // ?v= is the only thing standing between a deploy and a browser that keeps
    // running the previous version. It does not have to be a date — it just has
    // to change when the file does.
    const found = tags(fs.readFileSync(PAGE, 'utf8'));
    const versions = REQUIRED.map(f => found[f]).filter(Boolean);
    assert.strictEqual(versions.length, REQUIRED.length,
        'every deposit script needs a ?v= cache-bust');
    assert.strictEqual(new Set(versions).size, 1,
        'the deposit modules ship together and must share one ?v=, or a stale ' +
        'mix of versions can run side by side: ' + JSON.stringify(found));
});
