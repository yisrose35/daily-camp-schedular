-- ============================================================================
-- Migration: let platform super-admins create camps without an access code
--
-- The camps INSERT trigger check_access_code_on_camp_create →
-- validate_camp_creation() requires the OWNER's auth.users metadata to carry a
-- valid access_code. The platform owner's account was created without one, so
-- the Debug Copy feature can't insert a sandbox camp ("An access code is
-- required.").
--
-- Fix: add a single early bypass for is_super_admin() at the top of the
-- function. Everything else is preserved EXACTLY, so normal signups still
-- require a valid access/promo code. Idempotent (CREATE OR REPLACE).
--
-- Requires migration 010 (defines public.is_super_admin()).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_camp_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
    provided_code TEXT;
BEGIN
    -- ★ Debug Copy: platform super-admins may create camps (debug copies)
    --   without an access code. Everyone else still must provide a valid one.
    IF public.is_super_admin() THEN
        RETURN NEW;
    END IF;

    -- Get the access code the user provided at signup
    SELECT raw_user_meta_data->>'access_code' INTO provided_code
    FROM auth.users
    WHERE id = NEW.owner;

    -- No code provided = reject
    IF provided_code IS NULL OR provided_code = '' THEN
        RAISE EXCEPTION 'An access code is required. Contact campistryoffice@gmail.com for access.'
            USING ERRCODE = 'P0001';
    END IF;

    -- Check access_codes table (case-sensitive)
    IF EXISTS(
        SELECT 1 FROM access_codes
        WHERE code = provided_code
        AND active = true
        AND (max_uses IS NULL OR times_used < max_uses)
    ) THEN
        RETURN NEW;
    END IF;

    -- Fallback: check legacy promo_codes table
    IF EXISTS(
        SELECT 1 FROM promo_codes
        WHERE UPPER(code) = UPPER(provided_code)
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses IS NULL OR times_used < max_uses)
    ) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Invalid access code. Contact campistryoffice@gmail.com for access.'
        USING ERRCODE = 'P0001';
END;
$function$;

-- ─── Sanity check ──────────────────────────────────────────────────────────
-- As the super-admin, a camps INSERT should now succeed without an access
-- code. As any other user it must still fail with the access-code error.
