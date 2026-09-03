#!/usr/bin/env bash
# =============================================================================
# Vercel "Ignored Build Step" — decides whether a push deserves a build.
#
# Exit code semantics (Vercel's, not the usual shell convention):
#     exit 0  ->  SKIP the build
#     exit 1  ->  BUILD
#
# Why this exists: this repo is wired to TWO Vercel projects
# (daily-camp-schedular and campistrylink), and each was building both a
# Production and a Preview deployment for nearly every push -- four builds per
# commit. Vercel also does NOT honour "[skip ci]" on its own, so the OTA release
# commits were building too.
#
# Safety rule: this script only ever skips when it is CERTAIN nothing user-facing
# changed. Anything unexpected -- a git failure, a shallow clone, an unknown
# path -- falls through to BUILD. A wasted build is cheap; a missing deploy is
# not, and this site is served straight from the repo with no build step, so
# almost every file is user-facing.
# =============================================================================

set -u

msg="$(git log -1 --pretty=%B 2>/dev/null || echo '')"

# ── 1. Explicit opt-out in the commit message ────────────────────────────────
# Covers the OTA release commits, which never change the web app.
if printf '%s' "$msg" | grep -qiE '\[(skip ci|ci skip|skip vercel|vercel skip)\]'; then
    echo "SKIP: commit message opts out of CI"
    exit 0
fi

# ── 2. Otherwise decide on the files actually touched ────────────────────────
# Compare against the previous commit. If that is not possible (first commit,
# shallow clone, force push) we cannot tell what changed, so we build.
if ! changed="$(git diff --name-only HEAD^ HEAD 2>/dev/null)"; then
    echo "BUILD: cannot diff against HEAD^ (shallow or first commit)"
    exit 1
fi

if [ -z "$changed" ]; then
    echo "BUILD: no diff reported, not risking a skip"
    exit 1
fi

# Paths that cannot affect what a browser is served. Everything else builds --
# this is an allow-list of things to IGNORE, deliberately short.
#   tests/           unit tests, never shipped
#   *.md             docs, plans, audit notes
#   .github/         CI config
#   .claude/         assistant scratch
#   scripts/         build-time helpers, including this file
#   .gitignore/.gitattributes
ignorable='^(tests/|scripts/|\.github/|\.claude/|\.gitignore$|\.gitattributes$)|\.md$'

while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! printf '%s' "$f" | grep -qE "$ignorable"; then
        echo "BUILD: $f affects the deployed site"
        exit 1
    fi
done <<< "$changed"

echo "SKIP: only tests/docs/scripts changed"
exit 0
