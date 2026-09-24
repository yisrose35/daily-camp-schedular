-- Behaviour test for migration 282 (TED-156): the camp's "why auto-reload was
-- switched off" note goes as soon as the parent saves auto-reload themselves.
--   1. The camp's refund switched it off with a note; the parent switches it
--      back on: the note is gone.
--   2. The parent turns it off again: still no note, so Link says "off", not
--      "the camp switched it off".
--   3. Running 282 twice is harmless.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

INSERT INTO camps (id, owner, name) VALUES ('f2820000-0000-0000-0000-000000000001', 'f2820000-0000-0000-0000-0000000000ff', 'Note Camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2820000-0000-0000-0000-000000000001', 'app1', jsonb_build_object(
    'camperRoster', jsonb_build_object('Avi Gold', jsonb_build_object('camperId', '820', 'name', 'Avi Gold'))));
INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
VALUES ('f2820000-0000-0000-0000-000000000001', 'f2820000-0000-0000-0000-00000000f001',
        'Gold parent', 'g@example.test', jsonb_build_array('Avi Gold'), 'active');

DO $$
DECLARE
    camp uuid := 'f2820000-0000-0000-0000-000000000001';
    r    jsonb;
    ar   jsonb;
BEGIN
    -- the camp's refund emptied the wallet and switched auto-reload off, saying why
    PERFORM public.canteen_account_save(camp, 'Avi Gold', jsonb_build_object('balance', 0,
        'autoReload', jsonb_build_object('enabled', false, 'thresholdEnabled', true, 'thresholdAmount', 5,
            'thresholdReloadAmount', 20, 'cardOnFile', true, 'stripeCustomerId', 'cus_G',
            'disabledAt', '2026-08-20T10:00:00Z',
            'disabledReason', 'switched off when the camp refunded the canteen balance — switch it back on if you still want it')));

    PERFORM set_config('test.uid', 'f2820000-0000-0000-0000-00000000f001', false);
    -- 1. the parent switches it back on
    r := public.set_canteen_auto_reload(camp, 'Avi Gold', jsonb_build_object(
             'enabled', true, 'thresholdEnabled', true, 'thresholdAmount', 5, 'thresholdReloadAmount', 20), 820);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'save: %', r; END IF;
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts WHERE camp_id = camp AND account_key = 'Avi Gold';
    IF ar ? 'disabledReason' OR ar ? 'disabledAt' THEN
        RAISE EXCEPTION 'TED-156: the camp''s note survived the parent switching it back on: %', ar;
    END IF;
    IF (ar ->> 'enabled')::boolean IS NOT TRUE OR ar ->> 'stripeCustomerId' <> 'cus_G' THEN
        RAISE EXCEPTION 'the rest of the set-up was lost: %', ar;
    END IF;
    -- 2. the parent turns it off themselves
    r := public.set_canteen_auto_reload(camp, 'Avi Gold', jsonb_build_object(
             'enabled', false, 'thresholdEnabled', true, 'thresholdAmount', 5, 'thresholdReloadAmount', 20), 820);
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts WHERE camp_id = camp AND account_key = 'Avi Gold';
    IF ar ? 'disabledReason' THEN RAISE EXCEPTION 'TED-156: Link would say the camp switched it off: %', ar; END IF;
    RAISE NOTICE 'ok  282: a parent''s save clears the camp''s pause note';
END $$;

-- 3. a second run changes nothing
\i migrations/282_a_parent_save_clears_the_camps_pause_note.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v282 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v282 WHERE item LIKE '282%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 282 row says: %', r; END IF;
END $$;
ROLLBACK;
