// =============================================================================
// db.js — a throwaway Postgres with the real migrations applied.
//
// WHY THIS EXISTS. Every test in this repo is either static analysis of source
// text or a pgtest that calls one SQL function directly. Between those two sits
// the path nobody tests: the page calls an RPC, the RPC calls another function,
// that one writes a table, a trigger fires. Migration 233 lived in that gap
// from 215 until today — `settle_shop_order` called a `camp_family_save` that
// does not exist, so no Camp Shop order could ever reach a camp bill, and the
// whole suite stayed green the entire time.
//
// This boots the same database scripts/try_migration.sh boots (the same
// scripts/pgstubs.sql, deliberately — two copies would drift), applies the
// ordered migration chain in MIGRATIONS below, and hands back a `sql()` you can
// query with. tests/e2e/bridge.js puts an HTTP face on it so a browser can be
// the caller.
//
// WHAT IT IS NOT. It runs as `postgres`, a superuser, so ROW LEVEL SECURITY IS
// NOT IN FORCE. Anything this harness proves is about the function path, never
// about the policies — a test here that "passes" for an unauthorized caller has
// proved nothing about what RLS would have done. `auth.uid()` is real (it reads
// request.jwt.claims, the way Supabase's own does), so SECURITY DEFINER
// functions that gate on the caller DO behave correctly.
//
// The schema is the stubs plus the chain in MIGRATIONS below, not the whole
// history: migrations 001-121 were applied to the live project by hand and are in
// no bundle, so there is nothing to replay. APPLY_BUNDLE.sql refuses on the stubs
// for exactly that reason (it wants camps.payment_processor_key from 126). The
// chain is what the smoke path needs, in apply order, and each file's own
// prerequisite guard is what proves the order is right.
//
// Anything older than the chain that a PAGE nevertheless calls is stubbed in
// scripts/pgstubs.sql, verbatim where the stub has to refuse (_is_camp_admin,
// camp_staff_member, get_user_camp_id, get_user_role) — a gate that always says
// yes makes every refusal downstream of it untestable.
// =============================================================================
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

/**
 * The migration chain, in apply order.
 *
 * ORDER IS LOAD-BEARING and it is not arbitrary: every file from 212 onwards
 * opens with a DO block that raises if a prerequisite is missing, so a wrong
 * order fails loudly at boot rather than producing a half-schema. 178 is here
 * because 213 demands payment_ledger_entry(); 167 because it is what created
 * settle_shop_order in the first place.
 */
const MIGRATIONS = [
    // Six that are older than the smoke path but that the PAGES need, or they
    // spend the run logging an RPC that is not there. Each was added because the
    // harness reported the page calling it, not on a guess:
    //   048  get_my_access              — access_control.js gates the UI on it
    //   063  set_camp_timezone          — campistry_me.js calls it once at boot
    //   100/101 get_camp_pos_login_status — the Snacks settings pane reads it
    //   104  get_pos_roster             — the register reads its roster through it
    //   142  record_canteen_sale_inventory — the register calls it on every sale
    //   190  _session_taken             — 200 needs it
    //   193  list_workspaces            — the workspace banner reads it on every page
    //   200  get_camp_applications      — campistry_me.js reads it on hydration
    '048_section_access',
    '063_camp_timezone',
    '100_pos_pin_login',
    '101_pos_pin_manual_unlock',
    '104_pos_roster_read',
    '142_canteen_pos_inventory_only_save',
    '167_settle_shop_orders',
    // 171 before 178, and it is not optional: 178 puts record_chargeback on the
    // posted ledger, whose family_ledger_balance() 171 defines. 178 without 171
    // is a chargeback that raises 42883 on the way out — the 233 shape again,
    // found by 215's own pgtest once 178 was in the chain.
    '171_posted_ledger',
    '178_every_payment_posts_to_the_ledger',
    '188_payment_receipts',
    '190_session_capacity',
    '193_session_workspaces',
    '200_applications_out_of_the_blob',
    '202_ledger_projection',
    '203_canteen_archive',
    '205_parent_balance_off_the_blob',
    '206_canteen_archive_only_new',
    '208_payments_into_rows',
    '210_payments_read_from_rows',
    '211_families_into_rows',
    '212_families_read_from_rows',
    '213_payments_row_truth',
    '214_family_writers_row_truth',
    '215_payment_family_writers',
    '216_camp_people_identity',
    '217_canteen_accounts_into_rows',
    '218_canteen_read_from_rows',
    '219_canteen_row_truth',
    '220_canteen_overloads',
    '221_canteen_post_no_pgcrypto',
    '222_deleting_a_camp_deletes_its_data',
    '223_every_camper_reference_gets_an_id',
    '224_ownership_decided_on_ids',
    '225_parent_submissions_run_on_ids',
    '226_face_consent_follows_the_person',
    '227_the_canteen_follows_the_person',
    '228_four_ambiguous_money_rpcs',
    '229_four_canteen_writers_that_always_failed',
    '230_a_parent_shop_order_records_what_it_took',
    '231_the_last_four_canteen_writers_on_the_shared_gate',
    '232_an_invite_cannot_inherit_a_stranger',
    '233_two_money_writers_calling_nothing',
    '234_families_and_shop_orders_on_ids',
    '235_the_last_four_functions_that_only_knew_a_name',
    '236_attributing_the_names_no_rule_can_resolve',
    '237_a_departed_campers_number_is_not_reused',
    '238_the_ledger_moves_with_the_person',
    '239_a_stranger_cannot_settle_another_camps_order',
    '240_the_canteen_desk_writes_to_the_cloud',
    '241_a_family_card_the_charger_can_find',
    '242_offline_register_sales_reach_the_ledger',
];

