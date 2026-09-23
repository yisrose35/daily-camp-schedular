-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 238.
--
-- One question: when a person's number moves, does their canteen LEDGER move
-- with it? 237's cascade discovered person_id columns, and canteen_transactions
-- keeps its person reference in camper_id as text, so it did not.
--
-- The ledger matters because the balance is rebuilt from it. A ledger left
-- pointing at the old number is a balance that recomputes to the wrong figure.
--
-- uuids are prefixed a3800000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name, owner)
VALUES ('a3800000-0000-0000-0000-000000000001', '238 camp',
        'a3800000-0000-0000-0000-0000000000aa')
ON CONFLICT (id) DO NOTHING;

INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a3800000-0000-0000-0000-000000000001', 3001, 'camper', 'Ledger Kid', 'Ledger Kid');

-- Her account, and three ledger rows carrying her number as text.
INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('a3800000-0000-0000-0000-000000000001', 'Ledger Kid', 3001, 'Ledger Kid', 18.50);

INSERT INTO canteen_transactions (camp_id, sig, camper, camper_id, tx_type, amount, payload)
VALUES ('a3800000-0000-0000-0000-000000000001', 'sig1', 'Ledger Kid', '3001',
        'credit', 20.00, '{}'::jsonb),
       ('a3800000-0000-0000-0000-000000000001', 'sig2', 'Ledger Kid', '3001',
        'debit', 1.50, '{}'::jsonb),
       ('a3800000-0000-0000-0000-000000000001', 'sig3', 'Ledger Kid', '3001',
        'debit', 0.00, '{}'::jsonb),
       -- Somebody else's row, which must NOT move.
       ('a3800000-0000-0000-0000-000000000001', 'sig4', 'Other Kid', '3099',
        'credit', 5.00, '{}'::jsonb),
       -- And a row whose camper_id is not a number at all. The schema allows it,
       -- so the move must not choke on it and the dangling counter must not
       -- report it as a dangling ID — it is a different kind of problem.
       ('a3800000-0000-0000-0000-000000000001', 'sig5', 'Ledger Kid', 'not-a-number',
        'debit', 0.00, '{}'::jsonb);

-- ─── 1. the ledger column is recognised as a person reference ───────────────
DO $$
DECLARE v_n integer;
BEGIN
    SELECT count(*) INTO v_n FROM public._person_reference_columns()
     WHERE table_name = 'canteen_transactions' AND column_name = 'camper_id' AND is_text;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'the ledger column is not in the reference set';
    END IF;
    -- And the discovered half is still there.
    SELECT count(*) INTO v_n FROM public._person_reference_columns() WHERE NOT is_text;
    IF v_n < 10 THEN
        RAISE EXCEPTION 'the discovered person_id columns went missing: % left', v_n;
    END IF;
END $$;


-- ─── 2. the move takes it ───────────────────────────────────────────────────
DO $$
DECLARE v jsonb; v_mine integer; v_theirs integer; v_left integer;
BEGIN
    v := public._move_person_references('a3800000-0000-0000-0000-000000000001'::uuid,
                                        3001, 4001);
    IF (v->'by_table' ? 'canteen_transactions.camper_id') IS NOT TRUE THEN
        RAISE EXCEPTION 'the ledger was not moved: %', v;
    END IF;

    SELECT count(*) INTO v_mine FROM canteen_transactions
     WHERE camp_id = 'a3800000-0000-0000-0000-000000000001' AND camper_id = '4001';
    IF v_mine <> 3 THEN
        RAISE EXCEPTION 'expected 3 ledger rows on the new number, found %', v_mine;
    END IF;

    SELECT count(*) INTO v_left FROM canteen_transactions
     WHERE camp_id = 'a3800000-0000-0000-0000-000000000001' AND camper_id = '3001';
    IF v_left <> 0 THEN
        RAISE EXCEPTION '% ledger row(s) left behind on the old number', v_left;
    END IF;

    -- Somebody else's row is untouched.
    SELECT count(*) INTO v_theirs FROM canteen_transactions
     WHERE camp_id = 'a3800000-0000-0000-0000-000000000001' AND camper_id = '3099';
    IF v_theirs <> 1 THEN
        RAISE EXCEPTION 'another camper''s ledger row was dragged along';
    END IF;

    -- And the non-numeric row survived the move without an error.
    IF NOT EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = 'a3800000-0000-0000-0000-000000000001'
                      AND camper_id = 'not-a-number') THEN
        RAISE EXCEPTION 'the non-numeric ledger row was altered or destroyed';
    END IF;

    -- The account came too (it was already covered by 237, and must stay covered).
    IF NOT EXISTS (SELECT 1 FROM camp_canteen_accounts
                    WHERE camp_id = 'a3800000-0000-0000-0000-000000000001'
                      AND person_id = 4001) THEN
        RAISE EXCEPTION 'the account did not move, so 237''s half regressed';
    END IF;
