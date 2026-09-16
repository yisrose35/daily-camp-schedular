-- =============================================================================
-- 167 — a registration deposit on Sola / Cardknox
--
-- I said this rail had no hosted page. It does: cardknox-checkout-start already
-- mints a Sola-hosted checkout at secure.cardknox.com/<slug> with a real
-- per-transaction amount (?xAmount=), correlated back through xInvoice to an
-- intent row (migration 134), and cardknox-webhook resolves it. Card saving is
-- there too, through Sola's cc:save (migrations 135/136). Nothing new had to be
-- invented -- only taught about applications.
--
-- Every other kind of intent belongs to a FAMILY or a CAMPER. A registration
-- deposit belongs to neither: the family record does not exist until the office
-- accepts. So the intent gains an application to point at.
--
-- Idempotent -- safe to re-run. Requires 134, 136 and 185.
-- =============================================================================

-- ─── 1. an intent can belong to an application ──────────────────────────────
ALTER TABLE public.cardknox_checkout_intents
    ADD COLUMN IF NOT EXISTS enrollment_id text;

-- The kind list has been widened once already (136). Drop the constraint by
-- its known name first -- that is how 136 did it and the name has not moved --
-- and then sweep up any copy under a different name, so re-running this cannot
-- collide with one that is already there.
--
-- NOT matched on 'kind%IN%': Postgres does not store a CHECK as it was
-- written. `kind IN (...)` is normalised to `kind = ANY (ARRAY[...])`, so a
-- pattern looking for IN matches nothing, drops nothing, and the ADD below
-- then fails with "constraint already exists". 136's own sanity note prints
-- the ANY form; that is the shape to match.
ALTER TABLE public.cardknox_checkout_intents
    DROP CONSTRAINT IF EXISTS cardknox_checkout_intents_kind_check;

DO $$
DECLARE c_name text;
BEGIN
    FOR c_name IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'public.cardknox_checkout_intents'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%kind%'
    LOOP
        EXECUTE format('ALTER TABLE public.cardknox_checkout_intents DROP CONSTRAINT %I', c_name);
    END LOOP;
END $$;

ALTER TABLE public.cardknox_checkout_intents
    ADD CONSTRAINT cardknox_checkout_intents_kind_check
    CHECK (kind IN ('tuition_charge', 'canteen_deposit', 'card_save',
                    'canteen_autoreload_setup', 'registration_deposit'));

-- ─── 2. create one for an application ───────────────────────────────────────
-- A new signature rather than a changed one: the four-argument callers in
-- cardknox-checkout-start keep working untouched while this ships.
CREATE OR REPLACE FUNCTION public.create_cardknox_registration_intent(
    p_camp_id      uuid,
    p_reference    text,
    p_enroll_id    text,
    p_amount_cents integer,
    p_description  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO cardknox_checkout_intents
        (camp_id, reference, kind, enrollment_id, amount_cents, description)
    VALUES
        (p_camp_id, p_reference, 'registration_deposit', p_enroll_id, p_amount_cents, p_description);
    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_reference');
END;
$$;

REVOKE ALL ON FUNCTION public.create_cardknox_registration_intent(uuid, text, text, integer, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_cardknox_registration_intent(uuid, text, text, integer, text)
    TO service_role;

-- ─── 3. the webhook has to be able to SEE the application ───────────────────
-- get_cardknox_checkout_intent returns a fixed set of fields, so without this
-- the webhook would resolve a registration deposit and have nowhere to put it.
CREATE OR REPLACE FUNCTION public.get_cardknox_checkout_intent(p_reference text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN i.id IS NULL THEN jsonb_build_object('success', false, 'error', 'not_found')
                ELSE jsonb_build_object(
                    'success', true,
                    'campId', i.camp_id,
                    'kind', i.kind,
                    'familyKey', i.family_key,
                    'familyName', i.family_name,
                    'camperName', i.camper_name,
                    'enrollmentId', i.enrollment_id,
                    'amountCents', i.amount_cents,
                    'description', i.description,
                    'status', i.status
                )
           END
      FROM (SELECT 1) x
      LEFT JOIN cardknox_checkout_intents i ON i.reference = p_reference;
$$;

REVOKE ALL ON FUNCTION public.get_cardknox_checkout_intent(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cardknox_checkout_intent(text) TO service_role;

NOTIFY pgrst, 'reload schema';
