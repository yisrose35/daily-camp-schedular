# Part 4 — Campistry Me: Analytics, Reports, Print Sheets, Forms & Broadcasts

Covers everything Me produces for someone else to read: the Analytics page, the
canned reports, the custom Report Builder and saved reports, column preferences,
Print Sheets, Forms & Documents (including the Link forms a parent fills in), and
the Broadcast composer.

**Files:** `campistry_me.js`, `report_builder_core.js`, `campistry_broadcast_core.js`,
`campistry_link_branding.js`, `campistry_bus_routes.js`, `pdf-lib@1.17.1.js`,
`xlsx@0.18.5.js`.

---

## 4.1 — Analytics

#### ME-A-01 — The page renders with real numbers

| | |
|---|---|
| **Do** | Me → Analytics. Read every tile and chart: enrollment funnel, invoices, payments, division and grade breakdowns. |
| **Expect** | Numbers match what you know to be true from Parts 1–3. Charts render (donut, bar, line). Paged tables page. |
| **Verify** | Cross-check at least three tiles by counting by hand. A dashboard nobody has checked is decoration. |
| **If it fails** | `renderAnalytics` (11992), `chartDonut` (1055), `chartLine` (1090), `chartBarH` (1032). |
| **Sev** | S3 |

#### ME-A-02 — Analytics on an empty camp

| | |
|---|---|
| **Do** | Open Analytics on a camp with no campers and no payments (use the second camp). |
| **Expect** | Empty states, zeroes, no `NaN`, no `Infinity`, no division-by-zero percentages, no broken chart. |
| **Sev** | S3 |

#### ME-A-03 — Analytics respects the roster slice and access

| | |
|---|---|
| **Do** | Compare Analytics counts to the Roster's "in camp today" vs "All" counts. Then open Analytics as a user with `me.analytics` at `view`. |
| **Expect** | It is clear which population each number is over. A view-only user sees the page with no write controls. |
| **Sev** | S3 |

---

## 4.2 — Canned reports

#### ME-A-04 — Every canned export

| | |
|---|---|
| **Do** | Run each: Roster, Family, Enrollment, Division, Medical, Financial. Open each file. |
| **Expect** | Correct columns, correct row count, UTF-8 (open one with a non-Latin name in Excel and confirm it is not mojibake). |
| **If it fails** | `exportRosterReport` (18202) through `exportFinancialReport` (18287), `dlCsv` (18198). |
| **Sev** | S2 |

#### ME-A-05 ★ CORE — CSV injection

| | |
|---|---|
| **Do** | Create a camper whose name is `=HYPERLINK("http://x","click")` and another whose notes field starts with `+`, `-` or `@`. Export the roster report. Open the file in Excel. |
| **Expect** | The cells show as **literal text**. Excel must not offer to run a formula. |
| **If it fails** | `dlCsv` (18198), `_csvCell` in `campistry_link_export.js:25` for the Link side. |
| **Sev** | S1 — this is the classic way a roster export becomes an attack on the office. |

#### ME-A-06 — Print families

| | |
|---|---|
| **Do** | Print the family directory. |
| **Expect** | Readable, paginated, no clipped columns. |
| **If it fails** | `printFamilies` (18232). |
| **Sev** | S4 |

---

## 4.3 — The Report Builder

#### ME-A-07 ★ CORE — Build, run, save

| | |
|---|---|
| **Do** | **New Report**. Pick the Campers source. Add fields by dragging (name, division, bunk, allergies, parent email). Add a filter. Reorder fields by drag. Remove one. Watch the live preview. Save it. Run it from the saved list. Export it. Print it. |
| **Expect** | The preview updates live. The saved report reproduces exactly on re-run. Export matches the preview. |
| **If it fails** | `openReportBuilder` (17631), `_rbWireLive` (17678), `rbFieldDrop` (17874), `_computeReport` (17918), `saveCurrentReport` (18086), `runSavedReport` (18127). |
| **Sev** | S2 |

#### ME-A-08 — Report builder edge cases