END $$;


-- ─── 3. and the verifier counts a dangling ledger row ───────────────────────
-- 4001 is nobody: the camp_people row is still at 3001, because
-- _move_person_references moves references and the CALLER moves the person.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_person_references();
    IF (v->>'rows_pointing_at_nobody')::bigint < 4 THEN
        RAISE EXCEPTION 'expected at least 4 dangling rows (3 ledger + 1 account), got %: %',
                        v->>'rows_pointing_at_nobody', v;
    END IF;
    IF (v->'by_table' ? 'canteen_transactions.camper_id') IS NOT TRUE THEN
        RAISE EXCEPTION 'the verifier does not look at the ledger: %', v;
    END IF;
    -- FOUR, not three, and working out why is the point: the three rows just
    -- moved to 4001, plus 'Other Kid' at 3099 who was never a real person
    -- either. The FIFTH ledger row, 'not-a-number', is NOT counted — it is not
    -- an id, and counting it would make this number mean two different things.
    -- (My first version of this assertion said 3 and was simply wrong.)
    IF (v->'by_table'->>'canteen_transactions.camper_id')::bigint <> 4 THEN
        RAISE EXCEPTION 'expected 4 dangling ledger rows of the 5 present, got % — if it '
                        'is 5 the non-numeric row is being counted as an id',
                        v->'by_table'->>'canteen_transactions.camper_id';
    END IF;
    IF (v->>'money_on_a_dangling_id')::numeric <> 18.50 THEN
        RAISE EXCEPTION 'the money on a dangling id is %, not 18.50',
                        v->>'money_on_a_dangling_id';
    END IF;
END $$;

-- Move the person to match, and everything that WAS hers reads clean again.
UPDATE camp_people SET person_id = 4001
 WHERE camp_id = 'a3800000-0000-0000-0000-000000000001' AND person_id = 3001;

DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_person_references();
    -- ONE, not zero, and the one is 'Other Kid' at 3099 — a ledger row for a
    -- camper who never existed in camp_people at all. Moving a person does not
    -- and should not fix that; it is a real finding of its own, and asserting 0
    -- here would mean either deleting it from the fixture or making the verifier
    -- ignore it. Neither is honest. (My first version asserted 0.)
    IF (v->>'rows_pointing_at_nobody')::bigint <> 1 THEN
        RAISE EXCEPTION 'expected exactly the one pre-existing orphan (Other Kid at 3099), '
                        'got %: %', v->>'rows_pointing_at_nobody', v;
    END IF;
    IF (v->'by_table'->>'canteen_transactions.camper_id')::bigint <> 1 THEN
        RAISE EXCEPTION 'her three ledger rows did not follow her to 4001: %', v;
    END IF;
    -- And no money is stranded any more: the account moved with her.
    IF (v->>'money_on_a_dangling_id')::numeric <> 0 THEN
        RAISE EXCEPTION 'money is still on a dangling id: %',
                        v->>'money_on_a_dangling_id';
    END IF;
END $$;


-- ─── 4. two id columns that disagree are reported, not moved ────────────────
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a3800000-0000-0000-0000-000000000001', 5001, 'camper', 'Two Ids', 'Two Ids');

-- link_form_responses carries BOTH camper_id (007/013's roster number) and
-- 223's person_id. This row has them naming two different children.
INSERT INTO link_form_responses (camp_id, camper_name, camper_id, person_id)
VALUES ('a3800000-0000-0000-0000-000000000001', 'Two Ids', '9999', 5001);

DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_person_references();
    IF (v->'rows_whose_two_id_columns_disagree' ? 'link_form_responses') IS NOT TRUE THEN
        RAISE EXCEPTION 'a row whose two id columns name different children is not '
                        'reported: %', v;
    END IF;
END $$;

-- And a move does NOT touch the inferred column, on purpose.
DO $$
DECLARE v_cid text;
BEGIN
    PERFORM public._move_person_references('a3800000-0000-0000-0000-000000000001'::uuid,
                                           5001, 5002);
    SELECT camper_id INTO v_cid FROM link_form_responses
     WHERE camp_id = 'a3800000-0000-0000-0000-000000000001' AND camper_name = 'Two Ids';
    IF v_cid IS DISTINCT FROM '9999' THEN
        RAISE EXCEPTION 'camper_id was rewritten on a table whose meaning is inferred '
                        'rather than proven: %', COALESCE(v_cid, 'null');
    END IF;
    -- but person_id, which IS proven, moved.
    IF NOT EXISTS (SELECT 1 FROM link_form_responses
                    WHERE camp_id = 'a3800000-0000-0000-0000-000000000001'
                      AND person_id = 5002) THEN
        RAISE EXCEPTION 'the proven person_id column did not move';
    END IF;
END $$;

ROLLBACK;
