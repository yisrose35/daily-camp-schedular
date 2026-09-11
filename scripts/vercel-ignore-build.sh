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
PREVIEW_BRANCHES="New-Features main Go"
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

# Computed here (rather than at step 3) so the [skip ci] exception below can
# see it too. If we cannot tell what changed (first commit, shallow clone,
# force push), build.
if ! changed="$(git diff --name-only HEAD^ HEAD 2>/dev/null)"; then
    echo "BUILD: cannot diff against HEAD^ (shallow or first commit)"
    exit 1
fi

# ── 2. Explicit opt-out in the commit message ────────────────────────────────
# Covers the OTA release TRIGGER commit (bumping ota/RELEASE), which never
# changes the web app.
#
# EXCEPT the OTA workflow's own manifest-writeback commit ("OTA: publish
# link 1.0.NN [skip ci]") -- it carries this same marker but must NOT be
# skipped: api/ota.js does `require('../ota/link.json')`, so that file's
# content is baked into the Vercel function at BUILD time. Skipping this
# commit's build means /api/ota keeps serving the OLD version forever, no
# matter how many times a phone checks -- the update-check endpoint itself
# never learns a new version exists. Confirmed live: 1.0.71 was published
# and the manifest committed, but every device stayed on 1.0.69 because
# this exact skip silently ate the rebuild that would have served it.
if printf '%s' "$subject" | grep -qiE '\[(skip ci|ci skip|skip vercel|vercel skip)\]' \
    && ! printf '%s' "$changed" | grep -qE '^ota/(lite|link)\.json$'; then
    echo "SKIP: commit message opts out of CI"
    exit 0
fi

# ── 3. Otherwise decide on the files actually touched ────────────────────────
if [ -z "$changed" ]; then
    echo "BUILD: no diff reported, not risking a skip"
    exit 1
fi

# Paths that cannot affect what a browser is served. Deliberately short --
# this is an allow-list of things to IGNORE, everything else builds.
#   tests/  scripts/  .github/  .claude/  *.md  .gitignore  .gitattributes
ignorable='^(tests/|scripts/|\.github/|\.claude/|\.gitignore$|\.gitattributes$)|\.md$'

# --- Per-project: skip when only the OTHER app's files changed --------------
# Both Vercel projects deploy this one repo from different branches, so they
# cannot be merged -- but neither needs to rebuild for the other's code.
# Set CAMPISTRY_APP in each project's Environment Variables:
#     campistrylink        -> CAMPISTRY_APP=link
#     daily-camp-schedular -> CAMPISTRY_APP=admin
# Unset means "build for everything", so this stays inert until configured.
#
# The lists are deliberately narrow. Anything not listed still builds: the
# parent portal and the admin app share a lot (config.js, campistry-unified.css,
# the supabase client, the face/bio/push helpers) and a missed deploy is far
# worse than a spare build.
case "${CAMPISTRY_APP:-}" in
  link)
    # Admin-only surfaces the parent portal never loads. Checked against the
    # script and link tags in campistry_link_parent.html.
    other='^(campistry_go|campistry_snacks|campistry_shop|campistry_me|dashboard|flow\.html|scheduler_core_|auto_|total_solver_engine|rotation_|master_schedule_builder|print_center|daily_adjustments|schedule_calendar_views|leagues|specialty_leagues|special_activities|division_times_|unified_schedule_system|historical_route|view_historical_routes|campistry_ops\.css|campistry_payroll)'
    ;;
  admin)
    # Parent-portal-only files. campistry_link_branding.js is deliberately NOT
    # here -- the admin app uses it for message and email branding.
    other='^(campistry_link_parent|campistry_link\.css|campistry_link\.webmanifest|campistry_link_data|campistry_link_photos|campistry_link_export|campistry_link_capacitor|mobile/campistry-link/)'
    ;;
  *) other='' ;;
esac
if [ -n "$other" ]; then
    ignorable="$ignorable|$other"
fi

while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! printf '%s' "$f" | grep -qE "$ignorable"; then
        echo "BUILD: $f affects the deployed site"
        exit 1
    fi
done <<< "$changed"

echo "SKIP: only tests/docs/scripts changed"
exit 0
