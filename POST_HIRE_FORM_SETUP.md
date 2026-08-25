# Post-Hire Form — Setup

**New feature.** Hiring now has a third form, alongside the Staff
Application and Offer & Contract: the **Post-Hire Form**, sent once a
candidate reaches the **Hired** stage, collecting onboarding logistics
(t-shirt size, arrival date, housing preference, emergency contact,
handbook acknowledgment, photo/media permission — all camp-configurable,
plus your own Custom Questions/Sections) back onto that same application
record.

This mirrors the camper Post-Acceptance Form exactly — same builder
pattern (Quick Setup / Advanced tabs, section toggles with inline
field-editing, Custom Questions, Custom Sections, branding), same public
form shape, same auto-send-on-trigger option.

## What's new

- **Customize Forms → Post-Hire Form** — new button in Hiring, next to
  "Staff Application Form". Build the form the same way you build
  Registration/Staff/Post-Acceptance: toggle built-in sections
  (Logistics, Emergency Contact, Acknowledgments) on/off, add your own
  fields inside a section or as standalone Custom Questions, reorder
  sections, brand it with your logo/color.
- **"Send automatically on hire"** toggle in the builder — when on, the
  form is emailed the moment an applicant is marked **Hired** (same
  pattern as Post-Acceptance's "on acceptance"). When off, send it
  yourself from the applicant's Review panel.
- **Review panel button** — once someone is Hired, a "Post-Hire Form"
  button appears in their Review panel footer (checkmarked once
  submitted), to send the link manually or resend it.
- **Answers show up in Review** — once a hire submits, a "Post-Hire Form
  Responses" section appears in their Review panel, same as Post-Acceptance
  answers do for campers.
- New public page `campistry_posthire.html` — a hire opens their unique
  link (`?camp=<id>&id=<applicationId>`), fills out the form, submits.
  No login required.
- **Staff Handbook attachment** — new "Staff Handbook" card in the builder
  lets you upload an actual PDF (max 8MB). When attached, a "View Staff
  Handbook" download link appears right next to the "Handbook
  Acknowledged" checkbox on the public form, so a hire has something real
  to read before checking it. Optional — the checkbox still works fine
  with no file attached, for camps that hand the handbook out in person.
- **Camp Policies & Requirements** — new builder card for camp-specific
  hard rules (e.g. "No smoking on camp grounds," "No smartphones during
  camp hours"). Add as many as you want; each becomes its own required
  checkbox on the public form, and the whole section ends with a typed
  signature ("Type your name to confirm you agree to the above"). Entirely
  hidden on the public form when no policies are configured. Answers
  (which policies were agreed to, the signature, and when) show up in the
  Review panel's Post-Hire Form Responses.

## 1. Run the migration

```
086_posthire_bootstrap.sql
```

Paste into the Supabase SQL Editor. Safe to re-run. Two new anon-safe
SECURITY DEFINER RPCs, same lockdown pattern as every other public-form
RPC this session:
- `get_posthire_bootstrap(camp_id, app_id)` — read-only, returns only the
  candidate's name + form config + already-submitted status, never any
  other applicant's data or the rest of the application record.
- `submit_posthire_response(camp_id, app_id, posthire)` — atomically
  merges the submission onto that one application, server-side.

## 2. No edge function changes

Pure SQL plus new client-side HTML/JS files — nothing to redeploy on the
Edge Functions side.

## 3. Verify end to end

1. Go to Hiring → Customize Forms → Post-Hire Form. Toggle a section,
   add a custom field, save — confirm the live preview reflects it.
2. Advance a test application through to **Hired**.
3. From their Review panel, click "Post-Hire Form" → Send. Confirm the
   link contains both `?camp=` and `&id=`.
4. Open that link in a cold browser (no prior Campistry login) — confirm
   the form loads with the right camp name and your configured fields,
   not blank/generic.
5. Submit it — confirm it lands, and that reopening the same link now
   shows "Already Submitted" instead of the form again.
6. Back in Me, reopen that applicant's Review panel — confirm "Post-Hire
   Form Responses" shows the submitted answers, and the footer button
   now shows a checkmark.
7. Turn on "Send automatically on hire" in the builder, then advance a
   *different* test application to Hired — confirm the email sends on
   its own (toast confirms), without you clicking Send.
8. Attach a test PDF as the Staff Handbook, save, open the public link —
   confirm the "View Staff Handbook" link appears and actually opens your
   PDF. Remove it, save, reload the link — confirm the link disappears.
9. Add 2-3 test policies (e.g. "No smoking," "No smartphones during
   camp hours"). Try submitting without checking all of them, or without
   typing a signature — confirm you're blocked with a clear message.
   Check all + sign + submit — confirm the Review panel shows which
   policies were agreed to and the signature.

## What's NOT in this pass

- **No rate limiting** beyond the same 8MB payload cap every other public
  RPC uses — genuinely public, unauthenticated endpoint by design.
- **No display of the original Staff Application's own Custom
  Questions/Sections** in the Review panel — that's a pre-existing gap
  unrelated to this feature (the Staff Application form has always
  collected `customAnswers`/`customSectionAnswers`, but `viewStaffApp`
  never rendered them back to staff). Flagged here for visibility, not
  fixed — a natural fast-follow if it turns out to matter.

## Migration SQL

See `migrations/086_posthire_bootstrap.sql` for the full, commented SQL —
not duplicated here to avoid the two copies drifting apart.
