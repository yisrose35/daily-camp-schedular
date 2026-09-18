// node --test tests/parent_balance_dedupe.test.js
//
// get_my_balance is the most expensive RPC the parent portal calls: it runs the
// derived calculation, re-reads the camp's state row, and checks every payment
// the camp has recorded against the family's ledger. The portal cached its
// ANSWER in _balByCamp, which deduplicates every call after one lands — and
// none of the calls before it.
//
// Four places fetched it independently (the Payments pre-warm at boot, Cards,
// the canteen charge-card gate, and canteen auto-reload), and the gate runs once
// per canteen child. A family with three campers opening Canteen while the boot
// pre-warm is still in flight fired four reads of the same value. Multiplied by
// every family with the portal open, the heaviest query in the app was the one
// it repeated most needlessly.
//
// AND A CORRECTNESS BUG CAME WITH IT. Every one of those sites wrote
// `_balByCamp[cid] = d` unconditionally on resolve, so a read that started
// before a payment could land after it: the parent pays, the balance goes
// right, then flicks back to what they owed. _balGen is what stops that, and
// most of the tests below are about it rather than about saving a round trip.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PARENT = fs.readFileSync(path.join(ROOT, 'campistry_link_parent.html'), 'utf8');

// "This pattern must appear exactly once" assertions have to run against CODE.
// The comment above _getBalance quotes the very line it replaced
// (`_balByCamp[cid] = d`) to explain the bug, and a raw count of the page text
// reads that prose as a second offender. Strip comments first, keeping string
// contents intact.
function jsCode(src) {
    let out = '', i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
        if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e < 0 ? src.length : e + 2; continue; }
        if (c === "'" || c === '"' || c === '`') {
            const q = c; out += c; i++;
            while (i < src.length) { if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; } out += src[i]; if (src[i] === q) { i++; break; } i++; }
            continue;
        }
        out += c; i++;
    }
    return out;
}
const PARENT_CODE = jsCode(PARENT);

test('the comment stripper keeps code and drops prose', () => {
    assert.strictEqual(jsCode("var a=1; // _balByCamp[x] = y\nvar b=2;"), 'var a=1; \nvar b=2;');
    assert.strictEqual(jsCode("var s='// not a comment';"), "var s='// not a comment';");
    assert.strictEqual(jsCode('var a=1;/* _balByCamp[x] = y */var b=2;'), 'var a=1;var b=2;');
    // And it must actually have removed the explanatory comment in the page.
    assert.ok(PARENT.includes('`_balByCamp[cid] = d` unconditionally'),
        'expected the comment that motivated this stripper to still be there');
    assert.ok(!PARENT_CODE.includes('unconditionally'));
});

