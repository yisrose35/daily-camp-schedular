-- Behaviour test for migration 213. This one carries most of the proof: 213 is a
-- RESTRUCTURE of append_camp_payment's persistence, so a line diff cannot vouch
-- for it the way it could for 212.
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL, 'Writer Camp');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'wf1', jsonb_build_object('name','Weiss','camperIds', jsonb_build_array('Yoni Weiss')))));

-- ── THE POINT: no camp-wide lock in the function any more ──────────────────
DO $$
BEGIN
    IF pg_get_functiondef('public.append_camp_payment(uuid,jsonb,text,jsonb)'::regprocedure)
       LIKE '%FOR UPDATE%' THEN
        RAISE EXCEPTION 'append_camp_payment still locks something — nothing got faster';
    END IF;
    IF pg_get_functiondef('public.append_camp_payment(uuid,jsonb,text,jsonb)'::regprocedure)
       LIKE '%camp_state_kv%' THEN
        RAISE EXCEPTION 'append_camp_payment still touches the camp document';
    END IF;
    RAISE NOTICE 'ok  append_camp_payment takes no camp lock and never reads the document';
END $$;

-- ── a new payment lands as a row, and posts to the family ledger ──────────
DO $$
DECLARE r jsonb; n integer; ents jsonb;
BEGIN
    r := public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
         jsonb_build_object('id','w1','family','Weiss','familyKey','wf1','amount',250,
                            'status','succeeded','date','2026-07-01','method','card'));
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'append failed: %', r; END IF;
    IF (r ->> 'alreadyRecorded') <> 'false' THEN RAISE EXCEPTION 'should be new: %', r; END IF;
    IF (r ->> 'count')::int <> 1 THEN RAISE EXCEPTION 'count should be 1: %', r; END IF;

    SELECT count(*) INTO n FROM camp_payments
     WHERE camp_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND deleted_at IS NULL;
    IF n <> 1 THEN RAISE EXCEPTION 'expected 1 payment row, got %', n; END IF;

    ents := (public.camp_family('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','wf1')) -> 'entries';
    IF ents IS NULL OR jsonb_array_length(ents) <> 1 THEN
        RAISE EXCEPTION 'the ledger entry was not posted to the family row: %', ents;
    END IF;
    IF (r ->> 'ledgerPosted') <> 'true' THEN RAISE EXCEPTION 'ledgerPosted should be true: %', r; END IF;
    RAISE NOTICE 'ok  a new payment inserts one row and posts one ledger entry';
END $$;

-- ── a retried webhook is recognised and changes nothing ───────────────────
DO $$
DECLARE r jsonb; n integer; ents jsonb;
BEGIN
    r := public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
         jsonb_build_object('id','w1','family','Weiss','familyKey','wf1','amount',250,
                            'status','succeeded','date','2026-07-01','method','card'),
         'w1');
    IF (r ->> 'alreadyRecorded') <> 'true' THEN RAISE EXCEPTION 'retry not recognised: %', r; END IF;
    IF (r ->> 'updated') <> 'false' THEN RAISE EXCEPTION 'a plain retry must not update: %', r; END IF;
    SELECT count(*) INTO n FROM camp_payments
     WHERE camp_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND deleted_at IS NULL;
    IF n <> 1 THEN RAISE EXCEPTION 'a retry double-counted: % rows', n; END IF;
    ents := (public.camp_family('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','wf1')) -> 'entries';
    IF jsonb_array_length(ents) <> 1 THEN
        RAISE EXCEPTION 'a retry posted a second ledger entry: %', ents;
    END IF;
    RAISE NOTICE 'ok  a retried webhook is recognised, adds no row and no entry';
END $$;

