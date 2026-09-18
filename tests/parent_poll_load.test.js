// node --test tests/parent_poll_load.test.js
//
// The parent portal is the app's highest-frequency reader by a wide margin —
// two 30-second pollers per open tab, times every family with the portal open.
// Nothing in this file is about a wrong answer. Every RPC involved returned
// correct data. They each did an unbounded amount of work to do it, and the
// work grew with the camp's history, so the app got slower every week it was
// used and worst in the busiest camp.
//
// THE DEFECT WORTH REMEMBERING is a cap that isn't one:
//
//     SELECT coalesce(jsonb_agg(...) ORDER BY created_at DESC), '[]')
//       INTO result FROM link_broadcasts WHERE camp_id = p_camp_id
//      LIMIT 100;
//
// jsonb_agg with no GROUP BY makes the query exactly ONE output row, so
// LIMIT 100 caps one row at one row. It reads like a guard, reviews like a
// guard, and bounds nothing: every broadcast the camp ever sent came back to
// every parent every 30 seconds. Two functions had it.
//
// So the last test here is the point of the file: it re-runs that audit over
// every currently-effective function, so the next one written this way fails
// here instead of quietly shipping a cap that does nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(f => /^\d+[a-z]?_.*\.sql$/.test(f))
    .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b));

const M201 = read('migrations/201_parent_poll_load.sql');
const PARENT = read('campistry_link_parent.html');

// ── the effective definition of each function, last CREATE wins ─────────────
function catalogue() {
    const out = {};
    for (const f of MIGRATIONS) {
        if (/^APPLY/i.test(f)) continue;
        const sql = read('migrations/' + f);
        const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(sql))) {
            const end = sql.indexOf('\n$$;', m.index);
            out[m[1]] = {
                file: f,
                args: m[2],
                body: sql.slice(m.index, end > 0 ? end : m.index + 8000),
            };
        }
    }
    return out;
}
const CAT = catalogue();

