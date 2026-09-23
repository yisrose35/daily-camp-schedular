#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# run_pgtests.sh — every behaviour test, against the FULL migration chain, each
# on its own copy of the database.
#
#   npm run test:pg                 # all of them
#   scripts/run_pgtests.sh 229 242  # only tests whose file starts with these
#
# WHY THIS EXISTS. try_migration.sh runs a migration's test right after that
# migration, on a chain that stops there. That proves the file was right on the
# day it shipped. It does not prove it is still right: 219 dropped the trigger
# 217's and 218's tests wrote through, 237 decided a hand renumber carries the
# account that 217's test said must stay put, 241 moved the lock 214's test
# looked for. All four went red against today's chain and nothing ran them there.
#
# WHY A COPY PER TEST. Several tests replace a shared function for their own
# purposes — camp_reader, camp_staff_member, and until it was fixed, 230 replaced
# get_user_camp_id with a stub that read a session setting. In ONE shared
# database, every test after 230 ran against that stub, and 239, 240 and 242 —
# which gate on the real resolver — all failed "not_authorized". Nothing was
# wrong with them. A copy per test (CREATE DATABASE … TEMPLATE, a file copy, so
# it costs well under a second) means a test's stubs die with it.
#
# The chain is tests/e2e/db.js's MIGRATIONS — one list, shared with the browser
# harness, so the two cannot drift.
#
# Exit status is 0 only if every selected test passed.
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

PGBIN=""
for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do
    [ -x "$d/initdb" ] && PGBIN="$d"
done
[ -n "$PGBIN" ] || { echo "SKIP — no Postgres server binaries on this machine"; exit 0; }

CHAIN=$(node -e "
const s = require('fs').readFileSync('tests/e2e/db.js', 'utf8');
const m = s.match(/const MIGRATIONS = \[([\s\S]*?)\];/)[1].replace(/\/\/[^\n]*/g, '');
console.log([...m.matchAll(/'([^']+)'/g)].map(x => 'migrations/' + x[1] + '.sql').join(' '));")
[ -n "$CHAIN" ] || { echo "could not read the chain from tests/e2e/db.js" >&2; exit 2; }

# A test whose migration is not in the chain is a test nobody runs. That is how
# four of them went stale; refuse rather than skip.
ORPHANS=""
for t in scripts/pgtests/*.sql; do
    case " $CHAIN " in *"/$(basename "$t") "*) ;; *) ORPHANS="$ORPHANS $(basename "$t")";; esac
done
if [ -n "$ORPHANS" ]; then
    echo "these tests have no migration in tests/e2e/db.js's MIGRATIONS, so nothing runs them:"
    for o in $ORPHANS; do echo "  $o"; done
    echo "add the migration to the chain (it must apply after the ones before it)."
    exit 1
fi

export TRY_MIGRATION_PORT="${TRY_MIGRATION_PORT:-5439}"
LOG=$(mktemp)
# shellcheck disable=SC2086
scripts/try_migration.sh --keep --no-tests $CHAIN >"$LOG" 2>&1
if ! grep -q "^all applied" "$LOG"; then
    echo "the chain did not apply:"; grep -E "FAILED|ERROR|MISSING" "$LOG" | head -20
    rm -f "$LOG"; exit 1
fi
SOCK=$(sed -n 's/^server left running: psql -h \([^ ]*\) .*/\1/p' "$LOG")
DATA="${SOCK%/sock}/data"
BASE="${SOCK%/sock}"
rm -f "$LOG"

RUNAS=""
[ "$(id -u)" = "0" ] && RUNAS="pgtry"
asuser() {
    if [ -n "$RUNAS" ]; then su "$RUNAS" -c "PATH=$PGBIN:\$PATH $1"
    else PATH="$PGBIN:$PATH" sh -c "$1"; fi
}
PSQL="psql -h $SOCK -p $TRY_MIGRATION_PORT -U postgres -X -q"
stop() { asuser "pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1; rm -rf "$BASE"; }
trap stop EXIT

asuser "$PSQL -d postgres -c 'CREATE DATABASE chain_template TEMPLATE postgres'" >/dev/null 2>&1 \
    || { echo "could not snapshot the chain" >&2; exit 1; }

PASS=0; FAIL=0; FAILED=""
for m in $CHAIN; do
    t="scripts/pgtests/$(basename "$m")"
    [ -f "$t" ] || continue
    if [ $# -gt 0 ]; then
        want=0; for p in "$@"; do case "$(basename "$t")" in "$p"*) want=1;; esac; done
        [ "$want" = "1" ] || continue
    fi
    asuser "$PSQL -d postgres -c 'DROP DATABASE IF EXISTS t_run' -c 'CREATE DATABASE t_run TEMPLATE chain_template'" \
        >/dev/null 2>&1
    # From the repo root: some tests \i a migration by its repo path. A test that
    # includes another test uses \ir, which resolves beside the including file.
    out=$(asuser "cd $(pwd) && $PSQL -d t_run -v ON_ERROR_STOP=1 -f $t" 2>&1)
    if [ $? -eq 0 ]; then
        PASS=$((PASS + 1)); echo "  ok     $(basename "$t" .sql)"
    else
        FAIL=$((FAIL + 1)); FAILED="$FAILED $(basename "$t" .sql)"
        echo "  FAIL   $(basename "$t" .sql)"
        echo "$out" | grep -iE "error|DETAIL|CONTEXT" | head -6 | sed 's/^/           /'
    fi
done

echo ""
echo "$PASS passed, $FAIL failed — against $(echo $CHAIN | wc -w) migrations, one database copy per test"
[ "$FAIL" = "0" ] || { echo "failed:$FAILED"; exit 1; }
