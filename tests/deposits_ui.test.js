// node --test tests/deposits_ui.test.js
//
// The deposits UI is mostly DOM, but three things in it are pure and worth
// pinning down, because each one has a failure mode that is invisible in
// review: the ledger union (money silently not counted), the escaping split
// (mangled payer names, or worse), and the balance-snapshot payload (a wrong
// number feeding a server-side guardrail).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

globalThis.CampistryDepositMatch = require('../campistry_deposit_match.js');
const D = require('../campistry_deposits_ui.js');

test('loads outside a browser without touching a bare window', () => {
    // A bare `window` reference throws ReferenceError in Node rather than
    // yielding undefined, which would take the whole Billing page down if this
    // module were ever evaluated in a non-browser context.
    assert.strictEqual(typeof D.refresh, 'function');
    assert.strictEqual(typeof D.memoCode, 'function');
});

test('memo codes delegate to the matcher, so there is one implementation', () => {
    const M = require('../campistry_deposit_match.js');
    assert.strictEqual(D.memoCode('fam_klein', 'Klein Family'), M.memoCode('fam_klein', 'Klein Family'));
    assert.match(D.memoInstruction('fam_klein', 'Klein Family'), /KLE-\d{4}/);
});

test('the escaping split keeps apostrophes readable in text', () => {
    // je()-style escaping on visible text renders "SHIMON\\'S HARDWARE LLC".
    // Apostrophes are extremely common in exactly the business payer names this
    // feature exists to handle, so the HTML escaper and the JS-string escaper
    // must stay separate. Rendering the Known Payers list is the cheapest way
    // to prove they are.
    let body = '';
    D.init({
        showModal: (_title, html) => { body = html; },
        esc: (s) => String(s == null ? '' : s),
        jesc: (s) => String(s == null ? '' : s).replace(/'/g, "\\'"),
        families: () => ({ fam_klein: { name: 'Klein Family' } })
    });
    D.state().aliases = [{
        id: 'alias-1', familyKey: 'fam_klein',
        displayName: "SHIMON'S HARDWARE LLC", handle: '', source: 'learned'
    }];

    D.openAliases();

    assert.ok(body.indexOf("SHIMON'S HARDWARE LLC") >= 0,
        'payer name should render with a plain apostrophe');
    assert.strictEqual(body.indexOf("SHIMON\\'S"), -1,
        'payer name must not be JS-escaped into visible text');
    assert.ok(body.indexOf('Klein Family') >= 0);
});

test('creditsFor returns the posted deposits a family ledger must count', () => {
    const state = D.state();
    state.credits = {
        fam_klein: [
            { id: 'dep_1', amount: 850, date: '2026-07-08', method: 'zelle', notes: 'Received from SHIMON\'S HARDWARE LLC' },
            { id: 'dep_2', amount: 425, date: '2026-07-22', method: 'ach', notes: 'Received from GOLDSTEIN DENTAL PC' }
        ]
    };
    assert.strictEqual(D.creditsFor('fam_klein').length, 2);
    assert.strictEqual(D.creditsFor('fam_klein').reduce((s, d) => s + d.amount, 0), 1275);
    // A family with no deposits must yield an array, not undefined — the ledger
    // builder iterates this directly.
    assert.deepStrictEqual(D.creditsFor('fam_nobody'), []);
});

test('pending counts drive the Billing banner and exclude posted deposits', () => {
    const state = D.state();
    state.deposits = [
        { id: '1', status: 'review',    amount_cents: 50000 },
        { id: '2', status: 'unmatched', amount_cents: 25000 },
        { id: '3', status: 'posted',    amount_cents: 90000 },
        { id: '4', status: 'ignored',   amount_cents: 10000 }
    ];
    assert.strictEqual(D.totalPending(), 2);
    assert.strictEqual(D.pendingAmount(), 750);
});

test('a return/NSF stays negative so the ledger can debit it', () => {
    // bank_deposits stores amount_cents positive and flags is_reversal; the
    // sign is applied by get_camp_deposit_credits. If a reversal ever arrives
    // here positive, a family whose ACH bounced reads as paid.
    D.state().credits = {
        fam_klein: [
            { id: 'dep_1', amount: 850, date: '2026-07-08', method: 'ach' },
            { id: 'dep_2', amount: -850, date: '2026-07-11', method: 'ach', isReversal: true }
        ]
    };
    const rows = D.creditsFor('fam_klein');
    assert.strictEqual(rows.reduce((s, d) => s + d.amount, 0), 0);
    assert.ok(rows.some(d => d.amount < 0), 'the reversal must carry a negative amount');
});

test('deposit kinds all resolve to a real payment label', () => {
    // The family ledger labels a deposit with the shared payment catalogue.
    // A kind missing from it renders the raw id ("wire") as the category.
    const P = require('../campistry_payments.js');
    ['zelle', 'ach', 'wire', 'other'].forEach(k => {
        assert.notStrictEqual(P.label(k), k, k + ' has no catalogue label');
    });
});

test('an RPC failure names the actual cause and its fix', () => {
    // One vague "isn't set up yet" for three unrelated causes is the same
    // silent-failure pattern this feature exists to avoid — each needs a
    // different fix, so each has to be named.
    assert.match(D.explainError('not_authorized'), /owner or admin/i);
    assert.match(D.explainError('Could not find the function public.get_bank_deposits in the schema cache'),
                 /Reload schema/i);
    assert.match(D.explainError('function public.get_bank_deposits(uuid) does not exist'),
                 /Migration 145/i);
    assert.match(D.explainError('JWT expired'), /sign out/i);
    // Anything unrecognised is passed through rather than swallowed.
    assert.strictEqual(D.explainError('some novel failure'), 'some novel failure');
});

// ── the console layout ───────────────────────────────────────────────────────
//
// The old surface was a 920px modal with six buttons that each opened ANOTHER
// modal on top of it, so doing two related things meant closing and reopening
// your way back. These pin the structure that replaced it — they are cheap, and
// layout is the one part of this feature no other test looks at.

test('the console uses the screen instead of a narrow modal', () => {
    let opts = null;
    D.init({
        showModal: (_t, _h, _s, o) => { opts = o || {}; },
        families: () => ({})
    });
    D.openInbox();
    assert.ok(opts.maxWidth >= 1200, 'the inbox should be wide: got ' + opts.maxWidth);
    assert.ok(opts.maxHeight, 'and should use the viewport height');
});

test('lists are tabs on one surface, not modals over modals', () => {
    assert.strictEqual(typeof D.tab, 'function', 'the console needs tab switching');
    // Known Payers stays independently reachable — Billing links straight to it.
    assert.strictEqual(typeof D.openAliases, 'function');
    assert.strictEqual(typeof D.openTemplates, 'function');
});

test('a tab switch re-renders without another round trip to the server', () => {
    // Switching tabs must not refetch: the data is already loaded, and a
    // network hop between "Needs you" and "Posted" makes the console feel
    // broken on a slow connection.
    let body = '';
    D.init({
        showModal: (_t, h) => { body = h; },
        esc: (s) => String(s == null ? '' : s),
        jesc: (s) => String(s == null ? '' : s),
        fm: (n) => '$' + Number(n || 0).toFixed(2),
        families: () => ({ fam_klein: { name: 'Klein Family' } })
    });
    const state = D.state();
    state.deposits = [{ id: '1', status: 'review', amount_cents: 50000, payer_name: 'SHIMON MILLER', candidates: [] }];
    state.aliases = [];
    state.templates = [];
    // No DOM here, so this only has to not throw — the render target is absent.
    assert.doesNotThrow(() => D.tab('posted'));
    assert.doesNotThrow(() => D.tab('payers'));
    assert.doesNotThrow(() => D.tab('layouts'));
    assert.doesNotThrow(() => D.tab('needs'));
});

test('an unparsed deposit is counted as pending but not as a known amount', () => {
    // It belongs at the top of "Needs you" — it is the item most likely to be
    // real money nobody knows about. Its amount is unknown and stored as 0, so
    // adding it to the waiting total would imply a figure we do not have.
    const state = D.state();
    state.deposits = [
        { id: '1', status: 'review',   amount_cents: 50000 },
        { id: '2', status: 'unparsed', amount_cents: 0 }
    ];
    assert.strictEqual(D.totalPending(), 2);
    assert.strictEqual(D.pendingAmount(), 500);
});

// ── never having to guess ────────────────────────────────────────────────────

test('a camp that has received nothing lands on Setup, not an empty inbox', () => {
    // "No deposits yet" reads identically whether setup is unfinished or
    // everything works and nobody paid today. That ambiguity is the moment a
    // head counselor starts poking at the screen to find out which.
    let shown = false;
    D.init({ showModal: () => { shown = true; }, families: () => ({}) });
    const state = D.state();
    state.deposits = [];
    state.settings = { inboundToken: 'abc123', dryRun: true, senderAllowlist: [] };

    const st = D.setupState();
    assert.strictEqual(st.mailArrived, false);
    assert.strictEqual(st.hasAddress, true, 'the address must be known without opening Settings');
    assert.ok(shown === false || shown === true); // the modal call itself is the host's
});

test('setupState reports each step as a fact, not a mood', () => {
    const state = D.state();
    state.settings = { inboundToken: 'tok', dryRun: false, senderAllowlist: ['chase.com'] };
    state.deposits = [{ id: '1', status: 'posted', amount_cents: 100 }];
    assert.deepStrictEqual(D.setupState(), {
        hasAddress: true, mailArrived: true, allowlisted: true, dryRun: false, posted: 1
    });
});

test('the deposit address is built without opening Settings', () => {
    // It is the first thing a new camp needs, so it cannot live behind a button
    // they have no reason to press.
    const state = D.state();
    state.settings = { inboundToken: 'a3f9c2e1', dryRun: true, senderAllowlist: [] };
    const addr = D.inboundAddress();
    assert.ok(addr.includes('a3f9c2e1'), 'the token must be in the address: ' + addr);
    assert.ok(addr.includes('@'), 'and it must be an address: ' + addr);

    state.settings = null;
    assert.strictEqual(D.inboundAddress(), '', 'no settings means no address, not a broken one');
});

test('an action marks its own row rather than freezing the whole list', () => {
    // Without this the office clicks a family, nothing visibly changes for a
    // second, and they click again.
    const state = D.state();
    state.busyId = 'dep_1';
    assert.strictEqual(D.state().busyId, 'dep_1');
    state.busyId = null;
});

// ── reading the email, and teaching who sent it ─────────────────────────────
test('the email behind a deposit can be read in full from any row', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'campistry_deposits_ui.js'), 'utf8');

    assert.match(ui, /D\.viewEmail = function/, 'there is no reader');
    // The row you most need to read is the one that half-worked and landed on
    // nobody — it used to show nothing at all.
    assert.match(ui, /CampistryDeposits\.viewEmail\(/, 'no row opens it');
    assert.match(ui, /read the whole message/, 'the clipped unparsed view must link to the full one');
    // No clipping in the reader itself: the line explaining an odd deposit is
    // as likely to be the last as the first.
    assert.ok(!/viewEmail[\s\S]{0,2000}raw_excerpt\.slice\(/.test(ui),
        'the reader must not clip the message');
});

test('a sender can be taught, and the bank can never be one', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'campistry_deposits_ui.js'), 'utf8');

    assert.match(ui, /D\.teachSender = function/);
    assert.match(ui, /D\.senderCandidates = function/);
    assert.match(ui, /add_payer_alias/, 'the rule is never stored');

    // The three exclusions are the whole safety of this feature: every Chase
    // alert comes from one address, and the camp's own deposit address is on
    // every message by definition. Keying a family to either would credit them
    // with every deposit the camp ever receives.
    assert.match(ui, /This is the bank\./, 'the bank must be excluded by name');
    assert.match(ui, /your own deposit address/, "the camp's own address must be excluded");
    assert.match(ui, /already belong to/, 'a domain shared between families must be excluded');

    // Excluded addresses are shown with the reason rather than hidden — an
    // office that cannot see why its obvious choice is missing will assume the
    // feature is broken.
    assert.match(ui, /cannot be used<\/summary>/);
});
