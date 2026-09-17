# Part 6 — Campistry Link: the parent portal (and the staff tips page)

`campistry_link_parent.html`, served at **link.campistry.org** (and `/link`), also
shipped as a Capacitor mobile app. This is the only part of Campistry a customer's
customer ever touches, so a bug here is visible to hundreds of families at once.

**Run every card in a private window or a second browser profile, signed out of
the staff side.** A tab that still holds a staff session hides whole classes of
bug.

Covers: authentication and account linking, My Children, Schedule, Messages,
Forms & Documents, Lists, Photos, Payments and Cards, Canteen, Camp Shop, Tips,
Pickup & Arrival, Camper Mail, Health, Emergency Information, Settings, feature
flags, and the staff tips page.

**Files:** `campistry_link_parent.html`, `campistry_link_staff.html`,
`campistry_reset.html`, `campistry_card_setup.html`, `campistry_pay_thanks.html`,
`parent_lockout_guard.js`, `campistry_push.js`, `campistry_ota.js`,
`campistry_link_capacitor.js`, `campistry_bio_native.js`, `campistry_haptics.js`,
`campistry_scan_to_pdf.js`.

---

## 6.1 — Getting in

#### LK-P-01 ★ CORE — Sign up with the roster email

| | |
|---|---|
| **Do** | Open the portal. Create an account with **the exact email on the roster** in Me. Enter the verification code from the mailbox. |
| **Expect** | The children connect **automatically** — no code, no personal link. You land on Home showing exactly their children. |
| **If it fails** | `parentSignUp` (6242), `_showVerifyCode` (6053), `_loadByUser` (6371), `_claimAndLoad` (6417), migrations 009/032/039. |
| **Sev** | S1 |

#### LK-P-02 ★ CORE — Verification code lockout

| | |
|---|---|
| **Do** | Enter a wrong code 6 times in a row. Then wait and try the right one. Then use **Resend**. |
| **Expect** | The account locks after the configured number of attempts, says so plainly, and says what to do. The right code after a lockout is still refused until the lockout clears. |
| **Verify** | `select * from account_lockouts where …;` — migration 105, `EMAIL_VERIFICATION_LOCKOUT_SETUP.md`. |
| **If it fails** | `parentVerifyCode` (6071), `parentResendCode` (6100). |
| **Sev** | S2 |

#### LK-P-03 ★ CORE — Sign up with an email that is NOT on the roster

| | |
|---|---|
| **Do** | Create an account with an unknown email. |
| **Expect** | You are **not** dropped into an empty portal. You are offered the "request access" path, which lands in Link admin → Access Requests (LK-A-28). |
| **If it fails** | `_showLinkAccount` (6116), `_requestAccessBlock` (6139), `parentRequestAccess` (6151). |
| **Sev** | S2 |

#### LK-P-04 ★ CORE — An invite token

| | |
|---|---|
| **Do** | Open the portal with an invite token in the URL. Claim it. Then open the **same token again** in a different browser. |
| **Expect** | The first claim works. The second is refused — a claimed invite must not hand a stranger a family's children. |
| **Verify** | `select token, claimed_by, claimed_at from link_parent_invites …;` — migrations 033/034/087. |
| **Sev** | S1 |

#### LK-P-05 — Invalid, expired and tampered tokens

| | |
|---|---|
| **Do** | Try: a garbage token; a token from the **other camp**; a token whose camper has since been deleted; no token at all. |
| **Expect** | "Link Not Valid" or the ordinary sign-in screen. Never another camp's data. |
| **If it fails** | `_showInvalidToken` (6181), `_validateThenShowSignup` (6446), migration `024_parent_rpcs_camp_scoped.sql`, `tests/camp_scoped_rpc_auth.test.js`. |
| **Sev** | S1 |

#### LK-P-06 — Sign in, sign out, forgot password

| | |
|---|---|
| **Do** | Sign out and back in. Use **Forgot password** and complete the reset on `campistry_reset.html`. Toggle password visibility. |
| **Expect** | The reset email arrives, the new password works, the old one does not. |
| **If it fails** | `parentSignIn` (6194), `parentForgotPassword` (5789), `_lkEmailRedirect` (6233), `campistry_reset.html`. |
| **Sev** | S2 |

