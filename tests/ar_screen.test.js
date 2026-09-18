// node --test tests/ar_screen.test.js
//
// campistry_ar.js is proved by tests/ar.test.js. This file proves the SCREEN —
// that the rule is actually reachable from Billing, and that the numbers it is
// handed are derived from the one place that already knows which family an
// enrollment belongs to.
//
// WHY THIS RUNS THE CODE INSTEAD OF MATCHING THE SOURCE. Four times in this
// project a test asserted that a line existed while the branch around it was
// dead, and stayed green through a mutation that disabled the whole thing. The
// derivation here (which installments count as invoices, which payments count as
// payments) is exactly that shape of logic, so the helpers are sliced out of
// campistry_me.js and executed in a vm against stubs. Only the wiring itself —
// the call site and the export — is asserted against the text, because a call
// site is the one thing a running slice cannot show you.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ME = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
const AR = require(path.join(ROOT, 'campistry_ar.js'));

// ── the slice ─────────────────────────────────────────────────────────────

const SLICE_FROM = 'function _arAPI(){';
const SLICE_TO = 'function _liveOnlyNotice(what){';

function loadAr(opts) {
    opts = opts || {};
    const a = ME.indexOf(SLICE_FROM);
    const b = ME.indexOf(SLICE_TO, a);
    assert.ok(a > 0, 'cannot find ' + SLICE_FROM + ' — re-anchor this test');
    assert.ok(b > a, 'cannot find ' + SLICE_TO + ' after it');
    const src = ME.slice(a, b);

    const rendered = [];
    const sandbox = {
        console,
        rendered,
        // The page globals the slice reaches for, and nothing else: anything it
        // needs that is not listed here throws, which is the point.
        window: { CampistryAR: opts.noRule ? null : AR },
        esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/"/g, '&quot;'),
        je: s => String(s == null ? '' : s).replace(/'/g, "\\'"),
        fm: n => '$' + (Number(n) || 0),
        buildFamilyLedgers: () => opts.ledgers || {},
        renderBilling: () => { rendered.push(1); }
    };
    vm.runInContext(src + '\n;this.__api={_arDocsFor:_arDocsFor,_arLastPayment:_arLastPayment,'
        + '_arFamilies:_arFamilies,_arAgingHtml:_arAgingHtml,setArQuery:setArQuery,'
        + 'toggleAging:toggleAging,isOpen:function(){return _arOpen},'
        + 'query:function(){return _arQuery}};', vm.createContext(sandbox));
    const api = sandbox.__api;
    api.renders = rendered;
    return api;
}

/** An installment entry as buildFamilyLedgers pushes it. */
function inst(o) {
    return Object.assign({
        type: 'installment', category: 'Payment 1 of 2', desc: 'Ari — Payment 1 of 2',
        amount: 500, date: '2026-06-01', status: 'pending', ref: 'e1_inst0',
        invoicedAt: '', dueOn: '2026-06-01'
    }, o);
}

// ── what counts as an invoice ─────────────────────────────────────────────

test('a PENDING installment is not an invoice', () => {
    // The whole difference between this and a calendar: nobody has asked yet, so
    // aging it would put the camp's own delay in billing onto the family.
    const api = loadAr();
    // Length, not deepStrictEqual: an array built inside the vm carries the
    // sandbox's Array.prototype, and deepStrictEqual reports that as a content
    // mismatch — which sends you looking in entirely the wrong place.
    assert.strictEqual(api._arDocsFor({ entries: [inst({ status: 'pending' })] }).length, 0);
});

test('an INVOICED installment is an open invoice owed in full', () => {
    const api = loadAr();
    const docs = api._arDocsFor({ entries: [inst({ status: 'invoiced', amount: 500 })] });
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].kind, 'invoice');
    assert.strictEqual(docs[0].status, 'open');
    assert.strictEqual(docs[0].amount, 500);
    assert.strictEqual(docs[0].paid, 0, 'an invoiced installment has been asked for, not paid');
});

