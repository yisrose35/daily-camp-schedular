// =============================================================================
// shim.js — the Supabase client the page gets, in the browser.
//
// This is NOT a mock of the app's data. It is a transport: it takes what the
// page asked supabase-js for and posts it, unchanged in meaning, to the bridge,
// which runs it against a real Postgres carrying the real migrations. The rows
// that come back were computed by the same SQL that runs in production.
//
// That distinction is the whole point. A mock answers what the test author
// expected; this answers what the database does. Migration 233's defect — a
// money writer calling a function that does not exist — is invisible to the
// first kind of double and unmissable to the second.
//
// WHAT IS NOT REAL HERE, stated so no test claims otherwise:
//   * AUTH. The session is fabricated from the user the harness seeded. Sign-in
//     is checked against that list, not against Supabase's auth service, so
//     nothing here proves anything about password handling or token refresh.
//     What it DOES carry faithfully is the caller's id: the bridge sets
//     request.jwt.claims per request, so auth.uid() inside a SECURITY DEFINER
//     function is the signed-in user, and a function that gates on the caller
//     gates for real.
//   * REALTIME. `channel()` accepts subscriptions and delivers nothing. A test
//     about realtime propagation cannot be written against this.
//   * EDGE FUNCTIONS. `functions.invoke` refuses. Every caller in the app treats
//     that as a network failure, which is the honest answer — there is no Deno
//     here.
//   * ROW LEVEL SECURITY. The bridge connects as a superuser. See tests/e2e/db.js.
//
// It is loaded as source text and evaluated by addInitScript, so it must be one
// self-contained function with no imports.
// =============================================================================

