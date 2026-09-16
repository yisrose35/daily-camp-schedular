// node --test tests/billing_wiring.test.js
//
// campistry_billing_core.js is proved by tests/billing_core.test.js. This file
// proves the ENGINE IS ACTUALLY PLUGGED IN — that the specific lines in
// campistry_me.js which used to lose money now go through it.
//
// It asserts against the source text rather than by running the file, because
// campistry_me.js is a ~17,000-line browser script with module-level state and
// no export surface; standing it up in node would test a fake. The failure mode
// being guarded is silent (a line quietly reverting to `delete families[fk]`
// looks fine until a camp's debt vanishes), so a source assertion that fails
// loudly is worth more here than a prettier test that does not exist.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ME = read('campistry_me.js');

/** The body of one top-level function in campistry_me.js. */
function fnBody(src, decl, endDecl) {
    const a = src.indexOf(decl);
    assert.ok(a > 0, 'cannot find ' + decl + ' — the wiring tests need re-anchoring');
    const b = endDecl ? src.indexOf(endDecl, a) : src.length;
    assert.ok(b > a, 'cannot find the end anchor after ' + decl);
    return src.slice(a, b);
}

// ── 1. the module is loaded, and before the file that uses it ─────────────

test('campistry_me.html loads the billing core BEFORE campistry_me.js', () => {
    const html = read('campistry_me.html');
    const core = html.indexOf('campistry_billing_core.js');
    // Anchored on the SCRIPT TAG, not the bare filename — the name also appears
    // in comments earlier in the file, which made this read as out of order.
    const me = html.indexOf('src="campistry_me.js');
    assert.ok(core > 0, 'the billing core is not loaded at all — every helper ' +
        'would silently fall back to "this family has no ledger"');
    assert.ok(me > 0);
    assert.ok(core < me, 'the core must load first, or postTuition is undefined ' +
        'on the first render');
});

test('the helpers degrade instead of throwing when the core is absent', () => {
    // campistry_me.js is loaded by eight pages and only some include the core.
    // A missing module must mean "no ledger", never an exception mid-delete.
    assert.match(ME, /function _billingCore\(\)\{return \(typeof window!=='undefined'&&window\.BillingCore\)\|\|null\}/,
        'the guarded accessor is gone');
    const has = fnBody(ME, 'function _familyHasMoney(f){', 'function _creditWithdrawalsFor');
    assert.match(has, /var B=_billingCore\(\);\s*if\(B\)return B\.hasMoney\(f\)/,
        '_familyHasMoney no longer prefers the core');
    // The fallback must err towards KEEPING: deleting a family we cannot assess
    // is the unrecoverable direction.
    assert.match(has, /return !!\(Number\(f\.balance\)\|\|Number\(f\.totalPaid\)\)/,
        'the conservative fallback is gone');
});

// ── 2. THE LINE THAT LOST THE DEBT ────────────────────────────────────────

test('cascadeCamperDelete no longer deletes a family that carries money', () => {
    const body = fnBody(ME, 'function cascadeCamperDelete(name){', 'async function deleteCamper(n)');

    // The old line, which deleted unconditionally.
    assert.ok(!/if\(f\.camperIds\.length===0\)delete families\[fk\];/.test(body),
        'the unconditional family delete is BACK — removing a camper erases the debt again');

    // The new one, which is conditional on the account being empty.
    assert.match(body, /if\(f\.camperIds\.length===0&&!_familyHasMoney\(f\)\)\{delete families\[fk\];return\}/,
        'the guarded delete is missing');
    // And a kept-but-camperless family is marked, so Billing can group it.
    assert.match(body, /f\.formerCamper=true/, 'a kept family is not flagged as former');
});

test('the delete posts a withdrawal credit BEFORE the enrollments go', () => {
    const body = fnBody(ME, 'function cascadeCamperDelete(name){', 'async function deleteCamper(n)');
    const credit = body.indexOf('_creditWithdrawalsFor(f,name,');
    const filter = body.indexOf('f.camperIds=f.camperIds.filter');
    assert.ok(credit > 0, 'no withdrawal credit is posted on delete');
    assert.ok(credit < filter,
        'the credit must be posted while the camper is still linked to the family');
});

test('the default withdrawal policy forgives NOTHING', () => {
    // Forgiving by accident is the failure that loses money. The office can
    // always post a credit afterwards; it cannot un-forgive silently.
    const helper = fnBody(ME, 'function _creditWithdrawalsFor(f,name,reason,policy){', 'function _postTuitionFor');
    assert.match(helper, /policy:policy==null\?'none':policy/,
        'the default policy is no longer "forgive nothing"');
});

test('unenroll parks the money and Undo reverses it', () => {
    const body = fnBody(ME, 'function unenrollCamper(n){', 'function _reopenWithdrawals');
    assert.match(body, /_creditWithdrawalsFor\(families\[_fkOf\],n,'unenrolled'\)/,
        'unenroll no longer credits the withdrawal');
    assert.match(body, /if\(_credited\)_reopenWithdrawals\(_fkOf,n\)/,
        'Undo no longer reverses the credit — the family would stay credited');
});

