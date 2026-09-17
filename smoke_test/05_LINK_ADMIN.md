# Part 5 — Campistry Link: the admin console

`campistry_link_admin.html` — the camp's side of parent communication. Covers the
dashboard, Messages (Inbox / Sent / Scheduled / Assigned to me), the Compose
drawer and everything that decides who actually receives a message, Forms, Lists,
Parents, Photos, and Tips Setup.

**Files:** `campistry_link_admin.html`, `campistry_link_data.js`,
`campistry_link_photos.js`, `campistry_link_export.js`, `campistry_link_branding.js`,
`campistry_broadcast_core.js`, `face_match_core.js`, `campistry_face_shared.js`,
`campistry_face_engine_v2.js`, `campistry_cloud_bootstrap.js`.

**Depends on Parts 1–2:** Link reads the roster, families, structure and
enrollment status straight out of Me. If a camper is wrong here, check Me first.

---

## 5.1 — Dashboard and data bridge

#### LK-A-01 ★ CORE — Link sees Me's data

| | |
|---|---|
| **Do** | Open the Link admin page. Read the dashboard stats and the "Connected to Me" card. |
| **Expect** | Camper, family and parent counts match Me exactly. The data-check card reports a healthy link. |
| **Verify** | Console: `CampistryLink.data.getRoster()` and `…getParentDirectory()` — compare lengths with Me. |
| **If it fails** | `renderDash` (1775), `campistry_link_data.js` `data.getMe` (505), `campistry_cloud_bootstrap.js`. A count of zero here almost always means hydration, not Link. |
| **Sev** | S2 |

#### LK-A-02 — A change in Me shows up here

| | |
|---|---|
| **Do** | In another tab, add a camper in Me. Come back and refresh Link. |
| **Expect** | The new camper is in the audience counts and the individual search. |
| **Sev** | S2 |

---

## 5.2 — Messages

#### LK-A-03 ★ CORE — Inbox

| | |
|---|---|
| **Do** | Have a parent send a message (Part 6). In the admin inbox: read it, reply, mark important, archive, unarchive, delete. Use each filter (All / Unread / Important / Archived) and each dropdown (grade, division, bunk) and the search box. |
| **Expect** | Every action persists and the counts update. The reply reaches the parent. |
| **If it fails** | `renderAdminMsgs` (3137), `openAdminMsg` (3248), `sendAdminReply` (3283), `toggleMsgImportant` (3219), `deleteAdminMsg` (3238), migrations 020–023, 044. |
| **Sev** | S2 |

#### LK-A-04 — Confirm-deletes toggle

| | |
|---|---|
| **Do** | Turn **Confirm deletes** on, delete a message, tick "Don't ask me again", delete another. |
| **Expect** | The first asks, the second does not, and the preference survives a reload. |
| **If it fails** | `lkConfirmEnabled` (1192), `lkSetConfirmDelete` (1193). |
| **Sev** | S4 |

#### LK-A-05 — Swipe actions

| | |
|---|---|
| **Do** | On a touch device or with DevTools device emulation, swipe a message row both ways. |
| **Expect** | The revealed actions work and the row springs back if released early. |
| **If it fails** | `initMsgSwipe` (1147). |
| **Sev** | S4 |

#### LK-A-06 — Assigned to me

| | |
|---|---|
| **Do** | As a staff member who is a message-routing target (migration 027/038), open the "Assigned to me" tab and reply. |
| **Expect** | Only messages routed to that person. The tab is hidden for anyone with none. |
| **If it fails** | `_loadStaffInbox` (1279), `renderMyStaffInbox` (1291), `_staffReply` (1313). |
| **Sev** | S3 |

#### LK-A-07 — Sent

| | |
|---|---|
| **Do** | Open Sent, open a sent message's detail. |
| **Expect** | Recipients, channels and timestamp are all shown. A mass send appears once, not once per family. |
| **If it fails** | `renderSentList` (1412), `openSentDetail` (1449). |
| **Sev** | S3 |

---

## 5.3 — Compose: who actually receives it

This is hazard #4 and the most important section of Part 5. Work through it
slowly.

#### LK-A-08 ★ CORE — Scope

