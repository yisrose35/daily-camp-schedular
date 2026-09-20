// node --test tests/canteen_archive.test.js
//
// Migration 203: every canteen transaction that reaches the cloud survives it.
//
// The canteen ledger is money that lives ONLY inside one jsonb blob rewritten
// wholesale by every register, office tab and parent deposit — several of them
// clients doing read-merge-write from possibly-stale local storage.
// cloudSaveSnacks' own comment names the failure ("a naive full-blob upsert
// here can clobber a parent deposit"); the merge defends the happy path, and a
// clobber that slips through loses money history irrecoverably, because
// balances are recomputed as the SUM of that very array. 203 archives every
// transaction to rows via a trigger, so a clobbered blob costs a screen some
// history, never the ledger.
//
// TWO JUDGEMENTS THIS FILE EXISTS TO PROTECT:
//
// 1. NO CAP. The obvious "fix" for the blob's unbounded growth — truncate the
//    array in the trigger — silently rewrites every canteen balance in the
//    camp on the next office save, because the clients' _reconcileBalances
//    derives balance from the array. Compaction must be a client feature using
//    the client's own math. A test below fails the moment someone adds a trim.
//
// 2. THE SIGNATURE, NOT AN ID. The whole client fleet dedupes transactions by
//    [date,time,camper,type,amount,items].join('|'), keeping whichever copy a
//    merge saw first. A server-stamped id would be dropped by the next stale
//    save and re-stamped differently — one transaction, many archive rows. So
//    the archive keys on the fleet's own signature, byte-for-byte, and the
//    match to the client implementation is ASSERTED against the client source.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/203_canteen_archive.sql');

/** The SQL with comments stripped, for "must not contain" assertions. */
function codeOnly(sql) { return sql.replace(/--[^\n]*/g, ' '); }
const CODE = codeOnly(SQL);

/** One function body out of the file. */
function fn(name) {
    const a = SQL.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
    assert.ok(a > 0, name + ' is not in the migration');
    const end = SQL.indexOf('\n$$;', a);
    assert.ok(end > a, 'cannot find the end of ' + name);
    return SQL.slice(a, end);
}

// ── judgement 1: no cap, and loud about why ────────────────────────────────

test('the trigger never modifies the blob — archive is read-only on the source', () => {
    const body = codeOnly(fn('archive_canteen_transactions'));
    assert.ok(!/jsonb_set|NEW\.value\s*:=|UPDATE\s+camp_state_kv|DELETE\s+FROM\s+camp_state_kv/i.test(body),
        'any mutation of the blob here is the balance-corrupting cap in disguise');
    assert.match(body, /RETURN NEW;/);
    // AFTER trigger: a BEFORE trigger is the shape that CAN mutate NEW, so the
    // choice of AFTER is itself part of the guarantee.
    assert.match(SQL, /CREATE TRIGGER trg_archive_canteen_tx\s*\nAFTER INSERT OR UPDATE ON public\.camp_state_kv/);
});

test('the file says out loud why there is no cap', () => {
    assert.match(SQL, /DELIBERATELY DOES NOT DO: cap or trim/,
        'the landmine warning for the next person is part of the fix');
    assert.match(SQL, /_reconcileBalances/);
});

test('the archive never follows deletions', () => {
    const body = codeOnly(fn('archive_canteen_transactions'));
    assert.ok(!/DELETE\s+FROM\s+public\.canteen_transactions/i.test(body),
        'a transaction vanishing from the blob is the loss this table survives');
    assert.ok(!/DO UPDATE/i.test(body), 'append-only: first sighting wins, nothing is rewritten');
    assert.match(body, /ON CONFLICT \(camp_id, sig\) DO NOTHING/);
    // and no DELETE trigger variant either — 202's projections follow their
    // blob's lifecycle, this table deliberately does not.
    assert.ok(!/AFTER DELETE[\s\S]{0,120}archive_canteen_transactions/.test(SQL));
});

// ── judgement 2: the signature matches the fleet, byte for byte ───────────

/** The client's own _txSig, extracted and executed. */
function clientTxSig(file) {
    const src = read(file);
    const m = /function _txSig\(t\)\s*\{[^}]*\}/.exec(src);
    assert.ok(m, `_txSig not found in ${file}`);
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(m[0] + ';globalThis.__sig=_txSig;', ctx);
    return ctx.__sig;
}

/** The migration's canteen_tx_sig, re-run in JS off the same rules it states:
 *  ->> renders JSON scalars as their text form, COALESCE supplies ''. */
function sqlSigModel(t) {
    const f = k => {
        const v = t[k];
        if (v === null || v === undefined) return '';
        return String(v);
    };
    return [f('date'), f('time'), f('camper'), f('type'), f('amount'), f('items')].join('|');
}

