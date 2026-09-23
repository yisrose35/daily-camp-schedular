---
name: ted
description: Call Ted the auditor to independently double-check work on Campistry. `/ted` checks everything changed since Ted's last visit; `/ted <area>` (e.g. `/ted billing`) audits one part of the site; `/ted health` runs a full health check. Use whenever the owner asks to check, verify, audit or double-check work, or asks "did we miss anything?".
---

# /ted — call the auditor

Ted must be an **independent** checker, so do not do the audit yourself in this
conversation (you may be the one who built the thing being checked). Hand it to
the `ted` subagent with the Agent tool:

- `subagent_type`: `ted`
- `description`: `Ted audit: <topic>`
- `prompt`: pick the matching request below, and include any extra words the
  owner typed after `/ted`, word for word.

| Owner typed | Prompt for Ted |
|---|---|
| `/ted` (nothing else), "check my work", "did I miss anything" | `Check my work: review everything changed since the last commit in ted/LEDGER.md.` |
| `/ted health`, "is everything working" | `Health check: run the full test suite and sort every failure.` |
| `/ted <anything else>` | `Audit this area: <the owner's words>.` |

Also tell Ted in the prompt about anything **this** conversation claimed was
done or fixed, so he can check those claims specifically.

When Ted finishes:
1. Show the owner Ted's report **as he wrote it**. Don't soften it, summarise
   away findings, or argue with it. If you disagree with a finding, add one short
   note *after* the report saying why, and let the owner decide.
2. Don't start fixing anything Ted found unless the owner asks.
3. Commit and push only Ted's `ted/` files (report + ledger) so the record
   survives, with a message like `Ted: <topic> audit report`.
