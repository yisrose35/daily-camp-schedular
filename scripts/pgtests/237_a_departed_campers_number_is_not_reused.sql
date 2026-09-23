-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 237.
--
-- The two reproductions that found this, driven through the REAL path — a save
-- to camp_state_kv.app1, so the projection trigger does the work rather than the
-- test doing it for it. A test that calls _project_people directly would not
-- prove the trigger reaches it.
--
--   1. No camperId on the entry  → the new child used to inherit the departed
--      child's number AND their money.
--   2. camperId present (production) → the departed row used to be renumbered
--      onto the new child's id, leaving every reference pointing at nobody.
--
-- uuids are prefixed f3700000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name, owner)
VALUES ('f3700000-0000-0000-0000-000000000001', '237 camp',
        'f3700000-0000-0000-0000-0000000000aa')
ON CONFLICT (id) DO NOTHING;

INSERT INTO camp_users (camp_id, user_id, role)
VALUES ('f3700000-0000-0000-0000-000000000001',
        'f3700000-0000-0000-0000-0000000000aa', 'owner');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''f3700000-0000-0000-0000-0000000000aa''::uuid';


-- ─── CASE 1: no camperId on the entry ───────────────────────────────────────
-- Season one. The projection mints John an id.
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('f3700000-0000-0000-0000-000000000001', 'app1', jsonb_build_object(
    'camperRoster', jsonb_build_object(
        'John Smith', jsonb_build_object('name', 'John Smith', 'bunk', 'Minors 1'))))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

DO $$
DECLARE v_old bigint;
BEGIN
    SELECT person_id INTO v_old FROM camp_people
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000001' AND kind = 'camper'
       AND source_key = 'John Smith';
    IF v_old IS NULL THEN
        RAISE EXCEPTION 'the projection did not mint an id for John Smith';
    END IF;
    -- His money, and one row of his history.
    INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
    VALUES ('f3700000-0000-0000-0000-000000000001', 'John Smith', v_old, 'John Smith', 40.00);
    INSERT INTO pickup_alerts (camp_id, camper_name, status)
    VALUES ('f3700000-0000-0000-0000-000000000001', 'John Smith', 'open');
END $$;

-- He leaves: gone from the document, so stamped not destroyed.
UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', '{}'::jsonb)
 WHERE camp_id = 'f3700000-0000-0000-0000-000000000001' AND key = 'app1';

DO $$
DECLARE v_gone integer;
BEGIN
    SELECT count(*) INTO v_gone FROM camp_people
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000001'
       AND source_key = 'John Smith' AND deleted_at IS NOT NULL;
    IF v_gone <> 1 THEN
        RAISE EXCEPTION 'the departed camper was not stamped: % row(s)', v_gone;
    END IF;
END $$;

-- A DIFFERENT child, also John Smith, and no camperId on the entry.
UPDATE camp_state_kv
   SET value = jsonb_build_object('camperRoster', jsonb_build_object(
        'John Smith', jsonb_build_object('name', 'John Smith', 'bunk', 'Soloists 2')))
 WHERE camp_id = 'f3700000-0000-0000-0000-000000000001' AND key = 'app1';

DO $$
DECLARE v_live bigint; v_dead bigint; v_bal numeric;
BEGIN
    SELECT person_id INTO v_live FROM camp_people
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000001' AND kind = 'camper'
       AND source_key = 'John Smith' AND deleted_at IS NULL;
    SELECT person_id INTO v_dead FROM camp_people
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000001' AND kind = 'camper'
       AND source_key = 'John Smith' AND deleted_at IS NOT NULL;

    IF v_live IS NULL THEN
        RAISE EXCEPTION 'the new child was not projected at all — the partial index is '
                        'probably still total, so the departed row blocked the insert';
    END IF;
    IF v_dead IS NULL THEN
        RAISE EXCEPTION 'the departed row is gone: it was repurposed rather than kept';
    END IF;
    IF v_live = v_dead THEN
        RAISE EXCEPTION 'THE DEFECT: the new child is on the departed child''s number (%)',
                        v_live;
    END IF;

    -- And the $40 stayed with the child who earned it.
    SELECT a.balance INTO v_bal FROM camp_canteen_accounts a
     WHERE a.camp_id = 'f3700000-0000-0000-0000-000000000001' AND a.person_id = v_dead;
    IF v_bal IS DISTINCT FROM 40.00 THEN
        RAISE EXCEPTION 'the departed child''s $40 did not stay with them: %',
                        COALESCE(v_bal::text, 'gone');
    END IF;
    IF EXISTS (SELECT 1 FROM camp_canteen_accounts
                WHERE camp_id = 'f3700000-0000-0000-0000-000000000001'
                  AND person_id = v_live) THEN
        RAISE EXCEPTION 'the new child inherited a canteen account they never opened';
    END IF;
