// =============================================================================
// The canteen desk's writers go to the SERVER, not to the document.
//
// WHY THIS EXISTS. Migration 219 made camp_canteen_accounts and
// canteen_transactions the truth, and campistry_snacks.js honours that on the way
// out — _withoutRowBackedBranches deletes `accounts` and `transactions` from every
// document write. Three writers on the manager page did not come along:
//
//     addDep()    + a balance and a 'credit' row
//     cashOut()   - a balance and a 'debit'/'cash_out' row
//     setLimit()  a camper's dailyLimit
//
// All three wrote `snacks` and called saveSnacksData, and all three were stripped.
// The office took $40 in cash at the desk, the screen said "Added $40.00", and the
// database never heard about it — and because _reconcileBalances rebuilds every
// balance from the cloud ledger, the next hydration put the camper back where they
// were. Migration 240 gave the desk three RPCs and this is the check that keeps
// the client on them.
//
// Found by tests/money_path.e2e.js: it clicked "+ Add Deposit" in a real browser
// and then looked in a real database, where there was nothing.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SNACKS = fs.readFileSync(path.join(REPO, 'campistry_snacks.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(REPO, 'migrations',
    '240_the_canteen_desk_writes_to_the_cloud.sql'), 'utf8');

/** Comments blanked, so prose naming an RPC is not read as a call. */
function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
              .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
}

/** One `window.<name> = function() { … }` body, bounded by its own braces. */
function writerBody(name) {
    const src = code(SNACKS);
    const m = new RegExp('window\\.' + name + ' = (async )?function').exec(src);
    if (!m) return null;
    const at = m.index;
    let i = src.indexOf('{', at);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
    }
    return src.slice(at);
}

/** The three writers, the RPC each must use, and what it moves. */
const DESK_WRITERS = {
    addDep:   { rpc: 'canteen_office_credit',    moves: 'a deposit taken at the desk' },
    cashOut:  { rpc: 'canteen_office_cash_out',  moves: 'cash handed back over the counter' },
    setLimit: { rpc: 'canteen_office_set_limit', moves: "a camper's daily spending cap" },
};

test('each desk writer calls its server RPC', () => {
    for (const [name, spec] of Object.entries(DESK_WRITERS)) {
        const body = writerBody(name);
        assert.ok(body, 'campistry_snacks.js no longer defines window.' + name);
        assert.match(body, new RegExp("rpc\\(\\s*'" + spec.rpc + "'"),
            name + ' does not call ' + spec.rpc + '. It moves ' + spec.moves
            + ', and a document write is stripped before it reaches the cloud '
            + '(see _withoutRowBackedBranches and migration 240).');
    }
});

