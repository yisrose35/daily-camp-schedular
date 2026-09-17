# Part 2 — Campistry Me: Registration, Hiring & Leads

Covers: the camper application pipeline, sessions/bundles/capacity/waitlist, the
four form builders (registration, post-acceptance, staff application, post-hire),
every public-facing form page, acceptance → enrollment → parent invite, staff
hiring, contracts and offers, onboarding, offboarding, and the inquiry CRM.

**Files:** `campistry_me.js`, `campistry_register.html`, `campistry_staff_apply.html`,
`campistry_postaccept.html`, `campistry_posthire.html`, `campistry_contract.html`,
`campistry_inquiry.html`, `campistry_acceptance_letter.js`, `campistry_enrollment_window.js`,
`campistry_deposit_policy.js`, `campistry_card_capture.js`, `campistry_sibling_discount.js`.

**Migrations this part depends on:** 083, 084, 085, 086, 088, 090, 112, 113, 114,
164 (public deposit policy), 184, 185, 186, 187, 189, 190. If any are missing,
the public pages will load but fail on submit — check Part 0.2 first.

---

## 2.0 — The two state machines

Write these down; every card below is a transition on one of them.

**Camper enrollment status** — `applied → accepted → enrolled`, with branches:

| From | Action | To | Side effects |
|---|---|---|---|
| `applied` | Accept | `accepted` | Acceptance letter/invite may auto-send. Deposit becomes due. |
| `applied` | Waitlist | `waitlisted` | Nothing charged. |
| `applied` | Decline | `declined` | Terminal. |
| `waitlisted` | Accept | `accepted` | Also reached automatically by `autoPromoteWaitlist` when a seat frees. |
| `accepted` | Enroll | `enrolled` | **Creates the camper on the roster**, posts tuition to the ledger, applies sibling discount, provisions the parent invite, creates the canteen account. |
| `accepted` | Rescind | `withdrawn` | Credits what was posted, per the cancellation policy. Leaves an audit entry. |
| `enrolled` | Unenroll (Roster) | `unenrolled` | Credits withdrawals. Camper leaves the "today" slice. |
| `withdrawn`/`declined` | Re-add | `waitlisted` | |
| any non-terminal | camper deleted | record **deleted** | See ME-R-15/16. |

**Staff status:** `applied → screening → interview → reference → offered → hired`,
plus `declined` from anywhere (and `declined → applied` to reopen).

**Lead status:** `new → contacted → tour → applied → enrolled`, plus `lost`.

---

## 2.1 — The registration pipeline

#### ME-G-01 ★ CORE — The pipeline renders

| | |
|---|---|
| **Do** | Me → Registration. |
| **Expect** | A list of applications with status chips, newest first. Enrolled campers are **not** in this list — they are on the Roster. |
| **If it fails** | `renderRegistrationPage` (1966), `buildPipelineList` (2440), `_renderRegistrationPane` (2514). |
| **Sev** | S2 |

#### ME-G-02 ★ CORE — Office manual entry

| | |
|---|---|
| **Do** | **+ Add Application**. Fill camper, parents, session, everything. Save. |
| **Expect** | Appears at `applied`. Marital-status and "other parent at camp this summer" toggles reveal/hide the right fields. |
| **If it fails** | `addApplication` (10725), `appMaritalChanged` (10667), `appToggleOtherParentSummer` (10674). |
| **Sev** | S2 |

#### ME-G-03 — Review an application

| | |
|---|---|
| **Do** | Open an application. Read every section. Add a note. Print it. |
| **Expect** | Every answered question shows, including custom questions and custom sections. Uploaded documents open. Print produces a readable one-page-per-applicant sheet. |
| **If it fails** | `viewApplication` (9915), `saveAppNote` (10240), `printApplication` (10245). |
| **Sev** | S3 |

#### ME-G-04 ★ CORE — Accept → Enroll

| | |
|---|---|
| **Do** | Accept an application, then Enroll it. |
| **Expect, in order** | (1) status → `accepted`; (2) the acceptance letter / parent invite goes out if auto-send is on; (3) status → `enrolled`; (4) **the camper appears on the Roster**; (5) tuition is posted to the family ledger; (6) a canteen account exists in Snacks; (7) the parent can sign in to Link and see the child. |
| **Verify** | Billing → that family: exactly **one** tuition charge. Snacks → Accounts: the camper is listed. Link → Parents: the family is invite-eligible. |
| **If it fails** | `updateEnrollStatus` (10923), `enrollCamper` (11769), `_postTuitionFor` (3859), `_autoProvisionParentInvites` (11221). |
| **Sev** | S1 |

