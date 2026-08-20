-- ============================================================================
-- Migration 063: camp timezone
--
-- Nothing in this codebase stores a camp's timezone anywhere. The one
-- existing cron-based reminder job (check-notes-reminders) documents in its
-- own comments that its date/time math can drift by hours as a result. The
-- pickup-alert reminder (a later migration) fires exactly 5 minutes before a
-- scheduled pickup, which can't tolerate that drift — this is the real fix.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

ALTER TABLE public.camps ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York';

-- Owner/admin only, via RPC rather than a direct client UPDATE — camps' own
-- UPDATE RLS (if any) predates this repo's migrations and isn't reliably
-- knowable from here, so this doesn't assume it grants the right thing.
CREATE OR REPLACE FUNCTION public.set_camp_timezone(p_timezone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_camp uuid := get_user_camp_id();
    v_role text := get_user_role();
BEGIN
    IF v_camp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp');
    END IF;
    IF v_role NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
    IF p_timezone IS NULL OR btrim(p_timezone) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_timezone');
    END IF;
    -- Validate it's a real IANA zone name Postgres recognizes, rather than
    -- silently storing garbage that only fails later, at alert-time.
    BEGIN
        PERFORM now() AT TIME ZONE p_timezone;
    EXCEPTION WHEN invalid_parameter_value OR others THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_timezone');
    END;

    UPDATE public.camps SET timezone = p_timezone WHERE id = v_camp;
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_camp_timezone(text) FROM public;
REVOKE ALL ON FUNCTION public.set_camp_timezone(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_camp_timezone(text) TO authenticated;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT id, timezone FROM camps LIMIT 5;
