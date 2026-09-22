#!/usr/bin/env node
// =============================================================================
// Campistry load test — hundreds of parents at once, against a THROWAWAY project.
//
// WHAT IT PROVES. Every scaling fix in migrations 200–203 and the parent portal
// is correct by construction and by test; this is the only thing that turns
// "should hold" into "does hold" — real concurrent traffic against a real
// Supabase project, measured. It simulates the three bursts a camp actually
// sees:
//
//   reg      N families submitting registrations in the same minute (anon)
//   portal   N signed-in parents with the portal open — the boot reads, then
//            the 30-second poll loop (messages + broadcasts), for a while
//   canteen  M register sales in a rush, as the camp owner
//
// and reports latency percentiles, error counts and throughput per RPC, with a
// PASS / WARN verdict against a p95 threshold.
//
// WHAT IT CREATES, AND WHY THE PROJECT MUST BE DISPOSABLE. The portal phase
// needs N real signed-in parents, so setup creates N auth users
// (loadtest-parent-<i>@example.com) and N active invites bound to them; the
// canteen phase seeds N "Load Camper <i>" canteen accounts with balances; the
// registration phase files N applications. Teardown removes all of it, but a
// script that creates users and writes camp state must never be pointed at a
// live camp. It refuses to run without an explicit acknowledgement.
//
// HOW TO RUN (from the repo root, Node 18+; no packages to install):
//
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_ANON_KEY=... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   CAMP_ID=<a camp in the throwaway project> \
//   OWNER_EMAIL=... OWNER_PASSWORD=...        (only for the canteen phase) \
//   I_UNDERSTAND_THIS_IS_A_THROWAWAY_PROJECT=yes \
//   node scripts/load_test.mjs --parents 300 --concurrency 60 --duration 90
//
//   --parents N        families / parents / register accounts to simulate (200)
//   --concurrency C    requests in flight at once (50)
//   --duration S       seconds to run the portal poll loop (60)
//   --poll S           the portal's poll interval to simulate (30, the real one)
//   --session NAME     session name registrations sign up for (none)
//   --phases a,b,c     any of reg,portal,canteen (all that are configured)
//   --p95-ms MS        the verdict threshold (1500)
//   --keep             leave the synthetic parents/applications in place
//   --dry-run          print the plan and create nothing
//
// The Supabase Dashboard's own metrics (Reports → Database / Realtime) are the
// other half of the picture — CPU, connections, and the Realtime connection
// count — and are worth watching while this runs.
// =============================================================================
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

// ── pure helpers (exported for tests) ──────────────────────────────────────

