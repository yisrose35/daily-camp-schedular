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
    // The parent-setup site sits inside the retry loop now (`jwt = ...`), the
    // owner site still declares (`const jwt = ...`). Count the call, not the
    // declaration, or this pins a shape rather than the behaviour.
    const sites = [...src.matchAll(/jwt = tokenFrom\(s\.data\);/g)];
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

// ── the auth rate limit: the test's ceiling, not the app's ──────────────────
// A 100-parent run signed in 32 and then got HTTP 429 "Request rate limit
// reached" for the rest. Supabase rate-limits its auth endpoint per IP, and this
// script signs in N parents from one machine in seconds — which no real camp
// ever does: a parent signs in once, from home, and keeps the session for days.
// So the sign-ins are paced and retried, and a shortfall says what it is instead
// of looking like the app failing.

test('rateGate: spaces calls, and the first one is free', async () => {
    const { rateGate } = await load();
    const gate = rateGate(20);                   // one every 50ms
    const t0 = Date.now();
    await gate();
    assert.ok(Date.now() - t0 < 40, 'the first call must not wait');
    for (let i = 0; i < 5; i++) await gate();
    const ms = Date.now() - t0;
    assert.ok(ms >= 200, `expected ~250ms of pacing, got ${ms}ms`);
    assert.ok(ms < 900, `but not much more, got ${ms}ms`);
});

test('rateGate: paces concurrent callers too, which is the whole point', async () => {
    const { rateGate } = await load();
    const gate = rateGate(20);
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => gate()));
    assert.ok(Date.now() - t0 >= 300, 'eight at once must still be spread out');
});

