// =============================================================================
// bridge.js — serve the app, and put the throwaway Postgres behind it.
//
// Two jobs in one HTTP server:
//
//   GET  /<anything>   the repo's own files, so the pages under test are the
//                      real ones, byte for byte.
//   POST /__pg         one serialized Supabase call from the browser shim,
//                      compiled to SQL and executed.
//
// `supabase-js@2.js` is served EMPTY on purpose. supabase_client.js falls back
// to an already-present `window.supabase` when the library did not define
// `createClient`, which is the seam the shim needs — and serving the real
// library instead would have it open a websocket and a token refresh timer to a
// host that is not there.
//
// EVERY CALL IS LOGGED, including the ones the harness cannot answer. A shim
// that silently returned `{data: null}` for an operation it does not implement
// would make a page look like it worked; the log is how the test tells a real
// result from a missing implementation, and `unsupported` is a failure the test
// asserts on rather than a gap it lives with.
// =============================================================================
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { compile, readCatalog } = require('./postgrest');

const REPO = path.join(__dirname, '..', '..');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
    '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

/**
 * @param db     a tests/e2e/db.js handle
 * @param opts   { port }
 */
function start(db, opts) {
    const o = opts || {};
    const port = o.port || 8137;
    const catalog = readCatalog(db);
    const calls = [];      // every request, in order, for the test to inspect
    const pg = db.session();

    /**
     * Who the next statement runs as.
     *
     * SET, not SELECT set_config(...), for one reason that matters: this shares a
     * psql session with the statement, and a SELECT would print a row of its own
     * that the result parser would then have to step over.
     */
    function claims(userId) {
        if (!userId) return 'RESET "request.jwt.claims";';
        return 'SET "request.jwt.claims" = '
            + q(JSON.stringify({ sub: userId, role: 'authenticated' })) + ';';
    }

    function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

    async function handlePg(body) {
        const req = JSON.parse(body);
        const entry = {
            op: req.op, table: req.table, fn: req.fn,
            args: req.args ? Object.keys(req.args) : undefined,
            user: req.userId || null,
        };
        calls.push(entry);

        let plan;
        try {
            plan = compile(req, catalog);
        } catch (e) {
            entry.error = e.message;
            entry.unsupported = !e.code;    // a PGRST code is a real answer, not a gap
            return { error: { message: e.message, code: e.code || 'HARNESS' } };
        }

        // The claims and the statement share one connection — the bridge holds
        // one psql open — so auth.uid() inside the statement is this caller.
        const r = await pg.query(claims(req.userId) + '\n' + plan.sql);
        if (r.err) {
            entry.error = r.err.split('\n')[0];
            return { error: { message: r.err.split('\n').slice(0, 4).join(' ').trim() } };
        }

        // psql prints the set_config row, then ours. Take the last non-empty line.
        const lines = String(r.out).split('\n').map(s => s.trim()).filter(Boolean);
        const raw = lines.length ? lines[lines.length - 1] : '';
        let value = null;
        try { value = raw === '' ? null : JSON.parse(raw); } catch (_) { value = raw; }

        if (plan.kind === 'value') {
            entry.ok = true;
            // An RPC's own answer, kept for the test to read. Most of these
            // functions report a refusal as {success:false, error:'…'} rather than
            // raising, so "no SQL error" and "it did the thing" are different
            // questions and a harness that only records the first cannot tell them
            // apart.
            entry.value = value;
            return { data: value };
        }
        const rows = Array.isArray(value) ? value : (value == null ? [] : [value]);
        entry.rows = rows.length;
        entry.ok = true;
        return { data: rows };
    }

    const server = http.createServer(function (req, res) {
        if (req.method === 'POST' && req.url.split('?')[0] === '/__pg') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', function () {
                handlePg(body).then(
                    p => p,
                    e => ({ error: { message: 'harness failure: ' + e.message } })
                ).then(function (payload) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(payload));
                });
            });
            return;
        }

        const clean = decodeURIComponent(req.url.split('?')[0]);

        // Two files are served EMPTY on purpose.
        //
        // supabase-js: the real library would dial a host that is not there, and
        // an absent createClient is the seam supabase_client.js needs to adopt the
        // shim already on window.
        //
        // config.js: it is gitignored and holds the developer's REAL project url
        // and anon key. It loads after addInitScript and would overwrite the
        // shim's `window.__CAMPISTRY_SUPABASE__` — which broke the register,
        // because campistry_snacks_pos.html derives its session-storage key from
        // the project ref in that url and so looked for a session under the live
        // project's name and found none, leaving the PIN lock up. Keeping a real
        // credential out of a test run is the better reason.
        if (/supabase-js.*\.js$/.test(clean) || clean === '/config.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript' });
            res.end('/* replaced by the smoke harness — see tests/e2e/bridge.js */\n');
            return;
        }

        const file = path.join(REPO, clean === '/' ? '/index.html' : clean);
        if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });

    return new Promise(function (resolve) {
        server.listen(port, function () {
            resolve({
                port,
                calls,
                catalog,
                url: 'http://localhost:' + port,
                /** Calls the harness could not answer at all. */
                unsupported: () => calls.filter(c => c.unsupported),
                /** Calls that reached Postgres and came back with an error. */
                failed: () => calls.filter(c => c.error && !c.unsupported),
                close: () => new Promise(r => { pg.end(); server.close(r); }),
            });
        });
    });
}

module.exports = { start };