/** Parse argv into options with defaults; throws on an unknown flag. */
export function parseArgs(argv) {
    const o = { parents: 200, concurrency: 50, duration: 60, poll: 30, session: '',
                phases: null, p95: 1500, keep: false, dryRun: false };
    const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`); return n; };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], next = () => argv[++i];
        switch (a) {
            case '--parents': o.parents = Math.max(1, Math.floor(num(next(), a))); break;
            case '--concurrency': o.concurrency = Math.max(1, Math.floor(num(next(), a))); break;
            case '--duration': o.duration = num(next(), a); break;
            case '--poll': o.poll = Math.max(1, num(next(), a)); break;
            case '--session': o.session = String(next() || ''); break;
            case '--phases': o.phases = String(next() || '').split(',').map(s => s.trim()).filter(Boolean); break;
            case '--p95-ms': o.p95 = num(next(), a); break;
            case '--keep': o.keep = true; break;
            case '--dry-run': o.dryRun = true; break;
            default: throw new Error(`unknown argument: ${a}`);
        }
    }
    if (o.phases) for (const p of o.phases) if (!['reg', 'portal', 'canteen'].includes(p)) throw new Error(`unknown phase: ${p}`);
    return o;
}

/** Latency percentiles and error tallies over {ms, ok, error?} samples. */
export function summarize(samples, elapsedMs) {
    const lat = samples.map(s => s.ms).sort((a, b) => a - b);
    const pct = p => lat.length ? lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] : 0;
    const errors = {};
    let ok = 0;
    for (const s of samples) {
        if (s.ok) ok++;
        else errors[s.error || 'unknown'] = (errors[s.error || 'unknown'] || 0) + 1;
    }
    return {
        count: samples.length, ok, failed: samples.length - ok, errors,
        p50: pct(50), p95: pct(95), p99: pct(99), max: lat[lat.length - 1] || 0,
        mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
        rps: elapsedMs > 0 ? Math.round((samples.length / elapsedMs) * 1000 * 10) / 10 : 0,
    };
}

/** PASS / WARN for one phase: all requests answered and p95 under the bar. */
export function verdict(summary, p95Bar, expectedErrors) {
    const unexpected = Object.entries(summary.errors)
        .filter(([e]) => !(expectedErrors || []).some(x => e.includes(x)))
        .reduce((n, [, c]) => n + c, 0);
    if (summary.count === 0) return 'SKIP';
    if (unexpected > 0) return 'FAIL';
    return summary.p95 <= p95Bar ? 'PASS' : 'WARN';
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function pool(items, limit, worker) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) { const n = i++; if (n >= items.length) return; await worker(items[n], n); }
    }));
}

/** A registration entry shaped like campistry_register.html submits. */
export function registrationEntry(i, session, now) {
    const d = now || new Date();
    const date = d.toISOString().slice(0, 10);
    return {
        camperName: `Load Camper ${i}`, parentName: `Load Parent ${i}`,
        parentEmail: `loadtest-parent-${i}@example.com`,
        session: session || '', status: 'applied',
        appliedDate: date, appliedTime: d.toISOString(),
        loadTest: true,
    };
}

/** submit_public_application refuses ids shorter than 32 chars. */
export function entryId() { return 'lt_' + randomBytes(20).toString('hex'); }

/** The synthetic parent for index i: user, invite, credentials. */
export function parentFixture(i, campId) {
    return {
        email: `loadtest-parent-${i}@example.com`,
        password: 'LoadTest!' + randomBytes(8).toString('hex'),
        invite: {
            camp_id: campId, token: 'lt_' + randomBytes(16).toString('hex'),
            parent_name: `Load Parent ${i}`, parent_email: `loadtest-parent-${i}@example.com`,
            camper_names: [`Load Camper ${i}`], status: 'active',
        },
    };
}

/**
 * Seed N canteen accounts into an existing campistrySnacks value without
 * touching anyone else's: only "Load Camper <i>" keys are written.
 */
export function seedCanteenAccounts(value, n) {
    const v = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
    if (!v.accounts || typeof v.accounts !== 'object') v.accounts = {};
    if (!Array.isArray(v.transactions)) v.transactions = [];
    for (let i = 0; i < n; i++) v.accounts[`Load Camper ${i}`] = { balance: 100, dailyLimit: 50, spentToday: 0 };
    return v;
}

/** The inverse of seedCanteenAccounts, for teardown. */
export function unseedCanteenAccounts(value) {
    const v = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
    if (v.accounts) for (const k of Object.keys(v.accounts)) if (/^Load Camper \d+$/.test(k)) delete v.accounts[k];
    if (Array.isArray(v.transactions)) v.transactions = v.transactions.filter(t => !(t && /^Load Camper \d+$/.test(t.camper || '')));
    return v;
}

/** Spaces calls so no more than `perSecond` start in any second. */
export function rateGate(perSecond) {
    const gap = 1000 / Math.max(0.1, perSecond);
    let next = 0;
    return async () => {
        const now = Date.now();
        const at = Math.max(now, next);
        next = at + gap;
        if (at > now) await new Promise(r => setTimeout(r, at - now));
    };
}

/** Is this response Supabase's auth rate limiter saying "slow down"? */
export function isRateLimited(res) {
    if (!res) return false;
    if (res.status === 429) return true;
    const d = res.data;
    return !!(d && typeof d === 'object'
        && /rate limit/i.test(String(d.msg || d.error_description || d.error || d.message || '')));
}

/**
 * The access token out of a sign-in response, whatever shape it arrived in.
 *
 * GoTrue's password grant returns a flat {access_token}, but a gateway or a
 * newer client shape can nest it under session/data. Reading only the flat
 * field made a SUCCESSFUL sign-in (HTTP 200) look like a failure, which is
 * exactly how the first real run reported "could not sign in ... HTTP 200"
 * for 300 synthetic parents AND for the owner's real account.
 */
export function tokenFrom(data) {
    if (!data || typeof data !== 'object') return null;
    return data.access_token
        || (data.session && data.session.access_token)
        || (data.data && data.data.session && data.data.session.access_token)
        || (data.data && data.data.access_token)
        || null;
}

/**
 * Why a sign-in did not yield a token, in a line that is safe to paste.
 *
 * Never includes a token or a password: only the status, the field names that
 * came back, and any error-ish message. "200 with no token" is meaningless
 * without knowing WHAT arrived, and that was the whole problem.
 */
export function describeAuthFailure(res) {
    const d = res && res.data;
    const bits = [`HTTP ${res ? res.status : '?'}`];
    if (res && res.error) bits.push(res.error);
    if (typeof d === 'string') bits.push(`body(text): ${d.slice(0, 120)}`);
    else if (d && typeof d === 'object') {
        const msg = d.error_description || d.error || d.msg || d.message || (d.code !== undefined ? `code=${d.code}` : '');
        if (msg) bits.push(String(msg).slice(0, 160));
        const keys = Object.keys(d);
        bits.push(keys.length ? `fields: ${keys.slice(0, 12).join(',')}` : 'empty object');
    } else if (d === null) bits.push('empty body');
    return bits.join(' · ');
}

/** Spread N parents' first poll across one interval so they do not all fire at t=0. */
export function pollSchedule(n, intervalMs, durationMs) {
    const ticks = [];
    for (let i = 0; i < n; i++) {
        const offset = Math.floor((i / n) * intervalMs);
        for (let t = offset; t < durationMs; t += intervalMs) ticks.push({ parent: i, at: t });
    }
    return ticks.sort((a, b) => a.at - b.at);
}

// ── the client ────────────────────────────────────────────────────────────

function mkClient(env) {
    const base = env.SUPABASE_URL.replace(/\/$/, '');
    const anon = env.SUPABASE_ANON_KEY, svc = env.SUPABASE_SERVICE_ROLE_KEY;
    const call = async (method, path, body, jwt, key) => {
        const t0 = Date.now();
        try {
            const res = await fetch(base + path, {
                method,
                headers: { apikey: key || anon, Authorization: `Bearer ${jwt || key || anon}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await res.text();
            let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
            return { ms: Date.now() - t0, status: res.status, data, ok: res.ok };
        } catch (e) {
            return { ms: Date.now() - t0, status: 0, data: null, ok: false, error: e.message };
        }
    };
    return {
        rpc: (fn, args, jwt) => call('POST', `/rest/v1/rpc/${fn}`, args, jwt),
        // service-role table access (bypasses RLS) — setup and teardown only
        insert: (table, rows) => call('POST', `/rest/v1/${table}`, rows, svc, svc),
        select: (table, query) => call('GET', `/rest/v1/${table}?${query}`, undefined, svc, svc),
        del: (table, query) => call('DELETE', `/rest/v1/${table}?${query}`, undefined, svc, svc),
        // upsert one camp_state_kv row as service role (setup/teardown only)
        upsertKvMerge: async (campId, key, value) => {
            const t0 = Date.now();
            try {
                const res = await fetch(`${base}/rest/v1/camp_state_kv?on_conflict=camp_id,key`, {
                    method: 'POST',
                    headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json',
                               Prefer: 'resolution=merge-duplicates,return=minimal' },
                    body: JSON.stringify({ camp_id: campId, key, value, updated_at: new Date().toISOString() }),
                });
                return { ok: res.ok, status: res.status, ms: Date.now() - t0 };
            } catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, error: e.message }; }
        },
        // unauthenticated-ish GET, for the preflight below
        probe: (path) => call('GET', path, undefined),
        adminCreateUser: (email, password) => call('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, user_metadata: { loadTest: true } }, svc, svc),
        adminDeleteUser: (id) => call('DELETE', `/auth/v1/admin/users/${id}`, undefined, svc, svc),
        signIn: (email, password) => call('POST', '/auth/v1/token?grant_type=password', { email, password }),
    };
}