#### LK-P-07 — Biometric unlock

| | |
|---|---|
| **Do** | On a device that supports it: accept the biometric offer, sign out, sign back in with biometrics. Then decline the offer on another device. Then enable it later from Settings. |
| **Expect** | Offered once, not nagged. Declining is remembered. It unlocks an existing session — it is not a password replacement on a new device. |
| **If it fails** | `_maybeOfferBio` (5960), `parentRunBio` (5905), `parentEnableBio` (5983), `campistry_lite_biometric.js`, `campistry_bio_native.js`. |
| **Sev** | S3 |

#### LK-P-08 ★ CORE — A parent account cannot open the staff apps

| | |
|---|---|
| **Do** | While signed in as a parent, navigate directly to `dashboard.html`, `campistry_me.html`, `flow.html` and `campistry_snacks.html`. |
| **Expect** | Bounced back to the portal every time. Not an empty staff page, not a partially-rendered one. |
| **If it fails** | `parent_lockout_guard.js`, migration `036_parent_camp_lockout.sql`. |
| **Sev** | S1 |

#### LK-P-09 — Multi-camp parent

| | |
|---|---|
| **Do** | Put the same parent email on the roster of **both** camps. Sign in. Switch camps. |
| **Expect** | A camp switcher appears; each camp shows only its own children, balance, canteen and messages. Nothing bleeds across. |
| **If it fails** | `_augmentOtherCamps` (5470), `_checkConnectableCamps` (5583), `_autoConnectInvites` (5591), migrations 041/042. |
| **Sev** | S1 |

#### LK-P-10 — Session-gated and enrollment-gated access

| | |
|---|---|
| **Do** | Sign in as the parent of `Second-Half Only` during the first half. Then as the parent of a camper who has been unenrolled. |
| **Expect** | Access follows the rules in migrations 035 and 039 — state exactly what each parent can see. A disconnected child is hidden (migration 124) but a balance owed is still reachable (migration 070). |
| **Sev** | S2 |

---

## 6.2 — Home, children, schedule

#### LK-P-11 — Home

| | |
|---|---|
| **Do** | Read every tile. Switch child. Switch camp. Open the avatar menu. |
| **Expect** | Tiles reflect real state (unread messages, outstanding balance, canteen balance, unsubmitted forms, unchecked list items). |
| **If it fails** | `_applyData` (5359), `_renderCamperSwitch` (1823), `_paintPaymentsHomeSub` (1366), `_updateListsHomeTile` (4160). |
| **Sev** | S3 |

#### LK-P-12 ★ CORE — My Children

| | |
|---|---|
| **Do** | Open each child. Read the card: bunk, division, camp details, **Bunk Staff**, reference photos, other camps. |
| **Expect** | The bunk matches Me. The staff listed are exactly the staff on that child's bunk — never the camp's whole staff list. |
| **If it fails** | `showChild` (3569), `_bunkStaffRowsHtml` (3580). |
| **Sev** | S1 for the staff list (privacy). |

#### LK-P-13 — Daily Schedule

| | |
|---|---|
| **Do** | Open Schedule. Change the date forward and back, including to a day with no schedule and to a date outside the camp's dates. |
| **Expect** | The right day's schedule. An empty day says so rather than showing yesterday's. |
| **If it fails** | `changeSchedDate` (3897). |
| **Sev** | S3 — showing the wrong day's schedule is worse than showing none. |

---

## 6.3 — Messages

#### LK-P-14 ★ CORE — Read, reply, compose

| | |
|---|---|
| **Do** | Open a message from the camp, reply. Compose a new message — check who you can address it to (camp contacts / routed staff). Archive, unarchive, delete. Swipe a row. |
| **Expect** | Everything round-trips to the Link admin inbox. Deleting on the parent side does not delete it for the office (migration 021/022). |
| **If it fails** | `renderMsgs` (3600), `sendMsgReply` (3765), `sendComposedMsg` (3855), `msgArchive` (3735), `deleteMyMsg` (3763). |
| **Sev** | S2 |

