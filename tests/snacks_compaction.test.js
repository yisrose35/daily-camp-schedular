// node --test tests/snacks_compaction.test.js
//
// Ledger compaction for the canteen (task #57, on migration 203's archive).
//
// The transactions array was prepend-only and unbounded: every register sale,
// office save and parent deposit rewrote the whole season. It could not simply
// be trimmed — balances are Σ of that very array, so a trim rewrites every
// balance on the next save. Compaction FOLDS instead: rows older than a
// watermark are summed into ledgerCarry (the exact three buckets
// _reconcileBalances attributes by) and removed. Balance = carry + Σ(live).
//
// The invariant every test here circles: THE FOLD MUST NOT MOVE A BALANCE, and
// neither may anything that happens afterwards — a stale tab merging, a second
// fold, a register sale racing the save. The functions under test are the real
// ones, extracted from campistry_snacks.js and executed; the action runs
// against a fake client with real compare-and-set semantics.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SNACKS = read('campistry_snacks.js');
const POS = read('campistry_snacks_pos.js');

/** Brace-matched extraction of `function NAME(` or `window.NAME = async function(`. */
function sourceOf(src, name) {
    let at = src.indexOf(`function ${name}(`);
    if (at === -1) at = src.indexOf(`window.${name} = async function(`);
    if (at === -1) at = src.indexOf(`window.${name} = function(`);
    assert.notStrictEqual(at, -1, `${name} not found`);
    // `async function NAME(` — keep the keyword, or every await inside is a
    // syntax error once the body is evaluated on its own.
    if (src.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
    let i = src.indexOf('{', src.indexOf('(', at)), depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
        else if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } }
        else if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const PURE = ['_txSig', '_txFolded', '_ledgerBuckets', '_mergeCompaction', '_reconcileBalances',
              '_mergeSnacksInto', '_dateDaysBefore', '_cents', '_snacksCompactPlan', '_casWriteSnacks'];

/** A context holding the real pure helpers. */
function pure() {
    const ctx = { console, JSON, Math, Date, Object, Number, parseFloat, parseInt, isFinite, String, RegExp };
    vm.createContext(ctx);
    vm.runInContext(PURE.map(n => sourceOf(SNACKS, n)).join('\n') + '\n;globalThis.__x = {' +
        PURE.map(n => `${n}: ${n}`).join(',') + '};', ctx);
    return ctx.__x;
}
const X = pure();

// ── fixtures ───────────────────────────────────────────────────────────────
function tx(date, camper, type, amount, extra) {
    return Object.assign({ date, time: '12:00 PM', camper, type, amount, items: type === 'credit' ? '' : 'Snack' }, extra || {});
}
/** A camp part-way through a season: id'd rows, legacy name-only rows, a tip. */
function ledger() {
    return {
        accounts: {
            'Ari Katz':   { balance: 0, dailyLimit: 10, camperId: 'c1' },
            'Ben Levy':   { balance: 0, dailyLimit: 10 },                  // legacy: no id
            'Cara Moss':  { balance: 7.25, dailyLimit: 10, camperId: 'c3' }, // no transactions at all
        },
        transactions: [
            tx('2026-08-10', 'Ari Katz', 'debit', 3.5,  { camperId: 'c1' }),
            tx('2026-08-01', 'Ari Katz', 'credit', 50,  { camperId: 'c1' }),
            tx('2026-07-20', 'Ari Katz', 'debit', 2.25),                     // name-only, counts for Ari
            tx('2026-07-15', 'Ben Levy', 'credit', 20),
            tx('2026-07-16', 'Ben Levy', 'debit', 4.75),
            tx('2026-08-09', 'Ben Levy', 'tip', 5),
            { camper: 'Ben Levy', type: 'debit', amount: 1, time: '1:00 PM', items: 'No date' }, // legacy, undated
            tx('2026-06-30', 'Dina Roth', 'credit', 10),                     // no account (deleted camper)
        ],
        inventory: [{ name: 'Slush', price: 2 }],
        settings: { defaultDailyLimit: 10 },
    };
}
const balances = d => Object.fromEntries(Object.entries(d.accounts).map(([k, a]) => [k, X._cents(a.balance)]));

