// node --test tests/ledger_projection.test.js
//
// Migration 202: get_my_balance stops reading the camp blob.
//
// Stage 1 of moving payments off campistryMe. The blob stays the source of
// truth and NO WRITER CHANGES — a trigger on camp_state_kv projects each
// family's ledger entries and payment bucket into indexed tables on every
// write, whoever made it, in the same transaction. The wrapper then reads two
// few-KB rows per family instead of detoasting the whole camp a second time
// and scanning every payment the camp ever took per family key.
//
// The dangerous ways to have built this, each asserted AGAINST below:
//   * a second home the writers fill — a copy some writer forgets is a copy
//     that drifts (the 035/039 lesson: derived, never stamped);
//   * re-deriving the balance math over new tables — the helpers 171–178
//     shipped are audited money logic, so the projection feeds THEM, in the
//     jsonb shape they already take, and nothing is translated;
//   * an FK from the projection to camps — the trigger would then abort the
//     ORIGINAL blob save for a camp whose camps row is gone, which is how
//     migration 200's first paste failed, except live instead of at paste time.
//
// There is no database here, so this reads the SQL. The one behaviour shift is
// noted where it is tested: a camp with no blob row used to come back without
// a `ledger` key and now comes back with `ledger:false` — both falsy to every
// client read of it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('migrations/202_ledger_projection.sql');

const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(f => /^\d+[a-z]?_.*\.sql$/.test(f))
    .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b));

/** Every CREATE of a function, in apply order: name -> {file, body}. Last wins. */
function catalogue() {
    const out = {};
    for (const f of MIGRATIONS) {
        if (/^APPLY/i.test(f)) continue;
        const sql = read('migrations/' + f);
        const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([^)]*)\)/g;
        let m;
        while ((m = re.exec(sql))) {
            const end = sql.indexOf('\n$$;', m.index);
            out[m[1]] = { file: f, args: m[2], body: sql.slice(m.index, end > 0 ? end : m.index + 12000) };
        }
    }
    return out;
}
const CAT = catalogue();

/** The SQL with comments stripped, for "must not contain" assertions. */
function codeOnly(sql) {
    return sql.replace(/--[^\n]*/g, ' ');
}

// ── the wrapper ────────────────────────────────────────────────────────────

test('the effective get_my_balance is migration 202', () => {
    assert.match(CAT.get_my_balance.file, /^202_/,
        'a later migration replaced the wrapper — re-check the projection survived');
    assert.match(CAT.get_my_balance.args, /p_camp_id\s+uuid\s+DEFAULT\s+NULL/i,
        'the signature every caller and edge function depends on');
});

test('the wrapper no longer reads camp_state_kv at all', () => {
    const body = codeOnly(CAT.get_my_balance.body);
    assert.ok(!/camp_state_kv/.test(body),
        'the second whole-blob detoast is back');
    assert.match(body, /public\.projected_family_ledger\(v_camp, k\)/);
    assert.match(body, /public\.projected_family_payments\(v_camp, k\)/);
});

test("173's rename-guard marker survives, or re-running 173 eats the wrapper", () => {
    // 173 renames get_my_balance to get_my_balance_derived UNLESS prosrc
    // carries this marker — without it, a re-paste of 173 makes the wrapper
    // its own callee and every balance call recurses forever.
    assert.match(CAT.get_my_balance.body, /LEDGER_WRAPPER_V173/);
});

