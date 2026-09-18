# Campistry vs. Campflow — Competitive Gap Analysis

_Prepared 2026-09-18. Scope: match what Campflow "looks, acts, feels and offers."_
_Sources: Campflow public marketing site + product screenshots (provided), and a
direct inventory of the Campistry codebase (files, Supabase migrations, and Edge
Functions)._

---

## TL;DR

**Campistry is already a superset of Campflow on features.** Every product area
Campflow markets — registration, families/campers, bunks, money/payments,
communication, and platform/config — already exists in Campistry, usually in a
deeper form (multiple payment processors, a real double-entry ledger, scheduled
broadcasts, PDF custom forms, RBAC + entitlements). On top of that, Campistry
ships entire product lines Campflow has **nothing** comparable to: the auto/manual
**scheduling engine**, leagues & playoffs, **facial-recognition attendance**, **bus
routing** (Go), **canteen/POS + shop + luggage**, **payroll**, a **parent mobile app**
(Campistry Lite), and photos/photo sales.

So "offer everything they have" is essentially **already true**. The real gaps are
narrower and mostly about **presentation and a few specific UX affordances**:

1. **Marketing/site polish** — Campflow's public site (pricing tiers, testimonial
   wall, "how it works", FAQ) is a strong sales asset. This is the biggest
   genuine gap and the highest-leverage thing to match.
2. **A handful of small UX affordances** visible in their screenshots (disclosure
   "x of 6" progress, "Needs review" chips, one-click "Copy Registration Link",
   autopay active/paused chips, an income stat-card header). Most of the
   underlying data already exists in Campistry — these are surface additions.
3. **A few list-management niceties** — explicit duplicate-merge and
   waitlist/approval states worth confirming end-to-end.

Recommended sequence: **(A)** close the small UX affordance gaps (cheap, high
polish-per-hour), **(B)** decide whether to invest in a Campflow-grade public
marketing site, **(C)** lean into the differentiators Campflow can't match in our
own positioning.

---

## Area-by-area comparison

Legend: ✅ have it (equal or better) · 🟡 partial / worth confirming · ❌ gap

### 1. Registration
| Campflow feature | Campistry | Notes |
|---|---|---|
| Branded custom registration forms | ✅ | `campistry_register.html`, public form bootstrap migrations (084, 090, 114) |
| Family + camper + emergency info guided flow | ✅ | `campistry_me.js` field model |
| Deposit / payment-method / zero-deposit signup | ✅ | `registration-deposit`, `185/186/187/189` migrations, `campistry_card_capture.js` |
| Document uploads, agreements, e-signatures | ✅ | contract/`campistry_contract.html`, `085` contract offer, health docs (037) |
| Returning-family prefill | ✅ | `camp_person_seasons` (088), multi-season model |
| Save for later | 🟡 | Confirm the public form has an explicit "Save for later" like Campflow's |
| **Field Settings matrix (Use / Registration / Required per field)** | ✅ | present in `campistry_me.js` (~100 registration refs) — verify parity of the 3-toggle grid UI |
| One-click **"Copy Registration Link"** button | 🟡 | Small affordance to add next to the registration settings |
| "Record Owner" field for **separated parents** | 🟡 | Confirm we have an equivalent (which parent is submitting) |

### 2. Families & Campers
| Campflow feature | Campistry | Notes |
|---|---|---|
| Family profiles (parents, contacts, addresses, docs, notes) | ✅ | `campistry_me.js`, `campistry_notes.js` |
| Camper profiles (medical, allergies, schools, photos, custom fields) | ✅ | health (037), `campistry_camper_identity.js`, photo storage (080) |
| Unlimited custom fields | ✅ | field model in `campistry_me.js` |
| **Merge duplicates** | 🟡 | referenced in `campistry_me.js`/`dashboard.js` — confirm it's a first-class action |
| Approval workflow (review / accept / **waitlist** / reject) | 🟡 | acceptance letters + `113` application status exist; confirm explicit **waitlist** state |
| **Disclosures "x of 6" progress + "Needs review"** | 🟡 | disclosures exist in `campistry_me.js`; add the compact progress/needs-review chips seen in their Families table |

### 3. Organization (Bunks / Divisions / Staff)
| Campflow feature | Campistry | Notes |
|---|---|---|
| Bunks & divisions by grade | ✅ | `master_schedule_builder.js`, subdivisions |
| **Drag-drop bunk board** | ✅ | `mobile_touch_drag.js` + builder; verify a dedicated roster board view |
| Staff profiles (roles, terms, contact) | ✅ | `campistry_staff_apply.html`, staff accounts (017), RBAC |
| Print rosters / labels / name tags | ✅ | `print_center.js` |
| Term filter (Entire Season / First / Second Half) | ✅ | halves/terms in camp dates + rotation |

