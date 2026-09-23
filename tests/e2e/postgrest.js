// =============================================================================
// postgrest.js — compile the app's own Supabase calls into SQL.
//
// The browser shim (shim.js) does not speak SQL; it serializes what the app
// asked for — table, filters, rows, or an RPC name and its named arguments —
// exactly as supabase-js would have put it on the wire, and this turns that into
// one statement against the throwaway Postgres.
//
// TYPES COME FROM THE CATALOG, not from guessing. PostgREST casts a JSON body
// into the column's real type, and an RPC's named arguments into the function's
// declared parameter types; that casting is where a caller's mistake surfaces.
// If this file inferred types from the JavaScript value instead, a page passing
// a string where the function wants numeric would quietly work here and fail in
// production — which is the precise shape of bug the harness exists to catch.
//
// OVERLOAD RESOLUTION is PostgREST's rule, deliberately: pick the function whose
// parameter names cover the keys the caller supplied, preferring the narrowest.
// When two survive, that is real ambiguity — PostgREST answers PGRST203 and so
// does this. Four migrations in this repo (220, 228) exist because of exactly
// that error in production.
// =============================================================================
'use strict';

/** A text literal. standard_conforming_strings is on, so doubling ' is enough. */
function q(s) {
    return "'" + String(s).replace(/'/g, "''") + "'";
}

const JSON_TYPES = new Set(['json', 'jsonb']);
const NUM_TYPES = new Set(['smallint', 'integer', 'bigint', 'numeric', 'real',
    'double precision', 'money']);

/** A value as a literal of `type`, the way PostgREST would cast a JSON body. */
function lit(value, type) {
    if (value === null || value === undefined) return 'NULL';
    const t = String(type || '').replace(/\(.*\)$/, '').trim();

    if (JSON_TYPES.has(t)) return q(JSON.stringify(value)) + '::' + t;
    if (t.endsWith('[]')) return q(JSON.stringify(value)) + '::jsonb';   // caller sends an array

    if (NUM_TYPES.has(t)) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'NULL';
        return '(' + n + ')::' + (t || 'numeric');
    }
    if (t === 'boolean') return (value === true || value === 'true') ? 'true' : 'false';

    if (typeof value === 'object') {
        // An object or array bound for a non-JSON column: PostgREST sends it as
        // JSON text and Postgres decides. Keep that, so the failure is the
        // failure production would see.
        return q(JSON.stringify(value)) + (t ? '::' + t : '');
    }
    return q(value) + (t ? '::' + t : '');
}

/** Cast a value with no known column type — used for filters on unknown columns. */
function guess(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return q(JSON.stringify(value)) + '::jsonb';
    return q(value);
}

// ─── the catalog ────────────────────────────────────────────────────────────

/**
 * Read column types, primary keys and function signatures out of the live
 * database. Done once per boot: a migration cannot change under us mid-run.
 */
function readCatalog(db) {
    const cols = db.json(`
        SELECT c.relname AS table_name, a.attname AS column_name,
               format_type(a.atttypid, a.atttypmod) AS data_type
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
           AND a.attnum > 0 AND NOT a.attisdropped`);

    const columns = {};
    for (const r of cols) {
        (columns[r.table_name] || (columns[r.table_name] = {}))[r.column_name] = r.data_type;
    }

    const pks = db.json(`
        SELECT c.relname AS table_name,
               array_agg(a.attname ORDER BY k.ord)::text[] AS cols
          FROM pg_constraint ct
          JOIN pg_class c ON c.oid = ct.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN unnest(ct.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE ct.contype = 'p' AND n.nspname = 'public'
         GROUP BY c.relname`);

    const primaryKey = {};
    for (const r of pks) {
        primaryKey[r.table_name] = String(r.cols).replace(/^[{]|[}]$/g, '').split(',');
    }

    const fns = db.json(`
        SELECT p.proname AS name, p.proretset AS returns_set,
               format_type(p.prorettype, NULL) AS return_type,
               coalesce(p.proargnames, '{}'::text[])::text[] AS argnames,
               (SELECT array_agg(format_type(t, NULL) ORDER BY o)
                  FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]))
                       WITH ORDINALITY AS u(t, o))::text[] AS argtypes,
               p.pronargdefaults AS ndefaults,
               p.pronargs AS nargs
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'`);

    const functions = {};
    for (const r of fns) {
        const names = arr(r.argnames);
        const types = arr(r.argtypes);
        const params = {};
        names.forEach((nm, i) => { if (nm) params[nm] = types[i]; });
        (functions[r.name] || (functions[r.name] = [])).push({
            name: r.name,
            params,
            paramOrder: names,
            nargs: Number(r.nargs),
            ndefaults: Number(r.ndefaults),
            returnsSet: r.returns_set === true || r.returns_set === 't',
            returnType: r.return_type,
        });
    }

    return { columns, primaryKey, functions };
}

