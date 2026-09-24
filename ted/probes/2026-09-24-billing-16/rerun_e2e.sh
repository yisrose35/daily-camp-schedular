#!/usr/bin/env bash
# 16th pass: re-run the 14th pass's browser probes (unchanged) at HEAD.
R=/home/user/daily-camp-schedular
P=$R/ted/probes/2026-09-24-billing-14
O=$R/ted/probes/2026-09-24-billing-16/rerun_e2e
mkdir -p "$O"; rm -f "$O/_exit.txt" "$O/_done"
cd "$R"
for f in ach_charge_twice.e2e.js closeout_floor.e2e.js surcharge14.e2e.js surcharge_default_bank.e2e.js deposit_error_text.e2e.js billing_refund_again14.e2e.js; do
  b=${f%.js}; b=${b%.e2e}
  timeout 900 node "$P/$f" > "$O/$b.log" 2>&1
  echo "$? $f" >> "$O/_exit.txt"
done
date > "$O/_done"
