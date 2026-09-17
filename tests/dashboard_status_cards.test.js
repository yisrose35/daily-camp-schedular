const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const HTML = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const JS_ = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

test('emailing sits beside texting, and says on or off', () => {
    // Whether a camp can send email is the same KIND of fact as whether it has
    // a texting number — and a camp that cannot see it has no way to know why
    // an acceptance letter never went out.
    const textAt = HTML.indexOf('TEXTING NUMBER CARD');
    const mailAt = HTML.indexOf('EMAILING CARD');
    assert.ok(textAt > 0 && mailAt > textAt, 'the emailing card must sit next to texting');
    assert.ok(mailAt - textAt < 1200, 'they must be adjacent cards, not merely both present');
    assert.match(HTML, /id="emailServiceBox"/);

    // Loaded on the same pass, not behind a tab.
    assert.match(JS_, /loadTelnyxStatus\(campData\.id\);\s*[\s\S]{0,260}loadEmailServiceStatus\(\)/);

    // All three answers are distinguishable — "off because you never bought
    // it" and "off because we switched it off" are different conversations.
    const fn = JS_.slice(JS_.indexOf('window.loadEmailServiceStatus'), JS_.indexOf('LINK PROGRAMS'));
    assert.match(fn, /Not included/);
    assert.match(fn, /switched_off/);
    assert.match(fn, /<strong>On<\/strong>/);
    // And a failed check is not reported as "off".
    assert.match(fn, /Emailing status unknown/);
});

test('a camp cannot switch its own emailing on', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/196_camp_email_service.sql'), 'utf8');
    assert.match(sql, /ALTER TABLE camp_email_service ENABLE ROW LEVEL SECURITY/);
    assert.ok(!/CREATE POLICY[\s\S]*camp_email_service/.test(sql),
        'no client-facing policy: RLS on with no policy is what makes it service-role only');
    // Reading is fine; the read RPC answers only for the caller's own camp.
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_camp_email_service\(\) TO authenticated/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\._camp_may_send_email\(uuid\) TO service_role/);
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\._camp_may_send_email\(uuid\)[\s\S]{0,80}authenticated/.test(sql),
        'the send-path check must not be callable from a browser');
    // No row means NOT granted — the point of a paid gate.
    assert.match(sql, /COALESCE\(v_on, false\)/);
    // But no existing camp loses anything the day it lands.
    assert.match(sql, /INSERT INTO camp_email_service[\s\S]{0,200}FROM camps c/);
    assert.match(sql, /ON CONFLICT \(camp_id\) DO NOTHING/);
});

test('the birthdays card is always there', () => {
    // It used to hide itself whenever nobody had a date of birth on file —
    // most often because the roster had not hydrated yet. So a card that was
    // about to have birthdays in it vanished instead and came back next load,
    // which reads as broken rather than as "no birthdays".
    const fn = HTML.slice(HTML.indexOf('window.renderBirthdays = function'),
                          HTML.indexOf('// ── TEAM STAT COUNT ──'));
    assert.ok(!/section\.style\.display = 'none'/.test(fn),
        'the birthdays section must never hide itself');
    assert.match(fn, /No dates of birth on file yet/);
    // A late roster still fills it in.
    assert.match(fn, /_bdayRetry\(\)/);
    const retry = HTML.slice(HTML.indexOf('function _bdayRetry()'), HTML.indexOf('renderBirthdays();\n        // The roster'));
    assert.match(retry, /_bdayTries >= 3/, 'the retry must be bounded');
    // And a real hydration resets the budget rather than being ignored.
    assert.match(HTML, /campistry-cloud-hydrated[\s\S]{0,200}_bdayTries = 0/);
});
