// =============================================================================
// Every page that reads the camper roster reads the FULL state to get it.
//
// WHY THIS EXISTS. integration_hooks' setLocalSettings writes
// campGlobalSettings_v1 as a LITE snapshot: it `delete`s app1.camperRoster (and
// the other branches that grow without bound with camp size) so a large camp
// cannot blow localStorage's ~5MB ceiling. The complete state goes to IndexedDB,
// and window.loadGlobalSettings() is what returns it.
//
// So a page whose readGlobal() reads localStorage and stops there sees the roster
// exactly once — in the window between campistry_cloud_bootstrap.js writing the
// raw cloud keys and the first hydration replacing them — and never again. The
// symptoms are not subtle and they are not obviously bugs to whoever hits them:
//
//   campistry_snacks.js       no campers to deposit for, no accounts, no cash out
//   campistry_snacks_shop.js  an empty camper picker, so no order can be placed
//   campistry_health.js       an empty medication sheet, which reads as "none"
//   campistry_go_luggage.js   no camper to book luggage for
//
// campistry_live.js and campistry_live_locator.js already prefer the full state.
// The other four were found by tests/money_path.e2e.js — driving the real Snacks
// page in a browser, where the camper list came back empty — and fixed the same
// way. This is the check that keeps a fifth from arriving without it.
//
// campistry_snacks_pos.js is DELIBERATELY not on the list: its page loads neither
// integration_hooks.js nor local_cache_idb.js, so loadGlobalSettings does not
// exist there at all, and it reads its roster from the cloud itself through
// get_pos_roster (migration 104). A different answer to the same question.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

/** Files whose readGlobal() must consult the full state, and why each is here. */
const MUST_PREFER_FULL_STATE = {
    'campistry_snacks.js': 'the canteen: accounts, deposits, cash out',
    'campistry_snacks_shop.js': 'the Camp Shop order form’s camper picker',
    'campistry_health.js': 'medication, allergy and forms lists',
    'campistry_guard.js': 'who is at the pool, buddy pairs and pool clearance',
    'campistry_go_luggage.js': 'the luggage booking form',
    'campistry_live.js': 'roll call and attendance',
    'campistry_live_locator.js': 'where a camper is right now',
};

/** The one that answers it another way, and how. */
const READS_THE_CLOUD_INSTEAD = {
    'campistry_snacks_pos.js': 'get_pos_roster',
};

function read(f) { return fs.readFileSync(path.join(REPO, f), 'utf8'); }

/**
 * One function's body, bounded by its own braces.
 *
 * A fixed-size slice is not good enough here and the mutation run proved it: in
 * campistry_health.js the overlay helper is DEFINED immediately after readGlobal,
 * so a window of 2000 characters from `function readGlobal` still contained the
 * helper's name even with readGlobal itself reverted to a bare localStorage read.
 * The mutant survived. Brace matching stops at the right place.
 */
function bodyOf(src, name) {
    const at = src.indexOf('function ' + name);
    if (at < 0) return null;
    let i = src.indexOf('{', at);
    if (i < 0) return null;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
    }
    return src.slice(at);
}

/** Comments blanked, so prose about loadGlobalSettings is not read as a call. */
function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
              .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
}