test('the wrapper still calls derived first and trusts its refusals', () => {
    const body = CAT.get_my_balance.body;
    assert.match(body, /v_base := public\.get_my_balance_derived\(p_camp_id\);/);
    assert.match(body, /IF v_base IS NULL OR COALESCE\(\(v_base->>'success'\)::boolean, false\) = false THEN\s*\n\s*RETURN v_base;/);
    // and 202 does not redefine derived — identity and config are stage 2.
    assert.ok(!/get_my_balance_derived\s*\(/.test(
        SQL.replace(/v_base := public\.get_my_balance_derived\(p_camp_id\);/, '')
           .replace(/-- [^\n]*/g, '')),
        'derived must not be touched by this migration');
});

test('the balance math is the shipped math, not a re-derivation', () => {
    // The four helpers stay owned by 171/173/174/178. If 202 redefined any of
    // them, the projection would be feeding NEW money logic — the exact
    // translation-drift risk this design exists to avoid.
    for (const [fn, file] of [['family_has_ledger', /^171_/],
                              ['family_ledger_summary', /^173_/],
                              ['family_has_tuition_entry', /^174_/],
                              ['family_payments_all_posted', /^178_/],
                              ['family_covers_payment', /^178_/]]) {
        assert.match(CAT[fn].file, file, `${fn} must still be defined where it was audited`);
        assert.ok(!SQL.includes(`FUNCTION public.${fn}(`),
            `202 redefines ${fn}`);
    }
    const body = CAT.get_my_balance.body;
    assert.match(body, /public\.family_has_ledger\(v_fam\)/);
    assert.match(body, /public\.family_ledger_summary\(v_fam\)/);
    assert.match(body, /public\.family_has_tuition_entry\(v_fams -> k, enr->>'id'\)/);
    assert.match(body, /public\.family_payments_all_posted\(/);
});

test('both completeness passes and both fallbacks survive verbatim', () => {
    const body = CAT.get_my_balance.body;
    // enrollment pass (174) and payments pass (178)
    assert.match(body, /v_missing := v_missing \|\| jsonb_build_array\(enr->>'id'\);/);
    assert.match(body, /v_unpaid := v_unpaid \|\| jsonb_build_array\(k\);/);
    // not converted → derived, flagged
    assert.match(body, /IF NOT v_allHave THEN\s*\n\s*RETURN v_base \|\| jsonb_build_object\('ledger', false\);/);
    // converted but behind → derived, diagnosable from the portal
    assert.match(body, /'ledgerIncomplete', true,\s*\n\s*'unpostedEnrollments', v_missing,\s*\n\s*'unpostedPaymentFamilies', v_unpaid/);
    // complete → the ledger is the balance, same keys, same rounding
    assert.match(body, /'balance', ROUND\(v_billed - v_paid - v_credits, 2\)/);
    // and completeness only runs on a fully converted family set
    assert.match(body, /IF v_allHave THEN/);
});

test('one projected read per family key, cached for the completeness pass', () => {
    // Re-fetching inside the enrollment × key loop would be a point read per
    // pair; the cache keeps it to one per key, which is also what makes the
    // math read the SAME snapshot everywhere in one call.
    const body = CAT.get_my_balance.body;
    assert.match(body, /v_fams := jsonb_set\(v_fams, ARRAY\[k\], v_fam, true\);/);
    const fetches = [...body.matchAll(/projected_family_ledger\(/g)];
    assert.strictEqual(fetches.length, 1, 'exactly one fetch site, inside the per-key loop');
});

test('the wrapper keeps its exact grants', () => {
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.get_my_balance\(uuid\) FROM public;/);
    assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.get_my_balance\(uuid\) TO authenticated, service_role;/);
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.get_my_balance\(uuid\)[^;]*\banon\b/.test(SQL));
});

// ── the projection tables ──────────────────────────────────────────────────

test('no foreign key to camps — deliberately, and for a live reason', () => {
    // An FK here fails the TRIGGER, and a trigger failure aborts the original
    // blob save. A stale session writing a deleted camp's campistryMe row must
    // not start erroring on a write it has always been allowed to make.
    const tables = SQL.slice(SQL.indexOf('CREATE TABLE IF NOT EXISTS public.family_ledger_projection'),
                             SQL.indexOf('ALTER TABLE'));
    assert.ok(!/REFERENCES/.test(tables), 'an FK on a trigger-written table aborts blob saves');
    assert.match(SQL, /PRIMARY KEY \(camp_id, family_key\)/);
});

test('the projections are deny-all: RLS on, zero policies, anon revoked', () => {
    assert.match(SQL, /ALTER TABLE public\.family_ledger_projection\s+ENABLE ROW LEVEL SECURITY;/);
    assert.match(SQL, /ALTER TABLE public\.family_payments_projection ENABLE ROW LEVEL SECURITY;/);
    assert.ok(!/CREATE POLICY/.test(SQL),
        'a policy would let someone read another family\'s money through the projection');
    assert.match(SQL, /REVOKE ALL ON public\.family_ledger_projection\s+FROM anon;/);
    assert.match(SQL, /REVOKE ALL ON public\.family_payments_projection FROM anon;/);
});

// ── the trigger ────────────────────────────────────────────────────────────

test('the trigger fires on every campistryMe write and only campistryMe', () => {
    assert.match(SQL, /CREATE TRIGGER trg_project_campistry_me\s*\nAFTER INSERT OR UPDATE ON public\.camp_state_kv\s*\nFOR EACH ROW\s*\nWHEN \(NEW\.key = 'campistryMe'\)/,
        'without the WHEN clause every scheduler save of every other key pays for a projection pass');
    assert.match(SQL, /CREATE TRIGGER trg_project_campistry_me_del\s*\nAFTER DELETE ON public\.camp_state_kv\s*\nFOR EACH ROW\s*\nWHEN \(OLD\.key = 'campistryMe'\)/,
        'a deleted blob row must take its projection with it');
    assert.match(SQL, /DROP TRIGGER IF EXISTS trg_project_campistry_me ON public\.camp_state_kv;/,
        're-pasting the file must not error on an existing trigger');
});