// The one thing the stubs deliberately get wrong for our purposes: they define
// auth.uid() as a constant NULL, because a migration try only needs the function
// to EXIST. A browser signing in needs it to answer, so install Supabase's real
// definition — it reads the claims the bridge sets per request.
const REAL_AUTH_UID = `
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    -- The inner NULLIF is not decoration. A RESET custom GUC reads back as the
    -- EMPTY STRING, and ''::json raises "input string ended unexpectedly" — so an
    -- unauthenticated caller would get an exception where every gate expects NULL.
    -- Supabase's own definition wraps current_setting the same way.
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;`;

function findPgBin() {
    const globs = ['/usr/lib/postgresql', '/usr/local/pgsql'];
    const found = [];
    for (const g of globs) {
        if (!fs.existsSync(g)) continue;
        for (const d of fs.readdirSync(g)) {
            const bin = path.join(g, d, 'bin');
            if (fs.existsSync(path.join(bin, 'initdb'))) found.push(bin);
            if (fs.existsSync(path.join(g, d, 'initdb'))) found.push(path.join(g, d));
        }
    }
    return found.sort().pop() || null;
}

/**
 * Boot a throwaway server, load the stubs, apply the chain.
 *
 * Returns null when there is no Postgres to boot — the caller SKIPS rather than
 * fails, the same bargain tests/bunk_builder_ui.e2e.js strikes with Chromium.
 */
