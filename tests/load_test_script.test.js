// node --test tests/load_test_script.test.js
//
// scripts/load_test.mjs simulates hundreds of parents against a THROWAWAY
// Supabase project. It cannot be run here (no project), so this tests the
// parts that decide whether its numbers mean anything — the percentile math,
// the verdict, the concurrency pool, the poll schedule, the fixtures it
// creates — and the two guards that stop it being pointed at a live camp.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = pathToFileURL(path.join(__dirname, '..', 'scripts', 'load_test.mjs')).href;
const load = () => import(SCRIPT);

// ── parseArgs ──────────────────────────────────────────────────────────────
test('parseArgs: defaults are the real portal numbers', async () => {
    const { parseArgs } = await load();
    const o = parseArgs([]);
    assert.strictEqual(o.parents, 200);
    assert.strictEqual(o.concurrency, 50);
    assert.strictEqual(o.poll, 30, 'the portal polls every 30s; the test must too');
    assert.strictEqual(o.duration, 60);
    assert.strictEqual(o.p95, 1500);
    assert.strictEqual(o.phases, null, 'null means every configured phase');
    assert.strictEqual(o.keep, false);
    assert.strictEqual(o.dryRun, false);
});

test('parseArgs: every flag, and the floors', async () => {
    const { parseArgs } = await load();
    const o = parseArgs(['--parents', '300', '--concurrency', '60', '--duration', '90', '--poll', '10',
                         '--session', '1st Half', '--phases', 'reg, canteen', '--p95-ms', '800', '--keep', '--dry-run']);
    assert.deepStrictEqual([o.parents, o.concurrency, o.duration, o.poll, o.session], [300, 60, 90, 10, '1st Half']);
    assert.deepStrictEqual(o.phases, ['reg', 'canteen']);
    assert.strictEqual(o.p95, 800);
    assert.ok(o.keep && o.dryRun);
    assert.strictEqual(parseArgs(['--parents', '0']).parents, 1, 'at least one parent');
    assert.strictEqual(parseArgs(['--concurrency', '0.4']).concurrency, 1, 'at least one in flight');
    assert.strictEqual(parseArgs(['--poll', '0']).poll, 1, 'a zero poll interval would spin');
});

test('parseArgs: refuses what it does not understand', async () => {
    const { parseArgs } = await load();
    assert.throws(() => parseArgs(['--parnets', '5']), /unknown argument/);
    assert.throws(() => parseArgs(['--phases', 'reg,broadcast']), /unknown phase/);
    assert.throws(() => parseArgs(['--parents', 'lots']), /non-negative number/);
    assert.throws(() => parseArgs(['--duration', '-1']), /non-negative number/);
});

// ── summarize / verdict ────────────────────────────────────────────────────
const S = (ms, ok, error) => ({ ms, ok, error });

test('summarize: percentiles are nearest-rank over sorted latencies', async () => {
    const { summarize } = await load();
    const samples = Array.from({ length: 100 }, (_, i) => S(i + 1, true));  // 1..100 ms
    const s = summarize(samples, 2000);
    assert.strictEqual(s.count, 100);
    assert.strictEqual(s.ok, 100);
    assert.strictEqual(s.p50, 50);
    assert.strictEqual(s.p95, 95);
    assert.strictEqual(s.p99, 99);
    assert.strictEqual(s.max, 100);
    assert.strictEqual(s.mean, 51);
    assert.strictEqual(s.rps, 50, '100 requests in 2s');
});

test('summarize: unsorted input, one sample, and no samples', async () => {
    const { summarize } = await load();
    const s = summarize([S(300, true), S(10, true), S(120, true)], 1000);
    assert.deepStrictEqual([s.p50, s.p95, s.max], [120, 300, 300]);
    const one = summarize([S(42, true)], 1000);
    assert.deepStrictEqual([one.p50, one.p95, one.p99, one.max], [42, 42, 42, 42]);
    const none = summarize([], 1000);
    assert.deepStrictEqual([none.count, none.p95, none.max, none.mean, none.rps], [0, 0, 0, 0, 0]);
    assert.strictEqual(summarize([S(1, true)], 0).rps, 0, 'no division by a zero elapsed');
});