END $$;


-- ─── CASE 2: a camperId on the entry — the production path ──────────────────
-- Fresh camp, because case 1 leaves a soft-deleted John Smith behind.
INSERT INTO camps (id, name, owner)
VALUES ('f3700000-0000-0000-0000-000000000002', '237 camp two',
        'f3700000-0000-0000-0000-0000000000aa')
ON CONFLICT (id) DO NOTHING;
INSERT INTO camp_users (camp_id, user_id, role)
VALUES ('f3700000-0000-0000-0000-000000000002',
        'f3700000-0000-0000-0000-0000000000aa', 'owner');

INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('f3700000-0000-0000-0000-000000000002', 'app1', jsonb_build_object(
    'camperRoster', jsonb_build_object(
        'Rivka Stern', jsonb_build_object('name', 'Rivka Stern', 'camperId', 7,
                                          'bunk', 'Minors 1'))))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('f3700000-0000-0000-0000-000000000002', 'Rivka Stern', 7, 'Rivka Stern', 25.00);
INSERT INTO pickup_alerts (camp_id, camper_name, person_id, status)
VALUES ('f3700000-0000-0000-0000-000000000002', 'Rivka Stern', 7, 'open');

-- She leaves, and a different Rivka Stern arrives with her own client-assigned id.
UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', '{}'::jsonb)
 WHERE camp_id = 'f3700000-0000-0000-0000-000000000002' AND key = 'app1';
UPDATE camp_state_kv
   SET value = jsonb_build_object('camperRoster', jsonb_build_object(
        'Rivka Stern', jsonb_build_object('name', 'Rivka Stern', 'camperId', 8,
                                          'bunk', 'Soloists 2')))
 WHERE camp_id = 'f3700000-0000-0000-0000-000000000002' AND key = 'app1';

DO $$
DECLARE v_n integer; v_dangling bigint;
BEGIN
    -- BOTH rows exist: 7 departed, 8 live. Before 237 there was ONE row, at 8.
    SELECT count(*) INTO v_n FROM camp_people
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000002' AND kind = 'camper';
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'expected two identities (7 departed, 8 live), found % — the '
                        'departed row was renumbered onto the new child', v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
                      AND person_id = 7 AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'person 7 is not a departed camper any more';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
                      AND person_id = 8 AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'the new child is not at their own number 8';
    END IF;

    -- And nothing points at nobody. This is the number that used to be silent.
    v_dangling := (public.verify_person_references()->>'rows_pointing_at_nobody')::bigint;
    IF v_dangling <> 0 THEN
        RAISE EXCEPTION 'rows pointing at a person who does not exist: % — %',
                        v_dangling, public.verify_person_references();
    END IF;
END $$;


-- ─── 3. a legitimate hand renumber takes the history with it ────────────────
-- The camp edits the LIVE camper's ID field: 8 → 12. Before 237 this moved the
-- camp_people row alone and left her canteen account pointing at 8.
INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('f3700000-0000-0000-0000-000000000002', 'Rivka Stern 2', 8, 'Rivka Stern', 5.00);

UPDATE camp_state_kv
   SET value = jsonb_build_object('camperRoster', jsonb_build_object(
        'Rivka Stern', jsonb_build_object('name', 'Rivka Stern', 'camperId', 12,
                                          'bunk', 'Soloists 2')))
 WHERE camp_id = 'f3700000-0000-0000-0000-000000000002' AND key = 'app1';

DO $$
DECLARE v_acct bigint; v_dangling bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
                      AND person_id = 12 AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'the hand renumber did not move the camper to 12';
    END IF;
    SELECT person_id INTO v_acct FROM camp_canteen_accounts
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
       AND account_key = 'Rivka Stern 2';
    IF v_acct IS DISTINCT FROM 12 THEN
        RAISE EXCEPTION 'her canteen account was left behind at %, not moved to 12',
                        COALESCE(v_acct::text, 'null');
    END IF;
    -- The DEPARTED camper's account is untouched: 7 is not part of this move.
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
           AND account_key = 'Rivka Stern') IS DISTINCT FROM 7 THEN
        RAISE EXCEPTION 'the departed camper''s account was dragged along';
    END IF;

    v_dangling := (public.verify_person_references()->>'rows_pointing_at_nobody')::bigint;
    IF v_dangling <> 0 THEN
        RAISE EXCEPTION 'the renumber left % row(s) pointing at nobody', v_dangling;
    END IF;
END $$;


-- ─── 4. and when the office says she IS the same child ──────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    -- Dry run first, and it must change nothing.
    v := public.camper_returns_as('f3700000-0000-0000-0000-000000000002'::uuid,
                                  'Rivka Stern', 7);
    IF (v->>'dry_run')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'camper_returns_as is not dry by default: %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
                      AND person_id = 12 AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'the dry run merged anyway';
    END IF;
