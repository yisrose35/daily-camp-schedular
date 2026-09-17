const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'campistry_acceptance_letter.js'));

const FULL = {
    camperName: 'Naftoli Rosenfeld', camperId: '1387',
    parentName: 'Yitz Rosenfeld', campName: 'Camp Simcha', session: 'Session A',
    accessCode: 'ABCD-2345', portalUrl: 'https://link.campistry.com',
    campNumber: '3734', postAcceptUrl: 'https://camp.test/paf?id=e1',
    officeEmail: 'office@simcha.test',
};

test('the letter carries everything a family needs on day one', () => {
    const { subject, body, missing } = A.build(FULL);
    assert.match(subject, /Naftoli is accepted — welcome to Camp Simcha/);
    // How to get in — numbered, because it is two steps done on a phone once.
    assert.match(body, /GETTING INTO CAMPISTRY LINK/);
    assert.match(body, /1\. Go to https:\/\/link\.campistry\.com/);
    assert.match(body, /Enter your access code: ABCD-2345/);
    // The two numbers that matter all summer.
    assert.match(body, /Naftoli's camper ID: 1387/);
    assert.match(body, /Camp number: 3734/);
    // And the one that makes a bank transfer credit itself.
    assert.match(body, /Payment reference: 3734-1387/);
    assert.match(body, /memo of any Zelle or bank transfer/);
    assert.match(body, /https:\/\/camp\.test\/paf\?id=e1/);
    assert.deepStrictEqual(missing, []);
});

test('a missing piece leaves no trace, rather than printing undefined', () => {
    // The usual way this goes wrong: "Camper ID: undefined" in a letter that
    // has already gone to every family.
    const bare = A.build({ camperName: 'Naftoli Rosenfeld', campName: 'Camp Simcha',
                           accessCode: 'ABCD-2345', portalUrl: 'https://x.test' });
    assert.ok(!/undefined|null|NaN/.test(bare.body), bare.body);
    assert.ok(!/YOUR NUMBERS/.test(bare.body), 'the numbers section must not appear empty');
    assert.ok(!/A FEW MORE CHOICES/.test(bare.body));
    // And the caller is told what it could not say.
    assert.deepStrictEqual(bare.missing.sort(), ['camp number', 'camper ID']);

    // Nothing at all still produces a letter that reads.
    const nothing = A.build({});
    assert.ok(!/undefined/.test(nothing.body));
    assert.match(nothing.body, /has been accepted/);

    // A camp number with no camper ID yields no half-built reference.
    assert.strictEqual(A.reference('3734', ''), '');
    assert.strictEqual(A.reference('', '1387'), '');
    assert.strictEqual(A.reference('3734', '1387'), '3734-1387');
});

test('the reference matches the one the bank-memo matcher looks for', () => {
    // Two copies of this rule would be a silent mismatch: a letter telling a
    // parent a reference the deposit matcher does not recognise.
    const M = require(path.join(ROOT, 'campistry_deposit_match.js'));
    for (const [camp, kid] of [['3734', '1387'], ['12', '9'], ['3734', ''], ['', '']]) {
        assert.strictEqual(A.reference(camp, kid), M.reference(camp, kid),
            `letter and matcher disagree on ${camp}/${kid}`);
    }
    // And what the letter prints is what the matcher can parse back out.
    const ref = A.reference('3734', '1387');
    assert.match(A.build(FULL).body, new RegExp(ref));
    assert.ok(M.REFERENCE_RE.test('paid ' + ref + ' thanks'));
});

test('automatic sending is gated on the camp paying for it', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');

    // Both automatic emails, not just the letter.
    const invite = me.slice(me.indexOf('async function _autoSendParentInvite('), me.indexOf('async function _autoSendParentInvite(') + 900);
    assert.match(invite, /_emailServiceOn\(\)/);
    // The invite is still CREATED when sending is blocked — the access code
    // exists either way and the office sends it by hand.
    assert.match(invite, /generateParentInvite\(enrollId\);/);
    const paf = me.slice(me.indexOf('async function _autoSendPostAccept('), me.indexOf('async function _autoSendPostAccept(') + 600);
    assert.match(paf, /_emailServiceOn\(\)/);

    // Unknown is treated as allowed: the RPC does not exist until 195 is
    // applied, and failing closed there would stop every camp emailing the
    // day this ships.
    const check = me.slice(me.indexOf('async function _emailServiceOn()'), me.indexOf('/** Why an automatic email did not go'));
    assert.match(check, /_emailServiceCache=\{enabled:true,reason:'unknown'\}/);

    // The office is told which of the two it is.
    assert.match(me, /Your plan does not include emailing/);
    assert.match(me, /Emailing is switched off for this camp/);
});

test('the letter replaced the invite email rather than joining it', () => {
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    // One builder, both senders — the modal's Send and the automatic send.
    const calls = me.match(/_inviteEmailFor\(p,[^)]*\)/g) || [];
    assert.ok(calls.length >= 2, 'both senders must go through the one builder');
    assert.ok(calls.every(c => /extras|_letterExtrasFor/.test(c)),
        'every sender must pass the facts, or it sends a letter missing the numbers');
    // The old bare wording is gone.
    assert.ok(!/Your access code for the Campistry Link parent portal is/.test(me),
        'the old invite email should no longer exist');
    // A missing module degrades to a short letter rather than throwing.
    assert.match(me, /acceptance letter module missing — sent the short version/);
});

test('the office previews the letter it actually sends', () => {
    // The invite modal carried a THIRD hand-written copy of the email body, so
    // the office previewed one thing and the parent received another — and
    // nothing in the app would ever have said so.
    const me = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
    assert.match(me, /id="invitePreview'\+which\+'/);
    assert.match(me, /async function _fillInvitePreview\(/);
    // Filled from the same builder that sends.
    const fill = me.slice(me.indexOf('async function _fillInvitePreview('),
                          me.indexOf('async function _fillInvitePreview(') + 1600);
    assert.match(fill, /_inviteEmailFor\(pair\[1\],camperFirst,extras\)/);
    assert.match(fill, /box\.textContent=mail\.body/);
    // And it warns about what the letter could not say, while it can still be fixed.
    assert.match(fill, /Not in this letter: /);
});
