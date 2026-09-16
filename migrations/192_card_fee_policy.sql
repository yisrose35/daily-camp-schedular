-- =============================================================================
-- 192 — passing card costs to the parent
--
-- Camps ask for this constantly: a family who pays by card pays the processing
-- cost, a family who sends a cheque does not. It is three different things, and
-- they are not interchangeable.
--
--   SURCHARGE — a percentage on CREDIT cards. Capped at the lesser of the camp's
--     cost of acceptance and 3%. Never on debit, prepaid, FSA, HSA or Medicare
--     Flex. Banned in CT, MA, ME and Puerto Rico, and in Louisiana from 1 August
--     2026. Needs 30 days' written notice to the processor. Must be refunded in
--     proportion whenever the payment is.
--
--   CONVENIENCE FEE — a FLAT amount for a channel. Applies to debit and ACH too.
--     Visa and American Express require it to be a fixed amount, which is the
--     usual way camps get this wrong: they set "2.9% convenience fee", which is
--     a surcharge wearing the wrong name and carries none of a surcharge's
--     protections.
--
--   CASH DISCOUNT — the card price is the posted price and non-card payers get a
--     discount. Legal everywhere, no cap, no card rules, no notice.
--
-- The arithmetic and every one of those guards live in campistry_card_fees.js.
-- This migration does the three database-shaped parts.
--
-- ── 1. THE FUNDING TYPE, WHICH IS THE WHOLE BALL GAME ────────────────────────
--
-- A surcharge on a debit card is a card-brand violation. Every card-saving path
-- in this codebase recorded the BRAND and the last four digits and threw the
-- FUNDING TYPE away, so there has never been a way to tell a debit card from a
-- credit one. campistry_card_fees.js therefore refuses to surcharge unless
-- funding is known to be 'credit' — not as a default to override, as the answer.
-- A camp whose processor cannot report funding cannot surcharge, and must use a
-- flat convenience fee or a cash discount instead.
--
-- So `funding` is captured and stored: on registration_card_captures, and on
-- each entry in families[].savedPaymentMethods (written by stripe-webhook in
-- this same change). Absent means "do not surcharge", never "assume credit".
--
-- ── 2. THE POLICY LIVES WITH THE OTHER PRICING RULES ─────────────────────────
--
-- enrollSettings.cardFeePolicy, beside depositPolicy — one blob, one writer, and
-- it reaches the public form the way the deposit rule already does.
--
-- ── 3. THE PUBLIC FORM HAS TO DISCLOSE IT BEFORE THE PARENT CHOOSES ──────────
--
-- Disclosure before the payment method is chosen is a card-brand requirement,
-- not a courtesy, and it is also what stops the fee becoming a dispute. So the
-- policy crosses to the anonymous form exactly as the deposit rule does: it is a
-- price, the same one a camp would print on a brochure.
--
-- Standalone — not in APPLY_BUNDLE.sql. Paste this file on its own. Idempotent.
-- Requires 164 (the public form config) and 189 (registration_card_captures).
-- =============================================================================

-- ─── 1. funding on a captured card ───────────────────────────────────────────
ALTER TABLE public.registration_card_captures
    ADD COLUMN IF NOT EXISTS funding text;

COMMENT ON COLUMN public.registration_card_captures.funding IS
    'credit | debit | prepaid | unknown, from the processor. A credit-card '
    'surcharge may only ever be applied when this reads ''credit''; absent means '
    'do not surcharge, never assume credit.';

