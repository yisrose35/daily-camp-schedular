-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 234.
--
-- Two defects, and each needs the rename pointing the RIGHT WAY to reproduce.
-- Getting that backwards makes a test that passes against the broken code:
--
--   * settle_shop_order matched f.camperIds ? v_camper. The family list is a
--     SNAPSHOT and goes stale; the ORDER carries whatever the camper was called
--     when it was placed. So the failing case is a family list holding the OLD
--     spelling and an order placed under the NEW one. (Family stale, order
--     current — the other way round, the old code matched fine.)
--
--   * get_my_shop_orders matched inv.camper_names ? o.camperName. The invite is
--     re-synced from the roster and holds the NEW spelling; the OLD orders keep
--     the old one. So the failing case is the reverse: invite current, order
--     stale.
--
-- uuids are prefixed c3400000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name, owner)
VALUES ('c3400000-0000-0000-0000-000000000001', '234 camp',
        'c3400000-0000-0000-0000-0000000000aa')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_user_camp_id() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''c3400000-0000-0000-0000-000000000001''::uuid';
CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS text LANGUAGE sql STABLE
  AS 'SELECT ''owner''::text';
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''c3400000-0000-0000-0000-0000000000aa''::uuid';

-- The camper, on the roster under the spelling everything was first written
-- with. first_seen is explicit so 232's bound has something older than the
-- invite to compare against.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, first_seen)
VALUES ('c3400000-0000-0000-0000-000000000001', 7001, 'camper',
        'Sara Schepasnky', 'Sara Schepasnky', now() - interval '30 days');


-- ─── 1. saving a family stamps the ids ──────────────────────────────────────
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('c3400000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
    'families', jsonb_build_object(
        'fam_s', jsonb_build_object(
            'name', 'Schepasnky',
            'camperIds', jsonb_build_array('Sara Schepasnky'))),
    'finance', '{}'::jsonb))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

DO $$
DECLARE v jsonb;
BEGIN
    SELECT f.person_ids INTO v FROM camp_families f
     WHERE f.camp_id = 'c3400000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_s';
    IF v IS DISTINCT FROM '[7001]'::jsonb THEN
        RAISE EXCEPTION 'the projection did not stamp the family''s person ids: %',
                        COALESCE(v::text, 'null');
    END IF;
END $$;


-- ─── 1b. the orders that already exist get their id ─────────────────────────
-- Placed under the spelling of the day, one of them with no camperId at all —
-- the pre-230 shape. The backfill stamps both while the name still resolves,
-- which is the ONLY moment it can.
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('c3400000-0000-0000-0000-000000000001', 'campistryShop', jsonb_build_object(
    'orders', jsonb_build_array(
        jsonb_build_object('id', 'ord_new', 'camperName', 'Sara Schepasnky',
                           'camperId', 7001, 'total', 40),
        jsonb_build_object('id', 'ord_old', 'camperName', 'Sara Schepasnky',
                           'total', 25),
        jsonb_build_object('id', 'ord_ghost', 'camperName', 'Never On The Roster',
                           'total', 5))))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

DO $$
DECLARE v jsonb; v_id text;
BEGIN
    v := public.backfill_shop_order_camper_ids();
    IF (v->>'orders_stamped')::bigint < 1 THEN
        RAISE EXCEPTION 'the backfill stamped nothing: %', v;
    END IF;
    -- The order naming somebody who was never on the roster is counted, not
    -- guessed at.
    IF (v->>'orders_whose_camper_cannot_be_resolved')::bigint <> 1 THEN
        RAISE EXCEPTION 'expected exactly one unresolvable order, got %: %',
                        v->>'orders_whose_camper_cannot_be_resolved', v;
    END IF;

    SELECT o->>'camperId' INTO v_id
      FROM camp_state_kv k
      CROSS JOIN LATERAL jsonb_array_elements(k.value->'orders') AS o
     WHERE k.camp_id = 'c3400000-0000-0000-0000-000000000001'
       AND k.key = 'campistryShop' AND o->>'id' = 'ord_old';
    IF v_id IS DISTINCT FROM '7001' THEN
        RAISE EXCEPTION 'the pre-230 order was not stamped: %', COALESCE(v_id, 'null');
    END IF;
END $$;

-- Re-running changes nothing, and reports nothing new to stamp.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.backfill_shop_order_camper_ids();
    IF (v->>'orders_stamped')::bigint <> 0 THEN
        RAISE EXCEPTION 'the backfill is not idempotent: %', v;
    END IF;
END $$;


-- ─── 2. the camp corrects the spelling ──────────────────────────────────────
-- Schepasnky -> Schepansky. The roster row keeps its person_id, which is the
-- whole point of 216; only source_key moves. (216's projection does this from a
-- document save; doing it directly here keeps the test about 234.)
--
-- AFTER the backfill, deliberately. That is the real sequence: 234 goes in, and
-- renames happen afterwards. A rename that happened BEFORE 234 leaves an order
-- nothing can attribute — the file's header says so and the backfill counts it.
UPDATE camp_people SET source_key = 'Sara Schepansky', name = 'Sara Schepansky'
 WHERE camp_id = 'c3400000-0000-0000-0000-000000000001' AND person_id = 7001;

