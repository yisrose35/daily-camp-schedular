#!/usr/bin/env bash
# =============================================================================
# Vercel "Ignored Build Step" — decides whether a push deserves a build.
#
# Exit code semantics (Vercel's, inverted from the usual shell convention):
#     exit 0  ->  SKIP the build
#     exit 1  ->  BUILD
#
# Why this exists: this repo is wired to TWO Vercel projects
# (daily-camp-schedular and campistrylink). Each was producing a Production AND
# a Preview deployment for nearly every push -- four builds per commit -- and
# Vercel does not honour "[skip ci]" on its own, so the OTA release commits,
# which never touch the web app, were building too. The queue backed up until
# deploys stopped landing altogether.
#
# Safety rule: only ever skip when nothing user-facing can have changed.
# Anything unexpected -- a git failure, a shallow clone, an unknown path --
# falls through to BUILD. This site is served straight from the repo with no
# build step, so almost every file is user-facing: a wasted build is cheap, a
# missing deploy is not.
# =============================================================================

set -u

ref="${VERCEL_GIT_COMMIT_REF:-}"
env="${VERCEL_ENV:-}"

# ── 1. Preview builds only for branches somebody is actually looking at ──────
# The repo carries 46 branches but only two are live. Without this, pushing any
# old experiment builds a preview on BOTH projects. Production is never gated
# here -- whatever a project calls its production branch always builds.
PREVIEW_BRANCHES="New-Features main"
if [ "$env" = "preview" ] && [ -n "$ref" ]; then
    case " $PREVIEW_BRANCHES " in
        *" $ref "*) : ;;   # an active branch, keep checking below
        *) echo "SKIP: preview builds are off for branch '$ref'"; exit 0 ;;
    esac
fi

# Only the SUBJECT line, never the body. Scanning the whole message meant a
# commit that merely EXPLAINS the marker in prose -- like the one that added
# this script -- would skip its own deploy.
subject="$(git log -1 --pretty=%s 2>/dev/null || echo '')"

# ── 2. Explicit opt-out in the commit message ────────────────────────────────
# Covers the OTA release commits, which never change the web app.
if printf '%s' "$subject" | grep -qiE '\[(skip ci|ci skip|skip vercel|vercel skip)\]'; then
    echo "SKIP: commit message opts out of CI"
    exit 0
fi

# ── 3. Otherwise decide on the files actually touched ────────────────────────
# If we cannot tell what changed (first commit, shallow clone, force push), build.
if ! changed="$(git diff --name-only HEAD^ HEAD 2>/dev/null)"; then
    echo "BUILD: cannot diff against HEAD^ (shallow or first commit)"
    exit 1
fi
if [ -z "$changed" ]; then
    echo "BUILD: no diff reported, not risking a skip"
    exit 1
fi

# Paths that cannot affect what a browser is served. Deliberately short --
# this is an allow-list of things to IGNORE, everything else builds.
#   tests/  scripts/  .github/  .claude/  *.md  .gitignore  .gitattributes
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
