-- =============================================================================
-- Migration 080: Link Photos — real object storage (Phase 1 of the paid-
-- photos work; see /root/.claude/plans/bubbly-jingling-kite.md for the
-- full 3-phase design).
--
-- Photos today are a single 1200px-resized copy, stored inline as base64
-- text directly in link_photos.image_data (capped ~3MB/row) -- the
-- original full-resolution upload is discarded immediately after
-- client-side face-matching runs. There is no full-resolution asset
-- anywhere in the system, so nothing can ever be sold as a paid "high-def"
-- unlock. This migration moves both a preview AND the (newly retained)
-- original into a private Supabase Storage bucket, replacing inline image
-- bytes with path references. Delivery goes exclusively through the new
-- get-photo-urls edge function (short-lived signed URLs), never direct
-- client reads -- same "RLS enabled, zero client policies, every access
-- funneled through a SECURITY DEFINER RPC or service-role function"
-- pattern already used this session for sms_opt_outs/camp_telnyx_provisioning.
--
-- This phase does NOT build the camp paywall or parent purchase flow --
-- it only makes them possible. Nothing in this migration can retrieve
-- original_path under any circumstance yet; that gate is Phase 3's job.
-- =============================================================================

-- ─── 1. New private bucket: camp-photos ─────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('camp-photos', 'camp-photos', false)
ON CONFLICT (id) DO NOTHING;

-- Paths: {camp_id}/preview/{photo_id}.jpg and {camp_id}/original/{photo_id}.jpg
-- storage.foldername(name) splits the path into an array; [1] is the camp_id
-- segment. INSERT is staff-only (owner/camp_users), mirroring link_photos'
-- own lp_staff_all policy shape exactly. No SELECT/UPDATE/DELETE policy is
-- granted to anyone -- deliberately deny-all; every read goes through
-- get-photo-urls (service-role, short-lived signed URLs), and there is
-- correspondingly no client-side delete path either (see the purge_face_data
-- note in §5 below for why that's a known, flagged gap, not an oversight).
DROP POLICY IF EXISTS camp_photos_staff_insert ON storage.objects;
CREATE POLICY camp_photos_staff_insert ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'camp-photos'
        AND (
            EXISTS (
                SELECT 1 FROM camps c
                WHERE c.id::text = (storage.foldername(name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(name))[1] AND u.user_id = auth.uid()
            )
        )
    );

-- ─── 2. link_photos: path columns alongside (not replacing) image_data ─────
-- image_data stays as-is, nullable, unused going forward -- non-destructive,
-- reversible, and the natural backfill target for any pre-migration rows.
ALTER TABLE public.link_photos
    ADD COLUMN IF NOT EXISTS preview_path  text,
    ADD COLUMN IF NOT EXISTS original_path text;

-- ─── 3. save_scanned_photo — stop accepting/writing inline image bytes ─────
-- The client now uploads preview + original to Storage separately, then
-- calls set_photo_storage_paths (below) to record them. Uploading a
-- full-resolution original for an entire batch's worth of photos before
-- any of them are persisted would mean holding all of them in memory at
-- once, so the client instead generates the photo id itself
-- (crypto.randomUUID()) and uploads each file's Storage objects
-- immediately after scanning it -- one at a time, discarding the bytes as
-- it goes -- then passes that same id here when it finally persists the
-- row, so the id this function assigns always matches whatever path the
-- bytes actually landed at. p_photo_id is optional (falls back to
-- gen_random_uuid()) so this RPC still works standalone / from the SQL
-- Editor sanity check below.
CREATE OR REPLACE FUNCTION public.save_scanned_photo(
    p_camp_id    uuid,
    p_file_name  text,
    p_week       text,
    p_tags       jsonb DEFAULT '[]'::jsonb,
    p_photo_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    new_id   uuid := coalesce(p_photo_id, gen_random_uuid());
    rec      jsonb;
    n_tags   int  := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    INSERT INTO link_photos (id, camp_id, file_name, week, uploaded_by, faces_found)
    VALUES (new_id, p_camp_id, p_file_name, p_week, caller, coalesce(jsonb_array_length(p_tags), 0));

    FOR rec IN SELECT * FROM jsonb_array_elements(coalesce(p_tags, '[]'::jsonb)) LOOP
        -- only persist tags for consented campers
        IF EXISTS (
            SELECT 1 FROM link_camper_faces f
            WHERE f.camp_id = p_camp_id AND f.camper_name = rec->>'camper_name' AND f.consent = true
        ) THEN
            INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, confidence, manual, pending)
            VALUES (new_id, p_camp_id, rec->>'camper_name',
                    NULLIF(rec->>'confidence','')::real,
                    coalesce((rec->>'manual')::boolean, false),
                    coalesce((rec->>'pending')::boolean, false))
            ON CONFLICT (photo_id, camper_name) DO NOTHING;
            n_tags := n_tags + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'photo_id', new_id, 'tags_saved', n_tags);
