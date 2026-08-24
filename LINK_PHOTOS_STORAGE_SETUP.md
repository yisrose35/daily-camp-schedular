# Link Photos — Real Object Storage — Setup

Moves Link Photos off inline base64 bytes in the `link_photos` table and
onto real Supabase Storage, and — for the first time — actually **retains
the full-resolution original** upload instead of discarding it right after
face-matching runs. See `/root/.claude/plans/bubbly-jingling-kite.md`
("Link Photos — Phase 1") for the full design writeup.

This is Phase 1 of 3 (storage → camp paywall → parent payments). **This
pass does not add a camp paywall or any parent purchase flow** — it only
makes both possible later. Every photo already visible for free today
(the resized preview) stays visible for free; nothing here changes who can
see what, only how the bytes are delivered.

## 1. Create the `camp-photos` Storage bucket

The migration below includes `INSERT INTO storage.buckets (...)`, which
works fine pasted into the SQL Editor and is the simplest one-paste path —
use that first.

If it errors for you (some Supabase projects restrict direct writes to
`storage.buckets` from the SQL Editor), create the bucket by hand instead,
then re-run the migration (it uses `ON CONFLICT DO NOTHING`, so re-running
after a manual bucket creation is safe):

1. Supabase Dashboard → **Storage** → **New bucket**
2. Name: `camp-photos` (must match exactly — the RLS policy and the edge
   function both hard-code this name)
3. **Public bucket: OFF** — this must stay private. Nothing should ever be
   able to read a photo directly from the bucket; every view goes through
   the `get-photo-urls` edge function below, which mints short-lived
   signed URLs after checking who's actually allowed to see it.
4. Leave file size limit / allowed MIME types at their defaults, or cap to
   images if you'd like (`image/jpeg`, `image/png`) — not required, just a
   nice-to-have.

## 2. Run the migration

```
080_photo_storage.sql
```

Paste into the Supabase SQL Editor. Safe to re-run. Sets up:
- The bucket (§1, if not already created by hand)
- RLS on `storage.objects` for `camp-photos`: staff-only INSERT, **no**
  SELECT/UPDATE/DELETE policy for anyone — direct reads are always denied,
  by design (see below).
- `preview_path` / `original_path` columns on `link_photos` (the old
  `image_data` column stays, unused going forward — non-destructive).
- `save_scanned_photo` — no longer accepts/writes inline image bytes.
- New `set_photo_storage_paths` RPC — records where a photo's bytes landed
  after upload.
- `get_my_camper_photos` — no longer returns `image_data`, metadata only.
- New `get_viewable_photo_ids` RPC — batched parent-authorization check,
  used by the edge function below.

## 3. Deploy the new edge function

New:
- `get-photo-urls` — the **only** way anything in the app can ever
  actually see a photo now. JWT verification **on** (default) — requires
  a real parent or staff session, no anon-only path (unlike
  `stripe-checkout`'s documented residual gap, there's no legitimate
  reason for this one to be public). Mints short-lived (5 minute) signed
  preview URLs, after re-deriving authorization itself server-side —
  never trusts which photo ids the caller claims to be allowed to see.

Deploy via Supabase Dashboard → **Edge Functions** → `get-photo-urls` →
paste the contents of `supabase/functions/get-photo-urls/index.ts` →
Deploy.

## 4. Secrets

No new secrets — reuses `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, all already set from prior work.

## 5. Verify end to end

1. As staff, upload a batch of photos through the existing scan-and-tag
   flow in Link Photos. Confirm it completes with no errors.
2. In the Supabase Dashboard → **Storage** → `camp-photos`, confirm you
   see both `{camp_id}/preview/{photo_id}.jpg` and
   `{camp_id}/original/{photo_id}.jpg` objects for the photos you just
   uploaded.
3. In the **Table Editor** → `link_photos`, confirm the corresponding rows
   have `preview_path`/`original_path` populated and `image_data` is
   null/unused.
4. As a parent whose child is tagged in one of those photos: open Link →
   Photos, confirm the gallery renders (this now round-trips through
   `get_my_camper_photos` for metadata, then `get-photo-urls` for signed
   URLs — you should NOT see any inline image bytes if you inspect the
   network tab, only short signed Storage URLs).
5. Tap a photo to open it full-size — confirm it loads (this re-mints a
   fresh signed URL rather than reusing the grid's, so it should work even
   if you waited a few minutes after loading the gallery).
6. Confirm a photo that's still `pending` (not yet approved by staff)
   does **not** appear in the parent's gallery — same authorization logic
   as before, just re-verified now that it flows through a different RPC.
7. **Security check**: as a signed-in parent, open your browser console
   and try a direct read against the bucket —
   `window._parentDB.storage.from('camp-photos').download('<any path>')`
   — confirm it's rejected. No policy grants SELECT on `camp-photos`
   objects to anyone; this must always fail.
8. Confirm nothing in the app can ever retrieve `original_path` right now
   — there's no UI or RPC path that requests it yet. That's correct: full
   resolution originals are being **retained** as of this pass, but
   nothing can **serve** them until Phase 3 (paid downloads) exists. Until
   then they just sit in Storage, unreachable.

## What's NOT in this pass

- **Camp paywall** (Phase 2) — Link access gating (free year-round
  messaging/forms, paid 2–3 month window for everything else including
  Photos) is a separate, not-yet-built feature.
- **Parent payments** (Phase 3) — facial-recognition unlock and high-def
  photo purchases are separate, not-yet-built features. Nothing in this
  pass can be bought; it only makes a real full-resolution asset exist to
  sell later.
- **Backfill for pre-migration photos** — if any `link_photos` rows exist
  with `image_data` set and no `preview_path`, they won't show up in the
  gallery until backfilled (decode the base64, upload it as the preview
  variant, set `preview_path`). There's no original to backfill for those
  rows either way — that data was already discarded before this pass
  existed. Not built here; confirm with the user whether any real
  production photo data exists before building a backfill script.
- **Storage cleanup on purge** — `purge_face_data(p_delete_photos=true)`
  (migration 040) deletes `link_photos` rows but has no way to delete the
  backing Storage objects from plain SQL. Flagged in migration 080's
  comments as a needed fast-follow (a service-role edge function), not
  fixed here.

## Migration SQL

See `migrations/080_photo_storage.sql` for the full, commented SQL — not
duplicated here to avoid the two copies drifting apart.
