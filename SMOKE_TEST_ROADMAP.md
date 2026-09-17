# Campistry — Me / Link / Snacks Full Smoke Test

**Hand this file to Claude:** *"Read `SMOKE_TEST_ROADMAP.md` and walk me through it,
starting at Part 0."*

This is a complete, adversarial walkthrough of three apps — **Campistry Me**,
**Campistry Link** (admin console + parent portal + staff tips page) and
**Campistry Snacks** (manager + register + camp shop + offline register) — plus
everything underneath them that all three share: cloud sync, per-section access,
entitlements, session planning, and the money ledger.

It is not a happy-path demo. Roughly half the checks are written to **break
things on purpose**, because the failures that matter here are silent ones: a
balance that quietly resets, a message that reaches two-thirds of a list, a
camper who loses their canteen money to a child with the same name.

---

## How to read this file

Every check is a numbered card:

| | |
|---|---|
| **Do** | The exact action. |
| **Expect** | What correct looks like. |
| **Verify** | Where to prove it — a SQL query, a DevTools panel, a console command. Not every card has one. |
| **If it fails** | The file and function to start reading. |
| **Sev** | How bad it is if it fails (see below). |

**Severity:**

| | |
|---|---|
| **S1** | Money is wrong, or data is lost. Stop and report immediately — do not keep testing on that camp. |
| **S2** | A core flow is blocked. Nobody can finish the job. |
| **S3** | Wrong information is shown, but nothing is lost. |
| **S4** | Cosmetic. Log it and move on. |

**Check IDs** are stable — `ME-R-04`, `SN-P-11`, `BRK-22`. Report by ID so a
re-run can be compared to the last one.

---

## Rules for whoever runs this

1. **Report honestly.** A step you could not do is a *skip*, not a pass. Say
   which and why. A partial pass with the gap named is worth more than a clean
   sheet that isn't true.
2. **Never run the money parts against a camp with real families.** Part 0 sets
   up a throwaway camp. Autopay and the deposit cron run against *every* camp in
   the Supabase project — do not hand-trigger them.
3. **One finding, one card ID.** If a check fails, write down: the ID, what you
   actually saw, the browser console output, and the network request that failed
   (Name, Status, Response). A screenshot of a wrong number is not a bug report.
4. **Don't fix as you go.** Record and continue, unless the failure corrupts data
   (S1) — then stop.
5. **Hard-reload between parts.** `Cmd/Ctrl + Shift + R`. Every one of these
   pages is cache-busted by a `?v=` query string, and a stale tab will make you
   chase a bug that was fixed weeks ago.

---

## Run order

Run them in this order. Later parts assume the data earlier parts created.

| Part | File | What it covers | Cards | Rough time |
|---|---|---|---|---|
| **0** | `smoke_test/00_PREFLIGHT.md` | Accounts, migrations, seed data, console tools, known-benign noise | 9 | 45 min |
| **1** | `smoke_test/01_ME_ROSTER_STRUCTURE.md` | Roster, camper & staff profiles, families, Structure, Bunk Builder, bunk generator, bunk staff, division heads, CSV import | 53 | 2–3 h |
| **2** | `smoke_test/02_ME_REGISTRATION_HIRING.md` | Registration pipeline, sessions/bundles/capacity/waitlist, form builders, public forms, Hiring, contracts, post-hire, Leads | 51 | 3–4 h |
| **3** | `smoke_test/03_ME_MONEY.md` | Billing ledger, charges/credits/refunds, cards on file, pay links, plans & autopay, deposits, card fees, bank deposit inbox, Payroll, Finance | 43 | 4–5 h |
| **4** | `smoke_test/04_ME_OUTPUT.md` | Analytics, Reports, Report Builder, Print Sheets, Forms & Docs, Broadcasts, notes/custom fields/documents/scholarships | 24 | 2 h |
| **5** | `smoke_test/05_LINK_ADMIN.md` | Link dashboard, Messages, Compose & delivery, Forms, Lists, Parents, Photos, Tips Setup | 45 | 3–4 h |
| **6** | `smoke_test/06_LINK_PARENT.md` | Parent portal end to end — auth, children, schedule, messages, forms, lists, photos, payments, canteen, shop, tips, pickup, mail, health, settings + the staff tips page | 64 | 4–5 h |
| **7** | `smoke_test/07_SNACKS.md` | Canteen manager, accounts & cash, menu, register (POS), offline register, Camp Shop | 49 | 3–4 h |
| **8** | `smoke_test/08_CROSS_APP.md` | Cloud sync contract, multi-tab/multi-device/offline, roles & per-section access, entitlements, trial limits, session planning (sandbox), realtime | 40 | 3 h |
| **9** | `smoke_test/09_BREAK_IT.md` | The adversarial suite — races, concurrency, hostile input, scale, clock, identity collisions | 50 | 3–4 h |
| **10** | `smoke_test/10_RESULTS.md` | Results template, the SQL verification pack, and the console command reference | — | — |

