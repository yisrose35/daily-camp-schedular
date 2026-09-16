// node --test tests/camper_identity.test.js
//
// TWO CAMPERS MAY SHARE A NAME.
//
// This was blocked app-wide, not just in the canteen. `roster` is keyed by the
// camper's full name, and so is nearly everything downstream —
// `families[].camperIds`, `enrollments[].camperName`, `bunkAsgn[bunk]`,
// `snacks.accounts` and its ledger, the Go addresses, the print sheets — around
// 1,200 references across 45 client files and 88 server-side ones. So saveCamper
// had to refuse the second child outright:
//
//     if(!editingCamper && roster[full]){ toast('Already exists','error'); return }
//
// Without that guard the new record would be merged onto the existing one and two
// children would silently become one. With it, a camp cannot enrol two kids
// called the same thing.
//
// The fix keeps the key a STRING and keeps it unique: the first Malky Stein keeps
// `'Malky Stein'`, a second gets `'Malky Stein #102'` (her camperId) and carries
// `displayName`. Every existing lookup keeps working, because it was always
// looking up "the key" — the key just is not always identical to the name.
//
// Re-keying everything by camperId is the right endpoint and the wrong next step:
// ~1,200 call sites, many on paths that move money, all at once.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const I = require('../campistry_camper_identity.js');

// ── 1. the common case is untouched ───────────────────────────────────────

test('a camper with a free name gets their name as the key', () => {
    assert.strictEqual(I.uniqueKey({}, 'Malky Stein', 101), 'Malky Stein');
    assert.strictEqual(I.uniqueKey({ 'Shaya Stein': {} }, 'Malky Stein', 101), 'Malky Stein');
});

test('no existing camp ever sees a suffix', () => {
    // The whole point of not re-keying: every record already on file keeps the
    // key it has. Only a record that could not have existed before is suffixed.
    const roster = { 'Malky Stein': { camperId: 101 }, 'Shaya Stein': { camperId: 102 } };
    for (const k of Object.keys(roster)) assert.strictEqual(I.isSuffixed(k), false);
});

test('labelOf returns the name for an ordinary camper', () => {
    assert.strictEqual(I.labelOf({ camperId: 101 }, 'Malky Stein'), 'Malky Stein');
});

// ── 2. the duplicate ──────────────────────────────────────────────────────

test('a second camper with the same name gets a unique key from their id', () => {
    const roster = { 'Malky Stein': { camperId: 101 } };
    const key = I.uniqueKey(roster, 'Malky Stein', 102);
    assert.strictEqual(key, 'Malky Stein #102');
    assert.strictEqual(I.isSuffixed(key), true);
    assert.strictEqual(I.idFromKey(key), 102);
});

test('the suffixed key still resolves to the real name', () => {
    assert.strictEqual(I.labelOf({ displayName: 'Malky Stein' }, 'Malky Stein #102'),
        'Malky Stein');
    // And without displayName — an older record, or a caller that did not set it.
    assert.strictEqual(I.labelOf({}, 'Malky Stein #102'), 'Malky Stein',
        'the suffix must be stripped as a fallback, so no parent is ever shown it');
});

test('a THIRD camper with the same name also fits', () => {
    const roster = { 'Malky Stein': {}, 'Malky Stein #102': {} };
    assert.strictEqual(I.uniqueKey(roster, 'Malky Stein', 103), 'Malky Stein #103');
});

test('the id is used rather than a counter, so keys are stable', () => {
    // A counter would renumber when an earlier duplicate is deleted, silently
    // re-pointing every reference to the wrong child.
    const roster = { 'Malky Stein': {}, 'Malky Stein #102': {}, 'Malky Stein #103': {} };
    delete roster['Malky Stein #102'];
    assert.strictEqual(I.uniqueKey(roster, 'Malky Stein', 104), 'Malky Stein #104',
        'the next key comes from the new camper’s id, not from a position');
    assert.ok(roster['Malky Stein #103'], 'and #103 keeps their key');
});

test('a counter is the fallback only when there is no id at all', () => {
    const roster = { 'Malky Stein': {} };
    assert.strictEqual(I.uniqueKey(roster, 'Malky Stein', null), 'Malky Stein #2');
    // Refusing to record the child would be worse than an unstable key.
    assert.notStrictEqual(I.uniqueKey(roster, 'Malky Stein'), '');
});

test('an empty name yields no key — nothing to disambiguate', () => {
    assert.strictEqual(I.uniqueKey({}, '   ', 101), '');
    assert.strictEqual(I.uniqueKey({}, null, 101), '');
});

test('a key is never handed out twice', () => {
    const roster = {};
    for (const [name, id] of [['Malky Stein', 101], ['Malky Stein', 102],
                              ['Malky Stein', 103], ['Shaya Stein', 104]]) {
        const k = I.uniqueKey(roster, name, id);
        assert.ok(!(k in roster), 'collision on ' + k);
        roster[k] = { camperId: id, displayName: name };
    }
    assert.strictEqual(Object.keys(roster).length, 4);
    // All three Malkys are distinct records that all present as "Malky Stein".
    const malkys = Object.keys(roster).filter(k => I.labelOf(roster[k], k) === 'Malky Stein');
    assert.strictEqual(malkys.length, 3);
});