| | |
|---|---|
| **Do** | For each scope — Everyone, By Division, By Grade, By Bunk, Specific Parent — select it and read the recipient count. Use **Select all** and **Clear** on the chips. For Specific Parent, search by camper name and by parent name, add several. |
| **Expect** | The count is right every time. Count it by hand for one bunk. |
| **If it fails** | `onScopeChange` (2274), `_getComposeTargets` (2448), `_updateScopeCount` (2541). |
| **Sev** | S2 |

#### LK-A-09 ★ CORE — Audience and term

| | |
|---|---|
| **Do** | Switch **Include** between "Approved campers only", "All active (incl. pending)" and "Everyone (incl. past/declined)". Then set **Term** to one session. |
| **Expect** | The count changes in the expected direction each time. A declined family is **not** in "Approved only". A 2nd-Half-only camper is excluded when the term is 1st Half. |
| **Verify** | Cross-check against Me's Registration statuses. |
| **If it fails** | `_passesAudience` (2432), `_passesSession` (2442), `classifyEnrollmentStatus`/`matchesAudience` in `campistry_broadcast_core.js`. |
| **Sev** | S1 — messaging a family who was declined is the kind of mistake a camp does not recover from socially. |

#### LK-A-10 ★ CORE — The reach bar tells the truth

| | |
|---|---|
| **Do** | Pick a group. Select In-App, then add Email, then add SMS. Read the reach bar after each. Then send, and count what actually arrives. |
| **Expect** | The bar's per-channel numbers match reality. Choosing SMS means SMS reaches **everyone in the audience, consent permitting** — it is not quietly limited to parents without a Link account. Anyone skipped is counted and the reason is named. |
| **If it fails** | `_computeReach` (1876), `_renderReachBar` (1893), `computeReach` in `campistry_broadcast_core.js`, `sendCompose` (2748). |
| **Sev** | S1 |

#### LK-A-11 — The dedupe checkbox

| | |
|---|---|
| **Do** | Tick "skip parents who will see this in Link" and send to a mixed group of adopters and non-adopters. |
| **Expect** | Adopters get it in-app only; non-adopters get email/SMS; the toast states the split. Untick it and everyone gets both. |
| **If it fails** | `toggleCompDedupe` (1867), `_splitByAdoption` (1845), `_fetchLinkAdoption` (1825), migration `071_link_adoption_status.sql`. |
| **Sev** | S2 |

#### LK-A-12 ★ CORE — Siblings do not get two copies

| | |
|---|---|
| **Do** | Send an email broadcast to a group containing two siblings who share one parent email. |
| **Expect** | **One** email to that address. The send dedupes on event key + address. |
| **If it fails** | `sendCompose` (2748) `eventKey`, `_sendNonAdopterFallback` (1933), `send-broadcast`. |
| **Sev** | S2 |

#### LK-A-13 ★ CORE — Merge tags

| | |
|---|---|
| **Do** | Insert every tag — `{{child_name}}`, `{{parent_name}}`, `{{bunk}}`, `{{bus_route}}`, `{{grade}}`, `{{division}}` — and preview. Then send to a camper with **no bunk**, one with **no bus route**, and one whose parent name is blank. Also try an invented tag `{{nonsense}}`. |
| **Expect** | Real values substituted per recipient (use **Preview All** to check several). A missing value leaves something sensible, never the literal `{{bunk}}` or the word `undefined`. An unknown tag is left alone or stripped — state which. |
| **If it fails** | `insertTag` (2689), `_applyMergeTags` (2529), `applyMergeTags` in `campistry_broadcast_core.js`, `_buildBusRouteMap` (2513). |
| **Sev** | S2 — "Your child undefined is on bus undefined" goes to the whole camp. |

#### LK-A-14 — Preview, Preview All, Send test to me

| | |
|---|---|
| **Do** | Use each. Step through variants in Preview All. Send a test to yourself. |
| **Expect** | The preview is what actually lands, branding and all. The test is a **real** message with merge tags filled in. |
| **If it fails** | `openComposePreview` (2585), `showComposePreviewAll` (2709), `sendTestToMe` (2995). |
| **Sev** | S3 |