test('fixture sanity: reconcile gives the expected balances', () => {
    const d = X._reconcileBalances(JSON.parse(JSON.stringify(ledger())));
    assert.deepStrictEqual(balances(d), {
        'Ari Katz': 44.25,   // 50 − 3.5 − 2.25
        'Ben Levy': 9.25,    // 20 − 4.75 − 5 − 1
        'Cara Moss': 7.25,   // untouched: no rows anywhere
    });
});

// ── _txFolded ──────────────────────────────────────────────────────────────
test('_txFolded: at or before the watermark, well-formed dates only', () => {
    assert.strictEqual(X._txFolded(tx('2026-08-01', 'a', 'debit', 1), '2026-08-01'), true, 'inclusive');
    assert.strictEqual(X._txFolded(tx('2026-07-31', 'a', 'debit', 1), '2026-08-01'), true);
    assert.strictEqual(X._txFolded(tx('2026-08-02', 'a', 'debit', 1), '2026-08-01'), false);
    assert.strictEqual(X._txFolded({ camper: 'a', amount: 1 }, '2026-08-01'), false, 'undated: never folded');
    assert.strictEqual(X._txFolded(tx('8/1/2026', 'a', 'debit', 1), '2026-08-01'), false, 'malformed: never folded');
    assert.strictEqual(X._txFolded(tx('2026-07-01', 'a', 'debit', 1), ''), false, 'no watermark: nothing folds');
    assert.strictEqual(X._txFolded(null, '2026-08-01'), false);
});

// ── _ledgerBuckets and _reconcileBalances ──────────────────────────────────
test('_ledgerBuckets: the attribution rules are the ones _reconcileBalances always had', () => {
    const b = X._ledgerBuckets(ledger().transactions);
    assert.strictEqual(X._cents(b.byId.c1), 46.5, 'id rows: 50 − 3.5');
    assert.strictEqual(X._cents(b.byNameNoId['Ari Katz']), -2.25, 'the name-only row is separate');
    assert.strictEqual(X._cents(b.byName['Ari Katz']), 44.25, 'byName sees both');
    assert.strictEqual(X._cents(b.byName['Ben Levy']), 9.25);
    assert.strictEqual(b.byId.c3, undefined, 'no rows, no bucket');
});

test('_ledgerBuckets: a carry seeds the buckets before live rows are added', () => {
    const b = X._ledgerBuckets([tx('2026-08-10', 'Ari Katz', 'debit', 1, { camperId: 'c1' })],
                               { byId: { c1: 10 }, byName: { 'Ari Katz': 10 }, byNameNoId: { 'Zed': -2 } });
    assert.strictEqual(b.byId.c1, 9);
    assert.strictEqual(b.byName['Ari Katz'], 9);
    assert.strictEqual(b.byNameNoId.Zed, -2, 'untouched carry keys survive');
});

test('_reconcileBalances without a carry behaves exactly as before', () => {
    // No ledgerCarry: the seeding is a no-op, so nothing about a camp that has
    // never compacted changes. The identity test in canteen_identity.test.js
    // still holds the two copies together; this holds the behaviour.
    const d = X._reconcileBalances(JSON.parse(JSON.stringify(ledger())));
    assert.deepStrictEqual(balances(d), { 'Ari Katz': 44.25, 'Ben Levy': 9.25, 'Cara Moss': 7.25 });
});

test('_reconcileBalances with a carry: balance = carry + live, and carry alone is enough', () => {
    const d = {
        accounts: { 'Ari Katz': { balance: 0, camperId: 'c1' }, 'Only Carry': { balance: 0 }, 'Nothing': { balance: 3 } },
        transactions: [tx('2026-08-10', 'Ari Katz', 'debit', 3.5, { camperId: 'c1' })],
        ledgerCarry: { byId: { c1: 47.75 }, byName: { 'Ari Katz': 47.75, 'Only Carry': 12 }, byNameNoId: { 'Only Carry': 12 } },
    };
    X._reconcileBalances(d);
    assert.strictEqual(d.accounts['Ari Katz'].balance, 44.25);
    assert.strictEqual(d.accounts['Only Carry'].balance, 12, 'every row folded: the carry IS the balance');
    assert.strictEqual(d.accounts['Nothing'].balance, 3, 'no rows and no carry: left alone, as always');
});

