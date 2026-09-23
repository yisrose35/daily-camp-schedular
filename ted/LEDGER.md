# Ted's Ledger

Ted's memory between visits: what's been checked, what's still broken, and
what nobody has looked at yet. Ted updates this every run. Findings close only
when Ted has fresh proof they're fixed.

**Last commit checked:** `d9f7ffa0` (2026-09-23)

## Open findings

| ID | Severity | What's wrong | Found | Status |
|----|----------|--------------|-------|--------|
| TED-001 | 🔴 | Auto Builder shows a named custom block (e.g. "Main Activity") as **"Custom"** on the schedule. 14 tests failing since at least 2026-07-12; they passed on 2026-06-16. `tests/README.md` calls them "known failures" | 2026-09-23 | Open |
| TED-002 | 🟡 | Setup checklist's `?v=` cache-bust number (`-07`) doesn't match the dashboard's (`-08`) in `dashboard.html` | 2026-09-23 | Open |
| TED-003 | 🟡 | Out-of-date test: registration-page deposit tests (3) can't find their code, most likely because today's translation change added a script to the page. Deposit code itself looks present | 2026-09-23 | Open (likely stale test) |
| TED-004 | 🟡 | Out-of-date test: installment-plan test only reads the first 900 characters of the function, and a new comment pushed the real check past that. Code is fine | 2026-09-23 | Open (stale test) |

## Closed findings

| ID | What it was | Closed | Proof |
|----|-------------|--------|-------|
| — | | | |

## Areas audited

| Area | Last deep audit | Result |
|------|-----------------|--------|
| Whole site (automated tests only) | 2026-09-23 | 🔴 see TED-001 to TED-004 |
| Auto Builder (scheduler) | never | |
| Manual Builder | never | |
| Cloud saving / sync | never | |
| Rotation & fairness | never | |
| Leagues | never | |
| Billing, payments, deposits, refunds | never | |
| Registration forms | never | |
| Canteen / Snacks / Shop | never | |
| Payroll | never | |
| Staff roles & access | never | |
| Print center & calendar | never | |
| Campistry Go (buses, luggage) | never | |
| Campistry Lite (mobile) | never | |

## Run history

| Date | Type | Commit | Tests passed / failed | Verdict | Report |
|------|------|--------|-----------------------|---------|--------|
| 2026-09-23 | Health check | `d9f7ffa0` | 3,198 / 19 (plus 3 false alarms from a missing tool, resolved) | 🔴 | [report](reports/2026-09-23-first-health-check.md) |
