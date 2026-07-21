# Competitor Deep-Dive: CampMinder & CampFlow

_Research compiled 2026-07-21 for Campistry. Sources are review sites, each vendor's
public feature/help/pricing pages, and competitor comparison pages (full list at bottom).
The two vendor domains block automated fetching, so mechanics below are reconstructed from
search-indexed help-center and feature-page content plus third-party reviews — treat exact
UI labels as ~90% accurate, feature existence as high-confidence._

---

## TL;DR — the one thing that matters most for Campistry

**Neither product does true period-by-period activity scheduling — the thing Campistry is built around.**

- CampMinder's "activity scheduling" is really **activity _sign-up / elective enrollment_** (campers or parents pick activities, capacities cap enrollment). It does **not** generate a per-bunk, per-period daily grid that respects field availability, rotation fairness, and league fixtures. Multiple sources confirm program directors **run the actual daily schedule in a spreadsheet next to CampMinder and print it every morning.**
- CampFlow's "operations" is **bunk assignment + rosters + staff-to-bunk assignment**. There is **no daily activity grid / solver at all.**

So both are strong **camp-business platforms** (registration, billing, CRM, health, comms, photos) and weak-to-absent on the **daily operational schedule**. That is Campistry's wedge. Everything below is the feature surface you'd want to _eventually_ match on the business side, plus the exact scheduling gap you already beat them on.

---

# PART 1 — CAMPMINDER

Positioning: the incumbent "all-in-one" for **residential (sleepaway) + day camps**, 20+ camp-specific tools, ~2,000+ camps. Sells on being the system of record for the whole camp. Per-camper pricing, sold by an account exec, packaged in 3 suites.

## 1.1 Data model foundation — the Unified Person Record (UPR)

This is the spine of the whole system; copy this model first.

- **One record per person**, typed as Camper (Child), Adult Camper, Parent/Caregiver, Staff, or Alumni. The record's tabs change based on type.
- **Household model:** every person belongs to a *household*. Children have a **Primary Childhood Household**; staff/adults have a **Principal Household**. Household holds the shared **Address book** and lists all members → this is how siblings, two-home custody, and family billing all resolve to one place.
- **Tabs on a record:** Household, Forms (view/print submitted forms, mark complete/incomplete), Medical (health-history answers + health-center logs/treatments), Notes, Bulletins (staff-visible flags), Financial, Enrollment/Sessions.
- Everything else (billing, health, bunking, comms, reports) reads/writes against this record. The lesson: **model the person + household once, hang every module off it.** Campistry currently models bunks/divisions; a UPR-style person+household layer is what unlocks CRM/billing/health later.

## 1.2 Registration & Enrollment (Suite: Classic and up)

- **Application/form builder:** camp defines the camper application — custom questions, custom dropdown answer options, per-session. Parents self-enroll online.
- **Session Groups:** configurable enrollment units with **capacities, waitlists, and automated enrollment** (auto-promote from waitlist when a spot frees).
- **Deposits:** required deposit collected at time of enrollment; deposit payment method captured separately from balance method; balance paid later as lump sum or installments.
- **Discounts/pricing engine:** early-bird, multi-session, sibling discounts, **coupon codes** (percent or flat), pay-in-full discount, tiered pricing. Coupon entered on the application.
- **Enrollment dashboards:** live charts of enrolled/pending/waitlisted by session.
- **Sub-brand:** marketed as "CampMinder Registrar."

## 1.3 Forms

- Arbitrary custom forms (health history, permissions, etc.) attached to person types.
- **Mobile form fill** via the Campanion app (parents fill on phone, or photograph a paper doc to upload).
- Form completion status tracked on the UPR Forms tab; drives reminder emails.

## 1.4 Financial / Billing

- **Invoices vs Statements:** Invoice = amount due; Statement = current account status snapshot. Both generated under Financial > Billing.
- **Payment plans:** deposit + balance; installment schedules (monthly / quarterly / 3-pay); auto-billed recurring charges.
- **Payment methods:** all major credit cards, ACH; charges anything from tuition to camp-store re-ups.
- **Payments portal** (`payments.campminder.com`): camp sees current + potential revenue, overdue balances, paid-in-full accounts.
- **Financial reports** module for reconciliation/AR.
- **Camp store / spending accounts:** store account balances families can top up (canteen/camp-store money).