/** RPC result → sample. A JSON {success:false,error} is an error even on HTTP 200. */
/** True only for a parsed JSON object — what every RPC in this app answers with. */
export function isJsonObject(d) { return !!d && typeof d === 'object' && !Array.isArray(d); }

/**
 * RPC result → sample.
 *
 * THREE ways to fail, and the third is the one that mattered. A JSON
 * {success:false,error} is a failure even on HTTP 200 — the app reports refusals
 * that way. And a 200 whose body is NOT JSON is a failure too: on the first real
 * run SUPABASE_URL pointed at the Vercel-hosted website instead of the project
 * API, so every request got a 200 with an HTML page, and this counted 300 of 300
 * "ok" at 73 rps for traffic that never reached the database. A load test that
 * reports PASS when nothing happened is worse than no load test.
 */
function sample(res, fn) {
    if (!res.ok) return { ms: res.ms, ok: false, error: `${fn}: HTTP ${res.status}${res.error ? ' ' + res.error : ''}${isJsonObject(res.data) && res.data.message ? ' ' + res.data.message : ''}` };
    if (!isJsonObject(res.data)) {
        return { ms: res.ms, ok: false,
                 error: `${fn}: HTTP ${res.status} but the body was not JSON (${typeof res.data === 'string' ? 'html/text' : String(res.data)}) — is SUPABASE_URL the project API URL?` };
    }
    if (res.data.success === false) return { ms: res.ms, ok: false, error: `${fn}: ${res.data.error || 'success:false'}` };
    return { ms: res.ms, ok: true };
}

