-- =============================================================================
-- 147 — learned bank alert layouts
--
-- A camp has ONE bank account, so every payment it receives all season arrives
-- in the same email layout. Rather than parse prose forever, a camp points at
-- the name, the amount and the memo in one of its own emails once, and
-- campistry_deposit_template.js turns that into two rules per field (a text
-- anchor and a line shape). This is where those rules live.
--
-- TWO SCOPES
--
--   scope='camp'    taught by that camp, used only by that camp. Always wins
--                   over a shared template: the camp that owns the mailbox is
--                   the authority on what its own mail looks like.
--   scope='shared'  the same layout, independently taught by several camps,
--                   offered to every camp that later connects the same bank.
--                   This is the compounding: the tenth camp on Capital One
--                   gets a working reader before it sends its first email.
--
-- WHY PROMOTION NEEDS CORROBORATION
--
-- A shared template is code one camp writes and other camps run. Two risks,
-- one defence.
--
--   Bad teaching   a careless highlight produces a template that works for
--                  that camp and fails elsewhere.
--   Leaked data    an anchor is meant to be boilerplate, but a highlight that
--                  stops a character early bakes part of a family's name into
--                  one, and sharing it would hand that to another camp.
--
-- Promotion requires N DISTINCT camps to have independently produced the SAME
-- rules (template_hash). That is a real defence rather than a hopeful one:
-- boilerplate is identical across camps, so correct templates converge on one
-- hash, while anything contaminated with a family name, an account number or a
-- sloppy boundary is unique to the camp that made it and can never reach the
-- threshold. is_shareable is additionally computed client-side and must be
-- true; it is the cheap check, corroboration is the one that matters.
--
-- Idempotent -- safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bank_templates (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL for a shared template: it belongs to no camp.
    camp_id        uuid REFERENCES camps(id) ON DELETE CASCADE,
    scope          text NOT NULL DEFAULT 'camp' CHECK (scope IN ('camp', 'shared')),

    -- The bank's SENDING DOMAIN, not a typed name: "Chase", "chase bank" and
    -- "JPM Chase" are one bank and three strings, but email.chase.com is
    -- something the bank itself controls.
    bank_signature text NOT NULL,
    bank_label     text NOT NULL DEFAULT '',   -- display only

    template       jsonb NOT NULL,             -- { fields: {...}, meta: {...} }
    template_hash  text NOT NULL,              -- rules only; identical across camps
    is_shareable   boolean NOT NULL DEFAULT false,

    -- How the template is actually doing on live mail. A template that stops
    -- working must be visible, not quietly wrong: conflicts counts the emails
    -- where the anchor and the line rule disagreed, which is the earliest
    -- signal that the bank changed its layout.
    hits           integer NOT NULL DEFAULT 0,
    misses         integer NOT NULL DEFAULT 0,
    conflicts      integer NOT NULL DEFAULT 0,
    last_used_at   timestamptz,

    taught_by      uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bank_templates_scope_camp
        CHECK ((scope = 'camp' AND camp_id IS NOT NULL)
            OR (scope = 'shared' AND camp_id IS NULL))
);

-- One template per camp per bank, and one shared template per bank.
CREATE UNIQUE INDEX IF NOT EXISTS bank_templates_camp_uq
    ON bank_templates (camp_id, bank_signature) WHERE scope = 'camp';
CREATE UNIQUE INDEX IF NOT EXISTS bank_templates_shared_uq
    ON bank_templates (bank_signature) WHERE scope = 'shared';

ALTER TABLE bank_templates ENABLE ROW LEVEL SECURITY;


-- ─── read ────────────────────────────────────────────────────────────────────
-- A camp gets its own templates plus every shared one. The caller decides
-- precedence; get_bank_templates just reports scope so it can.
CREATE OR REPLACE FUNCTION public.get_bank_templates(p_camp_id uuid)
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

    SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.scope, t.bank_signature), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT id, scope, bank_signature, bank_label, template, is_shareable,
               hits, misses, conflicts, last_used_at, created_at
          FROM bank_templates
         WHERE (scope = 'camp' AND camp_id = p_camp_id)
            OR scope = 'shared'
      ) t;

    RETURN jsonb_build_object('success', true, 'templates', v_out);
END;
$$;