test('a PAID installment is closed, so it ages to nothing', () => {
    const api = loadAr();
    const docs = api._arDocsFor({ entries: [inst({ status: 'paid', amount: 500 })] });
    assert.strictEqual(docs[0].status, 'paid');
    assert.strictEqual(docs[0].paid, 500);
    const aged = AR.age({ docs: docs, asOf: '2027-01-01' });
    assert.strictEqual(aged.total, 0, 'a settled invoice must not still be outstanding');
    assert.strictEqual(aged.pastDue, 0);
});

test('the date aged against is what the office ASKED for, not what the schedule intended', () => {
    // A camp that billed the June installment in August asked for it in August.
    // Aging from the schedule's date would invent two months of lateness the
    // family had no opportunity to avoid.
    const api = loadAr();
    const docs = api._arDocsFor({
        entries: [inst({ status: 'invoiced', date: '2026-06-01',
                         invoicedAt: '2026-08-01', dueOn: '2026-08-31' })]
    });
    assert.strictEqual(docs[0].dueDate, '2026-08-31');
    assert.strictEqual(docs[0].issuedOn, '2026-08-01');
    assert.strictEqual(AR.age({ docs: docs, asOf: '2026-09-10' }).oldestDays, 10);
});

test('with no dueOn it falls back to the schedule date rather than to no date', () => {
    const api = loadAr();
    const docs = api._arDocsFor({
        entries: [inst({ status: 'invoiced', dueOn: '', date: '2026-06-01' })]
    });
    assert.strictEqual(docs[0].dueDate, '2026-06-01');
});

test('a zero or negative installment is not an invoice', () => {
    const api = loadAr();
    assert.strictEqual(api._arDocsFor({ entries: [inst({ status: 'invoiced', amount: 0 })] }).length, 0);
    assert.strictEqual(api._arDocsFor({ entries: [inst({ status: 'invoiced', amount: -40 })] }).length, 0);
});

test('charges, credits and payments are not invoices', () => {
    const api = loadAr();
    const docs = api._arDocsFor({ entries: [
        { type: 'charge', amount: 900, status: 'invoiced' },
        { type: 'credit', amount: 100, status: 'invoiced' },
        { type: 'payment', amount: 200, status: 'invoiced' }
    ] });
    assert.strictEqual(docs.length, 0, 'only an installment carries the invoiced event');
});

test('an empty or malformed ledger yields no invoices instead of throwing', () => {
    const api = loadAr();
    assert.strictEqual(api._arDocsFor(null).length, 0);
    assert.strictEqual(api._arDocsFor({}).length, 0);
    assert.strictEqual(api._arDocsFor({ entries: [null, undefined] }).length, 0);
});

// ── when they last paid ───────────────────────────────────────────────────

test('the last payment is the most recent one, whatever order the ledger is in', () => {
    const api = loadAr();
    assert.strictEqual(api._arLastPayment({ entries: [
        { type: 'payment', amount: 100, date: '2026-07-04' },
        { type: 'payment', amount: 100, date: '2026-08-19' },
        { type: 'payment', amount: 100, date: '2026-06-01' }
    ] }), '2026-08-19');
});

test('a refund is not a payment', () => {
    // Money going the other way must never look like a family keeping up.
    const api = loadAr();
    assert.strictEqual(api._arLastPayment({ entries: [
        { type: 'payment', amount: 200, date: '2026-06-01' },
        { type: 'payment', amount: -200, date: '2026-09-01' }
    ] }), '2026-06-01');
});

test('a pending or failed payment is not a payment', () => {
    // A card that has not settled is not money. Counting it would quietly excuse
    // the family from the no-payment-since query, which is the one query that
    // finds the accounts nobody has chased.
    const api = loadAr();
    assert.strictEqual(api._arLastPayment({ entries: [
        { type: 'payment', amount: 200, date: '2026-06-01', status: '' },
        { type: 'payment', amount: 900, date: '2026-09-01', status: 'pending' },
        { type: 'payment', amount: 900, date: '2026-09-02', status: 'failed' }
    ] }), '2026-06-01');
});

test('a family who has never paid reports no last payment, not today', () => {
    const api = loadAr();
    assert.strictEqual(api._arLastPayment({ entries: [] }), '');
    assert.strictEqual(api._arLastPayment(null), '');
});