test('isRateLimited: recognises the limiter by status AND by message', async () => {
    const { isRateLimited } = await load();
    assert.strictEqual(isRateLimited({ status: 429, data: {} }), true);
    // the real body Supabase sent: {code, error_code, msg}
    assert.strictEqual(isRateLimited({ status: 400, data: { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' } }), true,
        'a limiter answering 400 with a rate-limit message must still be recognised');
    assert.strictEqual(isRateLimited({ status: 200, data: { error_description: 'Rate limit exceeded' } }), true);
    // and NOT anything else — a wrong password must never be retried as a limit
    assert.strictEqual(isRateLimited({ status: 400, data: { error: 'invalid_grant', error_description: 'Invalid login credentials' } }), false);
    assert.strictEqual(isRateLimited({ status: 500, data: { msg: 'internal error' } }), false);
    assert.strictEqual(isRateLimited({ status: 200, data: { access_token: 'x' } }), false);
    assert.strictEqual(isRateLimited(null), false);
    assert.strictEqual(isRateLimited({ status: 400, data: 'some html' }), false);
});

test('the sign-in loop paces, retries only a rate limit, and gives up bounded', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.match(src, /const signInGate = rateGate\(Math\.max\(1, Number\(process\.env\.LOADTEST_SIGNIN_PER_SEC \|\| 8\)\)\);/,
        'paced, and tunable when a project has a tighter limit');
    assert.match(src, /for \(let attempt = 0; attempt < 4 && !jwt; attempt\+\+\) \{/, 'bounded');
    assert.match(src, /await signInGate\(\);\s*\n\s*s = await c\.signIn/, 'the gate is inside the retry loop');
    assert.match(src, /if \(jwt \|\| !isRateLimited\(s\)\) break;/,
        'only a rate limit is retried — a bad password must not be tried four times');
    assert.match(src, /await new Promise\(r => setTimeout\(r, 2000 \* \(attempt \+ 1\)\)\);/, 'backoff grows');
});

test('a shortfall from the limiter explains itself as the test\'s ceiling', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.match(src, /if \(rateLimited\) \{/);
    assert.match(src, /THIS SCRIPT's ceiling, not your app's/,
        'the reader must not mistake it for the app falling over');
    assert.match(src, /Authentication → Rate Limits/, 'and must say how to raise it');
    assert.match(src, /LOADTEST_SIGNIN_PER_SEC/);
});

// ── bootOrder: the burst must not be charged to one RPC ─────────────────────
// The defect this exists to prevent: four sequential calls per parent in a
// FIXED order, started concurrently, make the first call eat the whole queue
// wait. That reported get_my_balance at 2096ms when its own service time was a
// fraction of it — a harness artifact that reads exactly like a slow function.
test('bootOrder rotates, so every call is first for its share of parents', async () => {
    const { bootOrder } = await load();
    const keys = ['a', 'b', 'c', 'd'];
    assert.deepStrictEqual(bootOrder(keys, 0), ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual(bootOrder(keys, 1), ['b', 'c', 'd', 'a']);
    assert.deepStrictEqual(bootOrder(keys, 3), ['d', 'a', 'b', 'c']);
    assert.deepStrictEqual(bootOrder(keys, 4), ['a', 'b', 'c', 'd'], 'wraps');
});

test('bootOrder is a permutation — no call dropped or measured twice', async () => {
    const { bootOrder } = await load();
    const keys = ['get_my_balance', 'get_canteen_accounts', 'get_my_messages', 'get_camp_broadcasts'];
    for (let i = 0; i < 40; i++) {
        const got = bootOrder(keys, i);
        assert.strictEqual(got.length, keys.length, `i=${i}: every call still fires`);
        assert.deepStrictEqual([...got].sort(), [...keys].sort(), `i=${i}: same set`);
    }
});

test('bootOrder spreads first position evenly across the four calls', async () => {
    const { bootOrder } = await load();
    const keys = ['a', 'b', 'c', 'd'];
    const firsts = {};
    for (let i = 0; i < 60; i++) {
        const f = bootOrder(keys, i)[0];
        firsts[f] = (firsts[f] || 0) + 1;
    }
    // 60 parents over 4 calls: each must lead 15 times. A fixed order would
    // give one call 60 and the rest 0 — which is the bug.
    for (const k of keys) assert.strictEqual(firsts[k], 15, `${k} leads its share`);
});

test('bootOrder survives degenerate input rather than throwing mid-run', async () => {
    const { bootOrder } = await load();
    assert.deepStrictEqual(bootOrder([], 3), [], 'no calls, no crash');
    assert.deepStrictEqual(bootOrder(['only'], 7), ['only']);
    // Deliberately NOT asserting a negative index. `pool` counts up from 0, so
    // it is unreachable, and it is also untestable as a guard: `i % n` already
    // reduces |i| below n, and JS's negative slice offsets coincide with the
    // normalised rotation across that whole range. An assertion here would pass
    // against either spelling and guard nothing.
});

test('the boot loop actually uses the rotation and the pool index', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    // pool must hand the worker its index, or the rotation has nothing to rotate on
    assert.match(src, /for \(;;\) \{ const n = i\+\+; if \(n >= items\.length\) return; await worker\(items\[n\], n\); \}/,
        'pool passes the index');
    assert.match(src, /await pool\(parents, o\.concurrency, async \(p, i\) => \{\s*\n\s*for \(const fn of bootOrder\(bootKeys, i\)\)/,
        'the boot loop rotates per parent — a fixed Object.keys(boot) is the bug');
    assert.doesNotMatch(src, /for \(const fn of Object\.keys\(boot\)\) \{\s*\n\s*const res = await c\.rpc/,
        'the fixed-order loop must be gone, not merely shadowed');
});

test('the boot output says the burst was shared, so the numbers can be read', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.match(src, /call order rotated per parent so no single RPC absorbs the whole burst/);
    assert.match(src, /parents at once/, 'and names the real concurrency reached');
});

// ── the canteen's concurrency is registers, not parents ─────────────────────
// submit_canteen_purchase takes a camp-wide FOR UPDATE lock and rewrites the
// whole snacks blob, so sales serialize. Running the phase at parent
// concurrency measured 100 tills ringing in the same instant — which no camp
// does — and reported WARN (p95 2179ms) for a scenario that cannot occur.
test('parseArgs has a registers default that is a plausible camp, not the pool', async () => {
    const { parseArgs } = await load();
    const o = parseArgs([]);
    assert.strictEqual(o.registers, 6, 'a handful of tills');
    assert.notStrictEqual(o.registers, o.concurrency,
        'the canteen must not inherit the parent-browsing concurrency');
    assert.strictEqual(parseArgs(['--registers', '3']).registers, 3);
    assert.strictEqual(parseArgs(['--registers', '0']).registers, 1, 'floored at one');
    assert.strictEqual(parseArgs(['--registers', '100']).registers, 100,
        'the wide burst stays available for stress runs');
});

test('--registers leaves the parent concurrency alone, and vice versa', async () => {
    const { parseArgs } = await load();
    const a = parseArgs(['--registers', '2']);
    assert.strictEqual(a.concurrency, 50, 'untouched');
    const b = parseArgs(['--concurrency', '10']);
    assert.strictEqual(b.registers, 6, 'untouched');
});

test('the canteen phase runs at the register count, capped by the work available', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.match(src, /const tills = Math\.min\(o\.registers, o\.parents\);/,
        'never more tills than purchases to make');
    assert.match(src, /await pool\(Array\.from\(\{ length: n \}, \(_, i\) => i\), tills,/,
        'the pool uses tills — o.concurrency here is the bug this replaced');
});

test('the canteen seeds ROWS, because 219 stopped the document reaching them', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function phaseCanteen'),
                           src.indexOf('async function teardown('));
    // 219 made camp_canteen_accounts the truth and dropped the projection, so
    // seeding the document now reaches nothing: every account would be created
    // at zero by canteen_account_lock and every sale would fail
    // insufficient_balance — while the phase still printed a throughput number
    // for a run in which nothing was sold.
    assert.match(body, /c\.insert\('camp_canteen_accounts', seedRows\)/,
        'the accounts must be seeded as rows');
    assert.doesNotMatch(body, /upsertKvMerge\(env\.CAMP_ID, 'campistrySnacks'/,
        'seeding the document no longer reaches the accounts that serve the POS');
    // A second run must not collide on the primary key, and must start from a
    // full balance or the daily cap refuses sales partway through.
    assert.match(body, /c\.del\('camp_canteen_accounts',[\s\S]{0,120}?Load Camper/,
        'cleared before seeding');
});

test('the canteen measures SCALING now, not a ceiling it no longer has', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function phaseCanteen'),
                           src.indexOf('async function teardown('));
    // The old phase asserted a camp-wide ceiling as a fact — "adding registers
    // does not raise it". After 219/220 that sentence is false, and a report
    // that states it would tell the reader the opposite of what was achieved.
    assert.doesNotMatch(body, /whatever the register count/);
    assert.doesNotMatch(body, /Adding registers does not raise it/);
    // One register against many, same work: a camp-wide lock cannot let the
    // rate rise, so a rise is the proof it is gone.
    assert.match(body, /const serial = await burst\(serialN, 1\);/,
        'the serial leg must run at ONE register whatever --registers says');
    assert.match(body, /const scale = Math\.round\(\(sN \/ s1\) \* 10\) \/ 10;/);
    assert.match(body, /if \(scale < 1\.5\)/,
        'a rate that does not rise with registers is the finding, and must be called out');
    assert.match(body, /still serialising the camp/);
    // ...and a discarded warm-up, so the first measured burst does not pay for
    // opening the connections the second one reuses.
    assert.match(body, /const warm = Math\.min\(30, o\.parents\);/);
    assert.ok(body.indexOf('const warm =') < body.indexOf('const serial ='),
        'the warm-up must run before anything measured');
});

test('the canteen reports efficiency against linear, not just a ratio', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function phaseCanteen'),
                           src.indexOf('async function teardown('));
    // Two consecutive runs of identical work measured the one-register leg at
    // 3.2/second and then 6.1/second, which inflated the headline ratio to 15x
    // and 13.2x when the truth was near-linear both times. A baseline that
    // swings 2x between runs is not a baseline.
    assert.match(body, /const serialN = Math\.max\(10, Math\.min\(100, o\.parents\)\);/,
        'the baseline leg needs enough samples to divide by');
    // tills/p50 is what perfect scaling would be; the fraction achieved says
    // the same thing as the ratio without a noisy denominator.
    assert.match(body, /const ideal = tills \/ \(full\.sum\.p50 \/ 1000\);/);
    assert.match(body, /% of perfect scaling/);
    assert.match(body, /if \(pct < 60\)/,
        'well under linear is a finding, and names the likely cause');
    assert.match(body, /connections/);
});

test('the label and the plan line both name the register count', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.match(src, /report\.push\(\[`canteen rush · \$\{tills\} register\(s\)`/,
        'two runs at different register counts must not look like the same measurement');
    assert.match(src, /\$\{o\.registers\} canteen register\(s\)/, 'the plan line states it up front');
});

// ── the payments phase ──────────────────────────────────────────────────────
// Migrations 208-215 took payment recording off a camp-wide FOR UPDATE. That is
// asserted structurally by tests/payment_family_writers.test.js and exercised on
// a real Postgres by scripts/pgtests; this phase is the only thing that turns it
// into a number against a real project under real concurrency.
//
// These assert the phase's SHAPE, because the thing that went wrong the first
// time was not a wrong number — it was a measurement whose answer was decided by
// the order the bursts happened to run in. Order, warm-up and what counts as the
// verdict are therefore all pinned here.

/** Just phasePayments, so an assertion cannot pass on a match elsewhere in the file. */
function phaseBody(src) {
    const a = src.indexOf('async function phasePayments');
    assert.ok(a > 0, 'phasePayments exists');
    const b = src.indexOf('async function phaseCanteen', a);
    assert.ok(b > a, 'and ends before the canteen phase');
    return src.slice(a, b);
}
test('parseArgs takes the payments options, with sane defaults', async () => {
    const { parseArgs } = await load();
    const o = parseArgs([]);
    assert.strictEqual(o.payments, 200);
    assert.strictEqual(o.payFamilies, 50);
    assert.strictEqual(parseArgs(['--payments', '500']).payments, 500);
    assert.strictEqual(parseArgs(['--pay-families', '120']).payFamilies, 120);
    assert.strictEqual(parseArgs(['--payments', '0']).payments, 1, 'floored at one');
    assert.strictEqual(parseArgs(['--pay-families', '0']).payFamilies, 1);
    assert.deepStrictEqual(parseArgs(['--phases', 'payments']).phases, ['payments']);
    assert.throws(() => parseArgs(['--phases', 'paymets']), /unknown phase/);
});

test('the payments options do not disturb the other phases', async () => {
    const { parseArgs } = await load();
    const o = parseArgs(['--payments', '5', '--pay-families', '2']);
    assert.strictEqual(o.parents, 200);
    assert.strictEqual(o.registers, 6);
    assert.strictEqual(o.concurrency, 50);
});

test('the payment fixture carries every field the dedupe and the ledger need', async () => {
    const { loadPayment, payFamilyKey } = await load();
    assert.strictEqual(payFamilyKey(3), 'lt_fam_3');
    const p = loadPayment('spread_7', 'lt_fam_3');
    assert.strictEqual(p.id, 'lt_pay_spread_7');
    assert.strictEqual(p.reference, 'lt_ref_spread_7');
    assert.strictEqual(p.familyKey, 'lt_fam_3', 'the ledger post needs familyKey, or nothing is locked');
    assert.ok(p.amount > 0);
    assert.strictEqual(p.status, 'succeeded', 'a pending payment posts no ledger entry, so it would measure less');
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
    // The ids must be prefixed, because teardown deletes by that prefix.
    assert.ok(p.id.startsWith('lt_pay_'));
});

test('every simulated payment is DISTINCT, in both modes', async () => {
    const { loadPayment } = await load();
    const ids = new Set();
    for (const mode of ['spread', 'one']) {
        for (let i = 0; i < 50; i++) ids.add(loadPayment(`${mode}_${i}`, 'lt_fam_0').id);
    }
    // 100 distinct ids: if `one` reused ids, the dedupe would short-circuit and the
    // run would measure a lookup instead of contention on the family row.
    assert.strictEqual(ids.size, 100,
        'a repeated id makes append_camp_payment return alreadyRecorded, measuring nothing');
});

test('the phase discards a warm-up, so no measured burst pays for the connections', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = phaseBody(src);
    // The warm-up must come BEFORE every measured burst, or it warms nothing.
    const warm = body.indexOf("burst('warm'");
    assert.ok(warm > 0, 'there is a warm-up burst');
    for (const leg of ["burst('serial'", "burst('spreadA'", "burst('one'", "burst('spreadB'"]) {
        assert.ok(body.indexOf(leg) > warm, `${leg} must run after the warm-up`);
    }
    // And it must not reach the report: a burst that is measured is not discarded.
    assert.doesNotMatch(body, /report\.push\(\[[^\]]*warm/i, 'the warm-up is discarded, not reported');
});

test('the headline is throughput against CONCURRENCY, which a lock cannot fake', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = phaseBody(src);
    // One caller vs many, same work. This is the test the ratio could not do.
    assert.match(body, /burst\('serial', 'spread', serialN, 1\)/,
        'the serial leg must run at concurrency 1, whatever --concurrency says');
    assert.match(body, /burst\('spreadA', 'spread', o\.payments, o\.concurrency\)/);
    assert.match(body, /const scale = Math\.round\(\(sN \/ s1\) \* 10\) \/ 10;/);
    assert.match(body, /if \(scale < 2\)/,
        'a rate that does not rise with callers is the finding, and must be called out');
    assert.match(body, /A camp-wide lock makes the camp ONE queue/);
    assert.match(body, /still takes a camp-level lock/);
});

test('spread-vs-one is reported but NOT used as the verdict', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = phaseBody(src);
    assert.match(body, /payments · spread over \$\{o\.payFamilies\} families/);
    assert.match(body, /payments · all to ONE family/);
    assert.match(body, /payFamilyKey\(mode === 'one' \? 0 : i % o\.payFamilies\)/,
        'the two modes must differ only in WHICH family is posted to');
    // The claim the first version of this phase made, and could not support.
    assert.match(body, /NOT evidence/,
        'it must say outright that this comparison is not evidence about the camp lock');
    assert.match(body, /one hot row can beat many cold ones/,
        'and must give the reason, so the number is not re-promoted to a verdict later');
    assert.doesNotMatch(body, /if \(ratio < 1\.3\)/,
        'the old ratio verdict conflated a cache hit with a lock — it must be gone');
});