test('the trigger is SECURITY DEFINER, because the blob writer has no rights here', () => {
    const body = CAT.project_campistry_me.body;
    assert.match(body, /SECURITY DEFINER/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.project_campistry_me\(\) FROM public, anon, authenticated;/,
        'nothing calls this but the trigger machinery');
});

test('a save that did not touch families or payments costs two comparisons', () => {
    const body = CAT.project_campistry_me.body;
    assert.match(body, /\(NEW\.value -> 'families'\) IS DISTINCT FROM \(OLD\.value -> 'families'\)/);
    assert.match(body, /\(NEW\.value -> 'finance' -> 'payments'\)\s*\n\s*IS DISTINCT FROM \(OLD\.value -> 'finance' -> 'payments'\)/);
    // and INSERT (no OLD) projects unconditionally
    const inserts = [...body.matchAll(/TG_OP = 'INSERT'/g)];
    assert.strictEqual(inserts.length, 2, 'both branches must handle a first save');
});

test('an unchanged family costs an index probe, not a dead tuple', () => {
    const body = CAT.project_campistry_me.body;
    const guards = [...body.matchAll(/DO UPDATE\s*\n\s+SET [^;]*?WHERE public\.family_(ledger|payments)_projection\.\w+ IS DISTINCT FROM EXCLUDED\.\w+/g)];
    assert.strictEqual(guards.length, 2,
        'both upserts need the per-row IS DISTINCT guard, or every save rewrites every family');
});

test('bucket aggregation is ordinality-ordered, or the guards see phantom changes', () => {
    // jsonb equality is order-sensitive for arrays. Without ORDER BY ord,
    // re-aggregating an UNCHANGED payments array could produce differently
    // ordered jsonb, defeat IS DISTINCT FROM, and rewrite every bucket on
    // every save — quietly, since the data would still be correct.
    const sites = [...SQL.matchAll(/jsonb_agg\(e\.value ORDER BY e\.ord\)/g)];
    assert.ok(sites.length >= 3, `trigger, backfill and verifier must all agg the same way, found ${sites.length}`);
    assert.ok(!/jsonb_agg\(e\.value\)(?! ORDER)/.test(SQL));
});

test('a family or bucket removed from the blob leaves the projection', () => {
    const body = CAT.project_campistry_me.body;
    assert.match(body, /DELETE FROM public\.family_ledger_projection p\s*\n\s*WHERE p\.camp_id = NEW\.camp_id\s*\n\s*AND NOT v_fams \? p\.family_key;/,
        'a leftover row would resurrect a deleted family\'s ledger in the balance math');
    assert.match(body, /DELETE FROM public\.family_payments_projection p\s*\n\s*WHERE p\.camp_id = NEW\.camp_id\s*\n\s*AND NOT EXISTS \(/);
    assert.match(body, /IF TG_OP = 'DELETE' THEN\s*\n\s*DELETE FROM public\.family_ledger_projection\s+WHERE camp_id = OLD\.camp_id;\s*\n\s*DELETE FROM public\.family_payments_projection WHERE camp_id = OLD\.camp_id;/);
});

// ── the projected reads ────────────────────────────────────────────────────

test('a missing projection row reads as an empty ledger, which is 171\'s own definition', () => {
    // family_has_ledger is `entries is a non-empty array`, so "no row",
    // "entries: []" and "no entries key" all collapse to the same answer the
    // blob gave — not-converted, fall back to derived.
    assert.match(CAT.projected_family_ledger.body, /jsonb_build_object\('entries', COALESCE\(/);
    assert.match(CAT.projected_family_ledger.body, /'\[\]'::jsonb\)\);/);
    assert.match(CAT.projected_family_payments.body, /'\[\]'::jsonb\);/);
});

test('the projected reads are plain functions gated by the tables\' RLS', () => {
    // Called from inside SECURITY DEFINER get_my_balance they read as owner;
    // called directly by a curious user they hit deny-all RLS and see [].
    // Making THEM definers would hand any authenticated user any family's
    // ledger by key.
    assert.ok(!/projected_family_ledger[\s\S]{0,400}SECURITY DEFINER/.test(SQL),
        'projected_family_ledger must NOT be SECURITY DEFINER');
    assert.ok(!/projected_family_payments\(p_camp_id uuid, p_family_key text\)[\s\S]{0,400}SECURITY DEFINER/.test(SQL),
        'projected_family_payments must NOT be SECURITY DEFINER');
});

// ── the backfill ───────────────────────────────────────────────────────────

test('the backfill is scoped to camps that still exist — 200\'s first-paste lesson', () => {
    const backfills = [...SQL.matchAll(/AND EXISTS \(SELECT 1 FROM camps c WHERE c\.id = kv\.camp_id\)/g)];
    assert.strictEqual(backfills.length, 2, 'both backfills need the scope');
});

