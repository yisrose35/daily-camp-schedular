-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 235.
--
-- Each of the four has to be exercised through the case that was broken, not
-- just called. For the two pickup-alert functions that means the alert must be
-- filed under the OLD spelling and asked for under the NEW one — an alert is
-- written when a parent arrives and is not rewritten afterwards.
--
-- uuids are prefixed d3500000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name, owner, address, contact_email)
VALUES ('d3500000-0000-0000-0000-000000000001', '235 camp',
        'd3500000-0000-0000-0000-0000000000aa', '1 Camp Road', 'office@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO camp_users (camp_id, user_id, role)
VALUES ('d3500000-0000-0000-0000-000000000001',
        'd3500000-0000-0000-0000-0000000000aa', 'owner');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''d3500000-0000-0000-0000-0000000000aa''::uuid';
CREATE OR REPLACE FUNCTION public.get_user_camp_id() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''d3500000-0000-0000-0000-000000000001''::uuid';
CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS text LANGUAGE sql STABLE
  AS 'SELECT ''owner''::text';

-- The camper, under the spelling everything below is first written with.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, first_seen)
VALUES ('d3500000-0000-0000-0000-000000000001', 5001, 'camper',
        'Chesky Rosenfeld', 'Chesky Rosenfeld', now() - interval '30 days');

-- A family holding that camper, with a billing contact who is NOT the first
-- household — so a lookup that finds the family but picks the wrong household
-- is visible too.
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('d3500000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
    'families', jsonb_build_object(
        'fam_r', jsonb_build_object(
            'name', 'Rosenfeld',
            'camperIds', jsonb_build_array('Chesky Rosenfeld'),
            'households', jsonb_build_array(
                jsonb_build_object('parents', jsonb_build_array(
                    jsonb_build_object('name', 'Not The Payer',
                                       'email', 'wrong@example.com'))),
                jsonb_build_object('billingContact', true,
                                   'parents', jsonb_build_array(
                    jsonb_build_object('name', 'The Payer',
                                       'email', 'payer@example.com')))))),
    'enrollments', '{}'::jsonb))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

-- The alert, filed under the spelling of the day.
INSERT INTO pickup_alerts (id, camp_id, camper_name, status, created_at)
VALUES ('d3500000-0000-0000-0000-00000000e001',
        'd3500000-0000-0000-0000-000000000001', 'Chesky Rosenfeld', 'open',
        now() - interval '1 hour');

DO $$
DECLARE v bigint;
BEGIN
    SELECT person_id INTO v FROM pickup_alerts
     WHERE id = 'd3500000-0000-0000-0000-00000000e001';
    IF v IS DISTINCT FROM 5001 THEN
        RAISE EXCEPTION '223 did not stamp the alert with the camper id: %',
                        COALESCE(v::text, 'null');
    END IF;
END $$;


-- ─── the camp corrects the spelling ─────────────────────────────────────────
-- Rosenfeld stays; the first name was entered wrong. The roster row keeps its
-- person_id; the family list and the alert keep the old string.
UPDATE camp_people SET source_key = 'Chesky Rosenfeld Jr', name = 'Chesky Rosenfeld Jr'
 WHERE camp_id = 'd3500000-0000-0000-0000-000000000001' AND person_id = 5001;

DO $$
BEGIN
    IF public.camp_person_by_name('d3500000-0000-0000-0000-000000000001',
                                  'Chesky Rosenfeld') IS NOT NULL THEN
        RAISE EXCEPTION 'the old spelling still resolves — the rename did not happen';
    END IF;
END $$;


-- ─── 1. the receipt reaches whoever pays ────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    -- Asked with the NEW spelling, which is what a receipt built from the roster
    -- carries. The family list still holds the old one.
    v := public.receipt_recipient('d3500000-0000-0000-0000-000000000001'::uuid,
                                  NULL, 'Chesky Rosenfeld Jr', NULL);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the receipt found nobody to send to: %', v;
    END IF;
    IF v->>'family_key' IS DISTINCT FROM 'fam_r' THEN
        RAISE EXCEPTION 'the receipt found family % and not the one holding the camper: %',
                        COALESCE(v->>'family_key', 'none'), v;
    END IF;
    -- The BILLING household, not the first one.
    IF v->>'email' IS DISTINCT FROM 'payer@example.com' THEN
        RAISE EXCEPTION 'the receipt is addressed to % and not the billing contact',
                        COALESCE(v->>'email', 'nobody');
    END IF;
    IF (v->>'camper_id')::bigint IS DISTINCT FROM 5001 THEN
        RAISE EXCEPTION 'the receipt does not report who it is for: %', v;
    END IF;