test('summarize: errors are tallied by message', async () => {
    const { summarize } = await load();
    const s = summarize([S(5, false, 'HTTP 500'), S(6, false, 'HTTP 500'), S(7, false, 'session_full'), S(8, false), S(9, true)], 1000);
    assert.strictEqual(s.ok, 1);
    assert.strictEqual(s.failed, 4);
    assert.deepStrictEqual(s.errors, { 'HTTP 500': 2, session_full: 1, unknown: 1 });
});

test('verdict: PASS under the bar, WARN over it, FAIL on unexpected errors, SKIP on nothing', async () => {
    const { summarize, verdict } = await load();
    const fast = summarize(Array.from({ length: 20 }, () => S(100, true)), 1000);
    const slow = summarize(Array.from({ length: 20 }, () => S(3000, true)), 1000);
    assert.strictEqual(verdict(fast, 1500), 'PASS');
    assert.strictEqual(verdict(slow, 1500), 'WARN');
    assert.strictEqual(verdict(summarize([], 1000), 1500), 'SKIP');
    const errs = summarize([S(100, true), S(100, false, 'submit_public_application: HTTP 500')], 1000);
    assert.strictEqual(verdict(errs, 1500), 'FAIL');
});

test('verdict: an expected error is a feature, not a failure', async () => {
    const { summarize, verdict } = await load();
    // A full session correctly waitlists; a synthetic parent with no family
    // correctly gets no_active_invite. Neither is the system falling over.
    const s = summarize([S(100, true), S(100, false, 'submit_public_application: session_full')], 1000);
    assert.strictEqual(verdict(s, 1500, ['session_full']), 'PASS');
    assert.strictEqual(verdict(s, 1500, []), 'FAIL', 'only when listed');
    assert.strictEqual(verdict(s, 50, ['session_full']), 'WARN', 'expected errors still count toward latency');
});

// ── pool ───────────────────────────────────────────────────────────────────
test('pool: bounded concurrency, every item once, index passed', async () => {
    const { pool } = await load();
    let live = 0, peak = 0; const seen = [];
    await pool(Array.from({ length: 30 }, (_, i) => i), 7, async (item, idx) => {
        live++; peak = Math.max(peak, live);
        assert.strictEqual(item, idx);
        await new Promise(r => setTimeout(r, 3));
        seen.push(item); live--;
    });
    assert.strictEqual(peak, 7);
    assert.strictEqual(new Set(seen).size, 30);
    await pool([], 5, async () => { throw new Error('must not run'); });
});

// ── fixtures ───────────────────────────────────────────────────────────────
test('registrationEntry: the shape the public form submits, tagged for teardown', async () => {
    const { registrationEntry } = await load();
    const e = registrationEntry(7, '1st Half', new Date('2026-08-10T15:04:05Z'));
    assert.strictEqual(e.camperName, 'Load Camper 7');
    assert.strictEqual(e.parentEmail, 'loadtest-parent-7@example.com');
    assert.strictEqual(e.session, '1st Half');
    assert.strictEqual(e.status, 'applied');
    assert.strictEqual(e.appliedDate, '2026-08-10');
    assert.strictEqual(e.appliedTime, '2026-08-10T15:04:05.000Z', 'ISO, as the form stamps it — migration 200 backfills from it');
    assert.strictEqual(e.loadTest, true, 'teardown deletes by this tag');
    assert.strictEqual(registrationEntry(1).session, '', 'no session: no capacity lock, still a valid entry');
});

test('entryId: long enough for submit_public_application, and never repeated', async () => {
    const { entryId } = await load();
    const ids = new Set(Array.from({ length: 500 }, entryId));
    assert.strictEqual(ids.size, 500);
    for (const id of ids) assert.ok(id.length >= 32, `${id} would be refused as weak_entry_id`);
});

