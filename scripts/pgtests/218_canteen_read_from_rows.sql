-- Behaviour test for 218. The reader is a gate as much as a query, so the
-- checks are about who sees what: a parent must still see their own child's
-- balance (including the 353 unattributed ones), and must never see anybody
-- else's.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- The harness has no auth, so staff/parent identity is stubbed and flipped by
-- a setting. These two are what 183 gates on.
CREATE OR REPLACE FUNCTION public.camp_staff_member(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT COALESCE(current_setting('test.staff', true) = 'yes', false) $$;

CREATE OR REPLACE FUNCTION public.camp_parent_campers(p_camp_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT COALESCE(NULLIF(current_setting('test.campers', true), '')::jsonb, '[]'::jsonb) $$;

DO $$
DECLARE
    c uuid := '44444444-4444-4444-4444-444444444444';
    v jsonb;
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (c, NULL, 'Reader Camp');

    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Mine One',  jsonb_build_object('camperId', '701', 'name', 'Mine One'),
            'Not Mine',  jsonb_build_object('camperId', '702', 'name', 'Not Mine'))));

    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (c, 'campistrySnacks', jsonb_build_object(
        'accounts', jsonb_build_object(
            'Mine One',   jsonb_build_object('balance', 5.00, 'dailyLimit', 10,
                                             'lastSpendDate', '2026-09-22',
                                             'autoReload', jsonb_build_object('on', true, 'amount', 20)),
            'Not Mine',   jsonb_build_object('balance', 99.00, 'dailyLimit', 10),
            'Mine Orphan', jsonb_build_object('balance', 3.50, 'dailyLimit', 10)),
        'transactions', jsonb_build_array(
            jsonb_build_object('camper', 'Mine One', 'amount', 1.5),
            jsonb_build_object('camper', 'Not Mine', 'amount', 2.5))));

    -- ── 1. staff see the whole camp, with the same numbers ──────────────────
    PERFORM set_config('test.staff', 'yes', true);
    v := public.get_canteen_accounts(c);
    IF (v ->> 'success') <> 'true' THEN RAISE EXCEPTION 'staff read failed: %', v; END IF;
    IF (SELECT count(*) FROM jsonb_each(v -> 'accounts')) <> 3 THEN
        RAISE EXCEPTION 'staff did not get every account: %', v -> 'accounts';
    END IF;
    IF (v -> 'accounts' -> 'Not Mine' ->> 'balance')::numeric <> 99.00 THEN
        RAISE EXCEPTION 'a balance changed on the way out of the rows: %', v;
    END IF;

    -- ── 2. fields the rows know nothing about survive ───────────────────────
    -- autoReload lives in the payload and has no column. Rebuilding the object
    -- from columns alone would drop it, and a canteen auto-reload that stops
    -- working reports no error anywhere.
    -- IS DISTINCT FROM, not <>. A missing field yields NULL, `NULL <> '20'` is
    -- NULL, and `IF NULL THEN` does not fire — so the first version of this
    -- check passed against a function with the payload merge deleted entirely.
    -- Every comparison below that can meet a missing key uses the null-safe
    -- form for the same reason.
    IF (v -> 'accounts' -> 'Mine One' -> 'autoReload' ->> 'amount') IS DISTINCT FROM '20' THEN
        RAISE EXCEPTION 'an unknown payload field was dropped: %', v -> 'accounts' -> 'Mine One';
    END IF;
    -- Emitted under the name the WRITER reads. submit_canteen_purchase does
    -- v_acct->>'lastSpendDate'; serving it as 'spentOn' would leave the daily
    -- counter looking like it belonged to no day, resetting on every sale.
    IF (v -> 'accounts' -> 'Mine One' ->> 'lastSpendDate') IS DISTINCT FROM '2026-09-22' THEN
        RAISE EXCEPTION 'the daily-spend date is not served under the name the writer reads: %',
            v -> 'accounts' -> 'Mine One';
    END IF;

    -- ── 3. a parent sees their own child, by id ─────────────────────────────
    PERFORM set_config('test.staff', 'no', true);
    PERFORM set_config('test.campers', '["Mine One","Mine Orphan"]', true);
    v := public.get_canteen_accounts(c);
    IF (v ->> 'scope') <> 'parent' THEN RAISE EXCEPTION 'parent branch not taken: %', v; END IF;
    IF NOT (v -> 'accounts' ? 'Mine One') THEN
        RAISE EXCEPTION 'a parent cannot see their own child''s balance: %', v;
    END IF;

    -- ── 4. ...including the unattributed one ────────────────────────────────
    -- 353 of this project's accounts have no person_id. A reader matching only
    -- on id would show those parents a blank balance, which reads as "no
    -- money" rather than "we lost track of your child".
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Mine Orphan') IS NOT NULL THEN
        RAISE EXCEPTION 'test setup: Mine Orphan was meant to be unattributable';
    END IF;
    IF NOT (v -> 'accounts' ? 'Mine Orphan') THEN
        RAISE EXCEPTION 'an unattributed account vanished from its parent: %', v;
    END IF;

    -- ── 5. and never anybody else's ─────────────────────────────────────────
    IF v -> 'accounts' ? 'Not Mine' THEN
        RAISE EXCEPTION 'a parent can see another family''s balance: %', v;
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(v -> 'transactions')) <> 1 THEN
        RAISE EXCEPTION 'a parent got another family''s transactions: %', v -> 'transactions';
    END IF;

    -- ── 6. a rename does not cost a parent their child ──────────────────────
    -- The id follows a rename; the name does not. This is the bug 218 fixes as
    -- a side effect of matching on person_id.
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Mine Renamed', jsonb_build_object('camperId', '701', 'name', 'Mine Renamed'),
            'Not Mine',     jsonb_build_object('camperId', '702', 'name', 'Not Mine')))
     WHERE camp_id = c AND key = 'app1';
    -- the parent's link still names the child the old way, as it would in life
    PERFORM set_config('test.campers', '["Mine Renamed"]', true);
    v := public.get_canteen_accounts(c);
    IF NOT (v -> 'accounts' ? 'Mine One') THEN
        RAISE EXCEPTION 'after a rename the parent lost sight of the balance: %', v;
    END IF;

    -- ── 7. an attributed account is never reachable by NAME alone ───────────
    -- The dangerous inverse of check 4, and the case that actually bites: the
    -- account_key stays "Mine One" after its owner is renamed, so when a NEW
    -- camper called "Mine One" joins another family, that family's camper list
    -- contains the old account's key. If the name fallback applied to rows
    -- that already have an owner, they would see a stranger's child's balance.
    --
    -- Testing this with a family whose names simply do not match proves
    -- nothing — that was the first version, and deleting the
    -- `person_id IS NULL` guard passed it.
    UPDATE camp_state_kv SET value = jsonb_build_object('camperRoster', jsonb_build_object(
            'Mine Renamed', jsonb_build_object('camperId', '701', 'name', 'Mine Renamed'),
            'Not Mine',     jsonb_build_object('camperId', '702', 'name', 'Not Mine'),
            'Mine One',     jsonb_build_object('camperId', '703', 'name', 'Mine One')))
     WHERE camp_id = c AND key = 'app1';
    IF (SELECT person_id FROM camp_canteen_accounts
         WHERE camp_id = c AND account_key = 'Mine One') IS DISTINCT FROM 701 THEN
        RAISE EXCEPTION 'test setup: the "Mine One" account should still belong to person 701';
    END IF;

    PERFORM set_config('test.campers', '["Mine One"]', true);   -- the NEW child, person 703
    v := public.get_canteen_accounts(c);
    IF v -> 'accounts' ? 'Mine One' THEN
        RAISE EXCEPTION 'a family inherited a stranger''s balance by reusing the name: %', v;
    END IF;

    -- ── 8. a stranger gets nothing ──────────────────────────────────────────
    PERFORM set_config('test.campers', '[]', true);
    v := public.get_canteen_accounts(c);
    IF (v ->> 'success') <> 'false' OR (v ->> 'error') <> 'not_authorized' THEN
        RAISE EXCEPTION 'somebody with no relationship to the camp was served: %', v;
    END IF;

    -- ── 9. the COLUMN wins over the payload, and the verifier sees it ───────
    -- _canteen_account_json merges the payload first and layers the columns on
    -- top. While both agree, a test cannot tell which one it read — which is
    -- how the check above passed with the column emitted under the wrong name
    -- entirely, satisfied by the payload's own copy. Make them disagree.
    --
    -- This is not hypothetical: after 219 the row is the truth and the payload
    -- is a stale snapshot of the blob, so a field served from the payload is a
    -- field frozen at the last document write.
    UPDATE camp_canteen_accounts SET spent_on = DATE '2026-09-01', balance = 42.00
     WHERE camp_id = c AND account_key = 'Mine One';
    PERFORM set_config('test.staff', 'yes', true);
    v := public.get_canteen_accounts(c);
    IF (v -> 'accounts' -> 'Mine One' ->> 'lastSpendDate') IS DISTINCT FROM '2026-09-01' THEN
        RAISE EXCEPTION 'the stale payload beat the column: served %, column says 2026-09-01',
            v -> 'accounts' -> 'Mine One' ->> 'lastSpendDate';
    END IF;
    -- The same question for the number that IS money. The payload still says
    -- 5.00; after 219 that is a snapshot of the last document write, and a
    -- balance served from it is a balance frozen in the past.
    IF (v -> 'accounts' -> 'Mine One' ->> 'balance')::numeric IS DISTINCT FROM 42.00 THEN
        RAISE EXCEPTION 'the served balance came from the stale payload, not the row: %',
            v -> 'accounts' -> 'Mine One' ->> 'balance';
    END IF;

    -- ...and the verifier must NOTICE that the row and the blob now disagree.
    -- Nothing else in this file produces a lastSpendDate mismatch, so a
    -- verifier that never compared the field would pass every other check.
    v := public.verify_canteen_read_swap(c);
    IF (v ->> 'sameValues') <> 'false' THEN
        RAISE EXCEPTION 'the verifier ignored a lastSpendDate disagreement: %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'differences') d
                    WHERE d ->> 'field' = 'lastSpendDate') THEN
        RAISE EXCEPTION 'the verifier reported a difference but not the right field: %', v;
    END IF;
    UPDATE camp_canteen_accounts SET spent_on = DATE '2026-09-22', balance = 5.00
     WHERE camp_id = c AND account_key = 'Mine One';

    -- ── 10. the verifier agrees the swap lost nothing ───────────────────────
    v := public.verify_canteen_read_swap(c);
    IF (v ->> 'sameValues') <> 'true' THEN
        RAISE EXCEPTION 'the rows serve different numbers than the blob: %', v;
    END IF;
    IF (v ->> 'nobodyLosesSight') <> 'true' THEN
        RAISE EXCEPTION 'an account in the blob cannot be served from rows: %', v;
    END IF;

    RAISE NOTICE '218: staff see the camp, parents see only their own — including';
    RAISE NOTICE '218: unattributed accounts and across a rename — payload fields survive,';
    RAISE NOTICE '218: an owned account is never reachable by name, strangers get nothing.';
END $$;