// ── 3. telling them apart on screen ───────────────────────────────────────

test('duplicates() finds every shared name', () => {
    const roster = {
        'Malky Stein': { camperId: 101 },
        'Malky Stein #102': { camperId: 102, displayName: 'Malky Stein' },
        'Shaya Stein': { camperId: 103 },
    };
    const d = I.duplicates(roster);
    assert.deepStrictEqual(Object.keys(d), ['Malky Stein']);
    assert.strictEqual(d['Malky Stein'].length, 2);
});

test('disambiguate adds a bunk when two share a name, and nothing when they do not', () => {
    const roster = {
        'Malky Stein': { camperId: 101, bunk: 'Maples' },
        'Malky Stein #102': { camperId: 102, displayName: 'Malky Stein', bunk: 'Willows' },
        'Shaya Stein': { camperId: 103, bunk: 'Maples' },
    };
    assert.strictEqual(I.disambiguate(roster, 'Malky Stein'), 'Malky Stein (Maples)');
    assert.strictEqual(I.disambiguate(roster, 'Malky Stein #102'), 'Malky Stein (Willows)');
    assert.strictEqual(I.disambiguate(roster, 'Shaya Stein'), 'Shaya Stein',
        'a unique name is shown plainly — no noise where there is no ambiguity');
});

test('disambiguate falls back to the camper id when there is no bunk', () => {
    const roster = {
        'Malky Stein': { camperId: 101 },
        'Malky Stein #102': { camperId: 102, displayName: 'Malky Stein' },
    };
    assert.strictEqual(I.disambiguate(roster, 'Malky Stein'), 'Malky Stein (#101)');
});

// ── 4. it is actually wired in ────────────────────────────────────────────

test('saveCamper no longer refuses a duplicate name outright', () => {
    const ME = read('campistry_me.js');
    const fn = ME.slice(ME.indexOf('function saveCamper(){'),
                        ME.indexOf('function cascadeCamperRename'));
    assert.ok(fn.length > 0, 're-anchor this test');

    // The line that blocked it.
    assert.ok(!/if\(!editingCamper&&roster\[full\]\)\{toast\('Already exists','error'\);return\}/.test(fn),
        'the hard refusal is back — two kids with the same name cannot be enrolled');

    assert.match(fn, /_dupKey=_ID\.uniqueKey\(roster,full,existingId\)/,
        'the unique key is no longer generated');
    assert.match(fn, /if\(_dupKey\)_core\.displayName=full;/,
        'displayName is not stamped — every screen would show the suffixed key');
    assert.match(fn, /roster\[_key\]=Object\.assign\(\{\},_oldRec,_core\)/,
        'the record is still written under the bare name, which would overwrite');
});

test('the unique key is chosen AFTER the camper id is settled', () => {
    // The suffix comes from camperId, so generating the key before the id exists
    // would fall back to the unstable counter every time.
    const ME = read('campistry_me.js');
    const idAt = ME.indexOf('if(!existingId){existingId=nextPersonId;nextPersonId++}');
    const keyAt = ME.indexOf('_dupKey=_ID.uniqueKey(roster,full,existingId)');
    assert.ok(idAt > 0 && keyAt > idAt,
        'the key is generated before the id is known — suffixes would be counters');
});

