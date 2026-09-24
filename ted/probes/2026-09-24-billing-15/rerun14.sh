#!/usr/bin/env bash
# 15th pass: re-run each 14th-pass probe, unchanged, at today's HEAD.
R=/home/user/daily-camp-schedular
P=$R/ted/probes/2026-09-24-billing-14
O=$R/ted/probes/2026-09-24-billing-15
cd "$R"
rm -f "$O/rerun14_exit.txt"
for f in autoreload_after_season.js alert_email_fails.js check_script_275.js floor14_realdb.js floor_sola_realdb.js \
         refund_failed_realdb14.js access_repaste_278.js ach_charge_twice.e2e.js closeout_floor.e2e.js surcharge14.e2e.js \
         surcharge_default_bank.e2e.js deposit_error_text.e2e.js billing_refund_again14.e2e.js; do
  b=${f%.js}; b=${b%.e2e}
  timeout 600 node "$P/$f" > "$O/rerun14_$b.log" 2>&1
  echo "$? $f" >> "$O/rerun14_exit.txt"
done
timeout 600 node --experimental-strip-types --no-warnings "$P/canteen_index_cpu.mts" > "$O/rerun14_canteen_index_cpu.log" 2>&1
echo "$? canteen_index_cpu.mts" >> "$O/rerun14_exit.txt"
date > "$O/rerun14_done"
