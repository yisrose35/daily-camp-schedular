# Public Form Submissions — Critical Fix — Setup

**Every submission through Registration, Staff Applications, and the
Post-Acceptance form has been silently failing to reach your camp.** This
is not new breakage from recent work — it's a pre-existing gap: these
three public pages have always tried to write directly into `camp_state_kv`
from the visitor's own browser using only the public anon key (no login),
but that table's RLS has only ever allowed an authenticated owner/admin to
write to it. The write was rejected every time.

- **Registration** and **Staff Applications** made it worse by showing
  "Success!" regardless of whether the cloud write actually worked — so
  every applicant who ever submitted believed it went through. It only
  ever landed in their own browser's local storage.
- The **Post-Acceptance form** at least showed an error on failure, which
  means it has simply never been submittable at all until now.

## The fix

Three narrow SECURITY DEFINER RPCs, deliberately granted to `anon` (the one
deliberate exception to this session's usual "revoke from anon" pattern —
these exist specifically to be public). Each can only touch one specific
part of `campistryMe`:

- `submit_public_application(camp_id, kind, entry_id, entry)` — `kind` is
  locked to `'enrollments'` or `'staffApplications'` only.
- `submit_postaccept_response(camp_id, enroll_id, postaccept)` — can only
  attach a `postAccept` object onto an enrollment that already exists,
  never create a new one.

Both merge atomically in a single SQL statement server-side, which also
closes a smaller pre-existing risk: two families submitting around the
same moment could previously have clobbered each other under the old
read-modify-write-from-the-browser approach.

## 1. Run the migration

```
083_public_application_submit.sql
```

Paste into the Supabase SQL Editor. Safe to re-run.

## 2. No edge function changes

This is pure SQL — no edge functions were touched, nothing to redeploy.

## 3. Verify end to end

1. Open your public Registration link in an incognito window (no login),
   fill it out, submit.
2. Log in as the camp owner/admin, open People → Pipeline — confirm the
   new application actually appears within a few seconds (you may need to
   reload the page once, since there's no realtime push for this yet — see
   below).
3. Repeat for the Staff Application link.
4. Send yourself (or a test camper) a Post-Acceptance form link, submit
   it, confirm the response actually lands on that camper's enrollment
   record — this is the one that\'s never worked before, so it\'s worth
   double-checking it saves correctly.
5. Try submitting Registration with your wifi turned off — confirm you
   now get a clear "could not reach the camp, check your connection"
   error instead of a false "Success!" screen.

## What's NOT in this pass

- **No rate limiting or spam protection** beyond a basic payload-size cap
  (8MB) on the RPCs — these are genuinely public, unauthenticated
  endpoints by design. If spam becomes a real problem, the fix is
  Supabase's own rate limiting or a CAPTCHA on the form, not a change to
  how these RPCs authorize.
- **No realtime push** when a new application arrives — the admin's People
  page picks it up on its normal load/refresh cycle, not instantly. Worth
  a future pass if instant visibility matters, but out of scope for this
  fix (which is about the write actually reaching the cloud at all).

## Migration SQL

See `migrations/083_public_application_submit.sql` for the full, commented
SQL — not duplicated here to avoid the two copies drifting apart.