#### LK-A-15 — Branding editor

| | |
|---|---|
| **Do** | Open **Branding & logo**. Upload a logo, set a brand colour, set a footer, upload a watermark, switch header style (bar / plain / none), remove the logo. Then upload a 10 MB PNG, an SVG containing a script, and a file that is not an image. |
| **Expect** | Valid images apply and show in the preview. **The SVG with a script must be rejected** (`isSafeImage`). Oversized/invalid refused. |
| **If it fails** | `openLinkBranding` (2071), `_lbUploadLogo` (2227), `LinkBranding.isSafeImage` (`campistry_link_branding.js:39`). |
| **Sev** | S1 for the SVG. |

#### LK-A-16 — Templates

| | |
|---|---|
| **Do** | Use the quick-fill templates (Bunk, Bus Route, Form Reminder). Save a template of your own, load it, delete it. |
| **Expect** | All persist. |
| **If it fails** | `loadTemplate` (1960), `saveComposeTemplate` (2030), `deleteSavedTemplate` (2053). |
| **Sev** | S4 |

#### LK-A-17 ★ CORE — Attach a form or list

| | |
|---|---|
| **Do** | Attach a form, send. Then attach a list, send. Then attach a form and **delete that form template before sending**. |
| **Expect** | The parent gets an "Open & fill" / "View list" button that works. Sending with a deleted attachment either refuses or degrades to plain text — never a dead button in a parent's inbox. |
| **If it fails** | `_attachPick` (1371), `sendCompose` (2748) `refs` tokens, `_msgFormActionHtml` in the parent page (3685). |
| **Sev** | S2 |

#### LK-A-18 ★ CORE — Scheduling

| | |
|---|---|
| **Do** | Schedule a broadcast for 2 minutes out and wait. Then schedule one for a **past** time. Then one for 6 months out. Then schedule one and **cancel** it before it fires. Then schedule one and, before it fires, **rename the bunk** it targets in Me. |
| **Expect** | The 2-minute one fires once, on time, in the **camp's timezone**. A past time is refused (there is a minimum lead time). Cancel works. The renamed bunk still resolves — scheduled sends resolve recipients from a stored `{scope, values}` snapshot, not the live DOM, so check whether the rename breaks it and report either way. |
| **Verify** | `select * from …` scheduled broadcasts; `send-scheduled-broadcasts` logs. `validateScheduleTime` / `selectDue` in `campistry_broadcast_core.js`. |
| **If it fails** | `scheduleCompose` (2939), `_resolveTargetsFor` (2825), `_getComposeScopeSnapshot` (2874), `cancelScheduled` (3080), migration 046. |
| **Sev** | S1 — a broadcast that fires twice, or at 3 a.m. local time, is a real incident. |

#### LK-A-19 — Compose refusals

| | |
|---|---|
| **Do** | Try to send with: no subject; no body and no attachment; no recipients selected; SMS selected on a camp with **no Telnyx number**; email selected on a camp with **no contact email**; a 10,000-character body; an emoji-only subject. |
| **Expect** | Each refused or delivered with a clear statement of what will and will not go out. SMS with no number must not silently succeed. |
| **Verify** | `select telnyx_number from camps where id='<UUID>';` — migrations 075/076. |
| **If it fails** | `sendCompose` (2748), `formatOutgoingSms` in `campistry_broadcast_core.js`. |
| **Sev** | S2 |

---

## 5.4 — Forms

#### LK-A-20 ★ CORE — Build a form

| | |
|---|---|
| **Do** | **New Form** → **Build a Form**. Add each field type from the palette. Reorder, duplicate and delete fields. Preview. **Use This Form**. Save. |
| **Expect** | The preview is what the parent sees. It saves and appears in the Forms list. |
| **If it fails** | `openFormBuilder` (3749), `fbAddField` (3774), `renderFbCanvas` (3789), `useBuiltForm` (3890). |
| **Sev** | S2 |

#### LK-A-21 — Upload a form

