-- Behaviour test for 227. The defect is a hard one: after a camper is renamed,
-- every canteen operation for that child raises a unique-violation and the sale
-- does not happen. So this file first PROVES the constraint that causes it is
-- really there and really fires, then proves the translation stops it firing.
--
--   1. The constraint is real: a second attributed row for one child is refused
--      by the database. Without this, nothing below means what it says.
--   2. A purchase under the NEW name lands on the account opened under the OLD
--      one, at the right balance, with no second account created.
--   3. A till still showing the old name reaches the same account.
--   4. The ledger row is filed under the same key and carries the camper id.
--   5. The label catches up to the current roster key; the KEY does not move.
--   6. A second lock leaves the label alone. Whether the write is SKIPPED cannot
--      be seen from one transaction — see the note in that block.
--   7. The writers that reach the lock work after the rename too: the processor
--      credit, and the daily cap still bites. The refunds return no_canteen_data
--      on every call until 229, so they are 229's to prove. The five
--      parent-facing ones are refused earlier, by their own copy of the
--      name-containment check, and 227 does not claim them either.
--   8. A parent sees their child's history across the rename, from either side,
--      and another family sees none of it.
--   9. A name that resolves to nobody is left exactly alone.
--  10. Two campers never reach each other's money.
--  11. The verifier reports the affected accounts and their money.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- 218's behaviour test stubbed these two to read session settings, and the stubs
-- persist in this shared server. The history path is exactly about who a parent's
-- children are, so it is tested against the REAL definitions — 183's
-- camp_parent_campers, and a camp_staff_member that means owner-or-member — not
-- against a setting this file could set to whatever it wanted.
CREATE OR REPLACE FUNCTION public.camp_parent_campers(p_camp_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        (SELECT jsonb_agg(DISTINCT n)
           FROM link_parent_invites i,
                LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                         THEN i.camper_names ELSE '[]'::jsonb END) n
          WHERE i.camp_id = p_camp_id
            AND i.user_id = auth.uid()
            AND (i.status = 'active' OR i.billing_access = true)
            AND (i.expires_at IS NULL OR i.expires_at > now())),
        '[]'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.camp_staff_member(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = auth.uid())
        OR EXISTS (SELECT 1 FROM camp_users u
                    WHERE u.camp_id = p_camp_id AND u.user_id = auth.uid());
$$;


-- ── the camp, two campers, two parents ──────────────────────────────────────
DO $$
DECLARE
    camp  uuid := 'f2700000-0000-0000-0000-000000000001';
    owner uuid := 'f2700000-0000-0000-0000-0000000000ff';
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (camp, owner, 'Canteen Camp');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (camp, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss', jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',  jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'))));
END $$;

INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
VALUES
    ('f2700000-0000-0000-0000-000000000001', 'f2700000-0000-0000-0000-00000000d001',
     'Weiss parent', 'w@example.test', jsonb_build_array('Ayala Weiss'), 'active'),
    ('f2700000-0000-0000-0000-000000000001', 'f2700000-0000-0000-0000-00000000d002',
     'Lerner parent', 'l@example.test', jsonb_build_array('Dov Lerner'), 'active');


-- ── 1. the constraint that causes the outage is real ────────────────────────
DO $$
DECLARE
    camp uuid := 'f2700000-0000-0000-0000-000000000001';
    hit  boolean := false;
BEGIN
    PERFORM public.canteen_account_save(camp, 'Ayala Weiss',
        jsonb_build_object('balance', 41.25, 'dailyLimit', 10, 'spentToday', 0));
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'the seeded account is not attributed to camper 880';
    END IF;

    -- A second row for the SAME child, under a different key. This is exactly
    -- what 219's lock attempted after a rename, and this is what happened.
    BEGIN
        INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, payload)
        VALUES (camp, 'Ayala Weiss-Katz', 880, 'Ayala Weiss-Katz', '{}'::jsonb)
        ON CONFLICT (camp_id, account_key) DO NOTHING;
    EXCEPTION WHEN unique_violation THEN
        hit := true;
    END;
    IF NOT hit THEN
        RAISE EXCEPTION 'uq_canteen_accounts_person did not fire, so the outage this file fixes '
                        'is not reproducible here and nothing below proves anything';
    END IF;
    RAISE NOTICE '227: a second account for one child is refused by the database — which is why '
                 'a rename broke every canteen operation';
END $$;