// ── _mergeCompaction ───────────────────────────────────────────────────────
test('_mergeCompaction: with no watermark anywhere it changes nothing', () => {
    const merged = {}, tx1 = ledger().transactions;
    const out = X._mergeCompaction(merged, tx1, { transactions: [] }, { transactions: [] });
    assert.strictEqual(out, tx1);
    assert.strictEqual(merged.ledgerCompactedThrough, undefined);
    assert.strictEqual(merged.ledgerCarry, undefined);
});

test('_mergeCompaction: the cloud watermark drops folded rows and keeps the cloud carry', () => {
    const cloud = { ledgerCompactedThrough: '2026-07-31', ledgerCarry: { byId: { c1: 1 }, byName: {}, byNameNoId: {} } };
    const local = {};   // a stale tab that never heard of compaction
    const merged = {};
    const out = X._mergeCompaction(merged, ledger().transactions, cloud, local);
    assert.ok(out.every(t => !X._txFolded(t, '2026-07-31')), 'a stale local must not resurrect folded rows');
    assert.ok(out.some(t => t.items === 'No date'), 'an undated legacy row is never dropped');
    assert.strictEqual(merged.ledgerCompactedThrough, '2026-07-31');
    assert.deepStrictEqual(merged.ledgerCarry, cloud.ledgerCarry);
});

test('_mergeCompaction: the higher watermark wins, and brings its own carry', () => {
    const cloud = { ledgerCompactedThrough: '2026-07-15', ledgerCarry: { tag: 'cloud' } };
    const local = { ledgerCompactedThrough: '2026-07-31', ledgerCarry: { tag: 'local' } };
    const merged = {};
    X._mergeCompaction(merged, [], cloud, local);
    assert.strictEqual(merged.ledgerCompactedThrough, '2026-07-31');
    assert.deepStrictEqual(merged.ledgerCarry, { tag: 'local' },
        'the carry must belong to the watermark it was folded at, or rows count twice');
    const m2 = {};
    X._mergeCompaction(m2, [], { ledgerCompactedThrough: '2026-07-31', ledgerCarry: { tag: 'cloud' } },
                                { ledgerCompactedThrough: '2026-07-31', ledgerCarry: { tag: 'local' } });
    assert.deepStrictEqual(m2.ledgerCarry, { tag: 'cloud' }, 'on a tie the fresher cloud copy wins');
});

// ── _mergeSnacksInto: the stale-tab scenario end to end ────────────────────
test('a stale tab merging into a compacted cloud cannot change a balance', () => {
    // Before compaction, both tabs agree on the truth:
    const truth = balances(X._reconcileBalances(JSON.parse(JSON.stringify(ledger()))));
    // The office compacts (through July) — the cloud now holds the fold:
    const plan = X._snacksCompactPlan(JSON.parse(JSON.stringify(ledger())), 10, '2026-08-10'); // watermark 2026-07-31
    assert.strictEqual(plan.watermark, '2026-07-31');
    const cloud = plan.result;
    // A stale tab still holds the full pre-compaction ledger and adds a sale:
    const stale = JSON.parse(JSON.stringify(ledger()));
    stale.transactions.unshift(tx('2026-08-11', 'Ben Levy', 'debit', 2));
    const merged = X._mergeSnacksInto(cloud, stale);
    // Folded rows must not be back, the new sale must be in, balances exact:
    assert.ok(merged.transactions.every(t => !X._txFolded(t, '2026-07-31')));
    assert.ok(merged.transactions.some(t => t.date === '2026-08-11'));
    assert.strictEqual(merged.ledgerCompactedThrough, '2026-07-31');
    const expect = Object.assign({}, truth, { 'Ben Levy': X._cents(truth['Ben Levy'] - 2) });
    assert.deepStrictEqual(balances(merged), expect);
});

test('_mergeSnacksInto without a cloud returns the local data untouched', () => {
    const d = ledger();
    assert.strictEqual(X._mergeSnacksInto(null, d), d);
    assert.strictEqual(X._mergeSnacksInto('junk', d), d);
});