test('two identical spread bursts straddle `one`, so drift cannot pass as a finding', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = phaseBody(src);
    const a = body.indexOf("burst('spreadA'"), o = body.indexOf("burst('one'"), b = body.indexOf("burst('spreadB'");
    assert.ok(a > 0 && o > a && b > o,
        'spreadA then one then spreadB — a fixed order with `one` last is what biased the first version');
    assert.match(body, /const drift = Math\.round\(\(Math\.max\(a, b\) \/ Math\.min\(a, b\)\) \* 10\) \/ 10;/);
    assert.match(body, /if \(drift >= 1\.5\)/, 'a drifting project must invalidate the comparison, loudly');
    assert.match(body, /too noisy for the comparison below to mean much/);
    // The combined rate must use REAL elapsed time, not a rate reconstructed from
    // a rounded rps.
    assert.match(body, /spreadA\.elapsed \+ spreadB\.elapsed/);
});

test('every burst tags its payment ids, so no call in the phase repeats one', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const body = phaseBody(src);
    assert.match(body, /loadPayment\(`\$\{leg\}_\$\{i\}`, famKey\)/,
        'ids carry the leg, or the second burst repeats the first burst\'s ids');
    // Five legs, five distinct tags — a duplicate tag would collide ids across bursts.
    const tags = [...body.matchAll(/burst\('(\w+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(tags, ['warm', 'serial', 'spreadA', 'one', 'spreadB']);
    assert.strictEqual(new Set(tags).size, tags.length, 'a reused leg tag collides ids across bursts');
    // And teardown's prefix still catches all of them.
    for (const t of tags) assert.ok(('lt_pay_' + t).startsWith('lt_pay_'));
});

test('it calls in as the webhooks do — service role, not a browser', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    assert.match(src, /svcRpc: \(fn, args\) => call\('POST', `\/rest\/v1\/rpc\/\$\{fn\}`, args, svc, svc\)/);
    assert.match(src, /await c\.svcRpc\('append_camp_payment',/);
    assert.match(src, /p_dedupe_key: pay\.reference/,
        'the webhook path always passes a reference, which is what exercises the dedupe index');
});

test('the families are seeded through the app\'s own route, not behind its back', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const a = src.indexOf('async function phasePayments');
    const body = src.slice(a, src.indexOf('async function phaseCanteen', a));
    assert.match(body, /upsertKvMerge\(env\.CAMP_ID, 'campistryMe'/,
        "seeded into the document so migration 211's trigger projects them, as a real save would");
    assert.doesNotMatch(body, /insert\('camp_families'/,
        'inserting rows directly would skip the projection and prove less');
    assert.match(body, /Object\.assign\(\{\}, \(me\.families/,
        "it must MERGE with the camp's existing families, not replace them");
});

test('teardown removes the payment rows, the families and the document entries', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    const a = src.indexOf('async function teardown(');
    const body = src.slice(a, src.indexOf('\n}', src.indexOf('family rows removed', a)));
    assert.match(body, /payment_id=like\.lt_pay_\*/, 'the synthetic payment rows');
    assert.match(body, /family_key=like\.lt_fam_\*/, 'and the synthetic family rows');
    assert.match(body, /\/\^lt_fam_\\d\+\$\/\.test\(k\)/, 'and the families out of the document');
    // Leaving payment rows behind would inflate the dedupe index for every later
    // run — the same decay migration 206 fixed in the canteen archive.
    assert.match(body, /inflate every later run's dedupe index/);
    assert.match(body, /if \(paymentsRan\)/, 'and it only runs when the phase did');
});

test('the phase is in the default set and documented at the top', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'load_test.mjs'), 'utf8');
    // The header describes the MEASUREMENT, so it has to describe the one the code
    // performs. The first version's header promised a spread-vs-one contrast and
    // called it proof the camp lock was gone; that reading is what made a cold
    // connection pool look like a lock, so the claim must not survive anywhere.
    const header = src.slice(0, src.indexOf('import {'));
    assert.match(header, /camp-wide lock caps throughput no matter how many callers arrive/);
    assert.match(header, /a rate that RISES with callers is what shows the lock is gone/);
    assert.doesNotMatch(header, /run TWICE/,
        'the header must not still promise the contrast that could not answer the question');
    assert.match(src, /const phases = o\.phases \|\| \['reg', 'portal', 'canteen', 'payments'\];/);
    assert.match(src, /--payments N\s+payments to record/);
    assert.match(src, /--pay-families F/);
    assert.match(src, /any of reg,portal,canteen,payments/);
});