| | |
|---|---|
| **Do** | **Upload a Form** with a PDF, then a `.docx`, then a `.jpg`. Then a 40 MB file and a file with a 200-character name. |
| **Expect** | Accepted types attach and are downloadable by the parent. Oversized refused with a message. |
| **If it fails** | `fcFileChosen` (1600), `_renderFcAttach` (1614), `saveFormTemplate` (1641). |
| **Sev** | S3 |

#### LK-A-22 ★ CORE — Responses

| | |
|---|---|
| **Do** | After parents submit (Part 6), open **Responses**. Drill down the tree, use breadcrumbs, search, export CSV and XLSX, open the sheet view, download a filled PDF and an uploaded document. |
| **Expect** | Every submission present and attributed to the right camper. The XLSX opens in Excel. Answers containing commas, quotes and newlines survive the CSV round-trip. |
| **If it fails** | `renderReceivedTree` (3333), `exportResponsesCSV` (3502), `exportResponsesXLSX` (3509), `downloadFilledPdf` (3983), `campistry_link_export.js`. |
| **Sev** | S2 |

#### LK-A-23 — Delete a form with responses

| | |
|---|---|
| **Do** | Delete a form template that has submissions. |
| **Expect** | Warned; responses preserved or explicitly removed with consent. |
| **If it fails** | `deleteFormTemplate` (1708), `deleteSentForm` (1727). |
| **Sev** | S1 |

---

## 5.5 — Lists

#### LK-A-24 — Create and scope a list

| | |
|---|---|
| **Do** | **New List**. Name it, describe it, scope it (Everyone / division / grade / bunk), paste 10 items one per line. Save. Broadcast it. Edit it. Delete it. |
| **Expect** | It appears for exactly the scoped families in the portal, and for nobody else. |
| **If it fails** | `openListEditor` (3650), `saveListEditor` (3669), `onListScopeChange` (3628), `broadcastToList` (3604), migration `014_link_lists_rpc.sql`. |
| **Sev** | S2 |

#### LK-A-25 — List abuse

| | |
|---|---|
| **Do** | A list with zero items; 500 items; an item of 500 characters; an item containing `<b>bold</b>`; a list scoped to a bunk you then delete in Me. |
| **Expect** | No crash. HTML rendered as text. A list scoped to a deleted bunk shows to nobody, or is flagged — not to everyone. |
| **Sev** | S3 — "shows to everyone" would leak a bunk-specific instruction camp-wide. |

---

## 5.6 — Parents

#### LK-A-26 ★ CORE — Eligibility and bulk invite

| | |
|---|---|
| **Do** | Read the Step 1 card. Click **Generate invites for all families**. Then **Download mail-merge CSV**. Then **Copy announcement email**. |
| **Expect** | Families are already eligible automatically; the button is a backfill. The CSV has one row per family with a working link. The announcement text names the portal URL. |
| **Verify** | `select count(*) from link_parent_invites where camp_id='<UUID>';` equals the family count. |
| **If it fails** | `bulkInviteAll` (4076), `downloadParentMailMerge` (4294), `copyParentAnnouncement` (4269), migration 032. |
| **Sev** | S2 |

#### LK-A-27 ★ CORE — Sync Parent Portals

| | |
|---|---|
| **Do** | Move a camper to a different family in Me. Then click **Sync Parent Portals**. Sign in as each parent. |
| **Expect** | Each parent sees exactly their own children — **no parent ever sees a child who is not theirs**. This button exists precisely because that went wrong. |
| **If it fails** | `bulkInviteAll` (4076), `_syncParentInviteSnapshot` (`campistry_me.js:11375`), migration 033. |
| **Sev** | S1 |

#### LK-A-28 ★ CORE — Access requests

| | |
|---|---|
| **Do** | Have a parent sign up with an email that is **not** on the roster. Find them under Access Requests. Match them to a family and approve. Then reject one. Then approve one to the **wrong** family and fix it. |
| **Expect** | Approving links them to exactly that family's children. Fixing a mis-match removes the wrong children from their portal. |
| **If it fails** | `_renderJoinRequests` (4196), `resolveJoinReq` (4234). |
| **Sev** | S1 |

#### LK-A-29 — Families table

| | |
|---|---|
| **Do** | Read the table: status badges, children, links. Use Refresh. |
| **Expect** | Statuses (invited / claimed / not eligible) match reality. |
| **If it fails** | `_renderParentFamilies` (4157), `_pgStatusBadge` (4138). |
| **Sev** | S3 |

