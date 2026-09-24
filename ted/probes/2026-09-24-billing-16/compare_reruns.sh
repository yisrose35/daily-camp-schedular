#!/usr/bin/env bash
# 16th pass: compare each re-run log with the 15th pass's copy (passes 1-14),
# or with the probe's own 15th-pass log (pass 15), masking ids/times/ports.
A=/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-15/rerun
P15=/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-15
B=/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-16/rerun
norm() { sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g; s/(cref|rfnd|pay|ref|evt|cs|pi|re|ch|RN|X)_?[a-z0-9]{6,}/\1_<id>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?/<ts>/g; s/[0-9]+(\.[0-9]+)?ms/<ms>/g; s/duration_ms:? [0-9.]+/duration_ms <n>/g; s/[0-9]{10,13}/<epoch>/g; s/port [0-9]+/port <p>/g; s/\/tmp\/[^ ]+/<tmp>/g; s/[0-9]{1,2}:[0-9]{2} (AM|PM)/<clock>/g; s/billing-1[0-9]\//billing-N\//g; s/:[0-9]+:[0-9]+\)/:L:C)/g' "$1"; }
same=0; diffn=0; new=0
for f in "$B"/*.log; do
  b=$(basename "$f"); ref="$A/$b"
  if [[ "$b" == 2026-09-24-billing-15__* ]]; then n=${b#2026-09-24-billing-15__}; ref="$P15/$n"; fi
  if [ ! -e "$ref" ]; then echo "NEW   $b"; new=$((new+1)); continue; fi
  if diff -q <(norm "$ref") <(norm "$f") >/dev/null; then same=$((same+1)); else echo "DIFF  $b"; diffn=$((diffn+1)); fi
done
echo "same $same · differ $diffn · new $new"