/** Strip -- line comments so "must not contain" assertions run against code. */
function codeOnly(sql) {
    return sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

// ── the analyzer: is a LIMIT on the outer SELECT or inside a subquery? ──────
//
// Paren depth alone does NOT answer this, and assuming it did was my first
// mistake here: in the real defect the aggregate sits at depth 1, wrapped in
// `coalesce(jsonb_agg(...), '[]')`, while the LIMIT it fails to bound sits at
// depth 0. A depth test reports "no outer aggregate" and clears the very
// statement the migration exists to fix.
//
// What actually matters is whether an enclosing paren opened a SUBQUERY. So
// each `(` pushes a frame, marked as a subquery when a SELECT/VALUES/WITH
// follows it. A token belongs to the outermost query iff no frame on the stack
// is a subquery — `coalesce(` is a plain call frame, so the aggregate inside it
// is still the outer query's, and `FROM ( SELECT ... LIMIT 100 )` is not.
//
// Strings and comments are skipped so a LIMIT inside a quoted literal or a
// comment is never counted as code.
function scanStatement(stmt) {
    const agg = [];        // aggregate calls belonging to the outermost SELECT
    const limits = [];     // {depth, outer, n} for each LIMIT keyword
    const groupBys = [];   // {depth, outer} for each GROUP BY
    const frames = [];     // one per open paren: true when it opened a subquery
    let i = 0;
    const AGG = /^(jsonb_agg|json_agg|array_agg|string_agg|count|sum|max|min|avg)\s*\(/i;
    const inSub = () => frames.some(Boolean);
    while (i < stmt.length) {
        const c = stmt[i];
        if (c === '-' && stmt[i + 1] === '-') { const nl = stmt.indexOf('\n', i); i = nl < 0 ? stmt.length : nl; continue; }
        if (c === '/' && stmt[i + 1] === '*') { const e = stmt.indexOf('*/', i); i = e < 0 ? stmt.length : e + 2; continue; }
        if (c === "'") { i++; while (i < stmt.length) { if (stmt[i] === "'" && stmt[i + 1] === "'") { i += 2; continue; } if (stmt[i] === "'") { i++; break; } i++; } continue; }
        if (c === '"') { i++; while (i < stmt.length && stmt[i] !== '"') i++; i++; continue; }
        if (c === '(') {
            frames.push(/^\(\s*(?:--[^\n]*\n\s*)*(SELECT|VALUES|WITH)\b/i.test(stmt.slice(i)));
            i++; continue;
        }
        if (c === ')') { frames.pop(); i++; continue; }
        const rest = stmt.slice(i);
        const prevOk = i === 0 || /[\s),]/.test(stmt[i - 1]);
        if (/^\bLIMIT\b/i.test(rest) && prevOk) {
            const n = /^\bLIMIT\s+(\d+)/i.exec(rest);
            limits.push({ depth: frames.length, outer: !inSub(), n: n ? Number(n[1]) : null });
            i += 5; continue;
        }
        if (/^\bGROUP\s+BY\b/i.test(rest) && prevOk) {
            groupBys.push({ depth: frames.length, outer: !inSub() }); i += 5; continue;
        }
        const a = AGG.exec(rest);
        if (a && (i === 0 || /[^\w.]/.test(stmt[i - 1]))) {
            if (!inSub()) agg.push(a[1].toLowerCase());
            i += a[1].length; continue;
        }
        i++;
    }
    return { agg, limits, groupBys };
}

/** Top-level statements of a function body, split on ; outside parens/strings. */
function statementsOf(body) {
    const out = [];
    let depth = 0, start = 0, i = 0;
    while (i < body.length) {
        const c = body[i];
        if (c === '-' && body[i + 1] === '-') { const nl = body.indexOf('\n', i); i = nl < 0 ? body.length : nl; continue; }
        if (c === "'") { i++; while (i < body.length) { if (body[i] === "'" && body[i + 1] === "'") { i += 2; continue; } if (body[i] === "'") { i++; break; } i++; } continue; }
        if (c === '(') { depth++; i++; continue; }
        if (c === ')') { depth--; i++; continue; }
        if (c === ';' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; i++; continue; }
        i++;
    }
    if (start < body.length) out.push(body.slice(start));
    return out;
}

/** Statements whose outermost SELECT is a bare aggregate yet carries a LIMIT. */
function deadLimits(body) {
    const bad = [];
    for (const stmt of statementsOf(body)) {
        if (!/\bSELECT\b/i.test(stmt)) continue;
        const { agg, limits, groupBys } = scanStatement(stmt);
        if (!agg.length) continue;
        if (groupBys.some(g => g.outer)) continue;   // grouped: many rows, LIMIT is real
        const outer = limits.filter(l => l.outer);
        if (outer.length) bad.push({ stmt: stmt.trim().slice(0, 140), limits: outer });
    }
    return bad;
}

// ── the analyzer has to be right, or every test below is theatre ────────────
test('analyzer flags a LIMIT after a bare aggregate', () => {
    const bad = deadLimits(`
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id)), '[]'::jsonb)
          INTO result FROM link_broadcasts b WHERE b.camp_id = p_camp_id LIMIT 100;`);
    assert.strictEqual(bad.length, 1, 'the original shape must be flagged');
    assert.strictEqual(bad[0].limits[0].n, 100);
});

test('analyzer accepts a LIMIT inside the subquery', () => {
    assert.deepStrictEqual(deadLimits(`
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id)), '[]'::jsonb)
          INTO result FROM (
            SELECT b2.id FROM link_broadcasts b2 WHERE b2.camp_id = p_camp_id
             ORDER BY b2.created_at DESC LIMIT 100) b;`), []);
});

test('analyzer accepts a grouped aggregate with a real LIMIT', () => {
    assert.deepStrictEqual(deadLimits(`
        SELECT thread_id, max(created_at) FROM mine GROUP BY thread_id
         ORDER BY max(created_at) DESC LIMIT 200;`), []);
});

test('analyzer accepts a plain non-aggregate LIMIT', () => {
    assert.deepStrictEqual(deadLimits(`
        SELECT * INTO inv FROM link_parent_invites WHERE user_id = caller
         ORDER BY created_at DESC LIMIT 1;`), []);
});

test('analyzer ignores a LIMIT that is only in a comment or a string', () => {
    assert.deepStrictEqual(deadLimits(`
        SELECT jsonb_agg(x) INTO result FROM t; -- LIMIT 100 would do nothing here`), []);
    assert.deepStrictEqual(deadLimits(`
        SELECT jsonb_agg(note) INTO result FROM t WHERE note = 'LIMIT 100';`), []);
});

test('analyzer counts depth through a nested subquery', () => {
    const { limits } = scanStatement(
        `SELECT jsonb_agg(x) FROM (SELECT y FROM (SELECT z LIMIT 5) a LIMIT 10) b LIMIT 20`);
    assert.deepStrictEqual(limits.map(l => l.depth).sort(), [0, 1, 2]);
});

// ── 1. get_camp_broadcasts ─────────────────────────────────────────────────
test('get_camp_broadcasts: the effective definition is migration 201', () => {
    assert.match(CAT.get_camp_broadcasts.file, /^201_/,
        'a later migration has taken over this function — re-check the fix survived');
});

test('get_camp_broadcasts: the cap is no longer dead', () => {
    assert.deepStrictEqual(deadLimits(CAT.get_camp_broadcasts.body), [],
        'LIMIT is back on the outer aggregate, where it bounds nothing');
});

test('get_camp_broadcasts: the newest 100 rows are chosen before aggregating', () => {
    const { limits } = scanStatement(
        statementsOf(CAT.get_camp_broadcasts.body).find(s => /jsonb_agg/i.test(s)));
    const inner = limits.filter(l => !l.outer);
    assert.strictEqual(inner.length, 1, 'expected exactly one LIMIT, inside the subquery');
    assert.strictEqual(inner[0].n, 100);
    assert.match(codeOnly(CAT.get_camp_broadcasts.body),
        /FROM\s+link_broadcasts\s+b2[\s\S]*?ORDER\s+BY\s+b2\.created_at\s+DESC[\s\S]*?LIMIT\s+100/i,
        'the subquery must order newest-first, or the cap keeps the OLDEST 100');
});

test('get_camp_broadcasts: signature, shape and authorization are unchanged', () => {
    assert.match(CAT.get_camp_broadcasts.args, /^\s*p_camp_id\s+uuid\s*$/i,
        'changing the signature would create an overload, not replace the function');
    const body = CAT.get_camp_broadcasts.body;
    assert.match(body, /public\.camp_reader\(p_camp_id\)/,
        'migration 183 gated this on camp_reader; the rewrite must keep it');
    for (const k of ['id', 'subject', 'body', 'created_at']) {
        assert.ok(body.includes(`'${k}'`), `lost the ${k} field the portal reads`);
    }
    assert.match(body, /'success',\s*true,\s*'broadcasts',\s*result/,
        'the envelope the client destructures must not change');
});

test('get_camp_broadcasts: still not executable by anon', () => {
    assert.match(M201, /REVOKE ALL ON FUNCTION public\.get_camp_broadcasts\(uuid\) FROM public, anon;/);
    assert.match(M201,
        /GRANT EXECUTE ON FUNCTION public\.get_camp_broadcasts\(uuid\) TO authenticated, service_role;/,
        'grant must end at service_role — "TO authenticated, anon" would also match a looser pattern');
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.get_camp_broadcasts\(uuid\)[^;]*\banon\b/.test(M201),
        'anon must not be granted back');
});

// ── 2. get_staff_messages — same defect, staff side ────────────────────────
test('get_staff_messages: the effective definition is migration 201', () => {
    assert.match(CAT.get_staff_messages.file, /^201_/);
});

test('get_staff_messages: the cap is no longer dead', () => {
    assert.deepStrictEqual(deadLimits(CAT.get_staff_messages.body), []);
});

test('get_staff_messages: the newest 300 rows are chosen before aggregating', () => {
    const { limits } = scanStatement(
        statementsOf(CAT.get_staff_messages.body).find(s => /jsonb_agg/i.test(s)));
    const inner = limits.filter(l => !l.outer);
    assert.strictEqual(inner.length, 1);
    assert.strictEqual(inner[0].n, 300);
    assert.match(codeOnly(CAT.get_staff_messages.body),
        /ORDER\s+BY\s+m2\.created_at\s+DESC[\s\S]*?LIMIT\s+300/i);
});

test('get_staff_messages: the membership check and every field survive', () => {
    const body = codeOnly(CAT.get_staff_messages.body);
    assert.match(body, /FROM camp_users u WHERE u\.camp_id = p_camp_id AND u\.user_id = caller/);
    assert.match(body, /FROM camps c WHERE c\.id = p_camp_id AND c\.owner = caller/);
    assert.match(body, /'not_a_member'/);
    // The three filters that make this a staff INBOX rather than the camp's
    // whole message table. Losing recipient_user_id would hand one staff member
    // every parent message in the camp.
    assert.match(body, /m2\.recipient_user_id\s*=\s*caller/);
    assert.match(body, /m2\.direction\s*=\s*'in'/);
    assert.match(body, /m2\.camp_id\s*=\s*p_camp_id/);
    for (const k of ['id', 'thread_id', 'subject', 'body', 'parent_name',
                     'parent_email', 'recipient_label', 'read', 'created_at']) {
        assert.ok(body.includes(`'${k}'`), `lost the ${k} field`);
    }
});

// ── 3. get_my_messages — bounded by whole threads ─────────────────────────
test('get_my_messages: the effective definition is migration 201', () => {
    assert.match(CAT.get_my_messages.file, /^201_/);
    assert.match(CAT.get_my_messages.args, /p_camp_id\s+uuid\s+DEFAULT\s+NULL/i);
});

test('get_my_messages: the cap is on threads, not messages', () => {
    const body = codeOnly(CAT.get_my_messages.body);
    assert.match(body, /recent_threads\s+AS\s*\([\s\S]*?GROUP\s+BY\s+thread_id[\s\S]*?ORDER\s+BY\s+max\(created_at\)\s+DESC[\s\S]*?LIMIT\s+200/i,
        'the newest 200 THREADS by last activity');
    assert.match(body, /JOIN\s+recent_threads\s+rt\s+ON\s+rt\.thread_id\s*=\s*mi\.thread_id/i,
        'a kept thread must bring all of its messages, or a reply outlives its original');
    assert.deepStrictEqual(deadLimits(CAT.get_my_messages.body), []);
});

test('get_my_messages: the family scope and dedupe from 038 are intact', () => {
    const body = codeOnly(CAT.get_my_messages.body);
    assert.match(body, /m\.camp_id\s*=\s*inv\.camp_id/);
    assert.match(body, /lower\(m\.parent_email\)\s*=\s*lower\(inv\.parent_email\)/,
        'case-insensitive match is what migration 038 fixed; it must stay');
    assert.match(body, /m\.hidden_for_parent\s*=\s*false/);
    assert.match(body, /DISTINCT\s+ON\s*\(\s*mi\.thread_id,\s*mi\.direction,\s*mi\.created_at\s*\)/i,
        "038's dedupe of a group message's per-recipient copies");
    assert.match(body, /status\s*=\s*'active'/);
    assert.match(body, /expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*now\(\)/i);
});

test('get_my_messages: returns exactly the keys the portal reads', () => {
    // _syncMessagesFromCloud builds its local row straight off these names, so
    // a renamed key is a blank message in the parent's inbox, not an error.
    const keys = ['id', 'thread_id', 'direction', 'subject', 'body', 'read',
                  'archived', 'camper', 'to', 'created_at'];
    const body = CAT.get_my_messages.body;
    const listed = [...body.matchAll(/'(\w+)',\s+(?:id|thread_id|direction|subject|body|read|archived_for_parent|camper_name|recipient_label|created_at)\b/g)]
        .map(m => m[1]);
    assert.deepStrictEqual(listed, keys,
        'the returned key names/order changed — check campistry_link_parent.html');
});

// ── 3b. retry_failed_tip_transfers — the one the audit found ───────────────
test('retry_failed_tip_transfers: the effective definition is migration 201', () => {
    assert.match(CAT.retry_failed_tip_transfers.file, /^201_/);
    assert.match(CAT.retry_failed_tip_transfers.args, /p_limit\s+integer\s+DEFAULT\s+50/i);
});

test('retry_failed_tip_transfers: p_limit actually limits', () => {
    // This one is not a performance nicety. p_limit is the ONLY parameter and
    // it is a batch size: ignored, the nightly runner asks for 50 failed
    // transfers, receives every one from the last 90 days, and tries to push
    // them all through Stripe in one invocation.
    assert.deepStrictEqual(deadLimits(CAT.retry_failed_tip_transfers.body), []);
    const { limits } = scanStatement(
        statementsOf(CAT.retry_failed_tip_transfers.body).find(s => /jsonb_agg/i.test(s)));
    const inner = limits.filter(l => !l.outer);
    assert.strictEqual(inner.length, 1, 'exactly one LIMIT, inside the subquery');
    assert.match(codeOnly(CAT.retry_failed_tip_transfers.body),
        /LIMIT GREATEST\(COALESCE\(p_limit, 50\), 1\)/,
        'the original clamp must be preserved verbatim, just moved inward');
});

test('retry_failed_tip_transfers: the batch walks the backlog oldest-first', () => {
    // Newest-first plus a real cap would retry the same newest 50 every night
    // while the oldest failures never clear — a cap that works and a queue that
    // still does not drain.
    assert.match(codeOnly(CAT.retry_failed_tip_transfers.body),
        /ORDER BY i2\.created_at\s*\n\s*LIMIT/,
        'ascending created_at, so the queue moves forward');
});

test('retry_failed_tip_transfers: filters, shape and grant are unchanged', () => {
    const body = codeOnly(CAT.retry_failed_tip_transfers.body);
    assert.match(body, /i2\.processed_at IS NULL/);
    assert.match(body, /COALESCE\(i2\.transfer_error, ''\) <> ''/);
    assert.match(body, /i2\.staff_account_id IS NOT NULL/);
    assert.match(body, /i2\.created_at > now\(\) - interval '90 days'/);
    for (const k of ['id', 'campId', 'cartId', 'staffName', 'staffAccountId',
                     'tipCents', 'feeCents', 'error']) {
        assert.ok(body.includes(`'${k}'`), `lost the ${k} field the runner reads`);
    }
    assert.match(M201, /REVOKE ALL ON FUNCTION public\.retry_failed_tip_transfers\(integer\)\s*\n?\s*FROM public, anon, authenticated;/);
    assert.match(M201, /GRANT EXECUTE ON FUNCTION public\.retry_failed_tip_transfers\(integer\) TO service_role;/);
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.retry_failed_tip_transfers\(integer\)[^;]*\bauthenticated\b/.test(M201),
        'this reads other people\'s tip failures — service_role only');
});

// ── 4. the indexes have to match the predicates that actually run ──────────
test('the functional index matches get_my_messages and the Realtime policy', () => {
    assert.match(M201,
        /CREATE INDEX IF NOT EXISTS idx_link_messages_camp_parent_lower\s*\n?\s*ON public\.link_messages \(camp_id, lower\(parent_email\)\)/,
        'an index on the raw column cannot serve a lower() predicate — that is the whole defect');
    // Migration 023's link_messages_parent_select is the policy Realtime runs
    // per subscriber per change. If its expression ever stops matching this
    // index, the index silently stops being used there.
    const m023 = read('migrations/023_link_messages_parent_realtime.sql');
    assert.match(m023, /lower\(link_messages\.parent_email\)/,
        'policy no longer compares lower(parent_email) — the index no longer covers it');
});

test('the invite probe every parent policy runs is indexed', () => {
    assert.match(M201,
        /CREATE INDEX IF NOT EXISTS idx_link_parent_invites_user_camp_lower\s*\n?\s*ON public\.link_parent_invites \(user_id, camp_id, lower\(parent_email\)\)/);
});

test('the pickup index is on the RAW column, matching that policy as written', () => {
    assert.match(M201,
        /CREATE INDEX IF NOT EXISTS idx_ppr_camp_parent\s*\n?\s*ON public\.parent_pickup_requests \(camp_id, parent_email\)/);
    // ppr_parent_read compares parent_email with no lower() on either side. An
    // index on lower() would not be used there, so this one is deliberately raw
    // — asserted so nobody "fixes" it into a functional index for consistency.
    const m025 = read('migrations/025_parent_pickup_requests.sql');
    assert.match(m025, /i\.parent_email = parent_pickup_requests\.parent_email/,
        'that policy now uses lower() — idx_ppr_camp_parent must change with it');
});

test('no CONCURRENTLY: the user pastes this into the SQL Editor, inside a transaction', () => {
    assert.ok(!/CREATE\s+INDEX\s+CONCURRENTLY/i.test(codeOnly(M201)),
        'CONCURRENTLY cannot run inside a transaction block and the paste is one');
});

// ── 5. the client half ────────────────────────────────────────────────────
test('every link_messages subscription in the parent portal is filtered', () => {
    const ons = [...PARENT.matchAll(/\.on\('postgres_changes',\s*\{[^}]*table:\s*'link_messages'[^}]*\}/g)]
        .map(m => m[0]);
    assert.ok(ons.length >= 1, 'expected the parent message subscription to still exist');
    for (const on of ons) {
        assert.match(on, /filter:\s*'camp_id=eq\.'\s*\+/,
            'an unfiltered subscription makes Realtime RLS-check every link_messages '
            + 'row in the database against every connected parent');
    }
});