function boot(opts) {
    const o = opts || {};
    const pgbin = findPgBin();
    if (!pgbin) return null;

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'campistry-e2e-'));
    const data = path.join(base, 'data');
    const sock = path.join(base, 'sock');
    const port = String(o.port || 5441);
    fs.mkdirSync(data);
    fs.mkdirSync(sock);

    // initdb refuses to run as root, so when we are root we borrow the same
    // unprivileged account try_migration.sh borrows. Created once, never
    // removed: another run may be using it.
    let runas = null;
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        runas = 'pgtry';
        if (spawnSync('id', [runas]).status !== 0) spawnSync('useradd', ['-m', runas]);
        spawnSync('chown', ['-R', runas + ':' + runas, base]);
    }

    function asUser(cmd) {
        if (runas) {
            return spawnSync('su', [runas, '-c', 'PATH=' + pgbin + ':$PATH ' + cmd],
                { encoding: 'utf8' });
        }
        return spawnSync('sh', ['-c', 'PATH=' + pgbin + ':$PATH ' + cmd], { encoding: 'utf8' });
    }

    let stopped = false;
    function stop() {
        if (stopped) return;
        stopped = true;
        asUser('pg_ctl -D ' + data + ' -m immediate stop');
        try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    }

    const init = asUser('initdb -D ' + data + ' -U postgres --auth=trust');
    if (init.status !== 0) { stop(); throw new Error('initdb failed: ' + (init.stderr || init.stdout)); }

    asUser('pg_ctl -D ' + data + ' -o "-p ' + port + ' -k ' + sock +
        ' -c listen_addresses=\'\'" -l ' + base + '/pg.log start');

    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
        up = spawnSync(path.join(pgbin, 'pg_isready'),
            ['-h', sock, '-p', port, '-U', 'postgres'], { encoding: 'utf8' }).status === 0;
        if (!up) spawnSync('sleep', ['0.5']);
    }
    if (!up) {
        const log = fs.existsSync(base + '/pg.log') ? fs.readFileSync(base + '/pg.log', 'utf8') : '';
        stop();
        throw new Error('postgres did not start: ' + log.split('\n').slice(-8).join('\n'));
    }

    const psql = path.join(pgbin, 'psql');
    const conn = ['-h', sock, '-p', port, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'];

    function run(args, input) {
        const r = spawnSync(psql, conn.concat(args), { encoding: 'utf8', input: input, maxBuffer: 1 << 28 });
        if (r.status !== 0) {
            const e = new Error((r.stderr || r.stdout || 'psql failed').trim());
            e.psql = true;
            throw e;
        }
        return r.stdout;
    }

    /** One statement (or several, separated by `;`), output as raw text. */
    function sql(text, o2) {
        const args = ['-q', '-t', '-A'];
        if (o2 && o2.singleTransaction) args.push('--single-transaction');
        return run(args.concat(['-c', text]));
    }

    /** One SELECT, its rows as parsed JSON. */
    function json(text) {
        const out = sql("SELECT coalesce(json_agg(_t), '[]'::json)::text FROM (" + text + ') _t');
        return JSON.parse(out.trim() || '[]');
    }

    function file(p, o2) {
        const args = ['-q'];
        if (!o2 || o2.singleTransaction !== false) args.push('--single-transaction');
        return run(args.concat(['-f', p]));
    }

    const applied = [];
    try {
        file(path.join(REPO, 'scripts', 'pgstubs.sql'), { singleTransaction: false });
        sql(REAL_AUTH_UID);
        for (const name of (o.migrations || MIGRATIONS)) {
            const p = path.join(REPO, 'migrations', name + '.sql');
            if (!fs.existsSync(p)) throw new Error('no such migration: ' + name);
            try {
                file(p);
            } catch (e) {
                const lines = String(e.message).split('\n')
                    .filter(l => /ERROR|DETAIL|HINT/.test(l)).slice(0, 4).join('\n  ');
                throw new Error('migration ' + name + ' failed to apply:\n  ' + lines);
            }
            applied.push(name);
        }
    } catch (e) {
        stop();
        throw e;
    }

    // ─── a persistent session ───────────────────────────────────────────────
    //
    // Every psql invocation above is a fresh connection, which costs ~30ms. A
    // page under test makes hundreds of queries just to boot, so the bridge uses
    // this instead: one long-lived psql reading statements off a pipe.
    //
    // ON_ERROR_STOP is deliberately NOT set here. It makes psql EXIT on the
    // first error, which would take the session down with it — and a statement
    // that errors is a result the harness needs to report, not a crash.
    const EOQ = '__CAMPISTRY_EOQ__';

    function session() {
        const p = spawn(psql, ['-h', sock, '-p', port, '-U', 'postgres',
            '-q', '-t', '-A', '-X', '--no-align'], { stdio: ['pipe', 'pipe', 'pipe'] });

        let out = '';
        let err = '';
        const waiting = [];

        p.stdout.setEncoding('utf8');
        p.stderr.setEncoding('utf8');
        p.stderr.on('data', d => { err += d; });
        p.stdout.on('data', function (d) {
            out += d;
            let at;
            while ((at = out.indexOf(EOQ)) >= 0) {
                const body = out.slice(0, at);
                out = out.slice(at + EOQ.length).replace(/^\r?\n/, '');
                const w = waiting.shift();
                // stderr for this statement was written before psql reached the
                // sentinel, so whatever has arrived belongs to it.
                const e = err; err = '';
                if (w) w({ out: body, err: e.trim() });
            }
        });

        let dead = false;
        p.on('exit', function () {
            dead = true;
            while (waiting.length) waiting.shift()({ out: '', err: 'the psql session exited' });
        });

        function query(text) {
            return new Promise(function (resolve) {
                if (dead) { resolve({ out: '', err: 'the psql session exited' }); return; }
                waiting.push(resolve);
                // The terminating semicolon is not cosmetic. A backslash command
                // arriving while psql's query buffer is unterminated runs at once
                // and LEAVES THE BUFFER — so the sentinel came back, the
                // statement never ran, and the next request's text was appended
                // to the half-statement. Every query after the first failed with
                // a syntax error pointing at a line it did not send.
                const body = text.replace(/\s*$/, '');
                p.stdin.write((body.endsWith(';') ? body : body + ';')
                    + '\n\\echo ' + EOQ + '\n');
            });
        }

        function end() { try { p.stdin.end(); } catch (_) {} }

        return { query, end };
    }

    return { sql, json, file, stop, applied, session, socket: sock, port, psql };
}

module.exports = { boot, MIGRATIONS, findPgBin };
