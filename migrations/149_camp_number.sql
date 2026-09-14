-- =============================================================================
-- 149 — the payment reference a parent actually types
--
-- Deposits are matched by a code in the memo. Until now that code was derived
-- from the family name (KLE-1234), which works and cannot be said out loud: no
-- parent knows their family's hash, so the camp has to look it up and send it
-- to them individually.
--
-- The reference is now <camp number>-<camper number>, e.g. 1234-5678. A parent
-- knows their child, so a camp can put one sentence on a registration form and
-- every family can act on it without being told anything personal.
--
-- The camp number is also the GUARD. Bank messages are full of digit pairs that
-- look like a reference -- dates ("2026-09"), confirmation numbers, account
-- fragments -- so the first half must equal this camp's own number before the
-- second half is read as a camper at all. Two independent things have to line
-- up, and the camp's number does not appear in a message by accident.
--
-- Four digits, assigned once, unique across camps. Unique is not a security
-- property here (every camp has its own inbox already) -- it just means two
-- camps comparing notes are never confused about whose reference is whose.
--
-- Idempotent -- safe to re-run. Run AFTER 145/145a.
-- =============================================================================

ALTER TABLE camp_deposit_settings ADD COLUMN IF NOT EXISTS camp_number text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS camp_deposit_settings_number_uq
    ON camp_deposit_settings (camp_number) WHERE camp_number <> '';


-- Assigns this camp a four-digit number the first time one is needed.
-- Retries on collision; after enough attempts it widens to five digits rather
-- than failing, because a camp with no reference cannot be paid by reference.
CREATE OR REPLACE FUNCTION public._deposit_assign_camp_number(p_camp_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_existing text;
    v_try      text;
    i          integer := 0;
BEGIN
    SELECT camp_number INTO v_existing FROM camp_deposit_settings WHERE camp_id = p_camp_id;
    IF COALESCE(v_existing, '') <> '' THEN RETURN v_existing; END IF;

    LOOP
        i := i + 1;
        IF i <= 40 THEN
            v_try := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
        ELSE
            v_try := lpad((10000 + floor(random() * 90000))::int::text, 5, '0');
        END IF;

        BEGIN
            UPDATE camp_deposit_settings SET camp_number = v_try, updated_at = now()
             WHERE camp_id = p_camp_id;
            RETURN v_try;
        EXCEPTION WHEN unique_violation THEN
            IF i > 80 THEN RETURN ''; END IF;
        END;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_assign_camp_number(uuid) FROM public, anon, authenticated;


-- Settings now mint and return the camp number alongside the inbound token.
CREATE OR REPLACE FUNCTION public.get_camp_deposit_settings(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_deposit_settings;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_deposit_settings (camp_id, inbound_token)
    VALUES (p_camp_id, replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (camp_id) DO NOTHING;

    PERFORM _deposit_assign_camp_number(p_camp_id);
    SELECT * INTO v_row FROM camp_deposit_settings WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'enabled', v_row.enabled,
        'inboundToken', v_row.inbound_token,
        'campNumber', v_row.camp_number,
        'senderAllowlist', to_jsonb(v_row.sender_allowlist),
        'autoPostAt', v_row.auto_post_at,
        'suggestAt', v_row.suggest_at,
        'ambiguousGap', v_row.ambiguous_gap,
        'dryRun', v_row.dry_run
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_camp_deposit_settings(uuid) TO authenticated;


-- The edge function matches a payment reference against the camp's own
-- number, so the token lookup has to hand it over. Without this the first
-- half never matches and every reference is silently ignored.
CREATE OR REPLACE FUNCTION public._deposit_camp_for_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_deposit_settings;
BEGIN
    SELECT * INTO v_row FROM camp_deposit_settings
     WHERE inbound_token = p_token AND enabled = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'unknown_token');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'campId', v_row.camp_id,
        'campNumber', v_row.camp_number,
        'senderAllowlist', to_jsonb(v_row.sender_allowlist),
        'autoPostAt', v_row.auto_post_at,
        'suggestAt', v_row.suggest_at,
        'ambiguousGap', v_row.ambiguous_gap,
        'dryRun', v_row.dry_run
    );
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_camp_for_token(text) FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
