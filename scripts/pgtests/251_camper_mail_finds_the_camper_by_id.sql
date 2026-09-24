-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 251: camper mail finds the camper by ID.
--
--   1. a <camp>-<camper id> code finds the camper in camp_people (it read a
--      roster that does not exist), placement from the camper's roster entry,
--      and the answer carries camperId
--   2. leading zeros, unknown numbers, departed campers
--   3. the sender-email candidates carry the ids stamped on the invite, one
--      candidate per child
--
-- uuids are prefixed a5100000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name) VALUES ('a5100000-0000-0000-0000-000000000001', '251 camp');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a5100000-0000-0000-0000-000000000001', 5101, 'camper', 'Mine', 'Mine');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, deleted_at) VALUES
    ('a5100000-0000-0000-0000-000000000001', 5102, 'camper', 'Gone', 'Gone', now());
-- Placement lives in the roster. Written straight to the table's value, the way
-- the page saves it.
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Mine}',
         '{"camperId":5101,"division":"Juniors","grade":"3","bunk":"B7"}')
 WHERE camp_id = 'a5100000-0000-0000-0000-000000000001' AND key = 'app1';
INSERT INTO camp_state_kv (camp_id, key, value)
SELECT 'a5100000-0000-0000-0000-000000000001', 'app1',
       '{"camperRoster":{"Mine":{"camperId":5101,"division":"Juniors","grade":"3","bunk":"B7"}}}'
 WHERE NOT EXISTS (SELECT 1 FROM camp_state_kv
                    WHERE camp_id = 'a5100000-0000-0000-0000-000000000001' AND key = 'app1');

-- ─── 1 + 2. by code ─────────────────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public._camper_mail_by_camper_number('a5100000-0000-0000-0000-000000000001', '005101');
    IF (v->>'found')::boolean IS NOT TRUE OR (v->>'camperId') IS DISTINCT FROM '5101' THEN
        RAISE EXCEPTION 'a correct code did not find the camper by id: %', v;
    END IF;
    IF v->>'bunk' IS DISTINCT FROM 'B7' OR v->>'division' IS DISTINCT FROM 'Juniors' THEN
        RAISE EXCEPTION 'placement not read from the roster entry: %', v;
    END IF;
    IF (public._camper_mail_by_camper_number('a5100000-0000-0000-0000-000000000001', '9999')->>'found')::boolean THEN
        RAISE EXCEPTION 'an unknown number found somebody';
    END IF;
    IF (public._camper_mail_by_camper_number('a5100000-0000-0000-0000-000000000001', '5102')->>'found')::boolean THEN
        RAISE EXCEPTION 'a departed camper''s number still receives mail';
    END IF;
    IF (public._camper_mail_by_camper_number('a5100000-0000-0000-0000-000000000001', '99999999999999999999999')->>'found')::boolean THEN
        RAISE EXCEPTION 'an absurd number found somebody';
    END IF;
END $$;

-- ─── 3. by sender email ─────────────────────────────────────────────────────
INSERT INTO link_parent_invites (camp_id, parent_email, camper_names, person_ids, status) VALUES
    ('a5100000-0000-0000-0000-000000000001', 'mom@251.test', '["Mine","Nobody Yet"]', '[5101, null]', 'active'),
    ('a5100000-0000-0000-0000-000000000001', 'mom@251.test', '["Mine"]', '[5101]', 'active');
DO $$
DECLARE v jsonb := public._camper_mail_candidates('a5100000-0000-0000-0000-000000000001', ' MOM@251.test ');
BEGIN
    IF jsonb_array_length(v->'candidates') <> 2 THEN
        RAISE EXCEPTION 'expected one candidate per child: %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'candidates') c
                    WHERE c->>'name' = 'Mine' AND c->>'camperId' = '5101') THEN
        RAISE EXCEPTION 'the stamped id did not come back: %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'candidates') c
                    WHERE c->>'name' = 'Nobody Yet' AND c->'camperId' = 'null'::jsonb) THEN
        RAISE EXCEPTION 'an unstamped slot was given an id: %', v;
    END IF;
END $$;

ROLLBACK;