#### ME-G-05 ★ CORE — Accept the same application twice

| | |
|---|---|
| **Do** | Accept, then Enroll, then click Enroll again (use two tabs if the button disappears). |
| **Expect** | **One** camper, **one** tuition charge, **one** invite. |
| **Verify** | Sum the ledger. A doubled tuition charge is S1. |
| **Sev** | S1 |

#### ME-G-06 — Bulk status change

| | |
|---|---|
| **Do** | Tick several applications, use the bulk bar to accept them all. Then tick all with the header checkbox. |
| **Expect** | The bulk bar shows the count. All change. Nothing outside the selection is touched. |
| **If it fails** | `toggleAllEnroll` (10971), `_updateRegBulkBar` (10975), `bulkEnrollStatus` (10980). |
| **Sev** | S2 |

#### ME-G-07 ★ CORE — Rescind after enrolling

| | |
|---|---|
| **Do** | Enroll a camper, take a $500 payment against their tuition, then Rescind. |
| **Expect** | Status → `withdrawn` with an audit entry. The posted tuition is **credited**, not deleted — the $500 payment stays on the record, and the family is now in credit. The cancellation policy decides how much is forgiven. |
| **Verify** | The family ledger shows charge, payment and credit as three separate posted entries. The balance is arithmetically right. |
| **If it fails** | `rescindEnrollment` (8138), `_creditWithdrawalsFor` (3710), `_withdrawalQuotes` (3678), `campistry_cancellation_policy.js`, `tests/withdrawal_lifecycle.test.js`. |
| **Sev** | S1 |

#### ME-G-08 — Delete an application

| | |
|---|---|
| **Do** | Delete a `declined` application. Then try to delete one that is `accepted`. |
| **Expect** | Declined deletes cleanly. Accepted either refuses or warns about the ledger. An application that has money behind it must not vanish quietly. |
| **If it fails** | `deleteApplication` (8180). |
| **Sev** | S1 |

---

## 2.2 — Sessions, bundles, capacity and the waitlist

#### ME-G-09 ★ CORE — Capacity and waitlist

| | |
|---|---|
| **Do** | Set `1st Half` capacity to 2 (Dashboard → Sessions). Accept two campers into it. Now accept a third. |
| **Expect** | The third is refused or auto-waitlisted with a clear message. |
| **Verify** | Console: `await CampistryDB.getClient().rpc('session_capacity_state', {p_camp_id: CampistryDB.getCampId()})` |
| **If it fails** | `_sessionCapacityOf` (11755), `autoPromoteWaitlist` (11730), migration `190_session_capacity.sql`, `tests/session_capacity.test.js`. |
| **Sev** | S2 |

#### ME-G-10 ★ CORE — Waitlist auto-promotion

| | |
|---|---|
| **Do** | With the session full and one camper waitlisted, rescind one of the enrolled campers. |
| **Expect** | The waitlisted camper is promoted (or offered for promotion) — and only **one** of them if several are waiting. |
| **Sev** | S2 |

#### ME-G-11 — Race the last seat

| | |
|---|---|
| **Do** | One seat left. In two browser tabs, accept two different applications into it at the same moment. |
| **Expect** | One succeeds, the other is refused. **Not both.** |
| **Sev** | S1 — capacity enforced only in the browser is capacity not enforced. |

#### ME-G-12 — Bundles

| | |
|---|---|
| **Do** | Dashboard → Sessions → **+ Add Bundle**. Make a bundle of both halves with its own price. Register a camper for the bundle. |
| **Expect** | The public form offers the bundle. Tuition posted is the **bundle price**, not the sum of the two sessions. |
| **If it fails** | `_dashRenderBundleSessionChecks` (`dashboard.js:2662`), `_freshBundles` (10694), migrations `090`/`114`. |
| **Sev** | S1 |

#### ME-G-13 — Overlapping and impossible sessions