-- ── 2, 3, 4, 5, 6. the rename, and the sale that used to throw ──────────────
DO $$
DECLARE
    camp  uuid := 'f2700000-0000-0000-0000-000000000001';
    owner uuid := 'f2700000-0000-0000-0000-0000000000ff';
    r     jsonb;
    bal   numeric;
    n     bigint;
BEGIN
    PERFORM set_config('test.uid', owner::text, false);

    -- THE RENAME. 216 relabels the row, so the id stays and the new spelling
    -- resolves to her.
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster}',
                             (value -> 'camperRoster') - 'Ayala Weiss'
                             || jsonb_build_object('Ayala Weiss-Katz',
                                  jsonb_build_object('camperId', '880',
                                                     'name', 'Ayala Weiss-Katz')))
     WHERE camp_id = camp AND key = 'app1';
    IF public.camp_person_by_name(camp, 'Ayala Weiss-Katz') IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'the new spelling does not resolve to her';
    END IF;

    -- The translation is the fix, and it is worth asserting on its own.
    IF public.canteen_account_key_for(camp, 'Ayala Weiss-Katz') IS DISTINCT FROM 'Ayala Weiss' THEN
        RAISE EXCEPTION 'the new name does not translate to the account her money is on: %',
            public.canteen_account_key_for(camp, 'Ayala Weiss-Katz');
    END IF;

    -- 2. THE SALE. Under 219 this raised and the till refused.
    r := public.submit_canteen_purchase(camp, 'Ayala Weiss-Katz', 3.00, 'Ices');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a purchase for a renamed camper was refused: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 38.25 THEN
        RAISE EXCEPTION 'balance on her account is %, expected 38.25 — the sale went somewhere '
                        'else', bal;
    END IF;

    -- No second account, and the key did not move.
    SELECT count(*) INTO n FROM camp_canteen_accounts WHERE camp_id = camp AND person_id = 880;
    IF n <> 1 THEN
        RAISE EXCEPTION '% accounts for one child', n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_canteen_accounts
                    WHERE camp_id = camp AND account_key = 'Ayala Weiss') THEN
        RAISE EXCEPTION 'the account key moved — canteen_transactions.camper points at the old '
                        'one for every historical sale';
    END IF;

    -- 5. The label caught up.
    IF (SELECT camper_name FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 'Ayala Weiss-Katz' THEN
        RAISE EXCEPTION 'the label did not follow the rename, so print sheets still show the old '
                        'name: %', (SELECT camper_name FROM camp_canteen_accounts
                                     WHERE camp_id = camp AND account_key = 'Ayala Weiss');
    END IF;

    -- 4. The ledger row is filed under the account's key and carries her id.
    IF NOT EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = camp AND camper = 'Ayala Weiss' AND camper_id = '880'
                      AND amount = 3.00) THEN
        RAISE EXCEPTION 'the sale''s ledger row is not filed against her account: %',
            (SELECT jsonb_agg(jsonb_build_object('camper', camper, 'camper_id', camper_id,
                                                 'amount', amount))
               FROM canteen_transactions WHERE camp_id = camp);
    END IF;

    -- 3. A till still showing the old name reaches the same account.
    r := public.submit_canteen_purchase(camp, 'Ayala Weiss', 1.25, 'Gum');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the old spelling stopped working: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 37.00 THEN
        RAISE EXCEPTION 'the old-name sale did not land on the same account';
    END IF;

    -- 6. The label refresh is GUARDED by IS DISTINCT FROM, and that guard cannot
    --    be tested from here. It is recorded rather than papered over, the same
    --    way 219 recorded that deleting FOR UPDATE breaks no test:
    --
    --    updated_at is set from now(), which is the TRANSACTION clock, so a
    --    second write inside this block produces a byte-identical timestamp. The
    --    row version changes and nothing observable does. What the guard actually
    --    costs if removed is a row write on every single sale for the rest of the
    --    season, which is how 203's trigger took the canteen from 84 sales a
    --    second to 26 before 206 fixed it — a throughput fact, measurable by
    --    scripts/load_test.mjs and not by this file.
    --
    --    What IS checked is that a second lock leaves the label correct rather
    --    than clobbering it.
    PERFORM public.canteen_account_lock(camp, 'Ayala Weiss-Katz');
    IF (SELECT camper_name FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss')
       IS DISTINCT FROM 'Ayala Weiss-Katz' THEN
        RAISE EXCEPTION 'a second lock clobbered the label';
    END IF;

    RAISE NOTICE '227: a renamed camper can buy again, on her own balance, with no second '
                 'account, the old name still works, and the label caught up once';
END $$;


-- ── 7. the writers that reach the lock, after the rename ────────────────────
-- Only the ones that GET to the lock. submit_canteen_deposit, submit_shop_order,
-- set_canteen_limits, set_canteen_auto_reload and
-- use_family_card_for_canteen_auto_reload each carry their own copy of the
-- name-containment check and refuse a renamed camper before any account is
-- touched; 227 does not claim to fix those and so does not test them.
DO $$
DECLARE
    camp  uuid := 'f2700000-0000-0000-0000-000000000001';
    owner uuid := 'f2700000-0000-0000-0000-0000000000ff';
    r     jsonb;
    bal   numeric;
BEGIN
    PERFORM set_config('test.uid', owner::text, false);

    -- A processor credit, and the same webhook twice.
    -- Six arguments, not five: until 228 there are two live overloads and five
    -- is ambiguous — which is the bug 228 exists for, and not this file's to
    -- prove.
    r := public.credit_canteen_balance_from_processor(camp, 'Ayala Weiss-Katz', 15.00,
             'cardknox', 'ext_227_a', 'parent');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a processor credit for a renamed camper was refused: %', r;
    END IF;
    PERFORM public.credit_canteen_balance_from_processor(camp, 'Ayala Weiss-Katz', 15.00,
             'cardknox', 'ext_227_a', 'parent');
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 52.00 THEN
        RAISE EXCEPTION 'balance is % — expected 52.00 from 37.00 + 15.00, so the retried '
                        'webhook credited twice or the credit missed', bal;
    END IF;

    -- The refund of it belongs in 229's test, not here: refund_canteen_deposit_
    -- from_processor returns no_canteen_data on every call until 229 fixes it, so
    -- asserting it here would be asserting 229's work from 227's file. 229 proves
    -- the refund AND that it reaches a renamed camper's own account.
    --
    -- The daily cap still applies to the credited money, under the new name: the
    -- limit is 10, so a 15.00 sale is refused and nothing moves.
    r := public.submit_canteen_purchase(camp, 'Ayala Weiss-Katz', 15.00, 'Over the cap');
    IF (r ->> 'success') IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'a sale over the daily cap was allowed after the rename: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 52.00 THEN
        RAISE EXCEPTION 'a refused sale moved the balance to %', bal;
    END IF;

    -- Still one account, after all of it.
    IF (SELECT count(*) FROM camp_canteen_accounts
         WHERE camp_id = camp AND person_id = 880) <> 1 THEN
        RAISE EXCEPTION 'one of the writers created a second account after all';
    END IF;
    RAISE NOTICE '227: a processor credit reaches the renamed camper''s own account, a retried '
                 'webhook still credits once, and the daily cap still bites under the new name';
END $$;


-- ── 8. the history, across the rename ───────────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2700000-0000-0000-0000-000000000001';
    r    jsonb;
BEGIN
    -- Her parent's invite still says the OLD name.
    PERFORM set_config('test.uid', 'f2700000-0000-0000-0000-00000000d001', false);
    r := public.get_canteen_history(camp, 'Ayala Weiss-Katz');
    IF (r ->> 'success') <> 'true' THEN
        RAISE EXCEPTION 'a parent asking by their child''s CURRENT name was refused: %', r;
    END IF;
    IF jsonb_array_length(r -> 'transactions') = 0 THEN
        RAISE EXCEPTION 'a parent asking by the current name sees none of the history that is '
                        'filed under the old key';
    END IF;
    -- And by the old one.
    r := public.get_canteen_history(camp, 'Ayala Weiss');
    IF (r ->> 'success') <> 'true' OR jsonb_array_length(r -> 'transactions') = 0 THEN
        RAISE EXCEPTION 'a parent asking by the old name sees nothing: %', r;
    END IF;
    -- All of theirs, unfiltered.
    r := public.get_canteen_history(camp, NULL);
    IF (r ->> 'success') <> 'true' OR jsonb_array_length(r -> 'transactions') = 0 THEN
        RAISE EXCEPTION 'a parent asking for all of their own sees nothing: %', r;
    END IF;

    -- The other family sees none of it, by either spelling.
    PERFORM set_config('test.uid', 'f2700000-0000-0000-0000-00000000d002', false);
    IF (public.get_canteen_history(camp, 'Ayala Weiss-Katz') ->> 'error') <> 'not_authorized'
       OR (public.get_canteen_history(camp, 'Ayala Weiss') ->> 'error') <> 'not_authorized' THEN
        RAISE EXCEPTION 'another family could page this child''s canteen history';
    END IF;
    r := public.get_canteen_history(camp, NULL);
    IF (r ->> 'success') <> 'true' OR jsonb_array_length(r -> 'transactions') <> 0 THEN
        RAISE EXCEPTION 'another family''s unfiltered history includes this child''s rows: %', r;
    END IF;

    -- Staff see the lot.
    PERFORM set_config('test.uid', 'f2700000-0000-0000-0000-0000000000ff', false);
    r := public.get_canteen_history(camp, NULL);
    IF (r ->> 'success') <> 'true' OR jsonb_array_length(r -> 'transactions') = 0 THEN
        RAISE EXCEPTION 'staff see no history: %', r;
    END IF;
    RAISE NOTICE '227: a parent sees their child''s history from either spelling, and no other '
                 'family sees any of it';
END $$;


-- ── 9, 10, 11. the untouched cases, and the verifier ────────────────────────
DO $$
DECLARE
    camp  uuid := 'f2700000-0000-0000-0000-000000000001';
    owner uuid := 'f2700000-0000-0000-0000-0000000000ff';
    r     jsonb;
    v     jsonb;
BEGIN
    PERFORM set_config('test.uid', owner::text, false);

    -- 9. A name on nobody's roster is left exactly alone: it opens and uses its
    --    own account, which is how the 353 unattributed accounts keep working.
    IF public.canteen_account_key_for(camp, 'Nobody At All') IS DISTINCT FROM 'Nobody At All' THEN
        RAISE EXCEPTION 'an unresolvable name was translated to somebody else''s account';
    END IF;
    PERFORM public.canteen_account_save(camp, 'Nobody At All',
        jsonb_build_object('balance', 5.00, 'dailyLimit', 10, 'spentToday', 0));
    r := public.submit_canteen_purchase(camp, 'Nobody At All', 1.00, 'Chips');
    IF (r ->> 'success') IS DISTINCT FROM 'true'
       OR (SELECT balance FROM camp_canteen_accounts
            WHERE camp_id = camp AND account_key = 'Nobody At All') IS DISTINCT FROM 4.00 THEN
        RAISE EXCEPTION 'an unattributed account stopped working: %', r;
    END IF;
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Nobody At All') IS NOT NULL THEN
        RAISE EXCEPTION 'an unresolvable name was attributed to somebody';
    END IF;

    -- 10. And the other camper's money is untouched by any of it.
    PERFORM public.canteen_account_save(camp, 'Dov Lerner',
        jsonb_build_object('balance', 8.00, 'dailyLimit', 10, 'spentToday', 0));
    r := public.submit_canteen_purchase(camp, 'Dov Lerner', 2.00, 'Pretzels');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the other camper''s purchase was refused: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Dov Lerner') IS DISTINCT FROM 6.00
       OR (SELECT balance FROM camp_canteen_accounts
            WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 52.00 THEN
        RAISE EXCEPTION 'two campers'' balances ran into each other';
    END IF;

    -- 11. The verifier.
    v := public.verify_canteen_identity();
    IF (v ->> 'accounts_keyed_under_an_old_name')::bigint < 1 THEN
        RAISE EXCEPTION 'the verifier cannot see the account whose key is no longer her roster '
                        'key: %', v;
    END IF;
    IF (v ->> 'money_on_them')::numeric < 37.00 THEN
        RAISE EXCEPTION 'the verifier under-reports the money on those accounts: %', v;
    END IF;
    IF (v ->> 'accounts_the_roster_cannot_resolve')::bigint < 1 THEN
        RAISE EXCEPTION 'the verifier cannot see the unattributed account: %', v;
    END IF;
    -- The label caught up. Checked on THIS camp's account rather than on the
    -- verifier's camp-wide total: 218's behaviour test left a renamed account of
    -- its own in this shared server, and a total is not a number this file gets
    -- to predict.
    IF (SELECT camper_name FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss')
       IS DISTINCT FROM 'Ayala Weiss-Katz' THEN
        RAISE EXCEPTION 'the label on her account is still %',
            (SELECT camper_name FROM camp_canteen_accounts
              WHERE camp_id = camp AND account_key = 'Ayala Weiss');
    END IF;
    RAISE NOTICE '227: unresolvable names untouched, two campers stay separate, and the verifier '
                 'reports % account(s) keyed under an old name holding %',
                 v ->> 'accounts_keyed_under_an_old_name', v ->> 'money_on_them';
END $$;

RESET test.uid;
