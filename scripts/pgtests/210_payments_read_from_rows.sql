-- Behaviour test for migration 210 (phase 2a: readers move to the rows).
-- Runs after 205, 208 and 209 have applied. Every check RAISEs on failure.
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name)
VALUES ('33333333-3333-3333-3333-333333333333', NULL, 'Read Swap Camp');

-- Two families, four payments, one pending, and one payment matched only by
-- enrollmentId (the autopay path) so all four match predicates are exercised.
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('33333333-3333-3333-3333-333333333333', 'campistryMe', jsonb_build_object(
  'enrollments', jsonb_build_object(
      'e1', jsonb_build_object('camperName','Ari Cohen','status','enrolled','session','1st Half','sessionTuition',1000),
      'e2', jsonb_build_object('camperName','Bina Levy','status','enrolled','session','1st Half','sessionTuition',1000)),
  'families', jsonb_build_object(
      'fk1', jsonb_build_object('name','Cohen','camperIds', jsonb_build_array('Ari Cohen')),
      'fk2', jsonb_build_object('name','Levy','camperIds', jsonb_build_array('Bina Levy'))),
  'sessions', jsonb_build_array(jsonb_build_object('name','1st Half','tuition',1000)),
  'finance', jsonb_build_object('payments', jsonb_build_array(
      jsonb_build_object('id','q1','family','Cohen','familyKey','fk1','amount',300,'status','','date','2026-06-01','method','card'),
      jsonb_build_object('id','q2','family','Levy','familyKey','fk2','amount',400,'status','','date','2026-06-02','method','ach'),
      jsonb_build_object('id','q3','family','Cohen','familyKey','fk1','amount',50,'status','pending','date','2026-06-03','method','card'),
      -- no family/familyKey at all: matched only by enrollmentId
      jsonb_build_object('id','q4','enrollmentId','e1','amount',125,'status','','date','2026-06-04','method','cash')
  ))));

-- NOTE: no manual fill of 205's camp_billing_* projections. 205 installs its own
-- trigger on camp_state_kv, so inserting the campistryMe row above already
-- populated them — the same thing that happens on the live database. Filling
-- them by hand here duplicated (camp_id, seq) and broke the primary key.

-- ── the swap returns exactly what it returned before ───────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    r := public.verify_payments_read_swap('33333333-3333-3333-3333-333333333333');
    IF (r ->> 'comparable') <> 'true' THEN
        RAISE EXCEPTION 'nothing to compare against — the fixture did not load: %', r;
    END IF;
    IF (r ->> 'sameOrderAndContent') <> 'true' THEN
        RAISE EXCEPTION 'the swap changed what a reader sees: %', r;
    END IF;
    IF (r ->> 'collectedOld')::numeric <> (r ->> 'collectedNew')::numeric THEN
        RAISE EXCEPTION 'collected money changed across the swap: %', r;
    END IF;
    IF (r ->> 'collectedNew')::numeric <> 825 THEN   -- 300 + 400 + 125, pending 50 excluded
        RAISE EXCEPTION 'expected 825 collected, got %', r ->> 'collectedNew';
    END IF;
    RAISE NOTICE 'ok  read swap: identical order, identical content, 825 both sides';
END $$;

-- ── the parent slice finds a payment by EACH of its four predicates ────────
DO $$
DECLARE s jsonb; ids text[];
BEGIN
    -- Ari Cohen: family name "Cohen" (q1, q3) and enrollmentId e1 (q4).
    s := public.parent_billing_slice('33333333-3333-3333-3333-333333333333',
                                     jsonb_build_array('Ari Cohen'));
    SELECT array_agg(e ->> 'id' ORDER BY e ->> 'id') INTO ids
      FROM jsonb_array_elements(s -> 'finance' -> 'payments') AS e;
    IF ids IS DISTINCT FROM ARRAY['q1','q3','q4'] THEN
        RAISE EXCEPTION 'Cohen should see q1,q3,q4 — got %', ids;
    END IF;
    -- and must NOT see the other family's payment
    IF 'q2' = ANY (ids) THEN RAISE EXCEPTION 'a parent can see another family payment'; END IF;

    s := public.parent_billing_slice('33333333-3333-3333-3333-333333333333',
                                     jsonb_build_array('Bina Levy'));
    SELECT array_agg(e ->> 'id' ORDER BY e ->> 'id') INTO ids
      FROM jsonb_array_elements(s -> 'finance' -> 'payments') AS e;
    IF ids IS DISTINCT FROM ARRAY['q2'] THEN
        RAISE EXCEPTION 'Levy should see only q2 — got %', ids;
    END IF;
    RAISE NOTICE 'ok  slice scopes to the parent: name, familyKey and enrollmentId all match';