END $$;

-- Confirming it: she and her money end up on 7, the identity she is returning to.
-- Her live account has to go first — both identities holding one is the refusal
-- case, tested below.
DO $$
DECLARE v jsonb; v_live integer; v_acct bigint;
BEGIN
    DELETE FROM camp_canteen_accounts
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
       AND account_key = 'Rivka Stern';        -- the departed one's, freeing 7

    v := public.camper_returns_as('f3700000-0000-0000-0000-000000000002'::uuid,
                                  'Rivka Stern', 7, true);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the merge failed: %', v;
    END IF;

    SELECT count(*) INTO v_live FROM camp_people
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000002' AND kind = 'camper';
    IF v_live <> 1 THEN
        RAISE EXCEPTION 'expected one identity after the merge, found %', v_live;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
                      AND person_id = 7 AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'she is not enrolled on the identity she returned to';
    END IF;

    SELECT person_id INTO v_acct FROM camp_canteen_accounts
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
       AND account_key = 'Rivka Stern 2';
    IF v_acct IS DISTINCT FROM 7 THEN
        RAISE EXCEPTION 'her money did not come with her: %', COALESCE(v_acct::text, 'null');
    END IF;
END $$;

-- THE THING THAT MAKES IT STICK: the document agrees, so the next save does not
-- split them apart again.
DO $$
DECLARE v_id text;
BEGIN
    SELECT value #>> ARRAY['camperRoster', 'Rivka Stern', 'camperId'] INTO v_id
      FROM camp_state_kv
     WHERE camp_id = 'f3700000-0000-0000-0000-000000000002' AND key = 'app1';
    IF v_id IS DISTINCT FROM '7' THEN
        RAISE EXCEPTION 'the document still says camperId %, so the next Me-page save '
                        'would undo the merge', COALESCE(v_id, 'null');
    END IF;
END $$;

-- And re-saving the document really does leave her where she is.
UPDATE camp_state_kv SET value = value WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
   AND key = 'app1';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM camp_people
                    WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
                      AND person_id = 7 AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'a re-save moved her off the merged identity';
    END IF;
END $$;


-- ─── 5. the refusals ────────────────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    -- Merging onto somebody still enrolled is two children, not a return.
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
    VALUES ('f3700000-0000-0000-0000-000000000002', 99, 'camper',
            'Somebody Else', 'Somebody Else');
    v := public.camper_returns_as('f3700000-0000-0000-0000-000000000002'::uuid,
                                  'Rivka Stern', 99, true);
    IF v->>'error' IS DISTINCT FROM 'that_camper_is_still_enrolled' THEN
        RAISE EXCEPTION 'it merged a child onto somebody who is still here: %', v;
    END IF;

    -- A name nobody is enrolled under.
    v := public.camper_returns_as('f3700000-0000-0000-0000-000000000002'::uuid,
                                  'Nobody At All', 7, true);
    IF v->>'error' IS DISTINCT FROM 'no_live_camper_of_that_name' THEN
        RAISE EXCEPTION 'expected no_live_camper_of_that_name, got %', v;
    END IF;
END $$;

-- Two canteen accounts, one person: refused rather than half-moved.
DO $$
DECLARE v_msg text;
BEGIN
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, deleted_at)
    VALUES ('f3700000-0000-0000-0000-000000000002', 55, 'camper',
            'Two Accounts', 'Two Accounts', now());
    INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
    VALUES ('f3700000-0000-0000-0000-000000000002', 'acct_55', 55, 'Two Accounts', 11.00),
           ('f3700000-0000-0000-0000-000000000002', 'acct_99', 99, 'Somebody Else', 3.00);
    BEGIN
        PERFORM public._move_person_references(
            'f3700000-0000-0000-0000-000000000002'::uuid, 99, 55);
        RAISE EXCEPTION 'two accounts for one person were merged without asking';
    EXCEPTION WHEN raise_exception THEN
        v_msg := SQLERRM;
        IF v_msg NOT LIKE '%both hold a canteen account%' THEN
            RAISE;                          -- some other failure, do not swallow it
        END IF;
    END;
    -- And nothing moved.
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = 'f3700000-0000-0000-0000-000000000002'
           AND account_key = 'acct_99') IS DISTINCT FROM 99 THEN
        RAISE EXCEPTION 'the refused move changed a row anyway';
    END IF;
END $$;

-- A parent cannot merge identities.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''f3700000-0000-0000-0000-0000000000bb''::uuid';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.camper_returns_as('f3700000-0000-0000-0000-000000000002'::uuid,
                                  'Rivka Stern', 7, true);
    IF v->>'error' IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a non-admin can merge two children into one: %', v;
    END IF;
END $$;

ROLLBACK;
