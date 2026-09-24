#!/usr/bin/env bash
# 19th pass: run every suite at HEAD, one after another, keep each log + exit code.
R=/home/user/daily-camp-schedular
O=$R/ted/probes/2026-09-24-billing-19
cd "$R"
rm -f "$O/exit.txt" "$O/suites_done.flag"
npm run test:pg    > "$O/pg.log"    2>&1; echo "pg $?"    >> "$O/exit.txt"
npm run test:keys  > "$O/keys.log"  2>&1; echo "keys $?"  >> "$O/exit.txt"
npm run test:lite  > "$O/lite.log"  2>&1; echo "lite $?"  >> "$O/exit.txt"
npm run test:smoke > "$O/smoke.log" 2>&1; echo "smoke $?" >> "$O/exit.txt"
npm run test:scale > "$O/scale.log" 2>&1; echo "scale $?" >> "$O/exit.txt"
npm test           > "$O/npm_test.log" 2>&1; echo "npm $?" >> "$O/exit.txt"
date > "$O/suites_done.flag"
