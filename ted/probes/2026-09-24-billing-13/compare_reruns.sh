#!/usr/bin/env bash
# Compare each re-run log with the 12th pass's copy, masking ids/times/ports.
A=/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-12/rerun
B=/home/user/daily-camp-schedular/ted/probes/2026-09-24-billing-13/rerun
norm() { sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g; s/(cref|rfnd|pay|ref|evt|cs|pi|re|ch|RN|X)_?[a-z0-9]{6,}/\1_<id>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?/<ts>/g; s/[0-9]+(\.[0-9]+)?ms/<ms>/g; s/duration_ms:? [0-9.]+/duration_ms <n>/g; s/[0-9]{10,13}/<epoch>/g; s/port [0-9]+/port <p>/g; s/\/tmp\/[^ ]+/<tmp>/g' "$1"; }
same=0; diffn=0; new=0
for f in "$B"/*.log; do
  b=$(basename "$f")
  if [ ! -e "$A/$b" ]; then echo "NEW   $b"; new=$((new+1)); continue; fi
  if diff -q <(norm "$A/$b") <(norm "$f") >/dev/null; then same=$((same+1)); else echo "DIFF  $b"; diffn=$((diffn+1)); fi
done
echo "same $same · differ $diffn · new $new"