/** Postgres prints a text[] as `{a,b}`; turn it back into an array. */
function arr(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) return [];
    const s = String(v).replace(/^[{]|[}]$/g, '');
    if (!s) return [];
    return s.split(',').map(x => x.replace(/^"|"$/g, ''));
}

// ─── filters ────────────────────────────────────────────────────────────────

function where(filters, types) {
    if (!filters || !filters.length) return '';
    const parts = filters.map(f => one(f, types)).filter(Boolean);
    return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
}

function one(f, types) {
    const col = '"' + String(f.column).replace(/"/g, '') + '"';
    const t = types && types[f.column];
    const v = t ? lit(f.value, t) : guess(f.value);

    switch (f.op) {
        case 'eq':    return col + ' = ' + v;
        case 'neq':   return col + ' <> ' + v;
        case 'gt':    return col + ' > ' + v;
        case 'gte':   return col + ' >= ' + v;
        case 'lt':    return col + ' < ' + v;
        case 'lte':   return col + ' <= ' + v;
        case 'like':  return col + ' LIKE ' + guess(f.value);
        case 'ilike': return col + ' ILIKE ' + guess(f.value);
        case 'in':    return (f.value || []).length
                                ? col + ' IN (' + f.value.map(x => (t ? lit(x, t) : guess(x))).join(', ') + ')'
                                : 'false';
        case 'is':    return col + ' IS ' + (f.value === null ? 'NULL'
                                : f.value === true ? 'TRUE' : f.value === false ? 'FALSE' : 'NULL');
        case 'not':   return 'NOT (' + one({ column: f.column, op: f.inner, value: f.value }, types) + ')';
        default:
            throw new Error('the smoke harness does not implement the "' + f.op + '" filter');
    }
}

// ─── statements ─────────────────────────────────────────────────────────────

/**
 * Compile one request. Returns { sql, kind } — `kind` is 'rows' when the
 * statement yields a json array of rows and 'value' when it yields one json
 * value (an RPC's return).
 */
function compile(req, catalog) {
    if (req.op === 'rpc') return rpc(req, catalog);

    const table = String(req.table || '').replace(/"/g, '');
    const types = catalog.columns[table];
    if (!types) throw new Error('no such table in the smoke harness schema: ' + table);
    const T = '"' + table + '"';

    // Every statement returns whole rows as JSON and the shim projects the
    // caller's column list in JavaScript. Parsing PostgREST's select syntax
    // (embedded resources, renames, casts) would be a second implementation of
    // something with no bearing on what these tests prove.
    const RET = ' RETURNING to_jsonb(' + T + ') AS _row';

    if (req.op === 'select') {
        let s = 'SELECT to_jsonb(' + T + ') AS _row FROM ' + T + where(req.filters, types);
        if (req.order && req.order.length) {
            s += ' ORDER BY ' + req.order.map(o =>
                '"' + String(o.column).replace(/"/g, '') + '"' +
                (o.ascending === false ? ' DESC' : ' ASC') +
                (o.nullsFirst ? ' NULLS FIRST' : '')).join(', ');
        }
        if (req.limit != null) s += ' LIMIT ' + Number(req.limit);
        if (req.offset != null) s += ' OFFSET ' + Number(req.offset);
        return { sql: agg(s), kind: 'rows' };
    }

    if (req.op === 'insert' || req.op === 'upsert') {
        const rows = Array.isArray(req.rows) ? req.rows : [req.rows];
        if (!rows.length) return { sql: "SELECT '[]'::json AS _out", kind: 'rows' };
        const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
        const unknown = keys.filter(k => !(k in types));
        if (unknown.length) {
            throw new Error(table + ' has no column ' + unknown.join(', ') +
                ' — the page is writing a field this schema does not have');
        }
        const values = rows.map(r => '(' + keys.map(k =>
            (k in r) ? lit(r[k], types[k]) : 'DEFAULT').join(', ') + ')');
        let s = 'INSERT INTO ' + T + ' (' + keys.map(k => '"' + k + '"').join(', ') + ')'
            + ' VALUES ' + values.join(', ');
        if (req.op === 'upsert') {
            const conflict = (req.onConflict
                ? String(req.onConflict).split(',').map(c => c.trim())
                : (catalog.primaryKey[table] || []));
            if (!conflict.length) {
                throw new Error('upsert into ' + table + ' with no onConflict and no primary key');
            }
            const sets = keys.filter(k => conflict.indexOf(k) < 0);
            s += ' ON CONFLICT (' + conflict.map(c => '"' + c + '"').join(', ') + ') '
                + (sets.length
                    ? 'DO UPDATE SET ' + sets.map(k => '"' + k + '" = EXCLUDED."' + k + '"').join(', ')
                    : 'DO NOTHING');
        }
        return { sql: agg(s + RET, '_row'), kind: 'rows' };
    }

    if (req.op === 'update') {
        const keys = Object.keys(req.values || {});
        if (!keys.length) throw new Error('update with no values');
        const unknown = keys.filter(k => !(k in types));
        if (unknown.length) throw new Error(table + ' has no column ' + unknown.join(', '));
        const s = 'UPDATE ' + T + ' SET ' + keys.map(k =>
            '"' + k + '" = ' + lit(req.values[k], types[k])).join(', ')
            + where(req.filters, types) + RET;
        return { sql: agg(s, '_row'), kind: 'rows' };
    }

    if (req.op === 'delete') {
        const s = 'DELETE FROM ' + T + where(req.filters, types) + RET;
        return { sql: agg(s, '_row'), kind: 'rows' };
    }

    throw new Error('the smoke harness does not implement the "' + req.op + '" operation');
}

/**
 * Wrap a row-producing statement so psql prints one JSON array.
 *
 * A data-modifying statement cannot sit in a FROM subquery — it has to be a CTE
 * — so INSERT/UPDATE/DELETE take the WITH form and a plain SELECT the subquery
 * form.
 */
function agg(inner, col) {
    const c = col || '_row';
    const pick = "SELECT coalesce(json_agg(_q." + c + "), '[]'::json)::text AS _out FROM _q";
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(inner)) {
        return 'WITH _q AS (' + inner + ') ' + pick;
    }
    return "SELECT coalesce(json_agg(_q." + c + "), '[]'::json)::text AS _out FROM ("
        + inner + ') _q';
}

/**
 * An RPC, resolved the way PostgREST resolves one.
 *
 * A caller's argument names pick the overload. That is not a detail: `DROP
 * FUNCTION` names ONE declared signature, so a narrow form dropped while a
 * defaulted wider one survives leaves the wider one callable with fewer
 * arguments — and two candidates is PGRST203, the error that four migrations in
 * this repo were written to clear.
 */
function rpc(req, catalog) {
    const name = String(req.fn);
    const args = req.args || {};
    const keys = Object.keys(args);
    const all = catalog.functions[name];

    if (!all || !all.length) {
        const e = new Error('Could not find the function public.' + name +
            '(' + keys.join(', ') + ') in the schema cache');
        e.code = 'PGRST202';
        throw e;
    }

    let fit = all.filter(f => keys.every(k => k in f.params));
    if (!fit.length) {
        const e = new Error('Could not find the function public.' + name +
            '(' + keys.join(', ') + ') in the schema cache. Candidates take: ' +
            all.map(f => '(' + f.paramOrder.join(', ') + ')').join(' or '));
        e.code = 'PGRST202';
        throw e;
    }
    // Every parameter the caller did NOT supply must have a default, or the call
    // cannot be made at all.
    fit = fit.filter(f => (f.nargs - keys.length) <= f.ndefaults);
    if (!fit.length) {
        const e = new Error('Could not find the function public.' + name +
            '(' + keys.join(', ') + ') in the schema cache: every candidate has ' +
            'required parameters the caller did not pass');
        e.code = 'PGRST202';
        throw e;
    }
    if (fit.length > 1) {
        const narrow = Math.min(...fit.map(f => f.nargs));
        const tied = fit.filter(f => f.nargs === narrow);
        if (tied.length > 1) {
            const e = new Error('Could not choose the best candidate function between: ' +
                tied.map(f => 'public.' + name + '(' + f.paramOrder.map(
                    p => p + ' => ' + f.params[p]).join(', ') + ')').join(', '));
            e.code = 'PGRST203';
            throw e;
        }
        fit = tied;
    }

    const f = fit[0];
    const call = 'public."' + name + '"(' + keys.map(k =>
        '"' + k.replace(/"/g, '') + '" => ' + lit(args[k], f.params[k])).join(', ') + ')';

    if (f.returnsSet) {
        return {
            sql: "SELECT coalesce(json_agg(to_jsonb(_q)), '[]'::json)::text AS _out FROM "
                + call + ' _q',
            kind: 'rows',
        };
    }
    return { sql: 'SELECT to_json(' + call + ')::text AS _out', kind: 'value' };
}

module.exports = { compile, readCatalog, lit, q, arr };