-- Replaces 189's definition. Same guards — the bad-status refusal, the row lock,
-- the completed-is-final rule — with funding carried through.
CREATE OR REPLACE FUNCTION public.complete_card_capture(
    p_reference    text,
    p_status       text,
    p_customer_ref text,
    p_method_ref   text,
    p_last4        text,
    p_brand        text,
    p_error        text,
    p_funding      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_current text;
BEGIN
    IF p_status NOT IN ('completed', 'failed') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_status');
    END IF;

    SELECT status INTO v_current
      FROM registration_card_captures WHERE reference = p_reference FOR UPDATE;
    IF v_current IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;
    IF v_current = 'completed' THEN
        -- Already good. A retry does not get to undo that.
        RETURN jsonb_build_object('success', true, 'alreadyDone', true);
    END IF;

    UPDATE registration_card_captures
       SET status       = p_status,
           customer_ref = COALESCE(p_customer_ref, customer_ref),
           method_ref   = COALESCE(p_method_ref, method_ref),
           last4        = COALESCE(p_last4, last4),
           brand        = COALESCE(p_brand, brand),
           -- Only ever narrowed towards a known value, never widened: a retry
           -- that arrives without a funding type must not erase one we have.
           funding      = COALESCE(NULLIF(btrim(COALESCE(p_funding, '')), ''), funding),
           error_text   = p_error,
           completed_at = now()
     WHERE reference = p_reference;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- The 8-argument form is the one stripe-webhook now calls. The 7-argument form
-- from 189 is left in place: dropping it would break any in-flight caller, and a
-- default-valued 8th parameter cannot be reached by a positional 7-arg call.
REVOKE ALL ON FUNCTION public.complete_card_capture(text, text, text, text, text, text, text, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_card_capture(text, text, text, text, text, text, text, text)
    TO service_role;

-- ─── 2. reading and writing the policy ───────────────────────────────────────
/**
 * The camp's own fee policy, for the office settings screen.
 *
 * Owner-only. A camp-wide pricing rule is an owner decision, the same bar the
 * cancellation policy and the Tax ID use.
 */
CREATE OR REPLACE FUNCTION public.get_card_fee_policy(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_owner');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'policy', COALESCE(
            (SELECT value #> '{enrollSettings,cardFeePolicy}'
               FROM camp_state_kv
              WHERE camp_id = p_camp_id AND key = 'campistryMe'),
            '{}'::jsonb),
        -- The camp's address, as a HINT for the settings screen to pre-fill the
        -- state from. Deliberately not parsed into a state code here: the camp
        -- address is one free-text line, guessing a two-letter code out of it
        -- would be wrong often enough to matter, and this code decides whether a
        -- surcharge is lawful. The owner picks the state explicitly and it is
        -- stored on the policy.
        'camp_address', (SELECT COALESCE(NULLIF(btrim(c.address), ''), '') FROM camps c WHERE c.id = p_camp_id)
    );
END;
$$;

/**
 * Save it. Owner-only, and the surcharge percentage is clamped HERE as well as
 * in the module: a policy written by an older build, or edited straight in the
 * cloud, must not be able to exceed the card brands' cap either.
 */
CREATE OR REPLACE FUNCTION public.set_card_fee_policy(p_camp_id uuid, p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_mode text;
    v_pol  jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_owner');
    END IF;
    IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    v_mode := COALESCE(p_policy->>'mode', 'off');
    IF v_mode NOT IN ('off', 'surcharge', 'convenience', 'cash_discount') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_mode');
    END IF;

    v_pol := p_policy
        -- 3% is Visa's ceiling; Mastercard allows 4, so a camp taking both is
        -- held to 3. Clamped rather than rejected, so a camp that types 5 gets a
        -- working policy at 3 instead of a failed save.
        || jsonb_build_object('surchargePct',
             least(3, greatest(0, COALESCE(NULLIF(p_policy->>'surchargePct','')::numeric, 0))))
        -- A percentage is not a convenience fee. There is nowhere to put one, so
        -- anything non-numeric or negative becomes zero.
        || jsonb_build_object('convenienceFlat',
             greatest(0, COALESCE(NULLIF(p_policy->>'convenienceFlat','')::numeric, 0)));

    -- jsonb_set with create_missing, one path, server-side: campistryMe has one
    -- writer (the browser, which rewrites the whole object), so a read-modify-
    -- write from anywhere else loses whatever was saved in between.
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (p_camp_id, 'campistryMe',
            jsonb_build_object('enrollSettings', jsonb_build_object('cardFeePolicy', v_pol)), now())
    ON CONFLICT (camp_id, key) DO UPDATE
    SET value = jsonb_set(
            camp_state_kv.value,
            ARRAY['enrollSettings', 'cardFeePolicy'],
            v_pol,
            true
        ),
        updated_at = now();

    RETURN jsonb_build_object('success', true, 'policy', v_pol);
END;
$$;

REVOKE ALL ON FUNCTION public.get_card_fee_policy(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_card_fee_policy(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.set_card_fee_policy(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_card_fee_policy(uuid, jsonb) TO authenticated;

-- ─── 3. the public form learns the rule ──────────────────────────────────────
-- Replaces 164's get_public_form_config. Every field 164 returned is still
-- returned; cardFeePolicy joins depositPolicy for the same reason and with the
-- same reasoning: it is a price, not a fact about any family, and the form
-- cannot disclose a fee it has not been told about.
CREATE OR REPLACE FUNCTION public.get_public_form_config(
    p_camp_id uuid,
    p_kind    text   -- 'registration' | 'staff'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row  record;
    kv_value  jsonb;
BEGIN
    IF p_kind NOT IN ('registration', 'staff') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF p_kind = 'registration' THEN
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'formConfig', coalesce(kv_value -> 'formConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb),
            'sessionBundles', coalesce(kv_value -> 'sessionBundles', '[]'::jsonb),
            'promoCodes', coalesce(kv_value -> 'promoCodes', '{}'::jsonb),
            'schoolGrades', coalesce(kv_value #> '{bunkGenConfig,schoolGrades}', '[]'::jsonb),
            'allowParentPaymentPlans', coalesce(kv_value #> '{enrollSettings,allowParentPaymentPlans}', 'false'::jsonb),
            'depositPolicy', coalesce(kv_value #> '{enrollSettings,depositPolicy}', '{}'::jsonb),
            -- A fee a parent is not told about before they pick a card is both a
            -- card-brand violation and a chargeback waiting to happen.
            'cardFeePolicy', coalesce(kv_value #> '{enrollSettings,cardFeePolicy}', '{}'::jsonb)
        );
    ELSE
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'staffFormConfig', coalesce(kv_value -> 'staffFormConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb)
        );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_form_config(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_public_form_config(uuid, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- Verify after running:
--   -- the funding column exists:
--   select column_name from information_schema.columns
--    where table_name = 'registration_card_captures' and column_name = 'funding';
--
--   -- save a policy as the camp owner (from the app, not the SQL Editor, which
--   -- runs as a superuser and would bypass the owner check):
--   --   await supabase.rpc('set_card_fee_policy', { p_camp_id: campId,
--   --     p_policy: { mode:'surcharge', surchargePct: 5, state:'NY' } })
--   --   → policy.surchargePct comes back as 3, clamped to the brands' cap
--
--   -- and a non-owner is refused:
--   --   → { success:false, error:'not_owner' }
--
--   -- the public form can see the rule and nothing else:
--   select public.get_public_form_config('<camp uuid>', 'registration') -> 'cardFeePolicy';
