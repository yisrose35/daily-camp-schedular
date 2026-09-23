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

// ── rows written straight to a table ────────────────────────────────────────

function fakeTableClient() {
    const writes = [];
    return {
        writes,
        rpc() { return Promise.resolve({ data: null, error: null }); },
        from(table) {
            const qb = {};
            ['insert', 'upsert', 'update'].forEach(op => {
                qb[op] = (values, opts) => { writes.push({ table, op, values: JSON.parse(JSON.stringify(values)), opts }); return qb; };
            });
            qb.eq = () => qb; qb.select = () => qb;
            return qb;
        },
    };
}

test('a row written with camper_name also carries person_id', () => {
    const M = load(), c = fakeTableClient();
    M.wrap(c, fromRoster);
    c.from('link_messages').insert({ camp_id: 'c1', camper_name: 'Ayala Weiss', body: 'hi' });
    c.from('link_photo_tags').upsert([{ camper_name: 'Dov Lerner' }, { camper_name: 'Nobody' }], { onConflict: 'x' });
    assert.strictEqual(c.writes[0].values.person_id, 880);
    assert.strictEqual(c.writes[1].values[0].person_id, 881);
    assert.ok(!('person_id' in c.writes[1].values[1]), 'an insert naming nobody we know is left for the server');
    assert.deepStrictEqual(c.writes[1].opts, { onConflict: 'x' }, 'the options pass through');
});

test('re-assigning a row to another camper cannot keep the old camper\'s number', () => {
    // Live's "assign letter to a camper" updates camper_name only. The server
    // stamps a number only where there is none, so the letter kept the number
    // of whoever it was filed under before.
    const M = load(), c = fakeTableClient();
    M.wrap(c, fromRoster);
    c.from('link_camper_mail').update({ camper_name: 'Dov Lerner', bunk: 'B2' }).eq('id', 'm1');
    c.from('link_camper_mail').update({ camper_name: 'Somebody New' }).eq('id', 'm2');
    c.from('link_camper_mail').update({ status: 'printed' }).eq('id', 'm3');
    assert.strictEqual(c.writes[0].values.person_id, 881);
    assert.strictEqual(c.writes[1].values.person_id, null, 'an unknown name must clear the old number so the server resolves it afresh');
    assert.ok(!('person_id' in c.writes[2].values), 'an update that names nobody leaves the number alone');
});

test('a number the page already sent is kept; an async resolver never blocks a write', () => {
    const M = load(), c = fakeTableClient();
    M.wrap(c, () => Promise.resolve(5));
    c.from('link_messages').insert({ camper_name: 'Ayala Weiss' });
    c.from('link_messages').insert({ camper_name: 'Ayala Weiss', person_id: 42 });
    assert.ok(!('person_id' in c.writes[0].values));
    assert.strictEqual(c.writes[1].values.person_id, 42);
});

// ── Campistry Lite (Ted, TED-003) ───────────────────────────────────────────

test('the staff lookup also reads a roster a page registers (Lite keeps its own)', () => {
    const src = fs.readFileSync(path.join(REPO, 'supabase_client.js'), 'utf8');
    const start = src.indexOf('function _camperIdFromRoster');
    const end = src.indexOf('window.__camperIdResolve = _camperIdFromRoster');
    const window = { __camperIdRoster: { 'Ayala Weiss': { camperId: 880 } } };
    const fn = vm.runInNewContext('(' + src.slice(start, end).trim().replace(/;?\s*\/\/[^\n]*$/gm, '') + ')', { window, String });
    assert.strictEqual(fn('c1', 'Ayala Weiss'), 880, 'Lite\'s roster is not consulted');
    assert.strictEqual(fn('c1', 'Nobody'), null);
    window.loadGlobalSettings = () => ({ app1: { camperRoster: { 'Ayala Weiss': { camperId: 5 } } } });
    assert.strictEqual(fn('c1', 'Ayala Weiss'), 5, 'the page\'s own settings still come first');
});

test('Lite registers its roster for the lookup, and records medication by number', () => {
    const lite = fs.readFileSync(path.join(REPO, 'campistry_lite.js'), 'utf8');
    assert.match(lite, /window\.__camperIdRoster = camp\.roster;/);
    assert.ok(lite.indexOf('window.__camperIdRoster = camp.roster;') < lite.indexOf('camp.rosterAll = camp.roster;'),
        'the full roster must be registered before the "here today" filter narrows it');
    const med = lite.slice(lite.indexOf('async function logMedGiven'), lite.indexOf('function healthTodayISO'));
    assert.match(med, /camperId:/, 'a medication given from Lite is recorded by name only');
});

