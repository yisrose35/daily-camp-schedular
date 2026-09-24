#!/usr/bin/env bash
# 18th pass: re-run every earlier billing probe at HEAD, one at a time.
#  1. non-browser probes of passes 1-16 (same rules as the 16th pass's
#     rerun_all_probes.sh, plus the 16th-pass folder) → rerun/
#  2. the 16th pass's own browser probes (cash_discount16; link_paused16 and
#     pos_double16 were re-run by hand into rerun16/) → rerun16/
#  3. the 15th pass's browser probes → rerun15/
#  4. the 14th pass's browser probes → rerun_e2e/
# The 10th-pass access sweep rewrites its own output file; it is put back
# afterwards and this pass's copy kept as access_sweep18.out.json.
R=/home/user/daily-camp-schedular
O=$R/ted/probes/2026-09-24-billing-18
cd "$R"
rm -rf "$O/rerun"; mkdir -p "$O/rerun" "$O/rerun16" "$O/rerun15" "$O/rerun_e2e"
for d in ted/probes/2026-09-24-billing ted/probes/2026-09-24-billing-{3,4,5,6,7,8,9,10,11,12,13,14,15,16,17}; do
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
if [ -e "$AS" ] && ! git diff --quiet -- "$AS" 2>/dev/null; then cp "$AS" "$O/access_sweep18.out.json"; git checkout -- "$AS"; fi
echo done > "$O/rerun/_done"
P16=ted/probes/2026-09-24-billing-16
timeout 900 node "$P16/cash_discount16.e2e.js" > "$O/rerun16/cash_discount16.log" 2>&1; echo "$? cash_discount16" >> "$O/rerun16/_exit.txt"
P15=ted/probes/2026-09-24-billing-15
for f in closeout_sales15.e2e.js cash_discount15.e2e.js ach15.e2e.js surcharge15.e2e.js link_paused_reason.e2e.js billing_refund_again15.e2e.js; do
  timeout 900 node "$P15/$f" > "$O/rerun15/${f%.js}.log" 2>&1; echo "$? $f" >> "$O/rerun15/_exit.txt"
done
P14=ted/probes/2026-09-24-billing-14
for f in ach_charge_twice.e2e.js closeout_floor.e2e.js surcharge14.e2e.js surcharge_default_bank.e2e.js deposit_error_text.e2e.js billing_refund_again14.e2e.js; do
  b=${f%.js}; b=${b%.e2e}
  timeout 900 node "$P14/$f" > "$O/rerun_e2e/$b.log" 2>&1; echo "$? $f" >> "$O/rerun_e2e/_exit.txt"
done
date > "$O/rerun_all_done"