// Brace-matched extraction. A lazy regex stops at the first line that merely
// looks like a closing brace and hands vm a truncated function.
function sourceOf(name) {
    const at = PARENT.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} not found in campistry_link_parent.html`);
    let i = PARENT.indexOf('{', at), depth = 0;
    for (; i < PARENT.length; i++) {
        const c = PARENT[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return PARENT.slice(at, i + 1); }
        else if (c === "'" || c === '"') { const q = c; i++; while (i < PARENT.length && PARENT[i] !== q) { if (PARENT[i] === '\\') i++; i++; } }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

/**
 * The balance accessor, running for real against a fake supabase client.
 * `answers` is a queue of what each successive RPC call resolves to.
 */
function harness(answers, opts) {
    const calls = [];
    const pending = [];
    const db = {
        rpc(fn, args) {
            calls.push({ fn, args });
            if (opts && opts.manual) {
                return new Promise((resolve, reject) => pending.push({ resolve, reject }));
            }
            const a = answers.shift();
            if (a instanceof Error) return Promise.reject(a);
            return Promise.resolve({ data: a });
        },
    };
    const ctx = {
        Promise, console,
        window: { _parentDB: (opts && opts.noDb) ? null : db, _pRpc: null },
        _balByCamp: {},
    };
    vm.createContext(ctx);
    vm.runInContext(
        'var _balInFlight={};var _balGen={};\n'
        + sourceOf('_invalidateBalance') + '\n'
        + sourceOf('_getBalance') + '\n'
        + ';globalThis.__api={get:_getBalance,inval:_invalidateBalance,'
        + 'inflight:function(){return _balInFlight;},gen:function(){return _balGen;}};',
        ctx);
    return { api: ctx.__api, calls, pending, ctx };
}

const OK = { success: true, balance: 100, familyKey: 'fam_1' };
const OK2 = { success: true, balance: 0, familyKey: 'fam_1' };

test('the extracted source parses and both helpers are found', () => {
    assert.doesNotThrow(() => new vm.Script(sourceOf('_getBalance')));
    assert.doesNotThrow(() => new vm.Script(sourceOf('_invalidateBalance')));
});

test('concurrent callers share one round trip', async () => {
    const h = harness([OK], { manual: true });
    const a = h.api.get('c1'), b = h.api.get('c1'), c = h.api.get('c1');
    assert.strictEqual(h.calls.length, 1, 'three callers, one RPC');
    h.pending[0].resolve({ data: OK });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.deepStrictEqual([ra.balance, rb.balance, rc.balance], [100, 100, 100],
        'every caller gets the answer');
    assert.strictEqual(h.calls.length, 1);
});

test('a landed answer is served from cache with no further RPC', async () => {
    const h = harness([OK]);
    await h.api.get('c1');
    assert.strictEqual(h.calls.length, 1);
    const again = await h.api.get('c1');
    assert.strictEqual(again.balance, 100);
    assert.strictEqual(h.calls.length, 1, 'cached answers must not re-query');
});

test('different camps do not share a cache entry', async () => {
    const h = harness([OK, OK2]);
    const a = await h.api.get('c1');
    const b = await h.api.get('c2');
    assert.strictEqual(a.balance, 100);
    assert.strictEqual(b.balance, 0);
    assert.strictEqual(h.calls.length, 2);
    assert.deepStrictEqual(h.calls.map(c => c.args.p_camp_id), ['c1', 'c2']);
});

test('force re-reads even when cached', async () => {
    const h = harness([OK, OK2]);
    assert.strictEqual((await h.api.get('c1')).balance, 100);
    assert.strictEqual((await h.api.get('c1', { force: true })).balance, 0,
        'force must go back to the server');
    assert.strictEqual(h.calls.length, 2);
});

test('invalidation makes the next call re-read', async () => {
    const h = harness([OK, OK2]);
    await h.api.get('c1');
    h.api.inval('c1');
    assert.strictEqual((await h.api.get('c1')).balance, 0);
    assert.strictEqual(h.calls.length, 2);
});

// ── the part that is a correctness fix, not a saving ──────────────────────
test('an answer that predates an invalidation is never published', async () => {
    const h = harness([], { manual: true });
    const inflight = h.api.get('c1');          // read starts: balance is 100
    h.api.inval('c1');                         // the parent pays
    h.pending[0].resolve({ data: OK });        // ...and the old read lands
    const got = await inflight;
    assert.strictEqual(got, null,
        'publishing it would put the pre-payment balance back on screen');
    assert.strictEqual(h.ctx._balByCamp.c1, undefined,
        'and must not be written into the cache either');
});

test('after a mid-flight invalidation the next read is fresh, not the stale one', async () => {
    const h = harness([], { manual: true });
    const stale = h.api.get('c1');
    h.api.inval('c1');
    h.pending[0].resolve({ data: OK });        // stale: balance 100
    await stale;
    const fresh = h.api.get('c1');             // must be a NEW request
    assert.strictEqual(h.calls.length, 2, 'the invalidated read may not be reused');
    h.pending[1].resolve({ data: OK2 });       // fresh: balance 0
    assert.strictEqual((await fresh).balance, 0);
    assert.strictEqual(h.ctx._balByCamp.c1.balance, 0);
});

test('a mid-flight invalidation keeps an already-cached value rather than nulling it', async () => {
    // A stale read resolving must not be able to blank a good cached answer.
    const h = harness([], { manual: true });
    const first = h.api.get('c1');
    h.pending[0].resolve({ data: OK });
    await first;                                // cache holds balance 100
    const second = h.api.get('c1', { force: true });
    h.ctx._balByCamp.c1 = OK2;                  // something else publishes 0
    h.api.inval('c1');
    h.ctx._balByCamp.c1 = OK2;                  // and re-seeds it
    h.pending[1].resolve({ data: OK });         // the forced read lands, stale
    assert.strictEqual((await second).balance, 0,
        'the caller sees what is cached now, not the answer it asked for');
});

test('force does not leave a previous in-flight read able to publish', async () => {
    const h = harness([], { manual: true });
    const old = h.api.get('c1');
    const forced = h.api.get('c1', { force: true });
    assert.strictEqual(h.calls.length, 2);
    h.pending[1].resolve({ data: OK2 });        // the forced read lands first
    assert.strictEqual((await forced).balance, 0);
    h.pending[0].resolve({ data: OK });         // the older one lands after
    await old;
    assert.strictEqual(h.ctx._balByCamp.c1.balance, 0,
        'the older read must not overwrite the newer answer');
});

// ── failure and edge behaviour ───────────────────────────────────────────
test('a rejected RPC resolves null and does not poison the cache', async () => {
    const h = harness([new Error('network down'), OK]);
    assert.strictEqual(await h.api.get('c1'), null);
    assert.strictEqual(h.ctx._balByCamp.c1, undefined,
        'a failure must stay retryable, not cache as "no balance"');
    assert.strictEqual((await h.api.get('c1')).balance, 100);
});

test('an unsuccessful response is treated as no answer', async () => {
    const h = harness([{ success: false, error: 'no_active_invite' }, OK]);
    assert.strictEqual(await h.api.get('c1'), null);
    assert.strictEqual((await h.api.get('c1')).balance, 100, 'and is retried');
});

test('a malformed response does not throw', async () => {
    for (const bad of [undefined, null, {}, { data: null }, { data: undefined }]) {
        const h = harness([]);
        h.ctx.window._parentDB = { rpc: () => Promise.resolve(bad) };
        assert.strictEqual(await h.api.get('c1'), null, `on ${JSON.stringify(bad)}`);
    }
});

test('no client yet resolves null without querying', async () => {
    const h = harness([], { noDb: true });
    assert.strictEqual(await h.api.get('c1'), null);
    assert.strictEqual(h.calls.length, 0);
});

test('a falsy camp id resolves null without querying', async () => {
    const h = harness([OK]);
    for (const cid of [null, undefined, '', 0]) {
        assert.strictEqual(await h.api.get(cid), null, `on ${String(cid)}`);
    }
    assert.strictEqual(h.calls.length, 0);
});

test('invalidating nothing leaves no trace behind', () => {
    // The portal lives in one long-running tab, so a stray invalidation that
    // writes _balGen['null'] / _balGen['undefined'] accumulates junk keys for
    // the session. Nothing breaks; nothing should be created either.
    const h = harness([]);
    for (const cid of [null, undefined, '', 0, false]) {
        assert.doesNotThrow(() => h.api.inval(cid), `on ${String(cid)}`);
    }
    assert.deepStrictEqual(Object.keys(h.api.gen()), [],
        'a no-op invalidation must not create a generation entry');
    assert.deepStrictEqual(Object.keys(h.ctx._balByCamp), []);
    assert.deepStrictEqual(Object.keys(h.api.inflight()), []);
});

test('the in-flight map is emptied once a read settles, on success and failure', async () => {
    const h = harness([OK, new Error('boom')]);
    await h.api.get('c1');
    assert.deepStrictEqual(Object.keys(h.api.inflight()), [],
        'a retained promise would cache the answer for ever, past invalidation');
    await h.api.get('c2');
    assert.deepStrictEqual(Object.keys(h.api.inflight()), []);
});

test('the generation counter advances once per invalidation', async () => {
    const h = harness([OK]);
    await h.api.get('c1');
    const g0 = h.api.gen().c1;
    h.api.inval('c1'); h.api.inval('c1');
    assert.strictEqual(h.api.gen().c1, g0 + 2);
});

test('_pRpc is preferred when the portal provides it', async () => {
    const h = harness([]);
    const seen = [];
    h.ctx.window._pRpc = (fn, args, cid) => { seen.push([fn, cid]); return Promise.resolve({ data: OK }); };
    assert.strictEqual((await h.api.get('c9')).balance, 100);
    assert.deepStrictEqual(seen, [['get_my_balance', 'c9']]);
    assert.strictEqual(h.calls.length, 0, 'must not also hit db.rpc');
});

// ── the wiring: every fetcher and every invalidation goes through them ────
test('the portal has exactly one get_my_balance call site', () => {
    const calls = [...PARENT.matchAll(/(?:_pRpc|\.rpc)\(\s*'get_my_balance'/g)];
    assert.strictEqual(calls.length, 2,
        'expected the two spellings inside _getBalance only (the _pRpc branch and '
        + 'the db.rpc fallback) — a fifth fetcher has been added somewhere else');
    const fn = sourceOf('_getBalance');
    assert.strictEqual([...fn.matchAll(/(?:_pRpc|\.rpc)\(\s*'get_my_balance'/g)].length, 2,
        'both call sites must be inside _getBalance');
});

test('no site writes _balByCamp directly any more except through the accessor', () => {
    const writes = [...PARENT_CODE.matchAll(/_balByCamp\[[^\]]+\]\s*=/g)].map(m => m[0]);
    assert.strictEqual(writes.length, 1,
        'an unconditional write is exactly the stale-answer bug: ' + writes.join(', '));
    assert.ok(jsCode(sourceOf('_getBalance')).includes('_balByCamp[cid]=d'),
        'the one write belongs to _getBalance');
});

test('nothing deletes _balByCamp behind the generation counter', () => {
    const dels = [...PARENT_CODE.matchAll(/delete\s+_balByCamp\[[^\]]+\]/g)].map(m => m[0]);
    assert.strictEqual(dels.length, 1,
        'a bare delete leaves an in-flight read free to republish the old value: '
        + dels.join(', '));
    assert.ok(jsCode(sourceOf('_invalidateBalance')).includes('delete _balByCamp[cid]'),
        'the one delete belongs to _invalidateBalance');
});

test('all three balance-changing actions invalidate', () => {
    // A payment confirmed, a default card changed, a card removed. Each changes
    // what get_my_balance would say, so each must drop the cached answer.
    //
    // Counted OUTSIDE the two helpers, or the definition's own parameter list
    // and _getBalance's force branch are miscounted as call sites.
    const outside = PARENT_CODE
        .replace(jsCode(sourceOf('_invalidateBalance')), '')
        .replace(jsCode(sourceOf('_getBalance')), '');
    const invals = [...outside.matchAll(/_invalidateBalance\(([^)]*)\)/g)].map(m => m[1]);
    assert.deepStrictEqual(invals.sort(), ['cid', 'cid', 'meta.campId'],
        'expected exactly: the Banquest/payment return, set-default-card, remove-card');
    assert.ok(PARENT_CODE.includes('function _invalidateBalance(cid){'));
    // force must route through it rather than reimplementing the reset.
    assert.ok(jsCode(sourceOf('_getBalance')).includes('_invalidateBalance(cid)'));
});

test('_getBalance is defined before the code that uses it runs', () => {
    // Both are plain hoisted function declarations in the same top-level script
    // block as their callers, which is what makes the call sites safe.
    const at = PARENT.indexOf('function _getBalance(cid, opts){');
    assert.notStrictEqual(at, -1);
    const block = PARENT.lastIndexOf('<script>', at);
    const close = PARENT.indexOf('</script>', at);
    for (const site of ['_getBalance(cid).then', 'd=await _getBalance(cid)',
                        '_getBalance(c.campId)']) {
        const use = PARENT.indexOf(site);
        assert.notStrictEqual(use, -1, `call site missing: ${site}`);
        assert.ok(use > block && use < close,
            `${site} is outside the script block that declares _getBalance`);
    }
});