| | |
|---|---|
| **Do** | Create a session whose end date is **before** its start. Create two sessions that overlap. Create one with no dates. |
| **Expect** | Inverted dates refused. Overlap allowed but stated. A session with no dates is shown as unusable for presence/planning, not silently accepted. |
| **Sev** | S2 — a dateless session breaks every presence check downstream (ME-R-04). |

---

## 2.3 — The registration form builder

The builder is a split view: settings on the left, a **live iframe of the real
public form** on the right.

#### ME-G-14 ★ CORE — Build and preview

| | |
|---|---|
| **Do** | **Customize Registration Form**. Toggle sections on/off, reorder sections by drag, add a custom question of each type, add a custom section, add a rich-text block, add a document row, add a promo code row. Watch the preview after each change. |
| **Expect** | The preview updates live. Nothing saves until **Save Configuration**. |
| **If it fails** | `openFormBuilder` (8750), `_fbPushPreview` (8683), `_collectFormConfigDraft` (8518), `saveFormConfig` (9811). |
| **Sev** | S2 |

#### ME-G-15 — The preview fails visibly

| | |
|---|---|
| **Do** | Block the iframe (DevTools → Network → block `campistry_register.html`) and reopen the builder. |
| **Expect** | The explicit failure panel appears — **not** a silent grey box. A retry button works once unblocked. |
| **If it fails** | `_fbPreviewOk` (8818), `_fbWatchPreview` (8825), `_fbRetryPreview` (8846). |
| **Sev** | S3 |

#### ME-G-16 — Builder abuse

| | |
|---|---|
| **Do** | Save a form with: zero sections enabled; 50 custom questions; two questions with the identical label; a question label containing `{{child_name}}`; a rich-text block containing `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>`; a required question with no options; a section dragged to the very top. |
| **Expect** | Saves or refuses with a message. **The script and the onerror image are stripped** — open the public form and confirm nothing executes. Duplicate labels are allowed but the responses must still be distinguishable. |
| **If it fails** | `_sanitizeRichHtml` (9265), `_readCustomQuestions` (9130), `_readCustomSections` (9310). |
| **Sev** | S1 for the script; S3 otherwise. |

#### ME-G-17 — Payment methods and the deposit card

| | |
|---|---|
| **Do** | In the builder, tick which payment methods the camp accepts. Note that **debit is deliberately not offered** where a balance can be drawn back out as cash. Configure the registration deposit (flat / percentage / per-session), and whether an application is even looked at before it is paid. |
| **Expect** | Saved policy shows on the public form, and is what Snacks later allows for canteen deposits. |
| **Verify** | Console on any page: `window.CampistryPayments && CampistryPayments.readSettings?.()`; and `select * from camp_state_kv where key='campistryMe'` → the payment policy blob. |
| **If it fails** | `campistry_payments.js`, `campistry_deposit_policy.js`, `_dpCardHtml` (16469), `_pmBuilderCardHtml` (16574). |
| **Sev** | S2 |

---

## 2.4 — The public registration form

Open `campistry_register.html?camp=<CAMP_UUID>` **in a private window, signed out,
on a different device if you can.** That is the only way to test what a real
parent gets — a signed-in tab hides every anon-access bug.

#### ME-G-18 ★ CORE — A real submission from a clean browser

| | |
|---|---|
| **Do** | Private window. Open the registration link. Fill everything. Submit. |
| **Expect** | The form loads (it resolves the camp from the URL, not from a session), submits, and shows "Application Submitted". Within seconds it appears in Me → Registration. |
| **Verify** | Network tab: `get_public_form_config` 200, `submit_public_application` 200. |
| **If it fails** | `PUBLIC_FORM_CAMP_ID_FIX_SETUP.md`, `PUBLIC_FORM_SUBMIT_FIX_SETUP.md`, migrations 083/084/184. **This has historically been completely broken** — the write was rejected by RLS every time and the parent saw success. Check the office actually received it, not just the thank-you screen. |
| **Sev** | S1 |

#### ME-G-19 — Public form abuse