#### LK-P-15 — Message actions for forms and lists

| | |
|---|---|
| **Do** | Open a message with a form attached, and one with a list attached. Use the button in each. |
| **Expect** | It opens the right form/list for the right child, and returns you to the message afterwards. |
| **If it fails** | `_msgFormActionHtml` (3685), `_openFormFromMsg` (3725), `_openListFromMsg` (3721), `_parseMsgRefs` (4532). |
| **Sev** | S2 |

#### LK-P-16 — Message realtime

| | |
|---|---|
| **Do** | Leave the portal open on Messages. Send a message from the admin console. |
| **Expect** | It arrives without a manual refresh (migration 023 enables realtime for parents). If it needs a refresh, say so. |
| **Sev** | S3 |

#### LK-P-17 — Message abuse

| | |
|---|---|
| **Do** | Send a reply of 10,000 characters; one containing `<script>alert(1)</script>`; one that is only emoji; one with RTL Hebrew text; send 20 in a row quickly; reply to a thread the office has deleted. |
| **Expect** | Long text handled. Script rendered as text in **both** the portal and the admin inbox. No crash on a deleted thread. Note whether any rate limit exists. |
| **Sev** | S1 for the script (it would execute in the office's browser). |

---

## 6.4 — Forms & Documents

#### LK-P-18 ★ CORE — Fill a built form online

| | |
|---|---|
| **Do** | Open an assigned digital form for one child. Fill every field type. Sign the signature pad. Submit. Then open it again. |
| **Expect** | Submits once, shows as submitted, and the office sees it under Responses. Reopening shows it is already done. |
| **If it fails** | `openFillOnline` (6640), `submitFillOnline` (6996), `_foInitSig` (6719), `_submitFormResponseCloud` (4995), migration 013. |
| **Sev** | S2 |

#### LK-P-19 — Form validation

| | |
|---|---|
| **Do** | Submit with required fields empty. Submit with an **empty signature**. Submit with only whitespace in a text field. |
| **Expect** | Refused with the offending field named. An empty signature must not pass as a signature. |
| **If it fails** | `_foSigEmpty` (6738), `submitFillOnline` (6996). |
| **Sev** | S2 — a blank signature on a medical consent is a legal problem. |

#### LK-P-20 ★ CORE — Fill a PDF form online

| | |
|---|---|
| **Do** | Open a PDF form with detected AcroForm fields. Check the overlays sit on the right places on every page. Fill and submit. Download the filled PDF from the admin side. |
| **Expect** | Overlays aligned on all pages, including page 2+. The downloaded PDF carries the answers. |
| **If it fails** | `openFillOnlinePdf` (6755), `_foPdfRenderAllPages` (6806), `_foPdfPlaceFieldOverlay` (6859), `submitFillOnlinePdf` (6905), `submit-pdf-form-response`. |
| **Sev** | S2 |

#### LK-P-21 — Print & Return, and Scan

| | |
|---|---|
| **Do** | Download a blank print form. Upload a completed one. Then use **Scan** to photograph two pages with the camera. |
| **Expect** | The download works. The upload attaches and the office can open it. The scan produces one real multi-page PDF. |
| **If it fails** | `downloadBlankForm` (3018), `handleFormReturn` (3021), `scanFormReturn` (3087), `campistry_scan_to_pdf.js`. |
| **Sev** | S3 |

#### LK-P-22 — Upload abuse

| | |
|---|---|
| **Do** | Upload a 30 MB file; a 0-byte file; a `.exe` renamed `.pdf`; the same file twice. |
| **Expect** | Refused with a message where appropriate. No silent failure, no hung spinner. |
| **Sev** | S3 |

---

## 6.5 — Lists

#### LK-P-23 — Check items off

| | |
|---|---|
| **Do** | Open a list, tick items, reload. Tick an item on a **second device** and watch the first. |
| **Expect** | Ticks persist per child. State whether the second device syncs live or on refresh. |
| **If it fails** | `toggleListItem` (4090), `_listChecks` (4087), `_listAppliesToChild` (4098). |
| **Sev** | S3 |

#### LK-P-24 — List scoping

| | |
|---|---|
| **Do** | With a list scoped to `A1`, sign in as a parent whose child is in `B1`. |
| **Expect** | They do not see it. |
| **Sev** | S2 |

---

## 6.6 — Photos

#### LK-P-25 ★ CORE — Consent

| | |
|---|---|
| **Do** | On first visit to Photos, read the consent overlay. **Decline** it. Then sign in as another parent and **accept**. |
| **Expect** | Declining means no reference photos, no face matching, and no AI-filtered view — and it is honoured on the admin side (LK-A-31). Accepting unlocks the flow. The wording states what is stored and for how long. |
| **If it fails** | `checkPhotoConsent` (4817), `acceptPhotoConsent` (4831), `declinePhotoConsent` (4840), `_setFaceConsentAll` (4824). |
| **Sev** | S1 |

#### LK-P-26 — Reference photos

| | |
|---|---|
| **Do** | Upload reference photos for a child: one, two, three. Then try a fourth. Then upload a photo with **no face**, and one with **two faces**. |
| **Expect** | Up to three angles accepted. The fourth is refused or replaces one, with a message. A faceless photo is rejected with a reason, not accepted and silently useless. |
| **If it fails** | `handleRefPhoto` (3117), `_submitHeadshot` (3109), `_updateRefStatusText` (3193). |
| **Sev** | S3 |

#### LK-P-27 — Gallery and purchases

| | |
|---|---|
| **Do** | Browse the gallery, open a photo, buy the AI-filtered folder for one camper, buy an HD download, download the original. Then try to buy the same thing twice. |
| **Expect** | Only photos of your own children. A repeat purchase is either prevented or clearly a second purchase — never charged silently twice. |
| **Verify** | `select * from …` photo purchases; migrations 081/082; `link-photo-checkout`. |
| **If it fails** | `_loadParentPhotos` (3320), `_lkBuyPhoto` (3297), `_fetchOriginalAndDownload` (3505), `_loadMyPhotoPurchases` (3274). |
| **Sev** | S1 |

#### LK-P-28 — A photo tagged with a child who was deleted

| | |
|---|---|
| **Do** | Delete a camper in Me who appears in tagged photos. Reload the parent portal. |
| **Expect** | No crash. State what the parent sees. |
| **Sev** | S3 |

---

## 6.7 — Payments and cards

Branch on the camp's processor (PRE-05).

#### LK-P-29 ★ CORE — The balance is the same number

| | |
|---|---|
| **Do** | Open Payments. Compare the balance to Me → Billing for that family. |
| **Expect** | Identical, to the cent. This is invariant **I3**. |
| **Verify** | `select get_my_balance(...)` — migrations 046, 095, 096, 118, 152, 166, 173. |
| **If it fails** | `loadPayments` (1204), `_lkFamPlans` (1385), `tests/money_parity.test.js`. |
| **Sev** | S1 |

#### LK-P-30 ★ CORE — Pay the balance

| | |
|---|---|
| **Do** | **Pay now**. Pay in full with a new card. Then part-pay. Then pay when the balance is **$0**. Then when the family is **in credit** (negative balance). |
| **Expect** | Full and partial payments post and the balance drops immediately. Paying $0 or a credit balance is refused, not a $0 charge. |
| **Verify** | Me → Billing shows the payment within seconds. The posted ledger has it (**I2**). |
| **If it fails** | `payNow` (1668), `_lkPayConfirm` (1713), `_lkCheckout` (1051), `payments-checkout` / `stripe-checkout`. |
| **Sev** | S1 |

#### LK-P-31 ★ CORE — Double-tap Pay

| | |
|---|---|
| **Do** | Tap **Pay** twice rapidly. Then complete a payment and press the browser **Back** button, then re-submit. Then close the processor tab mid-payment and reopen the portal. |
| **Expect** | **One** charge in every case. If money was taken, the portal reflects it on return. A cancelled payment leaves no phantom entry. |
| **Verify** | The processor dashboard: count the charges. |
| **If it fails** | `_handleStripeReturn` (1107), `_handleBanquestReturn` (1164), `_lkGoToCheckout` (1118), migration `168_atomic_payment_writes.sql`. |
| **Sev** | S1 |

#### LK-P-32 — Cards on file

| | |
|---|---|
| **Do** | Cards page: add a card, add a second, set the second as default, remove the first, remove the default. Then try to pay with a card you have deliberately expired. |
| **Expect** | Add/remove/default all work. Removing the only card is handled (and autopay reacts). An expired card gives the gateway's decline in plain language. |
| **If it fails** | `_renderCardsList` (1286), `_addSavedCard` (1307), `_setDefaultCard` (1333), `_doRemoveSavedCard` (1350), migrations 139/151. |
| **Sev** | S1 |

#### LK-P-33 ★ CORE — Charge a saved card

| | |
|---|---|
| **Do** | Pay using the saved card ("Use your card on file?"). Confirm the confirmation overlay appears first. |
| **Expect** | A confirmation before any charge — never a one-tap charge with no confirm. |
| **If it fails** | `_lkPayChargeSaved` (1686), `lkChargeConfirm` (4413), `charge-saved-card`. |
| **Sev** | S1 |

#### LK-P-34 ★ CORE — Build a payment plan

| | |
|---|---|
| **Do** | Open **Build your payment plan**. Change the number of installments and the start date, watch the preview, save. Then build a whole-family plan. Then turn on autopay. |
| **Expect** | The preview sums exactly to the balance. Saving produces the same schedule Me shows. Autopay shows as on in both places. |
| **Verify** | Me → Billing → that family: the identical schedule. Migrations 115–118, 181. |
| **If it fails** | `openPlanBuilder` (1565), `_lkPlanRefreshPreview` (1599), `_lkPlanSave` (1616), `startAutopaySetup` (1511). |
| **Sev** | S1 |

#### LK-P-35 — Card fees shown before paying

| | |
|---|---|
| **Do** | With a surcharge or convenience fee configured (ME-B-20), start a payment. |
| **Expect** | The fee is shown **before** the parent commits, with the total. A cash-discount camp shows the discount instead. |
| **If it fails** | `campistry_card_fees.js`, `_payCardHtml` (1424). |
| **Sev** | S1 |

#### LK-P-36 — No processor connected

| | |
|---|---|
| **Do** | On a camp with no processor, open Payments. |
| **Expect** | The balance is shown, and the pay path is either hidden or says the camp will invoice. **Never** a pay button that dead-ends or silently opens the wrong processor. |
| **If it fails** | `_getCampProcessorInfo` (2282) — note its deliberate retry: a single dropped request used to fall through to Stripe for a Banquest camp. |
| **Sev** | S1 |

#### LK-P-37 — Payment history

| | |
|---|---|
| **Do** | Open Payment History after several payments and a refund. |
| **Expect** | Every entry, including refunds, with dates and amounts that sum to the balance change. |
| **If it fails** | `_renderPayHistory` (1652). |
| **Sev** | S2 |

---

## 6.8 — Canteen

#### LK-P-38 ★ CORE — Balance and transactions

| | |
|---|---|
| **Do** | Open Canteen for each child. Compare the balance and recent transactions to Snacks → Accounts. |
| **Expect** | Identical. Switching child switches account. A child with no account shows an empty state, not $0 pretending to be an account. |
| **If it fails** | `_activeCanteenChild` (2188), `switchCanteen` (2985), `_syncCanteenFromCloud` (5318), `_mapCanteenTx` (1013). |
| **Sev** | S1 |

#### LK-P-39 ★ CORE — Add funds

| | |
|---|---|
| **Do** | Add funds by each available route. Then try $0, a negative amount, $0.001, and $10,000. Then add funds on a camp with **no processor**. |
| **Expect** | Valid amounts open the right processor's checkout (Stripe → Stripe; Banquest → Campistry's card page in pay-now mode; Cardknox → its hosted checkout; none → the Add Funds path is hidden entirely). Invalid amounts refused. |
| **Verify** | The balance rises **only after** the money is actually taken — a parent must never be able to inflate their own child's balance for free. |
| **If it fails** | `addFunds` (2214), `_applyCanteenStripeGate` (2325), `payments-canteen-checkout`, migration 079/132, `CANTEEN_STRIPE_DEPOSITS_SETUP.md`. |
| **Sev** | S1 |