// ── which accounts the screen covers ──────────────────────────────────────

test('every account Billing lists is an account the aging screen ages', () => {
    // Including the ephemeral `pending_` ledgers an accepted applicant gets —
    // buildFamilyLedgers synthesizes those and never writes them to families{},
    // so a screen that walked families{} would silently skip exactly the people
    // who have just been billed for the first time.
    const ledgers = {
        f1: { family: { name: 'Klein Family' }, entries: [inst({ status: 'invoiced' })] },
        pending_ari_e9: { family: { name: 'Ari Family' }, entries: [] }
    };
    const api = loadAr({ ledgers: ledgers });
    const keys = api._arFamilies(ledgers).map(f => f.key).sort().join(',');
    assert.strictEqual(keys, 'f1,pending_ari_e9');
});

test('with no argument it builds the ledgers itself', () => {
    // Billing passes the ledgers it already computed; anything else calling this
    // must still get an answer rather than an empty screen.
    const ledgers = { f1: { family: { name: 'Klein Family' }, entries: [] } };
    const api = loadAr({ ledgers: ledgers });
    assert.strictEqual(api._arFamilies().length, 1);
});

test('a family with no name falls back to its key, not to blank', () => {
    const ledgers = { f1: { family: {}, entries: [] } };
    const api = loadAr({ ledgers: ledgers });
    assert.strictEqual(api._arFamilies(ledgers)[0].name, 'f1');
});

// ── the screen ────────────────────────────────────────────────────────────

const LATE = {
    f1: {
        family: { name: 'Klein Family' },
        entries: [
            inst({ status: 'invoiced', amount: 500, invoicedAt: '2026-06-01', dueOn: '2026-06-01' }),
            { type: 'payment', amount: 250, date: '2026-05-01' }
        ]
    }
};

test('the screen is COLLAPSED by default and says why you would open it', () => {
    // This page was deliberately stripped to one search box and one dropdown.
    // Four filters and a table permanently expanded above the account list would
    // undo that, so closed it is one line carrying the deciding number.
    const api = loadAr({ ledgers: LATE });
    const h = api._arAgingHtml(LATE);
    assert.strictEqual(api.isOpen(), false);
    assert.match(h, /Aging report<\/button>/, 'there must be a way to open it');
    assert.match(h, /past due across 1 family/);
    assert.ok(!/<table/.test(h), 'the table must not render while collapsed');
});

test('opening it renders the aged table, and closing it puts it away', () => {
    const api = loadAr({ ledgers: LATE });
    api.toggleAging();
    assert.strictEqual(api.isOpen(), true);
    assert.strictEqual(api.renders.length, 1, 'the toggle must re-render Billing');
    const h = api._arAgingHtml(LATE);
    assert.match(h, /<table/);
    assert.match(h, /Klein Family/);
    assert.match(h, /Hide<\/button>/);
    api.toggleAging();
    assert.strictEqual(api.isOpen(), false);
    assert.ok(!/<table/.test(api._arAgingHtml(LATE)));
});

test('the Open button goes to a function that EXISTS', () => {
    // It pointed at CampistryMe.openFamilyDetail, which was never defined
    // anywhere in the app: every row on this screen was a dead click. The real
    // entry point is viewFamily, which checks the key against the LEDGERS and so
    // also works for a synthesized pending_ account.
    const api = loadAr({ ledgers: LATE });
    api.toggleAging();
    const h = api._arAgingHtml(LATE);
    assert.match(h, /CampistryMe\.viewFamily\('f1'\)/);
    assert.ok(!/openFamilyDetail/.test(h));
    assert.ok(!/function openFamilyDetail|openFamilyDetail\s*:/.test(ME),
        'openFamilyDetail still does not exist — nothing may link to it');
    assert.match(ME, /\n    viewFamily:viewFamily,/, 'viewFamily must stay exported');
});

