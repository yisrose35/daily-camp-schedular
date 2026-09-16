-- ============================================================================
-- Migration 184: a public form submission creates a record. It does not get to
-- replace one.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own. Idempotent.
--
-- ── THE HOLE ───────────────────────────────────────────────────────────────
-- submit_public_application is anon-callable by design — that is how a family
-- applies. But the entry id comes from the CLIENT, and the write was an
-- unconditional merge at that key:
--
--     coalesce(value -> p_kind, '{}') || jsonb_build_object(p_entry_id, p_entry)
--
-- `||` at the top level REPLACES the whole object at that key. So anyone who
-- knew (or guessed) an existing enrollment id could post to it and overwrite
-- that camper's record wholesale — session, tuition, discount, status, the lot.
-- No login, from a public endpoint. The camp would see an accepted camper
-- silently become something else.
--
-- ── WHY NOT SIMPLY REFUSE AN ID THAT EXISTS ────────────────────────────────
-- Because the register page retries. It submits one call per camper and returns
-- on the first failure, so a partial success followed by a retry legitimately
-- re-sends a camper that already landed. A flat "must not exist" would turn
-- every retry into a permanent failure and lose the application.
--
-- The rule is therefore about STATE, not existence: a public submission may
-- write an entry that is still `status = 'applied'` — which is what both public
-- forms create and what a retry re-sends — and is refused the moment the office
-- has acted on it. Accepted, enrolled, declined, hired: all closed to the
-- public endpoint. That keeps the retry working and shuts the overwrite.
--
-- ── AND THE ID HAS TO BE WORTH SOMETHING ───────────────────────────────────
-- These ids are bearer tokens: get_postaccept_bootstrap, get_contract_offer and
-- friends hand over a family's or a staff member's details to whoever presents
-- one, including payType and payRate. They were minted client-side as
-- 'enr_<ms>_<6 base36>' and 'staff_<ms>_<4 base36>' — about 2.2 billion and 1.7
-- million combinations respectively, narrowed further by a timestamp an
-- attacker can bracket.
--
-- The forms now mint them from crypto.getRandomValues. This checks it, because
-- a convention held only in two HTML files is one edit from being gone, and the
-- thing it protects is somebody's salary. 32 characters admits the UUID-based
-- scheme (40 and 42) and rejects both old ones (24 and 22).
--
-- SAFE BECAUSE THERE ARE NO CAMPS YET: no existing entry ids have to keep
-- working. On a live database this length rule would have to be introduced
-- alongside a backfill.
-- ============================================================================

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
DECLARE
    v_existing jsonb;
    v_status   text;
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

    -- The id is a bearer token for everything downstream. A short one is not a
    -- token, it is a guess away from somebody's file.
    IF length(p_entry_id) < 32 THEN
        RETURN jsonb_build_object('success', false, 'error', 'weak_entry_id');
    END IF;

    -- Already there? Only a record the office has not touched may be written by
    -- the public endpoint. A retry re-sending its own fresh submission is still
    -- 'applied' and goes through; anything the camp has acted on is closed.
    SELECT value -> p_kind -> p_entry_id INTO v_existing
      FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF v_existing IS NOT NULL AND jsonb_typeof(v_existing) = 'object' THEN
        v_status := COALESCE(v_existing->>'status', '');
        IF v_status <> 'applied' THEN
            RETURN jsonb_build_object('success', false, 'error', 'already_processed',
                                      'status', v_status);
        END IF;
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


-- ─── Checking it ───────────────────────────────────────────────────────────
-- A weak id is refused outright:
--   select submit_public_application('<camp>'::uuid, 'enrollments',
--     'enr_1780000000000_ab12cd', '{"status":"applied"}'::jsonb);
--   -- {"success": false, "error": "weak_entry_id"}
--
-- A fresh submission goes in, and re-sending it (the retry path) still works:
--   select submit_public_application('<camp>'::uuid, 'enrollments',
--     'enr_' || gen_random_uuid(), '{"camperName":"Test","status":"applied"}'::jsonb);
--   -- success both times for the same id
--
-- Once the office accepts it, the public endpoint is shut out. Set the status
-- to 'accepted' in Me, then re-send the same id:
--   -- {"success": false, "error": "already_processed", "status": "accepted"}
--   -- and the record in camp_state_kv is unchanged.
-- ============================================================================