test('Lite loads every one of its own scripts with a version, and loads the number module', () => {
    const html = fs.readFileSync(path.join(REPO, 'campistry_lite.html'), 'utf8');
    assert.match(html, /var LITE_ASSET_VERSION = '\d{8}-\d{2}';/);
    assert.match(html, /t\.src = own \? chain\[i\] \+ '\?v=' \+ LITE_ASSET_VERSION : chain\[i\];/);
    assert.match(html, /campistry_camper_id_rpc\.js\?v=/);
    // Every static script and stylesheet tag of our own carries ?v=.
    const bare = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)]
        .map(m => m[1]).filter(u => !/^https?:/.test(u) && !/\?v=/.test(u));
    assert.deepStrictEqual(bare, [], 'unversioned: ' + bare.join(', '));
});

test('the Health page records carry the camper number', () => {
    const h = fs.readFileSync(path.join(REPO, 'campistry_health.js'), 'utf8');
    const pushes = [...h.matchAll(/hd\.(dispensingLog|sickVisits)\.push\(\{[^\n]*/g)].map(m => m[0]);
    assert.ok(pushes.length >= 3);
    pushes.forEach(p => assert.match(p, /camperId:camperIdOf\(/, 'a Health record written by name only: ' + p.slice(0, 60)));
});

test('every page loading the database client dynamically asks for a versioned copy', () => {
    const pages = fs.readdirSync(REPO).filter(f => f.endsWith('.html'));
    const bare = pages.filter(f => /\.src = 'supabase_client\.js'/.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
    assert.deepStrictEqual(bare, []);
});

// ── names are shown without numbers ─────────────────────────────────────────

test('a camper\'s name is shown without the roster\'s internal number', () => {
    const window = {};
    vm.runInNewContext(MODULE, { window, Promise, Object, String, Number, RegExp });
    const show = window.campistryName;
    assert.strictEqual(show('Malky Stein #102'), 'Malky Stein');
    assert.strictEqual(show('Malky Stein'), 'Malky Stein');
    assert.strictEqual(show('Avi Katz #10-2'), 'Avi Katz');
    assert.strictEqual(show('Room #4B'), 'Room #4B', 'only a trailing " #<number>" is internal');
    assert.strictEqual(show(null), '');
});

test('the parent portal and Live show names through it, and never raw keys', () => {
    const portal = fs.readFileSync(path.join(REPO, 'campistry_link_parent.html'), 'utf8');
    const live = fs.readFileSync(path.join(REPO, 'campistry_live.html'), 'utf8');
    assert.ok(!/lk-child-name">'\+c\.name\+/.test(portal), 'the portal child card shows the raw key');
    assert.ok(!/esc\(m\.camper\)/.test(live), 'Live camper mail shows the raw key');
    assert.ok(!/esc\(r\.childName\)/.test(live), 'Live pickup requests show the raw key');
    assert.ok(!/esc\(a\.camper_name\)/.test(live), 'Live pickup alerts show the raw key');
    for (const f of ['auto-notify', 'canteen-auto-reload', 'charge-saved-card', 'payments-charge-nonce', 'stripe-checkout', 'send-payment-receipt']) {
        const src = fs.readFileSync(path.join(REPO, 'supabase/functions', f, 'index.ts'), 'utf8');
        assert.match(src, /function displayName\(/, f + ' writes a parent-facing name without stripping the internal number');
    }
});

test('a saved camp document: every record naming a camper gets their number', () => {
    const M = load(), c = fakeTableClient();
    M.wrap(c, (campId, name) => ({ 'Ayala Weiss': 880, 'Dov Lerner': 881 })[name] || null);
    c.from('camp_state_kv').upsert([{ camp_id: 'c1', key: 'campistryHealth', value: {
        dispensingLog: [{ camperName: 'Ayala Weiss', medication: 'x' }, { camperName: 'Dov Lerner', camperId: 5 }],
        sickVisits: [{ camperName: 'A Lead', complaint: 'y' }],
        nested: { deep: [{ orders: [{ camperName: 'Dov Lerner' }] }] },
    } }], { onConflict: 'camp_id,key' });
    const v = c.writes[0].values[0].value;
    assert.strictEqual(v.dispensingLog[0].camperId, 880);
    assert.strictEqual(v.dispensingLog[1].camperId, 5, 'a number already there is kept');
    assert.ok(!('camperId' in v.sickVisits[0]), 'a name that is not a camper is left alone');
    assert.strictEqual(v.nested.deep[0].orders[0].camperId, 881, 'records deep in the document too');
    c.from('link_messages').insert({ value: { camperName: 'Ayala Weiss' } });
    assert.ok(!('camperId' in c.writes[1].values.value), 'only camp documents are walked');
});