#### LK-P-40 ★ CORE — Spending controls

| | |
|---|---|
| **Do** | Set a daily limit. Tick **no cap**. Untick it. Set a limit **lower than what the child has already spent today**. Set a negative limit. |
| **Expect** | Saves (with the auto-save hint). The lower-than-spent case is handled explicitly — the register must not go negative because of it. Negative refused. |
| **Verify** | Snacks → Accounts shows the same limit; the POS enforces it (Part 7). |
| **If it fails** | `saveSpendingControls` (2385), `_limToggleNoCap` (2380), `_autoSaveSpendingControls` (2434), migration 026. |
| **Sev** | S1 |

#### LK-P-41 ★ CORE — Auto-reload

| | |
|---|---|
| **Do** | Set up auto-reload: pick day options, use a session preset, set a date range, set a threshold and an amount, choose **use family card**, save. Then turn it off. Then set an end date **before** the start date. Then set it to fire today and watch whether it fires **twice**. |
| **Expect** | Saves and shows its status in plain language. An inverted date range refused. The frequency cap prevents a second charge in the same window. |
| **Verify** | `select * from …` auto-reload config; migrations 109, 135, 138, 140–144, 180. |
| **If it fails** | `_renderAutoReload` (2547), `saveAutoReload` (2643), `_saveAutoReloadConfig` (2682), `turnOffAutoReload` (2670), `canteen-auto-reload`, `CANTEEN_AUTORELOAD_SETUP.md`. |
| **Sev** | S1 — an auto-reload that double-fires charges a parent twice, unattended. |

