#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# try_migration.sh — apply a migration to a THROWAWAY Postgres and report.
#
# WHY THIS EXISTS. Every migration here is pasted by hand into the Supabase SQL
# Editor, and the Editor runs the file as ONE transaction: any error anywhere
# rolls the whole thing back, so the only symptom the user sees is that the
# LAST thing in the file "does not exist". That sends them looking at the wrong
# file. It happened with 208.
#
# pglast (scripts/check_plpgsql_bodies.py) parses SQL. It cannot tell you that a
# function you call was never created, that a role is missing, or that an insert
# names a column the table does not have. Only a real server can. This gives it
# one.
#
# WHAT IT IS NOT. The stubs below are the SHAPE of the prerequisites, not the
# real schema — they are enough to prove a migration applies, its functions
# compile and its backfill runs. A green result here does NOT prove the
# migration is correct against live data; that is what each migration's own
# verify_* function is for.
#
# USAGE
#   scripts/try_migration.sh migrations/208_payments_into_rows.sql [more.sql ...]
#   scripts/try_migration.sh --keep migrations/208_...   # leave the server up
#
# Files are applied in the order given, each in its own single transaction, the
# same way the SQL Editor would. The first failure stops the run and prints the
# statement that caused it.
#
# Exit status is 0 only if every file applied.
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

PGBIN=""
for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do
    [ -x "$d/initdb" ] && PGBIN="$d"
done
if [ -z "$PGBIN" ]; then
    echo "no Postgres server binaries found (looked in /usr/lib/postgresql/*/bin)" >&2
    echo "this script is a convenience; migrations can still be checked with" >&2
    echo "  python3 scripts/check_plpgsql_bodies.py <file>" >&2
    exit 127
fi

KEEP=0
if [ "${1:-}" = "--keep" ]; then KEEP=1; shift; fi
if [ "$#" -eq 0 ]; then
    echo "usage: $0 [--keep] <migration.sql> [...]" >&2
    exit 2
fi

BASE="${TMPDIR:-/tmp}/try_migration.$$"
DATA="$BASE/data"
SOCK="$BASE/sock"
PORT="${TRY_MIGRATION_PORT:-5433}"
mkdir -p "$DATA" "$SOCK"

# initdb refuses to run as root, so when we are root we borrow an unprivileged
# account. Created once and reused; never removed, because another run may be
# using it.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
    RUNAS="pgtry"
    id "$RUNAS" >/dev/null 2>&1 || useradd -m "$RUNAS" >/dev/null 2>&1
    chown -R "$RUNAS":"$RUNAS" "$BASE"
fi
asuser() {
    if [ -n "$RUNAS" ]; then su "$RUNAS" -c "PATH=$PGBIN:\$PATH $1"
    else PATH="$PGBIN:$PATH" sh -c "$1"; fi
}

cleanup() {
    if [ "$KEEP" = "1" ]; then
        echo ""
        echo "server left running: psql -h $SOCK -p $PORT -U postgres"
        echo "stop it with: $PGBIN/pg_ctl -D $DATA stop"
        return
    fi
    asuser "pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1
    rm -rf "$BASE"
}
trap cleanup EXIT

asuser "initdb -D $DATA -U postgres --auth=trust" >"$BASE/initdb.log" 2>&1 || {
    echo "initdb failed:" >&2; tail -5 "$BASE/initdb.log" >&2; exit 1; }
asuser "pg_ctl -D $DATA -o \"-p $PORT -k $SOCK -c listen_addresses=''\" -l $BASE/pg.log start" \
    >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do
    "$PGBIN/pg_isready" -h "$SOCK" -p "$PORT" -U postgres >/dev/null 2>&1 && break
    sleep 1
done
"$PGBIN/pg_isready" -h "$SOCK" -p "$PORT" -U postgres >/dev/null 2>&1 || {
    echo "server did not start:" >&2; tail -10 "$BASE/pg.log" >&2; exit 1; }

PSQL="$PGBIN/psql -h $SOCK -p $PORT -U postgres -q -v ON_ERROR_STOP=1"

# ── the stubs ───────────────────────────────────────────────────────────────
# Supabase's roles, its auth schema, and the shape of the tables migrations
# reference. Deliberately minimal: shape, not behaviour.
$PSQL <<'STUBS' >"$BASE/stubs.log" 2>&1 || { echo "stubs failed:" >&2; cat "$BASE/stubs.log" >&2; exit 1; }
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE TABLE IF NOT EXISTS public.camps      (id uuid PRIMARY KEY, owner uuid, name text);
CREATE TABLE IF NOT EXISTS public.camp_users (camp_id uuid, user_id uuid, role text);
CREATE TABLE IF NOT EXISTS public.camp_state_kv (
    camp_id uuid NOT NULL, key text NOT NULL, value jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, key));
CREATE TABLE IF NOT EXISTS public.bank_deposits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid, family_key text,
    amount_cents bigint, is_reversal boolean DEFAULT false, deposit_date date,
    status text, kind text, payer_name text, memo_code text, trace_id text);
CREATE TABLE IF NOT EXISTS public.link_parent_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camp_id uuid, user_id uuid,
    token text, parent_name text, parent_email text, camper_names jsonb,
    status text, billing_access boolean DEFAULT false,
    expires_at timestamptz, created_at timestamptz DEFAULT now());

-- Helpers earlier migrations define, stubbed so a later file can be tried on
-- its own. A migration that defines them itself just replaces these.
CREATE OR REPLACE FUNCTION public._num_or_null(p text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS $$
BEGIN RETURN p::numeric; EXCEPTION WHEN OTHERS THEN RETURN NULL; END; $$;

CREATE OR REPLACE FUNCTION public._ts_or_null(p text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS $$
BEGIN RETURN p::timestamptz; EXCEPTION WHEN OTHERS THEN RETURN NULL; END; $$;

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = auth.uid())
$$;
STUBS

echo "postgres $("$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres -tAc 'show server_version') ready, stubs loaded"

FAILED=0
for f in "$@"; do
    if [ ! -f "$f" ]; then echo "  MISSING  $f"; FAILED=1; break; fi
    out="$($PGBIN/psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 \
             --single-transaction -f "$f" 2>&1)"
    if [ $? -ne 0 ]; then
        echo "  FAILED   $f"
        echo "$out" | grep -E "ERROR|DETAIL|HINT|CONTEXT|LINE" | head -12 | sed 's/^/           /'
        FAILED=1
        break
    fi
    echo "  ok       $f"

    # A behaviour test with the same basename, if one exists, is run against the
    # migration that just applied. Applying is the low bar — this is where the
    # trigger, the backfill and the verifier are actually exercised with data.
    bt="scripts/pgtests/$(basename "$f")"
    if [ -f "$bt" ]; then
        bout="$($PGBIN/psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -f "$bt" 2>&1)"
        if [ $? -ne 0 ]; then
            echo "  BEHAVIOUR FAILED   $bt"
            echo "$bout" | grep -E "ERROR|DETAIL|HINT|CONTEXT" | head -12 | sed 's/^/           /'
            FAILED=1
            break
        fi
        echo "$bout" | grep -E "NOTICE:" | sed -E 's/^.*NOTICE:[[:space:]]*/           /'
        echo "  behaviour ok   $bt"
    fi
done

if [ "$FAILED" = "0" ]; then echo "all applied"; else echo "stopped at the first failure"; fi
exit "$FAILED"