function fmt(name, s, v) {
    const errs = Object.entries(s.errors).map(([e, n]) => `${n}× ${e}`).join('; ');
    return `  ${v.padEnd(4)} ${name.padEnd(28)} n=${String(s.count).padStart(5)} ok=${String(s.ok).padStart(5)} ` +
        `p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms rps=${s.rps}` + (errs ? `\n       errors: ${errs}` : '');
}

// ── the phases ────────────────────────────────────────────────────────────

async function phaseRegistration(c, o, env, report) {
    const items = Array.from({ length: o.parents }, (_, i) => i);
    const samples = [];
    const t0 = Date.now();
    await pool(items, o.concurrency, async (i) => {
        const res = await c.rpc('submit_public_application', {
            p_camp_id: env.CAMP_ID, p_kind: 'enrollments', p_entry_id: entryId(),
            p_entry: registrationEntry(i, o.session),
        });
        samples.push(sample(res, 'submit_public_application'));
    });
    const s = summarize(samples, Date.now() - t0);
    // A full session correctly waitlists; that is the feature, not a failure.
    report.push(['registration burst', s, verdict(s, o.p95, ['session_full'])]);
}

async function setupParents(c, o, env, log) {
    const parents = [];
    // Cap the noise: 300 identical failure lines scrolled the one useful fact
    // off the screen on the first real run. After a few, count silently.
    let shown = 0, suppressed = 0, rateLimited = 0;
    const warn = (m) => { if (shown < 5) { shown++; log(m); } else suppressed++; };
    const signInGate = rateGate(Math.max(1, Number(process.env.LOADTEST_SIGNIN_PER_SEC || 8)));
    await pool(Array.from({ length: o.parents }, (_, i) => i), Math.min(o.concurrency, 20), async (i) => {
        const f = parentFixture(i, env.CAMP_ID);
        const u = await c.adminCreateUser(f.email, f.password);
        if (!u.ok) { warn(`  ! could not create ${f.email}: HTTP ${u.status} ${JSON.stringify(u.data).slice(0, 120)}`); return; }
        f.userId = u.data.id;
        const inv = await c.insert('link_parent_invites', [{ ...f.invite, user_id: f.userId }]);
        if (!inv.ok) { warn(`  ! could not invite ${f.email}: HTTP ${inv.status} ${JSON.stringify(inv.data).slice(0, 120)}`); return; }
        // Paced and retried, because Supabase rate-limits the auth endpoint per IP
        // and this script signs in N parents from ONE machine in a few seconds —
        // which no real camp ever does (a parent signs in once and keeps the
        // session for days). A shortfall here is the TEST's ceiling, not the app's.
        let s = null, jwt = null;
        for (let attempt = 0; attempt < 4 && !jwt; attempt++) {
            await signInGate();
            s = await c.signIn(f.email, f.password);
            jwt = tokenFrom(s.data);
            if (jwt || !isRateLimited(s)) break;
            rateLimited++;
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
        if (!jwt) { warn(`  ! could not sign in ${f.email}: ${describeAuthFailure(s)}`); return; }
        f.jwt = jwt;
        parents.push(f);
    });
    if (suppressed) log(`  ! ...and ${suppressed} more like the above`);
    if (rateLimited) {
        log(`  note: hit Supabase's auth rate limit ${rateLimited} time(s) signing parents in.`);
        log(`        That is THIS SCRIPT's ceiling, not your app's — real parents sign in`);
        log(`        once, from their own homes, and keep the session for days. To simulate`);
        log(`        more: Dashboard → Authentication → Rate Limits, raise sign-ins, or set`);
        log(`        LOADTEST_SIGNIN_PER_SEC lower to pace them out over a longer setup.`);
    }
    return parents;
}

async function phasePortal(c, o, env, report, parents, log) {
    if (!parents.length) { log('  portal: no parents could be set up — skipped'); return; }
    // boot: what the portal calls when it opens
    const boot = { get_my_balance: [], get_canteen_accounts: [], get_my_messages: [], get_camp_broadcasts: [] };
    let t0 = Date.now();
    await pool(parents, o.concurrency, async (p) => {
        for (const fn of Object.keys(boot)) {
            const res = await c.rpc(fn, { p_camp_id: env.CAMP_ID }, p.jwt);
            boot[fn].push(sample(res, fn));
        }
    });
    const bootMs = Date.now() - t0;
    for (const fn of Object.keys(boot)) {
        const s = summarize(boot[fn], bootMs);
        report.push([`portal boot · ${fn}`, s, verdict(s, o.p95, ['no_active_invite', 'no_family'])]);
    }
    // the poll loop, for --duration seconds, at the real interval, spread out
    const durationMs = o.duration * 1000, intervalMs = o.poll * 1000;
    const ticks = pollSchedule(parents.length, intervalMs, durationMs);
    const polls = { get_my_messages: [], get_camp_broadcasts: [] };
    log(`  portal: ${parents.length} parents polling every ${o.poll}s for ${o.duration}s → ${ticks.length} ticks`);
    t0 = Date.now();
    let inFlight = 0;
    const runTick = async (tick) => {
        inFlight++;
        const p = parents[tick.parent];
        for (const fn of Object.keys(polls)) {
            const res = await c.rpc(fn, { p_camp_id: env.CAMP_ID }, p.jwt);
            polls[fn].push(sample(res, fn));
        }
        inFlight--;
    };
    const pending = [];
    for (const tick of ticks) {
        const wait = tick.at - (Date.now() - t0);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        while (inFlight >= o.concurrency) await new Promise(r => setTimeout(r, 5));
        pending.push(runTick(tick));
    }
    await Promise.all(pending);
    const pollMs = Date.now() - t0;
    for (const fn of Object.keys(polls)) {
        const s = summarize(polls[fn], pollMs);
        report.push([`portal poll · ${fn}`, s, verdict(s, o.p95, ['no_active_invite'])]);
    }
}

async function phaseCanteen(c, o, env, report, log) {
    if (!env.OWNER_EMAIL || !env.OWNER_PASSWORD) { log('  canteen: OWNER_EMAIL/OWNER_PASSWORD not set — skipped'); return null; }
    const s = await c.signIn(env.OWNER_EMAIL, env.OWNER_PASSWORD);
    const jwt = tokenFrom(s.data);
    if (!jwt) { log(`  canteen: owner sign-in failed (${describeAuthFailure(s)}) — skipped`); return null; }
    // seed balances for the synthetic campers, touching nobody else's account
    const cur = await c.select('camp_state_kv', `select=value&camp_id=eq.${env.CAMP_ID}&key=eq.campistrySnacks`);
    const existing = cur.ok && Array.isArray(cur.data) && cur.data[0] ? cur.data[0].value : null;
    const seeded = seedCanteenAccounts(existing, o.parents);
    const w = await c.upsertKvMerge(env.CAMP_ID, 'campistrySnacks', seeded);
    if (!w.ok) { log(`  canteen: could not seed accounts (HTTP ${w.status}) — skipped`); return null; }
    const samples = [];
    const t0 = Date.now();
    await pool(Array.from({ length: o.parents }, (_, i) => i), o.concurrency, async (i) => {
        const res = await c.rpc('submit_canteen_purchase', {
            p_camp_id: env.CAMP_ID, p_camper_name: `Load Camper ${i}`, p_amount: 1.5, p_items: 'Load test',
        }, jwt);
        samples.push(sample(res, 'submit_canteen_purchase'));
    });
    const sum = summarize(samples, Date.now() - t0);
    report.push(['canteen rush', sum, verdict(sum, o.p95, [])]);
    return existing;
}

async function teardown(c, env, parents, snacksBefore, log) {
    log('teardown…');
    const inv = await c.del('link_parent_invites', `camp_id=eq.${env.CAMP_ID}&parent_email=like.loadtest-parent-*@example.com`);
    log(`  invites removed: ${inv.ok ? 'ok' : 'HTTP ' + inv.status}`);
    let users = 0;
    await pool(parents, 10, async (p) => { if (p.userId) { const r = await c.adminDeleteUser(p.userId); if (r.ok) users++; } });
    log(`  auth users removed: ${users}/${parents.filter(p => p.userId).length}`);
    const apps = await c.del('camp_applications', `camp_id=eq.${env.CAMP_ID}&payload->>loadTest=eq.true`);
    log(`  applications removed: ${apps.ok ? 'ok' : 'HTTP ' + apps.status}`);
    if (snacksBefore !== undefined) {
        const cur = await c.select('camp_state_kv', `select=value&camp_id=eq.${env.CAMP_ID}&key=eq.campistrySnacks`);
        const now = cur.ok && Array.isArray(cur.data) && cur.data[0] ? cur.data[0].value : null;
        const r = await c.upsertKvMerge(env.CAMP_ID, 'campistrySnacks', unseedCanteenAccounts(now));
        log(`  canteen accounts removed: ${r.ok ? 'ok' : 'HTTP ' + r.status}`);
    }
}

// ── main ──────────────────────────────────────────────────────────────────

export async function main(argv, env, log) {
    log = log || console.log;
    const o = parseArgs(argv);
    const phases = o.phases || ['reg', 'portal', 'canteen'];
    const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CAMP_ID'].filter(k => !env[k]);
    if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
    if (env.I_UNDERSTAND_THIS_IS_A_THROWAWAY_PROJECT !== 'yes') {
        throw new Error('This creates auth users and writes camp state. Set I_UNDERSTAND_THIS_IS_A_THROWAWAY_PROJECT=yes to run it against a disposable project.');
    }
    log(`plan: ${o.parents} parents, concurrency ${o.concurrency}, phases ${phases.join(',')}, portal ${o.duration}s at a ${o.poll}s poll, p95 bar ${o.p95}ms`);
    if (o.dryRun) { log('dry run — nothing created'); return { dryRun: true, plan: o }; }

    const c = mkClient(env);

    // ── preflight: is SUPABASE_URL actually the project API? ────────────────
    // The first real run pointed at the Vercel-hosted website. Every endpoint
    // answered HTTP 200 with an HTML page, so nothing reached the database and
    // the run still printed a throughput figure. Prove both APIs answer JSON
    // before creating a single thing.
    const [rest, auth] = await Promise.all([c.probe('/rest/v1/'), c.probe('/auth/v1/health')]);
    const wrong = [];
    if (!isJsonObject(rest.data)) wrong.push(`  ${env.SUPABASE_URL}/rest/v1/ answered ${describeAuthFailure(rest)}`);
    if (!isJsonObject(auth.data)) wrong.push(`  ${env.SUPABASE_URL}/auth/v1/health answered ${describeAuthFailure(auth)}`);
    if (wrong.length) {
        throw new Error('SUPABASE_URL does not look like a Supabase project API.\n' + wrong.join('\n')
            + '\n  Use the Project URL from Supabase → Project Settings → API'
            + ' (https://<project-ref>.supabase.co) — not your website address.');
    }
    log('preflight: REST and Auth both answered JSON');

    const report = [];
    let parents = [], snacksBefore;
    try {
        if (phases.includes('reg')) { log('phase: registration burst'); await phaseRegistration(c, o, env, report); }
        if (phases.includes('portal')) {
            log(`phase: portal — creating ${o.parents} parents`);
            parents = await setupParents(c, o, env, log);
            log(`  ${parents.length} parents ready`);
            await phasePortal(c, o, env, report, parents, log);
        }
        if (phases.includes('canteen')) { log('phase: canteen rush'); snacksBefore = await phaseCanteen(c, o, env, report, log); }
    } finally {
        if (!o.keep) await teardown(c, env, parents, snacksBefore, log);
        else log('--keep: synthetic parents, applications and canteen accounts left in place');
    }

    log('\nresults');
    for (const [name, s, v] of report) log(fmt(name, s, v));
    const worst = report.reduce((w, [, , v]) => (['FAIL', 'WARN', 'PASS', 'SKIP'].indexOf(v) < ['FAIL', 'WARN', 'PASS', 'SKIP'].indexOf(w) ? v : w), 'SKIP');
    log(`\noverall: ${worst}` + (worst === 'WARN' ? ` (a p95 above ${o.p95}ms — check compute size and the Dashboard's database report)` : '')
        + (worst === 'FAIL' ? ' (unexpected errors — read the error lines above)' : ''));
    return { report, worst };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2), process.env).catch(e => { console.error('load test failed:', e.message); process.exit(1); });
}
