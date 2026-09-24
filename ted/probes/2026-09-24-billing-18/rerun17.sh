#!/usr/bin/env bash
# 18th pass: re-run every 17th-pass probe at HEAD, one at a time → rerun17/
R=/home/user/daily-camp-schedular
O=$R/ted/probes/2026-09-24-billing-18
P=$R/ted/probes/2026-09-24-billing-17
cd "$R"; rm -rf "$O/rerun17"; mkdir -p "$O/rerun17"
for f in webhook_write_fails17.js deposit_match17.js check_script_281_17.js sale_key_race17.js finance_billing17.e2e.js pos17.e2e.js offline_register17.e2e.js link17.e2e.js payroll_runs17.e2e.js payer_split17.e2e.js; do
  b=${f%.js}; b=${b%.e2e}
  timeout 900 node "$P/$f" > "$O/rerun17/$b.log" 2>&1; echo "$? $f" >> "$O/rerun17/_exit.txt"
done
date > "$O/rerun17/_done"