### 4. Money / Billing / Payments — **Campistry is materially stronger here**
| Campflow feature | Campistry | Notes |
|---|---|---|
| Invoices w/ line items | ✅ | `campistry_billing_core.js`, family charges (094) |
| Cards, ACH, checks, Zelle, cash, custom | ✅ | multi-processor (Stripe, Cardknox, Banquest, BYOP); manual methods |
| Payment plans + auto installments | ✅ | multi/whole-family plans (115–118), `charge-due-installments` |
| Autopay w/ audit trail | ✅ | autopay status (096), ledger posting (169–178) |
| Real-time dashboards (billed/collected/outstanding) | ✅ | AR + closeout; add the exact **stat-card header** (Income received / Spent / Remaining) if we want visual parity |
| Refunds / chargebacks / failed payments | ✅ | refund intents (198), chargebacks/dunning (175, 179) |
| **Autopay active/paused chip** in family list | 🟡 | data exists (096) — add the chip |
| _Beyond Campflow:_ double-entry **posted ledger**, tax statements, bank deposit reconciliation, tips, card-fee policy | ✅➕ | no Campflow equivalent |

### 5. Communication
| Campflow feature | Campistry | Notes |
|---|---|---|
| Broadcast by bunk / grade / term / custom list | ✅ | `campistry_broadcast_core.js`, `send-broadcast` |
| Email + SMS | ✅ | `send-sms`, Telnyx numbers (075/076), opt-outs (072/073) |
| **Voice broadcasts (upload/record/TTS)** | 🟡 | Telnyx voice infra exists — confirm a voice-broadcast UI matching theirs |
| Custom forms w/ responses syncing to records | ✅ | PDF forms (110–112), `submit-pdf-form-response`, form responses (013) |
| Rich text + attachments + merge tags | ✅ | broadcast core; confirm merge-tag catalogue parity |
| Delivery tracking / history per message | ✅ | link messages (020–023), scheduled broadcasts (046) |
| Live **preview pane** in composer | 🟡 | add a side-by-side email preview like their Broadcast screen |

### 6. Platform / Config
| Campflow feature | Campistry | Notes |
|---|---|---|
| Feature toggles (Hebrew names, Hebrew dates, colony tracking) | ✅ | link features (053/108), Hebrew field labels present in register form |
| Role-based permissions | ✅➕ | full RBAC (`rbac_*`, `access_control.js`) + entitlements (155–161) + access groups (097) — deeper than Campflow |
| Every change logged w/ user attribution | 🟡 | confirm a user-facing audit log view |
| Multi-season w/ history | ✅ | `camp_person_seasons` (088), seasons throughout |
| **Smart Import (Excel/CSV auto-map)** | 🟡 | `xlsx` bundled + import UI referenced — confirm auto-column-mapping parity |
| **Saved reports (one-click reuse)** | ✅ | `report_builder_core.js`, `send-scheduled-reports` |

### 7. Where Campistry has no Campflow competition (our moat)
Scheduling engine (auto + manual), leagues & playoffs, **facial-recognition
attendance** (face engine v2), **bus routing / Go** (Google + ORS + Geoapify
optimization), **canteen POS + camp shop + luggage** (with offline POS), **payroll
& youth corps**, **parent mobile app** (Campistry Lite), photos & photo sales,
birthdays, live locator, pickup requests/alerts. **Lead with these** — they are
reasons to choose Campistry over Campflow, not just parity.

---

## Look & feel

Campflow's visual identity: magenta/pink primary, purple-gradient logo, generous
white space, soft-pink section backgrounds, large rounded cards, pill status
chips, and a polished public marketing site. To "feel" on par:

- **Public marketing site** is the standout gap. Campflow has hero + value props,
  a logo/testimonial wall, feature accordion, "How it works" (4 steps), "Who it's
  for", pricing tiers, and an FAQ. Campistry has `landing.js`/`index.html`
  (functional signup/login/trial) but should be evaluated against that sales page.
  **This is the single highest-impact item for matching how they look.**
- **In-app chips & badges**: adopt their compact status vocabulary — Paid up /
  Partially paid / Unpaid, "Needs review", disclosure "x of 6", autopay
  active/paused. Cheap, high-polish.
- **Stat-card headers** on money pages (three-up summary cards) for instant
  visual parity with their Income screen.
- **Composer preview pane** for broadcasts.

---

## Recommended priorities

**Tier 1 — cheap parity wins (data already exists, surface-only):**
1. "Copy Registration Link" button
2. Disclosure "x of 6" + "Needs review" chips in Families
3. Autopay active/paused chip in Families
4. Income stat-card header (Received / Spent / Remaining)
5. Broadcast live preview pane

**Tier 2 — confirm/complete existing capabilities:**
6. Duplicate-merge as a first-class action
7. Explicit waitlist state in the approval workflow
8. Smart Import auto-column-mapping parity
9. User-facing audit log view
10. Voice-broadcast UI; merge-tag catalogue parity; "Save for later" on public form

**Tier 3 — strategic (biggest effort, biggest look-and-feel payoff):**
11. A Campflow-grade public marketing site (pricing, testimonials, how-it-works, FAQ)

**Tier 4 — positioning (no build):**
12. Foreground the differentiators Campflow can't match in messaging and demos.

---

## Open questions to confirm before building
- How polished is the current `index.html`/`landing.js` marketing surface vs.
  Campflow's? (Determines Tier 3 scope.)
- Do we already have explicit **waitlist** and **duplicate-merge** actions, or only
  the underlying data?
- Is there a user-facing **audit log** view, or only backend attribution?
- Does Smart Import already do **auto column mapping**?

_None of the above changes the headline: on features, Campistry already offers
everything Campflow does and considerably more. The work is mostly polish,
presentation, and a marketing site._
