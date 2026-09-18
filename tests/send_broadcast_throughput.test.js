// node --test tests/send_broadcast_throughput.test.js
//
// A broadcast to a few hundred families could not finish.
//
// send-broadcast sent strictly serially, with a deliberate `await sleep(100)`
// after every recipient AND one awaited `notifications` INSERT per recipient
// before each send. At roughly half a second per family for email + SMS, 400
// families needed about 200 seconds of wall clock — past the platform's limit,
// so the invocation was killed part way through and the office was told
// nothing about how far it got.
//
// The sleep was not pointless: it kept the request rate under the providers'
// limits. So this is not "add concurrency". Pacing is now explicit and shared
// per provider, concurrency is separate and hides each call's latency, and the
// two are tuned independently.
//
// AND THE WORSE BUG UNDERNEATH IT. The idempotency marker is written BEFORE the
// send, which is the right order — a crash must never double-message a family.
// But nothing ever removed it on failure, so any transient rejection (a 429 at
// exactly the recipient counts where 429s start happening) marked that family
// as delivered for good. Retrying the whole broadcast skipped them. The office
// saw `emailFailed: 12` and had no way to reach those twelve except by
// inventing a new eventKey.
//
// The helpers here are the real ones, lifted out of the edge function and
// executed via Node's TypeScript type stripping — not a transcription of them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'supabase/functions/send-broadcast/index.ts');
const SRC = fs.readFileSync(FN, 'utf8');

/** Brace-matched extraction of a top-level function from the edge function. */
function sourceOf(name) {
    const re = new RegExp(`(?:async\\s+)?function ${name}\\b`);
    const m = re.exec(SRC);
    assert.ok(m, `${name} not found in send-broadcast/index.ts`);
    const at = m.index;
    let i = SRC.indexOf('{', SRC.indexOf('(', at)), depth = 0;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
        else if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < SRC.length && SRC[i] !== q) { if (SRC[i] === '\\') i++; i++; } }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const HELPERS = ['rateGate', 'pool', 'withRetry', 'isRetryable'];

/**
 * Runs `body` against the REAL extracted helpers, in a child node with
 * TypeScript type stripping on (the helpers are .ts and carry annotations).
 * Returns whatever `body` prints via `out(value)`.
 */