END $$;

-- And passing the id directly works when the caller knows it, even if the name
-- it passes alongside is the stale one.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.receipt_recipient('d3500000-0000-0000-0000-000000000001'::uuid,
                                  NULL, 'Chesky Rosenfeld', NULL, 5001);
    IF v->>'email' IS DISTINCT FROM 'payer@example.com' THEN
        RAISE EXCEPTION 'the id-first path did not find the payer: %', v;
    END IF;
END $$;

-- A camper in no family still gets no_email_on_file rather than somebody else's
-- address. Guessing here would email one family another family's receipt.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.receipt_recipient('d3500000-0000-0000-0000-000000000001'::uuid,
                                  NULL, 'Nobody At All', NULL);
    IF (v->>'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'a camper in no family was given an address: %', v;
    END IF;
    IF v->>'error' IS DISTINCT FROM 'no_email_on_file' THEN
        RAISE EXCEPTION 'expected no_email_on_file, got %', COALESCE(v->>'error', 'null');
    END IF;
END $$;


-- ─── 2. the league captains are added ───────────────────────────────────────
DO $$
DECLARE v jsonb; v_n integer;
BEGIN
    v := public.add_pickup_alert_league_recipients(
            'd3500000-0000-0000-0000-000000000001'::uuid,
            'Chesky Rosenfeld Jr',
            ARRAY['captain@example.com', 'Coach Name|extra'],
            'Hockey', 'Team A');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the league recipients could not be added: %', v;
    END IF;
    IF v->>'alertId' IS DISTINCT FROM 'd3500000-0000-0000-0000-00000000e001' THEN
        RAISE EXCEPTION 'it found the wrong alert: %', v;
    END IF;

    SELECT count(*) INTO v_n FROM pickup_alert_recipients
     WHERE alert_id = 'd3500000-0000-0000-0000-00000000e001'
       AND recipient_role = 'league_captain';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'expected one captain with an email address, found %', v_n;
    END IF;
END $$;

-- A trailing space is not a different camper. Exact equality is what made this
-- lose an alert, so the lookup trims and folds case.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.add_pickup_alert_league_recipients(
            'd3500000-0000-0000-0000-000000000001'::uuid,
            '  chesky rosenfeld jr  ', ARRAY['second@example.com'], 'Hockey', 'Team A');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'a trailing space and a lowercase letter lost the alert: %', v;
    END IF;
END $$;

-- And a camper with no alert at all is still refused.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.add_pickup_alert_league_recipients(
            'd3500000-0000-0000-0000-000000000001'::uuid,
            'Nobody At All', ARRAY['x@example.com'], 'Hockey', 'Team A');
    IF v->>'error' IS DISTINCT FROM 'no_matching_alert' THEN
        RAISE EXCEPTION 'an alert was invented for a camper who has none: %', v;
    END IF;
END $$;


-- ─── 2b. and the NAME branch trims and folds too ────────────────────────────
-- The case above is answered by the id: '  chesky rosenfeld jr  ' resolves
-- through camp_person_by_name, which trims and lowercases already, so the alert
-- is found on person_id and the name comparison never runs. Reverting that
-- comparison to exact equality therefore passed every assertion above — a
-- mutation that survived, which is a test gap and not an argument that the
-- comparison does not matter.
--
-- An alert for a camper who is NOT on the roster has no person_id to match, so
-- only the name can answer, and exact equality is what lost these alerts.
INSERT INTO pickup_alerts (id, camp_id, camper_name, status, created_at)
VALUES ('d3500000-0000-0000-0000-00000000e002',
        'd3500000-0000-0000-0000-000000000001', 'Ghost Camper ', 'open',
        now() - interval '30 minutes');

DO $$
DECLARE v bigint; r jsonb;
BEGIN
    SELECT person_id INTO v FROM pickup_alerts
     WHERE id = 'd3500000-0000-0000-0000-00000000e002';
    IF v IS NOT NULL THEN
        RAISE EXCEPTION 'this alert was supposed to be unresolvable, but carries id %', v;
    END IF;

    -- Filed as 'Ghost Camper ' with a trailing space; asked for as 'ghost camper'.
    r := public.add_pickup_alert_league_recipients(
            'd3500000-0000-0000-0000-000000000001'::uuid,
            'ghost camper', ARRAY['ghost@example.com'], 'Hockey', 'Team B');
    IF (r->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the name branch did not trim or fold: %', r;
    END IF;
    IF r->>'alertId' IS DISTINCT FROM 'd3500000-0000-0000-0000-00000000e002' THEN
        RAISE EXCEPTION 'it matched the wrong alert: %', r;
    END IF;
END $$;


-- ─── 3. and marking it checked either works or says it did not ──────────────
DO $$
DECLARE v jsonb; v_state text;
BEGIN
    v := public.mark_pickup_alert_league_checked(
            'd3500000-0000-0000-0000-000000000001'::uuid,
            'Chesky Rosenfeld Jr', 'checked_no_match');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'marking the alert checked failed: %', v;
    END IF;
    SELECT league_check_state INTO v_state FROM pickup_alerts
     WHERE id = 'd3500000-0000-0000-0000-00000000e001';
    IF v_state IS DISTINCT FROM 'checked_no_match' THEN
        RAISE EXCEPTION 'the alert state is % — the UPDATE matched nothing', v_state;
    END IF;
END $$;

-- THE DEFECT. Before 235 this returned success having changed nothing.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.mark_pickup_alert_league_checked(
            'd3500000-0000-0000-0000-000000000001'::uuid,
            'Nobody At All', 'checked_no_match');
    IF (v->>'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'it still reports success for an alert that does not exist: %', v;
    END IF;
    IF v->>'error' IS DISTINCT FROM 'no_matching_alert' THEN
        RAISE EXCEPTION 'expected no_matching_alert, got %', COALESCE(v->>'error', 'null');
    END IF;
END $$;

-- And neither is open to a counselor.
CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS text LANGUAGE sql STABLE
  AS 'SELECT ''counselor''::text';

DO $$
DECLARE v jsonb;
BEGIN
    v := public.mark_pickup_alert_league_checked(
            'd3500000-0000-0000-0000-000000000001'::uuid, 'Chesky Rosenfeld Jr');
    IF v->>'error' IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a counselor can mark a pickup alert checked: %', v;
    END IF;
    v := public.add_pickup_alert_league_recipients(
            'd3500000-0000-0000-0000-000000000001'::uuid,
            'Chesky Rosenfeld Jr', ARRAY['x@example.com'], 'Hockey', 'Team A');
    IF v->>'error' IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a counselor can add league recipients: %', v;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS text LANGUAGE sql STABLE
  AS 'SELECT ''owner''::text';


-- ─── 4. a checkout intent records who it is for ─────────────────────────────
DO $$
DECLARE v jsonb; v_pid bigint;
BEGIN
    v := public.create_cardknox_checkout_intent(
            'd3500000-0000-0000-0000-000000000001'::uuid, 'ref_1', 'canteen_deposit',
            NULL, NULL, 'Chesky Rosenfeld Jr', 2500, 'Canteen top-up', 5001);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the intent was not created: %', v;
    END IF;
    SELECT person_id INTO v_pid FROM cardknox_checkout_intents WHERE reference = 'ref_1';
    IF v_pid IS DISTINCT FROM 5001 THEN
        RAISE EXCEPTION 'the intent does not carry the camper id: %',
                        COALESCE(v_pid::text, 'null');
    END IF;
END $$;

-- Without the id, the row is still attributed — by 223's stamping TRIGGER, not
-- by the function. That is deliberate: an earlier draft resolved the name here
-- too, and a mutation removing that resolve changed nothing observable, because
-- the trigger was doing the work either way. One mechanism, and this proves it
-- is the one that runs.
DO $$
DECLARE v jsonb; v_pid bigint;
BEGIN
    v := public.create_cardknox_checkout_intent(
            'd3500000-0000-0000-0000-000000000001'::uuid, 'ref_2', 'canteen_deposit',
            NULL, NULL, 'Chesky Rosenfeld Jr', 1000, 'Canteen top-up');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the id-less call failed: %', v;
    END IF;
    SELECT person_id INTO v_pid FROM cardknox_checkout_intents WHERE reference = 'ref_2';
    IF v_pid IS DISTINCT FROM 5001 THEN
        RAISE EXCEPTION 'the name was not resolved to an id: %',
                        COALESCE(v_pid::text, 'null');
    END IF;
END $$;

-- The reference is still unique, and the duplicate is still reported rather
-- than raising.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.create_cardknox_checkout_intent(
            'd3500000-0000-0000-0000-000000000001'::uuid, 'ref_1', 'canteen_deposit',
            NULL, NULL, 'Chesky Rosenfeld Jr', 2500, 'Canteen top-up', 5001);
    IF v->>'error' IS DISTINCT FROM 'reference_already_used' THEN
        RAISE EXCEPTION 'a reused reference was accepted: %', v;
    END IF;
END $$;

ROLLBACK;