test('the SQL signature agrees with BOTH client implementations on real shapes', () => {
    const sigs = [clientTxSig('campistry_snacks.js'), clientTxSig('campistry_snacks_pos.js')];
    const cases = [
        { date: '2026-07-01', time: '3:41 PM', camper: 'Ari Katz', type: 'debit', amount: 4.5, items: 'Slush + chips' },
        { date: '2026-07-01', time: '3:41 PM', camper: 'Ari Katz', type: 'credit', amount: 25, items: '' },
        // the fields a malformed or legacy row can miss
        { camper: 'No Date Kid', type: 'debit', amount: 2 },
        { date: '2026-08-02', time: '12:00 PM', camper: "O'Brien, Sean", type: 'tip', amount: 5, items: 'Tip — Dana (Lifeguard)' },
        // integer vs decimal rendering is where JS and SQL could diverge
        { date: '2026-07-04', time: '1:05 PM', camper: 'X', type: 'debit', amount: 3, items: 'Bar' },
        { date: '2026-07-04', time: '1:05 PM', camper: 'X', type: 'debit', amount: 3.25, items: 'Bar' },
    ];
    for (const t of cases) {
        const want = sigs[0](t);
        assert.strictEqual(sigs[1](t), want, 'the two client copies disagree — that is a client bug to fix first');
        assert.strictEqual(sqlSigModel(t), want, `SQL model diverges for ${JSON.stringify(t)}`);
    }
});

