-- =============================================================================
-- Migration 081: Link Photos — Phase 3 (parent purchases)
-- See /root/.claude/plans/bubbly-jingling-kite.md ("Link Photos — Phase 3")
-- for the full design writeup.
--
-- Two separate one-time purchases a parent can make, both charged through
-- the CAMP's own connected Stripe account (Stripe Connect — this is the
-- camp's revenue, not Campistry's):
--   1. facial_recognition — one-time fee PER CAMPER, unlocks the existing
--      AI-filtered "just my kid" view (get_my_camper_photos) for the rest
--      of the season.
--   2. hd_photo — flat fee PER PHOTO, unlocks the full-resolution original
--      download for one specific photo.
--
-- Inverts today's model: get_my_camper_photos has always been free for any
-- consented parent with no purchase check at all -- this migration adds
-- one, and simultaneously introduces a brand new FREE tier
-- (get_camp_photos_browse) that didn't exist before, so every parent still
-- has *something* to look at without paying anything. This is a real
-- behavior change for any camp already relying on the free personalized
-- view this season -- flag it to camp owners before this ships live.
--
-- Same "RLS enabled, zero client policies, every access through a
-- SECURITY DEFINER RPC or service-role function" shape used throughout
-- this session.
-- =============================================================================

-- ─── 1. link_photo_purchases ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.link_photo_purchases (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id                   uuid NOT NULL REFERENCES public.camps(id),
    parent_user_id            uuid NOT NULL,
    kind                      text NOT NULL CHECK (kind IN ('facial_recognition', 'hd_photo')),
    camper_name               text,   -- required for facial_recognition
    photo_id                  uuid REFERENCES public.link_photos(id), -- required for hd_photo
    amount_paid_cents         integer NOT NULL,
    stripe_payment_intent_id  text NOT NULL,
    purchased_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS link_photo_purchases_pi_uq
    ON public.link_photo_purchases (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS link_photo_purchases_lookup
    ON public.link_photo_purchases (camp_id, parent_user_id, kind);
ALTER TABLE public.link_photo_purchases ENABLE ROW LEVEL SECURITY;
-- No client-side policies at all -- every access goes through the RPCs below.

-- ─── 2. get_camp_photos_browse — the new FREE tier ─────────────────────────
-- Every photo in the camp for the week, no camper-name/tag data attached --
-- nothing here asserts "this is your kid," so photo-tag consent/pending
-- review status isn't implicated. Same shared-camp-album privacy shape as
-- any group photo stream. Gated only on having an active parent invite for
-- this camp (same membership check _parent_owns_camper uses, minus the
-- per-camper name match).
CREATE OR REPLACE FUNCTION public.get_camp_photos_browse(p_camp_id uuid, p_week text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (
        SELECT 1 FROM link_parent_invites i
        WHERE i.user_id = caller AND i.camp_id = p_camp_id AND i.status = 'active'
          AND (i.expires_at IS NULL OR i.expires_at > now())
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT jsonb_build_object('id', p.id, 'week', p.week, 'created_at', p.created_at) AS x
        FROM link_photos p
        WHERE p.camp_id = p_camp_id
          AND (p_week IS NULL OR p.week = p_week)
          AND p.preview_path IS NOT NULL
    ) sub;

    RETURN jsonb_build_object('success', true, 'photos', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_photos_browse(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_photos_browse(uuid, text) TO authenticated;

-- ─── 3. get_my_photo_purchases — what has THIS parent already unlocked ────
CREATE OR REPLACE FUNCTION public.get_my_photo_purchases(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); fr jsonb; hd jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(camper_name), '[]'::jsonb) INTO fr
    FROM link_photo_purchases
    WHERE camp_id = p_camp_id AND parent_user_id = caller AND kind = 'facial_recognition';

    SELECT coalesce(jsonb_agg(photo_id), '[]'::jsonb) INTO hd
    FROM link_photo_purchases
    WHERE camp_id = p_camp_id AND parent_user_id = caller AND kind = 'hd_photo';

    RETURN jsonb_build_object('success', true, 'facialRecognition', fr, 'hdPhotoIds', hd);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_photo_purchases(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_photo_purchases(uuid) TO authenticated;

-- ─── 4. verify_my_camper — thin public wrapper for the edge function ──────
-- _parent_owns_camper (migration 028) already does exactly this check, but
-- is treated as an internal-only helper by convention in this codebase
-- (never called directly from client/edge code) -- this gives
-- link-photo-checkout a proper public-facing name to call instead.
CREATE OR REPLACE FUNCTION public.verify_my_camper(p_camp_id uuid, p_camper_name text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT public._parent_owns_camper(p_camp_id, p_camper_name);
$$;
REVOKE ALL ON FUNCTION public.verify_my_camper(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_my_camper(uuid, text) TO authenticated;

-- ─── 5. get_my_camper_photos — gate the dedicated folder on FR purchase ───
-- Same as migration 080's version, plus one added EXISTS check. A parent
-- with 2 kids who only bought the folder for one still correctly sees only
-- that one's tagged photos -- everything else (consent, pending=false,
-- ownership) is unchanged from Phase 1.
CREATE OR REPLACE FUNCTION public.get_my_camper_photos(p_camp_id uuid, p_week text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT DISTINCT ON (p.id) jsonb_build_object(
            'id',         p.id,
            'week',       p.week,
            'created_at', p.created_at,
            'camper',     t.camper_name
        ) AS x, p.id, p.created_at
        FROM link_photos p
        JOIN link_photo_tags t ON t.photo_id = p.id
        WHERE p.camp_id = p_camp_id
          AND (p_week IS NULL OR p.week = p_week)
          AND t.pending = false
          AND public._parent_owns_camper(p_camp_id, t.camper_name)
          AND EXISTS (
              SELECT 1 FROM link_photo_purchases lp
              WHERE lp.camp_id = p_camp_id AND lp.kind = 'facial_recognition'
                AND lp.camper_name = t.camper_name AND lp.parent_user_id = caller
          )
        ORDER BY p.id, p.created_at DESC
    ) sub;

    RETURN jsonb_build_object('success', true, 'photos', result);
END;
$$;

-- ─── 6. get_viewable_original_photo_ids — the HD purchase gate ───────────
-- Parallel to migration 080's get_viewable_photo_ids, but for originals:
-- same viewability check (_parent_owns_camper + pending=false), ADDED to
-- an EXISTS against an hd_photo purchase for that exact photo id. Used by
-- get-photo-urls when a caller asks for resolution:'original'.
CREATE OR REPLACE FUNCTION public.get_viewable_original_photo_ids(p_photo_ids uuid[])
RETURNS uuid[]
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT coalesce(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    FROM link_photos p
    JOIN link_photo_tags t ON t.photo_id = p.id
    WHERE p.id = ANY(p_photo_ids)
      AND t.pending = false
      AND public._parent_owns_camper(p.camp_id, t.camper_name)
      AND EXISTS (
          SELECT 1 FROM link_photo_purchases lp
          WHERE lp.kind = 'hd_photo' AND lp.photo_id = p.id AND lp.parent_user_id = auth.uid()
      );
$$;
REVOKE ALL ON FUNCTION public.get_viewable_original_photo_ids(uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.get_viewable_original_photo_ids(uuid[]) TO authenticated;

-- ─── 7. record_link_photo_purchase — webhook-only, idempotent ────────────
CREATE OR REPLACE FUNCTION public.record_link_photo_purchase(
    p_camp_id           uuid,
    p_parent_user_id    uuid,
    p_kind              text,
    p_camper_name       text,
    p_photo_id          uuid,
    p_amount_cents      integer,
    p_payment_intent_id text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO link_photo_purchases
        (camp_id, parent_user_id, kind, camper_name, photo_id, amount_paid_cents, stripe_payment_intent_id)
    VALUES
        (p_camp_id, p_parent_user_id, p_kind, p_camper_name, p_photo_id, p_amount_cents, p_payment_intent_id)
    ON CONFLICT (stripe_payment_intent_id) DO NOTHING;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.record_link_photo_purchase(uuid, uuid, text, text, uuid, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_link_photo_purchase(uuid, uuid, text, text, uuid, integer, text) TO service_role;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'record_link_photo_purchase';
--   select get_camp_photos_browse('<a real camp id>'::uuid);
--   select get_my_photo_purchases('<a real camp id>'::uuid);
-- =============================================================================
