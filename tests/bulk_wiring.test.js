// node --test tests/bulk_wiring.test.js
//
// campistry_bulk.js is proved by tests/bulk.test.js. This file proves it is PLUGGED
// IN — that the four actions exist on the page, are reachable from the Billing menu,
// gated like every other money action, and that the pieces they depend on (the
// enrollment-to-family map, the billingRules key) are actually loaded and saved.
//
// The derivation helpers run for real, in a vm, against stubs. The call sites and
// the load/save wiring are asserted against the source, because a call site is the
// one thing a running slice cannot show you — anchored at the start of a line, since
// a bare substring match is satisfied by `if(false)`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ME = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'campistry_me.html'), 'utf8');
const B = require(path.join(ROOT, 'campistry_bulk.js'));
const I = require(path.join(ROOT, 'campistry_installments.js'));

// ── the attribution map and the plan list, run for real ───────────────────

const SLICE_FROM = 'function _bulkAPI(){';
const SLICE_TO = '\nfunction runInstallments(){';

function loadSlice(enrollmentsObj) {
    const a = ME.indexOf(SLICE_FROM);
    const b = ME.indexOf(SLICE_TO, a);
    assert.ok(a > 0, 'cannot find ' + SLICE_FROM + ' — re-anchor this test');
    assert.ok(b > a, 'cannot find ' + SLICE_TO + ' after it');
    const box = {
        console,
        window: { CampistryBulk: B },
        enrollments: enrollmentsObj || {},
        _camperLabel: k => String(k == null ? '' : k).replace(/\s#\d+$/, '')
    };
    vm.runInContext(ME.slice(a, b)
        + '\n;this.__api={_bulkAPI:_bulkAPI,_famKeyByEnrollment:_famKeyByEnrollment,'
        + '_planRows:_planRows};', vm.createContext(box));
    return box.__api;
}

/** A ledger as buildFamilyLedgers builds one: a Tuition charge per enrollment. */
function ledger(name, tuitionRefs) {
    return {
        family: { name },
        entries: (tuitionRefs || []).map(ref => ({
            type: 'charge', category: 'Tuition', amount: 900, ref
        }))
    };
}

test('the enrollment-to-family map comes from the ledger’s tuition charges', () => {
    // Those are posted for every enrolled AND accepted enrollment, unconditionally,
    // by the one function that knows the whole attribution cascade. Re-deriving the
    // cascade here would be a second answer to the same question.
    const api = loadSlice();
    const map = api._famKeyByEnrollment({
        f1: ledger('Klein', ['e1', 'e2']),
        pending_ari_e9: ledger('Ari Family', ['e9'])
    });
    assert.strictEqual(map.e1, 'f1');
    assert.strictEqual(map.e2, 'f1');
    assert.strictEqual(map.e9, 'pending_ari_e9',
        'an accepted applicant on a synthesized ledger must still be reachable');
});

test('a non-tuition charge is not an enrollment', () => {
    const api = loadSlice();
    const map = api._famKeyByEnrollment({
        f1: { family: { name: 'Klein' }, entries: [
            { type: 'charge', category: 'Late Fee', amount: 25, ref: 'lf_1' },
            { type: 'credit', category: 'Discount', amount: 50, ref: 'e1_disc' },
            { type: 'installment', category: 'Payment 1', amount: 450, ref: 'e1_inst0' }
        ] }
    });
    assert.deepStrictEqual(Object.keys(map), []);
});

test('only enrollments with a plan are listed, and each carries its family', () => {
    const api = loadSlice({
        e1: { camperName: 'Ari Klein', installments: [{ amount: 450, status: 'pending' }] },
        e2: { camperName: 'Malky Klein' },                        // no plan
        e3: { camperName: 'Shevy Stein', installments: [] },      // empty plan
        e4: { camperName: 'Nobody', installments: [{ amount: 1 }] } // no ledger
    });
    const rows = api._planRows({ f1: ledger('Klein Family', ['e1', 'e2', 'e3']) });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].key, 'f1|e1');
    assert.strictEqual(rows[0].famKey, 'f1');
    assert.strictEqual(rows[0].eid, 'e1');
    assert.strictEqual(rows[0].camperName, 'Ari Klein');
});