test('re-enrolling REVERSES the credit rather than deleting it', () => {
    // Append-only: the credit and its reversal both stay, so an office can see
    // the whole story. This is also the structural answer to D1 — there is no
    // instalment status to reopen because none was ever wrongly written.
    const body = fnBody(ME, 'function _reopenWithdrawals(fk,name){', 'function reenrollCamper(n){');
    assert.match(body, /B\.reverse\(f,credit\.id,/, 'the credit is not reversed');
    assert.ok(!/delete .*entries|splice/.test(body),
        'something is removing entries — the ledger must stay append-only');
    assert.match(body, /if\(credit&&B\.isReversed\(f,credit\.id\)\)return|if\(!credit\|\|B\.isReversed\(f,credit\.id\)\)return/,
        'reversing twice is not guarded');
    assert.match(ME, /_reopenWithdrawals\(_resolveFamilyKeyExact\(n\),n\);/,
        'reenrollCamper does not reopen the withdrawal');
});

// ── 3. the annual reset ───────────────────────────────────────────────────

test('the Replace import preserves families that carry money', () => {
    const wipe = ME.slice(ME.indexOf('═══ WIPE EXISTING DATA'),
                          ME.indexOf('nextPersonId is intentionally NOT reset'));
    assert.ok(wipe.length > 0, 're-anchor this test — the wipe block moved');

    // The line that destroyed every plan and card in the camp.
    assert.ok(!/^\s*families=\{\};\s*$/m.test(wipe),
        'families={} is back — the annual reset destroys every payment plan again');

    assert.match(wipe, /if\(!f\|\|!_familyHasMoney\(f\)\)\{delete families\[fk\];return\}/,
        'the preservation predicate is missing');
    assert.match(wipe, /f\.camperIds=\[\]/, 'camper links are not cleared on a kept family');
    assert.match(wipe, /f\.formerCamper=true/, 'kept families are not flagged');
    // roster/structure SHOULD still be wiped — that is the point of a reset.
    assert.match(wipe, /roster=\{\};/);
    assert.match(wipe, /structure=\{\};/);
});

test('the reset does not push the wipe to the cloud and undo itself', () => {
    // g.campistryMe.families={} would be re-hydrated over the preserved copy.
    assert.ok(!/g\.campistryMe\.families=\{\};/.test(ME),
        'the cloud write still blanks families — the next hydration undoes the fix');
    assert.match(ME, /g\.campistryMe\.families=families;/,
        'the cloud write no longer mirrors the in-memory decision');
});

// ── 4. tuition becomes a posted fact ──────────────────────────────────────

test('buildFamilyLedgers posts tuition before rendering', () => {
    const body = fnBody(ME, 'function buildFamilyLedgers(){', 'function PC(){');
    const post = body.indexOf('_postTuitionFor(families[fk],eid)');
    assert.ok(post > 0, 'tuition is never posted — the balance is still derived only');
    // Only for live enrollments, and only via the idempotent helper.
    assert.match(body, /if\(!e\|\|\(e\.status!=='enrolled'&&e\.status!=='accepted'\)\)return;/,
        'tuition would be posted for withdrawn enrollments too');
});

test('the posted ledger wins over the derived figure when it exists', () => {
    const body = fnBody(ME, 'function buildFamilyLedgers(){', 'function PC(){');
    assert.match(body, /l\.balance=posted;/,
        'the derived balance still wins — a former family would read as owing nothing');
    // A disagreement on a still-enrolled family must be visible, not silently resolved.
    assert.match(body, /l\.ledgerDiff=/,
        'a derived/posted mismatch is silently swallowed');
});

test('a render cannot double-bill, however many times it runs', () => {
    // The one real risk of moving from derived to posted. The guarantee lives in
    // BillingCore.postTuition, so assert it is the thing being called and that
    // it is still keyed on the enrollment.
    const core = read('campistry_billing_core.js');
    const fn = core.slice(core.indexOf('B.postTuition = function'),
                          core.indexOf('B.tuitionEntryFor = function'));
    assert.match(fn, /var existing = B\.tuitionEntryFor\(account, eid\);/);
    assert.match(fn, /if \(existing\) return \{ ok: true, entry: existing, alreadyPosted: true \};/,
        'postTuition is no longer idempotent — every render would bill the family again');
});

// ── 5. the office is told what happens to the money ───────────────────────

test('the delete dialog says what happens to an outstanding balance', () => {
    const body = fnBody(ME, 'async function deleteCamper(n){', 'function unenrollCamper(n){');
    assert.match(body, /still owes/, 'the warning does not mention what is owed');
    assert.match(body, /is owed[\s\S]{0,80}back/, 'the refund-owed direction is not covered');
    assert.match(body, /_outstandingForCamper\(n\)/, 'the warning is not computed from the ledger');
    // Warn, do not block: a hard block gets worked around by resetting the
    // roster instead, which had the same effect and no warning at all.
    assert.match(body, /confirmLabel:'Delete'/, 'the delete is no longer offered');
});