test('renaming onto an existing camper is still refused', () => {
    // Allowing DUPLICATES on create must not weaken the rename guard: renaming
    // Shaya onto Malky's key would still merge two children into one record.
    const ME = read('campistry_me.js');
    assert.match(ME, /if\(editingCamper&&editingCamper!==full&&roster\[full\]\)\{toast\('A camper named "'/,
        'the rename-collision guard is gone');
});

test('the identity module loads before campistry_me.js', () => {
    const html = read('campistry_me.html');
    const mod = html.indexOf('campistry_camper_identity.js');
    const me = html.indexOf('src="campistry_me.js');
    assert.ok(mod > 0, 'the identity module is not loaded — saveCamper falls back to refusing');
    assert.ok(mod < me, 'it must load first; saveCamper calls it');
});

test('saveCamper still refuses rather than throwing if the module is missing', () => {
    // campistry_me.js is loaded by eight pages and only some include the module.
    const ME = read('campistry_me.js');
    assert.match(ME, /if\(!_ID\)\{toast\('Already exists','error'\);return\}/,
        'a missing module would throw mid-save instead of degrading to the old refusal');
});

// ── 5. the canteen inherits the fix ───────────────────────────────────────

test('the canteen keys accounts off the roster KEY, so duplicates get two accounts', () => {
    // This is why the canteen needed no separate fix: its accounts and its ledger
    // are keyed by the roster key, which is now unique per child.
    for (const f of ['campistry_snacks.js', 'campistry_snacks_pos.js']) {
        const src = read(f);
        const fn = src.slice(src.indexOf('function getCamperList()'),
                             src.indexOf('function loadSnacksData()'));
        assert.match(fn, /label: \(data && data\.displayName\) \|\|/,
            f + ' does not carry a display label — the POS would show "Malky Stein #102"');
        assert.match(fn, /campers\.push\(\{ name/,
            f + ' no longer keys on the roster key');
    }
});

test('the POS shows the label but selects by the key', () => {
    const src = read('campistry_snacks_pos.js');
    assert.match(src, /const shown = c\.label \|\| c\.name;/, 'the POS has no display label');
    // The name cell is part of a longer literal ("camper-info" opens in the same
    // string), so anchor on the substring rather than a synthetic line start.
    assert.match(src, /class="camper-name">' \+ esc\(shown\)/,
        'the POS renders the raw key to the counter staff');
    // Identity — selection, accounts, ledger — must stay on the key.
    assert.match(src, /pickCamper\(\\'' \+ esc\(c\.name\)/,
        'selection moved off the unique key, which would break the account lookup');
    // And search must match what the user sees.
    assert.match(src, /\(c\.label \|\| c\.name\)\.toLowerCase\(\)\.includes\(q\)/,
        'searching by the visible name no longer works');
});

// ── 6. the display sweep ──────────────────────────────────────────────────
//
// A screen printing the roster key raw shows "Malky Stein #102". The rule is
// narrow and worth stating precisely, because getting it backwards is worse than
// the suffix: IDENTITY keeps the key — option values, data- attributes, account
// and ledger lookups, onclick arguments — and only VISIBLE TEXT is labelled.
// Labelling an option value would break the lookup it feeds.

const SWEPT = ['campistry_health.js', 'campistry_live.js', 'campistry_snacks.js',
               'campistry_snacks_pos.js', 'campistry_go.js', 'campistry_go_luggage.js'];

test('every swept file has the label helper, and it is a pure string function', () => {
    for (const f of SWEPT) {
        const src = read(f);
        assert.match(src, /function _lbl\(key\) \{ return String\(key == null \? '' : key\)\.replace\(\/\\s#\\d\+\$\/, ''\); \}/,
            f + ' has no label helper, or it is no longer a pure strip — a roster ' +
            'lookup here would be slower and could disagree with displayName');
    }
});

test('the helper strips only a trailing " #<digits>"', () => {
    assert.strictEqual(I.labelOf({}, 'Malky Stein #102'), 'Malky Stein');
    // Not a mid-string hash, not a non-numeric suffix.
    assert.strictEqual(I.labelOf({}, 'Malky #1 Stein'), 'Malky #1 Stein');
    assert.strictEqual(I.labelOf({}, 'Malky Stein #abc'), 'Malky Stein #abc');
    // displayName always wins when a record is in scope.
    assert.strictEqual(I.labelOf({ displayName: 'Bob #5' }, 'Bob #5 #110'), 'Bob #5');
});

test('an option VALUE keeps the key while its text is labelled', () => {
    // Labelling the value would point the picker at a camper that does not exist.
    const live = read('campistry_live.js');
    assert.match(live, /'<option value="' \+ esc\(n\) \+ '">' \+ esc\(_lbl\(n\)\) \+ '<\/option>'/,
        'the live picker labels its value or fails to label its text');

    const snacks = read('campistry_snacks.js');
    assert.match(snacks, /'<option value="' \+ esc\(c\.name\) \+ '">' \+ esc\(c\.label \|\| _lbl\(c\.name\)\)/,
        'the snacks picker no longer separates value from label');

    const lug = read('campistry_go_luggage.js');
    assert.match(lug, /value="' \+ esc\(c\.name\) \+ '"/, 'the luggage picker value moved off the key');
    assert.match(lug, /esc\(_lbl\(c\.name\)\) \+ \(c\.bunk/, 'its visible text is not labelled');
});

test('identity attributes and click handlers keep the raw key', () => {
    const live = read('campistry_live.js');
    assert.match(live, /data-camper="' \+ esc\(name\) \+ '"/,
        'data-camper was labelled — attendance would be recorded against a name, ' +
        'not a camper');
    const snacks = read('campistry_snacks.js');
    assert.match(snacks, /const jsName = esc\(c\.name\)\.replace/,
        'the account-history onclick was labelled — it would open the wrong account');
});

test('the camp name was NOT mistaken for a camper name', () => {
    // go.js renders esc(cn) in its printed route sheets, and `cn` there is the
    // CAMP name. Sweeping it as a camper would have mangled the report title.
    const go = read('campistry_go.js');
    assert.match(go, /<title>Bus Routes — ' \+ esc\(cn\)/,
        'the route-sheet title changed — check it is still the camp name, unlabelled');
    assert.ok(!/esc\(_lbl\(cn\)\)/.test(go),
        'the camp name is being run through the camper label helper');
});
