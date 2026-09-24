// =============================================================================
// deposit_charge_error_text.test.js — TED-149, Registration's "Charge $250 now".
//
// The button read only r.data. Supabase's client hands back a refusal (a 403
// "Only the camp's owner or an admin can charge a deposit.", a 404 for an
// application it cannot find) as r.error with the reason on the response — so
// every refusal read "The card was declined", for a card that was never tried.
// And the button showed to everyone who can open Registration, though only the
// owner or an admin can charge a card.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
function cut(name) {
    const at = ME.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}

// supabase-js's own shape for a non-2xx answer: data null, error carrying the Response
function refusal(status, body) {
    return { data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
        context: { status, clone() { return this; }, json: async () => body } } };
}
function page(answers, role) {
    const toasts = [];
    const e = { camperName: 'Avi Gold', savedCardCustomer: 'cus_A', savedCardLast4: '4242', deposit: 250 };
    const ctx = {
        enrollments: { app1: e }, toasts,
        _depPolicyAPI: () => ({ outstanding: (x) => (x.depositStatus === 'paid' ? 0 : 250) }),
        fm: (n) => '$' + n, esc: (s) => String(s), confirmDialog: async () => true, save() {}, renderRegistrationPage() {},
        toast: (t, k) => toasts.push([t, k || '']),
        localStorage: { getItem: () => 'camp1' },
        window: { location: { origin: 'https://x', pathname: '/me' },
            CampistryDB: { getRole: () => role || 'owner',
                getClient: () => ({ functions: { invoke: async () => answers.shift() } }), getCampId: () => 'camp1' } },
    };
    const fns = new Function(...Object.keys(ctx), cut('_canChargeCards') + cut('chargeDepositNow') + '\nreturn { chargeDepositNow, _canChargeCards };')(...Object.values(ctx));
    return { ...fns, toasts, e };
}
const last = (p) => p.toasts[p.toasts.length - 1][0];

test('TED-149: a manager\'s press is refused — the office reads the server\'s reason, never "declined"', async () => {
    const p = page([refusal(403, { success: false, error: "Only the camp's owner or an admin can charge a deposit." })]);
    await p.chargeDepositNow('app1');
    assert.strictEqual(last(p), "Not charged: Only the camp's owner or an admin can charge a deposit.");
    assert.ok(!p.toasts.some(([t]) => /declined/i.test(t)), JSON.stringify(p.toasts));
});

test('TED-149: an application the server cannot find — its words, not "declined"', async () => {
    const p = page([refusal(404, { success: false, error: 'Application not found' })]);
    await p.chargeDepositNow('app1');
    assert.strictEqual(last(p), 'Not charged: Application not found');
});

test('TED-149: a 5xx is never called "not charged" — it may have gone through', async () => {
    const p = page([refusal(500, { error: 'upstream timeout' })]);
    await p.chargeDepositNow('app1');
    assert.match(last(p), /^upstream timeout — it may have gone through; check the processor’s dashboard/);
});

test('TED-149: a real decline is still a decline, and a success still books it', async () => {
    const d = page([{ data: { success: false, error: 'Your card was declined.' }, error: null }]);
    await d.chargeDepositNow('app1');
    assert.strictEqual(last(d), 'Your card was declined.');
    const ok = page([{ data: { success: true, paid: true, amount: 250 }, error: null }]);
    await ok.chargeDepositNow('app1');
    assert.strictEqual(last(ok), 'Charged $250');
    assert.strictEqual(ok.e.depositPaid, 250);
});

test('TED-149: "did the earlier charge go through?" still works when it comes back as a refusal status', async () => {
    const p = page([refusal(409, { success: false, reason: 'needs_check', error: 'An earlier charge got no answer.' }),
                    { data: { success: true, paid: true, amount: 250 }, error: null }]);
    await p.chargeDepositNow('app1');
    assert.strictEqual(last(p), 'Charged $250');
});

test('TED-149: only the owner or an admin sees "Charge now"', () => {
    assert.strictEqual(page([], 'owner')._canChargeCards(), true);
    assert.strictEqual(page([], 'admin')._canChargeCards(), true);
    assert.strictEqual(page([], 'manager')._canChargeCards(), false);
    assert.strictEqual(page([], 'viewer')._canChargeCards(), false);
    assert.match(ME, /if\(_hasCard&&_canChargeCards\(\)\)\{\s*b\+='<button[^\n]*chargeDepositNow/);
});