test('and none of them writes the document instead', () => {
    // saveSnacksData is the document write. It is correct for inventory, settings
    // and POS configuration — and for money it is the defect, because the branches
    // that carry money are deleted on the way out.
    for (const [name, spec] of Object.entries(DESK_WRITERS)) {
        const body = writerBody(name);
        assert.doesNotMatch(body, /saveSnacksData\s*\(/,
            name + ' calls saveSnacksData. That write has accounts and transactions '
            + 'stripped out of it, so ' + spec.moves + ' would reach nothing.');
    }
});

test('the balance shown after a desk write is the server’s, re-read from the rows', () => {
    // Not the client's arithmetic. Two tills and a parent portal can all move one
    // balance, so the number to show afterwards is the one the row holds.
    for (const name of Object.keys(DESK_WRITERS)) {
        const body = writerBody(name);
        assert.match(body, /_deskRefresh\s*\(/,
            name + ' does not re-read the rows after writing. Whatever it leaves on '
            + 'screen is this tab’s guess at a number three writers can change.');
    }
    const src = code(SNACKS);
    const fnBody = (name) => {
        const at = src.indexOf('function ' + name + '(');
        if (at < 0) return '';
        let depth = 0;
        for (let j = src.indexOf('{', at); j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
        }
        return '';
    };
    // The whole camp, when nothing narrower is known (a refused cash-out, an
    // offline import)…
    assert.match(fnBody('_deskRefresh'), /_overlayCanteenRows/,
        '_deskRefresh no longer reads the row-backed accounts and ledger');
    // …and one camper after a write that named one: the balance from the
    // server's reply, the ledger rows from the server. Re-reading the whole camp
    // after every deposit is 1.7 MB a click at 600 campers.
    const one = fnBody('_deskRefreshOne');
    assert.match(one, /result\.balance/, 'the per-camper refresh does not take the server\'s balance');
    assert.match(one, /rpc\(\s*'get_canteen_history'/, 'the per-camper refresh does not re-read the camper\'s rows');
    for (const name of Object.keys(DESK_WRITERS)) {
        assert.match(writerBody(name), /_deskRefresh\(\s*null\s*,\s*name\s*,\s*d\s*\)/,
            name + ' re-reads the whole camp after a successful write instead of just this camper');
    }
});

test('there is no local fallback, because a local-only deposit is the defect', () => {
    // The tempting shape — "offline? write it locally and reconcile later" — is
    // exactly what used to happen on every deposit, online or not, and it is why
    // the money vanished. Refusing and saying so is the honest answer.
    const body = writerBody('addDep');
    assert.match(body, /Not connected/,
        'addDep no longer says anything when there is no connection. If it now '
        + 'writes locally instead, that is the original defect restored.');
    assert.doesNotMatch(body, /snacks\.transactions\.unshift/,
        'addDep is building a local ledger row again — that row never leaves the tab.');
});

test('every refusal the server can return has something to say to the office', () => {
    // A code the page cannot phrase surfaces as "could not …" with no reason, which
    // is how staff learn to click twice. The list is taken from the migration, so a
    // new refusal cannot be added there without being handled here.
    const src = code(SNACKS);
    const at = src.indexOf('const DESK_ERRORS');
    assert.ok(at >= 0, 'campistry_snacks.js no longer maps the desk refusals');
    const map = src.slice(at, src.indexOf('};', at));

    const codes = new Set();
    const re = /'error',\s*'([a-z_]+)'/g;
    let m;
    while ((m = re.exec(MIGRATION)) !== null) codes.add(m[1]);
    assert.ok(codes.size >= 8, 'only found ' + codes.size + ' refusal codes in 240 — '
        + 'the regex is probably not matching its jsonb_build_object calls any more');

    const unhandled = [...codes].filter(c => !map.includes("'" + c + "'") && !map.includes(c + ':')).sort();
    assert.deepStrictEqual(unhandled, [],
        'migration 240 can refuse with these, and the page has no phrase for any of '
        + 'them:\n  ' + unhandled.join('\n  '));
});

test('the offline-register import goes to the server, not the document', () => {
    // It used to unshift each sale into snacks.transactions, subtract it from
    // snacks.accounts[...].balance and call saveSnacksData — all stripped on the
    // way out, so every offline sale was free. Migration 242 gave it a server
    // importer; this keeps the page on it.
    const src = code(SNACKS);
    const at = src.indexOf('function _importOfflineSales');
    assert.ok(at >= 0, 'campistry_snacks.js no longer defines _importOfflineSales');
    let depth = 0, end = src.length;
    for (let j = src.indexOf('{', at); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    const body = src.slice(at, end);
    assert.match(body, /rpc\(\s*'canteen_office_import_offline'/,
        'the offline import no longer calls canteen_office_import_offline');
    assert.doesNotMatch(body, /saveSnacksData\s*\(|snacks\.accounts\[|\.transactions\.unshift/,
        'the offline import is writing the document again — accounts and '
        + 'transactions are stripped from that write, so the sales reach nothing');
    assert.doesNotMatch(writerBody('importOfflinePOSTransactions'),
        /saveSnacksData\s*\(|snacks\.accounts\[/,
        'importOfflinePOSTransactions writes the document itself');
});

test('the offline register is loaded with LIVE balances, and with camper ids', () => {
    // Both exports read loadSnacksData() alone, whose accounts are the copy
    // frozen at 219. A register loaded from it starts every camper on a stale
    // balance. They now overlay the rows, and refuse when the rows cannot be read.
    const src = code(SNACKS);
    for (const name of ['downloadOfflinePOS', 'exportForOfflinePOS']) {
        assert.match(writerBody(name), /_withLiveCanteenRows\s*\(/,
            name + ' exports balances without reading the rows');
    }
    const live = src.slice(src.indexOf('function _withLiveCanteenRows'));
    assert.match(live.slice(0, 400), /_overlayCanteenRows/,
        '_withLiveCanteenRows no longer overlays the row-backed accounts');
    assert.match(live.slice(0, 400), /ok \? data : null/,
        '_withLiveCanteenRows falls back to the stale document when the rows fail');

    // Every account the register receives carries its camper id, so every sale
    // it takes can be posted to the person.
    // Each builder has two branches — campers with an account and campers
    // without one yet — and both must carry the id.
    for (const [label, start] of [['buildOfflineExportData', 'function buildOfflineExportData'],
                                  ['exportForOfflinePOS', 'window.exportForOfflinePOS']]) {
        const at = src.indexOf(start);
        const body = src.slice(at, src.indexOf('var exportData', at));
        const n = (body.match(/camperId:\s*(a|c)\.camperId != null/g) || []).length;
        assert.strictEqual(n, 2, label + ' carries camperId on ' + n + ' of its 2 account '
            + 'branches — a sale on the other kind of account reaches the importer by name only');
    }

    const reg = fs.readFileSync(path.join(REPO, 'campistry_snacks_pos_offline.html'), 'utf8');
    const tx = reg.slice(reg.indexOf('// Log transaction'));
    assert.match(tx.slice(0, 700), /camperId:/,
        'the offline register no longer stamps a camper id on each sale');
});
