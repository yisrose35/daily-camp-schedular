-- Behaviour test for migration 270 (TED-087): a scheduler without Billing
-- reads the camp's notifications through the real read rule and sees the
-- schedule notice but not the money ones; the owner sees both. Also: the
-- retired APPLY_BUNDLE.sql refuses to run on a database this new.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES
  ('f2700000-0000-0000-0000-0000000000a1', 'owner@270.test'),
  ('f2700000-0000-0000-0000-0000000000b2', 'sched@270.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2700000-0000-0000-0000-000000000001', 'f2700000-0000-0000-0000-0000000000a1', 'Notice Camp');
INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES
  ('f2700000-0000-0000-0000-000000000001', 'f2700000-0000-0000-0000-0000000000b2', 'scheduler', now());
INSERT INTO notifications (camp_id, source, source_id, title, body) VALUES
  ('f2700000-0000-0000-0000-000000000001', 'payment_unmatched', 'sola:1', 'A card payment needs matching', '$412.00 · card ending 4242'),
  ('f2700000-0000-0000-0000-000000000001', 'autopay_blocked', 'gold:p1:declined', 'Autopay cannot collect', 'Gold — their card was declined'),
  ('f2700000-0000-0000-0000-000000000001', 'notes_reminder', 'n1', 'Reminder', 'Check the bunk list');

-- the database's own read rule, as production has it (the test stubs leave
-- the table open)
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON notifications TO authenticated;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t270.uid', true), '')::uuid $f$;
-- Billing: the owner has it, the scheduler does not.
CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $f$
    SELECT CASE WHEN p_section = 'me.billing' AND auth.uid() = 'f2700000-0000-0000-0000-0000000000b2'
                THEN 'none' ELSE 'edit' END $f$;

BEGIN;
SELECT set_config('t270.uid', 'f2700000-0000-0000-0000-0000000000b2', true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE seen_sched ON COMMIT DROP AS SELECT source FROM notifications;
RESET ROLE;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM seen_sched WHERE source IN ('payment_unmatched', 'autopay_blocked')) THEN
        RAISE EXCEPTION 'TED-087: a scheduler without Billing sees money notices: %', (SELECT array_agg(source) FROM seen_sched);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM seen_sched WHERE source = 'notes_reminder') THEN
        RAISE EXCEPTION 'the scheduler lost the notices that are theirs';
    END IF;
END $$;
COMMIT;

BEGIN;
SELECT set_config('t270.uid', 'f2700000-0000-0000-0000-0000000000a1', true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE seen_owner ON COMMIT DROP AS SELECT source FROM notifications;
RESET ROLE;
DO $$
BEGIN
    IF (SELECT count(*) FROM seen_owner) <> 3 THEN
        RAISE EXCEPTION 'the owner should see all 3 notices, sees %', (SELECT array_agg(source) FROM seen_owner);
    END IF;
    RAISE NOTICE 'ok  270: money notices only to Billing; the owner sees all, the scheduler only theirs';
END $$;
COMMIT;

-- the cart line can carry the parent's payment
DO $$
BEGIN
    IF to_regclass('public.link_tip_cart_items') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'link_tip_cart_items' AND column_name = 'stripe_payment_intent_id') THEN
        RAISE EXCEPTION 'link_tip_cart_items has no stripe_payment_intent_id';
    END IF;
END $$;

-- The retired bundle's guard (its first statement) refuses on a database this
-- new. (The rest of the bundle cannot run on the test stubs anyway, so the
-- guard itself is what is run.) tests/bundle_guard.test.js checks it IS first.
\set guard `sed -n '/^DO \$bundle_guard\$/,/^END \$bundle_guard\$;/p' migrations/APPLY_BUNDLE.sql`
SELECT set_config('t270.guard', :'guard', false);
DO $$
DECLARE g text := current_setting('t270.guard');
BEGIN
    IF position('bundle_guard' IN g) = 0 THEN RAISE EXCEPTION 'APPLY_BUNDLE.sql has no guard'; END IF;
    BEGIN
        EXECUTE g;
        RAISE EXCEPTION 'TED-087: APPLY_BUNDLE.sql would run on a database with 262+';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'APPLY_BUNDLE.sql is retired%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'ok  270: the retired bundle stops before changing anything';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v270 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v270 WHERE item LIKE '270%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 270 row says: %', r; END IF;
END $$;
ROLLBACK;