test('parentFixture: the invite has exactly what the parent RPCs read', async () => {
    const { parentFixture } = await load();
    const f = parentFixture(3, 'camp-uuid');
    assert.strictEqual(f.email, 'loadtest-parent-3@example.com');
    assert.ok(f.password.length >= 16);
    assert.strictEqual(f.invite.camp_id, 'camp-uuid');
    assert.strictEqual(f.invite.parent_email, f.email, 'get_my_messages matches messages by this email');
    assert.deepStrictEqual(f.invite.camper_names, ['Load Camper 3'], 'camp_parent_campers reads camper_names');
    assert.strictEqual(f.invite.status, 'active');
    assert.ok(f.invite.token.length >= 20);
    assert.notStrictEqual(parentFixture(3, 'c').invite.token, f.invite.token, 'tokens are unique');
    assert.ok(!('user_id' in f.invite), 'user_id is bound after the auth user exists');
});

test('seedCanteenAccounts: adds only Load Camper accounts, touches nothing else', async () => {
    const { seedCanteenAccounts, unseedCanteenAccounts } = await load();
    const existing = { accounts: { 'Real Kid': { balance: 12, dailyLimit: 10 } }, transactions: [{ camper: 'Real Kid', amount: 2, type: 'debit' }], inventory: [1] };
    const seeded = seedCanteenAccounts(existing, 3);
    assert.deepStrictEqual(existing.accounts, { 'Real Kid': { balance: 12, dailyLimit: 10 } }, 'input untouched');
    assert.deepStrictEqual(Object.keys(seeded.accounts).sort(), ['Load Camper 0', 'Load Camper 1', 'Load Camper 2', 'Real Kid']);
    assert.deepStrictEqual(seeded.accounts['Load Camper 1'], { balance: 100, dailyLimit: 50, spentToday: 0 });
    assert.deepStrictEqual(seeded.inventory, [1]);
    // teardown removes exactly what was seeded — accounts AND their sales
    seeded.transactions.unshift({ camper: 'Load Camper 2', amount: 1.5, type: 'debit' });
    const clean = unseedCanteenAccounts(seeded);
    assert.deepStrictEqual(Object.keys(clean.accounts), ['Real Kid']);
    assert.deepStrictEqual(clean.transactions, [{ camper: 'Real Kid', amount: 2, type: 'debit' }]);
    // a camp with no snacks blob at all
    assert.deepStrictEqual(seedCanteenAccounts(null, 1), { accounts: { 'Load Camper 0': { balance: 100, dailyLimit: 50, spentToday: 0 } }, transactions: [] });
});

test('pollSchedule: parents are spread across the interval, not fired at once', async () => {
    const { pollSchedule } = await load();
    const ticks = pollSchedule(4, 30000, 60000);
    // 4 parents, offsets 0/7.5/15/22.5s, each polling at t and t+30
    assert.strictEqual(ticks.length, 8);
    assert.deepStrictEqual(ticks.map(t => t.at), [0, 7500, 15000, 22500, 30000, 37500, 45000, 52500]);
    assert.ok(ticks.every((t, i) => i === 0 || t.at >= ticks[i - 1].at), 'sorted by time');
    assert.deepStrictEqual(pollSchedule(3, 30000, 0), [], 'no duration, no ticks');
    const one = pollSchedule(1, 1000, 3500);
    assert.deepStrictEqual(one.map(t => t.at), [0, 1000, 2000, 3000]);
});

// ── the guards ─────────────────────────────────────────────────────────────
const ENV = {
    SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
    CAMP_ID: '00000000-0000-0000-0000-000000000000', I_UNDERSTAND_THIS_IS_A_THROWAWAY_PROJECT: 'yes',
};

