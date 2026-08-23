# Non-Adopter SMS/Email Broadcast Fallback — Setup

Lets a Link broadcast (compose or scheduled) reach parents who never claimed
a Link account, via SMS and/or email, gated on their own consent. See
`/root/.claude/plans/bubbly-jingling-kite.md` (this session) for the full
design writeup.

## 1. Run migrations

```
071_link_adoption_status.sql
072_sms_opt_outs.sql
073_email_unsubscribes.sql
074_camp_contact_email.sql
```

Safe to re-run — every statement is `CREATE OR REPLACE` / `ADD COLUMN IF NOT
EXISTS`.

## 2. Deploy/redeploy edge functions

New:
- `telnyx-sms-webhook` — deploy with **JWT verification OFF** (public,
  authenticated instead by Telnyx's own request signature).
- `email-unsubscribe` — deploy with **JWT verification OFF** (public link
  clicked from an email client).

Changed (redeploy):
- `send-broadcast` — now requires a real caller session (owner/admin/
  scheduler), swapped Twilio → Telnyx for SMS, added consent + opt-out
  gating and idempotency, and pulls the sending camp's own address/contact
  email per-send (see below).
- `send-scheduled-broadcasts` — added consent/opt-out gating and real
  Telnyx SMS sending (was a stub before), same per-camp address/email pull.

## 3. Set secrets

```
supabase secrets set TELNYX_API_KEY=...
supabase secrets set TELNYX_FROM_NUMBER=+1...          # or TELNYX_MESSAGING_PROFILE_ID
supabase secrets set TELNYX_PUBLIC_KEY=...              # from the Telnyx portal, for webhook signature verification
supabase secrets set EMAIL_UNSUB_SECRET=$(openssl rand -hex 32)
supabase secrets set POSTAL_ADDRESS="..."                # fallback only — see below
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `RESEND_API_KEY` are already
set from prior work.

**CAN-SPAM address + Reply-To now come from each camp's own Dashboard**, not
a platform-wide secret. `camps.address` already existed (Dashboard → Camp
Profile → Address); migration 074 adds `camps.contact_email` alongside it
(Dashboard → Camp Profile → "Camp Contact Email") — both edit fields live in
the same Camp Profile card. Every fallback email's footer pulls `address`
for that camp, and sets `contact_email` as the Reply-To (so a parent's reply
lands in the camp's own inbox, not Campistry's). `POSTAL_ADDRESS` is only a
fallback for a camp that hasn't filled in its address yet — worth setting
so the footer is never blank, but it's no longer the primary source.

The `From:` address itself stays on Campistry's own verified sending domain
regardless — Resend (and every ESP) requires SPF/DKIM-verified domain
ownership to send `From:`, so a camp's own email can't be the raw sender
without that camp verifying their domain with Resend separately. Reply-To
is the correct mechanism for "replies reach the camp" without that
requirement.

## 4. Register the Telnyx inbound webhook

In the Telnyx portal → Messaging → your Messaging Profile → inbound webhook
URL, set:

```
https://<project-ref>.functions.supabase.co/telnyx-sms-webhook
```

This is what makes "reply STOP" actually work.

## 5. Verify end to end

0. Dashboard → Camp Profile → Edit → set an Address and a Camp Contact
   Email, Save. Confirm both show up in `SELECT address, contact_email FROM
   camps WHERE id = '<camp_id>'`.
1. Seed one parent with a claimed Link account and one with only an
   unclaimed invite, both in the same division, both with
   `smsEmailConsent:true` on their roster record.
2. In Link Admin → Messages → Compose, target that division, select
   Email and/or SMS alongside In-App, send.
3. Confirm: the claimed parent's message shows up in `link_messages`
   only; the unclaimed parent gets a real email and/or text; the toast
   reports the right split ("N saw it in Link, N by SMS, N by email").
4. Reply STOP from the test phone number → confirm a row lands in
   `sms_opt_outs` and a follow-up send to that number is silently skipped.
5. Click the unsubscribe link in a test email → confirm a row lands in
   `email_unsubscribes` and is honored on the next send.
6. Repeat the compose test using **Schedule** instead of **Send now** —
   confirm the same adopter/non-adopter split holds once
   `send-scheduled-broadcasts` fires.

## What's NOT in this pass (see the plan file's "Deferred" section)

- Counselor/Lite-side parity (same fallback for staff who never open Lite).
- Individual (non-broadcast) messages, payment reminders, pickup alerts,
  daily schedules — same non-adopter concept, different trigger points,
  each wireable onto this same consent/opt-out/idempotency foundation.
- Consolidating `campistry_me.js`'s separate Billing-page broadcast tool
  into this one (flagged as existing architectural duplication, not
  resolved here — its `send-broadcast` calls were updated to keep working
  under the new auth/consent model, nothing more).
