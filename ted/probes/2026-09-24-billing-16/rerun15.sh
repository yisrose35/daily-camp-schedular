#!/usr/bin/env bash
# 16th pass: re-run the 15th pass's own probes, unchanged, at HEAD.
R=/home/user/daily-camp-schedular
P=$R/ted/probes/2026-09-24-billing-15
O=$R/ted/probes/2026-09-24-billing-16/rerun15
cd "$R"
rm -f "$O/_exit_codes.txt" "$O/_done"
for f in closeout_sales15.e2e.js cash_discount15.e2e.js ach15.e2e.js surcharge15.e2e.js link_paused_reason.e2e.js billing_refund_again15.e2e.js; do
  timeout 900 node "$P/$f" > "$O/${f%.js}.log" 2>&1; echo "$? $f" >> "$O/_exit_codes.txt"
done
for f in autoreload_dates15.js sola_pause15.js closeout_access15.js refund_failed_realdb15.js alert_retry_realdb15.js check_script_280_281.js; do
  timeout 600 node "$P/$f" > "$O/${f%.js}.log" 2>&1; echo "$? $f" >> "$O/_exit_codes.txt"
done
timeout 600 node --test "$P/charge_card_same_or_new15.test.js" > "$O/charge_card_same_or_new15.log" 2>&1; echo "$? charge_card_same_or_new15.test.js" >> "$O/_exit_codes.txt"
date > "$O/_done"
