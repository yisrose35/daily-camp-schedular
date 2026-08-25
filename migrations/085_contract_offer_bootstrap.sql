-- =============================================================================
-- Migration 085: anon-safe read + accept for the staff Offer & Contract page.
--
-- CRITICAL BUG FOUND, same shape as migration 084: campistry_contract.html
-- is opened by a job candidate who has never logged into Campistry —
-- campId and the applicant id travel in the URL, and the page reads the
-- offer with a DIRECT anonymous `camp_state_kv` SELECT. That table's RLS
-- (migration 001) requires camp_id = get_user_camp_id(), which an
-- unauthenticated caller can never satisfy — the read has always been
-- blocked, so no candidate has ever actually seen their offer load.
--
-- WORSE: the "Accept Offer" button did a direct anonymous UPSERT of the
-- ENTIRE campistryMe blob (re-fetch the whole thing, splice in the
-- acceptance, write the whole thing back) — also blocked by the same RLS
-- (INSERT/UPDATE require owner/admin), so accepting has never worked
-- either. Even if that RLS gap were papered over, a client-side
-- read-modify-write of the FULL blob from anonymous code is exactly the
-- pattern this session has been closing everywhere else (see migration
-- 083's header) — a bug in the merge, or two people accepting offers at
-- the same moment, could clobber unrelated data (other applicants,
-- enrollments, families, finance) for the whole camp.
--
-- Fix: same pattern as migration 084 — two narrow, whitelisted SECURITY
-- DEFINER RPCs granted to anon. The read returns only the public-facing
-- offer fields for that ONE application, never the full blob. The accept
-- action does a single atomic jsonb_set touching only that one
-- application's contract.{status,acceptedAt,acceptedName} — nothing else
-- in campistryMe can be reached through it.
-- =============================================================================

-- ─── 1. get_contract_offer — read one candidate's offer ────────────────────
CREATE OR REPLACE FUNCTION public.get_contract_offer(
    p_camp_id uuid,
    p_app_id  text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row record;
    kv_value jsonb;
    app_row  jsonb;
    ctr      jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_app_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    app_row := kv_value -> 'staffApplications' -> p_app_id;
    ctr := app_row -> 'contract';
    IF app_row IS NULL OR ctr IS NULL OR coalesce(ctr ->> 'status', 'none') = 'none' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'campName', camp_row.name,
        'candidateName', coalesce(
            nullif(app_row ->> 'name', ''),
            trim(coalesce(app_row ->> 'first', '') || ' ' || coalesce(app_row ->> 'last', ''))
        ),
        'status', ctr ->> 'status',
        'position', ctr ->> 'position',
        'payType', ctr ->> 'payType',
        'payRate', ctr -> 'payRate',
        'startDate', ctr ->> 'startDate',
        'endDate', ctr ->> 'endDate',
        'terms', ctr ->> 'terms',
        'acceptedName', ctr ->> 'acceptedName',
        'acceptedAt', ctr ->> 'acceptedAt'
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_contract_offer(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_contract_offer(uuid, text) TO anon, authenticated;

-- ─── 2. accept_staff_contract — the candidate's e-signature ────────────────
-- Touches ONLY staffApplications->p_app_id->contract.{status,acceptedAt,
-- acceptedName} via jsonb_set — every other field on the application (and
-- everything else in campistryMe) is left completely untouched, and there
-- is no client-side read-modify-write for a race to land in.
CREATE OR REPLACE FUNCTION public.accept_staff_contract(
    p_camp_id       uuid,
    p_app_id        text,
    p_accepted_name text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    kv_value jsonb;
    app_row  jsonb;
    ctr      jsonb;
    new_ctr  jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_app_id IS NULL OR p_accepted_name IS NULL OR btrim(p_accepted_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;
    IF length(p_accepted_name) > 200 THEN
        RETURN jsonb_build_object('success', false, 'error', 'name_too_long');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    app_row := kv_value -> 'staffApplications' -> p_app_id;
    ctr := app_row -> 'contract';
    IF app_row IS NULL OR ctr IS NULL OR coalesce(ctr ->> 'status', 'none') = 'none' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;
    IF (ctr ->> 'status') = 'accepted' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_accepted');
    END IF;

    new_ctr := ctr || jsonb_build_object(
        'status', 'accepted',
        'acceptedAt', to_jsonb(now()),
        'acceptedName', to_jsonb(btrim(p_accepted_name))
    );

    UPDATE camp_state_kv
    SET value = jsonb_set(
            value,
            ARRAY['staffApplications', p_app_id, 'contract'],
            new_ctr,
            true
        ),
        updated_at = now()
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_staff_contract(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.accept_staff_contract(uuid, text, text) TO anon, authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'get_contract_offer';
--   select proacl from pg_proc where proname = 'accept_staff_contract';
--   -- both should show anon among the grantees.
--   select get_contract_offer('<a real camp id>'::uuid, '<a real application id>');
-- =============================================================================