| | |
|---|---|
| **Do** | On the public form try each of: submit twice by double-clicking; press back and re-submit; edit `camp` in the URL to another camp's UUID; edit it to garbage; remove it entirely; submit with every field empty; submit a 10 MB document; paste `'; drop table camps;--` into a name; submit after the enrollment window has closed; submit for a session at capacity. |
| **Expect** | One record per real submission — a double-click must not create two. A foreign camp UUID must not let you write into that camp. A closed window refuses. Capacity refuses or waitlists. Nothing 500s. |
| **Verify** | `select count(*) from camp_state_kv …` / the pipeline list — count the records. |
| **If it fails** | migration `184_public_submission_cannot_overwrite.sql`, `tests/public_submission_ids.test.js`. Note the commit message *"Stop treating a camp id as a password"* — a camp UUID is public, so the server, not the URL, must decide what you may write. |
| **Sev** | S1 |

#### ME-G-20 ★ CORE — The registration deposit is collected

| | |
|---|---|
| **Do** | With a deposit configured and the camp on a real processor, complete the form and pay the deposit. |
| **Expect** | The card is accepted **before** the form can be submitted — the money refuses at the door, not after the form is filled in. On return, the application exists and shows the deposit as paid. |
| **Verify** | The family ledger shows the deposit as a posted payment. `select * from camp_state_kv …` / the processor's own dashboard. |
| **If it fails** | `campistry_card_capture.js`, `registration-deposit-checkout` edge function, migrations 185/186/187/189/194. |
| **Sev** | S1 |

#### ME-G-21 — Deposit with no processor connected

| | |
|---|---|
| **Do** | Same, on a camp with **no** processor. |
| **Expect** | The form either does not offer card payment at all, or says clearly that the camp will invoice. Never a pay button that dead-ends. |
| **Sev** | S2 |

#### ME-G-22 — Abandon the payment

| | |
|---|---|
| **Do** | Reach the processor's page, then close the tab. Then repeat and press Back. Then repeat and pay, but close the tab before the return redirect. |
| **Expect** | No half-created application that blocks a retry. If money was taken, it is recorded when you next open the camp. |
| **Sev** | S1 |

#### ME-G-23 — Application status page

| | |
|---|---|
| **Do** | Open the link with `?status=` for a submitted application. |
| **Expect** | Shows the real status. An unknown id shows "Application Not Found", not an error. |
| **If it fails** | `get_public_application_status`, migration `113`. |
| **Sev** | S3 |

#### ME-G-24 — Send link, QR, embed

| | |
|---|---|
| **Do** | **Send Link** to an email. **Show QR**. **Embed** → copy the snippet and paste it into a blank local HTML file opened from disk. |
| **Expect** | The email arrives. The QR scans to the right URL on a phone. The embedded iframe loads and submits from a foreign origin. |
| **If it fails** | `openSendRegLinkModal` (10465), `showLinkQR` (10421), `openEmbedLinkModal` (10371), `copyEmbedSnippet` (10384). |
| **Sev** | S3 |

---

## 2.5 — Post-acceptance form

#### ME-G-25 — Configure and send

| | |
|---|---|
| **Do** | Customize the post-acceptance form (shirt size, bunkmate requests, medical, custom questions). Accept a camper; send the post-acceptance link (or let it auto-send). |
| **Expect** | The parent receives it. Submitting writes back onto **that same application record**, and bunkmate requests appear in Bunk Builder → Bunk Requests. |
| **If it fails** | `openPostAcceptFormConfig` (9653), `_autoSendPostAccept` (10550), `_syncPostAcceptBunkRequests` (5731), `get_postaccept_bootstrap`, migration 085. |
| **Sev** | S2 |

#### ME-G-26 — Submit the post-acceptance form twice

| | |
|---|---|
| **Do** | Submit it, then open the same link again. |
| **Expect** | "Already Submitted" — not a second record, and not an overwrite of the first without warning. |
| **Sev** | S2 |

#### ME-G-27 — Post-acceptance link for a rescinded camper

| | |
|---|---|
| **Do** | Send the link, then rescind the enrollment, then open the link. |
| **Expect** | Refused gracefully ("Form Not Available"), not a crash and not a submission into a withdrawn record. |
| **Sev** | S3 |

---

## 2.6 — The parent invite chain

#### ME-G-28 ★ CORE — Invites are provisioned automatically

| | |
|---|---|
| **Do** | Enroll a camper with a parent email. Then go to Link → Parents. |
| **Expect** | The family is already sign-up-eligible **without anyone clicking anything** — the button there is only a backfill. |
| **Verify** | `select * from link_parent_invites where camp_id='<UUID>';` |
| **If it fails** | `_autoProvisionParentInvites` (11221), `_scheduleAutoParentInvites` (11197), `upsert_parent_invite` RPC, migrations 008/011/033/034/087. |
| **Sev** | S2 |

#### ME-G-29 ★ CORE — An invite must not hand over the wrong child

| | |
|---|---|
| **Do** | Two families share a parent email by mistake (do this deliberately). Run **Sync Parent Portals** from Link → Parents. Then sign in as that parent. |
| **Expect** | State exactly which children that parent sees. If they can see a child who is not theirs, that is the worst bug in this plan. |
| **Verify** | `select * from link_parent_invites where parent_email='<the email>';` |
| **If it fails** | `_syncParentInviteSnapshot` (11375), `_sweepOrphanedParentInvites` (11211), migration `033_upsert_preserve_claim.sql`. |
| **Sev** | S1 |

#### ME-G-30 — Invite after a camper is deleted

| | |
|---|---|
| **Do** | Delete an enrolled camper whose parent has already claimed their portal account. |
| **Expect** | The child disappears from the parent's portal (migration 124 hides disconnected children) but the parent's login still works and still shows any balance owed (migration 070). |
| **Sev** | S1 |

#### ME-G-31 ★ CORE — The acceptance letter

One letter now replaces the bare portal invite, so this card and the five after
it are worth doing carefully.

| | |
|---|---|
| **Do** | Accept a camper with auto-send on. Read the email that arrives, end to end. |
| **Expect** | It says how to get into Link, and carries the access code, the **camper ID**, the **camp number**, and the `campNumber-camperId` payment reference that makes a Zelle payment credit itself. Branded per the camp's Link branding. |
| **If it fails** | `campistry_acceptance_letter.js` (pure, and unit-tested), `_letterExtrasFor` (11691), `_inviteEmailFor` (11658), `send-invite-email`, migrations `149_camp_number.sql`, `088_camp_person_seasons.sql`. |
| **Sev** | S2 |

#### ME-G-32 ★ CORE — Every part disappears cleanly

| | |
|---|---|
| **Do** | Accept a camper on a camp with **no camp number** set. Then one with no access code yet. Read each letter. |
| **Expect** | The reference section is simply **absent** — never `Camper ID: undefined` in a letter that has already gone to every family. Each missing fact removes its own section and nothing else. |
| **Verify** | The builder reports what it could not say; the preview should name it. |
| **If it fails** | `campistry_acceptance_letter.js` — its `missing` list. |
| **Sev** | S1 — a malformed letter cannot be unsent. |

#### ME-G-33 ★ CORE — Preview and send are the same letter

| | |
|---|---|
| **Do** | Open the invite modal and read the preview. Then send. Compare the two word for word. |
| **Expect** | Identical. The modal used to carry a **third** hand-written copy of the body, so the office previewed one letter and the parent received another with nothing to say so. The preview now renders from the same builder that sends, and it names anything the letter could not say — while it can still be fixed. |
| **If it fails** | `_fillInvitePreview` (11609), `_showInviteModal` (11522). |
| **Sev** | S1 |

#### ME-G-34 ★ CORE — A reference the matcher will accept

| | |
|---|---|
| **Do** | Take the `campNumber-camperId` reference out of a real letter and use it as the memo on a Zelle/ACH deposit (Part 3, ME-B-26). |
| **Expect** | The deposit inbox matches it to that family automatically. The letter must never print a reference shape the matcher does not recognise. |
| **Verify** | `node --test tests/acceptance_letter.test.js` — it holds the letter's reference rule against `campistry_deposit_match.js`'s. |
| **Sev** | S1 — a reference nobody can place is the exact problem this letter exists to solve. |

#### ME-G-35 ★ CORE — Automatic sending is gated on paying for email

| | |
|---|---|
| **Do** | On a camp whose **email service is off** (or not on its plan), accept a camper. Then switch emailing on and accept another. |
| **Expect** | With emailing off: **nothing is sent automatically**, and the office is told why in plain language — either "Emailing is switched off for this camp" or "Your plan does not include emailing". Crucially the invite is **still created**: the access code exists and the modal still sends by hand exactly as before. With emailing on: the letter goes automatically. |
| **Expect also** | The gate covers **both** automatic emails, not only this one — check the post-acceptance form auto-send too. |
| **Verify** | `select proname from pg_proc where proname like '%email_service%';` (migration `196_camp_email_service.sql`). |
| **If it fails** | `_emailServiceOn` (11033), `_emailBlockedReason` (11049), `_autoSendParentInvite` (11109), `_autoSendPostAccept` (10550). |
| **Sev** | S1 — a camp that quietly stops telling families they were accepted will not find out until the families do. |

#### ME-G-36 — Auto-send is on by default

| | |
|---|---|
| **Do** | On a camp that has never touched the setting, accept a camper. Then turn auto-send off and accept another. |
| **Expect** | On by default — accepting a family and telling them nothing is not a state any camp wants. Turning it off leaves the modal working exactly as it did. |
| **If it fails** | `_autoInviteOn` (11067). |
| **Sev** | S2 |

#### ME-G-37 — Invite with no camp contact email

| | |
|---|---|
| **Do** | Clear the camp contact email on the Dashboard and try to send an invite. |
| **Expect** | A clear message naming the missing setting. Not a silent no-op, and not a message claiming success. |
| **Sev** | S2 |

---

## 2.7 — Hiring

#### ME-H-01 ★ CORE — The staff pipeline

| | |
|---|---|
| **Do** | Me → Hiring. Add a staff application manually. Advance it: Applied → Screening → Interview → Reference → Offered → Hired. Decline another, then reopen it. |
| **Expect** | Each stage saves and the chip colour changes. The "next stage" button always offers the correct next step. |
| **If it fails** | `setStaffStatus` (7920), `_staffNextStage` (7369), `addStaffApp` (8023). |
| **Sev** | S2 |

#### ME-H-02 — The public staff application

| | |
|---|---|
| **Do** | Private window → `campistry_staff_apply.html?camp=<UUID>`. Submit. |
| **Expect** | Arrives in Hiring at `applied`. Same abuse list as ME-G-19 applies — run it here too. |
| **If it fails** | `get_public_form_config` / `submit_public_application` with the staff kind, migration 112. |
| **Sev** | S1 |

#### ME-H-03 — Staff form customizer

| | |
|---|---|
| **Do** | Customize the staff application: positions list, certifications list, custom questions. Add a position, rename one, delete one that somebody already holds. |
| **Expect** | Deleting a held position is handled — say what happens to the staff member holding it, and to the **suggested tip** configured for it in Link. |
| **If it fails** | `openStaffFormConfig` (9537), `addPositionRow` (9458), `_readChipList` (9470); Link side: `_linkPositions` (`campistry_link_admin.html:4697`). |
| **Sev** | S2 — an orphaned tip role means parents are offered a tip for a job nobody holds. |

#### ME-H-04 ★ CORE — Offer and contract

| | |
|---|---|
| **Do** | On an `offered` candidate, open the contract modal, set pay type and rate, fill from session, save, and copy the contract link. Open that link in a private window and accept it. |
| **Expect** | The candidate sees the offer, accepts, and Me shows it accepted. On acceptance the person is **synced into Payroll** with their pay terms. |
| **Verify** | Me → Payroll → Staff: the record exists with the right rate. `select * from camp_state_kv where key='campistryMePayroll';` |
| **If it fails** | `openStaffContractModal` (7734), `saveStaffContract` (7770), `_syncAcceptedContractsToPayroll` (7801), `get_contract_offer`/`accept_staff_contract`, migration 085. |
| **Sev** | S1 |

#### ME-H-05 — Contract link abuse

| | |
|---|---|
| **Do** | Accept the contract twice. Open the link after the candidate was declined. Change the `id` in the URL to another candidate's. |
| **Expect** | Second acceptance is a no-op. A declined candidate's link refuses. A guessed id does not expose someone else's offer or pay rate. |
| **Sev** | S1 — a contract link leaking another person's salary is a privacy breach. |

#### ME-H-06 — Post-hire form

| | |
|---|---|
| **Do** | Configure the post-hire form (t-shirt size, arrival date, housing, emergency contact, handbook upload, policy rows). Send it to a hired candidate. Submit it. |
| **Expect** | Answers land on that staff record. The handbook is downloadable. Policy acknowledgements are recorded individually. |
| **If it fails** | `openPostHireFormConfig` (9751), `_autoSendPostHire` (10616), `get_posthire_bootstrap`, migration 086, `POST_HIRE_FORM_SETUP.md`. |
| **Sev** | S3 |

#### ME-H-07 — Onboarding checklist and references

| | |
|---|---|
| **Do** | Tick each onboarding item (signed contract, I-9, W-4, background check, orientation). Cycle a reference through its states. |
| **Expect** | Persist through reload. |
| **If it fails** | `toggleOnboard` (7981), `cycleRef` (7982). |
| **Sev** | S4 |

#### ME-H-08 ★ CORE — Hire → assign to a bunk → invite to Lite

| | |
|---|---|
| **Do** | Hire someone, assign them to `A1` as Counselor, and invite them to Campistry Lite. |
| **Expect** | They appear as bunk staff in Me, as a tip recipient in the parent portal for `A1` children, and receive the Lite invite. |
| **If it fails** | `assignHiredToBunk` (6854), `_autoInviteHiredToLite` (7970), `inviteBunkStaffToLite` (6909), migration `018_counselor_role_campistry_lite.sql`. |
| **Sev** | S2 |

#### ME-H-09 ★ CORE — Offboard a hired staff member

| | |
|---|---|
| **Do** | Decline / offboard someone who is assigned to a bunk, has timesheets in Payroll, has a connected tip account, and has a Lite login. |
| **Expect** | A clear warning listing what will happen. Afterwards: removed from the bunk, their **timesheets and pay history are kept**, their Lite access is revoked, and parents are no longer offered them as a tip recipient. |
| **Verify** | Payroll still shows their hours. The parent portal no longer lists them. |
| **If it fails** | `_cascadeStaffOffboard` (7853), `_declineHiredStaff` (7892), `_restoreStaffOffboard` (7880). |
| **Sev** | S1 |

#### ME-H-10 — Undo an offboard

| | |
|---|---|
| **Do** | Offboard, then restore. |
| **Expect** | Bunk assignment, payroll link and access all return. |
| **If it fails** | `_restoreStaffOffboard` (7880). |
| **Sev** | S2 |

#### ME-H-11 — Export staff

| | |
|---|---|
| **Do** | Export staff CSV. Open it in Excel. |
| **Expect** | Correct columns, and names with commas/apostrophes/newlines are properly quoted. A cell starting `=` must be escaped — see ME-R-31's formula row. |
| **If it fails** | `exportStaffCSV` (8123), `dlCsv` (18198). |
| **Sev** | S2 |

---

## 2.8 — Leads / inquiry CRM

#### ME-L-01 — The inquiry form and pipeline

| | |
|---|---|
| **Do** | Open `campistry_inquiry.html` for the camp, submit an inquiry. In Me, find it under Leads. Move it through New → Contacted → Tour → Applied → Enrolled. Set a follow-up date, log an activity, add notes, delete one. |
| **Expect** | Each stage persists. The follow-up date surfaces somewhere useful. Export produces a clean CSV. |
| **If it fails** | `renderLeads` (7224), `setLeadStatus` (7315), `addLeadActivity` (7318), `exportLeadsCSV` (7336), `copyInquiryLink` (7335). |
| **Sev** | S3 |

#### ME-L-02 — Lead → application linkage

| | |
|---|---|
| **Do** | Move a lead to `applied`, then have that family actually submit the registration form. |
| **Expect** | State whether the two records are linked or remain separate. A duplicate that nobody can reconcile is a finding. |
| **Sev** | S3 |

---

## 2.9 — Persistence for Part 2

| | |
|---|---|
| **ME-G-38 Do** | Hard-reload, log out, log back in, open on a second device. |
| **Expect** | Every application, status, form configuration, contract and onboarding tick is identical everywhere. |
| **Verify** | `select key, jsonb_array_length(coalesce(value->'…','[]')) from camp_state_kv …` — or simply diff the console blob between the two devices. |
| **Sev** | S1 |

**Form configurations live inside `campistryMe`** alongside the roster — which
means a stale tab in the form builder can clobber roster changes made elsewhere.
That is BRK-10 in Part 9; do not skip it.
