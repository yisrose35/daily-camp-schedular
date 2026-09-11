-- =============================================================================
-- 148 — learn a bank's layout from the corrections staff already make
--
-- WHY
--
-- 147 lets a camp teach a layout deliberately. Most camps never will. But every
-- time staff fix a deposit in the inbox they produce a labelled example without
-- meaning to: the message is on the row (raw_excerpt, from 146) and the value
-- they confirmed is the answer. Finding that value inside that text gives the
-- same offsets a highlight would have, so the same learner runs on it.
--
-- A camp that never opens the teaching screen therefore still ends up with a
-- working template, assembled out of the corrections it was making anyway.
--
-- CORROBORATION, AGAIN
--
-- A rule derived from ONE correction is a guess. A typo, a staff member
-- pasting the wrong name, a one-off forwarded message — any of these would
-- produce a rule that fits that message and nothing else.
--
-- So derived rules land in bank_template_candidates and are counted. Only when
-- the SAME rules (template_hash) come out of two independent deposits does the
-- template become real. Two different mistakes do not produce the same hash;
-- two correct readings of the same bank always do. Same defence that gates
-- cross-camp sharing in 147, for the same reason.
--
-- PRECEDENCE
--
-- A derived template never displaces one a camp taught on purpose. Teaching is
-- an explicit statement about your own mail; deriving is an inference from it.
-- source tells them apart, and promotion simply does not happen when a taught
-- template already exists for that camp and bank.
--
-- AUTHORITY IS UNCHANGED
--
-- Nothing here lets money move more easily. A payer name from a derived
-- template scores what any other payer name scores (88, below the 90 auto-post
-- line), and the amount is only ever confirmed against the generic parser,
-- never overridden. This widens coverage, not permission.
--
-- Idempotent -- safe to re-run. Run AFTER 145, 146 and 147.
-- =============================================================================

-- Which address the alert came from. Needed because a template is keyed on the
-- bank's SENDING DOMAIN, and until now nothing on the row recorded it.
ALTER TABLE bank_deposits  ADD COLUMN IF NOT EXISTS from_address text NOT NULL DEFAULT '';

ALTER TABLE bank_templates ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'taught';
ALTER TABLE bank_templates DROP CONSTRAINT IF EXISTS bank_templates_source_check;
ALTER TABLE bank_templates ADD CONSTRAINT bank_templates_source_check
    CHECK (source IN ('taught', 'auto'));


