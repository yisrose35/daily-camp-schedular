#!/usr/bin/env bash
# 13th pass: re-run every earlier billing probe (passes 1-12) at today's HEAD and
# keep each one's output. *.test.js via node --test, other *.js via node.
# Run: bash ted/probes/2026-09-24-billing-13/rerun_all_probes.sh
R=/home/user/daily-camp-schedular
OUT=$R/ted/probes/2026-09-24-billing-13/rerun
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$R"
for d in ted/probes/2026-09-24-billing ted/probes/2026-09-24-billing-{3,4,5,6,7,8,9,10,11,12}; do
  for f in "$d"/*.js "$d"/rerun_*/*.js; do
    [ -e "$f" ] || continue
    case "$f" in
      *defs.js|*two_fn_harness.js|*realdb_bridge.js|*/rerun/*|*.e2e.js) continue ;;   # helpers, not probes
    esac
    b=$(basename "$d")__$(basename "$f" .js)
    if [[ "$f" == *.test.js ]]; then
      timeout 300 node --test "$f" > "$OUT/$b.log" 2>&1
    else
      timeout 300 node "$f" > "$OUT/$b.log" 2>&1
    fi
    echo "$? $f" >> "$OUT/_exit_codes.txt"
  done
done
echo done > "$OUT/_done"
