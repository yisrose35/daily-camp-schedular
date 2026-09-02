# Email Verification + Login Lockout — Setup

Two things, both on the main Campistry login only (`index.html`/`landing.js`
for owner signup/login, `invite.html` for invited staff signing up or
signing in to accept an invite). Campistry Lite and the Link parent portal
are untouched — they have their own separate logins.

1. **Signup verification code.** Today `signUp()` hands anyone full access
   immediately, whether or not they actually own the email address they
   typed. This turns on Supabase's real email confirmation and switches it
   to a 6-digit code (not a click-through link) entered right in the same
   modal — no new page, no custom email-sending code needed for this part,
   it's all built into Supabase Auth.
2. **Password lockout.** 5 wrong passwords on ONE login within a rolling 24
   hours locks just that email, with a self-service "reopen my account"
   link emailed to it — this is a ONE-TIME speed bump per streak: attempts
   1-4 show "N attempts left," attempt 5 locks + emails the link, and once
   you click it, attempts 6-9 do NOT re-lock or send another email — they
   just resume the "N attempts left" warning, now counting down toward 10.
   If the count reaches 10 within that same 24-hour window, it escalates to
   an office-only lock — and that escalation is camp-wide (every login at
   that camp, owner + staff, not just the one being guessed at). No more
   self-service unlock link at that point, someone has to clear it by hand
   in the SQL Editor (exact query at the bottom of migration 105, and in
   step 5 below). Two separate proactive emails go out the moment this
   happens: `campistryoffice@gmail.com` gets Campistry's own internal ops
   alert, and the CAMP OWNER (specifically — resolved via `camps.owner`,
   not just whoever triggered it) gets a customer-facing notice that their
   camp's sign-in is locked and to reach out to campistryoffice@gmail.com
   when ready to reopen it. Both are separate from `LOCKED_MESSAGE.office`,
   the message shown to whoever is actually trying to sign in — so a real
   attack (or a confused owner whose staff triggered it) surfaces
   proactively instead of only when someone calls in.

## 1. Run the migration

Paste `migrations/105_account_lockouts.sql` into the SQL Editor. Idempotent
— safe to paste again if you're not sure whether it already ran (including
if you already ran an earlier version of it before the camp-wide-lock,
office-alert, or one-time-email-tier additions — re-pasting the current
version picks all of that up, nothing needs to be dropped first; it adds
the `email_lock_used_at` column via `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` since the earlier `CREATE TABLE IF NOT EXISTS` is a no-op on a
table that already exists).

If you already deployed `secure-login` before these additions, redeploy it
with the current `supabase/functions/secure-login/index.ts` too — the office
alert email (step 5 below) and the office-lock message wording are new code
in that function, not just the SQL.

## 2. Deploy the edge function — and set the ONE setting that's easy to miss