## 1.5 Health / Medical — "The Health Center" module (a real EHR)

This is one of CampMinder's deepest modules; it's effectively a camp EHR.

- **Health Profile** per camper/staff — allergies, conditions, providers, insurance, immunizations, pulled from the Health History form.
- **eMAR (electronic Medication Administration Record):** the compliance centerpiece. Meds submitted by parents on the health form land as **Pending Medications** (shows date added, source, dosage, delivery times, memos). Nurse **accepts or discontinues** each.
- **Logs vs MAR vs Treatments:**
  - **Log** = an expected/routine visit (check-in, follow-up).
  - **MAR** = administering a scheduled med, or recording missed/refused/skipped.
  - **Treatment** = an individual treatment record.
- Health data surfaces on the UPR Medical tab and in the Health Center dashboard. Marketed to camp nurses as "always confident and prepared."

## 1.6 Bunk / Cabin Assignment ("BunkPlanner")

Closest thing to Campistry's domain — but it's *housing assignment*, not *daily scheduling*.

- **Card-based drag-and-drop:** each camper is a "card"; drag cards into groups you create (cabin/group/program). Cards show **photo + camper profile detail** (age, grade, allergies, requests).
- **Bunk requests from parents:** "Bunk Request Form Settings" let the camp choose which request types parents can submit through the CampInTouch portal (e.g. "wants to bunk with X"). These surface next to the card during planning.
- **Staff-to-cabin:** drag staff cards into cabins to assign counselors.
- **8 bunk reports** (rosters, who's-where, allergies per cabin, table assignments, etc.).
- **Marketed as** "making history" — i.e., replaces the index-cards-on-a-corkboard ritual.

## 1.7 Activity Scheduling — **sign-ups, NOT a daily grid** (the gap)

- Handles **activity/elective sign-ups** with **capacity limits** and session planning rules to prevent oversell.
- Campers/parents choose activities; the system enforces caps and waitlists.
- **Does not** produce a per-bunk × per-period grid with field-conflict resolution, rotation fairness, or league fixtures. Directors run that in spreadsheets. ← **Campistry's core advantage.**

## 1.8 Attendance ("Paperless Attendance")

- Real-time attendance from any Wi-Fi device.
- One place to take **bus, group, and lunch attendance.**
- Handles late drop-offs / early pickups; flags absent campers instantly.

## 1.9 Transportation

- Build **buses, bus stops, routes, shuttles, schedules** (day + residential).
- Attendance check-ins built into the travel plan.
- **Daily Passenger Update** report: clean per-camper sheet for afternoon + next day pickup/dropoff.
- **Residential Travel** config for flights/arrivals for sleepaway camps.

## 1.10 Staff / HR ("Staff Coordinator" + `staff.campminder.com`)

- **Staff applications** (custom forms, mobile-friendly).
- **References auto-requested:** applicant submits → reference forms auto-emailed.
- **Background & reference checks**, candidate filtering.
- Stores **tax info, contracts, payroll docs** in one shared place.
- **Assign staff to cabins / specialty areas** in a few clicks.
- Actual shift scheduling is via **integrations** (When I Work, Deputy, Shiftboard) rather than native.

## 1.11 Communication — the "Communication Hub"

- **General Email** (non-marketing: reminders, weather).
- **Marketing Email** (with CTA: re-enrollment campaigns) — drag-and-drop editor, **scheduled/automated drip** to convert leads.
- **Shared email templates** (Professional suite) reusable across parents/staff/campers.
- **Text messaging (SMS):** opt-in checkbox added to camper/staff/alumni applications; send/schedule texts; configure sending numbers.
- **Targeted sends** by any filter (session, grade, cabin, form-status, balance).
- **CampInTouch** = the parent portal. Camp controls exactly which "Summer Services" (photos, guest accounts, emails, eLetters) each caregiver sees per session.

## 1.12 Campanion app (mobile; Deluxe + Professional suites)

The parent-facing mobile experience and a big upsell driver.

- **Smart photo feed** with **Face Finder** facial recognition: parent uploads one photo of their kid → app auto-surfaces every photo that child appears in, with push notifications on new matches.
- **Photo Season Pass** (paid add-on): unlimited high-res downloads + auto-tagged delivery. In the **Professional** suite this facial recognition + downloads is **free to all families** (differentiator).
- **eLetters / in-app letters:** parents compose letters in-app → printed & hand-delivered to camper.
- **Microposts:** short camp updates between photo drops.
- **Curated daily stream:** "must-see" photos + quick camp updates.
- **Mobile forms** and **Campanion Admin** side for staff to post/curate.
- Subscriptions let the camp control which parents get app access.

## 1.13 Reporting & Data

- **Built-in reports** library + **User Reports** custom builder (pick fields on camper/staff/alumni, add filters, titles, formatting).
- Export **CSV/Excel** or **PDF**.
- **Google Sheets Sync** (live auto-updating export).
- **Enrollment dashboards** with live charts.
- **"Ace Reporting"** (newer advanced reporting).

## 1.14 API & Integrations

- **REST API** requiring an **API key + subscription key** pair.
- Official **Zapier app** → connect to Mailchimp, HubSpot, Constant Contact, Salesforce, ad/lead CRMs.
- Fundraising via integration (e.g. **DonorPerfect**) rather than native donations.

## 1.15 Suites / Pricing

- **Custom per-camper pricing**, quoted by an account exec; no public dollar figures on the site. Third-party data points seen: ~**$24/camper at 200 enrolled**, ~**$13/camper at 500** (i.e., volume-tiered, larger camps pay less per head).
- **Classic** (<~100 campers): registration, forms, email, reporting — the fundamentals.
- **Deluxe:** adds **Campanion** app (mobile parent experience) + communication automation (scheduled email, drag-drop editor).
- **Professional:** everything in Deluxe + **advanced staff management** + **premium parent features** (free facial recognition + photo downloads for all families).

---

# PART 2 — CAMPFLOW

Positioning: newer, **lean, all-in-one for day camps / "colony" camps**, "built by people who ran camps," transparent low pricing, fast (~1-week) onboarding. Far smaller feature surface than CampMinder — deliberately. Strong on registration→billing→communication; **no daily activity scheduler.**

## 2.1 Registration

- **Branded custom registration pages** — your wording, your flow, guided multi-step (family → camper → emergency info in one flow).
- **Custom fields** on both camper and family profiles.
- **Deposit rules:** require deposit, collect payment method only, or **zero-deposit signup**.
- Shareable registration link; onboarding team imports your existing data and configures forms/billing/bunks to match how the camp runs.
- Generic **form builder:** build any form, send it, responses **sync back to records**.

## 2.2 Family & Camper Profiles (CRM)

- **Family profile:** parents, contacts, addresses, documents, notes.
- **Camper profile:** medical, allergies, schools, photos, custom fields.
- Communication history and replies logged on the family record (see comms).

## 2.3 Billing & Payments

- **Invoices** tied to family or camper with **real line items.**
- **Payment methods:** cards, **ACH, checks, Zelle, cash, and custom methods** (unusually broad — reflects the day-camp/community-camp market).
- **Payment plans** with **automatic installment charging on schedule.**
- Processing fees are **fixed per plan tier.**
- Real-time payment visibility as registrations come in.

## 2.4 Camp Operations (their "scheduling") — bunks & rosters only

- **Bunk Assignments:** create bunks, **drag campers between bunks**, assign counselors, set **bunk-specific pricing.**
- **Grade Rosters:** enrollment counts by grade, approval-status breakdown, bunk-assignment progress, print/export rosters.
- **Staff Management:** add/edit staff, track **salaries + employment periods**, assign staff to bunks, contact info.
- **No period-by-period activity grid, no field-conflict engine, no rotation solver, no leagues.** ← Campistry beats this outright.

## 2.5 Communication (a real strength for them)

- Channels: **Email, SMS, Voice Call** — send to whole season or filter by **grade, bunk, term, or approval status.**
- **Broadcast delivery tracking:** open any broadcast → per-recipient status (received / opened / bounced / failed).
- **Two-way SMS:** parent text replies are forwarded to camp email **and logged on the family record.**
- **Rich-text editor** with **file attachments + merge tags**; per-message delivery history.
- **Dedicated phone number** option.

## 2.6 Reporting

- Grade rosters, bunk rosters, enrollment/approval breakdowns, financial visibility, broadcast delivery reports. Lighter than CampMinder — operational lists more than an analytics suite.

## 2.7 Pricing (fully public — the opposite of CampMinder)

- **From $599/year**, billed annually, for small camps; core registration included.
- **No setup fees, no support fees**, "everything included, no add-ons."
- **Free 7-day trial.**
- **Usage-based comms:** **SMS $0.01/msg, Email $0.005/email, Voice $0.02/min, dedicated number $49 setup + $15/mo.**
- Payment-processing rates fixed by plan.

---

# PART 3 — SIDE-BY-SIDE & WHAT TO COPY FOR CAMPISTRY

| Capability | CampMinder | CampFlow | Campistry today |
|---|---|---|---|
| Person/household data model (UPR) | ✅ deep | ⚠️ family+camper profiles | ⚠️ divisions/grades/bunks (no person/household layer) |
| Online registration + form builder | ✅ | ✅ | ❌ |
| Billing / payment plans / store | ✅ deep | ✅ (broad payment methods) | ❌ |
| Health EHR / eMAR | ✅ deep | ⚠️ basic medical fields | ❌ |
| Bunk/cabin **assignment** (housing) | ✅ card drag-drop | ✅ drag-drop | ✅ (bunk model) |
| **Daily activity schedule (period grid, fields, rotation, leagues)** | ❌ sign-ups only | ❌ none | ✅ **your moat** |
| Transportation / bus routing | ✅ | ❌ | ❌ |
| Staff hiring/HR | ✅ deep | ⚠️ basic | ❌ |
| Comms (email/SMS/voice, 2-way) | ✅ | ✅ strong | ⚠️ (internal only) |
| Parent portal + mobile app + photos/Face Finder | ✅ (Campanion) | ❌ | ❌ |
| Reporting/analytics | ✅ | ⚠️ light | ⚠️ (analytics.js) |
| API / Zapier | ✅ | ❌ | ❌ |
| Pricing transparency | ❌ quote-only | ✅ public | n/a |

### If you want to copy them, do it in this order
1. **Own the schedule harder** (you already win): fields, rotation fairness, leagues, multi-period specials — none of them have this. Lead with it.
2. **Add a person/household layer (UPR-style)** — the prerequisite that unlocks everything else. Model Person (typed) + Household + Forms/Medical/Financial tabs.
3. **Registration + form builder → billing/payment plans** — the revenue core both competitors monetize.
4. **Health module (eMAR + logs/treatments)** — CampMinder's stickiest module; CampFlow doesn't have it, so it's a differentiator against the cheaper competitor.
5. **Comms hub (email + 2-way SMS, filtered by division/bunk/grade)** — CampFlow proves a lean version is enough; two-way SMS logged to the record is the table-stakes bit.
6. **Parent mobile app w/ photo feed + facial recognition** — CampMinder's biggest upsell (Campanion). High effort, high stickiness; do last.
7. **Transportation + attendance**, then **API/Zapier**.

### Positioning read
- **CampMinder** = premium, everything-included, sleepaway-camp incumbent, opaque per-camper pricing, monetizes photos + staff HR as upsell suites.
- **CampFlow** = cheap, transparent, day-camp-focused challenger, strong comms, deliberately no daily scheduler.
- **Campistry** = the daily-operations engine neither one has. The competitive story writes itself: "They register your campers and bill your families. We actually build your day."

---

## Sources
- CampMinder features & suites: campminder.com/features, /suites, /solutions/*, /features/{transportation,health-management,api,email-text-messages,unified-person-record,campanion-app}
- CampMinder Help Center: help.campminder.com (UPR, Health Center/eMAR/Pending Meds, Billing, Bunk Reports, Communication Hub, Text Messages, Paperless Attendance, API, User Reports, Ace Reporting)
- Campanion: campanionapp.com; help.campminder.com Campanion Admin
- Reviews/pricing: softwareadvice.com, capterra.com, getapp.com, g2.com, softwareworld.co
- Competitor comparison (scheduling-gap claims): campplaybook.com/vs-campminder
- CampFlow: campflow.org, campflow.org/help/{operations,communication,registration,payments}