#### LK-P-42 — Charge the saved card for canteen

| | |
|---|---|
| **Do** | Use the "charge card on file" row for a canteen top-up, and the card-choice overlay for auto-reload. |
| **Expect** | A confirmation first. The balance moves once. |
| **If it fails** | `_lkCanteenChargeSaved` (2358), `arCardChoice` (4437), `_useFamilyCardForAutoReload` (2786), migration 138. |
| **Sev** | S1 |

---

## 6.9 — Camp Shop

#### LK-P-43 ★ CORE — Order

| | |
|---|---|
| **Do** | Browse the catalogue, pick a variant and size, add to cart, change quantity, place the order. Check it under Past Orders and in Snacks → Camp Shop. |
| **Expect** | The order appears both sides with the right lines and total. |
| **If it fails** | `renderShopCatalogue` (1979), `shopAddToCart` (2046), `shopPlaceOrder` (2108), `renderShopOrders` (2161), `campistry_shop_core.js`, migrations 047/052/167. |
| **Sev** | S1 |

#### LK-P-44 ★ CORE — Stock races

| | |
|---|---|
| **Do** | Set a variant to stock 1. Two parents (two browsers) add it and order at the same moment. Then order a variant with stock 0. Then order after the camp disables the shop while your cart is full. |
| **Expect** | Only one order succeeds for the last unit, or backorder is explicit. Stock 0 refused. A disabled shop refuses the order with a message, and does not take money. |
| **If it fails** | `_shopStock` (1911), `shopPlaceOrder` (2108), migration `107_gate_shop_and_mail.sql`. |
| **Sev** | S1 |