- `secure-login` — **JWT verification OFF.** This is the step that's easy
  to skip and causes "Failed to send a request to the Edge Function" in the
  browser with no other clue why: this function is called by someone with
  **no session at all** (that's the whole point — it's the login itself,
  it's what proves who they are), so Supabase's gateway-level JWT check has
  nothing valid to check and rejects the request before it ever reaches the
  function's own code. Same reasoning, same fix, as `pos-pin-login` from
  the earlier Snacks POS login work. Turning this off is safe: nothing
  inside `secure-login` trusts the caller's JWT for anything — the real
  checks (is this account locked, is the password right) happen through
  the service-role client and GoTrue's own token endpoint, completely
  independent of whatever's in the Authorization header.

  In the Supabase Dashboard: Edge Functions → `secure-login` → Settings →
  turn off "Enforce JWT Verification" → redeploy. If you're deploying it
  for the very first time, there's usually a toggle right on the
  create/deploy screen instead — same setting, just look for it there.

Paste the contents of `supabase/functions/secure-login/index.ts`.

## 3. No new secrets

Uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
`RESEND_API_KEY` — all already set from prior work (the invite-email and
canteen/pos functions already use these same four). Nothing new to add.

If lockout emails aren't arriving but everything else here checks out,
confirm `RESEND_API_KEY` is actually set on **this** function too — Supabase
project secrets are shared across functions automatically, but it's worth
a quick check in Edge Functions → `secure-login` → Settings → Secrets if
something seems off.

## 4. Turn on email confirmation, and switch it to a code

Two changes, both in Authentication:

**a. Turn on "Confirm email"**
Authentication → Providers → Email → toggle **"Confirm email"** ON, if it
isn't already. This is what makes `signUp()` require verification before
handing back a session — without it, the whole verification-code screen
never appears (an account gets a session immediately, same as before).

**b. Switch the confirmation email from a link to a 6-digit code**
Authentication → Emails → **Confirm signup** template. Replace the default
body (which links to `{{ .ConfirmationURL }}`) with one that shows
`{{ .Token }}` instead — that's Supabase's own 6-digit OTP code, the same
one the app's "Enter the 6-digit code" screen calls
`supabase.auth.verifyOtp({ email, token, type: 'signup' })` with. Something
like:

```html
<h2>Confirm your Campistry account</h2>
<p>Enter this code to verify your email address:</p>
<h1 style="letter-spacing: 4px; font-size: 32px;">{{ .Token }}</h1>
<p>This code expires in 24 hours. If you didn't create a Campistry account, you can ignore this email.</p>
```

Save the template. (Optional: Authentication → Settings → "Email OTP
Expiration" controls how long the code stays valid — the default is
usually fine, change it here if you want something other than the
template copy above implies.)

**Note for invited staff (`invite.html`):** this same "Confirm signup"
template and toggle is what their first-time signup also uses — there's
only one signup email template in the project, shared by every account.

## 5. Handling an office-only lockout

There's no button for this on purpose — it only happens after 10 wrong
attempts in 24 hours, which should be rare and worth a human actually
looking at it before clearing it. It's also **camp-wide**: it locks every
login at that camp (owner + every accepted staff account), not just the
one that was being guessed at, so unlocking should clear all of them at
once too. Once you've confirmed with the camp owner that it's really them,
run this in the SQL Editor — you can pass ANY email from that camp, it
resolves the rest of the camp's logins on its own:

```sql
UPDATE account_lockouts SET lock_level = NULL, unlock_token = NULL,
    unlock_token_expires_at = NULL, updated_at = now()
  WHERE email IN (SELECT public._camp_lock_emails('any-email-from-that-camp@example.com'));
```

To check who's currently locked and at what level before clearing anything:

```sql
SELECT * FROM account_lockouts
 WHERE email IN (SELECT public._camp_lock_emails('any-email-from-that-camp@example.com'));
```

(An email-tier lock — one person hit 5 fails, the camp never reached 10 —
only ever affects that one row, and is meant to self-clear via the emailed
link rather than needing this.)

**You'll know before the camp tells you — and so will they.** The moment a
camp crosses into this tier, `secure-login` sends two emails:
- `campistryoffice@gmail.com` — subject "Camp locked out: 10 failed
  sign-ins on \<email\>" — listing every login that got locked. Internal,
  ops-facing.
- The camp **owner's** own email — subject "Your Campistry sign-in has
  been locked" — a plain-language notice that their camp's sign-in is
  paused and to reach out to campistryoffice@gmail.com when ready to
  reopen it. Customer-facing, sent even if the owner personally never
  failed a single attempt (a staff member's login triggering the lock
  still notifies them).

Both fire exactly once per lockout event (not once per subsequent attempt,
since a locked camp's further tries never even reach the code that would
resend them), via the same Resend setup as `stripe-risk-volume-monitor`'s
spike alerts — no separate secret needed.

**If either doesn't arrive**, in order of likelihood:
1. **It already fired in an earlier test.** Both are one-time-per-lockout
   by design — if the account was already at the office-lock level from a
   prior test round (you didn't run `clear_login_failures` or sign in
   successfully to reset it), this round's escalation isn't a NEW one, so
   nothing sends even though the lock message still displays correctly.
   Reset the test account between rounds to rule this out.
2. **Spam.** Every email this app sends — these included — currently goes
   out from `onboarding@resend.dev`, Resend's own shared testing domain,
   not a domain Campistry has verified. Gmail in particular can be picky
   about that. Worth checking spam before assuming it's broken, and worth
   verifying a real sending domain in Resend (Resend Dashboard → Domains)
   if this keeps happening — every `from:` in this codebase would benefit
   from that, not just this feature.
3. **A real send failure** — check Edge Functions → `secure-login` → Logs
   around the time of the 10th attempt for `office alert email failed:` /
   `office alert email threw:` (or the `owner lock notice` equivalents).
   Their absence entirely (not even an error) points back to #1.

## 6. Verify end to end

**Signup verification:**
- Sign up with a brand-new email on `index.html` — confirm you land on
  "Check Your Email" with a 6-digit code field instead of going straight
  to the dashboard.
- Enter the code from the actual email received — confirm it drops you
  into the dashboard with your camp created, same as before this change.
- Try "Resend Code" — confirm a second email arrives and the newer code
  also works.
- Try signing in with that same account BEFORE ever entering a code —
  confirm it routes you to the same code-entry screen instead of a dead
  "email not confirmed" error.
- Repeat the whole thing once on `invite.html` for an invited (non-owner)
  account — confirm the code screen appears there too and accepting the
  invite completes correctly after verifying.

**Password lockout:**
- Sign in with the correct email and a wrong password 5 times in a row —
  confirm the account locks and an email with a "Reopen My Account" link
  arrives.
- Try signing in again (even with the correct password) before clicking
  the link — confirm it's still rejected with the "check your email"
  message, not a normal wrong-password error.
- Click the link — confirm it lands on `index.html` with "Your account has
  been reopened" and that signing in with the correct password now works.
- Fail the password once more (attempt 6) — confirm you get a normal
  "Invalid email or password. 4 attempts left before your account locks."
  message, NOT another lockout — and confirm no second unlock email arrives.
- Fail 3 more times (attempts 7-9) — confirm the count keeps counting down
  (3, 2, 1 attempts left) with no re-lock and no further emails.
- Fail once more (attempt 10, still within the 24h window) — confirm THIS
  time the message reads "You have been locked out due to repeated failed
  sign-in attempts. Please contact campistryoffice@gmail.com in order to
  unlock your account." and no unlock email is sent (office tier has none).
- With a second staff login on the same camp (invite one if needed), try
  signing in with its correct password — confirm it's ALSO rejected with
  the office-lock message, even though it never failed a single attempt
  itself. That's the camp-wide part working.
- Check `campistryoffice@gmail.com`'s inbox — confirm the "Camp locked out"
  alert arrived and lists both logins. Check the camp OWNER's inbox too —
  confirm "Your Campistry sign-in has been locked" arrived there, even if
  the owner wasn't the login that actually failed 10 times. Fail the
  password a few more times on either login (still locked, so these are
  rejected before ever reaching the database) — confirm NO additional
  alert or notice emails come in for the same incident.
- Run the `SELECT` from step 5 — confirm every login at the camp shows
  `lock_level = 'office'` — then run the `UPDATE` from step 5 and confirm
  BOTH logins work again immediately with their correct passwords.
- Confirm a correct password on the first try (no prior failures) still
  signs in normally with no extra step.
