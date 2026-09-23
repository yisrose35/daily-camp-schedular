// =============================================================================
// campistry_camper_id_rpc.js — every call that names a camper carries their ID.
//
// Since migration 248 every database function that takes a camper's name also
// takes p_camper_id, and given one, the ID decides who the camper is. This makes
// sure the pages always send it: wrap(client, resolve) replaces client.rpc with
// one that, for any call whose arguments name a camper (p_camper_name, or a
// string p_camper) and carry no numeric p_camper_id, looks the id up and adds it.
//
// Done once, at the client, rather than at each of ~50 call sites: a call site
// written tomorrow is covered without anyone remembering to.
//
//   resolve(campId, name) → the camper's id, or null, or a Promise of either.
//     Staff pages (supabase_client.js): the roster, which is keyed by exactly
//       the name those pages send.
//     The parent portal: get_my_camper_ids (migration 249) — the ids stamped
//       on the parent's own invites.
//
// What it will not do:
//   * guess. No id found → the call goes by name, exactly as before, and the
//     server's own resolution and gates decide.
//   * break a page on a database that has not had 248 yet. If the server
//     answers "no such function" to a call this added an id to, the call is
//     repeated once without it.
//   * keep a non-numeric p_camper_id. The portal once sent its own list index
//     ("child_0") in that slot; an id that is not a number is replaced, or
//     dropped.
// =============================================================================
(function () {
    'use strict';

    function isId(v) { return v != null && /^\d+$/.test(String(v)); }

    /** The camper name a call's arguments carry, or null. */
    function camperNameIn(args) {
        if (!args || typeof args !== 'object') return null;
        var n = args.p_camper_name != null ? args.p_camper_name
              : (typeof args.p_camper === 'string' ? args.p_camper : null);
        n = n == null ? '' : String(n).trim();
        return n ? n : null;
    }

    var MISSING_FN = /PGRST202|could not find the function|function .* does not exist/i;

    function wrap(client, resolve) {
        if (!client || typeof client.rpc !== 'function' || client.__camperIdRpc) return client;
        var raw = client.rpc.bind(client);

        client.rpc = function (fn, args, opts) {
            var name = camperNameIn(args);
            if (!name || isId(args.p_camper_id)) return raw(fn, args, opts);

            var send = function (id) {
                var a = Object.assign({}, args);
                var added = false;
                if (isId(id)) { a.p_camper_id = Number(id); added = true; }
                else if ('p_camper_id' in a) delete a.p_camper_id;       // "child_0" and the like
                if (!added) return raw(fn, a, opts);
                return raw(fn, a, opts).then(function (res) {
                    if (res && res.error && MISSING_FN.test(res.error.message || res.error.code || '')) {
                        var b = Object.assign({}, a); delete b.p_camper_id;
                        return raw(fn, b, opts);
                    }
                    return res;
                });
            };

            var r;
            try { r = resolve(args.p_camp_id || null, name); } catch (_) { r = null; }
            return (r && typeof r.then === 'function')
                ? r.then(send, function () { return send(null); })
                : send(r);
        };
        client.__camperIdRpc = true;
        client.__rawRpc = raw;
        wrapFrom(client, resolve);
        return client;
    }

    // ── Rows written straight to a table, too ────────────────────────────────
    // A page that inserts, upserts or updates a row with camper_name (camper
    // mail, messages, photo tags, outbox…) sends person_id beside it. Only a
    // resolver that answers at once can do this — the query builder is built
    // synchronously — which the staff roster does; the parent portal writes
    // no such rows. An UPDATE that names a camper we cannot find sends
    // person_id: null, so the server resolves the new name afresh (223's
    // stamp) instead of keeping the number of whoever the row was about before.
    function stampRow(row, op, resolveNow) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        var name = typeof row.camper_name === 'string' ? row.camper_name.trim() : '';
        if (!name || isId(row.person_id)) return row;
        var id = null;
        try { id = resolveNow ? resolveNow(row.camp_id || null, name) : null; } catch (_) { id = null; }
        var out = Object.assign({}, row);
        if (isId(id)) out.person_id = Number(id);
        else if (op === 'update') out.person_id = null;
        return out;
    }
    // Every record inside a saved document that names a camper (camperName)
    // and carries no number gets camperId, looked up the same way as every
    // call. Additive only: nothing is removed or renamed, and a name that is
    // not a camper on the roster (a lead, a sample) is left as it is.
    function stampDoc(node, campId, resolveNow, depth) {
        if (!node || typeof node !== 'object' || depth > 12) return;
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) stampDoc(node[i], campId, resolveNow, depth + 1);
            return;
        }
        if (typeof node.camperName === 'string' && node.camperName.trim() && !isId(node.camperId)) {
            var id = null;
            try { id = resolveNow ? resolveNow(campId, node.camperName.trim()) : null; } catch (_) { id = null; }
            if (isId(id)) node.camperId = Number(id);
        }
        for (var k in node) {
            if (Object.prototype.hasOwnProperty.call(node, k) && node[k] && typeof node[k] === 'object') {
                stampDoc(node[k], campId, resolveNow, depth + 1);
            }
        }
    }

    function wrapFrom(client, resolve) {
        if (!client || typeof client.from !== 'function' || client.__camperIdFrom) return;
        var resolveNow = function (campId, name) {
            var r = resolve(campId, name);
            return (r && typeof r.then === 'function') ? null : r;
        };
        var rawFrom = client.from.bind(client);
        client.from = function (table) {
            var qb = rawFrom(table);
            if (!qb || typeof qb !== 'object') return qb;
            ['insert', 'upsert', 'update'].forEach(function (op) {
                if (typeof qb[op] !== 'function') return;
                var rawOp = qb[op].bind(qb);
                qb[op] = function (values) {
                    var rest = Array.prototype.slice.call(arguments, 1);
                    var v = Array.isArray(values)
                        ? values.map(function (r) { return stampRow(r, op, resolveNow); })
                        : stampRow(values, op, resolveNow);
                    // A camp document (health logs, luggage, shop orders,
                    // enrollments…): every record in it that names a camper
                    // gets their number too.
                    if (table === 'camp_state_kv') {
                        (Array.isArray(v) ? v : [v]).forEach(function (r) {
                            if (r && typeof r === 'object' && r.value && typeof r.value === 'object') {
                                stampDoc(r.value, r.camp_id || null, resolveNow, 0);
                            }
                        });
                    }
                    return rawOp.apply(null, [v].concat(rest));
                };
            });
            return qb;
        };
        client.__camperIdFrom = true;
    }

    // ── Edge functions, too ──────────────────────────────────────────────────
    // A page reaches an edge function with fetch('…/functions/v1/<name>') or
    // client.functions.invoke (which is fetch underneath), and a JSON body that
    // names the camper as camperName — or camperNames, a list, or a list of
    // lines each with its own camperName (a cart). The same rule: the body (or
    // the line) gets camperId — camperIds, position for position, for a list —
    // when the resolver knows it. Installed once per page.
    function wrapFetch(resolve) {
        if (typeof window.fetch !== 'function' || window.fetch.__camperIdFetch) return;
        var rawFetch = window.fetch.bind(window);
        var wrapped = function (input, init) {
            try {
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                if (!/\/functions\/v1\//.test(url) || !init || typeof init.body !== 'string') {
                    return rawFetch(input, init);
                }
                var body = JSON.parse(init.body);
                if (!body || typeof body !== 'object' || Array.isArray(body)) return rawFetch(input, init);
                var names = function (o) {
                    return o && typeof o === 'object' && typeof o.camperName === 'string'
                        && o.camperName.trim() && !isId(o.camperId);
                };
                var one = names(body);
                var many = Array.isArray(body.camperNames) && !Array.isArray(body.camperIds);
                // A cart: a list of lines, each naming its own camper (the tip cart).
                var lines = [];
                Object.keys(body).forEach(function (k) {
                    if (Array.isArray(body[k])) body[k].forEach(function (o) { if (names(o)) lines.push(o); });
                });
                if (!one && !many && !lines.length) return rawFetch(input, init);
                var campId = body.campId || body.camp_id || null;
                var ask = function (n, camp) {
                    try { return Promise.resolve(resolve(camp || campId, String(n))); } catch (_) { return Promise.resolve(null); }
                };
                var jobs = [];
                var stamp = function (o) {
                    return ask(o.camperName.trim(), o.campId || o.camp_id).then(function (id) {
                        if (isId(id)) o.camperId = Number(id); else delete o.camperId;
                    });
                };
                if (one) jobs.push(stamp(body));
                lines.forEach(function (o) { jobs.push(stamp(o)); });
                if (many) jobs.push(Promise.all(body.camperNames.map(ask)).then(function (ids) {
                    body.camperIds = ids.map(function (id) { return isId(id) ? Number(id) : null; });
                }));
                return Promise.all(jobs).then(function () {
                    return rawFetch(input, Object.assign({}, init, { body: JSON.stringify(body) }));
                }, function () { return rawFetch(input, init); });
            } catch (_) {
                return rawFetch(input, init);
            }
        };
        wrapped.__camperIdFetch = true;
        window.fetch = wrapped;
    }

    // A camper's name as a person reads it. Two campers may share a name; the
    // roster tells them apart with an internal key ("Malky Stein #102") that
    // must never be shown. Use this wherever a camper's name reaches a screen,
    // a receipt or a message — never where it identifies the camper.
    function displayName(s) { return String(s == null ? '' : s).replace(/\s#\d+(?:-\d+)?$/, ''); }
    window.campistryName = displayName;

    // The number of the camper a page holds by roster key, or null — for a
    // page writing a record that should carry it. Only an answer the page
    // already has (the staff roster); never waits, never guesses.
    function camperIdOf(name, campId) {
        var n = String(name == null ? '' : name).trim();
        if (!n || typeof window.__camperIdResolve !== 'function') return null;
        var r = null;
        try { r = window.__camperIdResolve(campId || null, n); } catch (_) { r = null; }
        return (r && typeof r.then !== 'function' && isId(r)) ? Number(r) : null;
    }
    window.campistryCamperId = camperIdOf;

    window.CampistryCamperIdRpc = { wrap: wrap, wrapFetch: wrapFetch, wrapFrom: wrapFrom, stampRow: stampRow, stampDoc: stampDoc, camperNameIn: camperNameIn, isId: isId };

    // Loaded AFTER the staff client was created (a page that loads
    // supabase_client.js dynamically, or puts this tag later): wrap it now.
    if (window.supabase && typeof window.supabase.rpc === 'function'
        && typeof window.__camperIdResolve === 'function') {
        wrap(window.supabase, window.__camperIdResolve);
    }
    if (typeof window.__camperIdResolve === 'function') wrapFetch(window.__camperIdResolve);
})();