#### LK-A-30 — Bulk invite at scale

| | |
|---|---|
| **Do** | Run bulk invite on a camp with 500 families (BRK-01). |
| **Expect** | Progress is shown, it completes, and nothing times out silently. Note the time. |
| **Sev** | S2 |

---

## 5.7 — Photos

Needs migrations 028–031, 040, 080, 081, 082 and the storage bucket. Skip cleanly
if absent. Face recognition runs **entirely in the browser**; only descriptors are
stored.

#### LK-A-31 ★ CORE — Consent gates everything

| | |
|---|---|
| **Do** | With a parent who has **declined** photo consent, upload a photo containing their child. |
| **Expect** | That child is **not** matched, not tagged, and their photo is not shown to other parents. Consent is the gate, not a preference. |
| **Verify** | `_siblingEnrolledSet` / `buildFaceIndex` in `campistry_link_photos.js` (278); parent side `checkPhotoConsent` (4817). |
| **Sev** | S1 — this is biometric data. |

#### LK-A-32 — Build the index

| | |
|---|---|
| **Do** | With reference photos uploaded by parents, click **Force Re-sync**. |
| **Expect** | The badge moves to built, with a count. |
| **If it fails** | `buildIndex` (4331), `ensureFreshIndex` (252), `getIndexVersion` (235), migrations 029/031. |
| **Sev** | S2 |

#### LK-A-33 ★ CORE — Upload and auto-triage

| | |
|---|---|
| **Do** | Upload 20 photos. Set auto-accept to 85% and auto-reject to 40%. Apply to the current queue. Turn on self-tune, resolve a few review items, and see whether the dials move. |
| **Expect** | Strong matches auto-tag; weak ones are dropped; the middle waits for review and is **invisible to parents** until approved. |
| **If it fails** | `batchUploadAndScan` (686), `applyTriageToQueue` (4568), `_maybeSelfTune` (1101), `FACE_RECOGNITION_V2.md`. |
| **Sev** | S2 |

#### LK-A-34 — Triage abuse

| | |
|---|---|
| **Do** | Set accept **below** reject. Set both to 0. Set both to 100. Mark a division "extra careful" that has no campers. |
| **Expect** | An inverted pair is refused or normalised — never a state where a photo is both auto-accepted and auto-rejected. |
| **If it fails** | `updateTriageDials` (4557), `refreshTriageUI` (4381). |
| **Sev** | S3 |

#### LK-A-35 — Upload abuse

| | |
|---|---|
| **Do** | Upload: 300 photos at once; a HEIC; a 0-byte file; the same photo twice; a photo with 30 faces; a 50 MP image; a `.txt` renamed `.jpg`. |
| **Expect** | Duplicates deduped by content hash. Invalid files skipped with a message. The browser does not freeze — note if the tab becomes unresponsive. |
| **If it fails** | `handlePhotos` (4347), `_contentHash` (1483), `_processOne` (713), the worker pool (531). |
| **Sev** | S2 |

#### LK-A-36 — Unknown faces and review

| | |
|---|---|
| **Do** | Assign an unknown-face cluster to a camper. Dismiss another. Then delete that camper in Me and reopen the page. |
| **Expect** | Assigning tags every photo in the cluster and teaches the engine. A cluster assigned to a since-deleted camper does not crash the page. |
| **If it fails** | `assignUnknownCluster` (1024), `dismissUnknownCluster` (1058), `resolvePendingTag` (1123). |
| **Sev** | S3 |

#### LK-A-37 — Coverage

| | |
|---|---|
| **Do** | Open Photo Coverage. |
| **Expect** | It names the campers with fewest photos this week — the shot list. Numbers match the gallery. |
| **If it fails** | `getCoverageReport` (1317), `refreshCoverage` (4487). |
| **Sev** | S4 |

#### LK-A-38 ★ CORE — Season close-out