-- ── dedupe finds a payment by EACH of the four id fields ──────────────────
DO $$
DECLARE r jsonb;
BEGIN
    PERFORM public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        jsonb_build_object('id','w2','reference','REF-2','stripePaymentIntentId','pi_2',
                           'byopTransactionId','byop_2','family','Weiss','familyKey','wf1',
                           'amount',10,'status','succeeded','date','2026-07-02'));
    FOR r IN SELECT jsonb_build_object('k', k) FROM unnest(ARRAY['w2','REF-2','pi_2','byop_2']) AS k LOOP
        IF (public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              jsonb_build_object('id','w2dup','amount',10), r ->> 'k') ->> 'alreadyRecorded') <> 'true' THEN
            RAISE EXCEPTION 'dedupe missed the key %', r ->> 'k';
        END IF;
    END LOOP;
    RAISE NOTICE 'ok  dedupe matches on id, reference, stripe intent and byop id';
END $$;

-- ── pending -> succeeded patches in place and posts the entry ─────────────
DO $$
DECLARE r jsonb; n integer; ents jsonb; ord_before bigint; ord_after bigint;
BEGIN
    PERFORM public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        jsonb_build_object('id','w3','stripePaymentIntentId','pi_3','family','Weiss',
                           'familyKey','wf1','amount',75,'status','pending','date','2026-07-03'));
    SELECT ordinal INTO ord_before FROM camp_payments
     WHERE camp_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND payment_id = 'w3';
    ents := (public.camp_family('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','wf1')) -> 'entries';
    IF jsonb_array_length(ents) <> 2 THEN
        RAISE EXCEPTION 'a PENDING payment must not post a ledger entry: %', ents;
    END IF;

    r := public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
         jsonb_build_object('id','w3','amount',75), 'pi_3',
         jsonb_build_object('status','succeeded'));
    IF (r ->> 'updated') <> 'true' THEN RAISE EXCEPTION 'the transition did not patch: %', r; END IF;
    IF (r ->> 'ledgerPosted') <> 'true' THEN RAISE EXCEPTION 'succeeded must post: %', r; END IF;
    IF (SELECT status FROM camp_payments
         WHERE camp_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND payment_id = 'w3') <> 'succeeded' THEN
        RAISE EXCEPTION 'the row status was not patched';
    END IF;
    SELECT ordinal INTO ord_after FROM camp_payments
     WHERE camp_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND payment_id = 'w3';
    IF ord_after <> ord_before THEN
        RAISE EXCEPTION 'a status change moved the payment in history: % -> %', ord_before, ord_after;
    END IF;
    SELECT count(*) INTO n FROM camp_payments
     WHERE camp_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND deleted_at IS NULL;
    IF n <> 3 THEN RAISE EXCEPTION 'the transition added a row: % rows', n; END IF;
    RAISE NOTICE 'ok  pending to succeeded patches in place, posts once, keeps its position';
END $$;

-- ── succeeded -> failed writes the REVERSAL, not a removal ────────────────
DO $$
DECLARE r jsonb; ents jsonb; rev jsonb;
BEGIN
    r := public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
         jsonb_build_object('id','w3','amount',75), 'pi_3',
         jsonb_build_object('status','failed','notes','ACH returned'));
    IF (r ->> 'ledgerPosted') <> 'true' THEN RAISE EXCEPTION 'the reversal was not posted: %', r; END IF;
    ents := (public.camp_family('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','wf1')) -> 'entries';
    SELECT e INTO rev FROM jsonb_array_elements(ents) AS e
     WHERE e ->> 'reason' = 'reversal' LIMIT 1;
    IF rev IS NULL THEN RAISE EXCEPTION 'no reversal entry: %', ents; END IF;
    IF (rev ->> 'kind') <> 'refund' THEN RAISE EXCEPTION 'reversal kind wrong: %', rev; END IF;
    IF (rev ->> 'amount')::numeric <> 75 THEN RAISE EXCEPTION 'reversal amount wrong: %', rev; END IF;
    IF (rev ->> 'note') <> 'ACH returned' THEN RAISE EXCEPTION 'reversal note wrong: %', rev; END IF;
    IF (rev ->> 'id') NOT LIKE 'le_payrev_%' THEN RAISE EXCEPTION 'reversal id wrong: %', rev; END IF;

    -- and it is idempotent: the same failure again must not reverse twice
    PERFORM public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        jsonb_build_object('id','w3','amount',75), 'pi_3',
        jsonb_build_object('status','failed','notes','ACH returned'));
    ents := (public.camp_family('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','wf1')) -> 'entries';
    IF (SELECT count(*) FROM jsonb_array_elements(ents) AS e WHERE e ->> 'reason' = 'reversal') <> 1 THEN
        RAISE EXCEPTION 'the reversal was written twice: %', ents;
    END IF;
    RAISE NOTICE 'ok  succeeded to failed reverses once, append-only, with 178s shape';