**428 checks in total, roughly 30 hours of real clicking.** It is meant to be run over several
sessions. Each part is self-contained after Part 0, so you can stop between them.

**If you only have one day**, run Part 0, then the 156 cards marked **★ CORE**,
then all 50 cards in Part 9. That is the shape of the system's real risk. (Part 9
uses a bare **★** for its highest-value cards — every card in that part is
adversarial by design, so none of them are optional.)

---

## What this covers, in one picture

```
   Campistry Me  ───────────────────────────────────────────────┐
     roster ─────────────► canteen accounts (Snacks)            │
     roster ─────────────► children + audiences (Link)          │
     bunks/bunk staff ───► tip recipients (Link), POS filter    │
     enrollment accepted ► parent invite (Link) + ledger charge │
     ledger ─────────────► "what I owe" (Link parent portal)    │
     positions ──────────► suggested tip by role (Link)         │
     payment methods ────► what Snacks may record, what the     │
                           registration form may offer          │
   Campistry Link  ──────────────────────────────────────────── │
     parent pays tuition ► ledger (Me) ► balance parity         │
     parent adds funds ──► canteen balance (Snacks + POS)       │
     parent orders swag ─► shop order (Snacks)                  │
     parent tips ────────► staff tip account (Me → Payroll)     │
   Campistry Snacks  ─────────────────────────────────────────── │
     POS sale ───────────► balance ► parent portal              │
     refund ─────────────► processor ► parent portal            │
     cash out ───────────► balance, own daily cap              ─┘
```

Every arrow in that picture is a check somewhere in Parts 1–8. Part 9 tries to
break each arrow.

---

## The five failures this plan exists to catch

These are real, documented hazards in this codebase. Every part references back
to one of them, and Part 9 attacks all five directly.

1. **The stale-tab clobber.** `campistryMe` is one row that the browser rewrites
   whole from what it read at page load. Server-side functions (autopay, the
   Stripe/Cardknox/BYOP handlers) write into `finance` and `families` between
   those two moments. `campistry_finance_merge.js` puts the server's writes back
   — if it ever fails, a family is charged twice or a payment disappears.
   *(`integration_hooks.js` ~line 897, the ★ comment.)*
2. **Two campers, one name.** The roster, the canteen ledger and the family map
   are all keyed by name. A duplicate gets a suffixed key and a `displayName`;
   the canteen joins on `camperId` with an unidentified-by-name fallback. Get it
   wrong and one child spends another child's money. *(`campistry_camper_identity.js`,
   `_reconcileBalances` in `campistry_snacks.js`.)*
3. **The unenforced charge.** The register's daily limit and overdraft rules are
   only truly enforced by `submit_canteen_purchase` under a row lock. The client
   pre-check is UX. If the RPC is missing or the network drops, the sale still
   goes through with a warning — by design. *(`charge()` in `campistry_snacks_pos.js`.)*
4. **Partial delivery.** Choosing SMS or Email on a broadcast reaches everyone in
   the audience *consent permitting*. Consent, opt-outs, unsubscribes, a camp
   with no Telnyx number and the dedupe checkbox each silently shrink the list.
   The reach bar is the promise; `send-broadcast` is what actually happens.
5. **The wrong workspace.** A session plan looks exactly like the live camp. An
   office that spends an afternoon building next half's bunks in what it thought
   was a sandbox — and wasn't — has wrecked the running camp. Money is never
   sandboxed and must refuse at the door.

---

## Before you start

Go to `smoke_test/00_PREFLIGHT.md`. Nothing below Part 0 will give a trustworthy
answer until Part 0 is done, and the single most common cause of a false failure
in this plan is a migration that was never run.