| | |
|---|---|
| **Do** | On the throwaway camp only: run **Delete All Face Data**, first without and then with "also delete the gallery". |
| **Expect** | A serious confirmation. Afterwards every face descriptor and reference headshot is gone; with the box ticked, the photos too. **Irreversible, and it must actually delete** — this is the retention promise in the consent language. |
| **Verify** | `select count(*) from …` the face tables → 0. Migration `040_face_purge.sql`. |
| **Sev** | S1 — a purge that leaves biometric data behind is a legal exposure, not a bug. |

#### LK-A-39 — Send the roundup

| | |
|---|---|
| **Do** | **Preview**, then **Send Roundup**. |
| **Expect** | Each parent receives only their own child's photos. Preview matches what is sent. |
| **If it fails** | `generatePhotoRoundup` (1387), `sendPhotoRoundup` (1450). |
| **Sev** | S1 — a roundup containing another family's children is the same failure class as LK-A-27. |

---

## 5.8 — Tips Setup

#### LK-A-40 — Suggested tip by role

| | |
|---|---|
| **Do** | Set an amount for each role. Then try $0, `-5`, `1000000`, `12.345`, and blank. |
| **Expect** | Sensible amounts save and reach the parent portal. Negative refused. The empty-state card appears if no positions are configured, and points at Me → Hiring → Positions. |
| **If it fails** | `_renderRoleTips` (4704), `setRoleTipAmount` (4724), `_linkPositions` (4697). |
| **Sev** | S2 |

#### LK-A-41 — Tip history and export

| | |
|---|---|
| **Do** | After a parent tips (Part 6), open the history and export CSV and XLSX. |
| **Expect** | Every tip listed with amount, staff member and date. Totals match Me → Payroll → Tip Payments. |
| **If it fails** | `_renderTipHistory` (4777), `_exportTips` (4765), `_mergedTipLog` (4753). |
| **Sev** | S2 |

#### LK-A-42 — Staff payments card

| | |
|---|---|
| **Do** | Read the Staff Payments card. |
| **Expect** | It states that handles and Stripe status are managed in **Me → Payroll → Tip Payments** — and the link there works. It must not be a second, divergent editor. |
| **Sev** | S4 |

---

## 5.9 — Realtime and persistence

#### LK-A-43 ★ CORE — What updates without a refresh

| | |
|---|---|
| **Do** | Leave the admin page open on Messages. From the parent portal on another device: send a message, submit a form, tick a list item, send a tip, upload a reference photo, request access. |
| **Expect** | State, for each one, whether it appears live, on a poll, or only after a manual refresh. A message must not sit unseen for an hour. |
| **If it fails** | `boot` (4833), `_initCloudSubs` (4851), `_pollMsgs` (4866), `loadCloudMessages` (`campistry_link_data.js:356`). |
| **Sev** | S2 |

#### LK-A-44 — Two admins at once

| | |
|---|---|
| **Do** | Two admins open the inbox. One replies, the other archives the same message at the same moment. |
| **Expect** | Both actions survive, or the loser is told. Never a message that silently reverts. |
| **Sev** | S2 |

#### LK-A-45 — Persistence

| | |
|---|---|
| **Do** | Reload, log out and in, second device. |
| **Expect** | Messages, forms, lists, branding, triage dials and tip config identical. |
| **Verify** | Link's own store: `select key from camp_state_kv where camp_id='<UUID>' and key like 'link%';` plus the `link_*` tables. |
| **Sev** | S2 |

---

## 5.10 — Provider matrix

Fill this in for the camp under test and put it in the report. Most "Link is
broken" findings are a row of this table being empty.

| Feature | Needs | If not configured, the UI should |
|---|---|---|
| Email broadcast | camp contact email + the email service (migration `196_camp_email_service.sql`) | say so before sending |
| SMS broadcast | Telnyx number (075/076) | refuse SMS, not silently drop it |
| Push notifications | `push_tokens` (054–056, 066) | fall back to in-app |
| Photos | storage bucket (080) | hide the photo upload |
| Photo purchases | 081/082 + `link-photo-checkout` | hide the buy button |
| Tips by card | camp Stripe Connect (057, 078) | show handles only (Venmo/PayPal/Cash App/Zelle) |
| PDF forms | 110/111 + `get-pdf-form-urls` | offer print-and-return instead |