-- ─── write ───────────────────────────────────────────────────────────────────
-- Saves the camp's template, then checks whether this layout now has enough
-- independent corroboration to be offered to everyone.
CREATE OR REPLACE FUNCTION public.save_bank_template(
    p_camp_id       uuid,
    p_bank_signature text,
    p_bank_label    text,
    p_template      jsonb,
    p_template_hash text,
    p_is_shareable  boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- Distinct camps that must independently produce identical rules before
    -- those rules are shown to a camp that did not write them.
    c_promote_at constant integer := 3;
    v_id      uuid;
    v_agree   integer;
    v_shared  uuid;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF p_bank_signature IS NULL OR btrim(p_bank_signature) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bank_signature_required');
    END IF;
    IF p_template IS NULL OR p_template->'fields' IS NULL
       OR jsonb_typeof(p_template->'fields') <> 'object'
       OR p_template->'fields' = '{}'::jsonb THEN
        RETURN jsonb_build_object('success', false, 'error', 'template_empty');
    END IF;

    INSERT INTO bank_templates (
        camp_id, scope, bank_signature, bank_label,
        template, template_hash, is_shareable, taught_by
    )
    VALUES (
        p_camp_id, 'camp', lower(btrim(p_bank_signature)), COALESCE(p_bank_label, ''),
        p_template, COALESCE(p_template_hash, ''), COALESCE(p_is_shareable, false), auth.uid()
    )
    ON CONFLICT (camp_id, bank_signature) WHERE scope = 'camp'
    DO UPDATE SET
        bank_label    = EXCLUDED.bank_label,
        template      = EXCLUDED.template,
        template_hash = EXCLUDED.template_hash,
        is_shareable  = EXCLUDED.is_shareable,
        -- Re-teaching is a fresh start: the old counts described a rule that
        -- no longer exists and would hide whether the new one works.
        hits = 0, misses = 0, conflicts = 0,
        taught_by     = auth.uid(),
        updated_at    = now()
    RETURNING id INTO v_id;

    -- Promotion. Counted over DISTINCT camps, so one camp re-teaching the same
    -- layout ten times still counts once.
    IF COALESCE(p_is_shareable, false) AND COALESCE(p_template_hash, '') <> '' THEN
        SELECT COUNT(DISTINCT camp_id) INTO v_agree
          FROM bank_templates
         WHERE scope = 'camp'
           AND bank_signature = lower(btrim(p_bank_signature))
           AND template_hash = p_template_hash
           AND is_shareable;

        IF v_agree >= c_promote_at THEN
            INSERT INTO bank_templates (
                camp_id, scope, bank_signature, bank_label,
                template, template_hash, is_shareable
            )
            VALUES (
                NULL, 'shared', lower(btrim(p_bank_signature)), COALESCE(p_bank_label, ''),
                p_template, p_template_hash, true
            )
            ON CONFLICT (bank_signature) WHERE scope = 'shared'
            DO UPDATE SET
                template      = EXCLUDED.template,
                template_hash = EXCLUDED.template_hash,
                updated_at    = now()
             WHERE bank_templates.template_hash <> EXCLUDED.template_hash
            RETURNING id INTO v_shared;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'id', v_id,
        'corroborations', COALESCE(v_agree, 0),
        'promoted', v_shared IS NOT NULL,
        'promoteAt', c_promote_at
    );
END;
$$;


CREATE OR REPLACE FUNCTION public.delete_bank_template(p_camp_id uuid, p_bank_signature text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    -- Only ever the camp's own row. A shared template is not one camp's to
    -- withdraw; a camp that disagrees with it teaches its own, which wins.
    DELETE FROM bank_templates
     WHERE scope = 'camp' AND camp_id = p_camp_id
       AND bank_signature = lower(btrim(p_bank_signature));
    RETURN jsonb_build_object('success', true);
END;
$$;


-- ─── scoring (service role only) ─────────────────────────────────────────────
-- Called by deposit-inbox on every email so a template that has stopped
-- working shows up as a number instead of as a quiet wrong answer.
CREATE OR REPLACE FUNCTION public._bank_template_result(
    p_camp_id        uuid,
    p_bank_signature text,
    p_outcome        text          -- 'hit' | 'miss' | 'conflict'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    UPDATE bank_templates SET
        hits         = hits      + CASE WHEN p_outcome = 'hit'      THEN 1 ELSE 0 END,
        misses       = misses    + CASE WHEN p_outcome = 'miss'     THEN 1 ELSE 0 END,
        conflicts    = conflicts + CASE WHEN p_outcome = 'conflict' THEN 1 ELSE 0 END,
        last_used_at = now(),
        updated_at   = now()
     WHERE bank_signature = lower(btrim(p_bank_signature))
       AND ((scope = 'camp' AND camp_id = p_camp_id) OR scope = 'shared');
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public._bank_template_result(uuid, text, text) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_bank_templates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_bank_template(uuid, text, text, jsonb, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_bank_template(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