test('main: refuses without the throwaway acknowledgement, before any network', async () => {
    const { main } = await load();
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network must not be touched'); };
    try {
        await assert.rejects(() => main([], { ...ENV, I_UNDERSTAND_THIS_IS_A_THROWAWAY_PROJECT: 'YES' }, () => {}), /THROWAWAY/);
        await assert.rejects(() => main([], { ...ENV, I_UNDERSTAND_THIS_IS_A_THROWAWAY_PROJECT: undefined }, () => {}), /THROWAWAY/);
    } finally { globalThis.fetch = realFetch; }
});

test('main: names every missing env var', async () => {
    const { main } = await load();
    await assert.rejects(() => main([], { SUPABASE_URL: 'x' }, () => {}),
        /missing env: SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CAMP_ID/);
});

test('main: --dry-run prints the plan and creates nothing', async () => {
    const { main } = await load();
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls++; throw new Error('network must not be touched'); };
    const lines = [];
    try {
        const r = await main(['--dry-run', '--parents', '12', '--phases', 'reg'], ENV, l => lines.push(l));
        assert.strictEqual(r.dryRun, true);
        assert.strictEqual(r.plan.parents, 12);
        assert.strictEqual(calls, 0);
        assert.ok(lines.some(l => /12 parents/.test(l) && /phases reg/.test(l)));
        assert.ok(lines.some(l => /dry run — nothing created/.test(l)));
    } finally { globalThis.fetch = realFetch; }
});

test('main: an unknown flag fails before the env is even read', async () => {
    const { main } = await load();
    await assert.rejects(() => main(['--bogus'], {}, () => {}), /unknown argument/);
});

