-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 236.
--
-- Built on the real case: a canteen account under 'Sara Schepansky' holding
-- $10.72 while the roster says 'Sara Schepasnky'. Two transposed letters, which
-- camp_person_by_name will never bridge and should not try to.
--
-- The three things that matter:
--   the candidate list finds that pair and does NOT offer a different child;
--   attributing it stamps every table at once, and not before it is confirmed;
--   it REFUSES when the child already has an account, instead of raising.
--
-- uuids are prefixed e3600000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name, owner)
VALUES ('e3600000-0000-0000-0000-000000000001', '236 camp',
        'e3600000-0000-0000-0000-0000000000aa')
ON CONFLICT (id) DO NOTHING;

INSERT INTO camp_users (camp_id, user_id, role)
VALUES ('e3600000-0000-0000-0000-000000000001',
        'e3600000-0000-0000-0000-0000000000aa', 'owner');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''e3600000-0000-0000-0000-0000000000aa''::uuid';

-- The roster: the child, and a DIFFERENT child who shares a surname. The second
-- one is here to prove the candidate list does not offer them.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, first_seen)
VALUES ('e3600000-0000-0000-0000-000000000001', 6001, 'camper',
        'Sara Schepasnky', 'Sara Schepasnky', now() - interval '30 days'),
       ('e3600000-0000-0000-0000-000000000001', 6002, 'camper',
        'Chana Rosenfeld', 'Chana Rosenfeld', now() - interval '30 days');

-- The stranded account, and rows for the same misspelling elsewhere, so the
-- one-decision-many-tables claim is actually tested.
INSERT INTO camp_canteen_accounts (camp_id, account_key, camper_name, balance)
VALUES ('e3600000-0000-0000-0000-000000000001', 'Sara Schepansky',
        'Sara Schepansky', 10.72);

INSERT INTO pickup_alerts (camp_id, camper_name, status)
VALUES ('e3600000-0000-0000-0000-000000000001', 'Sara Schepansky', 'open');

INSERT INTO link_camper_mail (camp_id, camper_name, subject, body)
VALUES ('e3600000-0000-0000-0000-000000000001', 'Sara Schepansky', 'Hello', 'Hi'),
       -- Written by a different screen, in a different case, with a trailing
       -- space. Only the folded comparison reaches it; with exact equality this
       -- row keeps its NULL and nothing else in the file notices.
       ('e3600000-0000-0000-0000-000000000001', 'sara schepansky ', 'Hello again', 'Hi');

-- An account for a camper who was never on the roster and holds nothing, and one
-- who was never on the roster and holds money. The purge must take the first and
-- refuse the second.
INSERT INTO camp_canteen_accounts (camp_id, account_key, camper_name, balance)
VALUES ('e3600000-0000-0000-0000-000000000001', 'Gone Long Ago', 'Gone Long Ago', 0),
       ('e3600000-0000-0000-0000-000000000001', 'Gone With Money', 'Gone With Money', 4.50),
       -- THE TRAP, and it is a real one from the live data: an account for
       -- 'Sara Rosenfeld' while the roster holds 'Chana Rosenfeld'. Same surname,
       -- different child. A candidate rule that matched surnames would offer
       -- Chana here, and somebody in a hurry would accept it — which is one
       -- child's $16 moved onto another. Without this row, loosening the rule to
       -- include surnames is a mutation no assertion notices.
       ('e3600000-0000-0000-0000-000000000001', 'Sara Rosenfeld', 'Sara Rosenfeld', 16.00);

DO $$
DECLARE v bigint;
BEGIN
    SELECT person_id INTO v FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND account_key = 'Sara Schepansky';
    IF v IS NOT NULL THEN
        RAISE EXCEPTION 'the misspelled account resolved by itself, so there is nothing '
                        'for this file to do: %', v;
    END IF;
END $$;


-- ─── 1. the letter tests, on the real spellings ─────────────────────────────
DO $$
BEGIN
    IF public._name_letters('Sara Schepansky') <> public._name_letters('Sara Schepasnky') THEN
        RAISE EXCEPTION 'a transposition is not seen as the same letters';
    END IF;
    IF public._name_letters('Sara Schepansky') = public._name_letters('Chana Rosenfeld') THEN
        RAISE EXCEPTION 'two unrelated names have the same letters';
    END IF;
    -- Punctuation and spacing are not a difference.
    IF public._name_letters('O''Brien, Sean') <> public._name_letters('sean o brien') THEN
        RAISE EXCEPTION 'punctuation is being treated as a letter';
    END IF;
END $$;


