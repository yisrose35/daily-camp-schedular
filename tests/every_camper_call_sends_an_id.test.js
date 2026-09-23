// =============================================================================
// Every call that names a camper carries the camper's ID.
//
// Since migration 248 every database function that takes a camper's name also
// takes p_camper_id, and given one, the id decides. campistry_camper_id_rpc.js
// makes the pages send it: it wraps the client's rpc() once, so every call site —
// the ~50 that exist and the ones written later — carries the id without each
// having to remember. This file holds the module to its rules and holds every
// page to loading it.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const MODULE = fs.readFileSync(path.join(REPO, 'campistry_camper_id_rpc.js'), 'utf8');

function load() {
    const window = {};
    vm.runInNewContext(MODULE, { window, Promise, Object, String, Number, RegExp });
    return window.CampistryCamperIdRpc;
}

/** A client whose rpc records what it was sent and answers `reply(fn, args)`. */
function fakeClient(reply) {
    const sent = [];
    return {
        sent,
        rpc(fn, args) {
            sent.push({ fn, args: Object.assign({}, args) });
            return Promise.resolve(reply ? reply(fn, args) : { data: { success: true }, error: null });
        },
    };
}

const ROSTER = { 'Ayala Weiss': 880, 'Dov Lerner': 881 };
const fromRoster = (campId, name) => (name in ROSTER ? ROSTER[name] : null);

test('a call that names a camper gets the camper\'s id', async () => {
    const M = load(), c = fakeClient();
    M.wrap(c, fromRoster);
    await c.rpc('set_canteen_limits', { p_camp_id: 'c1', p_camper_name: 'Ayala Weiss', p_daily_limit: 5 });
    await c.rpc('merge_canteen_autoreload_card', { p_camp_id: 'c1', p_camper: 'Dov Lerner', p_fields: {} });
    assert.strictEqual(c.sent[0].args.p_camper_id, 880);
    assert.strictEqual(c.sent[1].args.p_camper_id, 881, 'p_camper (the other spelling) is covered too');
});

test('an id the caller already sent is left alone', async () => {
    const M = load(), c = fakeClient();
    M.wrap(c, () => 999);
    await c.rpc('canteen_office_credit', { p_camp_id: 'c1', p_camper_name: 'Ayala Weiss', p_camper_id: 42 });
    assert.strictEqual(c.sent[0].args.p_camper_id, 42);
});

test('a call that names no camper is untouched', async () => {
    const M = load(), c = fakeClient();
    let asked = 0;
    M.wrap(c, () => { asked++; return 1; });
    await c.rpc('get_camp_families', { p_camp_id: 'c1' });
    assert.ok(!('p_camper_id' in c.sent[0].args));
    assert.strictEqual(asked, 0, 'no lookup for a call that names nobody');
});

test('a non-numeric "id" is replaced by the real one — or dropped', async () => {
    // The portal sent its own list index ("child_0") in this slot.
    const M = load(), c = fakeClient();
    M.wrap(c, fromRoster);
    await c.rpc('submit_link_form_response', { p_camper_name: 'Ayala Weiss', p_camper_id: 'child_0' });
    await c.rpc('submit_link_form_response', { p_camper_name: 'Nobody', p_camper_id: 'child_3' });
    assert.strictEqual(c.sent[0].args.p_camper_id, 880);
    assert.ok(!('p_camper_id' in c.sent[1].args), 'an index that is not an id must not reach the server');
});

test('no id found: the call goes by name, exactly as before', async () => {
    const M = load(), c = fakeClient();
    M.wrap(c, fromRoster);
    await c.rpc('get_canteen_history', { p_camp_id: 'c1', p_camper: 'Old Spelling' });
    assert.deepStrictEqual(c.sent[0].args, { p_camp_id: 'c1', p_camper: 'Old Spelling' });
});

test('a database without 248 is not broken: "no such function" retries without the id', async () => {
    const M = load();
    const c = fakeClient((fn, args) => ('p_camper_id' in args)
        ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.x(...) in the schema cache' } }
        : { data: { success: true }, error: null });
    M.wrap(c, fromRoster);
    const res = await c.rpc('set_canteen_limits', { p_camp_id: 'c1', p_camper_name: 'Ayala Weiss' });
    assert.strictEqual(c.sent.length, 2, 'retried once');
    assert.ok(!('p_camper_id' in c.sent[1].args));
    assert.strictEqual(res.data.success, true);
});

test('an asynchronous resolver (the parent portal\'s) works the same way', async () => {
    const M = load(), c = fakeClient();
    M.wrap(c, (campId, name) => Promise.resolve(campId === 'c1' && name === 'Ayala Weiss' ? 880 : null));
    await c.rpc('set_camper_face_consent', { p_camp_id: 'c1', p_camper_name: 'Ayala Weiss', p_consent: true });
    assert.strictEqual(c.sent[0].args.p_camper_id, 880);
});