test('a camp that has never invoiced anybody is told so, not shown an empty table', () => {
    // The commonest reason this screen is blank and the least obvious one. A camp
    // that has not billed has families who owe nothing YET — not families who are
    // late — and an empty aging table says the opposite.
    const quiet = { f1: { family: { name: 'Klein Family' },
                          entries: [inst({ status: 'pending' })] } };
    const api = loadAr({ ledgers: quiet });
    assert.match(api._arAgingHtml(quiet), /Nothing has been invoiced yet/);
    api.toggleAging();
    const open = api._arAgingHtml(quiet);
    assert.match(open, /families who owe\s+nothing yet/);
    assert.ok(!/<table/.test(open), 'there is nothing to tabulate');
    assert.ok(!/No payment since/.test(open),
        'filters over an empty set are furniture');
});

test('the collapsed line distinguishes "nothing late" from "nothing billed"', () => {
    const paidUp = { f1: { family: { name: 'Klein Family' },
                           entries: [inst({ status: 'invoiced', dueOn: '2099-01-01' })] } };
    const api = loadAr({ ledgers: paidUp });
    const h = api._arAgingHtml(paidUp);
    assert.match(h, /Nothing past due/);
    assert.ok(!/Nothing has been invoiced/.test(h),
        'it HAS been invoiced — it just is not late');
});

test('the collapsed summary ignores the filters', () => {
    // Otherwise the one line that tells you whether to open the screen is
    // answering a question you cannot see, and reads as "there is nothing here".
    const api = loadAr({ ledgers: LATE });
    api.setArQuery('minPastDue', 99999);
    const h = api._arAgingHtml(LATE);
    assert.match(h, /past due across 1 family/);
});

test('a filter that matches nobody says so instead of rendering an empty table', () => {
    const api = loadAr({ ledgers: LATE });
    api.toggleAging();
    api.setArQuery('minPastDue', 99999);
    const h = api._arAgingHtml(LATE);
    assert.match(h, /Nobody matches that/);
    assert.match(h, /widening the filters/);
    assert.ok(!/<table/.test(h));
});

test('the filters are the AR rule’s own criteria, applied', () => {
    const api = loadAr({ ledgers: LATE });
    api.toggleAging();
    assert.match(api._arAgingHtml(LATE), /Klein Family/);
    // Nothing is older than this, so the family drops out.
    api.setArQuery('minDaysLate', 99999);
    assert.ok(!/Klein Family/.test(api._arAgingHtml(LATE)));
    api.setArQuery('minDaysLate', 0);
    api.setArQuery('bucket', 'current');
    assert.ok(!/Klein Family/.test(api._arAgingHtml(LATE)),
        'a long-overdue invoice has nothing in the current bucket');
    api.setArQuery('bucket', '');
    assert.match(api._arAgingHtml(LATE), /Klein Family/);
});

test('an unknown filter field is ignored rather than added', () => {
    const api = loadAr({ ledgers: LATE });
    api.setArQuery('deleteEverything', 1);
    assert.ok(!('deleteEverything' in api.query()));
});

test('every bucket the rule defines gets a tile', () => {
    const api = loadAr({ ledgers: LATE });
    api.toggleAging();
    const h = api._arAgingHtml(LATE);
    AR.BUCKETS.forEach(b => assert.ok(h.indexOf(b.label) >= 0,
        'the ' + b.id + ' bucket has no tile — money would age into a column nobody shows'));
});

test('a family who never paid shows "never", not a blank cell', () => {
    const never = { f1: { family: { name: 'Klein Family' },
                          entries: [inst({ status: 'invoiced', dueOn: '2026-06-01' })] } };
    const api = loadAr({ ledgers: never });
    api.toggleAging();
    assert.match(api._arAgingHtml(never), />never</);
});

test('a page without campistry_ar.js renders nothing at all, and does not throw', () => {
    // campistry_me.js is loaded by several pages. A missing module must mean the
    // screen is absent, never a broken render that takes Billing down with it.
    const api = loadAr({ noRule: true, ledgers: LATE });
    assert.strictEqual(api._arAgingHtml(LATE), '',
        'no rule, no screen \u2014 and no exception taking Billing down with it');
    // The derivation itself deliberately does NOT depend on the rule: reading the
    // ledger is arithmetic, and making it conditional would mean a page without
    // campistry_ar.js disagreed with one that has it about what a family was asked
    // to pay. It is only the aging and the markup that need the rule.
    assert.strictEqual(api._arDocsFor({ entries: [inst({ status: 'invoiced' })] }).length, 1);
    assert.strictEqual(api._arFamilies(LATE).length, 1);
});