test('the backfill converges instead of churning, so it doubles as the repair tool', () => {
    const code = codeOnly(SQL);
    const converge = [...code.matchAll(/ON CONFLICT \(camp_id, family_key\) DO UPDATE\s*\n\s*SET \w+ = EXCLUDED\.\w+, updated_at = now\(\)\s*\n\s*WHERE public\.family_(ledger|payments)_projection\.\w+ IS DISTINCT FROM EXCLUDED\.\w+;/g)];
    assert.strictEqual(converge.length, 2,
        'a re-paste must heal drift without rewriting rows that already match');
});

// ── the verifier ───────────────────────────────────────────────────────────

test('the verifier is gated and reports keys, never money', () => {
    const body = CAT.verify_ledger_projection.body;
    assert.match(body, /AND NOT public\.camp_reader\(p_camp_id\) THEN/,
        'an API caller with no relationship to the camp must still be refused');
    assert.match(body, /'not_authorized'/);
    const ret = body.slice(body.lastIndexOf('RETURN jsonb_build_object'));
    assert.ok(!/entries|payments'?,\s*(r\.|v_me)/.test(ret),
        'the report must stay safe to read over a shoulder — keys and counts only');
    assert.match(ret, /'familiesMismatched', v_fam_bad/);
    assert.match(ret, /'paymentBucketsMismatched', v_pay_bad/);
    assert.match(ret, /'inSync'/);
});

test('the verifier works from the SQL Editor, where its header says to run it', () => {
    // Found live: the first version gated on camp_reader() alone, which answers
    // by auth.uid() — and the SQL Editor carries no JWT, so auth.uid() is NULL
    // there and the gate said not_authorized to the person holding the postgres
    // password. The gate must only apply to API callers, who ALWAYS carry
    // claims (anon included), so "no claims at all" can only be a direct
    // database session.
    const body = CAT.verify_ledger_projection.body;
    assert.match(body, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)/,
        "the missing-setting read must be NULLIF'd — it can come back '' rather than NULL");
    assert.match(body, /IF v_claims IS NOT NULL\s*\n\s*AND COALESCE\(v_claims::jsonb ->> 'role', ''\) <> 'service_role'\s*\n\s*AND NOT public\.camp_reader\(p_camp_id\) THEN/,
        'gate order: only an API request without the service key needs a camp relationship');
    // current_user/session_user are useless here and must not sneak in: inside
    // a SECURITY DEFINER function current_user is the OWNER for every caller,
    // so a role-name check would wave everyone through.
    assert.ok(!/current_user|session_user/.test(codeOnly(body)),
        'role-name checks inside SECURITY DEFINER always see the owner');
});

test('the verifier misses nothing on either side', () => {
    // A blob family with no projection row AND a projection row with no blob
    // family are both drift. An inner join would silently skip exactly the
    // rows most worth reporting.
    // Counted over comment-stripped code — the function's own comment says
    // "FULL JOIN" while explaining why, and prose is not a join.
    const body = codeOnly(CAT.verify_ledger_projection.body);
    const fulls = [...body.matchAll(/FULL JOIN/g)];
    assert.strictEqual(fulls.length, 2, 'both comparisons need a FULL JOIN');
});

// ── the file's own rules ───────────────────────────────────────────────────

test('202 is standalone, not in the apply bundle', () => {
    assert.match(SQL, /Standalone — not in APPLY_BUNDLE\.sql/);
    assert.ok(!read('scripts/build-migration-bundle.py').includes('202_ledger_projection'));
    assert.ok(!read('migrations/APPLY_BUNDLE.sql').includes('202_ledger_projection'));
});

test('no writer is touched: the payment RPCs stay exactly where they were', () => {
    // Stage 1 is readers only. The first sign of scope creep here would be 202
    // redefining a function that moves money.
    for (const fn of ['append_camp_payment', 'record_autopay_charge',
                      'record_autopay_installment', '_record_registration_deposit',
                      'append_family_payment_method', 'sync_family_ledger_payments']) {
        assert.ok(!SQL.includes(`FUNCTION public.${fn}`),
            `202 must not touch ${fn} — writers are stage 2/3`);
        assert.ok(!CAT[fn].file.startsWith('202'), `${fn} effective definition moved`);
    }
});

test('the blob write path is untouched end to end', () => {
    // The trigger reads OLD/NEW; nothing in 202 UPDATEs or INSERTs
    // camp_state_kv. The projection follows the blob — never the reverse.
    const code = codeOnly(SQL);
    assert.ok(!/UPDATE\s+camp_state_kv|INSERT INTO\s+camp_state_kv|DELETE FROM\s+camp_state_kv/i.test(code),
        'the projection must never write the source of truth');
});