test('wrapping twice does not wrap twice', async () => {
    const M = load(), c = fakeClient();
    M.wrap(c, fromRoster); M.wrap(c, () => 1);
    await c.rpc('set_canteen_limits', { p_camper_name: 'Ayala Weiss' });
    assert.strictEqual(c.sent.length, 1);
    assert.strictEqual(c.sent[0].args.p_camper_id, 880);
});

// ── edge functions: fetch('…/functions/v1/…') ───────────────────────────────

function loadWithFetch() {
    const sent = [];
    const window = {
        fetch: (url, init) => { sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
                                return Promise.resolve({ ok: true }); },
    };
    vm.runInNewContext(MODULE, { window, Promise, Object, String, Number, RegExp, JSON, Array });
    return { M: window.CampistryCamperIdRpc, window, sent };
}

test('an edge-function request that names a camper gets camperId', async () => {
    const { M, window, sent } = loadWithFetch();
    M.wrapFetch(fromRoster);
    await window.fetch('https://x.supabase.co/functions/v1/payments-charge-nonce',
        { method: 'POST', body: JSON.stringify({ campId: 'c1', kind: 'canteen_deposit', camperName: 'Ayala Weiss' }) });
    assert.strictEqual(sent[0].body.camperId, 880);
});

test('a list of campers gets a list of ids, position for position', async () => {
    const { M, window, sent } = loadWithFetch();
    M.wrapFetch(fromRoster);
    await window.fetch('https://x.supabase.co/functions/v1/link-photo-checkout',
        { method: 'POST', body: JSON.stringify({ campId: 'c1', camperNames: ['Dov Lerner', 'Nobody', 'Ayala Weiss'] }) });
    assert.deepStrictEqual(sent[0].body.camperIds, [881, null, 880]);
});

test('a cart: every line that names a camper gets that camper\'s id', async () => {
    const { M, window, sent } = loadWithFetch();
    const seen = [];
    M.wrapFetch((campId, name) => { seen.push(campId); return fromRoster(campId, name); });
    await window.fetch('https://x.supabase.co/functions/v1/stripe-connect-tip-cart',
        { method: 'POST', body: JSON.stringify({ items: [
            { campId: 'c1', accountId: 'a', tipAmount: 5, camperName: 'Ayala Weiss' },
            { campId: 'c2', accountId: 'b', tipAmount: 5, camperName: 'Nobody' },
            { campId: 'c1', accountId: 'c', tipAmount: 5 }] }) });
    assert.strictEqual(sent[0].body.items[0].camperId, 880);
    assert.ok(!('camperId' in sent[0].body.items[1]));
    assert.ok(!('camperId' in sent[0].body.items[2]));
    assert.deepStrictEqual(seen, ['c1', 'c2'], 'each line is looked up in its own camp');
});

test('other requests pass through untouched', async () => {
    const { M, window, sent } = loadWithFetch();
    M.wrapFetch(fromRoster);
    await window.fetch('https://x.supabase.co/rest/v1/camps', { method: 'POST', body: JSON.stringify({ camperName: 'Ayala Weiss' }) });
    await window.fetch('https://x.supabase.co/functions/v1/send-push', { method: 'POST', body: JSON.stringify({ title: 'hi' }) });
    await window.fetch('https://x.supabase.co/functions/v1/x', { method: 'POST', body: JSON.stringify({ camperName: 'Ayala Weiss', camperId: 5 }) });
    assert.ok(!('camperId' in sent[0].body), 'only edge functions');
    assert.ok(!('camperId' in sent[1].body), 'only requests that name a camper');
    assert.strictEqual(sent[2].body.camperId, 5, 'an id already sent is kept');
});

// ── the wiring ──────────────────────────────────────────────────────────────

test('the staff client is wrapped, with the roster as the resolver', () => {
    const src = fs.readFileSync(path.join(REPO, 'supabase_client.js'), 'utf8');
    assert.match(src, /CampistryCamperIdRpc\.wrap\(client, _camperIdFromRoster\)/);
    assert.match(src, /window\.supabase = _withCamperIds\(_client\)/, 'the created client is not wrapped');
    assert.match(src, /camperRoster/, 'the resolver does not read the roster');
});

test('every page that loads the staff client loads the module too', () => {
    const pages = fs.readdirSync(REPO).filter(f => f.endsWith('.html'));
    const missing = pages.filter(f => {
        const s = fs.readFileSync(path.join(REPO, f), 'utf8');
        return /supabase_client\.js/.test(s) && !/campistry_camper_id_rpc\.js/.test(s);
    });
    assert.deepStrictEqual(missing, [], 'these pages send camper calls without the id:\n  ' + missing.join('\n  '));
});