DO $$
BEGIN
    IF public.camp_person_by_name('c3400000-0000-0000-0000-000000000001',
                                  'Sara Schepasnky') IS NOT NULL THEN
        RAISE EXCEPTION 'the old spelling still resolves — the rename did not happen';
    END IF;
    IF public.camp_person_by_name('c3400000-0000-0000-0000-000000000001',
                                  'Sara Schepansky') <> 7001 THEN
        RAISE EXCEPTION 'the new spelling does not resolve to the same person';
    END IF;
END $$;

-- ─── 2b. and re-saving the family does not drop the id ──────────────────────
-- The office saves campistryMe constantly. After the rename the family's
-- camperIds still holds the OLD spelling, which no longer resolves — so a
-- projection that REPLACED person_ids with what it can resolve today would
-- write [] and undo everything below. It unions instead. Without this case,
-- swapping the union for a replace is a mutation no test notices, and the id
-- would quietly disappear the next time anybody touched the Billing page.
UPDATE camp_state_kv
   SET value = jsonb_set(value, '{families,fam_s,note}', '"touched"'::jsonb, true)
 WHERE camp_id = 'c3400000-0000-0000-0000-000000000001' AND key = 'campistryMe';

DO $$
DECLARE v jsonb;
BEGIN
    SELECT f.person_ids INTO v FROM camp_families f
     WHERE f.camp_id = 'c3400000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_s';
    IF v IS DISTINCT FROM '[7001]'::jsonb THEN
        RAISE EXCEPTION 'a later save dropped the family''s stamped id: %',
                        COALESCE(v::text, 'null');
    END IF;
END $$;


-- ─── 3. the shared rule finds the family anyway ─────────────────────────────
DO $$
DECLARE v text;
BEGIN
    -- On the stamped id, which is rule 1 and the only one that works here.
    v := public.camp_family_key_for_person('c3400000-0000-0000-0000-000000000001',
                                           7001, 'Sara Schepansky');
    IF v IS DISTINCT FROM 'fam_s' THEN
        RAISE EXCEPTION 'the shared rule lost the family after a rename: %',
                        COALESCE(v, 'null');
    END IF;
    -- A stranger is not in anybody's family.
    v := public.camp_family_key_for_person('c3400000-0000-0000-0000-000000000001',
                                           9999, 'Nobody At All');
    IF v IS NOT NULL THEN
        RAISE EXCEPTION 'the shared rule handed a stranger a family: %', v;
    END IF;
    -- And with no id at all, the current name still answers — the path that
    -- carries every camper the roster cannot resolve.
    v := public.camp_family_key_for_person('c3400000-0000-0000-0000-000000000001',
                                           NULL, 'Sara Schepasnky');
    IF v IS DISTINCT FROM 'fam_s' THEN
        RAISE EXCEPTION 'the name-only path stopped working: %', COALESCE(v, 'null');
    END IF;
END $$;


-- ─── 4. and the office can bill the order ───────────────────────────────────
-- The family list still holds the old spelling; the camper is now called
-- something else. Before 234 the lookup was `camperIds ? camperName` against
-- whatever the order said, and this answered no_family_for_camper.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.settle_shop_order('c3400000-0000-0000-0000-000000000001'::uuid,
                                 'ord_new', 'bill', 40, false);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'billing a renamed camper''s order failed: %', v;
    END IF;
    IF v->>'familyKey' IS DISTINCT FROM 'fam_s' THEN
        RAISE EXCEPTION 'billed to % instead of the family holding the camper: %',
                        COALESCE(v->>'familyKey', 'nobody'), v;
    END IF;
    IF (v->>'camperId')::bigint IS DISTINCT FROM 7001 THEN
        RAISE EXCEPTION 'the settlement did not record who it was for: %', v;
    END IF;
END $$;

-- The name-only order resolves through the same rule, by resolving the name it
-- carries. Nothing about that spelling is on the roster any more, so this one
-- goes by the family's own list — rule 2.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.settle_shop_order('c3400000-0000-0000-0000-000000000001'::uuid,
                                 'ord_old', 'bill', 25, false);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'billing a pre-230 order failed: %', v;
    END IF;
    IF v->>'familyKey' IS DISTINCT FROM 'fam_s' THEN
        RAISE EXCEPTION 'the pre-230 order found no family: %', v;
    END IF;
END $$;

-- Two orders, two charges, on the one family — and the family still intact.
DO $$
DECLARE v_n integer; v_name text;
BEGIN
    SELECT count(*) INTO v_n
      FROM camp_families f
      CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(f.payload->'charges', '[]'::jsonb)) AS c
     WHERE f.camp_id = 'c3400000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_s';
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'expected two Camp Shop charges, found %', v_n;
    END IF;
    SELECT f.payload->>'name' INTO v_name FROM camp_families f
     WHERE f.camp_id = 'c3400000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_s';
    IF v_name IS DISTINCT FROM 'Schepasnky' THEN
        RAISE EXCEPTION 'settling erased the family name (now %)',
                        COALESCE(v_name, 'missing');
    END IF;