// ── _dateDaysBefore ────────────────────────────────────────────────────────
test('_dateDaysBefore: calendar arithmetic across month and year edges', () => {
    assert.strictEqual(X._dateDaysBefore('2026-08-10', 10), '2026-07-31');
    assert.strictEqual(X._dateDaysBefore('2026-03-01', 1), '2026-02-28');
    assert.strictEqual(X._dateDaysBefore('2028-03-01', 1), '2028-02-29', 'leap year');
    assert.strictEqual(X._dateDaysBefore('2026-01-05', 10), '2025-12-26');
    assert.strictEqual(X._dateDaysBefore('2026-08-10', 0), '2026-08-10');
    assert.strictEqual(X._dateDaysBefore('2026-08-10', -3), '2026-08-10', 'negative days clamp to 0');
    assert.strictEqual(X._dateDaysBefore('garbage', 5), '');
});

// ── _snacksCompactPlan ─────────────────────────────────────────────────────
test('the plan folds exactly the window, keeps the rest live, and moves no balance', () => {
    const d = ledger();
    const before = balances(X._reconcileBalances(JSON.parse(JSON.stringify(d))));
    const plan = X._snacksCompactPlan(d, 10, '2026-08-10');
    assert.strictEqual(plan.invariantOk, true, `drift: ${plan.drift}`);
    assert.strictEqual(plan.watermark, '2026-07-31');
    assert.strictEqual(plan.oldWatermark, '');
    assert.strictEqual(plan.dropped.length, 0, 'nothing was carried before');  // length, not deepStrictEqual: vm arrays are another realm's
    assert.strictEqual(plan.folded.length, 4, 'Ari 07-20, Ben 07-15, Ben 07-16, Dina 06-30');
    assert.strictEqual(plan.live.length, 4, 'Ari 08-10, Ari 08-01, Ben tip 08-09, the undated row');
    assert.deepStrictEqual(balances(plan.result), before);
    assert.strictEqual(plan.result.ledgerCompactedThrough, '2026-07-31');
    // the carry: Ari's name-only −2.25, Ben's +20 −4.75, Dina's +10
    assert.strictEqual(plan.result.ledgerCarry.byNameNoId['Ari Katz'], -2.25);
    assert.strictEqual(plan.result.ledgerCarry.byName['Ben Levy'], 15.25);
    assert.strictEqual(plan.result.ledgerCarry.byName['Dina Roth'], 10,
        'a deleted camper\'s history is carried too, so a recreated account finds it');
});

test('the plan never mutates its input', () => {
    const d = ledger();
    const snapshot = JSON.stringify(d);
    X._snacksCompactPlan(d, 10, '2026-08-10');
    assert.strictEqual(JSON.stringify(d), snapshot);
});

test('a second fold cannot count a row twice', () => {
    // Fold through July, then — after a stale tab resurrected an old row —
    // fold through August 5th. The resurrected row is `dropped`, never folded.
    const first = X._snacksCompactPlan(ledger(), 10, '2026-08-10');       // through 07-31
    const truth = balances(first.result);
    const again = JSON.parse(JSON.stringify(first.result));
    again.transactions.push(tx('2026-07-16', 'Ben Levy', 'debit', 4.75)); // resurrected by a stale tab
    const second = X._snacksCompactPlan(again, 5, '2026-08-10');           // through 08-05
    assert.strictEqual(second.oldWatermark, '2026-07-31');
    assert.strictEqual(second.dropped.length, 1, 'the resurrected row is dropped, not re-folded');
    assert.strictEqual(second.folded.length, 1, 'only Ari 08-01 is in the new window');
    assert.strictEqual(second.invariantOk, true);
    assert.deepStrictEqual(balances(second.result), truth);
    assert.ok(!second.result.transactions.some(t => t.date === '2026-07-16'));
});

test('a fold that would not advance the watermark is a no-op', () => {
    const first = X._snacksCompactPlan(ledger(), 10, '2026-08-10');
    const same = X._snacksCompactPlan(first.result, 10, '2026-08-10');
    assert.strictEqual(same.nothing, true);
    assert.strictEqual(same.watermark, '2026-07-31');
    const older = X._snacksCompactPlan(first.result, 30, '2026-08-10');
    assert.strictEqual(older.nothing, true, 'a wider keep window cannot un-fold');
});