test('the parent portal wraps its own client, from the ids on its invites', () => {
    const s = fs.readFileSync(path.join(REPO, 'campistry_link_parent.html'), 'utf8');
    assert.ok(s.indexOf('campistry_camper_id_rpc.js') >= 0 && s.indexOf('campistry_camper_id_rpc.js') < s.indexOf('window._parentDB = db'),
        'the portal does not load the module before it creates its client');
    assert.match(s, /CampistryCamperIdRpc\.wrap\(db,/, 'the portal client is not wrapped');
    assert.match(s, /raw\('get_my_camper_ids'/, 'the portal does not read its children\'s ids');
});

test('the staff pages and the portal both cover edge-function requests', () => {
    const client = fs.readFileSync(path.join(REPO, 'supabase_client.js'), 'utf8');
    assert.match(client, /wrapFetch\(_camperIdFromRoster\)/, 'staff edge requests go without the id');
    const portal = fs.readFileSync(path.join(REPO, 'campistry_link_parent.html'), 'utf8');
    assert.match(portal, /CampistryCamperIdRpc\.wrapFetch\(resolve\)/, 'portal edge requests go without the id');
});

// ── the edge functions themselves ───────────────────────────────────────────

// Superseded: they import ../_shared, so they cannot be deployed from the
// Dashboard, and nothing calls them (payments-charge-nonce / -hosted-link / the
// card flows replaced them).
const SUPERSEDED = new Set(['payments-canteen-checkout', 'payments-checkout', 'payments-charge']);

function edgeSources() {
    const root = path.join(REPO, 'supabase', 'functions');
    return fs.readdirSync(root)
        .filter(d => !SUPERSEDED.has(d) && fs.existsSync(path.join(root, d, 'index.ts')))
        .map(d => ({ name: d, src: fs.readFileSync(path.join(root, d, 'index.ts'), 'utf8') }));
}

/** Every `.rpc("fn", { … })` call in a source, with its literal argument object. */
function rpcCalls(src) {
    const out = [], re = /\.rpc\(\s*["'`](\w+)["'`]\s*,\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
        let i = m.index + m[0].length, depth = 1;
        while (depth && i < src.length) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
        out.push({ fn: m[1], args: src.slice(m.index + m[0].length, i - 1),
                   line: src.slice(0, m.index).split('\n').length });
    }
    return out;
}

test('every edge-function call that names a camper also passes p_camper_id', () => {
    const bad = [];
    for (const { name, src } of edgeSources()) {
        for (const c of rpcCalls(src)) {
            if (/\bp_camper(_name)?\s*:/.test(c.args) && !/\bp_camper_id\s*:/.test(c.args)
                && !/\bp_camper_name\s*:\s*null\b/.test(c.args)) {
                bad.push(`${name}/index.ts:${c.line} ${c.fn}`);
            }
        }
    }
    assert.deepStrictEqual(bad, [], 'these name a camper without the id:\n  ' + bad.join('\n  '));
});

test('the scanner sees a call that names a camper without the id', () => {
    const calls = rpcCalls('await db.rpc("credit_x", { p_camp_id: c, p_camper_name: n, p_meta: { a: 1 } });');
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].args, /p_camper_name/);
    assert.doesNotMatch(calls[0].args, /p_camper_id/);
});

test('a camper named in payment metadata travels with its id', () => {
    // What a webhook reads back to credit a camper: camperName in the metadata
    // must have camperId beside it, or the credit goes by spelling.
    const bad = [];
    for (const { name, src } of edgeSources()) {
        const re = /(["'`]?metadata\[camperName\]["'`]?|\bcamperName:\s*String\()/g;
        if (re.test(src) && !/camperId/.test(src)) bad.push(name);
    }
    assert.deepStrictEqual(bad, [], 'metadata names a camper without the id in: ' + bad.join(', '));
});

test('the tip cart and its webhook carry the camper id to link_tips', () => {
    const cart = fs.readFileSync(path.join(REPO, 'supabase/functions/stripe-connect-tip-cart/index.ts'), 'utf8');
    const hook = fs.readFileSync(path.join(REPO, 'supabase/functions/stripe-connect-webhook/index.ts'), 'utf8');
    assert.match(cart, /person_id:\s*camperIdIn\(it\.camperId\)/);
    assert.match(hook, /person_id:\s*item\.person_id/);
    assert.match(hook, /person_id:\s*camperIdIn\(meta\.camperId\)/);
});
