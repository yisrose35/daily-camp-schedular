#!/usr/bin/env bash
# 21st pass: re-run every earlier non-browser billing probe (passes 1-20) at HEAD,
# one at a time → rerun/; then the browser probes that touch this commit's
# changed code (Charge Card / Batch Charge / payer accounts / Finance) → rerun_e2e/.
# Tracked files the probes rewrite in earlier folders are put back afterwards.
R=/home/user/daily-camp-schedular
O=$R/ted/probes/2026-09-24-billing-21
cd "$R"
rm -rf "$O/rerun" "$O/rerun_e2e"; mkdir -p "$O/rerun" "$O/rerun_e2e"
for d in ted/probes/2026-09-24-billing ted/probes/2026-09-24-billing-{3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20}; do
  for f in "$d"/*.js "$d"/*.mts "$d"/rerun_*/*.js; do
    [ -e "$f" ] || continue
    case "$f" in
      *defs.js|*two_fn_harness.js|*realdb_bridge.js|*/rerun/*|*.e2e.js) continue ;;
    esac
    b=$(basename "$d")__$(basename "$f"); b=${b%.*}
    if [[ "$f" == *.test.js ]]; then timeout 300 node --test "$f" > "$O/rerun/$b.log" 2>&1
    elif [[ "$f" == *.mts ]]; then timeout 300 node --experimental-strip-types --no-warnings "$f" > "$O/rerun/$b.log" 2>&1
    else timeout 300 node "$f" > "$O/rerun/$b.log" 2>&1; fi
    echo "$? $f" >> "$O/rerun/_exit_codes.txt"
  done
done
AS=ted/probes/2026-09-24-billing-10/access_sweep.out.json
if [ -e "$AS" ] && ! git diff --quiet -- "$AS" 2>/dev/null; then cp "$AS" "$O/access_sweep21.out.json"; git checkout -- "$AS"; fi
echo done > "$O/rerun/_done"
for f in 2026-09-24-billing-14/ach_charge_twice 2026-09-24-billing-15/ach15 2026-09-24-billing-15/surcharge15 2026-09-24-billing-17/finance_billing17 \
         2026-09-24-billing-17/payer_split17 2026-09-24-billing-18/payer_split18 2026-09-24-billing-19/payer_split19 2026-09-24-billing-19/payer_migrate19; do
  timeout 900 node "ted/probes/$f.e2e.js" > "$O/rerun_e2e/$(basename $f).log" 2>&1; echo "$? $f" >> "$O/rerun_e2e/_exit.txt"
done
git status --short -- ted/probes | grep -v "billing-21" > "$O/rerun_e2e/_rewritten.txt"
echo done > "$O/rerun_e2e/_done"