test('a synthesized pending_ account is on the run list like any other', () => {
    // An accepted applicant whose household does not exist in families{} yet lives
    // only as an ephemeral `pending_` ledger. Those are exactly the families who
    // have just been billed for the first time, so skipping them would leave the
    // deposit run missing the people it most exists for.
    const api = loadSlice({
        e9: { camperName: 'Ari Newman', installments: [{ amount: 200, status: 'pending' }] }
    });
    const rows = api._planRows({ pending_newman_e9: ledger('Newman Family', ['e9']) });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].famKey, 'pending_newman_e9');
    assert.strictEqual(rows[0].key, 'pending_newman_e9|e9');
});

test('a duplicate-name camper’s roster suffix is not shown to the office', () => {
    const api = loadSlice({
        e1: { camperName: 'Malky Stein #102', installments: [{ amount: 1, status: 'pending' }] }
    });
    const rows = api._planRows({ f1: ledger('Stein', ['e1']) });
    assert.strictEqual(rows[0].camperName, 'Malky Stein');
    assert.ok(!/#102/.test(rows[0].name));
});

test('two campers in one family are two separate plans', () => {
    // A plan belongs to an ENROLLMENT, not a household: two siblings can sit on
    // different installments and a run has to advance them independently.
    const api = loadSlice({
        e1: { camperName: 'Ari', installments: [{ amount: 1, status: 'pending' }] },
        e2: { camperName: 'Malky', installments: [{ amount: 1, status: 'pending' }] }
    });
    const rows = api._planRows({ f1: ledger('Klein', ['e1', 'e2']) });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.map(r => r.eid).sort().join(','), 'e1,e2');
});

test('the rows the rule is given are rows it can actually run', () => {
    // The end-to-end shape: what _planRows produces must be what planInvoiceRun
    // consumes, and the key must carry the enrollment id back out so the caller
    // knows where to store the advanced schedule.
    B.useInstallments(I);
    const api = loadSlice({
        e1: { camperName: 'Ari', installments: [
            { n: 1, of: 2, label: 'Payment 1 of 2', amount: 450, dueDate: '2026-06-01',
              status: 'pending' },
            { n: 2, of: 2, label: 'Payment 2 of 2', amount: 450, dueDate: '2026-07-01',
              status: 'pending' }
        ] }
    });
    const rows = api._planRows({ f1: ledger('Klein', ['e1']) });
    const plan = B.planInvoiceRun({ families: rows, on: '2026-06-01' });
    assert.strictEqual(plan.count, 1);
    assert.strictEqual(plan.total, 450);
    assert.strictEqual(String(plan.run[0].key).split('|')[1], 'e1',
        'the enrollment id must survive the round trip, or the schedule is stored nowhere');
    assert.strictEqual(plan.run[0].schedule[0].status, 'invoiced');
});

// ── the four actions exist and are gated ──────────────────────────────────

const ACTIONS = ['runInstallments', 'bulkAdjust', 'applyCreditsToOwed',
                 'assessLateFees', 'manageLateFees'];

test('every bulk action is defined and exported', () => {
    ACTIONS.forEach(fn => {
        assert.ok(ME.indexOf('\nfunction ' + fn + '(') > 0, fn + ' is not defined');
        assert.match(ME, new RegExp('\\n    ' + fn + ':' + fn + '[,\\n]'),
            fn + ' is not exported, so nothing can call it');
    });
});

