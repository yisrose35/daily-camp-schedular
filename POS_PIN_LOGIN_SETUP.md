# Snacks POS Email + PIN Login — Setup

Lets a camp owner give the canteen runner a login that opens **only**
`snacks.campistry.org`'s register — not their real Campistry account.
Login is the same email the owner uses to sign into Campistry, plus a PIN
standing in for a password. The PIN is a completely separate secret from
the owner's real account password: it's checked by its own function
against its own stored hash, and can only ever reach a hidden, read-
everything/write-only-Snacks "shadow" account, never the owner's real one.

## 1. Run the migrations, in order

```
100_pos_pin_login.sql
101_pos_pin_manual_unlock.sql
102_pos_pin_global_lookup.sql
103_pos_email_pin_login.sql
```

All four, in order, even though 102's PIN-only global-lookup design was
superseded by 103's email+PIN design a day later — 103 depends on 100/101's
table and columns, and its own DROP statements clean up everything 102
added. Skipping straight to 103 without 100-102 first will fail (the table
and columns it ALTERs won't exist yet). All four are idempotent — safe to
paste again if you're not sure whether one already ran.

## 2. Deploy the edge function — and set the ONE setting that's easy to miss

- `pos-pin-login` — **JWT verification OFF**. This is the step that's easy
  to skip and causes "Failed to send a request to the Edge Function" in
  the browser with no other clue why: this function is called by someone
  with **no session at all** (that's the entire point — it's the login
  itself), so Supabase's gateway-level JWT check has nothing valid to
  check and rejects the request before it ever reaches the function's own
  code — before the function's CORS headers even get a chance to be set,
  which is why the browser reports a generic network failure instead of a
  readable error. Same reasoning as `email-unsubscribe`/`telnyx-sms-webhook`
  in this codebase (both also JWT-off, both also called with no session).
  Turning this off is safe: nothing inside `pos-pin-login` trusts the
  caller's JWT for anything — the real checks (which camp, is the PIN
  right, is the register locked) all happen against the service-role
  client, completely independent of whatever's in the Authorization header.

  In the Supabase Dashboard: Edge Functions → `pos-pin-login` → Settings →
  turn off "Enforce JWT Verification" → redeploy. If you're deploying it
  for the very first time, there's usually a toggle right on the
  create/deploy screen instead — same setting, just look for it there.

Paste the contents of `supabase/functions/pos-pin-login/index.ts`.

## 3. No new secrets

Uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` —
already set from prior work, nothing new to add.

## 4. Verify end to end

- Manager Dashboard → Settings → set a register PIN (owner/admin only).
- Load `snacks.campistry.org` in a fresh/private browser window (no prior
  session) — confirm you land on the email + PIN login screen, not the
  register itself.
- Sign in with your real Campistry email + the PIN you just set — confirm
  it drops you straight into the selling console.
- Reload the page — confirm it stays logged in (no re-prompt).
- Click the lock icon in the top bar — confirm it signs out and the login
  screen reappears.
- Enter the wrong PIN 5 times in a row — confirm the 6th attempt (even
  with the CORRECT PIN) says the register is locked, and that it does
  **not** auto-clear after waiting. Go to the Manager Dashboard → Settings
  → click **Unlock Register** → confirm the PIN works again immediately.
- Confirm a wrong email (one with no Campistry account) gives the same
  generic "Incorrect email or PIN" message as a wrong PIN — it shouldn't
  reveal whether the email exists.