test('the carry is stored to the cent', () => {
    const d = { accounts: { A: { balance: 0 } }, transactions: [
        tx('2026-07-01', 'A', 'credit', 0.1), tx('2026-07-02', 'A', 'credit', 0.2), tx('2026-07-03', 'A', 'debit', 0.3)] };
    const plan = X._snacksCompactPlan(d, 1, '2026-08-10');
    assert.strictEqual(plan.result.ledgerCarry.byName.A, 0, '0.1 + 0.2 − 0.3 is not 5.5e-17 in a ledger');
    assert.strictEqual(plan.invariantOk, true);
});

test('a bad today refuses rather than folding against an empty watermark', () => {
    assert.strictEqual(X._snacksCompactPlan(ledger(), 10, 'nope').error, 'bad_date');
});

// ── _casWriteSnacks ────────────────────────────────────────────────────────
/** A fake camp_state_kv row with real compare-and-set behaviour. */
function fakeClient(row, opts) {
    const state = { row: JSON.parse(JSON.stringify(row)), writes: [], rpcs: [] };
    const verify = (opts && opts.verify) || (() => ({ success: true, inSync: true, blobTransactions: state.row.value.transactions.length, missingFromArchive: 0 }));
    const builder = (kind, payload) => {
        const filters = {};
        const b = {
            eq(k, v) { filters[k] = v; return b; },
            select() {
                if (kind === 'select') return { maybeSingle: () => Promise.resolve({ data: { value: state.row.value, updated_at: state.row.updated_at } }) };
                // update
                if (opts && opts.updateError) return Promise.resolve({ error: { message: opts.updateError } });
                if (filters.updated_at !== undefined && filters.updated_at !== state.row.updated_at) return Promise.resolve({ data: [] });
                state.row.value = JSON.parse(JSON.stringify(payload.value));
                state.row.updated_at = payload.updated_at + '#' + (state.writes.length + 1);
                state.writes.push(JSON.parse(JSON.stringify(payload.value)));
                // The stamp a real UPDATE ... RETURNING hands back is the one THIS
                // write set. A racer's write comes after it — so capture first,
                // then let the simulated racer move the row on.
                const returned = state.row.updated_at;
                if (opts && opts.afterWrite) opts.afterWrite(state, state.writes.length);
                return Promise.resolve({ data: [{ updated_at: returned }] });
            },
            maybeSingle() { return Promise.resolve({ data: { value: state.row.value, updated_at: state.row.updated_at } }); },
        };
        return b;
    };
    const client = {
        from() { return { select: () => builder('select'), update: (payload) => builder('update', payload) }; },
        rpc(name, args) { state.rpcs.push([name, args]); return Promise.resolve({ data: verify(state) }); },
    };
    return { client, state };
}

test('_casWriteSnacks: writes when the stamp matches, returns the new stamp', async () => {
    const { client, state } = fakeClient({ value: { a: 1 }, updated_at: 'T0' });
    const stamp = await X._casWriteSnacks(client, 'camp', { a: 2 }, 'T0');
    assert.ok(stamp && stamp !== 'T0');
    assert.deepStrictEqual(state.row.value, { a: 2 });
});

test('_casWriteSnacks: returns null and writes nothing when someone wrote first', async () => {
    const { client, state } = fakeClient({ value: { a: 1 }, updated_at: 'T1' });
    assert.strictEqual(await X._casWriteSnacks(client, 'camp', { a: 2 }, 'T0'), null);
    assert.deepStrictEqual(state.row.value, { a: 1 }, 'the racing write must survive');
});

test('_casWriteSnacks: no expected stamp means an unconditional write', async () => {
    const { client, state } = fakeClient({ value: { a: 1 }, updated_at: 'T9' });
    assert.ok(await X._casWriteSnacks(client, 'camp', { a: 3 }, null));
    assert.deepStrictEqual(state.row.value, { a: 3 });
});

test('_casWriteSnacks: a database error throws', async () => {
    const { client } = fakeClient({ value: {}, updated_at: 'T0' }, { updateError: 'permission denied' });
    await assert.rejects(() => X._casWriteSnacks(client, 'camp', {}, 'T0'), /permission denied/);
});

