# Public Forms Never Knew Which Camp They Belonged To — Setup

**A real applicant clicking a real Registration, Staff Application, or
Post-Acceptance link — on their own device, having never touched
Campistry before — has likely never been able to load or submit these
forms correctly.** This is deeper than the anon-write RLS gap fixed in
migration 083. That fix closed the *write* path; this one closes the
*"which camp is this?"* path underneath it, which nothing has ever
addressed.

## What was actually broken

Every link Campistry generated for these forms (Copy Link, QR codes, Send
Link emails) was just `origin/campistry_register.html` — **no camp
identifier anywhere in the URL.** `getCampId()` in `supabase_client.js`
only ever resolves via an *authenticated* session's camp
membership/ownership; a logged-out public visitor has none, and
`detectCampAndRole()` returns immediately if there's no signed-in user.
Even when a camp id happened to be known, `camp_state_kv`'s RLS
(`camp_id = get_user_camp_id()`, migration 001) blocks anonymous `SELECT`
entirely — there was no way to read a camp's public form config,
sessions, or branding without being staff.

Net effect: a cold visitor saw a blank/generic form (no camp name, no
sessions, no custom fields) and got `no-client` on submit. Every prior
test that appeared to work was from a browser already logged into
Me/Dashboard on the same origin — the local `campGlobalSettings_v1` cache
papered over the gap. A genuine external applicant never had that.

## The fix

1. **Every generated link now embeds `?camp=<id>`** — `copyRegLink`,
   `copyStaffLink`, `showRegistrationQR`, `showStaffQR`,
   `openSendLinkModal`, and `_postAcceptUrl` (which also keeps its
   existing `?id=<enrollmentId>`), all in `campistry_me.js`.
2. **Two new anon-safe SECURITY DEFINER RPCs** (migration 084), the same
   deliberate exception to this session's "revoke from anon" pattern as
   migration 083's write-side RPCs — these exist specifically to be
   public:
   - `get_public_form_config(camp_id, kind)` — `kind` is `'registration'`
     or `'staff'`. Returns only the public-safe slice needed to render
     that form (camp name, form config, sessions, promo codes, school
     grades) — never the full `campistryMe` blob, which also holds
     enrollments, staff applications, families, and other office-only
     data.
   - `get_postaccept_bootstrap(camp_id, enroll_id)` — returns only the
     tiny slice of that **one** enrollment needed to render its
     post-acceptance form (camper's name, whether it's already been
     submitted) — never the full enrollment record (address, medical
     info, parent contact) and never any other family's data.
3. **Each public page reads `?camp=` and calls the matching RPC** as its
   authoritative data source, instead of relying on `getCampId()` or the
   local cache. The old local-cache read still runs first as a fast
   synchronous paint (useful when office staff are previewing/testing
   from a browser that's already logged in) — the cloud call then
   overwrites it with the real data once it resolves. **Old links already
   sent out (no `?camp=`) still work exactly as before** — they just fall
   back to the local-cache-only behavior, same as today.
4. **Submission now uses the resolved camp id first**, before falling
   back to the old `getCampId()`/local-storage guess — so a submission
   from a genuinely cold browser no longer depends on that guess
   succeeding at all.

## 1. Run the migration

```
084_public_form_bootstrap.sql
```

Paste into the Supabase SQL Editor. Safe to re-run.

## 2. No edge function changes

Pure SQL plus client-side HTML/JS — nothing to redeploy on the Edge
Functions side.

## 3. Verify end to end

1. Copy a fresh Registration link from Me → People → Get Link (or the QR
   code). Confirm the URL now has `?camp=<a uuid>` on it.
2. Open that link in a **fully cold browser profile** — incognito, or
   better, a different browser entirely, with no prior Campistry history.
   Confirm the camp name, sessions, and any custom fields render
   correctly (not blank/generic).
3. Submit a test application from that cold session. Confirm it appears
   in People → Pipeline within a few seconds.
4. Repeat for a fresh Staff Application link.
5. Accept a test camper, send yourself (or a test camper) a
   Post-Acceptance link, open it in a cold session, confirm the camper's
   name shows correctly and submission saves onto the right enrollment.
6. Try an **old-style link** without `?camp=` (e.g. one already sent out
   before this fix, if you have one saved) from a browser that's
   currently logged into Me on the same domain — confirm it still works
   exactly as before (this is the backward-compat fallback path).
7. Try a deliberately broken link (`?camp=00000000-0000-0000-0000-000000000000`)
   — confirm you get a clear "this link doesn't look right" message
   instead of a blank page or a silent failure.

## Related gap flagged, not fixed here

`campistry_contract.html` (staff hiring offer/contract page) does a
**direct** `camp_state_kv` `SELECT` as an anonymous client
(`campId`/`appId` from the URL, same pattern this fix replaces) — that
read is almost certainly blocked by the same RLS policy for the same
reason. Worth its own fast-follow using the same
`get_public_form_config`-style pattern (a narrow, whitelisted RPC scoped
to exactly what that one page needs), not expanded into this fix since it
wasn't part of what broke the three application forms.

## What's NOT in this pass

- **No change to `submit_public_application` / `submit_postaccept_response`**
  (migration 083) — those write-side RPCs were already correct; this pass
  only adds the missing read-side.
- **No rate limiting** on the two new RPCs beyond what migration 083
  already established elsewhere — same reasoning: genuinely public,
  unauthenticated endpoints by design.

## Migration SQL

See `migrations/084_public_form_bootstrap.sql` for the full, commented
SQL — not duplicated here to avoid the two copies drifting apart.