function runWithHelpers(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcast-'));
    const file = path.join(dir, 'probe.mts');
    fs.writeFileSync(file,
        HELPERS.map(sourceOf).join('\n\n')
        + '\ntype SendResult = { ok: boolean; error?: string; retryable?: boolean };\n'
        + 'function out(v: unknown) { console.log("@@" + JSON.stringify(v)); }\n'
        + `await (async () => {\n${body}\n})();\n`);
    try {
        const stdout = execFileSync(process.execPath,
            ['--experimental-strip-types', '--no-warnings', file],
            { encoding: 'utf8', timeout: 60000 });
        const line = stdout.split('\n').find(l => l.startsWith('@@'));
        assert.ok(line, `probe printed nothing:\n${stdout}`);
        return JSON.parse(line.slice(2));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('the whole edge function is valid TypeScript', () => {
    // Nothing else here executes the file end to end, and it is deployed by
    // pasting it into the Dashboard — a syntax error surfaces in production.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbchk-'));
    const f = path.join(dir, 'index.ts');
    fs.writeFileSync(f, SRC);
    try {
        execFileSync(process.execPath, ['--experimental-strip-types', '--check', f],
            { encoding: 'utf8' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('all four helpers extract and type-strip', () => {
    const got = runWithHelpers('out(HELPERS_OK());'.replace('HELPERS_OK()',
        '[typeof rateGate, typeof pool, typeof withRetry, typeof isRetryable].join(",")'));
    assert.strictEqual(got, 'function,function,function,function');
});

// ── pool: the concurrency that replaces the serial loop ───────────────────
test('pool runs at most `limit` tasks at once and every item exactly once', async () => {
    const got = runWithHelpers(`
        const seen: number[] = [];
        let live = 0, peak = 0;
        const items = Array.from({length: 50}, (_, i) => i);
        await pool(items, 6, async (n: number) => {
            live++; peak = Math.max(peak, live);
            await new Promise(r => setTimeout(r, 5));
            seen.push(n); live--;
        });
        out({ peak, count: seen.length, unique: new Set(seen).size,
              min: Math.min(...seen), max: Math.max(...seen) });
    `);
    assert.strictEqual(got.peak, 6, 'must not exceed the limit');
    assert.strictEqual(got.count, 50, 'every recipient attempted');
    assert.strictEqual(got.unique, 50, 'and none attempted twice');
    assert.deepStrictEqual([got.min, got.max], [0, 49]);
});

test('pool is genuinely faster than serial for slow tasks', async () => {
    const got = runWithHelpers(`
        const t0 = Date.now();
        await pool(Array.from({length: 24}, (_, i) => i), 8, async () => {
            await new Promise(r => setTimeout(r, 40));
        });
        out({ ms: Date.now() - t0 });
    `);
    // Serial would be 24*40 = 960ms; 8-wide should be near 3*40 = 120ms.
    assert.ok(got.ms < 500, `expected well under serial 960ms, got ${got.ms}ms`);
});

test('pool with more capacity than work never over-runs it', async () => {
    const got = runWithHelpers(`
        let peak = 0, live = 0;
        await pool([1, 2], 16, async () => {
            live++; peak = Math.max(peak, live);
            await new Promise(r => setTimeout(r, 10)); live--;
        });
        out({ peak });
    `);
    assert.strictEqual(got.peak, 2, 'two items can never be more than two in flight');
});

test('pool allocates no more workers than there is work', () => {
    // Deliberately a SOURCE assertion. Spare workers find the queue empty and
    // return immediately, so dropping Math.min changes no observable behaviour
    // — it only allocates CONCURRENCY promises to send one email. Asserting it
    // behaviourally would mean writing a test that cannot fail, which is worse
    // than admitting what this checks.
    assert.match(CODE, /Array\.from\(\{ length: Math\.min\(limit, items\.length\) \}/);
});

test('pool on an empty list resolves without running anything', async () => {
    const got = runWithHelpers(`
        let ran = 0;
        await pool([], 6, async () => { ran++; });
        out({ ran });
    `);
    assert.strictEqual(got.ran, 0);
});

test('one throwing task does not silently drop the rest', async () => {
    // Promise.all rejects on the first throw, so a worker that throws aborts
    // the pool. The send worker is written to catch everything; this records
    // that the pool itself does NOT swallow an escape, so a future unguarded
    // throw surfaces rather than half the camp silently going unsent.
    const got = runWithHelpers(`
        let ran = 0, threw = false;
        try {
            await pool([1,2,3,4], 1, async (n: number) => { ran++; if (n === 2) throw new Error('boom'); });
        } catch (e) { threw = true; }
        out({ ran, threw });
    `);
    assert.strictEqual(got.threw, true, 'the pool must propagate, not swallow');
    assert.ok(got.ran < 4, 'and it stops rather than pretending to continue');
});

// ── rateGate: the pacing the 100ms sleep used to provide ──────────────────
test('rateGate spaces calls to the configured rate', async () => {
    const got = runWithHelpers(`
        const gate = rateGate(20);          // one every 50ms
        const t0 = Date.now();
        for (let i = 0; i < 6; i++) await gate();
        out({ ms: Date.now() - t0 });
    `);
    // 6 calls at 50ms spacing: the first is free, so ~250ms.
    assert.ok(got.ms >= 200, `expected pacing of at least 200ms, got ${got.ms}ms`);
    assert.ok(got.ms < 800, `but not much more than that, got ${got.ms}ms`);
});

test('rateGate paces a burst of concurrent callers, not just sequential ones', async () => {
    // This is the case that matters: the pool fires several sends at once, and
    // the gate is what keeps their combined rate under the provider's limit.
    const got = runWithHelpers(`
        const gate = rateGate(20);          // one every 50ms
        const t0 = Date.now();
        const at: number[] = [];
        await Promise.all(Array.from({length: 8}, async () => { await gate(); at.push(Date.now() - t0); }));
        at.sort((a, b) => a - b);
        out({ last: at[at.length - 1], first: at[0] });
    `);
    assert.ok(got.last >= 300,
        `8 concurrent callers at 20/s must span ~350ms, spanned ${got.last}ms — the gate is not pacing concurrency`);
});

test('rateGate does not delay the very first call', async () => {
    const got = runWithHelpers(`
        const gate = rateGate(2);
        const t0 = Date.now();
        await gate();
        out({ ms: Date.now() - t0 });
    `);
    assert.ok(got.ms < 100, `first call should be immediate, waited ${got.ms}ms`);
});

test('two gates are independent, so email pacing cannot throttle SMS', async () => {
    const got = runWithHelpers(`
        const a = rateGate(2), b = rateGate(100);
        await a(); await a();               // burn a's allowance
        const t0 = Date.now();
        await b(); await b();
        out({ ms: Date.now() - t0 });
    `);
    assert.ok(got.ms < 200, `the fast gate was slowed by the slow one (${got.ms}ms)`);
});

// ── isRetryable: which rejections deserve another go ─────────────────────
test('isRetryable: rate limits and server errors are retryable', async () => {
    const got = runWithHelpers(`
        out({
          rl429:    isRetryable(429, 'Too many requests'),
          // A provider that returns a bare 429 with an unhelpful body. Every
          // other 429 case here also says "too many requests", so the message
          // branch alone satisfied them and the status check looked covered
          // when it was not.
          bare429:  isRetryable(429, 'Request failed'),
          silent429: isRetryable(429, ''),
          s500:     isRetryable(500, 'oops'),
          s503:     isRetryable(503, 'unavailable'),
          byName:   isRetryable(undefined, 'rate_limit_exceeded'),
          byWords:  isRetryable(undefined, 'Too Many Requests'),
          timeout:  isRetryable(undefined, 'request timeout'),
          reset:    isRetryable(undefined, 'ECONNRESET'),
          network:  isRetryable(undefined, 'network error'),
          temp:     isRetryable(undefined, 'temporarily unavailable'),
        });
    `);
    for (const [k, v] of Object.entries(got)) assert.strictEqual(v, true, `${k} should be retryable`);
});

test('isRetryable: a bad address or rejected message is NOT retryable', async () => {
    const got = runWithHelpers(`
        out({
          s400:     isRetryable(400, 'Invalid to field'),
          s403:     isRetryable(403, 'domain not verified'),
          s422:     isRetryable(422, 'invalid recipient'),
          unsub:    isRetryable(undefined, 'recipient has unsubscribed'),
          plain:    isRetryable(undefined, 'send failed'),
          empty:    isRetryable(undefined, ''),
        });
    `);
    for (const [k, v] of Object.entries(got)) assert.strictEqual(v, false,
        `${k} must not be retried — retrying a permanent rejection just burns the budget`);
});

// ── withRetry: a transient failure is not a lost family ─────────────────
test('withRetry succeeds first time without retrying', async () => {
    const got = runWithHelpers(`
        let n = 0;
        const r = await withRetry(async () => { n++; return { ok: true }; });
        out({ n, ok: r.ok });
    `);
    assert.deepStrictEqual(got, { n: 1, ok: true });
});

test('withRetry retries a rate limit and can then succeed', async () => {
    const got = runWithHelpers(`
        let n = 0;
        const r = await withRetry(async () => {
            n++;
            return n < 3 ? { ok: false, error: '429', retryable: true } : { ok: true };
        });
        out({ n, ok: r.ok });
    `);
    assert.deepStrictEqual(got, { n: 3, ok: true },
        'a 429 must cost a delay, not a family');
});

test('withRetry does NOT retry a permanent rejection', async () => {
    const got = runWithHelpers(`
        let n = 0;
        const r = await withRetry(async () => { n++; return { ok: false, error: 'bad address' }; });
        out({ n, ok: r.ok, err: r.error });
    `);
    assert.strictEqual(got.n, 1, 'retrying a bad address wastes the wall-clock budget');
    assert.strictEqual(got.ok, false);
    assert.strictEqual(got.err, 'bad address');
});

test('withRetry gives up after its attempt limit and reports the last error', async () => {
    const got = runWithHelpers(`
        let n = 0;
        const t0 = Date.now();
        const r = await withRetry(async () => { n++; return { ok: false, error: 'try ' + n, retryable: true }; });
        out({ n, ok: r.ok, err: r.error, ms: Date.now() - t0 });
    `);
    assert.strictEqual(got.n, 3, 'default is three attempts');
    assert.strictEqual(got.ok, false);
    assert.strictEqual(got.err, 'try 3', 'the reported error must be the last one, not the first');
    assert.ok(got.ms >= 1900, `expected 0.5s + 1.5s of backoff, waited ${got.ms}ms`);
});

test('withRetry honours a custom attempt count', async () => {
    const got = runWithHelpers(`
        let n = 0;
        await withRetry(async () => { n++; return { ok: false, error: 'x', retryable: true }; }, 1);
        out({ n });
    `);
    assert.strictEqual(got.n, 1);
});

// ── the wiring in the handler ───────────────────────────────────────────
// The edge function with its comments removed.
function code() {
    let out = '', i = 0;
    while (i < SRC.length) {
        const c = SRC[i];
        if (c === '/' && SRC[i + 1] === '/') { const nl = SRC.indexOf('\n', i); i = nl < 0 ? SRC.length : nl; continue; }
        if (c === '/' && SRC[i + 1] === '*') { const e = SRC.indexOf('*/', i); i = e < 0 ? SRC.length : e + 2; continue; }
        if (c === "'" || c === '"' || c === '`') { const q = c; out += c; i++; while (i < SRC.length) { if (SRC[i] === '\\') { out += SRC.slice(i, i + 2); i += 2; continue; } out += SRC[i]; if (SRC[i] === q) { i++; break; } i++; } continue; }
        out += c; i++;
    }
    return out;
}
const CODE = code();

test('the per-recipient sleep is gone', () => {
    assert.ok(!/setTimeout\(\(r\) => r\), 100\)|length > 5\) await new Promise/.test(CODE),
        'the 100ms-per-recipient sleep must be replaced by the shared rate gates');
    assert.ok(!CODE.includes('(to as any[]).length > 5'),
        'the old pacing condition is still there');
});

test('idempotency is claimed in one round trip, not one per recipient', () => {
    assert.ok(!/\.from\("notifications"\)\s*\.insert\(\{/.test(CODE),
        'a per-recipient INSERT is 400 sequential round trips before the first send');
    assert.match(CODE, /\.from\("notifications"\)\s*\.upsert\(rows,\s*\{\s*onConflict:\s*"camp_id,source,source_id",\s*ignoreDuplicates:\s*true\s*\}\)\s*\.select\("source_id"\)/,
        'one upsert, keyed on the table\'s unique constraint, returning what it claimed');
});

test('recipients sharing an address are deduped before the claim', () => {
    // Siblings on one parent email. The old loop got this right by accident —
    // the second INSERT conflicted — so the batch has to do it on purpose.
    assert.match(CODE, /const bySource = new Map<string, any>\(\)/);
    assert.match(CODE, /if \(!bySource\.has\(sid\)\) bySource\.set\(sid, r\)/);
});

test('a failed claim sends nothing at all', () => {
    // Not knowing who has already been messaged, sending would risk
    // double-messaging the whole camp. One retry is cheaper.
    assert.match(CODE, /if \(claimErr\) \{[\s\S]{0,400}?return json\(\s*\{\s*error:[^}]*\}\s*,\s*503\s*\)/);
});

test('a claim that could not be honoured is released', () => {
    assert.match(CODE, /if \(anyFailed && !anySent\) deferred\.push\(recipient\)/,
        'a family nothing reached must be released, or a retry skips them for ever');
    assert.match(CODE, /\.from\("notifications"\)\s*\.delete\(\)[\s\S]{0,200}?\.in\("source_id", sids\)/,
        'the release itself');
    assert.match(CODE, /\.eq\("camp_id", campId\)\.eq\("source", "broadcast_fallback"\)/,
        'scoped to this camp and source, so it cannot delete another camp\'s markers');
});

test('a partial success is NOT released', () => {
    // A family that got the email but not the SMS has been reached. Releasing
    // them would email them twice on the retry.
    const guard = /if \(anyFailed && !anySent\)/.exec(CODE);
    assert.ok(guard, 'the guard must test BOTH, not just anyFailed');
    assert.ok(!/if \(anyFailed\) deferred\.push/.test(CODE));
});

test('a deliberate skip is not a failure', () => {
    // An unsubscribed address or an opted-out phone is a decision, not an
    // error: it must not release the claim and invite a retry.
    assert.match(CODE, /unsubscribedEmails\.has\(String\(recipient\.email\)\.toLowerCase\(\)\)\) \{ results\.emailSkipped\+\+; \}/);
    assert.match(CODE, /optedOutPhones\.has\(key\)\) \{ results\.smsSkipped\+\+; \}/);
    // ...and neither touches anyFailed.
    for (const m of CODE.matchAll(/results\.(email|sms)Skipped\+\+;([^\n]*)/g)) {
        assert.ok(!m[2].includes('anyFailed'), `a skip set anyFailed: ${m[0]}`);
    }
});

test('the wall-clock budget stops cleanly and says so', () => {
    assert.match(CODE, /if \(Date\.now\(\) - startedAt > BUDGET_MS\) \{ outOfTime = true; deferred\.push\(recipient\); return; \}/,
        'over budget, the remaining recipients are deferred rather than attempted');
    assert.match(CODE, /const done = !outOfTime;/);
    assert.match(CODE, /return json\(\{ success: true, \.\.\.results, done, remaining, attempted: queue\.length - remaining \}\)/,
        'the caller needs to know it is incomplete and how much is left');
});

test('both consent and the send path survive the rewrite', () => {
    assert.match(CODE, /if \(recipient\.consent === false\)/,
        'only an EXPLICIT consent:false is skipped — default-allow is deliberate');
    assert.match(CODE, /!phoneBook\?\.has\(key\)/,
        'a phone must still be proven to belong to this camp');
    assert.match(CODE, /"List-Unsubscribe": `<\$\{link\}>`/,
        'per-recipient unsubscribe headers are deliverability-critical');
    assert.match(CODE, /replyTo: campReplyTo/);
    assert.match(CODE, /Reply STOP to opt out\./);
    assert.match(CODE, /const rSubject = recipient\.subject \|\| subject;/,
        'merge-tag-personalised per-recipient copy');
});

test('every provider call goes through pacing and retry', () => {
    // Counted outside withRetry's own declaration, which the bare name matches.
    const callSites = [...CODE.matchAll(/(?<!function )withRetry\(/g)]
        .filter(m => !/async function withRetry\($/.test(CODE.slice(0, m.index + 10)));
    assert.strictEqual(callSites.length, 2, 'exactly the email send and the SMS send');
    assert.match(CODE, /await emailGate\(\);/);
    assert.match(CODE, /await smsGate\(\); return await sendTelnyxSMS/);
    // Both gates must be INSIDE the retried closure, so a retry after a 429
    // waits for a fresh rate slot instead of firing straight back into the limit.
    const flat = CODE.replace(/\s+/g, ' ');
    assert.match(flat, /withRetry\(async \(\) => \{ await emailGate\(\);/);
    assert.match(flat, /withRetry\(async \(\) => \{ await smsGate\(\); return await sendTelnyxSMS/);
});

test('the tunables are env-overridable with sane floors', () => {
    for (const [name, def] of [['BROADCAST_CONCURRENCY', 6], ['BROADCAST_EMAIL_PER_SEC', 8],
                               ['BROADCAST_SMS_PER_SEC', 8]]) {
        assert.match(CODE, new RegExp(`Math\\.max\\(1, Number\\(Deno\\.env\\.get\\("${name}"\\) \\|\\| ${def}\\)\\)`),
            `${name} must clamp to at least 1 — a 0 rate would divide by zero and hang`);
    }
    assert.match(CODE, /Math\.max\(5000, Number\(Deno\.env\.get\("BROADCAST_BUDGET_MS"\) \|\| 100000\)\)/);
});

test('the function is still a single self-contained file', () => {
    // It is deployed by pasting one file into the Dashboard, so a relative
    // import of ../_shared cannot bundle.
    assert.ok(!/from\s+["']\.\.?\//.test(CODE),
        'no relative imports — this file is pasted whole into the Dashboard');
});

// ── the caller has to finish what the budget interrupted ─────────────────
const ADMIN = fs.readFileSync(path.join(ROOT, 'campistry_link_admin.html'), 'utf8');

/** _sendNonAdopterFallback, extracted and run against a fake invoker. */
function runFallback(responses) {
    const at = ADMIN.indexOf('async function _sendNonAdopterFallback(');
    assert.notStrictEqual(at, -1, '_sendNonAdopterFallback not found');
    let i = ADMIN.indexOf('{', ADMIN.indexOf(')', at)), depth = 0, end = -1;
    for (; i < ADMIN.length; i++) {
        const c = ADMIN[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        else if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < ADMIN.length && ADMIN[i] !== q) { if (ADMIN[i] === '\\') i++; i++; } }
    }
    const src = ADMIN.slice(at, end);
    const invocations = [];
    const vmMod = require('node:vm');
    const ctx = {
        console, Promise,
        toast: () => {},
        _applyMergeTags: (s) => s,
        _dbc2: () => ({
            campId: 'camp1',
            client: { functions: { invoke: (name, opts) => {
                invocations.push(opts.body);
                const r = responses.shift();
                return Promise.resolve(r instanceof Error ? { error: r } : { data: r });
            } } },
        }),
    };
    vmMod.createContext(ctx);
    vmMod.runInContext(src + ';globalThis.__fn=_sendNonAdopterFallback;', ctx);
    return { fn: ctx.__fn, invocations };
}

const RECIPIENTS = [{ parentEmail: 'a@x.com', smsEmailConsent: true },
                    { parentEmail: 'b@x.com', smsEmailConsent: true }];

test('a complete send invokes once', async () => {
    const h = runFallback([{ success: true, emailSent: 2, done: true, remaining: 0 }]);
    const out = await h.fn(RECIPIENTS, 's', 'b', ['email'], 'Camp', 'ev1', {});
    assert.strictEqual(h.invocations.length, 1);
    assert.strictEqual(out.emailSent, 2);
    assert.strictEqual(out.done, true);
});

test('an interrupted send is resumed and the counts are summed', async () => {
    const h = runFallback([
        { success: true, emailSent: 180, emailFailed: 1, done: false, remaining: 220 },
        { success: true, emailSent: 200, emailFailed: 0, done: false, remaining: 20 },
        { success: true, emailSent: 20, emailFailed: 2, done: true, remaining: 2 },
    ]);
    const out = await h.fn(RECIPIENTS, 's', 'b', ['email'], 'Camp', 'ev1', {});
    assert.strictEqual(h.invocations.length, 3, 'must keep going while done is false');
    assert.strictEqual(out.emailSent, 400, 'the office needs the total, not the last pass');
    assert.strictEqual(out.emailFailed, 3);
    assert.strictEqual(out.done, true);
});

test('every resume passes the same eventKey and list, which is what makes it resume', async () => {
    const h = runFallback([
        { success: true, done: false, remaining: 1 },
        { success: true, done: true, remaining: 0 },
    ]);
    await h.fn(RECIPIENTS, 's', 'b', ['email'], 'Camp', 'ev-7', {});
    assert.strictEqual(h.invocations.length, 2);
    for (const body of h.invocations) {
        assert.strictEqual(body.eventKey, 'ev-7',
            'a fresh eventKey would re-send to everyone already messaged');
        assert.strictEqual(body.to.length, 2);
    }
});

test('a legacy response with no done field is treated as complete', async () => {
    // An older deployment of the function still in place must not make the
    // client loop for ever waiting for a field it never sends.
    const h = runFallback([{ success: true, emailSent: 2 }]);
    const out = await h.fn(RECIPIENTS, 's', 'b', ['email'], 'Camp', 'ev1', {});
    assert.strictEqual(h.invocations.length, 1);
    assert.strictEqual(out.emailSent, 2);
});

test('the resume loop is bounded', async () => {
    const h = runFallback(Array.from({ length: 50 },
        () => ({ success: true, emailSent: 1, done: false, remaining: 99 })));
    const out = await h.fn(RECIPIENTS, 's', 'b', ['email'], 'Camp', 'ev1', {});
    assert.strictEqual(h.invocations.length, 20, 'a stuck send must not spin for ever');
    assert.strictEqual(out.truncated, true, 'and it must say it gave up');
});

test('an invoke error still surfaces rather than looping', async () => {
    const h = runFallback([
        { success: true, done: false, remaining: 5 },
        new Error('function boot failed'),
    ]);
    const out = await h.fn(RECIPIENTS, 's', 'b', ['email'], 'Camp', 'ev1', {});
    assert.strictEqual(out, null, 'the caller contract is null on failure, never a throw');
    assert.strictEqual(h.invocations.length, 2);
});

test('nothing to send short-circuits without invoking', async () => {
    const h = runFallback([]);
    assert.strictEqual(await h.fn([], 's', 'b', ['email'], 'Camp', 'ev1', {}), null);
    assert.strictEqual(await h.fn(RECIPIENTS, 's', 'b', ['app'], 'Camp', 'ev1', {}), null,
        'in-app only is not a fallback channel');
    assert.strictEqual(h.invocations.length, 0);
});

// ── the office side of the same resume, in campistry_me.js ───────────────
const ME = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');

/** sendBroadcastComplete, extracted and run against a fake edge call. */
function runMeSender(responses) {
    const at = ME.indexOf('async function sendBroadcastComplete(');
    assert.notStrictEqual(at, -1, 'sendBroadcastComplete not found in campistry_me.js');
    let i = ME.indexOf('{', ME.indexOf(')', at)), depth = 0, end = -1;
    for (; i < ME.length; i++) {
        const c = ME[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        else if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < ME.length && ME[i] !== q) { if (ME[i] === '\\') i++; i++; } }
    }
    const bodies = [];
    const vmMod = require('node:vm');
    const ctx = {
        console, Promise,
        callEdgeFunctionAuthed: (fn, body) => {
            bodies.push(body);
            const r = responses.shift();
            if (r instanceof Error) return Promise.reject(r);
            return Promise.resolve(r);
        },
    };
    vmMod.createContext(ctx);
    vmMod.runInContext(ME.slice(at, end) + ';globalThis.__fn=sendBroadcastComplete;', ctx);
    return { fn: ctx.__fn, bodies };
}

test('the office sender resumes until the function reports done', async () => {
    const h = runMeSender([
        { emailSent: 150, done: false, remaining: 250 },
        { emailSent: 150, done: false, remaining: 100 },
        { emailSent: 100, emailFailed: 1, done: true, remaining: 1 },
    ]);
    const out = await h.fn({ campId: 'c', to: [1, 2], eventKey: 'ev1' });
    assert.strictEqual(h.bodies.length, 3);
    assert.strictEqual(out.emailSent, 400, 'totals across passes, not the last pass');
    assert.strictEqual(out.emailFailed, 1);
    assert.strictEqual(out.done, true);
});

test('the office sender refuses to resume without an eventKey', async () => {
    // No eventKey means no claims in the notifications table, so a second pass
    // would message everyone a second time. One pass, and say it is incomplete.
    const h = runMeSender([{ emailSent: 150, done: false, remaining: 250 }]);
    const out = await h.fn({ campId: 'c', to: [1, 2] });
    assert.strictEqual(h.bodies.length, 1, 'must not resume a send it cannot deduplicate');
    assert.strictEqual(out.truncated, true, 'and must say the send is incomplete');
});

test('the office sender treats a response with no done field as complete', async () => {
    const h = runMeSender([{ emailSent: 2 }]);
    const out = await h.fn({ campId: 'c', to: [1, 2], eventKey: 'ev1' });
    assert.strictEqual(h.bodies.length, 1);
    assert.strictEqual(out.emailSent, 2);
});

test('the office sender is bounded and flags giving up', async () => {
    const h = runMeSender(Array.from({ length: 40 },
        () => ({ emailSent: 1, done: false, remaining: 99 })));
    const out = await h.fn({ campId: 'c', to: [1, 2], eventKey: 'ev1' });
    assert.strictEqual(h.bodies.length, 20);
    assert.strictEqual(out.truncated, true);
});

test('the office sender passes the identical body every pass', async () => {
    const h = runMeSender([
        { done: false, remaining: 1 }, { done: true, remaining: 0 },
    ]);
    const body = { campId: 'c', to: [1, 2], subject: 's', eventKey: 'ev-9' };
    await h.fn(body);
    assert.strictEqual(h.bodies.length, 2);
    assert.strictEqual(h.bodies[0], h.bodies[1], 'the same object, so nothing can drift');
    assert.strictEqual(h.bodies[1].eventKey, 'ev-9');
});

test('an edge-function error propagates instead of looping', async () => {
    const h = runMeSender([{ done: false, remaining: 5 }, new Error('boom')]);
    await assert.rejects(() => h.fn({ campId: 'c', to: [1], eventKey: 'ev1' }), /boom/);
    assert.strictEqual(h.bodies.length, 2);
});

test('both bulk senders in Me go through the resume helper', () => {
    // The two that send to a whole camp. Every other call site sends to one
    // address and cannot outgrow an invocation.
    assert.match(ME, /return await sendBroadcastComplete\(\{campId:getCampId\(\),to:recipients,[^}]*eventKey:'me-broadcast:'/,
        'the Me broadcast');
    assert.match(ME, /var r=await sendBroadcastComplete\(\{campId:getCampId\(\),to:recipients,[^}]*eventKey:'me-sendlink:'\+Date\.now\(\)\}\)/,
        'Send Link, which previously had no eventKey at all');
    // No bulk caller may still invoke the function directly.
    for (const m of ME.matchAll(/callEdgeFunctionAuthed\('send-broadcast',\{[^\n]*/g)) {
        assert.ok(!/to:recipients/.test(m[0]),
            `a bulk send still bypasses the resume helper: ${m[0].slice(0, 120)}`);
    }
});

test('Send Link reports what was sent, not what was intended', () => {
    // It used to toast recipients.length unconditionally, so a send that
    // reached 180 of 400 families still said "Sent to 400".
    const at = ME.indexOf("eventKey:'me-sendlink:'");
    const near = ME.slice(at, at + 900);
    assert.match(near, /var sent=Number\(r\.emailSent\|\|0\)/);
    assert.match(near, /toast\('Sent to '\+sent\+' recipient'/);
    assert.ok(!/toast\('Sent to '\+recipients\.length/.test(ME),
        'the intended-count toast is still there');
});
