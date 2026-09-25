-- =============================================================================
-- Migration 292: Camp logo moves to a real Storage bucket instead of living
-- as a base64 data: URL inline inside camp_state_kv's 'campistryLink' JSON
-- blob (settings.branding.logo). That worked but had real costs: every
-- save/read of that JSON key carried the full image bytes, the logo had to
-- stay tiny (resized to ~340px / capped ~500KB client-side) specifically
-- because of it, there was no CDN caching, and it got re-duplicated into a
-- fresh data URL everywhere it was used (branding preview, outgoing email
-- HTML, print sheets) instead of being referenced by one shared URL.
--
-- New bucket: camp-logos, PUBLIC (unlike camp-photos/camp-pdf-forms, which
-- are private + signed-URL-only) -- a camp logo isn't sensitive, and it
-- needs to render with a plain <img src> in emails sent to parents days or
-- weeks later, in print sheets, and painted onto a <canvas> for the
-- watermark feature, none of which should depend on a signed URL that can
-- expire. One object per camp at a fixed path (camp_id/logo.<ext>,
-- upsert=true) -- a logo has no history to keep, unlike photos.
-- =============================================================================

-- ─── 1. New public bucket: camp-logos ───────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('camp-logos', 'camp-logos', true)
ON CONFLICT (id) DO NOTHING;

-- Path: {camp_id}/logo.<ext> -- storage.foldername(name) splits the path
-- into an array; [1] is the camp_id segment. Same staff-membership check
-- shape as camp-photos' INSERT policy (owner OR camp_users row), but this
-- bucket also allows UPDATE (upsert overwrite when a new logo replaces the
-- old one at the same path) and DELETE (removing a logo entirely), which
-- camp-photos deliberately does not.
DROP POLICY IF EXISTS camp_logos_staff_insert ON storage.objects;
CREATE POLICY camp_logos_staff_insert ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'camp-logos'
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

DROP POLICY IF EXISTS camp_logos_staff_update ON storage.objects;
CREATE POLICY camp_logos_staff_update ON storage.objects
    FOR UPDATE
    USING (
        bucket_id = 'camp-logos'
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
    )
    WITH CHECK (
        bucket_id = 'camp-logos'
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

DROP POLICY IF EXISTS camp_logos_staff_delete ON storage.objects;
CREATE POLICY camp_logos_staff_delete ON storage.objects
    FOR DELETE
    USING (
        bucket_id = 'camp-logos'
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

-- Public read -- anyone can view a camp's logo with no auth, same as any
-- other public-bucket asset. Nothing sensitive lives at this path.
DROP POLICY IF EXISTS camp_logos_public_read ON storage.objects;
CREATE POLICY camp_logos_public_read ON storage.objects
    FOR SELECT
    USING (bucket_id = 'camp-logos');

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select id, public from storage.buckets where id = 'camp-logos';
--   select policyname from pg_policies
--     where schemaname = 'storage' and tablename = 'objects' and policyname like 'camp_logos_%';
-- =============================================================================
