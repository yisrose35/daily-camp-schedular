-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 252: a tip paid from the cart remembers WHICH camper.
--
--   1. the cart line has a person_id (059's table is not in the browser chain,
--      so it is created here from 059 itself, then 252 is applied again)
--   2. the id the webhook copies to link_tips is kept — not re-guessed from a
--      name another camper now holds
--
-- uuids are prefixed a5200000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;
\ir ../../migrations/059_link_tip_cart.sql
\ir ../../migrations/252_a_tip_cart_remembers_the_camper.sql

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'link_tip_cart_items'
                      AND column_name = 'person_id') THEN
        RAISE EXCEPTION 'the cart line cannot hold a camper id';
    END IF;
END $$;

INSERT INTO camps (id, name) VALUES ('a5200000-0000-0000-0000-000000000001', '252 camp');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a5200000-0000-0000-0000-000000000001', 5201, 'camper', 'Sam Cohen', 'Sam Cohen'),
    ('a5200000-0000-0000-0000-000000000001', 5202, 'camper', 'Sam Cohen #5202', 'Sam Cohen');

-- The webhook's insert: the name alone would find 5201; the cart said 5202.
INSERT INTO link_tips (camp_id, camper_name, person_id, recipient_name, amount)
VALUES ('a5200000-0000-0000-0000-000000000001', 'Sam Cohen', 5202, 'Counselor', 5);
DO $$
BEGIN
    IF (SELECT person_id FROM link_tips WHERE camp_id = 'a5200000-0000-0000-0000-000000000001')
       IS DISTINCT FROM 5202 THEN
        RAISE EXCEPTION 'the tip was re-attributed from the name';
    END IF;
END $$;

ROLLBACK;
