#!/usr/bin/env bash
# 16th pass: compare each re-run of a 15th-pass probe with that probe's own
# 15th-pass log, masking ids/times/ports (same masks as the 15th pass).
P15=/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-15
B=/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-16/rerun15
norm() { sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g; s/(cref|rfnd|pay|ref|evt|cs|pi|re|ch|RN|X)_?[a-z0-9]{6,}/\1_<id>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?/<ts>/g; s/[0-9]+(\.[0-9]+)?ms/<ms>/g; s/duration_ms:? [0-9.]+/duration_ms <n>/g; s/[0-9]{10,13}/<epoch>/g; s/port [0-9]+/port <p>/g; s/\/tmp\/[^ ]+/<tmp>/g; s/[0-9]{1,2}:[0-9]{2} (AM|PM)/<clock>/g; s/billing-1[0-9]\//billing-N\//g; s/:[0-9]+:[0-9]+\)/:L:C)/g' "$1"; }
for f in "$B"/*.log; do
  b=$(basename "$f"); ref="$P15/${b%.log}.log"; [ -e "$ref" ] || ref="$P15/${b%.e2e.log}.log"
  [ -e "$ref" ] || { echo "NEW   $b"; continue; }
  if diff -q <(norm "$ref") <(norm "$f") >/dev/null; then echo "SAME  $b"; else echo "DIFF  $b"; diff <(norm "$ref") <(norm "$f") | head -${LINES_PER:-12} | sed 's/^/        /'; fi
done