-- ─── 2. the candidate list ──────────────────────────────────────────────────
DO $$
DECLARE v jsonb; v_row jsonb;
BEGIN
    v := public.camper_name_candidates('e3600000-0000-0000-0000-000000000001'::uuid);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the candidate list refused the owner: %', v;
    END IF;

    SELECT e INTO v_row
      FROM jsonb_array_elements(v->'names') AS e
     WHERE e->>'unresolved' = 'Sara Schepansky';
    IF v_row IS NULL THEN
        RAISE EXCEPTION 'the stranded account is not on the candidate list: %', v;
    END IF;
    IF (v_row->>'balance')::numeric <> 10.72 THEN
        RAISE EXCEPTION 'the list does not show the money at stake: %', v_row;
    END IF;
    IF NOT (v_row->'candidates')::text LIKE '%Sara Schepasnky%' THEN
        RAISE EXCEPTION 'the roster spelling is not offered as a candidate: %', v_row;
    END IF;
    IF (v_row->'candidates')::text LIKE '%Rosenfeld%' THEN
        RAISE EXCEPTION 'a different child was offered as a candidate: %', v_row;
    END IF;

    -- The accounts with no plausible match are NOT on the list. A decision list
    -- padded with departed campers is a list nobody reads.
    IF (v->'names')::text LIKE '%Gone Long Ago%'
       OR (v->'names')::text LIKE '%Gone With Money%' THEN
        RAISE EXCEPTION 'a camper who was never on the roster is on the decision list: %', v;
    END IF;

    -- And 'Sara Rosenfeld' is not offered 'Chana Rosenfeld'. Sharing a surname is
    -- not evidence of being the same person, and this is the assertion that says
    -- so — a looser rule passes everything above.
    IF (v->'names')::text LIKE '%Sara Rosenfeld%' THEN
        RAISE EXCEPTION 'a shared surname was offered as a candidate: %', v;
    END IF;
END $$;

-- And a stranger cannot read it.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''e3600000-0000-0000-0000-0000000000bb''::uuid';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.camper_name_candidates('e3600000-0000-0000-0000-000000000001'::uuid);
    IF v->>'error' IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a non-admin can read the camp''s camper names: %', v;
    END IF;
    v := public.attribute_camper_name('e3600000-0000-0000-0000-000000000001'::uuid,
                                      'Sara Schepansky', 6001, true);
    IF v->>'error' IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a non-admin can attribute a camper name: %', v;
    END IF;
END $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''e3600000-0000-0000-0000-0000000000aa''::uuid';


-- ─── 3. the dry run changes nothing ─────────────────────────────────────────
DO $$
DECLARE v jsonb; v_left bigint;
BEGIN
    v := public.attribute_camper_name('e3600000-0000-0000-0000-000000000001'::uuid,
                                      'Sara Schepansky', 6001);
    IF (v->>'dry_run')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the default is not a dry run: %', v;
    END IF;
    IF (v->>'rows')::bigint < 4 THEN
        RAISE EXCEPTION 'the dry run found % rows; expected the account, the alert and '
                        'both mail records: %', v->>'rows', v;
    END IF;

    SELECT count(*) INTO v_left FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND account_key = 'Sara Schepansky' AND person_id IS NULL;
    IF v_left <> 1 THEN
        RAISE EXCEPTION 'the dry run stamped the account anyway';
    END IF;
END $$;


-- ─── 4. and confirming it stamps every table at once ────────────────────────
DO $$
DECLARE v jsonb; v_acct bigint; v_alert bigint; v_mail bigint;
BEGIN
    v := public.attribute_camper_name('e3600000-0000-0000-0000-000000000001'::uuid,
                                      'Sara Schepansky', 6001, true);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'attributing the name failed: %', v;
    END IF;
    IF (v->>'attributed')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'it reported a dry run while confirming: %', v;
    END IF;

    SELECT person_id INTO v_acct FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND account_key = 'Sara Schepansky';
    SELECT person_id INTO v_alert FROM pickup_alerts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND camper_name = 'Sara Schepansky';
    SELECT person_id INTO v_mail FROM link_camper_mail
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND camper_name = 'Sara Schepansky';

    IF v_acct IS DISTINCT FROM 6001 THEN
        RAISE EXCEPTION 'the canteen account was not attributed: %',
                        COALESCE(v_acct::text, 'null');
    END IF;
    IF v_alert IS DISTINCT FROM 6001 THEN
        RAISE EXCEPTION 'the pickup alert was not attributed: %',
                        COALESCE(v_alert::text, 'null');
    END IF;
    IF v_mail IS DISTINCT FROM 6001 THEN
        RAISE EXCEPTION 'the mail record was not attributed: %',
                        COALESCE(v_mail::text, 'null');
    END IF;

    SELECT person_id INTO v_mail FROM link_camper_mail
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND camper_name = 'sara schepansky ';
    IF v_mail IS DISTINCT FROM 6001 THEN
        RAISE EXCEPTION 'the row spelled in another case was left behind: %',
                        COALESCE(v_mail::text, 'null');
    END IF;
END $$;

-- The money followed. This is the $10.72.
DO $$
DECLARE v numeric;
BEGIN
    SELECT balance INTO v FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001' AND person_id = 6001;
    IF v IS DISTINCT FROM 10.72 THEN
        RAISE EXCEPTION 'the balance did not come with the attribution: %',
                        COALESCE(v::text, 'null');
    END IF;