function installCampistrySmokeShim(cfg) {
    'use strict';

    var ENDPOINT = cfg.endpoint;
    var log = [];

    function post(body) {
        // Synchronous XHR is deliberate: it keeps the shim's own plumbing out of
        // the page's task queue, so a page that awaits a query sees exactly the
        // ordering a real client would, and a test that asserts right after an
        // action is not racing the transport. The harness serves one caller.
        var xhr = new XMLHttpRequest();
        xhr.open('POST', ENDPOINT, false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        try {
            xhr.send(JSON.stringify(body));
        } catch (e) {
            return { error: { message: 'smoke bridge unreachable: ' + (e.message || e) } };
        }
        var res;
        try { res = JSON.parse(xhr.responseText); } catch (e) {
            res = { error: { message: 'smoke bridge returned non-JSON: ' + xhr.responseText } };
        }
        log.push({ sent: body, got: res });
        return res;
    }

    function send(req) {
        req.userId = state.session ? state.session.user.id : null;
        var res = post(req);
        if (res.error) return { data: null, error: res.error, status: 400, count: null };
        return { data: res.data, error: null, status: 200, count: null };
    }

    // ─── state ──────────────────────────────────────────────────────────────
    var state = { session: null };

    function sessionFor(user) {
        return {
            access_token: 'smoke-' + user.id,
            refresh_token: 'smoke-refresh',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: {
                id: user.id, email: user.email, aud: 'authenticated',
                role: 'authenticated', app_metadata: {}, user_metadata: {},
                created_at: new Date(0).toISOString(),
            },
        };
    }

    // ─── where supabase-js keeps the session, because pages read it there ───
    //
    // The register (campistry_snacks_pos.html) decides whether to show its PIN
    // overlay by reading `sb-<projectRef>-auth-token` out of localStorage in a
    // synchronous <head> script, BEFORE any client exists — it derives <ref> from
    // the first hostname label of the configured Supabase URL. So the shim has to
    // advertise a Supabase-shaped URL and persist the session under that key, or
    // the whole selling console stays hidden behind `html.pos-locked` and the test
    // is measuring a lock screen.
    var PROJECT_REF = cfg.projectRef || 'smoke';
    var AUTH_KEY = 'sb-' + PROJECT_REF + '-auth-token';

    function persist() {
        try {
            if (state.session) localStorage.setItem(AUTH_KEY, JSON.stringify(state.session));
            else localStorage.removeItem(AUTH_KEY);
        } catch (_) {}
    }

    // The harness may seed a signed-in user, so a page under test does not have
    // to drive a login form it is not the subject of.
    if (cfg.signedInAs) state.session = sessionFor(cfg.signedInAs);
    persist();

    var authListeners = [];
    function emit(event) {
        authListeners.forEach(function (cb) {
            try { cb(event, state.session); } catch (_) {}
        });
    }

    // ─── the query builder ──────────────────────────────────────────────────
    //
    // Chainable like PostgrestFilterBuilder, thenable at the end — which is what
    // makes `await client.from(t).select().eq(...)` work without a `.execute()`.
    function builder(table) {
        var req = { op: null, table: table, filters: [], order: [] };
        var projection = null;
        var shape = 'many';       // 'many' | 'single' | 'maybeSingle'

        function filter(op) {
            return function (column, value) {
                req.filters.push({ column: column, op: op, value: value });
                return api;
            };
        }

        function run() {
            if (!req.op) req.op = 'select';
            var res = send(req);
            if (res.error) {
                if (shape === 'single' || shape === 'maybeSingle') {
                    return { data: null, error: res.error, status: 400, count: null };
                }
                return res;
            }

            var rows = res.data || [];
            if (projection) rows = rows.map(pick);

            if (shape === 'single') {
                if (rows.length !== 1) {
                    return {
                        data: null, status: 406, count: null,
                        error: {
                            code: 'PGRST116',
                            message: 'JSON object requested, multiple (or no) rows returned',
                            details: 'Results contain ' + rows.length + ' rows',
                        },
                    };
                }
                return { data: rows[0], error: null, status: 200, count: null };
            }
            if (shape === 'maybeSingle') {
                if (rows.length > 1) {
                    return {
                        data: null, status: 406, count: null,
                        error: {
                            code: 'PGRST116',
                            message: 'JSON object requested, multiple (or no) rows returned',
                            details: 'Results contain ' + rows.length + ' rows',
                        },
                    };
                }
                return { data: rows.length ? rows[0] : null, error: null, status: 200, count: null };
            }
            return { data: rows, error: null, status: 200, count: rows.length };
        }

        /**
         * Project the caller's column list. The bridge always returns whole
         * rows; narrowing here rather than in SQL keeps PostgREST's select
         * grammar (embedded resources, renames) out of the harness. A list this
         * cannot parse yields the whole row, which is a superset — it can make a
         * test pass that a narrower read would also pass, never the reverse.
         */
        function pick(row) {
            if (projection.indexOf('(') >= 0 || projection.indexOf('*') >= 0) return row;
            var out = {};
            projection.split(',').forEach(function (c) {
                var name = c.trim();
                if (!name) return;
                var as = name.split(':');
                if (as.length === 2) { out[as[0].trim()] = row[as[1].trim()]; return; }
                out[name] = row[name];
            });
            return out;
        }

        var api = {
            select: function (cols) {
                if (!req.op) req.op = 'select';
                projection = (cols === undefined || cols === null || cols === '*') ? null : String(cols);
                return api;
            },
            insert: function (rows) { req.op = 'insert'; req.rows = rows; return api; },
            upsert: function (rows, opts) {
                req.op = 'upsert'; req.rows = rows;
                if (opts && opts.onConflict) req.onConflict = opts.onConflict;
                if (opts && opts.ignoreDuplicates) req.ignoreDuplicates = true;
                return api;
            },
            update: function (values) { req.op = 'update'; req.values = values; return api; },
            delete: function () { req.op = 'delete'; return api; },

            eq: filter('eq'), neq: filter('neq'),
            gt: filter('gt'), gte: filter('gte'),
            lt: filter('lt'), lte: filter('lte'),
            like: filter('like'), ilike: filter('ilike'),
            in: filter('in'), is: filter('is'),
            contains: filter('contains'),

            not: function (column, op, value) {
                req.filters.push({ column: column, op: 'not', inner: op, value: value });
                return api;
            },
            or: function () {
                // Unimplemented ON PURPOSE rather than silently dropped: an
                // ignored OR widens a result set, which is how a harness makes a
                // scoping bug look like correct behaviour.
                req.filters.push({ column: '(or)', op: 'or', value: null });
                return api;
            },

            order: function (column, opts) {
                req.order.push({
                    column: column,
                    ascending: !opts || opts.ascending !== false,
                    nullsFirst: !!(opts && opts.nullsFirst),
                });
                return api;
            },
            limit: function (n) { req.limit = n; return api; },
            range: function (from, to) { req.offset = from; req.limit = (to - from + 1); return api; },

            single: function () { shape = 'single'; return api; },
            maybeSingle: function () { shape = 'maybeSingle'; return api; },
            csv: function () { return api; },
            abortSignal: function () { return api; },
            throwOnError: function () { return api; },

            then: function (onOk, onErr) {
                var out;
                try { out = run(); } catch (e) {
                    if (onErr) return Promise.resolve(onErr(e));
                    return Promise.reject(e);
                }
                return Promise.resolve(onOk ? onOk(out) : out);
            },
            catch: function (onErr) { return api.then(null, onErr); },
            finally: function (fn) { return api.then(function (r) { fn(); return r; }); },
        };
        return api;
    }

    // ─── auth ───────────────────────────────────────────────────────────────
    var users = cfg.users || [];

    function findUser(email) {
        var e = String(email || '').toLowerCase();
        for (var i = 0; i < users.length; i++) {
            if (String(users[i].email).toLowerCase() === e) return users[i];
        }
        return null;
    }

    var auth = {
        getSession: function () {
            return Promise.resolve({ data: { session: state.session }, error: null });
        },
        getUser: function () {
            return Promise.resolve({
                data: { user: state.session ? state.session.user : null },
                error: state.session ? null : { message: 'Auth session missing!' },
            });
        },
        onAuthStateChange: function (cb) {
            authListeners.push(cb);
            // supabase-js fires INITIAL_SESSION asynchronously on subscribe.
            setTimeout(function () { try { cb('INITIAL_SESSION', state.session); } catch (_) {} }, 0);
            return {
                data: {
                    subscription: {
                        unsubscribe: function () {
                            var i = authListeners.indexOf(cb);
                            if (i >= 0) authListeners.splice(i, 1);
                        },
                    },
                },
            };
        },
        signInWithPassword: function (creds) {
            var u = findUser(creds && creds.email);
            if (!u || u.password !== (creds && creds.password)) {
                return Promise.resolve({
                    data: { user: null, session: null },
                    error: { message: 'Invalid login credentials', status: 400 },
                });
            }
            state.session = sessionFor(u);
            persist();
            emit('SIGNED_IN');
            return Promise.resolve({
                data: { user: state.session.user, session: state.session }, error: null,
            });
        },
        signOut: function () {
            state.session = null;
            persist();
            emit('SIGNED_OUT');
            return Promise.resolve({ error: null });
        },
        refreshSession: function () {
            return Promise.resolve({
                data: { session: state.session, user: state.session ? state.session.user : null },
                error: null,
            });
        },
        setSession: function () {
            return Promise.resolve({ data: { session: state.session }, error: null });
        },
        updateUser: function () {
            return Promise.resolve({
                data: { user: state.session ? state.session.user : null }, error: null,
            });
        },
        signUp: function () {
            return Promise.resolve({
                data: { user: null, session: null },
                error: { message: 'sign-up is not part of the smoke harness' },
            });
        },
        resetPasswordForEmail: function () { return Promise.resolve({ data: {}, error: null }); },
        resend: function () { return Promise.resolve({ data: {}, error: null }); },
        verifyOtp: function () {
            return Promise.resolve({
                data: { user: null, session: null },
                error: { message: 'OTP is not part of the smoke harness' },
            });
        },
        admin: {},
    };

    // ─── realtime, deliberately inert ───────────────────────────────────────
    var channels = [];
    function channel(name) {
        var ch = {
            topic: name,
            on: function () { return ch; },
            subscribe: function (cb) {
                if (typeof cb === 'function') setTimeout(function () { cb('SUBSCRIBED'); }, 0);
                return ch;
            },
            unsubscribe: function () { return Promise.resolve('ok'); },
            send: function () { return Promise.resolve('ok'); },
            track: function () { return Promise.resolve('ok'); },
            untrack: function () { return Promise.resolve('ok'); },
            presenceState: function () { return {}; },
        };
        channels.push(ch);
        return ch;
    }

    var client = {
        from: builder,
        schema: function () { return client; },
        // Lazy, like supabase-js: nothing is sent until the result is asked
        // for (then/catch/finally). Pages wrap the call before that moment —
        // the erase guard checks the camp's version first — and an eager shim
        // would send the call before any such check could run.
        rpc: function (fn, args) {
            var p = null;
            function run() {
                if (!p) {
                    var res;
                    try {
                        res = send({ op: 'rpc', fn: fn, args: args || {} });
                    } catch (e) {
                        res = { data: null, error: { message: String(e.message || e) } };
                    }
                    p = Promise.resolve(res);
                }
                return p;
            }
            return {
                then: function (a, b) { return run().then(a, b); },
                catch: function (b) { return run().catch(b); },
                finally: function (f) { return run().finally(f); },
            };
        },
        auth: auth,
        channel: channel,
        getChannels: function () { return channels.slice(); },
        removeChannel: function () { return Promise.resolve('ok'); },
        removeAllChannels: function () { channels = []; return Promise.resolve('ok'); },
        functions: {
            invoke: function (name) {
                return Promise.resolve({
                    data: null,
                    error: { message: 'edge function "' + name + '" is not available in the smoke harness' },
                });
            },
        },
        storage: {
            from: function () {
                var err = { message: 'storage is not available in the smoke harness' };
                return {
                    upload: function () { return Promise.resolve({ data: null, error: err }); },
                    download: function () { return Promise.resolve({ data: null, error: err }); },
                    remove: function () { return Promise.resolve({ data: null, error: err }); },
                    list: function () { return Promise.resolve({ data: [], error: null }); },
                    getPublicUrl: function () { return { data: { publicUrl: '' } }; },
                    createSignedUrl: function () { return Promise.resolve({ data: null, error: err }); },
                };
            },
        },
        realtime: { isConnected: function () { return false; } },
    };

    // What the test reads back afterwards.
    window.__smoke = {
        log: log,
        client: client,
        signedIn: function () { return state.session && state.session.user; },
    };

    // supabase_client.js takes this branch when the library did not define
    // createClient — see bridge.js on why supabase-js is served empty.
    window.supabase = client;
    // Supabase-SHAPED, so a page that parses the project ref out of it (see
    // AUTH_KEY above) finds one. Queries do not go here — they go to cfg.endpoint.
    window.__CAMPISTRY_SUPABASE__ = {
        url: 'https://' + PROJECT_REF + '.supabase.co',
        anonKey: 'smoke-anon-key',
    };
}