#### LK-P-45 — Shop not open

| | |
|---|---|
| **Do** | Turn the Camp Shop off in Dashboard → Link Programs. Reload the portal. |
| **Expect** | "The shop isn't open yet", the nav item gone, and the underlying action refused even if called directly. |
| **If it fails** | `lkLoadFeatures` (7788), migration 053/106/108. |
| **Sev** | S2 |

---

## 6.10 — Tips

#### LK-P-46 ★ CORE — Who is offered

| | |
|---|---|
| **Do** | Open Tips for a child in `A1`. |
| **Expect** | Only the staff on **that child's bunk**, each carrying the suggested amount for their role. Switching child switches the list. |
| **If it fails** | `_renderTipRecipients` (7172), `amtForRole` (7189), `_resolveTipTag` (7151). |
| **Sev** | S1 (privacy). |

#### LK-P-47 ★ CORE — Pay a tip

| | |
|---|---|
| **Do** | Tip one staff member by card. Then build a **cart** of tips for several and pay once. Check the fee note before paying. |
| **Expect** | The fee is disclosed. The staff member's balance rises by the **full tip** (Stripe splits it; Campistry's fee is on top). The tip shows in the staff tips page and in Me → Payroll → Tip Payments. |
| **Verify** | Migrations 016, 043, 057, 059, 078, 182; `stripe-connect-tip`, `stripe-connect-tip-cart`, `TIPPING_SETUP.md`. |
| **If it fails** | `confirmTip` (7539), `payTipCart` (7488), `_tipComputeFeeCents` (7358). |
| **Sev** | S1 |

