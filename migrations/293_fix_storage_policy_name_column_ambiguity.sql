-- =============================================================================
-- Migration 293: Fix a column-ambiguity bug in the camp-logos/camp-photos/
-- camp-pdf-forms staff Storage policies.
--
-- Each policy's ownership check does:
--     EXISTS (SELECT 1 FROM camps c WHERE c.id::text = (storage.foldername(name))[1] ...)
-- The bare `name` inside that subquery is ambiguous: `camps` ALSO has a
-- column called `name` (the camp's display name, e.g. "Camp Campistry"),
-- and Postgres resolves an unqualified column reference to the innermost
-- scope that has it -- so `name` bound to `c.name` (the camp's own name
-- string) instead of the outer `storage.objects.name` (the actual file
-- path) that was intended. The policy ended up comparing a camp's id
-- against a folder-split of the camp's OWN NAME, which can never match --
-- so every one of these three INSERT policies has always rejected every
-- legitimate staff upload, not just camp-logos'.
--
-- Fix: fully qualify as storage.objects.name, which bypasses the shadowing
-- (an unambiguous, schema+table-qualified reference always wins regardless
-- of what the subquery's own tables happen to be named).
-- =============================================================================

-- ─── camp-logos (migration 292) ─────────────────────────────────────────────
DROP POLICY IF EXISTS camp_logos_staff_insert ON storage.objects;
CREATE POLICY camp_logos_staff_insert ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'camp-logos'
        AND (
            EXISTS (
                SELECT 1 FROM camps c
                WHERE c.id::text = (storage.foldername(storage.objects.name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(storage.objects.name))[1] AND u.user_id = auth.uid()
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
                WHERE c.id::text = (storage.foldername(storage.objects.name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(storage.objects.name))[1] AND u.user_id = auth.uid()
            )
        )
    )
    WITH CHECK (
        bucket_id = 'camp-logos'
        AND (
            EXISTS (
                SELECT 1 FROM camps c
                WHERE c.id::text = (storage.foldername(storage.objects.name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(storage.objects.name))[1] AND u.user_id = auth.uid()
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
                WHERE c.id::text = (storage.foldername(storage.objects.name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(storage.objects.name))[1] AND u.user_id = auth.uid()
            )
        )
    );

-- ─── camp-photos (migration 080) — same bug, pre-existing ──────────────────
DROP POLICY IF EXISTS camp_photos_staff_insert ON storage.objects;
CREATE POLICY camp_photos_staff_insert ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'camp-photos'
        AND (
            EXISTS (
                SELECT 1 FROM camps c
                WHERE c.id::text = (storage.foldername(storage.objects.name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(storage.objects.name))[1] AND u.user_id = auth.uid()
            )
        )
    );

-- ─── camp-pdf-forms (migration 110) — same bug, pre-existing ───────────────
DROP POLICY IF EXISTS camp_pdf_forms_staff_insert ON storage.objects;
CREATE POLICY camp_pdf_forms_staff_insert ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'camp-pdf-forms'
        AND (
            EXISTS (
                SELECT 1 FROM camps c
                WHERE c.id::text = (storage.foldername(storage.objects.name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(storage.objects.name))[1] AND u.user_id = auth.uid()
            )
        )
    );

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select policyname, with_check from pg_policies
--     where schemaname = 'storage' and tablename = 'objects'
--     and policyname in ('camp_logos_staff_insert','camp_photos_staff_insert','camp_pdf_forms_staff_insert');
--   -- with_check should now read storage.objects.name, not a bare "name".
-- =============================================================================
