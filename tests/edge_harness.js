// =============================================================================
// edge_harness.js — run a REAL Supabase edge function (supabase/functions/*/
// index.ts) inside Node, against a pretend database and a pretend Stripe /
// processor, and report exactly what it did.
//
// The function's own file is used as-is. Only its three outside imports are
// swapped: Deno's `serve` (so the test can call the handler directly),
// supabase-js's `createClient` (a small in-memory database the scenario fills
// in), `npm:resend` (email) and js-md5 (Node's own md5). Everything else — the checks, the maths, the
// calls it makes — is the function's own code, run with Node's TypeScript type
// stripping.
//
//   const r = runEdge('stripe-refund', `
//       T.env = { STRIPE_SECRET_KEY: 'sk_test' };
//       T.users = { good: 'u-owner' };                 // token -> user id
//       T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
//       T.rpc.camp_families_object = () => ({ fam1: { stripeCustomerId: 'cus_1' } });
//       T.fetch = (url, init) => ({ id: 'pi_1', customer: 'cus_1' });   // any outside HTTP call
//       T.request = { headers: { Authorization: 'Bearer good' }, body: { paymentIntentId: 'pi_1' } };
//   `);
//   r.status, r.body, r.fetches (every outside call: url, body, headers), r.rpcs
//
// The scenario is TypeScript/JS source run before the function loads; `T` is
// the shared state. Several requests: set T.requests = [...] instead; the
// result is then r.responses[].
// =============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const FAKE_SERVE = `
export let handler: any = null;
export function serve(h: any) { handler = h; const T = (globalThis as any).__T; (T.handlers = T.handlers || []).push(h); T.handler = h; }
`;

// A tiny supabase-js: auth.getUser from the bearer token, table reads that
// honour eq / in / not-null filters, writes that are recorded, and rpc calls
// answered by the scenario.
const FAKE_DB = `
const T: any = (globalThis as any).__T;
function rowsOf(table: string) { return (T.tables[table] = T.tables[table] || []); }
function query(table: string, token: string | null) {
  const filters: Array<(r: any) => boolean> = [];
  let op = 'select', payload: any = null, single = false, maybe = false, limit = Infinity;
  const b: any = {
    select() { return b; },
    insert(v: any) { op = 'insert'; payload = v; return b; },
    upsert(v: any) { op = 'upsert'; payload = v; return b; },
    update(v: any) { op = 'update'; payload = v; return b; },
    delete() { op = 'delete'; return b; },
    eq(c: string, v: any) { filters.push(r => r && r[c] === v); return b; },
    neq(c: string, v: any) { filters.push(r => r && r[c] !== v); return b; },
    like(c: string, pat: string) {       // prefix% only — what the functions use
      const p = String(pat), pre = p.endsWith('%') ? p.slice(0, -1) : null;
      filters.push(r => r && (pre != null ? String(r[c] ?? '').startsWith(pre) : String(r[c] ?? '') === p)); return b; },
    in(c: string, vs: any[]) { filters.push(r => r && vs.includes(r[c])); return b; },
    is(c: string, v: any) { filters.push(r => r && (r[c] ?? null) === v); return b; },
    not(c: string, o: string, v: any) { if (o === 'is' && v === null) filters.push(r => r && r[c] != null); return b; },
    gte(c: string, v: any) { filters.push(r => r && r[c] >= v); return b; },
    lte(c: string, v: any) { filters.push(r => r && r[c] <= v); return b; },
    lt(c: string, v: any) { filters.push(r => r && r[c] < v); return b; },
    gt(c: string, v: any) { filters.push(r => r && r[c] > v); return b; },
    order() { return b; }, range() { return b; },
    limit(n: number) { limit = n; return b; },
    single() { single = true; return b; },
    maybeSingle() { maybe = true; return b; },
    then(ok: any, err: any) {
      try {
        T.writes.push({ table, op, payload, token });
        let data: any;
        const match = (r: any) => filters.every(f => f(r));
        if (op === 'select') data = rowsOf(table).filter(match).slice(0, limit);
        else if (op === 'insert' || op === 'upsert') {
          const arr = Array.isArray(payload) ? payload : [payload];
          arr.forEach((r: any) => rowsOf(table).push(r)); data = arr;
        } else if (op === 'update') { data = rowsOf(table).filter(match); data.forEach((r: any) => Object.assign(r, payload)); }
        else { const keep = rowsOf(table).filter((r: any) => !match(r)); data = rowsOf(table).filter(match); T.tables[table] = keep; }
        if (single || maybe) data = data.length ? data[0] : null;
        return Promise.resolve({ data, error: null }).then(ok, err);
      } catch (e) { return Promise.reject(e).then(ok, err); }
    },
  };
  return b;
}
export function createClient(_url: string, _key: string, opts?: any) {
  const auth = opts?.global?.headers?.Authorization || '';
  const token = auth.replace(/^Bearer\\s+/i, '') || null;
  return {
    auth: { getUser: async (jwt?: string) => {
      const t = jwt || token; const id = t ? T.users[t] : null;
      return { data: { user: id ? { id, email: id + '@test' } : null }, error: id ? null : { message: 'bad token' } };
    } },
    from: (t: string) => query(t, token),
    rpc: async (name: string, args: any) => {
      T.rpcs.push({ name, args, token });
      const h = T.rpc[name];
      if (h === undefined) return { data: { success: true }, error: null };
      try { const v = typeof h === 'function' ? await h(args, token) : h; return { data: v, error: null }; }
      catch (e: any) { return { data: null, error: { message: String(e?.message || e) } }; }
    },
    functions: { invoke: async (name: string, o: any) => { T.invokes.push({ name, body: o?.body }); return { data: {}, error: null }; } },
  };
}
`;

const FAKE_RESEND = `
export class Resend { emails = { send: async (m: any) => { const T = (globalThis as any).__T; if (typeof T.emailFails === 'function' && T.emailFails(m)) return { data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } }; T.emails.push(m); return { data: { id: 'em_1' }, error: null }; } }; constructor(_k?: string) {} }
`;

/**
 * Run edge function `name` under `scenario` (source text). Returns
 * { status, body, responses, fetches, rpcs, writes, emails, invokes, logs }.
 */
function runEdge(name, scenario, opts) {
    return runEdges([name], scenario, opts);
}

/**
 * Several real edge functions in ONE process, so they can race each other:
 * T.handlers[k] is function k (in the order given); T.requests go to the LAST
 * one loaded. A scenario starts the others from inside a pretend database or
 * processor call — exactly the moment a second office's request would land.
 */
function runEdges(names, scenario, opts) {
    opts = opts || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-' + names[0] + '-'));
    names.forEach(function (name, k) {
        const src = fs.readFileSync(path.join(ROOT, 'supabase/functions', name, 'index.ts'), 'utf8');
        let fn = src
            .replace(/from\s+["']https:\/\/deno\.land\/std@[^"']+\/http\/server\.ts["']/g, 'from "./fake_serve.mts"')
            .replace(/from\s+["']https:\/\/esm\.sh\/@supabase\/supabase-js@[^"']+["']/g, 'from "./fake_db.mts"')
            .replace(/from\s+["']npm:resend@[^"']+["']/g, 'from "./fake_resend.mts"')
            // md5 from esm.sh (the Sola signature) -> Node's own, same answers.
            .replace(/import md5 from ["']https:\/\/esm\.sh\/js-md5@[^"']+["'];/, 'import { createHash as __ch } from "node:crypto"; const md5 = (x: string) => __ch("md5").update(x).digest("hex");');
        if (typeof opts.transform === 'function') fn = opts.transform(fn, name);
        fs.writeFileSync(path.join(dir, 'fn' + k + '.mts'), fn);
    });
    fs.writeFileSync(path.join(dir, 'fake_serve.mts'), FAKE_SERVE);
    fs.writeFileSync(path.join(dir, 'fake_db.mts'), FAKE_DB);
    fs.writeFileSync(path.join(dir, 'fake_resend.mts'), FAKE_RESEND);
    fs.writeFileSync(path.join(dir, 'run.mts'), `