// ── the action, end to end against the fake client ─────────────────────────
function actionHarness(cloudValue, opts) {
    const { client, state } = fakeClient({ value: cloudValue, updated_at: 'T0' }, opts);
    const els = {
        compactDays: { value: String((opts && opts.days) || 30) },
        compactBtn: { disabled: false, textContent: '' },
        compactResult: { style: {}, textContent: '' },
        ledgerCompactBox: { innerHTML: '' },
    };
    const store = {};
    const toasts = [], renders = [];
    const ctx = {
        console: { error() {}, warn() {}, log() {} }, JSON, Math, Date, Object, Number, parseFloat, parseInt, isFinite, String, RegExp, Promise,
        window: { CampistryDB: { client, getCampId: () => 'camp-1' } },
        document: { getElementById: id => els[id] || null },
        localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        STORE_KEY: 'campGlobalSettings_v1', SNACKS_LOCAL_KEY: 'snacks_local',
        _secEdit: () => (opts && opts.denied) ? false : true,
        toast: m => toasts.push(m),
        todayStr: () => (opts && opts.today) || '2026-08-10',
        renderStats: () => renders.push('stats'), rAccounts: () => renders.push('accounts'),
        rAnalytics: () => renders.push('analytics'), rSettings: () => renders.push('settings'),
        esc: s => String(s),
        snacks: JSON.parse(JSON.stringify((opts && opts.local) || cloudValue)),
    };
    vm.createContext(ctx);
    vm.runInContext(PURE.map(n => sourceOf(SNACKS, n)).join('\n') + '\n' + sourceOf(SNACKS, 'compactSnacksLedger') + '\n;globalThis.__run = window.compactSnacksLedger;', ctx);
    return { run: ctx.__run, ctx, state, els, toasts, renders, store };
}

test('the action: lands the ledger, verifies the archive, folds, and saves with CAS', async () => {
    const h = actionHarness(ledger(), { days: 10 });
    const truth = balances(X._reconcileBalances(JSON.parse(JSON.stringify(ledger()))));
    await h.run();
    assert.strictEqual(h.state.writes.length, 2, 'write A (unfolded) then write B (folded)');
    assert.ok(!h.state.writes[0].ledgerCompactedThrough, 'A carries no fold — it exists to get everything archived');
    assert.strictEqual(h.state.writes[1].ledgerCompactedThrough, '2026-07-31');
    assert.deepStrictEqual(h.state.rpcs.map(r => r[0]), ['verify_canteen_archive'], 'verified between A and B');
    assert.deepStrictEqual(balances(h.state.row.value), truth, 'the cloud balances did not move');
    assert.strictEqual(h.ctx.snacks.ledgerCompactedThrough, '2026-07-31', 'the page now holds the compacted ledger');
    assert.ok(h.els.compactResult.textContent.startsWith('Archived 4 transaction'), h.els.compactResult.textContent);
    assert.ok(h.renders.includes('settings') && h.renders.includes('accounts'));
    assert.strictEqual(h.els.compactBtn.disabled, false, 'button re-enabled');
});

test('the action: a register sale landing after write A makes it start over, and nothing is lost', async () => {
    let injected = false;
    const h = actionHarness(ledger(), {
        days: 10,
        afterWrite(state, n) {
            // simulate the POS writing a sale between A and B, exactly once
            if (n === 1 && !injected) {
                injected = true;
                state.row.value.transactions.unshift(tx('2026-08-10', 'Ben Levy', 'debit', 1.5));
                state.row.updated_at = 'POS-WROTE';
            }
        },
    });
    await h.run();
    // A, (B fails CAS), A again, B
    assert.strictEqual(h.state.writes.length, 3);
    const final = h.state.row.value;
    assert.ok(final.transactions.some(t => t.amount === 1.5 && t.camper === 'Ben Levy'), 'the racing sale survived');
    assert.strictEqual(final.ledgerCompactedThrough, '2026-07-31');
    const expectBen = X._cents(9.25 - 1.5);
    assert.strictEqual(balances(final)['Ben Levy'], expectBen);
});

test('the action: an archive that is behind stops everything before any row is dropped', async () => {
    const h = actionHarness(ledger(), {
        days: 10,
        verify: () => ({ success: true, inSync: false, blobTransactions: 8, missingFromArchive: 2 }),
    });
    await h.run();
    assert.strictEqual(h.state.writes.length, 1, 'write A only — the fold never happened');
    assert.ok(!h.state.row.value.ledgerCompactedThrough);
    assert.match(h.els.compactResult.textContent, /archive is behind/i);
    assert.strictEqual(h.els.compactResult.style.color, 'var(--red-600)');
});