test('every bulk action is gated on billing:edit before it does anything', () => {
    // Every one of these posts money or changes what a family is asked for. The gate
    // also carries the plan/sandbox refusal, which is why it comes first rather than
    // after the form has been filled in.
    ACTIONS.forEach(fn => {
        const a = ME.indexOf('\nfunction ' + fn + '(');
        const body = ME.slice(a, a + 400);
        assert.match(body, /if\(!_secEdit\('billing'/,
            fn + ' is not gated — it would post money inside a plan');
    });
});

test('all six are reachable from the Billing menu', () => {
    const a = ME.indexOf('function renderBilling(){');
    const b = ME.indexOf('\nfunction ', a + 10);
    const body = ME.slice(a, b);
    ['CampistryMe.runInstallments()',
     "CampistryMe.bulkAdjust(\\'credit\\')",
     "CampistryMe.bulkAdjust(\\'charge\\')",
     'CampistryMe.applyCreditsToOwed()',
     'CampistryMe.assessLateFees()',
     'CampistryMe.manageLateFees()'].forEach(call => {
        assert.ok(body.indexOf(call) > 0, call + ' is not in the Billing menu');
    });
});

test('campistry_me.html loads the bulk rule before campistry_me.js', () => {
    const bulk = HTML.indexOf('src="campistry_bulk.js');
    const me = HTML.indexOf('src="campistry_me.js');
    assert.ok(bulk > 0, 'campistry_bulk.js is not loaded — every action would refuse');
    assert.ok(bulk < me, 'the rule must load first');
    assert.match(HTML.slice(bulk, bulk + 60), /\?v=/, 'it needs a cache-bust');
});

// ── the run stores what it advanced, and re-plans on the real selection ───

test('the run stores the advanced schedule back onto the enrollment', () => {
    const a = ME.indexOf('\nfunction runInstallments(){');
    const b = ME.indexOf('\nfunction _riToggleAll', a);
    const body = ME.slice(a, b);
    assert.match(body, /if\(enrollments\[eid\]\)enrollments\[eid\]\.installments=r\.schedule;/,
        'the advanced schedule is never stored — the run would invoice nothing');
    assert.match(body, /\n        save\(\);/, 'an unsaved run is lost on the next hydration');
});

test('the run is PLANNED AGAIN on the selection the office actually chose', () => {
    // The preview is computed over everybody. Invoicing whoever the preview happened
    // to include, rather than who is ticked, is exactly how a bulk action bills the
    // wrong people.
    const a = ME.indexOf('\nfunction runInstallments(){');
    const b = ME.indexOf('\nfunction _riToggleAll', a);
    const body = ME.slice(a, b);
    const preview = body.indexOf('var preview=B.planInvoiceRun({families:rows})');
    const replan = body.indexOf('var plan=B.planInvoiceRun({families:chosen');
    assert.ok(preview > 0, 'the preview plan is gone');
    assert.ok(replan > preview, 'the confirm handler must re-plan on `chosen`');
    assert.match(body, /if\(!chosen\.length\)\{toast\('Nobody is selected'/,
        'an empty selection must be refused, not run over everybody');
});

test('a run with nothing left to invoice says which of the two it is', () => {
    // "Nobody is on a plan" and "every plan is fully invoiced" are different facts,
    // and an empty list tells you neither.
    const a = ME.indexOf('\nfunction runInstallments(){');
    const body = ME.slice(a, ME.indexOf('\nfunction _riToggleAll', a));
    assert.match(body, /Nobody is on a payment plan yet/);
    assert.match(body, /Every payment plan has already been fully invoiced/);
});

// ── settling from credit posts nothing ────────────────────────────────────

test('settling an invoice from credit posts no money and no ledger entry', () => {
    // The credit is already on the ledger and already in the balance. Posting
    // anything here would count the same credit twice.
    const a = ME.indexOf('\nfunction applyCreditsToOwed(){');
    const b = ME.indexOf('\nfunction manageLateFees(){', a);
    const body = ME.slice(a, b);
    assert.ok(!/_postLedgerCredit|finPayments\.push|\.charges\.push|\.credits\.push/.test(body),
        'settling from credit must not post anything');
    assert.match(body, /inst\.status='paid';/, 'the installment must stop asking');
    assert.match(body, /inst\.paidFrom='credit';/,
        'a statement must be able to say it was settled from credit, not from a ' +
        'payment that never reached the bank');
});

test('only a FULL cover is applied; a partial one is left alone and named', () => {
    const a = ME.indexOf('\nfunction applyCreditsToOwed(){');
    const body = ME.slice(a, ME.indexOf('\nfunction manageLateFees(){', a));
    assert.match(body, /cov\.applications\.filter\(function\(a\)\{return a\.full\}\)/,
        'the full-cover filter is gone — an installment would be half settled');
    assert.match(body, /Not enough credit to settle/);
});

test('available credit is the NEGATIVE balance, clamped at zero', () => {
    const a = ME.indexOf('\nfunction applyCreditsToOwed(){');
    const body = ME.slice(a, ME.indexOf('\nfunction manageLateFees(){', a));
    assert.match(body, /Math\.max\(0,-\(l\.balance\|\|0\)\)/,
        'a family who OWES money must never look like a family with credit');
});

test('deposits and registration are recognised from the installment label', () => {
    const a = ME.indexOf('\nfunction applyCreditsToOwed(){');
    const body = ME.slice(a, ME.indexOf('\nfunction manageLateFees(){', a));
    // campistry_installments.js labels a deposit plan's first installment
    // "Down payment", so that is the string this has to match.
    assert.match(body, /down \?payment\|deposit/);
    const built = I.build({ session: { paymentPlan: 'deposit', depositAmount: 200 },
                            tuition: 900, today: '2026-06-01' });
    assert.ok(/down ?payment|deposit/i.test(built[0].label),
        'the rule’s own label must still match what this looks for: ' + built[0].label);
});

// ── late fees ─────────────────────────────────────────────────────────────

test('late fees are off until a camp turns them on', () => {
    const a = ME.indexOf('\nfunction assessLateFees(){');
    const body = ME.slice(a, a + 900);
    assert.match(body, /if\(pol\.mode==='off'\)\{/,
        'an off policy must refuse rather than charge a default fee');
    assert.match(body, /manageLateFees\(\);/,
        'refusing should offer the setup, not just say no');
});

test('the applied keys are checked, stored, and never mutated in place', () => {
    const a = ME.indexOf('\nfunction assessLateFees(){');
    const b = ME.length;
    const body = ME.slice(a, ME.indexOf('\nfunction _liveOnlyNotice', a) > 0
        ? ME.indexOf('\nfunction _liveOnlyNotice', a) : b);
    assert.match(body, /B\.planLateFees\(\{proposals:proposed,applied:applied\}\)/,
        'the dedupe is not consulted — a second run would charge every fee again');
    assert.match(body, /nextApplied=B\.recordLateFees\(nextApplied,x\.plan,asOf\)/,
        'nothing records what was charged, so the dedupe has nothing to check');
    assert.match(body, /billingRules=Object\.assign\(\{\},billingRules\|\|\{\},\{lateFeesApplied:nextApplied\}\)/,
        'the record must be stored on the camp');
    assert.match(body, /\n        save\(\);/, 'an unsaved record deduplicates nothing');
});

test('the proposal key is also the charge id, so the two dedupes cannot disagree', () => {
    const a = ME.indexOf('\nfunction assessLateFees(){');
    const body = ME.slice(a, a + 6000);
    assert.match(body, /var id='lf_'\+String\(p\.key\)\.replace\(\/\^lf_\/,''\)/);
    assert.match(body, /if\(f\.charges\.some\(function\(c\)\{return c&&c\.id===id\}\)\)return;/,
        'the per-charge check is gone — one stale record would double-charge');
});

test('a percentage with no percentage, or a flat fee of nothing, is refused', () => {
    const a = ME.indexOf('\nfunction manageLateFees(){');
    const body = ME.slice(a, ME.indexOf('\nfunction assessLateFees(){', a));
    assert.match(body, /norm\.mode==='flat'&&!\(norm\.flat>0\)/);
    assert.match(body, /norm\.mode==='percent'&&!\(norm\.percent>0\)/);
    assert.match(body, /billingRules=Object\.assign\(\{\},billingRules\|\|\{\},\{lateFee:norm\}\)/);
});

// ── the state actually survives a reload ──────────────────────────────────

test('billingRules is declared, hydrated and saved', () => {
    // The recurring defect in this project is something recorded in one place and
    // read by nobody. A late-fee record that does not survive a reload guarantees a
    // double charge the next morning.
    assert.match(ME, /\nvar billingRules=\{\};/, 'billingRules is not declared');
    assert.match(ME,
        /billingRules=\(me\.billingRules&&typeof me\.billingRules==='object'\)\?me\.billingRules:\{\};/,
        'billingRules is never loaded from the camp blob');
    assert.match(ME, /\n            billingRules:billingRules,/,
        'billingRules is never written back');
});

test('the direction of a bulk adjustment is remembered, not read off the screen', () => {
    // A credit and a charge are opposites. Deriving the direction from display text
    // is how a preview ends up describing the reverse of what the button does.
    assert.match(ME, /\nvar _baKind='credit';/);
    const a = ME.indexOf('\nfunction _baPreview(){');
    const body = ME.slice(a, a + 900);
    assert.match(body, /_baPlan\(_baKind\)/);
    assert.ok(!/me-modal-title/.test(ME),
        'nothing may depend on a modal-title class that does not exist');
});

// ── telling the family ────────────────────────────────────────────────────

const SEND_FROM = 'function _famEmails(f){';
const SEND_TO = '\nfunction _campNameForSend(){';

function loadEmails() {
    const a = ME.indexOf(SEND_FROM);
    const b = ME.indexOf(SEND_TO, a);
    assert.ok(a > 0 && b > a, 'cannot find _famEmails — re-anchor this test');
    const box = { console };
    vm.runInContext(ME.slice(a, b) + '\n;this.__f=_famEmails;', vm.createContext(box));
    return box.__f;
}

test('the billing-contact household is asked first', () => {
    // A camp that has said which parent handles the money has said something this
    // must not ignore.
    const _famEmails = loadEmails();
    const got = _famEmails({ households: [
        { label: 'Dad', parents: [{ email: 'dad@x.com' }] },
        { label: 'Mum', billingContact: true, parents: [{ email: 'mum@x.com' }] }
    ] });
    assert.strictEqual(got.join(','), 'mum@x.com,dad@x.com');
});

test('every address is returned, not just the first', () => {
    // Two parents who both want the invoice is the ordinary case; picking one of
    // them quietly makes the other wonder why the camp never writes.
    const _famEmails = loadEmails();
    const got = _famEmails({ households: [
        { billingContact: true, parents: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }
    ] });
    assert.strictEqual(got.join(','), 'a@x.com,b@x.com');
});

test('a household with no parents, or a family with none, is empty not broken', () => {
    const _famEmails = loadEmails();
    assert.strictEqual(_famEmails(null).length, 0);
    assert.strictEqual(_famEmails({}).length, 0);
    assert.strictEqual(_famEmails({ households: [{}, { parents: [] },
        { parents: [{ name: 'no email' }] }] }).length, 0);
});

test('the run offers to email, ticked by default', () => {
    const a = ME.indexOf('\nfunction runInstallments(){');
    const body = ME.slice(a, ME.indexOf('\nfunction _riToggleAll', a));
    assert.match(body, /id="riEmail" checked/,
        'an invoice nobody is told about is not an invoice');
    // The GUARD, not just the call. `if(!wantEmail)return;` rewritten to a bare
    // `return;` leaves the planSend call sitting right there, unreachable, which a
    // match on the call alone is perfectly happy with.
    assert.match(body, /\n        if\(!wantEmail\)return;\n/,
        'the email step must be conditional on the tick, and reachable when it is set');
    const guard = body.indexOf('if(!wantEmail)return;');
    const send = body.indexOf("B2.planSend({kind:'invoice'");
    assert.ok(send > guard, 'nothing is sent');
});

test('the invoices go out AFTER the schedules are saved', () => {
    // A send that goes out and then fails to save would ask a family for money the
    // app has no record of asking for — and the next run would ask again.
    const a = ME.indexOf('\nfunction runInstallments(){');
    const body = ME.slice(a, ME.indexOf('\nfunction _riToggleAll', a));
    const saved = body.indexOf('\n        save();');
    const sent = body.indexOf('B2.planSend(');
    assert.ok(saved > 0 && sent > saved, 'the send must follow the save, not precede it');
});

test('a send failure is counted, not allowed to stop the run', () => {
    const a = ME.indexOf('\nasync function _sendBillingDoc(');
    const body = ME.slice(a, ME.indexOf('\n/**', a + 10));
    assert.match(body, /catch\(e\)\{/, 'one bad address would abort the whole run');
    assert.match(body, /return false;/, 'a failure must be reportable');
});

test('statements are sent, and carry no due date', () => {
    // campistry_ar.js refuses a statement a dueDate on purpose: a summary with a
    // deadline is an invoice wearing the wrong name.
    assert.ok(ME.indexOf('\nasync function sendStatements(){') > 0);
    assert.match(ME, /\n    sendStatements:sendStatements,/);
    const a = ME.indexOf('\nfunction _statementBody(');
    const body = ME.slice(a, ME.indexOf('\n/**', a + 10));
    assert.ok(!/[Dd]ue by|dueDate/.test(body), 'a statement must not carry a deadline');
    assert.match(body, /This is a statement, not a bill/);
    assert.ok(ME.indexOf("CampistryMe.sendStatements()") > 0,
        'statements are not reachable from the Billing menu');
});

test('sendStatements is gated and only lists families with something to report', () => {
    const a = ME.indexOf('\nasync function sendStatements(){');
    const body = ME.slice(a, ME.indexOf('\nfunction _statementBody(', a));
    assert.match(body, /if\(!_secEdit\('billing','Sending statements'\)\)return;/);
    assert.match(body, /return r\.balance>0\|\|r\.owed\.total>0/,
        'a family who owes nothing should not be sent a statement about it');
    assert.match(body, /plan\.noEmail\.length/,
        'families with no email must be named, not silently skipped');
});

test('a run that can reach nobody does not offer a Send button', () => {
    const a = ME.indexOf('\nasync function sendStatements(){');
    const body = ME.slice(a, ME.indexOf('\nfunction _statementBody(', a));
    assert.match(body, /if\(!plan\.ok\)\{\s*\n\s*showModal\('Send statements',h,null\);/,
        'a Send button that can send nothing is a button that lies');
});