CREATE TABLE IF NOT EXISTS bank_template_candidates (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id        uuid NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
    bank_signature text NOT NULL,
    template_hash  text NOT NULL,
    template       jsonb NOT NULL,
    -- Distinct deposits that produced exactly these rules.
    seen           integer NOT NULL DEFAULT 1,
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    promoted_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_template_candidates_uq
    ON bank_template_candidates (camp_id, bank_signature, template_hash);

ALTER TABLE bank_template_candidates ENABLE ROW LEVEL SECURITY;


-- Called by the browser right after staff resolve a deposit: it derives the
-- rules client-side (campistry_deposit_template.deriveFromCorrection) and
-- offers them here. Admin-gated like every other deposit RPC.
CREATE OR REPLACE FUNCTION public.learn_template_from_correction(
    p_camp_id        uuid,
    p_bank_signature text,
    p_template       jsonb,
    p_template_hash  text,
    p_is_shareable   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- Independent deposits that must yield identical rules before those rules
    -- are used on real mail.
    c_promote_at constant integer := 2;
    v_sig      text := lower(btrim(COALESCE(p_bank_signature, '')));
    v_seen     integer;
    v_taught   boolean;
    v_promoted boolean := false;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF v_sig = '' OR p_template IS NULL OR p_template->'fields' IS NULL
       OR p_template->'fields' = '{}'::jsonb OR COALESCE(p_template_hash, '') = '' THEN
        -- Nothing usable to learn from. Not an error: most corrections are on
        -- messages where the confirmed value does not appear verbatim.
        RETURN jsonb_build_object('success', true, 'learned', false);
    END IF;

    INSERT INTO bank_template_candidates (camp_id, bank_signature, template_hash, template)
    VALUES (p_camp_id, v_sig, p_template_hash, p_template)
    ON CONFLICT (camp_id, bank_signature, template_hash)
    DO UPDATE SET seen = bank_template_candidates.seen + 1,
                  last_seen_at = now()
    RETURNING seen INTO v_seen;

    SELECT EXISTS (
        SELECT 1 FROM bank_templates
         WHERE scope = 'camp' AND camp_id = p_camp_id
           AND bank_signature = v_sig AND source = 'taught'
    ) INTO v_taught;

    -- A camp that taught its own layout has said what its mail looks like.
    -- An inference does not get to argue with that.
    IF v_seen >= c_promote_at AND NOT v_taught THEN
        INSERT INTO bank_templates (
            camp_id, scope, bank_signature, bank_label,
            template, template_hash, is_shareable, source
        )
        VALUES (
            p_camp_id, 'camp', v_sig, v_sig,
            p_template, p_template_hash, COALESCE(p_is_shareable, false), 'auto'
        )
        ON CONFLICT (camp_id, bank_signature) WHERE scope = 'camp'
        DO UPDATE SET
            template      = EXCLUDED.template,
            template_hash = EXCLUDED.template_hash,
            is_shareable  = EXCLUDED.is_shareable,
            -- The counters described the rules being replaced, so they would
            -- misreport the new ones.
            hits = 0, misses = 0, conflicts = 0,
            updated_at    = now()
         WHERE bank_templates.source = 'auto'
           AND bank_templates.template_hash <> EXCLUDED.template_hash;

        UPDATE bank_template_candidates SET promoted_at = now()
         WHERE camp_id = p_camp_id AND bank_signature = v_sig
           AND template_hash = p_template_hash AND promoted_at IS NULL;
        v_promoted := true;
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'learned', true,
        'seen', v_seen, 'promoteAt', c_promote_at,
        'promoted', v_promoted, 'blockedByTaught', v_taught
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.learn_template_from_correction(uuid, text, jsonb, text, boolean) TO authenticated;


-- get_bank_deposits must hand the browser from_address, or it cannot tell
-- which bank a correction is teaching it about.
CREATE OR REPLACE FUNCTION public.get_bank_deposits(
    p_camp_id uuid,
    p_status  text DEFAULT NULL,
    p_limit   integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out jsonb;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(d)::jsonb ORDER BY d.deposit_date DESC NULLS LAST, d.created_at DESC), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT id, fingerprint, amount_cents, is_reversal, deposit_date,
               payer_name, payer_handle, memo, memo_code, kind, trace_id,
               bank, source, raw_subject, raw_excerpt, parse_reason, from_address,
               status, family_key, match_confidence,
               match_reasons, candidates, guardrail, matched_by,
               resolved_by, resolved_at, created_at
          FROM bank_deposits
         WHERE camp_id = p_camp_id
           AND (p_status IS NULL OR status = p_status)
         ORDER BY deposit_date DESC NULLS LAST, created_at DESC
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
      ) d;

    RETURN jsonb_build_object('success', true, 'deposits', v_out);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_bank_deposits(uuid, text, integer) TO authenticated;


-- _deposit_record stores the sending address, so a correction on this row can
-- say which bank's layout it is teaching. Same signature; it just reads one
-- more key out of the deposit payload.
CREATE OR REPLACE FUNCTION public._deposit_record(
    p_camp_id      uuid,
    p_fingerprint  text,
    p_amount_cents integer,
    p_deposit      jsonb,
    p_decision     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id       uuid;
    v_status   text := COALESCE(p_decision->>'decision', 'unmatched');
    v_family   text := NULLIF(p_decision->>'familyKey', '');
    v_dup      boolean := false;
BEGIN
    IF v_status = 'auto' THEN v_status := 'posted'; END IF;
    IF v_status NOT IN ('posted', 'review', 'unmatched', 'ignored') THEN
        v_status := 'unmatched';
    END IF;
    IF v_status = 'posted' AND v_family IS NULL THEN
        v_status := 'review';
    END IF;

    INSERT INTO bank_deposits (
        camp_id, fingerprint, amount_cents, is_reversal, deposit_date,
        payer_name, payer_handle, memo, memo_code, kind, trace_id, bank,
        source, raw_subject, raw_excerpt, from_address, status, family_key, match_confidence,
        match_reasons, candidates, guardrail, matched_by, resolved_at
    ) VALUES (
        p_camp_id,
        p_fingerprint,
        abs(p_amount_cents),
        COALESCE((p_deposit->>'isReversal')::boolean, false),
        NULLIF(p_deposit->>'date', '')::date,
        COALESCE(p_deposit->>'payerName', ''),
        COALESCE(p_deposit->>'payerHandle', ''),
        COALESCE(p_deposit->>'memo', ''),
        COALESCE(p_deposit->>'memoCode', ''),
        COALESCE(NULLIF(p_deposit->>'kind', ''), 'ach'),
        COALESCE(p_deposit->>'traceId', ''),
        COALESCE(p_deposit->>'bank', ''),
        COALESCE(NULLIF(p_deposit->>'source', ''), 'email'),
        COALESCE(p_deposit->>'rawSubject', ''),
        COALESCE(LEFT(p_deposit->>'rawExcerpt', 4000), ''),
        COALESCE(LEFT(lower(p_deposit->>'fromAddress'), 200), ''),
        v_status,
        v_family,
        COALESCE((p_decision->>'confidence')::integer, 0),
        COALESCE(p_decision->'reasons', '[]'::jsonb),
        COALESCE(p_decision->'candidates', '[]'::jsonb),
        COALESCE(p_decision->>'guardrail', ''),
        'auto',
        CASE WHEN v_status = 'posted' THEN now() ELSE NULL END
    )
    ON CONFLICT (camp_id, fingerprint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        v_dup := true;
        SELECT id INTO v_id FROM bank_deposits
         WHERE camp_id = p_camp_id AND fingerprint = p_fingerprint;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', v_id,
                              'duplicate', v_dup, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public._deposit_record(uuid, text, integer, jsonb, jsonb) FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