| | |
|---|---|
| **Do** | Save a report with: zero fields; forty fields; a filter on a field that you then remove from the structure (e.g. filter on division `Gamma` after deleting `Gamma`); two saved reports with the same name; a report name containing `/` and one containing emoji; a filter that matches nothing. |
| **Expect** | Zero fields refused or produces an empty sheet with headers. A stale filter yields zero rows with an explanation, not a crash. Duplicate names allowed but distinguishable. Nothing matching → an empty state, not a blank page. |
| **If it fails** | `_rbSyncFromDom` (17884), `rbSourceChange` (17900), `_reportSources` (17463). |
| **Sev** | S3 |

#### ME-A-09 — Column preferences

| | |
|---|---|
| **Do** | Resize a column, drag a column header to reorder, then reload. Then open the same report as a **different user**. |
| **Expect** | Your layout comes back for you. The other user has their own, unaffected. |
| **Verify** | `select * from user_ui_prefs where user_id='<UID>';` — migration 120. |
| **If it fails** | `getUiPref` (17949), `setUiPref` (17961), `_applyColPrefOrder` (17975). |
| **Sev** | S4 |

#### ME-A-10 — Two users edit the same saved report

| | |
|---|---|
| **Do** | Two browsers, same camp. Both open the same saved report, both rename it, both save. |
| **Expect** | Last write wins is acceptable, **silent loss of the other's fields is not**. Say which happens. |
| **Sev** | S3 |

#### ME-A-11 — Scheduled reports

| | |
|---|---|
| **Do** | Set a saved report to email weekly. |
| **Expect** | It saves. Note that per `SCHEDULED_REPORTS_SETUP.md` the email is a **"your report is ready" notification**, not the data itself — confirm the UI does not promise an attachment it will not send. |
| **If it fails** | `send-scheduled-reports`. |
| **Sev** | S3 |

---

## 4.4 — Print Sheets

#### ME-A-12 ★ CORE — Build a sheet

| | |
|---|---|
| **Do** | Print Sheets → New. Add columns, set headers, reorder by drag, group by division then by bunk, toggle hide-empty, rename the sheet, duplicate it, preview, print. |
| **Expect** | The preview matches the printed output. Grouping produces one block per group in the structure's own order. |
| **If it fails** | `psNew` (19486), `psAddColumn` (19520), `psColDrop` (19565), `psGroups` (19439), `psPreviewHtml` (19644), `psPrint` (19660). |
| **Sev** | S2 |

#### ME-A-13 — The bus column

| | |
|---|---|
| **Do** | Add the bus-route column to a sheet on a camp where Campistry Go **has** routes, then on one where it does not. |
| **Expect** | Real route names when Go has them. A clear warning (not blank cells) when it does not. |
| **If it fails** | `_busVal` (19320), `_busHasData` (19358), `_psBusWarningHtml` (19625), `campistry_bus_routes.js`. |
| **Sev** | S3 |

#### ME-A-14 — Print sheet abuse

| | |
|---|---|
| **Do** | A sheet with zero columns; twenty columns (does it fit the page?); grouping by a field every camper shares; a header of 200 characters; a sheet printed while the roster slice is "in camp today" vs "All". |
| **Expect** | Zero columns refused or prints an empty grid. Twenty columns either fit, scale or wrap — not silently truncated. **The printed population matches the slice shown on screen**, and the sheet says which. |
| **Sev** | S2 — a bunk list printed from the wrong slice is a head count that is wrong at pickup. |

#### ME-A-15 — Staff rows

| | |
|---|---|
| **Do** | Build a sheet that includes staff rows alongside campers. |
| **Expect** | Staff appear with their own fields and are visually distinguishable. |
| **If it fails** | `_psStaffAsRow` (19391). |
| **Sev** | S4 |

---

## 4.5 — Forms & Documents

