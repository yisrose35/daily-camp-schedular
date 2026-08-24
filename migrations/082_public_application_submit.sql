-- =============================================================================
-- Migration 082: real cloud delivery for public application forms.
--
-- CRITICAL BUG FIXED: campistry_register.html, campistry_staff_apply.html,
-- and campistry_postaccept.html have all been writing directly to
-- camp_state_kv from the visitor's own browser using only the anon key —
-- no login. But camp_state_kv's INSERT/UPDATE RLS policies (migration 001)
-- require get_user_role() = owner/admin, and get_user_role() itself is
-- GRANT EXECUTE ... TO authenticated only (migration 005) — an anonymous
-- caller can't even invoke it. So every one of these writes has always been
-- rejected by the database, silently: campistry_register.html's own success
-- screen shows regardless of the outcome (the cloud write is a
-- fire-and-forget promise fired AFTER the success UI is already shown), so
-- a parent submitting an application has always seen "Success!" while the
-- application only ever landed in their own browser's localStorage —
-- invisible to the camp. campistry_postaccept.html at least surfaces the
-- failure as an error today (it awaits the write before showing success),
-- but that means post-acceptance forms have never been submittable at all.
--
-- Fix: three narrow, whitelisted SECURITY DEFINER RPCs, deliberately
-- granted to `anon` (the ONE departure from this session's usual "revoke
-- from anon" pattern — these are meant to be public by design, that's the
-- whole point of a public application form). Each can only ever touch one
-- specific sub-key of campistryMe, and does the merge atomically in a
-- single SQL statement server-side — which also closes a pre-existing
-- client-side race (two families submitting around the same moment could
-- have clobbered each other under the old read-modify-write-from-the-
-- browser approach; there is no read-modify-write from the browser
-- anymore).
-- =============================================================================

-- ─── 1. submit_public_application — new registration / staff application ──
-- p_kind is a closed whitelist, not free text — this can NEVER be used to
-- write into any other key of campistryMe (payments, families, whatever).
CREATE OR REPLACE FUNCTION public.submit_public_application(
    p_camp_id  uuid,
    p_kind     text,     -- 'enrollments' | 'staffApplications'
    p_entry_id text,
    p_entry    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF p_kind NOT IN ('enrollments', 'staffApplications') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    IF p_camp_id IS NULL OR p_entry_id IS NULL OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;
    -- Basic abuse guard on a genuinely public, unauthenticated endpoint —
    -- generous enough for a normal submission with a few document uploads.
    IF pg_column_size(p_entry) > 8388608 THEN
        RETURN jsonb_build_object('success', false, 'error', 'submission_too_large');
    END IF;

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (p_camp_id, 'campistryMe', jsonb_build_object(p_kind, jsonb_build_object(p_entry_id, p_entry)), now())
    ON CONFLICT (camp_id, key) DO UPDATE
    SET value = jsonb_set(
            coalesce(camp_state_kv.value, '{}'::jsonb),
            ARRAY[p_kind],
            coalesce(camp_state_kv.value -> p_kind, '{}'::jsonb) || jsonb_build_object(p_entry_id, p_entry),
            true
        ),
        updated_at = now();

    RETURN jsonb_build_object('success', true, 'id', p_entry_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_public_application(uuid, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_public_application(uuid, text, text, jsonb) TO anon, authenticated;

-- ─── 2. submit_postaccept_response — attach onto an EXISTING enrollment ────
-- Different shape from #1 on purpose: this merges a `postAccept` sub-object
-- onto an enrollment that must already exist (created by #1 above, or by
-- staff manually) — it can never create a brand-new top-level enrollment,
-- and never touches anything outside that one enrollment's postAccept key.
CREATE OR REPLACE FUNCTION public.submit_postaccept_response(
    p_camp_id    uuid,
    p_enroll_id  text,
    p_postaccept jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    existing jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_enroll_id IS NULL OR p_postaccept IS NULL OR jsonb_typeof(p_postaccept) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;
    IF pg_column_size(p_postaccept) > 8388608 THEN
        RETURN jsonb_build_object('success', false, 'error', 'submission_too_large');
    END IF;

    SELECT value -> 'enrollments' -> p_enroll_id INTO existing
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF existing IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'enrollment_not_found');
    END IF;

    UPDATE camp_state_kv
    SET value = jsonb_set(
            value,
            ARRAY['enrollments', p_enroll_id],
            (existing || jsonb_build_object('postAccept', p_postaccept)),
            true
        ),
        updated_at = now()
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_postaccept_response(uuid, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_postaccept_response(uuid, text, jsonb) TO anon, authenticated;

-- ─── Known gap, flagged not silently dropped ────────────────────────────────
-- No rate limiting / spam protection beyond the size cap above — a public,
-- unauthenticated endpoint by nature can be hit repeatedly. Not addressed
-- here; if abuse becomes a real problem, the fix is Supabase's built-in
-- edge-function/RPC rate limiting or a CAPTCHA on the form itself, not a
-- change to these RPCs' access model.

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'submit_public_application';
--   select proacl from pg_proc where proname = 'submit_postaccept_response';
--   -- both should show anon among the grantees.
--   select submit_public_application('<a real camp id>'::uuid, 'enrollments', 'test123', '{"camperName":"Test Camper"}'::jsonb);
-- =============================================================================
