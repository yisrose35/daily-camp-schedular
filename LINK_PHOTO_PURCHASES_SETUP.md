# Link Photos — Parent Purchases — Setup

Adds the two parent-facing purchases from the photos monetization plan
(Phase 3 of 3 — see `/root/.claude/plans/bubbly-jingling-kite.md`):

1. **Facial-recognition dedicated folder** — one-time fee **per camper**,
   unlocks the AI-filtered "just my kid" photo view for the rest of the
   season.
2. **HD (full-resolution) download** — flat fee **per photo**, works on
   any photo the parent can already view a preview of.

**Both prices are placeholders** — $20 for the folder, $4 per HD photo —
each a single named constant in `link-photo-checkout/index.ts`
(`FACIAL_RECOGNITION_FEE_CENTS`, `HD_PHOTO_FEE_CENTS`). Change those two
lines whenever real pricing is decided; nothing else needs to change.

Both purchases are charged through the **camp's own connected Stripe
account** (Stripe Connect — the same one already used for tips/canteen).
This is the camp's revenue, not Campistry's. A camp that hasn't connected
Stripe gets a hard rejection on both purchase types.

## Real behavior change — read before deploying

**Today, `get_my_camper_photos` is free for every consented parent with no
purchase check at all.** This migration adds one. After this ships:

- Every parent gets a brand-new **free** "All Camp Photos" tab — the whole
  camp's photo stream, no AI filtering, nothing showing whose kid is in
  which photo.
- The existing personalized "my kid's tagged photos" view becomes the
  **paid** "My Kids" tab — gated per camper on a $20 purchase.

If any camp is actively using Photos this season, their parents will
suddenly need to buy the folder they were getting for free. **Tell camp
owners about this before it goes live** if that applies.

## 1. Run the migration

```
081_link_photo_purchases.sql
```

Paste into the Supabase SQL Editor. Safe to re-run.

Creates `link_photo_purchases` (RLS enabled, no client policies) and five
functions: `get_camp_photos_browse` (new free tier), `get_my_photo_purchases`,
`get_my_camper_photos` (redefined — now purchase-gated), `verify_my_camper`,
`get_viewable_original_photo_ids`, and `record_link_photo_purchase`
(service-role only, webhook-called).

## 2. Deploy the edge functions

New:
- `link-photo-checkout` — requires the parent's real session (JWT
  verification **on**, default). Verifies camper/photo ownership
  server-side before ever calling Stripe; the client can never influence
  the amount charged.

Changed (redeploy):
- `stripe-webhook` — now also branches on
  `metadata.source === 'campistry-link-photo-purchase'`, crediting
  `link_photo_purchases` via `record_link_photo_purchase`. Either/or with
  the tuition and canteen paths — never double-recorded.
- `get-photo-urls` — now accepts an optional `resolution: 'original'` in
  the request body. Staff always get originals (no purchase check — they
  uploaded them); a parent only gets one for a photo they've bought an HD
  unlock for (`get_viewable_original_photo_ids`). Originals are signed
  with `download: true` so the browser actually saves the file instead of
  just displaying it.

## 3. Secrets

No new secrets — reuses `STRIPE_SECRET_KEY`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, all already set.

## 4. No new webhook registration needed

Same existing `stripe-webhook` endpoint tuition/tips/canteen already use —
a photo purchase's PaymentIntent fires the identical `payment_intent.*`
events (still a destination charge on the platform, same shape as
canteen). Nothing new to register in Stripe.

## 5. Verify end to end

Use Stripe **test mode**, with a camp that has connected Stripe Connect.

1. As a parent, open Link → Photos. Confirm you land on "My Kids" and see
   either an upsell button ("Get {child}'s folder — $20") for each child
   who hasn't purchased, or their photos if already purchased.
2. Switch to "All Camp Photos" — confirm you see the whole camp's photo
   stream (not just your kid's), free, no upsell shown.
3. Click "Get {child}'s folder — $20" → redirected to Stripe Checkout →
   pay with a test card (`4242 4242 4242 4242`) → redirected back →
   reload the Photos page → confirm that child's tagged photos now appear
   under "My Kids", and the upsell button for that child is gone.
4. Confirm a sibling you have NOT purchased still shows the upsell button
   and their photos do NOT appear.
5. Open any photo's full-size view → click "Download HD — $4" → pay with a
   test card → confirm you're redirected back, and re-opening that same
   photo now shows a "Download HD" button that actually saves the
   full-resolution file (not the resized preview — compare pixel
   dimensions).
6. Confirm a DIFFERENT photo you haven't bought still only offers the $4
   button, never a real download.
7. In Stripe's test dashboard, confirm both charges show a transfer to the
   camp's connected test account, not the platform balance.
8. Resend one of the webhook events from Stripe's dashboard — confirm the
   purchase is NOT recorded twice (`link_photo_purchases` has a unique
   constraint on `stripe_payment_intent_id`).
9. On a camp that has NOT connected Stripe, confirm both purchase buttons
   are rejected with "This camp hasn't set up payments yet."
10. Confirm staff (in the Link Admin review UI) can still see everything
    at full resolution with no purchase prompts at all — staff access is
    untouched by this pass.

## What's NOT in this pass

- **Refunds** for photo purchases — not built. A fast-follow, same as how
  canteen shipped deposits before refunds.
- **Phase 2 (camp-wide Link paywall)** — still on hold; the camp's overall
  access to Link stays a manual flip, unrelated to this pass.
- Bundle/pack pricing for HD downloads (e.g. "5 for $12") — flat per-photo
  only.

## Migration SQL

See `migrations/081_link_photo_purchases.sql` for the full, commented SQL
— not duplicated here to avoid the two copies drifting apart.