#### LK-P-48 — Tip handles

| | |
|---|---|
| **Do** | For a staff member with Venmo / PayPal / Cash App / Zelle handles but **no** Stripe Connect, open their row. |
| **Expect** | The handles are offered with copy/deep-link buttons, and card payment is not falsely promised. |
| **If it fails** | `_tipHandlesFor` (7255), `_venmoUrl` (7263), `_copyTip` (7280). |
| **Sev** | S3 |

#### LK-P-49 — Tip abuse

| | |
|---|---|
| **Do** | Tip $0; a negative amount; $10,000; a custom amount with three decimals. Tip a staff member who was removed from the bunk after you opened the sheet. Double-tap Pay. |
| **Expect** | Invalid amounts refused. One charge per tap-pair. A removed staff member is handled per ME-S-18. |
| **Sev** | S1 |

---

## 6.11 — Pickup & Arrival

#### LK-P-50 ★ CORE — Each request type

| | |
|---|---|
| **Do** | Submit an **Early Pickup**, a **Late Arrival**, a **Pickup Change** and a **Bus Change**. Set an ETA. Check today's submitted requests. Report a child dropped off. |
| **Expect** | Each lands in Campistry Live / the office, with the right child, date and time. Status updates come back to the parent. |
| **Verify** | `select * from parent_pickup_requests where camp_id='<UUID>' order by created_at desc;` — migrations 025, 061–068, 093. |
| **If it fails** | `submitPickup` (4624), `selPickup` (4618), `pollPickupStatuses` (4758), `reportDroppedOff` (4733). |
| **Sev** | S2 |

#### LK-P-51 — Pickup edge cases

| | |
|---|---|
| **Do** | Request for **yesterday**; for a date next month; for 11:59 PM; two conflicting requests for the same child on the same day; a request for a child in the **other** camp; a request on a day the camp isn't running. |
| **Expect** | Past dates refused. Future dates allowed per migration 093 or refused with a reason. Conflicts flagged, not silently stacked. Cross-camp impossible. |
| **Sev** | S2 |

#### LK-P-52 — Status polling

| | |
|---|---|
| **Do** | Submit a request, leave the screen open, and have the office reply/approve it. |
| **Expect** | The parent sees the status change and the office's reply without re-submitting. Note the poll interval. |
| **If it fails** | `pollPickupStatuses` (4758), `hydratePickupRequests` (4287), migration 061/062. |
| **Sev** | S3 |

---

## 6.12 — Camper Mail, Health, Emergency, Settings

#### LK-P-53 — Write a letter

| | |
|---|---|
| **Do** | Write a letter to a child. Check My Letters. Then send one of 5,000 characters, one of emoji only, one in Hebrew, and one containing `<script>`. |
| **Expect** | Delivered to the camp's mail queue. Long text handled or capped with a counter. Script rendered as text. |
| **If it fails** | `sendCamperMail` (4251), `_renderMyMail` (4208), `_submitCamperMailCloud` (5035), migration 015/107. |
| **Sev** | S2 for the script. |

#### LK-P-54 — Health

| | |
|---|---|
| **Do** | Open Health: nurse visit log, medical, health documents. Upload a health document. |
| **Expect** | Only this parent's children. The document reaches Campistry Health. |
| **If it fails** | `switchHealth` (3097), `handleHealthDocUpload` (3519), `_loadMyHealthDocs` (3556), migration 037. |
| **Sev** | S1 (medical privacy). |

