-- Behaviour test for migration 212 (family readers move to the rows).
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name)
VALUES ('99999999-9999-9999-9999-999999999999', NULL, 'Read Swap Families');

INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('99999999-9999-9999-9999-999999999999', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'g1', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Dov Gold'),
            'charges', jsonb_build_array(jsonb_build_object('amount',500,'date','2026-06-01'))),
    'g2', jsonb_build_object('name','Stern','camperIds', jsonb_build_array('Eli Stern'),
            'charges', jsonb_build_array(jsonb_build_object('amount',300,'date','2026-06-01'))))));

-- ── the accessors return the branch's own shape ────────────────────────────
DO $$
DECLARE o jsonb; one jsonb;
BEGIN
    o := public.camp_families_object('99999999-9999-9999-9999-999999999999');
    IF (SELECT count(*) FROM jsonb_object_keys(o)) <> 2 THEN
        RAISE EXCEPTION 'expected 2 families, got %', o;
    END IF;
    IF (o -> 'g1' ->> 'name') <> 'Gold' THEN RAISE EXCEPTION 'wrong payload: %', o; END IF;
    one := public.camp_family('99999999-9999-9999-9999-999999999999', 'g2');
    IF (one ->> 'name') <> 'Stern' THEN RAISE EXCEPTION 'camp_family wrong: %', one; END IF;
    IF public.camp_family('99999999-9999-9999-9999-999999999999', 'nope') IS NOT NULL THEN
        RAISE EXCEPTION 'an absent family must be NULL, as #> ARRAY[...] was';
    END IF;
    RAISE NOTICE 'ok  accessors return {key: payload}, and NULL for an absent family';
END $$;

-- ── the swap sees exactly what the document said ───────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    r := public.verify_families_read_swap('99999999-9999-9999-9999-999999999999');
    IF (r ->> 'sameFamilies') <> 'true' THEN RAISE EXCEPTION 'the swap changed what a reader sees: %', r; END IF;
    IF (r ->> 'chargedOld')::numeric <> 800 THEN RAISE EXCEPTION 'expected 800 charged, got %', r; END IF;
    IF (r ->> 'chargedOld')::numeric <> (r ->> 'chargedNew')::numeric THEN
        RAISE EXCEPTION 'charges differ across the swap: %', r;
    END IF;
    RAISE NOTICE 'ok  read swap: identical families, 800 charged on both sides';
END $$;

-- ── A SOFT-DELETED FAMILY DISAPPEARS FROM EVERY READER ─────────────────────
-- This is the behaviour the whole soft-delete design exists to give: removing a
-- family must stop it counting immediately, without destroying its record.
DO $$
DECLARE o jsonb; r jsonb;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{families}', (value -> 'families') - 'g2'), updated_at = now()
     WHERE camp_id = '99999999-9999-9999-9999-999999999999' AND key = 'campistryMe';

    o := public.camp_families_object('99999999-9999-9999-9999-999999999999');
    IF o ? 'g2' THEN RAISE EXCEPTION 'a removed family is still visible to readers: %', o; END IF;
    IF public.camp_family('99999999-9999-9999-9999-999999999999', 'g2') IS NOT NULL THEN
        RAISE EXCEPTION 'camp_family still returns a removed family';
    END IF;
    -- but the row, and its charges, still exist
    IF NOT EXISTS (SELECT 1 FROM camp_families
                    WHERE camp_id = '99999999-9999-9999-9999-999999999999'
                      AND family_key = 'g2' AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'the row was destroyed instead of stamped';
    END IF;

    r := public.verify_families_read_swap('99999999-9999-9999-9999-999999999999');
    IF (r ->> 'sameFamilies') <> 'true' THEN
        RAISE EXCEPTION 'after a removal the two homes should still agree: %', r;
    END IF;
    IF (r ->> 'chargedNew')::numeric <> 500 THEN
        RAISE EXCEPTION 'the removed family must stop counting: %', r;
    END IF;
    RAISE NOTICE 'ok  a removed family vanishes from readers but keeps its row';
END $$;

-- ── the parent slice reads live families only ──────────────────────────────
DO $$
DECLARE s jsonb;
BEGIN
    -- Dov Gold is in g1 (live). Eli Stern is in g2 (soft-deleted).
    s := public.parent_billing_slice('99999999-9999-9999-9999-999999999999',
                                     jsonb_build_array('Dov Gold'));
    IF NOT ((s -> 'families') ? 'g1') THEN RAISE EXCEPTION 'the live family is missing: %', s; END IF;
    s := public.parent_billing_slice('99999999-9999-9999-9999-999999999999',
                                     jsonb_build_array('Eli Stern'));
    IF (s -> 'families') <> '{}'::jsonb THEN
        RAISE EXCEPTION 'a soft-deleted family still reaches a parent balance: %', s;
    END IF;
    RAISE NOTICE 'ok  the parent slice counts live families only';
END $$;

-- ── the accessors are not reachable by a signed-in user ────────────────────
DO $$
BEGIN
    IF has_function_privilege('authenticated', 'public.camp_families_object(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'camp_families_object is callable by authenticated — that is a cross-camp read';
    END IF;
    IF has_function_privilege('authenticated', 'public.camp_family(uuid, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'camp_family is callable by authenticated — that is a cross-camp read';
    END IF;
    IF has_function_privilege('anon', 'public.camp_families_object(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'camp_families_object is callable by anon';
    END IF;
    RAISE NOTICE 'ok  the accessors are granted to nobody, so no cross-camp read';
END $$;

-- ── the office read is gated and shaped ───────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    r := public.get_camp_families('99999999-9999-9999-9999-999999999999');
    IF (r ->> 'error') <> 'not_authenticated' THEN
        RAISE EXCEPTION 'an unauthenticated caller must be refused: %', r;
    END IF;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS 'SELECT ''44444444-4444-4444-4444-444444444444''::uuid';
    r := public.get_camp_families('99999999-9999-9999-9999-999999999999');
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'office read failed: %', r; END IF;
    IF (r ->> 'count')::int <> 1 THEN
        RAISE EXCEPTION 'the office must see 1 live family, got %', r ->> 'count';
    END IF;
    IF (r -> 'families') ? 'g2' THEN RAISE EXCEPTION 'the office sees a removed family: %', r; END IF;

    CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
    RETURNS text LANGUAGE sql STABLE AS 'SELECT ''none''::text';
    r := public.get_camp_families('99999999-9999-9999-9999-999999999999');
    IF (r ->> 'error') <> 'not_authorized' THEN
        RAISE EXCEPTION 'me.billing=none must be refused: %', r;
    END IF;
    CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
    RETURNS text LANGUAGE sql STABLE AS 'SELECT ''edit''::text';
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
    RAISE NOTICE 'ok  the office read is gated on me.billing and shows live families only';
END $$;

-- ── a camp with no families ───────────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    INSERT INTO public.camps (id, owner, name)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, 'Empty');
    IF public.camp_families_object('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> '{}'::jsonb THEN
        RAISE EXCEPTION 'an empty camp must give {}, not null';
    END IF;
    r := public.verify_families_read_swap('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    IF (r ->> 'sameFamilies') <> 'true' THEN RAISE EXCEPTION 'empty camp mismatch: %', r; END IF;
    RAISE NOTICE 'ok  a camp with no families gives an empty object, not null';
END $$;

SELECT 'ALL 212 BEHAVIOUR CHECKS PASSED' AS result;
