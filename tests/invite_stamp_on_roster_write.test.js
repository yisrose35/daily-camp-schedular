// =============================================================================
// Every path that brings a camper INTO EXISTENCE refreshes their family's invite.
//
// WHY THIS EXISTS. A parent invite's camper list is stamped with camper ids when
// it is written (migration 223), and migration 232 stopped a null slot being
// re-resolved by name at check time. That was the right call — "a matching name
// that appeared later" cannot be told apart from "a different child with the same
// name who appeared later", and the second one shows a parent somebody else's
// child — but it makes the ORDER of two ordinary clicks matter:
//
//   1. Accept  → updateEnrollStatus(id,'accepted') generates the invite and emails
//                the parent. No roster entry exists yet, so no camp_people row, so
//                223 stamps a NULL in that camper's slot.
//   2. Enroll  → enrollCamper(id) creates the roster entry. The camp_people row is
//                born now, with first_seen AFTER the invite's stamp.
//
// Between those, and until something rewrites the invite's camper list, the parent
// logs in and their own child is not there. saveCamper refreshed the invite;
// enrollCamper did not, so the accept-then-enroll flow — the normal one — left the
// parent staring at an empty portal until somebody happened to open that camper in
// the Me page.
//
// So: every function that creates a roster entry is listed here with what it does
// about the invite, and a missing entry fails rather than being assumed benign.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');

/** Comments blanked, so prose naming the helper is not read as a call. */
function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
              .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
}

/** One top-level `function name(...) { … }`, bounded by its own braces. */
function bodyOf(src, name) {
    const at = src.indexOf('function ' + name + '(');
    if (at < 0) return null;
    let i = src.indexOf('{', at);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
    }
    return src.slice(at);
}

/**
 * How each roster-creating path handles the invite.
 *
 *   'refreshes'  — calls _syncInvitesForCamper, so the stamp catches up. Checked.
 *   'no invite'  — the campers it creates are not on any invite, so there is
 *                  nothing to stamp. Checked differently: the reason has to be
 *                  written down, because "it does not need one" is exactly what
 *                  was assumed about enrollCamper.
 */
const ROSTER_WRITERS = {
    saveCamper:   'refreshes',
    enrollCamper: 'refreshes',
    importRows:   'no invite',
};

/** The line a roster write becomes visible as a PERSON — the projection's input. */
const CREATES_A_ROSTER_ENTRY = /^\s*roster\[[^\]]*\]\s*=\s*(\{|_buildCamperRecord|Object\.assign)/m;

test('every function that creates a roster entry is classified', () => {
    const src = code(ME);
    const found = [];
    const re = /^function ([A-Za-z_$][\w$]*)/gm;
    let m, marks = [];
    while ((m = re.exec(src)) !== null) marks.push({ name: m[1], at: m.index });
    marks.forEach((mk, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
        if (CREATES_A_ROSTER_ENTRY.test(src.slice(mk.at, end))) found.push(mk.name);
    });

    const unclassified = found.filter(f => !(f in ROSTER_WRITERS)).sort();
    assert.deepStrictEqual(unclassified, [],
        'These create a camper in the roster, which is what gives them a camp_people row. '
        + 'Say whether each refreshes the family\'s parent invite — since migration 232 a '
        + 'camper whose row is born after the invite was stamped is invisible to their own '
        + 'parent until it is refreshed:\n  ' + unclassified.join('\n  '));

    const gone = Object.keys(ROSTER_WRITERS).filter(f => !found.includes(f)).sort();
    assert.deepStrictEqual(gone, [],
        'No longer creates a roster entry — strike these from ROSTER_WRITERS:\n  ' + gone.join('\n  '));
});

test('the ones that put a camper on an invite refresh it', () => {
    for (const [fn, how] of Object.entries(ROSTER_WRITERS)) {
        if (how !== 'refreshes') continue;
        const body = bodyOf(code(ME), fn);
        assert.ok(body, 'campistry_me.js no longer defines ' + fn);
        assert.match(body, /_syncInvitesForCamper\s*\(/,
            fn + ' creates a camper and does not refresh their family\'s invite. The camper\'s '
            + 'camp_people row is born here, AFTER the invite was stamped, so migration 232 '
            + 'leaves them invisible in the parent portal until something rewrites the invite\'s '
            + 'camper list.');
    }
});

test('and the one that does not says why, in the source', () => {
    // "It does not need one" is precisely what was assumed about enrollCamper, so
    // the exemption has to carry its reason where the next reader will find it.
    const at = ME.indexOf('roster[targetName]=_buildCamperRecord');
    assert.ok(at >= 0, 'importRows no longer writes a roster entry that way');
    const before = ME.slice(Math.max(0, at - 1200), at);
    assert.match(before, /ENROLLMENT-based|not on any invite/,
        'importRows creates campers without refreshing any invite, and no longer says why. '
        + 'The reason is that Link access is enrollment-based and a CSV import creates no '
        + 'enrollments — write it down or route it, but do not leave it silent.');
});

test('the refresh helper still rebuilds the invite from the family', () => {
    // The single fact the whole rule rests on: rewriting camper_names is what
    // re-stamps the invite (223's trigger fires on UPDATE OF camper_names). A
    // "refresh" that did not touch that column would satisfy the tests above and
    // fix nothing.
    const body = bodyOf(code(ME), '_syncInvitesForCamper');
    assert.ok(body, 'campistry_me.js no longer defines _syncInvitesForCamper');
    assert.match(body, /_syncParentInviteSnapshot\s*\(/,
        '_syncInvitesForCamper no longer reaches the snapshot sync');

    const snap = bodyOf(code(ME), '_syncParentInviteSnapshot');
    assert.ok(snap, 'campistry_me.js no longer defines _syncParentInviteSnapshot');
    assert.match(snap, /p_camper_names\s*:/,
        '_syncParentInviteSnapshot no longer sends camper_names to upsert_parent_invite. '
        + '223\'s trigger fires on UPDATE OF camper_names, so that write IS the re-stamp — '
        + 'without it a refresh leaves every null slot null.');
});