test('the SQL signature reads exactly the six fields, in the client order', () => {
    const body = fn('canteen_tx_sig');
    const order = [...body.matchAll(/p_tx ->> '(\w+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(order, ['date', 'time', 'camper', 'type', 'amount', 'items'],
        "the client joins [date,time,camper,type,amount,items] — order IS the identity");
    assert.match(body, /concat_ws\('\|',/);
    const coalesces = [...body.matchAll(/COALESCE\(p_tx ->> '\w+',\s*''\)/g)];
    assert.strictEqual(coalesces.length, 6,
        "JS join renders null/undefined as '', so every field needs the COALESCE");
});

test('no ids are invented anywhere', () => {
    assert.ok(!/gen_random_uuid|uuid_generate/i.test(CODE),
        'a server-stamped id desyncs from the fleet: the merge keeps the copy it '
        + 'saw first, drops the id, and the re-stamp makes one transaction many rows');
});

// ── the trigger's wiring ───────────────────────────────────────────────────

test('the trigger fires on campistrySnacks only, and skips non-ledger saves', () => {
    assert.match(SQL, /WHEN \(NEW\.key = 'campistrySnacks'\)/);
    const body = fn('archive_canteen_transactions');
    assert.match(body, /IF TG_OP <> 'INSERT'\s*\n\s*AND \(NEW\.value -> 'transactions'\) IS NOT DISTINCT FROM \(OLD\.value -> 'transactions'\) THEN\s*\n\s*RETURN NEW;/,
        'an inventory or config save must cost one comparison, not an array scan');
    assert.match(SQL, /DROP TRIGGER IF EXISTS trg_archive_canteen_tx ON public\.camp_state_kv;/);
});

test('the trigger is SECURITY DEFINER and callable by nothing', () => {
    assert.match(fn('archive_canteen_transactions'), /SECURITY DEFINER/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.archive_canteen_transactions\(\) FROM public, anon, authenticated;/);
});

test('a malformed transaction costs itself, never the purchase', () => {
    const body = fn('archive_canteen_transactions');
    assert.match(body, /WHERE jsonb_typeof\(t\) = 'object'/,
        'a stray string or null in the array must be skipped, not thrown on');
    assert.match(body, /COALESCE\(public\._num_or_null\(t ->> 'amount'\), 0\)/,
        'a bare ::numeric cast THROWS, and a trigger throw aborts the register sale');
    assert.match(fn('_num_or_null'), /EXCEPTION WHEN OTHERS THEN\s*\n\s*RETURN NULL;/);
});

test('an array holding sig-duplicates archives cleanly', () => {
    // DISTINCT ON collapses them before the insert even needs ON CONFLICT —
    // the same collapse every client merge performs.
    assert.match(fn('archive_canteen_transactions'), /SELECT DISTINCT ON \(public\.canteen_tx_sig\(t\)\)/);
});

// ── the table ──────────────────────────────────────────────────────────────

test('no FK to camps — a trigger-written table must never abort the blob save', () => {
    const tableDef = SQL.slice(SQL.indexOf('CREATE TABLE IF NOT EXISTS public.canteen_transactions'),
                               SQL.indexOf('CREATE INDEX IF NOT EXISTS idx_canteen_tx_camp_camper'));
    assert.ok(!/REFERENCES/.test(codeOnly(tableDef)));
    assert.match(tableDef, /PRIMARY KEY \(camp_id, sig\)/);
});

test('deny-all RLS, and the camper-scoped index the reads need', () => {
    assert.match(SQL, /ALTER TABLE public\.canteen_transactions ENABLE ROW LEVEL SECURITY;/);
    assert.ok(!/CREATE POLICY/.test(SQL), 'a policy would open a camp\'s money ledger');
    assert.match(SQL, /ON public\.canteen_transactions \(camp_id, camper, tx_date DESC\)/);
});

// ── the backfill ───────────────────────────────────────────────────────────

test('the backfill carries 200\'s lessons: scoped, convergent, duplicate-safe', () => {
    const backfill = SQL.slice(SQL.indexOf('-- ─── 3. backfill'), SQL.indexOf('-- ─── 4.'));
    assert.match(backfill, /AND EXISTS \(SELECT 1 FROM camps c WHERE c\.id = kv\.camp_id\)/,
        'deleted camps leave orphaned blobs behind — the first paste of 200 proved it');
    assert.match(backfill, /ON CONFLICT \(camp_id, sig\) DO NOTHING;/);
    assert.match(backfill, /SELECT DISTINCT ON \(kv\.camp_id, public\.canteen_tx_sig\(t\)\)/);
    assert.match(backfill, /jsonb_typeof\(t\) = 'object'/);
});

// ── the reads ──────────────────────────────────────────────────────────────

test('get_canteen_history is gated exactly like the blob read it will replace', () => {
    const body = fn('get_canteen_history');
    assert.match(body, /public\.camp_staff_member\(p_camp_id\)/);
    assert.match(body, /public\.camp_parent_campers\(p_camp_id\)/);
    assert.match(body, /IF p_camper IS NOT NULL AND NOT v_mine \? p_camper THEN\s*\n\s*RETURN jsonb_build_object\('success', false, 'error', 'not_authorized'\);/,
        "asking for someone else's child is a refusal, not a filter");
    assert.match(body, /AND \(v_staff OR v_mine \? ct\.camper\)/,
        'the row filter must hold even with no p_camper — a parent pages THEIR children');
});

test('the history cap is inside the subquery — the migration-201 defect stays dead', () => {
    const body = codeOnly(fn('get_canteen_history'));
    assert.match(body, /LIMIT v_limit\s*\n\s*\) x;/, 'rows capped before the aggregate sees them');
    assert.match(body, /LEAST\(GREATEST\(COALESCE\(p_limit, 200\), 1\), 1000\)/,
        'caller-supplied limits need a floor and a ceiling');
});

test('the verifier asks blob ⊆ archive, never the reverse', () => {
    const body = fn('verify_canteen_archive');
    assert.match(body, /'missingFromArchive', v_missing/);
    assert.match(body, /archivedTotal may exceed blobTransactions/,
        'the archive outliving the blob is its purpose, and the report says so');
    assert.match(body, /'inSync', v_missing = 0/);
});

test('the verifier works from the SQL Editor — the 202 gate, not the one before it', () => {
    const body = fn('verify_canteen_archive');
    assert.match(body, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/);
    assert.match(body, /IF v_claims IS NOT NULL\s*\n\s*AND COALESCE\(v_claims::jsonb ->> 'role', ''\) <> 'service_role'\s*\n\s*AND NOT public\.camp_reader\(p_camp_id\) THEN/);
    assert.ok(!/current_user|session_user/.test(codeOnly(body)),
        'inside SECURITY DEFINER current_user is the owner for every caller');
});

// ── the file's own rules ───────────────────────────────────────────────────

test('203 is standalone and touches no writer and no blob', () => {
    assert.match(SQL, /Standalone — not in APPLY_BUNDLE\.sql/);
    assert.ok(!read('scripts/build-migration-bundle.py').includes('203_canteen_archive'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('203_canteen_archive'));
    assert.ok(!/UPDATE\s+camp_state_kv|INSERT INTO\s+camp_state_kv|DELETE FROM\s+camp_state_kv/i.test(CODE),
        'the archive follows the blob — never the reverse');
    assert.ok(!SQL.includes('FUNCTION public.submit_canteen_purchase'),
        'the purchase RPC is untouched: this file adds a shadow, not a new path');
});

test('anon can execute nothing here', () => {
    const grants = [...SQL.matchAll(/GRANT EXECUTE ON FUNCTION [^;]+;/g)].map(m => m[0]);
    assert.ok(grants.length >= 4);
    for (const g of grants) assert.ok(!/\banon\b/.test(g), g);
});