test('the action: a verifier counting a different ledger is a race, retried, never folded', async () => {
    // inSync:true but blobTransactions disagreeing with what THIS tab just
    // landed means a sale arrived between write A and the check — the verifier
    // looked at a value we have not seen. That is not "archive behind" (nothing
    // is missing); it is a reason to re-read. Here it never agrees, so the
    // action re-lands three times and gives up without ever dropping a row.
    const h = actionHarness(ledger(), {
        days: 10,
        verify: () => ({ success: true, inSync: true, blobTransactions: 3, missingFromArchive: 0 }),
    });
    await h.run();
    assert.strictEqual(h.state.writes.length, 3, 'write A each attempt, never write B');
    assert.ok(h.state.writes.every(w => !w.ledgerCompactedThrough));
    assert.ok(!h.state.row.value.ledgerCompactedThrough);
    assert.match(h.els.compactResult.textContent, /register was busy/);
});

test('the action: a verifier error changes nothing', async () => {
    const h = actionHarness(ledger(), { days: 10, verify: () => ({ success: false, error: 'not_authorized' }) });
    await h.run();
    assert.strictEqual(h.state.writes.length, 1);
    assert.match(h.els.compactResult.textContent, /Could not confirm the archive/);
});

test('the action: refuses to keep fewer than 7 days, before touching anything', async () => {
    const h = actionHarness(ledger(), { days: 3 });
    await h.run();
    assert.strictEqual(h.state.writes.length, 0);
    assert.ok(h.toasts.some(t => /at least 7 days/.test(t)));
});

test('the action: a denied section edit does nothing at all', async () => {
    const h = actionHarness(ledger(), { days: 10, denied: true });
    await h.run();
    assert.strictEqual(h.state.writes.length, 0);
    assert.strictEqual(h.state.rpcs.length, 0);
});

test('the action: nothing older than the window is reported, not written', async () => {
    const h = actionHarness(ledger(), { days: 200 });   // watermark 2026-01-22: nothing that old
    await h.run();
    assert.strictEqual(h.state.writes.length, 1, 'A still lands the merge; no B');
    assert.ok(!h.state.row.value.ledgerCompactedThrough);
    assert.match(h.els.compactResult.textContent, /Nothing older than 200 days/);
});

test('the action: a fold that would move a balance is refused', async () => {
    const h = actionHarness(ledger(), { days: 10 });
    // Corrupt the planner's verdict from inside the same context.
    const real = h.ctx._snacksCompactPlan;
    h.ctx._snacksCompactPlan = function() { const p = real.apply(this, arguments); p.invariantOk = false; p.drift = ['Ari Katz']; return p; };
    await h.run();
    assert.strictEqual(h.state.writes.length, 1, 'no write B');
    assert.match(h.els.compactResult.textContent, /Refused: archiving would change 1 balance/);
});

test('the action: when the register never stops, it gives up saying so', async () => {
    const h = actionHarness(ledger(), {
        days: 10,
        afterWrite(state) { state.row.updated_at = 'SOMEONE-ELSE-' + Math.random(); },  // every CAS on B fails
    });
    await h.run();
    assert.match(h.els.compactResult.textContent, /register was busy/);
    assert.ok(!h.state.row.value.ledgerCompactedThrough, 'never folded');
});

// ── source: the shape that keeps this safe ─────────────────────────────────
test('the shared ledger block is byte-identical in the manager and the POS', () => {
    const block = src => src.slice(src.indexOf('function _txFolded(t, w) {'), src.indexOf('function _mergeCompaction(merged, tx, cloud, local) {'))
        + sourceOf(src, '_mergeCompaction');
    assert.strictEqual(block(SNACKS), block(POS),
        'the POS register loads without the manager; a different fold rule there is a different balance there');
});

test('both merges route through _mergeCompaction, and the manager\'s through _mergeSnacksInto', () => {
    assert.match(SNACKS, /var merged = _mergeSnacksInto\(cloud, data\);/, 'cloudSaveSnacks');
    assert.match(sourceOf(SNACKS, '_mergeSnacksInto'), /merged\.transactions = _mergeCompaction\(merged, tx, cloud, data\);/);
    assert.match(POS, /merged\.transactions = _mergeCompaction\(merged, tx, cloud, data\);/, 'the POS merge');
    assert.ok(!/merged\.transactions = tx;/.test(SNACKS + POS), 'a merge that ignores the watermark resurrects folded rows');
});