/** Every file that defines its own readGlobal(), i.e. every candidate. */
function filesWithReadGlobal() {
    return fs.readdirSync(REPO)
        .filter(f => f.endsWith('.js'))
        .filter(f => /function readGlobal\s*\(/.test(code(read(f))))
        .sort();
}

test('every roster reader is classified', () => {
    const known = new Set([
        ...Object.keys(MUST_PREFER_FULL_STATE),
        ...Object.keys(READS_THE_CLOUD_INSTEAD),
    ]);
    const unclassified = filesWithReadGlobal().filter(f => !known.has(f));
    assert.deepStrictEqual(unclassified, [],
        'These files define their own readGlobal(). Say whether each one prefers the full '
        + 'state (window.loadGlobalSettings) or gets its roster from the cloud another way, '
        + 'and why — a reader that only looks at localStorage cannot see app1.camperRoster, '
        + 'because setLocalSettings strips it. See tests/money_path.e2e.js:\n  '
        + unclassified.join('\n  '));

    const gone = [...known].filter(f => !fs.existsSync(path.join(REPO, f))).sort();
    assert.deepStrictEqual(gone, [], 'No longer exists — strike these from the lists:\n  ' + gone.join('\n  '));
});

test('each one consults loadGlobalSettings inside readGlobal', () => {
    for (const [file, why] of Object.entries(MUST_PREFER_FULL_STATE)) {
        const src = code(read(file));
        const region = bodyOf(src, 'readGlobal');
        assert.ok(region, file + ' no longer defines readGlobal — re-read this test’s header');

        // readGlobal itself, or the helper it hands off to. Both shapes are in
        // use: Live returns the full state outright, the four later ones overlay
        // the roster onto the lite snapshot (their own key IS in localStorage and
        // is the fresher copy, so replacing the lot would undo a just-made edit).
        assert.match(region, /loadGlobalSettings\s*\(\s*\)|_withFullRoster\s*\(/,
            file + ' reads localStorage and stops. It needs the roster for ' + why
            + ', and setLocalSettings deletes app1.camperRoster from the lite snapshot, '
            + 'so this page will show nothing after the first cloud hydration.');
    }
});

test('the overlay helpers really read camperRoster off the full state', () => {
    // The shape of the fix, not just the presence of the name. A helper that
    // called loadGlobalSettings and then ignored what it returned would satisfy
    // the test above and fix nothing.
    for (const file of Object.keys(MUST_PREFER_FULL_STATE)) {
        const src = code(read(file));
        if (!/_withFullRoster/.test(src)) continue;      // the Live shape, checked below
        const body = bodyOf(src, '_withFullRoster');
        assert.ok(body, file + ' calls _withFullRoster but does not define it');
        // The CALL, not the name: every one of these helpers also has a
        // `typeof window.loadGlobalSettings !== 'function'` guard, so matching the
        // bare name passed even with the call itself removed.
        assert.match(body, /loadGlobalSettings\s*\(\s*\)/,
            file + ': _withFullRoster never actually calls loadGlobalSettings()');
        // And the roster has to come OFF that result. Matching a bare
        // `.camperRoster` anywhere in the body was not enough — the helper's own
        // `if (lite.app1 && lite.app1.camperRoster)` guard satisfied it while the
        // read itself had been redirected to another branch entirely, and that
        // mutant survived. Name the variable, then require the read to be on it.
        const held = body.match(/(?:var|let|const)\s+(\w+)\s*=\s*window\.loadGlobalSettings\s*\(\s*\)/);
        assert.ok(held, file + ': _withFullRoster does not keep what loadGlobalSettings returned');
        assert.match(body, new RegExp('\\b' + held[1] + '\\.app1[\\s\\S]{0,80}?camperRoster'),
            file + ': _withFullRoster calls loadGlobalSettings but does not read '
            + held[1] + '.app1.camperRoster out of the result');
    }
    for (const file of ['campistry_live.js', 'campistry_live_locator.js']) {
        const src = code(read(file));
        const body = bodyOf(src, 'readGlobal');
        assert.ok(body, file + ' no longer defines readGlobal');
        assert.match(body, /loadGlobalSettings\s*\(\s*\)/,
            file + ': readGlobal no longer calls loadGlobalSettings()');
    }
});

test('setLocalSettings still strips the roster, which is what makes all this necessary', () => {
    // The single fact every entry above rests on. If the lite snapshot ever stops
    // dropping app1.camperRoster, these overlays become harmless no-ops rather
    // than load-bearing — and this test should be deleted, not silently kept.
    const src = code(read('integration_hooks.js'));
    const at = src.indexOf('function setLocalSettings');
    assert.ok(at >= 0, 'integration_hooks no longer defines setLocalSettings');
    const body = src.slice(at, at + 4000);
    assert.match(body, /delete\s+lite\.app1\.camperRoster/,
        'setLocalSettings no longer strips app1.camperRoster from the localStorage snapshot. '
        + 'If that is intentional, the roster is in localStorage again and every overlay this '
        + 'test guards is now dead code — remove them and this file together.');
});

test('the register gets its roster from the cloud, not from a stripped snapshot', () => {
    // campistry_snacks_pos.js is exempt from the rule above, and this is the
    // reason. If it stopped fetching its own roster the exemption would be a hole.
    const src = code(read('campistry_snacks_pos.js'));
    // Quoted and exact: a rename to get_pos_roster_gone still contains the
    // substring, and did survive this check before it was tightened.
    assert.match(src, /rpc\(\s*'get_pos_roster'/,
        'campistry_snacks_pos.js no longer reads get_pos_roster. Its page loads neither '
        + 'integration_hooks.js nor local_cache_idb.js, so loadGlobalSettings does not exist '
        + 'there — without its own cloud fetch the register has no roster at all.');
});
