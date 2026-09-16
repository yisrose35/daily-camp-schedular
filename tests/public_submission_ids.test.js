// node --test tests/public_submission_ids.test.js
//
// Two problems with the same root: a public form's entry id was doing work it
// was not strong enough to do.
//
//   IT COULD OVERWRITE. submit_public_application is anon-callable by design —
//     that is how a family applies — but the id comes from the client and the
//     write was an unconditional merge at that key. `||` at the top level
//     REPLACES the object there, so anyone who knew an enrollment id could post
//     to it and rewrite that camper's record: session, tuition, discount,
//     status. No login, from a public endpoint.
//
//   IT WAS A WEAK BEARER TOKEN. get_postaccept_bootstrap, get_contract_offer
//     and friends accept that id in place of a login and hand back a family's
//     or a staff member's file — payType and payRate included. The ids were
//     'enr_<ms>_<6 base36>' and 'staff_<ms>_<4 base36>': ~2.2 billion and ~1.7
//     million, narrowed by a timestamp an attacker can bracket.
//
// The fix for the first is about STATE, not existence — the register page
// retries, and a flat "must not exist" would turn every retry into a lost
// application.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const M184 = read('migrations/184_public_submission_cannot_overwrite.sql');
const REGISTER = read('campistry_register.html');
const STAFF = read('campistry_staff_apply.html');

const FN = (() => {
    const at = M184.indexOf('FUNCTION public.submit_public_application');
    return M184.slice(at, M184.indexOf('\n$$;', at));
})();

// ── 1. a submission cannot replace a record the camp has acted on ───────────

test('an entry the office has touched is closed to the public endpoint', () => {
    assert.ok(FN.length > 400, 'the function was not found — the slice is wrong');
    assert.match(FN, /v_status <> 'applied'/,
        'the public endpoint can still write over a record in any state');
    assert.match(FN, /'already_processed'/);
    // ...and it reads the CURRENT state to decide, rather than trusting the
    // status in the incoming payload, which the caller controls.
    assert.match(FN, /SELECT value -> p_kind -> p_entry_id INTO v_existing/,
        'the status is taken from the submission instead of from the record');
    const readAt = FN.indexOf('INTO v_existing');
    const decideAt = FN.indexOf("v_status <> 'applied'");
    assert.ok(readAt > 0 && decideAt > readAt,
        'the decision is made before the existing record is read');
});

test('the retry path still works', () => {
    // The register page submits one call per camper and returns on the first
    // failure, so a partial success followed by a retry legitimately re-sends a
    // camper that already landed. Refusing that would lose the application.
    assert.ok(!/v_existing IS NOT NULL[\s\S]{0,120}RETURN jsonb_build_object\('success', false, 'error', 'already_exists'/.test(FN),
        'an id that already exists is refused outright, which breaks the retry');
    assert.match(REGISTER, /for\(var j=0;j<ids\.length;j\+\+\)\{/,
        'the per-camper submit loop this rule is shaped around is gone');
    assert.match(REGISTER, /return \{ok:false,reason:res\.data\.error\}/,
        'the page no longer returns on first failure, so re-check the rule');
});

test('the guards 083 had are all still there', () => {
    for (const g of ["'invalid_kind'", "'invalid_payload'", "'camp_not_found'",
                     "'submission_too_large'"]) {
        assert.ok(FN.includes(g), `guard ${g} was lost`);
    }
    assert.match(FN, /pg_column_size\(p_entry\) > 8388608/);
    // Still anon-callable: this IS the public application form.
    assert.match(M184, /GRANT EXECUTE ON FUNCTION public\.submit_public_application\(uuid, jsonb, text, jsonb\)|GRANT EXECUTE ON FUNCTION public\.submit_public_application\(uuid, text, text, jsonb\)\s*TO anon, authenticated;/);
});

// ── 2. the id is worth being a bearer token ─────────────────────────────────

test('a weak id is refused by the database, not just discouraged', () => {
    assert.match(FN, /length\(p_entry_id\) < 32/,
        'nothing stops a form regressing to a short, guessable id');
    assert.match(FN, /'weak_entry_id'/);
    // 32 admits the new scheme (prefix + uuid = 40 and 42) and rejects both old
    // ones (24 and 22). If that boundary moves, one of those stops being true.
    assert.ok('enr_'.length + 36 >= 32 && 'staff_'.length + 36 >= 32,
        'the new ids would be rejected by the length rule');
    assert.ok(('enr_' + '1780000000000' + '_' + 'abcdef').length < 32,
        'the old enrollment id would still be accepted');
    assert.ok(('staff_' + '1780000000000' + '_' + 'abcd').length < 32,
        'the old staff id would still be accepted');
});

test('both public forms mint ids from a CSPRNG', () => {
    for (const [name, src] of [['campistry_register.html', REGISTER],
                               ['campistry_staff_apply.html', STAFF]]) {
        assert.match(src, /function _campistrySubmissionId\(prefix\)/,
            `${name} has no secure id helper`);
        assert.match(src, /window\.crypto\.randomUUID/, `${name} does not use randomUUID`);
        assert.match(src, /window\.crypto\.getRandomValues/,
            `${name} has no getRandomValues path for browsers without randomUUID`);
        // The old scheme must be gone from the id itself.
        assert.ok(!/id='enr_'\+Date\.now\(\)/.test(src) && !/id='staff_'\+Date\.now\(\)/.test(src),
            `${name} still mints the timestamp-and-a-few-characters id`);
    }
    assert.match(REGISTER, /var id=_campistrySubmissionId\('enr'\);/);
    assert.match(STAFF, /var id=_campistrySubmissionId\('staff'\);/);
});

test('Math.random is a last resort, and says so', () => {
    // It is not a CSPRNG. Reaching it silently would put the weak id back with
    // nothing to show for it.
    for (const [name, src] of [['campistry_register.html', REGISTER],
                               ['campistry_staff_apply.html', STAFF]]) {
        const at = src.indexOf('function _campistrySubmissionId');
        const body = src.slice(at, at + 1400);
        const cryptoAt = body.indexOf('window.crypto');
        const mathAt = body.indexOf('Math.random');
        assert.ok(cryptoAt > 0 && mathAt > cryptoAt,
            `${name} reaches for Math.random before trying crypto`);
        assert.match(body, /console\.warn\([\s\S]{0,120}weak/,
            `${name} falls back to a weak id without saying so`);
    }
});

// ── 3. the siblings, checked and left alone ─────────────────────────────────

test('the narrower public writers were already safe', () => {
    // Recorded so nobody re-audits these two from scratch, and so it fails here
    // if either loses the property.
    const m083 = read('migrations/083_public_application_submit.sql');
    const postaccept = m083.slice(m083.indexOf('FUNCTION public.submit_postaccept_response'));
    // It merges a postAccept sub-object onto an EXISTING enrollment. It cannot
    // replace the record, and it cannot create one.
    assert.match(postaccept, /existing \|\| jsonb_build_object\('postAccept', p_postaccept\)/);
    assert.match(postaccept, /'enrollment_not_found'/);

    const m085 = read('migrations/085_contract_offer_bootstrap.sql');
    const accept = m085.slice(m085.indexOf('FUNCTION public.accept_staff_contract'));
    assert.match(accept, /'already_accepted'/,
        'a contract acceptance can be replayed');
});