Two separate things live here: **camp forms** (the camp's own list) and **Link
forms** (what a parent sees in the portal).

#### ME-A-16 ★ CORE — The four Link item kinds

| | |
|---|---|
| **Do** | Add one of each: a **digital form** (parent fills online), a **print form** (download, fill, return), a **document** (read-only), and a **PDF form** (AcroForm fields auto-detected). |
| **Expect** | Each appears in the parent portal under Forms & Documents in the right group and behaves per its kind. |
| **If it fails** | `addLinkDigitalForm` (17099), `addLinkPrintForm` (17113), `addLinkDocument` (17128), `addLinkPdfForm` (17149), migrations 110/111. |
| **Sev** | S2 |

#### ME-A-17 ★ CORE — PDF AcroForm detection

| | |
|---|---|
| **Do** | Upload a real fillable PDF. Review the detected fields, fix a label and a type, save. Then upload a **flat** (non-fillable) PDF, a 30 MB PDF, an encrypted PDF, and a `.docx` renamed `.pdf`. |
| **Expect** | Fields detected and editable for the real one. The flat PDF is either rejected or offered as a print form instead. Encrypted/oversized/misnamed files refused with a message, not a hung spinner. |
| **If it fails** | `_detectPdfFields` (17188), `_pdfFieldType` (17227), `_openPdfFieldReview` (17261), `_savePdfFormDraft` (17314). |
| **Sev** | S2 |

#### ME-A-18 — Form responses

| | |
|---|---|
| **Do** | After a parent submits (Part 6), open **View Responses** here. |
| **Expect** | Responses grouped under the form, one row per camper, downloadable. |
| **If it fails** | `viewFormResponses` (17078), `_loadFormSubmissions` in the Link admin page (3946). |
| **Sev** | S2 |

#### ME-A-19 — Delete a form that has responses

| | |
|---|---|
| **Do** | Delete a form template that parents have already filled in. |
| **Expect** | Warned. The **responses survive** or are explicitly deleted with consent. Never silently orphaned. |
| **If it fails** | `deleteForm` (17073), `deleteLinkItem` (17373). |
| **Sev** | S1 |

---

## 4.6 — Broadcasts from Me

Me has its own broadcast composer, separate from Link's. Both end up at
`send-broadcast`.

#### ME-A-20 — Compose and preview

| | |
|---|---|
| **Do** | New broadcast. Write subject and body. Watch the branded preview. Send. |
| **Expect** | The preview shows the camp's real branding (logo, brand colour, footer) — the same template the parent actually receives. |
| **If it fails** | `openBroadcastModal` (16810), `_bcRefreshPreview` (16800), `_getLinkBranding` (16793), `campistry_link_branding.js`, `tests/link_branding.test.js`. |
| **Sev** | S3 |

#### ME-A-21 ★ CORE — Delivery reality

| | |
|---|---|
| **Do** | Send to a small group, then count what actually arrived across email, SMS and in-app. |
| **Expect** | The count sent matches the count delivered, minus recipients without consent / opted out / unsubscribed — and the UI **says** how many were skipped and why. |
| **Verify** | `select * from sms_opt_outs where camp_id='<UUID>';` and `select * from email_unsubscribes;` |
| **If it fails** | `sendBroadcastNow` (18298), `send-broadcast`, `campistry_broadcast_core.js`, `SMS_EMAIL_BROADCAST_SETUP.md`. |
| **Sev** | S2 — this is hazard #4. Silent partial delivery on "the bus is two hours late" is the failure that matters. |

#### ME-A-22 — Reminders

| | |
|---|---|
| **Do** | **Send payment reminders** and **Send form reminders**. |
| **Expect** | Only families who actually owe / haven't submitted are targeted. Nobody paid-up gets a demand. |
| **If it fails** | `sendPaymentReminders` (18332), `sendFormReminders` (18344). |
| **Sev** | S2 |

#### ME-A-23 — Automated notifications

| | |
|---|---|
| **Do** | Trigger an event that fires an automatic notification (enrollment accepted, payment received). |
| **Expect** | It fires once per event, not once per render. |
| **If it fails** | `sendAutoNotification` (18326), `auto-notify`. |
| **Sev** | S2 — a notification that fires on render spams a family every time the office opens a page. |

---

## 4.7 — Persistence for Part 4

| | |
|---|---|
| **ME-A-24 Do** | Reload, log out and in, second device. |
| **Expect** | Saved reports, print sheets, column preferences (per user), forms, Link items and broadcast history all survive. |
| **Verify** | Saved reports and print sheets live inside `campistryMe`; column prefs in `user_ui_prefs`; Link forms in `link_forms` / `camp_state_kv` under `link_forms`. |
| **Sev** | S2 |