END;
$$;

-- Old signature (with p_image_data as the 2nd positional arg) is superseded
-- -- drop it so nothing can accidentally keep calling the inline-bytes path.
DROP FUNCTION IF EXISTS public.save_scanned_photo(uuid, text, text, text, jsonb);

-- ─── 4. set_photo_storage_paths — record where the uploaded bytes landed ───
-- Called by the client immediately after both Storage uploads succeed.
-- Staff-only (same membership check as save_scanned_photo); scoped to a
-- row the caller's own camp actually owns.
CREATE OR REPLACE FUNCTION public.set_photo_storage_paths(
    p_photo_id      uuid,
    p_preview_path  text,
    p_original_path text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_camp uuid;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    SELECT camp_id INTO v_camp FROM link_photos WHERE id = p_photo_id;
    IF v_camp IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'photo_not_found'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = v_camp AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = v_camp AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    UPDATE link_photos
    SET preview_path = coalesce(p_preview_path, preview_path),
        original_path = coalesce(p_original_path, original_path)
    WHERE id = p_photo_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_photo_storage_paths(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_photo_storage_paths(uuid, text, text) TO authenticated;

-- ─── 5. get_my_camper_photos — metadata only, no image bytes ───────────────
-- Authorization logic is completely unchanged (_parent_owns_camper +
-- pending=false) -- only the returned shape changes. The client now
-- batch-calls the get-photo-urls edge function with the returned ids to
-- render anything.
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
        ORDER BY p.id, p.created_at DESC
    ) sub;

    RETURN jsonb_build_object('success', true, 'photos', result);
END;
$$;

-- ─── 6. get_viewable_photo_ids — batched parent authorization check ────────
-- Used by the get-photo-urls edge function: given a candidate list of photo
-- ids (already filtered down to whatever a staff-membership check via RLS
-- did NOT already authorize), returns the subset the CALLING PARENT may
-- view -- one round trip instead of one RPC call per photo. Same
-- authorization logic as get_my_camper_photos (_parent_owns_camper +
-- pending=false), just batched and keyed on id instead of camp_id/week.
CREATE OR REPLACE FUNCTION public.get_viewable_photo_ids(p_photo_ids uuid[])
RETURNS uuid[]
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT coalesce(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    FROM link_photos p
    JOIN link_photo_tags t ON t.photo_id = p.id
    WHERE p.id = ANY(p_photo_ids)
      AND t.pending = false
      AND public._parent_owns_camper(p.camp_id, t.camper_name);
$$;
REVOKE ALL ON FUNCTION public.get_viewable_photo_ids(uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.get_viewable_photo_ids(uuid[]) TO authenticated;

-- ─── Known gap, flagged not silently dropped ────────────────────────────────
-- purge_face_data(p_delete_photos=true) (migration 040) deletes link_photos
-- ROWS but has no way to delete the backing Storage OBJECTS from plain SQL
-- (Storage's actual file backend is only reachable via its HTTP API, which
-- needs a service-role call, not a Postgres function body). Until a
-- follow-up service-role edge function does that cleanup, purging photos
-- deletes the metadata but leaves the image files themselves in the
-- camp-photos bucket. Not addressed here -- flagged for a fast-follow,
-- since purge_face_data's whole purpose is data destruction and this is a
-- real (if narrow) gap in it once photos live in Storage instead of the DB.

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select id from storage.buckets where id = 'camp-photos';
--   select column_name from information_schema.columns
--     where table_name = 'link_photos' and column_name like '%_path';
--   select save_scanned_photo('<a real camp id>'::uuid, 'test.jpg', 'week1', '[]'::jsonb);
--   -- with an explicit id (what the client actually does):
--   select save_scanned_photo('<a real camp id>'::uuid, 'test.jpg', 'week1', '[]'::jsonb, gen_random_uuid());
-- =============================================================================