END $$;

-- Re-running is a no-op, not a second pass.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.attribute_camper_name('e3600000-0000-0000-0000-000000000001'::uuid,
                                      'Sara Schepansky', 6001, true);
    IF (v->>'rows')::bigint <> 0 THEN
        RAISE EXCEPTION 'attributing twice touched % rows the second time', v->>'rows';
    END IF;
END $$;

-- A camper who does not exist is refused.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.attribute_camper_name('e3600000-0000-0000-0000-000000000001'::uuid,
                                      'Gone Long Ago', 99999, true);
    IF v->>'error' IS DISTINCT FROM 'no_such_camper' THEN
        RAISE EXCEPTION 'a name was attributed to a camper who does not exist: %', v;
    END IF;
END $$;


-- ─── 5. two accounts for one child is REFUSED, not raised ───────────────────
-- 6001 now holds the Schepansky account. A second account under yet another
-- spelling would break uq_canteen_accounts_person, which is the question "which
-- of these balances is theirs?" arriving — and not this function's to answer.
INSERT INTO camp_canteen_accounts (camp_id, account_key, camper_name, balance)
VALUES ('e3600000-0000-0000-0000-000000000001', 'Schepasnky Sara',
        'Schepasnky Sara', 3.25);

DO $$
DECLARE v jsonb; v_still numeric;
BEGIN
    v := public.attribute_camper_name('e3600000-0000-0000-0000-000000000001'::uuid,
                                      'Schepasnky Sara', 6001, true);
    IF v->>'error' IS DISTINCT FROM 'camper_already_has_a_canteen_account' THEN
        RAISE EXCEPTION 'expected a refusal, got: %', v;
    END IF;
    IF (v->>'their_balance')::numeric <> 10.72 OR (v->>'this_balance')::numeric <> 3.25 THEN
        RAISE EXCEPTION 'the refusal does not show both balances: %', v;
    END IF;

    -- And it changed nothing, including in the other tables. A partial
    -- attribution would be worse than none: the alert would point at the child
    -- and the money would not.
    SELECT balance INTO v_still FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND account_key = 'Schepasnky Sara';
    IF v_still IS DISTINCT FROM 3.25 THEN
        RAISE EXCEPTION 'the refused account was changed anyway';
    END IF;
END $$;


-- ─── 6. the purge takes the empty ones and only those ───────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.purge_unattributable_canteen_accounts();
    IF (v->>'deleted')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'the purge deleted without being asked: %', v;
    END IF;
    IF (v->>'empty_accounts_with_no_camper')::bigint <> 1 THEN
        RAISE EXCEPTION 'expected one empty unattributable account, got %: %',
                        v->>'empty_accounts_with_no_camper', v;
    END IF;
    IF (v->>'accounts_holding_money_with_no_camper')::bigint <> 3 THEN
        RAISE EXCEPTION 'expected three money-holding unattributable accounts '
                        '(Gone With Money, Sara Rosenfeld, Schepasnky Sara), got %: %',
                        v->>'accounts_holding_money_with_no_camper', v;
    END IF;

    v := public.purge_unattributable_canteen_accounts(true);
    IF (v->>'empty_accounts_with_no_camper')::bigint <> 1 THEN
        RAISE EXCEPTION 'the purge removed % accounts, not the one it counted: %',
                        v->>'empty_accounts_with_no_camper', v;
    END IF;
END $$;

DO $$
DECLARE v_n bigint;
BEGIN
    SELECT count(*) INTO v_n FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND account_key = 'Gone Long Ago';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'the empty account is still there';
    END IF;

    -- THE THING THAT MUST NOT HAPPEN. Money, positive or negative, is never
    -- deleted to make a number go down.
    SELECT count(*) INTO v_n FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND account_key IN ('Gone With Money', 'Schepasnky Sara');
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'the purge deleted an account holding money — % of 2 left', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM camp_canteen_accounts
     WHERE camp_id = 'e3600000-0000-0000-0000-000000000001'
       AND account_key = 'Sara Rosenfeld';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'the purge deleted the account it could not attribute';
    END IF;
END $$;


-- ─── 7. and the verifier reports what is left to decide ─────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_camper_attribution();
    IF (v->>'rows_carrying_an_id')::bigint < 3 THEN
        RAISE EXCEPTION 'the verifier does not see the attributed rows: %', v;
    END IF;
    -- 'Schepasnky Sara' is an anagram of the roster key, so it is a live decision;
    -- 'Gone With Money' is not.
    IF (v->>'unresolved_accounts_with_a_plausible_match')::bigint <> 1 THEN
        RAISE EXCEPTION 'expected one account still needing a decision, got %: %',
                        v->>'unresolved_accounts_with_a_plausible_match', v;
    END IF;
END $$;

ROLLBACK;