test('a family name is escaped, and a key is escaped for the onclick', () => {
    const nasty = { "o'brien": { family: { name: '<script>x</script>' },
                                 entries: [inst({ status: 'invoiced', dueOn: '2026-06-01' })] } };
    const api = loadAr({ ledgers: nasty });
    api.toggleAging();
    const h = api._arAgingHtml(nasty);
    assert.ok(!/<script>x<\/script>/.test(h), 'a family name must not execute');
    assert.match(h, /viewFamily\('o\\'brien'\)/, 'an apostrophe must not break the handler');
});

// ── the wiring a running slice cannot show you ────────────────────────────

test('renderBilling actually renders the screen', () => {
    const a = ME.indexOf('function renderBilling(){');
    const b = ME.indexOf('\nfunction ', a + 10);
    assert.ok(a > 0 && b > a);
    const body = ME.slice(a, b);
    // ANCHORED AT THE START OF THE LINE, deliberately. A bare /h\+=_arAgingHtml/
    // matches just as happily inside `if(false)h+=_arAgingHtml(ledgers);`, which
    // is precisely the mutation this test exists to catch — and is the fifth time
    // in this project a source assertion has quietly passed over dead code.
    assert.match(body, /\n    h\+=_arAgingHtml\(ledgers\);\n/,
        'the aging screen is not called unconditionally — a tested module nothing renders');
    assert.strictEqual((body.match(/_arAgingHtml\(/g) || []).length, 1,
        'exactly one call site, so there is one answer to where this renders');
    // Handed the ledgers Billing already built, not a second build of its own.
    assert.ok(body.indexOf('_arAgingHtml(ledgers)') > body.indexOf('var ledgers=buildFamilyLedgers()'),
        'it must reuse the ledgers, not recompute them');
});

test('the toggle and the filters are reachable from the markup', () => {
    assert.match(ME, /\n    toggleAging:toggleAging,/, 'toggleAging is not exported');
    assert.match(ME, /setArQuery:setArQuery,/, 'setArQuery is not exported');
});

test('the ledger carries invoicedAt and dueOn on every installment entry', () => {
    // This is what lets aging be derived from the ledger instead of re-deciding
    // which family owns an enrollment. Drop them and the screen silently ages
    // every invoice from the schedule's date again.
    const a = ME.indexOf("type:'installment'");
    assert.ok(a > 0);
    const push = ME.slice(a, a + 400);
    assert.match(push, /invoicedAt:inst\.invoicedAt\|\|''/);
    assert.match(push, /dueOn:inst\.invoiceDueDate\|\|inst\.dueDate\|\|''/);
});

test('a one-payment plan that has been invoiced is not hidden', () => {
    // A lone installment used to be suppressed as "the tuition charge restated".
    // Once invoiced it is a real event, and the aging report reads these entries.
    const a = ME.indexOf('var _schedSeen=');
    assert.ok(a > 0, 'the guard is gone — a one-payment plan cannot be aged');
    const guard = ME.slice(a, a + 220);
    assert.match(guard, /schedule\.length>1/);
    assert.match(guard, /String\(\(schedule\[0\]\|\|\{\}\)\.status\|\|'pending'\)!=='pending'/);
});

test('campistry_me.html loads campistry_ar.js before campistry_me.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'campistry_me.html'), 'utf8');
    const ar = html.indexOf('src="campistry_ar.js');
    const me = html.indexOf('src="campistry_me.js');
    assert.ok(ar > 0, 'campistry_ar.js is not loaded at all — the screen would never appear');
    assert.ok(me > 0);
    assert.ok(ar < me, 'the rule must load first');
    assert.match(html.slice(ar, ar + 60), /\?v=/, 'it needs a cache-bust like every other script');
});