END $$;


-- ─── 5. the parent still sees both orders ───────────────────────────────────
-- The invite is re-synced from the roster, so it holds the NEW spelling. The
-- pre-230 order holds the old one. Before 234, get_my_shop_orders matched
-- camper_names ? camperName and that order simply vanished — with success: true.
INSERT INTO link_parent_invites
    (id, camp_id, user_id, token, parent_name, parent_email, camper_names, status)
VALUES ('c3400000-0000-0000-0000-00000000d001',
        'c3400000-0000-0000-0000-000000000001',
        'c3400000-0000-0000-0000-0000000000bb', 'tok-d1', 'Schepansky Parent',
        'parent@example.com', '["Sara Schepansky"]'::jsonb, 'active');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''c3400000-0000-0000-0000-0000000000bb''::uuid';

DO $$
DECLARE v jsonb; v_ids text;
BEGIN
    SELECT i.person_ids::text INTO v_ids FROM link_parent_invites i
     WHERE i.id = 'c3400000-0000-0000-0000-00000000d001';
    IF v_ids IS DISTINCT FROM '[7001]' THEN
        RAISE EXCEPTION 'the invite was not stamped with the camper id: %',
                        COALESCE(v_ids, 'null');
    END IF;

    v := public.get_my_shop_orders('c3400000-0000-0000-0000-000000000001'::uuid);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the parent could not read their orders: %', v;
    END IF;
    IF jsonb_array_length(v->'orders') <> 2 THEN
        RAISE EXCEPTION 'the parent sees % of their 2 orders — a rename is still losing '
                        'history: %', jsonb_array_length(v->'orders'), v;
    END IF;
    -- Named explicitly, so a count that happens to be right for the wrong
    -- reason does not pass.
    IF NOT (v->'orders')::text LIKE '%ord_old%' THEN
        RAISE EXCEPTION 'the order placed under the old spelling is missing: %', v;
    END IF;
    IF NOT (v->'orders')::text LIKE '%ord_new%' THEN
        RAISE EXCEPTION 'the order placed under the new spelling is missing: %', v;
    END IF;
END $$;

-- ─── 5b. and not somebody else's ────────────────────────────────────────────
-- A second camper, in no family, with an order of their own. Appended rather
-- than rewriting the document, because rewriting it would discard the camperIds
-- the backfill just stamped and quietly turn section 5 into a name match again.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, first_seen)
VALUES ('c3400000-0000-0000-0000-000000000001', 7002, 'camper',
        'Other Family Kid', 'Other Family Kid', now() - interval '30 days');

UPDATE camp_state_kv
   SET value = jsonb_set(value, '{orders}',
                 (value->'orders') || jsonb_build_array(jsonb_build_object(
                     'id', 'ord_theirs', 'camperName', 'Other Family Kid',
                     'camperId', 7002, 'total', 99)), true)
 WHERE camp_id = 'c3400000-0000-0000-0000-000000000001' AND key = 'campistryShop';

DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_my_shop_orders('c3400000-0000-0000-0000-000000000001'::uuid);
    IF (v->'orders')::text LIKE '%ord_theirs%' THEN
        RAISE EXCEPTION 'the parent can see another family''s order: %', v;
    END IF;
    IF jsonb_array_length(v->'orders') <> 2 THEN
        RAISE EXCEPTION 'expected the parent''s own 2 orders, got %',
                        jsonb_array_length(v->'orders');
    END IF;
    IF (v->'orders')::text LIKE '%ord_ghost%' THEN
        RAISE EXCEPTION 'the parent can see an order for a camper nobody owns: %', v;
    END IF;
END $$;


-- ─── 6. an order for a camper in no family is still refused ─────────────────
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''c3400000-0000-0000-0000-0000000000aa''::uuid';

DO $$
DECLARE v jsonb;
BEGIN
    v := public.settle_shop_order('c3400000-0000-0000-0000-000000000001'::uuid,
                                 'ord_theirs', 'bill', 99, false);
    IF (v->>'error') IS DISTINCT FROM 'no_family_for_camper' THEN
        RAISE EXCEPTION 'a camper in no family was billed anyway: %', v;
    END IF;
END $$;


-- ─── 7. and the verifier agrees ─────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_family_identity();
    IF v->'still_matching_camper_names_by_hand' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'something still tests camper_names by hand: %',
                        v->'still_matching_camper_names_by_hand';
    END IF;
    IF (v->>'families_carrying_an_id')::bigint < 1 THEN
        RAISE EXCEPTION 'no family carries an id, so nothing above proved anything: %', v;
    END IF;
    -- Two: Other Family Kid, who is on the roster but in no family, and
    -- Never On The Roster, who is in neither. Both are genuine — the office has
    -- to put them in a family — and neither is a renamed camper any more, which
    -- is the whole change.
    IF (v->>'orders_no_family_can_be_billed_for')::bigint <> 2 THEN
        RAISE EXCEPTION 'expected two unbillable orders, got %: %',
                        v->>'orders_no_family_can_be_billed_for', v;
    END IF;
END $$;

ROLLBACK;