test('the realtime handler debounces instead of re-reading per event', () => {
    assert.match(PARENT, /function _syncMessagesSoon\(\)\s*\{[\s\S]*?clearTimeout\(_msgSyncDebTimer\)[\s\S]*?setTimeout\([\s\S]*?_syncMessagesFromCloud\(\)/,
        '_syncMessagesSoon must coalesce a burst into one read');
    const sub = /function _subscribeParentMsgs\(campIds\)\s*\{[\s\S]*?\n    \}/.exec(PARENT);
    assert.ok(sub, '_subscribeParentMsgs not found');
    assert.match(sub[0], /_syncMessagesSoon\(\)/,
        'the realtime callback must go through the debounce, not straight to a full read');
});

test('the subscription is (re)opened for the primary camp and then for all camps', () => {
    assert.match(PARENT, /_subscribeParentMsgs\(\[d\.camp_id\]\)/,
        'first subscribe, when only the primary camp is known');
    assert.match(PARENT, /_subscribeParentMsgs\(parent\.camps\.map\(function\(cp\)\{ return cp\.camp_id \|\| cp\.campId; \}\)\)/,
        'and again after _augmentOtherCamps resolves parent.camps, or a second '
        + "camp's messages only ever arrive on the 30s poll");
});

test('the pickup poller asks only for the requests it is waiting on', () => {
    const fn = /function pollPickupStatuses\(\)\s*\{[\s\S]*?\n\}/.exec(PARENT);
    assert.ok(fn, 'pollPickupStatuses not found');
    assert.match(fn[0], /\.in\('id',\s*waiting\)/,
        'selecting the whole camp and filtering client-side made the server walk '
        + "every request the camp ever took, per parent, every 30s");
    assert.match(fn[0], /if \(!waiting\.length\) return;/,
        'nothing pending means no query at all');
});

// ── 6. the client helpers, actually run ───────────────────────────────────
// Pull a function's source out of the page and evaluate it in isolation.
//
// Brace-matched, not regex-sliced. A lazy `[\s\S]*?\n\}` stops at the first
// line that merely LOOKS like a closing brace — `}, 400);` inside a setTimeout
// callback — and hands vm a truncated function. That surfaces as a SyntaxError
// here, but the same mistake in an assertion is the silent kind: a pattern that
// matches a fragment and proves nothing about the whole.
function sourceOf(name) {
    const at = PARENT.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} not found in campistry_link_parent.html`);
    let i = PARENT.indexOf('{', at), depth = 0;
    assert.notStrictEqual(i, -1, `${name} has no body`);
    for (; i < PARENT.length; i++) {
        const c = PARENT[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return PARENT.slice(at, i + 1); }
        else if (c === "'" || c === '"') { const q = c; i++; while (i < PARENT.length && PARENT[i] !== q) { if (PARENT[i] === '\\') i++; i++; } }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

/** Evaluate an extracted function in a fresh context. */
function loadFn(name, extra, preamble) {
    const ctx = Object.assign({ setTimeout, clearTimeout, console }, extra || {});
    if (!ctx.window) ctx.window = {};
    vm.createContext(ctx);
    vm.runInContext((preamble || '') + sourceOf(name) + `\n;globalThis.__fn = ${name};`, ctx);
    return { fn: ctx.__fn, ctx };
}

test('sourceOf brace-matches past a nested closing brace', () => {
    // The regression that made this helper necessary: _syncMessagesSoon's body
    // contains `}, 400);` before its own `}`.
    const src = sourceOf('_syncMessagesSoon');
    assert.match(src, /\}, 400\);/, 'expected the inner callback to be included');
    assert.ok(src.trimEnd().endsWith('}'), 'must end at the real closing brace');
    assert.doesNotThrow(() => new vm.Script(src), 'extracted source must parse');
});

test('_syncMessagesSoon collapses a burst of events into one read', async () => {
    let reads = 0;
    const { fn } = loadFn('_syncMessagesSoon', { _syncMessagesFromCloud: () => { reads++; } },
                          'var _msgSyncDebTimer = null;\n');
    for (let i = 0; i < 25; i++) fn();
    assert.strictEqual(reads, 0, 'must not read synchronously on the first event');
    await new Promise(r => setTimeout(r, 600));
    assert.strictEqual(reads, 1, '25 row events must cost one re-read, not 25');
});

test('_syncMessagesSoon still fires again for a later, separate event', async () => {
    let reads = 0;
    const { fn } = loadFn('_syncMessagesSoon', { _syncMessagesFromCloud: () => { reads++; } },
                          'var _msgSyncDebTimer = null;\n');
    fn();
    await new Promise(r => setTimeout(r, 600));
    fn();
    await new Promise(r => setTimeout(r, 600));
    assert.strictEqual(reads, 2, 'debounce must not swallow a genuinely new event');
});

/** A fake supabase channel that records every .on() it is given. */
function fakeDb() {
    const removed = [];
    const chans = [];
    const db = {
        channel(name) {
            const ch = { name, ons: [], subscribed: false };
            ch.on = (evt, opts) => { ch.ons.push(opts); return ch; };
            ch.subscribe = () => { ch.subscribed = true; return ch; };
            chans.push(ch);
            return ch;
        },
        removeChannel(ch) { removed.push(ch); },
    };
    return { db, chans, removed };
}

test('_subscribeParentMsgs opens one filtered .on() per camp', () => {
    const { db, chans } = fakeDb();
    const { fn, ctx } = loadFn('_subscribeParentMsgs', { db });
    fn(['camp-a', 'camp-b']);
    assert.strictEqual(chans.length, 1, 'one channel');
    assert.strictEqual(chans[0].ons.length, 2, 'one .on() per camp');
    assert.deepStrictEqual(chans[0].ons.map(o => o.filter),
        ['camp_id=eq.camp-a', 'camp_id=eq.camp-b']);
    for (const o of chans[0].ons) {
        assert.strictEqual(o.table, 'link_messages');
        assert.strictEqual(o.event, '*');
        assert.strictEqual(o.schema, 'public');
    }
    assert.ok(chans[0].subscribed);
    assert.strictEqual(ctx.window._parentMsgCamps, 'camp-a,camp-b');
});

test('_subscribeParentMsgs dedupes the primary camp coming back a second time', () => {
    const { db, chans } = fakeDb();
    const { fn } = loadFn('_subscribeParentMsgs', { db });
    fn(['camp-a', 'camp-a', 'camp-b', 'camp-a']);
    assert.deepStrictEqual(chans[0].ons.map(o => o.filter),
        ['camp_id=eq.camp-a', 'camp_id=eq.camp-b']);
});

test('_subscribeParentMsgs drops null and empty camp ids', () => {
    const { db, chans } = fakeDb();
    const { fn } = loadFn('_subscribeParentMsgs', { db });
    fn([null, 'camp-a', undefined, '']);
    assert.deepStrictEqual(chans[0].ons.map(o => o.filter), ['camp_id=eq.camp-a']);
});

test('_subscribeParentMsgs with no usable camp opens nothing', () => {
    const { db, chans } = fakeDb();
    const { fn } = loadFn('_subscribeParentMsgs', { db });
    fn([]); fn([null]); fn(undefined);
    assert.strictEqual(chans.length, 0,
        'a channel with no .on() would be a socket that can never deliver anything');
});

test('_subscribeParentMsgs re-subscribing to the same camps is a no-op', () => {
    const { db, chans, removed } = fakeDb();
    const { fn } = loadFn('_subscribeParentMsgs', { db });
    fn(['camp-a']);
    fn(['camp-a']);
    assert.strictEqual(chans.length, 1, 'must not tear down a working socket for nothing');
    assert.strictEqual(removed.length, 0);
});

test('_subscribeParentMsgs widens to a second camp, tearing the old channel down', () => {
    const { db, chans, removed } = fakeDb();
    const { fn } = loadFn('_subscribeParentMsgs', { db });
    fn(['camp-a']);
    fn(['camp-a', 'camp-b']);
    assert.strictEqual(chans.length, 2);
    assert.strictEqual(removed.length, 1, 'the narrower channel must be removed');
    assert.strictEqual(removed[0], chans[0]);
    assert.deepStrictEqual(chans[1].ons.map(o => o.filter),
        ['camp_id=eq.camp-a', 'camp_id=eq.camp-b']);
});

test('_subscribeParentMsgs survives a realtime client that throws', () => {
    const warns = [];
    const db = { channel() { throw new Error('websocket refused'); } };
    const { fn } = loadFn('_subscribeParentMsgs',
        { db, console: { warn: (...a) => warns.push(a) } });
    assert.doesNotThrow(() => fn(['camp-a']),
        'a dead socket must leave the 30s poll working, not break auth');
    assert.strictEqual(warns.length, 1);
});

test('_subscribeParentMsgs does nothing when realtime is unavailable', () => {
    const { fn } = loadFn('_subscribeParentMsgs', { db: {} });
    assert.doesNotThrow(() => fn(['camp-a']));
    const { fn: fn2 } = loadFn('_subscribeParentMsgs', { db: null });
    assert.doesNotThrow(() => fn2(['camp-a']));
});

test('the callback wired into each .on() goes through the debounce', () => {
    const { db, chans } = fakeDb();
    let soon = 0, now = 0;
    const { fn } = loadFn('_subscribeParentMsgs', {
        db,
        _syncMessagesSoon: () => { soon++; },
        _syncMessagesFromCloud: () => { now++; },
    });
    fn(['camp-a']);
    const cb = chans[0].ons[0] && chans[0].onsCb;
    // the handler is the third argument to .on(); capture it explicitly
    assert.ok(chans[0].ons.length === 1);
    // re-run with a channel that keeps handlers
    const kept = [];
    const db2 = {
        channel() {
            const ch = { on: (e, o, h) => { kept.push(h); return ch; }, subscribe: () => ch };
            return ch;
        },
        removeChannel() {},
    };
    const { fn: fn3 } = loadFn('_subscribeParentMsgs', {
        db: db2,
        _syncMessagesSoon: () => { soon++; },
        _syncMessagesFromCloud: () => { now++; },
    });
    fn3(['camp-a']);
    assert.strictEqual(kept.length, 1);
    kept[0]();
    assert.strictEqual(soon, 1, 'must call the debounced path');
    assert.strictEqual(now, 0, 'must not call the immediate full read');
    void cb;
});

test('the .on() callback falls back to a direct read if the debounce is missing', () => {
    const kept = [];
    let now = 0;
    const db = {
        channel() { const ch = { on: (e, o, h) => { kept.push(h); return ch; }, subscribe: () => ch }; return ch; },
        removeChannel() {},
    };
    const { fn } = loadFn('_subscribeParentMsgs',
        { db, _syncMessagesFromCloud: () => { now++; } });
    fn(['camp-a']);
    kept[0]();
    assert.strictEqual(now, 1, 'losing the debounce must not silence live messages');
});

// ── 7. the audit that makes this file worth keeping ───────────────────────
test('no currently-effective function caps a bare aggregate with a trailing LIMIT', () => {
    const offenders = [];
    for (const [name, def] of Object.entries(CAT)) {
        for (const bad of deadLimits(def.body)) {
            offenders.push(`${name} (${def.file}): LIMIT ${bad.limits.map(l => l.n).join(',')}`
                + ` on a bare aggregate\n      ${bad.stmt}`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'jsonb_agg with no GROUP BY yields one row, so a trailing LIMIT bounds '
        + 'nothing. Cap the rows inside a subquery instead:\n  ' + offenders.join('\n  '));
});

test('the audit is looking at a real catalogue, not an empty one', () => {
    // A broken catalogue() would make the audit above pass vacuously — the same
    // way a source assertion passes against code that no longer exists.
    assert.ok(Object.keys(CAT).length > 100,
        `expected hundreds of functions, found ${Object.keys(CAT).length}`);
    assert.ok(CAT.get_my_balance, 'catalogue missed get_my_balance');
    assert.ok(CAT.submit_public_application, 'catalogue missed submit_public_application');
    // ...and it must genuinely have caught the two this migration fixes, which
    // is only provable by checking the PRE-fix source still fails the audit.
    const pre = read('migrations/183_lock_down_camp_scoped_readers.sql');
    const old = /CREATE OR REPLACE FUNCTION public\.get_camp_broadcasts[\s\S]*?\n\$\$;/.exec(pre);
    assert.ok(old, "could not find 183's get_camp_broadcasts");
    assert.strictEqual(deadLimits(old[0]).length, 1,
        'the analyzer no longer detects the original defect, so the audit proves nothing');
});

test('201 is a standalone migration, not added to the apply bundle', () => {
    const manifest = read('scripts/build-migration-bundle.py');
    assert.ok(!manifest.includes('201_parent_poll_load'),
        'migrations 180+ are pasted individually, per the project convention');
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('201_parent_poll_load'));
});