END $$;

-- ── the slice keeps array order, and a status patch does not reorder ───────
DO $$
DECLARE s jsonb; ids text[];
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{finance,payments,0,status}', '"succeeded"'::jsonb),
           updated_at = now()
     WHERE camp_id = '33333333-3333-3333-3333-333333333333' AND key = 'campistryMe';
    s := public.parent_billing_slice('33333333-3333-3333-3333-333333333333',
                                     jsonb_build_array('Ari Cohen'));
    SELECT array_agg(e ->> 'id') INTO ids
      FROM jsonb_array_elements(s -> 'finance' -> 'payments') AS e;
    IF ids IS DISTINCT FROM ARRAY['q1','q3','q4'] THEN
        RAISE EXCEPTION 'a status change reordered the history: %', ids;
    END IF;
    RAISE NOTICE 'ok  ordinal order survives a status patch';
END $$;

-- ── the office read is gated, shaped and ordered ───────────────────────────
DO $$
DECLARE r jsonb; ids text[];
BEGIN
    -- auth.uid() is NULL in this harness, which is the unauthenticated case.
    r := public.get_camp_payments('33333333-3333-3333-3333-333333333333');
    IF (r ->> 'success') <> 'false' OR (r ->> 'error') <> 'not_authenticated' THEN
        RAISE EXCEPTION 'an unauthenticated caller must be refused, got %', r;
    END IF;
    RAISE NOTICE 'ok  the office read refuses an unauthenticated caller';

    -- With a uid, the stubbed user_section_level returns edit, so it answers.
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS 'SELECT ''44444444-4444-4444-4444-444444444444''::uuid';
    r := public.get_camp_payments('33333333-3333-3333-3333-333333333333');
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'the office read failed: %', r; END IF;
    IF (r ->> 'count')::int <> 4 THEN RAISE EXCEPTION 'expected 4 payments, got %', r ->> 'count'; END IF;
    SELECT array_agg(e ->> 'id') INTO ids
      FROM jsonb_array_elements(r -> 'payments') AS e;
    IF ids IS DISTINCT FROM ARRAY['q1','q2','q3','q4'] THEN
        RAISE EXCEPTION 'the office must see the whole camp in array order — got %', ids;
    END IF;
    RAISE NOTICE 'ok  the office read returns the whole camp, in array order';

    r := public.get_camp_payments(NULL);
    IF (r ->> 'error') <> 'missing_camp' THEN RAISE EXCEPTION 'a null camp must be refused'; END IF;

    -- me.billing = none must be refused, even for a signed-in staff member.
    CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
    RETURNS text LANGUAGE sql STABLE AS 'SELECT ''none''::text';
    r := public.get_camp_payments('33333333-3333-3333-3333-333333333333');
    IF (r ->> 'error') <> 'not_authorized' THEN
        RAISE EXCEPTION 'me.billing=none must be refused, got %', r;
    END IF;
    RAISE NOTICE 'ok  the office read is gated on me.billing, not merely on being staff';

    CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
    RETURNS text LANGUAGE sql STABLE AS 'SELECT ''edit''::text';
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
END $$;

-- ── a camp with no payments answers empty, not null ────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS 'SELECT ''44444444-4444-4444-4444-444444444444''::uuid';
    INSERT INTO public.camps (id, owner, name)
    VALUES ('55555555-5555-5555-5555-555555555555', NULL, 'No Payments');
    r := public.get_camp_payments('55555555-5555-5555-5555-555555555555');
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'empty camp failed: %', r; END IF;
    IF (r -> 'payments') <> '[]'::jsonb THEN
        RAISE EXCEPTION 'an empty camp must return [], not null: %', r;
    END IF;
    IF (r ->> 'count')::int <> 0 THEN RAISE EXCEPTION 'count should be 0'; END IF;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
    RAISE NOTICE 'ok  a camp with no payments returns an empty array, not null';
END $$;

SELECT 'ALL 210 BEHAVIOUR CHECKS PASSED' AS result;