// ── the script's own rules ─────────────────────────────────────────────────
test('the script has no dependencies and refuses to touch a live camp silently', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.ok(!/from ['"](?!node:)/.test(src.replace(/\/\/[^\n]*/g, '')), 'node built-ins only — nothing to npm install');
    assert.match(src, /I_UNDERSTAND_THIS_IS_A_THROWAWAY_PROJECT !== 'yes'/);
    // every synthetic thing it creates is recognisable for teardown
    assert.match(src, /loadtest-parent-\$\{i\}@example\.com/);
    assert.match(src, /Load Camper \$\{i\}/);
    assert.match(src, /loadTest: true/);
    // and teardown deletes by exactly those markers, never wider
    assert.match(src, /parent_email=like\.loadtest-parent-\*@example\.com/);
    assert.match(src, /payload->>loadTest=eq\.true/);
    assert.match(src, /\/\^Load Camper \\d\+\$\//);
});

// ── the sign-in bug the first real run exposed ──────────────────────────────
// The run reported "could not sign in ... HTTP 200" for 300 synthetic parents
// AND for the owner's real account. HTTP 200 is SUCCESS: the code read only a
// flat data.access_token and treated every other shape as a failure, then threw
// away the response so the reason was unknowable. Both halves are fixed here —
// tolerate the shapes, and report what actually arrived.

test('tokenFrom: accepts every shape a sign-in can answer with', async () => {
    const { tokenFrom } = await load();
    assert.strictEqual(tokenFrom({ access_token: 'flat' }), 'flat', "GoTrue's own password grant");
    assert.strictEqual(tokenFrom({ session: { access_token: 'nested' } }), 'nested');
    assert.strictEqual(tokenFrom({ data: { session: { access_token: 'deep' } } }), 'deep');
    assert.strictEqual(tokenFrom({ data: { access_token: 'wrapped' } }), 'wrapped');
    assert.strictEqual(tokenFrom({ access_token: 'wins', session: { access_token: 'other' } }), 'wins',
        'the flat field is the real one when both are present');
});

test('tokenFrom: a genuine failure is still null, never a truthy accident', async () => {
    const { tokenFrom } = await load();
    for (const bad of [null, undefined, '', 'a string body', 42, {}, { user: { id: 'u1' } },
                       { error: 'invalid_grant' }, { session: null }, { data: {} }]) {
        assert.strictEqual(tokenFrom(bad), null, `on ${JSON.stringify(bad)}`);
    }
});

test('describeAuthFailure: says what arrived, and never leaks a token or password', async () => {
    const { describeAuthFailure } = await load();
    // an error body
    const e = describeAuthFailure({ status: 400, data: { error: 'invalid_grant', error_description: 'Invalid login credentials' } });
    assert.match(e, /HTTP 400/);
    assert.match(e, /Invalid login credentials/);
    assert.match(e, /fields: error,error_description/);
    // the case that actually happened: 200 with an unexpected shape
    const ok = describeAuthFailure({ status: 200, data: { user: { id: 'u1' }, weird: 1 } });
    assert.match(ok, /HTTP 200/);
    assert.match(ok, /fields: user,weird/, 'the field names are the diagnosis');
    // empty body, text body, network error
    assert.match(describeAuthFailure({ status: 200, data: null }), /empty body/);
    assert.match(describeAuthFailure({ status: 200, data: {} }), /empty object/);
    assert.match(describeAuthFailure({ status: 502, data: '<html>bad gateway</html>' }), /body\(text\): <html>/);
    assert.match(describeAuthFailure({ status: 0, error: 'fetch failed' }), /HTTP 0 · fetch failed/);
    assert.match(describeAuthFailure({ status: 429, data: { msg: 'too many requests' } }), /too many requests/);
    // safety: a description must never carry the secret it was diagnosing
    const safe = describeAuthFailure({ status: 200, data: { access_token: 'SECRET-JWT', refresh_token: 'SECRET-R' } });
    assert.ok(!safe.includes('SECRET-JWT') && !safe.includes('SECRET-R'),
        'field NAMES are diagnostic; values are not ours to print');
    assert.match(safe, /fields: access_token,refresh_token/);
});

test('both sign-in call sites use the extractor and report the reason', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const sites = [...src.matchAll(/const jwt = tokenFrom\(s\.data\);/g)];
    assert.strictEqual(sites.length, 2, 'the parent setup and the canteen owner');
    assert.ok(!/s\.data\.access_token/.test(src), 'no call site may read the flat field directly again');
    assert.strictEqual([...src.matchAll(/describeAuthFailure\(s\)/g)].length, 2, 'both must say why');
});

test('setup failure logging is capped so the reason stays readable', () => {
    // The first real run printed 300 identical lines and scrolled the useful
    // fact away. A few, then a count.
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.match(src, /const warn = \(m\) => \{ if \(shown < 5\) \{ shown\+\+; log\(m\); \} else suppressed\+\+; \};/);
    assert.match(src, /if \(suppressed\) log\(`  ! \.\.\.and \$\{suppressed\} more like the above`\);/);
    assert.strictEqual([...src.matchAll(/warn\(`  ! could not /g)].length, 3,
        'create, invite and sign-in all route through the cap');
});

// ── the false pass: a website answering 200 with HTML ───────────────────────
// The first real run had SUPABASE_URL pointing at the Vercel-hosted site instead
// of the project API. Every endpoint returned HTTP 200 with a Next.js HTML page,
// so nothing reached the database — and the run still reported "300 of 300 ok,
// 73 rps". These tests exist so that can never be reported as a pass again.

const HTML = '<!DOCTYPE html><html lang="en" data-dpl-id="dpl_Hm"><head><meta charSet="utf-8" data-next-head';

test('isJsonObject: only a parsed JSON object counts', async () => {
    const { isJsonObject } = await load();
    assert.strictEqual(isJsonObject({ success: true }), true);
    assert.strictEqual(isJsonObject({}), true);
    for (const bad of [HTML, '', null, undefined, 42, true, [1, 2], []]) {
        assert.strictEqual(isJsonObject(bad), false, `on ${JSON.stringify(bad)}`);
    }
});

test('main: a website URL is caught by the preflight, before anything is created', async () => {
    const { main } = await load();
    const realFetch = globalThis.fetch;
    const hits = [];
    globalThis.fetch = async (url) => {
        hits.push(String(url));
        return { ok: true, status: 200, text: async () => HTML };
    };
    try {
        await assert.rejects(
            () => main(['--parents', '3'], ENV, () => {}),
            (e) => {
                assert.match(e.message, /does not look like a Supabase project API/);
                assert.match(e.message, /Project Settings → API/, 'must say where to get the right URL');
                assert.match(e.message, /rest\/v1\//);
                assert.match(e.message, /auth\/v1\/health/);
                return true;
            });
        // and it must have stopped at the two probes — no users, no applications
        assert.strictEqual(hits.length, 2, `probed then stopped; instead: ${hits.join(' ')}`);
        assert.ok(!hits.some(h => /admin\/users|camp_applications|rpc\//.test(h)),
            'nothing may be created before the URL is proven');
    } finally { globalThis.fetch = realFetch; }
});

test('main: a real project API passes the preflight', async () => {
    const { main } = await load();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
        ok: true, status: 200,
        // REST root and GoTrue health both answer JSON on a real project
        text: async () => (/auth\/v1\/health/.test(String(url)) ? '{"name":"GoTrue","version":"2"}'
                                                                : '{"openapi":"3.0.0"}'),
    });
    const lines = [];
    try {
        // reg phase only, so the run ends quickly; the point is it gets past preflight
        await main(['--parents', '1', '--phases', 'reg'], ENV, l => lines.push(l));
        assert.ok(lines.some(l => /preflight: REST and Auth both answered JSON/.test(l)),
            `expected the preflight to pass; got:\n${lines.join('\n')}`);
    } finally { globalThis.fetch = realFetch; }
});

test('a 200 carrying HTML is counted as a FAILURE, never a success', async () => {
    // The exact false pass: without this, an HTML body sails through as ok.
    const { main, summarize, verdict } = await load();
    const realFetch = globalThis.fetch;
    let phase = 'preflight';
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (/\/rest\/v1\/$/.test(u)) return { ok: true, status: 200, text: async () => '{"openapi":"3.0.0"}' };
        if (/auth\/v1\/health/.test(u)) return { ok: true, status: 200, text: async () => '{"name":"GoTrue"}' };
        phase = 'rpc';
        return { ok: true, status: 200, text: async () => HTML };   // the website answering an RPC
    };
    const lines = [];
    try {
        const r = await main(['--parents', '4', '--phases', 'reg'], ENV, l => lines.push(l));
        const [, s, v] = r.report.find(([name]) => /registration/.test(name));
        assert.strictEqual(phase, 'rpc', 'the RPC must actually have been attempted');
        assert.strictEqual(s.count, 4);
        assert.strictEqual(s.ok, 0, 'not one HTML response may count as ok');
        assert.strictEqual(v, 'FAIL');
        assert.strictEqual(r.worst, 'FAIL');
        const err = Object.keys(s.errors)[0];
        assert.match(err, /body was not JSON \(html\/text\)/);
        assert.match(err, /is SUPABASE_URL the project API URL\?/, 'the error must point at the cause');
    } finally { globalThis.fetch = realFetch; }
});

test('a genuine JSON refusal is still read as a refusal, not as a bad URL', async () => {
    const { main } = await load();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (/\/rest\/v1\/$/.test(u)) return { ok: true, status: 200, text: async () => '{"openapi":"3.0.0"}' };
        if (/auth\/v1\/health/.test(u)) return { ok: true, status: 200, text: async () => '{"name":"GoTrue"}' };
        return { ok: true, status: 200, text: async () => '{"success":false,"error":"session_full"}' };
    };
    try {
        const r = await main(['--parents', '2', '--phases', 'reg'], ENV, () => {});
        const [, s, v] = r.report.find(([name]) => /registration/.test(name));
        assert.strictEqual(s.ok, 0);
        assert.match(Object.keys(s.errors)[0], /session_full/);
        assert.strictEqual(v, 'PASS', 'a full session is a feature, and must not read as a broken URL');
    } finally { globalThis.fetch = realFetch; }
});