#### LK-P-55 — Emergency Information

| | |
|---|---|
| **Do** | Read the Emergency Information screen. |
| **Expect** | The camp's real emergency contacts, not a placeholder. |
| **Sev** | S2 — a placeholder phone number here is what a parent calls in an emergency. |

#### LK-P-56 — Settings

| | |
|---|---|
| **Do** | Change notification preferences, haptics, biometrics. Save. Reload. Then change them on a **second device**. |
| **Expect** | Persist per parent (migration 051). Push preferences actually change what arrives. |
| **If it fails** | `saveParentSettings` (3923), `_hydrateParentSettings` (3975), `applyParentPrefs` (4080), `campistry_push.js`. |
| **Sev** | S3 |

---

## 6.13 — Feature flags and the app shell

#### LK-P-57 ★ CORE — Turning a program off mid-session

| | |
|---|---|
| **Do** | With the parent's portal open, turn **Camper Mail** off in Dashboard → Link Programs. Have the parent navigate, then reload. |
| **Expect** | After reload the tile and nav item are gone. The underlying RPC refuses the action even if called directly — hiding the button is not the enforcement. |
| **Verify** | Console on the parent side: call the mail submit RPC directly and confirm it is refused. Migration 107. |
| **If it fails** | `lkLoadFeatures` (7788), `guard` (7777). |
| **Sev** | S1 — "hidden but callable" is not off. |

#### LK-P-58 — Navigation shell

| | |
|---|---|
| **Do** | Use the bottom nav and the "more" sheet on a phone width. Use the hardware/browser Back button from several screens. |
| **Expect** | Back goes where you expect and never exits to a blank page. |
| **If it fails** | `nav` (1758), `__navBack` (1774), `lkNavFromSheet` (7685). |
| **Sev** | S3 |

#### LK-P-59 — Offline and reconnect

| | |
|---|---|
| **Do** | Go offline (DevTools → Network → Offline). Navigate, try to send a message, tick a list item. Reconnect. |
| **Expect** | Clear offline messaging rather than silent failure. Anything queued syncs on reconnect, or the parent is told it did not send. |
| **Sev** | S2 — a parent who believes they sent "my child is sick today" and did not is a real-world incident. |

#### LK-P-60 — OTA update

| | |
|---|---|
| **Do** | In the native app, trigger an OTA update while a form is half-filled. |
| **Expect** | Either the draft survives or the parent is warned before the update. |
| **If it fails** | `campistry_ota.js`. |
| **Sev** | S3 |

---

## 6.14 — The staff tips page

`campistry_link_staff.html` — a single screen, no login, one access code.

#### LK-S-01 — Enter a code

| | |
|---|---|
| **Do** | Enter a valid access code. |
| **Expect** | Balance, total earned, total paid out, and recent tips showing only a first name plus an initial ("Avi K.'s family"). The code is remembered for next time. |
| **If it fails** | `get_staff_tip_account`, migrations 017/078. |
| **Sev** | S2 |

#### LK-S-02 ★ CORE — Code abuse

| | |
|---|---|
| **Do** | Enter: a wrong code; a code from the **other camp**; the code of a staff member who has been offboarded; a code in lower case; a code with the dash removed; 20 wrong codes in a row. |
| **Expect** | Wrong codes give the "doesn't match an account" message. Cross-camp codes resolve only within their own camp. An offboarded staff member's behaviour is stated. Note whether any rate limit exists — an 8-character code with unlimited guesses is brute-forceable. |
| **Sev** | S1 if there is no rate limit and the code space is small. |

#### LK-S-03 — Numbers agree

| | |
|---|---|
| **Do** | Compare this page's balance to Me → Payroll → Tip Payments and to Link admin → Tips history. |
| **Expect** | Three identical numbers. |
| **Sev** | S1 |

---

## 6.15 — Close-out

| | |
|---|---|
| **LK-P-61 ★ CORE Do** | Re-run LK-P-29 and LK-P-38: tuition balance and canteen balance, portal vs Me vs Snacks. |
| **Expect** | All still identical after everything above. |
| **Sev** | S1 |