END $$;

-- ── a payment with no familyKey records, and posts nothing ────────────────
DO $$
DECLARE r jsonb; before integer; after integer;
BEGIN
    SELECT jsonb_array_length(COALESCE(payload -> 'entries','[]'::jsonb)) INTO before
      FROM camp_families WHERE camp_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND family_key='wf1';
    r := public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
         jsonb_build_object('id','w4','amount',5,'status','succeeded','date','2026-07-04'));
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'a payment with no family must still record: %', r; END IF;
    IF (r ->> 'ledgerPosted') <> 'false' THEN RAISE EXCEPTION 'nothing to post to: %', r; END IF;
    SELECT jsonb_array_length(COALESCE(payload -> 'entries','[]'::jsonb)) INTO after
      FROM camp_families WHERE camp_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND family_key='wf1';
    IF after <> before THEN RAISE EXCEPTION 'it posted to an unrelated family'; END IF;
    RAISE NOTICE 'ok  a payment with no familyKey records and posts nothing';
END $$;

-- ── bad arguments are refused, as 178 refused them ───────────────────────
DO $$
BEGIN
    IF (public.append_camp_payment(NULL, '{}'::jsonb) ->> 'error') <> 'bad_arguments' THEN
        RAISE EXCEPTION 'a null camp must be refused';
    END IF;
    IF (public.append_camp_payment('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '"a string"'::jsonb) ->> 'error')
       <> 'bad_arguments' THEN
        RAISE EXCEPTION 'a non-object payment must be refused';
    END IF;
    RAISE NOTICE 'ok  bad arguments refused';
END $$;

-- ── the office soft-deletes a payment, and Undo restores it ───────────────
DO $$
DECLARE r jsonb;
BEGIN
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS 'SELECT ''44444444-4444-4444-4444-444444444444''::uuid';
    r := public.sync_camp_billing('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, jsonb_build_array('w4'));
    IF (r ->> 'paymentsDeleted')::int <> 1 THEN RAISE EXCEPTION 'delete did not stamp: %', r; END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_payments
                    WHERE camp_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
                      AND payment_id='w4' AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'the row was destroyed rather than stamped';
    END IF;
    IF (public.get_camp_payments('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') -> 'payments')::text LIKE '%"w4"%' THEN
        RAISE EXCEPTION 'a deleted payment is still visible to the office';
    END IF;

    -- Undo: the office upserts it again, which clears the stamp.
    r := public.sync_camp_billing('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            '{}'::jsonb, '[]'::jsonb,
            jsonb_build_array(jsonb_build_object('id','w4','amount',5,'status','succeeded','date','2026-07-04')),
            '[]'::jsonb);
    IF (r ->> 'paymentsUpserted')::int <> 1 THEN RAISE EXCEPTION 'undo did not upsert: %', r; END IF;
    IF EXISTS (SELECT 1 FROM camp_payments
                WHERE camp_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
                  AND payment_id='w4' AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'undo did not clear the stamp';
    END IF;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
    RAISE NOTICE 'ok  the office soft-deletes a payment and Undo restores it';
END $$;

-- ── the office write is gated on me.billing EDIT, not merely view ─────────
DO $$
DECLARE r jsonb;
BEGIN
    IF (public.sync_camp_billing('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') ->> 'error')
       <> 'not_authenticated' THEN
        RAISE EXCEPTION 'an unauthenticated caller must be refused';
    END IF;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS 'SELECT ''44444444-4444-4444-4444-444444444444''::uuid';
    CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
    RETURNS text LANGUAGE sql STABLE AS 'SELECT ''view''::text';
    r := public.sync_camp_billing('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    IF (r ->> 'error') <> 'not_authorized' THEN
        RAISE EXCEPTION 'view-only must not be allowed to WRITE: %', r;
    END IF;
    CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
    RETURNS text LANGUAGE sql STABLE AS 'SELECT ''edit''::text';
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
    RAISE NOTICE 'ok  the office write needs me.billing=edit, not just view';
END $$;

-- ── the verifier reports no double counting ───────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    r := public.verify_payment_writes('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    IF (r ->> 'noDoubleCounting') <> 'true' THEN
        RAISE EXCEPTION 'a retried charge was recorded twice: %', r;
    END IF;
    IF (r ->> 'livePayments')::int <> 4 THEN
        RAISE EXCEPTION 'expected 4 live payments, got %', r ->> 'livePayments';
    END IF;
    RAISE NOTICE 'ok  the verifier confirms no double counting';
END $$;

-- ── the duplicate check counts PAYMENTS, not occurrences ──────────────────
-- The false alarm this replaces fired on real data: one payment whose id and
-- reference hold the same value (several processors do that) put the value in
-- its own dedupe_keys array twice, and counting occurrences reported it as a
-- duplicate of itself. Both directions are checked, so the fix cannot have
-- simply silenced the test.
DO $$
DECLARE r jsonb;
BEGIN
    INSERT INTO public.camps (id, owner, name)
    VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, 'Dup Probe');

    -- ONE payment, id = reference. Normal. Must NOT be flagged.
    INSERT INTO public.camp_payments (camp_id, payment_id, payload)
    VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','dp1',
            jsonb_build_object('id','dp1','reference','dp1','amount',10,'status','paid'));
    IF (SELECT dedupe_keys FROM public.camp_payments
         WHERE camp_id='dddddddd-dddd-dddd-dddd-dddddddddddd' AND payment_id='dp1')
       IS DISTINCT FROM ARRAY['dp1','dp1',NULL,NULL]::text[] THEN
        RAISE EXCEPTION 'the array should legitimately contain the value twice';
    END IF;
    r := public.verify_payment_writes('dddddddd-dddd-dddd-dddd-dddddddddddd');
    IF (r ->> 'noDoubleCounting') <> 'true' THEN
        RAISE EXCEPTION 'one payment with id = reference is NOT a duplicate: %', r;
    END IF;
    RAISE NOTICE 'ok  a payment whose id equals its reference is not a duplicate of itself';

    -- TWO payments sharing a key. That IS the failure, and must be caught.
    INSERT INTO public.camp_payments (camp_id, payment_id, payload)
    VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','dp2',
            jsonb_build_object('id','dp2','reference','dp1','amount',10,'status','paid'));
    r := public.verify_payment_writes('dddddddd-dddd-dddd-dddd-dddddddddddd');
    IF (r ->> 'noDoubleCounting') <> 'false' THEN
        RAISE EXCEPTION 'two payments sharing a dedupe key MUST be reported: %', r;
    END IF;
    IF (r -> 'duplicateDedupeKeys') <> '["dp1"]'::jsonb THEN
        RAISE EXCEPTION 'the offending key should be listed once: %', r -> 'duplicateDedupeKeys';
    END IF;
    RAISE NOTICE 'ok  two payments sharing a key IS reported, and listed once';

    -- A soft-deleted duplicate stops counting, because it stops existing.
    UPDATE public.camp_payments SET deleted_at = now()
     WHERE camp_id='dddddddd-dddd-dddd-dddd-dddddddddddd' AND payment_id='dp2';
    r := public.verify_payment_writes('dddddddd-dddd-dddd-dddd-dddddddddddd');
    IF (r ->> 'noDoubleCounting') <> 'true' THEN
        RAISE EXCEPTION 'a deleted duplicate must not still be reported: %', r;
    END IF;
    RAISE NOTICE 'ok  deleting one of the two clears the report';
END $$;

SELECT 'ALL 213 BEHAVIOUR CHECKS PASSED' AS result;