const T: any = (globalThis as any).__T = { env: {}, users: {}, tables: {}, rpc: {}, rpcs: [], writes: [], emails: [], invokes: [],
  fetches: [], fetch: null, request: null, requests: null, handler: null, logs: [] };
${scenario}
(globalThis as any).Deno = { env: { get: (k: string) => T.env[k] }, serve: (h: any) => { T.handler = h; } };
(globalThis as any).fetch = async (input: any, init: any) => {
  const url = String(input && input.url || input);
  const body = init && init.body != null ? String(init.body) : '';
  const headers: Record<string, string> = {};
  const h = init && init.headers || {};
  if (typeof h.forEach === 'function') h.forEach((v: string, k: string) => { headers[k] = v; });
  else Object.keys(h).forEach(k => { headers[k] = h[k]; });
  T.fetches.push({ url, body, headers, method: (init && init.method) || 'GET' });
  const ans = T.fetch ? await T.fetch(url, { body, headers, method: (init && init.method) || 'GET' }) : {};
  const status = ans && ans.__status || 200;
  const text = typeof ans === 'string' ? ans : JSON.stringify(ans);
  // __headers: response headers a scenario sets (Stripe's Idempotent-Replayed)
  return new Response(text, { status, headers: Object.assign({ 'content-type': 'application/json' }, (ans && ans.__headers) || {}) });
};
const _log = console.log, _err = console.error, _warn = console.warn;
console.log = (...a: any[]) => { T.logs.push(a.join(' ')); };
console.error = console.log; console.warn = console.log;
for (let k = 0; k < ${names.length}; k++) await import('./fn' + k + '.mts');
async function call(r: any) {
  const req = new Request(r.url || 'http://edge.test/fn', {
    method: r.method || 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, r.headers || {}),
    body: r.rawBody != null ? r.rawBody : (r.body === undefined ? undefined : JSON.stringify(r.body)),
  });
  const res = await T.handler(req);
  const text = await res.text();
  let body: any = text; try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
const list = T.requests || [T.request];
const responses: any[] = [];
for (const r of list) responses.push(await call(r));
console.log = _log;
_log('@@' + JSON.stringify({ status: responses[0].status, body: responses[0].body, responses,
  fetches: T.fetches, rpcs: T.rpcs, writes: T.writes, emails: T.emails, invokes: T.invokes, logs: T.logs,
  tables: T.tables }));
`);
    try {
        const stdout = execFileSync(process.execPath,
            ['--experimental-strip-types', '--no-warnings', path.join(dir, 'run.mts')],
            { encoding: 'utf8', timeout: 60000, cwd: dir });
        const line = stdout.split('\n').find(l => l.startsWith('@@'));
        assert.ok(line, 'the edge function printed nothing:\n' + stdout);
        return JSON.parse(line.slice(2));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { runEdge, runEdges };
