# Link Program Settings — Setup

Lets a camp owner turn off any Link program their camp doesn't actually run
this year — Photos, Canteen, Camp Shop, Tips, Camper Mail, Pickup & Arrival —
so parents never see a way to sign up or pay for something that isn't
happening. Off is enforced two ways: parents never see the nav item/tile at
all (reuses the existing entitlements plumbing — see below), and the
underlying RPC/edge function refuses the action even if someone calls it
directly.

## 1. Run the migrations, in order

```
106_link_program_settings.sql
107_gate_shop_and_mail.sql
108_merge_program_settings_into_link_features.sql
```

All idempotent — safe to paste again if you're not sure whether one already
ran.

**What each one does:**
- **106** creates `camp_link_program_settings` (one row per camp, six
  booleans, default all `true`) plus `get_link_program_settings` (any signed-
  in user reads it), `set_link_program_settings` (owner/admin writes it —
  Dashboard → Camp Settings tab → Link Programs), and an internal helper
  other functions can call.
- **107** adds the actual server-side gate to the two purchase/submit RPCs
  that don't go through a Stripe edge function at all — `submit_shop_order`
  (Camp Shop) and `submit_camper_mail` (Camper Mail) — so those are blocked
  even without touching the parent app's UI.
- **108** is the important one for what parents actually SEE: this app
  already has a per-camp feature-entitlement system
  (`link_camp_features`/`get_my_link_features`, migration 053) that the
  parent app (`campistry_link_parent.html`) uses to hide nav items, bottom-
  nav buttons, the "more" sheet, and home tiles for anything a camp's plan
  doesn't include — and it already guards `nav()` itself so a deep link or
  browser back button can't reach a hidden page either. 108 folds the new
  owner-controlled toggles into that SAME mechanism, so **no new client-side
  code was needed in `campistry_link_parent.html` at all** — it already
  calls `get_my_link_features()` on every load and reacts to whatever comes
  back. A program disabled by either the platform (`link_camp_features`) or
  the owner (`camp_link_program_settings`) is hidden; the platform's "no"
  always wins over the owner trying to re-enable something their plan
  doesn't include.

## 2. Redeploy 4 existing edge functions (not new — just changed)

These already exist and are already deployed; paste the updated
`supabase/functions/<name>/index.ts` contents over what's there and redeploy
each. No JWT-verification setting to change — these already require (or
already work without) a session the same way they did before.

- `link-photo-checkout` — now checks `photos` before creating a Stripe
  session.
- `stripe-checkout` — now checks `canteen` before creating a canteen-deposit
  Stripe session (tuition payments are unaffected — this only applies to the
  `campistry-canteen-deposit` source).
- `stripe-connect-tip` — now checks `tips` before creating a single-tip
  Stripe session.
- `stripe-connect-tip-cart` — now checks `tips` for EVERY camp referenced in
  a multi-recipient cart before creating the session.

## 3. No new secrets

All four functions already had everything they need
(`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`). Nothing new
to add.

## 4. Turning a program off

Dashboard → Camp Settings tab (owner/admin only) → **Link Programs** card.
Six toggles, self-saving on change (no Save button — same as everywhere else
in this app that auto-saves). Turning one off takes effect immediately for
every parent on next load/nav.

## 5. Verify end to end

- As owner: Dashboard → Camp Settings → Link Programs → turn **Photos**
  off. Reload Link as a parent on that camp — confirm the Photos nav item,
  bottom-nav icon, and home tile are all gone. Try navigating directly (if
  you have a way to call `nav('photos')` from the console) — confirm it
  redirects to Home instead of opening the page.
- Try `link-photo-checkout` directly (e.g. via curl with a real parent
  session token) for that camp — confirm it's rejected with "This camp
  isn't offering Link Photos right now," not a normal ownership error.
- Turn Photos back on — confirm the nav item reappears on the parent's next
  load and the purchase flow works again.
- Repeat the same on/off/on cycle for **Canteen** (confirm both "Add Funds"
  disappears AND a direct `stripe-checkout` canteen-deposit call is
  rejected), **Camp Shop** (confirm the tab disappears AND `submit_shop_order`
  returns `program_disabled`), **Tips** (confirm both the single-tip and
  cart checkout paths reject), and **Camper Mail** (confirm
  `submit_camper_mail` returns `program_disabled`).
- Confirm **Pickup & Arrival** hides correctly too (client-side only for
  this one — there's no separate purchase edge function to gate).
- Confirm a camp that has never touched these toggles (no row in
  `camp_link_program_settings`) shows every program exactly as before this
  migration — nothing should change for an untouched camp.
- Confirm a camp with an existing `link_camp_features` billing restriction
  (if you have one to test with) still has that restriction honored even if
  every `camp_link_program_settings` toggle is on — billing's "no" wins.