test('the action is the only writer of the watermark and the carry', () => {
    const writers = [...(SNACKS + POS).matchAll(/ledgerCompactedThrough: w\b|ledgerCompactedThrough = w\b/g)];
    assert.strictEqual(writers.length, 3,
        'the plan sets it (1) and _mergeCompaction carries it through (2 copies) — nothing else may');
});

test('write A happens before the verify, and the verify before write B', () => {
    const src = sourceOf(SNACKS, 'compactSnacksLedger');
    const a = src.indexOf('_casWriteSnacks(client, campId, merged, stamp)');
    const v = src.indexOf("client.rpc('verify_canteen_archive'");
    const p = src.indexOf('_snacksCompactPlan(merged, days, todayStr())');
    const b = src.indexOf('_casWriteSnacks(client, campId, plan.result, stamp1)');
    assert.ok(a > 0 && v > a && p > v && b > p, 'order: land → verify → plan → save');
    assert.match(src, /if \(stamp1 === null\) continue;/);
    assert.match(src, /if \(stamp2 === null\) continue;/);
    assert.match(src, /Number\(vd\.blobTransactions\) !== merged\.transactions\.length/);
});

test('archived history is rendered, never written back into the ledger', () => {
    const fn = sourceOf(SNACKS, 'loadArchivedHistory');
    assert.match(fn, /client\.rpc\('get_canteen_history'/);
    assert.ok(!/snacks\.transactions\s*=|snacks\.transactions\.(push|unshift|concat)|saveSnacksData|cloudSaveSnacks/.test(fn),
        'writing fetched rows back would undo the compaction on the next save');
    assert.match(fn, /rows = \(d\.transactions \|\| \[\]\)\.filter\(function\(t\) \{ return _txFolded\(t, w\); \}\)/,
        'only the folded rows — the live ones are already on screen');
    assert.match(sourceOf(SNACKS, '_archivedHistoryHtml'), /if \(!w\) return '';/, 'no button until something is archived');
});

/**
 * The date part of a `<file>?v=YYYYMMDD-NN` reference, compared against a floor.
 *
 * A cache-bust only ever moves forward, so "no older than" is the honest
 * assertion: it proves the change shipped with a bump without freezing the value
 * for everyone who bumps it next.
 */
function bustAtLeast(html, file, minDate) {
    const m = html.match(new RegExp(file.replace('.', '\\.') + '\\?v=(\\d{8})'));
    return !!m && m[1] >= minDate;
}

test('the settings card exists and the caches are busted', () => {
    const html = read('campistry_snacks.html');
    assert.match(html, /id="ledgerCompactBox"/);
    // NOT the literal version this shipped with. Pinning `?v=20260922-219` made
    // this test a tripwire on every LATER bump — migration 240 changed
    // campistry_snacks.js, the bump that ships it is mandatory, and this line then
    // failed for doing the right thing. What the test actually wants is that the
    // reference carries a cache-bust NO OLDER than the change it guards.
    assert.ok(bustAtLeast(html, 'campistry_snacks.js', '20260922'),
        'campistry_snacks.html must load campistry_snacks.js with a ?v= no older than '
        + 'the compaction change, or a stale tab runs the ledger without it');
    assert.ok(bustAtLeast(read('campistry_snacks_pos.html'), 'campistry_snacks_pos.js', '20260920'),
        'campistry_snacks_pos.html must load campistry_snacks_pos.js with a ?v= no older '
        + 'than the compaction change — the register shares the compaction block');
    assert.match(SNACKS, /loadPosPinStatus\(\);\s*\n\s*_renderCompactionCard\(\);/, 'rendered with the rest of Settings');
    assert.match(sourceOf(SNACKS, '_renderCompactionCard'), /min="7"/);
});

test('history rows share one renderer between live and archived', () => {
    assert.match(sourceOf(SNACKS, '_renderHistoryBody'), /txs\.map\(_histRowHtml\)\.join\(''\) \+ _archivedHistoryHtml\(\)/);
    assert.match(sourceOf(SNACKS, 'loadArchivedHistory'), /rows\.map\(_histRowHtml\)/);
});
